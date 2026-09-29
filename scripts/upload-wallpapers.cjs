/**
 * Upload the built-in wallpapers to Static's wallpaper service and publish
 * them.
 *
 *   PowerShell:  $env:SUPABASE_SECRET_KEY = "<secret key>"; node scripts/upload-wallpapers.cjs
 *   bash/zsh:    SUPABASE_SECRET_KEY=<secret key> node scripts/upload-wallpapers.cjs
 *
 * The SECRET key (Supabase dashboard -> Project Settings -> API Keys ->
 * "Secret keys", or the legacy service_role key) is needed because the
 * browser's publishable key can only read. It is read from the environment
 * for this run only: never put it in a file in this project, and never in
 * src/main/secure/keys.js, which ships inside the app.
 *
 * Safe to run again: files are overwritten in place and rows re-published.
 */
const fs = require('node:fs');
const path = require('node:path');

const URL_BASE = process.env.SUPABASE_URL || 'https://nijfavitbnopaliqlblx.supabase.co';
const KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ROOT = path.join(__dirname, '..', 'src', 'renderer', 'assets');
const manifest = require('../src/shared/wallpapers.json');

if (!KEY || KEY.startsWith('sb_publishable_')) {
  console.error('Set SUPABASE_SECRET_KEY to the project\'s SECRET key first (the publishable key cannot upload).');
  process.exit(1);
}

const headers = (extra = {}) => ({
  apikey: KEY,
  ...(KEY.startsWith('eyJ') ? { authorization: 'Bearer ' + KEY } : {}),
  ...extra,
});

async function upload(local, remote) {
  const body = fs.readFileSync(path.join(ROOT, local));
  const response = await fetch(URL_BASE + '/storage/v1/object/wallpapers/' + remote, {
    method: 'POST',
    headers: headers({ 'content-type': 'image/jpeg', 'x-upsert': 'true', 'cache-control': 'max-age=31536000' }),
    body,
  });
  if (!response.ok) throw new Error(remote + ': ' + response.status + ' ' + (await response.text()).slice(0, 200));
}

(async () => {
  const done = [];
  for (const [index, w] of manifest.wallpapers.entries()) {
    const file = w.file.replace(/^wallpapers\//, 'v1/');
    const thumb = w.thumb.replace(/^wallpapers\//, 'v1/');
    try {
      await upload(w.file, file);
      await upload(w.thumb, thumb);
      done.push(w.id);
      console.log('[' + (index + 1) + '/' + manifest.wallpapers.length + '] ' + w.id);
    } catch (error) {
      console.error('failed: ' + error.message);
    }
  }
  if (!done.length) process.exit(1);
  const response = await fetch(URL_BASE + '/rest/v1/wallpapers?id=in.(' + done.map((id) => '"' + id + '"').join(',') + ')', {
    method: 'PATCH',
    headers: headers({ 'content-type': 'application/json', prefer: 'return=minimal' }),
    body: JSON.stringify({ published: true }),
  });
  if (!response.ok) {
    console.error('Uploaded, but publishing failed: ' + response.status + ' ' + (await response.text()).slice(0, 200));
    process.exit(1);
  }
  console.log('\nUploaded and published ' + done.length + ' of ' + manifest.wallpapers.length + ' wallpapers.');
})();
