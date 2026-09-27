const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

/** Split view, end to end, off-screen. */
async function run(browser) {
  const { app } = require('electron');
  const pageMenu = require('../src/main/page-menu');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 220) : ''));
    if (!ok) fails++;
  };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>' + req.url + '</title><body style="background:' + (req.url.includes('b') ? '#246' : '#642') + '">' + req.url + '</body>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const attached = (id) => browser.window.contentView.children.includes(browser.tabs.tabs.get(id)?.view);
  const settle = () => wait(500);

  try {
    browser.window.show();
    await wait(1000);
    browser.settings.update({ tabLayout: 'horizontal' });
    browser.applyTabLayout();
    const first = browser.tabs.activeId;
    browser.tabs.navigate(first, base + '/a');
    await wait(900);

    // Right-click a link -> Open link in split view.
    await pageMenu.runCommand(browser, { tabId: first, contents: browser.tabs.tabs.get(first).view.webContents,
      params: { linkURL: base + '/b', x: 0, y: 0 } }, 'link-split');
    await settle();
    const pair = browser.tabs.pairOf(first);
    check('"Open link in split view" puts the link beside this tab', !!pair && pair.left === first, JSON.stringify(pair));
    const second = pair?.right;
    const l = browser.tabs.tabs.get(first).view.getBounds();
    const r = browser.tabs.tabs.get(second).view.getBounds();
    const d = browser.splitDivider?.getBounds();
    const area = browser.tabs.bounds;
    check('both pages are on screen, side by side, with a handle between',
      attached(first) && attached(second) && l.x === area.x && r.x + r.width === area.x + area.width &&
      d && d.x === l.x + l.width && r.x === d.x + d.width, JSON.stringify({ l, d, r, area }));
    check('split evenly', Math.abs(l.width - r.width) <= 1, l.width + ' / ' + r.width);
    const listed = browser.tabs.list().filter((t) => t.splitWith);
    check('the strip knows they are a pair', listed.length === 2 && listed[0].splitSide === 'left');

    // Clicking into the right pane makes it the active tab.
    browser.tabs.tabs.get(second).view.webContents.emit('focus');
    await wait(200);
    check('clicking into a pane makes it the active tab (address bar follows)', browser.tabs.activeId === second);
    check('without taking the other pane off screen', attached(first) && attached(second));

    // Resize from the handle, then reset with a double-click.
    browser.tabs.setSplitRatio(second, 0.3);
    browser.layout();
    const narrow = browser.tabs.tabs.get(first).view.getBounds().width;
    check('dragging the handle resizes the panes', Math.abs(narrow - Math.round((area.width - 8) * 0.3)) <= 1, narrow);
    for (let i = 0; i < 30 && browser.splitDivider.webContents.isLoading(); i++) await wait(100);
    await browser.splitDivider.webContents.executeJavaScript(`window.page.invoke('split:reset')`);
    await wait(300);
    const even = browser.tabs.tabs.get(first).view.getBounds().width;
    check('double-clicking it (split:reset, from the handle itself) evens them out', Math.abs(even - Math.round((area.width - 8) * 0.5)) <= 1, even);

    // Swap.
    browser.tabs.swapSplit(first);
    browser.layout();
    check('swap sides', browser.tabs.pairOf(first).left === second);
    browser.tabs.swapSplit(first);
    browser.layout();

    // Fullscreen in one pane gives it everything.
    browser.enterHtmlFullscreen(browser.tabs.tabs.get(second).view.webContents);
    await wait(200);
    const full = browser.tabs.tabs.get(second).view.getBounds();
    check('a pane going fullscreen takes the whole window', full.x === 0 && full.y === 0 && !attached(first) &&
      browser.splitDivider.getBounds().width === 0, JSON.stringify(full));
    browser.leaveHtmlFullscreen();
    await wait(200);
    check('and leaving brings the pair back', attached(first) && attached(second) && browser.splitDivider.getBounds().width === 8);

    // Exit split: both tabs stay.
    browser.tabs.select(first);
    browser.tabs.unsplit(first);
    browser.layout();
    check('exit split view keeps both tabs', browser.tabs.tabs.has(first) && browser.tabs.tabs.has(second) &&
      attached(first) && !attached(second) && browser.tabs.tabs.get(first).view.getBounds().width === area.width);

    // Drag a tab onto the page's right edge.
    browser.showSplitDrop(second);
    for (let i = 0; i < 30 && (!browser.splitDrop || browser.splitDrop.webContents.isLoading()); i++) await wait(100);
    await wait(300);
    const zone = browser.splitDrop.getBounds();
    check('dragging a tab shows drop zones over the page', zone.width === area.width && zone.height === area.height, JSON.stringify(zone));
    await browser.splitDrop.webContents.executeJavaScript(`(() => {
      const z = document.querySelector('.zone[data-side="right"]');
      z.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
    })()`);
    await settle();
    const dropped = browser.tabs.pairOf(first);
    check('dropping it on the right edge opens it on the right', dropped?.left === first && dropped?.right === second, JSON.stringify(dropped));
    check('and the drop zones go away', browser.splitDrop.getBounds().width === 0);
    const shot = await browser.window.contentView.children.find((v) => v === browser.splitDivider) ? null : null;
    void shot;

    // Closing one half leaves the other, whole.
    browser.tabs.close(second);
    browser.layout();
    await wait(200);
    check('closing one half leaves the other as a normal tab', browser.tabs.activeId === first && !browser.tabs.pairOf(first) &&
      browser.tabs.tabs.get(first).view.getBounds().width === area.width);

    // Ctrl+Shift+T brings it back.
    const count = browser.tabs.order.length;
    browser.dispatch('tab:reopen');
    await wait(600);
    const back = browser.tabs.active?.state.displayUrl;
    check('Ctrl+Shift+T reopens the closed tab', browser.tabs.order.length === count + 1 && back === base + '/b', back);

    const shots = path.join(app.getAppPath(), 'shots');
    fs.mkdirSync(shots, { recursive: true });
    browser.openSplit(base + '/b', first);
    await wait(1200);
    const img = await browser.chrome.webContents.capturePage().catch(() => null);
    if (img) fs.writeFileSync(path.join(shots, 'split-strip.png'), img.toPNG());
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }
  server.close();
  console.log(fails ? '\nFAILURES: ' + fails : '\nall split view checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
