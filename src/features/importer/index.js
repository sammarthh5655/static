'use strict';

/**
 * Import bookmarks and history from another browser on this computer.
 *
 * Chrome, Edge, Brave, Opera and Vivaldi share Chromium's format: bookmarks
 * are a JSON file and history an SQLite database. Firefox keeps both in
 * places.sqlite. Databases are copied to a temporary file first and read
 * from the copy - the other browser may be running and holding a lock, and
 * its own files must never be modified.
 *
 * Passwords are NOT read from these folders: current browsers encrypt them
 * with keys tied to that browser (Chrome's app-bound encryption, Firefox's
 * key4.db). The supported route is that browser's own CSV export, which
 * browser://passwords imports.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = os.homedir();
// Windows' standard per-user folders; only consulted when running on Windows.
const local = path.join(home, 'AppData', 'Local');
const roaming = path.join(home, 'AppData', 'Roaming');
const macSupport = path.join(home, 'Library', 'Application Support');
const linuxConfig = process.env.XDG_CONFIG_HOME || path.join(home, '.config');

/** Where each browser keeps its data, per platform. */
const CHROMIUM = [
  { id: 'chrome', name: 'Google Chrome', win: [local, 'Google', 'Chrome', 'User Data'], mac: [macSupport, 'Google', 'Chrome'], linux: [linuxConfig, 'google-chrome'] },
  { id: 'edge', name: 'Microsoft Edge', win: [local, 'Microsoft', 'Edge', 'User Data'], mac: [macSupport, 'Microsoft Edge'], linux: [linuxConfig, 'microsoft-edge'] },
  { id: 'brave', name: 'Brave', win: [local, 'BraveSoftware', 'Brave-Browser', 'User Data'], mac: [macSupport, 'BraveSoftware', 'Brave-Browser'], linux: [linuxConfig, 'BraveSoftware', 'Brave-Browser'] },
  { id: 'opera', name: 'Opera', win: [roaming, 'Opera Software', 'Opera Stable'], mac: [macSupport, 'com.operasoftware.Opera'], linux: [linuxConfig, 'opera'], flat: true },
  { id: 'vivaldi', name: 'Vivaldi', win: [local, 'Vivaldi', 'User Data'], mac: [macSupport, 'Vivaldi'], linux: [linuxConfig, 'vivaldi'] },
];
const FIREFOX = { id: 'firefox', name: 'Mozilla Firefox', win: [roaming, 'Mozilla', 'Firefox'], mac: [macSupport, 'Firefox'], linux: [home, '.mozilla', 'firefox'] };

const platformKey = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
const MAX_HISTORY = 5000;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Chromium profiles: Default, Profile 1, ... named as the user named them. */
function chromiumProfiles(browser, root) {
  if (browser.flat) return fs.existsSync(path.join(root, 'Bookmarks')) || fs.existsSync(path.join(root, 'History')) ? [{ id: '.', name: 'Default' }] : [];
  const names = readJson(path.join(root, 'Local State'))?.profile?.info_cache || {};
  const dirs = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => d === 'Default' || /^Profile \d+$/.test(d)) : [];
  return dirs.filter((d) => fs.existsSync(path.join(root, d, 'Bookmarks')) || fs.existsSync(path.join(root, d, 'History')))
    .map((d) => ({ id: d, name: names[d]?.name || d }));
}

function firefoxProfiles(root) {
  const profiles = path.join(root, 'Profiles');
  const base = fs.existsSync(profiles) ? profiles : root;
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base)
    .filter((d) => fs.existsSync(path.join(base, d, 'places.sqlite')))
    .map((d) => ({ id: path.relative(root, path.join(base, d)), name: d.replace(/^[a-z0-9]+\./, '') }));
}

/** Browsers installed here, with their profiles. `roots` overrides for tests. */
function detect(roots = null) {
  const found = [];
  for (const browser of CHROMIUM) {
    const root = roots?.[browser.id] || path.join(...browser[platformKey]);
    const profiles = chromiumProfiles(browser, root);
    if (profiles.length) found.push({ id: browser.id, name: browser.name, kind: 'chromium', profiles });
  }
  const ffRoot = roots?.firefox || path.join(...FIREFOX[platformKey]);
  const ff = firefoxProfiles(ffRoot);
  if (ff.length) found.push({ id: 'firefox', name: FIREFOX.name, kind: 'firefox', profiles: ff });
  return found;
}

