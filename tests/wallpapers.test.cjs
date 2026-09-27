const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const wallpapers = require('../src/features/wallpapers');
const { Settings } = require('../src/features/settings');

test('the built-in set is there, categorised and credited', () => {
  const { categories, wallpapers: list } = wallpapers.catalog();
  assert.ok(list.length >= 40, 'at least forty wallpapers');
  assert.deepEqual(categories.map((c) => c.id).sort(), ['cityscapes', 'colours', 'landscapes', 'patterns', 'space']);
  for (const w of list) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'src', 'renderer', 'assets', w.file)), w.file);
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'src', 'renderer', 'assets', w.thumb)), w.thumb);
    assert.notEqual(w.credit.by, 'Unknown', w.id + ' is credited');
    assert.match(w.tone, /^#[0-9a-f]{6}$/);
  }
});

test('a random pick never repeats the one on screen when there is a choice', () => {
  const first = wallpapers.pick('space', [], '');
  for (let i = 0; i < 50; i++) assert.notEqual(wallpapers.pick('space', [], first.id).id, first.id);
});

test('random from favourites uses only favourites, or everything if there are none', () => {
  const [a, b] = wallpapers.catalog().wallpapers;
  for (let i = 0; i < 20; i++) assert.ok([a.id, b.id].includes(wallpapers.pick('favourites', [a.id, b.id], '').id));
  assert.equal(wallpapers.poolOf('favourites', []).length, wallpapers.catalog().wallpapers.length);
});

test('settings keep only real wallpapers, known widgets and positions on the page', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-wp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settings = new Settings(dir);
  const real = wallpapers.catalog().wallpapers[0].id;
  const next = settings.update({ newTab: {
    wallpaperMode: 'launch', wallpaperPool: 'space',
    wallpaperFavourites: [real, 'not-a-wallpaper', real],
    positions: { clock: { x: 1.7, y: -3 }, bogus: { x: 0.5, y: 0.5 }, notes: { x: 'a', y: 1 } },
  } }).newTab;
  assert.equal(next.wallpaperMode, 'launch');
  assert.equal(next.wallpaperPool, 'space');
  assert.deepEqual(next.wallpaperFavourites, [real]);
  assert.deepEqual(next.positions, { clock: { x: 1, y: 0 } });
  assert.equal(settings.update({ newTab: { wallpaperMode: 'sometimes', wallpaperPool: 'mars' } }).newTab.wallpaperMode, 'fixed');
  assert.equal(settings.value.newTab.wallpaperPool, 'all');
});
