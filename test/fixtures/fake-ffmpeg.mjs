#!/usr/bin/env node
// A stand-in for ffmpeg, so the HLS plumbing can be tested without one.
// It answers the capability probes and, when asked for HLS, writes a playlist
// and segments the way ffmpeg does.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);

if (args.includes('-version')) {
  process.stdout.write('ffmpeg version 0.0.0-fake\n');
  process.exit(0);
}
if (args.includes('-encoders')) {
  // No hardware encoders, so the software path is what gets exercised.
  process.stdout.write('V....D libx264  H.264\n');
  process.exit(0);
}
if (args.includes('-filters')) {
  process.stdout.write(' T.. zscale  Z\n T.. tonemap  T\n');
  process.exit(0);
}

// Refusing on demand, to exercise the failure path.
if (process.env.FAKE_FFMPEG_FAIL === '1') {
  process.stderr.write('Invalid data found when processing input\n');
  process.exit(1);
}

const playlistPath = args[args.length - 1];
if (!playlistPath.endsWith('.m3u8')) {
  process.stderr.write('fake ffmpeg only knows how to write HLS\n');
  process.exit(1);
}

const directory = path.dirname(playlistPath);
const segmentCount = Number(process.env.FAKE_FFMPEG_SEGMENTS ?? 3);
const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0'];

for (let i = 0; i < segmentCount; i++) {
  const name = `seg${String(i).padStart(5, '0')}.ts`;
  fs.writeFileSync(path.join(directory, name), Buffer.alloc(512, i + 1));
  lines.push('#EXTINF:4.000000,', name);
}
lines.push('#EXT-X-ENDLIST', '');
fs.writeFileSync(playlistPath, lines.join('\n'));
process.exit(0);
