'use strict';
(function () {
/**
 * Vertical tabs. Draws the same tab list the horizontal strip does, from the
 * same pushed state, and sends the same requests; main decides everything.
 */
const { invoke, $, element, icon, onState } = window.page;

let state = null;
let dragId = null;
// Tabs picked with Ctrl/Cmd-click or Shift-click, to act on together.
let picked = new Set();

$('#new-icon').append(icon('plus', { size: 16 }));
$('#fold').append(icon('back', { size: 16 }));
$('#search').append(icon('tab_search', { size: 16 }));
$('#new').addEventListener('click', () => invoke('tabs:new', {}));
// Every open tab, searchable: main draws the list in the overlay, beside this panel.
$('#search').addEventListener('click', () => {
  hidePreview();
  const box = $('#search').getBoundingClientRect();
  invoke('tabs:search', { anchor: { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height } });
});
invoke('ui:shortcuts').then((list) => {
  const key = (list || []).find((entry) => entry.id === 'tab:search');
  if (key) $('#search').title = 'Search tabs (' + key.display + ')';
}).catch(() => {});
$('#fold').addEventListener('click', () =>
  invoke('settings:update', { verticalTabsCollapsed: !state?.settings?.verticalTabsCollapsed }));

const act = (channel, payload = {}) => ({ channel, payload });
const ui = (id) => act('ui:action', { action: id });

/** The overlay draws menus; main offsets the anchor by this panel's position. */
function menuAt(event, items) {
  event.preventDefault();
  invoke('menu:open', {
    items,
    anchor: { left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY, width: 0, height: 0 },
    align: 'left',
  });
}

function layoutItems() {
  const collapsed = !!state?.settings?.verticalTabsCollapsed;
  return [
    { label: 'Show tabs horizontally', icon: 'tabs', action: act('settings:update', { tabLayout: 'horizontal' }) },
    { label: collapsed ? 'Expand tab list' : 'Collapse to icons', icon: 'sidebar',
      action: act('settings:update', { verticalTabsCollapsed: !collapsed }) },
  ];
}

/**
 * A tab's menu is built by main (organizer/menu.js), the same one the strip
 * along the top offers. Right-clicked inside a selection, it acts on all of it.
 */
function tabMenu(tab, event) {
  event.preventDefault();
  invoke('tabs:menu', {
    id: tab.id, ids: picked.has(tab.id) ? [...picked] : [tab.id],
    anchor: { left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY, width: 0, height: 0 },
  });
}

const pickKey = (event) => (state?.platform === 'darwin' ? event.metaKey : event.ctrlKey);

/** Click: open. Ctrl/Cmd-click: add to the selection. Shift-click: a range. */
function clickTab(tab, event, visible) {
  if (pickKey(event) || event.shiftKey) {
    const activeId = state.tabs.find((t) => t.active)?.id;
    if (!picked.size && activeId) picked.add(activeId);
    if (event.shiftKey) {
      const ids = visible.map((t) => t.id);
      const [a, b] = [ids.indexOf(activeId), ids.indexOf(tab.id)].sort((x, y) => x - y);
      picked = new Set(ids.slice(Math.max(0, a), b + 1));
    } else if (picked.has(tab.id) && picked.size > 1) picked.delete(tab.id);
    else picked.add(tab.id);
    render();
    return;
  }
  picked.clear();
  invoke('tabs:select', { id: tab.id });
  render();
}

/** A dropped link, if the drag carries one. */
function linkFrom(event) {
  const types = event.dataTransfer?.types || [];
  if (!types.includes('text/uri-list') && !types.includes('text/plain')) return null;
  const raw = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain') || '';
  const url = raw.split(/\r?\n/).find((line) => line && !line.startsWith('#')) || '';
  return url.trim();
}

const initialOf = (tab) => (tab.title || tab.url || '?').replace(/^[^\p{L}\p{N}]+/u, '').charAt(0).toUpperCase() || '·';

/** What a tab's icon shows; it is only rebuilt when this changes. */
const iconKey = (tab) => (tab.loading ? 'spin' : tab.favicon ? 'img:' + tab.favicon : tab.pinned ? 'letter:' + initialOf(tab) : 'glyph');

/** A tab's icon: its favicon, a spinner while it loads, or a letter. `swapped` hears of a favicon that failed. */
function iconOf(tab, swapped = () => {}) {
  const letter = () => element('span', { class: 'vt-letter', text: initialOf(tab) });
  const fallback = () => (tab.pinned ? letter() : icon('search', { size: 14 }));
  if (tab.loading) return element('span', { class: 'vt-spinner' });
  if (!tab.favicon) return fallback();
  const img = element('img', { src: tab.favicon, alt: '' });
  img.addEventListener('error', () => {
    const stand = fallback();
    img.replaceWith(stand);
    swapped(stand, img);
  });
  return img;
}

/** "id:muted" for each tab that showed a speaker at the last redraw. */
let sounding = new Set();

/**
 * A speaker whose waves pulse in turn while the tab plays, or the struck-out
 * one once it is muted - the same one the strip along the top draws.
 */
function speakerGlyph(muted, size) {
  if (muted) return icon('muted', { size });
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('speaker');
  for (const [d, cls] of [['M4 9.5h3.5L12 5.5v13l-4.5-4H4Z', 'cone'], ['M15.5 9a4 4 0 0 1 0 6', 'wave wave-1'], ['M18 6.5a7.5 7.5 0 0 1 0 11', 'wave wave-2']]) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', cls);
    svg.append(path);
  }
  // The waves keep their beat when a speaker is drawn again.
  svg.style.setProperty('--wave-phase', -(Date.now() % 1190) + 'ms');
  return svg;
}

/** Mute or unmute with one click: a speaker on the row, a badge on a pinned square. */
function soundButton(tab, { badge = false } = {}) {
  const label = tab.muted ? 'Unmute tab' : 'Mute tab';
  const button = element('button', {
    class: (badge ? 'vt-sound-badge' : 'vt-sound') + (tab.muted ? ' is-muted' : ' is-playing')
      + (sounding.has(tab.id + ':' + !!tab.muted) ? '' : ' is-new'),
    title: label, 'aria-label': label, 'aria-pressed': String(!!tab.muted), draggable: 'false',
  }, [speakerGlyph(!!tab.muted, badge ? 10 : 15)]);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    invoke('tabs:mute', { ids: [tab.id], muted: !tab.muted });
  });
  return button;
}

