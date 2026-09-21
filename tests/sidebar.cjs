const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const path = require('node:path');

/**
 * The sidebar setting must actually reach the sidebar. It was stored, offered
 * in three places in the UI, and read by nothing - so "On" did nothing.
 */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 140) : ''));
    if (!ok) fails++;
  };

  try {
    browser.window.show();
    await wait(1400);

    // ---- the setting must control it ------------------------------------
    browser.settings.update({ sidebarMode: 'off' });
    browser.applySidebarMode();
    await wait(500);
    check('off means closed', browser.sidebarOpen === false);
    check('and the toggle cannot reopen it while off',
      browser.toggleSidebar(true) === false && browser.sidebarOpen === false);

    browser.settings.update({ sidebarMode: 'on' });
    browser.applySidebarMode();
    await wait(900);
    check('ON actually opens the sidebar', browser.sidebarOpen === true);
    check('and a view really exists for it',
      !!browser.sidebar && !browser.sidebar.webContents.isDestroyed());

    // It must occupy real space on screen, not be open-but-zero-width.
    const bounds = browser.sidebar.getBounds();
    check('it has real width on screen', bounds.width > 100,
      JSON.stringify(bounds));
    check('and real height', bounds.height > 100, JSON.stringify(bounds));

    browser.settings.update({ sidebarMode: 'autohide' });
    browser.applySidebarMode();
    await wait(900);
    check('autohide starts hidden', browser.sidebarOpen === false);
    check('but the toggle can open it', browser.toggleSidebar(true) === true);
    browser.toggleSidebar(false);
    await wait(400);

    // Autohide must give a way BACK, or it is just "off" with extra steps.
    check('autohide creates the edge reveal strip',
      !!browser.edgeStrip && !browser.edgeStrip.webContents.isDestroyed());
    const strip = browser.edgeStrip.getBounds();
    const win = browser.window.getContentBounds();
    check('the strip is at the right edge',
      strip.x + strip.width >= win.width - 2, JSON.stringify(strip));
    check('and is narrow enough not to steal the page',
      strip.width <= 12, strip.width + 'px');

    check('reaching the edge reveals the sidebar',
      browser.peekSidebar(true) === true && browser.sidebarOpen === true);
    check('and leaving hides it again',
      browser.peekSidebar(false) === false && browser.sidebarOpen === false);

    // On and Off must not leave a stray strip behind.
    browser.settings.update({ sidebarMode: 'on' });
    browser.applySidebarMode();
    await wait(500);
    check('no edge strip outside autohide', !browser.edgeStrip);

    // ---- the rail --------------------------------------------------------
    browser.settings.update({ sidebarMode: 'on' });
    browser.applySidebarMode();
    await wait(1200);
    const wc = browser.sidebar.webContents;
    for (let i = 0; i < 40 && wc.isLoading(); i++) await wait(200);
    await wait(900);

    const errors = [];
    wc.on('console-message', (e) => {
      if (e?.level === 'error' || e?.level === 3) errors.push(String(e.message).slice(0, 160));
    });

    const rail = await wc.executeJavaScript(`({
      items: document.querySelectorAll('.side-rail-item').length,
      hasEdit: !!document.getElementById('rail-edit'),
      customiseHidden: document.getElementById('customise').hidden,
      hasAI: !!document.getElementById('transcript'),
    })`);
    check('the rail shows modes', rail.items >= 4, rail.items + ' modes');
    check('the AI panel is still there', rail.hasAI === true);
    check('customise is offered', rail.hasEdit === true);
    check('and is hidden until asked for', rail.customiseHidden === true);

    // Customising must persist through the validated settings path.
    browser.settings.update({ sidebarModes: ['ai', 'notes'] });
    browser.push();
    await wait(900);
    const after = await wc.executeJavaScript(`document.querySelectorAll('.side-rail-item').length`);
    check('the rail follows the saved choice', after === 2, after + ' modes after choosing 2');

    // A rail button must open a panel HERE, not navigate the browser away.
    browser.settings.update({ sidebarModes: null });
    browser.push();
    await wait(900);
    const urlBefore = browser.tabs.active?.state?.displayUrl || '';

    await wc.executeJavaScript(`(function(){
      var items = document.querySelectorAll('.side-rail-item');
      for (var i = 0; i < items.length; i++) {
        if (/shield/i.test(items[i].getAttribute('aria-label') || '')) { items[i].click(); return true; }
      }
      items[0].click();
      return true;
    })()`);
    await wait(1400);

    const panel = await wc.executeJavaScript(`({
      open: !document.getElementById('panel').hidden,
      rows: document.querySelectorAll('.side-panel-row').length,
      name: (document.querySelector('.side-panel-head strong')||{}).textContent || '',
      hasOpenLink: !!document.querySelector('.side-panel-open'),
    })`);
    check('a rail button opens a panel in the sidebar', panel.open === true, JSON.stringify(panel));
    check('the panel shows real figures', panel.rows >= 2, panel.rows + ' rows');
    check('and names the mode', panel.name.length > 0, panel.name);
    check('it offers the full page without forcing it', panel.hasOpenLink === true);
    check('the browser did NOT navigate away',
      (browser.tabs.active?.state?.displayUrl || '') === urlBefore,
      'was ' + urlBefore + ', now ' + (browser.tabs.active?.state?.displayUrl || ''));

    check('no sidebar page errors', errors.length === 0, errors.join(' | '));

    const dir = path.join(app.getAppPath(), 'shots');
    fs.mkdirSync(dir, { recursive: true });
    browser.settings.update({ sidebarModes: null });
    browser.push();
    await wait(1000);
    let img = null;
    for (let i = 0; i < 4 && !img; i++) { img = await wc.capturePage().catch(() => null); if (!img) await wait(700); }
    if (img) { fs.writeFileSync(path.join(dir, 'sidebar.png'), img.toPNG()); console.log('shot written'); }
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }

  console.log(fails ? '\nFAILURES: ' + fails : '\nall sidebar checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
