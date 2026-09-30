const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const http = require('node:http');
const crypto = require('node:crypto');

/**
 * Passkeys, end to end and off-screen: a real page creates one and signs in
 * with it through navigator.credentials; every response is checked the way a
 * site's server checks it. Then the autofill ("conditional") flow, a locked
 * vault, deleting one on browser://passwords, and a live run on webauthn.io.
 *
 * The face/fingerprint check is simulated for the whole probe - a real Windows
 * Security prompt must never appear on someone's screen during a test - and
 * nothing here takes the "use another device" path, which would open one.
 */
const PAGE = `<!doctype html><title>Passkey test</title>
<form><input id="u" name="username" autocomplete="username webauthn"><input id="p" type="password" name="password"></form>
<script>
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const rnd = () => crypto.getRandomValues(new Uint8Array(32));
window.register = async (extra = {}) => {
  const challenge = rnd();
  try {
    const cred = await navigator.credentials.create({ publicKey: {
      rp: { name: 'Local test', ...(extra.rp || {}) },
      user: { id: new Uint8Array([1, 2, 3, 4]), name: 'sam@local', displayName: 'Sam' },
      challenge, pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      extensions: { credProps: true },
      excludeCredentials: extra.exclude ? [{ type: 'public-key', id: unb64(extra.exclude) }] : [],
    } });
    return { ok: true, challenge: b64(challenge), id: cred.id, rawId: b64(cred.rawId), type: cred.type,
      isPKC: cred instanceof PublicKeyCredential, isAtt: cred.response instanceof AuthenticatorAttestationResponse,
      transports: cred.response.getTransports(), alg: cred.response.getPublicKeyAlgorithm(), publicKey: b64(cred.response.getPublicKey()),
      clientDataJSON: b64(cred.response.clientDataJSON), attestationObject: b64(cred.response.attestationObject),
      ext: cred.getClientExtensionResults(), attachment: cred.authenticatorAttachment, json: JSON.stringify(cred.toJSON()) };
  } catch (e) { return { ok: false, name: e.name, message: e.message }; }
};
window.signIn = async (opts = {}) => {
  const challenge = rnd();
  try {
    const cred = await navigator.credentials.get({ mediation: opts.mediation, publicKey: { challenge, rpId: opts.rpId, userVerification: 'preferred' } });
    return { ok: true, challenge: b64(challenge), id: cred.id, isAssert: cred.response instanceof AuthenticatorAssertionResponse,
      clientDataJSON: b64(cred.response.clientDataJSON), authenticatorData: b64(cred.response.authenticatorData),
      signature: b64(cred.response.signature), userHandle: b64(cred.response.userHandle) };
  } catch (e) { return { ok: false, name: e.name, message: e.message }; }
};
window.passwordSignIn = async () => {
  try { const c = await navigator.credentials.get({ password: true, mediation: 'optional' }); return c ? { id: c.id, password: c.password, type: c.type } : null; }
  catch (e) { return { error: e.name + ': ' + e.message }; }
};
</script>`;

