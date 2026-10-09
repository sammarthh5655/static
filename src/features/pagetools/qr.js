'use strict';

/**
 * QR codes, made on this computer.
 *
 * "QR code for this page" must not send the address anywhere to draw it - an
 * online QR service would learn every page anyone ever shared - so this is a
 * complete encoder: byte mode (any UTF-8 text), every version from 1 to 40,
 * Reed-Solomon error correction and all eight masks, as ISO/IEC 18004 sets
 * them out. It follows the structure of Project Nayuki's well-known reference
 * encoder, written afresh here rather than copied.
 *
 * Pure functions with no Electron in them: main draws the picture for Copy
 * and Save from `bitmap`, the overlay draws the card from `rows`, and the
 * tests decode what both of them produce.
 */

/** Error correction levels, weakest first: roughly 7, 15, 25 and 30 per cent. */
const LEVELS = ['L', 'M', 'Q', 'H'];
/** The two bits each level writes into the format information. */
const FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

// Per version (index 1-40; 0 is unused), for L, M, Q and H in that order:
// how many error correction codewords each block carries, and how many blocks
// the data is split into. Straight from the standard's table 9.
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

/** Modules left for data and error correction once the fixed patterns are drawn. */
function rawModules(version) {
  let modules = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    modules -= (25 * align - 10) * align - 55;
    if (version >= 7) modules -= 36;
  }
  return modules;
}

/** Codewords of actual data a version holds at a level. */
function dataCodewords(version, level) {
  return Math.floor(rawModules(version) / 8) - ECC_PER_BLOCK[level][version] * BLOCKS[level][version];
}

/** Centres of the alignment patterns along each axis. */
function alignmentPositions(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
  const positions = [6];
  for (let pos = version * 4 + 10; positions.length < count; pos -= step) positions.splice(1, 0, pos);
  return positions;
}

/* ---- Reed-Solomon over GF(2^8), modulo x^8 + x^4 + x^3 + x^2 + 1 ---------- */

function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    divisor.forEach((coefficient, i) => { result[i] ^= gfMultiply(coefficient, factor); });
  }
  return result;
}

/* ---- the symbol ------------------------------------------------------------ */

const bit = (value, i) => ((value >>> i) & 1) !== 0;

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/**
 * Encode text as a QR code.
 *
 * Starts from `level` (M by default: enough to survive a scuffed or glary
 * screen) and steps up to a stronger level whenever that fits in the same
 * size, since the extra protection then costs nothing.
 *
 * @returns {{ version: number, level: string, mask: number, size: number, modules: boolean[][] }}
 *          modules[y][x] is true for a dark module.
 */
