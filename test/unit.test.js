import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRange } from '../src/range.js';
import { srtToVtt, assToVtt } from '../src/subtitles.js';
import { Room } from '../src/room.js';
import { buildFfmpegArgs, buildVideoFilter, pickEncoder, MAX_HEIGHT_BY_QUALITY } from '../src/transcode.js';
import {
  AttemptLimiter,
  clientAddress,
  generatePasscode,
  hashPasscode,
  parseCookies,
  safeEqual,
  shouldReusePasscodes,
  signSession,
  verifyPasscode,
  verifySession,
} from '../src/auth.js';
import { chooseDeliveryMode, suggestedQuality } from '../src/media.js';
import { acceptKey } from '../src/ws.js';

test('parseRange handles the shapes <video> actually sends', () => {
  assert.deepEqual(parseRange('bytes=0-', 1000), { start: 0, end: 999, length: 1000 });
  assert.deepEqual(parseRange('bytes=100-199', 1000), { start: 100, end: 199, length: 100 });
  assert.deepEqual(parseRange('bytes=-200', 1000), { start: 800, end: 999, length: 200 });
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
  const srt = ['1', '00:00:01,000 --> 00:00:04,500', 'Hello there', '', '2',
    '00:01:02,250 --> 00:01:05,000', 'Line one', 'Line two', ''].join('\r\n');
  const vtt = srtToVtt(srt);
  assert.match(vtt, /^WEBVTT\n/);
  assert.match(vtt, /00:00:01\.000 --> 00:00:04\.500\nHello there/);
  assert.match(vtt, /00:01:02\.250 --> 00:01:05\.000\nLine one\nLine two/);
});

test('srtToVtt tolerates a BOM and missing sequence numbers', () => {
  const vtt = srtToVtt('﻿00:00:00,500 --> 00:00:02,000\nNo index here\n');
  assert.match(vtt, /00:00:00\.500 --> 00:00:02\.000\nNo index here/);
});

test('assToVtt strips override tags and keeps commas in dialogue', () => {
  const ass = ['[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an8}Yes, of course\\Nright away'].join('\n');
  const vtt = assToVtt(ass);
  assert.match(vtt, /00:00:01\.000 --> 00:00:03\.000\nYes, of course\nright away/);
  assert.doesNotMatch(vtt, /\\an8/);
});

// ------------------------------------------------------------------ room --

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
});

test('room accounts for playback rate without rewriting history', () => {
  let clock = 0;
  const room = new Room({ clock: () => clock });
  const host = room.addViewer({ role: 'host' });

  room.applyControl(host, { action: 'play', position: 0 });
  clock += 10_000;
  room.applyControl(host, { action: 'rate', rate: 2 });
  assert.equal(Math.round(room.positionAt()), 10);

  clock += 10_000;
  assert.equal(Math.round(room.positionAt()), 30);
});

