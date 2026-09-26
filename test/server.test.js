import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../src/server.js';
import { AttemptLimiter } from '../src/auth.js';

const HOST_PASSCODE = 'HOSTPC';
const GUEST_PASSCODE = 'GUESTPC';

let server;
let baseUrl;
let guestCookie;

// Exchange a passcode for a session cookie, the way the join page does.
async function join(url, passcode, name = 'Tester') {
  const response = await fetch(`${url}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passcode, name }),
  });
  const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? null;
  return { status: response.status, cookie, body: await response.json().catch(() => ({})) };
}

const as = (cookie) => ({ headers: { cookie } });

before(async () => {
  server = await createServer({ hostPasscode: HOST_PASSCODE, guestPasscode: GUEST_PASSCODE });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  guestCookie = (await join(baseUrl, GUEST_PASSCODE, 'Guest')).cookie;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('the front door shows a passcode gate, not an error', async () => {
  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /passcode/i);
  assert.match(html, /id="join-form"/);
});

test('loading the page drops any session, so a reload asks again', async () => {
  const cookie = (await join(baseUrl, GUEST_PASSCODE)).cookie;
  assert.equal((await fetch(`${baseUrl}/api/session`, as(cookie))).status, 200);

  // Opening the page is what clears it — that is the whole mechanism.
  const page = await fetch(`${baseUrl}/`, as(cookie));
  assert.match(page.headers.get('set-cookie'), /Max-Age=0/);
});

test('the room heading can be set, and is escaped', async () => {
  const named = await createServer({
    hostPasscode: HOST_PASSCODE,
    guestPasscode: GUEST_PASSCODE,
    roomName: 'Sam & Alex <3',
  });
  await new Promise((resolve) => named.listen(0, '127.0.0.1', resolve));
  const html = await (await fetch(`http://127.0.0.1:${named.address().port}/`)).text();

  assert.match(html, /Sam &amp; Alex &lt;3/);
  assert.doesNotMatch(html, /Sam & Alex <3/, 'the name must not be injected raw');
  assert.doesNotMatch(html, /\{\{ROOM_NAME\}\}/, 'the placeholder is filled in');

  await new Promise((resolve) => named.close(resolve));
});

test('a correct passcode returns a session cookie and the right role', async () => {
  const host = await join(baseUrl, HOST_PASSCODE);
  assert.equal(host.status, 200);
  assert.equal(host.body.role, 'host');
  assert.match(host.cookie, /^stream_session=/);

  const guest = await join(baseUrl, GUEST_PASSCODE);
  assert.equal(guest.body.role, 'guest');
});

