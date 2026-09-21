const { app, protocol, Menu } = require('electron');
const path = require('node:path');
app.setName('static');

// Test modes run against a throwaway profile so they never touch real user data.
const TEST_FLAGS = ['--smoke', '--smoke-store', '--shot', '--probe', '--appearance', '--ai', '--aipage', '--modes', '--homepage', '--shields', '--privacy', '--welcome', '--extract', '--planets', '--counters', '--picker', '--planetarium', '--sidebar', '--organise', '--bravejs', '--omnibox', '--menu', '--ytdeep', '--lists', '--adsites', '--stalecache', '--liveprofile', '--adshot', '--aispeed'];
TEST_FLAGS.push('--productivity');
const testFlag = !app.isPackaged && process.argv.find(arg => TEST_FLAGS.includes(arg));
if (testFlag) app.setPath('userData', path.join(app.getAppPath(), '.test-profile', testFlag.slice(2)));

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
]);

if (!app.requestSingleInstanceLock()) app.quit();
else {
  let browser;
  app.whenReady().then(async () => {
    const { BrowserApplication } = require('./application');
    browser = new BrowserApplication();
    await browser.start();
    if (testFlag === '--shot') await require('../../tests/screenshot.cjs').run(browser);
    else if (testFlag === '--probe') await require('../../tests/probe.cjs').run(browser);
    else if (testFlag === '--productivity') await require('../../tests/productivity.cjs').run(browser);
    else if (testFlag === '--privacy') await require('../../tests/privacy.cjs').run(browser);
    else if (testFlag === '--shields') await require('../../tests/shields.cjs').run(browser);
    else if (testFlag === '--homepage') await require('../../tests/homepage.cjs').run(browser);
    else if (testFlag === '--modes') await require('../../tests/modes.cjs').run(browser);
    else if (testFlag === '--aipage') await require('../../tests/aipage.cjs').run(browser);
    else if (testFlag === '--counters') await require('../../tests/counters.cjs').run(browser);
    else if (testFlag === '--planetarium') await require('../../tests/planetarium.cjs').run(browser);
    else if (testFlag === '--liveprofile') await require('../../tests/liveprofile.cjs').run(browser);
    else if (testFlag === '--adsites') await require('../../tests/adsites.cjs').run(browser);
    else if (testFlag === '--aispeed') await require('../../tests/aispeed.cjs').run(browser);
    else if (testFlag === '--adshot') await require('../../tests/adshot.cjs').run(browser);
    else if (testFlag === '--stalecache') await require('../../tests/stalecache.cjs').run(browser);
    else if (testFlag === '--lists') await require('../../tests/lists.cjs').run(browser);
    else if (testFlag === '--menu') await require('../../tests/menu.cjs').run(browser);
    else if (testFlag === '--organise') await require('../../tests/organise.cjs').run(browser);
    else if (testFlag === '--ytdeep') await require('../../tests/ytdeep.cjs').run(browser);
    else if (testFlag === '--omnibox') await require('../../tests/omnibox.cjs').run(browser);
    else if (testFlag === '--bravejs') await require('../../tests/bravejs.cjs').run(browser);
    else if (testFlag === '--sidebar') await require('../../tests/sidebar.cjs').run(browser);
    else if (testFlag === '--picker') await require('../../tests/picker.cjs').run(browser);
    else if (testFlag === '--planets') await require('../../tests/planets.cjs').run(browser);
    else if (testFlag === '--extract') await require('../../tests/extract.cjs').run(browser);
    else if (testFlag === '--welcome') await require('../../tests/welcome.cjs').run(browser);
    else if (testFlag === '--ai') await require('../../tests/ai.cjs').run(browser);
    else if (testFlag === '--appearance') await require('../../tests/appearance.cjs').run(browser);
    else if (testFlag) await require('../../tests/smoke.cjs').run(browser);
  }).catch(error => { console.error(error); app.exit(1); });
  app.on('second-instance', () => browser?.focusWindow());
  app.on('activate', () => browser?.focusWindow());
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' || testFlag) app.quit(); });
  app.on('before-quit', () => browser?.flush());
}
