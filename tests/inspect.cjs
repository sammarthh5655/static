const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fs = require('node:fs');
const path = require('node:path');

/**
 * A look at the things this session changed, in the real app: the title bar
 * with the tabs in it, the downloads button and its bubble, the new tab's
 * shortcut row and quick buttons, and the Passwords page's tabs.
 *
 * Reports measurements (so a squashed or overlapping thing shows up as
 * numbers) and writes screenshots to .test-profile/inspect/shots for a look.
 * Run with `node scripts/start.cjs --inspect`.
 */

async function run(browser) {
  const { app } = require('electron');
  const shots = path.join(app.getPath('userData'), 'shots');
  fs.mkdirSync(shots, { recursive: true });
  let failures = 0;
  const problems = [];
  const check = (name, ok, detail = '') => {
    console.log((ok ? '  ok  ' : 'BUG   ') + name + (detail ? ' :: ' + detail : ''));
    if (!ok) { failures++; problems.push(name + (detail ? ' :: ' + detail : '')); }
  };
  const errors = [];
  const watch = (wc, tag) => wc.on('console-message', (e) => {
    const text = e?.message ?? '';
    if ((e?.level === 'error' || e?.level === 3) && text) errors.push(tag + ': ' + text);
  });

  const shot = async (view, name) => {
    try {
      const image = await view.webContents.capturePage();
      if (image.isEmpty()) return;
      fs.writeFileSync(path.join(shots, name + '.png'), image.toPNG());
    } catch (error) { console.log('  (no shot ' + name + ': ' + error.message + ')'); }
  };

  try {
    // A fresh probe profile starts on the welcome flow; skip it so the real
    // new tab is what gets looked at.
    browser.onboarding?.complete?.();
    browser.window.show();
    browser.window.setContentSize(1280, 800);
    watch(browser.chrome.webContents, 'chrome');
    watch(browser.overlay.webContents, 'overlay');
    await wait(1600);

    /* ---- 1. the title bar with the tabs in it ---- */
    const bar = await browser.chrome.webContents.executeJavaScript(`(() => {
      const r = (s) => { const n = document.querySelector(s); if (!n) return null;
        const b = n.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
      const strip = document.querySelector('.titlebar .strip');
      return {
        titlebar: r('.titlebar'), strip: r('.titlebar .strip'), tabs: r('#tabs'),
        firstTab: r('.tab'), menu: r('#app-menu'), controls: r('#window-controls'),
        toolbar: r('.toolbar'),
        stripInsideTitlebar: !!strip,
        bodyClasses: document.body.className,
      };
    })()`);
    console.log('  layout: ' + JSON.stringify(bar));
    check('tab strip lives in the title bar', bar.stripInsideTitlebar);
    check('tabs start at the top of the window', bar.firstTab && bar.firstTab.y < 12,
      'first tab y=' + (bar.firstTab && bar.firstTab.y));
    check('title bar is the strip height', bar.titlebar && bar.titlebar.h === 40, 'h=' + (bar.titlebar && bar.titlebar.h));
    check('toolbar sits directly under the title bar', bar.toolbar && bar.titlebar && bar.toolbar.y === bar.titlebar.h,
      'toolbar y=' + (bar.toolbar && bar.toolbar.y) + ' titlebar h=' + (bar.titlebar && bar.titlebar.h));
    check('window controls do not overlap the tabs', bar.controls && bar.tabs && bar.tabs.x + bar.tabs.w <= bar.controls.x + 1,
      'tabs end ' + (bar.tabs && (bar.tabs.x + bar.tabs.w)) + ', controls start ' + (bar.controls && bar.controls.x));
    await shot(browser.chrome, '01-titlebar');

    /* ---- 2. main process geometry agrees with the CSS ---- */
    const { chromeHeight } = require('../src/main/window');
    const settings = browser.settings ? browser.settings.value : null;
    if (settings) {
      const top = chromeHeight(settings);
      const expected = (bar.titlebar?.h || 0) + (bar.toolbar?.h || 0) + (settings.bookmarksBar ? 34 : 0);
      check('main and CSS agree where the page starts', top === expected, 'main=' + top + ' css=' + expected);
    }

    /* ---- 3. the downloads button ---- */
    const dl = await browser.chrome.webContents.executeJavaScript(`(() => {
      const b = document.getElementById('downloads');
      if (!b) return { missing: true };
      const ring = b.querySelector('.dl-ring');
      return { hidden: b.hidden, hasRing: !!ring, title: b.title,
        inToolbar: !!b.closest('.toolbar') };
    })()`);
    check('downloads button exists, in the toolbar, with its ring', !dl.missing && dl.hasRing && dl.inToolbar, JSON.stringify(dl));
    // Only true on a clean profile: this one keeps the downloads a previous
    // run made, and then the button is right to be showing.
    const hadDownloads = browser.downloads.list().length > 0;
    check('downloads button is hidden until there is a download',
      hadDownloads ? dl.hidden === false : dl.hidden === true,
      'hidden=' + dl.hidden + ', ' + browser.downloads.list().length + ' in the list');

    /* ---- 4. the new tab: shortcuts row and quick buttons ---- */
    const tab = browser.tabs?.active;
    if (tab) {
      watch(tab.view.webContents, 'newtab');
      browser.tabs.navigate(tab.id, 'browser://newtab');
      await wait(2200);
      const nt = await tab.view.webContents.executeJavaScript(`(() => {
        const r = (s) => { const n = document.querySelector(s); if (!n) return null;
          const b = n.getBoundingClientRect(); return { y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
        return {
          actions: r('#actions'), actionCount: document.querySelectorAll('.action').length,
          frequentHidden: document.getElementById('frequent')?.hidden,
          tiles: document.querySelectorAll('.frequent-item').length,
          addTile: !!document.querySelector('.frequent-add'),
          moreButtons: document.querySelectorAll('.frequent-more').length,
          shortcutsApi: typeof window.newtabShortcuts,
          hasInit: typeof window.newtabShortcuts?.init,
        };
      })()`).catch((e) => ({ error: e.message }));
      console.log('  newtab: ' + JSON.stringify(nt));
      check('new tab exposes the shortcuts module', nt.shortcutsApi === 'object' && nt.hasInit === 'function');
      check('quick buttons render', nt.actionCount > 0, 'count=' + nt.actionCount);
      // With no history a fresh profile shows only the + tile.
      check('shortcuts row shows the add tile', nt.addTile === true, 'tiles=' + nt.tiles);
      check('every shortcut tile has its menu button', nt.tiles === 0 || nt.moreButtons === nt.tiles - (nt.addTile ? 1 : 0),
        'tiles=' + nt.tiles + ' more=' + nt.moreButtons);
      await shot(tab.view, '02-newtab');

      /* right-clicking a quick button must open our own menu, not throw */
      const menuResult = await tab.view.webContents.executeJavaScript(`(() => {
        const a = document.querySelector('.action');
        if (!a) return 'no action button';
        try {
          a.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
          return document.querySelector('.nt-menu') ? 'menu opened' : 'no menu';
        } catch (e) { return 'threw: ' + e.message; }
      })()`).catch((e) => 'threw: ' + e.message);
      check('right-click on a quick button opens its menu', menuResult === 'menu opened', String(menuResult));
      await shot(tab.view, '03-quickbutton-menu');
    }

    /* ---- 5. the Passwords page and its tabs ---- */
    // create() answers with an id; the tab itself comes from the map.
    const pwId = browser.tabs.create({ url: 'browser://passwords' });
    await wait(2800);
    const pwTab = browser.tabs.tabs.get(pwId);
    const pw = pwTab?.view?.webContents;
    check('the Passwords page opened', !!pw, 'id=' + pwId);
    if (pw) {
      watch(pw, 'passwords');
      const diag = await pw.executeJavaScript(`(() => ({
        bodyHtmlLen: document.body.innerHTML.length,
        shellMounted: !!document.querySelector('.shell-content, .panel, main'),
        anyCard: document.querySelectorAll('.panel-card').length,
        hasExtras: !!window.passwordExtras,
        hasPage: !!window.passwordPage,
        hasSecurity: !!window.passwordSecurity,
        contentChildren: (document.querySelector('.shell-content')?.children.length) ?? -1,
        contentHTML: (document.querySelector('.shell-content')?.innerHTML || '').slice(0, 300),
      }))()`).catch((e) => ({ error: e.message }));
      console.log('  passwords DIAG: ' + JSON.stringify(diag));
      const info = await pw.executeJavaScript(`(() => ({
        tabs: [...document.querySelectorAll('.pw-tab')].map((b) => b.textContent.trim()),
        active: document.querySelector('.pw-tab.is-active')?.textContent.trim() || null,
        cards: document.querySelectorAll('.panel-card').length,
        extrasHostHidden: document.querySelector('.pw-extras')?.hidden,
        locked: !!document.querySelector('.pv-lock'),
      }))()`).catch((e) => ({ error: e.message }));
      console.log('  passwords: ' + JSON.stringify(info));
      check('Passwords shows three tabs', Array.isArray(info.tabs) && info.tabs.length === 3, JSON.stringify(info.tabs));
      check('a tab is selected and cards are drawn', !!info.active && info.cards > 0, 'active=' + info.active + ' cards=' + info.cards);
      await shot(pwTab.view, '04-passwords');

      // Switch to Settings: the master password and recovery live there.
      const settingsTab = await pw.executeJavaScript(`(() => {
        const b = [...document.querySelectorAll('.pw-tab')].find((x) => x.textContent.includes('Settings'));
        if (!b) return 'no settings tab';
        b.click();
        return 'clicked';
      })()`).catch((e) => 'threw: ' + e.message);
      await wait(900);
      const after = await pw.executeJavaScript(`(() => ({
        active: document.querySelector('.pw-tab.is-active')?.textContent.trim() || null,
        cards: document.querySelectorAll('.panel-card').length,
        hasSecurity: !!document.querySelector('.pv-security'),
        hasRecovery: !!document.querySelector('.pv-recovery'),
        hasSignIn: [...document.querySelectorAll('.panel-card-title')].some((t) => t.textContent.includes('Signing in')),
        hasTransfer: [...document.querySelectorAll('.panel-card-title')].some((t) => t.textContent.includes('Import and export')),
      }))()`).catch((e) => ({ error: e.message }));
      console.log('  passwords/settings: ' + settingsTab + ' ' + JSON.stringify(after));
      check('Settings tab switches', after.active === 'Settings', 'active=' + after.active);
      check('Settings shows the security card', after.hasSecurity === true);
      check('Settings shows the sign-in and transfer cards', after.hasSignIn && after.hasTransfer, JSON.stringify(after));
      await shot(pwTab.view, '05-passwords-settings');

      const checkupTab = await pw.executeJavaScript(`(() => {
        const b = [...document.querySelectorAll('.pw-tab')].find((x) => x.textContent.includes('Checkup'));
        if (b) b.click();
        return !!b;
      })()`).catch(() => false);
      await wait(900);
      const checkup = await pw.executeJavaScript(`(() => ({
        active: document.querySelector('.pw-tab.is-active')?.textContent.trim() || null,
        cards: document.querySelectorAll('.panel-card').length,
        text: (document.querySelector('.panel-card')?.textContent || '').slice(0, 60),
      }))()`).catch((e) => ({ error: e.message }));
      console.log('  passwords/checkup: ' + JSON.stringify(checkup));
      check('Checkup tab shows something', checkupTab && checkup.cards > 0, JSON.stringify(checkup));
      await shot(pwTab.view, '06-passwords-checkup');
    }

    /* ---- 6. Settings: the import card and its search ---- */
    const setId = browser.tabs.create({ url: 'browser://settings' });
    await wait(2800);
    const setTab = browser.tabs.tabs.get(setId);
    const sw = setTab?.view?.webContents;
    check('the Settings page opened', !!sw, 'id=' + setId);
    if (sw) {
      watch(sw, 'settings');
      const found = await sw.executeJavaScript(`(() => {
        const box = document.getElementById('settings-search');
        if (!box) return { error: 'no search box' };
        box.value = 'import';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        return new Promise((resolve) => setTimeout(() => resolve({
          importCardVisible: !!document.querySelector('#import-host') &&
            !document.querySelector('#import-host')?.closest('[hidden]'),
          noResults: document.getElementById('settings-no-results')?.hidden === false,
          visibleFields: document.querySelectorAll('.field:not([hidden])').length,
        }), 350));
      })()`).catch((e) => ({ error: e.message }));
      console.log('  settings search "import": ' + JSON.stringify(found));
      check('searching "import" in Settings finds the import card', found.importCardVisible === true && !found.noResults, JSON.stringify(found));
      await shot(setTab.view, '07-settings-import-search');
    }

    /* ---- 7. a real download: the button, its ring and the bubble ---- */
    const http = require('node:http');
    const server = http.createServer((q, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="probe-file.bin"', 'content-length': '2000000' });
      // Dribble it out so the download is still running when it is looked at.
      let sent = 0;
      const chunk = Buffer.alloc(100000);
      const push = () => {
        if (sent >= 2000000) return res.end();
        res.write(chunk); sent += chunk.length; setTimeout(push, 90);
      };
      push();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const fileUrl = 'http://127.0.0.1:' + server.address().port + '/probe-file.bin';
    const before = browser.downloads.list().length;
    browser.tabs.navigate(browser.tabs.active.id, fileUrl);
    await wait(2600);
    check('a download was recorded', browser.downloads.list().length > before,
      'was ' + before + ', now ' + browser.downloads.list().length);
    const dlAfter = await browser.chrome.webContents.executeJavaScript(`(() => {
      const b = document.getElementById('downloads');
      const cs = getComputedStyle(b);
      return { hidden: b.hidden, classes: b.className, title: b.title,
        progress: cs.getPropertyValue('--progress').trim(),
        ringVisible: getComputedStyle(b.querySelector('.dl-ring')).opacity };
    })()`).catch((e) => ({ error: e.message }));
    console.log('  downloads button while downloading: ' + JSON.stringify(dlAfter));
    check('the downloads button appears while downloading', dlAfter.hidden === false, JSON.stringify(dlAfter));
    check('its ring shows progress', dlAfter.classes && dlAfter.classes.includes('is-active') && dlAfter.ringVisible === '1', JSON.stringify(dlAfter));
    await shot(browser.chrome, '08-downloading');

    // The bubble the download opens for itself.
    const bubble = await browser.overlay.webContents.executeJavaScript(`(() => {
      const card = document.querySelector('.dl-card');
      if (!card) return { open: false };
      const rows = [...document.querySelectorAll('.dl-row')];
      return { open: true, rows: rows.length,
        name: rows[0]?.querySelector('.dl-name')?.textContent || '',
        status: rows[0]?.querySelector('.dl-status')?.textContent || '',
        hasBar: !!rows[0]?.querySelector('.dl-bar') };
    })()`).catch((e) => ({ error: e.message }));
    console.log('  downloads bubble: ' + JSON.stringify(bubble));
    check('the bubble opened by itself with the download in it', bubble.open === true && bubble.rows > 0, JSON.stringify(bubble));
    check('the running download shows a progress bar and a status',
      bubble.hasBar === true && /[0-9]/.test(bubble.status || ''), JSON.stringify(bubble));
    await shot(browser.overlay, '09-download-bubble');
    try { server.close(); } catch { /* done */ }

    /* ---- console errors from every view ---- */
    await wait(600);
    check('no console errors anywhere', errors.length === 0, errors.slice(0, 8).join(' | '));

    console.log('\nShots in: ' + shots);
    if (problems.length) {
      console.log('\n' + problems.length + ' problem(s):');
      problems.forEach((p) => console.log('  - ' + p));
    }
  } catch (error) {
    failures++;
    console.log('PROBE THREW :: ' + (error && error.stack || error));
  }

  console.log('\n' + (failures ? failures + ' failing check(s)' : 'all checks passed'));
  app.exit(failures ? 1 : 0);
}

module.exports = { run };
