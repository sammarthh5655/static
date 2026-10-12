const test = require('node:test');
const assert = require('node:assert/strict');
const { matchAccelerator, isMac, forPlatform } = require('../src/main/shortcuts');

const PLATFORMS = ['win32', 'darwin', 'linux'];

for (const platform of PLATFORMS) {
  test(platform + ': no two actions share a key combination', () => {
    const { ACCELERATORS } = forPlatform(platform);
    const mac = platform === 'darwin';
    const seen = new Map();
    for (const a of ACCELERATORS) {
      const m = a.match;
      // Outside macOS, Ctrl and the "mod" key are the same physical key.
      const mods = mac ? [!!m.mod, !!m.ctrl] : [!!(m.mod || m.ctrl)];
      const key = JSON.stringify([m.key.toLowerCase(), ...mods, !!m.shift, !!m.alt]);
      if (seen.has(key)) assert.equal(seen.get(key), a.id, 'clash on ' + key);
      seen.set(key, a.id);
    }
  });

  test(platform + ': Ctrl+Tab and Ctrl+Shift+Tab switch tabs, as in Chrome', () => {
    const { matchAccelerator: match, ACCEL } = forPlatform(platform);
    const press = (key, extra) => match({ type: 'keyDown', key, control: false, meta: false, shift: false, alt: false, ...extra });
    assert.equal(press('Tab', { control: true }), 'tab:next');
    assert.equal(press('Tab', { control: true, shift: true }), 'tab:previous');
    assert.equal(ACCEL.get('tab:next').display, 'Ctrl+Tab');
    assert.equal(ACCEL.get('tab:previous').display, 'Ctrl+Shift+Tab');
    // A bare Tab is the page's, always.
    assert.equal(press('Tab', {}), null);
  });
}

test('macOS: Cmd is the shortcut key and Control is a different one', () => {
  const { matchAccelerator: match, ACCEL } = forPlatform('darwin');
  const press = (key, extra) => match({ type: 'keyDown', key, control: false, meta: false, shift: false, alt: false, ...extra });
  assert.equal(press('t', { meta: true }), 'tab:new');
  assert.equal(press('w', { meta: true }), 'tab:close');
  // Control+T is not Cmd+T on a Mac: it must not open a tab.
  assert.equal(press('t', { control: true }), null);
  // Holding both is neither.
  assert.equal(press('t', { meta: true, control: true }), null);
  assert.equal(press('Tab', { meta: true, control: true }), null);
  // Option+Tab used to be next tab on the Mac; it is a plain key again.
  assert.equal(press('Tab', { alt: true }), null);
  // Chrome's other Mac pair.
  assert.equal(press('ArrowRight', { meta: true, alt: true }), 'tab:next');
  assert.equal(press('ArrowLeft', { meta: true, alt: true }), 'tab:previous');
  assert.equal(ACCEL.get('tab:new').display, 'Cmd+T');
});

test('Windows and Linux: the Windows/Super key is never part of a shortcut', () => {
  for (const platform of ['win32', 'linux']) {
    const { matchAccelerator: match } = forPlatform(platform);
    assert.equal(match({ type: 'keyDown', key: 't', control: true, meta: true, shift: false, alt: false }), null);
    assert.equal(match({ type: 'keyDown', key: 't', control: true, meta: false, shift: false, alt: false }), 'tab:new');
  }
});

test('anything that is not a keyDown with a key is ignored', () => {
  assert.equal(matchAccelerator(null), null);
  assert.equal(matchAccelerator({ type: 'keyUp', key: 't', control: true, meta: true }), null);
  assert.equal(matchAccelerator({ type: 'keyDown', control: true }), null);
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
  assert.equal(press('n'), 'window:new');
  assert.equal(press('n', { shift: true }), 'window:incognito');
  assert.equal(press('i', { shift: true }), 'window:incognito');
  assert.equal(press('t', { shift: true }), 'tab:reopen');
});
