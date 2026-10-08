const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const http = require('node:http');

/**
 * The awkward corners of tab search, muting and hover cards - the things
 * tests/tabtouches.cjs does not walk through: a card asked for and put away
 * in the same moment, a card up while the keyboard switches or closes tabs,
 * a page whose title is markup, a tab in another workspace, closing the tab
 * you are on from the list, a long list of tabs, internal pages, a window
 * resized under a card, and previews switched off. Runs off-screen.
 *
 *   node scripts/start.cjs --tabtouchesedge
 */
const page = (title) => `<!doctype html><html><head><title>${title}</title></head>
  <body style="margin:0;font:16px system-ui;background:#eef"><h1 style="padding:30px">${title.replace(/</g, '&lt;')}</h1></body></html>`;

async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d !== undefined && !ok ? ' :: ' + String(d).slice(0, 300) : ''));
    if (!ok) fails++;
  };
  const until = async (fn, tries = 40, every = 100) => {
    for (let i = 0; i < tries; i++) { const v = await Promise.resolve().then(fn).catch(() => null); if (v) return v; await wait(every); }
    return null;
  };

  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.slice(1).split('?')[0]) || 'Home';
    if (name === 'favicon.ico') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    // A title that is markup, served raw: a page can call itself anything.
    res.end(name === 'Evil' ? `<!doctype html><html><head><title><img src=x onerror="window.top.__pwned=1">Evil &lt;b&gt;bold&lt;/b&gt;</title></head><body>evil</body></html>` : page(name));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;

  const organizer = browser.productivity.organizer;
  const chrome = () => browser.chrome.webContents;
  const overlay = () => browser.overlay.webContents;
  const tab = (id) => browser.tabs.tabs.get(id);
  const mac = process.platform === 'darwin';
  const mod = mac ? 'meta' : 'control';
  const move = (wc, x, y) => wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
  const key = (wc, keyCode, modifiers = []) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode === 'Return') wc.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
  const centre = (wc, selector) => wc.executeJavaScript(`(() => { const n = document.querySelector(${JSON.stringify(selector)});
    if (!n) return null; const b = n.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
  const tabAt = (id) => centre(chrome(), `.tab[data-id="${id}"]`);
  const card = () => overlay().executeJavaScript(`(() => { const c = document.querySelector('.tab-card'); if (!c) return null;
    return { title: c.querySelector('.tc-title').textContent, html: c.querySelector('.tc-title').innerHTML, site: c.querySelector('.tc-site-name')?.textContent || '' }; })()`);
  const noCard = () => overlay().executeJavaScript(`!document.querySelector('.tab-card')`);
  const tiny = () => { const b = browser.overlay.getBounds(); return b.width <= 1 && b.height <= 1; };
  const gone = () => until(async () => (await noCard()) && tiny() && !browser.preview, 20, 50);
  const listOpen = () => until(() => overlay().executeJavaScript(`!!document.querySelector('.menu.menu-tabsearch')`));
  const closeMenu = async () => {
    await overlay().executeJavaScript('window.ui.closeMenu(), true').catch(() => {});
    await until(() => overlay().executeJavaScript(`!document.querySelector('.menu')`));
    await wait(150);
  };
  const rows = () => overlay().executeJavaScript(`[...document.querySelectorAll('.ts-row')].map((n) => ({
    title: n.querySelector('.ts-title').textContent, html: n.querySelector('.ts-title').innerHTML,
    workspace: n.querySelector('.ts-workspace')?.textContent || '', selected: n.classList.contains('is-selected') }))`);
  const rest = async (id) => {
    const at = await tabAt(id);
    move(chrome(), at.x, at.y);
    return until(async () => { const c = await card(); return c && browser.preview?.id === id ? c : null; }, 25, 60);
  };
  const leave = async () => { move(chrome(), 300, 4); await gone(); move(chrome(), 300, 6); await wait(500); };

  try {
    await wait(1400);
    browser.settings.update({ tabLayout: 'horizontal', tabPreviews: true, bookmarksBar: false });
    browser.applyTabLayout();
    browser.layout();
    organizer.groups = [];
    for (const extra of browser.tabs.order.slice(1)) browser.tabs.close(extra);
    const first = browser.tabs.active.id;
    browser.tabs.navigate(first, base + '/Alpha');
    const ids = { first };
    for (const name of ['Bravo', 'Charlie', 'Evil']) ids[name.toLowerCase()] = browser.tabs.create({ url: base + '/' + name, background: true });
    browser.tabs.select(first);
    await until(() => browser.tabs.list().every((t) => !t.loading && /^http/.test(t.url)));
    browser.push();
    await wait(900);

    // ---- A card asked for and put away in the same moment ----------------
    // The 500ms timer fires and the request leaves for main; a wheel, a
    // blur or a press lands before main answers. The card must not be left
    // standing over the page with nothing to put it away.
    for (const how of ['wheel', 'blur']) {
      await chrome().executeJavaScript(`(() => { hover.id = ${JSON.stringify(ids.bravo)}; showPreview(${JSON.stringify(ids.bravo)});
        ${how === 'wheel' ? `document.getElementById('tabs').dispatchEvent(new WheelEvent('wheel', { deltaY: 10 }))` : `window.dispatchEvent(new Event('blur'))`}; return true; })()`);
      await wait(700);
      check(`a card cut off by a ${how} straight after it was asked for does not stay up`, (await noCard()) && tiny() && !browser.preview,
        JSON.stringify({ preview: browser.preview, bounds: browser.overlay.getBounds() }));
      await overlay().executeJavaScript('window.tabPreview.hide(), true');
      browser.overlay.setBounds({ x: 0, y: 0, width: 1, height: 1 });
      browser.preview = null;
      await chrome().executeJavaScript('hidePreview(), true');
    }

    // ---- The keyboard switches tabs while a card is up --------------------
    check('a card comes up on a resting pointer', !!(await rest(ids.bravo)));
    key(chrome(), 'Tab', [mod]);
    await until(() => browser.tabs.activeId !== first);
    check('switching tab from the keyboard puts the card away', !!(await gone()));
    browser.tabs.select(first);
    await leave();

    // ---- The hovered tab closes under the pointer -------------------------
    const doomed = browser.tabs.create({ url: base + '/Doomed', background: true });
    await until(() => !tab(doomed).state.loading);
    await wait(400);
    check('a card on a tab about to close', !!(await rest(doomed)));
    browser.tabs.close(doomed);
    check('closing the tab under the pointer takes its card with it', !!(await gone()));
    await leave();

    // ---- A title that is markup -------------------------------------------
    const evil = await rest(ids.evil);
    check('a page\'s title on its card is only ever text', !!evil && !/<img/i.test(evil.html) && /onerror|Evil/.test(evil.title), JSON.stringify(evil));
    await leave();

    // ---- The window changes size under a card -----------------------------
    check('a card is up', !!(await rest(ids.charlie)));
    const size = browser.window.getSize();
    browser.window.setSize(size[0] - 60, size[1]);
    await wait(300);
    browser.layout();
    check('resizing the window puts it away', !!(await gone()));
    browser.window.setSize(size[0], size[1]);
    browser.layout();
    await leave();

    // ---- An internal page --------------------------------------------------
    const settingsTab = browser.tabs.create({ url: 'browser://settings', background: true });
    await until(() => !tab(settingsTab).state.loading);
    await wait(500);
    browser.push();
    await wait(300);
    const inner = await rest(settingsTab);
    check('an internal page\'s card names it as Static\'s own', !!inner && /Static/.test(inner.site), JSON.stringify(inner));
    browser.tabs.close(settingsTab);
    await leave();

    // ---- Tab search: a title that is markup, another workspace -----------
    organizer.store.data.workspaces.push({ id: 'probe-ws', name: 'Holiday' });
    const away = browser.tabs.create({ url: base + '/Faraway', background: true, workspaceId: 'probe-ws' });
    await until(() => !tab(away).state.loading);
    browser.push();
    await wait(400);
    key(chrome(), 'A', [mod, 'shift']);
    check('the shortcut opens tab search', !!(await listOpen()));
    let list = await until(async () => { const r = await rows(); return r.length ? r : null; });
    check('tabs in every workspace are listed', list?.length === browser.tabs.order.length, JSON.stringify(list?.map((r) => r.title)));
    check('each says which workspace it is in', list?.find((r) => /Faraway/.test(r.title))?.workspace === 'Holiday', JSON.stringify(list));
    const bad = list?.find((r) => /Evil|onerror/.test(r.title));
    check('a title that is markup is listed as text', !!bad && !/<img/i.test(bad.html), JSON.stringify(bad));
    check('nothing in a page title ran in the overlay', !(await overlay().executeJavaScript('!!window.__pwned')));
    overlay().insertText('farawy');
    await wait(200);
    key(overlay(), 'Return');
    await until(() => browser.tabs.activeId === away);
    check('choosing a tab in another workspace goes there', browser.tabs.activeId === away && browser.tabs.activeWorkspace === 'probe-ws', browser.tabs.activeWorkspace);
    browser.tabs.select(first);
    browser.tabs.close(away);
    organizer.store.data.workspaces = organizer.store.data.workspaces.filter((w) => w.id !== 'probe-ws');
    browser.push();
    await wait(400);

    // ---- Closing the tab you are on, from the list -------------------------
    browser.tabs.select(ids.charlie);
    await wait(400);
    key(chrome(), 'A', [mod, 'shift']);
    await listOpen();
    await wait(300);
    const shut = await overlay().executeJavaScript(`(() => { const r = [...document.querySelectorAll('.ts-row')].find((n) => n.classList.contains('is-current'));
      const b = r.querySelector('.ts-close').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
    move(overlay(), shut.x, shut.y);
    await wait(80);
    overlay().sendInputEvent({ type: 'mouseDown', x: shut.x, y: shut.y, button: 'left', clickCount: 1 });
    overlay().sendInputEvent({ type: 'mouseUp', x: shut.x, y: shut.y, button: 'left', clickCount: 1 });
    await until(() => !browser.tabs.tabs.has(ids.charlie));
    await wait(400);
    list = await rows();
    check('closing the current tab from the list closes it', !browser.tabs.tabs.has(ids.charlie));
    check('the list stays open, over the tab that took its place', list.length === browser.tabs.order.length && browser.overlayInteractive
      && browser.window.contentView.children.at(-1) === browser.overlay, JSON.stringify(list.map((r) => r.title)));
    check('the new current tab is marked', await overlay().executeJavaScript(`[...document.querySelectorAll('.ts-row.is-current')].length === 1`));
    await closeMenu();

    // ---- A long list -----------------------------------------------------------
    const many = [];
    for (let i = 0; i < 40; i++) many.push(browser.tabs.create({ url: base + '/Page ' + i, background: true }));
    await until(() => many.every((id) => !tab(id).state.loading), 80);
    browser.push();
    await wait(500);
    key(chrome(), 'A', [mod, 'shift']);
    await listOpen();
    await wait(300);
    const fits = await overlay().executeJavaScript(`(() => { const m = document.querySelector('.menu').getBoundingClientRect(); const l = document.querySelector('.ts-list');
      return { bottom: m.bottom, h: innerHeight, scrolls: l.scrollHeight > l.clientHeight }; })()`);
    check('a long list stays inside the window and scrolls', fits.bottom <= fits.h && fits.scrolls, JSON.stringify(fits));
    for (let i = 0; i < 25; i++) key(overlay(), 'Down');
    await wait(300);
    const seen = await overlay().executeJavaScript(`(() => { const r = document.querySelector('.ts-row.is-selected').getBoundingClientRect(); const l = document.querySelector('.ts-list').getBoundingClientRect();
      return r.top >= l.top - 1 && r.bottom <= l.bottom + 1; })()`);
    check('the chosen row is kept in view as the arrows go down', seen);
    const t0 = Date.now();
    overlay().insertText('page 3');
    await until(() => overlay().executeJavaScript(`document.querySelector('.ts-count').textContent.includes(' of ')`), 20, 10);
    const took = Date.now() - t0;
    list = await rows();
    check('typing narrows a long list at once', took < 400 && /Page 3/.test(list[0]?.title || ''), took + 'ms ' + JSON.stringify(list.slice(0, 3).map((r) => r.title)));
    await closeMenu();
    for (const id of many) browser.tabs.close(id);
    browser.push();
    await wait(400);

    // ---- A request with nonsense in it ----------------------------------------
    const odd = await chrome().executeJavaScript(`Promise.all([
      window.browser.invoke('tabs:preview', { id: ${JSON.stringify(ids.bravo)}, anchor: { left: 'x', right: {}, top: null } }).then((r) => !!r, () => 'threw'),
      window.browser.invoke('tabs:preview', { id: 42 }).then((r) => r, () => 'threw'),
      window.browser.invoke('tabs:search-close', { id: 'nope' }).then((r) => Array.isArray(r), () => 'threw'),
      window.browser.invoke('tabs:mute', { ids: 'all' }).then((r) => r, () => 'threw'),
    ])`);
    check('nonsense in a request is turned away without harm', odd[1] === false && odd[2] === true && odd[3] === false && browser.tabs.order.length === 3, JSON.stringify(odd));
    await chrome().executeJavaScript(`window.browser.invoke('tabs:preview', { id: null })`);
    await gone();

    // ---- A tab gets its picture while on screen, for when it is not -------------
    // Only the first tab paints in an off-screen window, so it is the one
    // that moves to a new page, sits for a moment, and is then left.
    browser.tabs.select(first);
    browser.tabs.navigate(first, base + '/Delta');
    await until(() => /Delta/.test(tab(first).state.displayUrl) && !tab(first).state.loading);
    const settled = await until(() => /Delta/.test(browser.thumbs.get(first)?.url || ''), 40, 100);
    check('the tab on screen has its picture taken once its page settles, unasked', !!settled);
    browser.tabs.select(ids.bravo);
    browser.push();
    await wait(500);
    const delta = await rest(first);
    const pictured = await until(() => overlay().executeJavaScript(`!!document.querySelector('.tab-card .tc-img') && !document.querySelector('.tc-shot.is-pending')`), 20, 100);
    check('so its card shows that picture once it is in the background', !!delta && /Delta/.test(delta.title) && !!pictured, JSON.stringify(delta));
    await leave();
    browser.tabs.select(first);
    await wait(300);

    // ---- Previews off: nothing is photographed -----------------------------------
    // Switched off the way Settings does it: the pictures already kept go too.
    await chrome().executeJavaScript(`window.browser.invoke('settings:update', { tabPreviews: false })`);
    check('switching previews off forgets every picture kept', browser.thumbs.size === 0, browser.thumbs.size);
    browser.tabs.select(ids.bravo);
    await wait(300);
    browser.tabs.select(first);
    await wait(1800);
    check('with previews off, switching tabs keeps no pictures', browser.thumbs.size === 0, JSON.stringify([...browser.thumbs].map(([k, v]) => [k === first ? 'first' : k === ids.bravo ? 'bravo' : k, Date.now() - v.at, v.url])));
    browser.tabs.navigate(first, base + '/Echo');
    await until(() => /Echo/.test(tab(first).state.displayUrl) && !tab(first).state.loading);
    await wait(1500);
    check('nor when a page loads', browser.thumbs.size === 0, browser.thumbs.size);
    await chrome().executeJavaScript(`window.browser.invoke('settings:update', { tabPreviews: true })`);

    // ---- Muting a sleeping tab ---------------------------------------------------
    await organizer.sleep([ids.bravo]);
    const asleep = organizer.sleeping.has(ids.bravo);
    const muted = await chrome().executeJavaScript(`window.browser.invoke('tabs:mute', { ids: [${JSON.stringify(ids.bravo)}], muted: true })`);
    check('a sleeping tab can be muted too', !asleep || (muted === true && tab(ids.bravo).view.webContents.isAudioMuted()), JSON.stringify({ asleep, muted }));
    if (asleep) await organizer.wake(ids.bravo);
    browser.tabs.setMuted(ids.bravo, false);

    // ---- A crowded strip, and tabs folded to icons down the side ----------------
    // Sound is marked by hand here (tests/tabtouches.cjs plays the real thing):
    // these checks are about where the speaker fits when room runs out.
    const crowd = [];
    for (let i = 0; i < 16; i++) crowd.push(browser.tabs.create({ url: base + '/Crowd ' + i, background: true }));
    await until(() => crowd.every((id) => !tab(id).state.loading), 80);
    tab(crowd[3]).state.audible = true;
    browser.tabs.setMuted(crowd[5], true);
    browser.push();
    await wait(600);
    const squeezed = await chrome().executeJavaScript(`(() => { const one = (id) => { const n = document.querySelector('.tab[data-id="' + id + '"]');
      const s = n.querySelector('.tab-sound'); const b = n.getBoundingClientRect(); const sb = s && s.getBoundingClientRect();
      return { w: Math.round(b.width), narrow: n.classList.contains('narrow'), sound: !!s && sb.width > 0 && sb.right <= b.right + 0.5 && sb.left >= b.left - 0.5 }; };
      return [one(${JSON.stringify(crowd[3])}), one(${JSON.stringify(crowd[5])})]; })()`);
    check('on a squeezed tab the speaker still fits inside it, playing or muted', squeezed.every((s) => s.sound), JSON.stringify(squeezed));
    const strip = await chrome().executeJavaScript(`(() => { const b = document.getElementById('tabs').getBoundingClientRect(); return { x: 0, y: Math.floor(b.top), width: innerWidth, height: Math.ceil(b.height) + 4 }; })()`);
    const stripShot = await browser.chrome.webContents.capturePage(strip);
    require('node:fs').writeFileSync(require('node:path').join(app.getAppPath(), 'shots', 'tabtouchesedge-crowded.png'), stripShot.toPNG());

    browser.settings.update({ tabLayout: 'vertical', verticalTabsCollapsed: true });
    browser.applyTabLayout();
    browser.layout();
    browser.push();
    await until(() => browser.vtabs && !browser.vtabs.webContents.isLoading());
    await wait(900);
    const folded = await browser.vtabs.webContents.executeJavaScript(`(() => {
      const badge = (id) => { const n = document.querySelector('[data-id="' + id + '"] .vt-sound-badge'); return !!n && getComputedStyle(n).display !== 'none' && n.getBoundingClientRect().width > 0; };
      const head = document.querySelector('.vt-head').getBoundingClientRect(); const search = document.getElementById('search').getBoundingClientRect();
      return { playing: badge(${JSON.stringify(crowd[3])}), muted: badge(${JSON.stringify(crowd[5])}), searchFits: search.width > 0 && search.right <= head.right + 0.5 && search.left >= head.left - 0.5 }; })()`);
    check('folded to icons, sound shows as a badge on the icon', folded.playing && folded.muted, JSON.stringify(folded));
    check('and the search button still fits in the folded header', folded.searchFits, JSON.stringify(folded));
    const sideShot = await browser.vtabs.webContents.capturePage();
    require('node:fs').writeFileSync(require('node:path').join(app.getAppPath(), 'shots', 'tabtouchesedge-folded.png'), sideShot.toPNG());
    browser.settings.update({ tabLayout: 'horizontal', verticalTabsCollapsed: false });
    browser.applyTabLayout();
    browser.layout();
    for (const id of crowd) browser.tabs.close(id);
    browser.push();
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  } finally {
    browser.settings.update({ tabLayout: 'horizontal', tabPreviews: true });
    browser.sessionStore.save({ tabs: [], savedAt: 0 });
    organizer.groups = [];
    server.close();
  }
  console.log(fails ? '\nFAILURES: ' + fails : '\nall tab touch edge checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
