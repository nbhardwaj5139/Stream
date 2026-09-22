import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server.js';
import { AttemptLimiter } from '../src/auth.js';

const HOST_PASSCODE = 'HOSTPC';
const GUEST_PASSCODE = 'GUESTPC';

let server;
let baseUrl;
let mediaRoot;
let fileId;
let hostCookie;
let guestCookie;

const FILE_SIZE = 64 * 1024;
const expectedByte = (index) => index % 251;

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
  mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'stream-test-'));
  await fs.mkdir(path.join(mediaRoot, 'Nested'));

  const body = Buffer.alloc(FILE_SIZE);
  for (let i = 0; i < FILE_SIZE; i++) body[i] = expectedByte(i);
  await fs.writeFile(path.join(mediaRoot, 'Nested', 'Movie Night.mp4'), body);
  await fs.writeFile(
    path.join(mediaRoot, 'Nested', 'Movie Night.en.srt'),
    '1\n00:00:01,000 --> 00:00:03,000\nHello\n'
  );
  await fs.writeFile(path.join(mediaRoot, 'notes.txt'), 'not a video');

  server = await createServer({
    roots: [mediaRoot],
    hostPasscode: HOST_PASSCODE,
    guestPasscode: GUEST_PASSCODE,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  hostCookie = (await join(baseUrl, HOST_PASSCODE, 'Host')).cookie;
  guestCookie = (await join(baseUrl, GUEST_PASSCODE, 'Guest')).cookie;

  const library = await (await fetch(`${baseUrl}/api/library`, as(hostCookie))).json();
  fileId = library.items[0].id;
  // Guests can only reach what is playing, so put this file on screen.
  server.room.mediaId = fileId;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(mediaRoot, { recursive: true, force: true });
});

test('the front door shows a passcode page, not an error', async () => {
  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /passcode/i);
  assert.match(html, /id="join-form"/);
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
  for (const route of ['/api/library', '/api/session', `/stream/${fileId}`, `/api/media/${fileId}`]) {
    assert.equal((await fetch(`${baseUrl}${route}`)).status, 401, route);
  }
});

test('a forged or expired session cookie is rejected', async () => {
  const forged = 'stream_session=eyJyb2xlIjoiaG9zdCJ9.not-a-real-signature';
  assert.equal((await fetch(`${baseUrl}/api/library`, as(forged))).status, 401);
});

