const test = require('node:test');
const assert = require('node:assert/strict');
const qr = require('../src/features/pagetools/qr');
const { decode, sample } = require('./qr.decoder.cjs');

/**
 * The QR codes Static draws for "QR code for this page", read back by an
 * independent, strict decoder: right format information, every block passing
 * its error correction check, and the exact text out again.
 */

test('a typical address encodes and reads back exactly', () => {
  const url = 'https://en.wikipedia.org/wiki/QR_code#Error_correction';
  const symbol = qr.encode(url);
  const read = decode(symbol.modules);
  assert.equal(read.text, url);
  assert.equal(read.version, symbol.version);
  assert.equal(read.level, symbol.level);
  assert.equal(read.mask, symbol.mask);
});

test('every size from a few letters to a very long address', () => {
  const versions = new Set();
  for (let n = 1; n < 2200; n = Math.ceil(n * 1.2) + 2) {
    const text = 'https://static.example/' + 'abcdefghijklmnopqrstuvwxyz0123456789-_~'.repeat(60).slice(0, n);
    const symbol = qr.encode(text);
    versions.add(symbol.version);
    assert.equal(decode(symbol.modules).text, text, 'length ' + text.length);
  }
  // Small symbols, the multi-block ones and those with version information.
  assert.ok([...versions].some((v) => v <= 3) && [...versions].some((v) => v >= 7) && [...versions].some((v) => v >= 20),
    [...versions].join(','));
});

test('any text, not only ASCII', () => {
  for (const text of ['héllo wörld', '日本語のページ', 'emoji 🎉 too', '']) {
    assert.equal(decode(qr.encode(text).modules).text, text);
  }
});

test('the level steps up when it costs nothing', () => {
  const short = qr.encode('https://a');
  assert.equal(short.version, 1);
  assert.ok(['Q', 'H'].includes(short.level), short.level);
  for (const level of qr.LEVELS) assert.equal(decode(qr.encode('level ' + level, { level }).modules).text, 'level ' + level);
});

test('too much text says so rather than drawing nonsense', () => {
  assert.throws(() => qr.encode('x'.repeat(3000)), /too long/);
});

test('the picture for Copy and Save reads back too, quiet zone and all', () => {
  const url = 'https://static.example/page?with=query&and=more#fragment';
  const symbol = qr.encode(url);
  const picture = qr.bitmap(symbol, { scale: 6, border: 4 });
  assert.equal(picture.width, (symbol.size + 8) * 6);
  assert.equal(picture.buffer.length, picture.width * picture.height * 4);
  // The quiet zone is light all the way round.
  for (const [x, y] of [[0, 0], [picture.width - 1, 0], [0, picture.height - 1], [23, 23]]) {
    assert.equal(picture.buffer[(y * picture.width + x) * 4], 255);
  }
  const modules = sample(picture.buffer, picture.width, { left: 24, top: 24, side: symbol.size * 6, count: symbol.size });
  assert.equal(decode(modules).text, url);
  assert.deepEqual(qr.rows(symbol)[0].slice(0, 7), '1111111');
});