/** With hover cards on, the card says it all; a tooltip on top would only cover it. */
function setTip(node, text) {
  if (state?.settings?.tabPreviews === false) node.title = text;
  else node.removeAttribute('title');
}

/* ---- kept, not redrawn ------------------------------------------------------
   As along the top (see chrome.js), each tab keeps one node for as long as
   it is open and only what changed is touched, so the list can move: a
   closed tab folds away while the rows below close up, a new one opens out,
   a moved one glides, and a folded group's rows tuck up under its header.
   Timings and the switch that stills it all are in shared/motion.js. */
const kept = {
  rows: new Map(),      // tab id -> its row in the list
  pins: new Map(),      // tab id -> its square in the pinned row
  chips: new Map(),     // group id -> its header
  parts: new WeakMap(), // row or square -> its icon, title, speaker
  shape: '',
  workspace: null,
  folded: new Set(),    // tab ids tucked into a folded group at the last change
};

const tabById = (id) => state?.tabs.find((t) => t.id === id);
function visibleTabs() {
  const workspace = state?.organizer?.activeWorkspace || 'main';
  return (state?.tabs || []).filter((t) => (t.workspaceId || 'main') === workspace);
}

/** Listeners look the tab up when they fire: the node outlives any one state. */
function wire(node, id) {
  node.addEventListener('click', (event) => { const tab = tabById(id); if (tab) clickTab(tab, event, visibleTabs()); });
  node.addEventListener('auxclick', (event) => { if (event.button === 1) invoke('tabs:close', { id }); });
  node.addEventListener('contextmenu', (event) => {
    const tab = tabById(id);
    if (tab) tabMenu(tab, event); else event.preventDefault();
  });
}

