// Everything that has to be true before the evening, checked on a Tuesday.
//
// Each failure here is one that otherwise turns up at the worst moment: a
// tunnel pointing at the wrong place, a relay with a stale password, a port
// something else already took. The checks are deliberately dull and every
// dependency is injectable, so the whole thing runs offline under test.
import fs from 'node:fs';
import net from 'node:net';

import { inspectHostname, readIngressHostnames } from './cloudflare.js';
import { detectFfmpeg } from './media.js';
import { checkRelay, describeRelay, parseTurnUrl } from './turn.js';
import { hasCloudflared } from './tunnel.js';

const ok = (name, detail) => ({ name, status: 'ok', detail });
const warn = (name, detail, fix = null) => ({ name, status: 'warn', detail, fix });
const fail = (name, detail, fix = null) => ({ name, status: 'fail', detail, fix });

// Is anything already sitting on the port we want?
export function probePort(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => resolve({ free: false, code: error.code }));
    server.once('listening', () => server.close(() => resolve({ free: true, code: null })));
    server.listen(port, host);
  });
}

async function checkFolders(roots, { statDir }) {
  // The normal case now: screen sharing needs no folder.
  if (!roots.length) return [ok('Folders', 'None — screen sharing only.')];

  const missing = [];
  for (const dir of roots) {
    try {
      if (!statDir(dir).isDirectory()) missing.push(dir);
    } catch {
      missing.push(dir);
    }
  }
  if (missing.length) {
    return [fail('Folders', `Cannot read ${missing.join(', ')}`, 'Check the drive is plugged in and the path is right.')];
  }
  return [ok('Folders', `${roots.length} folder${roots.length === 1 ? '' : 's'} readable.`)];
}

async function checkPort(port, { probe }) {
  const result = await probe(port);
  if (result.free) return [ok('Port', `${port} is free.`)];
  if (result.code === 'EADDRINUSE') {
    return [fail('Port', `Something is already using ${port}.`, `Close it, or start with --port ${port + 1}.`)];
  }
  return [fail('Port', `Cannot listen on ${port} (${result.code}).`)];
}

async function checkTunnel({ hostname, tunnelName }, { cloudflared, inspect, ingressHostnames }) {
  const checks = [];
  if (!hostname && !tunnelName) {
    return [warn('Public link', 'No subdomain configured — a throwaway link will be made at start-up.')];
  }

  if (!(await cloudflared())) {
    return [fail('Public link', 'cloudflared is not installed.', 'Install it, then run bin/setup-tunnel.js.')];
  }

  // The config on disk is what cloudflared will actually serve. A hostname
  // that is not in it is the single most common cause of a 1033 page.
  if (hostname) {
    const configured = ingressHostnames();
    if (configured.length && !configured.includes(hostname)) {
      checks.push(
        fail(
          'Tunnel config',
          `cloudflared serves ${configured.join(', ')}, not ${hostname}.`,
          `Re-run: node bin/setup-tunnel.js ${hostname}`
        )
      );
    } else {
      checks.push(ok('Tunnel config', `cloudflared is set up for ${hostname}.`));
    }

    const seen = await inspect(hostname);
    if (seen.verdict === 'ok') {
      checks.push(ok('DNS', `${hostname} resolves to Cloudflare.`));
    } else if (seen.verdict === 'local-dns') {
      // The record exists; this machine's resolver simply has not caught up,
      // which is a negative cache entry expiring, not a misconfiguration.
      checks.push(warn('DNS', seen.detail, 'Usually clears by itself within a few minutes.'));
    } else {
      checks.push(
        fail('DNS', seen.detail ?? `${hostname} does not resolve.`,
          `node bin/setup-tunnel.js ${hostname} --overwrite-dns`)
      );
    }
  }

  return checks;
}

async function checkRelays({ turnUrls, turnUser, turnPass }, { relay }) {
  if (!turnUrls.length) {
    return [
      warn(
        'Relay',
        'No TURN relay configured. The picture will only arrive if both networks allow a direct connection.',
        'Mobile data almost never does — see --turn in the README.'
      ),
    ];
  }

  const checks = [];
  for (const url of turnUrls) {
    // A malformed address should not take the rest of the checks down.
    try {
      parseTurnUrl(url);
    } catch (error) {
      checks.push(fail('Relay', `${url} — ${error.message}`));
      continue;
    }
    const result = await relay({ url, username: turnUser, password: turnPass });
    checks.push(result.ok ? ok('Relay', describeRelay(result)) : fail('Relay', describeRelay(result)));
  }
  return checks;
}

async function checkFfmpeg({ ffmpeg }) {
  const found = await ffmpeg();
  return found?.ffmpeg
    ? [ok('ffmpeg', 'Present, so odd formats can be repackaged if a file ever needs it.')]
    : [warn('ffmpeg', 'Not installed. Screen sharing does not need it; playing an unusual file might.')];
}

export async function preflight(options = {}, deps = {}) {
  const {
    roots = [],
    port = 8420,
    hostname = null,
    tunnelName = null,
    turnUrls = [],
    turnUser = null,
    turnPass = null,
  } = options;

  const wired = {
    statDir: fs.statSync,
    probe: probePort,
    cloudflared: hasCloudflared,
    inspect: inspectHostname,
    ingressHostnames: readIngressHostnames,
    relay: checkRelay,
    ffmpeg: detectFfmpeg,
    ...deps,
  };

  const checks = [
    ...(await checkFolders(roots, wired)),
    ...(await checkPort(port, wired)),
    ...(await checkTunnel({ hostname, tunnelName }, wired)),
    ...(await checkRelays({ turnUrls, turnUser, turnPass }, wired)),
    ...(await checkFfmpeg(wired)),
  ];

  return {
    checks,
    failures: checks.filter((check) => check.status === 'fail').length,
    warnings: checks.filter((check) => check.status === 'warn').length,
    ok: checks.every((check) => check.status !== 'fail'),
  };
}

const MARK = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };

export function formatPreflight({ checks, failures, warnings, ok: passed }) {
  const lines = checks.map((check) => {
    const head = `  [${MARK[check.status]}] ${check.name}: ${check.detail}`;
    return check.fix && check.status !== 'ok' ? `${head}\n         ${check.fix}` : head;
  });

  lines.push('');
  if (!passed) {
    lines.push(`${failures} thing${failures === 1 ? '' : 's'} would stop the evening. Fix those first.`);
  } else if (warnings) {
    lines.push(`Nothing is broken. ${warnings} thing${warnings === 1 ? '' : 's'} worth a look above.`);
  } else {
    lines.push('All clear.');
  }
  return lines.join('\n');
}
