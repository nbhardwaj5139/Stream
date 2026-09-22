import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server.js';

const HOST_KEY = 'a'.repeat(32);
const GUEST_KEY = 'b'.repeat(32);

let server;
let baseUrl;
let mediaRoot;
let fileId;

// 64 KiB of predictable bytes: enough to exercise range requests without
// needing a real encoder in the test environment.
const FILE_SIZE = 64 * 1024;
function expectedByte(index) {
  return index % 251;
}

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

  server = await createServer({ roots: [mediaRoot], hostKey: HOST_KEY, guestKey: GUEST_KEY });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${baseUrl}/api/library?k=${HOST_KEY}`);
  const body2 = await response.json();
  fileId = body2.items[0].id;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(mediaRoot, { recursive: true, force: true });
});

test('the library finds videos recursively and ignores other files', async () => {
  const response = await fetch(`${baseUrl}/api/library?k=${GUEST_KEY}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].relativePath, path.join('Nested', 'Movie Night.mp4'));
  assert.equal(body.items[0].size, FILE_SIZE);
});

test('requests without a valid key are refused', async () => {
  assert.equal((await fetch(`${baseUrl}/api/library`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/library?k=wrong`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/stream/${fileId}`)).status, 401);

  // The landing page shows an explanation rather than a bare 401.
  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /invite only/i);
});

test('a valid key sets a cookie so <video> requests authenticate themselves', async () => {
  const response = await fetch(`${baseUrl}/?k=${GUEST_KEY}`);
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /stream_key=/);
  assert.match(cookie, /HttpOnly/);
});

test('guests cannot trigger a rescan', async () => {
  const guest = await fetch(`${baseUrl}/api/rescan?k=${GUEST_KEY}`, { method: 'POST' });
  assert.equal(guest.status, 403);
  const host = await fetch(`${baseUrl}/api/rescan?k=${HOST_KEY}`, { method: 'POST' });
  assert.equal(host.status, 200);
});

test('a plain request streams the whole file', async () => {
  const response = await fetch(`${baseUrl}/stream/${fileId}?k=${GUEST_KEY}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(Number(response.headers.get('content-length')), FILE_SIZE);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, FILE_SIZE);
  assert.equal(bytes[0], expectedByte(0));
  assert.equal(bytes[FILE_SIZE - 1], expectedByte(FILE_SIZE - 1));
});

test('a range request returns exactly the bytes asked for', async () => {
  const response = await fetch(`${baseUrl}/stream/${fileId}?k=${GUEST_KEY}`, {
    headers: { range: 'bytes=1000-1099' },
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes 1000-1099/${FILE_SIZE}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, 100);
  for (let i = 0; i < 100; i++) assert.equal(bytes[i], expectedByte(1000 + i));
});

test('an open-ended range runs to the end of the file', async () => {
  const response = await fetch(`${baseUrl}/stream/${fileId}?k=${GUEST_KEY}`, {
    headers: { range: `bytes=${FILE_SIZE - 10}-` },
  });
  assert.equal(response.status, 206);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, 10);
  assert.equal(bytes[9], expectedByte(FILE_SIZE - 1));
});

test('an unsatisfiable range gets a 416', async () => {
  const response = await fetch(`${baseUrl}/stream/${fileId}?k=${GUEST_KEY}`, {
    headers: { range: 'bytes=999999-' },
  });
  assert.equal(response.status, 416);
  assert.equal(response.headers.get('content-range'), `bytes */${FILE_SIZE}`);
});

test('sidecar subtitles are served as WebVTT', async () => {
  const description = await (await fetch(`${baseUrl}/api/media/${fileId}?k=${GUEST_KEY}`)).json();
  assert.equal(description.subtitles.length, 1);
  assert.equal(description.subtitles[0].label, 'en');

  const response = await fetch(
    `${baseUrl}/subtitles/${fileId}/${description.subtitles[0].id}.vtt?k=${GUEST_KEY}`
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/vtt/);
  const text = await response.text();
  assert.match(text, /^WEBVTT/);
  assert.match(text, /00:00:01\.000 --> 00:00:03\.000/);
});

test('unknown ids and paths 404 rather than leaking the filesystem', async () => {
  assert.equal((await fetch(`${baseUrl}/stream/${'f'.repeat(16)}?k=${GUEST_KEY}`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/media/nope?k=${GUEST_KEY}`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/static/../src/server.js?k=${HOST_KEY}`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/stream/..%2F..%2Fetc%2Fpasswd?k=${HOST_KEY}`)).status, 404);
});

test('the host sees the guest key; the guest does not', async () => {
  const host = await (await fetch(`${baseUrl}/api/session?k=${HOST_KEY}`)).json();
  assert.equal(host.role, 'host');
  assert.equal(host.guestLinkKey, GUEST_KEY);

  const guest = await (await fetch(`${baseUrl}/api/session?k=${GUEST_KEY}`)).json();
  assert.equal(guest.role, 'guest');
  assert.equal(guest.guestLinkKey, undefined);
  assert.equal(guest.roots, undefined);
});

test('files a browser cannot open are routed to the transcoder', async () => {
  await fs.writeFile(path.join(mediaRoot, 'Old Film.mkv'), Buffer.alloc(4096));
  await fetch(`${baseUrl}/api/rescan?k=${HOST_KEY}`, { method: 'POST' });

  const library = await (await fetch(`${baseUrl}/api/library?k=${HOST_KEY}`)).json();
  const mkv = library.items.find((item) => item.relativePath.endsWith('.mkv'));
  const description = await (await fetch(`${baseUrl}/api/media/${mkv.id}?k=${HOST_KEY}`)).json();
  assert.equal(description.deliveryMode, 'transcode');

  const response = await fetch(`${baseUrl}/transcode/${mkv.id}?k=${GUEST_KEY}`);
  if (server.capabilities.ffmpeg) {
    // ffmpeg is present: it will reject the bogus file, but the route is wired.
    assert.equal(response.status, 200);
    await response.arrayBuffer().catch(() => {});
  } else {
    // ffmpeg is absent: say so plainly rather than serving a broken stream.
    assert.equal(response.status, 503);
    assert.match(await response.text(), /ffmpeg/i);
  }
});

test('transcoding can be turned off entirely', async () => {
  const strict = await createServer({
    roots: [mediaRoot],
    hostKey: HOST_KEY,
    guestKey: GUEST_KEY,
    allowTranscode: false,
  });
  await new Promise((resolve) => strict.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${strict.address().port}`;

  const library = await (await fetch(`${url}/api/library?k=${HOST_KEY}`)).json();
  const mkv = library.items.find((item) => item.relativePath.endsWith('.mkv'));
  const response = await fetch(`${url}/transcode/${mkv.id}?k=${HOST_KEY}`);
  assert.equal(response.status, 503);

  await new Promise((resolve) => strict.close(resolve));
});
