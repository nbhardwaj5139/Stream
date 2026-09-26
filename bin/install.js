#!/usr/bin/env node
// The second half of Install-Stream.cmd: everything after Node and Git are on
// the machine and the project has been downloaded. Safe to run again — each
// step checks whether it is already done.
//
//   node bin/install.js
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { isLoggedIn, isValidHostname, readIngressHostnames } from '../src/cloudflare.js';
import {
  cleanHostname,
  defaultHostname,
  launcherScript,
  shellFolder,
  tunnelNameFor,
} from '../src/setup.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const START_CMD = path.join(ROOT, 'start.cmd');
const WINDOWS = process.platform === 'win32';

// Where cloudflared's installer puts it, for the case where it has not added
// itself to PATH yet.
const CLOUDFLARED_FOLDERS = [
  path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'cloudflared'),
  path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'cloudflared'),
];

const step = (n, text) => console.log(`\n[${n}/5] ${text}`);
const say = (text) => console.log(`      ${text}`);

function fail(text) {
  console.log(`\n  ${text}\n`);
  process.exit(1);
}

// Programs are started directly, never through a shell: on Windows a shell
// joins the arguments with plain spaces, and Node itself lives in
// "C:\Program Files", so the first path with a space in it would be split in
// two. Everything run here is an .exe, which starts fine without one.
function works(command, args = ['--version']) {
  return spawnSync(command, args, { stdio: 'ignore' }).status === 0;
}

function run(command, args) {
  return spawnSync(command, args, { stdio: 'inherit' }).status === 0;
}

// One reader for the whole run, taking answers in order. Opening and closing
// one per question drops whatever was typed ahead — and nothing run in
// between reads the keyboard, so there is nothing for it to swallow.
let reader = null;
let answers = null;
async function ask(question) {
  if (!reader) {
    reader = readline.createInterface({ input: process.stdin, output: process.stdout });
    answers = reader[Symbol.asyncIterator]();
  }
  process.stdout.write(`      ${question}`);
  const { value, done } = await answers.next();
  if (done) fail('No answer came, so there is nothing more to set up. Run this again to finish.');
  return value.trim();
}

function doneAsking() {
  reader?.close();
  reader = null;
}

console.log('Setting this laptop up to host the room.');
console.log('Running this again is always safe.');

// ------------------------------------------------------------ cloudflared --

step(1, 'cloudflared, which gives the room its web address');
if (works('cloudflared')) {
  say('Already installed.');
} else {
  say('Installing...');
  run('winget', [
    'install', '--id', 'Cloudflare.cloudflared', '--exact', '--silent',
    '--accept-package-agreements', '--accept-source-agreements',
  ]);
  // A fresh install is often not on this window's PATH yet. start.cmd looks
  // in these same folders, so it will find it at login too.
  for (const folder of CLOUDFLARED_FOLDERS) {
    if (fs.existsSync(path.join(folder, 'cloudflared.exe'))) {
      process.env.PATH = `${process.env.PATH}${path.delimiter}${folder}`;
    }
  }
  if (!works('cloudflared')) fail('cloudflared did not install. Restart the laptop and run this again.');
  say('Installed.');
}

// ------------------------------------------------------------- Cloudflare --

step(2, 'Your Cloudflare account');
if (isLoggedIn()) {
  say('Already connected.');
} else {
  say('A browser window will open. Log in to Cloudflare, then click your domain.');
  say('Come back here when the page says it worked.');
  if (!run('cloudflared', ['tunnel', 'login']) || !isLoggedIn()) {
    fail('The Cloudflare login did not finish. Run this again and complete it in the browser.');
  }
}

// ----------------------------------------------------------------- address --

step(3, 'The web address');
const suggested = defaultHostname(readIngressHostnames());
let hostname = null;
while (!hostname) {
  const typed = cleanHostname(
    await ask(
      suggested
        ? `Web address for the room [${suggested}]: `
        : 'Web address for the room, on the domain you just picked (e.g. stream.yourdomain.com): '
    )
  );
  const answer = typed || suggested;
  if (answer && isValidHostname(answer)) hostname = answer;
  else say(`"${typed}" is not a web address. It should look like stream.yourdomain.com`);
}

const tunnelName = tunnelNameFor(os.hostname());
say(`${hostname}, through the tunnel "${tunnelName}"`);
if (!run(process.execPath, [path.join(ROOT, 'bin', 'setup-tunnel.js'), hostname, '--name', tunnelName])) {
  fail(`Setting up ${hostname} did not finish. The lines above say why.`);
}

// ------------------------------------------------------------------ button --

step(4, 'The Start Stream button');
if (WINDOWS) {
  const where = {
    queryRegistry: (key, value) => execFileSync('reg', ['query', key, '/v', value], { encoding: 'utf8' }),
    env: process.env,
  };
  const desktop = shellFolder('Desktop', where);
  const startup = shellFolder('Startup', where);

  fs.mkdirSync(desktop, { recursive: true });
  fs.writeFileSync(path.join(desktop, 'Start Stream.cmd'), launcherScript(START_CMD));
  say(`On the desktop: Start Stream`);

  fs.mkdirSync(startup, { recursive: true });
  fs.writeFileSync(path.join(startup, 'Start Stream.cmd'), launcherScript(START_CMD, { minimised: true }));
  say('And it will start by itself, minimised, whenever you log in.');

  // A sleeping laptop takes the site down with it. Changing that is the
  // owner's call, so ask.
  const awake = await ask('Keep this laptop awake while it is on the charger, so the site stays up? [Y/n]: ');
  if (!/^n/i.test(awake)) {
    run('powercfg', ['/change', 'standby-timeout-ac', '0']);
    say('It will stay awake on the charger. On battery nothing changes.');
  } else {
    say('Sleep settings left as they were.');
  }
} else {
  say('Not Windows: run start.sh to start the room.');
}
doneAsking();

// ------------------------------------------------------------------- start --

step(5, 'Starting the room');
if (WINDOWS) {
  // Its own window, so closing this one does not take the room with it.
  // Verbatim, because `start` treats its first quoted argument as the
  // window title and Node would otherwise decide the quoting itself.
  spawn('cmd.exe', ['/c', 'start', '"Stream"', `"${START_CMD}"`], {
    detached: true,
    stdio: 'ignore',
    windowsVerbatimArguments: true,
  }).unref();
  say('It is starting in its own window. Leave that window open.');
}
say(`When it says READY, open https://${hostname}, sign in, and press Share screen.`);
console.log('\nAll done.\n');
