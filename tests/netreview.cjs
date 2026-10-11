const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

/**
 * Network protection, the second look (features/netguard): what a person
 * would run into that the main probe (netprivacy) does not walk through.
 *
 *   node scripts/start.cjs --netreview
 *
 *   - Secure DNS really changes where names are looked up: an unreachable
 *     provider in "Always encrypted" means a real site does not load, and
 *     Cloudflare means it does
 *   - HTTPS-only asks about a site that fell back to http quietly earlier
 *   - the fake-site check leaves real sign-in pages alone (Amazon UK,
 *     Microsoft) and still stops an imitation
 *   - the warning page works from the keyboard alone
 *   - the site card opens promptly on a real https site
 */
async function run(browser) {
  const { app } = require('electron');
  const shots = path.join(app.getAppPath(), 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const failures = [];
  const check = (name, ok, detail = '') => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + name + (detail !== '' ? ' :: ' + detail : ''));
    if (!ok) failures.push(name);
  };
  const until = async (fn, tries = 60, every = 100) => {
    for (let i = 0; i < tries; i++) { const v = await Promise.resolve().then(fn).catch(() => null); if (v) return v; await wait(every); }
    return null;
  };

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end('<!doctype html><title>Plain</title><body style="background:#123;color:#fff;font:20px system-ui">plain http ' + req.url + '</body>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const w = browser.front;
  const g = browser.netguard;
  const tab = () => w.tabs.active;
  const wc = () => tab().view.webContents;
  const chrome = () => w.chrome.webContents;
  const overlay = () => w.overlay.webContents;
  const settle = () => until(() => !tab().state.loading, 150);
  const go = async (url) => { w.tabs.navigate(w.tabs.activeId, url); await wait(200); await settle(); await wait(300); };
  const set = (patch) => { browser.settings.update(patch); g.settingsChanged(patch); browser.push(); };
  const key = async (contents, keyCode, shift = false) => {
    const modifiers = shift ? ['shift'] : [];
    contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode.length === 1 || keyCode === 'Return') contents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Return' ? String.fromCharCode(13) : keyCode, modifiers });
    contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await wait(120);
  };
  const click = async (contents, x, y) => {
    contents.sendInputEvent({ type: 'mouseMove', x, y });
    await wait(40);
    contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await wait(60);
  };
  const shoot = async (name, contents = wc()) => {
    await wait(450);
    const img = await contents.capturePage().catch(() => null);
    if (img && !img.isEmpty()) fs.writeFileSync(path.join(shots, 'netreview-' + name + '.png'), img.toPNG());
  };
  const onWarning = () => until(() => /^browser:\/\/warning/.test(tab().state.internalUrl || '') && !tab().state.loading, 80);
  const loaded = async (url) => {
    let failed = null;
    const onFail = (_e, code, desc, _u, main) => { if (main) failed = desc; };
    wc().on('did-fail-load', onFail);
    await go(url);
    await wait(500);
    wc().removeListener('did-fail-load', onFail);
    const title = await wc().executeJavaScript('document.title').catch(() => '');
    return { failed, title, url: wc().getURL() };
  };

  try {
    await until(() => !chrome().isLoading() && w.tabs.order.length, 80);
    await wait(1200);
    g.forget({ all: true });
    g.httpThisSession.clear();

    // ---- Secure DNS, for real ---------------------------------------------------
    set({ secureDns: 'secure', secureDnsProvider: 'custom', secureDnsCustom: 'https://doh.static-probe.invalid/dns-query' });
    check('the resolver was given the custom provider', g.dnsApplied?.secureDnsServers?.[0] === 'https://doh.static-probe.invalid/dns-query', JSON.stringify(g.dnsApplied));
    const blocked = await loaded('https://example.org/');
    check('with an unreachable provider, a real site cannot be looked up', !!blocked.failed && /NAME_NOT_RESOLVED|DNS/i.test(blocked.failed), JSON.stringify(blocked));
    set({ secureDnsProvider: 'cloudflare' });
    const through = await loaded('https://example.net/');
    check('with Cloudflare, it loads over encrypted DNS', !through.failed && /example/i.test(through.title), JSON.stringify(through));
    set({ secureDns: 'automatic', secureDnsProvider: 'cloudflare', secureDnsCustom: '' });

    // ---- the site card opens promptly, with the certificate -------------------------
    await go('https://example.com/');
    const opened = Date.now();
    const p = await chrome().executeJavaScript(`(() => { const b = document.querySelector('#security').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
    await click(chrome(), p.x, p.y);
    const facts = await until(() => overlay().executeJavaScript(`(() => { const h = document.querySelector('.menu-site'); return h ? [...h.parentElement.querySelectorAll('.menu-site-facts div')].map((d) => d.textContent) : null; })()`), 60, 50);
    const took = Date.now() - opened;
    check('the site card opens within two seconds', !!facts && took < 2000, took + ' ms');
    check('and names the certificate', (facts || []).some((f) => /^Certificate/.test(f)), JSON.stringify(facts));
    await shoot('sitecard', overlay());
    w.closeMenu();
    await wait(300);

    // ---- HTTPS-only after a quiet fallback --------------------------------------------
    set({ httpsOnly: false });
    const quiet = await loaded(`http://fallback.probe.test:${port}/first`);
    check('without HTTPS-only, a site with no https opens over http', /^http:/.test(quiet.url) && /Plain/.test(quiet.title), JSON.stringify(quiet));
    set({ httpsOnly: true });
    w.tabs.navigate(w.tabs.activeId, `http://fallback.probe.test:${port}/second`);
    check('turning HTTPS-only on asks about that site from then on', !!(await onWarning()), tab().state.internalUrl || tab().state.url);
    const kind = await wc().executeJavaScript(`new URLSearchParams(location.search).get('kind')`).catch(() => '');
    check('with the no-https warning', kind === 'nohttps', kind);
    set({ httpsOnly: false });

    // ---- the fake-site check -------------------------------------------------------------
    const assess = (u) => browser.safety.assess(u);
    for (const real of ['https://www.amazon.co.uk/ap/signin', 'https://login.microsoftonline.com/common/oauth2/authorize', 'https://outlook.office365.com/mail/', 'https://apple.stackexchange.com/users/login', 'https://purchase.ticketmaster.com/account']) {
      const a = assess(real);
      check('fake-site check leaves ' + new URL(real).hostname + ' alone', !(a.imitates && a.score >= 45), a.score + ' ' + a.reasons.map((r) => r.title).join('; '));
    }
    const fake = assess('https://paypal-login.com/');
    check('and still flags paypal-login.com', fake.imitates && fake.score >= 60, String(fake.score));

    // ---- the warning page from the keyboard ------------------------------------------------
    set({ safeBrowsing: 'standard' });
    w.tabs.navigate(w.tabs.activeId, `http://secure-paypal-login.probe.test:${port}/`);
    check('an imitation address gets the warning', !!(await onWarning()));
    await wait(400);
    wc().focus();
    const focused = () => wc().executeJavaScript('document.activeElement?.id || ""');
    check('Back to safety has the focus to start with', (await focused()) === 'back', await focused());
    await key(wc(), 'Tab');
    console.log('after one Tab:', await focused());
    if ((await focused()) !== 'details-toggle') await key(wc(), 'Tab');
    check('Tab reaches Details', (await focused()) === 'details-toggle', await focused());
    await key(wc(), 'Return');
    check('Enter opens the details', await wc().executeJavaScript(`!document.getElementById('details').hidden`));
    await shoot('suspicious-details');
    await key(wc(), 'Tab');
    check('then Tab reaches Continue', (await focused()) === 'continue', await focused());
    await key(wc(), 'Return');
    check('Enter asks to confirm, with Cancel focused', (await focused()) === 'confirm-no', await focused());
    await key(wc(), 'Escape');
    check('Escape steps back out of the confirmation', await wc().executeJavaScript(`document.getElementById('confirm').hidden && !document.getElementById('continue').hidden`));
    await shoot('suspicious-keyboard');
  } catch (error) {
    check('no errors', false, error.stack || error.message);
  }
  set({ secureDns: 'automatic', httpsOnly: false });
  server.close();
  console.log(failures.length ? '\n' + failures.length + ' FAILURES' : '\nall review checks passed');
  app.exit(failures.length ? 1 : 0);
}
module.exports = { run };
