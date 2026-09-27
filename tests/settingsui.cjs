const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const path = require('node:path');

/**
 * Profiles can be made from the picker and managed in Settings, and settings
 * search answers the words people type - every term on the list the user
 * gave, each of which must lead somewhere.
 */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 160) : ''));
    if (!ok) fails++;
  };
  const dir = path.join(app.getAppPath(), 'shots');
  fs.mkdirSync(dir, { recursive: true });
  const shot = async (wc, name) => {
    await wait(500);
    const img = await wc.capturePage().catch(() => null);
    if (img) fs.writeFileSync(path.join(dir, name + '.png'), img.toPNG());
  };
  // Navigation starts asynchronously, so isLoading() can still be false the
  // instant after navigate(); wait for the load event itself.
  const go = async (wc, url) => {
    const loaded = new Promise((resolve) => {
      wc.once('did-finish-load', resolve);
      setTimeout(resolve, 8000);
    });
    browser.tabs.navigate(browser.tabs.activeId, url);
    await loaded;
    await wait(700);
  };

  try {
    browser.window.show();
    await wait(1000);
    for (const extra of browser.profiles.list.slice(1)) {
      try { browser.profiles.remove(extra.id); } catch { /* the last stays */ }
    }

    const errors = [];
    const wc = browser.tabs.active.view.webContents;
    wc.on('console-message', (e) => {
      if (e?.level === 'error' || e?.level === 3) errors.push(String(e.message).slice(0, 160));
    });

    // ---- the creation sheet ----
    await go(wc, 'browser://profiles#new');
    // The sheet is drawn once the profile list arrives, after the load event.
    for (let i = 0; i < 40; i++) {
      if (await wc.executeJavaScript(`!!document.querySelector('.creator-planet')`)) break;
      await wait(150);
    }
    const sheet = await wc.executeJavaScript(`({
      open: !document.getElementById('creator').hidden,
      planets: document.querySelectorAll('#creator-planets .creator-choice').length,
      avatars: document.querySelectorAll('#creator-avatars .creator-choice').length,
      templates: document.querySelectorAll('#creator-templates .creator-choice').length,
      swatch: getComputedStyle(document.querySelector('.creator-planet')).backgroundImage.slice(0, 30),
    })`);
    check('browser://profiles#new opens the creation sheet', sheet.open, JSON.stringify(sheet));
    check('it offers every planet, icon and template',
      sheet.planets >= 9 && sheet.avatars >= 6 && sheet.templates >= 4, JSON.stringify(sheet));
    check('planet swatches are painted (CSP allows them)', /gradient/.test(sheet.swatch), sheet.swatch);

    await wc.executeJavaScript(`(() => {
      const input = document.getElementById('creator-name');
      input.value = 'Study'; input.dispatchEvent(new Event('input'));
      document.querySelector('#creator-planets [aria-label="Mars"]').click();
    })()`);
    await wait(400);
    const preview = await wc.executeJavaScript(`({
      name: document.getElementById('creator-preview-name').textContent,
      planet: document.getElementById('creator-preview-planet').textContent,
      checked: document.querySelector('#creator-planets [aria-checked="true"]')?.getAttribute('aria-label'),
    })`);
    check('the preview follows the choices', preview.name === 'Study' && preview.checked === 'Mars' && /Mars/.test(preview.planet), JSON.stringify(preview));
    await shot(wc, 'profile-creator');

    // Create through the same IPC the sheet uses, without entering (entering relaunches).
    const made = browser.profiles.create({ name: 'Study', theme: 'mars', template: 'privacy' });
    check('a created profile is listed', browser.profiles.list.some((p) => p.id === made.id));

    // ---- Settings -> Profiles ----
    await go(wc, 'browser://settings#profiles');
    for (let i = 0; i < 40; i++) {
      if (await wc.executeJavaScript(`!!document.querySelector('.profile-row')`)) break;
      await wait(150);
    }
    const section = await wc.executeJavaScript(`({
      visible: !document.querySelector('[data-section="profiles"]').hidden,
      nav: !!document.querySelector('[data-category="profiles"]'),
      rows: [...document.querySelectorAll('.profile-row .profile-name')].map(n => n.textContent),
      startupOptions: document.querySelectorAll('#profile-startup option').length,
      hasNew: !!document.getElementById('profile-new'),
    })`);
    check('settings#profiles is a real section now', section.visible && section.nav, JSON.stringify(section));
    check('every profile has a row', section.rows.includes('Study') && section.rows.length === browser.profiles.list.length, JSON.stringify(section.rows));
    check('picker startup behaviour is offered', section.startupOptions >= 3);
    await shot(wc, 'settings-profiles');

    // ---- search: every term from the list, plus the words people use ----
    const terms = ['user selection', 'theme', 'privacy', 'appearance', 'downloads', 'passwords',
      'autofill', 'shields', 'search engine', 'ai', 'performance', 'tabs', 'startup',
      'keyboard shortcuts', 'dark mode', 'cookies', 'wallpaper', 'ram', 'profile', 'licence'];
    const results = {};
    for (const term of terms) {
      results[term] = await wc.executeJavaScript(`(() => {
        const input = document.getElementById('settings-search');
        input.value = ${JSON.stringify(term)};
        input.dispatchEvent(new Event('input'));
        const fields = [...document.querySelectorAll('#settings-content .field')].filter(f => f.offsetParent);
        const jumps = document.querySelectorAll('#settings-jump .field').length;
        return { fields: fields.length, jumps, empty: !document.getElementById('settings-no-results').hidden };
      })()`);
    }
    const missing = terms.filter((t) => results[t].empty || (results[t].fields + results[t].jumps) === 0);
    check('every searched term finds something', missing.length === 0, 'nothing for: ' + missing.join(', '));
    check('"user selection" reaches profiles', results['user selection'].fields > 0, JSON.stringify(results['user selection']));
    check('"passwords" also offers the password manager', results.passwords.jumps > 0, JSON.stringify(results.passwords));
    console.log('  search counts: ' + terms.map((t) => t + '=' + results[t].fields + '+' + results[t].jumps).join('  '));
    await wc.executeJavaScript(`(() => { const i = document.getElementById('settings-search'); i.value = 'user selection'; i.dispatchEvent(new Event('input')); })()`);
    await shot(wc, 'settings-search');

    check('no page errors', errors.length === 0, errors.join(' | '));
    // Leave one profile behind, or the next run starts on the picker.
    browser.profiles.remove(made.id);
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }

  console.log(fails ? '\nFAILURES: ' + fails : '\nall settings checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