function encode(text, { level = 'M' } = {}) {
  const data = Array.from(new TextEncoder().encode(String(text ?? '')));
  let ecl = Math.max(0, LEVELS.indexOf(level));
  const bitsFor = (version) => 4 + (version < 10 ? 8 : 16) + data.length * 8;

  let version = 1;
  while (version <= 40 && bitsFor(version) > dataCodewords(version, ecl) * 8) version++;
  if (version > 40) throw new Error('That is too long to fit in a QR code.');
  for (let stronger = ecl + 1; stronger < LEVELS.length; stronger++) {
    if (bitsFor(version) <= dataCodewords(version, stronger) * 8) ecl = stronger;
  }

  // The bit stream: byte mode, the length, the bytes, a terminator, then
  // the two pad bytes the standard names, alternating to fill the space.
  const bits = [];
  const push = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  push(0b0100, 4);
  push(data.length, version < 10 ? 8 : 16);
  for (const byte of data) push(byte, 8);
  const capacity = dataCodewords(version, ecl) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((byte, b) => (byte << 1) | b, 0));

  // Split into blocks, protect each, then interleave them, so a smudge that
  // takes out a patch of the symbol costs every block a little rather than
  // one block everything.
  const blockCount = BLOCKS[ecl][version];
  const blockEcc = ECC_PER_BLOCK[ecl][version];
  const total = Math.floor(rawModules(version) / 8);
  const shortBlocks = blockCount - (total % blockCount);
  const shortLength = Math.floor(total / blockCount);
  const divisor = rsDivisor(blockEcc);
  const blocks = [];
  for (let i = 0, k = 0; i < blockCount; i++) {
    const chunk = codewords.slice(k, k + shortLength - blockEcc + (i < shortBlocks ? 0 : 1));
    k += chunk.length;
    const ecc = rsRemainder(chunk, divisor);
    if (i < shortBlocks) chunk.push(0);
    blocks.push(chunk.concat(ecc));
  }
  const stream = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLength - blockEcc || j >= shortBlocks) stream.push(block[i]);
    });
  }

  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { modules[y][x] = dark; fixed[y][x] = true; };

  // Timing lines, the three finders, the alignment patterns.
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, ring !== 2 && ring !== 4);
      }
    }
  }
  const centres = alignmentPositions(version);
  const last = centres.length - 1;
  centres.forEach((cy, i) => centres.forEach((cx, j) => {
    // Not where a finder already sits.
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }));

  const drawFormat = (mask) => {
    const value = (FORMAT_BITS[LEVELS[ecl]] << 3) | mask;
    let rem = value;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const format = ((value << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) set(8, i, bit(format, i));
    set(8, 7, bit(format, 6));
    set(8, 8, bit(format, 7));
    set(7, 8, bit(format, 8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(format, i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(format, i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(format, i));
    set(8, size - 8, true);
  };
  drawFormat(0);

  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const info = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit(info, i));
      set(b, a, bit(info, i));
    }
  }

  // The data, in the zigzag the standard prescribes: up and down two columns
  // at a time from the right, stepping over the vertical timing line.
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - step : step;
        if (!fixed[y][x] && index < stream.length * 8) {
          modules[y][x] = bit(stream[index >>> 3], 7 - (index & 7));
          index++;
        }
      }
    }
  }

  // Every mask is tried and the one leaving the fewest confusing patterns
  // (long runs, blocks, finder look-alikes, lopsided balance) is kept.
  const applyMask = (mask) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) if (!fixed[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x];
    }
  };
  let best = 0;
  let lowest = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormat(mask);
    const score = penalty(modules);
    if (score < lowest) { lowest = score; best = mask; }
    applyMask(mask);
  }
  applyMask(best);
  drawFormat(best);

  return { version, level: LEVELS[ecl], mask: best, size, modules };
}

/** How hard a symbol is to read, by the standard's four rules. Lower is better. */
function penalty(modules) {
  const size = modules.length;
  let score = 0;
  const line = (get) => {
    let run = 1;
    let pattern = 0;
    for (let i = 0; i < size; i++) {
      if (i > 0) {
        if (get(i) === get(i - 1)) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score++;
        } else run = 1;
      }
      // Finder look-alikes: dark-light-dark-dark-dark-light-dark with four
      // light modules on either side, tracked as an 11-bit window.
      pattern = ((pattern << 1) | (get(i) ? 1 : 0)) & 0x7ff;
      if (i >= 10 && (pattern === 0b10111010000 || pattern === 0b00001011101)) score += 40;
    }
  };
  for (let y = 0; y < size; y++) line((x) => modules[y][x]);
  for (let x = 0; x < size; x++) line((y) => modules[y][x]);
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) dark++;
      if (x < size - 1 && y < size - 1) {
        const c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
      }
    }
  }
  const total = size * size;
  score += Math.ceil(Math.abs(dark * 20 - total * 10) / total - 1) * 10;
  return score;
}

/** The symbol as rows of '1' (dark) and '0', which crosses IPC compactly. */
function rows(qr) {
  return qr.modules.map((row) => row.map((dark) => (dark ? '1' : '0')).join(''));
}

/**
 * The symbol as a BGRA bitmap, `scale` pixels to a module, with the four
 * module quiet zone scanners need around it.
 */
function bitmap(qr, { scale = 12, border = 4, dark = [17, 17, 20], light = [255, 255, 255] } = {}) {
  const side = (qr.size + border * 2) * scale;
  const buffer = Buffer.alloc(side * side * 4);
  for (let py = 0; py < side; py++) {
    const y = Math.floor(py / scale) - border;
    for (let px = 0; px < side; px++) {
      const x = Math.floor(px / scale) - border;
      const on = y >= 0 && y < qr.size && x >= 0 && x < qr.size && qr.modules[y][x];
      const [r, g, b] = on ? dark : light;
      const at = (py * side + px) * 4;
      buffer[at] = b;
      buffer[at + 1] = g;
      buffer[at + 2] = r;
      buffer[at + 3] = 255;
    }
  }
  return { width: side, height: side, buffer };
}

module.exports = { encode, rows, bitmap, LEVELS };
