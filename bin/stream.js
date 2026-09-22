#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.js';
import { generatePasscode, generateToken } from '../src/auth.js';
import { hasCloudflared, startTunnel, startNamedTunnel } from '../src/tunnel.js';
import { describeProblem, resolveRoots } from '../src/roots.js';
import { readIngressHostnames } from '../src/cloudflare.js';

const CONFIG_PATH = path.join(os.homedir(), '.stream-room.json');

const USAGE = `
stream — watch the movies on your disk with someone far away

Usage
  node bin/stream.js [options] [media-folder ...]

Options
  -d, --dir <path>          Folder to serve (repeatable; default ~/Movies or ~/Videos)
  -p, --port <number>       Port to listen on (default 8420)
      --passcode <code>     Set her passcode instead of generating one
      --host-passcode <code>  Set your own passcode
      --new-passcodes       Throw away the saved passcodes and make new ones
      --host-only           Only you can play/pause/seek; she just watches
      --shared-library      Let her browse your files too (default: host only)
      --hostname <domain>   Your own domain, e.g. movies.example.com
      --tunnel-name <name>  Run this named Cloudflare tunnel instead of a
                            throwaway one (pairs with --hostname)
      --no-tunnel           Don't create a public link (same Wi-Fi only)
      --no-auto-pause       Don't pause everyone when one side is buffering
      --no-transcode        Never invoke ffmpeg
      --software-encoding   Force CPU encoding even if a GPU encoder exists
  -h, --help                Show this help

Examples
  node bin/stream.js "D:\\Movies"
  node bin/stream.js                       (repeats whatever you ran last time)
  node bin/stream.js -d "D:\\Movies" -d "E:\\Films" --passcode POPCORN
  node bin/stream.js "D:\\Movies" --tunnel-name movies --hostname movies.example.com
`.trim();

function parseArgs(argv) {
  const options = {
    dirs: [],
    port: Number(process.env.PORT) || 8420,
    passcode: null,
    hostPasscode: null,
    newPasscodes: false,
    hostname: null,
    tunnelName: null,
    controlMode: 'everyone',
    libraryMode: 'host',
    tunnel: true,
    autoPauseOnBuffer: true,
    allowTranscode: true,
    preferSoftwareEncoder: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h': case '--help':
        console.log(USAGE);
        process.exit(0);
        break;
      case '-d': case '--dir': options.dirs.push(argv[++i]); break;
      case '-p': case '--port': options.port = Number(argv[++i]); break;
      case '--passcode': options.passcode = argv[++i]; break;
      case '--host-passcode': options.hostPasscode = argv[++i]; break;
      case '--new-passcodes': options.newPasscodes = true; break;
      case '--hostname': options.hostname = argv[++i]; break;
      case '--tunnel-name': options.tunnelName = argv[++i]; break;
      case '--host-only': options.controlMode = 'host'; break;
      case '--shared-library': options.libraryMode = 'shared'; break;
      case '--no-tunnel': options.tunnel = false; break;
      case '--no-auto-pause': options.autoPauseOnBuffer = false; break;
      case '--no-transcode': options.allowTranscode = false; break;
      case '--software-encoding': options.preferSoftwareEncoder = true; break;
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}\n`);
          console.error(USAGE);
          process.exit(1);
        }
        options.dirs.push(arg);
    }
  }

  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    console.error(`Invalid port: ${options.port}`);
    process.exit(1);
  }
  return options;
}

// Passcodes survive restarts, so you don't have to text her a new one every
// time your laptop reboots.
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  } catch (error) {
    console.warn(`Could not save passcodes to ${CONFIG_PATH}: ${error.message}`);
  }
}

function defaultDirectories() {
  const candidates = [
    path.join(os.homedir(), 'Movies'),
    path.join(os.homedir(), 'Videos'),
    path.join(os.homedir(), 'Downloads'),
  ];
  const found = candidates.filter((dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
  return found.length ? found : [process.cwd()];
}

function localAddresses(port) {
  const addresses = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const entry of interfaces ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(`http://${entry.address}:${port}`);
    }
  }
  return addresses;
}

const options = parseArgs(process.argv.slice(2));
const stored = loadConfig();
const saved = options.newPasscodes ? { lastRun: stored.lastRun } : stored;
const lastRun = saved.lastRun ?? {};

// Nothing passed? Do what we did last time rather than guessing at ~/Videos.
let reusing = false;
if (options.dirs.length === 0 && Array.isArray(lastRun.dirs) && lastRun.dirs.length) {
  options.dirs = lastRun.dirs;
  reusing = true;
}
if (!options.hostname && lastRun.hostname) {
  options.hostname = lastRun.hostname;
  reusing = true;
}
if (!options.tunnelName && lastRun.tunnelName && options.tunnel) {
  options.tunnelName = lastRun.tunnelName;
  reusing = true;
}
if (options.port === 8420 && Number.isInteger(lastRun.port)) options.port = lastRun.port;

const { roots, problems } = resolveRoots(
  options.dirs.length ? options.dirs : defaultDirectories(),
  { homedir: os.homedir(), stat: fs.statSync }
);

if (problems.length) {
  for (const problem of problems) console.error(describeProblem(problem));
  if (problems.some((problem) => problem.reason === 'not-a-folder')) {
    console.error('\nCheck the command — a stray argument usually means it was pasted twice.');
  }
  process.exit(1);
}

if (roots.length === 0) {
  console.error('No folder to share. Pass one, e.g. node bin/stream.js "D:\\Movies"');
  process.exit(1);
}

