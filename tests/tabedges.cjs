const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

/**
 * The corners of tab groups, pinned tabs and the tab menu that the main
 * walk-through (tests/tabgroups.cjs) does not reach: dragging a tab out past
 * the END of the strip, a group whose last tab was closed, reopening a closed
 * tab into its pin or group, waking several tabs, Escape out of the group
 * list, a bad name, internal pages, sleeping tabs, many tabs, and payloads a
 * page should never be able to slip past main. Real clicks and keys
 * (sendInputEvent) where a person would use them; runs off-screen.
 *
 *   node scripts/start.cjs --tabedges
 */
const page = (title) => `<!doctype html><html><head><title>${title}</title></head><body style="font:16px sans-serif">${title}</body></html>`;

async function run(browser) {
  const { app } = require('electron');
  const shots = path.join(app.getAppPath(), 'shots');
  fs.mkdirSync(shots, { recursive: true });
  let fails = 0;
  const check = (n, ok, d) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + n + (d !== undefined && !ok ? ' :: ' + String(d).slice(0, 300) : ''));
    if (!ok) fails++;
  };
  const until = async (fn, tries = 40) => {
    for (let i = 0; i < tries; i++) { const v = await Promise.resolve().then(fn).catch(() => null); if (v) return v; await wait(120); }
    return null;
  };

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page(decodeURIComponent(req.url.slice(1)) || 'Home'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;

  const organizer = browser.productivity.organizer;
  const { COLORS } = require('../src/features/organizer/classify');
  const chrome = () => browser.chrome.webContents;
  const overlay = () => browser.overlay.webContents;
  const tab = (id) => browser.tabs.tabs.get(id);
  /** A request sent the way the strip sends it, through the guarded IPC path. */
  const viaChrome = (channel, payload) => chrome().executeJavaScript(`window.browser.invoke(${JSON.stringify(channel)}, ${JSON.stringify(payload)}).then(() => true, (e) => String(e.message))`);

  const click = async (wc, x, y, { button = 'left', modifiers = [] } = {}) => {
    wc.sendInputEvent({ type: 'mouseMove', x, y, modifiers });
    await wait(40);
    wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 1, modifiers });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1, modifiers });
    await wait(120);
  };
  const key = async (wc, keyCode) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode });
    wc.sendInputEvent({ type: 'keyUp', keyCode });
    await wait(150);
  };
  const centre = (wc, selector) => wc.executeJavaScript(`(() => { const n = document.querySelector(${JSON.stringify(selector)});
    if (!n) return null; const b = n.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), w: b.width, h: b.height, right: b.right }; })()`);
  const menuOpen = () => until(() => overlay().executeJavaScript(`!!document.querySelector('.menu')`));
  const menuGone = () => until(() => overlay().executeJavaScript(`!document.querySelector('.menu')`));
  const choose = async (label) => {
    const at = await until(() => overlay().executeJavaScript(`(() => {
      const row = [...document.querySelectorAll('.menu .menu-item')].find((n) => (n.querySelector('.menu-label')?.firstChild?.textContent || '') === ${JSON.stringify(label)});
      if (!row) return null; const b = row.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`));
    if (!at) return false;
    await click(overlay(), at.x, at.y);
    return true;
  };
  const rightClick = async (wc, selector) => {
    browser.lastMenu = null;
    const at = await until(() => centre(wc, selector));
    await click(wc, at.x, at.y, { button: 'right' });
    await menuOpen();
    return browser.lastMenu?.items || [];
  };
  const labels = (items) => items.map((i) => i.label || (i.heading ? '#' + i.heading : i.separator ? '—' : i.field ? '[field]' : i.swatches ? '[colours]' : ''));
  const typeAndEnter = async (text) => {
    const box = await until(() => centre(overlay(), '.menu-field input'));
    if (box) await click(overlay(), box.x, box.y);
    await overlay().executeJavaScript(`document.querySelector('.menu-field input')?.select(), true`);
    if (text) overlay().insertText(text);
    else { await key(overlay(), 'Backspace'); }
    await wait(80);
    overlay().sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    overlay().sendInputEvent({ type: 'char', keyCode: '\r' });
    overlay().sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await wait(300);
  };
  /** A whole HTML5 drag, from one element to a point over another (or past its right edge). */
  const drag = (view, fromSelector, toSelector, { fraction = 0.5, past = 0 } = {}) => view.executeJavaScript(`(() => {
    const src = document.querySelector(${JSON.stringify(fromSelector)});
    const dest = document.querySelector(${JSON.stringify(toSelector)});
    if (!src || !dest) return null;
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const b = dest.getBoundingClientRect();
    const vertical = !!document.querySelector('.vt-list');
    const x = vertical ? b.left + b.width / 2 : b.left + b.width * ${fraction} + ${past};
    const y = vertical ? b.top + b.height * ${fraction} + ${past} : b.top + b.height / 2;
    const target = document.elementFromPoint(x, y) || dest;
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y });
    target.dispatchEvent(over);
    const bar = document.querySelector('.drop-before, .drop-after');
    const colour = bar ? getComputedStyle(bar, vertical ? '::after' : '::before').backgroundColor : null;
    const probe = document.createElement('i'); probe.style.color = 'var(--accent)'; document.body.append(probe);
    const accent = getComputedStyle(probe).color; probe.remove();
    const accepted = over.defaultPrevented;
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return { target: target.className || target.tagName, accepted, plain: colour === accent, bar: bar ? bar.dataset.id + ':' + (bar.classList.contains('drop-before') ? 'before' : 'after') : null };
  })()`);

  try {
    await wait(1400);
    browser.settings.update({ tabLayout: 'horizontal', theme: 'mercury' });
    browser.applyTabLayout();
    organizer.groups = [];
    for (const extra of browser.tabs.order.slice(1)) browser.tabs.close(extra);
    const first = browser.tabs.active.id;
    browser.tabs.navigate(first, base + '/Alpha');
    const ids = [first];
    for (const title of ['Bravo', 'Charlie', 'Delta']) ids.push(browser.tabs.create({ url: base + '/' + title, background: true }));
    browser.tabs.select(first);
    await until(() => browser.tabs.list().every((t) => !t.loading && /^http/.test(t.url)));
    await wait(500);
    const [alpha, bravo, charlie, delta] = ids;

    // ---- A group at the END of the strip: dragging past its edge leaves it.
    await organizer.assign({ ids: [charlie, delta], groupId: 'new', value: 'Tail' });
    const tail = organizer.groups.find((g) => g.name === 'Tail');
    check('a new group made in code gets the first colour', tail?.color === COLORS[0], tail?.color);
    await wait(400);
    let result = await drag(chrome(), `.tab[data-id="${charlie}"]`, `.tab[data-id="${delta}"]`, { fraction: 1, past: 30 });
    await wait(500);
    check('dragging the group\'s tab past the end of the strip is accepted as a drop', !!result?.accepted, JSON.stringify(result));
    check('and takes it out of the group, to the far end', tab(charlie).groupId === null && browser.tabs.order.at(-1) === charlie,
      JSON.stringify(result) + ' ' + browser.tabs.order.map((id) => tab(id).state.title + (tab(id).groupId ? '@' : '')).join(','));
    check('while it is held there, a bar in the plain accent marks the end of the row', result?.bar === delta + ':after' && result.plain, JSON.stringify(result));
    check('no drop marks are left over', await chrome().executeJavaScript(`!document.querySelector('.drop-before, .drop-after, .drop-into, .chip-target, .dragging')`));

    // ---- A group whose last tab is closed: its colour is free again.
    browser.tabs.close(delta);
    await wait(300);
    const next = await organizer.assign({ ids: [bravo], groupId: 'new', value: 'Second' }).then(() => organizer.groups.find((g) => g.name === 'Second'));
    check('a group left empty by closing its tab gives its colour back', next?.color === COLORS[0], next?.color);
    const suggested = organizer.suggestion([alpha]);
    check('and its name is no longer taken', !/Tail/.test(suggested.name) || suggested.name === 'Tail', suggested.name);

    // ---- Reopen closed tab: back in its group, or pinned.
    await organizer.pin([alpha], true);
    const reopenGroup = browser.tabs.create({ url: base + '/Echo', background: true });
    await organizer.assign({ ids: [reopenGroup], groupId: next.id });
    await until(() => !tab(reopenGroup).state.loading);
    browser.tabs.close(reopenGroup);
    await wait(200);
    browser.dispatch('tab:reopen');
    const back = await until(() => browser.tabs.list().find((t) => /Echo/.test(t.url)));
    check('a reopened tab comes back into the group it was in', back?.groupId === next.id, JSON.stringify(back));
    browser.tabs.close(alpha);
    await wait(200);
    browser.dispatch('tab:reopen');
    const pinBack = await until(() => browser.tabs.list().find((t) => /Alpha/.test(t.url)));
    check('a reopened pinned tab comes back pinned, first', pinBack?.pinned === true && browser.tabs.order[0] === pinBack.id, JSON.stringify(pinBack));
    const alpha2 = pinBack?.id;

    // ---- Waking several sleeping tabs at once.
    const s1 = browser.tabs.create({ url: base + '/Sleepy one', background: true });
    const s2 = browser.tabs.create({ url: base + '/Sleepy two', background: true });
    await until(() => !tab(s1).state.loading && !tab(s2).state.loading);
    await wait(300);
    await organizer.sleep([s1, s2]);
    check('two tabs fall asleep', organizer.sleeping.has(s1) && organizer.sleeping.has(s2), [...organizer.sleeping].join(','));
    let items = await rightClick(chrome(), `.tab[data-id="${s1}"]`);
    check('a sleeping tab\'s menu offers "Wake tab"', labels(items).includes('Wake tab'), labels(items).join(' | '));
    await overlay().executeJavaScript('window.ui.closeMenu(), true');
    await menuGone();
    const menu = require('../src/features/organizer/menu');
    items = menu.tabMenu({ id: s1, ids: [s1, s2], organizer, layout: 'horizontal', bookmarked: () => false, canReopen: true, accel: () => '' });
    const wake = items.find((i) => i.label === 'Wake 2 tabs');
    check('with both picked, the menu says "Wake 2 tabs"', !!wake, labels(items).join(' | '));
    if (wake) await viaChrome(wake.action.channel, wake.action.payload);
    await wait(200);
    check('and wakes both', !organizer.sleeping.has(s1) && !organizer.sleeping.has(s2), [...organizer.sleeping].join(','));

    // ---- Escape out of the group list gives the page its clicks back.
    items = await rightClick(chrome(), `.tab[data-id="${s1}"]`);
    await choose('Add tab to group');
    await until(() => (browser.lastMenu?.items || []).some((i) => i.field));
    await menuOpen();
    await wait(200);
    await key(overlay(), 'Escape');
    await menuGone();
    await wait(300);
    check('Escape closes the group list', !(await overlay().executeJavaScript(`!!document.querySelector('.menu')`)));
    check('and the overlay stops taking clicks', browser.overlayInteractive === false, browser.overlayInteractive);

    // ---- An empty name is refused in the menu, which stays open to say so.
    items = await rightClick(chrome(), `.tab[data-id="${s2}"]`);
    await choose('Add tab to group');
    await until(() => (browser.lastMenu?.items || []).some((i) => i.field));
    await typeAndEnter('   ');
    const stillOpen = await overlay().executeJavaScript(`(() => ({ open: !!document.querySelector('.menu .menu-field'), error: document.querySelector('.menu-field-error')?.textContent || '' }))()`);
    check('a blank group name keeps the menu open with a reason', stillOpen.open && /name/i.test(stillOpen.error), JSON.stringify(stillOpen));
    check('and makes no group', !organizer.groups.some((g) => !g.name.trim()));
    await key(overlay(), 'Escape');
    await menuGone();

    // ---- An internal page: no Bookmark, and nothing breaks.
    const settingsTab = browser.tabs.create({ url: 'browser://settings', background: true });
    await until(() => !tab(settingsTab).state.loading);
    await wait(300);
    items = await rightClick(chrome(), `.tab[data-id="${settingsTab}"]`);
    check('an internal page\'s menu has no Bookmark, but everything else', !labels(items).includes('Bookmark') && labels(items).includes('Pin'), labels(items).join(' | '));
    await choose('Pin');
    await until(() => tab(settingsTab).pinned);
    check('and it pins', tab(settingsTab).pinned === true);

    // ---- Duplicating a pinned tab keeps the copy pinned, as Chrome does.
    items = await rightClick(chrome(), `.tab[data-id="${alpha2}"]`);
    const before = browser.tabs.order.length;
    await choose('Duplicate');
    await until(() => browser.tabs.order.length === before + 1);
    const copy = browser.tabs.list().find((t) => /Alpha/.test(t.url) && t.id !== alpha2);
    check('a duplicated pinned tab is pinned too', copy?.pinned === true, JSON.stringify(copy));

    // ---- Close other tabs keeps pinned ones.
    const pinnedNow = browser.tabs.list().filter((t) => t.pinned).map((t) => t.id);
    items = await rightClick(chrome(), `.tab[data-id="${s2}"]`);
    await choose('Close other tabs');
    await until(() => browser.tabs.list().filter((t) => !t.pinned).length === 1);
    check('"Close other tabs" keeps the pinned tabs and that one', pinnedNow.every((id) => browser.tabs.tabs.has(id)) && browser.tabs.tabs.has(s2)
      && browser.tabs.list().filter((t) => !t.pinned).length === 1, browser.tabs.list().map((t) => t.title).join(','));

    // ---- Many tabs, several groups: the strip still draws and scrolls.
    const many = [];
    for (let i = 0; i < 36; i++) many.push(browser.tabs.create({ url: base + '/Tab ' + (i + 1), background: true }));
    await wait(600);
    for (let g = 0; g < 4; g++) await organizer.assign({ ids: many.slice(g * 6, g * 6 + 6), groupId: 'new', value: 'Pile ' + (g + 1) });
    await wait(500);
    const strip = await chrome().executeJavaScript(`(() => ({ tabs: document.querySelectorAll('.tab').length,
      chips: [...document.querySelectorAll('.tab-group-chip')].map((c) => getComputedStyle(c).backgroundColor),
      width: document.getElementById('tabs').scrollWidth, shown: document.getElementById('tabs').clientWidth,
      narrow: [...document.querySelectorAll('.tab')].map((n) => Math.round(n.getBoundingClientRect().width)).filter((w) => w < 38).length,
      overlaps: [...document.querySelectorAll('.tab, .tab-group-chip')].map((n) => n.getBoundingClientRect())
        .filter((b, i, all) => i > 0 && b.left < all[i - 1].right - 1).length }))()`);
    check('forty tabs and four groups all draw', strip.tabs === browser.tabs.list().length && strip.chips.length === 4, JSON.stringify(strip));
    check('in a crowded strip no tab is squeezed away or drawn over another', strip.narrow === 0 && strip.overlaps === 0, JSON.stringify(strip));
    check('four groups get four different colours', new Set(organizer.groups.filter((g) => /Pile/.test(g.name)).map((g) => g.color)).size === 4);
    const image = await browser.chrome.webContents.capturePage({ x: 0, y: 36, width: browser.chrome.getBounds().width, height: 40 }).catch(() => null);
    if (image) fs.writeFileSync(path.join(shots, 'tabedges-many.png'), image.toPNG());

    // ---- Main never trusts what it is sent.
    const longName = 'x'.repeat(5000);
    await organizer.assign({ ids: [s2], groupId: 'new', value: longName, color: 'red;background:url(https://evil)' });
    const odd = organizer.groups.find((g) => g.name.startsWith('xxx'));
    check('a group name is cut to 80 characters', odd?.name.length === 80, odd?.name.length);
    check('and an invented colour is never used', COLORS.includes(odd?.color), odd?.color);
    await organizer.group({ id: odd.id, color: 'url(javascript:alert(1))' });
    check('nor when recolouring', COLORS.includes(organizer.groups.find((g) => g.id === odd.id)?.color));
    const restored = organizer.restore([{ id: 'x', name: 'Bad', color: '#12345g' }, { id: 'y', name: '', color: '#123456' }, null, 'junk', { id: 'z', name: 'Fine', color: '#7aa7f7', workspaceId: 'nope' }]);
    check('a damaged saved session restores only sound groups', restored.size === 2 && !restored.has('y'), [...restored.keys()].join(','));
    check('with a valid colour and a real workspace', organizer.groups.filter((g) => ['Bad', 'Fine'].includes(g.name)).every((g) => /^#[0-9a-f]{6}$/i.test(g.color) && g.workspaceId === 'main'));
    organizer.dropEmptyGroups();
    let threw = false;
    try { await organizer.assign({ ids: 'not a list', groupId: 'new' }); } catch { threw = true; }
    check('a malformed request is refused', threw);
    const sizeBefore = browser.tabs.order.length;
    await viaChrome('tabs:close', { ids: ['nope', 42, { evil: true }] });
    check('closing unknown ids closes nothing', browser.tabs.order.length === sizeBefore);

    // ---- Leaving through the profile picker keeps the last session.
    browser.saveSession();
    const kept = browser.sessionStore.data.tabs.length;
    const realList = browser.tabs.list;
    browser.tabs.list = () => [{ id: 'p', url: 'browser://profiles', title: 'Profiles', active: true }];
    try { browser.saveSession(); } finally { browser.tabs.list = realList; }
    check('a window showing only the profile picker does not wipe the saved tabs', kept > 5 && browser.sessionStore.data.tabs.length === kept,
      kept + ' -> ' + browser.sessionStore.data.tabs.length);

    // ---- Vertical tabs: dragging the last grouped row out past the bottom.
    browser.settings.update({ tabLayout: 'vertical' });
    browser.applyTabLayout();
    const vt = () => browser.vtabs.webContents;
    await until(() => browser.vtabs && !vt().isLoading() && vt().executeJavaScript(`document.querySelectorAll('.vt-tab').length`));
    browser.push();
    await wait(600);
    const lastPile = organizer.groups.find((g) => g.name === 'Pile 4');
    const pileTabs = browser.tabs.order.filter((id) => tab(id).groupId === lastPile.id);
    // Move the pile to the end so its last row is the last row in the list.
    await organizer.move({ ids: browser.tabs.order.filter((id) => !tab(id).pinned && tab(id).groupId !== lastPile.id), beforeId: pileTabs[0] });
    await wait(500);
    const lastRow = pileTabs.at(-1);
    await vt().executeJavaScript(`document.querySelector('.vt-tab[data-id="${lastRow}"]').scrollIntoView(), true`);
    result = await drag(vt(), `.vt-tab[data-id="${lastRow}"]`, `.vt-tab[data-id="${pileTabs.at(-2)}"]`, { fraction: 1, past: 40 });
    await wait(400);
    check('down the side, dragging a group\'s last row past the bottom takes it out', tab(lastRow).groupId === null, JSON.stringify(result));
    // Folded to icons, on a light planet: still squares, pills and colour.
    await vt().executeJavaScript(`document.getElementById('list').scrollTop = 0, true`);
    browser.settings.update({ verticalTabsCollapsed: true, theme: 'venus' });
    browser.applyTabLayout();
    browser.push();
    await wait(800);
    const folded = await vt().executeJavaScript(`(() => ({ chips: [...document.querySelectorAll('.vt-group')].map((n) => Math.round(n.getBoundingClientRect().width)),
      pins: [...document.querySelectorAll('.vt-pin')].map((n) => Math.round(n.getBoundingClientRect().width)), width: document.body.clientWidth }))()`);
    check('folded to icons, group pills and pinned squares fit the narrow list', folded.chips.every((w) => w > 0 && w <= folded.width) && folded.pins.every((w) => w > 0 && w <= folded.width), JSON.stringify(folded));
    const shot = await browser.vtabs.webContents.capturePage().catch(() => null);
    if (shot) fs.writeFileSync(path.join(shots, 'tabedges-vertical-folded.png'), shot.toPNG());
    browser.settings.update({ verticalTabsCollapsed: false, theme: 'mercury' });
    browser.settings.update({ tabLayout: 'horizontal' });
    browser.applyTabLayout();
    await wait(300);
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  } finally {
    browser.sessionStore.save({ tabs: [], savedAt: 0 });
    server.close();
  }
  console.log(fails ? '\nFAILURES: ' + fails : '\nall tab edge checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