/**
 * The icon slot of a row or square, rebuilt only when what it shows changes.
 * A favicon that failed once is not asked for again; what stands in for it
 * follows the title, as it would on a tab without one.
 */
function freshIcon(parts, tab) {
  const shown = tab.favicon && parts.broken === tab.favicon ? { ...tab, favicon: '' } : tab;
  const key = iconKey(shown);
  if (parts.iconKey === key) return;
  parts.iconKey = key;
  parts.icon = iconOf(shown, (stand, img) => {
    // Only while it is still the icon shown: a newer one may have replaced it.
    if (parts.icon !== img) return;
    parts.icon = stand;
    parts.broken = shown.favicon;
    parts.iconKey = iconKey({ ...shown, favicon: '' });
  });
}

/** Set a node's children to `wanted` only if they differ. */
function fill(node, wanted) {
  const list = wanted.filter(Boolean);
  const children = node.children;
  if (children.length !== list.length || list.some((part, i) => children[i] !== part)) node.replaceChildren(...list);
}

function drawRow(tab, group) {
  let node = kept.rows.get(tab.id);
  if (!node) {
    node = element('div', { class: 'vt-tab', draggable: 'true', 'data-id': tab.id, role: 'tab' });
    const close = element('button', { class: 'vt-close', title: 'Close tab', 'aria-label': 'Close tab' }, [icon('close', { size: 12 })]);
    const id = tab.id;
    close.addEventListener('click', (event) => { event.stopPropagation(); invoke('tabs:close', { id }); });
    kept.parts.set(node, { glyph: element('span', { class: 'vt-icon' }), title: element('span', { class: 'vt-title' }), close });
    wire(node, id);
    kept.rows.set(id, node);
  }
  const parts = kept.parts.get(node);
  const sleeping = !!state.organizer?.sleeping?.includes(tab.id);
  const sound = !!(tab.audible || tab.muted);
  node.classList.toggle('active', !!tab.active);
  node.classList.toggle('split', !!tab.splitSide);
  node.classList.toggle('grouped', !!group);
  node.classList.toggle('sleeping', sleeping);
  node.classList.toggle('picked', picked.has(tab.id));
  node.classList.toggle('has-sound', sound);
  setTip(node, tab.title || tab.url || '');
  node.setAttribute('aria-selected', String(!!tab.active));
  node.setAttribute('aria-label', (tab.title || 'New tab') + (tab.muted ? ', muted' : tab.audible ? ', playing sound' : ''));
  if (group) node.style.setProperty('--group-color', group.color);
  else node.style.removeProperty('--group-color');

  freshIcon(parts, tab);
  // Folded to icons, the speaker becomes a badge on the icon, as on a pinned square.
  const speaker = sound ? String(!!tab.muted) : '';
  if (parts.speaker !== speaker) {
    parts.speaker = speaker;
    parts.badge = sound ? soundButton(tab, { badge: true }) : null;
    parts.sound = sound ? soundButton(tab) : null;
  }
  fill(parts.glyph, [parts.icon, parts.badge]);
  const title = tab.title || 'New tab';
  if (parts.title.textContent !== title) parts.title.textContent = title;
  fill(node, [parts.glyph, parts.title, parts.sound, parts.close]);
  return node;
}

