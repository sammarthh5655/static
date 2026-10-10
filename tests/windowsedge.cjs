const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

/**
 * The corners of more than one window that tests/windows.cjs does not walk
 * through: tabs down the side in two windows at once, find in page, split
 * view's own menu, the sidebar, a link opened in a new window from a page's
 * right-click menu, the unlock and passkey questions asked in the window
 * whose page asked - and windows closed while a question, a menu or a hover
 * card is still up in them. Then Exit with three windows open, and a second
 * launch that has to bring all three back, the one in front in front.
 *
 *   node scripts/start.cjs --windowsedge     (twice: the second run checks the restore)
 *
 * Every window is off-screen and unfocusable. Pictures land in
 * shots/windowsedge-*.png.
 */

const page = (title, body = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font:16px/1.5 system-ui,sans-serif;margin:40px;background:#fbfaf7;color:#222"><h1>${title}</h1>${body}</body></html>`;
const LINKS = page('Links', '<p>Some words to find: lantern, lantern, lantern.</p><p><a id="lnk" href="/Linked" style="font-size:28px">A link to follow</a></p>');
const PASSKEY = `<!doctype html><title>Passkey here</title><h1>Passkey here</h1>
<script>
window.register = async () => {
  try {
    const cred = await navigator.credentials.create({ publicKey: {
      rp: { name: 'Local test' }, user: { id: new Uint8Array([9, 9, 9]), name: 'edge@local', displayName: 'Edge' },
      challenge: crypto.getRandomValues(new Uint8Array(32)), pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' } } });
    return { ok: true, id: cred.id };
  } catch (e) { return { ok: false, name: e.name }; }
};
</script>`;

async function run(browser) {
  const { app, nativeImage } = require('electron');
  const shots = path.join(app.getAppPath(), 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const marker = path.join(app.getPath('userData'), 'windowsedge-phase.json');
  let fails = 0;
  const check = (name, ok, detail) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + name + (detail !== undefined && !ok ? ' :: ' + String(detail).slice(0, 400) : ''));
    if (!ok) fails++;
  };
  // A main-process error must be counted here, not shown in a dialog on
  // someone's screen.
  const crashes = [];
  process.on('uncaughtException', (error) => { crashes.push(error.stack || String(error)); console.error('uncaught', error); });
  process.on('unhandledRejection', (error) => { crashes.push(String(error?.stack || error)); console.error('unhandled', error); });
  const until = async (fn, tries = 50, every = 120) => {
    for (let i = 0; i < tries; i++) {
      const value = await Promise.resolve().then(fn).catch(() => null);
      if (value) return value;
      await wait(every);
    }
    return null;
  };
  const open = () => browser.windows.filter((w) => !w.closed);
  const isMac = process.platform === 'darwin';
  const mod = isMac ? 'meta' : 'control';
  const js = (wc, code) => wc.executeJavaScript(code, true);
  const press = (wc, keyCode, modifiers = []) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
  const type = async (wc, text) => {
    for (const ch of text) { wc.sendInputEvent({ type: 'char', keyCode: ch }); await wait(15); }
  };
  const click = async (wc, x, y, { button = 'left' } = {}) => {
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    await wait(40);
    wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1 });
    await wait(160);
  };
  const ready = (w) => until(async () => w.overlayReady && !w.chrome.webContents.isLoading()
    && (await js(w.chrome.webContents, `document.querySelectorAll('#tabs .tab').length`)) === w.tabs.order.length, 80);
  const loaded = (w, id) => until(() => {
    const tab = w.tabs.tabs.get(id);
    return tab && !tab.state.loading && /^http/.test(tab.state.url) && !tab.view.webContents.isLoading();
  }, 80);
  const menuOpen = (w) => until(() => js(w.overlay.webContents, `!!document.querySelector('.menu')`));
  const noMenu = async (w) => !(await js(w.overlay.webContents, `!!document.querySelector('.menu')`).catch(() => false));
  const closeMenu = async (w) => {
    await js(w.overlay.webContents, 'window.ui.closeMenu(), true').catch(() => {});
    await until(() => noMenu(w));
    await wait(150);
  };
  const choose = async (w, label) => {
    const at = await until(() => js(w.overlay.webContents, `(() => {
      const row = [...document.querySelectorAll('.menu .menu-item')].find((n) => (n.querySelector('.menu-label')?.firstChild?.textContent || '') === ${JSON.stringify(label)});
      if (!row) return null; const b = row.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`));
    if (!at) return false;
    await click(w.overlay.webContents, at.x, at.y);
    return true;
  };
  const labels = (items) => (items || []).map((i) => i.label || (i.heading ? '#' + i.heading : '')).filter(Boolean);
  const invokeFrom = (wc, channel, payload) => Promise.race([
    js(wc, `window.browser.invoke(${JSON.stringify(channel)}, ${JSON.stringify(payload ?? null)})`),
    wait(5000).then(() => 'no answer'),
  ]);
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

  /* ---- second launch: what came back ------------------------------------ */
  if (fs.existsSync(marker)) {
    const expected = JSON.parse(fs.readFileSync(marker, 'utf8'));
    fs.rmSync(marker, { force: true });
    try {
      await until(() => open().length === expected.windows.length, 80);
      for (const w of open()) await ready(w);
      const pathsOf = (w) => w.tabs.list().map((t) => { try { return decodeURIComponent(new URL(t.url).pathname); } catch { return t.url; } });
      const got = open().map(pathsOf);
      check('a second launch opens every window that was open at Exit', open().length === expected.windows.length, JSON.stringify(got));
      const sorted = (list) => list.map((p) => p.join('|')).sort();
      check('each with the tabs it had, in their order', JSON.stringify(sorted(got)) === JSON.stringify(sorted(expected.windows)), JSON.stringify({ got, expected: expected.windows }));
      const front = browser.front;
      check('the window that was in front is in front again', JSON.stringify(pathsOf(front)) === JSON.stringify(expected.front), JSON.stringify({ front: pathsOf(front), expected: expected.front }));
      const pinned = open().flatMap((w) => w.tabs.list().filter((t) => t.pinned).map((t) => decodeURIComponent(new URL(t.url).pathname)));
      check('pinned tabs come back pinned', JSON.stringify(pinned) === JSON.stringify(expected.pinned), JSON.stringify(pinned));
      const group = browser.productivity.organizer.groups.find((g) => g.name === expected.group.name);
      const holder = group && open().find((w) => w.tabs.list().some((t) => t.groupId === group.id));
      check('the group comes back with its name and colour, in its window', !!group && group.color === expected.group.color && !!holder
        && JSON.stringify(pathsOf(holder)) === JSON.stringify(expected.group.window), JSON.stringify(browser.productivity.organizer.groups));
      const later = open().filter((w) => w !== open()[0]);
      check('the windows that come back with it play no entrance', later.every((w) => !browser.state(w).window.arriving));
    } catch (error) {
      console.error('FAIL  probe crashed:', error.stack || error.message);
      fails++;
    }
    check('nothing went wrong in main', !crashes.length, crashes.join('\n---\n'));
    console.log('\n' + (fails ? fails + ' check(s) failed' : 'all checks passed'));
    app.exit(fails ? 1 : 0);
    return;
  }

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    const name = decodeURIComponent(req.url.slice(1).split('?')[0]);
    res.end(name === 'links' ? LINKS : name === 'passkey' ? PASSKEY : page(name || 'Home', '<p>' + 'Plain words. '.repeat(30) + '</p>'));
  });
  // localhost: a passkey's relying party cannot be an IP address.
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://localhost:' + server.address().port;

  let quitHandled = false;
  try {
    await wait(1200);
    browser.onboarding.complete();
    browser.settings.update({ tabLayout: 'horizontal', sidebarMode: 'off', tabPreviews: true, bookmarksBar: false, onStartup: 'restore', animations: true });
    for (const w of open()) { w.applySidebarMode(); w.applyTabLayout(); }
    for (const w of open().slice(1)) w.window.close();
    await until(() => open().length === 1);
    const A = open()[0];
    for (const extra of A.tabs.order.slice(1)) A.tabs.close(extra);
    await ready(A);
    const a1 = A.tabs.active.id;
    A.tabs.navigate(a1, base + '/Alpha');
    await loaded(A, a1);

    // A second window, from the keyboard in the first window's address bar.
    press(A.chrome.webContents, 'n', [mod]);
    const B = await until(() => open().find((w) => w !== A));
    if (!B) throw new Error('no second window');
    await ready(B);
    check('Ctrl+N in the chrome opens a window', open().length === 2 && browser.front === B);
    const b1 = B.tabs.active.id;
    B.tabs.navigate(b1, base + '/links');
    await loaded(B, b1);
    await wait(300);
    check('each window\'s system title follows its own page', /Links/.test(B.window.getTitle()) && /Alpha/.test(A.window.getTitle()), B.window.getTitle() + ' | ' + A.window.getTitle());

    /* ---- find in page, in the window it was asked in ------------------- */
    press(B.tabs.tabs.get(b1).view.webContents, 'f', [mod]);
    await until(() => B.findBar && !B.findBar.webContents.isLoading());
    check('Ctrl+F in the second window\'s page opens its find bar, and only its', !!B.findBar && !A.findBar);
    await wait(300);
    await js(B.findBar.webContents, `(() => { const i = document.querySelector('#query'); i.value = 'lantern'; i.dispatchEvent(new Event('input')); })()`);
    const count = await until(() => js(B.findBar.webContents, `document.querySelector('#count').textContent`).then((t) => /of 3/.test(t) && t));
    check('it searches that window\'s page', !!count, count);
    press(B.findBar.webContents, 'Escape');
    await until(() => !B.findBar);
    check('Escape closes it', !B.findBar);

    /* ---- a link opened in a new window from the page's own menu -------- */
    const link = await js(B.tabs.tabs.get(b1).view.webContents, `(() => { const b = document.getElementById('lnk').getBoundingClientRect(); return { x: Math.round(b.left + 20), y: Math.round(b.top + b.height / 2) }; })()`);
    B.lastMenu = null; B.lastPageMenu = null;
    await click(B.tabs.tabs.get(b1).view.webContents, link.x, link.y, { button: 'right' });
    await menuOpen(B);
    const pageItems = labels(B.lastPageMenu?.items);
    check('right-clicking a link in the second window opens its menu there', pageItems.includes('Open link in new window') && await noMenu(A), pageItems.join(' | '));
    await composite('windowsedge-link-menu', B);
    await choose(B, 'Open link in new window');
    const L = await until(() => open().find((w) => w !== A && w !== B));
    check('Open link in new window opens a window with that page', !!L && L.tabs.order.length === 1 && /\/Linked$/.test(L.tabs.active.state.displayUrl), L && L.tabs.active?.state.displayUrl);
    if (L) {
      await ready(L);
      await loaded(L, L.tabs.activeId);
      check('and the windows it came from keep their tabs', A.tabs.order.length === 1 && B.tabs.order.length === 1);
      // Ctrl+N with that window's menu open, from its overlay.
      press(L.chrome.webContents, 'F10');
      await menuOpen(L);
      press(L.overlay.webContents, 'n', [mod]);
      const M = await until(() => open().find((w) => ![A, B, L].includes(w)));
      check('Ctrl+N pressed while a menu is open opens a window too', !!M);
      if (M) { await ready(M); M.window.close(); await until(() => M.closed); }
      L.window.close();
      await until(() => L.closed);
    }

    /* ---- tabs down the side, in both windows --------------------------- */
    await invokeFrom(A.chrome.webContents, 'settings:update', { tabLayout: 'vertical' });
    await until(() => A.vtabs && B.vtabs && !A.vtabs.webContents.isLoading() && !B.vtabs.webContents.isLoading());
    check('turning on tabs down the side reaches every window', !!A.vtabs && !!B.vtabs);
    const b2 = await invokeFrom(B.chrome.webContents, 'tabs:new', { url: base + '/Bravo two' });
    await loaded(B, b2);
    const row = await until(() => js(B.vtabs.webContents, `(() => { const n = document.querySelector('.vt-tab[data-id="${b1}"]');
      if (!n) return null; const b = n.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`), 60);
    check('the second window\'s side list draws its tabs', !!row && (await js(B.vtabs.webContents, `document.querySelectorAll('.vt-tab').length`)) === 2
      && (await js(A.vtabs.webContents, `document.querySelectorAll('.vt-tab').length`)) === 1);
    if (row) {
      B.lastMenu = null;
      await click(B.vtabs.webContents, row.x, row.y, { button: 'right' });
      await menuOpen(B);
      check('right-clicking a tab down the side opens its menu in that window', labels(B.lastMenu?.items).includes('Move tab to another window') && await noMenu(A), labels(B.lastMenu?.items).join(' | '));
      await composite('windowsedge-vtabs-menu', B);
      await closeMenu(B);
      // Rest the pointer on the other row: a hover card, in this window.
      const other = await js(B.vtabs.webContents, `(() => { const n = document.querySelector('.vt-tab[data-id="${b2}"]'); const b = n.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
      B.vtabs.webContents.sendInputEvent({ type: 'mouseMove', x: other.x - 5, y: other.y });
      await wait(60);
      B.vtabs.webContents.sendInputEvent({ type: 'mouseMove', x: other.x, y: other.y });
      const card = await until(() => B.preview, 40);
      check('resting on a tab down the side shows its hover card in that window', card?.id === b2 && !A.preview, JSON.stringify({ b: B.preview, a: A.preview }));
      await composite('windowsedge-vtabs-preview', B);
      // A window closing with its hover card still up.
      const extra = browser.openWindow({ from: B });
      await ready(extra);
      browser.moveTabs([b2], B, extra.id);
      await until(() => extra.tabs.tabs.has(b2));
      check('a tab moved to another window down the side shows up in that window\'s list',
        !!(await until(() => js(extra.vtabs.webContents, `!!document.querySelector('.vt-tab[data-id="${b2}"]')`))) && !B.tabs.tabs.has(b2));
      await wait(1200);
      const rows = await js(extra.vtabs.webContents, `(() => { const n = document.querySelector('.vt-tab[data-id="${b2}"]'); const b = n.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
      extra.vtabs.webContents.sendInputEvent({ type: 'mouseMove', x: rows.x - 5, y: rows.y });
      await wait(60);
      extra.vtabs.webContents.sendInputEvent({ type: 'mouseMove', x: rows.x, y: rows.y });
      await until(() => extra.preview, 40);
      extra.window.close();
      await until(() => extra.closed);
      check('closing a window with a hover card up goes quietly', extra.closed && !crashes.length, crashes.join(' / '));
    }
    await invokeFrom(B.chrome.webContents, 'settings:update', { tabLayout: 'horizontal' });
    await until(() => !A.vtabs && !B.vtabs);
    check('and turning it off takes the side list out of every window', !A.vtabs && !B.vtabs);

    /* ---- split view's own menu, and the sidebar ------------------------- */
    const b3 = await invokeFrom(B.chrome.webContents, 'tabs:new', { url: base + '/Bravo three' });
    await loaded(B, b3);
    B.tabs.select(b1);
    await invokeFrom(B.chrome.webContents, 'split:with', { id: b3 });
    await until(() => B.splitDivider && !B.splitDivider.webContents.isLoading());
    check('split view in the second window gets its own divider', !!B.splitDivider && !A.splitDivider);
    B.lastMenu = null;
    await invokeFrom(B.splitDivider.webContents, 'split:menu', { x: 4, y: 120 });
    await menuOpen(B);
    check('the divider\'s menu opens in its window', labels(B.lastMenu?.items).includes('Swap sides') && await noMenu(A));
    await choose(B, 'Exit split view');
    await wait(250);
    check('and its choices act on that window\'s pair', !B.tabs.pairOf(b1));
    browser.settings.update({ sidebarMode: 'on' });
    for (const w of open()) w.applySidebarMode();
    await until(() => B.sidebar && !B.sidebar.webContents.isLoading() && A.sidebar && !A.sidebar.webContents.isLoading());
    const panelB = await invokeFrom(B.sidebar.webContents, 'sidebar:panel', { id: 'organizer' });
    const panelA = await invokeFrom(A.sidebar.webContents, 'sidebar:panel', { id: 'organizer' });
    const tabsIn = (panel) => panel?.rows?.find((r) => r.label === 'Open tabs')?.value;
    check('each window\'s sidebar speaks for its own tabs', tabsIn(panelB) === String(B.tabs.order.length) && tabsIn(panelA) === String(A.tabs.order.length),
      tabsIn(panelB) + ' ' + tabsIn(panelA));
    const permission = await invokeFrom(B.sidebar.webContents, 'ai:page-permission', {});
    check('and reads its own window\'s page', /Links|links/.test(permission?.url || '') || /Bravo/.test(permission?.url || ''), JSON.stringify(permission));
    await invokeFrom(B.sidebar.webContents, 'sidebar:toggle', { open: false });
    check('closing the sidebar from inside it closes that window\'s only', !B.sidebarOpen && A.sidebarOpen);
    browser.settings.update({ sidebarMode: 'off' });
    for (const w of open()) w.applySidebarMode();

    /* ---- tab search names the first window too -------------------------- */
    B.lastMenu = null;
    press(B.tabs.tabs.get(b1).view.webContents, 'a', [mod, 'shift']);
    const search = await until(() => B.lastMenu?.items?.[0]?.tabsearch);
    const others = (search?.tabs || []).filter((r) => r.elsewhere);
    check('tab search from the second window lists the first window\'s tabs as Window 1', others.length === A.tabs.order.length && others.every((r) => r.elsewhere.name === 'Window 1'), JSON.stringify(others.map((r) => r.elsewhere)));
    await closeMenu(B);

    /* ---- the unlock question, in the window whose page needs it --------- */
    const V = browser.passwords;
    browser.biometric.testAnswer = 'approve';
    if (V.hasMaster) { V.key = null; V.data.lock = null; V.save(); }
    V.clear();
    V.save_credential({ url: base, username: 'edge@local', password: 'quiet harbour 77' });
    const MASTER = 'amber Quartz 9 lighthouse';
    await V.setMaster(MASTER);
    V.lock();
    B.tabs.select(b1);
    await wait(200);
    B.lastMenu = null; A.lastMenu = null;
    await invokeFrom(B.chrome.webContents, 'passwords:key-menu', {});
    await menuOpen(B);
    const fill = (B.lastMenu?.items || []).find((i) => i.label === 'edge@local');
    check('the key in the second window\'s address bar lists what is saved for its page', !!fill && !A.lastMenu, labels(B.lastMenu?.items).join(' | '));
    if (fill) {
      invokeFrom(B.overlay.webContents, fill.action.channel, fill.action.payload);
      const asked = await until(() => (B.lastMenu?.items || []).some((i) => /Unlock to fill/.test(i.heading || '')));
      check('filling a locked password asks to unlock in that window', !!asked && !A.lastMenu && await noMenu(A), labels(B.lastMenu?.items).join(' | '));
      await composite('windowsedge-unlock', B);
      // The window closes with the question still up: it is let go, not left waiting.
      const wcB = B.chrome.webContents;
      B.window.close();
      await until(() => B.closed);
      await wait(400);
      check('closing a window while it asks to unlock goes quietly', B.closed && wcB.isDestroyed() && !crashes.length && ![...browser.prompts.values()].some((p) => p.w === B), crashes.join(' / '));
      check('and the other window carries on', !A.closed && browser.front === A && open().length === 1);
    }
    await V.unlock(MASTER);

    /* ---- the passkey question, in the window whose page asked ----------- */
    press(A.tabs.active.view.webContents, 'n', [mod]);
    const P = await until(() => open().find((w) => w !== A));
    if (!P) throw new Error('no window for the passkey');
    await ready(P);
    const p1 = P.tabs.activeId;
    P.tabs.navigate(p1, base + '/passkey');
    await loaded(P, p1);
    await wait(400);
    browser.autofill.setPrefs({ passkeys: true });
    A.lastMenu = null; P.lastMenu = null;
    const asking = js(P.tabs.tabs.get(p1).view.webContents, 'window.register()').catch((e) => ({ ok: false, name: String(e) }));
    const passkeyMenu = await until(() => (P.lastMenu?.items || []).some((i) => /Create a passkey/.test(i.heading || '')));
    check('a page asking for a passkey is asked about it in its own window', !!passkeyMenu && !A.lastMenu && await noMenu(A), labels(P.lastMenu?.items).join(' | '));
    await composite('windowsedge-passkey', P);
    P.window.close();
    await until(() => P.closed);
    const answer = await Promise.race([asking, wait(3000).then(() => 'still waiting')]);
    check('closing that window while it asks lets the question go', P.closed && !crashes.length && ![...browser.prompts.values()].some((p) => p.w === P), JSON.stringify(answer) + ' ' + crashes.join(' / '));
    V.clear();
    V.key = null; V.data.lock = null; V.save();

    /* ---- closing a window with a menu open in it ------------------------ */
    press(A.tabs.active.view.webContents, 'n', [mod]);
    const Q = await until(() => open().find((w) => w !== A));
    await ready(Q);
    press(Q.chrome.webContents, 'F10');
    await menuOpen(Q);
    await invokeFrom(Q.overlay.webContents, 'window:control', { action: 'close' });
    await until(() => Q.closed);
    check('closing a window from its own menu, menu and all, goes quietly', Q.closed && !crashes.length && open().length === 1, crashes.join(' / '));

    /* ---- the first window closes; the one opened from it carries on ---- */
    press(A.tabs.active.view.webContents, 'n', [mod]);
    const R = await until(() => open().find((w) => w !== A));
    await ready(R);
    const r1 = R.tabs.activeId;
    R.tabs.navigate(r1, base + '/Romeo');
    await loaded(R, r1);
    A.window.close();
    await until(() => A.closed);
    check('closing the first window leaves the second in front', A.closed && browser.front === R && open().length === 1);
    press(R.tabs.tabs.get(r1).view.webContents, 't', [mod]);
    await until(() => R.tabs.order.length === 2);
    check('and its keys still work', R.tabs.order.length === 2);
    R.tabs.close(R.tabs.activeId);
    press(R.tabs.tabs.get(r1).view.webContents, 'n', [mod]);
    const S = await until(() => open().find((w) => w !== R));
    check('and a new window still opens from it', !!S);
    await ready(S);

    /* ---- three windows, then Exit -------------------------------------- */
    // R: Romeo (pinned) + Romeo two; S: Sierra one, Sierra two (grouped); T: Tango.
    const r2 = await invokeFrom(R.chrome.webContents, 'tabs:new', { url: base + '/Romeo two' });
    await invokeFrom(R.chrome.webContents, 'organizer:pin', { ids: [r1], pinned: true });
    const s1 = S.tabs.activeId;
    S.tabs.navigate(s1, base + '/Sierra one');
    const s2 = await invokeFrom(S.chrome.webContents, 'tabs:new', { url: base + '/Sierra two' });
    await invokeFrom(S.chrome.webContents, 'organizer:assign', { ids: [s1, s2], groupId: 'new', name: 'Sierra set' });
    press(S.tabs.tabs.get(s2).view.webContents, 'n', [mod]);
    const T = await until(() => open().find((w) => w !== R && w !== S));
    await ready(T);
    T.tabs.navigate(T.tabs.activeId, base + '/Tango');
    await loaded(T, T.tabs.activeId);
    await loaded(R, r2); await loaded(S, s2);
    // S is the one in use when Exit is chosen.
    press(S.tabs.tabs.get(s2).view.webContents, 'F10');
    await menuOpen(S);
    check('the window Exit is chosen in is in front', browser.front === S);
    const pathsOf = (w) => w.tabs.list().map((t) => decodeURIComponent(new URL(t.url).pathname));
    const group = browser.productivity.organizer.groups.find((g) => g.name === 'Sierra set');
    const expected = {
      windows: [R, S, T].map(pathsOf), front: pathsOf(S), pinned: ['/Romeo'],
      group: { name: 'Sierra set', color: group?.color, window: pathsOf(S) },
    };
    let saved = null;
    app.once('will-quit', (event) => {
      event.preventDefault();
      quitHandled = true;
      saved = structuredClone(browser.sessionStore.data);
      const windowsSaved = Array.isArray(saved?.windows) ? saved.windows.length : 0;
      check('Exit keeps every window in the session for next time', windowsSaved === 3 && new Set(saved.tabs.map((t) => t.window)).size === 3,
        JSON.stringify(saved?.tabs?.map((t) => [t.title, t.window])));
      check('and marks the one in front', saved?.windows?.[saved.tabs.find((t) => /Sierra/.test(t.title))?.window]?.front === true, JSON.stringify(saved?.windows));
      check('nothing went wrong in main', !crashes.length, crashes.join('\n---\n'));
      fs.writeFileSync(marker, JSON.stringify(expected));
      server.close();
      console.log('\n' + (fails ? fails + ' check(s) failed' : 'all checks passed') + ' - run again to check the restore');
      app.exit(fails ? 1 : 0);
    });
    const exit = (S.lastMenu?.items || []).flatMap((i) => i.footer || []).find((i) => i.label === 'Exit');
    await invokeFrom(S.overlay.webContents, exit.action.channel, exit.action.payload);
    await wait(6000);
    if (!quitHandled) check('Exit quits', false);
  } catch (error) {
    console.error('FAIL  probe crashed:', error.stack || error.message);
    fails++;
  }
  if (!quitHandled) {
    server.close();
    console.log('\n' + fails + ' check(s) failed');
    app.exit(1);
  }
}

module.exports = { run };
