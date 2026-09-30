const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

/**
 * "You have a saved login here - one click to fill", off-screen:
 *   - the callout under the sign-in box when a sign-in page opens
 *   - only a REAL click fills (the page cannot script it)
 *   - the key in the address bar, and filling from it
 *   - username-first sign-in pages (Google-style)
 *   - suggestions no longer steal the keyboard: not on page autofocus, and
 *     when shown, typing still reaches the page; the down arrow moves into
 *     them; a click elsewhere closes them AND lands on the page
 *   - a locked vault asks for the master password first
 *   - it is styled even under a strict Content-Security-Policy
 */
const LOGIN = (extra = '') => `<!doctype html><title>Sign in</title>${extra}
<form id="f" onsubmit="event.preventDefault(); document.body.dataset.signedIn = document.getElementById('u').value">
<label for="u">Email</label><input id="u" name="email" type="email" autocomplete="username">
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password">
<button type="submit">Sign in</button></form><p style="height:420px"></p><input id="other" placeholder="Search this site">`;
const STEP1 = `<!doctype html><title>Sign in - step 1</title><form onsubmit="event.preventDefault()">
<label for="id">Email or phone</label><input id="id" type="email" name="identifier" autocomplete="username"><button>Next</button></form>`;
const AUTOFOCUS = LOGIN().replace('autocomplete="username">', 'autocomplete="username" autofocus>');

