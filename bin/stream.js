#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createServer } from '../src/server.js';
import { generateToken } from '../src/auth.js';
import { hasCloudflared, startTunnel } from '../src/tunnel.js';

const USAGE = `
stream — watch movies on your laptop together with someone far away

Usage
  node bin/stream.js [options] [media-folder ...]

Options
  -d, --dir <path>       Folder to serve (repeatable; default ~/Movies or cwd)
  -p, --port <number>    Port to listen on (default 8420)
      --host-only        Only you can play/pause/seek; guests just watch
      --no-tunnel        Don't start a public tunnel; LAN / your own tunnel only
      --no-auto-pause    Don't pause everyone when one side is buffering
      --no-transcode     Never invoke ffmpeg, even for files browsers can't play
      --host-key <key>   Reuse a fixed host key (keeps your link stable)
      --guest-key <key>  Reuse a fixed guest key (keeps their link stable)
  -h, --help             Show this help

Examples
  node bin/stream.js ~/Movies
  node bin/stream.js -d ~/Movies -d /Volumes/Media/Films --host-only
`.trim();

function parseArgs(argv) {
  const options = {
    dirs: [],
    port: Number(process.env.PORT) || 8420,
    controlMode: 'everyone',
    tunnel: true,
    autoPauseOnBuffer: true,
    allowTranscode: true,
    hostKey: process.env.STREAM_HOST_KEY || null,
    guestKey: process.env.STREAM_GUEST_KEY || null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        console.log(USAGE);
        process.exit(0);
        break;
      case '-d':
      case '--dir':
        options.dirs.push(argv[++i]);
        break;
      case '-p':
      case '--port':
        options.port = Number(argv[++i]);
        break;
      case '--host-only':
        options.controlMode = 'host';
        break;
      case '--no-tunnel':
        options.tunnel = false;
        break;
      case '--no-auto-pause':
        options.autoPauseOnBuffer = false;
        break;
      case '--no-transcode':
        options.allowTranscode = false;
        break;
      case '--host-key':
        options.hostKey = argv[++i];
        break;
      case '--guest-key':
        options.guestKey = argv[++i];
        break;
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
      if (entry.family === 'IPv4' && !entry.internal) {
        addresses.push(`http://${entry.address}:${port}`);
      }
    }
  }
  return addresses;
}

const options = parseArgs(process.argv.slice(2));
const roots = (options.dirs.length ? options.dirs : defaultDirectories()).map((dir) =>
  path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir()))
);

for (const root of roots) {
  if (!fs.existsSync(root)) {
    console.error(`Folder does not exist: ${root}`);
    process.exit(1);
  }
}

const hostKey = options.hostKey || generateToken();
const guestKey = options.guestKey || generateToken();

console.log('Scanning for video files...');
const server = await createServer({
  roots,
  hostKey,
  guestKey,
  controlMode: options.controlMode,
  autoPauseOnBuffer: options.autoPauseOnBuffer,
  allowTranscode: options.allowTranscode,
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(options.port, '0.0.0.0', resolve);
});

const count = server.library.items.size;
console.log(`Found ${count} video file${count === 1 ? '' : 's'} in:`);
for (const root of roots) console.log(`  ${root}`);

if (!server.capabilities.ffmpeg) {
  console.log(
    '\nffmpeg was not found. .mp4/.webm files will still work, but .mkv/.avi and\n' +
      'HEVC/AC3 files will not play. Install ffmpeg to cover those.'
  );
}

let tunnel = null;
if (options.tunnel) {
  if (await hasCloudflared()) {
    process.stdout.write('\nStarting public tunnel... ');
    try {
      tunnel = await startTunnel(options.port);
      console.log('done');
    } catch (error) {
      console.log(`failed (${error.message})`);
    }
  } else {
    console.log(
      '\ncloudflared is not installed, so no public link was created.\n' +
        '  macOS:   brew install cloudflared\n' +
        '  Windows: winget install --id Cloudflare.cloudflared\n' +
        '  Linux:   https://github.com/cloudflare/cloudflared/releases\n' +
        'Without it you can still watch together over the same Wi-Fi.'
    );
  }
}

const base = tunnel?.url ?? `http://localhost:${options.port}`;
console.log('\n' + '─'.repeat(64));
console.log(`  Your link:   ${base}/?k=${hostKey}`);
console.log(`  Their link:  ${base}/?k=${guestKey}`);
console.log('─'.repeat(64));
if (!tunnel) {
  const lan = localAddresses(options.port);
  if (lan.length) {
    console.log('On the same Wi-Fi they can also use:');
    for (const address of lan) console.log(`  ${address}/?k=${guestKey}`);
  }
}
console.log(
  `\nControl: ${options.controlMode === 'host' ? 'only you' : 'either of you'} can play, pause and seek.`
);
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
