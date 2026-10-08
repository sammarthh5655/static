const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

/**
 * Every kind of menu Static draws, opened the way a person opens it where
 * that is practical (a real right-click, a real click), photographed and
 * measured: row heights, headings, separators, and anything clipped.
 *
 * Run it before and after a change to the menus and compare the pictures:
 *   STATIC_SHOT_TAG=before node scripts/start.cjs --menugallery
 * Pictures land in shots/menus/<tag>-<menu>.png. Runs off-screen.
 */
const PAGE = `<!doctype html><html><head><title>Gallery page</title>
<style>body{font:16px sans-serif;margin:0;padding:20px;height:1200px;background:#f4f1ea}</style></head>
<body><a id="link" href="/next" style="position:absolute;left:40px;top:40px">A link</a>
<p style="position:absolute;left:40px;top:200px">Plain text on a page</p></body></html>`;

async function run(browser) {
  const { app } = require('electron');
  const tag = (process.env.STATIC_SHOT_TAG || 'after').replace(/[^a-z0-9-]/gi, '');
  const dir = path.join(app.getAppPath(), 'shots', 'menus');
  fs.mkdirSync(dir, { recursive: true });
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 260) : ''));
    if (!ok) fails++;
  };
  const until = async (fn, tries = 40) => { for (let i = 0; i < tries; i++) { const v = await Promise.resolve().then(fn).catch(() => null); if (v) return v; await wait(120); } return null; };

  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const measured = {};

  const overlay = () => browser.overlay.webContents;
  const chrome = () => browser.chrome.webContents;
  const closeMenu = async () => {
    await overlay().executeJavaScript('window.ui.closeMenu(), true').catch(() => {});
    await until(() => overlay().executeJavaScript(`!document.querySelector('.menu')`));
    await wait(150);
  };
  const MEASURE = `(() => {
    const m = document.querySelector('.menu');
    if (!m) return null;
    const r = m.getBoundingClientRect();
    const h = (n) => Math.round(n.getBoundingClientRect().height * 10) / 10;
    const plain = [...m.querySelectorAll('.menu-item:not(.has-hint)')].map(h);
    const hinted = [...m.querySelectorAll('.menu-item.has-hint')].map(h);
    const headings = [...m.querySelectorAll('.menu-heading')].map(h);
    const dividers = [...m.querySelectorAll('.menu-divider')].map((n) => {
      const cs = getComputedStyle(n);
      return Math.round(n.getBoundingClientRect().height + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom));
    });
    const clipped = [...m.querySelectorAll('.menu-label, .menu-hint, .menu-tile-label, .menu-heading, .menu-segment button')]
      .filter((n) => n.scrollWidth > n.clientWidth + 1).map((n) => n.textContent.slice(0, 40));
    const item = m.querySelector('.menu-item .menu-label');
    return { x: r.left, y: r.top, w: Math.round(r.width), h: Math.round(r.height), plain, hinted, headings, dividers, clipped,
      scrolls: m.scrollHeight > m.clientHeight + 1, font: item ? getComputedStyle(item).fontSize : '' };
  })()`;

  /** Wait for the menu, let its entrance settle, photograph it, close it. */
  const shoot = async (name) => {
    const info = await until(() => overlay().executeJavaScript(MEASURE));
    if (!info) { check('the ' + name + ' menu opened', false); return null; }
    await wait(500);
    const settled = await overlay().executeJavaScript(MEASURE) || info;
    const pad = 14;
    const bounds = browser.overlay.getBounds();
    const x = Math.max(0, Math.floor(settled.x) - pad), y = Math.max(0, Math.floor(settled.y) - pad);
    const rect = { x, y, width: Math.min(bounds.width - x, settled.w + pad * 2), height: Math.min(bounds.height - y, settled.h + pad * 2) };
    const image = await overlay().capturePage(rect).catch(() => null);
    if (image) fs.writeFileSync(path.join(dir, tag + '-' + name + '.png'), image.toPNG());
    const avg = (list) => list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length * 10) / 10 : null;
    measured[name] = { w: settled.w, h: settled.h, row: avg(settled.plain), hintRow: avg(settled.hinted), heading: avg(settled.headings),
      divider: avg(settled.dividers), font: settled.font, clipped: settled.clipped, scrolls: settled.scrolls };
    console.log('  [menu] ' + name.padEnd(14) + JSON.stringify(measured[name]));
    await closeMenu();
    return settled;
  };

  /** A real right-click, through the input pipeline, on a view. */
  const rightClick = async (wc, x, y) => {
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    await wait(60);
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 });
  };
  const centre = (wc, selector) => wc.executeJavaScript(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return null;
    const b = n.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
  const openFromChrome = (items, opts = {}) => chrome().executeJavaScript(`window.browser.invoke('menu:open', ${JSON.stringify({
    items, anchor: opts.anchor || { left: 900, right: 900, top: 110, bottom: 110, width: 0, height: 0 }, align: opts.align || 'right', passive: !!opts.passive })})`);

  try {
    await wait(1500);
    browser.settings.update({ tabLayout: 'horizontal', bookmarksBar: true });
    browser.applyTabLayout?.();
    for (const extra of browser.tabs.order.slice(1)) browser.tabs.close(extra);
    const first = browser.tabs.active;
    browser.tabs.navigate(first.id, base + '/');
    const second = browser.tabs.create({ url: base + '/two', background: true });
    browser.tabs.create({ url: base + '/three', background: true });
    browser.bookmarks.toggle(base + '/', 'Gallery page');
    browser.push();
    await until(() => Promise.resolve(!first.view.webContents.isLoading() && first.view.webContents.getURL().startsWith(base)));
    await wait(800);

    // 1. The main menu, from its button.
    await chrome().executeJavaScript(`document.getElementById('app-menu').click(), true`);
    await shoot('main');

    // 2. A tab's menu: a real right-click on the second tab.
    let at = await centre(chrome(), `.tab[data-id="${second}"]`);
    await rightClick(chrome(), at.x, at.y);
    await shoot('tab');

    // 3. The empty strip.
    at = await centre(chrome(), '.strip-drag');
    await rightClick(chrome(), at.x, at.y);
    await shoot('strip');

    // 4. A group's chip, and the list of groups.
    const organizer = browser.productivity.organizer;
    if (organizer.assign) {
      await organizer.assign({ ids: [second], groupId: 'new', name: 'Research' });
      await wait(500);
      at = await centre(chrome(), '.tab-group-chip');
      if (at) { await rightClick(chrome(), at.x, at.y); await shoot('chip'); }
      await chrome().executeJavaScript(`window.browser.invoke('organizer:group-menu', { ids: [${JSON.stringify(first.id)}] })`).catch(() => {});
      await shoot('picker');
    }

    // 5. The page's own right-click menu.
    const page = first.view.webContents;
    for (let i = 0; i < 3; i++) { page.sendInputEvent({ type: 'mouseMove', x: 300 + i * 10, y: 400 }); await wait(120); }
    await rightClick(page, 320, 400);
    await shoot('page');

    // 6. The key in the address bar.
    browser.passwords.save_credential({ url: base, username: 'sam@example.com', password: 'gallery-Secret-1' });
    browser.passwords.save_credential({ url: base, username: 'kim@example.com', password: 'gallery-Secret-2' });
    await chrome().executeJavaScript(`(() => { const b = document.getElementById('key').getBoundingClientRect();
      window.browser.invoke('passwords:key-menu', { anchor: { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height } }); })()`);
    await shoot('key');

    // 7. A bookmark on the bar.
    at = await centre(chrome(), '.bookmark');
    if (at) { await rightClick(chrome(), at.x, at.y); await shoot('bookmark'); }

    // 8. The ones that need a whole sign-in to appear, drawn from the same
    // item shapes main sends (see application.js).
    await openFromChrome([
      { label: 'sam@example.com', icon: 'key', hint: 'Saved password for 127.0.0.1' },
      { label: 'kim@example.com', icon: 'key', hint: 'Saved password for 127.0.0.1' },
      { separator: true }, { label: 'Manage passwords', icon: 'gear' },
    ], { anchor: { left: 140, right: 140, top: 260, bottom: 260, width: 0, height: 0 }, align: 'left', passive: true });
    await shoot('autofill');
    await openFromChrome([
      { heading: 'Unlock to sign in to localhost' },
      { field: { type: 'password', placeholder: 'Master password', button: 'Unlock' } },
      { label: 'Use Windows Hello', icon: 'key', hint: 'Face, fingerprint or PIN' },
      { label: 'Cancel' },
    ]);
    await shoot('unlock');
    await openFromChrome([
      { heading: 'Create a passkey for localhost?' },
      { label: 'sam@local', icon: 'key', hint: 'Saved in Static, used in place of a password' },
      { label: 'Use another device or security key', icon: 'lock' },
      { label: 'Cancel' },
    ]);
    await shoot('passkey');
    await openFromChrome([
      { heading: 'Save password for 127.0.0.1?' },
      { label: 'Save', icon: 'key', hint: 'sam@example.com · ••••••••' },
      { label: 'Never for this site', icon: 'close' },
      { label: 'Not now' },
    ]);
    await shoot('save');

    // 9. Vertical tabs: a tab's menu there.
    browser.settings.update({ tabLayout: 'vertical' });
    browser.applyTabLayout();
    const listed = await until(() => browser.vtabs && !browser.vtabs.webContents.isLoading() &&
      browser.vtabs.webContents.executeJavaScript(`document.querySelectorAll('.vt-tab').length`));
    if (listed) {
      browser.push();
      await wait(500);
      at = await centre(browser.vtabs.webContents, '.vt-tab:not(.active)');
      if (at) { await rightClick(browser.vtabs.webContents, at.x, at.y); await shoot('vtab'); }
    }
    browser.settings.update({ tabLayout: 'horizontal' });
    browser.applyTabLayout();

    for (const [name, m] of Object.entries(measured)) {
      check(name + ': nothing is clipped', !m.clipped.length, m.clipped.join(' | '));
      check(name + ': fits without scrolling', !m.scrolls);
    }
    fs.writeFileSync(path.join(dir, tag + '-measures.json'), JSON.stringify(measured, null, 2));
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  } finally {
    server.close();
  }
  console.log(fails ? '\nFAILURES: ' + fails : '\nall menu gallery checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
