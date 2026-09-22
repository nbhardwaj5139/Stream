import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from '../src/server.js';
import { resetFfmpegDetection } from '../src/media.js';
import { resetCapabilities } from '../src/transcode.js';
import { sessionKey } from '../src/hls.js';

// The stand-in is a shebang script, which Windows will not execute directly.
const windows = process.platform === 'win32';
const options = { skip: windows ? 'needs a POSIX shell for the stand-in ffmpeg' : false };

const HOST_PASSCODE = 'HLSHOST';
const GUEST_PASSCODE = 'HLSGUEST';

let server;
let baseUrl;
let mediaRoot;
let binDir;
let hostCookie;
let guestCookie;
let mkvId;
let originalPath;

async function join(passcode) {
  const response = await fetch(`${baseUrl}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passcode }),
  });
  return response.headers.get('set-cookie').split(';')[0];
}

const as = (cookie) => ({ headers: { cookie } });

before(async () => {
  if (windows) return;

  mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'stream-hls-test-'));
  await fs.writeFile(path.join(mediaRoot, 'Film.mkv'), Buffer.alloc(4096));

  // Put the stand-in on PATH under the name the server spawns.
  binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stream-bin-'));
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-ffmpeg.mjs');
  for (const name of ['ffmpeg', 'ffprobe']) {
    const shim = path.join(binDir, name);
    await fs.writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`);
    await fs.chmod(shim, 0o755);
  }
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;

  resetFfmpegDetection();
  resetCapabilities();

  server = await createServer({
    roots: [mediaRoot],
    hostPasscode: HOST_PASSCODE,
    guestPasscode: GUEST_PASSCODE,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  hostCookie = await join(HOST_PASSCODE);
  guestCookie = await join(GUEST_PASSCODE);

  const library = await (await fetch(`${baseUrl}/api/library`, as(hostCookie))).json();
  mkvId = library.items[0].id;
  server.room.mediaId = mkvId;
});

after(async () => {
  if (windows) return;
  process.env.PATH = originalPath;
  resetFfmpegDetection();
  resetCapabilities();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(mediaRoot, { recursive: true, force: true });
  await fs.rm(binDir, { recursive: true, force: true });
});

test('the playlist is served once segments exist', options, async () => {
  const key = sessionKey({ mediaId: mkvId, start: 0, quality: 'high', track: 0 });
  const response = await fetch(`${baseUrl}/hls/${key}/playlist.m3u8`, as(guestCookie));

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/vnd\.apple\.mpegurl/);

  const playlist = await response.text();
  assert.match(playlist, /^#EXTM3U/);
  assert.match(playlist, /seg00000\.ts/);
  // Safari abandons a playlist with nothing in it, so it must not be served
  // before ffmpeg has produced something.
  assert.ok((playlist.match(/\.ts$/gm) ?? []).length >= 2);
});

test('segments are served as transport stream bytes', options, async () => {
  const key = sessionKey({ mediaId: mkvId, start: 0, quality: 'high', track: 0 });
  await fetch(`${baseUrl}/hls/${key}/playlist.m3u8`, as(guestCookie));

  const response = await fetch(`${baseUrl}/hls/${key}/seg00000.ts`, as(guestCookie));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp2t');
  assert.equal((await response.arrayBuffer()).byteLength, 512);
});

test('one encode is shared rather than started per viewer', options, async () => {
  const key = sessionKey({ mediaId: mkvId, start: 120, quality: 'medium', track: 0 });
  const [a, b] = await Promise.all([
    fetch(`${baseUrl}/hls/${key}/playlist.m3u8`, as(hostCookie)),
    fetch(`${baseUrl}/hls/${key}/playlist.m3u8`, as(guestCookie)),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(await a.text(), await b.text());

  // Different settings are a different encode, and a separate directory.
  const other = sessionKey({ mediaId: mkvId, start: 120, quality: 'low', track: 0 });
  assert.notEqual(other, key);
  assert.equal((await fetch(`${baseUrl}/hls/${other}/playlist.m3u8`, as(hostCookie))).status, 200);
});

test('a guest cannot reach a film that is not playing', options, async () => {
  const elsewhere = sessionKey({ mediaId: 'b'.repeat(16), start: 0, quality: 'high', track: 0 });
  assert.equal((await fetch(`${baseUrl}/hls/${elsewhere}/playlist.m3u8`, as(guestCookie))).status, 403);
  assert.equal((await fetch(`${baseUrl}/hls/${elsewhere}/seg00000.ts`, as(guestCookie))).status, 403);
});

test('a malformed session id is refused before it names a path', options, async () => {
  for (const bad of ['nonsense', `${mkvId}_q-evil_t-0_s-0`, '..%2F..%2Fetc']) {
    const status = (await fetch(`${baseUrl}/hls/${bad}/playlist.m3u8`, as(hostCookie))).status;
    assert.ok(status === 400 || status === 404, `${bad} gave ${status}`);
  }
});

test('only ffmpeg-shaped segment names are served', options, async () => {
  const key = sessionKey({ mediaId: mkvId, start: 0, quality: 'high', track: 0 });
  await fetch(`${baseUrl}/hls/${key}/playlist.m3u8`, as(hostCookie));

  for (const name of ['playlist.m3u8.bak', 'seg1.ts', 'notasegment']) {
    const status = (await fetch(`${baseUrl}/hls/${key}/${name}`, as(hostCookie))).status;
    assert.equal(status, 404, `${name} gave ${status}`);
  }
});

test('an ffmpeg that refuses the file reports it instead of hanging', options, async () => {
  process.env.FAKE_FFMPEG_FAIL = '1';
  try {
    const key = sessionKey({ mediaId: mkvId, start: 999, quality: 'low', track: 1 });
    const response = await fetch(`${baseUrl}/hls/${key}/playlist.m3u8`, as(hostCookie));
    assert.equal(response.status, 500);
    // The host is shown the real reason; that is the point of the change.
    assert.match(await response.text(), /Invalid data found/);
  } finally {
    delete process.env.FAKE_FFMPEG_FAIL;
  }
});
