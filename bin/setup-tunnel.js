#!/usr/bin/env node
// One-time wiring of a permanent address on a domain you own.
//
//   node bin/setup-tunnel.js movies.example.com
//
// Runs the cloudflared steps in order, writes its config file, and prints the
// command to start the room. Safe to re-run: every step is skipped if it is
// already done.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import readline from 'node:readline/promises';

import {
  backupExistingConfig,
  buildConfigYaml,
  cloudflaredDir,
  configPath,
  credentialsPath,
  findTunnel,
  isLoggedIn,
  isValidHostname,
  isValidTunnelName,
  listTunnels,
} from '../src/cloudflare.js';

const execFileAsync = promisify(execFile);

const USAGE = `
Usage
  node bin/setup-tunnel.js <hostname> [--name <tunnel>] [--port <number>]

Example
  node bin/setup-tunnel.js movies.example.com
`.trim();

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

// Interactive steps need a real terminal (the login opens a browser).
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited with ${code}`))
    );
  });
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
  console.log(USAGE);
  process.exit(0);
}

let hostname = null;
let tunnelName = null;
let port = 8420;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--name') tunnelName = args[++i];
  else if (args[i] === '--port') port = Number(args[++i]);
  else if (!args[i].startsWith('-')) hostname = args[i];
}

hostname = hostname?.replace(/^https?:\/\//, '').replace(/\/+$/, '') ?? null;
// "movies.example.com" -> tunnel called "movies", unless told otherwise.
tunnelName ??= hostname?.split('.')[0] ?? null;

if (!isValidHostname(hostname)) fail(`Not a usable hostname: ${hostname}\n\n${USAGE}`);
if (!isValidTunnelName(tunnelName)) fail(`Not a usable tunnel name: ${tunnelName}`);
if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`Not a usable port: ${port}`);

try {
  await execFileAsync('cloudflared', ['--version'], { timeout: 10_000 });
} catch {
  fail(
    'cloudflared is not installed.\n' +
      '  Windows:  winget install Cloudflare.cloudflared\n' +
      '  macOS:    brew install cloudflared\n' +
      '  Linux:    https://github.com/cloudflare/cloudflared/releases'
  );
}

console.log(`Setting up ${hostname} -> http://localhost:${port}\n`);

// 1. Authorise this machine against the account that owns the domain.
if (isLoggedIn()) {
  console.log('1/4  Already logged in to Cloudflare.');
} else {
  console.log('1/4  Opening a browser to log in. Pick the domain you want to use.');
  try {
    await run('cloudflared', ['tunnel', 'login']);
  } catch (error) {
    fail(`Login failed: ${error.message}`);
  }
  if (!isLoggedIn()) fail(`Login did not produce a certificate in ${cloudflaredDir()}.`);
}

// 2. Create the tunnel, or reuse it if this is a re-run.
let tunnel = findTunnel(await listTunnels(), tunnelName);
if (tunnel) {
  console.log(`2/4  Tunnel "${tunnelName}" already exists (${tunnel.id}).`);
} else {
  console.log(`2/4  Creating tunnel "${tunnelName}".`);
  try {
    await run('cloudflared', ['tunnel', 'create', tunnelName]);
  } catch (error) {
    fail(`Could not create the tunnel: ${error.message}`);
  }
  tunnel = findTunnel(await listTunnels(), tunnelName);
  if (!tunnel) fail('The tunnel was created but could not be found afterwards.');
}

const credentials = credentialsPath(tunnel.id);
if (!fs.existsSync(credentials)) {
  fail(
    `The tunnel's credentials file is missing:\n  ${credentials}\n\n` +
      'If you created this tunnel on another machine, copy that file across.'
  );
}

// 3. Point the DNS record at the tunnel.
console.log(`3/4  Routing ${hostname} to the tunnel.`);
try {
  await run('cloudflared', ['tunnel', 'route', 'dns', tunnelName, hostname]);
} catch {
  // Re-running is the usual reason this fails, and it is harmless.
  console.log(`     (already routed, or a record for ${hostname} exists — continuing)`);
}

// 4. Write the config cloudflared reads on startup.
const target = configPath();
const backup = backupExistingConfig(target);
if (backup) console.log(`4/4  Saved your previous config to ${backup}`);

fs.mkdirSync(cloudflaredDir(), { recursive: true });
fs.writeFileSync(target, buildConfigYaml({ tunnelName, tunnelId: tunnel.id, hostname, port }));
console.log(`4/4  Wrote ${target}`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log(`\nDone. Start the room with:\n`);
console.log(`  node bin/stream.js "YOUR\\MOVIE\\FOLDER" --tunnel-name ${tunnelName} --hostname ${hostname}\n`);
console.log(`Then send her:  https://${hostname}`);
console.log('DNS can take a minute or two the first time.\n');
rl.close();
