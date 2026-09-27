const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const path = require('node:path');

/**
 * The new tab page's Customise studio, built-in wallpapers, and widgets that
 * go wherever they are dragged. Off-screen.
 */
async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d ? ' :: ' + String(d).slice(0, 220) : ''));
    if (!ok) fails++;
  };
  const shots = path.join(app.getAppPath(), 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const until = async (fn, tries = 40) => { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await wait(150); } return null; };

  try {
    browser.window.show();
    await wait(1000);
    browser.onboarding?.complete?.();
    browser.settings.update({ newTab: { background: 'plain', backgroundValue: '', wallpaperMode: 'fixed', wallpaperPool: 'all',
      wallpaperFavourites: [], positions: {}, widgets: ['clock', 'privacy', 'shortcuts', 'notes'] } });
    const tab = browser.tabs.active;
    const wc = tab.view.webContents;
    const loaded = new Promise((resolve) => { wc.once('did-finish-load', resolve); setTimeout(resolve, 8000); });
    browser.tabs.navigate(tab.id, 'browser://newtab');
    await loaded;
    await until(() => wc.executeJavaScript(`document.querySelectorAll('#widgets [data-widget]').length === 4`));
    await wait(500);

    // Default placement: clock top right, the others down the sides.
    const spots = await wc.executeJavaScript(`[...document.querySelectorAll('#widgets [data-widget]')].map(n => {
      const b = n.getBoundingClientRect(); return { id: n.dataset.widget, left: Math.round(b.left), top: Math.round(b.top), right: Math.round(innerWidth - b.right), w: Math.round(b.width) }; })`);
    const clock = spots.find((s) => s.id === 'clock');
    check('the clock starts top right', clock && clock.right <= 30 && clock.top <= 40, JSON.stringify(clock));
    check('other widgets start down the sides, not over the search box',
      spots.filter((s) => s.id !== 'clock').every((s) => s.left <= 30 || s.right <= 30), JSON.stringify(spots));

    // Drag the notes widget to the bottom middle by its grip.
    const moved = await wc.executeJavaScript(`(async () => {
      const card = document.querySelector('[data-widget="notes"]');
      const grip = card.querySelector('.widget-grip');
      const g = grip.getBoundingClientRect();
      const start = { x: g.left + 5, y: g.top + 5 };
      const opts = (x, y) => ({ bubbles: true, cancelable: true, pointerId: 7, button: 0, buttons: 1, clientX: x, clientY: y, isPrimary: true });
      grip.dispatchEvent(new PointerEvent('pointerdown', opts(start.x, start.y)));
      // Aim so the CARD's centre (not the grip in its corner) crosses the middle.
      const c = card.getBoundingClientRect();
      const target = { x: innerWidth / 2 + (start.x - (c.left + c.width / 2)) + 6, y: innerHeight - 120 };
      for (let i = 1; i <= 10; i++) {
        card.dispatchEvent(new PointerEvent('pointermove', opts(start.x + (target.x - start.x) * i / 10, start.y + (target.y - start.y) * i / 10)));
        await new Promise(r => setTimeout(r, 16));
      }
      card.dispatchEvent(new PointerEvent('pointerup', opts(target.x, target.y)));
      await new Promise(r => setTimeout(r, 400));
      return { left: card.offsetLeft, top: card.offsetTop, centre: Math.round(card.offsetLeft + card.offsetWidth / 2), mid: Math.round(innerWidth / 2) };
    })()`);
    await wait(700);
    const saved = browser.settings.value.newTab.positions.notes;
    check('a widget can be dragged anywhere, even the bottom middle', !!saved && saved.y > 0.6, JSON.stringify({ moved, saved }));
    // Saving re-renders the cards, so read where it was saved, not the old node.
    check('and it snaps to the centre line on the way', !!saved && Math.abs(saved.x - 0.5) < 0.005, JSON.stringify(saved));

    // It stays there after a reload.
    const again = new Promise((resolve) => { wc.once('did-finish-load', resolve); setTimeout(resolve, 8000); });
    wc.reload();
    await again;
    await until(() => wc.executeJavaScript(`!!document.querySelector('[data-widget="notes"]')`));
    await wait(600);
    const after = await wc.executeJavaScript(`(() => {
      const card = document.querySelector('[data-widget="notes"]');
      return window.widgetRenderers.__float.toFraction(card, card.offsetLeft, card.offsetTop); })()`);
    check('and is still there after a reload', Math.abs(after.x - saved.x) < 0.01 && Math.abs(after.y - saved.y) < 0.01, JSON.stringify({ saved, after }));

    // The studio.
    await wc.executeJavaScript(`document.getElementById('customise-open').click()`);
    const studio = await until(() => wc.executeJavaScript(`(() => {
      const s = document.querySelector('.studio');
      if (!s || !s.querySelector('.studio-thumb[data-id]')) return null;
      return { tabs: s.querySelectorAll('.studio-tab').length, pills: [...s.querySelectorAll('.studio-pill span')].map(n => n.textContent),
        thumbs: s.querySelectorAll('.studio-thumb[data-id]').length, specials: s.querySelectorAll('.studio-thumb[data-special]').length };
    })()`));
    check('Customise opens a studio with Wallpaper, Widgets and Layouts', studio?.tabs === 3, JSON.stringify(studio));
    check('with every category from the folder as a pill', ['Landscapes', 'Cityscapes', 'Colours', 'Patterns', 'Space'].every((c) => studio?.pills.includes(c)), JSON.stringify(studio?.pills));
    check('and every wallpaper in the gallery', studio?.thumbs === 48, studio?.thumbs);
    await wait(900);
    const shot1 = await wc.capturePage().catch(() => null);
    if (shot1) fs.writeFileSync(path.join(shots, 'studio-wallpapers.png'), shot1.toPNG());

    // Pick one.
    const picked = await wc.executeJavaScript(`(() => { const t = document.querySelectorAll('.studio-thumb[data-id]')[3]; t.click(); return t.dataset.id; })()`);
    await until(() => browser.settings.value.newTab.backgroundValue === picked);
    const layer = await until(() => wc.executeJavaScript(`(() => {
      const a = document.getElementById('ambient');
      const bg = a.style.backgroundImage;
      return bg.includes('wallpapers/') ? { bg: bg.slice(-70), credit: document.getElementById('wallpaper-credit').textContent,
        chosen: document.querySelector('.studio-thumb.is-chosen')?.dataset.id } : null; })()`));
    check('clicking a wallpaper sets it behind the page', !!layer, JSON.stringify(layer));
    check('credits the photographer', /Photo: .+ · (Unsplash|Pexels|Pixabay)/.test(layer?.credit || ''), layer?.credit);
    check('and marks it chosen in the gallery', layer?.chosen === picked);

    // Favourite, filter, random.
    await wc.executeJavaScript(`document.querySelectorAll('.studio-thumb[data-id] .studio-heart')[5].click()`);
    await until(() => browser.settings.value.newTab.wallpaperFavourites.length === 1);
    check('the heart saves a favourite', browser.settings.value.newTab.wallpaperFavourites.length === 1);
    await wc.executeJavaScript(`document.querySelector('.studio-pill[data-id="space"]').click()`);
    await wait(300);
    const spaceCount = await wc.executeJavaScript(`document.querySelectorAll('.studio-thumb[data-id]').length`);
    check('a category pill filters the gallery', spaceCount === 10, spaceCount);
    await wc.executeJavaScript(`document.querySelector('.studio-seg-item[data-id="newtab"]').click()`);
    await until(() => browser.settings.value.newTab.wallpaperMode === 'newtab');
    await wc.executeJavaScript(`document.querySelector('.studio-pill[data-id="space"]').click()`);
    await until(() => browser.settings.value.newTab.wallpaperPool === 'space');
    check('"Every tab" draws from the category you are on', browser.settings.value.newTab.wallpaperPool === 'space');
    const draws = new Set();
    for (let i = 0; i < 4; i++) {
      const next = new Promise((resolve) => { wc.once('did-finish-load', resolve); setTimeout(resolve, 8000); });
      wc.reload();
      await next;
      const id = await until(() => wc.executeJavaScript(`window.currentWallpaperId || ''`));
      draws.add(id);
    }
    const all = require('../src/shared/wallpapers.json').wallpapers;
    check('each new tab gets a different space wallpaper', draws.size >= 2 && [...draws].every((id) => all.find((w) => w.id === id)?.category === 'space'), [...draws].join(', '));
    await wait(1200);
    const shot2 = await wc.capturePage().catch(() => null);
    if (shot2) fs.writeFileSync(path.join(shots, 'newtab-wallpaper.png'), shot2.toPNG());
    browser.settings.update({ newTab: { wallpaperMode: 'fixed', background: 'plain' } });
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  }
  console.log(fails ? '\nFAILURES: ' + fails : '\nall studio checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
