const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const http = require('node:http');

/**
 * The basics every browser has: find in page, zoom, and fullscreen that
 * really gives the page the whole window. Runs off-screen.
 */
const PAGE = `<!doctype html><title>Basics</title><body style="height:2000px">
<p>apple banana apple cherry apple</p><video id="v" width="200" height="100"></video></body>`;

async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 200) : ''));
    if (!ok) fails++;
  };
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/';

  try {
    browser.window.show();
    await wait(1000);
    const where = browser.window.getBounds();
    check('the test window stays off-screen', where.x < -10000 && !browser.window.isFocused(), JSON.stringify(where));

    const tab = browser.tabs.active;
    const wc = tab.view.webContents;
    browser.tabs.navigate(tab.id, base);
    for (let i = 0; i < 60 && (wc.isLoading() || !wc.getURL().startsWith(base)); i++) await wait(150);
    await wait(500);

    // ---- find in page ----
    browser.dispatch('find:open');
    for (let i = 0; i < 40 && !(browser.findBar && !browser.findBar.webContents.isLoading()); i++) await wait(100);
    await wait(400);
    check('Ctrl+F opens a find bar over the page', !!browser.findBar);
    const fb = browser.findBar.webContents;
    await fb.executeJavaScript(`(() => { const i = document.getElementById('query'); i.value = 'apple'; i.dispatchEvent(new Event('input')); })()`);
    let count = '';
    for (let i = 0; i < 30 && !/of 3/.test(count); i++) {
      await wait(150);
      count = await fb.executeJavaScript(`document.getElementById('count').textContent`);
    }
    check('it counts every match', /1 of 3/.test(count), count);
    await fb.executeJavaScript(`document.getElementById('next').click()`);
    await wait(500);
    count = await fb.executeJavaScript(`document.getElementById('count').textContent`);
    check('Next moves to the following match', /2 of 3/.test(count), count);
    await fb.executeJavaScript(`(() => { const i = document.getElementById('query'); i.value = 'zzzz'; i.dispatchEvent(new Event('input')); })()`);
    await wait(700);
    count = await fb.executeJavaScript(`document.getElementById('count').textContent`);
    check('no match says so', /No results/.test(count), count);
    const fbBounds = browser.findBar.getBounds();
    const tabBounds = tab.view.getBounds();
    check('the bar sits over the page, top right, below the toolbar',
      fbBounds.y >= tabBounds.y && fbBounds.x + fbBounds.width <= tabBounds.x + tabBounds.width + 1,
      JSON.stringify({ fbBounds, tabBounds }));
    browser.closeFind();
    check('Escape/close removes it', !browser.findBar);

    // ---- zoom ----
    browser.dispatch('page:zoom-in');
    await wait(200);
    const zin = wc.getZoomFactor();
    browser.dispatch('page:zoom-out');
    browser.dispatch('page:zoom-out');
    await wait(200);
    const zout = wc.getZoomFactor();
    browser.dispatch('page:zoom-reset');
    await wait(200);
    check('zoom steps in, out and back to 100%', zin === 1.1 && zout === 0.9 && wc.getZoomFactor() === 1,
      [zin, zout, wc.getZoomFactor()].join(', '));

    // ---- a page asking for fullscreen ----
    const before = tab.view.getBounds();
    await wc.executeJavaScript(`document.getElementById('v').requestFullscreen()`, true).catch((e) => console.log('  request failed', e.message));
    for (let i = 0; i < 30 && !browser.htmlFullscreen; i++) await wait(100);
    await wait(300);
    const full = tab.view.getBounds();
    const content = browser.window.getContentBounds();
    const still = browser.window.getBounds();
    check('the off-screen window did not go fullscreen onto a monitor', still.x < -10000 && !browser.window.isFullScreen(),
      JSON.stringify(still));
    check('page fullscreen gives the tab the whole window', !!browser.htmlFullscreen &&
      full.y === 0 && full.height === content.height && full.width === content.width,
      JSON.stringify({ before, full, content }));
    check('and the toolbar gets out of the way', browser.chrome.getBounds().height === 0, JSON.stringify(browser.chrome.getBounds()));
    await wc.executeJavaScript(`document.exitFullscreen()`, true).catch(() => {});
    for (let i = 0; i < 30 && browser.htmlFullscreen; i++) await wait(100);
    await wait(300);
    const after = tab.view.getBounds();
    check('leaving puts everything back', !browser.htmlFullscreen && after.y === before.y && after.height === before.height,
      JSON.stringify({ before, after }));

    // ---- F11 ----
    browser.dispatch('window:fullscreen');
    await wait(300);
    check('F11 hides the toolbar too', browser.chrome.getBounds().height === 0 && tab.view.getBounds().y === 0);
    browser.dispatch('window:fullscreen');
    await wait(300);
    check('and F11 again brings it back', tab.view.getBounds().y === before.y);
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }

  server.close();
  console.log(fails ? '\nFAILURES: ' + fails : '\nall browsing checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
