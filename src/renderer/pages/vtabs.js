'use strict';
(function () {
/**
 * Vertical tabs. Draws the same tab list the horizontal strip does, from the
 * same pushed state, and sends the same requests; main decides everything.
 */
const { invoke, $, element, icon, onState } = window.page;

let state = null;
let dragId = null;

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
    { heading: true, label: 'Tab layout' },
    { label: 'Show tabs horizontally', icon: 'tabs', hint: 'Tabs return to the top of the window',
      action: act('settings:update', { tabLayout: 'horizontal' }) },
    { label: collapsed ? 'Expand tab list' : 'Collapse to icons', icon: 'sidebar',
      action: act('settings:update', { verticalTabsCollapsed: !collapsed }) },
  ];
}

function tabMenu(tab) {
  const sleeping = state.organizer?.sleeping?.includes(tab.id);
  return [
    { label: 'New tab below', icon: 'plus', action: act('tabs:new', { index: state.tabs.findIndex((t) => t.id === tab.id) + 1 }) },
    { label: 'Duplicate', icon: 'plus', action: act('tabs:new', { url: tab.url }) },
    { label: tab.pinned ? 'Unpin tab' : 'Pin tab', icon: 'bookmark', action: act('organizer:pin', { ids: [tab.id], pinned: !tab.pinned }) },
    { label: sleeping ? 'Wake tab' : 'Sleep tab', icon: 'clock',
      action: sleeping ? act('organizer:wake', { id: tab.id }) : act('organizer:sleep', { ids: [tab.id] }) },
    { separator: true },
    ...layoutItems(),
    { separator: true },
    { label: 'Close tab', icon: 'close', danger: true, action: act('tabs:close', { id: tab.id }) },
  ];
}

/** A dropped link, if the drag carries one. */
function linkFrom(event) {
  const types = event.dataTransfer?.types || [];
  if (!types.includes('text/uri-list') && !types.includes('text/plain')) return null;
  const raw = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain') || '';
  const url = raw.split(/\r?\n/).find((line) => line && !line.startsWith('#')) || '';
  return url.trim();
}

function row(tab, group) {
  const sleeping = state.organizer?.sleeping?.includes(tab.id);
  const node = element('div', {
    class: 'vt-tab' + (tab.active ? ' active' : '') + (group ? ' grouped' : '') + (sleeping ? ' sleeping' : ''),
    draggable: 'true', 'data-id': tab.id, title: tab.title || tab.url || '',
    role: 'tab', 'aria-selected': String(!!tab.active),
  });
  if (group) node.style.setProperty('--group-color', group.color);

  const glyph = element('span', { class: 'vt-icon' });
  if (tab.loading) glyph.append(element('span', { class: 'vt-spinner' }));
  else if (tab.favicon) {
    const img = element('img', { src: tab.favicon, alt: '' });
    img.addEventListener('error', () => img.replaceWith(icon('search', { size: 14 })));
    glyph.append(img);
  } else glyph.append(icon('search', { size: 14 }));

  const close = element('button', { class: 'vt-close', title: 'Close tab', 'aria-label': 'Close tab' }, [icon('close', { size: 12 })]);
  close.addEventListener('click', (event) => { event.stopPropagation(); invoke('tabs:close', { id: tab.id }); });

  node.append(glyph, element('span', { class: 'vt-title', text: (tab.pinned ? '◆ ' : '') + (tab.title || 'New tab') }), close);
  node.addEventListener('click', () => invoke('tabs:select', { id: tab.id }));
  node.addEventListener('auxclick', (event) => { if (event.button === 1) invoke('tabs:close', { id: tab.id }); });
  node.addEventListener('contextmenu', (event) => menuAt(event, tabMenu(tab)));
  return node;
}

function render() {
  if (!state || dragId) return; // replacing a dragged node cancels the drag
  const settings = state.settings || {};
  document.body.classList.toggle('collapsed', !!settings.verticalTabsCollapsed);
  $('#fold').title = settings.verticalTabsCollapsed ? 'Expand tabs' : 'Collapse tabs';

  const organizer = state.organizer || { groups: [], workspaces: [], activeWorkspace: 'main', sleeping: [] };
  $('#workspace').textContent = 'Workspace: ' + (organizer.workspaces.find((w) => w.id === organizer.activeWorkspace)?.name || 'Main');
  const visible = (state.tabs || []).filter((t) => (t.workspaceId || 'main') === organizer.activeWorkspace);
  // Pinned first, as in every browser with vertical tabs.
  visible.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));

  const painted = new Set();
  const nodes = [];
  for (const tab of visible) {
    const group = organizer.groups.find((g) => g.id === tab.groupId);
    if (group && !painted.has(group.id)) {
      painted.add(group.id);
      const chip = element('button', { class: 'vt-group', title: group.name, 'aria-expanded': String(!group.collapsed) },
        [element('span', { text: (group.collapsed ? '▸ ' : '▾ ') + group.name })]);
      chip.style.setProperty('--group-color', group.color);
      chip.addEventListener('click', () => invoke('organizer:group', { id: group.id, collapsed: !group.collapsed }));
      nodes.push(chip);
    }
    if (group?.collapsed && !tab.active) continue;
    nodes.push(row(tab, group));
  }
  $('#list').replaceChildren(...nodes);
}

/* ---- drag: reorder tabs, and drop links onto a tab or into empty space ---- */
const list = $('#list');
const clearMarks = () => {
  list.classList.remove('drop-new');
  list.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
};
list.addEventListener('dragstart', (event) => {
  const node = event.target.closest('.vt-tab');
  if (!node) return;
  dragId = node.dataset.id;
  node.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/x-static-tab', dragId);
});
list.addEventListener('dragover', (event) => {
  event.preventDefault();
  const over = event.target.closest('.vt-tab');
  clearMarks();
  if (!dragId && over) over.classList.add('drop-target');
  list.classList.toggle('drop-new', !dragId && !over);
  event.dataTransfer.dropEffect = dragId ? 'move' : 'copy';
});
list.addEventListener('dragleave', clearMarks);
list.addEventListener('drop', (event) => {
  event.preventDefault();
  clearMarks();
  const over = event.target.closest('.vt-tab');
  if (dragId) {
    const nodes = [...list.querySelectorAll('.vt-tab')].filter((n) => n.dataset.id !== dragId);
    const index = nodes.findIndex((n) => { const b = n.getBoundingClientRect(); return event.clientY < b.top + b.height / 2; });
    const targetId = index === -1 ? nodes.at(-1)?.dataset.id : nodes[index]?.dataset.id;
    const target = state.tabs.find((t) => t.id === targetId);
    if (target) {
      invoke('organizer:move', { ids: [dragId], groupId: target.groupId, workspaceId: target.workspaceId,
        beforeId: index === -1 ? null : targetId });
    }
    dragId = null;
    return;
  }
  const url = linkFrom(event);
  if (!url) return;
  // Onto a tab: that tab goes there. Anywhere else: a new tab.
  if (over) invoke('tabs:navigate', { id: over.dataset.id, input: url });
  else invoke('tabs:new', { url });
});
list.addEventListener('dragend', () => { dragId = null; render(); });

list.addEventListener('contextmenu', (event) => {
  if (event.target.closest('.vt-tab')) return;
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
