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
$('#new').addEventListener('click', () => invoke('tabs:new', {}));
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

function tabGlyph(tab) {
  const glyph = element('span', { class: 'vt-icon' });
  const letter = () => element('span', { class: 'vt-letter',
    text: (tab.title || tab.url || '?').replace(/^[^\p{L}\p{N}]+/u, '').charAt(0).toUpperCase() || '·' });
  const fallback = () => (tab.pinned ? letter() : icon('search', { size: 14 }));
  if (tab.loading) glyph.append(element('span', { class: 'vt-spinner' }));
  else if (tab.favicon) {
    const img = element('img', { src: tab.favicon, alt: '' });
    img.addEventListener('error', () => img.replaceWith(fallback()));
    glyph.append(img);
  } else glyph.append(fallback());
  return glyph;
}

function row(tab, group, visible) {
  const sleeping = state.organizer?.sleeping?.includes(tab.id);
  const node = element('div', {
    class: 'vt-tab' + (tab.active ? ' active' : '') + (tab.splitSide ? ' split' : '') + (group ? ' grouped' : '')
      + (sleeping ? ' sleeping' : '') + (picked.has(tab.id) ? ' picked' : ''),
    draggable: 'true', 'data-id': tab.id, title: tab.title || tab.url || '',
    role: 'tab', 'aria-selected': String(!!tab.active),
  });
  if (group) node.style.setProperty('--group-color', group.color);

  const close = element('button', { class: 'vt-close', title: 'Close tab', 'aria-label': 'Close tab' }, [icon('close', { size: 12 })]);
  close.addEventListener('click', (event) => { event.stopPropagation(); invoke('tabs:close', { id: tab.id }); });

  node.append(tabGlyph(tab), element('span', { class: 'vt-title', text: tab.title || 'New tab' }), close);
  wire(node, tab, visible);
  return node;
}

/** A pinned tab down the side: a favicon square in the row at the top. */
function pinnedSquare(tab, visible) {
  const node = element('div', {
    class: 'vt-pin' + (tab.active ? ' active' : '') + (picked.has(tab.id) ? ' picked' : ''),
    draggable: 'true', 'data-id': tab.id, title: (tab.title || tab.url || 'New tab') + ' (pinned)',
    role: 'tab', 'aria-selected': String(!!tab.active),
  }, [tabGlyph(tab)]);
  wire(node, tab, visible);
  return node;
}

function wire(node, tab, visible) {
  node.addEventListener('click', (event) => clickTab(tab, event, visible));
  node.addEventListener('auxclick', (event) => { if (event.button === 1) invoke('tabs:close', { id: tab.id }); });
  node.addEventListener('contextmenu', (event) => tabMenu(tab, event));
}

/** A group's header: a filled pill in its colour; click folds, right-click opens its menu. */
function groupChip(group, count) {
  const chip = element('button', {
    class: 'vt-group' + (group.collapsed ? ' collapsed' : ''), 'data-group-id': group.id,
    title: (group.collapsed ? 'Expand ' : 'Collapse ') + group.name, 'aria-expanded': String(!group.collapsed),
  }, [
    element('span', { class: 'vt-chevron' }, [icon('forward', { size: 12 })]),
    element('span', { class: 'vt-group-name', text: group.name }),
    element('span', { class: 'vt-group-count', text: String(count) }),
  ]);
  chip.style.setProperty('--group-color', group.color);
  chip.addEventListener('click', () => invoke('organizer:group', { id: group.id, collapsed: !group.collapsed }));
  chip.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    invoke('organizer:chip-menu', { id: group.id,
      anchor: { left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY, width: 0, height: 0 } });
  });
  return chip;
}

function render() {
  if (!state || dragId) return; // replacing a dragged node cancels the drag
  const settings = state.settings || {};
  document.body.classList.toggle('collapsed', !!settings.verticalTabsCollapsed);
  $('#fold').title = settings.verticalTabsCollapsed ? 'Expand tabs' : 'Collapse tabs';

  const organizer = state.organizer || { groups: [], workspaces: [], activeWorkspace: 'main', sleeping: [] };
  // Only worth a line once there is more than one workspace to be in.
  const workspaces = organizer.workspaces || [];
  $('#workspace').closest('.vt-foot').hidden = workspaces.length < 2;
  $('#workspace').textContent = 'Workspace: ' + (workspaces.find((w) => w.id === organizer.activeWorkspace)?.name || 'Main');
  const visible = (state.tabs || []).filter((t) => (t.workspaceId || 'main') === organizer.activeWorkspace);
  for (const id of [...picked]) if (!visible.some((t) => t.id === id)) picked.delete(id);

  // Pinned tabs: a compact row of favicon squares at the top, as in Chrome.
  const pinned = visible.filter((t) => t.pinned);
  $('#pinned').replaceChildren(...pinned.map((tab) => pinnedSquare(tab, visible)));
  $('#pinned').hidden = !pinned.length;

  const rest = visible.filter((t) => !t.pinned);
  const painted = new Set();
  const nodes = [];
  for (const tab of rest) {
    const group = organizer.groups.find((g) => g.id === tab.groupId);
    if (group && !painted.has(group.id)) {
      painted.add(group.id);
      nodes.push(groupChip(group, rest.filter((t) => t.groupId === group.id).length));
    }
    if (group?.collapsed && !tab.active) continue;
    nodes.push(row(tab, group, visible));
  }
  $('#list').replaceChildren(...nodes);
}

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
    const squares = [...pinRow.querySelectorAll('.vt-pin')].filter((n) => !moving.includes(n.dataset.id));
    const at = squares.findIndex((n) => {
      const b = n.getBoundingClientRect();
      return event.clientY < b.bottom && event.clientX < b.left + b.width / 2;
    });
    return { groupId: null, beforeId: at >= 0 ? squares[at].dataset.id : null,
      node: squares[at] || squares.at(-1), side: at >= 0 ? 'before' : 'after', pinned: true };
  }
  const rows = [...list.querySelectorAll('.vt-tab')].filter((n) => !moving.includes(n.dataset.id));
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
  area.addEventListener('dragend', () => { dragId = null; clearMarks(); invoke('split:drag', { id: null }); render(); });
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
