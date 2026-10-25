const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { /* skip the database tests */ }
const { detect, read, hasData } = require('../src/features/importer');
const { readExport, parseBookmarksHtml, parseHistoryJson } = require('../src/features/importer/files');
const { bookmarksFromPlist } = require('../src/features/importer/safari');
const plist = require('./fixtures/plist.cjs');
const { zip } = require('./fixtures/crx.cjs');

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-safari-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** A ~/Library/Safari as Safari leaves it: Bookmarks.plist and History.db. */
function fakeSafari(t) {
  const root = tmp(t);
  fs.writeFileSync(path.join(root, 'Bookmarks.plist'), plist.encode(plist.safariBookmarks()));
  if (sqlite) {
    const db = new sqlite.DatabaseSync(path.join(root, 'History.db'));
    db.exec(`CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT UNIQUE, visit_count INTEGER);
      CREATE TABLE history_visits (id INTEGER PRIMARY KEY, history_item INTEGER, visit_time REAL, title TEXT)`);
    db.prepare('INSERT INTO history_items (id, url, visit_count) VALUES (?, ?, ?)').run(1, 'https://news.example/', 2);
    db.prepare('INSERT INTO history_items (id, url, visit_count) VALUES (?, ?, ?)').run(2, 'file:///etc/hosts', 1);
    // Seconds since 2001-01-01: two visits to one page, the later one counts.
    const apple = (ms) => ms / 1000 - 978307200;
    db.prepare('INSERT INTO history_visits (history_item, visit_time, title) VALUES (?, ?, ?)').run(1, apple(Date.UTC(2026, 0, 1)), 'Old title');
    db.prepare('INSERT INTO history_visits (history_item, visit_time, title) VALUES (?, ?, ?)').run(1, apple(Date.UTC(2026, 5, 1)), 'News');
    db.prepare('INSERT INTO history_visits (history_item, visit_time, title) VALUES (?, ?, ?)').run(2, apple(Date.UTC(2026, 5, 2)), 'Hosts');
    db.close();
  }
  return root;
}

/* ---- Safari on a Mac ---- */

test('Safari is listed alongside the other browsers', (t) => {
  const roots = { safari: fakeSafari(t), chrome: '/nonexistent', edge: '/nonexistent', brave: '/nonexistent', opera: '/nonexistent', vivaldi: '/nonexistent', firefox: '/nonexistent' };
  const found = detect(roots);
  const sf = found.find((b) => b.id === 'safari');
  assert.ok(sf, JSON.stringify(found));
  assert.equal(sf.needsAccess, false);
  assert.deepEqual(sf.profiles, [{ id: '.', name: 'Safari' }]);
});

test('Safari bookmarks keep their folders; the Favorites bar is the main one', (t) => {
  const roots = { safari: fakeSafari(t) };
  const { bookmarks } = read('safari', '.', roots);
  assert.deepEqual(bookmarks.map((b) => [b.title, b.folder]), [
    ['Apple', ''],
    ['Docs', 'Work'],
    ['Ünïcödé café', 'Work'],
    ['News', 'Bookmarks Menu'],
    ['Long read', 'Reading List'],
  ]);
  assert.ok(!bookmarks.some((b) => b.url.startsWith('javascript:')), 'only web addresses');
});

test('Safari history: each page once, at its latest visit, web pages only', { skip: !sqlite }, (t) => {
  const { history } = read('safari', '.', { safari: fakeSafari(t) });
  assert.deepEqual(history, [{ url: 'https://news.example/', title: 'News', visitedAt: Date.UTC(2026, 5, 1) }]);
});

test('only Safari\'s own profile can be read', (t) => {
  assert.throws(() => read('safari', '../../etc', { safari: fakeSafari(t) }), /not found/);
});

