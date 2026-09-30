const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const http = require('node:http');

/** Passwords and autofill on real pages, end to end, off-screen. */
const LOGIN = `<!doctype html><title>Sign in</title><form id="f" onsubmit="event.preventDefault()">
<label for="u">Email</label><input id="u" name="email" type="email">
<label for="p">Password</label><input id="p" name="password" type="password">
<input name="otp" placeholder="One-time code"><button type="submit">Sign in</button></form>`;
const SIGNUP = `<!doctype html><title>Join</title><form onsubmit="event.preventDefault()">
<input name="username"><input id="np" name="new_password" type="password" placeholder="Create password"></form>`;
const CHECKOUT = `<!doctype html><title>Checkout</title><form id="c" onsubmit="event.preventDefault()">
<input id="name" name="fullname" placeholder="Full name"><input name="phone" placeholder="Mobile">
<input name="address1" placeholder="Address"><input name="address2" placeholder="Landmark">
<input name="city" placeholder="City"><select name="state"><option value="">State</option><option value="MH">Maharashtra</option><option value="KA">Karnataka</option></select>
<input name="pincode" placeholder="PIN code">
<input id="cc" name="cardnumber" placeholder="Card number"><input name="cc-exp" placeholder="MM / YY"><input name="cvv" placeholder="CVV">
<button type="submit">Pay</button></form>`;

