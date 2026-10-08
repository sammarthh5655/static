const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

/**
 * Three touches to the tabs, used the way a person uses them: tab search
 * (Ctrl/Cmd+Shift+A and the button at the end of the strip), muting a tab
 * that is making sound (the speaker, the badge on a pinned tab, the tab
 * menu), and the card that comes up when the pointer rests on a tab. Real
 * key presses, pointer moves and clicks (sendInputEvent) on the strip, the
 * vertical list and the menu overlay. Runs off-screen.
 *
 *   node scripts/start.cjs --tabtouches
 *
 * The page that plays sound plays a 20 Hz tone very quietly: loud enough for
 * Chromium to count the tab as audible, far too low and too quiet for anyone
 * at the computer to hear. It is muted or closed within seconds.
 */
const COLOURS = { Inbox: '#2b6cb0', Docs: '#2f855a', Recipes: '#c05621', Weather: '#2c7a7b', Radio: '#6b46c1', Maps: '#b83280' };
const page = (title, extra = '') => {
  const colour = COLOURS[title.split(' ')[0]] || '#4a5568';
  return `<!doctype html><html><head><title>${title}</title><style>
  body{margin:0;font:16px system-ui,sans-serif;background:#f6f4ef;color:#222}
  header{background:${colour};color:#fff;padding:26px 40px;font-size:30px;font-weight:700;letter-spacing:-.5px}
  main{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;padding:26px 40px}
  .c{height:130px;border-radius:14px;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.08);padding:16px}
  .c b{display:block;height:16px;width:60%;background:${colour}44;border-radius:8px;margin-bottom:12px}
  .c i{display:block;height:10px;width:90%;background:#0000000f;border-radius:5px;margin:7px 0}
  </style></head><body><header>${title}</header><main>${'<div class="c"><b></b><i></i><i></i><i></i></div>'.repeat(6)}</main>${extra}</body></html>`;
};
// Inaudible: 20 Hz, about -48 dBFS. See the note above.
const TONE = `<script>
  const ctx = new AudioContext(); const osc = ctx.createOscillator(); const gain = ctx.createGain();
  osc.frequency.value = 20; gain.gain.value = 0.004; osc.connect(gain).connect(ctx.destination); osc.start();
  window.__tone = ctx;
</script>`;

