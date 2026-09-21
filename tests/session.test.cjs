const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Settings } = require('../src/features/settings');
const os = require('node:os');

/** Reopening the tabs you had open is a preference, and it must be honoured. */

test('restoring tabs is the default, and the other choices are accepted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-session-'));
  try {
    const settings = new Settings(dir);
    assert.equal(settings.value.onStartup, 'restore', 'a new profile restores its tabs');
    for (const mode of ['newtab', 'homepage', 'restore']) {
      settings.update({ onStartup: mode });
      assert.equal(settings.value.onStartup, mode);
    }
    // An invalid mode must be refused rather than silently stored.
    assert.throws(() => settings.update({ onStartup: 'whatever' }), /Invalid setting/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the wallpaper background is a real, validated choice', () => {
  const { BACKGROUNDS } = require('../src/shared/widgets');
  assert.ok(BACKGROUNDS.photo, 'a photo background exists');
  assert.equal(BACKGROUNDS.photo.takesFile, true, 'and it is chosen from a file');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-session-'));
  try {
    const settings = new Settings(dir);
    settings.update({ newTab: { background: 'photo', backgroundValue: 'file:///x/y.png' } });
    assert.equal(settings.value.newTab.background, 'photo');
    assert.equal(settings.value.newTab.backgroundValue, 'file:///x/y.png');
    // An unknown background falls back rather than being written through.
    settings.update({ newTab: { background: 'not-a-background' } });
    assert.notEqual(settings.value.newTab.background, 'not-a-background');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