async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 240) : ''));
    if (!ok) fails++;
  };
  const until = async (fn, tries = 60, ms = 150) => { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await wait(ms); } return null; };
  const server = http.createServer((q, res) => {
    const strict = q.url.startsWith('/strict');
    res.writeHead(200, { 'content-type': 'text/html', ...(strict ? { 'content-security-policy': "default-src 'self'; style-src 'none'; script-src 'unsafe-inline'" } : {}) });
    res.end(q.url.startsWith('/step1') ? STEP1 : q.url.startsWith('/autofocus') ? AUTOFOCUS : LOGIN());
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://localhost:' + server.address().port;
  const V = browser.passwords;
  const overlay = (js) => browser.overlay.webContents.executeJavaScript(js);
  const shots = path.join(app.getAppPath(), 'shots');
  fs.mkdirSync(shots, { recursive: true });

  try {
    await until(() => browser.tabs?.active, 80);
    await wait(600);
    browser.biometric.testAnswer = 'approve';
    if (V.hasMaster) { V.key = null; V.data.lock = null; V.save(); }
    V.clear();
    browser.autofill.setPrefs({ autoSignIn: true, loginHints: true });
    browser.autoSignedIn?.clear();
    V.save_credential({ url: base, username: 'sam@example.com', password: 'first-Secret-1' });
    V.save_credential({ url: base, username: 'kim@example.com', password: 'second-Secret-2' });

    const tab = browser.tabs.active;
    const wc = tab.view.webContents;
    const bounds = browser.window.getBounds();
    browser.window.setBounds({ ...bounds, width: 1280, height: 860 });
    const go = async (url) => {
      browser.tabs.navigate(tab.id, url);
      await until(() => !wc.isLoading() && wc.getURL().startsWith(url));
      await wait(700);
    };
    // The callout, seen the way a probe may: its (probe-only) open shadow root.
    const card = () => wc.executeJavaScript(`(() => {
      const host = [...document.querySelectorAll('body > div')].find((d) => d.shadowRoot && d.shadowRoot.querySelector('.card'));
      if (!host || host.style.display === 'none') return null;
      const root = host.shadowRoot;
      const fills = [...root.querySelectorAll('.fill')].map((b) => { const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: b.getAttribute('aria-label'), disabled: b.disabled }; });
      return { text: root.querySelector('.card').textContent, fills, radius: getComputedStyle(root.querySelector('.card')).borderRadius };
    })()`);
    const click = async (target, x, y) => {
      target.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
      target.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
    };
    const fields = () => wc.executeJavaScript(`[document.getElementById('u')?.value, document.getElementById('p')?.value]`);
    const rectOf = (selector) => wc.executeJavaScript(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);

    // 1. Opening a sign-in page with two saved logins: the callout, no auto sign-in.
    await go(base + '/login');
    const shown = await until(card);
    check('a sign-in page with saved logins shows the callout under the box', !!shown && /Saved logins for localhost:\d+/.test(shown.text), shown?.text);
    check('listing the saved accounts, each one click to fill', shown && shown.fills.length === 2 && shown.fills.every((f) => /^Fill (sam|kim)@example.com$/.test(f.label)), JSON.stringify(shown?.fills));
    check('and nothing is filled or submitted by itself', JSON.stringify(await fields()) === '["",""]' && !(await wc.executeJavaScript('document.body.dataset.signedIn || ""')));
    await wait(300);
    let image = await wc.capturePage().catch(() => null);
    if (image && !image.isEmpty()) fs.writeFileSync(path.join(shots, 'callout.png'), image.toPNG());

    // 2. The page cannot press Fill for you.
    await wc.executeJavaScript(`(() => { const host = [...document.querySelectorAll('body > div')].find((d) => d.shadowRoot); host.shadowRoot.querySelector('.fill').click(); })()`);
    await wait(500);
    check('a click scripted by the page does not fill', JSON.stringify(await fields()) === '["",""]');

    // 3. A real click does.
    const first = (await card()).fills.find((f) => f.label === 'Fill kim@example.com');
    await click(wc, first.x, first.y);
    const filled = await until(async () => { const f = await fields(); return f[1] ? f : null; });
    check('a real click on Fill fills that account at once', filled && filled[0] === 'kim@example.com' && filled[1] === 'second-Secret-2', JSON.stringify(filled));
    check('and the callout goes away', !(await until(async () => !(await card()), 20)) === false);

    // 4. The key in the address bar.
    await go(base + '/login?key');
    const keyShown = await until(() => browser.chrome.webContents.executeJavaScript(`!document.getElementById('key').hidden`));
    const keyTitle = await browser.chrome.webContents.executeJavaScript(`document.getElementById('key').title`);
    check('the address bar shows a key for a site with saved logins', !!keyShown && /2 saved logins for this site/.test(keyTitle), keyTitle);
    browser.lastMenu = null;
    await browser.chrome.webContents.executeJavaScript(`document.getElementById('key').click()`);
    await until(() => browser.lastMenu);
    await until(() => overlay(`!!document.querySelector('.menu')`));
    const keyMenu = (browser.lastMenu?.items || []).map((i) => i.heading || i.label);
    check('clicking it lists the accounts, add, and manage', /^Saved for localhost:\d+$/.test(keyMenu[0]) && keyMenu.includes('sam@example.com') && keyMenu.some((l) => /^Add a password for/.test(l || '')), keyMenu.join(' | '));
    const pickSam = browser.lastMenu.items.find((i) => i.label === 'sam@example.com');
    // As a click on the item would: close the menu, then act.
    await overlay(`window.ui.closeMenu(); window.browser.invoke(${JSON.stringify(pickSam.action.channel)}, ${JSON.stringify(pickSam.action.payload)})`);
    const fromKey = await until(async () => { const f = await fields(); return f[1] ? f : null; });
    check('and choosing one fills the sign-in form', fromKey && fromKey[0] === 'sam@example.com' && fromKey[1] === 'first-Secret-1', JSON.stringify(fromKey));
    await go('about:blank');
    check('no key on a page with nothing saved', !!(await until(() => browser.chrome.webContents.executeJavaScript(`document.getElementById('key').hidden`))));

    // 5. Username-first sign-in.
    await go(base + '/step1');
    const step = await until(card);
    check('a username-first sign-in page gets the callout too', !!step && step.fills.length === 2, step?.text);
    const pick = step.fills.find((f) => f.label === 'Fill sam@example.com');
    await click(wc, pick.x, pick.y);
    const id = await until(() => wc.executeJavaScript(`document.getElementById('id').value`));
    check('and fills just the username on that step', id === 'sam@example.com', id);

    // 6. A page that focuses its own email box keeps the keyboard.
    browser.lastMenu = null;
    await go(base + '/autofocus');
    await wait(500);
    const autofocused = await wc.executeJavaScript(`document.activeElement?.id`);
    const menuItems = (browser.lastMenu?.items || []).filter((i) => i.action?.channel === 'autofill:choose');
    check('page autofocus does not pop the suggestions or take the keyboard', autofocused === 'u' && !menuItems.length && !browser.overlayInteractive, autofocused + ' / ' + menuItems.length);
    wc.focus();
    wc.sendInputEvent({ type: 'char', keyCode: 'z' });
    await wait(200);
    check('typing goes straight into the page', (await wc.executeJavaScript(`document.getElementById('u').value`)) === 'z');

    // 7. Clicking the box: the suggestions appear, but the page keeps the keyboard.
    await wc.executeJavaScript(`document.getElementById('u').value = ''`);
    browser.lastMenu = null;
    const u = await rectOf('#u');
    const tabBounds = tab.view.getBounds();
    await click(wc, u.x, u.y);
    await until(() => browser.overlayInteractive && (browser.lastMenu?.items || []).some((i) => i.action?.channel === 'autofill:choose'));
    check('clicking the box shows its suggestions, without taking the keyboard', browser.overlayInteractive && browser.overlayPassive === true, 'passive=' + browser.overlayPassive);
    wc.sendInputEvent({ type: 'char', keyCode: 's' });
    await wait(300);
    const typed = await wc.executeJavaScript(`document.getElementById('u').value`);
    check('typing reaches the page and closes the suggestions', typed === 's' && !(await until(() => !browser.overlayInteractive, 20)) === false, typed + ' / open=' + browser.overlayInteractive);

    // 8. The down arrow moves into them; Escape from the page closes them.
    browser.lastMenu = null;
    await click(wc, u.x, u.y);
    await until(() => browser.overlayInteractive);
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
    await wait(300);
    const focusedItem = await overlay(`document.activeElement?.classList.contains('menu-item') ? document.activeElement.textContent : ''`);
    check('the down arrow moves into the suggestions', !!focusedItem && browser.overlayPassive === false, focusedItem);
    browser.overlay.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    check('Escape closes them', !!(await until(() => !browser.overlayInteractive, 20)));

    // 9. Clicking elsewhere closes them AND lands on the page.
    browser.lastMenu = null;
    await wc.executeJavaScript(`document.getElementById('u').value = ''`);
    await click(wc, u.x, u.y);
    await until(() => browser.overlayInteractive && browser.overlayPassive);
    const other = await rectOf('#other');
    // The overlay covers the window while a menu is open: the click lands on it first.
    await click(browser.overlay.webContents, other.x + tabBounds.x, other.y + tabBounds.y);
    await wait(300);
    const landed = await until(() => wc.executeJavaScript(`document.activeElement?.id === 'other'`), 30);
    check('a click away from the suggestions closes them and reaches the page', !!landed && !browser.overlayInteractive);

    // 10. Locked vault: the callout says so, and Fill asks for the master password.
    await V.setMaster('saffron Kite 44 harbour');
    V.lock();
    await go(base + '/login?locked');
    const locked = await until(card);
    check('a locked vault still shows what is saved, and says it is locked', !!locked && /Locked - Fill asks for your master password/.test(locked.text), locked?.text);
    const lockedPick = locked.fills.find((f) => f.label === 'Fill sam@example.com');
    await click(wc, lockedPick.x, lockedPick.y);
    const field = await until(() => overlay(`!!document.querySelector('.menu-field input')`));
    check('Fill asks for the master password first', !!field);
    await overlay(`(() => { document.querySelector('.menu-field input').value = 'saffron Kite 44 harbour'; document.querySelector('.menu-field').requestSubmit(); })()`);
    const unlocked = await until(async () => { const f = await fields(); return f[1] ? f : null; });
    check('then fills', unlocked && unlocked[1] === 'first-Secret-1', JSON.stringify(unlocked));
    await V.removeMaster('saffron Kite 44 harbour');

    // 11. A strict Content-Security-Policy does not strip its styling.
    await go(base + '/strict');
    const strict = await until(card);
    check('under a strict CSP the callout still shows, fully styled', !!strict && strict.radius === '14px', strict?.radius);

    // 12. The switch.
    browser.autofill.setPrefs({ loginHints: false });
    await go(base + '/login?off');
    await wait(900);
    check('"Show saved logins on sign-in pages" off: no callout', !(await card()));
    browser.autofill.setPrefs({ loginHints: true });

    // 13. One saved login: automatic sign-in still wins, no callout.
    V.remove(V.forUrl(base).find((l) => l.username === 'kim@example.com').id);
    browser.autoSignedIn.clear();
    await go(base + '/login?auto');
    const auto = await until(() => wc.executeJavaScript(`document.body.dataset.signedIn || ''`));
    check('with one saved login it still signs in by itself', auto === 'sam@example.com', auto);
    browser.window.setBounds(bounds);
    V.clear();
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }
  browser.biometric.testAnswer = null;
  server.close();
  console.log(fails ? '\nFAILURES: ' + fails : '\nall callout checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
