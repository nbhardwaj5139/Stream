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
  inspectHostname,
  isLoggedIn,
  isValidHostname,
  isValidTunnelName,
  listTunnels,
  tunnelInfo,
} from '../src/cloudflare.js';

const execFileAsync = promisify(execFile);

const USAGE = `
Usage
  node bin/setup-tunnel.js <hostname> [--name <tunnel>] [--port <number>]
  node bin/setup-tunnel.js --check <hostname> [--name <tunnel>] [--port <number>]

Examples
  node bin/setup-tunnel.js movies.example.com
  node bin/setup-tunnel.js --check movies.example.com
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
let checkOnly = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--name') tunnelName = args[++i];
  else if (args[i] === '--port') port = Number(args[++i]);
  else if (args[i] === '--check') checkOnly = true;
  else if (!args[i].startsWith('-')) hostname = args[i];
}

hostname = hostname?.replace(/^https?:\/\//, '').replace(/\/+$/, '') ?? null;
// "movies.example.com" -> tunnel called "movies", unless told otherwise.
tunnelName ??= hostname?.split('.')[0] ?? null;

if (!isValidHostname(hostname)) fail(`Not a usable hostname: ${hostname}\n\n${USAGE}`);
if (!isValidTunnelName(tunnelName)) fail(`Not a usable tunnel name: ${tunnelName}`);
if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`Not a usable port: ${port}`);

let hasCloudflared = true;
try {
  await execFileAsync('cloudflared', ['--version'], { timeout: 10_000 });
} catch {
  hasCloudflared = false;
  // Diagnosing is still worth doing without it; setting up is not.
  if (!checkOnly) {
    fail(
      'cloudflared is not installed.\n' +
        '  Windows:  winget install Cloudflare.cloudflared\n' +
        '  macOS:    brew install cloudflared\n' +
        '  Linux:    https://github.com/cloudflare/cloudflared/releases'
    );
  }
}

// ------------------------------------------------------------------ check --

if (checkOnly) {
  console.log(`Checking ${hostname}\n`);

  // 1. Is the room even running here?
  let local = null;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(4000),
    });
    local = await response.json();
    console.log(`  server    running on port ${port}, ${local.files} file(s) shared`);
  } catch {
    console.log(`  server    NOT running on port ${port}`);
  }

  // 2. Where does the name point, here and in the wider world?
  const dnsResult = await inspectHostname(hostname);
  const show = (label, answer) =>
    console.log(
      `  ${label.padEnd(9)} ${answer.addresses.length ? answer.addresses.join(', ') : `no answer (${answer.error})`}`
    );
  show('dns here', dnsResult.system);
  show('dns 1.1.1.1', dnsResult.public);
  if (dnsResult.cname) console.log(`  cname     ${dnsResult.cname}`);
  console.log(`            ${dnsResult.detail}`);

  // 3. Is the tunnel connected to Cloudflare's edge?
  const info = hasCloudflared ? await tunnelInfo(tunnelName) : null;
  if (!hasCloudflared) console.log('  tunnel    cloudflared is not installed on this machine');
  const connections = info?.conns?.length ?? 0;
  if (!hasCloudflared) {
    /* already reported above */
  } else if (!info) {
    console.log(`  tunnel    "${tunnelName}" not found, or cloudflared could not read it`);
  } else if (connections === 0) {
    console.log(`  tunnel    "${tunnelName}" exists but has NO live connections`);
  } else {
    console.log(`  tunnel    "${tunnelName}" connected (${connections} edge connection(s))`);
    if (info.id) console.log(`            id ${info.id}`);
    console.log('            the DNS record must point at this same id');
  }

  console.log('\nWhat this means:\n');
  if (dnsResult.verdict === 'no-dns') {
    console.log('  The DNS record is missing. Run the setup again without --check.');
  } else if (dnsResult.verdict === 'local-dns') {
    console.log('  The record exists — this machine just cannot see it yet.');
    console.log('  Clear the cached failure and try again:');
    console.log('');
    console.log('    ipconfig /flushdns');
    console.log('');
    console.log('  Chrome keeps its own cache too: open chrome://net-internals/#dns');
    console.log('  and press "Clear host cache", then reload.');
    console.log('');
    console.log('  If it still will not resolve, this network\u2019s DNS server is refusing');
    console.log('  the name. Try it on a phone over mobile data to confirm.');
  } else if (dnsResult.verdict === 'private-address' || dnsResult.verdict === 'not-cloudflare') {
    console.log(`  ${dnsResult.detail}`);
    console.log('  Open the Cloudflare dashboard -> DNS, delete any A or CNAME record on');
    console.log(`  "${hostname.split('.')[0]}", then run the setup again.`);
  } else if (!local) {
    console.log(`  DNS is fine, but nothing is serving on port ${port}.`);
    console.log('  Start the room first, in another window.');
  } else if (connections === 0) {
    console.log('  DNS is fine and the room is running, but no tunnel is connected.');
    console.log(`  Start it with:  node bin/stream.js "<folder>" --tunnel-name ${tunnelName} --hostname ${hostname}`);
  } else {
    console.log('  Everything on this machine looks right.');
    console.log('');
    console.log('  If the browser shows Cloudflare error 1033, the DNS record points at a');
    console.log('  different tunnel than the one running. That cannot be seen from here —');
    console.log('  a tunnel record is always proxied, so DNS only ever answers with');
    console.log(`  Cloudflare's own addresses. Re-run the setup to repoint it:`);
    console.log('');
    console.log(`    node bin/setup-tunnel.js ${hostname} --name ${tunnelName}`);
    console.log('');
    console.log('  If it times out instead, something between you and Cloudflare is');
    console.log('  blocking it — a corporate network or DNS filter is the usual cause.');
    console.log('  Try the same address from a phone on mobile data to confirm.');
  }
  console.log('');
  process.exit(0);
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

// Capture rather than inherit: cloudflared's "record already exists" is the
// normal answer on a re-run, and it should not look like a failure.
async function route(extraArgs = []) {
  try {
    await execFileAsync('cloudflared', ['tunnel', 'route', 'dns', ...extraArgs, tunnelName, hostname], {
      timeout: 60_000,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: `${error.stdout ?? ''}${error.stderr ?? error.message ?? ''}` };
  }
}

let routeResult = await route();
if (!routeResult.ok) {
  const existing = /record with that host already exists/i.test(routeResult.message);
  const check = await inspectHostname(hostname);

  if (existing && check.verdict === 'ok') {
    // Already a Cloudflare record. Repoint it rather than making them go and
    // delete it by hand — it is this tool's own record from a previous run.
    const retry = await route(['--overwrite-dns']);
    routeResult = retry;
    console.log(retry.ok ? '     Repointed the existing record.' : '     Could not repoint it.');
  }

  if (!routeResult.ok) {
    if (check.verdict === 'ok') {
      console.log('     (already pointing at Cloudflare — continuing)');
    } else {
      console.log(`     Could not route ${hostname}.`);
      console.log(`     ${check.detail}`);
      console.log('     Delete any existing A/CNAME record for that name in the Cloudflare');
      console.log('     dashboard (DNS tab), then run this again.');
    }
  }
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
