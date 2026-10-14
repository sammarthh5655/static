/**
 * Make a release folder to upload to the static website.
 *
 *   npm run release                       build for this computer, then assemble
 *   npm run release -- --skip-build       assemble from what is already in dist/
 *   npm run release -- --mac-notarized    say the Mac build in dist/ was notarized
 *   npm run release -- --win-signed       say the Windows build in dist/ was signed
 *                                         (detected automatically on Windows)
 *
 * Windows installers are built on Windows and the Mac disk image on a Mac
 * (or by .github/workflows/release.yml); copy the other platform's files into
 * dist/ and run with --skip-build to put them all in one release.
 *
 * release/ then holds, ready to upload as one folder:
 *
 *   index.html                    the download page (no outside files, works anywhere)
 *   static-setup.exe              Windows, x64 - stable name for "Download" buttons
 *   static-setup-arm64.exe        Windows on Arm
 *   static.dmg                    Mac, Apple Silicon and Intel
 *   static-<version>-...          the same files under their versioned names,
 *   latest.yml, latest-mac.yml    which automatic updates read (only when built
 *   *.blockmap                    with STATIC_UPDATE_URL - see docs/releasing.md)
 *   SHA256SUMS.txt, downloads.json
 *
 * Upload the whole folder to the address in STATIC_UPDATE_URL, e.g.
 * https://example.com/download/, and link "Download" to index.html there.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(ROOT, 'release');
const args = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;

/** Run one of our own Node scripts, without a shell. */
function run(script, scriptArgs = []) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...scriptArgs], { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

if (!args.includes('--skip-build')) {
  run('build.cjs');
  const platform = process.platform === 'win32' ? '--win' : process.platform === 'darwin' ? '--mac' : '--linux';
  // A fresh dist/: a release must never pick up installers of another version.
  fs.rmSync(DIST, { recursive: true, force: true });
  run('dist.cjs', [platform, '--publish', 'never']);
}

/* ---- what was built ---- */
const exists = (name) => fs.existsSync(path.join(DIST, name));
const files = {
  winX64: `static-${version}-setup-x64.exe`,
  winArm64: `static-${version}-setup-arm64.exe`,
  dmg: `static-${version}-mac-universal.dmg`,
  macZip: `static-${version}-mac-universal.zip`,
};
const found = Object.fromEntries(Object.entries(files).filter(([, name]) => exists(name)));
if (!Object.keys(found).length) {
  console.error(`Nothing to release: no static ${version} installers in dist/. Build first, or check package.json's version.`);
  process.exit(1);
}

/* ---- is it signed? (decides the help shown on the page) ---- */
function windowsSigned(file) {
  if (process.platform !== 'win32') return args.includes('--win-signed');
  try {
    const status = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}').Status`], { encoding: 'utf8' }).trim();
    return status === 'Valid';
  } catch { return false; }
}
const winSigned = found.winX64 ? windowsSigned(path.join(DIST, found.winX64)) : false;
const macNotarized = args.includes('--mac-notarized');

/*
 * A signed build must record the name its signer actually has: installed
 * copies accept an update only from that name (electron-updater checks the
 * signature against publisherName in app-update.yml). A mismatch cannot be
 * fixed later - the wrong name is inside every copy already installed - so
 * it stops the release here instead.
 */