test('the session cookie is HttpOnly so scripts cannot read it', async () => {
  const response = await fetch(`${baseUrl}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passcode: GUEST_PASSCODE }),
  });
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
});

test('a wrong passcode is refused and hands out nothing', async () => {
  const attempt = await join(baseUrl, 'NOPE42');
  assert.equal(attempt.status, 401);
  assert.equal(attempt.cookie, null);
  assert.match(attempt.body.error, /not right/i);
});

test('the passcode never appears in a URL', async () => {
  // The whole point of the join flow: the link is safe to paste anywhere.
  const page = await fetch(`${baseUrl}/`);
  const html = await page.text();
  assert.doesNotMatch(html, new RegExp(GUEST_PASSCODE));
  assert.doesNotMatch(html, /[?&]k=/);
});

test('without a session every route is closed', async () => {
  assert.equal((await fetch(`${baseUrl}/api/session`)).status, 401);
  // The old file routes are gone entirely, not merely locked.
  const cookie = (await join(baseUrl, HOST_PASSCODE)).cookie;
  for (const route of ['/api/library', `/stream/${'a'.repeat(16)}`, `/api/media/${'a'.repeat(16)}`, '/hls/x/playlist.m3u8']) {
    assert.equal((await fetch(`${baseUrl}${route}`, as(cookie))).status, 404, route);
  }
});

test('a forged or expired session cookie is rejected', async () => {
  const forged = 'stream_session=eyJyb2xlIjoiaG9zdCJ9.not-a-real-signature';
  assert.equal((await fetch(`${baseUrl}/api/session`, as(forged))).status, 401);
});

test('repeated wrong passcodes get locked out', async () => {
  const strict = await createServer({
    hostPasscode: HOST_PASSCODE,
    guestPasscode: GUEST_PASSCODE,
    limiter: new AttemptLimiter({ maxPerClient: 3, lockoutMs: 60_000 }),
  });
  await new Promise((resolve) => strict.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${strict.address().port}`;

  for (let i = 0; i < 3; i++) assert.equal((await join(url, `WRONG${i}`)).status, 401);

  const blocked = await join(url, 'WRONGX');
  assert.equal(blocked.status, 429);
  assert.match(blocked.body.error, /too many/i);

  // Even the correct passcode is refused while the lockout holds.
  assert.equal((await join(url, GUEST_PASSCODE)).status, 429);

  await new Promise((resolve) => strict.close(resolve));
});

test('the host and guest passcodes must differ', async () => {
  await assert.rejects(
    createServer({ hostPasscode: 'SAME12', guestPasscode: 'SAME12' }),
    /must be different/
  );
});

test('logging out invalidates the browser session', async () => {
  const cookie = (await join(baseUrl, HOST_PASSCODE)).cookie;
  assert.equal((await fetch(`${baseUrl}/api/session`, as(cookie))).status, 200);

  const out = await fetch(`${baseUrl}/api/logout`, { method: 'POST', ...as(cookie) });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
});

test('the session ends with the browser unless devices are remembered', async () => {
  // No Max-Age means the cookie is dropped when the browser closes, so the
  // passcode is asked for again next time.
  const response = await fetch(`${baseUrl}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passcode: GUEST_PASSCODE }),
  });
  const cookie = response.headers.get('set-cookie');
  assert.doesNotMatch(cookie, /Max-Age/, 'the cookie must not outlive the browser');
  assert.match(cookie, /HttpOnly/);

  const remembering = await createServer({
    hostPasscode: HOST_PASSCODE,
    guestPasscode: GUEST_PASSCODE,
    rememberDevices: true,
  });
  await new Promise((resolve) => remembering.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${remembering.address().port}`;
  // The raw header, not the helper's trimmed name=value pair.
  const remembered = await fetch(`${url}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passcode: GUEST_PASSCODE }),
  });
  assert.match(remembered.headers.get('set-cookie'), /Max-Age=\d+/);
  await new Promise((resolve) => remembering.close(resolve));
});

test('the page points at versioned scripts so a stale client cannot persist', async () => {
  const html = await (await fetch(`${baseUrl}/`)).text();

  const scripts = [...html.matchAll(/(?:src|href)="\/static\/(app\.js|styles\.css)\?v=([a-f0-9]+)"/g)];
  assert.equal(scripts.length, 2, 'both the script and the stylesheet are versioned');
  assert.doesNotMatch(html, /\{\{ASSETS\}\}/, 'the placeholder is filled in');

  // Same content, same stamp — the page is not cache-busted on every load.
  const again = await (await fetch(`${baseUrl}/`)).text();
  assert.equal(
    [...again.matchAll(/\?v=([a-f0-9]+)/g)][0][1],
    scripts[0][2],
    'the stamp is derived from the files, not generated per request'
  );

  const version = scripts[0][2];
  const versioned = await fetch(`${baseUrl}/static/app.js?v=${version}`);
  assert.equal(versioned.status, 200);
  assert.match(versioned.headers.get('cache-control'), /immutable/);

  // Without the stamp it must be revalidated, or an old copy could stick.
  const plain = await fetch(`${baseUrl}/static/app.js`);
  assert.match(plain.headers.get('cache-control'), /no-cache/);
});


test('the session says who you are and nothing about the machine', async () => {
  const session = await (await fetch(`${baseUrl}/api/session`, as(guestCookie))).json();
  assert.equal(session.role, 'guest');
  assert.ok(session.assets);
  // No folders, no encoder details: nothing about the host's machine leaks.
  assert.deepEqual(Object.keys(session).sort(), ['assets', 'name', 'role']);
});

test('the page has no file library in it any more', async () => {
  const html = await (await fetch(`${baseUrl}/`)).text();
  assert.doesNotMatch(html, /library|Choose a film|quality/i);
  assert.match(html, /id="btn-share"/);
  assert.match(html, /id="btn-test"/);
});