/** A pinned tab down the side: a favicon square in the row at the top. */
function drawPin(tab) {
  let node = kept.pins.get(tab.id);
  if (!node) {
    node = element('div', { class: 'vt-pin', draggable: 'true', 'data-id': tab.id, role: 'tab' });
    kept.parts.set(node, { glyph: element('span', { class: 'vt-icon' }) });
    wire(node, tab.id);
    kept.pins.set(tab.id, node);
  }
  const parts = kept.parts.get(node);
  node.classList.toggle('active', !!tab.active);
  node.classList.toggle('picked', picked.has(tab.id));
  setTip(node, (tab.title || tab.url || 'New tab') + ' (pinned)');
  node.setAttribute('aria-selected', String(!!tab.active));
  node.setAttribute('aria-label', (tab.title || 'New tab') + ' (pinned)' + (tab.muted ? ', muted' : tab.audible ? ', playing sound' : ''));
  freshIcon(parts, tab);
  const speaker = tab.audible || tab.muted ? String(!!tab.muted) : '';
  if (parts.speaker !== speaker) {
    parts.speaker = speaker;
    parts.badge = speaker ? soundButton(tab, { badge: true }) : null;
  }
  fill(parts.glyph, [parts.icon]);
  fill(node, [parts.glyph, parts.badge]);
  return node;
}

/** A group's header: a filled pill in its colour; click folds, right-click opens its menu. */
function drawChip(group, count) {
  let chip = kept.chips.get(group.id);
  if (!chip) {
    const id = group.id;
    chip = element('button', { class: 'vt-group', 'data-group-id': id }, [
      element('span', { class: 'vt-chevron' }, [icon('forward', { size: 12 })]),
      element('span', { class: 'vt-group-name' }),
      element('span', { class: 'vt-group-count' }),
    ]);
    chip.addEventListener('click', () => {
      const current = state?.organizer?.groups?.find((g) => g.id === id);
      if (current) invoke('organizer:group', { id, collapsed: !current.collapsed });
    });
    chip.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      invoke('organizer:chip-menu', { id,
        anchor: { left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY, width: 0, height: 0 } });
    });
    kept.chips.set(id, chip);
  }
  chip.classList.toggle('collapsed', !!group.collapsed);
  chip.title = (group.collapsed ? 'Expand ' : 'Collapse ') + group.name;
  chip.setAttribute('aria-expanded', String(!group.collapsed));
  chip.style.setProperty('--group-color', group.color);
  const [, name, tally] = chip.children;
  if (name.textContent !== group.name) name.textContent = group.name;
  if (tally.textContent !== String(count)) tally.textContent = String(count);
  return chip;
}

function render() {
  if (!state || dragId) return; // moving a dragged node cancels the drag
  const settings = state.settings || {};
  document.body.classList.toggle('collapsed', !!settings.verticalTabsCollapsed);
  $('#fold').title = settings.verticalTabsCollapsed ? 'Expand tabs' : 'Collapse tabs';
  // Animations just turned off: anything still moving lands at once.
  if (!motion.duration()) motion.settle();

  const organizer = state.organizer || { groups: [], workspaces: [], activeWorkspace: 'main', sleeping: [] };
  // Only worth a line once there is more than one workspace to be in.
  const workspaces = organizer.workspaces || [];
  $('#workspace').closest('.vt-foot').hidden = workspaces.length < 2;
  $('#workspace').textContent = 'Workspace: ' + (workspaces.find((w) => w.id === organizer.activeWorkspace)?.name || 'Main');
  const visible = (state.tabs || []).filter((t) => (t.workspaceId || 'main') === organizer.activeWorkspace);
  for (const id of [...picked]) if (!visible.some((t) => t.id === id)) picked.delete(id);

  // Pinned tabs: a compact row of favicon squares at the top, as in Chrome.
  const pinned = visible.filter((t) => t.pinned);
  const squares = pinned.map((tab) => drawPin(tab));
  const shape = pinned.map((t) => t.id);
  shape.push('|');

  const rest = visible.filter((t) => !t.pinned);
  const groups = new Map((organizer.groups || []).map((g) => [g.id, g]));
  const painted = new Set();
  const folded = new Set();
  const rows = [];
  for (const tab of rest) {
    const group = groups.get(tab.groupId);
    if (group && !painted.has(group.id)) {
      painted.add(group.id);
      rows.push(drawChip(group, rest.filter((t) => t.groupId === group.id).length));
      shape.push('[' + group.id);
    }
    if (group?.collapsed && !tab.active) { folded.add(tab.id); continue; }
    rows.push(drawRow(tab, group));
    shape.push(tab.id);
  }
  const key = shape.join(' ');
  if (key !== kept.shape || organizer.activeWorkspace !== kept.workspace) {
    place(squares, rows, { key, workspace: organizer.activeWorkspace, folded });
  }
  sounding = new Set(visible.filter((t) => t.audible || t.muted).map((t) => t.id + ':' + !!t.muted));
  // The tab under the pointer may have just closed.
  if (hover.id && !visible.some((t) => t.id === hover.id)) hidePreview();
}

