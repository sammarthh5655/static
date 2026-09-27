const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

/**
 * Right-click on a real page: plain background, a link, an image, a text box
 * and selected text each get the menu a browser should offer, drawn in the
 * overlay at the pointer, and the commands do what they say.
 */
const PAGE = `<!doctype html><html><head><title>Menu test</title>
<style>body{font:16px sans-serif;margin:0;padding:20px;height:1400px}
#link{position:absolute;left:40px;top:40px}
#img{position:absolute;left:40px;top:120px;width:80px;height:80px}
#box{position:absolute;left:40px;top:240px;width:220px}
#text{position:absolute;left:40px;top:320px}</style></head><body>
<a id="link" href="/target">A link to follow</a>
<img id="img" src="/pixel.png" alt="">
<input id="box" value="some wrods here">
<p id="text">Select this sentence please</p>
</body></html>`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function run(browser) {
  const { app, clipboard } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 200) : ''));
    if (!ok) fails++;
  };

  const server = http.createServer((req, res) => {
    if (req.url === '/pixel.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/target' ? '<title>Target</title>target' : PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;

  try {
    browser.window.show();
    await wait(1200);
    const where = browser.window.getBounds();
    check('the test window stays off-screen and unfocused', where.x < -10000 && !browser.window.isFocused(),
      JSON.stringify(where) + ' focused=' + browser.window.isFocused());
    const tab = browser.tabs.active;
    const wc = tab.view.webContents;
    browser.tabs.navigate(tab.id, base + '/');
    // A restored tab from the last run can finish its own load first, so
    // wait for THIS page rather than for any load event.
    for (let i = 0; i < 60 && (wc.isLoading() || !wc.getURL().startsWith(base)); i++) await wait(150);
    await wait(700);

    // The first synthetic input after a load can arrive before the page is
    // hit-testable; a pointer move first makes the right-click land.
    for (let i = 0; i < 3; i++) {
      wc.sendInputEvent({ type: 'mouseMove', x: 300 + i * 10, y: 500 });
      await wait(150);
    }
    const rightClick = async (x, y, retry = true) => {
      browser.lastPageMenu = null;
      let fired = false;
      const seen = new Promise((resolve) => {
        wc.once('context-menu', () => { fired = true; setTimeout(resolve, 150); });
        setTimeout(resolve, 3000);
      });
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 });
      await seen;
      const menu = browser.lastPageMenu;
      const labels = (menu?.items || []).filter((i) => i.label).map((i) => i.label);
      if (!fired && retry) return rightClick(x, y, false);
      if (!fired) console.log('  (no context-menu event at ' + x + ',' + y + ')');
      return { menu, labels };
    };
    const has = (labels, ...want) => want.every((w) => labels.some((l) => l.startsWith(w)));

    // Plain page.
    // Right after the window appears, synthetic input is dropped for a moment
    // (the compositor has not yet produced a hit-testable frame). Real users
    // cannot click that fast; the probe waits until clicks are landing.
    let hit = { menu: null };
    for (let i = 0; i < 12 && !hit.menu; i++) {
      hit = await rightClick(50, 48, false);
      if (!hit.menu) await wait(400);
    }
    console.log('  input ready: ' + !!hit.menu);
    hit = await rightClick(400, 450);
    check('page menu has Back, Forward, Reload, Save, Print, Translate, Source, Inspect',
      has(hit.labels, 'Back', 'Forward', 'Reload', 'Save page as', 'Print', 'Translate', 'View page source', 'Inspect'),
      hit.labels.join(' | '));
    const bounds = tab.view.getBounds();
    check('the menu is anchored at the pointer, in window coordinates',
      hit.menu && hit.menu.anchor.left === bounds.x + 400 && hit.menu.anchor.top === bounds.y + 450,
      JSON.stringify(hit.menu?.anchor) + ' view at ' + JSON.stringify(bounds));
    check('Back is enabled exactly when there is somewhere to go back to',
      hit.menu.items.find((i) => i.label === 'Back')?.disabled === !wc.navigationHistory.canGoBack());

    // Link.
    hit = await rightClick(50, 48);
    check('link menu offers new tab, save, copy address and copy text',
      has(hit.labels, 'Open link in new tab', 'Save link as', 'Copy link address', 'Copy link text'), hit.labels.join(' | '));
    const before = browser.tabs.order.length;
    await require('../src/main/page-menu').runCommand(browser, browser.contextTarget, 'copy-link');
    let copied = await clipboard.readText();
    check('Copy link address copies the link', copied === base + '/target', copied);
    await require('../src/main/page-menu').runCommand(browser, browser.contextTarget, 'copy-link-text');
    copied = await clipboard.readText();
    check('Copy link text copies the words', copied === 'A link to follow', copied);
    await require('../src/main/page-menu').runCommand(browser, browser.contextTarget, 'link-tab');
    await wait(400);
    check('Open link in new tab opens one, next to this tab, in the background',
      browser.tabs.order.length === before + 1 && browser.tabs.activeId === tab.id &&
      browser.tabs.order[browser.tabs.order.indexOf(tab.id) + 1] !== undefined);

    // Image.
    hit = await rightClick(70, 150);
    check('image menu offers open, save, copy and Lens',
      has(hit.labels, 'Open image in new tab', 'Save image as', 'Copy image', 'Copy image address', 'Search image with Google Lens'),
      hit.labels.join(' | '));

    // Editable, with a misspelling.
    await wc.executeJavaScript(`document.getElementById('box').focus()`);
    await wait(900);
    hit = await rightClick(120, 250);
    check('text box menu offers undo, cut, copy, paste, plain paste and select all',
      has(hit.labels, 'Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Paste as plain text', 'Select all'), hit.labels.join(' | '));

    // Selected text.
    // Select a word the way a person does: double-click it.
    const word = await wc.executeJavaScript(`(() => { const b = document.getElementById('text').getBoundingClientRect();
      return { x: Math.round(b.left + 20), y: Math.round(b.top + b.height / 2) }; })()`);
    wc.sendInputEvent({ type: 'mouseDown', x: word.x, y: word.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: word.x, y: word.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseDown', x: word.x, y: word.y, button: 'left', clickCount: 2 });
    wc.sendInputEvent({ type: 'mouseUp', x: word.x, y: word.y, button: 'left', clickCount: 2 });
    await wait(300);
    const picked = await wc.executeJavaScript('getSelection().toString()');
    if (!picked) {
      await wc.executeJavaScript(`(() => { const r = document.createRange();
        r.selectNodeContents(document.getElementById('text'));
        getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
    }
    hit = await rightClick(word.x, word.y);
    check('selection menu offers copy, web search and translate',
      has(hit.labels, 'Copy', 'Search the web for', 'Translate selection'), hit.labels.join(' | '));

    // The overlay really draws it.
    browser.pendingMenu = browser.lastPageMenu;
    browser.overlay.webContents.send('ui:render-menu', browser.pendingMenu);
    let drawn = 0;
    for (let i = 0; i < 20 && drawn <= 0; i++) {
      await wait(150);
      drawn = await browser.overlay.webContents.executeJavaScript(
        `document.querySelectorAll('[role="menuitem"], .menu-item').length`).catch(() => -1);
    }
    check('the overlay draws the items', drawn > 0, 'items drawn: ' + drawn);
    const shots = path.join(app.getAppPath(), 'shots');
    fs.mkdirSync(shots, { recursive: true });
    const img = await browser.overlay.webContents.capturePage().catch(() => null);
    if (img) fs.writeFileSync(path.join(shots, 'page-menu.png'), img.toPNG());
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }

  server.close();
  console.log(fails ? '\nFAILURES: ' + fails : '\nall page menu checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
