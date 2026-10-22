#!/usr/bin/env node
// Generates the PWA app icons (public/icons/*.png) as flat RGBA pixel
// buffers hand-encoded into PNG, using only Node's built-in zlib for
// compression. No image library dependency — the design is simple enough
// (gradient rounded square + circle + dot, same mark used everywhere else
// as an inline SVG: see the favicon link in public/index.html) to compute
// per-pixel directly. Re-run with `node scripts/generate-icons.js` if the
// brand mark ever changes.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');

const GRADIENT_FROM = [0x4f, 0x8c, 0xff]; // #4f8cff
const GRADIENT_TO = [0x7c, 0x5c, 0xff]; // #7c5cff
const WHITE = [0xff, 0xff, 0xff];
const DOT = [0x4f, 0x8c, 0xff];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function mixColor(t) {
  return [
    Math.round(lerp(GRADIENT_FROM[0], GRADIENT_TO[0], t)),
    Math.round(lerp(GRADIENT_FROM[1], GRADIENT_TO[1], t)),
    Math.round(lerp(GRADIENT_FROM[2], GRADIENT_TO[2], t)),
  ];
}

// Signed distance from a point to the nearest edge of a rounded square,
// used to both draw the rounded corners and antialias their edge.
function roundedRectCoverage(px, py, size, radius) {
  const cx = Math.min(Math.max(px, radius), size - radius);
  const cy = Math.min(Math.max(py, radius), size - radius);
  const dx = px - cx;
  const dy = py - cy;
  const dist = Math.sqrt(dx * dx + dy * dy) - radius;
  return clampCoverage(-dist);
}

function circleCoverage(px, py, cx, cy, r) {
  const dist = Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy)) - r;
  return clampCoverage(-dist);
}

function clampCoverage(v) {
  // 1px-wide antialiasing band around the edge (v is signed distance-inside).
  return Math.max(0, Math.min(1, v + 0.5));
}

function over(base, color, alpha) {
  return [
    Math.round(lerp(base[0], color[0], alpha)),
    Math.round(lerp(base[1], color[1], alpha)),
    Math.round(lerp(base[2], color[2], alpha)),
  ];
}

// purpose: 'any' draws the rounded-square card exactly like the existing
// inline SVG mark; 'maskable' fills edge-to-edge (no rounded corners baked
// in, since the OS launcher applies its own mask) with the same circle+dot
// centered well inside the safe zone.
function renderPixel(x, y, size, purpose) {
  const px = x + 0.5;
  const py = y + 0.5;
  const t = (px + py) / (2 * size); // diagonal gradient, matches SVG's x1y1->x2y2
  const bg = mixColor(t);

  let rgb;
  let alpha;
  if (purpose === 'maskable') {
    rgb = bg;
    alpha = 1;
  } else {
    const cornerRadius = size * 0.25; // matches rx=6 on a 24-wide SVG viewBox
    alpha = roundedRectCoverage(px, py, size, cornerRadius);
    rgb = bg;
  }

  const cx = size / 2;
  const cy = size / 2;
  const outerR = size * 0.1875; // matches r=4.5 on a 24-wide viewBox
  const innerR = size * 0.0833; // matches r=2 on a 24-wide viewBox

  const outerCov = circleCoverage(px, py, cx, cy, outerR);
  if (outerCov > 0) {
    rgb = over(rgb, WHITE, outerCov * 0.95);
  }
  const innerCov = circleCoverage(px, py, cx, cy, innerR);
  if (innerCov > 0) {
    rgb = over(rgb, DOT, innerCov);
  }

  return [rgb[0], rgb[1], rgb[2], Math.round(alpha * 255)];
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(width, height, pixelFn) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // filter type: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const idat = zlib.deflateSync(raw);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function generate(size, purpose, filename) {
  const png = encodePng(size, size, (x, y) => renderPixel(x, y, size, purpose));
  fs.writeFileSync(path.join(OUT_DIR, filename), png);
  console.log(`wrote public/icons/${filename} (${size}x${size}, ${purpose})`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
generate(192, 'any', 'icon-192.png');
generate(512, 'any', 'icon-512.png');
generate(512, 'maskable', 'icon-512-maskable.png');