/**
 * Put the squares and rows in place and play the change: one layout read
 * before it, one after, and transforms and opacity in between.
 */
function place(squares, rows, next) {
  const animate = motion.duration() > 0 && !!kept.shape && next.workspace === kept.workspace;
  const wasFolded = kept.folded;
  kept.shape = next.key;
  kept.workspace = next.workspace;
  kept.folded = next.folded;

  const wanted = new Set([...squares, ...rows]);
  const going = [...pinRow.children, ...list.children].filter((node) => !wanted.has(node) && !node.classList.contains('leaving'));
  for (const map of [kept.rows, kept.pins, kept.chips]) {
    for (const [id, node] of map) if (!wanted.has(node)) map.delete(id);
  }

  // READ: where everything is drawn now.
  let first = null;
  let gone = [];
  if (animate) {
    first = motion.measure(wanted);
    const boxes = new Map([[list, list.getBoundingClientRect()], [pinRow, pinRow.getBoundingClientRect()]]);
    gone = going.map((node) => {
      const box = node.getBoundingClientRect();
      const look = getComputedStyle(node);
      const host = node.parentElement;
      return { node, id: node.dataset.id, box, host, hostBox: boxes.get(host), opacity: Number(look.opacity),
        seen: box.height > 0 && box.bottom > boxes.get(host).top && box.top < boxes.get(host).bottom };
    });
  }

  // WRITE: lift what is leaving out where it is, then put the rest in place.
  if (animate) {
    motion.halt(first.keys());
    for (const leaving of gone) if (leaving.seen) motion.lift(leaving.node, leaving.host, leaving.box, leaving.hostBox);
  }
  pinRow.hidden = !squares.length;
  motion.arrange(pinRow, squares);
  motion.arrange(list, rows);
  if (!animate) return;

  // READ: where everything has landed.
  const entering = [...wanted].filter((node) => !first.has(node));
  const last = motion.measure([...first.keys(), ...entering]);

  // WRITE: play it.
  motion.glide(first, last);
  const headerOf = (id) => {
    const groupId = tabById(id)?.groupId;
    return groupId ? last.get(kept.chips.get(groupId)) : null;
  };
  for (const node of entering) {
    const box = last.get(node);
    if (!box) continue;
    if (node.classList.contains('vt-tab')) {
      const header = wasFolded.has(node.dataset.id) ? headerOf(node.dataset.id) : null;
      // Unfolded: down from under its header. New: opens out in its place.
      motion.enter(node, header ? [
        { transform: 'translateY(' + (header.bottom - box.bottom) + 'px)', clipPath: 'inset(100% 0 0 0)', opacity: 0 },
        { transform: 'none', clipPath: 'inset(0 0 0 0)', opacity: 1 },
      ] : [
        { clipPath: 'inset(0 0 100% 0 round 10px)', opacity: 0, transform: 'translateX(-8px)' },
        { opacity: 1, offset: 0.55 },
        { clipPath: 'inset(0 0 0 0 round 10px)', opacity: 1, transform: 'none' },
      ]);
    } else if (node.classList.contains('vt-pin')) {
      motion.enter(node, [{ transform: 'scale(.6)', opacity: 0 }, { transform: 'none', opacity: 1 }]);
    } else {
      motion.enter(node, [{ transform: 'translateY(-4px)', opacity: 0 }, { transform: 'none', opacity: 1 }]);
    }
  }
  for (const leaving of gone) {
    if (!leaving.seen) continue;
    const { node, box } = leaving;
    if (node.classList.contains('vt-tab')) {
      // Folded away: up under its header. Closed: closes up where it was.
      const header = next.folded.has(leaving.id) ? headerOf(leaving.id) : null;
      // Mostly solid while it closes up, fading at the end (as along the top).
      motion.leave(node, [
        { height: box.height + 'px', opacity: leaving.opacity, transform: 'none' },
        { opacity: leaving.opacity * 0.85, offset: 0.45 },
        { height: '0px', opacity: 0, transform: header ? 'translateY(' + (header.bottom - box.top) + 'px)' : 'translateX(-10px)' },
      ]);
    } else if (node.classList.contains('vt-pin')) {
      motion.leave(node, [{ transform: 'none', opacity: leaving.opacity }, { transform: 'scale(.6)', opacity: 0 }]);
    } else {
      motion.leave(node, [{ opacity: leaving.opacity }, { opacity: 0 }]);
    }
  }
}