test('host-only rooms reject guest control', () => {
  const room = new Room({ controlMode: 'host' });
  const host = room.addViewer({ role: 'host' });
  const guest = room.addViewer({ role: 'guest' });
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

test('a buffering viewer pauses the room and resuming un-pauses it', () => {
  let clock = 0;
  const room = new Room({ clock: () => clock, autoPauseOnBuffer: true });
  const host = room.addViewer({ role: 'host' });
  const guest = room.addViewer({ role: 'guest' });
  room.applyControl(host, { action: 'select', mediaId: 'abc' });
  room.applyControl(host, { action: 'play', position: 0 });

  clock += 4000;
  assert.equal(room.report(guest, { position: 4, buffering: true }).changed, true);
  assert.equal(room.paused, true);
  assert.equal(room.waitingFor, guest.id);

  clock += 6000;
  assert.equal(Math.round(room.positionAt()), 4, 'the room should not run on while paused');

  assert.equal(room.report(guest, { position: 4, buffering: false }).changed, true);
  assert.equal(room.paused, false);
  assert.equal(room.waitingFor, null);
});

test('the room stays paused while a second viewer is still stalled', () => {
  const room = new Room({ autoPauseOnBuffer: true });
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
  const viewer = room.addViewer({ role: 'guest', name: '  Sam  ' });
  assert.equal(viewer.name, 'Sam');
  assert.equal(room.addChat(viewer, '   '), null);
  assert.equal(room.addChat(viewer, '  hello   world  ').text, 'hello world');
  assert.equal(room.addChat(viewer, 'x'.repeat(2000)).text.length, 800);
});

test('removing the viewer we were waiting for clears the hold', () => {
  const room = new Room({ autoPauseOnBuffer: true });
  const host = room.addViewer({ role: 'host' });
  const guest = room.addViewer({ role: 'guest' });
  room.applyControl(host, { action: 'play', position: 0 });
  room.report(guest, { buffering: true });
  room.removeViewer(guest.id);
  assert.equal(room.waitingFor, null);
});

// ------------------------------------------------------------- transcode --

test('ffmpeg copies streams the browser can already play', () => {
  const args = buildFfmpegArgs({
    filePath: '/m/a.mkv',
    info: { videoCodec: 'h264', audioCodec: 'aac', height: 1080 },
    quality: 'original',
  });
  assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
  assert.equal(args[args.indexOf('-c:a') + 1], 'copy');
});

test('ffmpeg re-encodes HEVC video and AC3 audio', () => {
  const args = buildFfmpegArgs({
    filePath: '/m/b.mkv',
    info: { videoCodec: 'hevc', audioCodec: 'ac3', height: 2160, audioChannels: 6 },
    quality: 'original',
    encoder: 'libx264',
  });
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
});

test('surround audio keeps its channels instead of being flattened', () => {
  const surround = buildFfmpegArgs({
    filePath: '/m/b.mkv',
    info: { videoCodec: 'h264', audioCodec: 'ac3', audioChannels: 6, height: 1080 },
  });
  assert.equal(surround[surround.indexOf('-ac') + 1], '6');
  assert.equal(surround[surround.indexOf('-b:a') + 1], '384k');

  const stereo = buildFfmpegArgs({
    filePath: '/m/c.mkv',
    info: { videoCodec: 'h264', audioCodec: 'ac3', audioChannels: 2, height: 1080 },
  });
  assert.equal(stereo[stereo.indexOf('-ac') + 1], '2');
});

test('a GPU encoder is used when one is available', () => {
  assert.equal(pickEncoder(['h264_nvenc']), 'h264_nvenc');
  assert.equal(pickEncoder(['h264_qsv', 'h264_amf']), 'h264_qsv');
  assert.equal(pickEncoder([]), 'libx264');
  assert.equal(pickEncoder(['h264_nvenc'], { preferSoftware: true }), 'libx264');

  const args = buildFfmpegArgs({
    filePath: '/m/4k.mkv',
    info: { videoCodec: 'hevc', audioCodec: 'aac', height: 2160 },
    quality: 'high',
    encoder: 'h264_nvenc',
  });
  assert.equal(args[args.indexOf('-c:v') + 1], 'h264_nvenc');
  assert.ok(args.includes('-b:v'), 'hardware encoding is bitrate targeted');
});

test('4K is downscaled when a height cap is chosen', () => {
  const args = buildFfmpegArgs({
    filePath: '/m/4k.mkv',
    info: { videoCodec: 'hevc', audioCodec: 'aac', height: 2160 },
    quality: 'high',
  });
  assert.match(args[args.indexOf('-vf') + 1], /scale=-2:1080/);

  const untouched = buildFfmpegArgs({
    filePath: '/m/hd.mkv',
    info: { videoCodec: 'hevc', audioCodec: 'aac', height: 1080 },
    quality: 'high',
  });
  assert.doesNotMatch(untouched[untouched.indexOf('-vf') + 1], /scale=/);
});

test('HDR is tone mapped so it does not come out grey', () => {
  const filter = buildVideoFilter({
    info: { hdr: true, height: 2160 },
    maxHeight: 1080,
    canToneMap: true,
  });
  assert.match(filter, /tonemap/);
  assert.match(filter, /zscale=p=bt709/);
  assert.match(filter, /scale=-2:1080/);
  assert.match(filter, /format=yuv420p$/);

  // Without zimg we still have to force 8-bit, we just cannot tone map.
  const fallback = buildVideoFilter({ info: { hdr: true }, maxHeight: null, canToneMap: false });
  assert.doesNotMatch(fallback, /tonemap/);
  assert.match(fallback, /format=yuv420p/);
});

test('HDR forces a re-encode even when the codec is already playable', () => {
  const args = buildFfmpegArgs({
    filePath: '/m/hdr.mp4',
    info: { videoCodec: 'h264', audioCodec: 'aac', height: 1080, hdr: true },
    quality: 'original',
    canToneMap: true,
  });
  assert.notEqual(args[args.indexOf('-c:v') + 1], 'copy');
});

test('ffmpeg seeks before the input so large files stay fast', () => {
  const args = buildFfmpegArgs({ filePath: '/m/a.mkv', startSeconds: 900, info: null });
  assert.ok(args.indexOf('-ss') < args.indexOf('-i'));
  assert.equal(args[args.indexOf('-ss') + 1], '900');
});

test('quality names map to the heights people expect', () => {
  assert.equal(MAX_HEIGHT_BY_QUALITY.original, null);
  assert.equal(MAX_HEIGHT_BY_QUALITY.high, 1080);
  assert.equal(MAX_HEIGHT_BY_QUALITY.medium, 720);
  assert.equal(MAX_HEIGHT_BY_QUALITY.low, 480);
});

// ----------------------------------------------------------------- media --

test('delivery mode follows container and codec support', () => {
  assert.equal(chooseDeliveryMode('/m/a.mp4', { videoCodec: 'h264', audioCodec: 'aac' }), 'direct');
  assert.equal(chooseDeliveryMode('/m/a.mkv', { videoCodec: 'h264', audioCodec: 'aac' }), 'transcode');
  assert.equal(chooseDeliveryMode('/m/a.mp4', { videoCodec: 'hevc', audioCodec: 'aac' }), 'transcode');
  assert.equal(chooseDeliveryMode('/m/a.mp4', { videoCodec: 'h264', audioCodec: 'ac3' }), 'transcode');
  assert.equal(chooseDeliveryMode('/m/a.mp4', null), 'direct');
});

test('4K and very high bitrate files do not default to "original"', () => {
  assert.equal(suggestedQuality({ height: 2160, bitrate: 60_000_000 }), 'high');
  assert.equal(suggestedQuality({ height: 1080, bitrate: 40_000_000 }), 'high');
  assert.equal(suggestedQuality({ height: 1080, bitrate: 6_000_000 }), 'original');
  assert.equal(suggestedQuality(null), 'original');
});

// ------------------------------------------------------------------ auth --

test('passcodes verify only against themselves', () => {
  const record = hashPasscode('POPCORN');
  assert.equal(verifyPasscode('POPCORN', record), true);
  assert.equal(verifyPasscode('POPCOR', record), false);
  assert.equal(verifyPasscode('POPCORNS', record), false);
  assert.equal(verifyPasscode('', record), false);
  assert.equal(verifyPasscode('POPCORN', null), false);
  // Case is deliberately not part of it; see the case-insensitivity test.
});

test('generated passcodes avoid letters people confuse', () => {
  for (let i = 0; i < 40; i++) {
    const code = generatePasscode();
    assert.equal(code.length, 6);
    assert.doesNotMatch(code, /[OIL01U]/, `ambiguous character in ${code}`);
  }
});

test('session tokens survive a round trip and reject tampering', () => {
  const secret = 'a-test-secret';
  const token = signSession(secret, { role: 'guest', name: 'Sam', expiresAt: Date.now() + 10_000 });

  const payload = verifySession(secret, token);
  assert.equal(payload.role, 'guest');
  assert.equal(payload.name, 'Sam');

  assert.equal(verifySession('another-secret', token), null, 'signed with a different key');
  assert.equal(verifySession(secret, token.slice(0, -2) + 'xx'), null, 'signature edited');
  assert.equal(verifySession(secret, 'nonsense'), null);
});

test('expired sessions and bogus roles are refused', () => {
  const secret = 'a-test-secret';
  assert.equal(
    verifySession(secret, signSession(secret, { role: 'guest', expiresAt: Date.now() - 1 })),
    null
  );
  assert.equal(
    verifySession(secret, signSession(secret, { role: 'admin', expiresAt: Date.now() + 10_000 })),
    null
  );
});

test('the attempt limiter locks out a client that keeps guessing', () => {
  let clock = 0;
  const limiter = new AttemptLimiter({ maxPerClient: 3, lockoutMs: 60_000, clock: () => clock });

  assert.equal(limiter.check('1.2.3.4').allowed, true);
  limiter.fail('1.2.3.4');
  limiter.fail('1.2.3.4');
  assert.equal(limiter.check('1.2.3.4').allowed, true, 'still under the limit');

  limiter.fail('1.2.3.4');
  const blocked = limiter.check('1.2.3.4');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.scope, 'client');

  // A different address is unaffected by this one's lockout.
  assert.equal(limiter.check('5.6.7.8').allowed, true);

  clock += 60_001;
  assert.equal(limiter.check('1.2.3.4').allowed, true, 'lockout expires');
});

test('the attempt limiter also caps guessing spread across many addresses', () => {
  let clock = 0;
  const limiter = new AttemptLimiter({ maxPerClient: 100, maxGlobal: 5, clock: () => clock });
  for (let i = 0; i < 5; i++) limiter.fail(`10.0.0.${i}`);
  const blocked = limiter.check('10.0.0.99');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.scope, 'global');
});

