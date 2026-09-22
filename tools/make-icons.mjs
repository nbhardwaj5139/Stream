// Generates the home-screen icons. Run with: node tools/make-icons.mjs
// Kept as a script so the icons can be regenerated if the mark changes.
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const ACCENT = [91, 140, 255];
const INK = [255, 255, 255];

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function toPng(size, pixels) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixels[y * size + x];
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Coverage of the shape at a pixel, sampled 3x3 so the edges are not jagged.
function coverage(x, y, test) {
  let hits = 0;
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      if (test(x + (sx + 0.5) / 3, y + (sy + 0.5) / 3)) hits++;
    }
  }
  return hits / 9;
}

function blend(base, over, alpha) {
  return base.map((channel, i) => Math.round(channel * (1 - alpha) + over[i] * alpha));
}

// `maskable` icons must survive being cropped to a circle, so the mark sits
// inside the safe zone and the background runs to the edges.
function render(size, { maskable = false } = {}) {
  const radius = maskable ? 0 : size * 0.22;
  const scale = maskable ? 0.62 : 0.8; // how much of the tile the play mark uses
  const pixels = new Array(size * size);

  const inTile = (x, y) => {
    if (radius === 0) return true;
    const cx = Math.min(Math.max(x, radius), size - radius);
    const cy = Math.min(Math.max(y, radius), size - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };

  // An equilateral-ish play triangle, centred, with its apex to the right.
  const half = (size * scale) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const left = cx - half * 0.55;
  const right = cx + half * 0.72;
  const top = cy - half * 0.72;
  const bottom = cy + half * 0.72;
  const inPlay = (x, y) => {
    if (x < left || x > right) return false;
    const t = (x - left) / (right - left);
    const span = (1 - t) * (bottom - top) / 2;
    return y >= cy - span && y <= cy + span;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tile = coverage(x, y, inTile);
      if (tile === 0) {
        pixels[y * size + x] = [0, 0, 0, 0];
        continue;
      }
      const play = coverage(x, y, inPlay);
      const colour = play > 0 ? blend(ACCENT, INK, play) : ACCENT;
      pixels[y * size + x] = [...colour, Math.round(255 * tile)];
    }
  }
  return pixels;
}

const out = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public');
fs.mkdirSync(out, { recursive: true });

for (const size of [180, 192, 512]) {
  fs.writeFileSync(path.join(out, `icon-${size}.png`), toPng(size, render(size)));
}
fs.writeFileSync(path.join(out, 'maskable-512.png'), toPng(512, render(512, { maskable: true })));

console.log('icons written to public/');
