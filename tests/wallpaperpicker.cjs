const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const path = require('node:path');

/**
 * Wallpapers are picked by looking at them: Settings -> Appearance ->
 * Wallpaper, and the forge's "Wallpaper it brings". Worked the way a person
 * works them - real clicks on thumbnails, the arrow keys and Enter - and then
 * checked where it matters: in main's settings, and on real new tabs, which
 * must change wallpaper on every tab in random mode and stay put otherwise.
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
  const categoryOf = (id) => all.find((w) => w.id === id)?.category;
  const opened = [];

  try {
    browser.window.setSize(1640, 1020);
    browser.settings.update({
      theme: 'neptune', animations: true, customPlanets: [],
      newTab: { background: 'plain', backgroundValue: '', wallpaperMode: 'fixed', wallpaperPool: 'all', wallpaperFavourites: [] },
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
    // Scroll something to the middle of the settings column, then a real
    // mouse click on it (or at a point inside it).
    const centre = (selector) => js(`(() => {
      const n = document.querySelector(${JSON.stringify(selector)});
      if (!n) return null;
      n.scrollIntoView({ block: 'center' });
      const b = n.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
    })()`);
    const clickAt = async (selector) => {
      const at = await centre(selector);
      if (!at) throw new Error('nothing to click at ' + selector);
      await wait(120);
      wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
      await wait(40);
      wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
      await wait(120);
    };
    // A real key press. Enter activates a button on its character, as in
    // a person's keyboard, so that is sent too.
    const key = async (keyCode) => {
      wc.sendInputEvent({ type: 'keyDown', keyCode });
      if (keyCode === 'Return') wc.sendInputEvent({ type: 'char', keyCode: String.fromCharCode(13) });
      wc.sendInputEvent({ type: 'keyUp', keyCode });
      await wait(120);
    };
    const newTab = () => browser.settings.value.newTab;

    /** Open a real new tab and read which wallpaper it is wearing. */
    const openNewTab = async () => {
      const tabId = browser.tabs.create({ url: 'browser://newtab' });
      opened.push(tabId);
      const page = browser.tabs.tabs.get(tabId).view.webContents;
      const shown = await until(() => page.isLoading() ? null : page.executeJavaScript(`window.currentWallpaperId || ''`), 100);
      return shown || '';
    };
    const closeNewTabs = () => {
      for (const tabId of opened.splice(1)) { try { browser.tabs.close(tabId); } catch { /* gone */ } }
      browser.tabs.select(id);
    };

    // ---- Settings -> Appearance -> Wallpaper ----
    const ready = await until(() => js(`document.querySelectorAll('#wallpaper-settings .wp-tile[data-id]').length`));
    check('Appearance has a Wallpaper section with every wallpaper as a picture', ready === all.length, ready);
    const layout = await js(`(() => {
      const root = document.querySelector('#wallpaper-settings');
      const tiles = [...root.querySelectorAll('.wp-tile')];
      return {
        heading: [...document.querySelectorAll('[data-section=appearance] > h2')].map((h) => h.textContent).join(','),
        first: tiles.slice(0, 2).map((t) => t.querySelector('strong')?.textContent),
        tabs: [...root.querySelectorAll('.wp-tab')].map((t) => t.firstChild.textContent),
        groups: root.querySelectorAll('.wp-group').length,
        modes: [...root.querySelectorAll('.ws-mode strong')].map((n) => n.textContent),
        images: root.querySelectorAll('.wp-tile[data-id] img').length,
      };
    })()`);
    check('it sits under its own heading in Appearance', /Wallpaper/.test(layout.heading), layout.heading);
    check('"None" and "Random on every new tab" are the first two tiles', layout.first[0] === 'None' && layout.first[1] === 'Random on every new tab', layout.first.join(' | '));
    check('photos are grouped by category, with tabs and headings', layout.tabs.length === 6 && layout.tabs[0] === 'All' && layout.groups === 5, layout.tabs.join(',') + ' / ' + layout.groups);
    check('the three ways it can change are offered in plain words', layout.modes.join('|') === 'This wallpaper|A different one on every new tab|A new one each time Static starts', layout.modes.join('|'));
    const loaded = await until(() => js(`document.querySelectorAll('#wallpaper-settings .wp-tile.is-loaded').length >= 6 && document.querySelectorAll('#wallpaper-settings .wp-tile.is-loaded').length`));
    check('the thumbnails load', loaded >= 6, loaded);
    check('with no wallpaper yet, "None" is ringed', await js(`document.querySelector('#wallpaper-settings .wp-extra.is-none').classList.contains('is-chosen')`));

    // Hover shows who took it.
    const target = '#wallpaper-settings .wp-tile[data-id]:nth-of-type(6)';
    const hoverAt = await centre(target);
    wc.sendInputEvent({ type: 'mouseMove', x: hoverAt.x, y: hoverAt.y });
    await wait(500);
    // An off-screen window paints but its transitions are not guaranteed to
    // tick, so the fade is run to its end before reading where it lands.
    const hover = await js(`(() => { const t = document.querySelector(${JSON.stringify(target)}); const by = t.querySelector('.wp-by');
      for (const a of by.getAnimations()) a.finish();
      return { id: t.dataset.id, name: by.textContent, opacity: getComputedStyle(by).opacity, hovered: t.matches(':hover') }; })()`);
    const hoveredEntry = all.find((w) => w.id === hover.id);
    check('hovering a photo shows the photographer, small', hover.hovered && Number(hover.opacity) > 0.9 && hover.name === hoveredEntry?.credit.by, JSON.stringify(hover));

    // A real click on a thumbnail.
    await clickAt(target);
    await until(() => newTab().backgroundValue === hover.id);
    check('clicking a thumbnail makes it the new tab wallpaper', newTab().background === 'wallpaper' && newTab().backgroundValue === hover.id && newTab().wallpaperMode === 'fixed', JSON.stringify({ b: newTab().background, v: newTab().backgroundValue, m: newTab().wallpaperMode }));
    const ringed = await until(() => js(`document.querySelector('#wallpaper-settings .wp-tile.is-chosen')?.dataset.id`));
    check('and it is ringed in the picker', ringed === hover.id, ringed);
    const preview = await until(() => js(`(() => { const c = document.querySelector('.ws-credit').textContent; return /Photo: /.test(c) && c; })()`));
    check('the preview wears it and credits the photographer', (preview || '').includes(hoveredEntry.credit.by), preview);
    check('"This wallpaper" is the mode now', await js(`document.querySelector('.ws-mode[data-mode=fixed]').getAttribute('aria-checked') === 'true'`));
    await js(`document.querySelector('.settings-main').scrollTop = document.querySelector('.wallpaper-card').offsetTop - 60`);
    await wait(300);
    const settingsShot = await shot('wallpaper-settings', '.wallpaper-card');

    // Keyboard: the arrow keys move, Enter picks.
    await js(`document.querySelector('#wallpaper-settings .wp-tile.is-chosen').focus()`);
    const focusOk = await js(`document.activeElement?.classList.contains('wp-tile')`);
    await key('Right');
    const moved = await js(`document.activeElement?.dataset.id || ''`);
    await key('Return');
    const keyed = await until(() => newTab().backgroundValue === moved && moved);
    check('arrow keys move through the photos and Enter picks one', focusOk && !!keyed && moved !== hover.id, moved);
    await key('Down');
    const below = await js(`(() => { const a = document.activeElement.getBoundingClientRect(); return a.top; })()`);
    const above = await js(`document.querySelector('#wallpaper-settings .wp-tile.is-chosen').getBoundingClientRect().top`);
    check('down goes to the row below', below > above, below + ' > ' + above);

    // Fixed: every new tab wears the same one.
    closeNewTabs();
    const fixed = [];
    for (let i = 0; i < 3; i++) fixed.push(await openNewTab());
    closeNewTabs();
    check('in fixed mode, new tabs all wear the chosen wallpaper', fixed.every((w) => w === newTab().backgroundValue), fixed.join(', '));

    // Random on every new tab, from one category.
    await clickAt('#wallpaper-settings .wp-extra.is-random');
    await until(() => newTab().wallpaperMode === 'newtab');
    check('the Random tile turns on "a different one on every new tab"', newTab().wallpaperMode === 'newtab' && newTab().background === 'wallpaper', newTab().wallpaperMode);
    const poolOpen = await until(() => js(`document.querySelector('.ws-pool').classList.contains('is-open') && document.querySelector('.ws-mode[data-mode=newtab]').getAttribute('aria-checked') === 'true'`));
    check('and "Pick from" opens, with the mode lit', !!poolOpen);
    await wait(400);
    await clickAt('.ws-chip[data-pool="space"]');
    await until(() => newTab().wallpaperPool === 'space');
    check('a category chip limits what it picks from', newTab().wallpaperPool === 'space', newTab().wallpaperPool);
    const slides = await until(() => js(`document.querySelector('.ws-wall').dataset.showing || ''`));
    check('the preview shows wallpapers from that category', categoryOf(slides) === 'space', slides);
    await js(`document.querySelector('.settings-main').scrollTop = document.querySelector('.wallpaper-card').offsetTop - 60`);
    const randomShot = await shot('wallpaper-settings-random', '.wallpaper-card');

    const draws = [];
    for (let i = 0; i < 5; i++) draws.push(await openNewTab());
    closeNewTabs();
    const changesEveryTab = draws.every((w, i) => w && (i === 0 || w !== draws[i - 1]));
    check('every new tab gets a different wallpaper: five tabs, five photos', changesEveryTab && new Set(draws).size === draws.length, draws.join(', '));
    check('all from Space', draws.every((w) => categoryOf(w) === 'space'), draws.map(categoryOf).join(','));

    // "This wallpaper" keeps the one in the preview.
    await clickAt('.ws-mode[data-mode=fixed]');
    await until(() => newTab().wallpaperMode === 'fixed');
    check('"This wallpaper" keeps one', newTab().wallpaperMode === 'fixed' && newTab().background === 'wallpaper' && !!categoryOf(newTab().backgroundValue), newTab().backgroundValue);
    const kept = [];
    for (let i = 0; i < 3; i++) kept.push(await openNewTab());
    closeNewTabs();
    check('and new tabs stay put', kept.every((w) => w === newTab().backgroundValue), kept.join(', '));
    await clickAt('.ws-mode[data-mode=launch]');
    await until(() => newTab().wallpaperMode === 'launch');
    check('"A new one each time Static starts" can be chosen', newTab().wallpaperMode === 'launch');

    // Easy to find: searching Settings for it lands on it.
    const found = await js(`(() => {
      const search = document.getElementById('settings-search');
      search.value = 'random wallpaper';
      search.dispatchEvent(new Event('input'));
      const field = document.querySelector('.wallpaper-field');
      const shown = !field.hidden && !field.closest('[data-section]').hidden && field.getBoundingClientRect().height > 100;
      search.value = '';
      search.dispatchEvent(new Event('input'));
      return shown;
    })()`);
    check('searching Settings for "random wallpaper" finds it', found);

    // ---- the forge: "Wallpaper it brings" ----
    await js(`document.querySelector('[data-category=appearance]').click()`);
    const forgeTiles = await until(() => js(`document.querySelectorAll('#forge-wallpaper-picker .wp-tile').length`));
    check('the forge shows wallpapers as pictures, not a list of names', forgeTiles === all.length + 2 && await js(`!document.querySelector('select#forge-wallpaper')`), forgeTiles);
    check('with None ringed to begin with', await js(`document.querySelector('#forge-wallpaper-picker .wp-extra.is-none').classList.contains('is-chosen')`));
    await js(`(() => { const n = document.getElementById('forge-name'); n.value = 'Kepler'; n.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    // The Space tab, then a real click on its third photo.
    await clickAt('#forge-wallpaper-picker .wp-tab[data-tab="space"]');
    await until(() => js(`document.querySelector('#forge-wallpaper-picker .wp-tab[data-tab="space"]').getAttribute('aria-selected') === 'true'`));
    const spaceTiles = await js(`document.querySelectorAll('#forge-wallpaper-picker .wp-tile[data-id]').length`);
    check('category tabs show one category', spaceTiles === all.filter((w) => w.category === 'space').length, spaceTiles);
    const forgePick = await js(`document.querySelectorAll('#forge-wallpaper-picker .wp-tile[data-id]')[2].dataset.id`);
    await clickAt('#forge-wallpaper-picker .wp-tile[data-id="' + forgePick + '"]');
    const formValue = await until(() => js(`document.getElementById('forge-wallpaper').value`));
    check('clicking a photo sets the forge\'s wallpaper', formValue === forgePick, formValue);
    const named = await js(`document.getElementById('forge-wallpaper-name').textContent`);
    check('and says whose photo it is', named.includes(all.find((w) => w.id === forgePick).credit.by), named);
    const mock = await until(() => js(`document.querySelector('.forge-mock-wall .wp-slide.is-on') ? document.querySelector('.forge-mock-wall').dataset.showing : ''`));
    check('the preview browser wears it', mock === forgePick, mock);
    await js(`document.getElementById('forge-preview').scrollIntoView({ block: 'start' }); document.querySelector('.settings-main').scrollTop -= 20`);
    const forgeShot = await shot('wallpaper-forge', '#forge');

    await clickAt('#forge-apply');
    const kepler = await until(() => browser.settings.value.customPlanets.find((p) => p.name === 'Kepler'));
    check('a forged planet saves the wallpaper it brings', kepler?.wallpaper === forgePick, JSON.stringify(kepler));
    await until(() => browser.settings.value.theme === kepler?.id && newTab().backgroundValue === forgePick);
    check('wearing it brings that wallpaper, fixed', newTab().background === 'wallpaper' && newTab().backgroundValue === forgePick && newTab().wallpaperMode === 'fixed', JSON.stringify({ v: newTab().backgroundValue, m: newTab().wallpaperMode }));
    const keplerTabs = [];
    for (let i = 0; i < 3; i++) keplerTabs.push(await openNewTab());
    closeNewTabs();
    check('so every new tab wears it', keplerTabs.every((w) => w === forgePick), keplerTabs.join(', '));

    // A planet that brings a random one.
    await until(() => js(`document.getElementById('forge-wallpaper').value === ''`));
    await js(`(() => { const n = document.getElementById('forge-name'); n.value = 'Vesper'; n.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await clickAt('#forge-wallpaper-picker .wp-extra.is-random');
    const randomValue = await until(() => js(`document.getElementById('forge-wallpaper').value`));
    check('the forge\'s Random tile chooses "random"', randomValue === 'random', randomValue);
    const cycling = await until(() => js(`document.querySelector('.forge-mock-wall').dataset.showing || ''`));
    check('and the preview shows wallpapers taking turns', !!cycling, cycling);
    await clickAt('#forge-apply');
    const vesper = await until(() => browser.settings.value.customPlanets.find((p) => p.name === 'Vesper'));
    check('a planet can bring a random wallpaper', vesper?.wallpaper === 'random', JSON.stringify(vesper));
    await until(() => browser.settings.value.theme === vesper?.id && newTab().wallpaperMode === 'newtab');
    check('wearing it switches the new tab to a different wallpaper every tab', newTab().wallpaperMode === 'newtab' && newTab().background === 'wallpaper', newTab().wallpaperMode);
    browser.settings.update({ newTab: { wallpaperPool: 'all' } });
    const vesperTabs = [];
    for (let i = 0; i < 5; i++) vesperTabs.push(await openNewTab());
    closeNewTabs();
    check('and each new tab really is different', vesperTabs.every((w, i) => w && (i === 0 || w !== vesperTabs[i - 1])) && new Set(vesperTabs).size === vesperTabs.length, vesperTabs.join(', '));

    // Your planets: what each brings, wearing and editing.
    const made = await until(() => js(`(() => { const rows = [...document.querySelectorAll('.forge-made-item')]; return rows.length === 2 && rows.map((r) => !!r.querySelector('.forge-made-wall')).join(','); })()`));
    check('"Your planets" shows what each one brings', made === 'true,true', made);
    await js(`[...document.querySelectorAll('.forge-made-item')].find((r) => r.textContent.includes('Kepler')).querySelector('button').id = 'probe-wear'`);
    await clickAt('#probe-wear');
    await until(() => browser.settings.value.theme === kepler.id && newTab().wallpaperMode === 'fixed');
    check('wearing Kepler again goes back to its wallpaper', newTab().wallpaperMode === 'fixed' && newTab().backgroundValue === forgePick, newTab().backgroundValue);
    await js(`[...document.querySelectorAll('.forge-made-item')].find((r) => r.textContent.includes('Vesper')).querySelectorAll('button')[1].click()`);
    const editing = await until(() => js(`document.getElementById('forge-name').value === 'Vesper' && document.querySelector('#forge-wallpaper-picker .wp-tile.is-chosen')?.classList.contains('is-random')`));
    check('editing a planet shows the Random tile ringed', !!editing);

    // On a light planet, with no wallpaper: the preview falls back to the
    // planet's own sky and the picker still reads.
    browser.settings.update({ theme: 'venus', newTab: { background: 'plain', backgroundValue: '', wallpaperMode: 'fixed' } });
    browser.push();
    await until(() => js(`document.querySelector('.ws-stage').dataset.mode === 'plain' && document.querySelector('#wallpaper-settings .wp-extra.is-none.is-chosen')`));
    await js(`document.querySelector('.settings-main').scrollTop = document.querySelector('.wallpaper-card').offsetTop - 60`);
    const lightShot = await shot('wallpaper-settings-light', '.wallpaper-card');
    check('choosing None in a light theme shows the planet\'s own sky', await js(`/own sky/.test(document.querySelector('.ws-credit').textContent)`));

    check('no errors on the Settings page', !errors.length, errors.join(' | '));
    console.log('screenshots: ' + [settingsShot, randomShot, forgeShot, lightShot].join(', '));
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }
  try {
    browser.settings.update({ customPlanets: [], theme: 'neptune', newTab: { background: 'plain', backgroundValue: '', wallpaperMode: 'fixed', wallpaperPool: 'all' } });
  } catch { /* best effort */ }
  console.log(fails ? '\nFAILURES: ' + fails : '\nall wallpaper picker checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