test('a correct passcode clears that client’s failures', () => {
  const limiter = new AttemptLimiter({ maxPerClient: 3 });
  limiter.fail('1.2.3.4');
  limiter.fail('1.2.3.4');
  limiter.succeed('1.2.3.4');
  limiter.fail('1.2.3.4');
  assert.equal(limiter.check('1.2.3.4').allowed, true);
});

test('cookie parsing and constant-time comparison', () => {
  assert.deepEqual(parseCookies('a=1; stream_session=abc%20def'), { a: '1', stream_session: 'abc def' });
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

test('the real visitor is identified behind a Cloudflare tunnel', () => {
  // Without this every request looks like 127.0.0.1 and the per-client rate
  // limit collapses into one shared bucket for everybody.
  const cf = clientAddress({
    headers: { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.9, 10.0.0.1' },
    socket: { remoteAddress: '127.0.0.1' },
  });
  assert.equal(cf, '203.0.113.7');

  const forwarded = clientAddress({
    headers: { 'x-forwarded-for': '198.51.100.9, 10.0.0.1' },
    socket: { remoteAddress: '127.0.0.1' },
  });
  assert.equal(forwarded, '198.51.100.9', 'the client is the first entry, not the proxy');

  const lan = clientAddress({ headers: {}, socket: { remoteAddress: '192.168.1.40' } });
  assert.equal(lan, '192.168.1.40');

  assert.equal(clientAddress({ headers: {}, socket: {} }), 'unknown');
});

test('two visitors behind the same tunnel are rate limited separately', () => {
  const limiter = new AttemptLimiter({ maxPerClient: 3, lockoutMs: 60_000 });
  const her = { headers: { 'cf-connecting-ip': '203.0.113.7' }, socket: {} };
  const stranger = { headers: { 'cf-connecting-ip': '198.51.100.4' }, socket: {} };

  for (let i = 0; i < 3; i++) limiter.fail(clientAddress(stranger));
  assert.equal(limiter.check(clientAddress(stranger)).allowed, false);
  assert.equal(limiter.check(clientAddress(her)).allowed, true, 'she is not locked out by a stranger');
});

test('a pause somebody asked for is not undone when a buffer clears', () => {
  // The reported bug: the film would not stay paused. A viewer recovering from
  // a stall resumed the room even though someone had since pressed pause.
  let clock = 0;
  const room = new Room({ clock: () => clock, autoPauseOnBuffer: true });
  const host = room.addViewer({ role: 'host' });
  const guest = room.addViewer({ role: 'guest' });

  room.applyControl(host, { action: 'select', mediaId: 'abc' });
  room.applyControl(host, { action: 'play', position: 0 });

  // She stalls, so the room holds for her.
  clock += 3000;
  room.report(guest, { position: 3, buffering: true });
  assert.equal(room.paused, true);
  assert.equal(room.pausedBy, 'buffer');

  // Meanwhile he presses pause deliberately.
  room.applyControl(host, { action: 'pause', position: 3 });
  assert.equal(room.pausedBy, 'user');
  assert.equal(room.waitingFor, null, 'no longer waiting on anyone');

  // Her buffer recovers. The film must stay paused.
  const recovery = room.report(guest, { position: 3, buffering: false });
  assert.equal(recovery.changed, false);
  assert.equal(room.paused, true, 'the pause he asked for still stands');
});

test('a buffering hold still resumes by itself when nobody intervened', () => {
  let clock = 0;
  const room = new Room({ clock: () => clock, autoPauseOnBuffer: true });
  const host = room.addViewer({ role: 'host' });
  const guest = room.addViewer({ role: 'guest' });

  room.applyControl(host, { action: 'play', position: 0 });
  room.report(guest, { buffering: true });
  assert.equal(room.pausedBy, 'buffer');

  room.report(guest, { buffering: false });
  assert.equal(room.paused, false);
  assert.equal(room.pausedBy, null);
});

test('pressing play clears a buffering hold', () => {
  const room = new Room({ autoPauseOnBuffer: true });
  const host = room.addViewer({ role: 'host' });
  const guest = room.addViewer({ role: 'guest' });

  room.applyControl(host, { action: 'play', position: 0 });
  room.report(guest, { buffering: true });
  assert.equal(room.waitingFor, guest.id);

  room.applyControl(host, { action: 'play' });
  assert.equal(room.waitingFor, null);
  assert.equal(room.pausedBy, null);
  assert.equal(room.paused, false);
});

test('an emptied room forgets what was playing but keeps the conversation', () => {
  const room = new Room();
  const host = room.addViewer({ role: 'host' });
  room.applyControl(host, { action: 'select', mediaId: 'abc' });
  room.applyControl(host, { action: 'play', position: 120 });
  room.addChat(host, 'started without you');

  room.clearPlayback();

  assert.equal(room.mediaId, null, 'the next visit starts at the library');
  assert.equal(room.paused, true);
  assert.equal(room.positionAt(), 0);
  assert.equal(room.waitingFor, null);
  assert.equal(room.pausedBy, null);
  assert.equal(room.chat.length, 1, 'chat is the conversation, not playback state');
});

test('browsing is announced, but only for someone allowed to browse', () => {
  const room = new Room();
  const host = room.addViewer({ role: 'host' });
  const guest = room.addViewer({ role: 'guest' });

  assert.equal(room.setBrowsing(host, true), true);
  assert.equal(room.presence().viewers.find((v) => v.id === host.id).browsing, true);

  // Setting it again is not a change worth broadcasting.
  assert.equal(room.setBrowsing(host, true), false);
  assert.equal(room.setBrowsing(host, false), true);

  // A guest has no film list, so cannot be "choosing".
  assert.equal(room.setBrowsing(guest, true), false);
  assert.equal(guest.browsing, false);
});

test('a passcode is accepted whatever case it is typed in', () => {
  // The field renders uppercase but holds what was typed, phone keyboards
  // capitalise and laptop ones do not — so case cannot be part of the secret.
  const record = hashPasscode('K7M4PQ');
  assert.equal(verifyPasscode('K7M4PQ', record), true);
  assert.equal(verifyPasscode('k7m4pq', record), true);
  assert.equal(verifyPasscode('K7m4Pq', record), true);
  assert.equal(verifyPasscode('  k7m4pq  ', record), true, 'and surrounding space is ignored');

  // A different code is still a different code.
  assert.equal(verifyPasscode('K7M4PR', record), false);
  assert.equal(verifyPasscode('', record), false);

  // A passcode set in lower case works either way round too.
  const chosen = hashPasscode('popcorn');
  assert.equal(verifyPasscode('POPCORN', chosen), true);
  assert.equal(verifyPasscode('popcorn', chosen), true);
});

test('the room gives up waiting on a buffer that never finishes', () => {
  // Otherwise one viewer whose video never reaches a playable state holds the
  // film for everybody, for good — and a paused video may never buffer enough
  // to report that it recovered, so the wait cannot end on its own.
  let clock = 0;
  const room = new Room({ clock: () => clock, maxBufferHoldMs: 30_000, autoPauseOnBuffer: true });
  const host = room.addViewer({ role: 'host' });
  const guest = room.addViewer({ role: 'guest' });

  room.applyControl(host, { action: 'select', mediaId: 'abc' });
  room.applyControl(host, { action: 'play', position: 0 });

  clock += 5000;
  room.report(guest, { position: 5, buffering: true });
  assert.equal(room.paused, true);
  assert.equal(room.waitingFor, guest.id);

  clock += 10_000;
  assert.equal(room.releaseStaleHold().changed, false, 'still within the grace period');
  assert.equal(room.paused, true);

  clock += 25_000;
  const released = room.releaseStaleHold();
  assert.equal(released.changed, true);
  assert.equal(released.reason, 'gave-up-waiting');
  assert.equal(room.paused, false);
  assert.equal(room.waitingFor, null);
});

test('a pause somebody asked for is never released by the timer', () => {
  let clock = 0;
  const room = new Room({ clock: () => clock, maxBufferHoldMs: 1000, autoPauseOnBuffer: true });
  const host = room.addViewer({ role: 'host' });
  const guest = room.addViewer({ role: 'guest' });

  room.applyControl(host, { action: 'play', position: 0 });
  room.report(guest, { buffering: true });
  room.applyControl(host, { action: 'pause', position: 3 });

  clock += 60_000;
  assert.equal(room.releaseStaleHold().changed, false);
  assert.equal(room.paused, true, 'it stays paused because a person paused it');
});

test('recovering normally still resumes without waiting for the timer', () => {
  let clock = 0;
  const room = new Room({ clock: () => clock, maxBufferHoldMs: 30_000, autoPauseOnBuffer: true });
  const host = room.addViewer({ role: 'host' });
  const guest = room.addViewer({ role: 'guest' });

  room.applyControl(host, { action: 'play', position: 0 });
  room.report(guest, { buffering: true });
  clock += 2000;
  assert.equal(room.report(guest, { buffering: false }).changed, true);
  assert.equal(room.paused, false);
  assert.equal(room.waitingSince, null);
});

// --- Passcode rotation across a restart ---------------------------------

test('a restart minutes after the last one keeps the passcodes', () => {
  const now = Date.now();
  // Somebody in another country is holding a code that was right ten minutes
  // ago. Rotating here would lock them out of a film already in progress.
  assert.equal(shouldReusePasscodes({ startedAt: now - 10 * 60_000, now }), true);
  assert.equal(shouldReusePasscodes({ startedAt: now - 3.9 * 60 * 60_000, now }), true);
});

test('but a new evening gets new passcodes', () => {
  const now = Date.now();
  assert.equal(shouldReusePasscodes({ startedAt: now - 5 * 60 * 60_000, now }), false);
  assert.equal(shouldReusePasscodes({ startedAt: now - 30 * 24 * 60 * 60_000, now }), false);
  // Never run before: there is nothing to reuse.
  assert.equal(shouldReusePasscodes({ startedAt: null, now }), false);
  assert.equal(shouldReusePasscodes({ startedAt: undefined, now }), false);
  assert.equal(shouldReusePasscodes({ startedAt: 'yesterday', now }), false);
});

test('what was asked for beats what was inferred', () => {
  const now = Date.now();
  const old = now - 48 * 60 * 60_000;
  const recent = now - 60_000;

  assert.equal(shouldReusePasscodes({ startedAt: old, now, keepPasscodes: true }), true);
  assert.equal(shouldReusePasscodes({ startedAt: recent, now, newPasscodes: true }), false);
  // Both at once is contradictory; the destructive one wins, because it is
  // the one that cannot be arrived at by accident.
  assert.equal(
    shouldReusePasscodes({ startedAt: recent, now, keepPasscodes: true, newPasscodes: true }),
    false
  );
});

test('a clock that went backwards does not rotate the passcodes', () => {
  const now = Date.now();
  // A laptop resuming from sleep can correct its clock forwards, leaving a
  // timestamp in the future. That is a restart, not a month-old session.
  assert.equal(shouldReusePasscodes({ startedAt: now + 60_000, now }), false);
  assert.equal(shouldReusePasscodes({ startedAt: now, now }), true);
});
