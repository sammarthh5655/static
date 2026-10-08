const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tidyOrder } = require('../src/features/tabs/order');
const { Organizer } = require('../src/features/organizer');
const { COLORS, GROUP_COLORS } = require('../src/features/organizer/classify');

/** Pinned tabs first, groups together, everything else where it was. */

const tabs = (spec) => new Map(Object.entries(spec).map(([id, t]) => [id, { id, pinned: false, groupId: null, ...t }]));

test('pinned tabs come first, in their own order', () => {
  const all = tabs({ a: {}, b: { pinned: true }, c: {}, d: { pinned: true } });
  assert.deepEqual(tidyOrder(['a', 'b', 'c', 'd'], (id) => all.get(id)), ['b', 'd', 'a', 'c']);
});

test('a group gathers where its first tab is, and nothing else moves', () => {
  const all = tabs({ a: {}, b: { groupId: 'g' }, c: {}, d: { groupId: 'g' }, e: {} });
  assert.deepEqual(tidyOrder(['a', 'b', 'c', 'd', 'e'], (id) => all.get(id)), ['a', 'b', 'd', 'c', 'e']);
  // Already tidy: unchanged.
  assert.deepEqual(tidyOrder(['a', 'b', 'd', 'c', 'e'], (id) => all.get(id)), ['a', 'b', 'd', 'c', 'e']);
  // Closed tabs drop out.
  assert.deepEqual(tidyOrder(['a', 'gone', 'e'], (id) => all.get(id)), ['a', 'e']);
});

test('nine group colours, all different, named', () => {
  assert.equal(GROUP_COLORS.length, 9);
  assert.equal(new Set(COLORS).size, 9);
  assert.ok(GROUP_COLORS.every((c) => /^#[0-9a-f]{6}$/.test(c.value) && c.name));
});

function fixture(t, ids) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-taborder-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const map = new Map(ids.map((id) => [id, { id, url: 'https://example.com/' + id, title: id, pinned: false, groupId: null,
    workspaceId: 'main', lastActiveAt: Date.now(), state: { displayUrl: 'https://example.com/' + id }, view: { webContents: { isDestroyed: () => true } } }]));
  const manager = { tabs: map, order: [...ids], activeId: ids[0], activeWorkspace: 'main', onChange() {},
    list: () => manager.order.map((id) => map.get(id)).filter(Boolean) };
  const organizer = new Organizer(dir, { getTabs: () => manager, resources: { latest: { tabs: [] }, sample() {} }, ai: null });
  return { organizer, manager };
}

test('pinning puts a tab at the end of the pinned row and out of its group', async (t) => {
  const { organizer, manager } = fixture(t, ['a', 'b', 'c', 'd']);
  await organizer.assign({ ids: ['c'], groupId: 'new', name: 'Work' });
  await organizer.pin(['c'], true);
  await organizer.pin(['a'], true);
  assert.deepEqual(manager.order.slice(0, 2), ['c', 'a']);
  assert.equal(manager.tabs.get('c').groupId, null);
  assert.equal(organizer.groups.length, 0, 'the emptied group goes');
  await organizer.pin(['c'], false);
  assert.deepEqual(manager.order, ['a', 'c', 'b', 'd'], 'unpinned: straight after the pinned row');
});

test('a new group stays where its tab was, and takes the next free colour', async (t) => {
  const { organizer, manager } = fixture(t, ['a', 'b', 'c', 'd']);
  await organizer.assign({ ids: ['b'], groupId: 'new', value: 'First' });
  await organizer.assign({ ids: ['c'], groupId: 'new', value: 'Second' });
  assert.deepEqual(manager.order, ['a', 'b', 'c', 'd']);
  assert.deepEqual(organizer.groups.map((g) => g.color), [COLORS[0], COLORS[1]]);
  // Joining a group: behind its last tab.
  await organizer.assign({ ids: ['d'], groupId: organizer.groups[0].id });
  assert.deepEqual(manager.order, ['a', 'b', 'd', 'c']);
  await assert.rejects(async () => organizer.assign({ ids: ['a'], groupId: 'new', value: '   ' }), /Enter a name/);
});

test('a damaged session cannot put a bad colour or name on the strip', (t) => {
  const { organizer } = fixture(t, ['a']);
  const ids = organizer.restore([
    { id: 'x', name: 'Fine', color: '#7aa7f7', workspaceId: 'nowhere', collapsed: true },
    { id: 'y', name: '', color: '#7aa7f7' },
    { id: 'z', name: 'Odd colour', color: 'red; background: url(x)' },
    null, 'junk',
  ]);
  assert.deepEqual([...ids.keys()], ['x', 'z']);
  const [fine, odd] = organizer.groups;
  assert.equal(fine.workspaceId, 'main');
  assert.equal(fine.collapsed, true);
  assert.match(odd.color, /^#[0-9a-f]{6}$/);
});

test('a group whose last tab closed gives back its colour and its name', async (t) => {
  const { organizer, manager } = fixture(t, ['a', 'b', 'c']);
  await organizer.assign({ ids: ['b'], groupId: 'new', value: 'Reading' });
  // Closed with its X: the tab goes, the group's record stays (for reopening).
  manager.tabs.delete('b'); manager.order = manager.order.filter((id) => id !== 'b');
  assert.equal(organizer.groups.length, 1);
  await organizer.assign({ ids: ['c'], groupId: 'new', value: 'Other' });
  assert.equal(organizer.groups.find((g) => g.name === 'Other').color, COLORS[0]);
  assert.equal(organizer.suggestion(['a']).name.endsWith(' 2'), false);
});
