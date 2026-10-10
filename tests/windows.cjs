const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

/**
 * More than one window, used the way a person uses them: Ctrl+N pressed in a
 * page, tabs opened and right-clicked in each window's own strip with real
 * clicks, menus chosen in each window's own overlay, a tab moved out into a
 * window of its own and back, and windows closed - the last one too, which
 * quits.
 *
 * Every window is off-screen and unfocusable, the second as much as the
 * first. Every check that something happened in one window also checks it
 * did not happen in the other.
 *
 *   node scripts/start.cjs --windows
 *
 * Pictures land in shots/windows-*.png.
 */

const page = (title, body = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font:16px/1.5 system-ui,sans-serif;margin:40px;background:#fbfaf7;color:#222"><h1>${title}</h1>${body}</body></html>`;
const ARTICLE = page('The Long Read', '<article>' + Array.from({ length: 14 }, (_, i) =>
  `<p>Paragraph ${i + 1}. The river ran slowly past the old mill, and the town that had grown up around it went about its business the way it had for two hundred years, unhurried and a little proud of being so.</p>`).join('') + '</article>');
const LOGIN = page('Sign in', `<form id="f" onsubmit="event.preventDefault()">
<input id="u" name="email" type="email" placeholder="Email"><input id="p" name="password" type="password" placeholder="Password">
<button type="submit">Sign in</button></form>`);

async function run(browser) {
  const { app, nativeImage } = require('electron');
  const shots = path.join(app.getAppPath(), 'shots');
  fs.mkdirSync(shots, { recursive: true });
  let fails = 0;
  const check = (name, ok, detail) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + name + (detail !== undefined && !ok ? ' :: ' + String(detail).slice(0, 300) : ''));
    if (!ok) fails++;
  };
  const until = async (fn, tries = 50, every = 120) => {
    for (let i = 0; i < tries; i++) {
      const value = await Promise.resolve().then(fn).catch(() => null);
      if (value) return value;
      await wait(every);
    }
    return null;
  };

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    const name = decodeURIComponent(req.url.slice(1).split('?')[0]);
    res.end(name === 'article' ? ARTICLE : name === 'login' ? LOGIN : page(name || 'Home'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;

  const isMac = process.platform === 'darwin';
  const mod = isMac ? 'meta' : 'control';
  const open = () => browser.windows.filter((w) => !w.closed);
  const js = (wc, code) => wc.executeJavaScript(code, true);
  const press = (wc, keyCode, modifiers = []) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
  const click = async (wc, x, y, { button = 'left' } = {}) => {
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    await wait(40);
    wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1 });
    await wait(140);
  };
  /** A window whose chrome and overlay have loaded and drawn its tabs. */
  const ready = (w) => until(async () => w.overlayReady && !w.chrome.webContents.isLoading()
    && (await js(w.chrome.webContents, `document.querySelectorAll('#tabs .tab').length`)) === w.tabs.order.length, 80);
  const loaded = (w, id) => until(() => {
    const tab = w.tabs.tabs.get(id);
    return tab && !tab.state.loading && /^http/.test(tab.state.url) && !tab.view.webContents.isLoading();
  }, 80);
  /** The ids each window's own strip draws, in order. */
  const stripIds = (w) => js(w.chrome.webContents, `[...document.querySelectorAll('#tabs .tab[data-id]')].map((n) => n.dataset.id)`);
  const menuOpen = (w) => until(() => js(w.overlay.webContents, `!!document.querySelector('.menu')`));
  const noMenu = async (w) => !(await js(w.overlay.webContents, `!!document.querySelector('.menu')`).catch(() => false));
  const closeMenu = async (w) => {
    await js(w.overlay.webContents, 'window.ui.closeMenu(), true').catch(() => {});
    await until(() => noMenu(w));
    await wait(150);
  };
  /** Click a row of the menu open in `w` by its label, with a real click. */
  const choose = async (w, label) => {
    const at = await until(() => js(w.overlay.webContents, `(() => {
      const row = [...document.querySelectorAll('.menu .menu-item')].find((n) => (n.querySelector('.menu-label')?.firstChild?.textContent || '') === ${JSON.stringify(label)});
      if (!row) return null; const b = row.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`));
    if (!at) return false;
    await click(w.overlay.webContents, at.x, at.y);
    return true;
  };
  const rightClickTab = async (w, id) => {
    w.lastMenu = null;
    const at = await until(() => js(w.chrome.webContents, `(() => { const n = document.querySelector('.tab[data-id="${id}"]');
      if (!n) return null; const b = n.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`));
    if (!at) return [];
    await click(w.chrome.webContents, at.x, at.y, { button: 'right' });
    await menuOpen(w);
    return w.lastMenu?.items || [];
  };
  const labels = (items) => (items || []).map((i) => i.label || (i.heading ? '#' + i.heading : '')).filter(Boolean);
  // Given up on after a while: a request that closes its own window never hears back.
  const invokeFrom = (wc, channel, payload) => Promise.race([
    js(wc, `window.browser.invoke(${JSON.stringify(channel)}, ${JSON.stringify(payload ?? null)})`),
    wait(5000).then(() => 'no answer'),
  ]);

  /** The window as a person would see it: every view laid over the next, overlay on top. */
  const composite = async (name, w) => {
    await wait(380);
    const { width, height } = w.window.getContentBounds();
    const canvas = Buffer.alloc(width * height * 4);
    for (let i = 0; i < canvas.length; i += 4) { canvas[i] = 0x22; canvas[i + 1] = 0x1b; canvas[i + 2] = 0x16; canvas[i + 3] = 255; }
    for (const view of (w.window.contentView.children || []).filter((v) => v.webContents && !v.webContents.isDestroyed())) {
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
    fs.writeFileSync(path.join(shots, name + '.png'), nativeImage.createFromBitmap(canvas, { width, height }).toPNG());
  };

  try {
    await wait(1200);
    browser.settings.update({ tabLayout: 'horizontal', sidebarMode: 'off', tabPreviews: true, bookmarksBar: false, onStartup: 'restore', animations: true });
    for (const w of open()) { w.applySidebarMode(); w.applyTabLayout(); }
    // Whatever an earlier run left: one window, one tab.
    for (const w of open().slice(1)) w.window.close();
    await until(() => open().length === 1);
    const A = open()[0];
    for (const extra of A.tabs.order.slice(1)) A.tabs.close(extra);
    await ready(A);

    /* ---- Ctrl+N ------------------------------------------------------- */
    const a1 = A.tabs.active.id;
    A.tabs.navigate(a1, base + '/Alpha one');
    await loaded(A, a1);
    const pageA = A.tabs.tabs.get(a1).view.webContents;
    press(pageA, 'n', [mod]);
    const B = await until(() => open().find((w) => w !== A));
    check('Ctrl+N in a page opens a second window', !!B && open().length === 2, open().length);
    if (!B) throw new Error('no second window');
    // Watched from its first frame: which parts of the chrome play the entrance.
    const entrance = js(B.chrome.webContents, `new Promise((done) => { const t0 = performance.now(); (function look() {
      const found = document.getAnimations().filter((a) => a.id === 'motion-enter').map((a) => a.effect.target.className);
      if (found.length || performance.now() - t0 > 4000) return done(found); requestAnimationFrame(look); })(); })`).catch(() => []);
    await ready(B);
    check('the new window is in front, and the first is still open', browser.front === B && !A.closed);
    check('it starts with one new tab of its own', B.tabs.order.length === 1 && /newtab/.test(B.tabs.active.state.displayUrl || ''), B.tabs.active?.state.displayUrl);
    check('the first window kept its tabs', A.tabs.order.length === 1 && A.tabs.activeId === a1);
    const bb = B.window.getBounds();
    check('the second window is off-screen and cannot take focus, like the first',
      bb.x <= -30000 && bb.y <= -30000 && B.window.isFocusable() === false, JSON.stringify(bb) + ' focusable=' + B.window.isFocusable());
    check('the two windows share one profile session', B.tabs.session === A.tabs.session && B.chrome.webContents.session === browser.session);
    const played = await entrance;
    check('its strip and toolbar play a short entrance as it opens', played.some((c) => /strip/.test(c)) && played.some((c) => /toolbar/.test(c)), JSON.stringify(played));
    check('the first window was never told it was arriving', browser.state(A).window.arriving === false);

    /* ---- tabs in each, each strip its own ----------------------------- */
    const b1 = B.tabs.active.id;
    B.tabs.navigate(b1, base + '/Bravo one');
    const b2 = await invokeFrom(B.chrome.webContents, 'tabs:new', { url: base + '/Bravo two' });
    const a2 = await invokeFrom(A.chrome.webContents, 'tabs:new', { url: base + '/Alpha two' });
    await loaded(B, b1); await loaded(B, b2); await loaded(A, a2);
    check('a new tab asked for by a window opens in that window',
      B.tabs.tabs.has(b2) && !A.tabs.tabs.has(b2) && A.tabs.tabs.has(a2) && !B.tabs.tabs.has(a2));
    await ready(A); await ready(B);
    const stripA = await stripIds(A);
    const stripB = await stripIds(B);
    check('each strip draws only its own window\'s tabs',
      JSON.stringify(stripA) === JSON.stringify(A.tabs.order) && JSON.stringify(stripB) === JSON.stringify(B.tabs.order),
      JSON.stringify({ stripA, stripB }));
    const titleOf = (w) => js(w.chrome.webContents, `document.getElementById('address').value`);
    B.tabs.select(b2);
    A.tabs.select(a2);
    await wait(300);
    check('each address bar shows its own window\'s page',
      /Bravo%20two|Bravo two/.test(await titleOf(B)) && /Alpha%20two|Alpha two/.test(await titleOf(A)),
      (await titleOf(A)) + ' | ' + (await titleOf(B)));

    /* ---- shortcuts act on the window they are pressed in -------------- */
    const beforeA = A.tabs.order.length;
    const beforeB = B.tabs.order.length;
    press(B.tabs.tabs.get(b2).view.webContents, 't', [mod]);
    await until(() => B.tabs.order.length === beforeB + 1);
    check('Ctrl+T in the second window\'s page opens the tab there', B.tabs.order.length === beforeB + 1 && A.tabs.order.length === beforeA,
      beforeA + '->' + A.tabs.order.length + ' / ' + beforeB + '->' + B.tabs.order.length);
    const extraB = B.tabs.activeId;
    press(B.chrome.webContents, 'w', [mod]);
    await until(() => !B.tabs.tabs.has(extraB));
    check('Ctrl+W in its chrome closes that window\'s tab, not the other\'s', !B.tabs.tabs.has(extraB) && A.tabs.order.length === beforeA);
    check('a key pressed in a window brings it to the front', browser.front === B);
    press(A.tabs.tabs.get(a2).view.webContents, 'Tab', isMac ? ['alt'] : ['control']);
    await wait(300);
    check('Ctrl+Tab in the first window moves along its own tabs', A.tabs.activeId === a1 && B.tabs.activeId === b2, A.tabs.activeId + ' ' + B.tabs.activeId);
    check('and makes it the window in front again', browser.front === A);

    /* ---- menus and cards open in their own window's overlay ----------- */
    await closeMenu(A); await closeMenu(B);
    const menuB = await rightClickTab(B, b1);
    check('right-clicking a tab in the second window opens its menu in that window', labels(menuB).includes('Close tab') || labels(menuB).some((l) => /Close/.test(l)), labels(menuB).join(' | '));
    check('and not in the first', await noMenu(A) && !A.overlayInteractive);
    check('with two windows open, the menu offers to move the tab to another window', labels(menuB).includes('Move tab to another window'), labels(menuB).join(' | '));
    await composite('windows-tab-menu', B);
    await closeMenu(B);

    await invokeFrom(B.chrome.webContents, 'qr:show', {});
    const qrCard = await until(() => B.lastMenu?.items?.[0]?.qr);
    check('the QR card for the second window\'s page opens there, for its page', !!qrCard && /Bravo/.test(decodeURIComponent(qrCard.url)), qrCard?.url);
    // Drawn in the second window's overlay - and only then put away: a card
    // closed while still on its way would arrive afterwards.
    check('the card is drawn in that window\'s overlay', !!(await until(() => js(B.overlay.webContents, `!!document.querySelector('.menu-qr')`))));
    check('the first window\'s overlay stays idle', await noMenu(A));
    await closeMenu(B);

    // Tab search: this window's tabs first, the other's marked as elsewhere.
    A.lastMenu = null;
    press(A.chrome.webContents, 'a', [mod, 'shift']);
    const search = await until(() => A.lastMenu?.items?.[0]?.tabsearch);
    const rows = search?.tabs || [];
    const firstOther = rows.findIndex((r) => r.elsewhere);
    check('tab search lists every window\'s tabs, this window\'s first',
      rows.length === A.tabs.order.length + B.tabs.order.length && firstOther === A.tabs.order.length
      && rows.slice(0, firstOther).every((r) => A.tabs.tabs.has(r.id)), JSON.stringify(rows.map((r) => [r.title, !!r.elsewhere])));
    check('and says which window the others are in', rows.slice(firstOther).every((r) => r.elsewhere?.name === 'Window 2' && !r.active), JSON.stringify(rows.slice(firstOther).map((r) => r.elsewhere)));
    check('its placeholder says it searches every window', /every window/.test(search?.placeholder || ''), search?.placeholder);
    const tagged = await until(() => js(A.overlay.webContents, `[...document.querySelectorAll('.ts-window')].map((n) => n.textContent)`).then((t) => t.length ? t : null));
    check('the rows from the other window wear its name', (tagged || []).length === B.tabs.order.length && tagged.every((t) => t === 'Window 2'), JSON.stringify(tagged));
    await composite('windows-tab-search', A);
    // Choosing a tab in the other window brings that window forward with it.
    const choice = rows.find((r) => r.id === b1);
    await invokeFrom(A.overlay.webContents, choice.select.channel, choice.select.payload);
    await wait(200);
    check('choosing another window\'s tab there selects it in its window and brings that window forward',
      B.tabs.activeId === b1 && browser.front === B && A.tabs.tabs.size === 2);
    await closeMenu(A);

    /* ---- what one window may not do to another's tabs ----------------- */
    const muted = await invokeFrom(A.chrome.webContents, 'tabs:mute', { id: b1 });
    check('a window cannot mute another window\'s tab', muted === false && !B.tabs.tabs.get(b1).state.muted, muted);
    await invokeFrom(A.chrome.webContents, 'tabs:close', { ids: [b1, b2] });
    await invokeFrom(A.chrome.webContents, 'tabs:close', { id: b2 });
    await invokeFrom(A.chrome.webContents, 'tabs:search-close', { id: b2 });
    check('nor close them', B.tabs.tabs.has(b1) && B.tabs.tabs.has(b2));
    const pulled = await invokeFrom(A.chrome.webContents, 'tabs:select', { id: b2 });
    check('nor bring one forward, except from the tab search list', pulled === false && B.tabs.activeId === b1, pulled);
    const previewOther = await invokeFrom(A.chrome.webContents, 'tabs:preview', { id: b1, anchor: { left: 10, right: 60, top: 40, bottom: 76, width: 50, height: 36 } });
    check('nor show a hover card for one', previewOther === false && !A.preview && !B.preview);
    const moved = await invokeFrom(A.chrome.webContents, 'tabs:to-window', { ids: [b1], window: 'new' });
    check('nor move one away', moved === false && B.tabs.tabs.has(b1) && open().length === 2);
    await invokeFrom(A.chrome.webContents, 'split:with', { id: b2 });
    check('nor split with one', !A.tabs.active.splitWith && !B.tabs.tabs.get(b2).splitWith);

    /* ---- hover cards, mute, split and the sidebar, per window ---------- */
    const anchor = await js(B.chrome.webContents, `(() => { const b = document.querySelector('.tab[data-id="${b2}"]').getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; })()`);
    const menuState = { lastB: B.overlayInteractive ? Object.keys(B.lastMenu?.items?.[0] || {}).concat(labels(B.lastMenu?.items)) : null,
      pendingB: B.pendingMenu ? Object.keys(B.pendingMenu) : null, domB: await js(B.overlay.webContents, `document.querySelector('.menu')?.className || ''`).catch(() => '?') };
    const shown = await invokeFrom(B.chrome.webContents, 'tabs:preview', { id: b2, anchor });
    check('a hover card in the second window is for its tab, in its overlay', shown === true && B.preview?.id === b2 && !A.preview,
      JSON.stringify({ shown, preview: B.preview, a: A.preview, interactive: B.overlayInteractive, anchor, menuB: menuState.lastB, pendingB: menuState.pendingB, domB: menuState.domB }));
    await invokeFrom(B.chrome.webContents, 'tabs:preview', {});
    check('and goes when the pointer leaves', !B.preview);
    await invokeFrom(B.chrome.webContents, 'tabs:mute', { id: b2 });
    check('muting a tab mutes it in its own window', B.tabs.tabs.get(b2).state.muted === true);
    await invokeFrom(B.chrome.webContents, 'tabs:mute', { id: b2 });
    await invokeFrom(A.chrome.webContents, 'split:with', { id: a2 });
    A.layout();
    check('split view in the first window pairs its own tabs', !!A.tabs.pairOf(a1) && !B.tabs.pairOf(B.tabs.activeId) && !!A.splitDivider && !B.splitDivider);
    await invokeFrom(A.chrome.webContents, 'split:exit', {});
    browser.settings.update({ sidebarMode: 'on' });
    B.applySidebarMode();
    await invokeFrom(B.chrome.webContents, 'sidebar:toggle', { open: true });
    await invokeFrom(A.chrome.webContents, 'sidebar:toggle', { open: false });
    check('each window opens and closes its own sidebar', B.sidebarOpen === true && A.sidebarOpen === false, B.sidebarOpen + ' ' + A.sidebarOpen);
    await invokeFrom(B.chrome.webContents, 'sidebar:toggle', { open: false });
    browser.settings.update({ sidebarMode: 'off' });
    for (const w of open()) w.applySidebarMode();

    /* ---- groups and pins stay in their window ------------------------- */
    const organizer = browser.productivity.organizer;
    const made = await invokeFrom(B.chrome.webContents, 'organizer:assign', { ids: [b1, b2], groupId: 'new', name: 'Bravo work' }).catch((e) => String(e));
    const refused = await invokeFrom(A.chrome.webContents, 'organizer:assign', { ids: [b1], groupId: null }).catch((e) => String(e));
    const groupB = organizer.groups.find((g) => g.name === 'Bravo work');
    check('a group made in the second window holds its tabs', !!groupB && B.tabs.tabs.get(b1).groupId === groupB.id && B.tabs.tabs.get(b2).groupId === groupB.id, JSON.stringify({ made, groups: organizer.groups }));
    check('and the first window cannot take a tab out of it', B.tabs.tabs.get(b1).groupId === groupB?.id, JSON.stringify(refused));
    await invokeFrom(A.chrome.webContents, 'organizer:pin', { ids: [a1], pinned: true });
    check('pinning in the first window pins its tab', A.tabs.tabs.get(a1).pinned === true && !B.tabs.tabs.get(b1).pinned);
    await ready(A); await ready(B);
    const chip = await js(B.chrome.webContents, `!!document.querySelector('.tab-group-chip')`);
    const chipA = await js(A.chrome.webContents, `!!document.querySelector('.tab-group-chip')`);
    check('the group\'s chip is drawn in its window\'s strip only', chip && !chipA);
    await composite('windows-second', B);
    await composite('windows-first', A);

    /* ---- page tools and Read this page, per window -------------------- */
    B.tabs.navigate(b2, base + '/article');
    await loaded(B, b2);
    B.tabs.select(b2);
    await until(() => B.tabs.tabs.get(b2).readable?.ok, 60);
    await invokeFrom(B.chrome.webContents, 'reader:toggle', {});
    await until(() => /browser:\/\/reader/.test(B.tabs.tabs.get(b2).state.internalUrl || ''), 60);
    check('reading view from the second window\'s address bar opens its page in reading view',
      /browser:\/\/reader/.test(B.tabs.tabs.get(b2).state.internalUrl || '') && !A.tabs.list().some((t) => /reader/.test(t.url || '')), B.tabs.tabs.get(b2).state.internalUrl);
    await invokeFrom(B.chrome.webContents, 'reader:leave', {});
    await until(() => !B.tabs.tabs.get(b2).state.internalUrl, 60);

    // The screenshot menu from the main menu, in the window it was opened in.
    B.lastMenu = { anchor: { left: 12, right: 12, top: 40, bottom: 40, width: 0, height: 0 }, align: 'left', items: [] };
    await invokeFrom(B.chrome.webContents, 'shot:menu', {});
    check('the screenshot menu opens in the second window', labels(B.lastMenu?.items).includes('Visible area') && await noMenu(A), labels(B.lastMenu?.items).join(' | '));
    await invokeFrom(B.overlay.webContents, 'shot:take', { mode: 'visible' });
    const card = await until(() => B.lastMenu?.items?.[0]?.shot);
    check('and its picture comes back as a card there', !!card && card.width > 100 && await noMenu(A), JSON.stringify(card && { w: card.width, h: card.height }));
    await menuOpen(B);
    await closeMenu(B);

    // Read this page: the last web page of THIS window, never the other's.
    A.tabs.select(a2);
    await wait(150);
    B.tabs.select(b1); // the more recent web page, but in the other window
    await wait(150);
    const legal = await invokeFrom(A.chrome.webContents, 'tabs:new', { url: 'browser://legal' });
    await until(() => !A.tabs.tabs.get(legal).view.webContents.isLoading(), 60);
    await wait(500);
    const named = await invokeFrom(A.tabs.tabs.get(legal).view.webContents, 'workspace:recent-page', null);
    check('Read this page in the first window reads that window\'s last page, not the other window\'s', named?.ok && named.id === a2, JSON.stringify(named));
    A.tabs.close(legal);

    /* ---- the autofill prompt appears in the window whose page asked ---- */
    browser.passwords.clear();
    for (const o of browser.autofill.state().never) browser.autofill.removeNever(o);
    B.tabs.navigate(b1, base + '/login');
    await loaded(B, b1);
    B.tabs.select(b1);
    await wait(400);
    A.lastMenu = null; B.lastMenu = null;
    await js(B.tabs.tabs.get(b1).view.webContents, `(() => { document.getElementById('u').value = 'sam@example.com'; document.getElementById('p').value = 'river mill 1802'; document.getElementById('f').requestSubmit(); })()`);
    const offer = await until(() => B.lastMenu?.items?.some((i) => /Save password/.test(i.heading || '')) && B.lastMenu.items);
    check('signing in on a page in the second window offers to save there', !!offer, JSON.stringify(labels(B.lastMenu?.items)));
    check('and nothing is asked in the first', !A.lastMenu && await noMenu(A));
    await composite('windows-autofill', B);
    const save = (B.lastMenu?.items || []).find((i) => i.label === 'Save');
    if (save) await invokeFrom(B.overlay.webContents, save.action.channel, save.action.payload);
    await wait(250);
    check('saving it notes so along the bottom of that window', /Password saved/.test(B.notice?.message || '') && !/Password saved/.test(A.notice?.message || ''), (B.notice?.message || '') + ' | ' + (A.notice?.message || ''));
    browser.passwords.clear();

    /* ---- the main menu offers a new window, and it opens -------------- */
    await closeMenu(A);
    A.lastMenu = null;
    press(A.chrome.webContents, 'F10');
    await menuOpen(A);
    const mainItems = labels(A.lastMenu?.items);
    check('the main menu has a New window row with its shortcut', (A.lastMenu?.items || []).some((i) => i.label === 'New window' && /N$/.test(i.shortcut || '')), mainItems.join(' | '));
    const exit = (A.lastMenu?.items || []).flatMap((i) => i.footer || []).find((i) => i.label === 'Exit');
    check('its Exit quits every window, not just this one', exit?.action?.payload?.action === 'quit', JSON.stringify(exit));
    await composite('windows-main-menu', A);
    // With animations turned off, the window simply appears.
    browser.settings.update({ animations: false });
    await choose(A, 'New window');
    const C = await until(() => open().find((w) => w !== A && w !== B));
    check('choosing it opens a third window', !!C && open().length === 3, open().length);
    if (C) {
      const still = js(C.chrome.webContents, `new Promise((done) => { const t0 = performance.now(); (function look() {
        const found = document.getAnimations().filter((a) => a.id === 'motion-enter').length;
        if (found || performance.now() - t0 > 1500) return done(found); requestAnimationFrame(look); })(); })`).catch(() => -1);
      await ready(C);
      check('with animations off it plays no entrance', (await still) === 0);
      browser.settings.update({ animations: true });
      const ca = C.window.getBounds();
      check('also off-screen and unfocusable', ca.x <= -30000 && C.window.isFocusable() === false);
      C.window.close();
      await until(() => C.closed);
      check('closing it closes just that window', C.closed && open().length === 2);
    }

    /* ---- Move tab to a new window, and back --------------------------- */
    B.tabs.navigate(b1, base + '/Bravo one');
    await loaded(B, b1);
    const pageId = B.tabs.tabs.get(b1).view.webContents.id;
    await js(B.tabs.tabs.get(b1).view.webContents, `window.__kept = 'still here'; true`);
    await closeMenu(B);
    await rightClickTab(B, b1);
    await choose(B, 'Move tab to another window');
    await until(() => labels(B.lastMenu?.items).includes('New window'));
    check('it asks where to: a new window, or the other one by its tab', labels(B.lastMenu?.items).includes('New window') && (B.lastMenu?.items || []).some((i) => i.action?.payload?.window === A.id), labels(B.lastMenu?.items).join(' | '));
    await composite('windows-move-picker', B);
    await choose(B, 'New window');
    const D = await until(() => open().find((w) => w !== A && w !== B));
    check('choosing New window moves the tab into a window of its own', !!D && D.tabs.order.length === 1 && D.tabs.tabs.has(b1) && !B.tabs.tabs.has(b1), D && JSON.stringify(D.tabs.order));
    if (!D) throw new Error('no window for the moved tab');
    await ready(D);
    const live = D.tabs.tabs.get(b1).view.webContents;
    check('the page moved live: the same page, nothing reloaded', live.id === pageId && await js(live, 'window.__kept') === 'still here');
    check('it leaves its group behind with the window it left', !D.tabs.tabs.get(b1).groupId && B.tabs.tabs.get(b2).groupId === groupB?.id);
    check('and the window it went to is in front', browser.front === D);
    const dStrip = await stripIds(D);
    check('its new window\'s strip draws it', JSON.stringify(dStrip) === JSON.stringify([b1]), JSON.stringify(dStrip));
    await composite('windows-moved', D);
    // Key presses in the moved page now act on its new window.
    press(live, 't', [mod]);
    await until(() => D.tabs.order.length === 2);
    check('a key pressed in the moved page acts on its new window', D.tabs.order.length === 2 && B.tabs.order.length === 1, D.tabs.order.length + ' ' + B.tabs.order.length);
    D.tabs.close(D.tabs.activeId);
    await wait(150);
    // And into the first window: D is left with nothing, so it closes.
    const back = await invokeFrom(D.chrome.webContents, 'tabs:to-window', { ids: [b1], window: A.id });
    await until(() => D.closed);
    // (No answer comes back: the window that asked has closed.)
    check('moving its only tab to another window closes the emptied window', back !== false && D.closed && A.tabs.tabs.has(b1) && open().length === 2);
    check('the tab arrives in front in that window', A.tabs.activeId === b1 && browser.front === A);
    check('still the same page', A.tabs.tabs.get(b1).view.webContents.id === pageId);

    // Dragged out of the strip and let go outside every window: a window of
    // its own. Where it was let go is read by main from the system, never
    // taken from the page; an off-screen window is never under the pointer.
    const dragged = await invokeFrom(A.chrome.webContents, 'tabs:drag-out', { ids: [b1] });
    const F = await until(() => open().find((w) => w !== A && w !== B));
    check('a tab dragged out of the strip and let go outside becomes a window of its own',
      dragged === true && !!F && F.tabs.tabs.has(b1) && !A.tabs.tabs.has(b1), dragged);
    const draggedOther = await invokeFrom(A.chrome.webContents, 'tabs:drag-out', { ids: [b2] });
    check('a window cannot drag out another window\'s tab', draggedOther === false && B.tabs.tabs.has(b2));
    if (F) {
      await ready(F);
      invokeFrom(F.chrome.webContents, 'tabs:to-window', { ids: [b1], window: A.id });
      await until(() => F.closed);
      check('and dragged back it joins the first window again', F.closed && A.tabs.tabs.has(b1) && A.tabs.tabs.get(b1).view.webContents.id === pageId);
    }

    /* ---- session restore keeps each window's tabs --------------------- */
    browser.saveSession();
    const saved = structuredClone(browser.sessionStore.data);
    const windowsSaved = new Set(saved.tabs.map((t) => t.window));
    check('the session remembers both windows and which tab is in which',
      windowsSaved.size === 2 && Array.isArray(saved.windows) && saved.windows.length === 2
      && saved.tabs.filter((t) => t.window === saved.windows.findIndex((x) => x.front)).length === A.tabs.list().filter((t) => /^http/.test(t.url)).length,
      JSON.stringify(saved.tabs.map((t) => [t.title, t.window])) + JSON.stringify(saved.windows));
    check('with pins and groups, names and colours', saved.tabs.some((t) => t.pinned) && saved.groups.some((g) => g.name === 'Bravo work' && g.color), JSON.stringify(saved.groups));
    // Restore it into a fresh window, as a launch would.
    const before = new Set(open());
    const R = browser.openWindow({});
    for (const extra of R.tabs.order.slice()) R.tabs.close(extra);
    browser.restoreSession(saved, R);
    const S = await until(() => open().find((w) => !before.has(w) && w !== R));
    await ready(R);
    if (S) await ready(S);
    const homeTabs = R.tabs.list().filter((t) => /^http/.test(t.url));
    const otherTabs = S ? S.tabs.list() : [];
    check('restoring opens each saved window again with its own tabs',
      !!S && homeTabs.length === saved.tabs.filter((t) => t.window === saved.windows.findIndex((x) => x.front)).length
      && otherTabs.length === saved.tabs.filter((t) => t.window !== saved.windows.findIndex((x) => x.front)).length,
      homeTabs.length + ' + ' + otherTabs.length + ' of ' + saved.tabs.length);
    const restoredGroup = organizer.groups.find((g) => g.name === 'Bravo work' && S?.tabs.list().some((t) => t.groupId === g.id));
    check('the group comes back, in its window, with its colour', !!restoredGroup && restoredGroup.color === groupB?.color, JSON.stringify(organizer.groups.map((g) => [g.name, g.color])));
    check('pinned tabs come back pinned', homeTabs.some((t) => t.pinned));
    for (const w of [R, S].filter(Boolean)) w.window.close();
    await until(() => R.closed && (!S || S.closed));

    /* ---- closing windows ----------------------------------------------- */
    const bTabs = B.tabs.list().map((t) => t.url);
    const bContents = [...B.tabs.tabs.values()].map((t) => t.view.webContents);
    await invokeFrom(B.chrome.webContents, 'window:control', { action: 'close' });
    await until(() => B.closed);
    check('the window\'s own close button closes it', B.closed && open().length === 1 && open()[0] === A);
    check('and its pages with it', bContents.every((wc) => wc.isDestroyed()));
    check('the other window comes to the front', browser.front === A);
    browser.saveSession();
    check('a window closed while another stays open leaves the session', !browser.sessionStore.data.tabs.some((t) => bTabs.includes(t.url) && !A.tabs.list().some((x) => x.url === t.url)),
      JSON.stringify(browser.sessionStore.data.tabs.map((t) => t.url)));
    press(A.tabs.active.view.webContents, 't', [mod, 'shift']);
    const E = await until(() => open().find((w) => w !== A));
    check('Ctrl+Shift+T brings the closed window back, with its tabs', !!E && E.tabs.list().length === bTabs.filter((u) => /^http/.test(u)).length, E && JSON.stringify(E.tabs.list().map((t) => t.url)));
    if (E) {
      const regrouped = organizer.groups.find((g) => g.name === 'Bravo work' && E.tabs.list().some((t) => t.groupId === g.id));
      check('and with its group, name and colour', !!regrouped && regrouped.color === groupB?.color, JSON.stringify(organizer.groups.map((g) => [g.name, g.color])));
      await ready(E);
      // Its last tab closed: the window goes too, while another stays open.
      for (const id of E.tabs.order.slice(0, -1)) E.tabs.close(id);
      await invokeFrom(E.chrome.webContents, 'tabs:close', {});
      await until(() => E.closed);
      check('closing a window\'s last tab closes the window when another is open', E.closed && open().length === 1);
    }
    // The only window left: closing its last tab keeps it, with a new tab.
    for (const id of A.tabs.order.slice(0, -1)) A.tabs.close(id);
    A.tabs.close(A.tabs.activeId);
    await wait(300);
    check('closing the only window\'s last tab keeps the window, with a new tab', !A.closed && A.tabs.order.length === 1);
  } catch (error) {
    console.error('FAIL  probe crashed:', error.stack || error.message);
    fails++;
  }

  // Last of all: closing the last window quits the app (on every platform in
  // a probe; on a Mac outside one, the app would stay in the dock).
  server.close();
  console.log('\n' + (fails ? fails + ' check(s) failed' : 'all window checks passed'));
  let quitting = false;
  app.once('before-quit', () => { quitting = true; });
  const timer = setTimeout(() => {
    console.log('FAIL  closing the last window did not quit');
    app.exit(1);
  }, 6000);
  app.once('will-quit', (event) => {
    event.preventDefault();
    clearTimeout(timer);
    console.log((quitting && browser.quitting ? '  ok  ' : 'FAIL  ') + 'closing the last window quits the app');
    app.exit(fails || !quitting ? 1 : 0);
  });
  const last = browser.windows.find((w) => !w.closed);
  if (last) last.window.close();
  else app.exit(fails ? 1 : 0);
}

module.exports = { run };
