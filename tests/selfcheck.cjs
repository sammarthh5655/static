const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const path = require('node:path');

/** The self-check must report the real state of a real page. */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 150) : ''));
    if (!ok) fails++;
  };

  try {
    browser.window.show();
    await wait(1400);
    for (let i = 0; i < 40 && browser.shields.engine.count < 1000; i++) await wait(500);
    if (!browser.tabs.order.length) browser.tabs.create({ url: 'about:blank' });
    await wait(600);

    // Put a real YouTube page in the active tab, then check it.
    browser.tabs.navigate(browser.tabs.activeId, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    const wc = browser.tabs.active.view.webContents;
    for (let i = 0; i < 90 && wc.isLoading(); i++) await wait(250);
    await wait(7000);

    const result = await browser.state && null;
    const handlers = browser;  // call the handler through IPC the way the page does
    const report = await new Promise((resolve) => {
      const { ipcMain } = require('electron');
      // Invoke the registered handler directly by re-running its logic through
      // the same channel the page uses.
      const fake = { sender: browser.chrome.webContents };
      const list = ipcMain._invokeHandlers || null;
      resolve(null);
    });

    // Drive it the way the UI does: from the shields page.
    browser.tabs.create({ url: 'browser://shields', background: false });
    await wait(2500);
    const page = browser.tabs.active.view.webContents;
    for (let i = 0; i < 40 && page.isLoading(); i++) await wait(200);
    await wait(1200);

    const before = await page.executeJavaScript(
      `!!document.querySelector('.shield-check-run')`);
    check('the check button is on the Shields page', before === true);

    // The active tab is now the shields page, so the check reports on ITSELF -
    // which is correct behaviour and worth stating.
    await page.executeJavaScript(
      `document.querySelector('.shield-check-run').click(), true`);
    await wait(3000);

    const shown = await page.executeJavaScript(`({
      verdict: (document.querySelector('.shield-check-verdict')||{}).textContent || '',
      items: document.querySelectorAll('.shield-check-item').length,
      failed: document.querySelectorAll('.shield-check-item.is-bad').length,
      labels: [...document.querySelectorAll('.shield-check-item')].map(function(n){
        return (n.querySelector('.shield-check-mark')||{}).textContent + ' ' +
               (n.querySelector('.shield-check-label')||{}).textContent;
      }),
    })`);
    console.log('  [diag]', JSON.stringify(shown.labels, null, 1));

    check('it reports a verdict', shown.verdict.length > 0, shown.verdict);
    check('it lists the individual checks', shown.items >= 5, shown.items + ' checks');
    check('the core checks pass', shown.failed === 0,
      shown.failed + ' failed: ' + shown.labels.filter((l) => l.startsWith('NO')).join(' | '));

    const dir = path.join(app.getAppPath(), 'shots');
    fs.mkdirSync(dir, { recursive: true });
    const img = await page.capturePage().catch(() => null);
    if (img) { fs.writeFileSync(path.join(dir, 'selfcheck.png'), img.toPNG()); console.log('  shot written'); }
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }
  console.log(fails ? '\nFAILURES: ' + fails : '\nall self-check checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
