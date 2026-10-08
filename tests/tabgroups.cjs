const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

/**
 * Tab groups, pinned tabs and the tab menu, used the way a person uses them:
 * real right-clicks and clicks (sendInputEvent) on the strip and in the menu
 * overlay, real typing into the menu's name box, and HTML5 drags (synthetic
 * DragEvents - a real OS drag would take the user's mouse). Runs off-screen.
 *
 *   node scripts/start.cjs --tabgroups
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
  const chrome = () => browser.chrome.webContents;
  const overlay = () => browser.overlay.webContents;
  const tabsOf = () => browser.tabs.list();
  const tab = (id) => browser.tabs.tabs.get(id);
  const mods = process.platform === 'darwin' ? ['meta'] : ['control'];
  const savedWorkspaces = structuredClone(organizer.store.data.workspaces);

  const click = async (wc, x, y, { button = 'left', modifiers = [] } = {}) => {
    wc.sendInputEvent({ type: 'mouseMove', x, y, modifiers });
    await wait(40);
    wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 1, modifiers });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1, modifiers });
    await wait(120);
  };
  const centre = (wc, selector) => wc.executeJavaScript(`(() => { const n = document.querySelector(${JSON.stringify(selector)});
    if (!n) return null; const b = n.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), w: b.width, h: b.height }; })()`);
  const tabAt = (id) => centre(chrome(), `.tab[data-id="${id}"]`);
  const menuOpen = () => until(() => overlay().executeJavaScript(`!!document.querySelector('.menu')`));
  const closeMenu = async () => {
    await overlay().executeJavaScript('window.ui.closeMenu(), true').catch(() => {});
    await until(() => overlay().executeJavaScript(`!document.querySelector('.menu')`));
  };
  /** Click a menu row by its label, with a real click in the overlay. */
  const choose = async (label) => {
    const at = await until(() => overlay().executeJavaScript(`(() => {
      const row = [...document.querySelectorAll('.menu .menu-item')].find((n) => (n.querySelector('.menu-label')?.firstChild?.textContent || '') === ${JSON.stringify(label)});
      if (!row) return null; const b = row.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`));
    if (!at) return false;
    await click(overlay(), at.x, at.y);
    return true;
  };
  const rightClickTab = async (id) => {
    browser.lastMenu = null;
    const at = await tabAt(id);
    await click(chrome(), at.x, at.y, { button: 'right' });
    await menuOpen();
    return (browser.lastMenu?.items || []);
  };
  const labels = (items) => items.map((i) => i.label || (i.heading ? '#' + i.heading : i.separator ? '—' : i.field ? '[field]' : i.swatches ? '[colours]' : ''));
  /** Type into the open menu's text box, then press Enter, as a person would. */
  const typeAndEnter = async (text) => {
    // Into the box, as a person would if they had been clicking colours.
    if (!(await until(() => overlay().executeJavaScript(`document.activeElement?.matches('.menu-field input')`), 8))) {
      const box = await until(() => centre(overlay(), '.menu-field input'));
      if (box) await click(overlay(), box.x, box.y);
    }
    await overlay().executeJavaScript(`document.querySelector('.menu-field input')?.select(), true`);
    overlay().insertText(text);
    await wait(80);
    overlay().sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    overlay().sendInputEvent({ type: 'char', keyCode: '\r' });
    overlay().sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await wait(300);
  };
  /** An HTML5 drag from one tab to a point, held mid-drag so it can be looked at. */
  const dragOver = (fromSelector, toSelector, fraction = 0.5, view = chrome()) => view.executeJavaScript(`(() => {
    const src = document.querySelector(${JSON.stringify(fromSelector)});
    const dest = document.querySelector(${JSON.stringify(toSelector)});
    if (!src || !dest) return null;
    const dt = new DataTransfer();
    window.__drag = { src, dt };
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const b = dest.getBoundingClientRect();
    const vertical = !!document.querySelector('.vt-list');
    const x = vertical ? b.left + b.width / 2 : b.left + b.width * ${fraction};
    const y = vertical ? b.top + b.height * ${fraction} : b.top + b.height / 2;
    const target = document.elementFromPoint(x, y) || dest;
    window.__drag.at = { x, y, target };
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
    const bar = document.querySelector('.drop-before, .drop-after');
    const into = document.querySelector('.tab-group.drop-into, .chip-target');
    const chip = into && (into.matches('.tab-group-chip, .vt-group') ? into : into.querySelector('.tab-group-chip'));
    return { bar: bar ? { id: bar.dataset.id, side: bar.classList.contains('drop-before') ? 'before' : 'after',
      colour: getComputedStyle(bar, '::before').backgroundColor } : null,
      into: !!into, chipColour: chip ? getComputedStyle(chip).backgroundColor : null };
  })()`);
  const dropHere = (view = chrome()) => view.executeJavaScript(`(() => {
    const { src, dt, at } = window.__drag;
    at.target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: at.x, clientY: at.y }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return true;
  })()`);
  const shoot = async (name, view = browser.chrome, rect) => {
    await wait(350);
    const image = await view.webContents.capturePage(rect).catch(() => null);
    if (image) fs.writeFileSync(path.join(shots, name + '.png'), image.toPNG());
  };
  const stripRect = () => ({ x: 0, y: 36, width: Math.min(1100, browser.chrome.getBounds().width), height: 40 });

  try {
    await wait(1400);
    browser.settings.update({ tabLayout: 'horizontal', theme: 'mercury' });
    browser.applyTabLayout();
    organizer.groups = [];
    for (const extra of browser.tabs.order.slice(1)) browser.tabs.close(extra);
    const first = browser.tabs.active.id;
    browser.tabs.navigate(first, base + '/Inbox');
    const ids = [first];
    for (const title of ['Docs', 'Recipes', 'Weather', 'Maps', 'Music']) ids.push(browser.tabs.create({ url: base + '/' + title, background: true }));
    browser.tabs.select(first);
    await until(() => tabsOf().every((t) => !t.loading && /^http/.test(t.url)));
    await wait(600);
    const [inbox, docs, recipes, weather, maps, music] = ids;

    // ---- "Main" is gone from the strip until there is a second workspace.
    const hiddenSwitch = await chrome().executeJavaScript(`document.getElementById('workspace-switch').hidden`);
    check('with one workspace, the strip shows no "Main" button', hiddenSwitch === true);
    organizer.workspace('Work');
    await wait(300);
    const shownSwitch = await chrome().executeJavaScript(`(() => { const b = document.getElementById('workspace-switch'); return !b.hidden && b.getBoundingClientRect().width > 0 && b.textContent; })()`);
    check('with two, the workspace button appears', shownSwitch === 'Main', shownSwitch);
    organizer.store.data.workspaces = structuredClone(savedWorkspaces);
    organizer.store.save(); organizer.onChange();
    await wait(300);

    // ---- The tab menu: compact, in sections, the same from every tab list.
    let items = await rightClickTab(docs);
    const tabMenu = labels(items);
    const want = ['New tab to the right', 'Add tab to new group', 'Add tab to new split view', 'Reload', 'Duplicate', 'Pin', 'Sleep tab',
      'Bookmark', 'Close', 'Close other tabs', 'Close tabs to the right', 'Reopen closed tab', 'Tabs'];
    check('a tab\'s menu offers every action, in order', want.every((w, i) => tabMenu.indexOf(w) >= 0 && (i === 0 || tabMenu.indexOf(w) > tabMenu.indexOf(want[i - 1]))), tabMenu.join(' | '));
    check('the layout switch is one line, with no paragraph under it', items.find((i) => i.label === 'Tabs')?.choices?.length === 2 && !items.some((i) => (i.hint || '').length > 50));
    const rows = await overlay().executeJavaScript(`[...document.querySelectorAll('.menu .menu-item')].map((n) => Math.round(n.getBoundingClientRect().height))`);
    check('its rows are compact (28-30px)', rows.length > 8 && rows.every((h) => h >= 27 && h <= 31), JSON.stringify(rows));
    await wait(300);
    await shoot('tabgroups-tab-menu', browser.overlay);

    // ---- Add tab to group > New group, named in the menu, by typing.
    check('choosing "Add tab to new group" opens the group list in its place', await choose('Add tab to new group'));
    const picker = await until(() => (browser.lastMenu?.items || []).some((i) => i.field) && browser.lastMenu.items);
    check('the list offers a named new group', !!picker && picker.some((i) => i.heading === 'New group'), labels(picker || []).join(' | '));
    await typeAndEnter('Reading');
    let group = await until(() => organizer.groups.find((g) => g.name === 'Reading'));
    check('typing a name and pressing Enter makes the group, with the tab in it', !!group && tab(docs).groupId === group?.id, JSON.stringify(organizer.groups));
    check('the first group gets the first colour', group?.color === require('../src/features/organizer/classify').COLORS[0], group?.color);
    check('and the menu closes', !!(await until(() => overlay().executeJavaScript(`!document.querySelector('.menu')`))));

    // An existing group, from the list.
    items = await rightClickTab(recipes);
    check('with a group, the item reads "Add tab to group"', labels(items).includes('Add tab to group'), labels(items).join(' | '));
    await choose('Add tab to group');
    await until(() => (browser.lastMenu?.items || []).some((i) => i.label === 'Reading'));
    const readingRow = browser.lastMenu.items.find((i) => i.label === 'Reading');
    check('each group is listed with its colour and size', readingRow?.swatch === group.color && readingRow?.shortcut === '1 tab', JSON.stringify(readingRow));
    const chosen = await choose('Reading');
    await until(() => tab(recipes).groupId === group.id);
    check('the group in the list can be clicked', chosen);
    check('choosing it puts the tab in that group', tab(recipes).groupId === group.id);
    const order = browser.tabs.order;
    check('right behind the group\'s last tab', order.indexOf(recipes) === order.indexOf(docs) + 1, order.map((id) => tab(id).state.title).join(','));

    // A second group gets the next colour.
    await rightClickTab(maps);
    await choose('Add tab to group');
    await until(() => (browser.lastMenu?.items || []).some((i) => i.field));
    await typeAndEnter('Trips');
    const trips = await until(() => organizer.groups.find((g) => g.name === 'Trips'));
    const { COLORS } = require('../src/features/organizer/classify');
    check('a new group gets the next unused colour', trips && trips.color === COLORS[1] && trips.color !== group.color, trips?.color);

    // The strip draws them.
    await wait(400);
    const strip = await chrome().executeJavaScript(`(() => {
      const wrap = document.querySelector('.tab-group[data-group="${group.id}"]');
      const chip = wrap?.querySelector('.tab-group-chip');
      const cs = chip && getComputedStyle(chip);
      return { tabs: wrap ? wrap.querySelectorAll('.tab').length : 0, chip: chip?.textContent, radius: cs?.borderRadius,
        fill: cs?.backgroundColor, ink: cs?.color, tint: wrap && getComputedStyle(wrap.querySelector('.tab')).backgroundColor,
        plain: getComputedStyle(document.querySelector('.tab:not(.grouped):not(.active)')).backgroundColor };
    })()`);
    check('a group is a filled pill in its colour, then its tabs', strip.tabs === 2 && strip.chip === 'Reading' && parseFloat(strip.radius) > 100, JSON.stringify(strip));
    check('grouped tabs carry a tint of the colour', strip.tint !== strip.plain, strip.tint + ' vs ' + strip.plain);
    await shoot('tabgroups-strip', browser.chrome, stripRect());

    // ---- The chip's own menu: colour, rename, fold.
    browser.lastMenu = null;
    let at = await centre(chrome(), `.tab-group[data-group="${group.id}"] .tab-group-chip`);
    await click(chrome(), at.x, at.y, { button: 'right' });
    await menuOpen();
    const chipMenu = labels(browser.lastMenu?.items || []);
    check('the chip\'s menu has the name, colours, new tab, fold, ungroup and close',
      ['[field]', '[colours]', 'New tab in group', 'Collapse group', 'Ungroup', 'Close group'].every((w) => chipMenu.includes(w)), chipMenu.join(' | '));
    await shoot('tabgroups-chip-menu', browser.overlay);
    const swatch = await centre(overlay(), '.menu-swatch-btn:nth-child(4)');
    await click(overlay(), swatch.x, swatch.y);
    await until(() => organizer.groups.find((g) => g.id === group.id)?.color === COLORS[3]);
    check('clicking a colour recolours the group at once', organizer.groups.find((g) => g.id === group.id)?.color === COLORS[3]);
    check('and the menu stays open for another try', await overlay().executeJavaScript(`!!document.querySelector('.menu .menu-swatch-btn[aria-checked=true]:nth-child(4)')`));
    await typeAndEnter('Reading list');
    await until(() => organizer.groups.find((g) => g.id === group.id)?.name === 'Reading list');
    check('typing over the name renames it', organizer.groups.find((g) => g.id === group.id)?.name === 'Reading list');

    // Fold it with a click on the chip.
    browser.tabs.select(inbox);
    await wait(200);
    at = await centre(chrome(), `.tab-group[data-group="${group.id}"] .tab-group-chip`);
    await click(chrome(), at.x, at.y);
    await until(() => organizer.groups.find((g) => g.id === group.id)?.collapsed);
    await wait(300);
    const folded = await chrome().executeJavaScript(`(() => { const w = document.querySelector('.tab-group[data-group="${group.id}"]');
      return { tabs: w.querySelectorAll('.tab').length, count: w.querySelector('.chip-count')?.textContent }; })()`);
    check('a folded group shows how many tabs it holds', folded.tabs === 0 && folded.count === '2', JSON.stringify(folded));
    await shoot('tabgroups-collapsed', browser.chrome, stripRect());
    at = await centre(chrome(), `.tab-group[data-group="${group.id}"] .tab-group-chip`);
    await click(chrome(), at.x, at.y);
    await until(() => !organizer.groups.find((g) => g.id === group.id)?.collapsed);
    await wait(300);

    // ---- Dragging into and out of groups.
    let held = await dragOver(`.tab[data-id="${music}"]`, `.tab-group[data-group="${group.id}"] .tab-group-chip`);
    check('dragging a tab over a group\'s chip lights the chip up', held?.into === true, JSON.stringify(held));
    await dropHere();
    await until(() => tab(music).groupId === group.id);
    check('dropping it there adds it to the group', tab(music).groupId === group.id);
    await wait(400);

    // Between two of a group's tabs: in, with a bar in the group's colour.
    held = await dragOver(`.tab[data-id="${weather}"]`, `.tab[data-id="${recipes}"]`, 0.2);
    check('over a grouped tab, a bar shows where it lands', held?.bar?.id === recipes && held.bar.side === 'before', JSON.stringify(held));
    check('in the group\'s colour', !!held?.bar && held.bar.colour === held.chipColour, JSON.stringify(held));
    await shoot('tabgroups-drag-into', browser.chrome, stripRect());
    await dropHere();
    await until(() => tab(weather).groupId === group.id);
    const members = browser.tabs.order.filter((id) => tab(id).groupId === group.id);
    check('dropping it there adds it to the group, in that place', tab(weather).groupId === group.id && members.indexOf(weather) === members.indexOf(recipes) - 1,
      members.map((id) => tab(id).state.title).join(','));
    await wait(400);

    // Out past the group's edge: on the next ungrouped tab, it leaves.
    held = await dragOver(`.tab[data-id="${weather}"]`, `.tab[data-id="${inbox}"]`, 0.3);
    check('dragged onto an ungrouped tab, the bar is the plain accent', !!held?.bar && held.into === false, JSON.stringify(held));
    await dropHere();
    await until(() => !tab(weather).groupId);
    check('dragging a grouped tab out of the group takes it out', tab(weather).groupId === null);
    check('and it lands before that tab', browser.tabs.order.indexOf(weather) === browser.tabs.order.indexOf(inbox) - 1);
    await wait(400);

    // Plain reordering still works.
    held = await dragOver(`.tab[data-id="${inbox}"]`, `.tab[data-id="${weather}"]`, 0.2);
    await dropHere();
    await until(() => browser.tabs.order.indexOf(inbox) < browser.tabs.order.indexOf(weather));
    check('dragging between ungrouped tabs just reorders them', browser.tabs.order.indexOf(inbox) < browser.tabs.order.indexOf(weather) && !tab(inbox).groupId);
    check('and nothing was left behind as a drag', await chrome().executeJavaScript(`!document.querySelector('.dragging, .drop-before, .drop-after, .drop-into')`));
    await wait(400);

    // ---- Pinned tabs: small squares at the far left, in pin order.
    await rightClickTab(maps);
    await choose('Pin');
    await until(() => tab(maps).pinned);
    await rightClickTab(weather);
    await choose('Pin');
    await until(() => tab(weather).pinned);
    await wait(400);
    let pins = await chrome().executeJavaScript(`[...document.querySelectorAll('.tab')].map((n) => ({ id: n.dataset.id, pinned: n.classList.contains('pinned'),
      w: Math.round(n.getBoundingClientRect().width), title: !!n.querySelector('.title'), close: !!n.querySelector('.close'), tip: n.title }))`);
    check('pinned tabs sit first, in the order they were pinned', pins[0].id === maps && pins[1].id === weather && pins.slice(2).every((p) => !p.pinned), JSON.stringify(pins.map((p) => p.id.slice(0, 4) + (p.pinned ? '*' : ''))));
    check('as small squares: icon only, no title or close button', pins.slice(0, 2).every((p) => p.w >= 34 && p.w <= 42 && !p.title && !p.close), JSON.stringify(pins.slice(0, 2)));
    check('the title is in the tooltip', /Maps/.test(pins[0].tip), pins[0].tip);
    check('a pinned tab leaves its group', tab(maps).groupId === null && !organizer.groups.some((g) => g.id === trips.id));
    await shoot('tabgroups-pinned', browser.chrome, stripRect());

    // Reorder among pinned; an unpinned tab dragged there stays unpinned.
    held = await dragOver(`.tab[data-id="${weather}"]`, `.tab[data-id="${maps}"]`, 0.2);
    await dropHere();
    await until(() => browser.tabs.order[0] === weather);
    check('pinned tabs reorder among themselves', browser.tabs.order[0] === weather && browser.tabs.order[1] === maps && tab(weather).pinned);
    await wait(300);
    held = await dragOver(`.tab[data-id="${inbox}"]`, `.tab[data-id="${weather}"]`, 0.2);
    check('an unpinned tab dragged over the pinned row is shown landing after it', !held?.bar || !pins.slice(0, 2).some((p) => p.id === held.bar.id) || held.bar.side === 'after', JSON.stringify(held));
    await dropHere();
    await wait(500);
    check('and stays unpinned, first after the pinned row', !tab(inbox).pinned && browser.tabs.order.indexOf(inbox) === 2, browser.tabs.order.map((id) => tab(id).state.title).join(','));

    // Unpin from the menu: it goes straight after the pinned row.
    items = await rightClickTab(maps);
    check('a pinned tab\'s menu offers "Unpin"', labels(items).includes('Unpin'));
    await choose('Unpin');
    await until(() => !tab(maps).pinned);
    check('unpinning puts it just after the pinned row', browser.tabs.order.indexOf(maps) === 1);
    await wait(300);

    // ---- Several tabs at once: Ctrl/Cmd-click, then the menu.
    browser.tabs.select(inbox);
    await wait(250);
    at = await tabAt(maps);
    await click(chrome(), at.x, at.y, { modifiers: mods });
    const picked = await chrome().executeJavaScript(`[...document.querySelectorAll('.tab.picked')].map((n) => n.dataset.id)`);
    check('Ctrl/Cmd-click picks tabs out together', picked.includes(maps) && picked.includes(inbox), JSON.stringify(picked));
    items = await rightClickTab(maps);
    check('and the menu then speaks for all of them', labels(items).includes('Add 2 tabs to group') && labels(items).includes('Close 2 tabs'), labels(items).join(' | '));
    await choose('Add 2 tabs to group');
    await until(() => (browser.lastMenu?.items || []).some((i) => i.label === 'Reading list'));
    await choose('Reading list');
    await until(() => tab(maps).groupId === group.id && tab(inbox).groupId === group.id);
    check('adding them to a group moves both', tab(maps).groupId === group.id && tab(inbox).groupId === group.id);
    await wait(300);

    // Remove from group, from the menu. A plain click first ends the selection.
    at = await tabAt(inbox);
    await click(chrome(), at.x, at.y);
    items = await rightClickTab(inbox);
    check('a grouped tab\'s menu offers "Remove from group"', labels(items).includes('Remove from group'), labels(items).join(' | '));
    await choose('Remove from group');
    await until(() => !tab(inbox).groupId);
    check('which takes it out', tab(inbox).groupId === null);

    // ---- Light and dark: the colours read on both.
    const readable = async () => chrome().executeJavaScript(`(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const rgb = (css) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
      const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
      const strip = rgb(getComputedStyle(document.querySelector('.strip')).backgroundColor);
      return ${JSON.stringify(COLORS)}.map((colour) => {
        const wrap = document.createElement('div'); wrap.className = 'tab-group'; wrap.style.setProperty('--group-color', colour);
        const chip = document.createElement('button'); chip.className = 'tab-group-chip'; chip.textContent = 'x'; wrap.append(chip);
        document.getElementById('tabs').append(wrap);
        const cs = getComputedStyle(chip); const fill = rgb(cs.backgroundColor), ink = rgb(cs.color);
        wrap.remove();
        return { colour, text: Math.round(ratio(fill, ink) * 10) / 10, edge: Math.round(ratio(fill, strip) * 10) / 10 };
      });
    })()`);
    const dark = await readable();
    check('on a dark planet every group colour carries readable text (4.5:1)', dark.every((c) => c.text >= 4.5), JSON.stringify(dark));
    check('and stands out from the strip', dark.every((c) => c.edge >= 2), JSON.stringify(dark));
    browser.settings.update({ theme: 'venus' });
    browser.push();
    await wait(700);
    const light = await readable();
    check('on a light planet too (4.5:1 text)', light.every((c) => c.text >= 4.5), JSON.stringify(light));
    check('drawn deeper, so it stands out from cream', light.every((c) => c.edge >= 1.8), JSON.stringify(light));
    await shoot('tabgroups-strip-light', browser.chrome, stripRect());
    browser.lastMenu = null;
    at = await centre(chrome(), `.tab-group[data-group="${group.id}"] .tab-group-chip`);
    await click(chrome(), at.x, at.y, { button: 'right' });
    await menuOpen();
    await shoot('tabgroups-chip-menu-light', browser.overlay);
    await closeMenu();
    browser.settings.update({ theme: 'mercury' });
    browser.push();
    await wait(400);

    // ---- Close other tabs / to the right keep pinned tabs.
    await rightClickTab(docs);
    await choose('Pin');
    await until(() => tab(docs).pinned);
    const extra1 = browser.tabs.create({ url: base + '/Extra one', background: true });
    const extra2 = browser.tabs.create({ url: base + '/Extra two', background: true });
    await wait(500);
    await rightClickTab(extra1);
    await choose('Close tabs to the right');
    await until(() => !browser.tabs.tabs.has(extra2));
    check('"Close tabs to the right" closes those, and only those', !browser.tabs.tabs.has(extra2) && browser.tabs.tabs.has(extra1) && tab(docs)?.pinned);

    // ---- The session remembers pins, groups, names and colours.
    const before = tabsOf().map((t) => ({ title: t.title, pinned: !!t.pinned, group: organizer.groups.find((g) => g.id === t.groupId) }))
      .map((t) => t.title + (t.pinned ? '*' : '') + (t.group ? '@' + t.group.name + t.group.color : ''));
    browser.saveSession();
    const saved = structuredClone(browser.sessionStore.data);
    check('saving the session keeps each tab\'s pin and group', saved.tabs.some((t) => t.pinned) && saved.tabs.some((t) => t.groupId) && saved.groups.length >= 1, JSON.stringify(saved).slice(0, 300));
    // As a restart would: every tab gone, no groups, then the restore.
    const blank = browser.tabs.create({ url: 'about:blank' });
    for (const id of browser.tabs.order.filter((id) => id !== blank)) browser.tabs.close(id);
    organizer.groups = [];
    browser.restoreSession(saved);
    browser.tabs.close(blank);
    await until(() => tabsOf().every((t) => !t.loading && /^http/.test(t.url)));
    await wait(500);
    const after = tabsOf().map((t) => ({ title: t.title, pinned: !!t.pinned, group: organizer.groups.find((g) => g.id === t.groupId) }))
      .map((t) => t.title + (t.pinned ? '*' : '') + (t.group ? '@' + t.group.name + t.group.color : ''));
    check('after a restart the tabs come back pinned and grouped, in colour', JSON.stringify(after) === JSON.stringify(before), before.join(',') + '  ->  ' + after.join(','));
    await shoot('tabgroups-restored', browser.chrome, stripRect());

    // ---- Vertical tabs: pinned squares on top, groups as filled headers.
    browser.settings.update({ tabLayout: 'vertical' });
    browser.applyTabLayout();
    const vt = () => browser.vtabs.webContents;
    await until(() => browser.vtabs && !vt().isLoading() && vt().executeJavaScript(`document.querySelectorAll('.vt-tab').length`));
    browser.push();
    await wait(600);
    const side = await vt().executeJavaScript(`(() => ({
      pins: [...document.querySelectorAll('#pinned .vt-pin')].map((n) => Math.round(n.getBoundingClientRect().height)),
      groups: [...document.querySelectorAll('.vt-group')].map((n) => ({ name: n.querySelector('.vt-group-name').textContent, fill: getComputedStyle(n).backgroundColor })),
      rows: document.querySelectorAll('.vt-tab').length }))()`);
    const pinnedCount = tabsOf().filter((t) => t.pinned).length;
    check('down the side, pinned tabs are a row of squares at the top', side.pins.length === pinnedCount && side.pins.every((h) => h <= 36), JSON.stringify(side));
    check('and each group has a filled header in its colour', side.groups.length >= 1 && side.groups.every((g) => g.fill && g.fill !== 'rgba(0, 0, 0, 0)'), JSON.stringify(side.groups));
    await shoot('tabgroups-vertical', browser.vtabs);
    // The same menu, from a row there.
    const row = tabsOf().find((t) => !t.pinned && !t.groupId);
    browser.lastMenu = null;
    at = await centre(vt(), `.vt-tab[data-id="${row.id}"]`);
    await click(vt(), at.x, at.y, { button: 'right' });
    await menuOpen();
    const vmenu = labels(browser.lastMenu?.items || []);
    check('a row there has the same tab menu', vmenu.includes('Add tab to group') && vmenu.includes('Close tabs to the right'), vmenu.join(' | '));
    check('drawn where the pointer is', browser.lastMenu.anchor.left >= browser.vtabs.getBounds().x + at.x - 1, JSON.stringify(browser.lastMenu.anchor));
    await closeMenu();
    // Drag a row onto a group's header.
    const header = organizer.groups[0];
    held = await dragOver(`.vt-tab[data-id="${row.id}"]`, `.vt-group[data-group-id="${header.id}"]`, 0.5, vt());
    check('dragging a row onto a group header lights it up', held?.into === true, JSON.stringify(held));
    await dropHere(vt());
    await until(() => tab(row.id)?.groupId === header.id);
    check('and drops it into that group', tab(row.id)?.groupId === header.id);
    browser.settings.update({ tabLayout: 'horizontal' });
    browser.applyTabLayout();
    await wait(300);
  } catch (error) {
    check('probe completed', false, error.stack || error.message);
  } finally {
    // Leave nothing for the next run to restore.
    browser.sessionStore.save({ tabs: [], savedAt: 0 });
    organizer.store.data.workspaces = savedWorkspaces;
    organizer.store.save();
    server.close();
  }
  console.log(fails ? '\nFAILURES: ' + fails : '\nall tab group checks passed');
  app.exit(fails ? 1 : 0);
}
module.exports = { run };
