const { app, protocol } = require('electron');
const path = require('node:path');
app.setName('static');

// Test modes run against a throwaway profile so they never touch real user data.
const TEST_FLAGS = ['--smoke', '--smoke-store', '--shot', '--probe'];
const testFlag = !app.isPackaged && process.argv.find(arg => TEST_FLAGS.includes(arg));
if (testFlag) app.setPath('userData', path.join(app.getAppPath(), '.test-profile', testFlag.slice(2)));

app.enableSandbox();

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
    else if (testFlag) await require('../../tests/smoke.cjs').run(browser);
  }).catch(error => { console.error(error); app.exit(1); });
  app.on('second-instance', () => browser?.focus());
  app.on('activate', () => browser?.ensureWindow());
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' || testFlag) app.quit(); });
  app.on('before-quit', () => browser?.flush());
}