async function run(browser) {
  const { app } = require('electron');
  const webauthn = require('../src/features/passwords/webauthn');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 240) : ''));
    if (!ok) fails++;
  };
  const until = async (fn, tries = 60, ms = 150) => { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await wait(ms); } return null; };
  const server = http.createServer((q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // localhost, not 127.0.0.1: an IP address is not a valid relying-party ID.
  const base = 'http://localhost:' + server.address().port;
  const overlay = (js) => browser.overlay.webContents.executeJavaScript(js);
  const menuWith = (text) => until(() => (browser.lastMenu?.items || []).some((i) => (i.heading || '').includes(text) || i.label === text));
  const pick = (label) => {
    const item = (browser.lastMenu?.items || []).find((i) => i.label === label);
    return item ? overlay(`window.browser.invoke(${JSON.stringify(item.action.channel)}, ${JSON.stringify(item.action.payload)})`) : Promise.resolve('no item: ' + label);
  };
  const V = browser.passwords;
  const MASTER = 'amber Quartz 9 lighthouse';
  const b64 = (buf) => Buffer.from(buf).toString('base64url');

  /** What a site's server does with a registration. */
  const verifyRegistration = (r, origin) => {
    const client = JSON.parse(Buffer.from(r.clientDataJSON, 'base64url'));
    const att = webauthn.decodeCbor(Buffer.from(r.attestationObject, 'base64url')).value;
    const data = att.get('authData');
    const idLength = data.readUInt16BE(53);
    const cose = webauthn.decodeCbor(data.subarray(55 + idLength)).value;
    const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64(cose.get(-2)), y: b64(cose.get(-3)) }, format: 'jwk' });
    return {
      ok: client.type === 'webauthn.create' && client.challenge === r.challenge && client.origin === origin && att.get('fmt') === 'none' &&
        data.subarray(0, 32).equals(crypto.createHash('sha256').update('localhost').digest()) && (data[32] & 0x41) === 0x41 &&
        b64(data.subarray(55, 55 + idLength)) === r.id && key.export({ format: 'der', type: 'spki' }).toString('base64url') === r.publicKey,
      uv: !!(data[32] & 0x04),
      key,
    };
  };
  const verifyAssertion = (r, key, origin) => {
    const client = JSON.parse(Buffer.from(r.clientDataJSON, 'base64url'));
    const data = Buffer.from(r.authenticatorData, 'base64url');
    const signed = Buffer.concat([data, crypto.createHash('sha256').update(Buffer.from(r.clientDataJSON, 'base64url')).digest()]);
    return {
      ok: client.type === 'webauthn.get' && client.challenge === r.challenge && client.origin === origin &&
        crypto.verify('sha256', signed, key, Buffer.from(r.signature, 'base64url')),
      uv: !!(data[32] & 0x04),
    };
  };

  try {
    await wait(900);
    browser.biometric.testAnswer = 'approve';
    if (V.hasMaster) { V.key = null; V.data.lock = null; V.save(); }
    V.clear();
    browser.autofill.setPrefs({ passkeys: true, autoSignIn: true });
    const tab = browser.tabs.active;
    const wc = tab.view.webContents;
    const go = async (url) => {
      browser.tabs.navigate(tab.id, url);
      await until(() => !wc.isLoading() && wc.getURL().startsWith(url.split('#')[0]));
      await wait(400);
    };
    await go(base + '/');

    // 1. What the page is told before it asks.
    const offered = await wc.executeJavaScript(`Promise.all([PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(), PublicKeyCredential.isConditionalMediationAvailable()])`);
    check('sites are told Static can hold passkeys (platform + autofill)', offered[0] === true && offered[1] === true, JSON.stringify(offered));
    check('navigator.credentials still looks native', await wc.executeJavaScript(`Function.prototype.toString.call(navigator.credentials.create).includes('[native code]')`));

    // 2. Create one.
    browser.lastMenu = null;
    const registering = wc.executeJavaScript('register()');
    await menuWith('Create a passkey for localhost?');
    const createMenu = (browser.lastMenu?.items || []).map((i) => i.heading || i.label);
    check('the site asking for a passkey gets a clear question', createMenu[0] === 'Create a passkey for localhost?' && createMenu.includes('sam@local') && createMenu.includes('Use another device or security key'), createMenu.join(' | '));
    await pick('sam@local');
    const reg = await registering;
    check('the page receives a real PublicKeyCredential', reg.ok && reg.isPKC && reg.isAtt && reg.type === 'public-key' && reg.attachment === 'platform', JSON.stringify(reg).slice(0, 200));
    check('with ES256, credProps and transports', reg.alg === -7 && reg.ext?.credProps?.rk === true && reg.transports.includes('internal'), JSON.stringify([reg.alg, reg.ext, reg.transports]));
    const server1 = verifyRegistration(reg, base);
    check('a relying party would accept the registration', server1.ok);
    check('and sees the user was verified (face, fingerprint or PIN)', server1.uv);
    check('toJSON() gives the standard JSON form', JSON.parse(reg.json || '{}').response?.attestationObject === reg.attestationObject);
    const stored = V.listPasskeys();
    check('the passkey is kept in the vault', stored.length === 1 && stored[0].rpId === 'localhost' && stored[0].userName === 'sam@local', JSON.stringify(stored));

    // 3. Sign in with it.
    browser.lastMenu = null;
    let signing = wc.executeJavaScript('signIn()');
    await menuWith('Sign in to localhost with a passkey');
    await pick('sam@local');
    let assertion = await signing;
    const server2 = assertion.ok && verifyAssertion(assertion, server1.key, base);
    check('signing in returns an assertion the site can verify', assertion.ok && assertion.isAssert && server2.ok, JSON.stringify(assertion).slice(0, 160));
    check('for the right account, verified', assertion.userHandle === b64(Buffer.from([1, 2, 3, 4])) && server2.uv);

    // 4. Refusals.
    browser.lastMenu = null;
    signing = wc.executeJavaScript('signIn()');
    await menuWith('Sign in to localhost with a passkey');
    await pick('Cancel');
    assertion = await signing;
    check('Cancel tells the site NotAllowedError', !assertion.ok && assertion.name === 'NotAllowedError', assertion.name);
    const again = await wc.executeJavaScript(`register({ exclude: ${JSON.stringify(reg.id)} })`);
    check('an account that already has one gets InvalidStateError', !again.ok && again.name === 'InvalidStateError', again.name);
    const foreign = await wc.executeJavaScript(`register({ rp: { id: 'example.com' } })`);
    check('a page cannot create a passkey for another site', !foreign.ok && foreign.name === 'SecurityError', foreign.name);
    const foreignGet = await wc.executeJavaScript(`signIn({ rpId: 'google.com' })`);
    check('nor sign in as one', !foreignGet.ok && foreignGet.name === 'SecurityError', foreignGet.name);

    // 5. The autofill way: the page waits, the username box offers the passkey.
    browser.lastMenu = null;
    const conditional = wc.executeJavaScript(`signIn({ mediation: 'conditional' })`);
    await wait(400);
    await wc.executeJavaScript(`(() => { const el = document.getElementById('u'); el.focus(); el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); })()`, true);
    await menuWith('sam@local');
    const suggestion = (browser.lastMenu?.items || []).find((i) => i.label === 'sam@local');
    check('the username box offers the passkey', suggestion?.hint === 'Passkey for localhost', suggestion?.hint);
    await pick('sam@local');
    assertion = await conditional;
    check('choosing it signs the page in', assertion.ok && verifyAssertion(assertion, server1.key, base).ok, assertion.name);

    // 6. A locked vault: unlocking is the verification.
    await V.setMaster(MASTER);
    V.lock();
    browser.lastMenu = null;
    signing = wc.executeJavaScript('signIn()');
    await menuWith('Sign in to localhost with a passkey');
    await pick('sam@local');
    const field = await until(() => overlay(`!!document.querySelector('.menu-field input')`));
    check('a locked vault asks for the master password first', !!field && (browser.lastMenu?.items || [])[0]?.heading === 'Unlock to sign in to localhost');
    await overlay(`(() => { document.querySelector('.menu-field input').value = ${JSON.stringify(MASTER)}; document.querySelector('.menu-field').requestSubmit(); })()`);
    assertion = await signing;
    check('then signs in, sealed key and all', assertion.ok && verifyAssertion(assertion, server1.key, base).ok && !V.locked, assertion.name);
    await V.removeMaster(MASTER);

    // 7. Credential Management sign-in with a saved password.
    V.save_credential({ url: base, username: 'sam@local', password: 'cm-Secret-8' });
    const cm = await wc.executeJavaScript('passwordSignIn()');
    check('navigator.credentials.get({ password: true }) signs a site in', cm && cm.id === 'sam@local' && cm.password === 'cm-Secret-8' && cm.type === 'password', JSON.stringify(cm));

    // 8. Managing them on browser://passwords.
    await go('browser://passwords');
    const row = await until(() => wc.executeJavaScript(`document.querySelector('.pv-passkey strong')?.textContent`));
    check('browser://passwords lists the passkey', row === 'localhost', row);
    await wc.executeJavaScript(`document.querySelector('.pv-passkey .pill').click()`);
    await wait(150);
    check('deleting asks for a second click', V.listPasskeys().length === 1);
    await wc.executeJavaScript(`document.querySelector('.pv-passkey .pill').click()`);
    check('and then removes it', !!(await until(() => V.listPasskeys().length === 0)));
    const fs = require('node:fs');
    const path = require('node:path');
    const shots = path.join(app.getAppPath(), 'shots');
    fs.mkdirSync(shots, { recursive: true });

    // 9. Live: Yubico's WebAuthn developer demo, whose SERVER verifies both
    // the registration and the sign-in (webauthn.io is unreachable from some
    // networks, and webauthn.me only checks in the page).
    try {
      const demo = 'https://demo.yubico.com/webauthn-developers';
      const press = (text, last = true) => wc.executeJavaScript(`(() => { const all = [...document.querySelectorAll('button, [role=tab]')].filter(b => b.textContent.trim().toLowerCase() === ${JSON.stringify(text)});
        const b = ${last} ? all.pop() : all[0]; if (!b) return false; b.click(); return true; })()`);
      const text = async () => (await wc.executeJavaScript('document.body.innerText')).replace(/\s+/g, ' ');
      await go(demo);
      if (!(await until(() => wc.executeJavaScript(`[...document.querySelectorAll('button')].filter(b => b.textContent.trim().toLowerCase() === 'create').length >= 2`), 80, 250))) throw new Error('the demo did not load');
      browser.lastMenu = null;
      await press('create');
      await menuWith('Create a passkey for demo.yubico.com?');
      const account = (browser.lastMenu?.items || [])[1]?.label;
      await pick(account);
      const registered = await until(async () => /Registration successful/i.test(await text()), 60, 250);
      check("LIVE demo.yubico.com's server accepts a passkey made in Static", !!registered, registered ? account : (await text()).slice(0, 200));
      await go(demo);
      await until(() => wc.executeJavaScript(`[...document.querySelectorAll('button')].some(b => b.textContent.trim().toLowerCase() === 'assert')`), 80, 250);
      await press('assert', false);
      await until(() => wc.executeJavaScript(`[...document.querySelectorAll('button')].filter(b => b.textContent.trim().toLowerCase() === 'assert').length >= 2`), 40, 250);
      browser.lastMenu = null;
      await press('assert');
      await menuWith('Sign in to demo.yubico.com with a passkey');
      await pick(account);
      const signedIn = await until(async () => /Login successful/i.test(await text()), 60, 250);
      check('LIVE and its server accepts the sign-in', !!signedIn, signedIn ? '' : (await text()).slice(0, 200));
      const image = await wc.capturePage().catch(() => null);
      if (image && !image.isEmpty()) fs.writeFileSync(path.join(shots, 'passkey-live.png'), image.toPNG());
    } catch (error) {
      console.log('  --  live passkey site skipped: ' + error.message);
    }
    V.clear();
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }
  browser.biometric.testAnswer = null;
  server.close();
  console.log(fails ? '\nFAILURES: ' + fails : '\nall passkey checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
