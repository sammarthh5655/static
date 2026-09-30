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
    const loaded = new Promise((r) => { wc.once('did-finish-load', r); setTimeout(r, 8000); });
    browser.tabs.navigate(tab.id, 'browser://passwords#autofill');
    await loaded;
    await until(() => wc.executeJavaScript(`!!document.querySelector('.pw-stats')`));
    const stats = await wc.executeJavaScript(`[...document.querySelectorAll('.pw-stat')].map(s => s.textContent)`);
    check('the page shows password health', stats.some((s) => /1weak/.test(s)) && stats.some((s) => /2reused/.test(s)), stats.join(' | '));
    const tabs = await wc.executeJavaScript(`[...document.querySelectorAll('.pw-tab span')].map(s => s.textContent)`);
    check('autofill has addresses, cards, UPI, documents and custom fields', tabs.length === 5 && tabs[4] === 'Custom fields', tabs.join(' | '));

    await wc.executeJavaScript(`document.querySelector('.pw-add').click()`);
    await wait(200);
    await wc.executeJavaScript(`(() => {
      const byLabel = (t) => [...document.querySelectorAll('.pw-field')].find(f => f.textContent.startsWith(t)).querySelector('input,select');
      byLabel('Label').value = 'Home'; byLabel('Full name').value = 'Sam Sharma'; byLabel('Address').value = '12 MG Road';
      byLabel('City').value = 'Pune'; byLabel('PIN / ZIP code').value = '411001';
      [...document.querySelectorAll('.pw-editor .pill')].find(b => b.textContent.startsWith('Save')).click();
    })()`);
    const row = await until(() => wc.executeJavaScript(`document.querySelector('.pw-item strong')?.textContent || ''`));
    check('an address added on the page is saved and listed', row === 'Home' && browser.autofill.list('address').length === 1, row);

    await wc.executeJavaScript(`[...document.querySelectorAll('.pw-tab')][1].click()`);
    await wait(200);
    await wc.executeJavaScript(`document.querySelector('.pw-add').click()`);
    await wait(200);
    await wc.executeJavaScript(`(() => {
      const byLabel = (t) => [...document.querySelectorAll('.pw-field')].find(f => f.textContent.startsWith(t)).querySelector('input,select');
      byLabel('Card number').value = '4242 4242 4242 4241';
      [...document.querySelectorAll('.pw-editor .pill')].find(b => b.textContent.startsWith('Save')).click();
    })()`);
    const error = await until(() => wc.executeJavaScript(`document.querySelector('.pw-editor .pw-error')?.textContent || ''`));
    check('a mistyped card number is refused, with a reason', /does not look right/.test(error || ''), error);

    const shots = path.join(app.getAppPath(), 'shots');
    fs.mkdirSync(shots, { recursive: true });
    await wc.executeJavaScript(`document.getElementById('autofill').scrollIntoView()`);
    await wait(400);
    const img = await wc.capturePage().catch(() => null);
    if (img) fs.writeFileSync(path.join(shots, 'passwords-autofill.png'), img.toPNG());
    browser.passwords.clear();
    for (const e of browser.autofill.list()) browser.autofill.remove(e.id);
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }
  console.log(fails ? '\nFAILURES: ' + fails : '\nall password page checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
