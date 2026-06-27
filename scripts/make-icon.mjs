/**
 * Generates the Claude Keeper app icon (build/icon.png, 1024x1024 RGBA) with no
 * native dependencies — a tiny hand-rolled PNG encoder over Node's zlib.
 *
 * Design: a GitHub-dark rounded square, a blue→green "resume loop" arc with an
 * arrowhead (auto-resume), and two amber pause bars (waiting for the reset).
 *
 * Run: `node scripts/make-icon.mjs`
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;
const C = SIZE / 2;

// --- palette (GitHub dark) ---
const BG = [13, 17, 23]; // #0d1117
const BORDER = [48, 54, 61]; // #30363d
const BLUE = [88, 166, 255]; // #58a6ff
const GREEN = [63, 185, 80]; // #3fb950
const AMBER = [210, 153, 34]; // #d29922

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

function roundedRect(x, y, half, r) {
  const dx = Math.abs(x - C) - (half - r);
  const dy = Math.abs(y - C) - (half - r);
  const out = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - r;
  return Math.min(Math.max(dx, dy), 0) + out; // signed distance (<0 inside)
}

// Arc geometry
const R = 300; // centerline radius
const STROKE = 72; // ring thickness
const GAP_CENTER = -Math.PI / 2; // top
const GAP_HALF = (40 * Math.PI) / 180;
const END_ANGLE = GAP_CENTER + GAP_HALF; // leading end of the arc (arrowhead here)

function inArc(x, y) {
  const d = Math.hypot(x - C, y - C);
  if (Math.abs(d - R) > STROKE / 2) return false;
  let a = Math.atan2(y - C, x - C);
  // normalize gap test: present everywhere except within GAP_HALF of GAP_CENTER
  let diff = Math.atan2(Math.sin(a - GAP_CENTER), Math.cos(a - GAP_CENTER));
  return Math.abs(diff) > GAP_HALF;
}

// Arrowhead triangle at the arc's leading end, pointing along travel.
const ePt = [C + R * Math.cos(END_ANGLE), C + R * Math.sin(END_ANGLE)];
const tang = [-Math.sin(END_ANGLE), Math.cos(END_ANGLE)];
const norm = [Math.cos(END_ANGLE), Math.sin(END_ANGLE)];
const tip = [ePt[0] + tang[0] * 95, ePt[1] + tang[1] * 95];
const b1 = [ePt[0] - tang[0] * 18 + norm[0] * 72, ePt[1] - tang[1] * 18 + norm[1] * 72];
const b2 = [ePt[0] - tang[0] * 18 - norm[0] * 72, ePt[1] - tang[1] * 18 - norm[1] * 72];

function inTriangle(px, py, a, b, c) {
  const s = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const d1 = s([px, py], a, b);
  const d2 = s([px, py], b, c);
  const d3 = s([px, py], c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function inBars(x, y) {
  const w = 60;
  const h = 240;
  const gap = 78;
  const r = 26;
  for (const cx of [C - gap / 2 - w / 2, C + gap / 2 + w / 2]) {
    const dx = Math.abs(x - cx) - (w / 2 - r);
    const dy = Math.abs(y - C) - (h / 2 - r);
    const out = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - r;
    if (Math.min(Math.max(dx, dy), 0) + out < 0) return true;
  }
  return false;
}

/** Topmost layer color + alpha at a single (sub)sample point. */
function sample(x, y) {
  if (inBars(x, y)) return [...AMBER, 255];
  if (inArc(x, y)) {
    const t = (y - (C - R)) / (2 * R); // vertical blue->green gradient
    return [...mix(BLUE, GREEN, Math.min(1, Math.max(0, t))), 255];
  }
  if (inTriangle(x, y, tip, b1, b2)) return [...mix(BLUE, GREEN, 0.1), 255];
  const sd = roundedRect(x, y, SIZE / 2 - 8, 220);
  if (sd < 0) {
    // thin inner border ring near the edge
    if (sd > -10) return [...BORDER, 255];
    return [...BG, 255];
  }
  return [0, 0, 0, 0];
}

const SS = 3; // supersampling grid per pixel (AA)
const raw = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS;
        const py = y + (sy + 0.5) / SS;
        const [cr, cg, cb, ca] = sample(px, py);
        const af = ca / 255;
        r += cr * af;
        g += cg * af;
        b += cb * af;
        a += af;
      }
    }
    const n = SS * SS;
    const idx = (y * SIZE + x) * 4;
    const alpha = a / n;
    // un-premultiply to straight alpha
    raw[idx] = alpha > 0 ? Math.round(r / a) : 0;
    raw[idx + 1] = alpha > 0 ? Math.round(g / a) : 0;
    raw[idx + 2] = alpha > 0 ? Math.round(b / a) : 0;
    raw[idx + 3] = Math.round(alpha * 255);
  }
}

// --- minimal PNG encoder (RGBA, 8-bit, filter 0 per scanline) ---
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
const filtered = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  filtered[y * (SIZE * 4 + 1)] = 0; // filter type none
  raw.copy(filtered, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(filtered, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes, ${SIZE}x${SIZE})`);
