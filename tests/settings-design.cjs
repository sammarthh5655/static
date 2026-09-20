const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(label, predicate) {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await wait(100);
  }
  throw new Error('Timed out: ' + label);
}

async function run(browser) {
  const { app } = require('electron');
  const output = path.join(app.getAppPath(), '.test-output');
  fs.mkdirSync(output, { recursive: true });
  browser.window.setSize(1400, 1000);
  browser.settings.update({ theme: 'neptune', radius: 'rounded', animations: false, sidebarMode: 'on' });
  browser.push();
  const id = browser.tabs.create({ url: 'browser://settings' });
  const wc = browser.tabs.tabs.get(id).view.webContents;
  const js = code => wc.executeJavaScript(code);
  const overlay = code => browser.overlay.webContents.executeJavaScript(code);
  await until('settings navigation', () => js("!!document.querySelector('[data-category=about]')").catch(() => false));
  assert.equal(await js("document.querySelectorAll('[data-category]').length"), 14);
  assert.equal(await js("document.querySelector('[data-section=start]').hidden"), false);
  assert.equal(await js("document.querySelector('.settings-brand img').naturalWidth > 0"), true);
  await wait(250);
  fs.writeFileSync(path.join(output, 'settings-reference-dark.png'), (await wc.capturePage()).toPNG());

  await js("document.querySelector('[data-category=appearance]').click(); const f = document.querySelector('#font'); f.value = 'serif'; f.dispatchEvent(new Event('change')); const a = document.querySelector('#accentCustom'); a.value = '#328afc'; a.dispatchEvent(new Event('change'));");
  await until('font persists', () => browser.settings.value.font === 'serif' && browser.settings.value.accentCustom === '#328afc');
  await until('font repaints all surfaces', async () => {
    for (const contents of [wc, browser.chrome.webContents, browser.overlay.webContents]) {
      if (!await contents.executeJavaScript("getComputedStyle(document.documentElement).getPropertyValue('--font').includes('Georgia') && getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#328afc'")) return false;
    }
    return true;
  });
  await js("const s = document.querySelector('#settings-search'); s.value = 'cookies'; s.dispatchEvent(new Event('input'));");
  assert.equal(await js("!document.querySelector('[data-section=privacy]').hidden && document.querySelector('[data-section=appearance]').hidden"), true);
  await js("document.querySelector('#settings-search').value = 'zzznomatch'; document.querySelector('#settings-search').dispatchEvent(new Event('input'));");
  assert.equal(await js("document.querySelector('#settings-no-results').hidden"), false);
  await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));");
  assert.equal(await js("document.querySelector('#settings-search').value"), '');
  wc.focus();
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'k', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
  await until('settings keyboard search', () => js("document.activeElement.id === 'settings-search'"));

  browser.settings.update({ homepage: 'browser://history', bookmarksBar: false }); browser.push();
  await js("document.querySelector('[data-category=reset]').click(); document.querySelector('[data-reset=appearance]').click();");
  assert.equal(await js("document.querySelector('#reset-dialog').open"), true);
  await js("document.querySelector('#reset-dialog button[value=cancel]').click()");
  assert.equal(browser.settings.value.font, 'serif');
  await js("document.querySelector('[data-reset=appearance]').click(); document.querySelector('#confirm-reset').click();");
  await until('confirmed appearance reset', () => browser.settings.value.font === 'system');
  assert.equal(browser.settings.value.homepage, 'browser://history');
  assert.equal(browser.settings.value.bookmarksBar, false);
  assert.equal(await js("window.browser.invoke('settings:reset', {scope: 'invalid'}).then(() => false, () => true)"), true);

  const openMenu = async () => {
    browser.window.focus();
    await browser.chrome.webContents.executeJavaScript("document.querySelector('#overflow').click()");
    await until('branded menu', () => overlay("!!document.querySelector('.menu.browser-menu .menu-brand img')"));
    await wait(120);
  };
  await openMenu();
  assert.equal(await overlay("document.querySelector('.menu-brand img').naturalWidth > 0"), true);
  fs.writeFileSync(path.join(output, 'browser-menu-reference.png'), (await browser.overlay.webContents.capturePage()).toPNG());
  await overlay("[...document.querySelectorAll('.menu-segment button')].find(button => button.textContent === 'Autohide').click()");
  await until('menu sidebar selection', () => browser.settings.value.sidebarMode === 'autohide');
  const dashboard = browser.tabs.create({ url: 'browser://dashboard' });
  const dashboardWC = browser.tabs.tabs.get(dashboard).view.webContents;
  await until('workspace follows sidebar preference', () => dashboardWC.executeJavaScript("document.body.dataset.sidebar === 'autohide'").catch(() => false));
  browser.settings.update({ sidebarMode: 'off' }); browser.push();
  await until('workspace sidebar hidden', () => dashboardWC.executeJavaScript("document.body.classList.contains('sidebar-collapsed')"));
  await dashboardWC.executeJavaScript("document.querySelector('.shell-toggle').click()");
  await until('workspace sidebar restored', () => browser.settings.value.sidebarMode === 'on');
  browser.tabs.select(id);
  await openMenu();
  browser.overlay.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'End' });
  await until('menu keyboard navigation', () => overlay("document.activeElement.textContent === 'Exit'"));
  browser.overlay.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await until('Escape dismisses overlay', () => !browser.overlayInteractive);

  // Section links survive browser:// -> loadFile translation.
  browser.tabs.navigate(id, 'browser://settings#about');
  await until('about deep link', () => js("location.hash === '#about' && document.querySelector('[data-section=about]')?.hidden === false").catch(() => false));
  assert.equal(await js("document.querySelector('#app-version').textContent"), 'Version ' + app.getVersion());
  await js("document.querySelector('[data-category=start]').click()");
  browser.settings.update({ theme: 'sun' }); browser.push();
  await until('light theme reaches settings', () => js("getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() === '#f2f3f5'"));
  // CSS state can update before Chromium presents the next compositor frame.
  await wait(300);
  fs.writeFileSync(path.join(output, 'settings-reference-light.png'), (await wc.capturePage()).toPNG());
  browser.window.setSize(720, 640);
  await wait(250);
  assert.equal(await js("document.documentElement.scrollWidth <= innerWidth && document.querySelector('.settings-main').scrollWidth <= document.querySelector('.settings-main').clientWidth"), true);
  fs.writeFileSync(path.join(output, 'settings-reference-compact.png'), (await wc.capturePage()).toPNG());
  browser.settings.update({ theme: 'neptune', sidebarMode: 'on', homepage: 'browser://newtab', bookmarksBar: true }); browser.push();
  console.log('  ok  branded menu, live fonts/colors, settings search, reset confirmation, sidebar modes, keyboard controls, deep links, light and compact layouts');
}
module.exports = { run };
