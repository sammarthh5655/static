const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * macOS packaging and platform handling.
 *
 * These guard the things that made the browser unusable on a Mac: a window
 * with no close button, and no copy/paste. Both were invisible on Windows,
 * which is exactly why they need a test rather than a memory.
 */

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('macOS keeps its real traffic lights', () => {
  const source = read('src/main/application.js');
  // frame:false removes the traffic lights on macOS, leaving no way to close
  // the window.
  assert.match(source, /titleBarStyle:\s*'hiddenInset'/,
    'macOS must use hiddenInset, not frame:false');
  assert.match(source, /trafficLightPosition/,
    'and position them inside our own chrome');
  assert.match(source, /process\.platform === 'darwin'/,
    'the choice is made per platform');
});

test('the browser does not draw a second set of window buttons on macOS', () => {
  assert.match(read('src/renderer/chrome.css'),
    /body\.mac\s+\.window-controls\s*\{\s*display:\s*none/,
    'our own controls are hidden where the OS provides real ones');
});

test('macOS gets an application menu, so copy and paste work', () => {
  const source = read('src/main/main.js');
  // On macOS the edit commands are MENU ITEMS. Clearing the menu breaks
  // Cmd+C, Cmd+V, Cmd+Q and Cmd+H.
  assert.match(source, /Menu\.buildFromTemplate/, 'a menu is built');
  for (const role of ['copy', 'paste', 'cut', 'selectAll', 'quit', 'hide']) {
    assert.ok(source.includes("role: '" + role + "'"), role + ' is available');
  }
  assert.match(source, /Menu\.setApplicationMenu\(null\)/,
    'and Windows and Linux still get no native menu');
});

test('the Mac build covers every current Mac', () => {
  const mac = pkg.build.mac;
  assert.ok(mac, 'a mac target is declared');
  for (const target of mac.target) {
    assert.ok(target.arch.includes('universal'),
      target.target + ' is universal, so Apple Silicon and Intel both work');
  }
  assert.equal(mac.extendInfo.LSMinimumSystemVersion, '11.0');
});

test('the hardened runtime is on and has what Electron needs', () => {
  const mac = pkg.build.mac;
  // Required for notarization on 10.15+.
  assert.equal(mac.hardenedRuntime, true);

  const entitlements = read(mac.entitlements);
  // Without allow-jit, V8 cannot compile and no page runs any script.
  assert.match(entitlements, /allow-jit/);
  assert.match(entitlements, /allow-unsigned-executable-memory/);
  assert.match(entitlements, /disable-library-validation/);
  assert.match(entitlements, /network\.client/);

  const inherit = read(mac.entitlementsInherit);
  assert.match(inherit, /com\.apple\.security\.inherit/,
    'child processes inherit the sandbox rather than declaring their own');
});

test('every protected resource the browser touches has a stated reason', () => {
  // macOS crashes rather than prompting when a reason is missing.
  const info = pkg.build.mac.extendInfo;
  for (const key of ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription',
                     'NSLocationWhenInUseUsageDescription',
                     'NSDownloadsFolderUsageDescription',
                     'NSDocumentsFolderUsageDescription']) {
    assert.ok(info[key] && info[key].length > 25,
      key + ' explains itself in a sentence a person would accept');
  }
});

test('macOS can offer Static as the default browser', () => {
  const types = pkg.build.mac.extendInfo.CFBundleURLTypes;
  assert.ok(Array.isArray(types) && types.length, 'URL types are declared');
  const schemes = types[0].CFBundleURLSchemes;
  assert.ok(schemes.includes('http') && schemes.includes('https'),
    'without http and https, macOS never lists it as a browser');
});

test('an unsigned local build still produces a runnable app', () => {
  // A missing certificate must not fail the whole build.
  assert.equal(pkg.build.mac.identity, null);
  assert.equal(pkg.build.mac.gatekeeperAssess, false);
});

test('the generated preloads are built before packaging', () => {
  // They are gitignored and generated; packaging without them ships a browser
  // whose tabs have no preload at all.
  assert.equal(pkg.scripts.prepack, 'npm run build');
});

test('nothing in the shipped source assumes Windows', () => {
  const walk = (dir, hits) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, hits); continue; }
      if (!entry.name.endsWith('.js')) continue;
      // Generated, and full of unrelated text.
      if (entry.name === 'youtube-bundle.js') continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const pattern of [/\bC:\\/, /process\.env\.APPDATA/, /cmd \/c/, /powershell/i]) {
        if (pattern.test(text)) hits.push(path.relative(root, full) + ' :: ' + pattern);
      }
    }
  };
  const hits = [];
  walk(path.join(root, 'src'), hits);
  assert.deepEqual(hits, [], 'no Windows-only paths or commands in src/');
});
