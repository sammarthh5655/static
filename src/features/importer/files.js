'use strict';

/**
 * Importing from a file another browser exported. Needs no permissions and
 * works on any computer - the way to bring Safari data to a PC, and the way
 * on a Mac without granting Full Disk Access.
 *
 * Accepted:
 *   - Safari's export (Safari 18 and later: File > Export Browsing Data to
 *     File): a .zip, or the folder it unzips to, holding Bookmarks.html,
 *     History.json and Passwords.csv.
 *   - Any browser's bookmarks export: the .html file Chrome, Edge, Brave,
 *     Firefox, Safari and Opera all write (the "Netscape bookmark" format).
 *   - A History.json on its own.
 *
 * Zips are unpacked by the same strict reader as extension packages
 * (../extensions/crx.js extractZip): nothing can land outside a temporary
 * folder, sizes are capped while inflating, and the folder is removed after.
 * Pure Node; unit tested in tests/importer.test.cjs.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { extractZip } = require('../extensions/crx');

const MAX_FILE = 512 * 1024 * 1024;   // a zip, or one exported file
const MAX_TEXT = 200 * 1024 * 1024;   // any one file read as text
const MAX_HISTORY = 5000;
const ZIP_LIMITS = { fileBytes: MAX_FILE, totalBytes: 1024 * 1024 * 1024, entries: 5000 };

/* ---- bookmarks: the Netscape bookmark file every browser exports ---- */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

