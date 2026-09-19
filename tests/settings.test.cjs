const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Settings, DEFAULTS } = require('../src/features/settings');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, settings: new Settings(dir) };
}
test('sidebar preference validates, persists and repairs stale values', t => {
  const { dir, settings } = setup(t);
  settings.update({ sidebarMode: 'autohide' });
  assert.equal(new Settings(dir).value.sidebarMode, 'autohide');
  assert.throws(() => settings.update({ sidebarMode: 'script' }));
  settings.store.save({ ...settings.value, sidebarMode: 'broken' });
  assert.equal(new Settings(dir).value.sidebarMode, 'on');
});
test('appearance reset keeps browsing preferences and rejects unknown scopes', t => {
  const { settings } = setup(t);
  settings.update({ theme: 'light', fontSize: 20, sidebarMode: 'off', homepage: 'https://example.com', bookmarksBar: false });
  assert.throws(() => settings.reset('everything-on-disk'));
  settings.reset('appearance');
  assert.equal(settings.value.theme, DEFAULTS.theme);
  assert.equal(settings.value.fontSize, DEFAULTS.fontSize);
  assert.equal(settings.value.sidebarMode, 'on');
  assert.equal(settings.value.homepage, 'https://example.com/');
  assert.equal(settings.value.bookmarksBar, false);
});
test('full preferences reset keeps other local feature files', t => {
  const { dir, settings } = setup(t);
  const sentinel = path.join(dir, 'notes.json');
  fs.writeFileSync(sentinel, 'Keep my research');
  settings.update({ searchEngine: 'brave', newTab: { widgets: [] } });
  settings.reset('all');
  assert.deepEqual(new Settings(dir).value, DEFAULTS);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'Keep my research');
});
