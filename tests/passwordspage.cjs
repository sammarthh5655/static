const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const path = require('node:path');

/** browser://passwords: health, import/export, and autofill management. Off-screen. */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 220) : ''));
    if (!ok) fails++;
  };
  const until = async (fn, tries = 50) => { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await wait(150); } return null; };
  try {
    await wait(800);
    browser.passwords.clear();
    for (const e of browser.autofill.list()) browser.autofill.remove(e.id);
    // A Chrome-style export with a weak and a reused password.
    const result = browser.passwords.importCsv('name,url,username,password\r\nA,https://a.example,sam,hunter2\r\nB,https://b.example,sam,Same-Pass-9x!\r\nC,https://c.example,sam,Same-Pass-9x!\r\n');
    check('a Chrome/Edge/Brave CSV imports', result.ok && result.added === 3, JSON.stringify(result));
    const firefox = browser.passwords.importCsv('"url","username","password","httpRealm","formActionOrigin","guid"\n"https://d.example","sam","Tr0ub4dor&3xyz",,"","{x}"\n');
    check('and so does a Firefox one', firefox.ok && firefox.added === 1, JSON.stringify(firefox));
    const h = browser.passwords.health();
    check('health finds the weak and the reused', h.weak.length === 1 && h.reused.length === 2, JSON.stringify(h));
    const csv = browser.passwords.exportCsv();
    check('export writes every login back out', csv.split('\r\n').filter(Boolean).length === 5 && csv.startsWith('name,url,username,password'));

    const tab = browser.tabs.active;
    const wc = tab.view.webContents;
    const go = async (url) => {
      const loaded = new Promise((r) => { wc.once('did-finish-load', r); setTimeout(r, 8000); });
      browser.tabs.navigate(tab.id, url);
      await loaded;
    };
    const shots = path.join(app.getAppPath(), 'shots');
    fs.mkdirSync(shots, { recursive: true });
    const shot = async (name) => { const img = await wc.capturePage().catch(() => null); if (img && !img.isEmpty()) fs.writeFileSync(path.join(shots, name + '.png'), img.toPNG()); };

    await go('browser://passwords');
    await until(() => wc.executeJavaScript(`!!document.querySelector('.pw-stats')`));
    const stats = await wc.executeJavaScript(`[...document.querySelectorAll('.pw-stat')].map(s => s.textContent)`);
    check('the page shows password health', stats.some((s) => /1weak/.test(s)) && stats.some((s) => /2reused/.test(s)), stats.join(' | '));
    check('autofill is no longer on the passwords page', !(await wc.executeJavaScript(`!!document.querySelector('.pw-tabs, .af-cats')`)));
    const toggles = await wc.executeJavaScript(`[...document.querySelectorAll('.pw-toggle strong')].map(s => s.textContent)`);
    check('the sign-in switches are here', ['Offer to save passwords', 'Show saved logins on sign-in pages', 'Sign in automatically', 'Save and use passkeys'].every((t) => toggles.includes(t)), toggles.join(' | '));

    // Adding a password by hand.
    await wc.executeJavaScript(`[...document.querySelectorAll('.pill')].find(b => b.textContent === '+ Add password').click()`);
    await until(() => wc.executeJavaScript(`!!document.querySelector('.pv-editor')`));
    await wc.executeJavaScript(`(() => {
      const byLabel = (t) => [...document.querySelectorAll('.pv-editor .pw-field')].find(f => f.textContent.startsWith(t)).querySelector('input,textarea');
      byLabel('Website').value = 'mail.example.org'; byLabel('Username or email').value = 'sam@example.org';
      byLabel('Password').value = 'Hand-Typed-Secret-9'; byLabel('Note').value = 'Recovery code: 7788';
      document.querySelector('.pv-editor').requestSubmit();
    })()`);
    const added = await until(() => browser.passwords.forUrl('https://mail.example.org').length === 1);
    const addedId = browser.passwords.forUrl('https://mail.example.org')[0]?.id;
    const details = addedId && browser.passwords.details(addedId);
    check('"+ Add password" saves a login typed by hand, with its note', !!added && details?.password === 'Hand-Typed-Secret-9' && details?.note === 'Recovery code: 7788', JSON.stringify(details && { ...details, password: '…' }));
    await until(() => wc.executeJavaScript(`!document.querySelector('.pv-editor') && [...document.querySelectorAll('.password-origin')].some(e => e.textContent === 'mail.example.org')`));
    check('and lists it, marked as having a note', await wc.executeJavaScript(`[...document.querySelectorAll('.password-row')].some(r => r.textContent.includes('mail.example.org') && r.querySelector('.pv-note-tag'))`));

    // A second login for the same site and username is refused, with a reason.
    await wc.executeJavaScript(`[...document.querySelectorAll('.pill')].find(b => b.textContent === '+ Add password').click()`);
    await until(() => wc.executeJavaScript(`!!document.querySelector('.pv-editor')`));
    await wc.executeJavaScript(`(() => {
      const byLabel = (t) => [...document.querySelectorAll('.pv-editor .pw-field')].find(f => f.textContent.startsWith(t)).querySelector('input,textarea');
      byLabel('Website').value = 'https://mail.example.org'; byLabel('Username or email').value = 'sam@example.org'; byLabel('Password').value = 'x';
      document.querySelector('.pv-editor').requestSubmit();
    })()`);
    const dupe = await until(() => wc.executeJavaScript(`document.querySelector('.pv-editor .pw-error')?.textContent || ''`));
    check('a duplicate is refused: "edit that one instead"', /Edit that one instead/.test(dupe || ''), dupe);
    await wc.executeJavaScript(`[...document.querySelectorAll('.pv-editor .pill')].find(b => b.textContent === 'Cancel').click()`);

    // Editing: the form opens with what is saved, and only what changes changes.
    await wc.executeJavaScript(`[...document.querySelectorAll('.password-row')].find(r => r.textContent.includes('mail.example.org')).querySelector('.turn-tool:not(.danger)') && [...[...document.querySelectorAll('.password-row')].find(r => r.textContent.includes('mail.example.org')).querySelectorAll('.turn-tool')].find(b => b.textContent === 'Edit').click()`);
    await until(() => wc.executeJavaScript(`!!document.querySelector('.pv-editor')`));
    const prefilled = await wc.executeJavaScript(`[...document.querySelectorAll('.pv-editor input, .pv-editor textarea')].map(i => i.value)`);
    check('Edit opens the login with its username, password and note', prefilled[0] === 'mail.example.org' && prefilled[1] === 'sam@example.org' && prefilled[2] === 'Hand-Typed-Secret-9' && prefilled[3] === 'Recovery code: 7788', JSON.stringify(prefilled.map((v, i) => (i === 2 ? '…' : v))));
    await wc.executeJavaScript(`(() => {
      const byLabel = (t) => [...document.querySelectorAll('.pv-editor .pw-field')].find(f => f.textContent.startsWith(t)).querySelector('input,textarea');
      byLabel('Username or email').value = 'samuel@example.org'; byLabel('Note').value = '';
      document.querySelector('.pv-editor').requestSubmit();
    })()`);
    const edited = await until(() => browser.passwords.forUrl('https://mail.example.org')[0]?.username === 'samuel@example.org');
    const after = browser.passwords.details(addedId);
    check('saving the edit changes the username and clears the note, keeping the password', !!edited && after.password === 'Hand-Typed-Secret-9' && after.note === '', JSON.stringify({ ...after, password: after.password ? '…' : '' }));
    await wait(300);
    await shot('passwords-page');

    // The address-bar key's "Add a password for this site" link.
    // Opened from the address bar it is a new tab; here the page is already open, so the link changes only its hash.
    browser.tabs.navigate(tab.id, 'browser://passwords#add=' + encodeURIComponent('https://shop.example.net'));
    const prefill = await until(() => wc.executeJavaScript(`document.querySelector('.pv-editor input')?.value || ''`));
    check('#add=<site> opens the add form for that site', prefill === 'shop.example.net', prefill);

    // Autofill: its own page now.
    await go('browser://autofill');
    await until(() => wc.executeJavaScript(`document.querySelectorAll('.af-cat').length === 5`));
    const cats = await wc.executeJavaScript(`[...document.querySelectorAll('.af-cat-name')].map(s => s.textContent)`);
    check('browser://autofill has addresses, cards, UPI, documents and custom fields', cats.join('|') === 'Addresses|Payment cards|UPI IDs|IDs & documents|Custom fields', cats.join(' | '));
    const nav = await wc.executeJavaScript(`[...document.querySelectorAll('.shell-link')].map(l => l.dataset.mode)`);
    check('and its own place in the sidebar, after Passwords', nav.indexOf('autofill') === nav.indexOf('passwords') + 1, nav.join(' '));

    await wc.executeJavaScript(`document.querySelector('.af-add').click()`);
    await until(() => wc.executeJavaScript(`!!document.querySelector('.af-editor')`));
    await wc.executeJavaScript(`(() => {
      const byLabel = (t) => [...document.querySelectorAll('.af-editor .pw-field')].find(f => f.textContent.startsWith(t)).querySelector('input,select');
      byLabel('Label').value = 'Home'; byLabel('Full name').value = 'Sam Sharma'; byLabel('Address').value = '12 MG Road';
      byLabel('City').value = 'Pune'; byLabel('PIN / ZIP code').value = '411001'; byLabel('Phone').value = '9876543210';
      document.querySelector('.af-editor').requestSubmit();
    })()`);
    const row = await until(() => wc.executeJavaScript(`document.querySelector('.af-tile-head strong')?.textContent || ''`));
    check('an address added on the page is saved and shown as a tile', row === 'Home' && browser.autofill.list('address').length === 1, row);
    const count = await wc.executeJavaScript(`document.querySelector('.af-cat.is-active .af-cat-count').textContent`);
    check('and counted on its category', count === '1', count);

    await wc.executeJavaScript(`[...document.querySelectorAll('.af-cat')][1].click()`);
    await wait(200);
    await wc.executeJavaScript(`document.querySelector('.af-add').click()`);
    await until(() => wc.executeJavaScript(`!!document.querySelector('.af-editor')`));
    await wc.executeJavaScript(`(() => {
      const byLabel = (t) => [...document.querySelectorAll('.af-editor .pw-field')].find(f => f.textContent.startsWith(t)).querySelector('input,select');
      byLabel('Card number').value = '4242 4242 4242 4241';
      document.querySelector('.af-editor').requestSubmit();
    })()`);
    const error = await until(() => wc.executeJavaScript(`document.querySelector('.af-editor .pw-error')?.textContent || ''`));
    check('a mistyped card number is refused, with a reason', /does not look right/.test(error || ''), error);
    await wc.executeJavaScript(`(() => {
      const byLabel = (t) => [...document.querySelectorAll('.af-editor .pw-field')].find(f => f.textContent.startsWith(t)).querySelector('input,select');
      byLabel('Label').value = 'Personal'; byLabel('Name on card').value = 'Sam Sharma'; byLabel('Card number').value = '4242 4242 4242 4242';
      byLabel('Expiry month').value = '8'; byLabel('Expiry year').value = '2029';
      document.querySelector('.af-editor').requestSubmit();
    })()`);
    const cc = await until(() => wc.executeJavaScript(`document.querySelector('.af-cc') ? [document.querySelector('.af-cc-network').textContent, document.querySelector('.af-cc-number').textContent, document.querySelector('.af-cc-exp').textContent, document.querySelector('.af-cc').className] : null`));
    check('a saved card is drawn as a card: network, last four, expiry', cc && cc[0] === 'Visa' && /4242$/.test(cc[1]) && !/4242\s*4242/.test(cc[1].replace(/[•\s]/g, ' ')) && /08\/29/.test(cc[2]) && /tone-visa/.test(cc[3]), JSON.stringify(cc));
    check('the page never holds the full card number', !(await wc.executeJavaScript(`document.body.textContent.includes('4242424242424242') || document.body.textContent.includes('4242 4242 4242 4242')`)));
    await wait(500);
    await shot('autofill-cards');
    await wc.executeJavaScript(`[...document.querySelectorAll('.af-cat')][0].click()`);
    await wait(500);
    await shot('autofill-addresses');
    browser.passwords.clear();
    for (const e of browser.autofill.list()) browser.autofill.remove(e.id);
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }
  console.log(fails ? '\nFAILURES: ' + fails : '\nall password page checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