function attribute(attrs, name) {
  const match = new RegExp('\\b' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(attrs);
  return match ? decode(match[2] ?? match[3] ?? match[4] ?? '') : '';
}

// The folder each browser shows along the top. Its bookmarks are the main
// ones, so they get no folder name, as when importing from Chrome directly.
const MAIN_FOLDER = /^(bookmarks bar|bookmarks toolbar|favou?rites( bar)?|bookmarksbar|barre de favoris)$/i;

/**
 * Bookmarks from an exported bookmarks file: [{ url, title, folder, createdAt }].
 * Only http(s) addresses; folders become "Parent / Child".
 */
function parseBookmarksHtml(html) {
  const out = [];
  const stack = [];        // folder names for each open <DL>
  let pending = null;      // the <H3> just read, waiting for its <DL>
  const text = String(html);
  const token = /<(\/?)(dl|h3|a)\b([^>]*)>/gi;
  const closers = { h3: /<\/h3\s*>/gi, a: /<\/a\s*>/gi };
  let match;
  while ((match = token.exec(text))) {
    const closing = match[1] === '/';
    const tag = match[2].toLowerCase();
    if (tag === 'dl') {
      if (closing) stack.pop();
      else { stack.push(pending ?? ''); pending = null; }
      continue;
    }
    if (closing) continue;
    // The text up to the matching closing tag, found from here on (not by
    // lower-casing the file, which is slow and can shift positions).
    const closer = closers[tag];
    closer.lastIndex = token.lastIndex;
    const end = closer.exec(text);
    const inner = decode(text.slice(token.lastIndex, end ? end.index : token.lastIndex).replace(/<[^>]*>/g, '')).trim();
    if (tag === 'h3') {
      const main = /personal_toolbar_folder\s*=\s*"?true/i.test(match[3]) || MAIN_FOLDER.test(inner);
      pending = main ? '' : inner;
      continue;
    }
    const url = attribute(match[3], 'href');
    if (!/^https?:\/\//i.test(url)) continue;
    const added = Number(attribute(match[3], 'add_date'));
    out.push({
      url,
      title: inner || url,
      folder: stack.filter(Boolean).join(' / '),
      // Seconds since 1970 in every browser's export; some write milliseconds.
      createdAt: added > 0 ? (added > 1e11 ? added : added * 1000) : 0,
    });
  }
  return out;
}

/* ---- history: Safari's History.json ---- */

/**
 * Safari writes { metadata, history: [{ url, title, time_usec, ... }] }.
 * Other names for the time are accepted too, and its unit is worked out from
 * its size, so a slightly different export still imports.
 */
function parseHistoryJson(text) {
  let data;
  try { data = JSON.parse(String(text).replace(/^\uFEFF/, '')); } catch { throw new Error('That history file is not valid JSON.'); }
  const list = Array.isArray(data) ? data : Array.isArray(data?.history) ? data.history : [];
  const out = [];
  for (const item of list) {
    const url = typeof item?.url === 'string' ? item.url : '';
    if (!/^https?:\/\//i.test(url)) continue;
    const raw = Number(item.time_usec ?? item.visit_time_usec ?? item.visitTime ?? item.time ?? item.lastVisitTime ?? item.last_visit_time ?? 0);
    const visitedAt = raw > 1e15 ? Math.round(raw / 1000) : raw > 1e12 ? Math.round(raw) : raw > 1e9 ? Math.round(raw * 1000) : 0;
    if (!visitedAt) continue;
    out.push({ url, title: typeof item.title === 'string' && item.title ? item.title : url, visitedAt });
  }
  out.sort((a, b) => b.visitedAt - a.visitedAt);
  return out.slice(0, MAX_HISTORY);
}

/* ---- reading whatever was chosen ---- */

function readText(file) {
  const size = fs.statSync(file).size;
  if (size > MAX_TEXT) throw new Error(path.basename(file) + ' is too large to import.');
  return fs.readFileSync(file, 'utf8');
}

/** Every file under `dir` (a few levels deep), by lower-case name. */
function index(dir, depth = 0, found = new Map()) {
  if (depth > 3) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) index(full, depth + 1, found);
    else if (entry.isFile() && !found.has(entry.name.toLowerCase())) found.set(entry.name.toLowerCase(), full);
  }
  return found;
}

/** What a folder of exported files holds. */
function readFolder(dir) {
  const files = index(dir);
  const pick = (...names) => names.map((n) => files.get(n)).find(Boolean);
  const bookmarksFile = pick('bookmarks.html', 'bookmarks.htm');
  const historyFile = pick('history.json');
  const passwordsFile = pick('passwords.csv');
  if (!bookmarksFile && !historyFile && !passwordsFile) {
    throw new Error('Nothing to import was found there. Choose the zip Safari exported, or a bookmarks .html file.');
  }
  return {
    kind: 'export',
    bookmarks: bookmarksFile ? parseBookmarksHtml(readText(bookmarksFile)) : [],
    history: historyFile ? parseHistoryJson(readText(historyFile)) : [],
    passwordsCsv: passwordsFile ? readText(passwordsFile) : '',
  };
}

/**
 * Read an exported file or folder.
 * @returns {{ kind: string, bookmarks: object[], history: object[], passwordsCsv: string }}
 */
function readExport(target) {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) return readFolder(target);
  if (!stat.isFile()) throw new Error('That is not a file.');
  if (stat.size > MAX_FILE) throw new Error('That file is too large to import.');
  const ext = path.extname(target).toLowerCase();

  if (ext === '.zip') {
    const dest = path.join(os.tmpdir(), 'static-import-' + randomUUID());
    try {
      extractZip(fs.readFileSync(target), dest, ZIP_LIMITS);
      return readFolder(dest);
    } catch (error) {
      if (error?.name === 'CrxError') throw new Error('That zip file could not be read safely: ' + error.message);
      throw error;
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  }
  if (ext === '.html' || ext === '.htm') {
    const bookmarks = parseBookmarksHtml(readText(target));
    if (!bookmarks.length) throw new Error('No bookmarks were found in that file.');
    return { kind: 'bookmarks', bookmarks, history: [], passwordsCsv: '' };
  }
  if (ext === '.json') return { kind: 'history', bookmarks: [], history: parseHistoryJson(readText(target)), passwordsCsv: '' };
  throw new Error('Choose the zip Safari exported, a bookmarks .html file, or a History.json file.');
}

module.exports = { readExport, parseBookmarksHtml, parseHistoryJson, decode };
