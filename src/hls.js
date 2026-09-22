// HLS output, for Safari.
//
// Chrome and Firefox will play a fragmented MP4 straight off a chunked
// response, so that path stays. Safari will not — on an iPhone or iPad it just
// reports that it cannot decode the file. Safari does play HLS natively, with
// no player library, so transcoding into segments is the way to reach it.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

import { needsVideoReencode, needsAudioReencode } from './media.js';
import { MAX_HEIGHT_BY_QUALITY, BITRATE_BY_HEIGHT, buildVideoFilter } from './transcode.js';

const SEGMENT_SECONDS = 2;
const PLAYLIST_NAME = 'playlist.m3u8';
const SEGMENT_PATTERN = /^seg\d{5}\.ts$/;
const IDLE_TIMEOUT_MS = 5 * 60_000;

// Everything that changes the bytes ffmpeg produces goes in the key, so two
// viewers on the same settings share one encode instead of starting two.
export function sessionKey({ mediaId, start = 0, quality = 'original', track = 0 }) {
  return `${mediaId}_q-${quality}_t-${track}_s-${Math.floor(start)}`;
}

export function parseSessionKey(key) {
  const match = /^([a-f0-9]{16})_q-(original|high|medium|low)_t-(\d{1,2})_s-(\d{1,7})$/.exec(key);
  if (!match) return null;
  return {
    mediaId: match[1],
    quality: match[2],
    track: Number(match[3]),
    start: Number(match[4]),
  };
}

export function isSegmentName(name) {
  return SEGMENT_PATTERN.test(name);
}

export function buildHlsArgs({
  filePath,
  startSeconds = 0,
  info,
  audioTrack = 0,
  quality = 'original',
  encoder = 'libx264',
  canToneMap = false,
  directory,
}) {
  const maxHeight = MAX_HEIGHT_BY_QUALITY[quality] ?? null;
  const args = ['-hide_banner', '-loglevel', 'error', '-hwaccel', 'auto'];

  if (startSeconds > 0) args.push('-ss', String(startSeconds));
  args.push('-i', filePath, '-map', '0:v:0?', '-map', `0:a:${audioTrack}?`, '-sn', '-dn');

  const scaleNeeded = maxHeight && info?.height && info.height > maxHeight;
  const reencode = needsVideoReencode(info) || scaleNeeded || Boolean(info?.hdr);

  if (reencode) {
    const height = scaleNeeded ? maxHeight : info?.height ?? 1080;
    const bitrate = BITRATE_BY_HEIGHT[height <= 480 ? 480 : height <= 720 ? 720 : height <= 1080 ? 1080 : 2160];
    args.push('-vf', buildVideoFilter({ info, maxHeight, canToneMap }));
    if (encoder === 'h264_nvenc') {
      args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-b:v', String(bitrate));
    } else if (encoder === 'h264_qsv') {
      args.push('-c:v', 'h264_qsv', '-b:v', String(bitrate));
    } else if (encoder === 'h264_amf') {
      args.push('-c:v', 'h264_amf', '-rc', 'vbr_peak', '-b:v', String(bitrate));
    } else {
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-b:v', String(bitrate));
    }
    args.push('-profile:v', 'high', '-level', '4.1');
  } else {
    args.push('-c:v', 'copy');
  }

  if (needsAudioReencode(info)) {
    const channels = Math.min(info?.audioChannels || 2, 6);
    args.push('-c:a', 'aac', '-ac', String(channels), '-b:a', channels > 2 ? '384k' : '192k');
  } else {
    args.push('-c:a', 'copy');
  }

  // Segments must start on a keyframe or Safari stalls at the joins.
  args.push(
    '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`,
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SECONDS),
    '-hls_list_size', '0',
    '-hls_flags', 'independent_segments+temp_file',
    '-hls_playlist_type', 'event',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', path.join(directory, 'seg%05d.ts'),
    path.join(directory, PLAYLIST_NAME)
  );

  return args;
}

export class HlsSessions {
  constructor({ root = null } = {}) {
    this.root = root ?? path.join(os.tmpdir(), `stream-hls-${crypto.randomBytes(6).toString('hex')}`);
    this.sessions = new Map();
    fs.mkdirSync(this.root, { recursive: true });
  }

  directoryFor(key) {
    return path.join(this.root, key);
  }

  // Starts ffmpeg if this exact encode is not already running.
  start(key, options) {
    const existing = this.sessions.get(key);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing;
    }

    const directory = this.directoryFor(key);
    fs.mkdirSync(directory, { recursive: true });

    const args = buildHlsArgs({ ...options, directory });
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    const session = {
      key,
      directory,
      args,
      process: child,
      stderr: '',
      exitCode: null,
      lastUsed: Date.now(),
    };

    child.stderr.on('data', (chunk) => {
      session.stderr = (session.stderr + chunk.toString()).slice(-4000);
    });
    child.on('error', () => {
      session.exitCode = -1;
    });
    child.on('close', (code) => {
      session.exitCode = code;
    });

    this.sessions.set(key, session);
    return session;
  }

  touch(key) {
    const session = this.sessions.get(key);
    if (session) session.lastUsed = Date.now();
    return session ?? null;
  }

  // The playlist is written before any segment exists, and Safari gives up on
  // an empty one, so wait until at least one segment has been listed.
  async waitForPlaylist(session, { timeoutMs = 90_000, minimumSegments = 1 } = {}) {
    const playlist = path.join(session.directory, PLAYLIST_NAME);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const text = await fsp.readFile(playlist, 'utf8');
        const segments = (text.match(/\.ts$/gm) ?? []).length;
        if (segments >= minimumSegments || text.includes('#EXT-X-ENDLIST')) return text;
      } catch {
        /* not written yet */
      }
      if (session.exitCode !== null && session.exitCode !== 0) return null;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return null;
  }

  stop(key) {
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    if (session.process.exitCode === null && session.process.signalCode === null) {
      session.process.kill('SIGKILL');
    }
    fs.rm(session.directory, { recursive: true, force: true }, () => {});
  }

  sweep(now = Date.now()) {
    for (const [key, session] of this.sessions) {
      if (now - session.lastUsed > IDLE_TIMEOUT_MS) this.stop(key);
    }
  }

  stopAll() {
    for (const key of [...this.sessions.keys()]) this.stop(key);
    fs.rm(this.root, { recursive: true, force: true }, () => {});
  }
}
