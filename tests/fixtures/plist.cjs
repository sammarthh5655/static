/**
 * Writes binary property lists ("bplist00") for tests: the format Safari
 * keeps its bookmarks in. Not a probe and not a unit test.
 *
 * Supports what Safari's Bookmarks.plist uses - dictionaries, arrays,
 * strings (ASCII and UTF-16), integers, booleans, dates and data - plus
 * `raw` hooks the tests use to build damaged files.
 */

function encode(value, { refSize = 2, offsetSize = 4 } = {}) {
  const objects = [];
  const add = (v) => {
    const index = objects.length;
    objects.push(null);
    if (Array.isArray(v)) {
      const refs = v.map(add);
      objects[index] = { kind: 'array', refs };
    } else if (v && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) {
      const keys = Object.keys(v);
      const keyRefs = keys.map(add);
      const valueRefs = keys.map((k) => add(v[k]));
      objects[index] = { kind: 'dict', keyRefs, valueRefs };
    } else {
      objects[index] = { kind: 'scalar', v };
    }
    return index;
  };
  add(value);

  const uintBytes = (n, size) => { const b = Buffer.alloc(size); if (size === 8) b.writeBigUInt64BE(BigInt(n)); else b.writeUIntBE(n, 0, size); return b; };
  const ref = (n) => uintBytes(n, refSize);
  const count = (type, n) => {
    if (n < 15) return Buffer.from([(type << 4) | n]);
    return Buffer.concat([Buffer.from([(type << 4) | 0xF, 0x12]), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; })()]);
  };
  const body = (o) => {
    if (o.kind === 'array') return Buffer.concat([count(0xA, o.refs.length), ...o.refs.map(ref)]);
    if (o.kind === 'dict') return Buffer.concat([count(0xD, o.keyRefs.length), ...o.keyRefs.map(ref), ...o.valueRefs.map(ref)]);
    const v = o.v;
    if (v === null || v === undefined) return Buffer.from([0x00]);
    if (v === false) return Buffer.from([0x08]);
    if (v === true) return Buffer.from([0x09]);
    if (v instanceof Date) { const b = Buffer.alloc(9); b[0] = 0x33; b.writeDoubleBE(v.getTime() / 1000 - 978307200, 1); return b; }
    if (Buffer.isBuffer(v)) return Buffer.concat([count(0x4, v.length), v]);
    if (typeof v === 'number' && Number.isInteger(v)) { const b = Buffer.alloc(9); b[0] = 0x13; b.writeBigInt64BE(BigInt(v), 1); return b; }
    if (typeof v === 'number') { const b = Buffer.alloc(9); b[0] = 0x23; b.writeDoubleBE(v, 1); return b; }
    const s = String(v);
    if (/^[\x00-\x7f]*$/.test(s)) return Buffer.concat([count(0x5, s.length), Buffer.from(s, 'latin1')]);
    const units = Buffer.from(s, 'utf16le');
    units.swap16();
    return Buffer.concat([count(0x6, units.length / 2), units]);
  };

  const chunks = [Buffer.from('bplist00', 'latin1')];
  const offsets = [];
  let at = 8;
  for (const o of objects) {
    const b = body(o);
    offsets.push(at);
    chunks.push(b);
    at += b.length;
  }
  const tableAt = at;
  for (const off of offsets) chunks.push(uintBytes(off, offsetSize));
  const trailer = Buffer.alloc(32);
  trailer[6] = offsetSize;
  trailer[7] = refSize;
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(tableAt), 24);
  chunks.push(trailer);
  return Buffer.concat(chunks);
}

/** A Safari-shaped Bookmarks.plist: Favorites, the menu, Reading List. */
function safariBookmarks() {
  const leaf = (title, url) => ({ WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: url, URIDictionary: { title }, WebBookmarkUUID: 'U-' + title });
  const list = (Title, Children, extra = {}) => ({ WebBookmarkType: 'WebBookmarkTypeList', Title, Children, ...extra });
  return {
    WebBookmarkFileVersion: 1,
    WebBookmarkType: 'WebBookmarkTypeList',
    Title: '',
    Children: [
      { WebBookmarkType: 'WebBookmarkTypeProxy', Title: 'History', WebBookmarkIdentifier: 'History' },
      list('BookmarksBar', [leaf('Apple', 'https://www.apple.com/'), list('Work', [leaf('Docs', 'https://docs.example/'), leaf('Ünïcödé café', 'https://café.example/')])]),
      list('BookmarksMenu', [leaf('News', 'https://news.example/'), leaf('Bad', 'javascript:alert(1)')]),
      list('com.apple.ReadingList', [leaf('Long read', 'https://read.example/article')], { ShouldOmitFromUI: true }),
    ],
  };
}

module.exports = { encode, safariBookmarks };