const hostPasscode = options.hostPasscode ?? saved.hostPasscode ?? generatePasscode();
const guestPasscode = options.passcode ?? saved.guestPasscode ?? generatePasscode();
const sessionSecret = saved.sessionSecret ?? generateToken(32);

if (hostPasscode === guestPasscode) {
  console.error('Your passcode and hers must be different.');
  process.exit(1);
}

saveConfig({ hostPasscode, guestPasscode, sessionSecret, lastRun: saved.lastRun });

if (reusing) console.log('Using the folder and address from last time.\n');

saveConfig({
  hostPasscode,
  guestPasscode,
  sessionSecret,
  lastRun: {
    dirs: roots,
    port: options.port,
    hostname: options.hostname ?? null,
    tunnelName: options.tunnelName ?? null,
  },
});

console.log('Scanning for video files...');
const server = await createServer({
  roots,
  hostPasscode,
  guestPasscode,
  sessionSecret,
  controlMode: options.controlMode,
  libraryMode: options.libraryMode,
  autoPauseOnBuffer: options.autoPauseOnBuffer,
  allowTranscode: options.allowTranscode,
  preferSoftwareEncoder: options.preferSoftwareEncoder,
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(options.port, '0.0.0.0', resolve);
});

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (roots.some((root) => root === appDirectory)) {
  console.log(`\n  Note: ${appDirectory} is the app's own folder, not a movie folder.`);
  console.log('  Pass just the folder with your films in it.');
}

const count = server.library.items.size;
console.log(`Found ${count} video file${count === 1 ? '' : 's'} in:`);
for (const root of roots) console.log(`  ${root}`);

if (!server.capabilities.ffmpeg) {
  console.log(
    '\n  ffmpeg was not found. .mp4 files will still work, but .mkv, .avi and\n' +
      '  anything 4K or HEVC will not play. Install it first:\n' +
      '    winget install Gyan.FFmpeg'
  );
} else if (server.capabilities.encoder === 'libx264') {
  console.log(
    '\n  No GPU encoder found, so 4K files will be re-encoded on the CPU.\n' +
      '  That is slow and may stutter. 1080p files are unaffected.'
  );
} else {
  console.log(`\n  Using ${server.capabilities.encoder} for 4K re-encoding (GPU accelerated).`);
}

// Strip any scheme the user typed so we always build exactly one https:// URL.
let hostname = options.hostname?.replace(/^https?:\/\//, '').replace(/\/+$/, '') ?? null;

// cloudflared serves whatever its config says, not what was typed here. If the
// two disagree the printed link would not work, which is worse than useless
// when the whole point is to send it to somebody.
if (options.tunnelName) {
  const configured = readIngressHostnames();
  if (configured.length && hostname && !configured.includes(hostname)) {
    console.log(`\n  The tunnel serves ${configured.join(', ')}, not ${hostname}.`);
    console.log(`  Using ${configured[0]} for the link below.`);
    console.log('  (A mistyped --hostname usually means the command was pasted twice.)');
    hostname = configured[0];
  } else if (configured.length && !hostname) {
    hostname = configured[0];
  }
}

let tunnel = null;
if (options.tunnel) {
  if (await hasCloudflared()) {
    if (options.tunnelName) {
      process.stdout.write(`\nConnecting tunnel "${options.tunnelName}"... `);
      try {
        tunnel = await startNamedTunnel(options.tunnelName);
        console.log('done');
        if (!hostname) {
          console.log(
            '  Note: pass --hostname so the link printed below is the right one.\n' +
              '  The tunnel routes whatever hostname its config file says.'
          );
        }
      } catch (error) {
        console.log(`failed (${error.message})`);
      }
    } else {
      process.stdout.write('\nStarting public link... ');
      try {
        tunnel = await startTunnel(options.port);
        console.log('done');
      } catch (error) {
        console.log(`failed (${error.message})`);
      }
    }
  } else {
    console.log(
      '\ncloudflared is not installed, so there is no public link.\n' +
        '  winget install Cloudflare.cloudflared\n' +
        'Without it you can still watch together on the same Wi-Fi.'
    );
  }
}

// A hostname you own wins: it is the address that will still work next month.
const base = hostname
  ? `https://${hostname}`
  : tunnel?.url ?? `http://localhost:${options.port}`;
console.log('\n' + '─'.repeat(62));
console.log('  Send her this link and this passcode:');
console.log(`\n    ${base}`);
console.log(`    passcode:  ${guestPasscode}`);
console.log(`\n  Your own passcode (same link):  ${hostPasscode}`);
console.log('─'.repeat(62));

if (!tunnel && !hostname) {
  const lan = localAddresses(options.port);
  if (lan.length) {
    console.log('On the same Wi-Fi she can also use:');
    for (const address of lan) console.log(`  ${address}`);
  }
}

console.log(`\nControl: ${options.controlMode === 'host' ? 'only you' : 'either of you'} can play, pause and seek.`);
console.log(
  options.libraryMode === 'shared'
    ? 'Library: she can browse your files too.'
    : 'Library: only you can see the file list; she sees only what is playing.'
);
console.log(`Passcodes are saved in ${CONFIG_PATH} and reused next time.`);
if (hostname && !options.tunnelName && options.tunnel) {
  console.log(
    `\nUsing ${base} as the address. If you run cloudflared yourself\n` +
      '(as a service, say), add --no-tunnel so two tunnels do not fight.'
  );
}
console.log('Press Ctrl+C to stop.\n');

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nStopping...');
  tunnel?.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