/** Open a copy of an SQLite file, read it, and throw the copy away. */
function withCopy(file, read) {
  const copy = path.join(os.tmpdir(), 'static-import-' + process.pid + '-' + Date.now() + '.sqlite');
  fs.copyFileSync(file, copy);
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(copy, { readOnly: true });
    try { return read(db); } finally { db.close(); }
  } finally {
    for (const suffix of ['', '-wal', '-shm', '-journal']) { try { fs.rmSync(copy + suffix, { force: true }); } catch { /* gone */ } }
  }
}

// Chromium stores times as microseconds since 1601-01-01.
// They exceed a JavaScript number's exact range, so they arrive as BigInt.
const chromiumTime = (value) => (typeof value === 'bigint'
  ? Number(value / 1000n) - 11644473600000
  : Math.round(Number(value) / 1000 - 11644473600000));
const bigMicros = (value) => (typeof value === 'bigint' ? Number(value / 1000n) : Math.round(Number(value) / 1000));
/** A statement that returns 64-bit integers exactly. */
const exact = (db, sql) => { const statement = db.prepare(sql); statement.setReadBigInts(true); return statement; };

function chromiumBookmarks(dir) {
  const data = readJson(path.join(dir, 'Bookmarks'));
  const out = [];
  const walk = (node, folder) => {
    if (!node) return;
    if (node.type === 'url') out.push({ url: node.url, title: node.name, folder, createdAt: node.date_added ? chromiumTime(node.date_added) : 0 });
    for (const child of node.children || []) walk(child, node.type === 'folder' && node.name ? (folder ? folder + ' / ' : '') + node.name : folder);
  };
  for (const [key, root] of Object.entries(data?.roots || {})) {
    if (!root || typeof root !== 'object') continue;
    // The bookmarks bar is where people keep their main bookmarks, so it adds
    // no folder name; the others ("Other bookmarks") keep theirs.
    for (const child of root.children || []) walk(child, key === 'bookmark_bar' ? '' : root.name || '');
  }
  return out;
}

function chromiumHistory(dir) {
  const file = path.join(dir, 'History');
  if (!fs.existsSync(file)) return [];
  return withCopy(file, (db) => exact(db,
    'SELECT url, title, last_visit_time AS t FROM urls WHERE hidden = 0 ORDER BY last_visit_time DESC LIMIT ?').all(BigInt(MAX_HISTORY))
    .map((row) => ({ url: row.url, title: row.title, visitedAt: chromiumTime(row.t) })));
}

function chromiumHomepage(dir) {
  const prefs = readJson(path.join(dir, 'Preferences'));
  const url = prefs?.homepage;
  return typeof url === 'string' && /^https?:\/\//.test(url) && !prefs?.homepage_is_newtabpage ? url : '';
}

function firefoxData(dir) {
  return withCopy(path.join(dir, 'places.sqlite'), (db) => ({
    bookmarks: exact(db, `SELECT b.title AS title, p.url AS url, f.title AS folder, b.dateAdded AS added
      FROM moz_bookmarks b JOIN moz_places p ON b.fk = p.id LEFT JOIN moz_bookmarks f ON b.parent = f.id
      WHERE b.type = 1 AND p.url LIKE 'http%'`).all()
      .map((r) => ({ url: r.url, title: r.title, folder: ['menu', 'toolbar', 'unfiled', 'mobile'].includes(r.folder) ? '' : r.folder || '', createdAt: bigMicros(r.added) })),
    history: exact(db, `SELECT url, title, last_visit_date AS t FROM moz_places
      WHERE last_visit_date IS NOT NULL AND url LIKE 'http%' ORDER BY last_visit_date DESC LIMIT ?`).all(BigInt(MAX_HISTORY))
      .map((r) => ({ url: r.url, title: r.title, visitedAt: bigMicros(r.t) })),
  }));
}

/**
 * Read one profile of one browser.
 * @returns {{ bookmarks: object[], history: object[], homepage: string }}
 */
function read(browserId, profileId, roots = null) {
  const browser = [...CHROMIUM, FIREFOX].find((b) => b.id === browserId);
  if (!browser) throw new Error('Unknown browser.');
  const root = roots?.[browserId] || path.join(...browser[platformKey]);
  const valid = browserId === 'firefox' ? firefoxProfiles(root) : chromiumProfiles(browser, root);
  // Only a profile that detect() would list: nothing outside the browser's own folder.
  if (!valid.some((p) => p.id === profileId)) throw new Error('That profile was not found.');
  const dir = path.join(root, profileId);
  if (browserId === 'firefox') return { ...firefoxData(dir), homepage: '' };
  return { bookmarks: chromiumBookmarks(dir), history: chromiumHistory(dir), homepage: chromiumHomepage(dir) };
}

module.exports = { detect, read, chromiumTime };
