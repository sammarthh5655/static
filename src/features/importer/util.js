'use strict';

/** Helpers every importer shares. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Open a copy of an SQLite file, read it, and throw the copy away. The other
 * browser may be running and holding a lock, and its own files must never be
 * modified, so nothing ever opens the original.
 */
function withCopy(file, read) {
  const copy = path.join(os.tmpdir(), 'static-import-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.sqlite');
  fs.copyFileSync(file, copy);
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(copy, { readOnly: true });
    try { return read(db); } finally { db.close(); }
  } finally {
    for (const suffix of ['', '-wal', '-shm', '-journal']) { try { fs.rmSync(copy + suffix, { force: true }); } catch { /* gone */ } }
  }
}

/** True for the errors macOS gives when its privacy controls refuse a read. */
const isDenied = (error) => error && (error.code === 'EPERM' || error.code === 'EACCES');

module.exports = { readJson, withCopy, isDenied };
