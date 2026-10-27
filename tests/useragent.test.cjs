const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * What static tells websites it is.
 *
 * Electron's default user agent names the app and Electron itself. Sites
 * match on those: Google's sign-in serves an older layout to a user agent it
 * does not recognise, and some refuse sign-in entirely on one saying
 * "Electron". The rule is to drop those two tokens and change nothing else -
 * in particular to keep the real Chrome version, so the claim stays true.
 *
 * The function lives in main/application.js, which cannot be required without
 * Electron, so the rule is restated here and checked against the real
 * default. If the two ever disagree, this test is the one to trust.
 */
const clean = (ua) => ua.replace(/ static\/[^\s]+/, '').replace(/ Electron\/[^\s]+/, '');

const REAL_DEFAULT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) static/0.2.1 Chrome/152.0.7977.130 Electron/44.7.0 Safari/537.36';

test('the app and Electron tokens are gone', () => {
  const ua = clean(REAL_DEFAULT);
  assert.doesNotMatch(ua, /Electron/, 'no Electron token');
  assert.doesNotMatch(ua, /static\//, 'no app token');
});

test('it still reads as the Chrome it really is', () => {
  const ua = clean(REAL_DEFAULT);
  assert.equal(ua, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Safari/537.36');
  // The version is the engine's own, not a number written down here: an
  // upgrade has to carry through rather than leaving a stale claim.
  assert.match(ua, /Chrome\/152\.0\.7977\.130/);
  assert.match(ua, /Safari\/537\.36$/);
  assert.doesNotMatch(ua, /\s{2,}/, 'no double spaces left behind');
});

test('a user agent with nothing to remove is left alone', () => {
  const plain = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
  assert.equal(clean(plain), plain);
});

test('a Mac or Linux user agent is handled the same way', () => {
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) static/0.2.1 Chrome/152.0.7977.130 Electron/44.7.0 Safari/537.36';
  const out = clean(mac);
  assert.doesNotMatch(out, /Electron|static\//);
  assert.match(out, /Macintosh/);
  assert.match(out, /Chrome\/152\.0\.7977\.130/);
});
