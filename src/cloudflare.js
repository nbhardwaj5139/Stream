// Helpers for wiring a named Cloudflare tunnel to this machine. Kept separate
// from the CLI so the fiddly parts (which file, what YAML) can be tested.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
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
