const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

/**
 * The icon at the start of the address bar, clicked as a person would.
 *
 *   node scripts/start.cjs --siteinfo
 *   node scripts/start.cjs --siteinfo --incognito
 *
 * On Static's own pages (the gear) it offers Settings, and Open Settings
 * opens them. On a web page it shows the site card: the connection, what
 * Shields blocked, the cookies, Shields on/off for the site, clearing its
 * cookies, and Site settings. Enter on the focused icon opens it too.
 */
async function run(browser) {
  const { app } = require('electron');
  const shots = path.join(app.getAppPath(), 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const tag = browser.incognito ? 'incognito' : 'normal';
  const failures = [];
  const check = (name, ok, detail = '') => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + name + (detail !== '' ? ' :: ' + detail : ''));
    if (!ok) failures.push(name);
  };
  const until = async (fn, tries = 50) => {
    for (let i = 0; i < tries; i++) { const v = await Promise.resolve().then(fn).catch(() => null); if (v) return v; await wait(100); }
    return null;
  };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>Local page</title><body style="margin:0;font:30px sans-serif;background:#246;color:#fff">A page</body>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;

  const w = browser.front;
  const chrome = () => w.chrome.webContents;
  const overlay = () => w.overlay.webContents;
  const click = async (wc, x, y) => {
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    await wait(30);
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  };
  const at = (wc, selector) => wc.executeJavaScript(`(() => { const n = document.querySelector(${JSON.stringify(selector)});
    if (!n) return null; const b = n.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
  const card = () => overlay().executeJavaScript(`(() => {
    const head = document.querySelector('.menu-site'); if (!head) return null;
    return { title: head.querySelector('strong')?.textContent, subtitle: head.querySelector('small')?.textContent || '', tone: head.className,
      facts: [...document.querySelectorAll('.menu-site-facts div')].map((d) => d.querySelector('dt').textContent + '=' + d.querySelector('dd').textContent),
      items: [...document.querySelectorAll('.menu-item, .menu-segment-row')].map((n) => n.textContent.trim().replace(/\\s+/g, ' ')),
      width: Math.round(document.querySelector('.menu').getBoundingClientRect().width) }; })()`);
  const openCard = async () => {
    w.closeMenu(); await wait(250);
    const p = await at(chrome(), '#security');
    await click(chrome(), p.x, p.y);
    return until(card, 40);
  };
  const choose = async (label) => {
    const p = await overlay().executeJavaScript(`(() => { const n = [...document.querySelectorAll('.menu-item, button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)}));
      if (!n) return null; const b = n.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
    if (!p) return false;
    await click(overlay(), p.x, p.y);
    return true;
  };
  const shoot = async (name) => {
    await wait(350);
    const img = await overlay().capturePage().catch(() => null);
    if (img && !img.isEmpty()) fs.writeFileSync(path.join(shots, 'siteinfo-' + tag + '-' + name + '.png'), img.toPNG());
  };

  try {
    await until(() => !chrome().isLoading() && w.tabs.order.length, 80);
    await wait(1500);

    // ---- Static's own page: the gear opens Settings.
    w.tabs.navigate(w.tabs.activeId, 'browser://newtab');
    await wait(1200);
    const own = await openCard();
    check('the gear on a Static page opens a card', !!own, JSON.stringify(own));
    check('which says it is one of Static\'s own pages', own?.title === 'Static' && /Static's own/.test(own.subtitle), own?.subtitle);
    check('and offers Open Settings first', /^Open Settings/.test(own?.items?.[0] || ''), (own?.items || []).join(' | '));
    if (browser.incognito) check('in incognito it says the window is private', (own?.facts || []).some((f) => f.startsWith('Private window')), (own?.facts || []).join(' | '));
    await shoot('static-page');
    const tabsBefore = w.tabs.order.length;
    await choose('Open Settings');
    const settings = await until(() => [...w.tabs.tabs.values()].find((t) => /^browser:\/\/settings/.test(t.state.displayUrl || t.state.url || '')), 40);
    check('Open Settings opens Settings', !!settings, w.tabs.list().map((t) => t.url).join(', '));
    check('the card goes away', !!(await until(() => !w.overlayInteractive, 30)));
    if (settings && w.tabs.order.length > tabsBefore) w.tabs.close(settings.id);

    // ---- A web page over plain HTTP.
    w.tabs.navigate(w.tabs.activeId, base + '/');
    await until(() => w.tabs.active.state.displayUrl?.startsWith(base) && !w.tabs.active.state.loading, 50);
    await wait(500);
    await w.tabs.active.view.webContents.executeJavaScript(`document.cookie = 'probe=1; path=/; max-age=600'`);
    await wait(300);
    let info = await openCard();
    check('on a web page the card names the site', info?.title === '127.0.0.1', JSON.stringify(info));
    check('and says the connection is not private', /^Not secure/.test(info?.subtitle || '') && /tone-warn/.test(info?.tone || ''), info?.subtitle);
    check('it counts the site\'s cookies', (info?.facts || []).includes('Cookies=1 cookie'), (info?.facts || []).join(' | '));
    check('it says what Shields blocked here', (info?.facts || []).some((f) => f.startsWith('Blocked on this page=')), (info?.facts || []).join(' | '));
    check('it says camera, microphone and location are blocked', (info?.facts || []).includes('Camera, microphone & location=Blocked'));
    check('it offers Shields, clearing cookies and Site settings', ['Shields', 'Clear cookies and site data', 'Site settings'].every((l) => (info?.items || []).some((i) => i.startsWith(l))), (info?.items || []).join(' | '));
    check('the card is a comfortable width', info?.width >= 250 && info?.width <= 320, info?.width);
    await shoot('insecure');

    await choose('Off');
    check('Shields Off pauses them on this site', !!(await until(() => !browser.shields.activeFor('127.0.0.1'), 30)));
    info = await openCard();
    check('the card then shows them off', !(info?.facts || []).some((f) => f.startsWith('Blocked on this page')));
    await choose('On');
    check('and On turns them back on', !!(await until(() => browser.shields.activeFor('127.0.0.1'), 30)));

    info = await openCard();
    await choose('Clear cookies and site data');
    const gone = await until(async () => (await browser.session.cookies.get({ domain: '127.0.0.1' })).length === 0, 40);
    check('Clear cookies and site data clears them', !!gone);
    info = await openCard();
    check('and the card then counts none', (info?.facts || []).includes('Cookies=None'), (info?.facts || []).join(' | '));

    await choose('Site settings');
    const site = await until(() => [...w.tabs.tabs.values()].find((t) => /^browser:\/\/settings#privacy/.test(t.state.displayUrl || '')), 40);
    check('Site settings opens Settings at Privacy', !!site, w.tabs.list().map((t) => t.url).join(', '));
    if (site) w.tabs.close(site.id);
    await wait(400);

    // ---- The keyboard.
    w.closeMenu(); await wait(250);
    await chrome().executeJavaScript(`document.getElementById('security').focus()`);
    chrome().sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    chrome().sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    check('Enter on the focused icon opens the card', !!(await until(card, 30)));
    w.closeMenu();

    // ---- HTTPS, when the network is there.
    w.tabs.navigate(w.tabs.activeId, 'https://example.com/');
    const loaded = await until(() => w.tabs.active.state.security === 'secure' && !w.tabs.active.state.loading, 80);
    if (loaded) {
      info = await openCard();
      check('over HTTPS it says the connection is secure', info?.subtitle === 'Connection is secure' && /tone-secure/.test(info?.tone || ''), JSON.stringify(info));
      await shoot('secure');
    } else console.log('  --  no network: the HTTPS card was not checked');
    w.closeMenu();
  } catch (error) {
    check('no errors', false, error.stack || error.message);
  }
  server.close();
  console.log(failures.length ? '\n' + failures.length + ' FAILURES' : '\nall site card checks passed');
  app.exit(failures.length ? 1 : 0);
}
module.exports = { run };