test('repeated wrong passcodes get locked out', async () => {
  const strict = await createServer({
    roots: [mediaRoot],
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

test('the library finds videos recursively and ignores other files', async () => {
  const body = await (await fetch(`${baseUrl}/api/library`, as(hostCookie))).json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].relativePath, path.join('Nested', 'Movie Night.mp4'));
  assert.equal(body.items[0].size, FILE_SIZE);
});

test('guests cannot trigger a rescan', async () => {
  const guest = await fetch(`${baseUrl}/api/rescan`, { method: 'POST', ...as(guestCookie) });
  assert.equal(guest.status, 403);
  const host = await fetch(`${baseUrl}/api/rescan`, { method: 'POST', ...as(hostCookie) });
  assert.equal(host.status, 200);
});

test('the host sees the folder paths; the guest does not', async () => {
  const host = await (await fetch(`${baseUrl}/api/session`, as(hostCookie))).json();
  assert.equal(host.role, 'host');
  assert.ok(Array.isArray(host.roots));

  const guest = await (await fetch(`${baseUrl}/api/session`, as(guestCookie))).json();
  assert.equal(guest.role, 'guest');
  assert.equal(guest.roots, undefined);
});

test('a plain request streams the whole file', async () => {
  const response = await fetch(`${baseUrl}/stream/${fileId}`, as(guestCookie));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, FILE_SIZE);
  assert.equal(bytes[FILE_SIZE - 1], expectedByte(FILE_SIZE - 1));
});

test('a range request returns exactly the bytes asked for', async () => {
  const response = await fetch(`${baseUrl}/stream/${fileId}`, {
    headers: { cookie: guestCookie, range: 'bytes=1000-1099' },
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes 1000-1099/${FILE_SIZE}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, 100);
  for (let i = 0; i < 100; i++) assert.equal(bytes[i], expectedByte(1000 + i));
});

test('an open-ended range runs to the end of the file', async () => {
  const response = await fetch(`${baseUrl}/stream/${fileId}`, {
    headers: { cookie: guestCookie, range: `bytes=${FILE_SIZE - 10}-` },
  });
  assert.equal(response.status, 206);
  assert.equal((await response.arrayBuffer()).byteLength, 10);
});

test('an unsatisfiable range gets a 416', async () => {
  const response = await fetch(`${baseUrl}/stream/${fileId}`, {
    headers: { cookie: guestCookie, range: 'bytes=999999-' },
  });
  assert.equal(response.status, 416);
  assert.equal(response.headers.get('content-range'), `bytes */${FILE_SIZE}`);
});

test('sidecar subtitles are served as WebVTT', async () => {
  const description = await (await fetch(`${baseUrl}/api/media/${fileId}`, as(guestCookie))).json();
  assert.equal(description.subtitles.length, 1);
  assert.equal(description.subtitles[0].label, 'en');

  const response = await fetch(
    `${baseUrl}/subtitles/${fileId}/${description.subtitles[0].id}.vtt`,
    as(guestCookie)
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/vtt/);
  assert.match(await response.text(), /00:00:01\.000 --> 00:00:03\.000/);
});

test('unknown ids and paths 404 rather than leaking the filesystem', async () => {
  assert.equal((await fetch(`${baseUrl}/stream/${'f'.repeat(16)}`, as(hostCookie))).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/media/nope`, as(hostCookie))).status, 404);
  assert.equal((await fetch(`${baseUrl}/static/../src/server.js`, as(hostCookie))).status, 404);
  assert.equal((await fetch(`${baseUrl}/stream/..%2F..%2Fetc%2Fpasswd`, as(hostCookie))).status, 404);
});

test('files a browser cannot open are routed to the transcoder', async () => {
  await fs.writeFile(path.join(mediaRoot, 'Old Film.mkv'), Buffer.alloc(4096));
  await fetch(`${baseUrl}/api/rescan`, { method: 'POST', ...as(hostCookie) });

  const library = await (await fetch(`${baseUrl}/api/library`, as(hostCookie))).json();
  const mkv = library.items.find((item) => item.relativePath.endsWith('.mkv'));
  const description = await (await fetch(`${baseUrl}/api/media/${mkv.id}`, as(hostCookie))).json();
  assert.equal(description.deliveryMode, 'transcode');

  const response = await fetch(`${baseUrl}/transcode/${mkv.id}`, as(hostCookie));
  if (server.capabilities.ffmpeg) {
    assert.equal(response.status, 200);
    await response.arrayBuffer().catch(() => {});
  } else {
    assert.equal(response.status, 503);
    assert.match(await response.text(), /ffmpeg/i);
  }
});

test('transcoding can be turned off entirely', async () => {
  const strict = await createServer({
    roots: [mediaRoot],
    hostPasscode: HOST_PASSCODE,
    guestPasscode: GUEST_PASSCODE,
    allowTranscode: false,
  });
  await new Promise((resolve) => strict.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${strict.address().port}`;
  const cookie = (await join(url, HOST_PASSCODE)).cookie;

  const library = await (await fetch(`${url}/api/library`, as(cookie))).json();
  const mkv = library.items.find((item) => item.relativePath.endsWith('.mkv'));
  assert.equal((await fetch(`${url}/transcode/${mkv.id}`, as(cookie))).status, 503);

  await new Promise((resolve) => strict.close(resolve));
});

test('the host and guest passcodes must differ', async () => {
  await assert.rejects(
    createServer({ roots: [mediaRoot], hostPasscode: 'SAME12', guestPasscode: 'SAME12' }),
    /must be different/
  );
});

test('logging out invalidates the browser session', async () => {
  const cookie = (await join(baseUrl, HOST_PASSCODE)).cookie;
  assert.equal((await fetch(`${baseUrl}/api/library`, as(cookie))).status, 200);

  const out = await fetch(`${baseUrl}/api/logout`, { method: 'POST', ...as(cookie) });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
});

test('a guest cannot list the library at all', async () => {
  const response = await fetch(`${baseUrl}/api/library`, as(guestCookie));
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /host only/i);
});

test('a guest can only reach the file that is playing', async () => {
  const library = await (await fetch(`${baseUrl}/api/library`, as(hostCookie))).json();
  const playing = library.items.find((item) => item.relativePath.endsWith('.mp4'));
  const other = library.items.find((item) => item.id !== playing.id);

  server.room.mediaId = playing.id;

  // What is on screen: allowed.
  assert.equal((await fetch(`${baseUrl}/api/media/${playing.id}`, as(guestCookie))).status, 200);
  assert.equal((await fetch(`${baseUrl}/stream/${playing.id}`, as(guestCookie))).status, 200);

  // Anything else on the disk: refused, even holding a valid id.
  if (other) {
    assert.equal((await fetch(`${baseUrl}/api/media/${other.id}`, as(guestCookie))).status, 403);
    assert.equal((await fetch(`${baseUrl}/stream/${other.id}`, as(guestCookie))).status, 403);
    assert.equal((await fetch(`${baseUrl}/transcode/${other.id}`, as(guestCookie))).status, 403);
    assert.equal(
      (await fetch(`${baseUrl}/subtitles/${other.id}/file:0.vtt`, as(guestCookie))).status,
      403
    );
  }

  // The host is not restricted.
  assert.equal((await fetch(`${baseUrl}/api/media/${other?.id ?? playing.id}`, as(hostCookie))).status, 200);

  server.room.mediaId = fileId;
});

test('an id that was playing stops working once the film changes', async () => {
  const library = await (await fetch(`${baseUrl}/api/library`, as(hostCookie))).json();
  const [first, second] = library.items;
  if (!second) return;

  server.room.mediaId = first.id;
  assert.equal((await fetch(`${baseUrl}/stream/${first.id}`, as(guestCookie))).status, 200);

  server.room.mediaId = second.id;
  assert.equal((await fetch(`${baseUrl}/stream/${first.id}`, as(guestCookie))).status, 403);

  server.room.mediaId = fileId;
});

test('--shared-library opens the list back up', async () => {
  const shared = await createServer({
    roots: [mediaRoot],
    hostPasscode: HOST_PASSCODE,
    guestPasscode: GUEST_PASSCODE,
    libraryMode: 'shared',
  });
  await new Promise((resolve) => shared.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${shared.address().port}`;
  const cookie = (await join(url, GUEST_PASSCODE)).cookie;

  const response = await fetch(`${url}/api/library`, { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).items.length > 0);

  await new Promise((resolve) => shared.close(resolve));
});