/* ---- hover previews -------------------------------------------------------
   The same cards as along the top, coming out to the right of the list:
   rest on a tab for half a second, then move from tab to tab and the card
   follows at once. A click, a drag, a scroll or leaving the list puts it
   away (main/application.js#tabPreview draws it in the overlay). */
const PREVIEW_DELAY_MS = 500;
const hover = { id: null, timer: 0, leave: 0, shown: false, asking: 0, warmUntil: 0, pressed: null };

function hoverTab(id) {
  clearTimeout(hover.leave);
  if (id !== hover.pressed) hover.pressed = null;
  if (state?.settings?.tabPreviews === false || dragId || id === hover.pressed) return;
  if (id === hover.id && (hover.shown || hover.timer)) return;
  clearTimeout(hover.timer);
  hover.id = id;
  const warm = hover.shown || Date.now() < hover.warmUntil;
  hover.timer = setTimeout(() => { hover.timer = 0; showPreview(id); }, warm ? 0 : PREVIEW_DELAY_MS);
}

async function showPreview(id) {
  const find = () => document.querySelector(`.vt-tab[data-id="${CSS.escape(id)}"], .vt-pin[data-id="${CSS.escape(id)}"]`);
  if (!find()) return;
  // A row still sliding into place is measured where it comes to rest.
  await motion.settled(find());
  const node = find();
  if (!node || hover.id !== id || dragId) return;
  const box = node.getBoundingClientRect();
  hover.asking++;
  const shown = await invoke('tabs:preview', { id, anchor: { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height } })
    .catch(() => false).finally(() => { hover.asking--; });
  if (hover.id === id) hover.shown = !!shown;
}

function hidePreview({ soon = false } = {}) {
  clearTimeout(hover.timer);
  hover.timer = 0;
  clearTimeout(hover.leave);
  const away = () => {
    // A card still on its way counts as up: main has not answered yet, and
    // would otherwise draw it after this, with nothing left to put it away.
    if (hover.shown || hover.asking) {
      hover.warmUntil = Date.now() + 400;
      invoke('tabs:preview', { id: null }).catch(() => {});
    }
    hover.shown = false;
    hover.id = null;
  };
  if (soon) hover.leave = setTimeout(away, 90);
  else away();
}