test('when macOS keeps Safari private, the person is told how to allow it', (t) => {
  const root = fakeSafari(t);
  const denied = (target) => String(target).startsWith(root);
  const eperm = () => Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  const original = { openSync: fs.openSync, readFileSync: fs.readFileSync, copyFileSync: fs.copyFileSync };
  fs.openSync = function (target, ...rest) { if (denied(target)) throw eperm(); return original.openSync.call(this, target, ...rest); };
  fs.readFileSync = function (target, ...rest) { if (denied(target)) throw eperm(); return original.readFileSync.call(this, target, ...rest); };
  fs.copyFileSync = function (from, ...rest) { if (denied(from)) throw eperm(); return original.copyFileSync.call(this, from, ...rest); };
  t.after(() => Object.assign(fs, original));

  const sf = detect({ safari: root }).find((b) => b.id === 'safari');
  assert.equal(sf.needsAccess, true, 'listed, but marked as needing permission');
  assert.throws(() => read('safari', '.', { safari: root }), (error) => error.code === 'SAFARI_ACCESS' && /Full Disk Access/.test(error.message));
  assert.equal(hasData({ safari: root, chrome: '/x', edge: '/x', brave: '/x', opera: '/x', vivaldi: '/x', firefox: '/x' }), true,
    'every Mac user comes from Safari, so setup still offers to import');
});

test('no Safari folder, no Safari', (t) => {
  assert.equal(detect({ safari: path.join(tmp(t), 'missing') }).some((b) => b.id === 'safari'), false);
});

test('a damaged Bookmarks.plist is an error, not a crash', (t) => {
  const root = tmp(t);
  fs.writeFileSync(path.join(root, 'Bookmarks.plist'), Buffer.from('bplist00 but not really'));
  assert.throws(() => read('safari', '.', { safari: root }));
});

test('the bookmark walk ignores anything it does not recognise', () => {
  assert.deepEqual(bookmarksFromPlist({ WebBookmarkType: 'WebBookmarkTypeList', Children: [null, 7, 'x', { WebBookmarkType: 'Odd' }] }), []);
  assert.deepEqual(bookmarksFromPlist(null), []);
});

/* ---- files any browser exports ---- */

const CHROME_EXPORT = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000" LAST_MODIFIED="0" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://a.example/" ADD_DATE="1700000000" ICON="data:image/png;base64,AAAA">A &amp; B</A>
        <DT><H3 ADD_DATE="1700000001">Work</H3>
        <DL><p>
            <DT><A HREF="https://w.example/">İstanbul docs</A>
            <DT><A HREF="javascript:alert(1)">Bad</A>
        </DL><p>
    </DL><p>
    <DT><H3>Other bookmarks</H3>
    <DL><p>
        <DT><A HREF="https://o.example/">Other</A>
    </DL><p>
</DL><p>`;

test('a Chrome, Edge or Brave bookmarks export', () => {
  assert.deepEqual(parseBookmarksHtml(CHROME_EXPORT), [
    { url: 'https://a.example/', title: 'A & B', folder: '', createdAt: 1700000000000 },
    { url: 'https://w.example/', title: 'İstanbul docs', folder: 'Work', createdAt: 0 },
    { url: 'https://o.example/', title: 'Other', folder: 'Other bookmarks', createdAt: 0 },
  ]);
});

test('a Firefox bookmarks export (toolbar, menu, lowercase tags)', () => {
  const html = `<dl><p><dt><h3 personal_toolbar_folder="true">Bookmarks Toolbar</h3><dl><p>
    <dt><a href='https://ff.example/' add_date="1700000000000">Fox</a></dl><p>
    <dt><h3>Bookmarks Menu</h3><dl><p><dt><a href="https://menu.example/">Menu &#8212; item</a></dl></dl>`;
  assert.deepEqual(parseBookmarksHtml(html), [
    { url: 'https://ff.example/', title: 'Fox', folder: '', createdAt: 1700000000000 },
    { url: 'https://menu.example/', title: 'Menu — item', folder: 'Bookmarks Menu', createdAt: 0 },
  ]);
});

