const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const path = require('node:path');

/**
 * The wallpaper pickers from the keyboard and at the edges: Tab lands on the
 * chosen photo, the arrows cross category headings, Space picks, F keeps a
 * favourite, and the previews hold still the moment animations are turned
 * off. Also checks Settings and the new tab's Customise panel stay in step.
 * Off-screen.
 */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d !== undefined && d !== '' ? ' :: ' + String(d).slice(0, 220) : ''));
    if (!ok) fails++;
  };
  const dir = path.join(app.getAppPath(), 'shots');
  fs.mkdirSync(dir, { recursive: true });
  const until = async (predicate, tries = 80) => {
    for (let i = 0; i < tries; i++) {
      const value = await Promise.resolve().then(predicate).catch(() => null);
      if (value) return value;
      await wait(100);
    }
    return null;
  };
  const all = require('../src/shared/wallpapers.json').wallpapers;
  const opened = [];

  try {
    browser.window.setSize(1180, 900);
    browser.settings.update({
      theme: 'neptune', animations: true, customPlanets: [],
      newTab: { background: 'wallpaper', backgroundValue: all[3].id, wallpaperMode: 'fixed', wallpaperPool: 'all', wallpaperFavourites: [] },
    });
    browser.push();

    const id = browser.tabs.create({ url: 'browser://settings#appearance' });
    opened.push(id);
    const wc = browser.tabs.tabs.get(id).view.webContents;
    const js = (code) => wc.executeJavaScript(code);
    const errors = [];
    wc.on('console-message', (e) => {
      if (e?.level === 'error' || e?.level === 3) errors.push(String(e.message).slice(0, 160));
    });
    const newTab = () => browser.settings.value.newTab;
    const key = async (keyCode, char) => {
      wc.sendInputEvent({ type: 'keyDown', keyCode });
      if (char) wc.sendInputEvent({ type: 'char', keyCode: char });
      wc.sendInputEvent({ type: 'keyUp', keyCode });
      await wait(150);
    };
    const active = () => js(`(() => { const a = document.activeElement; return a ? (a.dataset.id || a.dataset.value !== undefined && ('extra:' + a.dataset.value) || a.dataset.tab && ('tab:' + a.dataset.tab) || a.id || a.className) : ''; })()`);
    const shot = async (name, selector) => {
      await wait(500);
      const rect = selector ? await js(`(() => {
        const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { x: Math.max(0, Math.floor(b.left) - 12), y: Math.max(0, Math.floor(b.top) - 12), width: Math.ceil(b.width) + 24, height: Math.min(Math.ceil(b.height) + 24, innerHeight) };
      })()`) : undefined;
      const img = await wc.capturePage(rect).catch(() => null);
      if (img) fs.writeFileSync(path.join(dir, name + '.png'), img.toPNG());
      return path.join(dir, name + '.png');
    };

    await until(() => js(`document.querySelectorAll('#wallpaper-settings .wp-tile[data-id]').length`));
    await until(() => js(`document.querySelector('#wallpaper-settings .wp-tile.is-chosen')?.dataset.id`));
    wc.focus();

    // Tab, the real key, from the last category tab lands on the chosen photo.
    await js(`(() => { const t = [...document.querySelectorAll('#wallpaper-settings .wp-tab')]; t[0].focus(); })()`);
    await key('Tab');
    const landed = await active();
    check('Tab from the category tabs lands on the chosen photo', landed === all[3].id, landed);

    // Up from the first row of photos crosses the heading to None / Random.
    await js(`document.querySelector('#wallpaper-settings .wp-tile[data-id]').focus()`);
    await key('Up');
    const up = await active();
    check('Up from the first photo row reaches None and Random', /^extra:/.test(up), up);
    await key('Down');
    const down = await active();
    check('Down from there comes back to the photos', all.some((w) => w.id === down), down);

    // Space picks, as on any button.
    await key('Right');
    const spaceTarget = await active();
    await key('Space', ' ');
    const spaced = await until(() => newTab().backgroundValue === spaceTarget);
    check('Space picks the photo in focus', !!spaced, newTab().backgroundValue + ' vs ' + spaceTarget);
    check('and focus stays on it after the save', (await active()) === spaceTarget, await active());

    // F favourites the photo in focus, and Favourites appears.
    await key('F', 'f');
    const liked = await until(() => (newTab().wallpaperFavourites || []).includes(spaceTarget));
    check('F keeps the photo in focus as a favourite', !!liked, JSON.stringify(newTab().wallpaperFavourites));
    const favTab = await until(() => js(`!!document.querySelector('#wallpaper-settings .wp-tab[data-tab=favourites]')`));
    check('a Favourites tab appears in the picker', !!favTab);
    check('focus survives the favourite', (await active()) === spaceTarget, await active());

    // Arrow keys on the category tabs.
    await js(`document.querySelector('#wallpaper-settings .wp-tab[aria-selected=true]').focus()`);
    await key('Right');
    await key('Right');
    const tabNow = await js(`document.querySelector('#wallpaper-settings .wp-tab[aria-selected=true]').dataset.tab`);
    check('Right arrow walks the category tabs', tabNow !== 'all' && (await active()) === 'tab:' + tabNow, tabNow);
    await key('Home');
    check('Home goes back to All', (await js(`document.querySelector('#wallpaper-settings .wp-tab[aria-selected=true]').dataset.tab`)) === 'all');

    // The modes from the keyboard.
    await js(`document.querySelector('.ws-mode[aria-checked=true]').focus()`);
    await key('Down');
    await until(() => newTab().wallpaperMode === 'newtab');
    check('Down on the modes chooses "a different one on every new tab"', newTab().wallpaperMode === 'newtab', newTab().wallpaperMode);
    const favChip = await until(() => js(`!!document.querySelector('.ws-chip[data-pool=favourites]')`));
    check('"Pick from" offers Favourites once there is one', !!favChip);

    // Animations off on the same page: the preview stops changing.
    await until(() => js(`document.querySelector('.ws-wall').dataset.showing`));
    browser.settings.update({ animations: false });
    browser.push();
    await until(() => js(`getComputedStyle(document.documentElement).getPropertyValue('--motion-base').trim() === '0ms'`));
    const seen = new Set();
    for (let i = 0; i < 8; i++) { seen.add(await js(`document.querySelector('.ws-wall').dataset.showing`)); await wait(1000); }
    check('with animations off, the preview holds still', seen.size === 1, [...seen].join(', '));
    browser.settings.update({ animations: true });
    browser.push();
    await until(() => js(`getComputedStyle(document.documentElement).getPropertyValue('--motion-base').trim() !== '0ms'`));
    const again = new Set();
    for (let i = 0; i < 8; i++) { again.add(await js(`document.querySelector('.ws-wall').dataset.showing`)); await wait(1000); }
    check('and takes turns again when they are back on', again.size > 1, [...again].join(', '));

    // The new tab's Customise panel and Settings agree.
    const ntId = browser.tabs.create({ url: 'browser://newtab' });
    opened.push(ntId);
    const nt = browser.tabs.tabs.get(ntId).view.webContents;
    await until(() => !nt.isLoading() && nt.executeJavaScript(`!!window.wallpaperPicker && !!document.body`));
    const ntErrors = [];
    nt.on('console-message', (e) => { if (e?.level === 'error' || e?.level === 3) ntErrors.push(String(e.message).slice(0, 160)); });
    const studio = await until(() => nt.executeJavaScript(`(() => {
      const bar = document.getElementById('customise-bar');
      if (bar.hidden) document.getElementById('customise-open').click();
      const labels = [...document.querySelectorAll('.studio-seg-item')].map((n) => n.textContent.trim());
      return labels.includes('Every tab') && labels;
    })()`), 60);
    check('the Customise panel still offers This one / Every tab / Every launch', !!studio, JSON.stringify(studio));
    if (studio) {
      await nt.executeJavaScript(`[...document.querySelectorAll('.studio-seg-item')].find((n) => n.textContent.trim() === 'Every launch').click()`);
      await until(() => newTab().wallpaperMode === 'launch');
      browser.tabs.select(id);
      const agrees = await until(() => js(`document.querySelector('.ws-mode[data-mode=launch]').getAttribute('aria-checked') === 'true'`));
      check('choosing in Customise shows in Settings straight away', !!agrees);
    }
    check('no errors on the new tab', !ntErrors.length, ntErrors.join(' | '));

    // Random draws: eight tabs, never the same twice running, all pool.
    browser.settings.update({ newTab: { wallpaperMode: 'newtab', wallpaperPool: 'all' } });
    const draws = [];
    for (let i = 0; i < 8; i++) {
      const tabId = browser.tabs.create({ url: 'browser://newtab' });
      opened.push(tabId);
      const page = browser.tabs.tabs.get(tabId).view.webContents;
      draws.push(await until(() => page.isLoading() ? null : page.executeJavaScript(`window.currentWallpaperId || ''`), 100));
    }
    check('eight new tabs, eight wallpapers', new Set(draws).size === 8 && draws.every(Boolean), draws.join(', '));
    for (const tabId of opened.splice(1)) { try { browser.tabs.close(tabId); } catch { /* gone */ } }
    browser.tabs.select(id);

    // The forge picker, in All, scrolled: headings pinned, nothing overlapping.
    await js(`document.querySelector('#forge').scrollIntoView({ block: 'start' })`);
    await js(`document.querySelector('#forge-wallpaper-picker .wp-scroll').scrollTop = 300`);
    const overlap = await js(`(() => {
      const tiles = [...document.querySelectorAll('#forge-wallpaper-picker .wp-tile')].map((t) => t.getBoundingClientRect());
      let bad = 0;
      for (let i = 0; i < tiles.length; i++) for (let j = i + 1; j < tiles.length; j++) {
        const a = tiles[i], b = tiles[j];
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) bad++;
      }
      return bad;
    })()`);
    check('no forge tiles overlap', overlap === 0, overlap);
    await js(`document.querySelector('#forge-wallpaper-picker .wp-tile[data-id]').focus()`);
    await key('Return', String.fromCharCode(13));
    const forgeValue = await until(() => js(`document.getElementById('forge-wallpaper').value`));
    check('Enter picks in the forge too', all.some((w) => w.id === forgeValue), forgeValue);
    await js(`document.querySelector('#forge-wallpaper-picker .wp-scroll').scrollTop = 300`);
    console.log('screenshot: ' + await shot('wallpaper-forge-scrolled', '#forge'));
    await js(`document.querySelector('.settings-main').scrollTop = document.querySelector('.wallpaper-card').offsetTop - 60`);
    console.log('screenshot: ' + await shot('wallpaper-settings-narrow', '.wallpaper-card'));

    check('no errors on the Settings page', !errors.length, errors.join(' | '));
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }
  try {
    browser.settings.update({ customPlanets: [], theme: 'neptune', animations: true, newTab: { background: 'plain', backgroundValue: '', wallpaperMode: 'fixed', wallpaperPool: 'all', wallpaperFavourites: [] } });
  } catch { /* best effort */ }
  console.log(fails ? '\nFAILURES: ' + fails : '\nall wallpaper keyboard checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
