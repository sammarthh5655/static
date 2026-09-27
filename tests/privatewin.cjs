const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

/**
 * Run with: node scripts/start.cjs --privatewin --incognito
 *
 * Checks from INSIDE an incognito process that it keeps nothing: an
 * in-memory session, a throwaway folder, no history, no saved session, no
 * extensions, and a look nobody could mistake for a normal window.
 */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 200) : ''));
    if (!ok) fails++;
  };
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'seen=1; Max-Age=86400; Path=/' });
    res.end('<title>Private test</title><script>localStorage.setItem("k", "v")</script>hello');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/';

  try {
    await wait(1200);
    check('this process is incognito', browser.incognito === true);
    const userData = app.getPath('userData');
    check('its data lives in a throwaway temp folder',
      userData.startsWith(os.tmpdir()) && path.basename(userData).startsWith('static-incognito-'), userData);
    check('with its owner recorded, so a later start can clean up',
      fs.readFileSync(path.join(userData, 'owner.pid'), 'utf8') === String(process.pid));
    check('the session is memory-only', browser.session.isPersistent() === false);

    const tab = browser.tabs.active;
    const wc = tab.view.webContents;
    browser.tabs.navigate(tab.id, base);
    for (let i = 0; i < 60 && (wc.isLoading() || !wc.getURL().startsWith(base)); i++) await wait(150);
    await wait(600);
    const cookies = await browser.session.cookies.get({ url: base });
    check('cookies work while the window is open', cookies.some((c) => c.name === 'seen'), JSON.stringify(cookies));
    check('but nothing is written to history', browser.history.search('').length === 0,
      JSON.stringify(browser.history.search('').slice(0, 2)));
    browser.saveSession();
    check('and the open tabs are not saved', (browser.sessionStore.data.tabs || []).length === 0);
    check('extensions are not running', (browser.extensions.list?.() || []).length === 0);
    const chrome = await browser.chrome.webContents.executeJavaScript(`({
      incognito: document.body.classList.contains('incognito'),
      pill: !document.getElementById('incognito-pill').hidden,
      bg: getComputedStyle(document.body).getPropertyValue('--bg').trim(),
    })`);
    check('the toolbar says Incognito and looks different', chrome.incognito && chrome.pill && chrome.bg === '#0d0a14', JSON.stringify(chrome));

    const ntLoaded = new Promise((resolve) => { wc.once('did-finish-load', resolve); setTimeout(resolve, 6000); });
    browser.tabs.navigate(tab.id, 'browser://newtab');
    await ntLoaded;
    let note = false;
    for (let i = 0; i < 20 && !note; i++) {
      await wait(150);
      note = await wc.executeJavaScript(`!document.getElementById('incognito-note').hidden`);
    }
    check('the new tab page explains what incognito does', note);
    const shots = path.join(app.getAppPath(), 'shots');
    fs.mkdirSync(shots, { recursive: true });
    await wait(400);
    const img = await browser.window.contentView.children[0]?.webContents?.capturePage?.().catch(() => null);
    const page = await wc.capturePage().catch(() => null);
    if (page) fs.writeFileSync(path.join(shots, 'incognito-newtab.png'), page.toPNG());
    if (img) fs.writeFileSync(path.join(shots, 'incognito-chrome.png'), img.toPNG());
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }
  server.close();
  console.log(fails ? '\nFAILURES: ' + fails : '\nall incognito checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
