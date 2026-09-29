const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** The menu must open and render its items. */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 200) : ''));
    if (!ok) fails++;
  };

  try {
    browser.window.show();
    await wait(1600);

    const overlayErrors = [];
    const chromeErrors = [];
    if (browser.overlay) {
      browser.overlay.webContents.on('console-message', (e) => {
        if (e?.level === 'error' || e?.level === 3) overlayErrors.push(String(e.message).slice(0, 200));
      });
    }
    browser.chrome.webContents.on('console-message', (e) => {
      if (e?.level === 'error' || e?.level === 3) chromeErrors.push(String(e.message).slice(0, 200));
    });

    check('the overlay view exists', !!browser.overlay);
    check('the overlay reported ready', browser.overlayReady === true,
      'overlayReady=' + browser.overlayReady);

    // Click the menu button the way a person does.
    await browser.chrome.webContents.executeJavaScript(`(function(){
      var b = document.getElementById('app-menu');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await wait(1600);

    const overlay = browser.overlay
      ? await browser.overlay.webContents.executeJavaScript(`({
          items: document.querySelectorAll('.menu-item').length,
          tiles: document.querySelectorAll('.menu-tile').length,
          zoom: !!document.querySelector('.menu-zoom output'),
          footer: document.querySelectorAll('.menu-footer button').length,
          brand: !!document.querySelector('.menu-brand'),
          brandText: (document.querySelector('.menu-brand span')||{}).textContent || '',
          root: !!document.getElementById('menu-root'),
          rootChildren: (document.getElementById('menu-root')||{children:[]}).children.length,
          bodyHTML: document.body.innerHTML.length,
        })`).catch((e) => ({ error: e.message }))
      : { error: 'no overlay' };

    console.log('  [diag] overlay', JSON.stringify(overlay));
    check('the menu rendered items', overlay.items >= 4 && overlay.tiles === 8 && overlay.zoom && overlay.footer === 4, JSON.stringify(overlay));
    {
      const fs = require('node:fs');
      const path = require('node:path');
      const dir = path.join(require('electron').app.getAppPath(), 'shots');
      fs.mkdirSync(dir, { recursive: true });
      await new Promise((r) => setTimeout(r, 700));
      const img = await browser.overlay.webContents.capturePage().catch(() => null);
      if (img) fs.writeFileSync(path.join(dir, 'main-menu.png'), img.toPNG());
    }
    check('the brand row is there', overlay.brand === true);
    check('it names the profile', /profile|switch/i.test(overlay.brandText), overlay.brandText);
    check('the overlay is interactive', browser.overlayInteractive === true,
      'overlayInteractive=' + browser.overlayInteractive);

    check('no overlay errors', overlayErrors.length === 0, overlayErrors.join(' | '));
    check('no chrome errors', chromeErrors.length === 0, chromeErrors.join(' | '));
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }
  console.log(fails ? '\nFAILURES: ' + fails : '\nall menu checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
