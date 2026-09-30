const { app, protocol, Menu } = require('electron');
const path = require('node:path');
app.setName('static');
// Groups windows under one taskbar button and lets the Start-menu shortcut
// and a pinned icon find the running app. Matches build.appId.
if (process.platform === 'win32') app.setAppUserModelId('dev.staticbrowser.desktop');

// Test modes run against a throwaway profile so they never touch real user data.
// `--name` runs tests/name.cjs; a probe file existing is what makes it a flag,
// so a new probe cannot be forgotten in a list and launch a normal browser.
const PROBE_ALIASES = { '--shot': 'screenshot', '--smoke': 'smoke', '--smoke-store': 'smoke' };
function probeFile(arg) {
  if (!/^--[a-z][a-z0-9-]*$/.test(arg)) return null;
  const name = PROBE_ALIASES[arg] || arg.slice(2);
  const file = path.join(__dirname, '..', '..', 'tests', name + '.cjs');
  return require('node:fs').existsSync(file) ? file : null;
}
const testFlag = !app.isPackaged && process.argv.find(probeFile);
if (testFlag) {
  app.setPath('userData', path.join(app.getAppPath(), '.test-profile', testFlag.slice(2)));
  // Probes run while someone is using this machine: the window is kept
  // off-screen and unfocusable (see ensureWindow). Chromium would treat an
  // off-screen window as occluded and stop painting it, which breaks
  // screenshots and animation checks, so occlusion tracking is disabled.
  process.env.STATIC_OFFSCREEN = '1';
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
}

// Incognito is its own process with its own throwaway data folder: nothing
// it does can reach the normal profile, and everything it wrote is deleted
// when it closes. The single-instance lock is per data folder, so it runs
// beside the normal browser rather than being folded into it.
const incognito = process.argv.includes('--incognito');
if (incognito) {
  const fs = require('node:fs');
  const os = require('node:os');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'static-incognito-'));
  fs.writeFileSync(path.join(scratch, 'owner.pid'), String(process.pid));
  app.setPath('userData', scratch);
  process.env.STATIC_INCOGNITO = '1';
  const wipe = () => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ } };
  app.on('will-quit', wipe);
  process.on('exit', wipe);
}

const { sweepIncognito } = require('./incognito');
if (!testFlag) setTimeout(sweepIncognito, 5000);

app.enableSandbox();

/**
 * The application menu.
 *
 * Every menu in this app is custom DOM drawn by the renderer, so on Windows
 * and Linux the native menu is cleared entirely - Electron installs a default
 * one otherwise, which both shows a menu bar and binds its own accelerators.
 *
 * macOS is NOT the same case. The menu bar there belongs to the system, not to
 * the window, and clearing it takes the standard edit commands with it: Cmd+C,
 * Cmd+V, Cmd+X, Cmd+A, Cmd+Z, Cmd+Q and Cmd+H all stop working, because those
 * are menu items rather than key handlers. A Mac user cannot copy a URL or
 * quit the app.
 *
 * So macOS gets a minimal menu with the roles the system expects, and nothing
 * that duplicates our own in-window menus.
 */
if (process.platform === 'darwin') {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      // Without this, a Mac user cannot copy or paste anywhere in the browser.
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ]));
} else {
  Menu.setApplicationMenu(null);
}

// registerSchemesAsPrivileged may only be called once, before 'ready', and a
// later call replaces the earlier list - so both schemes must be declared here.
// 'crx' is required by electron-chrome-extensions for <browser-action-list>
// icons; 'browser' is our internal page scheme.
protocol.registerSchemesAsPrivileged([
  { scheme: 'browser', privileges: { standard: true, secure: true } },
  { scheme: 'crx', privileges: { bypassCSP: true } },
  // Stand-ins for $redirect filter rules. Chromium refuses to redirect a web
  // request to a data: URL, so they are served from a scheme of our own.
  { scheme: 'static-stub', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  // Files from this computer opened in a tab (dragged in). Serves only files
  // the person dropped - see features/tabs/local-files.js.
  { scheme: 'static-file', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) app.quit();
else {
  let browser;
  app.whenReady().then(async () => {
    const { BrowserApplication } = require('./application');
    browser = new BrowserApplication();
    await browser.start();
    if (testFlag) await require(probeFile(testFlag)).run(browser);
  }).catch(error => { console.error(error); app.exit(1); });
  /**
   * The dock menu, which macOS shows on right-click.
   *
   * A Mac user expects to start a new window without first bringing the app
   * forward; without this the dock icon offers only Quit and Options.
   */
  if (process.platform === 'darwin') {
    app.whenReady().then(() => {
      app.dock?.setMenu(Menu.buildFromTemplate([
        {
          label: 'New Tab',
          click: () => { browser?.focusWindow(); browser?.tabs?.create({}); },
        },
        {
          label: 'New Window',
          click: () => browser?.focusWindow(),
        },
      ]));
    });
  }

  app.on('second-instance', () => browser?.focusWindow());
  app.on('activate', () => browser?.focusWindow());
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' || testFlag || incognito) app.quit(); });
  app.on('before-quit', () => browser?.flush());
}
