const fs = require('node:fs');
const path = require('node:path');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Password vault checks. Run with `npm run test:privacy`.
 *
 * The assertions that matter most are about what is NOT exposed: the vault
 * file must not contain plaintext, and a listing must never carry a password.
 * Those are the failures that would be invisible until something leaked.
 */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (name, ok, detail) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + name + (detail ? ' :: ' + String(detail).slice(0, 120) : ''));
    if (!ok) fails++;
  };

  try {
    const pw = browser.passwords;
    const { generatePassword } = require('../src/features/passwords');
    const SECRET = 'hunter2-correct-horse';

    // Start clean: a profile left over from a previous run would make every
    // count assertion below wrong for reasons that have nothing to do with
    // the code under test.
    pw.clear();

    const status = pw.encryptionStatus();
    check('OS encryption available', status.available === true, JSON.stringify(status));

    check('saves a credential',
      pw.save_credential({ url: 'https://example.com/login', username: 'sam', password: SECRET }).ok);

    const list = pw.list();
    check('lists it', list.length === 1 && list[0].username === 'sam');
    check('listing carries NO password', !JSON.stringify(list).includes('hunter2'),
      Object.keys(list[0]).join(','));

    const raw = fs.readFileSync(path.join(app.getPath('userData'), 'vault.json'), 'utf8');
    check('vault file is encrypted', !raw.includes('hunter2') && !/correct|horse/i.test(raw),
      raw.length + ' bytes');

    const revealed = pw.reveal(list[0].id);
    check('reveal returns the password', revealed.ok && revealed.password === SECRET);

    check('matches the same origin', pw.forUrl('https://example.com/other').length === 1);
    check('does not match another host', pw.forUrl('https://evil.com/login').length === 0);
    check('does not offer an https login over http',
      pw.forUrl('http://example.com/login').length === 0);

    pw.save_credential({ url: 'https://example.com/login', username: 'other', password: 'second' });
    check('two accounts on one site coexist', pw.forUrl('https://example.com/x').length === 2);

    const generated = Array.from({ length: 200 }, () => generatePassword({ length: 20 }));
    check('generated passwords are the right length', generated.every((g) => g.length === 20));
    check('generated passwords are unique', new Set(generated).size === 200);
    check('every character class present', generated.every((g) =>
      /[a-z]/.test(g) && /[A-Z]/.test(g) && /[0-9]/.test(g) && /[^a-zA-Z0-9]/.test(g)));
    check('confusable characters avoided', generated.every((g) => !/[lIO01]/.test(g)));

    // The page must not print a password until asked.
    browser.window.show();
    browser.push();
    // The first tab is created once the chrome finishes loading, so wait for
    // it rather than assuming it already exists.
    for (let i = 0; i < 50 && !browser.tabs?.active; i++) await wait(200);
    if (!browser.tabs?.active) throw new Error('No tab was ever created');
    browser.tabs.navigate(browser.tabs.activeId, 'browser://passwords');
    const wc = browser.tabs.active.view.webContents;
    for (let i = 0; i < 40 && wc.isLoading(); i++) await wait(200);
    await wait(1200);
    const page = await wc.executeJavaScript(`({
      rows: document.querySelectorAll('.password-row').length,
      leaks: document.body.innerText.includes('hunter2'),
    })`);
    check('page lists the logins', page.rows === 2, page.rows + ' rows');
    check('page shows no password by default', page.leaks === false);

    pw.clear();
    check('clear empties the vault', pw.list().length === 0);

    console.log(fails ? '\n' + fails + ' check(s) failed.\n' : '\nAll privacy checks passed.\n');
    app.exit(fails ? 1 : 0);
  } catch (error) {
    console.error('Privacy test failed:', error);
    app.exit(1);
  }
}

module.exports = { run };
