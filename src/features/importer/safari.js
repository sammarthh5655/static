'use strict';

/**
 * Safari's bookmarks and history, read straight from a Mac.
 *
 *   ~/Library/Safari/Bookmarks.plist   a binary property list (./plist.js)
 *   ~/Library/Safari/History.db        SQLite: history_items + history_visits
 *
 * macOS keeps that folder private. static can read it only after the person
 * turns on Full Disk Access for static in System Settings; until then every
 * read fails with "operation not permitted". That is reported as an access
 * problem (needsAccess / SAFARI_ACCESS), so the import screen can say exactly
 * what to do - or point to Safari's own export, which needs no permission at
 * all and is read by ./files.js.
 *
 * Passwords are never read here: Safari keeps them in the Keychain. Safari's
 * export includes them as a CSV file, which ./files.js hands to the vault.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseBplist } = require('./plist');
const { withCopy, isDenied } = require('./util');

const MAX_HISTORY = 5000;
const APPLE_EPOCH_MS = 978307200 * 1000;

/** Where Safari keeps its data, or null where there is no Safari. */
function safariRoot(roots = null) {
  // Tests pass their own folders; one that names none for Safari means no
  // Safari, never the real one on the machine running the test.
  if (roots) return roots.safari || null;
  return process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Safari') : null;
}

/** The error the import screen turns into "allow Full Disk Access". */
function accessError() {
  const error = new Error('static needs your permission to read Safari. Open System Settings > Privacy & Security > Full Disk Access, turn on static, then quit and reopen static. Or export from Safari (File > Export Browsing Data to File) and import that file instead.');
  error.code = 'SAFARI_ACCESS';
  return error;
}

/** 'ok', 'denied' (privacy controls), or 'missing' (no Safari data at all). */
function accessState(root) {
  let sawFile = false;
  for (const name of ['Bookmarks.plist', 'History.db']) {
    try {
      fs.closeSync(fs.openSync(path.join(root, name), 'r'));
      return 'ok';
    } catch (error) {
      if (isDenied(error)) return 'denied';
      if (error?.code !== 'ENOENT') sawFile = true;
    }
  }
  return sawFile ? 'denied' : 'missing';
}

/** Safari as detect() lists browsers, or null. */
function detectSafari(roots = null) {
  const root = safariRoot(roots);
  if (!root) return null;
  let exists = false;
  try { exists = fs.statSync(root).isDirectory(); } catch (error) { exists = isDenied(error); }
  if (!exists) return null;
  const state = accessState(root);
  if (state === 'missing') return null;
  return { id: 'safari', name: 'Safari', kind: 'safari', profiles: [{ id: '.', name: 'Safari' }], needsAccess: state === 'denied' };
}

/**
 * Bookmarks from the parsed Bookmarks.plist. The Favorites bar is where
 * people keep their main bookmarks, so like Chrome's bookmarks bar it adds no
 * folder name; the Bookmarks menu and the Reading List keep theirs.
 */
function bookmarksFromPlist(root) {
  const out = [];
  const TOP = { BookmarksBar: '', BookmarksMenu: 'Bookmarks Menu', 'com.apple.ReadingList': 'Reading List' };
  const walk = (node, folder, depth) => {
    if (!node || typeof node !== 'object' || depth > 40) return;
    if (node.WebBookmarkType === 'WebBookmarkTypeLeaf') {
      const url = typeof node.URLString === 'string' ? node.URLString : '';
      const title = typeof node.URIDictionary?.title === 'string' ? node.URIDictionary.title : '';
      if (/^https?:\/\//i.test(url)) out.push({ url, title: title || url, folder });
      return;
    }
    if (node.WebBookmarkType !== 'WebBookmarkTypeList' || !Array.isArray(node.Children)) return; // History proxy and the like
    for (const child of node.Children) {
      if (child?.WebBookmarkType === 'WebBookmarkTypeList') {
        const name = typeof child.Title === 'string' ? child.Title : '';
        const next = depth === 0 && name in TOP ? TOP[name] : [folder, name].filter(Boolean).join(' / ');
        walk(child, next, depth + 1);
      } else {
        walk(child, folder, depth + 1);
      }
    }
  };
  walk(root, '', 0);
  return out;
}

function safariBookmarks(root) {
  let buffer;
  try {
    buffer = fs.readFileSync(path.join(root, 'Bookmarks.plist'));
  } catch (error) {
    if (isDenied(error)) throw accessError();
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return bookmarksFromPlist(parseBplist(buffer));
}

/**
 * Each page once, at its latest visit, newest first. Safari stores visit
 * times as seconds since 2001-01-01 (Apple's epoch).
 */
function safariHistory(root) {
  const file = path.join(root, 'History.db');
  try {
    return withCopy(file, (db) => db.prepare(`SELECT i.url AS url, v.title AS title, MAX(v.visit_time) AS t
        FROM history_items i JOIN history_visits v ON v.history_item = i.id
        WHERE i.url LIKE 'http%'
        GROUP BY i.id ORDER BY t DESC LIMIT ?`).all(MAX_HISTORY)
      .map((row) => ({ url: row.url, title: row.title || row.url, visitedAt: Math.round(APPLE_EPOCH_MS + Number(row.t) * 1000) })));
  } catch (error) {
    if (isDenied(error)) throw accessError();
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

/** Everything importable from Safari on this Mac. */
function readSafari(roots = null) {
  const root = safariRoot(roots);
  if (!root) throw new Error('Safari is only on a Mac. To bring Safari data to this computer, export it from Safari on the Mac (File > Export Browsing Data to File) and import that file.');
  return { bookmarks: safariBookmarks(root), history: safariHistory(root), homepage: '' };
}

/**
 * Whether Safari has anything worth importing. Visits only, as for Firefox:
 * Safari ships starter favorites. Data the privacy controls hide counts as
 * yes - Safari is the browser every Mac user has come from.
 */
function safariHasData(roots = null) {
  const found = detectSafari(roots);
  if (!found) return false;
  if (found.needsAccess) return true;
  try { return safariHistory(safariRoot(roots)).length > 0; } catch { return true; }
}

module.exports = { detectSafari, readSafari, safariHasData, bookmarksFromPlist, accessError, safariRoot };