document.addEventListener('pointerover', (event) => {
  const node = event.target.closest?.('.vt-tab, .vt-pin');
  if (node) hoverTab(node.dataset.id);
  else hidePreview({ soon: true });
});
// Out of the panel altogether (into the page, or the card's own lane).
document.addEventListener('pointerout', (event) => {
  if (!event.relatedTarget) { hover.pressed = null; hidePreview({ soon: true }); }
});
document.addEventListener('pointerdown', (event) => {
  hover.pressed = event.target.closest?.('.vt-tab, .vt-pin')?.dataset.id || null;
  hidePreview();
}, true);
document.addEventListener('wheel', () => hidePreview(), { passive: true });
document.addEventListener('dragstart', () => hidePreview(), true);
document.addEventListener('contextmenu', () => hidePreview(), true);
window.addEventListener('blur', () => hidePreview());

/* ---- drag: reorder, group, and drop links ---------------------------------
   The same rules as the strip along the top: onto a group's header or any of
   its tabs (or between two of them) joins the group; anywhere else, including
   just past the group's last tab, leaves it. Pinned squares move only among
   themselves. A line shows where the tab will land, in the group's colour. */
const list = $('#list');
const pinRow = $('#pinned');

const dragIds = () => (picked.has(dragId) && picked.size > 1 ? [...picked] : [dragId]);

function clearMarks() {
  list.classList.remove('drop-new');
  document.querySelectorAll('.drop-target, .drop-before, .drop-after, .chip-target')
    .forEach((n) => n.classList.remove('drop-target', 'drop-before', 'drop-after', 'chip-target'));
  document.body.classList.remove('drop-grouped');
}

/** Where a drop at this point would put the dragged tabs. */
function dropTarget(event) {
  const dragged = state?.tabs.find((t) => t.id === dragId);
  if (!dragged) return null;
  const moving = dragIds();
  const chip = event.target.closest?.('.vt-group');
  if (chip && !dragged.pinned) return { groupId: chip.dataset.groupId, beforeId: null, chip };
  const tabOf = (n) => state.tabs.find((t) => t.id === n?.dataset.id);
  if (dragged.pinned) {
    // Along the pinned row, by the pointer's place in it.
    const squares = [...pinRow.querySelectorAll('.vt-pin:not(.leaving)')].filter((n) => !moving.includes(n.dataset.id));
    const at = squares.findIndex((n) => {
      const b = n.getBoundingClientRect();
      return event.clientY < b.bottom && event.clientX < b.left + b.width / 2;
    });
    return { groupId: null, beforeId: at >= 0 ? squares[at].dataset.id : null,
      node: squares[at] || squares.at(-1), side: at >= 0 ? 'before' : 'after', pinned: true };
  }
  const rows = [...list.querySelectorAll('.vt-tab:not(.leaving)')].filter((n) => !moving.includes(n.dataset.id));
  if (!rows.length) return { groupId: null, beforeId: null };
  const boxes = rows.map((n) => n.getBoundingClientRect());
  const y = event.clientY;
  const over = boxes.findIndex((b) => y >= b.top && y <= b.bottom);
  if (over >= 0) {
    const top = y < boxes[over].top + boxes[over].height / 2;
    return { groupId: tabOf(rows[over])?.groupId || null,
      beforeId: top ? rows[over].dataset.id : rows[over + 1]?.dataset.id || null,
      node: rows[over], side: top ? 'before' : 'after' };
  }
  let before = boxes.findIndex((b) => y < b.top);
  if (before < 0) before = rows.length;
  const above = tabOf(rows[before - 1]);
  const below = tabOf(rows[before]);
  return { groupId: above?.groupId && above.groupId === below?.groupId ? above.groupId : null,
    beforeId: rows[before]?.dataset.id || null, node: rows[before] || rows[before - 1], side: rows[before] ? 'before' : 'after' };
}

function showDrop(target) {
  clearMarks();
  if (!target) return;
  const group = target.groupId ? state.organizer?.groups.find((g) => g.id === target.groupId) : null;
  if (group) { document.body.style.setProperty('--drop-group', group.color); document.body.classList.add('drop-grouped'); }
  if (target.chip) { target.chip.classList.add('chip-target'); return; }
  target.node?.classList.add(target.side === 'before' ? 'drop-before' : 'drop-after');
}

