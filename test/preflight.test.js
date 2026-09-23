import test from 'node:test';
import assert from 'node:assert/strict';

import { formatPreflight, preflight, probePort } from '../src/preflight.js';

// Every dependency stubbed, so the checks run without touching the network.
function stubs(overrides = {}) {
  return {
    statDir: () => ({ isDirectory: () => true }),
    probe: async () => ({ free: true, code: null }),
    cloudflared: async () => true,
    inspect: async (hostname) => ({ hostname, verdict: 'ok', detail: 'DNS points at Cloudflare, which is correct.' }),
    ingressHostnames: () => ['movies.example.com'],
    relay: async ({ url }) => ({ ok: true, stage: 'allocate', url, scheme: 'turn', host: 'r', port: 3478, roundTripMs: 20, relayed: { address: '203.0.113.9' } }),
    ffmpeg: async () => ({ ffmpeg: '/usr/bin/ffmpeg' }),
    ...overrides,
  };
}

const find = (report, name) => report.checks.find((check) => check.name === name);

test('a healthy set-up passes with nothing to say', async () => {
  const report = await preflight(
    { roots: ['/films'], port: 8420, hostname: 'movies.example.com', tunnelName: 'movies', turnUrls: ['turn:r:3478'], turnUser: 'u', turnPass: 'p' },
    stubs()
  );

  assert.equal(report.ok, true);
  assert.equal(report.failures, 0);
  assert.equal(report.warnings, 0);
  assert.match(formatPreflight(report), /All clear/);
});

test('a folder that is not there is fatal, and says which', async () => {
  const report = await preflight(
    { roots: ['/films', '/gone'] },
    stubs({
      statDir: (dir) => {
        if (dir === '/gone') throw new Error('ENOENT');
        return { isDirectory: () => true };
      },
    })
  );

  assert.equal(report.ok, false);
  assert.match(find(report, 'Folders').detail, /\/gone/);
  assert.doesNotMatch(find(report, 'Folders').detail, /\/films/);
});

test('having no folders is fine, because screen sharing needs none', async () => {
  const report = await preflight({ roots: [] }, stubs());
  assert.equal(find(report, 'Folders').status, 'warn');
  assert.equal(report.ok, true);
});

test('a taken port is fatal and suggests the next one', async () => {
  const report = await preflight(
    { port: 8420 },
    stubs({ probe: async () => ({ free: false, code: 'EADDRINUSE' }) })
  );

  assert.equal(find(report, 'Port').status, 'fail');
  assert.match(find(report, 'Port').fix, /--port 8421/);
  assert.match(formatPreflight(report), /would stop the evening/);
});

test('a tunnel serving a different hostname is caught before the 1033 page is', async () => {
  const report = await preflight(
    { hostname: 'stream.example.com', tunnelName: 'movies' },
    stubs({ ingressHostnames: () => ['movies.example.com'] })
  );

  const check = find(report, 'Tunnel config');
  assert.equal(check.status, 'fail');
  assert.match(check.detail, /serves movies\.example\.com, not stream\.example\.com/);
  assert.match(check.fix, /setup-tunnel\.js stream\.example\.com/);
});

test('DNS this machine cannot see yet is a warning, not a failure', async () => {
  // A negative lookup cached locally clears on its own; a missing record does not.
  const stale = await preflight(
    { hostname: 'movies.example.com', tunnelName: 'movies' },
    stubs({ inspect: async () => ({ verdict: 'local-dns', detail: 'Public DNS can see it but this machine cannot.' }) })
  );
  assert.equal(find(stale, 'DNS').status, 'warn');
  assert.equal(stale.ok, true);

  const absent = await preflight(
    { hostname: 'movies.example.com', tunnelName: 'movies' },
    stubs({ inspect: async () => ({ verdict: 'no-dns', detail: 'The name does not resolve anywhere.' }) })
  );
  assert.equal(find(absent, 'DNS').status, 'fail');
  assert.equal(absent.ok, false);
});

test('no cloudflared means no link, and the tunnel checks stop there', async () => {
  const report = await preflight(
    { hostname: 'movies.example.com' },
    stubs({ cloudflared: async () => false })
  );

  assert.equal(find(report, 'Public link').status, 'fail');
  assert.equal(find(report, 'DNS'), undefined, 'nothing to resolve without the tunnel');
});

test('a relay that refuses the credentials fails the check', async () => {
  const report = await preflight(
    { turnUrls: ['turn:r:3478'], turnUser: 'u', turnPass: 'wrong' },
    stubs({
      relay: async ({ url }) => ({ ok: false, stage: 'allocate', code: 401, url, scheme: 'turn', host: 'r', port: 3478, roundTripMs: 15 }),
    })
  );

  assert.equal(find(report, 'Relay').status, 'fail');
  assert.match(find(report, 'Relay').detail, /username or password was refused/);
});

test('a malformed relay address is reported without running the check', async () => {
  let called = false;
  const report = await preflight(
    { turnUrls: ['turn::3478'] },
    stubs({ relay: async () => { called = true; return { ok: true }; } })
  );

  assert.equal(called, false);
  assert.equal(find(report, 'Relay').status, 'fail');
});

test('no relay at all is the warning that matters most', async () => {
  const report = await preflight({ turnUrls: [] }, stubs());
  const check = find(report, 'Relay');

  assert.equal(check.status, 'warn');
  assert.match(check.fix, /Mobile data/);
  // Printed with its remedy indented under it, so it cannot be missed.
  assert.match(formatPreflight(report), /Relay: No TURN relay configured[\s\S]*\n {9}Mobile data/);
});

test('a missing ffmpeg does not stop an evening of screen sharing', async () => {
  const report = await preflight({}, stubs({ ffmpeg: async () => ({ ffmpeg: null }) }));
  assert.equal(find(report, 'ffmpeg').status, 'warn');
  assert.equal(report.ok, true);
});

test('the port probe reports a real port as taken', async (t) => {
  const net = await import('node:net');
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  assert.deepEqual(await probePort(port), { free: false, code: 'EADDRINUSE' });
  // And releases the port it borrowed, so the check is repeatable.
  const free = await probePort(0);
  assert.equal(free.free, true);
  assert.equal((await probePort(0)).free, true);
});