test('Safari\'s exported Bookmarks.html (Favorites, Reading List)', () => {
  const html = `<DL><p><DT><H3 FOLDED>Favourites</H3><DL><p><DT><A HREF="https://fav.example/">Fav</A></DL><p>
    <DT><H3 id="com.apple.ReadingList">Reading List</H3><DL><p><DT><A HREF="https://r.example/">Read</A></DL><p></DL>`;
  assert.deepEqual(parseBookmarksHtml(html).map((b) => [b.title, b.folder]), [['Fav', ''], ['Read', 'Reading List']]);
});

test('Safari\'s History.json: newest first, web pages only, times in microseconds', () => {
  const json = JSON.stringify({
    metadata: { browser_name: 'Safari', data_type: 'history', schema_version: 1 },
    history: [
      { url: 'https://old.example/', title: 'Old', time_usec: Date.UTC(2025, 0, 1) * 1000, visit_count: 1 },
      { url: 'https://new.example/', title: '', time_usec: Date.UTC(2026, 0, 1) * 1000 },
      { url: 'file:///secret', title: 'No', time_usec: Date.UTC(2026, 0, 2) * 1000 },
      { url: 'https://notime.example/' },
    ],
  });
  assert.deepEqual(parseHistoryJson(json), [
    { url: 'https://new.example/', title: 'https://new.example/', visitedAt: Date.UTC(2026, 0, 1) },
    { url: 'https://old.example/', title: 'Old', visitedAt: Date.UTC(2025, 0, 1) },
  ]);
  assert.throws(() => parseHistoryJson('{not json'), /not valid JSON/);
});

test('Safari\'s export zip brings bookmarks, history and passwords', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'Safari Export.zip');
  fs.writeFileSync(file, zip([
    { name: 'Safari Export/', data: '', method: 0 },
    { name: 'Safari Export/Bookmarks.html', data: CHROME_EXPORT },
    { name: 'Safari Export/History.json', data: JSON.stringify({ history: [{ url: 'https://h.example/', title: 'H', time_usec: Date.UTC(2026, 0, 1) * 1000 }] }) },
    { name: 'Safari Export/Passwords.csv', data: 'Title,URL,Username,Password,Notes,OTPAuth\nSite,https://s.example/,me,pw,,\n' },
  ]));
  const unpacked = () => new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('static-import-') && !n.endsWith('.sqlite')));
  const before = unpacked();
  const data = readExport(file);
  assert.equal(data.kind, 'export');
  assert.equal(data.bookmarks.length, 3);
  assert.equal(data.history.length, 1);
  assert.match(data.passwordsCsv, /^Title,URL,Username,Password/);
  // The zip was unpacked to a temporary folder, which is gone again.
  assert.deepEqual([...unpacked()].filter((n) => !before.has(n)), []);
});

test('a zip that tries to write outside its folder is refused', (t) => {
  const file = path.join(tmp(t), 'evil.zip');
  fs.writeFileSync(file, zip([{ name: '../../escape.html', data: '<a href="https://x.example/">x</a>' }]));
  assert.throws(() => readExport(file), /could not be read safely/);
});

test('a bookmarks .html file on its own, and other kinds of file', (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'bookmarks_1_2_26.html'), CHROME_EXPORT);
  assert.equal(readExport(path.join(dir, 'bookmarks_1_2_26.html')).bookmarks.length, 3);
  fs.writeFileSync(path.join(dir, 'empty.html'), '<p>no bookmarks</p>');
  assert.throws(() => readExport(path.join(dir, 'empty.html')), /No bookmarks/);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
  assert.throws(() => readExport(path.join(dir, 'notes.txt')), /Choose the zip/);
  const unpacked = path.join(dir, 'export');
  fs.mkdirSync(unpacked);
  fs.writeFileSync(path.join(unpacked, 'History.json'), JSON.stringify({ history: [] }));
  assert.equal(readExport(unpacked).kind, 'export', 'the folder an export unzips to works too');
});
