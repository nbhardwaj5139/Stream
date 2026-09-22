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

// Works out what a hostname currently points at, and what that implies.
export async function inspectHostname(hostname) {
  const result = { hostname, cname: null, addresses: [], verdict: null, detail: null };

  try {
    result.cname = (await dns.resolveCname(hostname))[0] ?? null;
  } catch {
    /* a proxied record answers with addresses, not a visible CNAME */
  }

  try {
    result.addresses = await dns.resolve4(hostname);
  } catch (error) {
    result.verdict = 'no-dns';
    result.detail =
      error.code === 'ENOTFOUND' || error.code === 'ENODATA'
        ? 'The name does not resolve at all — the DNS record was never created.'
        : `DNS lookup failed (${error.code}).`;
    return result;
  }

  if (result.addresses.length === 0) {
    result.verdict = 'no-dns';
    result.detail = 'The name resolves to nothing.';
    return result;
  }

  if (result.addresses.some(isPrivateAddress)) {
    result.verdict = 'private-address';
    result.detail =
      'It points at a private address, so it only works on that network. ' +
      'An old A record is probably shadowing the tunnel.';
    return result;
  }

  if (!result.addresses.some(isCloudflareAddress)) {
    result.verdict = 'not-cloudflare';
    result.detail =
      'It resolves somewhere that is not Cloudflare, so the tunnel is not in the path. ' +
      'Check for an existing A or CNAME record on that name.';
    return result;
  }

  if (result.cname && !result.cname.endsWith('.cfargotunnel.com')) {
    result.verdict = 'wrong-target';
    result.detail = `It is a CNAME to ${result.cname}, not to a tunnel.`;
    return result;
  }

  result.verdict = 'ok';
  result.detail = 'DNS points at Cloudflare, which is correct.';
  return result;
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
