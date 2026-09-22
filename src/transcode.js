// On-the-fly remux/transcode for files a browser can't open directly.
//
// The expensive case is 4K: HEVC that browsers mostly can't decode, often HDR,
// at a bitrate no home upload can carry. That needs a real re-encode, so we use
// the GPU when there is one — software x264 cannot encode 4K in real time.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { needsVideoReencode, needsAudioReencode } from './media.js';

const execFileAsync = promisify(execFile);

// Best first. NVENC (NVIDIA), QSV (Intel iGPU), AMF (AMD) all encode 4K in
// real time at a fraction of the CPU cost; libx264 is the last resort.
const HARDWARE_ENCODERS = ['h264_nvenc', 'h264_qsv', 'h264_amf'];

export const BITRATE_BY_HEIGHT = {
  2160: 24_000_000,
  1080: 8_000_000,
  720: 4_000_000,
  480: 2_000_000,
};

export const MAX_HEIGHT_BY_QUALITY = { original: null, high: 1080, medium: 720, low: 480 };

let capabilities = null;

export function resetCapabilities() {
  capabilities = null;
}

export async function detectCapabilities() {
  if (capabilities) return capabilities;

  const listed = async (flag) => {
    try {
      const { stdout } = await execFileAsync('ffmpeg', ['-hide_banner', flag], {
        timeout: 15_000,
        maxBuffer: 8 << 20,
      });
      return stdout;
    } catch {
      return '';
    }
  };

  const [encoders, filters] = await Promise.all([listed('-encoders'), listed('-filters')]);

  capabilities = {
    encoders: HARDWARE_ENCODERS.filter((name) => encoders.includes(name)),
    // Tone mapping needs ffmpeg built with zimg. Most Windows builds have it.
    canToneMap: filters.includes('zscale') && filters.includes('tonemap'),
  };
  return capabilities;
}

export function pickEncoder(available = [], { preferSoftware = false } = {}) {
  if (preferSoftware) return 'libx264';
  return available[0] ?? 'libx264';
}

function targetBitrate(height) {
  if (!height) return BITRATE_BY_HEIGHT[1080];
  const steps = Object.keys(BITRATE_BY_HEIGHT)
    .map(Number)
    .sort((a, b) => a - b);
  for (const step of steps) {
    if (height <= step) return BITRATE_BY_HEIGHT[step];
  }
  return BITRATE_BY_HEIGHT[2160];
}

// Rate control differs per encoder; each of these targets "looks right at this
// bitrate" rather than a fixed quality, because the link is the constraint.
function encoderArgs(encoder, { bitrate, quality }) {
  const maxrate = Math.round(bitrate * 1.5);
  const bufsize = Math.round(bitrate * 3);

  switch (encoder) {
    case 'h264_nvenc': {
      const presets = { low: 'p1', medium: 'p4', high: 'p5', original: 'p5' };
      return [
        '-c:v', 'h264_nvenc',
        '-preset', presets[quality] ?? 'p4',
        '-rc', 'vbr',
        '-b:v', String(bitrate),
        '-maxrate', String(maxrate),
        '-bufsize', String(bufsize),
        '-profile:v', 'high',
      ];
    }
    case 'h264_qsv':
      return [
        '-c:v', 'h264_qsv',
        '-b:v', String(bitrate),
        '-maxrate', String(maxrate),
        '-bufsize', String(bufsize),
        '-profile:v', 'high',
      ];
    case 'h264_amf':
      return [
        '-c:v', 'h264_amf',
        '-quality', quality === 'low' ? 'speed' : 'balanced',
        '-rc', 'vbr_peak',
        '-b:v', String(bitrate),
        '-maxrate', String(maxrate),
        '-profile:v', 'high',
      ];
    default: {
      const presets = { low: 'veryfast', medium: 'faster', high: 'medium', original: 'medium' };
      return [
        '-c:v', 'libx264',
        '-preset', presets[quality] ?? 'faster',
        '-b:v', String(bitrate),
        '-maxrate', String(maxrate),
        '-bufsize', String(bufsize),
        '-profile:v', 'high',
        '-level', '4.1',
      ];
    }
  }
}

// HDR to SDR. Without this, HDR footage re-encoded as SDR looks washed out and
// grey — the single most visible mistake you can make transcoding 4K.
export function buildVideoFilter({ info, maxHeight, canToneMap }) {
  const filters = [];
  const scaleNeeded = maxHeight && info?.height && info.height > maxHeight;

  if (info?.hdr && canToneMap) {
    filters.push(
      'zscale=t=linear:npl=100',
      'format=gbrpf32le',
      'zscale=p=bt709',
      'tonemap=tonemap=hable:desat=0',
      'zscale=t=bt709:m=bt709:r=tv'
    );
  }
  if (scaleNeeded) filters.push(`scale=-2:${maxHeight}`);
  // Browsers need 8-bit 4:2:0; 10-bit HDR sources are otherwise undecodable.
  filters.push('format=yuv420p');

  return filters.join(',');
}

export function buildFfmpegArgs({
  filePath,
  startSeconds = 0,
  info,
  audioTrack = 0,
  quality = 'original',
  encoder = 'libx264',
  canToneMap = false,
  hardwareDecode = true,
}) {
  const maxHeight = MAX_HEIGHT_BY_QUALITY[quality] ?? null;
  const args = ['-hide_banner', '-loglevel', 'error'];

  // Hardware decode matters as much as hardware encode on 4K HEVC. 'auto' keeps
  // frames in system memory so software filters still work.
  if (hardwareDecode) args.push('-hwaccel', 'auto');

  // -ss before -i seeks by keyframe index: fast even on a 60GB file.
  if (startSeconds > 0) args.push('-ss', String(startSeconds));
  args.push('-i', filePath);

  args.push('-map', '0:v:0?');
  args.push('-map', `0:a:${audioTrack}?`);
  args.push('-sn', '-dn'); // subtitles and data streams are served separately

  const scaleNeeded = maxHeight && info?.height && info.height > maxHeight;
  const toneMapNeeded = Boolean(info?.hdr);
  const reencodeVideo = needsVideoReencode(info) || scaleNeeded || toneMapNeeded;

  if (reencodeVideo) {
    const outputHeight = scaleNeeded ? maxHeight : info?.height ?? null;
    args.push('-vf', buildVideoFilter({ info, maxHeight, canToneMap }));
    args.push(...encoderArgs(encoder, { bitrate: targetBitrate(outputHeight), quality }));
    // Regular keyframes keep seeking responsive.
    args.push('-g', '120', '-force_key_frames', 'expr:gte(t,n_forced*4)');
  } else {
    args.push('-c:v', 'copy');
  }

  if (needsAudioReencode(info)) {
    // Keep surround if the source has it: downmixing 5.1 to stereo is the other
    // half of "proper sound". Browsers downmix for themselves if they must.
    const channels = Math.min(info?.audioChannels || 2, 6);
    args.push('-c:a', 'aac', '-ac', String(channels), '-b:a', channels > 2 ? '384k' : '192k');
  } else {
    args.push('-c:a', 'copy');
  }

  args.push(
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration', '2000000',
    '-f', 'mp4',
    'pipe:1'
  );

  return args;
}

export function startTranscode(options) {
  const args = buildFfmpegArgs(options);
  const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    // Keep only the tail; a stuck decode can produce megabytes of warnings.
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  child.on('error', () => {
    /* surfaced to the caller via the 'close' event */
  });

  return {
    process: child,
    stdout: child.stdout,
    args,
    getStderr: () => stderr,
    stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    },
  };
}
