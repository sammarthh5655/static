'use strict';

/**
 * The keys Static runs with, read in main only.
 *
 * First the file baked in at build time (keys.js, gitignored). A build made
 * without it - the GitHub builds - also looks for a copy the owner placed in
 * Static's data folder:
 *   Windows  %APPDATA%\static\keys.js
 *   macOS    ~/Library/Application Support/static/keys.js
 * so a downloaded build can be given its key without building from source.
 */
const fs = require('node:fs');
const path = require('node:path');

let cached = null;

function keys() {
  if (cached) return cached;
  cached = {};
  try { cached = require('./keys'); } catch { /* not built in */ }
  if (!cached.gemini || !cached.supabase) {
    try {
      const { app } = require('electron');
      // The root data folder, not the per-profile or test one.
      const file = path.join(app.getPath('appData'), 'static', 'keys.js');
      if (fs.existsSync(file)) {
        const outside = require(file);
        cached = { ...outside, ...Object.fromEntries(Object.entries(cached).filter(([, v]) => v)) };
      }
    } catch { /* no data-folder copy */ }
  }
  return cached;
}

module.exports = { keys };
