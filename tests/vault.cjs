const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

/**
 * The vault's lock, end to end and off-screen: a master password set, changed
 * and removed on browser://passwords; the lock screen; unlocking from the fill
 * menu on a real page; device unlock (the sensor is simulated - a real Windows
 * Hello prompt must never appear during a probe); auto-lock; automatic
 * sign-in; and custom autofill fields.
 */
const LOGIN = `<!doctype html><title>Sign in</title>
<form id="f" onsubmit="event.preventDefault(); document.body.dataset.signedIn = document.getElementById('u').value + '|' + document.getElementById('p').value">
<label for="u">Email</label><input id="u" name="email" type="email" autocomplete="username">
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password">
<button type="submit">Sign in</button></form>`;
const LATE = `<!doctype html><title>App</title><div id="app">Loading…</div><script>
setTimeout(() => { document.getElementById('app').innerHTML = '<form id="f"><input id="u" name="username"><input id="p" type="password" name="pw"><button>Log in</button></form>';
document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); document.body.dataset.signedIn = document.getElementById('u').value; }); }, 700);
</script>`;
const PROFILE = `<!doctype html><title>HR form</title><form>
<label for="e">Employee ID</label><input id="e" name="emp_id">
<label for="d">Department</label><input id="d" name="dept">
<label for="o">One-time code</label><input id="o" name="otp"></form>`;

