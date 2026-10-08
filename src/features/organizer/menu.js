/**
 * The menus for tabs and groups: a tab's right-click menu, the list of groups
 * "Add tab to group" opens, and a group chip's menu.
 *
 * They are built here, in main, because two tab lists use them - the strip
 * along the top and the vertical list down the side - and both should offer
 * exactly the same thing. Neither renderer has to know how groups, pinning or
 * split view work; each sends the tab that was right-clicked (and any others
 * selected with it) and main answers with the menu.
 *
 * Returns plain menu items (see renderer/ui.js): data only, because they cross
 * IPC to the overlay. Every action names a channel main validates again.
 */
const { GROUP_COLORS } = require('./classify');

const act = (channel, payload = {}) => ({ channel, payload });
const plural = (n, one, many) => (n === 1 ? one : many.replace('#', n));

/** Groups in this workspace that still hold a tab, with how many. */
function liveGroups(organizer, workspaceId) {
  const tabs = organizer.tabs().list();
  return organizer.groups
    .filter((group) => group.workspaceId === workspaceId)
    .map((group) => ({ group, count: tabs.filter((tab) => tab.groupId === group.id).length }))
    .filter(({ count }) => count > 0);
}

/**
 * A tab's menu. `ids` is every tab it acts on: the one right-clicked, plus
 * the rest of the selection when it was right-clicked inside one.
 *
 * Compact on purpose, in the spirit of Chrome's: single-line rows in short
 * sections, an icon only where it helps the eye find its place.
 */
function tabMenu({ id, ids, organizer, layout, bookmarked, canReopen, accel }) {
  const manager = organizer.tabs();
  const tab = manager.tabs.get(id);
  const n = ids.length;
  const many = n > 1;
  const tabs = manager.list();
  const visible = tabs.filter((t) => t.workspaceId === tab.workspaceId);
  const position = visible.findIndex((t) => t.id === id);
  const grouped = ids.some((one) => manager.tabs.get(one)?.groupId);
  const groups = liveGroups(organizer, tab.workspaceId);
  const sleeping = ids.every((one) => organizer.sleeping.has(one));
  const pinned = ids.every((one) => manager.tabs.get(one)?.pinned);
  const muted = ids.every((one) => manager.tabs.get(one)?.state?.muted);
  const others = visible.filter((t) => !ids.includes(t.id) && !t.pinned).length;
  const right = visible.slice(position + 1).filter((t) => !t.pinned).length;
  const split = tab.splitWith && manager.tabs.has(tab.splitWith);

  // A new tab to the right joins the group this tab is in, as in Chrome.
  const index = manager.order.indexOf(id) + 1;
  const items = [
    { label: 'New tab to the right', icon: 'plus', action: act('tabs:new', { index, groupId: tab.groupId || null }) },
    {
      label: groups.length ? (many ? 'Add ' + n + ' tabs to group' : 'Add tab to group') : (many ? 'Add ' + n + ' tabs to new group' : 'Add tab to new group'),
      icon: 'tabs', more: true, action: act('organizer:group-menu', { ids }),
    },
    grouped ? { label: plural(n, 'Remove from group', 'Remove # tabs from group'), action: act('organizer:assign', { ids, groupId: null }) } : null,
    ...(split
      ? [
        { label: 'Swap sides', icon: 'split', action: act('split:swap', { id }) },
        { label: 'Exit split view', action: act('split:exit', { id }) },
      ]
      : !tab.active && !many ? [{ label: 'Add tab to new split view', icon: 'split', action: act('split:with', { id }) }] : []),
    { separator: true },
    { label: plural(n, 'Reload', 'Reload # tabs'), icon: 'reload', shortcut: tab.active && !many ? accel('page:reload') : '', action: act('tabs:reload', { ids }) },
    // The copy sits beside the original: pinned if it is, in its group if it has one.
    many ? null : { label: 'Duplicate', action: act('tabs:new', { url: tab.state.displayUrl || undefined, index, groupId: tab.groupId || null, pinned: !!tab.pinned }) },
    { label: pinned ? plural(n, 'Unpin', 'Unpin # tabs') : plural(n, 'Pin', 'Pin # tabs'), icon: 'pin', action: act('organizer:pin', { ids, pinned: !pinned }) },
    // A mixed selection is muted all together: the one that says "mute" wins.
    { label: muted ? plural(n, 'Unmute tab', 'Unmute # tabs') : plural(n, 'Mute tab', 'Mute # tabs'), icon: muted ? 'volume' : 'muted',
      action: act('tabs:mute', { ids, muted: !muted }) },
    tab.active && !many ? null : sleeping
      ? { label: plural(n, 'Wake tab', 'Wake # tabs'), action: act('organizer:wake', { ids }) }
      : { label: plural(n, 'Sleep tab', 'Sleep # tabs'), action: act('organizer:sleep', { ids }) },
    { separator: true },
    // Only web pages: Static's own pages and files cannot be bookmarked.
    ...(!many && /^https?:/i.test(tab.state.displayUrl || '') ? [{
      label: bookmarked(tab.state.displayUrl) ? 'Remove bookmark' : 'Bookmark', icon: 'star',
      action: act('bookmarks:toggle', { url: tab.state.displayUrl, title: tab.state.title }),
    }, { separator: true }] : []),
    { label: plural(n, 'Close', 'Close # tabs'), icon: 'close', shortcut: tab.active && !many ? accel('tab:close') : '', action: act('tabs:close', { ids }) },
    { label: 'Close other tabs', disabled: !others, action: act('tabs:close-others', { ids }) },
    { label: 'Close tabs to the right', disabled: !right, action: act('tabs:close-right', { id }) },
    { separator: true },
    { label: 'Reopen closed tab', disabled: !canReopen, shortcut: accel('tab:reopen'), action: act('ui:action', { action: 'tab:reopen' }) },
    { separator: true },
    layoutChoice(layout),
  ];
  return items.filter(Boolean);
}

