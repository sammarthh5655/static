const test = require('node:test');
const assert = require('node:assert');
const { resolveInput, allowedURL, internalPage, securityState } = require('../src/shared/urls');

// These run in plain Node (no Electron), so shared/urls.js must stay free of
// Electron imports. `npm test` depends on that.

test('treats bare hostnames as URLs', () => {
  assert.strictEqual(resolveInput('example.com'), 'https://example.com/');
  assert.strictEqual(resolveInput('www.example.com/path?q=1'), 'https://www.example.com/path?q=1');
  assert.strictEqual(resolveInput('sub.domain.co.uk'), 'https://sub.domain.co.uk/');
});

test('keeps localhost and loopback on http', () => {
  assert.strictEqual(resolveInput('localhost:3000'), 'http://localhost:3000/');
  assert.strictEqual(resolveInput('127.0.0.1:8080'), 'http://127.0.0.1:8080/');
});

test('falls back to the search engine for prose', () => {
  assert.match(resolveInput('how tall is everest'), /^https:\/\/www\.google\.com\/search\?q=/);
  assert.match(resolveInput('how tall is everest', 'brave'), /^https:\/\/search\.brave\.com\/search\?q=/);
  // A single word with no dot is a search, not a hostname.
  assert.match(resolveInput('electron'), /\/search\?q=electron/);
});

test('encodes the query safely', () => {
  assert.match(resolveInput('a&b=c d'), /q=a%26b%3Dc%20d/);
});

test('empty input opens the new tab page', () => {
  assert.strictEqual(resolveInput(''), 'browser://newtab');
  assert.strictEqual(resolveInput('   '), 'browser://newtab');
});

test('rejects dangerous schemes', () => {
  assert.throws(() => resolveInput('javascript:alert(1)'));
  assert.throws(() => resolveInput('file:///etc/passwd'));
  assert.strictEqual(allowedURL('javascript:alert(1)'), false);
  assert.strictEqual(allowedURL('file:///etc/passwd'), false);
});

test('allows extension and internal URLs', () => {
  assert.strictEqual(allowedURL('chrome-extension://' + 'a'.repeat(32) + '/popup.html'), true);
  assert.strictEqual(allowedURL('browser://settings'), true);
  assert.strictEqual(allowedURL('browser://evil'), false);
  assert.strictEqual(internalPage('browser://history'), 'history');
  assert.strictEqual(internalPage('https://example.com'), null);
});

test('reports the security state of a URL', () => {
  assert.strictEqual(securityState('https://example.com'), 'secure');
  assert.strictEqual(securityState('http://example.com'), 'insecure');
  assert.strictEqual(securityState('browser://newtab'), 'internal');
  assert.strictEqual(securityState('https://example.com', 'ERR_FAILED'), 'error');
});
