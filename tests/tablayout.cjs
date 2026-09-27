const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const path = require('node:path');

/**
 * Tabs down the side and back, from the tab strip's own right-click menu,
 * and links dropped onto tabs. Runs off-screen.
 */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 220) : ''));
    if (!ok) fails++;
  };
  const shots = path.join(app.getAppPath(), 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const until = async (fn, tries = 40) => { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await wait(150); } return null; };

  try {
    browser.window.show();
    await wait(1200);
    browser.settings.update({ tabLayout: 'horizontal', verticalTabsCollapsed: false });
    browser.applyTabLayout();
    for (const extra of browser.tabs.order.slice(1)) browser.tabs.close(extra);
    browser.tabs.create({ url: 'browser://settings' });
    browser.tabs.create({ url: 'browser://history' });
    await wait(900);
    const chrome = browser.chrome.webContents;
    const topBefore = browser.chrome.getBounds().height;

    // The strip's own menu offers vertical tabs, with the explanation.
    await chrome.executeJavaScript(`(() => {
      const strip = document.querySelector('.strip-drag');
      const b = strip.getBoundingClientRect();
      strip.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 5, clientY: b.top + 5 }));
    })()`);
    await wait(300);
    const stripMenu = browser.lastMenu?.items || [];
    const vertical = stripMenu.find((i) => i.label === 'Show tabs vertically');
    check('right-clicking the tab strip offers "Show tabs vertically"', !!vertical, stripMenu.map((i) => i.label).join(' | '));
    check('with the reason to use it', /whole titles/.test(vertical?.hint || ''), vertical?.hint);
    browser.lastMenu = null;

    // Choose it, exactly as the overlay would.
    browser.settings.update(vertical.action.payload);
    browser.applyTabLayout();
    const panel = await until(async () => browser.vtabs && !browser.vtabs.webContents.isLoading() &&
      await browser.vtabs.webContents.executeJavaScript(`document.querySelectorAll('.vt-tab').length`).catch(() => 0));
    browser.push();
    await wait(600);
    const vb = browser.vtabs.getBounds();
    const tb = browser.tabs.active.view.getBounds();
    const topAfter = browser.chrome.getBounds().height;
    check('tabs move to a list down the left edge', vb.x === 0 && vb.width === 248 && tb.x === 248, JSON.stringify({ vb, tb }));
    check('and the top bar gives back the strip\'s height', topAfter === topBefore - 40, topBefore + ' -> ' + topAfter);
    const rows = await browser.vtabs.webContents.executeJavaScript(
      `[...document.querySelectorAll('.vt-tab .vt-title')].map(n => n.textContent)`);
    check('every tab is listed with its whole title', rows.length === browser.tabs.order.length, JSON.stringify(rows) + ' / ' + panel);
    await wait(300);
    const shot = await browser.vtabs.webContents.capturePage().catch(() => null);
    if (shot) fs.writeFileSync(path.join(shots, 'vertical-tabs.png'), shot.toPNG());

    // A link dropped on empty space opens a new tab; on a tab, it goes there.
    const before = browser.tabs.order.length;
    await browser.vtabs.webContents.executeJavaScript(`(() => {
      const dt = new DataTransfer();
      dt.setData('text/uri-list', 'https://example.com/dropped');
      const list = document.getElementById('list');
      list.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 100, clientY: 600 }));
    })()`);
    await wait(700);
    check('a link dropped below the tabs opens in a new tab', browser.tabs.order.length === before + 1);
    const targetId = browser.tabs.order[0];
    await browser.vtabs.webContents.executeJavaScript(`(() => {
      const dt = new DataTransfer();
      dt.setData('text/uri-list', 'https://example.org/onto-tab');
      const row = document.querySelector('.vt-tab[data-id="${targetId}"]');
      row.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    })()`);
    await wait(700);
    const landed = browser.tabs.tabs.get(targetId)?.state.displayUrl;
    check('a link dropped onto a tab opens in that tab', /example\.org\/onto-tab/.test(landed || ''), landed);

    // Right-click in the list: the menu is offset into window coordinates.
    await browser.vtabs.webContents.executeJavaScript(`(() => {
      const row = document.querySelector('.vt-tab');
      const b = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 20, clientY: b.top + 10 }));
    })()`);
    await wait(300);
    const vmenu = browser.lastMenu;
    check('the vertical list has its own menu, including "Show tabs horizontally"',
      (vmenu?.items || []).some((i) => i.label === 'Show tabs horizontally'), (vmenu?.items || []).map((i) => i.label).join(' | '));
    check('drawn where the pointer is, in window coordinates', vmenu && vmenu.anchor.top >= vb.y, JSON.stringify(vmenu?.anchor));

    // Fold to icons.
    browser.settings.update({ verticalTabsCollapsed: true });
    browser.layout();
    check('folding shrinks the list to favicons', browser.vtabs.getBounds().width === 56 && browser.tabs.active.view.getBounds().x === 56);

    // And back.
    browser.settings.update({ tabLayout: 'horizontal', verticalTabsCollapsed: false });
    browser.applyTabLayout();
    await wait(300);
    check('horizontal again: the list is gone and the strip is back',
      !browser.vtabs && browser.chrome.getBounds().height === topBefore && browser.tabs.active.view.getBounds().x === 0);

    // Links dropped on the horizontal strip.
    const count = browser.tabs.order.length;
    await chrome.executeJavaScript(`(() => {
      const dt = new DataTransfer();
      dt.setData('text/uri-list', 'https://example.net/strip');
      document.getElementById('newtab').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    })()`);
    await wait(700);
    check('a link dropped on the + button opens a new tab', browser.tabs.order.length === count + 1);
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }
  console.log(fails ? '\nFAILURES: ' + fails : '\nall tab layout checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