/** Where tabs live, as one line: the label and a two-way switch. */
function layoutChoice(layout) {
  return {
    label: 'Tabs', icon: 'sidebar', value: layout === 'vertical' ? 'vertical' : 'horizontal', hint: 'Where your tabs live',
    choices: [
      { label: 'Top', value: 'horizontal', action: act('settings:update', { tabLayout: 'horizontal' }) },
      { label: 'Side', value: 'vertical', action: act('settings:update', { tabLayout: 'vertical' }) },
    ],
  };
}

/**
 * "Add tab to group", step two: the groups to put the tabs in.
 *
 * The overlay draws one menu at a time and has no submenus, so choosing "Add
 * tab to group" in a tab's menu opens this one in the same place.
 */
function groupPicker(organizer, ids) {
  const manager = organizer.tabs();
  const workspaceId = manager.tabs.get(ids[0])?.workspaceId || manager.activeWorkspace;
  const many = ids.length > 1;
  const groups = liveGroups(organizer, workspaceId);
  const items = [];

  if (groups.length) items.push({ heading: many ? 'Add ' + ids.length + ' tabs to' : 'Add tab to' });
  for (const { group, count } of groups) {
    const here = ids.every((id) => manager.tabs.get(id)?.groupId === group.id);
    items.push({
      label: group.name, swatch: group.color, checked: here, disabled: here,
      shortcut: plural(count, '1 tab', '# tabs'),
      action: act('organizer:assign', { ids, groupId: group.id }),
    });
  }
  if (groups.length) items.push({ separator: true });

  // A new group is named in the menu itself, with a sensible name already in
  // the box: Enter alone makes the group, typing replaces the name.
  const suggested = organizer.suggestion(ids);
  items.push({ heading: 'New group' });
  items.push({
    swatch: suggested.color,
    field: {
      type: 'text', value: suggested.name, placeholder: 'Name the group', button: 'Create', maxLength: 80,
      action: act('organizer:assign', { ids, groupId: 'new', color: suggested.color }),
    },
  });
  return items;
}

/**
 * A group chip's menu, like Chrome's group editor: the name, ready to type
 * over, the colours, then what can be done to the whole group.
 */
function chipMenu(organizer, groupId) {
  const group = organizer.groups.find((g) => g.id === groupId);
  if (!group) return null;
  const manager = organizer.tabs();
  const members = manager.order.filter((id) => manager.tabs.get(id)?.groupId === group.id);
  if (!members.length) return null;
  return [
    {
      swatch: group.color,
      field: { type: 'text', value: group.name, placeholder: 'Name this group', button: 'Rename', maxLength: 80,
        action: act('organizer:group', { id: group.id }) },
    },
    {
      swatches: GROUP_COLORS.map((color) => ({
        color: color.value, label: color.name, checked: color.value === group.color,
        action: act('organizer:group', { id: group.id, color: color.value }),
      })),
    },
    { separator: true },
    { label: 'New tab in group', icon: 'plus',
      action: act('tabs:new', { index: manager.order.indexOf(members.at(-1)) + 1, groupId: group.id }) },
    { label: group.collapsed ? 'Expand group' : 'Collapse group', action: act('organizer:group', { id: group.id, collapsed: !group.collapsed }) },
    { label: 'Ungroup', action: act('organizer:ungroup', { id: group.id }) },
    { separator: true },
    { label: 'Close group', icon: 'close', danger: true, shortcut: plural(members.length, '1 tab', '# tabs'),
      action: act('organizer:close-group', { id: group.id }) },
  ];
}

module.exports = { tabMenu, groupPicker, chipMenu, layoutChoice };
