'use strict';

/**
 * Files from this computer, opened in a tab: an image dragged onto the tab
 * strip, a PDF dropped on a page.
 *
 * Static never lets a tab load file:// - a web page must not be able to read
 * the disk, and a local page could pose as a built-in one. So each dropped
 * file gets a random token, and a tab opens static-file://<token>/<name>.
 * The static-file scheme serves ONLY files registered here, nothing else on
 * the disk, and nothing a page could guess its way to.
 *
 * Images dragged from a web page that exist only in memory (data: or blob:
 * addresses) are written to a folder in the profile first, and served the
 * same way. The list is kept on disk, capped, so tabs restored after a
 * restart still find their files.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FILE = 'dropped-files.json';
const MAX = 300;
/** Big enough for any photo, video or PDF someone drags in; small enough to refuse a disk image. */
const MAX_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_MEMORY_BYTES = 64 * 1024 * 1024;
const KEEP_COPIES_MS = 30 * 24 * 60 * 60 * 1000;

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', apng: 'image/apng',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/plain', log: 'text/plain', csv: 'text/plain', json: 'application/json',
  html: 'text/html', htm: 'text/html', xml: 'text/xml',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', opus: 'audio/ogg',
};

const mimeOf = (name) => MIME[String(path.extname(name)).slice(1).toLowerCase()] || 'application/octet-stream';

class LocalFiles {
  constructor(dir) {
    this.file = path.join(dir, FILE);
    this.copies = path.join(dir, 'dropped');
    /** token -> { path, name, at, copy } */
    this.entries = new Map();
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const entry of Array.isArray(saved) ? saved : []) {
        if (/^[a-f0-9]{32}$/.test(entry?.token) && typeof entry.path === 'string') this.entries.set(entry.token, entry);
      }
    } catch { /* first run */ }
    this.#sweep();
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify([...this.entries.values()]));
    } catch (error) {
      console.error('[files] could not save the list', error.message);
    }
  }

  /** Forget the oldest, and delete in-memory images copied long ago. */
  #sweep() {
    const now = Date.now();
    for (const [token, entry] of this.entries) {
      if (entry.copy && now - entry.at > KEEP_COPIES_MS) {
        try { fs.rmSync(entry.path, { force: true }); } catch { /* already gone */ }
        this.entries.delete(token);
      }
    }
    while (this.entries.size > MAX) {
      const [token, entry] = this.entries.entries().next().value;
      if (entry.copy) { try { fs.rmSync(entry.path, { force: true }); } catch { /* already gone */ } }
      this.entries.delete(token);
    }
  }

  #register(filePath, name, copy = false) {
    // The same file dropped twice keeps its address.
    for (const [token, entry] of this.entries) {
      if (entry.path === filePath) {
        this.entries.delete(token);
        entry.at = Date.now();
        this.entries.set(token, entry);
        this.#save();
        return this.urlFor(token);
      }
    }
    const token = crypto.randomBytes(16).toString('hex');
    this.entries.set(token, { token, path: filePath, name, at: Date.now(), copy });
    this.#sweep();
    this.#save();
    return this.urlFor(token);
  }

  /** A file on disk, by its full path. Returns the static-file URL or an error. */
  add(filePath) {
    const full = String(filePath || '');
    if (!full || !path.isAbsolute(full)) return { error: 'Not a file on this computer.' };
    let stat;
    try { stat = fs.statSync(full); } catch { return { error: 'That file could not be opened.' }; }
    if (!stat.isFile()) return { error: 'Folders cannot be opened in a tab.' };
    if (stat.size > MAX_BYTES) return { error: 'That file is too large to open in a tab.' };
    return { url: this.#register(path.resolve(full), path.basename(full)) };
  }

  /** An image that exists only in memory (dragged from a page): saved, then served. */
  addBytes(name, bytes) {
    const buffer = Buffer.from(bytes || []);
    if (!buffer.length) return { error: 'There was nothing in that image.' };
    if (buffer.length > MAX_MEMORY_BYTES) return { error: 'That image is too large.' };
    const clean = String(name || 'image').replace(/[^\w.() -]+/g, '_').slice(-80) || 'image';
    const safeName = /\.\w{2,5}$/.test(clean) ? clean : clean + '.png';
    fs.mkdirSync(this.copies, { recursive: true });
    const target = path.join(this.copies, crypto.randomBytes(6).toString('hex') + '-' + safeName);
    fs.writeFileSync(target, buffer);
    return { url: this.#register(target, safeName, true) };
  }

  urlFor(token) {
    const entry = this.entries.get(token);
    return 'static-file://' + token + '/' + encodeURIComponent(entry?.name || 'file');
  }

  /** What a static-file:// request may read: a registered, still existing file. */
  lookup(url) {
    let token = '';
    try { token = new URL(url).hostname.toLowerCase(); } catch { return null; }
    const entry = this.entries.get(token);
    if (!entry) return null;
    try { if (!fs.statSync(entry.path).isFile()) return null; } catch { return null; }
    return { path: entry.path, name: entry.name, mime: mimeOf(entry.name) };
  }

  /** The file's own name and folder, for the address bar. */
  describe(url) {
    const found = this.lookup(url);
    return found ? found.path : '';
  }
}

module.exports = { LocalFiles, mimeOf };
