const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

/**
 * The tab strip's motion at its edges, the way people actually trip over
 * them: a pinned tab whose favicon will not load, a middle-click close, a
 * close under an open hover card, clicking the same close button spot twice
 * in a row, the last tab of a group closing, animations switched off half
 * way through a close, a strip that has just filled up, a switch of
 * workspace, a sleeping tab, a Ctrl-click selection, and a row lifted out
 * of the side list at exactly its own size. Real input via sendInputEvent.
 * Runs off-screen.
 *
 *   node scripts/start.cjs --motionedge
 */
const page = (title, icon) => `<!doctype html><html><head><title>${title}</title>${icon ? '<link rel="icon" href="/broken.ico">' : ''}</head><body style="font:16px sans-serif">${title}</body></html>`;

async function run(browser) {
  const { app } = require('electron');
  const shots = path.join(app.getAppPath(), 'shots');
  fs.mkdirSync(shots, { recursive: true });
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d !== undefined && !ok ? ' :: ' + String(d).slice(0, 400) : ''));
    if (!ok) fails++;
  };
  const until = async (fn, tries = 40) => {
    for (let i = 0; i < tries; i++) { const v = await Promise.resolve().then(fn).catch(() => null); if (v) return v; await wait(100); }
    return null;
  };

  const server = http.createServer((req, res) => {
    if (req.url === '/broken.ico') { res.writeHead(404); res.end(); return; }
    const icon = req.url.startsWith('/icon/');
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page(decodeURIComponent(req.url.slice(icon ? 6 : 1)) || 'Home', icon));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;

  const organizer = browser.productivity.organizer;
  const chrome = () => browser.chrome.webContents;
  const vt = () => browser.vtabs.webContents;
  const tab = (id) => browser.tabs.tabs.get(id);
  const savedWorkspaces = structuredClone(organizer.store.data.workspaces);
  const errors = [];
  const listen = (wc, name) => wc.on('console-message', (event) => {
    const level = event?.level;
    if (level === 'error' || level === 3) errors.push(name + ': ' + String(event.message).slice(0, 200));
  });
  listen(chrome(), 'chrome');

  const centre = (wc, selector) => wc.executeJavaScript(`(() => { const n = document.querySelector(${JSON.stringify(selector)});
    if (!n) return null; const b = n.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), w: b.width }; })()`);
  const press = async (wc, x, y, { button = 'left', modifiers = [] } = {}) => {
    wc.sendInputEvent({ type: 'mouseMove', x, y, modifiers });
    await wait(30);
    wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 1, modifiers });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1, modifiers });
  };
  const ghosts = (wc = chrome()) => wc.executeJavaScript(`document.querySelectorAll('.leaving').length`);
  const moving = (wc = chrome()) => wc.executeJavaScript(`document.getAnimations().filter((a) => /^motion-/.test(a.id) && a.playState === 'running').length`);
  /** Every frame for `span` ms: how many ghosts and moves of ours there are. */
  const watch = (wc, span) => wc.executeJavaScript(`new Promise((resolve) => { const seen = []; const t0 = performance.now();
    const tick = (now) => { seen.push({ ghosts: document.querySelectorAll('.leaving').length,
      moves: document.getAnimations().filter((a) => /^motion-/.test(a.id)).length,
      spill: document.getElementById('tabs')?.classList.contains('is-moving') || false });
      if (now - t0 < ${span}) requestAnimationFrame(tick); else resolve(seen); }; requestAnimationFrame(tick); })`);
  const make = async (titles, prefix = '') => {
    const ids = titles.map((t) => browser.tabs.create({ url: base + '/' + prefix + t, background: true }));
    await until(() => ids.every((id) => tab(id) && !tab(id).state.loading && /^http/.test(tab(id).state.url || tab(id).state.displayUrl || '')));
    await wait(300);
    return ids;
  };

  try {
    await wait(1400);
    browser.settings.update({ tabLayout: 'horizontal', theme: 'mercury', animations: true, tabPreviews: true, bookmarksBar: false });
    browser.applyTabLayout();
    organizer.groups = [];
    for (const extra of browser.tabs.order.slice(1)) browser.tabs.close(extra);
    const home = browser.tabs.active.id;
    browser.tabs.navigate(home, base + '/Home');
    await wait(500);

    // ---- A pinned tab whose favicon will not load shows its initial.
    const [alpha] = await make(['Alpha'], 'icon/');
    await until(() => tab(alpha).state.favicon || tab(alpha).favicon, 30);
    await wait(500);
    const look = (id) => chrome().executeJavaScript(`(() => { const n = document.querySelector('.tab[data-id="${id}"]');
      return n ? { letter: n.querySelector('.tab-letter')?.textContent || null, img: !!n.querySelector('img.favicon'), glyph: !!n.querySelector(':scope > svg, :scope > .icon-svg, :scope > span:not(.title):not(.tab-letter) svg') } : null; })()`);
    const unpinnedLook = await look(alpha);
    check('an unpinned tab with a broken favicon shows the plain glyph', unpinnedLook && !unpinnedLook.img && !unpinnedLook.letter, JSON.stringify(unpinnedLook));
    await organizer.pin([alpha], true);
    const pinnedLook = await until(() => look(alpha).then((l) => (l && l.letter ? l : null)), 15);
    check('pinned, it shows its initial instead', pinnedLook?.letter === 'A', JSON.stringify(await look(alpha)));
    await organizer.pin([alpha], false);
    await wait(400);
    const backLook = await look(alpha);
    check('and unpinned again, the glyph comes back', backLook && !backLook.letter && !backLook.img, JSON.stringify(backLook));
    browser.tabs.close(alpha);
    await wait(400);

    // ---- A middle-click close animates like the close button.
    const [m1, m2, m3, m4, m5] = await make(['One', 'Two', 'Three', 'Four', 'Five']);
    const middle = await centre(chrome(), `.tab[data-id="${m2}"]`);
    const seen = watch(chrome(), 160);
    await press(chrome(), middle.x, middle.y, { button: 'middle' });
    const middleFrames = await seen;
    check('a middle-click closes the tab', await until(() => !browser.tabs.tabs.has(m2)));
    check('and it narrows away rather than vanishing', middleFrames.some((f) => f.ghosts > 0), JSON.stringify(middleFrames.slice(0, 4)));
    chrome().sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });
    await wait(500);
    check('no ghost is left after it', (await ghosts()) === 0);

    // ---- A hover card on a tab that closes goes with it.
    const over = await centre(chrome(), `.tab[data-id="${m3}"]`);
    chrome().sendInputEvent({ type: 'mouseMove', x: over.x - 10, y: over.y });
    await wait(40);
    chrome().sendInputEvent({ type: 'mouseMove', x: over.x, y: over.y });
    const carded = await until(() => browser.preview?.id === m3, 25);
    check('resting on a tab brings up its card', !!carded, JSON.stringify(browser.preview));
    chrome().sendInputEvent({ type: 'mouseDown', x: over.x, y: over.y, button: 'middle', clickCount: 1 });
    chrome().sendInputEvent({ type: 'mouseUp', x: over.x, y: over.y, button: 'middle', clickCount: 1 });
    await until(() => !browser.tabs.tabs.has(m3));
    await wait(700);
    check('closing it puts the card away, and none comes up for the ghost', browser.preview?.id !== m3, JSON.stringify(browser.preview));
    chrome().sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });
    await wait(500);

    // ---- Clicking the same spot again closes the tab that slid under it.
    // Titles of one length: tabs here are as wide as their titles, so only
    // then does the next close button land where the last one was.
    const [r1, r2, r3] = await make(['Shade 1', 'Shade 2', 'Shade 3']);
    browser.tabs.select(home);
    await wait(300);
    const spot = await centre(chrome(), `.tab[data-id="${r1}"] .close`);
    await press(chrome(), spot.x, spot.y);
    await until(() => !browser.tabs.tabs.has(r1));
    await wait(260);
    const underneath = await chrome().executeJavaScript(`(() => { const hit = document.elementFromPoint(${spot.x}, ${spot.y});
      return hit?.closest('.close') ? hit.closest('.tab')?.dataset.id || null : 'not a close button: ' + (hit?.className || hit?.tagName); })()`);
    await press(chrome(), spot.x, spot.y);
    await wait(400);
    check('the next tab has slid under the pointer a moment later', underneath === r2, JSON.stringify({ underneath, r2 }));
    check('so a second click there closes it too', !browser.tabs.tabs.has(r2) && browser.tabs.tabs.has(r3), JSON.stringify(browser.tabs.order));
    check('without switching to anything', browser.tabs.active.id === home);
    chrome().sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });
    await wait(400);

    // ---- The last tab of a group closing takes the chip with it.
    await organizer.assign({ ids: [m4], groupId: 'new', value: 'Solo' });
    await wait(500);
    const solo = organizer.groups.find((g) => g.name === 'Solo');
    check('a one-tab group is drawn', !!(await centre(chrome(), `.tab-group[data-group="${solo.id}"] .tab-group-chip`)));
    const groupGoing = watch(chrome(), 200);
    browser.tabs.close(m4);
    const groupFrames = await groupGoing;
    await wait(500);
    check('its chip leaves with its last tab', groupFrames.some((f) => f.ghosts >= 2), JSON.stringify(groupFrames.slice(0, 3)));
    check('and nothing of the group is left behind', await chrome().executeJavaScript(`!document.querySelector('.tab-group, .tab-group-chip, .leaving')`));

    // ---- Animations turned off half way through a close: it lands at once.
    const [h1] = await make(['Halfway']);
    browser.tabs.close(h1);
    await wait(50);
    const midway = await ghosts();
    browser.settings.update({ animations: false });
    browser.push();
    await wait(120);
    check('a close under way when animations are switched off stops at once', midway > 0 && (await ghosts()) === 0 && (await moving()) === 0, JSON.stringify({ midway, now: await ghosts() }));
    browser.settings.update({ animations: true });
    browser.push();
    await wait(300);

    // ---- A sleeping tab keeps its node and shows it is asleep.
    const keep = await chrome().executeJavaScript(`(window.__sleepy = document.querySelector('.tab[data-id="${m5}"]'), !!window.__sleepy)`);
    await organizer.sleep([m5]);
    const asleep = await until(() => chrome().executeJavaScript(`(() => { const n = document.querySelector('.tab[data-id="${m5}"]');
      return n && n.classList.contains('sleeping') && /^◌/.test(n.querySelector('.title').textContent) && n === window.__sleepy; })()`), 20);
    check('a sleeping tab is marked asleep in place', keep && !!asleep);
    await organizer.wake(m5).catch(() => {});
    await wait(300);

    // ---- Ctrl-click picks tabs; a plain click clears the pick.
    const key = process.platform === 'darwin' ? 'meta' : 'control';
    const p1 = await centre(chrome(), `.tab[data-id="${m1}"]`);
    await press(chrome(), p1.x, p1.y, { modifiers: [key] });
    await wait(200);
    const picked = await chrome().executeJavaScript(`[...document.querySelectorAll('.tab.picked')].map((n) => n.dataset.id)`);
    check('Ctrl-click picks a tab out alongside the one you are on', picked.includes(m1) && picked.length === 2, JSON.stringify(picked));
    const homeAt = await centre(chrome(), `.tab[data-id="${home}"]`);
    await press(chrome(), homeAt.x, homeAt.y);
    await wait(200);
    check('and a plain click clears it', (await chrome().executeJavaScript(`document.querySelectorAll('.tab.picked').length`)) === 0);
    chrome().sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });
    await wait(300);

    // ---- Another workspace's tabs simply appear; nothing slides across.
    const space = organizer.workspace('Elsewhere');
    await wait(200);
    const swap = watch(chrome(), 300);
    organizer.selectWorkspace(space.id);
    const swapFrames = await swap;
    check('switching workspace draws its tabs without any movement', swapFrames.every((f) => f.ghosts === 0 && f.moves === 0), JSON.stringify(swapFrames.find((f) => f.ghosts || f.moves)));
    await wait(300);
    const back = watch(chrome(), 300);
    organizer.selectWorkspace(savedWorkspaces[0]?.id || 'main');
    const backFrames = await back;
    check('and switching back the same', backFrames.every((f) => f.ghosts === 0 && f.moves === 0), JSON.stringify(backFrames.find((f) => f.ghosts || f.moves)));
    for (const id of [...browser.tabs.order]) if ((tab(id).workspaceId || 'main') === space.id) browser.tabs.close(id);
    organizer.store.data.workspaces = structuredClone(savedWorkspaces);
    await wait(400);

    // ---- A strip that fills up does not spill over its buttons.
    const crowd = [];
    for (let i = 0; i < 40; i++) crowd.push(browser.tabs.create({ url: 'about:blank', background: true }));
    await wait(900);
    const full = await chrome().executeJavaScript(`(() => { const t = document.getElementById('tabs'); return t.scrollWidth > t.clientWidth + 1; })()`);
    const spilling = watch(chrome(), 250);
    crowd.push(browser.tabs.create({ url: 'about:blank', background: true }));
    const spillFrames = await spilling;
    check('a crowded strip scrolls rather than spilling past its edge while tabs move', full && spillFrames.every((f) => !f.spill), JSON.stringify({ full, spill: spillFrames.filter((f) => f.spill).length }));
    const newtab = await chrome().executeJavaScript(`(() => { const t = document.getElementById('tabs').getBoundingClientRect(); const n = document.getElementById('newtab').getBoundingClientRect(); return n.left >= t.right - 1; })()`);
    check('and the + button stays clear of it', newtab);
    for (const id of crowd) browser.tabs.close(id);
    await wait(900);
    check('closing them all leaves no ghosts', (await ghosts()) === 0);

    // ---- Down the side: a row lifts out at exactly its own size.
    browser.settings.update({ tabLayout: 'vertical', verticalTabsCollapsed: false });
    browser.applyTabLayout();
    await until(() => browser.vtabs && !browser.vtabs.webContents.isLoading() && vt().executeJavaScript(`document.querySelectorAll('.vt-tab').length > 2`));
    listen(vt(), 'vtabs');
    browser.push();
    await wait(600);
    const victim = await vt().executeJavaScript(`[...document.querySelectorAll('#list .vt-tab')].at(-1).dataset.id`);
    const before = await vt().executeJavaScript(`(() => { const b = document.querySelector('.vt-tab[data-id="${victim}"]').getBoundingClientRect(); return { l: b.left, w: b.width, h: b.height }; })()`);
    const lifted = vt().executeJavaScript(`new Promise((resolve) => { const t0 = performance.now();
      const tick = (now) => { const g = document.querySelector('#list > .vt-tab.leaving');
        if (g) { for (const a of g.getAnimations()) { a.pause(); a.currentTime = 0; }
          const b = g.getBoundingClientRect(); resolve({ l: b.left, w: b.width, h: b.height }); return; }
        if (now - t0 > 2000) resolve(null); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick); })`);
    browser.tabs.close(victim);
    const ghost = await lifted;
    check('a closing row is lifted out at exactly its own size and place', ghost && Math.abs(ghost.w - before.w) < 1 && Math.abs(ghost.l - before.l) < 1 && Math.abs(ghost.h - before.h) < 1, JSON.stringify({ before, ghost }));
    await vt().executeJavaScript(`(() => { for (const a of document.getAnimations()) a.play(); return true; })()`);
    await wait(500);
    check('and is gone afterwards', (await ghosts(vt())) === 0);

    // A pinned square with a broken favicon shows its initial too.
    const [beta] = await make(['Beta'], 'icon/');
    await until(() => tab(beta).state.favicon || tab(beta).favicon, 30);
    await wait(400);
    await organizer.pin([beta], true);
    const square = await until(() => vt().executeJavaScript(`document.querySelector('.vt-pin[data-id="${beta}"] .vt-letter')?.textContent || null`), 15);
    check('down the side, a pinned square with a broken favicon shows its initial', square === 'B', square);
    await organizer.pin([beta], false);
    browser.tabs.close(beta);
    await wait(500);

    check('nothing was logged as an error along the way', errors.length === 0, errors.join(' | '));
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  } finally {
    browser.settings.update({ tabLayout: 'horizontal', animations: true, bookmarksBar: false });
    browser.applyTabLayout();
    browser.sessionStore.save({ tabs: [], savedAt: 0 });
    organizer.store.data.workspaces = savedWorkspaces;
    organizer.store.save();
    server.close();
  }
  console.log(fails ? '\nFAILURES: ' + fails : '\nall motion edge checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