async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 220) : ''));
    if (!ok) fails++;
  };
  const server = http.createServer((q, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(q.url.startsWith('/join') ? SIGNUP : q.url.startsWith('/checkout') ? CHECKOUT : LOGIN);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const overlay = (js) => browser.overlay.webContents.executeJavaScript(js);
  const pick = (label) => {
    const item = (browser.lastMenu?.items || []).find((i) => i.label === label || i.label?.startsWith(label));
    return item ? overlay(`window.browser.invoke(${JSON.stringify(item.action.channel)}, ${JSON.stringify(item.action.payload)})`) : Promise.resolve(false);
  };

  try {
    await wait(900);
    browser.passwords.clear();
    for (const e of browser.autofill.list()) browser.autofill.remove(e.id);
    for (const o of browser.autofill.state().never) browser.autofill.removeNever(o);
    const tab = browser.tabs.active;
    const wc = tab.view.webContents;
    const go = async (url) => {
      browser.tabs.navigate(tab.id, url);
      for (let i = 0; i < 60 && (wc.isLoading() || !wc.getURL().startsWith(url)); i++) await wait(120);
      await wait(500);
    };
    const focus = async (selector) => {
      browser.lastMenu = null;
      await wc.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); })()`, true);
      await wait(400);
      return (browser.lastMenu?.items || []).filter((i) => i.label).map((i) => i.label);
    };

    // 1. Sign in: offered to save.
    await go(base + '/login');
    browser.lastMenu = null;
    await wc.executeJavaScript(`(() => { document.getElementById('u').value = 'sam@example.com'; document.getElementById('p').value = 'correct horse 42';
      document.getElementById('f').requestSubmit(); })()`);
    await wait(500);
    const prompt = browser.lastMenu?.items || [];
    check('signing in offers to save the password', prompt.some((i) => /Save password for 127.0.0.1/.test(i.heading || '')), JSON.stringify(prompt.map((i) => i.heading || i.label)));
    check('showing the username, never the password', prompt.some((i) => i.label === 'Save' && /sam@example.com · •+/.test(i.hint || '')));
    await pick('Save');
    await wait(300);
    const saved = browser.passwords.forUrl(base);
    check('choosing Save stores it, encrypted', saved.length === 1 && saved[0].username === 'sam@example.com', JSON.stringify(saved));

    // 2. Come back: it is suggested and fills.
    await go(base + '/login');
    const suggestions = await focus('#u');
    check('the saved login is suggested under the field', suggestions.includes('sam@example.com'), suggestions.join(' | '));
    await pick('sam@example.com');
    await wait(400);
    const filled = await wc.executeJavaScript(`[document.getElementById('u').value, document.getElementById('p').value]`);
    check('choosing it fills email and password', filled[0] === 'sam@example.com' && filled[1] === 'correct horse 42', JSON.stringify(filled));
    check('one-time code fields get no suggestions', (await focus('input[name=otp]')).length === 0);

    // 3. Same password again: no nagging.
    browser.lastMenu = null;
    await wc.executeJavaScript(`document.getElementById('f').requestSubmit()`);
    await wait(400);
    check('signing in with the saved password does not ask again', !browser.lastMenu);

    // 4. New account: a strong password is offered.
    await go(base + '/join');
    const offer = await focus('#np');
    check('a new-password field offers a strong password', offer.includes('Use a strong password'), offer.join(' | '));
    await pick('Use a strong password');
    await wait(300);
    const strong = await wc.executeJavaScript(`document.getElementById('np').value`);
    check('and fills one', strong.length >= 16, strong.length);

    // 5. Checkout: an address fills every field it can.
    browser.autofill.put('address', { label: 'Home', name: 'Sam Sharma', tel: '9876543210', 'address-line1': '12 MG Road',
      'address-line2': 'Near the park', 'address-level2': 'Pune', 'address-level1': 'Maharashtra', 'postal-code': '411001', country: 'India' });
    await go(base + '/checkout');
    const addr = await focus('#name');
    check('an address is suggested in a name field', addr.includes('Sam Sharma'), addr.join(' | '));
    await pick('Sam Sharma');
    await wait(400);
    const form = await wc.executeJavaScript(`Object.fromEntries([...document.querySelectorAll('#c input, #c select')].map(e => [e.name, e.value]))`);
    check('choosing it fills name, phone, address, landmark, city, state and PIN',
      form.fullname === 'Sam Sharma' && form.phone === '9876543210' && form.address1 === '12 MG Road' && form.address2 === 'Near the park' &&
      form.city === 'Pune' && form.state === 'MH' && form.pincode === '411001', JSON.stringify(form));

    // 6. Paying with a new card: offered to save, CVV never.
    browser.lastMenu = null;
    await wc.executeJavaScript(`(() => { const f = document.getElementById('c');
      f.cardnumber.value = '4242 4242 4242 4242'; f['cc-exp'].value = '08 / 29'; f.cvv.value = '123'; f.requestSubmit(); })()`);
    await wait(500);
    const cardPrompt = browser.lastMenu?.items || [];
    check('paying with a new card offers to save it', cardPrompt.some((i) => /Save card ending 4242/.test(i.label || '')), JSON.stringify(cardPrompt.map((i) => i.label || i.heading)));
    check('and says the security code is never saved', cardPrompt.some((i) => /never saved/.test(i.hint || '')));
    await pick('Save card');
    await wait(300);
    const card = browser.autofill.list('card')[0];
    const cardValues = card && browser.autofill.values(card.id).fields;
    check('the card is stored with expiry, and without the CVV', card && /Visa •••• 4242 · 08\/29/.test(card.summary) && !JSON.stringify(cardValues).includes('123'), card?.summary);

    // 7. Never for this site.
    await go(base + '/login?again');
    browser.lastMenu = null;
    await wc.executeJavaScript(`(() => { document.getElementById('u').value = 'other@example.com'; document.getElementById('p').value = 'x'; document.getElementById('f').requestSubmit(); })()`);
    await wait(400);
    await pick('Never for this site');
    await wait(300);
    browser.lastMenu = null;
    await wc.executeJavaScript(`(() => { document.getElementById('u').value = 'third@example.com'; document.getElementById('p').value = 'y'; document.getElementById('f').requestSubmit(); })()`);
    await wait(400);
    check('"Never for this site" is respected', !browser.lastMenu && browser.autofill.never(base));

    browser.passwords.clear();
    for (const e of browser.autofill.list()) browser.autofill.remove(e.id);
    browser.autofill.removeNever(base);
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }
  server.close();
  console.log(fails ? '\nFAILURES: ' + fails : '\nall autofill checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
