const test = require('node:test');
const assert = require('node:assert/strict');
const { ACCELERATORS, matchAccelerator, isMac } = require('../src/main/shortcuts');

test('no two actions share a key combination', () => {
  const seen = new Map();
  for (const a of ACCELERATORS) {
    const key = JSON.stringify([a.match.key.toLowerCase(), !!a.match.mod, !!a.match.shift, !!a.match.alt]);
    if (seen.has(key)) assert.equal(seen.get(key), a.id, 'clash on ' + key);
    seen.set(key, a.id);
  }
});

test('the keys every browser shares do what people expect', () => {
  const press = (key, extra = {}) => matchAccelerator({
    type: 'keyDown', key, control: !isMac, meta: isMac, shift: false, alt: false, ...extra,
  });
  assert.equal(press('j'), 'open:downloads');
  assert.equal(press('f'), 'find:open');
  assert.equal(press('p'), 'page:print');
  assert.equal(press('s'), 'page:save');
  assert.equal(press('u'), 'page:source');
  assert.equal(press('0'), 'page:zoom-reset');
  assert.equal(press('='), 'page:zoom-in');
  assert.equal(press('-'), 'page:zoom-out');
  assert.equal(press('1'), 'tab:1');
  assert.equal(press('9'), 'tab:9');
  assert.equal(press('n', { shift: true }), 'window:incognito');
  assert.equal(press('t', { shift: true }), 'tab:reopen');
});
