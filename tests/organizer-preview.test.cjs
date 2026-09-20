const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Organizer } = require('../src/features/organizer');

/**
 * Selective apply: the preview dialog hands back the groups and tabs the user
 * left ticked, and the engine must treat that as a FILTER over its own plan -
 * never as a plan the renderer is allowed to invent.
 */

/** Minimal stand-in for the tab manager, holding only what the organizer touches. */
function fakeTabs(entries) {
  const tabs = new Map();
  for (const entry of entries) {
    tabs.set(entry.id, {
      id: entry.id,
      url: entry.url,
      title: entry.title,
      groupId: entry.groupId || null,
      workspaceId: 'main',
      pinned: false,
      active: false,
      lastActiveAt: Date.now(),
      state: { displayUrl: entry.url, loading: false },
      view: { webContents: { isDestroyed: () => true } },
    });
  }
  const manager = {
    tabs,
    order: entries.map((entry) => entry.id),
    activeId: null,
    activeWorkspace: 'main',
    onChange() {},
    list() {
      return manager.order
        .map((id) => tabs.get(id))
        .filter(Boolean)
        .map((tab) => ({ ...tab, active: tab.id === manager.activeId }));
    },
  };
  return manager;
}

function fixture(t, entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-organizer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manager = fakeTabs(entries);
  const organizer = new Organizer(dir, {
    getTabs: () => manager,
    resources: { latest: { tabs: [] }, sample() {} },
    ai: null,
  });
  return { organizer, manager };
}

const TABS = [
  { id: 't1', url: 'https://github.com/one', title: 'Repo one' },
  { id: 't2', url: 'https://stackoverflow.com/q/1', title: 'A question' },
  { id: 't3', url: 'https://amazon.in/dp/1', title: 'Headphones' },
  { id: 't4', url: 'https://amazon.in/dp/2', title: 'Keyboard' },
];

test('a plan is produced and every open web tab lands in exactly one group', (t) => {
  const { organizer } = fixture(t, TABS);
  const plan = organizer.localAnalysis();
  const grouped = plan.groups.flatMap((group) => group.ids);
  assert.equal(new Set(grouped).size, grouped.length, 'no tab appears twice');
  assert.deepEqual([...grouped].sort(), ['t1', 't2', 't3', 't4']);
});

test('applying with no selection groups everything in the plan', async (t) => {
  const { organizer, manager } = fixture(t, TABS);
  organizer.localAnalysis();
  await organizer.apply();
  for (const id of ['t1', 't2', 't3', 't4']) {
    assert.ok(manager.tabs.get(id).groupId, id + ' was grouped');
  }
});

test('a selection narrows the apply to the ticked groups only', async (t) => {
  const { organizer, manager } = fixture(t, TABS);
  const plan = organizer.localAnalysis();
  const keep = plan.groups[0];

  await organizer.apply({ groups: [keep.name], ids: keep.ids });

  for (const id of keep.ids) {
    assert.ok(manager.tabs.get(id).groupId, id + ' in the kept group was grouped');
  }
  const others = ['t1', 't2', 't3', 't4'].filter((id) => !keep.ids.includes(id));
  for (const id of others) {
    assert.equal(manager.tabs.get(id).groupId, null, id + ' was left alone');
  }
  assert.equal(organizer.groups.length, 1, 'exactly one group was created');
});

test('unticking individual tabs leaves them ungrouped', async (t) => {
  const { organizer, manager } = fixture(t, TABS);
  const plan = organizer.localAnalysis();
  // Find a group with more than one tab so there is something to untick.
  const group = plan.groups.find((candidate) => candidate.ids.length > 1);
  assert.ok(group, 'fixture produced a multi-tab group');

  const kept = group.ids[0];
  const dropped = group.ids[1];
  await organizer.apply({ groups: [group.name], ids: [kept] });

  assert.ok(manager.tabs.get(kept).groupId, 'the ticked tab was grouped');
  assert.equal(manager.tabs.get(dropped).groupId, null, 'the unticked tab was not');
});

test('a selection naming nothing real is refused rather than silently doing nothing', async (t) => {
  const { organizer } = fixture(t, TABS);
  organizer.localAnalysis();
  // It must REJECT rather than throw synchronously, so every organizer action
  // fails the same way and a caller's .catch() works on all of them.
  await assert.rejects(
    () => organizer.apply({ groups: ['Not a real group'], ids: [] }),
    /Nothing was selected/,
  );
  assert.equal(organizer.groups.length, 0, 'no groups were touched');
});

test('the renderer cannot invent tab ids that were not in the plan', async (t) => {
  const { organizer, manager } = fixture(t, TABS);
  const plan = organizer.localAnalysis();
  const group = plan.groups[0];

  // 'intruder' is not an id the engine ever proposed.
  await organizer.apply({ groups: [group.name], ids: [...group.ids, 'intruder'] });

  assert.equal(manager.tabs.has('intruder'), false, 'no phantom tab was created');
  const total = organizer.groups.reduce(
    (count, created) => count + manager.list().filter((tab) => tab.groupId === created.id).length, 0);
  assert.equal(total, group.ids.length, 'only the planned tabs were grouped');
});

test('undo restores the grouping that existed before a selective apply', async (t) => {
  const { organizer, manager } = fixture(t, TABS);
  const plan = organizer.localAnalysis();
  await organizer.apply({ groups: [plan.groups[0].name], ids: plan.groups[0].ids });
  assert.ok(organizer.groups.length, 'a group exists after apply');

  await organizer.undo();
  for (const id of ['t1', 't2', 't3', 't4']) {
    assert.equal(manager.tabs.get(id).groupId, null, id + ' is ungrouped again');
  }
});

/* ---- malformed input ------------------------------------------------------ */

const { analyze, aiMetadata, signature } = require('../src/features/organizer/classify');

test('analysis never throws on live tab state that is mid-change', () => {
  // A tab closing during analysis leaves a null or half-populated entry.
  const junk = [null, undefined, {}, { url: null }, { url: 'not a url' }, { title: 'no url' }];
  assert.equal(analyze(junk).groups.length, 0);
  assert.equal(aiMetadata(junk).length, 0);
  assert.equal(analyze(null).groups.length, 0);
  assert.equal(analyze(undefined).groups.length, 0);
  assert.equal(signature(null), '[]');
});

test('junk mixed into real tabs does not stop grouping', () => {
  const real = { id: 't1', url: 'https://github.com/a', title: 'Repo', lastActiveAt: Date.now(), memoryMb: 0 };
  const plan = analyze([real, null, { url: null }]);
  assert.equal(plan.groups.length, 1, 'the real tab was still grouped');
  assert.deepEqual(plan.groups[0].ids, ['t1']);
});

test('non-web schemes are never grouped', () => {
  const plan = analyze([
    { id: 'a', url: 'browser://newtab', title: 'New tab', lastActiveAt: 0, memoryMb: 0 },
    { id: 'b', url: 'file:///etc/passwd', title: 'File', lastActiveAt: 0, memoryMb: 0 },
  ]);
  assert.equal(plan.groups.length, 0);
});
