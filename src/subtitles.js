// Subtitle conversion. Browsers only take WebVTT, so everything becomes WebVTT.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// "00:01:02,500" (SRT) and "0:01:02.50" (ASS) both become "00:01:02.500".
function normalizeTimestamp(value) {
  const match = /^(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(value.trim());
  if (!match) return null;
  const [, hours, minutes, seconds, fraction] = match;
  const milliseconds = fraction.padEnd(3, '0');
  return `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:${seconds.padStart(2, '0')}.${milliseconds}`;
}

export function srtToVtt(input) {
  const body = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const cues = [];

  for (const block of body.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((line) => line.trim() !== '');
    if (lines.length === 0) continue;

    // Drop the numeric sequence line if present.
    let index = /^\d+$/.test(lines[0].trim()) ? 1 : 0;
    const timing = lines[index];
    if (!timing) continue;

    const match = /^(\S+)\s*-->\s*(\S+)(.*)$/.exec(timing);
    if (!match) continue;
    const start = normalizeTimestamp(match[1]);
    const end = normalizeTimestamp(match[2]);
    if (!start || !end) continue;

    const text = lines.slice(index + 1).join('\n');
    if (!text) continue;
    cues.push(`${start} --> ${end}${match[3] ?? ''}\n${text}`);
  }

  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

function stripAssFormatting(text) {
  return text
    .replace(/\{[^}]*\}/g, '') // {\an8}, {\i1} override blocks
    .replace(/\\N/gi, '\n')
    .replace(/\\h/gi, ' ')
    .trim();
}

export function assToVtt(input) {
  const lines = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  let format = null;
  const cues = [];

  for (const line of lines) {
    if (/^Format:/i.test(line) && format === null) {
      format = line.slice(line.indexOf(':') + 1).split(',').map((field) => field.trim().toLowerCase());
      continue;
    }
    if (!/^Dialogue:/i.test(line)) continue;
    if (!format) format = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];

    const rest = line.slice(line.indexOf(':') + 1);
    // The text field is last and may itself contain commas.
    const parts = rest.split(',');
    const fields = parts.slice(0, format.length - 1).map((field) => field.trim());
    fields.push(parts.slice(format.length - 1).join(','));

    const record = Object.fromEntries(format.map((key, i) => [key, fields[i]]));
    const start = normalizeTimestamp(record.start ?? '');
    const end = normalizeTimestamp(record.end ?? '');
    const text = stripAssFormatting(record.text ?? '');
    if (!start || !end || !text) continue;
    cues.push(`${start} --> ${end}\n${text}`);
  }

  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

export async function readSubtitleAsVtt(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.vtt') return raw.startsWith('WEBVTT') ? raw : `WEBVTT\n\n${raw}`;
  if (extension === '.ass' || extension === '.ssa') return assToVtt(raw);
  return srtToVtt(raw);
}

// Pull a text subtitle track out of an mkv and hand it back as WebVTT.
export async function extractEmbeddedSubtitle(filePath, streamIndex) {
  const { stdout } = await execFileAsync(
    'ffmpeg',
    [
      '-v', 'error',
      '-i', filePath,
      '-map', `0:${streamIndex}`,
      '-f', 'webvtt',
      'pipe:1',
    ],
    { timeout: 120_000, maxBuffer: 32 << 20, encoding: 'utf8' }
  );
  return stdout || 'WEBVTT\n\n';
}