async function run(browser) {
  const { app, safeStorage } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 240) : ''));
    if (!ok) fails++;
  };
  const until = async (fn, tries = 60, ms = 150) => { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await wait(ms); } return null; };
  const server = http.createServer((q, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(q.url.startsWith('/late') ? LATE : q.url.startsWith('/profile') ? PROFILE : LOGIN);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const overlay = (js) => browser.overlay.webContents.executeJavaScript(js);
  const pick = (label) => {
    const item = (browser.lastMenu?.items || []).find((i) => i.label === label || i.label?.startsWith(label));
    return item ? overlay(`window.browser.invoke(${JSON.stringify(item.action.channel)}, ${JSON.stringify(item.action.payload)})`) : Promise.resolve('no item: ' + label);
  };
  const outerOf = (encoded) => safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  const V = browser.passwords;
  const MASTER = 'violet Harbour 7 lanterns';

  try {
    await wait(900);
    // A clean vault.
    if (V.hasMaster) { V.key = null; V.data.lock = null; V.save(); }
    V.clear();
    for (const e of browser.autofill.list()) browser.autofill.remove(e.id);
    for (const o of browser.autofill.state().noAuto || []) browser.autofill.removeNoAuto(o);
    browser.autofill.setPrefs({ autoSignIn: true, passkeys: true, fillAddresses: true });
    browser.biometric.testAnswer = 'approve';
    V.save_credential({ url: 'https://mail.example', username: 'sam', password: 'first-Secret-1' });
    V.save_credential({ url: 'https://shop.example', username: 'sam', password: 'second-Secret-2' });

    // 1. Set a master password on the page.
    const tab = browser.tabs.active;
    const wc = tab.view.webContents;
    const go = async (url) => {
      browser.tabs.navigate(tab.id, url);
      await until(() => !wc.isLoading() && wc.getURL().startsWith(url.split('#')[0]));
      await wait(500);
    };
    await go('browser://passwords');
    await until(() => wc.executeJavaScript(`!!document.querySelector('.pv-security')`));
    await wc.executeJavaScript(`[...document.querySelectorAll('.pv-security .pill')].find(b => b.textContent === 'Set up').click()`);
    await wait(200);
    await wc.executeJavaScript(`(() => { const i = document.querySelectorAll('.pv-form input'); i[0].value = 'short'; i[1].value = 'short';
      document.querySelector('.pv-form').requestSubmit(); })()`);
    await wait(200);
    const weak = await wc.executeJavaScript(`document.querySelector('.pv-form .pw-error').textContent`);
    check('a short master password is refused, with a reason', /longer|8 characters/.test(weak), weak);
    await wc.executeJavaScript(`(() => { const i = document.querySelectorAll('.pv-form input'); i[0].value = ${JSON.stringify(MASTER)}; i[1].value = ${JSON.stringify(MASTER)};
      document.querySelector('.pv-form').requestSubmit(); })()`);
    const on = await until(() => V.hasMaster);
    check('the master password is set from the page', !!on);
    const sealed = V.data.entries.every((e) => outerOf(e.password).startsWith('x1:'));
    check('every saved password is now sealed under it', sealed);
    check('and still opens while unlocked', V.reveal(V.forUrl('https://mail.example')[0].id).password === 'first-Secret-1');
    const chip = await until(() => wc.executeJavaScript(`/On/.test(document.querySelector('.pv-chip')?.textContent || '') && document.querySelector('.pv-chip').textContent`));
    check('the page says the master password is on', /On/.test(chip || ''), chip);

    // 2. Lock now: the lock screen, and nothing readable.
    await wc.executeJavaScript(`[...document.querySelectorAll('.pv-security .pill')].find(b => b.textContent === 'Lock now').click()`);
    const locked = await until(() => wc.executeJavaScript(`!!document.querySelector('.pv-lock')`));
    check('"Lock now" shows the lock screen', !!locked && V.locked);
    const listed = await wc.executeJavaScript(`document.querySelectorAll('.password-row').length`);
    check('no logins are listed while locked', listed === 0, listed);
    const blocked = V.reveal(V.forUrl('https://mail.example')[0].id);
    check('a locked vault will not reveal a password', blocked.ok === false && blocked.locked === true);
    check('health and export refuse while locked', V.health().locked === true && (() => { try { V.exportCsv(); return false; } catch { return true; } })());
    const whileLocked = V.save_credential({ url: 'https://new.example', username: 'kim', password: 'saved-While-Locked-3' });
    check('a new login can still be saved while locked', whileLocked.ok);

    // 3. Wrong, then right, on the lock screen.
    await wc.executeJavaScript(`(() => { document.querySelector('.pv-lock-form input').value = 'not it at all'; document.querySelector('.pv-lock-form').requestSubmit(); })()`);
    const wrong = await until(() => wc.executeJavaScript(`document.querySelector('.pv-lock-error')?.textContent`));
    check('a wrong master password is refused on the lock screen', /not your master password/.test(wrong || '') && V.locked, wrong);
    await wc.executeJavaScript(`(() => { document.querySelector('.pv-lock-form input').value = ${JSON.stringify(MASTER)}; document.querySelector('.pv-lock-form').requestSubmit(); })()`);
    const opened = await until(() => wc.executeJavaScript(`!document.querySelector('.pv-lock') && document.querySelectorAll('.password-row').length === 3`));
    check('the right one opens the vault and lists every login', !!opened && !V.locked);
    check('the login saved while locked opens correctly', V.reveal(V.forUrl('https://new.example')[0].id).password === 'saved-While-Locked-3');

    // 4. Device unlock (simulated sensor).
    await wc.executeJavaScript(`document.querySelector('.pv-device').click()`);
    const device = await until(() => V.deviceUnlock);
    check('unlocking with Windows Hello / Touch ID can be turned on', !!device);
    V.lock();
    await until(() => wc.executeJavaScript(`!!document.querySelector('.pv-lock-device')`));
    const deviceLabel = await wc.executeJavaScript(`document.querySelector('.pv-lock-device').textContent`);
    check('the lock screen offers the device', /Unlock with (Windows Hello|Touch ID)/.test(deviceLabel), deviceLabel);
    browser.biometric.testAnswer = 'deny';
    await wc.executeJavaScript(`document.querySelector('.pv-lock-device').click()`);
    const denied = await until(() => wc.executeJavaScript(`document.querySelector('.pv-lock-error')?.textContent`));
    check('a failed face or fingerprint check does not unlock', /did not confirm/.test(denied || '') && V.locked, denied);
    browser.biometric.testAnswer = 'approve';
    await wc.executeJavaScript(`document.querySelector('.pv-lock-device').click()`);
    check('a passed one does', !!(await until(() => !V.locked)));

    // 5. Unlocking from the fill menu on a real page.
    V.lock();
    await go(base + '/login');
    browser.lastMenu = null;
    await wc.executeJavaScript(`(() => { const el = document.getElementById('u'); el.focus(); el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); })()`);
    await until(() => browser.lastMenu);
    V.save_credential({ url: base, username: 'sam@example.com', password: 'page-Secret-4' });
    V.save_credential({ url: base, username: 'kim@example.com', password: 'page-Secret-5' });
    browser.lastMenu = null;
    await wc.executeJavaScript(`(() => { const el = document.getElementById('u'); el.blur(); el.focus(); el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); })()`);
    await until(() => browser.lastMenu);
    const hints = (browser.lastMenu?.items || []).map((i) => i.label + '=' + (i.hint || ''));
    check('saved logins say they need unlocking', hints.some((h) => h.startsWith('sam@example.com=Locked')), hints.join(' | '));
    const choosing = pick('sam@example.com');
    const field = await until(() => overlay(`!!document.querySelector('.menu-field input')`));
    check('choosing one asks for the master password right there', !!field);
    const heading = (browser.lastMenu?.items || []).find((i) => i.heading)?.heading;
    check('and says why', heading === 'Unlock to fill your password', heading);
    check('with the device offered beside it', (browser.lastMenu?.items || []).some((i) => /^Use (Windows Hello|Touch ID)$/.test(i.label || '')));
    await overlay(`(() => { document.querySelector('.menu-field input').value = 'nope nope'; document.querySelector('.menu-field').requestSubmit(); })()`);
    const inline = await until(() => overlay(`document.querySelector('.menu-field-error')?.textContent`));
    check('a wrong password is refused inside the menu', /not your master password/.test(inline || ''), inline);
    await overlay(`(() => { document.querySelector('.menu-field input').value = ${JSON.stringify(MASTER)}; document.querySelector('.menu-field').requestSubmit(); })()`);
    await choosing;
    const filled = await until(async () => {
      const v = await wc.executeJavaScript(`[document.getElementById('u').value, document.getElementById('p').value]`);
      return v[1] ? v : null;
    });
    check('the right one unlocks and fills the login', filled && filled[0] === 'sam@example.com' && filled[1] === 'page-Secret-4', JSON.stringify(filled));

    // 6. Auto-lock.
    await go('browser://passwords');
    await until(() => wc.executeJavaScript(`!!document.querySelector('.pv-seg-btn')`));
    await wc.executeJavaScript(`[...document.querySelectorAll('.pv-seg-btn')].find(b => b.textContent === '1 min').click()`);
    check('the auto-lock time is chosen on the page', !!(await until(() => V.lockAfter() === 1)));
    V.lastUse = Date.now() - 2 * 60 * 1000;
    const autoLocked = await until(() => V.locked, 60, 500);
    check('an unused vault locks itself', !!autoLocked);
    await V.unlock(MASTER);

    // 7. Change the master password, then remove it.
    await until(() => wc.executeJavaScript(`!!document.querySelector('.pv-security')`));
    await wc.executeJavaScript(`[...document.querySelectorAll('.pv-security .pill')].find(b => b.textContent === 'Change').click()`);
    await wait(200);
    const NEXT = 'copper Kettle 42 marigold';
    await wc.executeJavaScript(`(() => { const i = document.querySelectorAll('.pv-form input'); i[0].value = ${JSON.stringify(MASTER)}; i[1].value = ${JSON.stringify(NEXT)}; i[2].value = ${JSON.stringify(NEXT)};
      document.querySelector('.pv-form').requestSubmit(); })()`);
    await until(() => wc.executeJavaScript(`/changed/.test(document.querySelector('.pw-ok')?.textContent || '')`));
    V.lock();
    check('after changing, the old master password no longer opens the vault', (await V.unlock(MASTER)).ok === false);
    V.waitUntil = 0;
    check('and the new one does', (await V.unlock(NEXT)).ok === true);
    await until(() => wc.executeJavaScript(`!!document.querySelector('.pv-security')`));
    await wc.executeJavaScript(`[...document.querySelectorAll('.pv-security .pill')].find(b => b.textContent === 'Turn off').click()`);
    await wait(200);
    await wc.executeJavaScript(`(() => { document.querySelector('.pv-form input').value = ${JSON.stringify(NEXT)}; document.querySelector('.pv-form').requestSubmit(); })()`);
    const off = await until(() => !V.hasMaster);
    check('the master password can be turned off from the page', !!off);
    check('which returns every password to OS-only encryption, intact', V.data.entries.every((e) => !outerOf(e.password).startsWith('x1:')) &&
      V.reveal(V.forUrl('https://shop.example')[0].id).password === 'second-Secret-2');

    const shots = path.join(app.getAppPath(), 'shots');
    fs.mkdirSync(shots, { recursive: true });
    await V.setMaster(MASTER);
    V.lock();
    await until(() => wc.executeJavaScript(`!!document.querySelector('.pv-lock')`));
    await wait(700);
    let image = await wc.capturePage().catch(() => null);
    if (image && !image.isEmpty()) fs.writeFileSync(path.join(shots, 'vault-locked.png'), image.toPNG());
    await V.unlock(MASTER);
    await until(() => wc.executeJavaScript(`!!document.querySelector('.pv-security')`));
    await wait(600);
    image = await wc.capturePage().catch(() => null);
    if (image && !image.isEmpty()) fs.writeFileSync(path.join(shots, 'vault-security.png'), image.toPNG());
    await V.removeMaster(MASTER);

    // 8. Automatic sign-in.
    V.clear();
    V.save_credential({ url: base, username: 'sam@example.com', password: 'auto-Secret-6' });
    browser.notice = null;
    await go(base + '/login?auto');
    const signed = await until(() => wc.executeJavaScript(`document.body.dataset.signedIn || ''`));
    check('one saved login: Static fills it and signs in by itself', signed === 'sam@example.com|auto-Secret-6', signed);
    check('and says so', /Signed in to 127\.0\.0\.1:\d+ automatically as sam@example.com/.test(browser.notice?.message || ''), browser.notice?.message);
    await go(base + '/login?again');
    await wait(1200);
    const again = await wc.executeJavaScript(`[document.body.dataset.signedIn || '', document.getElementById('p').value]`);
    check('but not again within ten minutes (no sign-out loops)', again[0] === '' && again[1] === '', JSON.stringify(again));
    browser.autoSignedIn.clear();
    await go(base + '/late');
    const late = await until(() => wc.executeJavaScript(`document.body.dataset.signedIn || ''`));
    check('a sign-in form drawn later by script is found too', late === 'sam@example.com', late);
    browser.autoSignedIn.clear();
    V.save_credential({ url: base, username: 'kim@example.com', password: 'auto-Secret-7' });
    await go(base + '/login?two');
    await wait(1500);
    check('two saved logins: it waits for you to choose', !(await wc.executeJavaScript(`document.body.dataset.signedIn || ''`)));
    V.remove(V.forUrl(base).find((l) => l.username === 'kim@example.com').id);
    browser.lastMenu = null;
    await wc.executeJavaScript(`(() => { const el = document.getElementById('u'); el.focus(); el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); })()`);
    await until(() => browser.lastMenu);
    await pick('Don’t sign in automatically here');
    await wait(200);
    browser.autoSignedIn.clear();
    await go(base + '/login?never');
    await wait(1500);
    check('"Don’t sign in automatically here" is respected', browser.autofill.noAuto(base) && !(await wc.executeJavaScript(`document.body.dataset.signedIn || ''`)));
    browser.autofill.removeNoAuto(base);
    browser.autoSignedIn.clear();
    await V.setMaster(MASTER);
    V.lock();
    await go(base + '/login?locked');
    await wait(1500);
    check('a locked vault never signs in on its own', !(await wc.executeJavaScript(`document.body.dataset.signedIn || ''`)));
    await V.removeMaster(MASTER);

    // 9. Custom fields.
    browser.autofill.put('custom', { label: 'Employee ID', value: 'EMP-4471', match: 'staff no' });
    await go(base + '/profile');
    browser.lastMenu = null;
    await wc.executeJavaScript(`(() => { const el = document.getElementById('e'); el.focus(); el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); })()`);
    await until(() => browser.lastMenu);
    const custom = (browser.lastMenu?.items || []).map((i) => i.label + '=' + (i.hint || ''));
    check('a custom field is offered in the box its name matches', custom.includes('EMP-4471=Employee ID · custom field'), custom.join(' | '));
    await pick('EMP-4471');
    const form = await until(() => wc.executeJavaScript(`document.getElementById('e').value ? [document.getElementById('e').value, document.getElementById('d').value] : null`));
    check('and fills only that box', form && form[0] === 'EMP-4471' && form[1] === '', JSON.stringify(form));
    browser.lastMenu = null;
    await wc.executeJavaScript(`(() => { const el = document.getElementById('d'); el.focus(); el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); })()`);
    await wait(500);
    check('boxes it does not match get nothing', !browser.lastMenu);
    browser.lastMenu = null;
    await wc.executeJavaScript(`(() => { const el = document.getElementById('o'); el.focus(); el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); })()`);
    await wait(500);
    check('one-time code boxes still get nothing', !browser.lastMenu);

    V.clear();
    for (const e of browser.autofill.list()) browser.autofill.remove(e.id);
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }
  browser.biometric.testAnswer = null;
  server.close();
  console.log(fails ? '\nFAILURES: ' + fails : '\nall vault checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
