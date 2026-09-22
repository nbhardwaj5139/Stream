// Discovering, probing and describing the movies on the host's disk.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.m4v', '.mkv', '.webm', '.avi', '.mov', '.wmv', '.flv', '.mpg', '.mpeg', '.ts', '.m2ts', '.ogv',
]);

export const SUBTITLE_EXTENSIONS = new Set(['.srt', '.vtt', '.ass', '.ssa', '.sub']);

// Containers a browser can open directly. Everything else needs ffmpeg.
const NATIVE_CONTAINERS = new Set(['.mp4', '.m4v', '.webm', '.ogv']);
const NATIVE_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1', 'theora']);
const NATIVE_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

const MIME_BY_EXTENSION = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
};

export function mimeForFile(filePath) {
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

// Stable across restarts so a shared link keeps working after you restart the server.
export function mediaId(absolutePath) {
  return crypto.createHash('sha1').update(absolutePath).digest('hex').slice(0, 16);
}

let ffmpegAvailability = null;

export async function detectFfmpeg() {
  if (ffmpegAvailability) return ffmpegAvailability;
  const probe = async (bin) => {
    try {
      await execFileAsync(bin, ['-version'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  };
  const [ffmpeg, ffprobe] = await Promise.all([probe('ffmpeg'), probe('ffprobe')]);
  ffmpegAvailability = { ffmpeg, ffprobe };
  return ffmpegAvailability;
}

export function resetFfmpegDetection() {
  ffmpegAvailability = null;
}

async function probeFile(absolutePath) {
  const { ffprobe } = await detectFfmpeg();
  if (!ffprobe) return null;
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v', 'error',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        absolutePath,
      ],
      { timeout: 30_000, maxBuffer: 8 << 20 }
    );
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function summarizeProbe(probe) {
  if (!probe) return null;
  const streams = probe.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');
  const subtitleStreams = streams.filter((s) => s.codec_type === 'subtitle');

  return {
    duration: Number(probe.format?.duration) || null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audioStreams[0]?.codec_name ?? null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    audioTracks: audioStreams.map((s, index) => ({
      index,
      streamIndex: s.index,
      codec: s.codec_name,
      language: s.tags?.language ?? null,
      title: s.tags?.title ?? null,
      channels: s.channels ?? null,
    })),
    embeddedSubtitles: subtitleStreams.map((s, index) => ({
      index,
      streamIndex: s.index,
      codec: s.codec_name,
      language: s.tags?.language ?? null,
      title: s.tags?.title ?? null,
      // Bitmap subtitles can't be converted to WebVTT; they'd need burning in.
      textBased: !['dvd_subtitle', 'hdmv_pgs_subtitle', 'dvb_subtitle', 'xsub'].includes(s.codec_name),
    })),
  };
}

// Can the browser play this file byte-for-byte, or does it need ffmpeg?
export function chooseDeliveryMode(absolutePath, info) {
  const extension = path.extname(absolutePath).toLowerCase();
  if (!NATIVE_CONTAINERS.has(extension)) return 'transcode';
  if (!info) return 'direct'; // no ffprobe: trust the container and let the browser try
  if (info.videoCodec && !NATIVE_VIDEO_CODECS.has(info.videoCodec)) return 'transcode';
  if (info.audioCodec && !NATIVE_AUDIO_CODECS.has(info.audioCodec)) return 'transcode';
  return 'direct';
}

export function needsVideoReencode(info) {
  return !info?.videoCodec || !NATIVE_VIDEO_CODECS.has(info.videoCodec);
}

export function needsAudioReencode(info) {
  // Matroska audio like ac3/dts/truehd has to become aac for browsers.
  return !info?.audioCodec || !['aac', 'mp3', 'opus', 'vorbis'].includes(info.audioCodec);
}

async function findSidecarSubtitles(absolutePath) {
  const directory = path.dirname(absolutePath);
  const base = path.basename(absolutePath, path.extname(absolutePath));
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const found = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!SUBTITLE_EXTENSIONS.has(extension)) continue;
    const stem = path.basename(entry.name, extension);
    // Matches "Movie.srt" and "Movie.en.srt" / "Movie.English.forced.srt".
    if (stem !== base && !stem.startsWith(`${base}.`)) continue;
    const suffix = stem.slice(base.length).replace(/^\./, '');
    found.push({
      file: path.join(directory, entry.name),
      label: suffix || 'Subtitles',
      format: extension,
    });
  }
  return found.sort((a, b) => a.label.localeCompare(b.label));
}

async function* walk(directory, depth, maxDepth) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (depth < maxDepth) yield* walk(full, depth + 1, maxDepth);
    } else if (entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      yield full;
    }
  }
}

