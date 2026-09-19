const { app, protocol, Menu } = require('electron');
const path = require('node:path');
app.setName('static');

// Test modes run against a throwaway profile so they never touch real user data.
const TEST_FLAGS = ['--smoke', '--smoke-store', '--shot', '--probe', '--appearance', '--ai', '--aipage', '--modes', '--homepage'];
const testFlag = !app.isPackaged && process.argv.find(arg => TEST_FLAGS.includes(arg));
if (testFlag) app.setPath('userData', path.join(app.getAppPath(), '.test-profile', testFlag.slice(2)));

app.enableSandbox();

// Every menu in this app is custom DOM drawn by the renderer. Electron installs
// a DEFAULT application menu when none is set, which would both show a native
// menu bar and bind its own accelerators, so clear it explicitly. Shortcuts are
// handled in src/main/shortcuts.js via before-input-event instead.
Menu.setApplicationMenu(null);

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
    else if (testFlag === '--homepage') await require('../../tests/homepage.cjs').run(browser);
    else if (testFlag === '--modes') await require('../../tests/modes.cjs').run(browser);
    else if (testFlag === '--aipage') await require('../../tests/aipage.cjs').run(browser);
    else if (testFlag === '--ai') await require('../../tests/ai.cjs').run(browser);
    else if (testFlag === '--appearance') await require('../../tests/appearance.cjs').run(browser);
    else if (testFlag) await require('../../tests/smoke.cjs').run(browser);
  }).catch(error => { console.error(error); app.exit(1); });
  app.on('second-instance', () => browser?.focus());
  app.on('activate', () => browser?.ensureWindow());
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' || testFlag) app.quit(); });
  app.on('before-quit', () => browser?.flush());
}
