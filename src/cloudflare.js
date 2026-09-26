// Helpers for wiring a named Cloudflare tunnel to this machine. Kept separate
// from the CLI so the fiddly parts (which file, what YAML) can be tested.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import dns from 'node:dns/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function cloudflaredDir() {
  return path.join(os.homedir(), '.cloudflared');
}

// Written by `cloudflared tunnel login`; its presence means this machine is
// already authorised for the account.
export function isLoggedIn() {
  return fs.existsSync(path.join(cloudflaredDir(), 'cert.pem'));
}

export function configPath() {
  return path.join(cloudflaredDir(), 'config.yml');
}

export function credentialsPath(tunnelId) {
  return path.join(cloudflaredDir(), `${tunnelId}.json`);
}

export function isValidHostname(hostname) {
  if (typeof hostname !== 'string') return false;
  if (hostname.length === 0 || hostname.length > 253) return false;
  if (hostname.includes('://') || hostname.includes('/')) return false;
  // Needs at least one dot: "movies" alone is not routable.
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(hostname);
}

export function isValidTunnelName(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(name);
}

export async function listTunnels() {
  try {
    const { stdout } = await execFileAsync('cloudflared', ['tunnel', 'list', '--output', 'json'], {
      timeout: 30_000,
      maxBuffer: 4 << 20,
    });
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function findTunnel(tunnels, name) {
  return tunnels.find((tunnel) => tunnel.name === name) ?? null;
}

// cloudflared reads this on startup; it maps the public hostname to our port.
// Anything that is not our hostname gets a 404 rather than reaching the app.
export function buildConfigYaml({ tunnelName, tunnelId, hostname, port }) {
  return [
    `tunnel: ${tunnelName}`,
    `credentials-file: ${credentialsPath(tunnelId)}`,
    '',
    'ingress:',
    `  - hostname: ${hostname}`,
    `    service: http://localhost:${port}`,
    '    originRequest:',
    '      # Movies are long; do not cut the connection mid-film.',
    '      connectTimeout: 30s',
    '      noTLSVerify: false',
    '      disableChunkedEncoding: false',
    '  - service: http_status:404',
    '',
  ].join('\n');
}

export function backupExistingConfig(target = configPath()) {
  if (!fs.existsSync(target)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${target}.${stamp}.bak`;
  fs.copyFileSync(target, backup);
  return backup;
}

// Cloudflare's published proxy ranges, abbreviated to the ones a proxied
// record actually lands in. A hostname resolving outside these is not going
// through Cloudflare, which is the usual reason a tunnel "times out".
const CLOUDFLARE_PREFIXES = [
  '104.16.', '104.17.', '104.18.', '104.19.', '104.20.', '104.21.', '104.22.',
  '104.23.', '104.24.', '104.25.', '104.26.', '104.27.', '104.28.',
  '172.64.', '172.65.', '172.66.', '172.67.', '172.68.', '172.69.', '172.70.', '172.71.',
  '162.159.', '173.245.', '188.114.', '190.93.', '197.234.', '198.41.',
];

export function isCloudflareAddress(address) {
  return CLOUDFLARE_PREFIXES.some((prefix) => address.startsWith(prefix));
}

export function isPrivateAddress(address) {
  return (
    address.startsWith('10.') ||
    address.startsWith('192.168.') ||
    address.startsWith('127.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address) ||
    /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(address) // CGNAT / VPN
  );
}

// Resolving through one resolver cannot tell "the record does not exist" from
// "this machine cannot see it" — and on a work laptop behind a corporate DNS
// server, or after a failed lookup has been negatively cached, those look
// identical. So ask the system resolver and a public one, and compare.
const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8'];

async function resolveBoth(resolver, hostname) {
  const answer = { cname: null, addresses: [], error: null };
  try {
    answer.cname = (await resolver.resolveCname(hostname))[0] ?? null;
  } catch {
    /* proxied records answer with addresses rather than a visible CNAME */
  }
  try {
    answer.addresses = await resolver.resolve4(hostname);
  } catch (error) {
    answer.error = error.code ?? 'FAILED';
  }
  return answer;
}

function classify(addresses) {
  if (addresses.some(isPrivateAddress)) return 'private-address';
  if (!addresses.some(isCloudflareAddress)) return 'not-cloudflare';
  return 'ok';
}

// Works out what a hostname currently points at, and what that implies.
export async function inspectHostname(hostname) {
  const publicResolver = new dns.Resolver({ timeout: 5000, tries: 2 });
  publicResolver.setServers(PUBLIC_RESOLVERS);

  const [system, world] = await Promise.all([
    resolveBoth(dns, hostname),
    resolveBoth(publicResolver, hostname),
  ]);

  const best = system.addresses.length ? system : world;
  const result = {
    hostname,
    system,
    public: world,
    cname: best.cname,
    addresses: best.addresses,
    verdict: null,
    detail: null,
  };

  Object.assign(result, judge({ system, public: world, cname: result.cname }));
  return result;
}

const DETAIL = {
  'no-dns': 'The name does not resolve anywhere — the DNS record was never created.',
  'local-dns':
    'Public DNS can see it but this machine cannot. Either a failed lookup is ' +
    'still cached here, or this network\u2019s DNS server will not resolve it.',
  'private-address':
    'It points at a private address, so it only works on that network. ' +
    'An old A record is probably shadowing the tunnel.',
  'not-cloudflare':
    'It resolves somewhere that is not Cloudflare, so the tunnel is not in the path. ' +
    'Check for an existing A or CNAME record on that name.',
  ok: 'DNS points at Cloudflare, which is correct.',
};

// Pure decision, given what each resolver answered.
export function judge({ system, public: world, cname = null }) {
  const systemSees = system.addresses.length > 0;
  const worldSees = world.addresses.length > 0;

  if (!systemSees && !worldSees) return { verdict: 'no-dns', detail: DETAIL['no-dns'] };
  if (!systemSees) return { verdict: 'local-dns', detail: DETAIL['local-dns'] };

  const addresses = system.addresses;
  const verdict = classify(addresses);
  if (verdict !== 'ok') return { verdict, detail: DETAIL[verdict] };

  if (cname && !cname.endsWith('.cfargotunnel.com')) {
    return { verdict: 'wrong-target', detail: `It is a CNAME to ${cname}, not to a tunnel.` };
  }

  return {
    verdict: 'ok',
    detail: worldSees ? DETAIL.ok : 'This machine resolves it correctly.',
  };
}

export async function tunnelInfo(name) {
  try {
    const { stdout } = await execFileAsync('cloudflared', ['tunnel', 'info', '--output', 'json', name], {
      timeout: 30_000,
      maxBuffer: 4 << 20,
    });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

// The hostnames cloudflared is actually configured to serve. We wrote this
// file ourselves, so a full YAML parser is not worth pulling in.
export function parseIngressHostnames(yaml) {
  return [...yaml.matchAll(/^\s*-\s*hostname:\s*["']?([^"'\s#]+)/gm)].map((match) => match[1]);
}

export function readIngressHostnames(file = configPath()) {
  try {
    return parseIngressHostnames(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

// The tunnel cloudflared is configured to run. With the hostname above, it is
// everything needed to start the room on a laptop that has been set up but
// never told — so a double-click works the first time, not the second.
export function parseTunnelName(yaml) {
  const match = /^\s*tunnel:\s*["']?([^"'\s#]+)/m.exec(yaml ?? '');
  return match ? match[1] : null;
}

export function readTunnelName(file = configPath()) {
  try {
    return parseTunnelName(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
