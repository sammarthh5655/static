'use strict';

/**
 * The keys Static runs with, read in main only.
 *
 * First the file baked in at build time (keys.js, gitignored; the GitHub
 * build writes it from repository secrets). Anything missing or blank there
 * - a build made without the secrets - is looked for in a copy the owner
 * placed in Static's data folder:
 *   Windows  %APPDATA%\static\keys.js
 *   macOS    ~/Library/Application Support/static/keys.js
 * so a downloaded build can be given its keys without building from source.
 */
const fs = require('node:fs');
const path = require('node:path');

let cached = null;

const hasSupabase = (value) => !!(value && value.url && value.key);

function keys() {
  if (cached) return cached;
  let baked = {};
  try { baked = require('./keys'); } catch { /* not built in */ }
  cached = { ...baked };
  if (!cached.gemini || !hasSupabase(cached.supabase)) {
    try {
      const { app } = require('electron');
      // The root data folder, not the per-profile or test one.
      const file = path.join(app.getPath('appData'), 'static', 'keys.js');
      if (fs.existsSync(file)) {
        const outside = require(file);
        // A blank value baked in (a secret that was not set) never hides a
        // real one from the data folder.
        if (!cached.gemini && outside.gemini) cached.gemini = outside.gemini;
        if (!hasSupabase(cached.supabase) && hasSupabase(outside.supabase)) cached.supabase = outside.supabase;
      }
    } catch { /* no data-folder copy */ }
  }
  return cached;
}

module.exports = { keys };
