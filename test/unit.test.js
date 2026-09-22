import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRange } from '../src/range.js';
import { srtToVtt, assToVtt } from '../src/subtitles.js';
import { Room } from '../src/room.js';
import { buildFfmpegArgs } from '../src/transcode.js';
import { parseCookies, safeEqual } from '../src/auth.js';
import { chooseDeliveryMode } from '../src/media.js';
import { acceptKey } from '../src/ws.js';

test('parseRange handles the shapes <video> actually sends', () => {
  assert.deepEqual(parseRange('bytes=0-', 1000), { start: 0, end: 999, length: 1000 });
  assert.deepEqual(parseRange('bytes=100-199', 1000), { start: 100, end: 199, length: 100 });
  assert.deepEqual(parseRange('bytes=-200', 1000), { start: 800, end: 999, length: 200 });
  // An end past EOF is clamped, not rejected.
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999, length: 100 });
  assert.equal(parseRange(undefined, 1000), null);
});

test('parseRange rejects unsatisfiable and malformed ranges', () => {
  assert.equal(parseRange('bytes=1000-', 1000).invalid, true);
  assert.equal(parseRange('bytes=500-100', 1000).invalid, true);
  assert.equal(parseRange('bytes=-0', 1000).invalid, true);
  assert.equal(parseRange('bytes=abc-def', 1000).invalid, true);
  assert.equal(parseRange('items=0-10', 1000).invalid, true);
  assert.equal(parseRange('bytes=0-', 0).invalid, true);
});

test('srtToVtt converts timings and drops sequence numbers', () => {
  const srt = [
    '1',
    '00:00:01,000 --> 00:00:04,500',
    'Hello there',
    '',
    '2',
    '00:01:02,250 --> 00:01:05,000',
    'Line one',
    'Line two',
    '',
  ].join('\r\n');

  const vtt = srtToVtt(srt);
  assert.match(vtt, /^WEBVTT\n/);
  assert.match(vtt, /00:00:01\.000 --> 00:00:04\.500\nHello there/);
  assert.match(vtt, /00:01:02\.250 --> 00:01:05\.000\nLine one\nLine two/);
  assert.doesNotMatch(vtt, /^1$/m);
});

test('srtToVtt tolerates a BOM and missing sequence numbers', () => {
  const vtt = srtToVtt('﻿00:00:00,500 --> 00:00:02,000\nNo index here\n');
  assert.match(vtt, /00:00:00\.500 --> 00:00:02\.000\nNo index here/);
});

test('assToVtt strips override tags and keeps commas in dialogue', () => {
  const ass = [
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an8}Yes, of course\\Nright away',
  ].join('\n');

  const vtt = assToVtt(ass);
  assert.match(vtt, /00:00:01\.000 --> 00:00:03\.000\nYes, of course\nright away/);
  assert.doesNotMatch(vtt, /\\an8/);
});

test('room advances position while playing and freezes when paused', () => {
  let clock = 1_000_000;
  const room = new Room({ clock: () => clock });
  const host = room.addViewer({ role: 'host', name: 'Me' });

  room.applyControl(host, { action: 'select', mediaId: 'abc' });
  room.applyControl(host, { action: 'play', position: 10 });

  clock += 5000;
  assert.equal(Math.round(room.positionAt()), 15);

  room.applyControl(host, { action: 'pause' });
  clock += 10_000;
  assert.equal(Math.round(room.positionAt()), 15);

  room.applyControl(host, { action: 'play' });
  clock += 2000;
  assert.equal(Math.round(room.positionAt()), 17);
});

test('room accounts for playback rate without rewriting history', () => {
  let clock = 0;
  const room = new Room({ clock: () => clock });
  const host = room.addViewer({ role: 'host' });

  room.applyControl(host, { action: 'play', position: 0 });
  clock += 10_000; // 10s at 1x
  room.applyControl(host, { action: 'rate', rate: 2 });
  assert.equal(Math.round(room.positionAt()), 10);

  clock += 10_000; // 10s at 2x
  assert.equal(Math.round(room.positionAt()), 30);
});

test('host-only rooms reject guest control', () => {
  const room = new Room({ controlMode: 'host' });
  const host = room.addViewer({ role: 'host' });
  const guest = room.addViewer({ role: 'guest' });

  assert.equal(room.applyControl(guest, { action: 'play' }).changed, false);
  assert.equal(room.applyControl(guest, { action: 'play' }).reason, 'not-allowed');
  assert.equal(room.applyControl(host, { action: 'play' }).changed, true);
});

test('shared rooms let either side pause', () => {
  const room = new Room();
  room.addViewer({ role: 'host' });
  const guest = room.addViewer({ role: 'guest' });
  assert.equal(room.applyControl(guest, { action: 'play' }).changed, true);
  assert.equal(room.applyControl(guest, { action: 'pause' }).changed, true);
  assert.equal(room.paused, true);
});

test('guests cannot start a screen share', () => {
  const room = new Room();
  const guest = room.addViewer({ role: 'guest' });
  assert.equal(room.applyControl(guest, { action: 'source', source: 'screen' }).reason, 'not-allowed');
});

