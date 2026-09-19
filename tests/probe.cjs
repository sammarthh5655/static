const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Diagnostic: load the chrome, the menu overlay and every internal page, then
 * report console errors and confirm each rendered. Run with `npm run test:probe`.
 *
 * Internal pages fail quietly - a CSP violation or a script error leaves a page
 * that still looks plausible but never applies its state - so this asserts no
 * console errors as well as "did it render".
 */
const PAGES = ['newtab', 'settings', 'history', 'bookmarks', 'downloads', 'extensions'];

function watch(wc, errors) {
  wc.on('console-message', (event) => {
    const text = event?.message ?? '';
    if ((event?.level === 'error' || event?.level === 3) && text) errors.push(text);
  });
}

async function run(browser) {
  const { app } = require('electron');
  let failures = 0;
  const report = (name, ok, errors = [], detail = '') => {
    if (ok && !errors.length) { console.log('  ok  ' + name + (detail ? ' (' + detail + ')' : '')); return; }
    failures++;
    console.log('FAIL  ' + name + (detail ? ' ' + detail : ''));
    errors.forEach((error) => console.log('        ' + error));
  };

  try {
    browser.window.show();

    const chromeErrors = [];
    watch(browser.chrome.webContents, chromeErrors);
    const overlayErrors = [];
    watch(browser.overlay.webContents, overlayErrors);
    await wait(1400);

    const chrome = await browser.chrome.webContents.executeJavaScript(`(() => ({
      titlebar: !!document.querySelector('.titlebar'),
      windowButtons: document.querySelectorAll('.window-btn').length,
      radius: getComputedStyle(document.documentElement).getPropertyValue('--radius').trim(),
      icons: document.querySelectorAll('.icon-svg').length,
    }))()`);
    report('chrome', chrome.titlebar && chrome.windowButtons === 3 && chrome.radius && chrome.icons > 0,
      chromeErrors, chrome.icons + ' icons, radius ' + chrome.radius);

    // The menu overlay: menus must render unclipped and fully opaque.
    // Wait for the overlay's own scripts to be live before asking for a menu -
    // clicking earlier races its load and the request is simply dropped.
    for (let attempt = 0; attempt < 30; attempt++) {
      const ready = await browser.overlay.webContents
        .executeJavaScript('!!(window.ui && window.browser)').catch(() => false);
      if (ready) break;
      await wait(120);
    }
    // Wait for the CHROME's own scripts too: clicking the button before its
    // handler is bound does nothing at all, which is not a menu failure.
    for (let attempt = 0; attempt < 30; attempt++) {
      const ready = await browser.chrome.webContents
        .executeJavaScript('!!(window.ui && window.theme && window.browser)')
        .catch(() => false);
      if (ready) break;
      await wait(120);
    }
    await browser.chrome.webContents.executeJavaScript(
      "document.getElementById('app-menu').click()");
    const readMenu = () => browser.overlay.webContents.executeJavaScript(`(() => {
      const node = document.querySelector('.menu');
      if (!node) return { rendered: false };
      const box = node.getBoundingClientRect();
      // Report whether the open animation has actually settled, rather than
      // the instantaneous opacity: sampling mid-flight reads ~0.99 and looks
      // like a failure when the menu is fine.
      const settled = node.getAnimations().every((a) => a.playState === 'finished');
      return {
        rendered: true,
        settled,
        fits: box.bottom <= innerHeight && box.right <= innerWidth && box.left >= 0,
        opacity: getComputedStyle(node).opacity,
        items: node.querySelectorAll('.menu-item').length,
        shortcuts: node.querySelectorAll('.menu-shortcut').length,
      };
    })()`);

    // Re-issue the click if no menu appeared: the very first request can be
    // dropped when the overlay has not painted yet, and a dropped request
    // otherwise looks identical to a broken menu.
    let menu = { rendered: false };
    for (let attempt = 0; attempt < 25; attempt++) {
      menu = await readMenu();
      if (menu.rendered && menu.opacity === '1') break;
      // Re-issue every few polls while nothing has rendered. The very first
      // click can land before the chrome has bound its handler or before the
      // overlay is listening, and a dropped request is indistinguishable from
      // a broken menu.
      if (!menu.rendered && attempt > 0 && attempt % 3 === 0) {
        await browser.chrome.webContents.executeJavaScript(
          "document.getElementById('app-menu')?.click()").catch(() => {});
      }
      await wait(120);
    }
    report('menu overlay', menu.rendered && menu.fits && menu.opacity === '1' &&
      menu.items > 0 && menu.shortcuts > 0, overlayErrors,
      menu.rendered
        ? JSON.stringify(menu)
        : 'did not render');
    await browser.overlay.webContents.executeJavaScript('window.ui.closeMenu()');
    await wait(400);

    for (const page of PAGES) {
      const errors = [];
      const id = browser.tabs.create({ url: 'browser://' + page });
      const wc = browser.tabs.tabs.get(id).view.webContents;
      watch(wc, errors);
      await wait(1200);
      const rendered = await wc.executeJavaScript(
        'document.body.innerText.trim().length > 0 && !!window.page');
      report(page, rendered, errors, rendered ? '' : 'did not render');
      browser.tabs.close(id);
    }

    console.log(failures ? '\n' + failures + ' check(s) failed.\n' : '\nAll pages render cleanly.\n');
    app.exit(failures ? 1 : 0);
  } catch (error) {
    console.error('Probe failed:', error);
    app.exit(1);
  }
}

module.exports = { run };