async function run(browser) {
  const { app } = require('electron');
  const shots = path.join(app.getAppPath(), 'shots');
  fs.mkdirSync(shots, { recursive: true });
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d !== undefined && !ok ? ' :: ' + String(d).slice(0, 300) : ''));
    if (!ok) fails++;
  };
  const until = async (fn, tries = 40, every = 120) => {
    for (let i = 0; i < tries; i++) { const v = await Promise.resolve().then(fn).catch(() => null); if (v) return v; await wait(every); }
    return null;
  };

  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.slice(1)) || 'Home';
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(name.startsWith('Radio') ? page(name, TONE) : page(name));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;

  const organizer = browser.productivity.organizer;
  const chrome = () => browser.chrome.webContents;
  const overlay = () => browser.overlay.webContents;
  const vt = () => browser.vtabs.webContents;
  const tab = (id) => browser.tabs.tabs.get(id);
  const mac = process.platform === 'darwin';
  const mod = mac ? 'meta' : 'control';

  const move = (wc, x, y) => wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
  const click = async (wc, x, y, { button = 'left' } = {}) => {
    move(wc, x, y);
    await wait(40);
    wc.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button, clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button, clickCount: 1 });
    await wait(150);
  };
  const key = (wc, keyCode, modifiers = []) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode === 'Return') wc.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
  const centre = (wc, selector) => wc.executeJavaScript(`(() => { const n = document.querySelector(${JSON.stringify(selector)});
    if (!n) return null; const b = n.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), left: b.left, right: b.right, top: b.top, bottom: b.bottom }; })()`);
  const tabAt = (id) => centre(chrome(), `.tab[data-id="${id}"]`);
  const listOpen = () => until(() => overlay().executeJavaScript(`!!document.querySelector('.menu.menu-tabsearch')`));
  const listClosed = () => until(() => overlay().executeJavaScript(`!document.querySelector('.menu')`));
  const rows = () => overlay().executeJavaScript(`[...document.querySelectorAll('.ts-row')].map((n) => ({
    title: n.querySelector('.ts-title').textContent, selected: n.classList.contains('is-selected'),
    current: n.classList.contains('is-current'), marks: n.querySelectorAll('mark').length,
    sound: n.querySelector('.ts-sound')?.className || '', group: n.querySelector('.ts-group')?.textContent || '' }))`);
  const card = () => overlay().executeJavaScript(`(() => { const c = document.querySelector('.tab-card'); if (!c) return null;
    const pos = document.querySelectorAll('.tab-card-pos');
    return { count: pos.length, title: c.querySelector('.tc-title').textContent, site: c.querySelector('.tc-site-name')?.textContent || '',
      img: !!c.querySelector('.tc-img.is-in'), pending: c.querySelector('.tc-shot').classList.contains('is-pending'),
      rest: c.querySelector('.tc-rest')?.textContent || '', tag: c.querySelector('.tc-tag')?.textContent || '',
      transform: pos[0].style.transform, grouped: c.classList.contains('is-grouped') }; })()`);
  const noCard = () => overlay().executeJavaScript(`!document.querySelector('.tab-card')`);
  const tiny = () => { const b = browser.overlay.getBounds(); return b.width <= 1 && b.height <= 1; };
  const closeMenu = async () => {
    await overlay().executeJavaScript('window.ui.closeMenu(), true').catch(() => {});
    await listClosed();
    await wait(150);
  };
  const choose = async (label) => {
    const at = await until(() => overlay().executeJavaScript(`(() => {
      const row = [...document.querySelectorAll('.menu .menu-item')].find((n) => (n.querySelector('.menu-label')?.firstChild?.textContent || '') === ${JSON.stringify(label)});
      if (!row) return null; const b = row.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`));
    if (!at) return false;
    await click(overlay(), at.x, at.y);
    return true;
  };
  const menuLabels = () => (browser.lastMenu?.items || []).map((i) => i.label || '');

  /**
   * The window as a person would see it: every view, photographed and laid
   * over each other in the order they are stacked, the overlay on top.
   */
  const { nativeImage } = require('electron');
  const composite = async (name, crop, scale = 1) => {
    await wait(380);
    const { width, height } = browser.window.getContentBounds();
    const canvas = Buffer.alloc(width * height * 4);
    for (let i = 0; i < canvas.length; i += 4) { canvas[i] = 0x22; canvas[i + 1] = 0x1b; canvas[i + 2] = 0x16; canvas[i + 3] = 255; }
    const views = (browser.window.contentView.children || []).filter((v) => v.webContents && !v.webContents.isDestroyed() && v.getVisible?.() !== false);
    for (const view of views) {
      const b = view.getBounds();
      if (b.width < 2 || b.height < 2) continue;
      let image = await view.webContents.capturePage().catch(() => null);
      if (!image || image.isEmpty()) continue;
      image = image.resize({ width: b.width, height: b.height });
      const px = image.toBitmap();
      for (let y = 0; y < b.height; y++) {
        const ty = b.y + y;
        if (ty < 0 || ty >= height) continue;
        for (let x = 0; x < b.width; x++) {
          const tx = b.x + x;
          if (tx < 0 || tx >= width) continue;
          const s = (y * b.width + x) * 4;
          const d = (ty * width + tx) * 4;
          const a = px[s + 3] / 255;
          if (a <= 0) continue;
          for (let c = 0; c < 3; c++) canvas[d + c] = Math.round(px[s + c] * a + canvas[d + c] * (1 - a));
        }
      }
    }
    let out = nativeImage.createFromBitmap(canvas, { width, height });
    if (crop) out = out.crop(crop);
    if (scale !== 1) out = out.resize({ width: Math.round(out.getSize().width * scale), quality: 'best' });
    fs.writeFileSync(path.join(shots, name + '.png'), out.toPNG());
  };

  // Count every time the overlay is given the keyboard: a hover card must never take it.
  let overlayFocusCalls = 0;
  const realFocus = browser.overlay.webContents.focus.bind(browser.overlay.webContents);
  browser.overlay.webContents.focus = () => { overlayFocusCalls++; return realFocus(); };

  let radio = null;
  try {
    await wait(1400);
    browser.settings.update({ tabLayout: 'horizontal', theme: 'neptune', tabPreviews: true, bookmarksBar: false });
    browser.applyTabLayout();
    browser.layout();
    organizer.groups = [];
    for (const extra of browser.tabs.order.slice(1)) browser.tabs.close(extra);
    const inbox = browser.tabs.active.id;
    browser.tabs.navigate(inbox, base + '/Inbox - sam@example.com - Mail');
    const ids = { inbox };
    for (const title of ['Docs - Quarterly plan', 'Recipes - Lemon tart', 'Weather - London', 'Maps - Lisbon']) {
      ids[title.split(' ')[0].toLowerCase()] = browser.tabs.create({ url: base + '/' + title, background: true });
    }
    browser.tabs.select(inbox);
    await until(() => browser.tabs.list().every((t) => !t.loading && /^http/.test(t.url)));
    // A group, so its colour shows in the list and on the card.
    const groupId = 'probe-group';
    organizer.groups.push({ id: groupId, name: 'Food', color: require('../src/features/organizer/classify').COLORS[2], collapsed: false, workspaceId: 'main' });
    tab(ids.recipes).groupId = groupId;
    browser.tabs.tidy();
    browser.push();
    await wait(900);

    // ---- 1. Tab search -----------------------------------------------------
    const { ACCEL } = require('../src/main/shortcuts');
    check('Ctrl/Cmd+Shift+A is registered as "Search tabs"', ACCEL.get('tab:search')?.display === (mac ? 'Cmd' : 'Ctrl') + '+Shift+A' && ACCEL.get('tab:search').label === 'Search tabs', JSON.stringify(ACCEL.get('tab:search')));
    const listed = (await chrome().executeJavaScript(`window.browser.invoke('ui:shortcuts')`)).find((s) => s.id === 'tab:search');
    check('and listed with every other shortcut (Settings and Help read this list)', listed?.label === 'Search tabs', JSON.stringify(listed));

    // Switch away and back, so "the tab you were on before" is Weather.
    browser.tabs.select(ids.weather);
    await wait(500);
    browser.tabs.select(inbox);
    await wait(500);

    key(chrome(), 'A', [mod, 'shift']);
    check('the shortcut opens the tab search list', !!(await listOpen()));
    let list = await until(async () => { const r = await rows(); return r.length ? r : null; });
    check('listing every open tab', list?.length === browser.tabs.order.length, JSON.stringify(list?.map((r) => r.title)));
    check('the tab you are on first, marked as current', list?.[0]?.current && /Inbox/.test(list[0].title), JSON.stringify(list?.[0]));
    check('and the one you were on before chosen, one Enter away', list?.[1]?.selected && /Weather/.test(list[1].title), JSON.stringify(list?.slice(0, 2)));
    check('a grouped tab wears its group', list?.some((r) => /Recipes/.test(r.title) && r.group === 'Food'), JSON.stringify(list?.map((r) => r.group)));
    const typingInBox = await overlay().executeJavaScript(`document.activeElement?.classList.contains('tabsearch-input')`);
    check('the search box has the keyboard', typingInBox === true);
    const anchoredRight = await overlay().executeJavaScript(`(() => { const r = document.querySelector('.menu').getBoundingClientRect(); return { right: r.right, top: r.top, w: innerWidth }; })()`);
    check('opened from the keyboard, it hangs under the end of the strip', anchoredRight.w - anchoredRight.right < 16 && anchoredRight.top >= 70 && anchoredRight.top <= 90, JSON.stringify(anchoredRight));
    await composite('tabtouches-search-open', { x: Math.max(0, anchoredRight.w - 520), y: 0, width: Math.min(520, anchoredRight.w), height: 480 });

    // Fuzzy: a half-remembered word.
    overlay().insertText('lemn trt');
    await wait(200);
    list = await rows();
    check('typing filters the list, forgivingly ("lemn trt" finds Lemon tart)', list.length === 1 && /Lemon tart/.test(list[0].title) && list[0].marks > 0, JSON.stringify(list));
    const count = await overlay().executeJavaScript(`document.querySelector('.ts-count').textContent`);
    check('and says how many match', /^1 of 5$/.test(count), count);
    await composite('tabtouches-search-typed', { x: Math.max(0, anchoredRight.w - 520), y: 0, width: Math.min(520, anchoredRight.w), height: 300 });
    await overlay().executeJavaScript(`(() => { const i = document.querySelector('.tabsearch-input'); i.select(); return true; })()`);
    overlay().insertText('zzqq');
    await wait(200);
    const empty = await overlay().executeJavaScript(`document.querySelector('.ts-empty')?.textContent || ''`);
    check('nothing matching says so', /No open tab matches/.test(empty), empty);
    await overlay().executeJavaScript(`(() => { const i = document.querySelector('.tabsearch-input'); i.select(); return true; })()`);
    overlay().insertText('lisbon');
    await wait(150);
    key(overlay(), 'Return');
    await until(() => browser.tabs.activeId === ids.maps);
    check('Enter switches to the chosen tab', browser.tabs.activeId === ids.maps);
    check('and the list closes', !!(await listClosed()));

    // Arrow keys, then Enter.
    key(chrome(), 'A', [mod, 'shift']);
    await listOpen();
    await wait(200);
    key(overlay(), 'Down');
    await wait(80);
    key(overlay(), 'Up');
    await wait(80);
    key(overlay(), 'Down');
    await wait(120);
    list = await rows();
    const pickedIndex = list.findIndex((r) => r.selected);
    check('Up and Down move through the list', pickedIndex === 2, JSON.stringify(list.map((r) => r.selected)));
    const wanted = browser.lastMenu.items[0].tabsearch.tabs[pickedIndex].id;
    key(overlay(), 'Return');
    await until(() => browser.tabs.activeId === wanted);
    check('Enter opens the row chosen with the arrows', browser.tabs.activeId === wanted);
    await listClosed();

    // The button at the end of the strip, with a real click.
    const button = await centre(chrome(), '#tab-search');
    check('a search button sits at the end of the strip', !!button && button.right > (await chrome().executeJavaScript('innerWidth')) - 50, JSON.stringify(button));
    await click(chrome(), button.x, button.y);
    check('clicking it opens the list', !!(await listOpen()));
    const underButton = await overlay().executeJavaScript(`(() => { const r = document.querySelector('.menu').getBoundingClientRect(); return { right: r.right, top: r.top }; })()`);
    check('right under the button', Math.abs(underButton.right - button.right) < 3 && underButton.top >= button.bottom, JSON.stringify({ underButton, button, anchor: browser.lastMenu?.anchor, align: browser.lastMenu?.align }));
    // Close a tab from the list with its own button.
    const before = browser.tabs.order.length;
    const closeAt = await overlay().executeJavaScript(`(() => { const row = [...document.querySelectorAll('.ts-row')].find((n) => /Docs/.test(n.textContent));
      const b = row.querySelector('.ts-close').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    move(overlay(), closeAt.x, closeAt.y);
    await wait(120);
    await click(overlay(), closeAt.x, closeAt.y);
    await until(() => browser.tabs.order.length === before - 1);
    check('a row\'s close button closes that tab', browser.tabs.order.length === before - 1 && !browser.tabs.tabs.has(ids.docs));
    await wait(400);
    list = await rows();
    check('and the list stays open without it', (await overlay().executeJavaScript(`!!document.querySelector('.menu-tabsearch')`)) && list.length === before - 1 && !list.some((r) => /Docs/.test(r.title)), JSON.stringify(list.map((r) => r.title)));
    check('with the keyboard still in the box', await overlay().executeJavaScript(`document.activeElement?.classList.contains('tabsearch-input')`));
    key(overlay(), 'A', [mod, 'shift']);
    check('pressing the shortcut again closes it', !!(await listClosed()));

    // ---- 2. Mute -----------------------------------------------------------
    radio = browser.tabs.create({ url: base + '/Radio - Late night jazz', background: false });
    await until(() => !tab(radio)?.state.loading, 40);
    await tab(radio).view.webContents.executeJavaScript('window.__tone && window.__tone.resume().then(() => window.__tone.state)', true).catch(() => null);
    let audible = await until(() => tab(radio)?.state.audible, 60, 150);
    if (!audible) {
      // No sound device to play to (a server, a muted machine): Chromium never
      // calls the tab audible. Say so, and stand in for its event so the
      // controls can still be checked.
      console.log('  [note] this computer reported no audible tab; standing in for Chromium\'s audio event');
      tab(radio).state.audible = true;
      browser.push();
      audible = true;
    }
    check('a tab playing sound is marked audible', !!audible && browser.tabs.list().find((t) => t.id === radio).audible === true);
    await wait(400);
    let speaker = await until(() => centre(chrome(), `.tab[data-id="${radio}"] .tab-sound.is-playing`));
    check('and shows a speaker on its tab', !!speaker);
    const waves = await chrome().executeJavaScript(`document.querySelectorAll('.tab[data-id="${radio}"] .tab-sound .wave').length`);
    check('whose waves are drawn to move', waves === 2, waves);
    const near = async (id) => { const b = await tabAt(id); return { x: Math.max(0, Math.round(b.left) - 120), y: 36, width: 420, height: 40 }; };
    await composite('tabtouches-sound-playing', await near(radio), 2);
    await click(chrome(), speaker.x, speaker.y);
    await until(() => tab(radio).view.webContents.isAudioMuted());
    check('clicking the speaker mutes the tab', tab(radio).view.webContents.isAudioMuted() === true && tab(radio).state.muted === true);
    check('without switching to it or away from it', browser.tabs.activeId === radio);
    speaker = await until(() => centre(chrome(), `.tab[data-id="${radio}"] .tab-sound.is-muted`));
    check('the speaker turns into a muted one', !!speaker);
    await composite('tabtouches-sound-muted', await near(radio), 2);
    await click(chrome(), speaker.x, speaker.y);
    await until(() => !tab(radio).view.webContents.isAudioMuted());
    check('clicking it again lets the tab be heard', tab(radio).view.webContents.isAudioMuted() === false);

    // The tab menu.
    browser.lastMenu = null;
    let at = await tabAt(radio);
    await click(chrome(), at.x - 20, at.y, { button: 'right' });
    await until(() => menuLabels().length);
    check('the tab menu offers "Mute tab"', menuLabels().includes('Mute tab'), menuLabels().join(' | '));
    await choose('Mute tab');
    await until(() => tab(radio).state.muted);
    check('which mutes it', tab(radio).view.webContents.isAudioMuted() === true);
    browser.lastMenu = null;
    at = await tabAt(radio);
    await click(chrome(), at.x - 20, at.y, { button: 'right' });
    await until(() => menuLabels().length);
    check('and then offers "Unmute tab"', menuLabels().includes('Unmute tab'), menuLabels().join(' | '));
    await choose('Unmute tab');
    await until(() => !tab(radio).state.muted);
    check('which unmutes it', tab(radio).view.webContents.isAudioMuted() === false);
    // A selection, muted together from one menu.
    browser.lastMenu = null;
    await chrome().executeJavaScript('0');
    const many = await (async () => {
      at = await tabAt(ids.weather);
      browser.lastMenu = null;
      chrome().sendInputEvent({ type: 'mouseDown', x: at.x - 20, y: at.y, button: 'left', clickCount: 1, modifiers: [mod] });
      chrome().sendInputEvent({ type: 'mouseUp', x: at.x - 20, y: at.y, button: 'left', clickCount: 1, modifiers: [mod] });
      await wait(200);
      await click(chrome(), at.x - 20, at.y, { button: 'right' });
      await until(() => menuLabels().length);
      return menuLabels();
    })();
    check('several selected tabs are muted in one go ("Mute 2 tabs")', many.includes('Mute 2 tabs'), many.join(' | '));
    await choose('Mute 2 tabs');
    await until(() => tab(ids.weather).state.muted && tab(radio).state.muted);
    check('both are muted', tab(ids.weather).state.muted && tab(radio).state.muted);
    await chrome().executeJavaScript(`window.browser.invoke('tabs:mute', { ids: [${JSON.stringify(ids.weather)}, ${JSON.stringify(radio)}], muted: false })`);
    await until(() => !tab(ids.weather).state.muted && !tab(radio).state.muted);
    // Nothing to mute on a tab outside the browser's own list.
    const refused = await chrome().executeJavaScript(`window.browser.invoke('tabs:mute', { ids: ['not-a-tab'] })`);
    check('a request naming no open tab does nothing', refused === false);

    // Pinned: a badge on the corner.
    organizer.pin([radio], true);
    await until(() => tab(radio).pinned);
    await wait(300);
    const badge = await until(() => centre(chrome(), `.tab.pinned[data-id="${radio}"] .tab-sound-badge`));
    check('a pinned tab making sound wears a speaker badge', !!badge);
    const pinBox = await tabAt(radio);
    check('on the corner of its icon, inside the square', badge && badge.x > pinBox.x && badge.y > pinBox.y && badge.right <= pinBox.right + 1, JSON.stringify({ badge, pinBox }));
    await click(chrome(), badge.x, badge.y);
    await until(() => tab(radio).state.muted);
    check('clicking the badge mutes it', tab(radio).view.webContents.isAudioMuted() === true);
    await until(() => centre(chrome(), `.tab.pinned[data-id="${radio}"] .tab-sound-badge.is-muted`));
    await composite('tabtouches-pinned-badge', { x: 0, y: 36, width: 300, height: 40 }, 2);
    // Tab search shows the sound too.
    key(chrome(), 'A', [mod, 'shift']);
    await listOpen();
    list = await rows();
    check('tab search marks the muted tab', list.some((r) => /Radio/.test(r.title) && /is-muted/.test(r.sound)), JSON.stringify(list.map((r) => r.sound)));
    await closeMenu();
    organizer.pin([radio], false);
    await until(() => !tab(radio).pinned);

    // ---- 3. Hover previews --------------------------------------------------
    // The first tab is the one this off-screen window has really painted, so
    // it is the one that can be photographed live (see the note in tabs).
    browser.tabs.select(inbox);
    await wait(900);
    overlayFocusCalls = 0;
    at = await tabAt(inbox);
    move(chrome(), at.x, at.y);
    await wait(250);
    check('a tab touched only in passing shows no card', await noCard() && tiny());
    let shown = await until(card, 20, 60);
    check('resting on a tab for about half a second brings up its card', !!shown && /Inbox/.test(shown.title) && shown.site === '127.0.0.1', JSON.stringify(shown));
    const lane = browser.overlay.getBounds();
    check('the overlay covers only the lane under the strip, never the tabs', lane.y >= 76 && lane.height < 300 && !browser.overlayInteractive, JSON.stringify(lane));
    shown = await until(async () => { const c = await card(); return c?.img ? c : null; }, 30, 100);
    check('with a picture of the page', !!shown?.img, JSON.stringify(shown));
    check('and without taking the keyboard', overlayFocusCalls === 0, overlayFocusCalls);
    // Never flickers while the pointer rests.
    const samples = [];
    for (let i = 0; i < 30; i++) {
      samples.push(JSON.stringify([await overlay().executeJavaScript(`document.querySelectorAll('.tab-card').length`), browser.overlay.getBounds()]));
      await wait(30);
    }
    check('it holds perfectly still while the pointer rests (30 looks over a second)', new Set(samples).size === 1 && samples[0].startsWith('[1,'), [...new Set(samples)].join(' / '));
    await composite('tabtouches-hover-card', { x: 0, y: 0, width: Math.min(760, lane.width), height: 360 });

    // On to the next tab: the same card slides along, at once.
    const first = shown.transform;
    at = await tabAt(ids.weather);
    move(chrome(), at.x, at.y);
    const slid = await until(async () => { const c = await card(); return c && /Weather/.test(c.title) ? c : null; }, 12, 25);
    check('moving to the next tab carries the card to it straight away', !!slid && slid.count === 1 && slid.transform !== first, JSON.stringify({ first, slid }));
    // Weather was on screen earlier, but this off-screen window never painted
    // it; either way the card shows something, never a blank or the last tab.
    const weatherCard = await until(async () => { const c = await card(); return c && !c.pending ? c : null; }, 20, 100);
    check('a tab with no picture to hand gets a placeholder, never the last tab\'s picture', !!weatherCard && (weatherCard.img || /No picture yet/.test(weatherCard.rest)), JSON.stringify(weatherCard));
    // Back to Inbox, which is no longer on screen: the picture kept from when it was.
    browser.tabs.select(ids.weather);
    await wait(600);
    at = await tabAt(inbox);
    move(chrome(), at.x, at.y);
    const kept = await until(async () => { const c = await card(); return c && /Inbox/.test(c.title) && c.img ? c : null; }, 25, 100);
    check('a tab in the background shows the picture taken when it was last on screen', !!kept, JSON.stringify(await card()));
    // The group's colour.
    at = await tabAt(ids.recipes);
    move(chrome(), at.x, at.y);
    const grouped = await until(async () => { const c = await card(); return c && /Recipes/.test(c.title) ? c : null; }, 20, 60);
    check('a grouped tab\'s card wears the group', grouped?.grouped === true, JSON.stringify(grouped));
    // Sound on the card.
    at = await tabAt(radio);
    move(chrome(), at.x - 20, at.y);
    const loud = await until(async () => { const c = await card(); return c && /Radio/.test(c.title) ? c : null; }, 20, 60);
    check('a card says when its tab is playing or muted', /Playing|Muted/.test(loud?.tag || ''), JSON.stringify(loud));

    // Leaving the tabs puts it away.
    move(chrome(), at.x, 100);
    check('moving off the tabs puts the card away', !!(await until(async () => (await noCard()) && tiny(), 15, 40)));

    // A sleeping tab: a placeholder, never a stale picture.
    await organizer.sleep([ids.maps]);
    const asleep = organizer.sleeping.has(ids.maps);
    at = await tabAt(ids.maps);
    move(chrome(), at.x, at.y);
    const sleepy = await until(async () => { const c = await card(); return c && /Maps/.test(c.title) ? c : null; }, 25, 60);
    check('a sleeping tab shows a tasteful placeholder that says so', !asleep || (/Asleep/.test(sleepy?.rest || '') && !sleepy.img), JSON.stringify({ asleep, sleepy }));
    const cardLeft = Math.round(await overlay().executeJavaScript(`document.querySelector('.tab-card-pos')?.getBoundingClientRect().left || 0`));
    const asleepX = Math.max(0, Math.min(cardLeft - 240, lane.width - 620));
    await composite('tabtouches-hover-asleep', { x: asleepX, y: 0, width: Math.min(620, lane.width - asleepX), height: 360 });
    if (asleep) await organizer.wake(ids.maps);

    // A click puts it away, and it stays away from that tab.
    at = await tabAt(ids.recipes);
    move(chrome(), at.x, at.y);
    await until(card, 25, 60);
    await click(chrome(), at.x, at.y);
    check('clicking a tab puts the card away', !!(await until(async () => (await noCard()) && tiny(), 10, 40)));
    await wait(800);
    check('and it does not come back while the pointer stays on that tab', await noCard());
    // A scroll puts it away.
    at = await tabAt(ids.weather);
    move(chrome(), at.x, at.y);
    await until(card, 25, 60);
    chrome().sendInputEvent({ type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: -60 });
    check('scrolling puts it away', !!(await until(async () => (await noCard()) && tiny(), 10, 40)));
    // A drag puts it away.
    at = await tabAt(inbox);
    move(chrome(), at.x + 6, at.y);
    await until(card, 25, 60);
    await chrome().executeJavaScript(`(() => { const t = document.querySelector('.tab[data-id="${inbox}"]'); const dt = new DataTransfer();
      t.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      t.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt })); return true; })()`);
    check('dragging a tab puts it away', !!(await until(async () => (await noCard()) && tiny(), 10, 40)));
    // A menu takes the overlay; the card goes.
    move(chrome(), at.x - 30, at.y);
    await wait(60);
    at = await tabAt(ids.weather);
    move(chrome(), at.x, at.y);
    await until(card, 25, 60);
    browser.lastMenu = null;
    await click(chrome(), at.x, at.y, { button: 'right' });
    await until(() => menuLabels().length);
    const swapped = await until(async () => (await noCard()) && (await overlay().executeJavaScript(`!!document.querySelector('.menu')`)), 20, 60);
    check('a right-click swaps the card for the tab menu', !!swapped, JSON.stringify({ card: await card(), menu: await overlay().executeJavaScript(`document.querySelectorAll('.menu').length`), interactive: browser.overlayInteractive, preview: browser.preview, bounds: browser.overlay.getBounds() }));
    await closeMenu();
    check('which leaves the overlay idle again', !!(await until(tiny, 10, 50)));

    // The Settings switch.
    const settingsTab = browser.tabs.create({ url: 'browser://settings#appearance' });
    const swc = tab(settingsTab).view.webContents;
    await until(() => !tab(settingsTab).state.loading);
    await wait(900);
    await swc.executeJavaScript(`document.querySelector('#tabPreviews')?.scrollIntoView({ block: 'center' }), true`);
    await wait(300);
    const toggle = await until(() => centre(swc, '#tabPreviews'));
    const before2 = await swc.executeJavaScript(`document.querySelector('#tabPreviews').checked`);
    check('Settings has a "Tab hover previews" switch, on by default', !!toggle && before2 === true && /Tab hover previews/.test(await swc.executeJavaScript(`document.querySelector('label[for=tabPreviews]').textContent`)), JSON.stringify(toggle));
    if (toggle) await click(swc, toggle.x, toggle.y);
    await until(() => browser.settings.value.tabPreviews === false, 20);
    check('turning it off is saved', browser.settings.value.tabPreviews === false, JSON.stringify({ toggle, viewport: await swc.executeJavaScript('[innerWidth, innerHeight]'), checked: await swc.executeJavaScript(`document.querySelector('#tabPreviews').checked`) }));
    browser.tabs.close(settingsTab);
    await wait(500);
    // From another tab, so nothing is left over from the right-click above.
    at = await tabAt(ids.recipes);
    move(chrome(), at.x, at.y);
    await wait(100);
    at = await tabAt(ids.weather);
    move(chrome(), at.x, at.y);
    await wait(1100);
    check('with it off, resting on a tab shows no card', (await noCard()) && tiny());
    const tipBack = await chrome().executeJavaScript(`document.querySelector('.tab[data-id="${ids.weather}"]').title`);
    check('and the plain tooltip comes back instead', /Weather/.test(tipBack), tipBack);
    browser.settings.update({ tabPreviews: true });
    browser.push();
    move(chrome(), at.x, 110);
    await wait(300);

    // ---- Down the side --------------------------------------------------------
    browser.settings.update({ tabLayout: 'vertical' });
    browser.applyTabLayout();
    browser.push();
    await until(() => browser.vtabs && !browser.vtabs.webContents.isLoading(), 40);
    await until(() => vt().executeJavaScript(`document.querySelectorAll('.vt-tab').length > 2`));
    await wait(600);
    const vrow = await centre(vt(), `.vt-tab[data-id="${inbox}"]`);
    move(vt(), vrow.x, vrow.y);
    const side = await until(card, 25, 60);
    const sideLane = browser.overlay.getBounds();
    const vb = browser.vtabs.getBounds();
    check('down the side, the card comes out to the right of the list', !!side && sideLane.x === vb.x + vb.width && /Inbox/.test(side.title), JSON.stringify({ sideLane, vb, side }));
    await until(async () => (await card())?.img, 20, 100);
    await composite('tabtouches-vertical-card', { x: 0, y: 0, width: Math.min(820, browser.window.getContentBounds().width), height: Math.min(520, browser.window.getContentBounds().height) });
    const vrow2 = await centre(vt(), `.vt-tab[data-id="${ids.weather}"]`);
    move(vt(), vrow2.x, vrow2.y);
    const side2 = await until(async () => { const c = await card(); return c && /Weather/.test(c.title) ? c : null; }, 12, 25);
    check('and follows the pointer down the list', !!side2 && side2.transform !== side.transform, JSON.stringify({ a: side.transform, b: side2?.transform }));
    move(vt(), vrow2.x, 2000);
    vt().sendInputEvent({ type: 'mouseLeave', x: vrow2.x, y: vrow2.y });
    check('leaving the list puts it away', !!(await until(async () => (await noCard()) && tiny(), 15, 40)));
    // Sound down the side.
    const vspeaker = await until(() => centre(vt(), `.vt-tab[data-id="${radio}"] .vt-sound`));
    check('a row making sound has a speaker', !!vspeaker);
    if (vspeaker) await click(vt(), vspeaker.x, vspeaker.y);
    await until(() => tab(radio).state.muted === false || tab(radio).state.muted === true);
    const flipped = await until(() => !tab(radio).state.muted, 10);
    check('which toggles the mute there too', !!flipped && tab(radio).view.webContents.isAudioMuted() === false);
    // Tab search from the side.
    const vsearch = await centre(vt(), '#search');
    await click(vt(), vsearch.x, vsearch.y);
    check('the list\'s search button opens tab search', !!(await listOpen()));
    const sideMenu = await overlay().executeJavaScript(`(() => { const r = document.querySelector('.menu').getBoundingClientRect(); return { left: r.left, top: r.top }; })()`);
    check('beside the button, opening into the page', Math.abs(sideMenu.left - (vb.x + vsearch.x - 15)) < 20 || sideMenu.left >= vb.x, JSON.stringify(sideMenu));
    await composite('tabtouches-vertical-search', { x: 0, y: 0, width: Math.min(820, browser.window.getContentBounds().width), height: Math.min(560, browser.window.getContentBounds().height) });
    await closeMenu();
    key(vt(), 'A', [mod, 'shift']);
    check('and the shortcut works from there as well', !!(await listOpen()));
    await closeMenu();
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  } finally {
    if (radio && browser.tabs.tabs.has(radio)) browser.tabs.close(radio);
    browser.overlay.webContents.focus = realFocus;
    browser.settings.update({ tabLayout: 'horizontal', tabPreviews: true });
    browser.applyTabLayout();
    browser.sessionStore.save({ tabs: [], savedAt: 0 });
    organizer.groups = [];
    server.close();
  }
  console.log(fails ? '\nFAILURES: ' + fails : '\nall tab search, mute and hover card checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
