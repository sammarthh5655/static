/**
 * Links and files from the operating system open in tabs (static as the
 * default browser, "Open with static", a second launch with an address).
 * Off-screen. The parsing rules themselves are unit tested in
 * tests/system-open.test.cjs; this checks they reach real tabs.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (name, ok, detail) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + name + (detail !== undefined ? ' :: ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 160) : ''));
    if (!ok) fails++;
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-systemopen-'));
  try {
    await wait(1200);
    const w = browser.front;
    const urls = () => w.tabs.order.map((id) => w.tabs.tabs.get(id).state.displayUrl || w.tabs.tabs.get(id).state.url || '');
    const before = w.tabs.order.length;

    const opened = browser.openFromSystem(['C:\\Program Files\\static\\static.exe', '--some-chromium-switch', 'http://systemopen.probe.test/one'], dir);
    await wait(600);
    check('a link from another app opens in a new tab', opened && w.tabs.order.length === before + 1, urls());
    check('and that tab is in front', /systemopen\.probe\.test\/one/.test(w.tabs.active?.state.url || w.tabs.active?.state.displayUrl || ''), w.tabs.active?.state);

    const page = path.join(dir, 'Local Page.html');
    fs.writeFileSync(page, '<!doctype html><title>Local page</title><p>from disk</p>');
    browser.openFromSystem(['Local Page.html'], dir);
    for (let i = 0; i < 30 && !/Local page/.test(w.tabs.active?.state.title || ''); i++) await wait(150);
    check('a local page opens through the file token scheme, never file://',
      /^static-file:\/\//.test(w.tabs.active?.view.webContents.getURL() || ''), w.tabs.active?.view.webContents.getURL());
    check('and shows the page', /Local page/.test(w.tabs.active?.state.title || ''), w.tabs.active?.state.title);

    const count = w.tabs.order.length;
    const refused = browser.openFromSystem(['javascript:alert(1)', 'browser://settings', 'data:text/html,x', path.join(dir, 'missing.html')], dir);
    await wait(300);
    check('anything else opens nothing', refused === false && w.tabs.order.length === count, { refused, tabs: w.tabs.order.length });

    const several = browser.openFromSystem(['http://systemopen.probe.test/a', 'http://systemopen.probe.test/b'], dir);
    await wait(500);
    check('several links open as several tabs, the first in front',
      several && w.tabs.order.length === count + 2 && /\/a$/.test(w.tabs.active?.state.url || w.tabs.active?.state.displayUrl || ''), urls().slice(-2));
  } catch (error) {
    check('probe ran', false, error && error.stack ? error.stack : String(error));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
  app.exit(fails ? 1 : 0);
}

module.exports = { run };
