const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { execFileSync } = require('node:child_process');

/**
 * Network protection, end to end (features/netguard):
 *
 *   node scripts/start.cjs --netprivacy
 *   node scripts/start.cjs --netprivacy --incognito
 *
 * Local servers stand in for the web. Main maps *.probe.test to this
 * computer in probe mode, so they have public-looking names that are not
 * left alone the way localhost is.
 *
 *   - privacy signals: Sec-GPC and DNT headers as the server received them,
 *     navigator.globalPrivacyControl / doNotTrack in the page AND in an iframe
 *     on another site, Strict referrers (header and document.referrer)
 *   - WebRTC: the policy on every tab, changed live
 *   - Secure DNS: app.configureHostResolver, spied on, from Settings changes
 *   - Safe Browsing: a listed host gets the red warning page (real clicks on
 *     Back to safety, Details, Continue, the confirmation), the blocked entry
 *     is not left in history, the site card offers to warn again, listed
 *     subresources never reach the server, the fake-site check, Enhanced's
 *     download warning
 *   - bounce tracking and AMP: redirect hops and AMP viewers skipped, an AMP
 *     page that names its real page left for it
 *   - HTTPS-only: the warning for a site with no https and Continue over http;
 *     without it, the quiet upgrade falling back to http
 *   - certificates: a self-signed local https site gets the certificate
 *     warning; a real https site shows Certificate rows in the site card
 *   - Settings: the three groups, the level tiles, clicked
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
  const until = async (fn, tries = 60, every = 100) => {
    for (let i = 0; i < tries; i++) { const v = await Promise.resolve().then(fn).catch(() => null); if (v) return v; await wait(every); }
    return null;
  };

  // ---- the local web ----------------------------------------------------------
  const seen = [];
  let port = 0;
  const page = (title, body) => `<!doctype html><title>${title}</title><body style="margin:0;font:22px system-ui;background:#1d2b3a;color:#fff;padding:30px">${body}</body>`;
  const server = http.createServer((req, res) => {
    const host = String(req.headers.host || '').split(':')[0];
    seen.push({ host, path: req.url, gpc: req.headers['sec-gpc'] || '', dnt: req.headers.dnt || '', referer: req.headers.referer || '' });
    const send = (body, type = 'text/html') => { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    const url = req.url;
    if (url.startsWith('/signals')) {
      return send(page('Signals', `<img referrerpolicy="unsafe-url" src="http://other.probe.test:${port}/pixel.png?n=${Date.now()}">
        <iframe src="http://frame.probe.test:${port}/frame" style="width:300px;height:80px"></iframe>
        <a id="away" referrerpolicy="unsafe-url" href="http://localhost:${port}/landing">away</a>`));
    }
    if (url.startsWith('/frame')) return send(page('Frame', 'an iframe on another site'));
    if (url.startsWith('/pixel.png')) return send('', 'image/png');
    if (url.startsWith('/withbad')) return send(page('Has a bad script', `<script src="http://badsub.probe.test:${port}/x.js"></script>ok`));
    if (url.startsWith('/amp-article')) {
      return send(`<!doctype html><html amp><head><title>AMP</title><link rel="canonical" href="http://localhost:${port}/real-article"></head><body>amp</body></html>`);
    }
    if (url.startsWith('/file.exe')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="setup.exe"' });
      return res.end(Buffer.alloc(2048, 1));
    }
    return send(page(url.split('?')[0].slice(1) || 'Home', 'Page ' + url));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  const at = (host, p) => `http://${host}:${port}${p}`;
  const hits = (host, prefix) => seen.filter((r) => r.host === host && r.path.startsWith(prefix));

  // A self-signed https site, if openssl is on this computer.
  let tlsServer = null;
  let tlsPort = 0;
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-probe-tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
      '-days', '2', '-subj', '/CN=selfsigned.probe.test', '-addext', 'subjectAltName=DNS:selfsigned.probe.test'], { stdio: 'ignore' });
    tlsServer = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) }, (req, res) => {
      seen.push({ host: 'tls', path: req.url });
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(page('Self-signed', `You went ahead<img src="http://other.probe.test:${port}/pixel.png?mixed"><script src="http://other.probe.test:${port}/mixed.js"></script>`));
    });
    await new Promise((resolve) => tlsServer.listen(0, '127.0.0.1', resolve));
    tlsPort = tlsServer.address().port;
  } catch { tlsServer = null; }

  const w = browser.front;
  const g = browser.netguard;
  const tab = () => w.tabs.active;
  const wc = () => tab().view.webContents;
  const chrome = () => w.chrome.webContents;
  const overlay = () => w.overlay.webContents;
  const settle = () => until(() => !tab().state.loading, 100);
  const go = async (url) => { w.tabs.navigate(w.tabs.activeId, url); await wait(150); await settle(); await wait(250); };
  const click = async (contents, x, y) => {
    contents.sendInputEvent({ type: 'mouseMove', x, y });
    await wait(40);
    contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await wait(60);
  };
  const where = (contents, selector) => contents.executeJavaScript(`(() => { const n = document.querySelector(${JSON.stringify(selector)});
    if (!n || n.hidden || !n.getClientRects().length) return null; n.scrollIntoView({ block: 'center' }); const b = n.getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
  const press = async (selector, contents = wc()) => {
    const p = await until(() => where(contents, selector), 30);
    if (!p) return false;
    await click(contents, p.x, p.y);
    return true;
  };
  const text = (selector, contents = wc()) => contents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.textContent || ''`).catch(() => '');
  const shoot = async (name, contents = wc()) => {
    await wait(450);
    const img = await contents.capturePage().catch(() => null);
    if (img && !img.isEmpty()) fs.writeFileSync(path.join(shots, 'netprivacy-' + tag + '-' + name + '.png'), img.toPNG());
  };
  const onWarning = () => until(() => /^browser:\/\/warning/.test(tab().state.internalUrl || '') && !tab().state.loading, 80);
  const history = () => wc().navigationHistory.getAllEntries().map((e) => e.url);
  const stat = (key) => browser.shields.stats.totals(1)[key] || 0;
  const set = (patch) => { browser.settings.update(patch); g.settingsChanged(patch); browser.push(); };
  const card = () => overlay().executeJavaScript(`(() => {
    const head = document.querySelector('.menu-site'); if (!head) return null;
    return { title: head.querySelector('strong')?.textContent, subtitle: head.querySelector('small')?.textContent || '', tone: head.className,
      facts: [...document.querySelectorAll('.menu-site-facts div')].map((d) => d.querySelector('dt').textContent + '=' + d.querySelector('dd').textContent),
      items: [...document.querySelectorAll('.menu-item, .menu-segment-row')].map((n) => n.textContent.trim().replace(/\\s+/g, ' ')),
      width: Math.round(document.querySelector('.menu').getBoundingClientRect().width) }; })()`);
  const openCard = async () => {
    w.closeMenu(); await wait(250);
    await press('#security', chrome());
    return until(card, 40);
  };
  const choose = async (label) => {
    const p = await overlay().executeJavaScript(`(() => { const n = [...document.querySelectorAll('.menu-item, button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)}));
      if (!n) return null; const b = n.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
    if (!p) return false;
    await click(overlay(), p.x, p.y);
    return true;
  };

  try {
    await until(() => !chrome().isLoading() && w.tabs.order.length, 80);
    await wait(1200);
    check('network protection is running', !!g && typeof g.inspect === 'function');
    // The profile is kept between runs: start from no choices made.
    g.forget({ all: true });
    g.httpThisSession.clear();

    // ---- privacy signals ---------------------------------------------------------
    await go(at('127.0.0.1', '/signals?secret=1'));
    await until(() => hits('frame.probe.test', '/frame').length && hits('other.probe.test', '/pixel').length, 50);
    const doc = hits('127.0.0.1', '/signals').at(-1);
    check('Global Privacy Control is sent with the page request (Sec-GPC: 1)', doc?.gpc === '1', JSON.stringify(doc));
    check('and with its subresources', hits('other.probe.test', '/pixel').at(-1)?.gpc === '1');
    check('Do Not Track is not sent by default', doc?.dnt === '', doc?.dnt);
    check('navigator.globalPrivacyControl is true in the page', await wc().executeJavaScript('navigator.globalPrivacyControl === true && "globalPrivacyControl" in navigator'));
    check('navigator.doNotTrack is unset by default', (await wc().executeJavaScript('String(navigator.doNotTrack)')) === 'null');
    const frame = await until(() => wc().mainFrame.frames.find((f) => /frame\.probe\.test/.test(f.url)), 40);
    check('the iframe on another site loaded', !!frame, wc().mainFrame.frames.map((f) => f.url).join(','));
    if (frame) check('navigator.globalPrivacyControl is true in that iframe too', (await frame.executeJavaScript('String(navigator.globalPrivacyControl)')) === 'true');
    check('Standard referrers: a page asking for its full address sends it', /\/signals\?secret=1$/.test(hits('other.probe.test', '/pixel').at(-1)?.referer || ''), hits('other.probe.test', '/pixel').at(-1)?.referer);

    set({ doNotTrack: true, referrerPolicy: 'strict' });
    await go(at('127.0.0.1', '/signals?secret=2'));
    await until(() => hits('other.probe.test', '/pixel').length >= 2, 50);
    check('Do Not Track on: DNT: 1 is sent', hits('127.0.0.1', '/signals').at(-1)?.dnt === '1');
    check('and navigator.doNotTrack is "1"', (await wc().executeJavaScript('navigator.doNotTrack')) === '1');
    const strictRef = hits('other.probe.test', '/pixel').at(-1)?.referer;
    check('Strict referrers: another site gets only the origin', strictRef === `http://127.0.0.1:${port}/`, strictRef);
    await wc().executeJavaScript('document.getElementById("away").click()');
    await until(() => hits('localhost', '/landing').length, 50);
    await settle();
    check('a link to another site sends only the origin, whatever the page asked', hits('localhost', '/landing').at(-1)?.referer === `http://127.0.0.1:${port}/`, hits('localhost', '/landing').at(-1)?.referer);
    check('and document.referrer there reads the same', (await wc().executeJavaScript('document.referrer')) === `http://127.0.0.1:${port}/`);
    set({ gpc: false, doNotTrack: false, referrerPolicy: 'standard' });
    await go(at('127.0.0.1', '/signals?secret=3'));
    check('Global Privacy Control off: no Sec-GPC header', hits('127.0.0.1', '/signals').at(-1)?.gpc === '');
    check('and no navigator.globalPrivacyControl', (await wc().executeJavaScript('String(navigator.globalPrivacyControl)')) === 'undefined');
    set({ gpc: true });

    // ---- WebRTC --------------------------------------------------------------------
    check('WebRTC: Standard keeps calls to the public interface', wc().getWebRTCIPHandlingPolicy() === 'default_public_interface_only', wc().getWebRTCIPHandlingPolicy());
    set({ webrtcPolicy: 'strict' });
    check('Strict applies to open tabs at once', wc().getWebRTCIPHandlingPolicy() === 'disable_non_proxied_udp', wc().getWebRTCIPHandlingPolicy());
    const extra = w.tabs.create({ url: at('127.0.0.1', '/two'), background: true });
    check('and to tabs opened after', w.tabs.tabs.get(extra).view.webContents.getWebRTCIPHandlingPolicy() === 'disable_non_proxied_udp');
    set({ webrtcPolicy: 'off' });
    check('Off is Chromium\'s default', wc().getWebRTCIPHandlingPolicy() === 'default');
    set({ webrtcPolicy: 'standard' });
    w.tabs.close(extra);
    await wait(200);

    // ---- Secure DNS ---------------------------------------------------------------
    const dnsCalls = [];
    const configure = app.configureHostResolver;
    app.configureHostResolver = (config) => { dnsCalls.push(JSON.parse(JSON.stringify(config))); return configure.call(app, config); };
    set({ secureDns: 'secure', secureDnsProvider: 'quad9' });
    check('Secure DNS with Quad9 configures the resolver', dnsCalls.at(-1)?.secureDnsMode === 'secure' && dnsCalls.at(-1)?.secureDnsServers?.[0] === 'https://dns.quad9.net/dns-query', JSON.stringify(dnsCalls.at(-1)));
    set({ secureDnsProvider: 'custom', secureDnsCustom: 'https://dns.example.com/dns-query{?dns}' });
    check('a custom provider is used as typed', dnsCalls.at(-1)?.secureDnsServers?.[0] === 'https://dns.example.com/dns-query{?dns}', JSON.stringify(dnsCalls.at(-1)));
    let refused = '';
    try { browser.settings.update({ secureDnsCustom: 'http://dns.example.com/q' }); } catch (error) { refused = error.message; }
    check('a custom provider that is not https is refused, with a reason', /https/.test(refused), refused);
    set({ secureDns: 'off' });
    check('Off asks the computer\'s own resolver', dnsCalls.at(-1)?.secureDnsMode === 'off');
    set({ secureDns: 'automatic', secureDnsProvider: 'cloudflare', secureDnsCustom: '' });
    check('and Automatic is back', dnsCalls.at(-1)?.secureDnsMode === 'automatic');

    // ---- Safe Browsing: a listed site ----------------------------------------------
    g.threats.inject('phishing', 'evil.probe.test\n');
    g.threats.inject('badware', '||badsub.probe.test^$all\n');
    await go(at('127.0.0.1', '/start'));
    const phishingBefore = stat('phishing');
    w.tabs.navigate(w.tabs.activeId, at('evil.probe.test', '/login'));
    check('a listed site gets the warning page', !!(await onWarning()), tab().state.internalUrl);
    await wait(500);
    check('nothing was asked of the dangerous site', hits('evil.probe.test', '/').length === 0);
    check('the address bar shows the address it is about', tab().state.displayUrl === at('evil.probe.test', '/login'), tab().state.displayUrl);
    check('marked as dangerous, not secure', tab().state.security === 'danger', tab().state.security);
    check('it says Dangerous site ahead and what kind of threat', /Dangerous site ahead/.test(await text('#eyebrow')) && /steal your details/.test(await text('#title')), await text('#eyebrow') + ' / ' + await text('#title'));
    check('the main button is Back to safety', (await text('#back')) === 'Back to safety');
    check('the tab is titled for the danger', tab().state.title === 'Dangerous site ahead', tab().state.title);
    check('it is counted in the Shields stats', stat('phishing') === phishingBefore + 1, stat('phishing') - phishingBefore);
    check('the blocked load is not left in history', !history().some((u) => /^https?:\/\/evil\.probe\.test/.test(u)), history().join(' | '));
    await shoot('threat');
    await shoot('chrome-danger', chrome());
    {
      const danger = await openCard();
      check('the site card on a warning says the page was stopped', danger?.title === 'evil.probe.test' && /tone-danger/.test(danger?.tone || '') && /stopped/.test(danger?.subtitle || ''), JSON.stringify(danger));
      await shoot('sitecard-danger', overlay());
      w.closeMenu();
      await wait(250);
    }
    await press('#details-toggle');
    await wait(300);
    const facts = await wc().executeJavaScript(`[...document.querySelectorAll('#facts div')].map((d) => d.children[0].textContent + '=' + d.children[1].textContent)`);
    check('Details names the list that said so', facts.includes('Listed on=Phishing URL Blocklist'), facts.join(' | '));
    check('and the entry that matched', facts.includes('Matched=evil.probe.test'));
    check('Continue anyway is behind Details', !!(await where(wc(), '#continue')));
    await shoot('threat-details');
    await press('#back');
    const backed = await until(() => tab().state.displayUrl === at('127.0.0.1', '/start') && !tab().state.loading, 60);
    check('Back to safety goes back to the page before', !!backed, tab().state.displayUrl);
    {
      const h = history();
      const i = wc().navigationHistory.getActiveIndex();
      check('and Back from there leads further back, not into the warning', i > 0 && !/warning\.html|evil\.probe/.test(h[i - 1]), h[i - 1]);
    }

    w.tabs.navigate(w.tabs.activeId, at('evil.probe.test', '/login'));
    await onWarning();
    await wait(300);
    await press('#details-toggle');
    await press('#continue');
    check('Continue asks once more, deliberately', !!(await until(() => where(wc(), '#confirm-yes'), 20)) && !(await where(wc(), '#continue')));
    await shoot('threat-confirm');
    await press('#confirm-no');
    check('Cancel steps back from it', !!(await until(() => where(wc(), '#continue'), 20)));
    await press('#continue');
    await press('#confirm-yes');
    const opened = await until(() => tab().state.displayUrl === at('evil.probe.test', '/login') && !tab().state.internalUrl && !tab().state.loading, 80);
    check('Open it anyway opens the site', !!opened && hits('evil.probe.test', '/login').length === 1, tab().state.displayUrl);
    check('the choice is remembered for the site', !!g.store.data.allowedSites['evil.probe.test']);
    check('the warning is not left in history', !history().some((u) => /warning\.html/.test(u)), history().join(' | '));
    const sbCard = await openCard();
    check('the site card says you went past a warning', (sbCard?.facts || []).includes('Safe Browsing=Warned · you went ahead'), (sbCard?.facts || []).join(' | '));
    await choose('Warn me about this site again');
    check('and Warn me again forgets the choice', !!(await until(() => !g.store.data.allowedSites['evil.probe.test'], 30)));
    w.closeMenu();

    // A listed script never reaches the server.
    const dangerousBefore = stat('dangerous');
    await go(at('127.0.0.1', '/withbad'));
    await wait(500);
    check('a listed script on an ordinary page is stopped', hits('badsub.probe.test', '/').length === 0 && hits('127.0.0.1', '/withbad').length > 0);
    check('and counted', stat('dangerous') === dangerousBefore + 1, stat('dangerous') - dangerousBefore);

    // The fake-site check is part of Standard.
    w.tabs.navigate(w.tabs.activeId, at('paypal.com.account-verify.probe.test', '/'));
    check('an address imitating a brand gets the warning', !!(await onWarning()));
    await wait(300);
    check('which says it looks like a fake, and why', /looks like a fake/.test(await text('#title')) && /Looks like paypal/.test(await text('#reasons')), await text('#reasons'));
    await shoot('suspicious');
    await press('#back');
    await settle();

    // Enhanced: a stricter fake-site check.
    w.tabs.navigate(w.tabs.activeId, at('paypal.shop.deals.probe.test', '/'));
    await wait(1500); await settle();
    check('Standard lets a milder look-alike through', !/^browser:\/\/warning/.test(tab().state.internalUrl || ''));
    set({ safeBrowsing: 'enhanced' });
    w.tabs.navigate(w.tabs.activeId, at('paypal.shop.deals2.probe.test', '/'));
    check('Enhanced warns about it', !!(await onWarning()));
    await press('#back'); await settle();

    // Enhanced: a program from a site never visited before.
    const saved = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'static-probe-dl-')), 'setup.exe');
    browser.session.on('will-download', (event, item) => { if (!event.defaultPrevented) item.setSavePath(saved); });
    const listBefore = browser.downloads.list().length;
    await go(at('localhost', '/start'));
    w.tabs.navigate(w.tabs.activeId, at('localhost', '/file.exe'));
    const asked = await until(() => overlay().executeJavaScript(`document.querySelector('.menu-site strong')?.textContent || ''`).then((t) => t === 'This file could harm your computer' && t), 60);
    check('Enhanced warns before a program from a site never visited', !!asked);
    await shoot('download', overlay());
    await choose('Don’t download');
    await wait(800);
    check('Don\'t download keeps nothing', !fs.existsSync(saved) && browser.downloads.list().length === listBefore);
    w.tabs.navigate(w.tabs.activeId, at('localhost', '/file.exe'));
    await until(() => overlay().executeJavaScript(`document.querySelector('.menu-site strong')?.textContent || ''`).then((t) => t === 'This file could harm your computer'), 60);
    await choose('Download anyway');
    check('Download anyway downloads it', !!(await until(() => fs.existsSync(saved) && fs.statSync(saved).size === 2048, 80)));
    set({ safeBrowsing: 'standard' });

    // Off: nothing at all.
    set({ safeBrowsing: 'off' });
    await go(at('evil.probe.test', '/off'));
    check('Safe Browsing off: the listed site just opens', !/^browser:\/\/warning/.test(tab().state.internalUrl || '') && hits('evil.probe.test', '/off').length === 1);
    set({ safeBrowsing: 'standard' });

    // ---- bounce tracking and AMP ---------------------------------------------------
    const bounceBefore = stat('bounce');
    await go('https://www.google.com/url?q=' + encodeURIComponent(at('localhost', '/landed-google')) + '&sa=D');
    check('google.com/url goes straight to where it points', tab().state.displayUrl === at('localhost', '/landed-google'), tab().state.displayUrl);
    await go('https://l.facebook.com/l.php?u=' + encodeURIComponent(at('localhost', '/landed-facebook')) + '&h=AT1');
    check('l.facebook.com/l.php too', tab().state.displayUrl === at('localhost', '/landed-facebook'), tab().state.displayUrl);
    await go('https://out.reddit.com/t3_x?url=' + encodeURIComponent(at('localhost', '/landed-reddit')) + '&token=1');
    check('and out.reddit.com', tab().state.displayUrl === at('localhost', '/landed-reddit'), tab().state.displayUrl);
    check('each skip is counted', stat('bounce') === bounceBefore + 3, stat('bounce') - bounceBefore);
    const ampBefore = stat('amp');
    await go('https://www.google.com/amp/localhost:' + port + '/amp-viewer');
    check('Google\'s AMP viewer goes to the publisher\'s page', tab().state.displayUrl === at('localhost', '/amp-viewer'), tab().state.displayUrl);
    await go(at('localhost', '/amp-article'));
    const real = await until(() => tab().state.displayUrl === at('localhost', '/real-article') && !tab().state.loading, 60);
    check('an AMP page that names its real page is left for it', !!real, tab().state.displayUrl);
    check('without the AMP page left in history', !history().some((u) => u.includes('/amp-article')), history().join(' | '));
    check('AMP skips are counted', stat('amp') === ampBefore + 2, stat('amp') - ampBefore);
    set({ bounceTracking: false });
    await go('https://www.google.com/url?q=' + encodeURIComponent(at('localhost', '/x')));
    check('with bounce tracking off the hop is left alone', /google\./.test(tab().state.displayUrl || '') || tab().state.security === 'error', tab().state.displayUrl);
    set({ bounceTracking: true });

    // ---- https ---------------------------------------------------------------------
    await go(at('quiet.probe.test', '/page'));
    await until(() => tab().state.displayUrl === at('quiet.probe.test', '/page') && !tab().state.loading, 80);
    check('without HTTPS-only, a site with no https opens over http', tab().state.displayUrl === at('quiet.probe.test', '/page') && hits('quiet.probe.test', '/page').length === 1, tab().state.displayUrl);
    check('and the failed https try is not left in history', !history().some((u) => u.startsWith('https://quiet.probe.test')), history().join(' | '));
    set({ httpsOnly: true });
    w.tabs.navigate(w.tabs.activeId, at('plain.probe.test', '/page'));
    check('HTTPS-only: a site with no https gets a warning', !!(await onWarning()), tab().state.internalUrl);
    await wait(300);
    check('which says it has no secure version', /no secure version/.test(await text('#title')), await text('#title'));
    check('and the http page was never asked for', hits('plain.probe.test', '/page').length === 0);
    await shoot('nohttps');
    await press('#plain-continue');
    const http1 = await until(() => tab().state.displayUrl === at('plain.probe.test', '/page') && !tab().state.loading, 80);
    check('Continue over http opens it', !!http1 && hits('plain.probe.test', '/page').length === 1, tab().state.displayUrl);
    w.tabs.navigate(w.tabs.activeId, at('plain.probe.test', '/again'));
    await until(() => hits('plain.probe.test', '/again').length, 60);
    check('and is remembered for the site', !/^browser:\/\/warning/.test(tab().state.internalUrl || ''));
    set({ httpsOnly: false });

    // ---- certificates ----------------------------------------------------------
    if (tlsServer) {
      w.tabs.navigate(w.tabs.activeId, `https://selfsigned.probe.test:${tlsPort}/`);
      check('a self-signed certificate gets the certificate warning', !!(await onWarning()), tab().state.internalUrl);
      await wait(300);
      check('saying the connection is not private', /is not private/.test(await text('#title')) && /Not from a trusted authority/.test(await text('#eyebrow')), await text('#eyebrow'));
      check('and nothing was sent to the site', hits('tls', '/').length === 0);
      await press('#details-toggle');
      await shoot('cert');
      const certFacts = await wc().executeJavaScript(`[...document.querySelectorAll('#facts div')].map((d) => d.children[0].textContent + '=' + d.children[1].textContent)`);
      check('Details shows who it was issued to', certFacts.includes('Issued to=selfsigned.probe.test'), certFacts.join(' | '));
      await press('#continue');
      await press('#confirm-yes');
      check('Continue opens it, for this run', !!(await until(() => hits('tls', '/').length && !tab().state.internalUrl, 80)));
      await settle(); await wait(600);
      check('a certificate you went past is not shown as secure', tab().state.security === 'insecure', tab().state.security);
      const bypassed = await openCard();
      check('the site card says the certificate is not trusted', (bypassed?.facts || []).includes('Certificate=Not trusted · you went ahead'), (bypassed?.facts || []).join(' | '));
      const mixed = (bypassed?.facts || []).find((f) => f.startsWith('Insecure content='));
      check('and counts the insecure content on the page', /1 blocked/.test(mixed || '') && /1 made secure/.test(mixed || ''), mixed);
      check('the insecure script never reached the server', hits('other.probe.test', '/mixed.js').length === 0);
      await shoot('sitecard-bypassed', overlay());
      w.closeMenu();
    } else console.log('  --  openssl not found: the certificate warning was not checked');

    await go('https://example.com/');
    if (tab().state.security === 'secure') {
      const info = await openCard();
      const cert = (info?.facts || []).find((f) => f.startsWith('Certificate='));
      check('a real https site: the site card has a Certificate row', !!cert && / · until /.test(cert), (info?.facts || []).join(' | '));
      check('and Certificate details', (info?.items || []).some((i) => i.startsWith('Certificate details')), (info?.items || []).join(' | '));
      check('the card stays a comfortable width', info?.width >= 250 && info?.width <= 340, info?.width);
      await shoot('sitecard-cert', overlay());
      await choose('Certificate details');
      const details = await until(async () => { const c = await card(); return c?.title === 'Certificate' && c; }, 30);
      const rows = (details?.facts || []).map((f) => f.split('=')[0]);
      check('Certificate details: issued to, by, validity and fingerprint', ['Issued to', 'Issued by', 'Valid from', 'Valid until', 'SHA-256'].every((r) => rows.includes(r)), rows.join(', '));
      await shoot('certificate', overlay());
      await choose('Back to site information');
      check('and back to the site card', !!(await until(async () => (await card())?.title === 'example.com', 30)));
      w.closeMenu();
      set({ httpsOnly: true });
      await go('http://example.com/');
      check('HTTPS-only opens a site that has https over https', tab().state.displayUrl === 'https://example.com/' && tab().state.security === 'secure', tab().state.displayUrl);
      set({ httpsOnly: false });
    } else console.log('  --  no network: the certificate rows were not checked');

    // ---- Settings ------------------------------------------------------------------
    await go('browser://settings#privacy');
    await until(() => where(wc(), '#net-safe'), 40);
    check('Settings has the three groups', ['Safe Browsing', 'Secure connections', 'Tracking protection'].every((h) => true) &&
      (await wc().executeJavaScript(`[...document.querySelectorAll('[data-section="privacy"] h2')].map((h) => h.textContent).join('|')`)).includes('Safe Browsing|Secure connections|Tracking protection'));
    check('the level reads Standard', await wc().executeJavaScript(`document.querySelector('input[name="net-level"][value="standard"]').checked`));
    await press('input[name="net-level"][value="strict"]');
    await until(() => browser.settings.value.referrerPolicy === 'strict', 30);
    check('clicking Strict sets Strict referrers and WebRTC', browser.settings.value.referrerPolicy === 'strict' && browser.settings.value.webrtcPolicy === 'strict' && browser.settings.value.fingerprinting === 'strict');
    check('and WebRTC follows on the open tabs', wc().getWebRTCIPHandlingPolicy() === 'disable_non_proxied_udp');
    await press('#net-doNotTrack');
    await until(() => browser.settings.value.doNotTrack === true, 30);
    check('a switch changed by hand makes it Custom', !!(await until(() => wc().executeJavaScript(`document.querySelector('input[name="net-level"][value="custom"]').checked`), 30)));
    await wc().executeJavaScript(`document.querySelectorAll('.net-tiles')[1].closest('.card').previousElementSibling.scrollIntoView({ block: 'start' });`);
    await shoot('settings-tracking');
    await press('input[name="net-level"][value="standard"]');
    check('and Standard puts every switch back', !!(await until(() => g.level() === 'standard' && browser.settings.value.doNotTrack === false, 30)), g.level());
    await press('input[name="net-safe"][value="off"]');
    check('Safe Browsing Off says plainly what is lost', !!(await until(() => where(wc(), '#net-safe-off'), 30)));
    await wc().executeJavaScript(`document.querySelector('#net-safe').previousElementSibling.scrollIntoView({ block: 'start' })`);
    await shoot('settings-safe-off');
    await press('input[name="net-safe"][value="standard"]');
    await until(() => browser.settings.value.safeBrowsing === 'standard', 30);
    await wc().executeJavaScript(`document.getElementById('net-secureDns').value = 'secure'; document.getElementById('net-secureDns').dispatchEvent(new Event('change'))`);
    check('choosing Always encrypted shows the provider', !!(await until(() => where(wc(), '#net-dnsProvider'), 30)) && browser.settings.value.secureDns === 'secure');
    await wc().executeJavaScript(`document.getElementById('net-dnsProvider').value = 'custom'; document.getElementById('net-dnsProvider').dispatchEvent(new Event('change'))`);
    await wc().executeJavaScript(`{ const i = document.getElementById('net-dnsCustom'); i.value = 'ftp://nope'; i.dispatchEvent(new Event('change')) }`);
    check('a bad custom address is refused on the page, with the reason', !!(await until(async () => /must start with https/.test(await text('#net-custom-hint')), 30)), await text('#net-custom-hint'));
    await wc().executeJavaScript(`document.querySelector('#net-secureDns').closest('.card').previousElementSibling.scrollIntoView({ block: 'start' })`);
    await shoot('settings-secure');
    await wc().executeJavaScript(`document.getElementById('net-secureDns').value = 'automatic'; document.getElementById('net-secureDns').dispatchEvent(new Event('change'))`);
    await until(() => browser.settings.value.secureDns === 'automatic', 30);
    await wc().executeJavaScript(`{ const s = document.getElementById('settings-search'); s.value = 'webrtc'; s.dispatchEvent(new Event('input')) }`);
    await wait(200);
    check('Settings search finds WebRTC', await wc().executeJavaScript(`!document.querySelector('#net-webrtcPolicy').closest('.field').hidden && document.querySelector('#net-httpsOnly').closest('.field').hidden`));
    await wc().executeJavaScript(`{ const s = document.getElementById('settings-search'); s.value = 'dns over https'; s.dispatchEvent(new Event('input')) }`);
    await wait(200);
    check('and Secure DNS', await wc().executeJavaScript(`!document.querySelector('#net-secureDns').closest('.field').hidden`));
    await wc().executeJavaScript(`{ const s = document.getElementById('settings-search'); s.value = ''; s.dispatchEvent(new Event('input')) }`);

    // ---- the warning page on a light planet ----------------------------------------
    if (!browser.incognito) {
      const theme = browser.settings.value.theme;
      set({ theme: 'venus' });
      w.tabs.navigate(w.tabs.activeId, at('evil.probe.test', '/light'));
      await onWarning();
      await shoot('threat-light');
      await go('browser://settings#privacy');
      await until(() => where(wc(), '#net-safe'), 40);
      await wc().executeJavaScript(`document.querySelector('#net-safe').previousElementSibling.scrollIntoView({ block: 'start' })`);
      await shoot('settings-light');
      set({ theme });
    }
  } catch (error) {
    check('no errors', false, error.stack || error.message);
  }
  server.close();
  tlsServer?.close();
  console.log(failures.length ? '\n' + failures.length + ' FAILURES' : '\nall network protection checks passed');
  app.exit(failures.length ? 1 : 0);
}
module.exports = { run };
