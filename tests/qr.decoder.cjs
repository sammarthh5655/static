'use strict';

/**
 * A small QR decoder, for checking the QR codes Static makes.
 *
 * Not a probe (the dot in the name keeps it from being run as one): the unit
 * test and the off-screen probe both use it to read back what the encoder
 * and the overlay drew. It is deliberately strict - format information that
 * does not match a valid code, or any block whose Reed-Solomon syndromes are
 * not all zero, is a failure rather than something to correct - because the
 * point is to prove the symbol is right, not merely readable.
 *
 * Written separately from src/features/pagetools/qr.js and checked against
 * OpenCV's decoder while it was developed.
 */

const ECC = {
  L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};
const GROUPS = {
  L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};
const LEVEL_OF_BITS = ['M', 'L', 'H', 'Q'];

function mul(a, b) {
  let r = 0;
  while (b) {
    if (b & 1) r ^= a;
    a <<= 1;
    if (a & 0x100) a ^= 0x11d;
    b >>= 1;
  }
  return r;
}

function formatCode(levelBits, mask) {
  const data = (levelBits << 3) | mask;
  let r = data << 10;
  for (let i = 14; i >= 10; i--) if ((r >> i) & 1) r ^= 0x537 << (i - 10);
  return ((data << 10) | r) ^ 0x5412;
}

const popcount = (n) => { let c = 0; while (n) { c += n & 1; n >>= 1; } return c; };

function alignmentCentres(version) {
  if (version < 2) return [];
  const count = Math.floor(version / 7) + 2;
  const last = version * 4 + 10;
  const step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
  const out = [];
  for (let i = 0; i < count - 1; i++) out.unshift(last - i * step);
  out.unshift(6);
  return out;
}

const MASK = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/**
 * Read a QR symbol. `m[y][x]` is true for a dark module; no quiet zone.
 * Returns { text, version, level, mask } or throws saying what was wrong.
 */
function decode(m) {
  const size = m.length;
  const version = (size - 17) / 4;
  if (!Number.isInteger(version) || version < 1 || version > 40) throw new Error('not a QR size: ' + size);
  const at = (x, y) => (m[y][x] ? 1 : 0);

  // Format information, both copies; each must be a valid code exactly.
  let first = 0;
  const firstPositions = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  firstPositions.forEach(([x, y], i) => { first |= at(x, y) << i; });
  let second = 0;
  for (let i = 0; i < 8; i++) second |= at(size - 1 - i, 8) << i;
  for (let i = 8; i < 15; i++) second |= at(8, size - 15 + i) << i;
  let found = null;
  for (let levelBits = 0; levelBits < 4; levelBits++) {
    for (let mask = 0; mask < 8; mask++) {
      const code = formatCode(levelBits, mask);
      if (code === first && code === second) found = { level: LEVEL_OF_BITS[levelBits], mask };
    }
  }
  if (!found) throw new Error('format information is not a valid code (' + first.toString(2) + ' / ' + second.toString(2) + ')');
  if (!m[size - 8][8]) throw new Error('the dark module is missing');

  // What is not data.
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (x0, y0, w, h) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (x >= 0 && y >= 0 && x < size && y < size) reserved[y][x] = true;
  };
  mark(0, 0, 9, 9); mark(size - 8, 0, 8, 9); mark(0, size - 8, 9, 8);
  mark(6, 0, 1, size); mark(0, 6, size, 1);
  const centres = alignmentCentres(version);
  for (const cy of centres) {
    for (const cx of centres) {
      if ((cx < 9 && cy < 9) || (cx > size - 9 && cy < 9) || (cx < 9 && cy > size - 9)) continue;
      mark(cx - 2, cy - 2, 5, 5);
    }
  }
  if (version >= 7) { mark(size - 11, 0, 3, 6); mark(0, size - 11, 6, 3); }

  // Finders must really be finders.
  for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
        if (at(ox + x, oy + y) !== (ring === 2 ? 0 : 1)) throw new Error('a finder pattern is damaged');
      }
    }
  }

  // The data bits, in zigzag order, unmasked.
  const bits = [];
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right--;
    for (let k = 0; k < size; k++) {
      const y = upward ? size - 1 - k : k;
      for (const x of [right, right - 1]) {
        if (reserved[y][x]) continue;
        bits.push(at(x, y) ^ (MASK[found.mask](x, y) ? 1 : 0));
      }
    }
    upward = !upward;
  }
  const total = Math.floor(bits.length / 8);
  const codewords = [];
  for (let i = 0; i < total; i++) codewords.push(bits.slice(i * 8, i * 8 + 8).reduce((b, v) => (b << 1) | v, 0));

  // De-interleave and check every block.
  const blocks = GROUPS[found.level][version];
  const ecc = ECC[found.level][version];
  const longBlocks = total % blocks;
  const shortData = Math.floor(total / blocks) - ecc;
  const dataLength = (b) => shortData + (b >= blocks - longBlocks ? 1 : 0);
  const parts = Array.from({ length: blocks }, () => ({ data: [], ecc: [] }));
  let p = 0;
  for (let i = 0; i < shortData + 1; i++) {
    for (let b = 0; b < blocks; b++) if (i < dataLength(b)) parts[b].data.push(codewords[p++]);
  }
  for (let i = 0; i < ecc; i++) for (let b = 0; b < blocks; b++) parts[b].ecc.push(codewords[p++]);
  parts.forEach((part, index) => {
    const all = [...part.data, ...part.ecc];
    let alpha = 1;
    for (let j = 0; j < ecc; j++) {
      let s = 0;
      for (const c of all) s = mul(s, alpha) ^ c;
      if (s !== 0) throw new Error('block ' + index + ' fails its error correction check');
      alpha = mul(alpha, 2);
    }
  });

  // Byte mode only, which is all Static writes.
  const data = parts.flatMap((part) => part.data);
  const stream = data.flatMap((byte) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (byte >> i) & 1));
  let cursor = 0;
  const read = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | stream[cursor++]; return v; };
  const mode = read(4);
  if (mode !== 0b0100) throw new Error('not byte mode: ' + mode.toString(2));
  const count = read(version < 10 ? 8 : 16);
  if (cursor + count * 8 > stream.length) throw new Error('length runs past the data');
  const bytes = new Uint8Array(count);
  for (let i = 0; i < count; i++) bytes[i] = read(8);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { text, version, level: found.level, mask: found.mask };
}

/**
 * Turn a picture of a symbol into modules: `pixels` is BGRA or RGBA (dark is
 * dark either way), the symbol's own square (no quiet zone) starts at
 * (left, top) and is `side` pixels across, `count` modules wide.
 */
function sample(pixels, width, { left, top, side, count }) {
  const modules = [];
  for (let y = 0; y < count; y++) {
    const row = [];
    for (let x = 0; x < count; x++) {
      const px = Math.floor(left + (x + 0.5) * side / count);
      const py = Math.floor(top + (y + 0.5) * side / count);
      const i = (py * width + px) * 4;
      row.push((pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3 < 128);
    }
    modules.push(row);
  }
  return modules;
}

module.exports = { decode, sample };
