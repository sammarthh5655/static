const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBplist } = require('../src/features/importer/plist');
const { encode, safariBookmarks } = require('./fixtures/plist.cjs');

test('a binary property list reads back exactly', () => {
  const value = {
    name: 'static', count: 42, big: 9007199254740991, negative: -5, ratio: 0.25,
    yes: true, no: false, nothing: null, when: new Date(Date.UTC(2026, 9, 25, 12, 0, 0)),
    data: Buffer.from([1, 2, 3]), list: ['a', 'b', ['nested']], unicode: 'Ünïcödé — 日本',
  };
  const back = parseBplist(encode(value));
  assert.deepEqual({ ...back, when: back.when.getTime(), data: [...back.data] },
    { ...value, when: value.when.getTime(), data: [1, 2, 3] });
});

test('long strings and arrays use the extended length form', () => {
  const long = 'x'.repeat(300);
  const many = Array.from({ length: 40 }, (_, i) => i);
  const back = parseBplist(encode({ long, many }));
  assert.equal(back.long, long);
  assert.deepEqual(back.many, many);
});

test('one-byte and eight-byte references both work', () => {
  for (const refSize of [1, 2, 4, 8]) {
    assert.deepEqual(parseBplist(encode({ a: [1, 2] }, { refSize, offsetSize: refSize === 1 ? 2 : refSize })), { a: [1, 2] });
  }
});

test('Safari\'s bookmarks structure parses', () => {
  const back = parseBplist(encode(safariBookmarks()));
  assert.equal(back.Children[1].Title, 'BookmarksBar');
  assert.equal(back.Children[1].Children[1].Children[1].URIDictionary.title, 'Ünïcödé café');
});

test('anything that is not a binary plist is refused', () => {
  assert.throws(() => parseBplist(Buffer.from('<?xml version="1.0"?><plist></plist>'.padEnd(64))), /Not a binary/);
  assert.throws(() => parseBplist(Buffer.alloc(10)), /Not a binary/);
  assert.throws(() => parseBplist('bplist00'), /Not a binary/);
});

test('damaged files are errors, never crashes or hangs', () => {
  const good = encode(safariBookmarks());
  // Every single-byte corruption of the trailer and offset table.
  for (let i = good.length - 64; i < good.length; i++) {
    for (const value of [0x00, 0xff, 0x7f]) {
      const bad = Buffer.from(good);
      bad[i] = value;
      try { parseBplist(bad); } catch (error) { assert.ok(error instanceof Error); }
    }
  }
  // Cut short anywhere.
  for (const cut of [9, 40, 100, good.length - 1]) {
    assert.throws(() => parseBplist(good.subarray(0, cut)));
  }
});

test('an array that contains itself is refused, not followed forever', () => {
  // Hand-made: one array object whose single reference points back to itself.
  const header = Buffer.from('bplist00', 'latin1');
  const array = Buffer.from([0xA1, 0x00]);
  const table = Buffer.from([0x08]);
  const trailer = Buffer.alloc(32);
  trailer[6] = 1; trailer[7] = 1;
  trailer.writeBigUInt64BE(1n, 8); trailer.writeBigUInt64BE(0n, 16); trailer.writeBigUInt64BE(10n, 24);
  assert.throws(() => parseBplist(Buffer.concat([header, array, table, trailer])), /nests too deeply/);
});

test('a key cannot reach the object prototype', () => {
  // JSON.parse makes "__proto__" a real key, as a hostile file would.
  const back = parseBplist(encode(JSON.parse('{"__proto__": {"polluted": true}, "constructor": "y", "safe": 1}')));
  assert.equal(({}).polluted, undefined);
  assert.equal(back.polluted, undefined);
  assert.equal(Object.getPrototypeOf(back), Object.prototype);
  assert.equal(back.safe, 1);
});
