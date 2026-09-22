// On-the-fly remux/transcode for files a browser can't open directly (mkv, avi,
// HEVC, AC3 audio...). Output is fragmented MP4 so playback can start before
// ffmpeg has finished reading the file.
import { spawn } from 'node:child_process';
import { needsVideoReencode, needsAudioReencode } from './media.js';

export function buildFfmpegArgs({
  filePath,
  startSeconds = 0,
  info,
  audioTrack = 0,
  quality = 'medium',
  maxHeight = null,
}) {
  const args = ['-hide_banner', '-loglevel', 'error'];

  // -ss before -i seeks by keyframe index: fast even on a 40GB file.
  if (startSeconds > 0) args.push('-ss', String(startSeconds));
  args.push('-i', filePath);

  args.push('-map', '0:v:0?');
  args.push('-map', `0:a:${audioTrack}?`);
  args.push('-sn', '-dn'); // subtitles and data streams are served separately

  const reencodeVideo = needsVideoReencode(info);
  const scaleNeeded = maxHeight && info?.height && info.height > maxHeight;

  if (reencodeVideo || scaleNeeded) {
    const presets = { low: 'veryfast', medium: 'faster', high: 'medium' };
    const crfs = { low: 28, medium: 23, high: 20 };
    args.push(
      '-c:v', 'libx264',
      '-preset', presets[quality] ?? 'faster',
      '-crf', String(crfs[quality] ?? 23),
      '-profile:v', 'high',
      '-level', '4.1',
      '-pix_fmt', 'yuv420p',
      // Regular keyframes keep seeking responsive.
      '-g', '120',
      '-force_key_frames', 'expr:gte(t,n_forced*4)'
    );
    if (scaleNeeded) args.push('-vf', `scale=-2:${maxHeight}`);
  } else {
    args.push('-c:v', 'copy');
  }

  if (needsAudioReencode(info)) {
    args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  } else {
    args.push('-c:a', 'copy');
  }

  args.push(
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof+faststart',
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
