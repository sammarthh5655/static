const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Import from another browser, through the real Settings panel, using
 * synthetic Chrome and Firefox profiles - never the user's own. Off-screen.
 */
function fixtures() {
  const { DatabaseSync } = require('node:sqlite');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-importprobe-'));
  const chrome = path.join(root, 'chrome');
  fs.mkdirSync(path.join(chrome, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(chrome, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Work' } } } }));
  fs.writeFileSync(path.join(chrome, 'Default', 'Bookmarks'), JSON.stringify({ roots: { bookmark_bar: { type: 'folder', children: [
    { type: 'url', name: 'Example A', url: 'https://a.example/' }, { type: 'url', name: 'Example B', url: 'https://b.example/' }] } } }));
  fs.writeFileSync(path.join(chrome, 'Default', 'Preferences'), JSON.stringify({ homepage: 'https://home.example/', homepage_is_newtabpage: false }));
  let db = new DatabaseSync(path.join(chrome, 'Default', 'History'));
  db.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, last_visit_time INTEGER, hidden INTEGER)');
  const insert = db.prepare('INSERT INTO urls (url, title, last_visit_time, hidden) VALUES (?, ?, ?, 0)');
  for (let i = 0; i < 3; i++) insert.run('https://visited' + i + '.example/', 'Visited ' + i, BigInt(Date.UTC(2026, 0, 1 + i) + 11644473600000) * 1000n);
  db.close();
  const firefox = path.join(root, 'firefox');
  const profile = path.join(firefox, 'Profiles', 'abc123.default-release');
  fs.mkdirSync(profile, { recursive: true });
  db = new DatabaseSync(path.join(profile, 'places.sqlite'));
  db.exec(`CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, last_visit_date INTEGER);
    CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER, title TEXT, dateAdded INTEGER);`);
  db.prepare('INSERT INTO moz_places (id, url, title, last_visit_date) VALUES (1, ?, ?, ?)').run('https://fox.example/', 'Fox', BigInt(Date.UTC(2026, 1, 1)) * 1000n);
  db.prepare("INSERT INTO moz_bookmarks (id, type, fk, parent, title, dateAdded) VALUES (1, 2, NULL, 0, 'toolbar', 0)").run();
  db.prepare("INSERT INTO moz_bookmarks (id, type, fk, parent, title, dateAdded) VALUES (2, 1, 1, 1, 'Fox bookmark', 0)").run();
  db.close();
  return { root, chrome, firefox };
}

async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 220) : ''));
    if (!ok) fails++;
  };
  const until = async (fn, tries = 50) => { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await wait(150); } return null; };
  const made = fixtures();
  try {
    await wait(800);
    browser.importRoots = { chrome: made.chrome, firefox: made.firefox, edge: '/none', brave: '/none', opera: '/none', vivaldi: '/none' };
    for (const b of browser.bookmarks.list()) browser.bookmarks.remove(b.id);
    const tab = browser.tabs.active;
    const wc = tab.view.webContents;
    const loaded = new Promise((r) => { wc.once('did-finish-load', r); setTimeout(r, 8000); });
    browser.tabs.navigate(tab.id, 'browser://settings#start');
    await loaded;
    const tiles = await until(() => wc.executeJavaScript(`[...document.querySelectorAll('.import-browser span:last-child')].map(s => s.textContent)`).then((t) => t.length ? t : null));
    check('Settings lists the browsers found on this computer', tiles && tiles.includes('Google Chrome') && tiles.includes('Mozilla Firefox'), JSON.stringify(tiles));

    await wc.executeJavaScript(`(() => {
      document.querySelector('.import-browser[data-id="chrome"]').click();
      [...document.querySelectorAll('.import-switch')].find(b => /Homepage/.test(b.textContent)).click();
      document.querySelector('.import-go').click();
    })()`);
    const status = await until(() => wc.executeJavaScript(`(document.querySelector('.import-status')?.textContent || '').startsWith('Imported') ? document.querySelector('.import-status').textContent : ''`));
    check('importing from Chrome brings bookmarks, history and homepage', /2 bookmarks, 3 history entries, your homepage/.test(status || ''), status);
    check('bookmarks are really there, marked with where they came from', browser.bookmarks.list().filter((b) => b.source === 'Google Chrome').length === 2);
    check('history keeps the original visit times', browser.history.search('visited2.example')[0]?.visitedAt === Date.UTC(2026, 0, 3));
    check('the homepage came across', browser.settings.value.homepage === 'https://home.example/', browser.settings.value.homepage);

    await wc.executeJavaScript(`document.querySelector('.import-go').click()`);
    const again = await until(() => wc.executeJavaScript(`/0 bookmarks, 0 history/.test(document.querySelector('.import-status')?.textContent || '') ? document.querySelector('.import-status').textContent : ''`));
    check('importing twice adds nothing twice', !!again, again);

    await wc.executeJavaScript(`document.querySelector('.import-browser[data-id="firefox"]').click(); document.querySelector('.import-go').click();`);
    const fox = await until(() => wc.executeJavaScript(`/Imported 1 bookmarks, 1 history/.test(document.querySelector('.import-status')?.textContent || '') ? 'yes' : ''`));
    check('Firefox imports too', !!fox && browser.bookmarks.list().some((b) => b.title === 'Fox bookmark'));

    const steps = browser.onboarding.state().steps.map((s) => s.id);
    check('the first-run flow has a "Bring your stuff" step after choosing a profile', steps.indexOf('import') === steps.indexOf('profile') + 1, steps.join(','));
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }
  fs.rmSync(made.root, { recursive: true, force: true });
  console.log(fails ? '\nFAILURES: ' + fails : '\nall import checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
