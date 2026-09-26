#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createServer } from '../src/server.js';
import { generatePasscode, generateToken, shouldReusePasscodes } from '../src/auth.js';
import {
  hasCloudflared,
  startNamedTunnel,
  startTunnel,
  summariseTunnelError,
  superviseTunnel,
} from '../src/tunnel.js';
import { readIngressHostnames, readTunnelName } from '../src/cloudflare.js';
import { formatPreflight, preflight } from '../src/preflight.js';

const CONFIG_PATH = path.join(os.homedir(), '.stream-room.json');

const USAGE = `
stream — share your screen, sound and all, with someone far away

Usage
  node bin/stream.js [options]          (or just double-click start.cmd)

Options
  -p, --port <number>       Port to listen on (default 8420)
      --passcode <code>     Set the guest passcode instead of generating one
      --host-passcode <code>  Set your own passcode
      --keep-passcodes      Always reuse the saved passcodes
      --new-passcodes       Force a fresh pair, even just after a restart
      --room-name <text>    Heading on the passcode screen
      --share-quality <p>   Height for a shared screen: 720, 1080, 1440 or
                            2160 (default 1080; above that needs real upload)
      --turn <url>          TURN relay for screen sharing, e.g.
                            turn:relay.example.com:3478 (repeatable).
                            Remembered, so it only has to be typed once.
      --turn-user <name>    Username for the TURN relay
      --turn-pass <secret>  Password for the TURN relay
      --no-turn             Ignore the remembered relay for this run
      --check               Check everything the evening needs, then exit
      --hostname <domain>   Your own domain, e.g. movies.example.com
      --tunnel-name <name>  Run this named Cloudflare tunnel instead of a
                            throwaway one (pairs with --hostname)
      --no-tunnel           Don't create a public link (same Wi-Fi only)
  -h, --help                Show this help

Examples
  node bin/stream.js                       (repeats whatever you ran last time)
  node bin/stream.js --tunnel-name movies --hostname movies.example.com
  node bin/stream.js --passcode POPCORN
  node bin/stream.js --check               (before the night, not during it)

The relay can also come from the environment, which keeps the password out of
your shell history: STREAM_TURN_URL, STREAM_TURN_USER, STREAM_TURN_PASS.
`.trim();