test('a buffering viewer pauses the room and resuming un-pauses it', () => {
  let clock = 0;
  const room = new Room({ clock: () => clock });
  const host = room.addViewer({ role: 'host' });
  const guest = room.addViewer({ role: 'guest' });
  room.applyControl(host, { action: 'select', mediaId: 'abc' });
  room.applyControl(host, { action: 'play', position: 0 });

  clock += 4000;
  const stalled = room.report(guest, { position: 4, buffering: true });
  assert.equal(stalled.changed, true);
  assert.equal(room.paused, true);
  assert.equal(room.waitingFor, guest.id);

  clock += 6000;
  assert.equal(Math.round(room.positionAt()), 4, 'the room should not run on while paused');

  const recovered = room.report(guest, { position: 4, buffering: false });
  assert.equal(recovered.changed, true);
  assert.equal(room.paused, false);
  assert.equal(room.waitingFor, null);
});

test('the room stays paused while a second viewer is still stalled', () => {
  const room = new Room();
  const host = room.addViewer({ role: 'host' });
  const a = room.addViewer({ role: 'guest' });
  const b = room.addViewer({ role: 'guest' });
  room.applyControl(host, { action: 'play', position: 0 });

  room.report(a, { buffering: true });
  room.report(b, { buffering: true });
  room.report(a, { buffering: false });
  assert.equal(room.paused, true, 'b is still buffering');
});

test('chat trims, caps and attributes messages', () => {
  const room = new Room();
  const viewer = room.addViewer({ role: 'guest', name: '  Priya  ' });
  assert.equal(viewer.name, 'Priya');

  assert.equal(room.addChat(viewer, '   '), null);
  const entry = room.addChat(viewer, '  hello   world  ');
  assert.equal(entry.text, 'hello world');
  assert.equal(entry.name, 'Priya');
  assert.equal(room.addChat(viewer, 'x'.repeat(2000)).text.length, 800);
});

test('removing the viewer we were waiting for clears the hold', () => {
  const room = new Room();
  const host = room.addViewer({ role: 'host' });
  const guest = room.addViewer({ role: 'guest' });
  room.applyControl(host, { action: 'play', position: 0 });
  room.report(guest, { buffering: true });
  assert.equal(room.waitingFor, guest.id);
  room.removeViewer(guest.id);
  assert.equal(room.waitingFor, null);
});

test('ffmpeg args copy compatible streams and re-encode the rest', () => {
  const copyable = buildFfmpegArgs({
    filePath: '/m/a.mkv',
    info: { videoCodec: 'h264', audioCodec: 'aac', height: 1080 },
  });
  assert.ok(copyable.includes('-c:v'));
  assert.equal(copyable[copyable.indexOf('-c:v') + 1], 'copy');
  assert.equal(copyable[copyable.indexOf('-c:a') + 1], 'copy');

  const reencoded = buildFfmpegArgs({
    filePath: '/m/b.mkv',
    info: { videoCodec: 'hevc', audioCodec: 'ac3', height: 1080 },
  });
  assert.equal(reencoded[reencoded.indexOf('-c:v') + 1], 'libx264');
  assert.equal(reencoded[reencoded.indexOf('-c:a') + 1], 'aac');
});

test('ffmpeg seeks before the input so large files stay fast', () => {
  const args = buildFfmpegArgs({ filePath: '/m/a.mkv', startSeconds: 900, info: null });
  assert.ok(args.indexOf('-ss') < args.indexOf('-i'));
  assert.equal(args[args.indexOf('-ss') + 1], '900');
});

test('ffmpeg downscales only when the source is taller than the cap', () => {
  const scaled = buildFfmpegArgs({
    filePath: '/m/a.mkv',
    info: { videoCodec: 'h264', audioCodec: 'aac', height: 2160 },
    maxHeight: 720,
  });
  assert.ok(scaled.includes('-vf'));
  assert.equal(scaled[scaled.indexOf('-vf') + 1], 'scale=-2:720');

  const untouched = buildFfmpegArgs({
    filePath: '/m/a.mkv',
    info: { videoCodec: 'h264', audioCodec: 'aac', height: 480 },
    maxHeight: 720,
  });
  assert.ok(!untouched.includes('-vf'));
});

test('delivery mode follows container and codec support', () => {
  assert.equal(chooseDeliveryMode('/m/a.mp4', { videoCodec: 'h264', audioCodec: 'aac' }), 'direct');
  assert.equal(chooseDeliveryMode('/m/a.mkv', { videoCodec: 'h264', audioCodec: 'aac' }), 'transcode');
  assert.equal(chooseDeliveryMode('/m/a.mp4', { videoCodec: 'hevc', audioCodec: 'aac' }), 'transcode');
  assert.equal(chooseDeliveryMode('/m/a.mp4', { videoCodec: 'h264', audioCodec: 'ac3' }), 'transcode');
  // Without ffprobe we trust the container rather than refusing to play.
  assert.equal(chooseDeliveryMode('/m/a.mp4', null), 'direct');
});

test('cookie parsing and constant-time comparison', () => {
  assert.deepEqual(parseCookies('a=1; stream_key=abc%20def'), { a: '1', stream_key: 'abc def' });
  assert.deepEqual(parseCookies(undefined), {});
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('abc', undefined), false);
});

test('the websocket handshake matches the RFC 6455 worked example', () => {
  // Getting the magic GUID wrong makes every browser refuse the connection,
  // so pin it to the published vector.
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});
