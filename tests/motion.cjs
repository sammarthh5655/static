const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

/**
 * The tab strip's motion, used the way a person uses it: real clicks on a
 * tab's close button and on a group's chip (sendInputEvent), a real
 * right-click for the tab menu, and an HTML5 drag (synthetic DragEvents - a
 * real OS drag would take the user's mouse). Frames are sampled inside the
 * renderer with requestAnimationFrame, so what is measured is what was drawn.
 * Then the same along the side, and with animations switched off (in
 * Static's settings, and as the system's reduced-motion preference).
 * Runs off-screen.
 *
 *   node scripts/start.cjs --motion
 */
const page = (title) => `<!doctype html><html><head><title>${title}</title></head><body style="font:16px sans-serif">${title}</body></html>`;

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
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page(decodeURIComponent(req.url.slice(1)) || 'Home'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;

  const organizer = browser.productivity.organizer;
  const chrome = () => browser.chrome.webContents;
  const overlay = () => browser.overlay.webContents;
  const vt = () => browser.vtabs.webContents;
  const tab = (id) => browser.tabs.tabs.get(id);
  const savedWorkspaces = structuredClone(organizer.store.data.workspaces);

  const click = async (wc, x, y, { button = 'left' } = {}) => {
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    await wait(30);
    wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1 });
  };
  const centre = (wc, selector) => wc.executeJavaScript(`(() => { const n = document.querySelector(${JSON.stringify(selector)});
    if (!n) return null; const b = n.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), w: b.width }; })()`);
  /** Moves of ours still running (shared/motion.js names each one). */
  const running = (wc = chrome()) => wc.executeJavaScript(`document.getAnimations().filter((a) => /^motion-/.test(a.id) && a.playState === 'running').length`);
  /** Keep a reference to every tab node, to see later whether it is the same one. */
  const remember = (wc = chrome(), selector = '#tabs .tab') => wc.executeJavaScript(`(() => {
    window.__kept = new Map([...document.querySelectorAll(${JSON.stringify(selector)})].map((n) => [n.dataset.id, n])); return window.__kept.size; })()`);
  const sameNodes = (ids, wc = chrome(), selector = '.tab') => wc.executeJavaScript(`(() => {
    const ids = ${JSON.stringify(ids)};
    return ids.filter((id) => document.querySelector('${selector}[data-id="' + id + '"]') !== window.__kept.get(id)); })()`);
  /**
   * Sample, every frame, the leaving ghost and a neighbour, from the moment
   * a ghost appears until `span` ms later. Started BEFORE the change.
   */
  const sampleLeaving = (wc, ghostSelector, neighbourSelector, span = 320) => wc.executeJavaScript(`new Promise((resolve) => {
    const out = []; let seen = 0; const t0 = performance.now();
    const tick = (now) => {
      const g = document.querySelector(${JSON.stringify(ghostSelector)});
      const n = document.querySelector(${JSON.stringify(neighbourSelector)});
      if (g && !seen) seen = now;
      if (seen) {
        const gb = g && g.getBoundingClientRect();
        const centre = gb && document.elementFromPoint(gb.left + gb.width / 2, gb.top + gb.height / 2);
        out.push({ t: Math.round(now - seen), ghost: g ? { w: +gb.width.toFixed(1), h: +gb.height.toFixed(1), o: +(+getComputedStyle(g).opacity).toFixed(2),
            hit: !!(centre && g.contains(centre)), id: g.dataset.id || null, pe: getComputedStyle(g).pointerEvents } : null,
          neighbour: n ? getComputedStyle(n).transform : null });
      }
      if ((seen && now - seen > ${span}) || now - t0 > 2500) resolve(out); else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })`);
  const sampleEntering = (wc, selector, span = 260) => wc.executeJavaScript(`new Promise((resolve) => {
    const out = []; let seen = 0; const t0 = performance.now();
    const tick = (now) => {
      const n = document.querySelector(${JSON.stringify(selector)});
      if (n && !seen) seen = now;
      if (seen && n) {
        const cs = getComputedStyle(n);
        out.push({ t: Math.round(now - seen), o: +(+cs.opacity).toFixed(2), clip: cs.clipPath, transform: cs.transform, anims: n.getAnimations().map((a) => a.id).join(',') });
      }
      if ((seen && now - seen > ${span}) || now - t0 > 2500) resolve(out); else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })`);
  /**
   * Freeze every move of ours part way, for a picture of the middle of it.
   * Armed before the change and done on the very frame a ghost appears: a
   * ghost is also removed on a timer (shared/motion.js#leave), so a picture
   * taken by polling from here could come too late to see it.
   */
  const freezeWhen = (wc, selector, ms) => wc.executeJavaScript(`new Promise((resolve) => { const t0 = performance.now();
    const tick = (now) => {
      if (document.querySelector(${JSON.stringify(selector)})) {
        const list = document.getAnimations().filter((a) => /^motion-/.test(a.id));
        for (const a of list) { a.pause(); a.currentTime = ${ms}; } window.__frozen = list; resolve(list.length); return;
      }
      if (now - t0 > 2000) resolve(0); else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick); })`);
  const thaw = (wc) => wc.executeJavaScript(`(() => { for (const a of window.__frozen || []) a.play(); window.__frozen = []; return true; })()`);
  const shoot = async (name, view = browser.chrome, rect) => {
    const image = await view.webContents.capturePage(rect).catch(() => null);
    if (image) fs.writeFileSync(path.join(shots, name + '.png'), image.toPNG());
  };
  const stripRect = () => ({ x: 0, y: 36, width: Math.min(1000, browser.chrome.getBounds().width), height: 40 });
  const stripIds = () => chrome().executeJavaScript(`[...document.querySelectorAll('#tabs .tab')].map((n) => n.dataset.id)`);
  const visibleIds = () => {
    const ws = organizer.activeWorkspace || 'main';
    return browser.tabs.order.filter((id) => (tab(id).workspaceId || 'main') === ws);
  };

  try {
    await wait(1400);
    browser.settings.update({ tabLayout: 'horizontal', theme: 'mercury', animations: true, tabPreviews: true, bookmarksBar: false });
    browser.applyTabLayout();
    organizer.groups = [];
    for (const extra of browser.tabs.order.slice(1)) browser.tabs.close(extra);
    const first = browser.tabs.active.id;
    browser.tabs.navigate(first, base + '/Inbox');
    const ids = [first];
    for (const title of ['Docs', 'Recipes', 'Weather', 'Maps', 'Music']) ids.push(browser.tabs.create({ url: base + '/' + title, background: true }));
    browser.tabs.select(first);
    await until(() => browser.tabs.list().every((t) => !t.loading && /^http/.test(t.url)));
    await wait(700);
    const [inbox, docs, recipes, weather, maps, music] = ids;
    check('the theme sets a real motion time', await chrome().executeJavaScript(`window.motion.duration()`) > 100);

    // ---- Nodes are kept: a state push updates them in place.
    await remember();
    browser.tabs.navigate(maps, base + '/Atlas');
    await until(() => tab(maps).state.title === 'Atlas');
    browser.tabs.select(docs);
    await wait(400);
    let changed = await sameNodes(ids);
    check('a title change and a tab switch keep every tab\'s node', changed.length === 0, JSON.stringify(changed));
    const activeLook = await chrome().executeJavaScript(`getComputedStyle(document.querySelector('.tab[data-id="${docs}"]')).transitionProperty`);
    check('and the active tab\'s highlight eases rather than snaps', /background/.test(activeLook), activeLook);
    browser.tabs.select(inbox);
    await wait(300);

    // ---- Closing: a real click on the close button.
    await remember();
    const closeAt = await centre(chrome(), `.tab[data-id="${recipes}"] .close`);
    const leaving = sampleLeaving(chrome(), '.strip > .tab.leaving', `.tab[data-id="${weather}"]`);
    await click(chrome(), closeAt.x, closeAt.y);
    // Point at the closing tab straight away, as someone clicking along the
    // strip would: it must not answer the pointer, or raise a card.
    await wait(40);
    chrome().sendInputEvent({ type: 'mouseMove', x: closeAt.x - 20, y: closeAt.y });
    const frames = await leaving;
    const ghostFrames = frames.filter((f) => f.ghost);
    check('a closed tab is gone from the browser', await until(() => !browser.tabs.tabs.has(recipes)));
    check('the closing tab leaves over several frames', ghostFrames.length >= 4, JSON.stringify(frames.slice(0, 3)));
    const widths = ghostFrames.map((f) => f.ghost.w);
    const opacities = ghostFrames.map((f) => f.ghost.o);
    check('it narrows to nothing as it goes', widths[0] > 60 && Math.min(...widths) < widths[0] * 0.5 && widths.every((w, i) => i === 0 || w <= widths[i - 1] + 0.5), widths.join(','));
    check('and fades as it narrows', opacities[0] > 0.6 && Math.min(...opacities) < 0.5, opacities.join(','));
    check('the closing tab cannot be clicked or hovered', ghostFrames.every((f) => !f.ghost.hit && f.ghost.pe === 'none' && !f.ghost.id), JSON.stringify(ghostFrames[0]));
    check('its neighbour slides into the space', frames.some((f) => f.neighbour && f.neighbour !== 'none'), JSON.stringify(frames.map((f) => f.neighbour).slice(0, 4)));
    check('it is removed once it has gone', await until(() => chrome().executeJavaScript(`!document.querySelector('.leaving')`), 10));
    check('and is not in the strip any more', !(await stripIds()).includes(recipes));
    await wait(500);
    check('no hover card came up for the closed tab', await chrome().executeJavaScript(`hover.id !== ${JSON.stringify(recipes)}`) && browser.preview?.id !== recipes);
    changed = await sameNodes([inbox, docs, weather, maps, music]);
    check('its neighbours are the same nodes as before', changed.length === 0, JSON.stringify(changed));
    chrome().sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });
    await wait(300);

    // ---- Opening: grows into place, neighbours make room.
    await remember();
    const entering = sampleEntering(chrome(), '#tabs .tab:last-child');
    const fresh = browser.tabs.create({ url: base + '/Fresh', background: true });
    let inFrames = await entering;
    check('a new tab grows in over several frames', inFrames.length >= 4 && inFrames.some((f) => /inset/.test(f.clip) && f.o < 1), JSON.stringify(inFrames.slice(0, 3)));
    check('and settles fully drawn', await until(() => chrome().executeJavaScript(`(() => { const n = document.querySelector('.tab[data-id="${fresh}"]'); return !!n && getComputedStyle(n).opacity === '1' && getComputedStyle(n).clipPath === 'none'; })()`), 10));
    // Opened in the middle (as a link opened from a tab is), the tabs after
    // it slide along to make room.
    const middle = sampleLeaving(chrome(), `.tab[data-id="${weather}"]`, `.tab[data-id="${weather}"]`, 200);
    const between = browser.tabs.create({ url: base + '/Between', background: true, index: browser.tabs.order.indexOf(weather) });
    inFrames = await middle;
    check('opened in the middle, the tabs after it slide aside', inFrames.some((f) => f.neighbour && f.neighbour !== 'none'), JSON.stringify(inFrames.slice(0, 3)));
    changed = await sameNodes([inbox, docs, weather, maps, music]);
    check('and are still the same nodes', changed.length === 0, JSON.stringify(changed));
    await wait(400);
    await shoot('motion-strip-rest', browser.chrome, stripRect());

    // A picture of the middle of a close, frozen half way.
    const midAt = await centre(chrome(), `.tab[data-id="${between}"] .close`);
    const frozen = freezeWhen(chrome(), '.strip > .tab.leaving', 30);
    await click(chrome(), midAt.x, midAt.y);
    await frozen;
    await wait(40);
    await shoot('motion-strip-closing', browser.chrome, stripRect());
    await thaw(chrome());
    await wait(400);

    // ---- Dragging to reorder: the neighbours glide, the menu still works.
    await remember();
    const glides = sampleLeaving(chrome(), `.tab[data-id="${music}"]`, `.tab[data-id="${docs}"]`, 400);
    await chrome().executeJavaScript(`(() => {
      const src = document.querySelector('.tab[data-id="${music}"]');
      const dest = document.querySelector('.tab[data-id="${docs}"]');
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      const b = dest.getBoundingClientRect();
      const x = b.left + b.width * 0.2, y = b.top + b.height / 2;
      const target = document.elementFromPoint(x, y) || dest;
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return true; })()`);
    await until(() => browser.tabs.order.indexOf(music) === browser.tabs.order.indexOf(docs) - 1);
    const dragFrames = await glides;
    check('dragging a tab moves it', browser.tabs.order.indexOf(music) === browser.tabs.order.indexOf(docs) - 1);
    check('and the tabs it passes glide to their new places', dragFrames.some((f) => f.neighbour && f.neighbour !== 'none'), JSON.stringify(dragFrames.slice(0, 3)));
    await wait(400);
    check('the strip is drawn in the new order', JSON.stringify(await stripIds()) === JSON.stringify(visibleIds()), JSON.stringify([await stripIds(), visibleIds()]));
    changed = await sameNodes([inbox, docs, weather, maps, music]);
    check('every tab kept its node through the drag', changed.length === 0, JSON.stringify(changed));
    check('nothing was left behind as a drag', await chrome().executeJavaScript(`!document.querySelector('.dragging, .drop-before, .drop-after, .drop-into')`));

    browser.lastMenu = null;
    const menuAt = await centre(chrome(), `.tab[data-id="${weather}"]`);
    await click(chrome(), menuAt.x, menuAt.y, { button: 'right' });
    await until(() => overlay().executeJavaScript(`!!document.querySelector('.menu')`));
    const menu = (browser.lastMenu?.items || []).map((i) => i.label).filter(Boolean);
    check('right-clicking a tab still opens its menu', menu.includes('Close tab') || menu.includes('Pin'), menu.join(' | '));
    await overlay().executeJavaScript('window.ui.closeMenu(), true').catch(() => {});
    await wait(300);

    // ---- Pinning: the tab glides to the front.
    const pinFrames = sampleLeaving(chrome(), `.tab[data-id="${maps}"]`, `.tab[data-id="${maps}"]`, 260);
    await organizer.pin([maps], true);
    const pinned = await pinFrames;
    await until(() => chrome().executeJavaScript(`document.querySelector('.tab[data-id="${maps}"]')?.classList.contains('pinned')`));
    check('a pinned tab glides to the front', pinned.some((f) => f.neighbour && f.neighbour !== 'none'), JSON.stringify(pinned.slice(0, 3)));
    await wait(400);
    check('pinning kept its node', (await sameNodes([maps])).length === 0);

    // ---- A group folds into its chip and back out.
    await organizer.assign({ ids: [weather, music], groupId: 'new', value: 'Later' });
    await wait(500);
    const group = organizer.groups.find((g) => g.name === 'Later');
    check('the group is drawn', !!(await centre(chrome(), `.tab-group[data-group="${group.id}"] .tab-group-chip`)));
    browser.tabs.select(inbox);
    await wait(300);
    const chipAt = await centre(chrome(), `.tab-group[data-group="${group.id}"] .tab-group-chip`);
    const folding = sampleLeaving(chrome(), '.strip > .tab.leaving', `.tab[data-id="${docs}"]`, 260);
    await click(chrome(), chipAt.x, chipAt.y);
    const foldFrames = (await folding).filter((f) => f.ghost);
    check('clicking the chip folds the group', await until(() => organizer.groups.find((g) => g.id === group.id)?.collapsed));
    check('its tabs slide into the chip as they go', foldFrames.length >= 3 && foldFrames.at(-1).ghost.w < foldFrames[0].ghost.w, JSON.stringify(foldFrames.map((f) => f.ghost.w)));
    await wait(400);
    check('folded, the group holds no tab nodes and no ghosts', await chrome().executeJavaScript(`document.querySelectorAll('.tab-group[data-group="${group.id}"] .tab').length === 0 && !document.querySelector('.leaving')`));
    const unfolding = sampleEntering(chrome(), `.tab[data-id="${weather}"]`, 200);
    const chipAgain = await centre(chrome(), `.tab-group[data-group="${group.id}"] .tab-group-chip`);
    await click(chrome(), chipAgain.x, chipAgain.y);
    const unfoldFrames = await unfolding;
    check('and clicking again brings them back out of it', unfoldFrames.some((f) => /translate|matrix/.test(f.transform) || f.o < 1), JSON.stringify(unfoldFrames.slice(0, 3)));
    await wait(400);
    check('both tabs are back in the group', await chrome().executeJavaScript(`document.querySelectorAll('.tab-group[data-group="${group.id}"] .tab').length`) === 2);
    await shoot('motion-strip-group', browser.chrome, stripRect());

    // ---- Ten tabs opened and closed as fast as possible: no ghosts left.
    const burst = [];
    for (let i = 0; i < 10; i++) { burst.push(browser.tabs.create({ url: base + '/Burst ' + i, background: true })); await wait(15); }
    await wait(60);
    for (const id of burst) { browser.tabs.close(id); await wait(15); }
    await wait(700);
    const after = await chrome().executeJavaScript(`({ ghosts: document.querySelectorAll('.leaving').length,
      ids: [...document.querySelectorAll('#tabs .tab')].map((n) => n.dataset.id), all: document.querySelectorAll('.tab').length,
      moving: document.getAnimations().filter((a) => /^motion-/.test(a.id)).length })`);
    check('after ten quick opens and closes, no ghost is left', after.ghosts === 0 && after.moving === 0, JSON.stringify(after));
    check('and the strip holds exactly the open tabs, once each', JSON.stringify(after.ids) === JSON.stringify(visibleIds()) && after.all === after.ids.length, JSON.stringify([after.ids.length, visibleIds().length, after.all]));

    // ---- Fifty tabs: the strip still keeps up.
    const many = [];
    for (let i = 0; i < 50; i++) many.push(browser.tabs.create({ url: 'about:blank', background: true }));
    await wait(800);
    const timing = await chrome().executeJavaScript(`new Promise((resolve) => {
      const gaps = []; let last = performance.now(); const t0 = last;
      const tick = (now) => { gaps.push(now - last); last = now; if (now - t0 < 400) requestAnimationFrame(tick); else resolve(gaps); };
      requestAnimationFrame(tick);
    })`).then(async (gaps) => gaps);
    // Close a run of them from the middle while frames are being timed.
    const frameTimes = chrome().executeJavaScript(`new Promise((resolve) => {
      const gaps = []; let last = performance.now(); const t0 = last;
      const tick = (now) => { gaps.push(now - last); last = now; if (now - t0 < 500) requestAnimationFrame(tick); else resolve(gaps); };
      requestAnimationFrame(tick);
    })`);
    for (const id of many.slice(20, 25)) { browser.tabs.close(id); await wait(30); }
    const gaps = await frameTimes;
    const worst = Math.max(...gaps.slice(1));
    check('with fifty-odd tabs, closing several in a row keeps frames coming', worst < 120, 'worst frame ' + worst.toFixed(1) + 'ms; idle worst ' + Math.max(...timing.slice(1)).toFixed(1));
    await wait(500);
    check('and leaves no ghosts', await chrome().executeJavaScript(`!document.querySelector('.leaving')`));
    for (const id of many) if (browser.tabs.tabs.has(id)) browser.tabs.close(id);
    await wait(600);

    // ---- Notices come and go with a little movement.
    const noticeIn = sampleEntering(chrome(), '#notice:not([hidden])', 150);
    browser.notify('Saved to your reading list');
    const noticeFrames = await noticeIn;
    check('a notice rises in', noticeFrames.some((f) => f.anims.includes('motion-enter')), JSON.stringify(noticeFrames.slice(0, 2)));
    browser.notice = null; browser.push();
    await wait(30);
    const leavingNotice = await chrome().executeJavaScript(`(() => { const n = document.getElementById('notice'); return { hidden: n.hidden, anims: n.getAnimations().map((a) => a.id) }; })()`);
    check('and fades out rather than vanishing', !leavingNotice.hidden && leavingNotice.anims.includes('motion-leave'), JSON.stringify(leavingNotice));
    check('then is hidden', await until(() => chrome().executeJavaScript(`document.getElementById('notice').hidden`), 10));

    // ---- The bookmarks bar's contents settle in when it is shown.
    const bar = sampleEntering(chrome(), '#bookmarks:not([hidden]) > *', 150);
    browser.settings.update({ bookmarksBar: true });
    browser.layout(); browser.push();
    const barFrames = await bar;
    check('showing the bookmarks bar eases its contents in', barFrames.some((f) => f.anims.includes('motion-enter')), JSON.stringify(barFrames.slice(0, 2)));
    browser.settings.update({ bookmarksBar: false });
    browser.layout(); browser.push();
    await wait(300);

    // ---- The sidebar slides open and shut, and the find bar drops in.
    browser.settings.update({ sidebarMode: 'on' });
    if (browser.sidebarOpen) { browser.toggleSidebar(false); await wait(400); }
    const sideSteps = [];
    browser.toggleSidebar(true);
    for (let i = 0; i < 14; i++) { sideSteps.push(browser.sidebarProgress); await wait(16); }
    check('the sidebar slides open over several steps', sideSteps.filter((p) => p > 0 && p < 1).length >= 2, sideSteps.map((p) => Number(p).toFixed(2)).join(','));
    await wait(300);
    check('and comes to rest fully open', browser.sidebarProgress === 1 && !browser.sidebarAnim);
    browser.toggleSidebar(false);
    await wait(400);
    const findDrop = async () => {
      browser.openFind();
      await until(() => browser.findBar && !browser.findBar.webContents.isLoading());
      return browser.findBar.webContents;
    };
    let fb = await findDrop();
    const dropTime = await until(() => fb.executeJavaScript(`(() => { const s = getComputedStyle(document.querySelector('.find'));
      return document.documentElement.style.getPropertyValue('--motion-base') ? s.animationName + ' ' + s.animationDuration : null; })()`));
    check('the find bar drops in, on the theme\'s time', dropTime === 'drop 0.17s', dropTime);
    browser.closeFind();
    await wait(200);

    // ---- Animations off: everything changes at once.
    browser.settings.update({ animations: false });
    browser.push();
    await wait(300);
    check('with animations off, the motion time is nothing', await chrome().executeJavaScript(`window.motion.duration()`) === 0);
    const quiet = await chrome().executeJavaScript(`new Promise((resolve) => { const seen = []; const t0 = performance.now();
      const tick = (now) => { seen.push(document.querySelectorAll('.leaving').length + document.getAnimations().filter((a) => /^motion-/.test(a.id)).length);
        if (now - t0 < 300) requestAnimationFrame(tick); else resolve(seen); }; requestAnimationFrame(tick); })`);
    const offAt = await centre(chrome(), `.tab[data-id="${docs}"] .close`);
    const offFrames = sampleLeaving(chrome(), '.leaving', `.tab[data-id="${inbox}"]`, 100);
    await click(chrome(), offAt.x, offAt.y);
    await until(() => !browser.tabs.tabs.has(docs));
    browser.tabs.create({ url: base + '/Still', background: true });
    await wait(300);
    const stillCheck = await chrome().executeJavaScript(`({ ghosts: document.querySelectorAll('.leaving').length,
      moving: document.getAnimations().filter((a) => /^motion-/.test(a.id)).length, docs: !!document.querySelector('.tab[data-id="${docs}"]') })`);
    offFrames.catch(() => {});
    check('a closed tab simply goes, and a new one simply appears', quiet.every((n) => n === 0) && stillCheck.ghosts === 0 && stillCheck.moving === 0 && !stillCheck.docs, JSON.stringify(stillCheck));
    browser.toggleSidebar(true);
    check('the sidebar is simply open', browser.sidebarProgress === 1 && !browser.sidebarAnim);
    browser.toggleSidebar(false);
    check('and simply shut', browser.sidebarProgress === 0 && !browser.sidebarAnim);
    fb = await findDrop();
    const stillDrop = await until(() => fb.executeJavaScript(`(() => { const s = getComputedStyle(document.querySelector('.find'));
      return document.documentElement.style.getPropertyValue('--motion-base') === '0ms' ? s.animationDuration : null; })()`));
    check('and the find bar is simply there', stillDrop === '0s', stillDrop);
    browser.closeFind();
    browser.settings.update({ animations: true });
    browser.push();
    await wait(300);

    // The system's reduced-motion preference does the same.
    const dbg = chrome().debugger;
    let emulated = false;
    try {
      if (!dbg.isAttached()) dbg.attach('1.3');
      await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      emulated = true;
    } catch (error) { console.log('  (could not emulate reduced motion: ' + error.message + ')'); }
    if (emulated) {
      await wait(200);
      check('asking the system for less motion stills it too', await chrome().executeJavaScript(`window.motion.duration()`) === 0);
      const id = browser.tabs.order.at(-1);
      browser.tabs.close(id);
      await wait(40);
      check('a tab closed then just goes', await chrome().executeJavaScript(`!document.querySelector('.leaving') && document.getAnimations().filter((a) => /^motion-/.test(a.id)).length === 0`));
      await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
      dbg.detach();
    }

    // ---- Down the side: the same moves, top to bottom.
    browser.settings.update({ tabLayout: 'vertical', verticalTabsCollapsed: false });
    browser.applyTabLayout();
    await until(() => browser.vtabs && !browser.vtabs.webContents.isLoading() && vt().executeJavaScript(`document.querySelectorAll('.vt-tab').length > 2`));
    browser.push();
    await wait(600);
    const rows = await vt().executeJavaScript(`[...document.querySelectorAll('#list .vt-tab')].map((n) => n.dataset.id)`);
    await remember(vt(), '#list .vt-tab');
    const victim = rows[1];
    const below = rows[2];
    const rowClose = await vt().executeJavaScript(`(() => { const n = document.querySelector('.vt-tab[data-id="${victim}"] .vt-close'); const b = n.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
    const vLeaving = sampleLeaving(vt(), '#list > .vt-tab.leaving', `.vt-tab[data-id="${below}"]`);
    vt().sendInputEvent({ type: 'mouseMove', x: rowClose.x, y: rowClose.y });
    await wait(60);
    await click(vt(), rowClose.x, rowClose.y);
    const vFrames = (await vLeaving);
    const vGhost = vFrames.filter((f) => f.ghost);
    check('down the side, a closed tab folds away over several frames', vGhost.length >= 4 && Math.min(...vGhost.map((f) => f.ghost.h)) < vGhost[0].ghost.h * 0.5, JSON.stringify(vGhost.map((f) => f.ghost.h)));
    check('and fades as it goes', Math.min(...vGhost.map((f) => f.ghost.o)) < 0.5);
    check('and cannot be clicked while it does', vGhost.every((f) => !f.ghost.hit && !f.ghost.id));
    check('the row below slides up', vFrames.some((f) => f.neighbour && f.neighbour !== 'none'), JSON.stringify(vFrames.map((f) => f.neighbour).slice(0, 4)));
    check('it is removed afterwards', await until(() => vt().executeJavaScript(`!document.querySelector('.leaving')`), 10));
    changed = await sameNodes(rows.filter((id) => id !== victim), vt(), '.vt-tab');
    check('and the other rows are the same nodes', changed.length === 0, JSON.stringify(changed));
    const vEnter = sampleEntering(vt(), '#list .vt-tab:last-of-type', 220);
    browser.tabs.create({ url: base + '/Sideways', background: true });
    const vIn = await vEnter;
    check('a new row grows in', vIn.some((f) => f.anims.includes('motion-enter')), JSON.stringify(vIn.slice(0, 2)));
    await wait(400);
    // Switching: the accent mark draws out on the row you move to.
    const target = await vt().executeJavaScript(`[...document.querySelectorAll('#list .vt-tab:not(.active):not(.grouped)')].at(-1)?.dataset.id`);
    const marks = vt().executeJavaScript(`new Promise((resolve) => { const seen = new Set(); const t0 = performance.now();
      const tick = (now) => { for (const a of document.getAnimations()) if (a.animationName) seen.add(a.animationName);
        if (now - t0 < 260) requestAnimationFrame(tick); else resolve([...seen]); }; requestAnimationFrame(tick); })`);
    browser.tabs.select(target);
    const markNames = await marks;
    check('switching tabs down the side draws the accent mark in', markNames.includes('vt-mark-in'), markNames.join(','));
    changed = await sameNodes(rows.filter((id) => id !== victim), vt(), '.vt-tab');
    check('and keeps every row', changed.length === 0, JSON.stringify(changed));
    await wait(300);
    // A picture of a row half way out.
    const lastRow = await vt().executeJavaScript(`document.querySelector('#list .vt-tab:last-of-type')?.dataset.id`);
    const vFrozen = freezeWhen(vt(), '#list > .vt-tab.leaving', 30);
    browser.tabs.close(lastRow);
    await vFrozen;
    await wait(40);
    await shoot('motion-vertical-closing', browser.vtabs);
    await thaw(vt());
    await wait(400);
    // A group folds up under its header.
    const vGroup = organizer.groups.find((g) => g.id === group.id);
    if (vGroup) {
      const header = await centre(vt(), `.vt-group[data-group-id="${vGroup.id}"]`);
      const vFold = sampleLeaving(vt(), '#list > .vt-tab.leaving', '#list .vt-tab', 220);
      await click(vt(), header.x, header.y);
      const vFoldFrames = (await vFold).filter((f) => f.ghost);
      check('down the side, a folding group\'s rows tuck under its header', vFoldFrames.length >= 3, JSON.stringify(vFoldFrames.slice(0, 2)));
      await wait(400);
      check('and leave nothing behind', await vt().executeJavaScript(`!document.querySelector('.leaving')`));
      await click(vt(), header.x, header.y);
      await wait(400);
    }
    // Drag a row: it still moves, and the list keeps its nodes.
    const vRows = await vt().executeJavaScript(`[...document.querySelectorAll('#list .vt-tab')].map((n) => n.dataset.id)`);
    await remember(vt(), '#list .vt-tab');
    const moved = vRows.at(-1);
    const onto = vRows[0];
    await vt().executeJavaScript(`(() => {
      const src = document.querySelector('.vt-tab[data-id="${moved}"]');
      const dest = document.querySelector('.vt-tab[data-id="${onto}"]');
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      const b = dest.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height * 0.2;
      const target = document.elementFromPoint(x, y) || dest;
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return true; })()`);
    const vMoved = await until(() => browser.tabs.order.indexOf(moved) < browser.tabs.order.indexOf(onto));
    check('dragging a row up the list moves it', !!vMoved);
    await wait(400);
    changed = await sameNodes(vRows, vt(), '.vt-tab');
    check('and every row kept its node', changed.length === 0, JSON.stringify(changed));
    check('and no row is left dimmed or marked as a drop', await vt().executeJavaScript(`!document.querySelector('.dragging, .drop-before, .drop-after, .drop-target')`));
    const vMenuAt = await centre(vt(), `.vt-tab[data-id="${moved}"]`);
    browser.lastMenu = null;
    await click(vt(), vMenuAt.x, vMenuAt.y, { button: 'right' });
    await until(() => overlay().executeJavaScript(`!!document.querySelector('.menu')`));
    check('right-clicking a row still opens the tab menu', (browser.lastMenu?.items || []).some((i) => i.label === 'Close tab' || i.label === 'Pin'));
    await overlay().executeJavaScript('window.ui.closeMenu(), true').catch(() => {});
    await wait(200);
    await shoot('motion-vertical-rest', browser.vtabs);
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
  console.log(fails ? '\nFAILURES: ' + fails : '\nall motion checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