function parseArgs(argv) {
  const options = {
    port: Number(process.env.PORT) || 8420,
    passcode: null,
    hostPasscode: null,
    keepPasscodes: false,
    newPasscodes: false,
    hostname: null,
    tunnelName: null,
    roomName: null,
    shareHeight: 1080,
    turnUrls: [],
    turnUser: null,
    turnPass: null,
    useTurn: true,
    check: false,
    tunnel: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h': case '--help':
        console.log(USAGE);
        process.exit(0);
        break;
      case '-p': case '--port': options.port = Number(argv[++i]); break;
      case '--passcode': options.passcode = argv[++i]; break;
      case '--host-passcode': options.hostPasscode = argv[++i]; break;
      case '--keep-passcodes': options.keepPasscodes = true; break;
      case '--new-passcodes': options.newPasscodes = true; break;
      case '--hostname': options.hostname = argv[++i]; break;
      case '--tunnel-name': options.tunnelName = argv[++i]; break;
      case '--room-name': options.roomName = argv[++i]; break;
      case '--share-quality': options.shareHeight = Number(String(argv[++i]).replace(/p$/i, '')); break;
      case '--turn': options.turnUrls.push(argv[++i]); break;
      case '--turn-user': options.turnUser = argv[++i]; break;
      case '--turn-pass': options.turnPass = argv[++i]; break;
      case '--no-turn': options.useTurn = false; break;
      case '--check': options.check = true; break;
      case '--no-tunnel': options.tunnel = false; break;
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}\n`);
          console.error(USAGE);
          process.exit(1);
        }
        // A folder, from the days when this played files off the disk. Old
        // commands and shortcuts still pass one; it is harmless, so say so
        // once rather than refuse to start.
        options.ignored ??= [];
        options.ignored.push(arg);
    }
  }

  if (![720, 1080, 1440, 2160].includes(options.shareHeight)) {
    console.error(`--share-quality must be 720, 1080, 1440 or 2160 (got ${options.shareHeight})`);
    process.exit(1);
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
const lastRun = stored.lastRun ?? {};

// Fresh passcodes every session by default: a code that stops working when the
// evening ends is worth more than one nobody has to be told twice.
//
// But a restart soon after the last one is not a new evening — it is a crash,
// a closed window, a laptop that slept. Rotating then would lock out somebody
// in another country holding a code that was correct ten minutes ago, and the
// link asks for the passcode on every load, so a phone discarding a
// backgrounded tab is enough to strand them. Inside the window, the codes
// stand.
const reusePasscodes = shouldReusePasscodes({
  startedAt: lastRun.startedAt,
  keepPasscodes: options.keepPasscodes,
  newPasscodes: options.newPasscodes,
});
// Distinguish "asked for" from "inferred", so only the inference is explained.
const resumed = reusePasscodes && !options.keepPasscodes;

const saved = reusePasscodes ? stored : { lastRun };

if (options.ignored?.length) {
  console.log(`Ignoring ${options.ignored.join(' ')} — no folder is needed to share a screen.`);
}

// Nothing passed? Use last time's address.
let reusing = false;
if (!options.hostname && lastRun.hostname) {
  options.hostname = lastRun.hostname;
  reusing = true;
}
if (!options.tunnelName && lastRun.tunnelName && options.tunnel) {
  options.tunnelName = lastRun.tunnelName;
  reusing = true;
}
if (options.port === 8420 && Number.isInteger(lastRun.port)) options.port = lastRun.port;

// A laptop that has been through setup-tunnel but never run the room: the
// tunnel and hostname are already in cloudflared's own config, so use them
// rather than falling back to a throwaway link nobody can remember.
if (options.tunnel && !options.tunnelName && !options.hostname) {
  const configuredTunnel = readTunnelName();
  const [configuredHost] = readIngressHostnames();
  if (configuredTunnel && configuredHost) {
    options.tunnelName = configuredTunnel;
    options.hostname = configuredHost;
    console.log(`Using the tunnel set up on this laptop (${configuredTunnel} → ${configuredHost}).`);
  }
}

// A relay is set up once and then wanted every time. Take it from the flags,
// then the environment, then what was used last time — so the evening it
// actually matters, nobody has to remember the command.
const storedTurn = lastRun.turn ?? {};
if (options.useTurn) {
  if (!options.turnUrls.length && process.env.STREAM_TURN_URL) {
    options.turnUrls = process.env.STREAM_TURN_URL.split(',').map((url) => url.trim()).filter(Boolean);
  }
  options.turnUser ??= process.env.STREAM_TURN_USER ?? null;
  options.turnPass ??= process.env.STREAM_TURN_PASS ?? null;

  if (!options.turnUrls.length && Array.isArray(storedTurn.urls) && storedTurn.urls.length) {
    options.turnUrls = storedTurn.urls;
    options.turnUser ??= storedTurn.username ?? null;
    options.turnPass ??= storedTurn.password ?? null;
  }
} else {
  options.turnUrls = [];
  options.turnUser = null;
  options.turnPass = null;
}

// The hostname is typed by a human, who may well paste a whole URL.
const configuredHostname = options.hostname?.replace(/^https?:\/\//, '').replace(/\/+$/, '') ?? null;

// Checking changes nothing: run it during an evening and the passcodes in
// somebody's pocket must still work afterwards. So it happens before anything
// is generated or written, and exits without touching the config.
if (options.check) {
  console.log('Checking what the evening needs...\n');
  const report = await preflight({
    port: options.port,
    hostname: configuredHostname,
    tunnelName: options.tunnelName,
    turnUrls: options.turnUrls,
    turnUser: options.turnUser,
    turnPass: options.turnPass,
  });
  console.log(formatPreflight(report));
  process.exit(report.ok ? 0 : 1);
}

if (reusing) console.log('Using the address from last time.');
if (options.turnUrls.length) console.log(`Relay: ${options.turnUrls.join(', ')}`);

const hostPasscode = options.hostPasscode ?? saved.hostPasscode ?? generatePasscode();
const guestPasscode = options.passcode ?? saved.guestPasscode ?? generatePasscode();
const sessionSecret = saved.sessionSecret ?? generateToken(32);

if (hostPasscode === guestPasscode) {
  console.error('The two passcodes must be different.');
  process.exit(1);
}

if (resumed) {
  const minutes = Math.round((Date.now() - (lastRun.startedAt ?? 0)) / 60_000);
  console.log(
    `Restarted ${minutes} minute${minutes === 1 ? '' : 's'} into a session, so the same ` +
      'passcodes still work.\n  --new-passcodes forces a fresh pair.'
  );
}

// Sign-ins removed from the room. They belong to this session secret, so
// they go when it does.
const revokedSessions = saved.sessionSecret ? (saved.revokedSessions ?? []) : [];

saveConfig({
  hostPasscode,
  guestPasscode,
  sessionSecret,
  revokedSessions,
  lastRun: {
    port: options.port,
    hostname: configuredHostname,
    tunnelName: options.tunnelName ?? null,
    startedAt: Date.now(),
    // Set from the host's own page: the heading on the passcode page, and the
    // message revealed to them once they are in. Kept only on this laptop.
    roomName: options.roomName ?? lastRun.roomName ?? null,
    surprise: lastRun.surprise ?? '',
    theme: lastRun.theme ?? 'classic',
    // Kept in this file, which is owner-only. Set STREAM_TURN_PASS instead if
    // you would rather it never touched the disk.
    turn: options.turnUrls.length
      ? { urls: options.turnUrls, username: options.turnUser, password: options.turnPass }
      : storedTurn,
  },
});

const server = await createServer({
  hostPasscode,
  guestPasscode,
  sessionSecret,
  ...(options.roomName ?? lastRun.roomName ? { roomName: options.roomName ?? lastRun.roomName } : {}),
  surprise: lastRun.surprise ?? '',
  theme: lastRun.theme ?? 'classic',
  // Kept for next time. Read fresh and written whole, so nothing else in the
  // file — the passcodes, the relay — is lost in the process.
  onSettingsChange: ({ roomName, surprise, theme }) => {
    const current = loadConfig();
    saveConfig({ ...current, lastRun: { ...(current.lastRun ?? {}), roomName, surprise, theme } });
  },
  revokedSessions,
  onRevokedChange: (list) => {
    saveConfig({ ...loadConfig(), revokedSessions: list });
    console.log('Someone was removed from the room.');
  },
  // Changed from the host's page after removing someone. Saved, so a restart
  // keeps it, and said here, in case this window is where they look.
  onPasscodeChange: ({ guestPasscode: next }) => {
    saveConfig({ ...loadConfig(), guestPasscode: next });
    console.log(`\n  Their passcode is now:  ${next}   (changed from your page)\n`);
  },
  shareHeight: options.shareHeight,
  iceServers: options.turnUrls.length
    ? [
        {
          urls: options.turnUrls,
          ...(options.turnUser ? { username: options.turnUser } : {}),
          ...(options.turnPass ? { credential: options.turnPass } : {}),
        },
      ]
    : [],
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(options.port, '0.0.0.0', resolve);
});

let hostname = configuredHostname;

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

// The passcodes, before anything that can be slow. Connecting the tunnel can
// take a while — or never happen, on a network that blocks it — and nobody
// should be left staring at "Connecting..." with no way into their own room.
console.log(`\n  Your passcode:   ${hostPasscode}`);
console.log(`  Their passcode:  ${guestPasscode}`);
console.log(`  On this laptop you can already open  http://localhost:${options.port}`);

let tunnel = null;
let supervisor = null;
// Why the public link is not up, if it is not. Anything here means READY
// would be a lie, and the banner has to say so instead.
let tunnelProblem = null;
// Set once the READY banner has been shown, so a reconnection later can say
// so briefly rather than printing everything again.
let announced = false;
if (options.tunnel) {
  if (await hasCloudflared()) {
    const label = options.tunnelName ? `the tunnel "${options.tunnelName}"` : 'a public link';
    console.log(`\nConnecting ${label}...`);

    // Never gives up: at login the internet may not be up yet, and over a day
    // a laptop sleeps, wakes and changes network. Each of those used to leave
    // the link down until somebody noticed.
    supervisor = superviseTunnel({
      start: () =>
        options.tunnelName ? startNamedTunnel(options.tunnelName) : startTunnel(options.port),
      onWaiting: (error, delay) => {
        console.log(`  Not connected yet: ${summariseTunnelError(error)}`);
        console.log(`  Trying again in ${Math.round(delay / 1000)}s. It will say READY once it is up.`);
      },
      onUp: (up) => {
        tunnel = up;
        if (!announced) return;
        // A throwaway link gets a new address every time, so repeat it.
        const where = options.tunnelName ? '' : ` The new link is ${up.url}`;
        console.log(`\n  ${new Date().toLocaleTimeString()}  Reconnected — READY again.${where}\n`);
      },
      onDown: () => {
        console.log(`\n  ${new Date().toLocaleTimeString()}  The connection dropped.`);
        console.log('  Reconnecting by itself — nothing to do.');
      },
    });
    tunnel = await supervisor.ready;
    console.log('Connected.');
    if (options.tunnelName && !hostname) {
      console.log(
        '  Note: pass --hostname so the link printed below is the right one.\n' +
          '  The tunnel routes whatever hostname its config file says.'
      );
    }
  } else {
    tunnelProblem = 'cloudflared is not installed.';
    console.log(
      '\ncloudflared is not installed, so there is no public link.\n' +
        '  winget install Cloudflare.cloudflared\n' +
        'Without it you can still watch together on the same Wi-Fi.'
    );
  }
}

// A hostname you own wins: it is the address that will still work next month.
let shuttingDown = false;

const base = hostname
  ? `https://${hostname}`
  : tunnel?.url ?? `http://localhost:${options.port}`;
const localBase = `http://localhost:${options.port}`;
const remote = base !== localBase;

console.log('\n' + '─'.repeat(62));
console.log('  Send them this link and this passcode:');
console.log(`\n    ${base}`);
console.log(`    passcode:  ${guestPasscode}`);
console.log(`\n  Your own passcode (same link):  ${hostPasscode}`);
console.log('─'.repeat(62));

if (!tunnel && !hostname) {
  const lan = localAddresses(options.port);
  if (lan.length) {
    console.log('On the same Wi-Fi they can also use:');
    for (const address of lan) console.log(`  ${address}`);
  }
}

if (options.turnUrls.length) {
  console.log(`\nScreen sharing will relay through ${options.turnUrls.join(', ')} if it has to.`);
}

console.log(
  options.keepPasscodes || resumed
    ? `Passcodes are the saved ones, from ${CONFIG_PATH}.`
    : 'These passcodes are new for this session, and stay valid across a restart.'
);
if (hostname && !options.tunnelName && options.tunnel) {
  console.log(
    `\nUsing ${base} as the address. If you run cloudflared yourself\n` +
      '(as a service, say), add --no-tunnel so two tunnels do not fight.'
  );
}
console.log('Press Ctrl+C to stop. Closing this window takes the link down.');

// The point of all the above is one action, so end on it rather than on a
// paragraph about passcodes.
console.log(`\n${'═'.repeat(62)}`);
if (tunnelProblem) {
  // The link above would show them Cloudflare's error page. Say so, loudly,
  // rather than let it be discovered from the other side of the world.
  console.log('  NOT READY — the link above will not work for them yet.');
  console.log(`\n  ${tunnelProblem}`);
  console.log('  Check with:  node bin/stream.js --check');
  console.log('  Then close this window and start again.');
} else if (remote) {
  // The same link as theirs: a shared screen goes browser to browser and
  // never through the tunnel, so there is nothing to save by using another.
  console.log('  READY. Send them the link and passcode above.');
  console.log(`\n  Then on THIS laptop open  ${base}`);
  console.log(`  sign in with  ${hostPasscode}  and click "Share screen".`);
  console.log('\n  Film in VLC or another program: pick "Entire Screen", leave its');
  console.log('  sound on, and put the film full screen.');
  console.log('  Film in a Chrome tab (YouTube, an .mp4 dragged in): pick that tab.');
} else {
  console.log('  READY, but there is no public link — only this network.');
  console.log(`\n  Open  ${localBase}  and click "Share screen".`);
}
console.log(`${'═'.repeat(62)}\n`);

announced = true;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nStopping...');
  supervisor?.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
