'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

/**
 * Tiny persistent JSON document store.
 *
 * Why JSON instead of SQLite: the data volumes here (bookmarks, settings, a
 * few thousand history rows, download list) are small, and SQLite would drag
 * in a native module that has to be rebuilt against Electron's ABI for every
 * platform we package. JSON keeps `npm install` + `electron-builder` trivial.
 * Each store is one file under `userData/`, written atomically (temp file +
 * rename) and debounced so hot paths (history logging) don't hammer the disk.
 */
const allStores = new Set();

class JsonStore {
  /**
   * @param {string} name     file name without extension, e.g. "bookmarks"
   * @param {object} defaults shape used when the file is missing/corrupt
   */
  constructor(name, defaults) {
    this.file = path.join(app.getPath('userData'), `${name}.json`);
    this.defaults = defaults;
    this.data = this._load();
    this._timer = null;
    allStores.add(this);
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      return { ...structuredClone(this.defaults), ...parsed };
    } catch {
      return structuredClone(this.defaults);
    }
  }

  /** Mark dirty; the write happens ~250ms later (coalesced). */
  save() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, 250);
  }

  /** Synchronous write. Called on quit so nothing is lost. */
  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error(`json-store: failed to write ${this.file}`, err);
    }
  }
}

function flushAll() {
  for (const store of allStores) store.flush();
}

module.exports = { JsonStore, flushAll };
