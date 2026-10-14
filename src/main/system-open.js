/**
 * What the operating system asks static to open.
 *
 * Once static is a browser the system knows about - registered by the
 * Windows installer, or listed by macOS from Info.plist - links clicked in
 * other apps and files opened "with static" arrive here:
 *   - Windows/Linux: as command-line arguments, on first launch or, when
 *     static is already running, through the single-instance lock's
 *     'second-instance' event.
 *   - macOS: as 'open-url' and 'open-file' events.
 *
 * Those arguments come from outside, so this only ever accepts http(s)
 * addresses and existing local files of a few viewable kinds. Everything
 * else - Chromium switches, the executable's own path, javascript:, data:,
 * our own browser:// pages - is ignored, not opened.
 *
 * Pure Node so it is unit tested (tests/system-open.test.cjs).
 */
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

/** Local files a browser opens: pages, documents, images, plain text. */
const FILE_TYPES = new Set([
  // Each must also have a type in features/tabs/local-files.js, or the tab
  // downloads the file instead of showing it (why .mht/.mhtml are not here).
  '.html', '.htm', '.xhtml', '.xht', '.shtml', '.pdf', '.svg',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico',
  '.txt', '.json', '.xml',
]);

/** Longest address accepted from outside; browsers allow about this much. */
const MAX_URL = 32 * 1024;

/**
 * One argument to { kind: 'web', url } or { kind: 'file', path }, or null.
 * `cwd` resolves a relative path, as a terminal would ("static page.html").
 */
function target(raw, cwd = process.cwd(), exists = fileExists) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > MAX_URL || value.startsWith('-')) return null;

  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return { kind: 'web', url: url.href };
    } catch { return null; }
  }

  let file = null;
  if (/^file:\/\//i.test(value)) {
    try { file = fileURLToPath(value); } catch { return null; }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
    // Any other scheme (javascript:, data:, browser:, mailto: ...). A
    // Windows drive path - a drive letter, a colon, a slash - also starts
    // "letter colon", which is why that case is let through to the path
    // check below.
    return null;
  } else {
    file = path.isAbsolute(value) ? value : path.resolve(cwd || process.cwd(), value);
  }
  if (!FILE_TYPES.has(path.extname(file).toLowerCase())) return null;
  return exists(file) ? { kind: 'file', path: path.normalize(file) } : null;
}

function fileExists(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

/** Every openable target in an argument list, in order, without repeats. */
function targets(argv, cwd, exists = fileExists) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(argv) ? argv : []) {
    const found = target(raw, cwd, exists);
    if (!found) continue;
    const key = found.kind + ':' + (found.url || found.path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(found);
    if (out.length >= 20) break; // a flood of arguments is not twenty tabs' worth
  }
  return out;
}

module.exports = { target, targets, FILE_TYPES };
