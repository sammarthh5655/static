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

/**
 * electron-builder.config.cjs as a build would see it, with `env` set and
 * every signing, notarization and update variable cleared first - so these
 * tests describe a plain, unsigned build unless they say otherwise.
 */
const CONFIG = path.join(root, 'electron-builder.config.cjs');
const BUILD_VARS = /^(STATIC_|CSC_|WIN_CSC_|APPLE_|AZURE_)/;
function loadConfig(env = {}) {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (BUILD_VARS.test(key)) delete process.env[key];
  Object.assign(process.env, env);
  delete require.cache[require.resolve(CONFIG)];
  try { return require(CONFIG); } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    delete require.cache[require.resolve(CONFIG)];
  }
}
const build = loadConfig();

test('macOS keeps its real traffic lights', () => {
  // Every window is made in one place (AppWindow), so every window keeps them.
  const source = read('src/main/window.js');
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
  const mac = build.mac;
  assert.ok(mac, 'a mac target is declared');
  for (const target of mac.target) {
    assert.ok(target.arch.includes('universal'),
      target.target + ' is universal, so Apple Silicon and Intel both work');
  }
  // Electron's own Info.plist states the oldest macOS it runs on (13 for
  // Electron 44). Overriding it with an older one let Macs that cannot run
  // static install it.
  assert.equal(mac.extendInfo.LSMinimumSystemVersion, undefined);
  assert.equal(mac.minimumSystemVersion, undefined);
});

test('the hardened runtime is on and has what Electron needs', () => {
  const mac = build.mac;
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
  const info = build.mac.extendInfo;
  for (const key of ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription',
                     'NSLocationWhenInUseUsageDescription',
                     'NSDownloadsFolderUsageDescription',
                     'NSDocumentsFolderUsageDescription']) {
    assert.ok(info[key] && info[key].length > 25,
      key + ' explains itself in a sentence a person would accept');
  }
});

test('macOS can offer Static as the default browser', () => {
  const types = build.mac.extendInfo.CFBundleURLTypes;
  assert.ok(Array.isArray(types) && types.length, 'URL types are declared');
  const schemes = types[0].CFBundleURLSchemes;
  assert.ok(schemes.includes('http') && schemes.includes('https'),
    'without http and https, macOS never lists it as a browser');
});

test('an unsigned local build still produces a runnable app', () => {
  // A missing certificate must not fail the whole build.
  assert.equal(build.mac.identity, null);
  assert.equal(build.mac.gatekeeperAssess, false);
  assert.equal(build.mac.notarize, false);
  // ...and is signed ad hoc after packaging: otherwise a downloaded copy is
  // "damaged and can't be opened", with no way past it.
  assert.ok(fs.existsSync(path.join(root, build.afterPack)), 'the afterPack hook exists');
  assert.ok(read(build.afterPack).includes("'codesign', ['--force', '--deep', '--sign', '-'"), 'ad-hoc codesign call present');
});

test('the Windows installer is per-user, one-click, per-architecture, and registers a browser', () => {
  const nsis = build.nsis;
  assert.equal(nsis.oneClick, true);
  assert.equal(nsis.perMachine, false, 'no administrator prompt');
  assert.equal(nsis.buildUniversalInstaller, false, 'x64 and arm64 are separate, smaller downloads');
  assert.deepEqual(build.win.target[0].arch, ['x64', 'arm64']);
  assert.equal(build.win.signAndEditExecutable, true, 'static.exe carries its own name and icon');
  const script = read(nsis.include);
  for (const key of ['StartMenuInternet', 'RegisteredApplications', 'URLAssociations', 'customUnInstall']) {
    assert.ok(script.includes(key), 'installer.nsh handles ' + key);
  }
});

test('the publisher shown to everyone is a name, never an email address', () => {
  assert.equal(build.extraMetadata.author.name, 'static');
  assert.doesNotMatch(String(pkg.author?.name || pkg.author || ''), /@/);
  assert.equal(loadConfig({ STATIC_PUBLISHER: 'Example Ltd' }).extraMetadata.author.name, 'Example Ltd');
});

test('updates are off without an address, and only ever over https', () => {
  assert.equal(build.publish, null, 'no address, no update file, no checks');
  const on = loadConfig({ STATIC_UPDATE_URL: 'https://example.com/download/' });
  assert.deepEqual(on.publish, [{ provider: 'generic', url: 'https://example.com/download/', channel: 'latest' }]);
  assert.equal(on.nsis.uninstallUrlInfoAbout, 'https://example.com', 'the site is linked from Apps & features');
  assert.throws(() => loadConfig({ STATIC_UPDATE_URL: 'http://example.com/download/' }), /https/);
  // This computer only, for testing the update path locally.
  assert.equal(loadConfig({ STATIC_UPDATE_URL: 'http://127.0.0.1:47321/' }).publish[0].url, 'http://127.0.0.1:47321/');
});

test('Windows signing switches on from whichever credentials are present', () => {
  assert.equal(build.win.azureSignOptions, undefined);
  assert.equal(build.win.signtoolOptions, undefined);
  const store = loadConfig({ STATIC_WIN_CERT_SHA1: 'AB cd:EF 12' });
  assert.equal(store.win.signtoolOptions.certificateSha1, 'ABcdEF12', 'a pasted thumbprint is cleaned');
  const azureVars = {
    AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's',
    STATIC_AZURE_ENDPOINT: 'https://eus.codesigning.azure.net', STATIC_AZURE_ACCOUNT: 'a', STATIC_AZURE_PROFILE: 'p',
  };
  const azure = loadConfig({ ...azureVars, STATIC_PUBLISHER: 'Example Ltd' });
  assert.equal(azure.win.azureSignOptions.certificateProfileName, 'p');
  assert.equal(azure.win.signtoolOptions, undefined, 'one signing method at a time');
});

test('signed builds record the signer\'s real name, or installed copies can never update', () => {
  // Installed copies accept an update only from the publisherName recorded
  // at build time. For a certificate, electron-builder reads it from the
  // certificate - so a default must NOT be filled in.
  const store = loadConfig({ STATIC_WIN_CERT_SHA1: 'ABCDEF' });
  assert.equal(store.win.signtoolOptions.publisherName, undefined, 'read from the certificate');
  assert.equal(loadConfig({ STATIC_WIN_CERT_SHA1: 'ABCDEF', STATIC_PUBLISHER: 'Example Ltd' }).win.signtoolOptions.publisherName, 'Example Ltd');
  // Azure cannot be read, so the name is required.
  assert.throws(() => loadConfig({
    AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's',
    STATIC_AZURE_ENDPOINT: 'https://eus.codesigning.azure.net', STATIC_AZURE_ACCOUNT: 'a', STATIC_AZURE_PROFILE: 'p',
  }), /STATIC_PUBLISHER/);
});

test('the Arm64 installer refuses an x64 PC before it changes anything', () => {
  const script = read('build/installer.nsh');
  assert.match(script, /!macro customInit[\s\S]*!ifdef APP_ARM64[\s\S]*\$\{IfNot\} \$\{IsNativeARM64\}[\s\S]*Quit/);
});

test('the app ships only what it reads at runtime', () => {
  assert.ok(build.files.includes('build/*.preload.cjs'));
  assert.ok(!build.files.includes('build/**/*'), 'installer artwork and scripts stay out of the app');
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
