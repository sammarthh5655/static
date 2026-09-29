const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// node:sqlite is part of the Node that ships with Electron; the plain Node
// running unit tests may be older.
let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { /* skip the database tests */ }
const { detect, read, chromiumTime } = require('../src/features/importer');

function fakeChrome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-import-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'Default');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(root, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Sam' } } } }));
  fs.writeFileSync(path.join(dir, 'Bookmarks'), JSON.stringify({ roots: {
    bookmark_bar: { type: 'folder', name: 'Bookmarks bar', children: [
      { type: 'url', name: 'Wiki', url: 'https://wikipedia.org/' },
      { type: 'folder', name: 'Work', children: [{ type: 'url', name: 'Docs', url: 'https://docs.example/' }] },
    ] },
    other: { type: 'folder', name: 'Other', children: [{ type: 'url', name: 'JS', url: 'javascript:alert(1)' }] },
  } }));
  fs.writeFileSync(path.join(dir, 'Preferences'), JSON.stringify({ homepage: 'https://start.example/', homepage_is_newtabpage: false }));
  if (sqlite) {
    const db = new sqlite.DatabaseSync(path.join(dir, 'History'));
    db.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, last_visit_time INTEGER, hidden INTEGER)');
    const when = (Date.UTC(2026, 0, 2) + 11644473600000) * 1000;
    db.prepare('INSERT INTO urls (url, title, last_visit_time, hidden) VALUES (?, ?, ?, 0)').run('https://news.example/', 'News', when);
    db.close();
  }
  return root;
}

test('Chromium times convert to ordinary dates', () => {
  assert.equal(chromiumTime((Date.UTC(2026, 0, 2) + 11644473600000) * 1000), Date.UTC(2026, 0, 2));
});

test('a Chrome profile is found and read: bookmarks with folders, history and homepage', (t) => {
  const root = fakeChrome(t);
  const found = detect({ chrome: root, edge: '/nope', brave: '/nope', opera: '/nope', vivaldi: '/nope', firefox: '/nope' });
  assert.deepEqual(found.map((b) => b.id), ['chrome']);
  assert.deepEqual(found[0].profiles, [{ id: 'Default', name: 'Sam' }]);
  const data = read('chrome', 'Default', { chrome: root });
  assert.deepEqual(data.bookmarks.map((b) => [b.title, b.folder]), [['Wiki', ''], ['Docs', 'Work'], ['JS', 'Other']]);
  assert.equal(data.homepage, 'https://start.example/');
  if (sqlite) assert.deepEqual(data.history.map((h) => [h.url, h.visitedAt]), [['https://news.example/', Date.UTC(2026, 0, 2)]]);
});

test('only profiles the browser really has can be read', (t) => {
  const root = fakeChrome(t);
  assert.throws(() => read('chrome', '../../Windows', { chrome: root }), /not found/);
  assert.throws(() => read('netscape', 'Default'), /Unknown browser/);
});
