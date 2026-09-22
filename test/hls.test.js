import test from 'node:test';
import assert from 'node:assert/strict';

import { buildHlsArgs, isSegmentName, parseSessionKey, sessionKey } from '../src/hls.js';

test('a session key round trips and rejects anything it did not make', () => {
  const key = sessionKey({ mediaId: 'a'.repeat(16), start: 930.7, quality: 'high', track: 2 });
  assert.equal(key, `${'a'.repeat(16)}_q-high_t-2_s-930`);

  const parsed = parseSessionKey(key);
  assert.deepEqual(parsed, { mediaId: 'a'.repeat(16), quality: 'high', track: 2, start: 930 });

  // The key names a file path on the host, so nothing else may parse.
  assert.equal(parseSessionKey('../../etc/passwd'), null);
  assert.equal(parseSessionKey(`${'a'.repeat(16)}_q-huge_t-0_s-0`), null);
  assert.equal(parseSessionKey(`${'z'.repeat(16)}_q-high_t-0_s-0`), null);
  assert.equal(parseSessionKey(''), null);
});

test('only ffmpeg-generated segment names are servable', () => {
  assert.equal(isSegmentName('seg00000.ts'), true);
  assert.equal(isSegmentName('seg01234.ts'), true);
  assert.equal(isSegmentName('../playlist.m3u8'), false);
  assert.equal(isSegmentName('seg1.ts'), false);
  assert.equal(isSegmentName('seg00000.ts.bak'), false);
  assert.equal(isSegmentName('..%2Fseg00000.ts'), false);
});

test('HLS output is segmented on keyframes so Safari does not stall at the joins', () => {
  const args = buildHlsArgs({
    filePath: '/m/film.mkv',
    info: { videoCodec: 'hevc', audioCodec: 'ac3', height: 2160, audioChannels: 6 },
    quality: 'high',
    encoder: 'h264_nvenc',
    directory: '/tmp/session',
  });

  assert.equal(args[args.indexOf('-f') + 1], 'hls');
  assert.ok(args.includes('-force_key_frames'));
  assert.match(args[args.indexOf('-hls_flags') + 1], /independent_segments/);
  assert.equal(args[args.indexOf('-hls_segment_type') + 1], 'mpegts');
  // Keeping every segment listed is what makes it seekable rather than live.
  assert.equal(args[args.indexOf('-hls_list_size') + 1], '0');
  assert.match(args[args.indexOf('-hls_segment_filename') + 1], /session[/\\]seg%05d\.ts$/);
  assert.equal(args[args.indexOf('-c:v') + 1], 'h264_nvenc');
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
  assert.equal(args[args.indexOf('-ac') + 1], '6', 'surround survives');
});

test('HLS copies streams that need no re-encoding', () => {
  const args = buildHlsArgs({
    filePath: '/m/film.mkv',
    info: { videoCodec: 'h264', audioCodec: 'aac', height: 1080 },
    quality: 'original',
    directory: '/tmp/session',
  });
  assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
  assert.equal(args[args.indexOf('-c:a') + 1], 'copy');
});

test('HLS seeks before the input, like the other path', () => {
  const args = buildHlsArgs({ filePath: '/m/a.mkv', startSeconds: 600, info: null, directory: '/tmp/s' });
  assert.ok(args.indexOf('-ss') < args.indexOf('-i'));
  assert.equal(args[args.indexOf('-ss') + 1], '600');
});