if (winSigned && process.platform === 'win32') {
  const feed = path.join(DIST, 'win-unpacked', 'resources', 'app-update.yml');
  if (fs.existsSync(feed)) {
    const lines = fs.readFileSync(feed, 'utf8').split(/\r?\n/);
    const at = lines.findIndex((line) => /^publisherName:/.test(line));
    const names = [];
    for (let i = at + 1; at >= 0 && i < lines.length && /^\s+-\s*/.test(lines[i]); i++) {
      names.push(lines[i].replace(/^\s+-\s*/, '').replace(/^['"]|['"]$/g, '').trim());
    }
    let signer = '';
    try {
      const exe = path.join(DIST, 'win-unpacked', 'static.exe').replace(/'/g, "''");
      signer = execFileSync('powershell', ['-NoProfile', '-Command',
        `(Get-AuthenticodeSignature -LiteralPath '${exe}').SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)`],
      { encoding: 'utf8' }).trim();
    } catch { /* reported below */ }
    if (!signer || (names.length && !names.includes(signer))) {
      console.error(`\nSTOP: installed copies would only accept updates signed by ${JSON.stringify(names)}, but this build is signed by ${JSON.stringify(signer)}.`);
      console.error('Set STATIC_PUBLISHER to the exact name on the certificate (or leave it unset for a certificate file or token) and build again.');
      process.exit(1);
    }
  }
}

// When the website folder is known, the page links there in full, so it
// works wherever it is put; otherwise its links are relative to its folder.
const base = (process.env.STATIC_UPDATE_URL || '').trim().replace(/\/?$/, '/');

/* ---- assemble ---- */
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const copy = (from, to = from) => { fs.copyFileSync(path.join(DIST, from), path.join(OUT, to)); return to; };
const sha256 = (file) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
});

const stable = { winX64: 'static-setup.exe', winArm64: 'static-setup-arm64.exe', dmg: 'static.dmg' };
const downloads = {};

(async () => {
  for (const [key, name] of Object.entries(found)) {
    copy(name);
    for (const extra of [name + '.blockmap']) if (exists(extra)) copy(extra);
    if (stable[key]) copy(name, stable[key]);
    const bytes = fs.statSync(path.join(OUT, name)).size;
    downloads[key] = { file: name, stable: stable[key] || null, bytes, sha256: await sha256(path.join(OUT, name)) };
  }
  // Update feeds: written by electron-builder only when built with STATIC_UPDATE_URL.
  const feeds = ['latest.yml', 'latest-mac.yml'].filter(exists);
  feeds.forEach((feed) => copy(feed));

  const sums = Object.values(downloads).flatMap((d) => [`${d.sha256}  ${d.file}`, ...(d.stable ? [`${d.sha256}  ${d.stable}`] : [])]);
  fs.writeFileSync(path.join(OUT, 'SHA256SUMS.txt'), sums.join('\n') + '\n');

  const manifest = {
    name: 'static',
    version,
    released: new Date().toISOString().slice(0, 10),
    signed: { windows: winSigned, macNotarized },
    publisher: (process.env.STATIC_PUBLISHER || '').trim() || 'static',
    updates: feeds.length > 0,
    base: /^https?:\/\//.test(base) ? base : null,
    downloads,
  };
  fs.writeFileSync(path.join(OUT, 'downloads.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT, 'index.html'), page(manifest));

  /* ---- report ---- */
  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
  console.log(`\nrelease/ for static ${version}:`);
  for (const [key, d] of Object.entries(downloads)) console.log(`  ${key.padEnd(9)} ${d.file.padEnd(40)} ${mb(d.bytes).padStart(9)}  ${d.stable ? 'also as ' + d.stable : ''}`);
  console.log(`  updates    ${feeds.length ? feeds.join(', ') : 'OFF - built without STATIC_UPDATE_URL, so installed copies will not update themselves'}`);
  console.log(`  windows    ${found.winX64 ? (winSigned ? 'signed' : 'NOT signed - Smart App Control will block it; others see a SmartScreen warning') : 'not in this release'}`);
  console.log(`  mac        ${found.dmg ? (macNotarized ? 'notarized' : 'NOT notarized - people must allow it in System Settings') : 'not in this release (build it on a Mac or with the release workflow)'}`);
  console.log('\nUpload everything in release/ to one folder on your website' + (manifest.base ? ' (' + manifest.base + ')' : '') + ',');
  console.log('installers first and latest*.yml last. Keep the .blockmap files of earlier versions');
  console.log('there: installed copies use them to download only what changed.');
})().catch((error) => { console.error(error); process.exit(1); });

/* ---- the download page ---------------------------------------------------- */

function page(m) {
  const mark = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'assets', 'static-mark.svg'), 'utf8').replace(/<\?xml[^>]*>/, '');
  const data = JSON.stringify(m).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Download static</title>
<meta name="description" content="static ${m.version}: a fast, private web browser with real Chrome extensions. For Windows and Mac.">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<style>
  :root { --bg: #f6f9fd; --card: #ffffff; --text: #0d1b2e; --dim: #4b5d73; --faint: #7b8ba0; --line: #dfe7f1; --accent: #1764ef; --accent2: #00baff; --code: #eef3f9; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0a1018; --card: #111a26; --text: #e7eef7; --dim: #a3b4c8; --faint: #6f8199; --line: #1f2c3d; --accent: #4d8dff; --accent2: #3fd0ff; --code: #0d1520; } }
  * { box-sizing: border-box; }
  html { background: var(--bg); }
  body { margin: 0; min-height: 100vh; color: var(--text); font: 16px/1.55 -apple-system, "Segoe UI", system-ui, sans-serif; padding: 0 20px;
         background: radial-gradient(ellipse 900px 520px at 50% -120px, color-mix(in srgb, var(--accent2) 18%, transparent), transparent) no-repeat, var(--bg); }
  main { max-width: 760px; margin: 0 auto; padding: 56px 0 64px; }
  header { text-align: center; }
  header svg { width: 64px; height: 64px; }
  h1 { font-size: clamp(30px, 6vw, 42px); letter-spacing: -0.03em; margin: 10px 0 6px; }
  .lede { color: var(--dim); margin: 0 auto; max-width: 30em; }
  .primary { margin: 34px auto 10px; text-align: center; }
  .button { display: inline-flex; align-items: center; gap: 10px; padding: 15px 26px; border-radius: 14px; font-weight: 650; font-size: 17px; text-decoration: none; color: #fff;
            background: linear-gradient(135deg, var(--accent2), var(--accent)); box-shadow: 0 10px 30px color-mix(in srgb, var(--accent) 30%, transparent); }
  .button:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 45%, transparent); outline-offset: 3px; }
  .meta { color: var(--faint); font-size: 13.5px; margin-top: 10px; }
  .others { text-align: center; font-size: 14.5px; color: var(--dim); }
  .others a { color: var(--accent); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; margin-top: 40px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 18px 20px; }
  .card h2 { font-size: 16px; margin: 0 0 8px; }
  .card ol { margin: 0; padding-left: 20px; color: var(--dim); font-size: 14.5px; }
  .card p { color: var(--dim); font-size: 14.5px; margin: 6px 0 0; }
  .note { border-left: 3px solid var(--accent); }
  details { margin-top: 28px; background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 14px 20px; }
  summary { cursor: pointer; font-weight: 600; }
  .sums { overflow-x: auto; }
  code { font: 12.5px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; background: var(--code); padding: 2px 6px; border-radius: 6px; word-break: break-all; }
  table { border-collapse: collapse; width: 100%; font-size: 13.5px; margin-top: 10px; }
  td { padding: 8px 6px; border-top: 1px solid var(--line); vertical-align: top; }
  footer { text-align: center; color: var(--faint); font-size: 13px; margin-top: 36px; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <header>
    ${mark}
    <h1>static</h1>
    <p class="lede">A fast, private web browser with real Chrome extensions.</p>
  </header>

  <div class="primary">
    <a class="button" id="get" href="#">Download static</a>
    <div class="meta" id="meta"></div>
  </div>
  <p class="others" id="others"></p>

  <div class="grid" id="steps"></div>

  <details>
    <summary>Check your download (SHA-256)</summary>
    <p style="color:var(--dim);font-size:14px">Each file's fingerprint. If yours matches, it is exactly the file published here.</p>
    <div class="sums"><table id="sums"></table></div>
  </details>

  <footer id="footer"></footer>
</main>
<script>
(async () => {
  const m = ${data};
  const $ = (id) => document.getElementById(id);
  const d = m.downloads;
  const mb = (n) => (n / 1048576).toFixed(0) + ' MB';
  const href = (x) => (m.base ? new URL(x.stable || x.file, m.base).href : (x.stable || x.file));
  const options = [];
  if (d.winX64) options.push({ id: 'win', label: 'Windows', item: d.winX64 });
  if (d.winArm64) options.push({ id: 'winarm', label: 'Windows on Arm', item: d.winArm64 });
  if (d.dmg) options.push({ id: 'mac', label: 'Mac', item: d.dmg });

  // Which computer is this? Chromium browsers can say whether Windows is on
  // Arm; the others cannot, and the x64 version runs on Arm as well.
  let os = /Mac/.test(navigator.platform) && navigator.maxTouchPoints < 2 ? 'mac' : /Win/.test(navigator.platform) ? 'win' : '';
  try {
    const hints = await navigator.userAgentData?.getHighEntropyValues(['platform', 'architecture']);
    if (hints?.platform === 'macOS') os = 'mac';
    if (hints?.platform === 'Windows') os = hints.architecture === 'arm' ? 'winarm' : 'win';
  } catch {}
  let pick = options.find((o) => o.id === os) || (os === 'winarm' && options.find((o) => o.id === 'win')) || null;

  const get = $('get');
  if (pick) {
    get.href = href(pick.item);
    get.textContent = 'Download for ' + pick.label;
    $('meta').textContent = 'Version ' + m.version + ' · ' + mb(pick.item.bytes) + (pick.id === 'mac' ? ' · Apple Silicon and Intel' : '');
  } else {
    get.hidden = true;
    // Only claim what this release actually has.
    $('meta').textContent = os === 'mac' && !d.dmg ? 'static for Mac is not available yet.'
      : (os === 'win' || os === 'winarm') && !d.winX64 && !d.winArm64 ? 'static for Windows is not available yet.'
        : 'Choose your computer below.';
  }
  $('others').innerHTML = '';
  const rest = options.filter((o) => o !== pick);
  if (rest.length) {
    $('others').append(pick ? 'Also for ' : 'Download for ');
    rest.forEach((o, i) => {
      if (i) $('others').append(i === rest.length - 1 ? ' and ' : ', ');
      const a = document.createElement('a');
      a.href = href(o.item);
      a.textContent = o.label + ' (' + mb(o.item.bytes) + ')';
      $('others').append(a);
    });
    $('others').append('.');
  }

  const card = (title, steps, extra, note) => {
    const el = document.createElement('section');
    el.className = 'card' + (note ? ' note' : '');
    el.innerHTML = '<h2></h2><ol></ol>';
    el.querySelector('h2').textContent = title;
    for (const s of steps) { const li = document.createElement('li'); li.textContent = s; el.querySelector('ol').append(li); }
    if (extra) { const p = document.createElement('p'); p.textContent = extra; el.append(p); }
    return el;
  };
  const steps = $('steps');
  const showWin = d.winX64 && (!pick || pick.id !== 'mac');
  const showMac = d.dmg && (!pick || pick.id === 'mac');
  if (showWin) {
    steps.append(card('Install on Windows', ['Open the file you downloaded.', 'static installs by itself in a few seconds - no questions, no administrator password.', 'static opens. To make it your default browser: Settings > Apps > Default apps > static.']));
    if (!m.signed.windows) steps.append(card('If Windows warns you', ['"Windows protected your PC": choose More info, then Run anyway.', 'If Smart App Control blocks it, this version cannot be installed on that PC yet.'], 'This release is not code-signed yet, which is why Windows asks.', true));
    // Signed, Windows can still ask while a new release builds its reputation.
    else steps.append(card('If Windows asks first', ['"Windows protected your PC": choose More info.', 'Check the publisher is ' + m.publisher + ', then choose Run anyway.'], 'New releases are sometimes checked like this for a short while.', true));
  }
  if (showMac) {
    steps.append(card('Install on Mac', ['Open the disk image you downloaded.', 'Drag static into Applications.', 'Open static from Applications or Launchpad.']));
    if (!m.signed.macNotarized) steps.append(card('If macOS will not open it', ['Choose Done on the message.', 'Open System Settings > Privacy & Security.', 'Next to "static was blocked", choose Open Anyway.'], 'This release is not notarized by Apple yet, which is why macOS asks once.', true));
  }

  const sums = $('sums');
  for (const item of Object.values(d)) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td></td><td><code></code></td>';
    tr.children[0].textContent = item.stable || item.file;
    tr.querySelector('code').textContent = item.sha256;
    sums.append(tr);
  }
  $('footer').textContent = ['static ' + m.version,
    d.winX64 ? 'Windows 10 and 11 (64-bit or Arm)' : '',
    d.dmg ? 'macOS 13 Ventura or later (Apple Silicon and Intel)' : ''].filter(Boolean).join(' · ');
})();
</script>
</body>
</html>
`;
}