for (const area of [list, pinRow]) {
  area.addEventListener('dragstart', (event) => {
    const node = event.target.closest('.vt-tab, .vt-pin');
    if (!node) return;
    dragId = node.dataset.id;
    for (const id of dragIds()) document.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.add('dragging');
    invoke('split:drag', { id: dragId });
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-static-tab', dragId);
  });
  area.addEventListener('dragend', (event) => {
    const ids = dragId ? dragIds() : [];
    dragId = null;
    clearMarks();
    // Rows are kept now, not redrawn, so the dimming has to be taken off.
    document.querySelectorAll('.dragging').forEach((node) => node.classList.remove('dragging'));
    invoke('split:drag', { id: null });
    render();
    // Let go where nothing took it, outside the window: as from the strip,
    // a window of its own there, or the Static window it was let go over.
    if (ids.length && event.dataTransfer?.dropEffect === 'none' && outsideWindow(event)) invoke('tabs:drag-out', { ids });
  });
}

/** Whether a pointer event happened beyond the window's edges, in screen pixels. */
function outsideWindow(event) {
  const x = event.screenX;
  const y = event.screenY;
  if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) return false;
  return x < window.screenX || y < window.screenY || x >= window.screenX + window.outerWidth || y >= window.screenY + window.outerHeight;
}

pinRow.addEventListener('dragover', (event) => {
  if (!dragId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  showDrop(dropTarget(event));
});
pinRow.addEventListener('drop', (event) => {
  if (!dragId) return;
  event.preventDefault();
  dropTabs(dropTarget(event));
});

function dropTabs(target) {
  const ids = dragIds();
  clearMarks();
  dragId = null;
  if (!target) return;
  invoke('organizer:move', { ids, groupId: target.groupId, workspaceId: state.organizer?.activeWorkspace, beforeId: target.beforeId });
}

list.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (dragId) {
    event.dataTransfer.dropEffect = 'move';
    showDrop(dropTarget(event));
    return;
  }
  const over = event.target.closest('.vt-tab');
  clearMarks();
  if (over) over.classList.add('drop-target');
  list.classList.toggle('drop-new', !over);
  event.dataTransfer.dropEffect = 'copy';
});
list.addEventListener('dragleave', (event) => { if (!list.contains(event.relatedTarget)) clearMarks(); });
list.addEventListener('drop', (event) => {
  event.preventDefault();
  if (dragId) { dropTabs(dropTarget(event)); return; }
  clearMarks();
  const over = event.target.closest('.vt-tab');
  // Onto a tab: that tab goes there. Anywhere else: a new tab.
  const url = linkFrom(event);
  const files = [...(event.dataTransfer?.files || [])];
  if (url && (/^https?:/i.test(url) || !files.length)) {
    if (over) invoke('tabs:navigate', { id: over.dataset.id, input: url });
    else invoke('tabs:new', { url });
    return;
  }
  // Files from the computer by path; an image that exists only in memory by its bytes.
  (async () => {
    const payload = [];
    for (const file of files.slice(0, 20)) {
      const path = window.browser.filePath?.(file) || '';
      if (path) payload.push({ path });
      else if (file.size && file.size <= 64 * 1024 * 1024) payload.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    }
    if (payload.length) invoke('tabs:open-files', { files: payload, intoTab: over?.dataset.id });
  })();
});

list.addEventListener('contextmenu', (event) => {
  if (event.target.closest('.vt-tab, .vt-group')) return;
  menuAt(event, [
    { label: 'New tab', icon: 'plus', action: act('tabs:new', {}) },
    { label: 'Reopen closed tab', icon: 'reload', action: ui('tab:reopen') },
    { label: 'Organise tabs', icon: 'grid', action: ui('open:organizer') },
    { separator: true },
    ...layoutItems(),
  ]);
});
$('#workspace').addEventListener('click', () => invoke('ui:action', { action: 'open:dashboard' }));

onState((next) => { state = next; render(); });
})();
