'use strict';

/**
 * Apple's binary property list ("bplist00"), read into plain JavaScript.
 *
 * Safari keeps its bookmarks in one (~/Library/Safari/Bookmarks.plist). There
 * is no plist reader in Node or Electron, and a dependency for one file format
 * is more to trust than this: the format is small and fully documented in
 * Apple's open-source CFBinaryPList.c.
 *
 *   header  "bplist00"
 *   objects  each starts with a marker byte: type in the high nibble, a
 *            size or count in the low one (0xF = the count follows as an int)
 *   offsets  where each object starts
 *   trailer  the last 32 bytes: offset and reference widths, object count,
 *            the top object, and where the offset table is
 *
 * The file comes from outside, so it is read defensively: every offset is
 * bounds-checked, nesting is capped (references can point back up and form a
 * loop), and sizes are capped. Anything malformed is an Error, never a hang
 * or a crash. Pure Node, unit tested in tests/plist.test.cjs.
 */

const MAX_DEPTH = 64;
const MAX_OBJECTS = 2_000_000;
const MAX_ITEMS = 1_000_000;
// Seconds between 1970-01-01 and Apple's epoch, 2001-01-01.
const APPLE_EPOCH = 978307200;

class PlistError extends Error {
  constructor(message) { super(message); this.name = 'PlistError'; }
}

function parseBplist(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 40 || buffer.toString('latin1', 0, 8) !== 'bplist00') {
    throw new PlistError('Not a binary property list.');
  }
  const trailer = buffer.length - 32;
  const offsetSize = buffer.readUInt8(trailer + 6);
  const refSize = buffer.readUInt8(trailer + 7);
  const count = toNumber(buffer.readBigUInt64BE(trailer + 8));
  const top = toNumber(buffer.readBigUInt64BE(trailer + 16));
  const tableAt = toNumber(buffer.readBigUInt64BE(trailer + 24));
  if (![1, 2, 4, 8].includes(offsetSize) || ![1, 2, 4, 8].includes(refSize)) throw new PlistError('The property list is damaged.');
  if (count < 1 || count > MAX_OBJECTS || top >= count || tableAt < 8 || tableAt + count * offsetSize > trailer) {
    throw new PlistError('The property list is damaged.');
  }

  const uint = (at, size) => {
    if (at < 0 || at + size > trailer) throw new PlistError('The property list is damaged.');
    if (size === 8) return toNumber(buffer.readBigUInt64BE(at));
    return buffer.readUIntBE(at, size);
  };
  const offsetOf = (ref) => {
    if (ref >= count) throw new PlistError('The property list is damaged.');
    const at = uint(tableAt + ref * offsetSize, offsetSize);
    if (at < 8 || at >= tableAt) throw new PlistError('The property list is damaged.');
    return at;
  };

  /** The count after a marker whose low nibble is 0xF: an int object. */
  const length = (at, info) => {
    if (info !== 0xF) return { value: info, next: at + 1 };
    const marker = buffer[at + 1];
    if (marker >> 4 !== 0x1) throw new PlistError('The property list is damaged.');
    const size = 1 << (marker & 0xF);
    if (size > 8) throw new PlistError('The property list is damaged.');
    return { value: uint(at + 2, size), next: at + 2 + size };
  };

  const read = (ref, depth) => {
    if (depth > MAX_DEPTH) throw new PlistError('The property list nests too deeply.');
    const at = offsetOf(ref);
    const marker = buffer[at];
    const type = marker >> 4;
    const info = marker & 0xF;
    switch (type) {
      case 0x0:
        if (info === 0x0) return null;
        if (info === 0x8) return false;
        if (info === 0x9) return true;
        throw new PlistError('The property list is damaged.');
      case 0x1: { // integer, 2^info bytes; 8 bytes are signed
        const size = 1 << info;
        if (size > 8 || at + 1 + size > trailer) throw new PlistError('The property list is damaged.');
        if (size === 8) return toNumber(buffer.readBigInt64BE(at + 1));
        return buffer.readUIntBE(at + 1, size);
      }
      case 0x2: { // real
        if (info === 2 && at + 5 <= trailer) return buffer.readFloatBE(at + 1);
        if (info === 3 && at + 9 <= trailer) return buffer.readDoubleBE(at + 1);
        throw new PlistError('The property list is damaged.');
      }
      case 0x3: // date: seconds since 2001-01-01, as a double
        if (info !== 3 || at + 9 > trailer) throw new PlistError('The property list is damaged.');
        return new Date((buffer.readDoubleBE(at + 1) + APPLE_EPOCH) * 1000);
      case 0x4: { // data
        const { value, next } = length(at, info);
        if (next + value > trailer) throw new PlistError('The property list is damaged.');
        return Buffer.from(buffer.subarray(next, next + value));
      }
      case 0x5: { // ASCII string
        const { value, next } = length(at, info);
        if (next + value > trailer) throw new PlistError('The property list is damaged.');
        return buffer.toString('latin1', next, next + value);
      }
      case 0x6: { // UTF-16 big-endian string; the count is in 16-bit units
        const { value, next } = length(at, info);
        if (next + value * 2 > trailer) throw new PlistError('The property list is damaged.');
        const units = Buffer.from(buffer.subarray(next, next + value * 2));
        units.swap16();
        return units.toString('utf16le');
      }
      case 0x8: // UID (NSKeyedArchiver); kept as a number
        if (info > 5 || at + 2 + info > trailer) throw new PlistError('The property list is damaged.');
        return { uid: buffer.readUIntBE(at + 1, info + 1) };
      case 0xA: // array
      case 0xC: { // set
        const { value, next } = length(at, info);
        if (value > MAX_ITEMS || next + value * refSize > trailer) throw new PlistError('The property list is damaged.');
        const out = [];
        for (let i = 0; i < value; i++) out.push(read(uint(next + i * refSize, refSize), depth + 1));
        return out;
      }
      case 0xD: { // dictionary: every key reference, then every value reference
        const { value, next } = length(at, info);
        if (value > MAX_ITEMS || next + value * 2 * refSize > trailer) throw new PlistError('The property list is damaged.');
        const out = {};
        for (let i = 0; i < value; i++) {
          const key = read(uint(next + i * refSize, refSize), depth + 1);
          if (typeof key !== 'string') throw new PlistError('The property list is damaged.');
          // Never let a file name a key that changes what an object is.
          if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
          out[key] = read(uint(next + (value + i) * refSize, refSize), depth + 1);
        }
        return out;
      }
      default:
        throw new PlistError('The property list uses a type this reader does not know.');
    }
  };

  return read(top, 0);
}

function toNumber(big) {
  if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < BigInt(Number.MIN_SAFE_INTEGER)) throw new PlistError('The property list is damaged.');
  return Number(big);
}

module.exports = { parseBplist, PlistError, APPLE_EPOCH };