export class Library {
  constructor(roots, { maxDepth = 6 } = {}) {
    this.roots = roots.map((root) => path.resolve(root));
    this.maxDepth = maxDepth;
    this.items = new Map();
    this.scannedAt = null;
  }

  async scan() {
    const items = new Map();
    for (const root of this.roots) {
      for await (const file of walk(root, 0, this.maxDepth)) {
        const id = mediaId(file);
        if (items.has(id)) continue;
        let stat;
        try {
          stat = await fs.stat(file);
        } catch {
          continue;
        }
        items.set(id, {
          id,
          path: file,
          root,
          name: path.basename(file, path.extname(file)),
          relativePath: path.relative(root, file),
          size: stat.size,
          modifiedAt: stat.mtimeMs,
          extension: path.extname(file).toLowerCase(),
          info: null,
          probed: false,
          subtitles: null,
          deliveryMode: null,
        });
      }
    }
    // Keep already-probed metadata so a rescan doesn't re-run ffprobe.
    for (const [id, previous] of this.items) {
      const next = items.get(id);
      if (next && previous.probed && previous.modifiedAt === next.modifiedAt) {
        Object.assign(next, {
          info: previous.info,
          probed: true,
          subtitles: previous.subtitles,
          deliveryMode: previous.deliveryMode,
        });
      }
    }
    this.items = items;
    this.scannedAt = Date.now();
    return this.list();
  }

  get(id) {
    return this.items.get(id) ?? null;
  }

  // Probing is lazy: scanning 400 files with ffprobe on startup is slow.
  async describe(id) {
    const item = this.get(id);
    if (!item) return null;
    if (!item.probed) {
      item.info = summarizeProbe(await probeFile(item.path));
      item.subtitles = await findSidecarSubtitles(item.path);
      item.deliveryMode = chooseDeliveryMode(item.path, item.info);
      item.probed = true;
    }
    return item;
  }

  list() {
    return [...this.items.values()]
      .map((item) => ({
        id: item.id,
        name: item.name,
        relativePath: item.relativePath,
        size: item.size,
        extension: item.extension,
        duration: item.info?.duration ?? null,
        deliveryMode: item.deliveryMode,
      }))
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true }));
  }
}

export function publicDescription(item) {
  if (!item) return null;
  return {
    id: item.id,
    name: item.name,
    relativePath: item.relativePath,
    size: item.size,
    extension: item.extension,
    deliveryMode: item.deliveryMode,
    duration: item.info?.duration ?? null,
    width: item.info?.width ?? null,
    height: item.info?.height ?? null,
    videoCodec: item.info?.videoCodec ?? null,
    audioCodec: item.info?.audioCodec ?? null,
    audioTracks: item.info?.audioTracks ?? [],
    subtitles: [
      ...(item.subtitles ?? []).map((sub, index) => ({
        id: `file:${index}`,
        label: sub.label,
        source: 'file',
      })),
      ...(item.info?.embeddedSubtitles ?? [])
        .filter((sub) => sub.textBased)
        .map((sub) => ({
          id: `embedded:${sub.index}`,
          label: sub.title || sub.language || `Track ${sub.index + 1}`,
          source: 'embedded',
        })),
    ],
  };
}
