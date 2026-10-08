const test = require('node:test');
const assert = require('node:assert/strict');
const { searchTabs, matchWord, runs, siteOf } = require('../src/shared/tabsearch');

// Plain Node, no Electron: the same ranking the tab search list uses.

const TABS = [
  { id: 'mail', title: 'Inbox (3) - sam@example.com - Gmail', url: 'https://mail.google.com/mail/u/0/#inbox' },
  { id: 'bbc', title: 'Home - BBC News', url: 'https://www.bbc.co.uk/news' },
  { id: 'doc', title: 'Quarterly plan', url: 'https://docs.google.com/document/d/abc/edit' },
  { id: 'yt', title: 'Lo-fi beats to study to - YouTube', url: 'https://www.youtube.com/watch?v=jfKfPfyJRdk' },
  { id: 'set', title: 'Settings', url: 'browser://settings' },
];
const ids = (query) => searchTabs(TABS, query).map((r) => r.tab.id);

test('nothing typed lists every tab, in the order given', () => {
  assert.deepEqual(ids(''), ['mail', 'bbc', 'doc', 'yt', 'set']);
  assert.deepEqual(ids('   '), ['mail', 'bbc', 'doc', 'yt', 'set']);
});

test('a half-remembered word still finds its tab', () => {
  assert.equal(ids('gmal')[0], 'mail');
  assert.equal(ids('lofi')[0], 'yt');
  assert.equal(ids('quartrly')[0], 'doc');
});

test('words can come in any order, from the title or the site', () => {
  assert.deepEqual(ids('news bbc'), ['bbc']);
  assert.deepEqual(ids('youtube study'), ['yt']);
  assert.equal(ids('docs.google')[0], 'doc');
});

test('every word has to match somewhere', () => {
  assert.deepEqual(ids('bbc weather'), []);
  assert.deepEqual(ids('zzz'), []);
});

test('a whole word at the start beats letters scattered through a title', () => {
  const ranked = ids('s');
  assert.equal(ranked[0], 'set');
  assert.ok(matchWord('Settings', 'set').score > matchWord('Sunset tips', 'set').score);
});

test('the address is searched, but only for whole words', () => {
  assert.deepEqual(ids('jfkfpf'), ['yt']);
  // In a long address almost any letters appear in order; that is not a match.
  assert.equal(matchWord('https://www.youtube.com/watch?v=jfKfPfyJRdk', 'wyk', { loose: false }), null);
});

test('matched letters are marked for drawing', () => {
  const [best] = searchTabs(TABS, 'bbc');
  assert.equal(best.tab.id, 'bbc');
  assert.deepEqual(runs(best.tab.title, best.titleHits), [['Home - ', false], ['BBC', true], [' News', false]]);
  assert.deepEqual(runs('abc', []), [['abc', false]]);
});

test('sites read the way people say them', () => {
  assert.equal(siteOf('https://www.bbc.co.uk/news'), 'bbc.co.uk');
  assert.equal(siteOf('browser://settings#privacy'), 'Static · settings');
  assert.equal(siteOf('static-file://abc/photo.png'), 'File on this computer');
  assert.equal(siteOf('not a url'), 'not a url');
});

test('odd input never throws', () => {
  assert.deepEqual(searchTabs(null, 'x'), []);
  assert.deepEqual(searchTabs([{}, { title: null, url: 42 }], 'a'), []);
  assert.doesNotThrow(() => searchTabs([{ title: 'İstanbul', url: '' }], 'is'));
});
