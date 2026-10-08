'use strict';

/**
 * Browser chrome renderer.
 *
 * This is a pure render of the state object pushed from main on 'app:state'.
 * It holds no browser state of its own; every action round-trips through IPC
 * and comes back as a new state. The one exception is transient input state
 * (what the user is typing, which suggestion is highlighted) held in `local`.
 *
 * Every menu here is custom DOM from renderer/ui.js - there is no native
 * Electron Menu anywhere in this application.
 */

const $ = (id) => document.getElementById(id);
const el = {
  titlebar: $('titlebar'), appMenu: $('app-menu'), windowControls: $('window-controls'),
  windowTitle: $('window-title'),
  tabs: $('tabs'), newtab: $('newtab'),
  back: $('back'), forward: $('forward'), reload: $('reload'), home: $('home'),
  address: $('address'), security: $('security'), star: $('star'), key: $('key'),
  suggestions: $('suggestions'), bookmarks: $('bookmarks'),
  overflow: $('overflow'), notice: $('notice'),
};

let state = { tabs: [], active: {}, bookmarks: [], settings: {}, downloads: [], window: {} };

/** id -> { display } for every shortcut, fetched once at startup. */
let shortcuts = new Map();

const local = {
  typing: false,
  suggestions: [],
  selected: -1,
  dragId: null,
  // Tabs picked with Ctrl/Cmd-click or Shift-click, to act on together.
  picked: new Set(),
};

const invoke = (channel, payload) => window.browser.invoke(channel, payload).catch((error) => {
  console.error(channel, error);
});

const accel = (id) => shortcuts.get(id)?.display || '';
const act = (action) => invoke('ui:action', { action });

/* ---- theme ---------------------------------------------------------------
 * Applied via style.setProperty rather than a <style> block, because the CSP
 * on this page forbids inline stylesheets.
 */

let appliedTheme = '';

function applyTheme(settings) {
  const key = JSON.stringify(window.theme.cssVariables(settings));
  if (key === appliedTheme) return;
  appliedTheme = key;
  const vars = window.theme.cssVariables(settings);
  for (const [name, value] of Object.entries(vars)) {
    document.documentElement.style.setProperty(name, value);
  }
}

/* ---- static chrome (built once) ------------------------------------------ */

function buildChrome() {
  const { icon, iconButton } = window.ui;

  const setIcon = (button, name) => {
    button.append(icon(name), icon(name, { filled: true }));
    button.firstChild.classList.add('icon-outline');
    button.lastChild.classList.add('icon-filled');
  };

  setIcon(el.back, 'back');
  setIcon(el.forward, 'forward');
  setIcon(el.reload, 'reload');
  setIcon(el.home, 'home');
  setIcon(el.star, 'star');
  setIcon(el.key, 'key');
  setIcon(el.newtab, 'plus');
  setIcon(el.overflow, 'menu');
  el.appMenu.append(icon('menu', { size: 16 }));

  // Window controls: our own glyphs, themed to the app.
  for (const [name, action, title, cls] of [
    ['window_minimize', 'minimize', 'Minimize', ''],
    ['window_maximize', 'maximize', 'Maximize', 'maximize'],
    ['window_close', 'close', 'Close', 'close'],
  ]) {
    const button = document.createElement('button');
    button.className = ('window-btn ' + cls).trim();
    button.type = 'button';
    button.title = title;
    button.dataset.control = action;
    button.append(icon(name, { size: 15 }));
    button.addEventListener('click', () => invoke('window:control', { action }));
    el.windowControls.append(button);
  }
}

/** Swap the maximise glyph for a restore glyph when the window is maximised. */
function renderWindowControls() {
  const button = el.windowControls.querySelector('[data-control="maximize"]');
  if (!button) return;
  const maximized = !!state.window?.maximized;
  button.replaceChildren(window.ui.icon(maximized ? 'window_restore' : 'window_maximize', { size: 15 }));
  button.title = maximized ? 'Restore' : 'Maximize';
}

/* ---- menus ---------------------------------------------------------------
 * Grouped logically with dividers, each item showing its real accelerator.
 */

/**
 * Menu item actions are sent to the overlay as data, not callbacks: the
 * description crosses an IPC boundary, and functions do not survive that. Each
 * item therefore names the channel and payload to invoke when chosen.
 */
const action = (channel, payload = {}) => ({ channel, payload });
const doAction = (id) => action('ui:action', { action: id });

function mainMenuItems() {
  const s = state.settings || {};
  return [
    // The brand row carries the active profile and opens the picker.
    //
    // DATA ONLY: this whole structure crosses IPC to the overlay, and a
    // function in it fails structured cloning - which threw "An object could
    // not be cloned" and left the menu completely empty. The action is named
    // here and dispatched by the overlay like any other menu action.
    { brand: true, profile: {
      name: state.profiles?.active?.name || 'Profile',
      action: action('tabs:navigate', { input: 'browser://profiles' }),
    } },
    { tiles: [
      { label: 'New tab', icon: 'plus', shortcut: accel('tab:new'), action: doAction('tab:new') },
      { label: 'Incognito', icon: 'incognito', shortcut: accel('window:incognito'), action: doAction('window:incognito') },
      { label: 'History', icon: 'clock', shortcut: accel('open:history'), action: doAction('open:history') },
      { label: 'Downloads', icon: 'download', shortcut: accel('open:downloads'), action: doAction('open:downloads') },
      { label: 'Bookmarks', icon: 'bookmark', shortcut: accel('open:bookmarks'), action: doAction('open:bookmarks') },
      { label: 'AI chat', icon: 'sparkle', shortcut: accel('open:ai'), action: doAction('open:ai') },
      { label: 'Workspaces', icon: 'grid', shortcut: accel('open:dashboard'), action: doAction('open:dashboard') },
      { label: 'Settings', icon: 'gear', shortcut: accel('open:settings'), action: doAction('open:settings') },
    ] },
    { zoom: {
      level: state.active?.zoom || 1,
      in: { label: 'Zoom in', action: doAction('page:zoom-in') },
      out: { label: 'Zoom out', action: doAction('page:zoom-out') },
      full: { label: 'Full screen', action: doAction('window:fullscreen') },
    } },
    { separator: true },
    { label: 'Find in page', icon: 'search', shortcut: accel('find:open'), action: doAction('find:open') },
    { label: 'Print…', icon: 'doc', shortcut: accel('page:print'), action: doAction('page:print') },
    { label: 'Organise tabs', icon: 'tabs', shortcut: accel('open:organizer'), action: doAction('open:organizer') },
    { label: 'Extensions', icon: 'puzzle', shortcut: accel('open:extensions'), action: doAction('open:extensions') },
    { label: 'Sidebar', icon: 'sidebar', hint: 'Workspace sidebar', value: s.sidebarMode || 'on', choices: [
      { label: 'On', value: 'on', action: action('settings:update', { sidebarMode: 'on' }) },
      { label: 'Auto', value: 'autohide', action: action('settings:update', { sidebarMode: 'autohide' }) },
      { label: 'Off', value: 'off', action: action('settings:update', { sidebarMode: 'off' }) },
    ] },
    { label: 'Tabs', icon: 'tabs', hint: 'Where your tabs live', value: s.tabLayout || 'horizontal', choices: [
      { label: 'Top', value: 'horizontal', action: action('settings:update', { tabLayout: 'horizontal' }) },
      { label: 'Side', value: 'vertical', action: action('settings:update', { tabLayout: 'vertical' }) },
    ] },
    { separator: true },
    { footer: [
      { label: 'Help', action: action('tabs:new', { url: 'browser://help' }) },
      // The tour that follows setup, for whenever someone wants it again.
      { label: 'Guide', action: action('tabs:new', { url: 'browser://guide' }) },
      { label: 'Send feedback', action: doAction('feedback:open') },
      { label: 'About Static', action: action('tabs:new', { url: 'browser://help#about' }) },
      { label: 'Exit', danger: true, action: action('window:control', { action: 'close' }) },
    ] },
  ];
}

/** Anchors are sent as plain numbers; a DOMRect does not survive IPC. */
function anchorRect(element) {
  const box = element.getBoundingClientRect();
  return {
    left: box.left, right: box.right, top: box.top, bottom: box.bottom,
    width: box.width, height: box.height,
  };
}

let menuOpenFor = null;

/** Ask the overlay to draw a menu anchored to a trigger button. */
function toggleMenu(trigger, items, align = 'left') {
  if (menuOpenFor === trigger) {
    closeOverlayMenu();
    invoke('menu:open', { items: [] });
    return;
  }
  closeOverlayMenu();
  menuOpenFor = trigger;
  trigger.classList.add('active');
  invoke('menu:open', { items, anchor: anchorRect(trigger), align });
}

/** Open a menu at the pointer, for context menus. */
function contextMenu(items, event) {
  event.preventDefault();
  closeOverlayMenu();
  const point = {
    left: event.clientX, right: event.clientX,
    top: event.clientY, bottom: event.clientY,
    width: 0, height: 0,
  };
  invoke('menu:open', { items, anchor: point, align: 'left' });
}

function closeOverlayMenu() {
  if (menuOpenFor) {
    menuOpenFor.classList.remove('active');
    menuOpenFor = null;
  }
}

// The overlay owns dismissal (click-away, Escape), so clear the trigger's
// active styling whenever focus leaves this view.
window.addEventListener('blur', closeOverlayMenu);
window.browser.on('ui:menu-closed', closeOverlayMenu);

/**
 * The layout choice, offered when the empty strip is right-clicked. The
 * hint says what vertical tabs are for, because the name alone does not -
 * in one line, not a paragraph.
 */
function tabLayoutItems() {
  return [
    {
      label: 'Show tabs vertically', icon: 'sidebar',
      hint: 'See whole titles, with room for many tabs',
      action: action('settings:update', { tabLayout: 'vertical' }),
    },
  ];
}

/** A link dragged in from a page or another app, if there is one. */
function droppedLink(event) {
  const types = event.dataTransfer?.types || [];
  if (!types.includes('text/uri-list') && !types.includes('text/plain')) return '';
  const raw = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain') || '';
  return (raw.split(/\r?\n/).find((line) => line && !line.startsWith('#')) || '').trim();
}

/** Does the drag carry a link, a file, or an image? Anything a tab can open. */
function canOpen(event) {
  const types = event.dataTransfer?.types || [];
  return types.includes('Files') || types.includes('text/uri-list') || types.includes('text/plain');
}

/**
 * Open what was dropped: a web link or image by its address, files from the
 * computer by their path, and an image that exists only in memory (a data: or
 * blob: picture from a page) by its bytes. Onto a tab: the first replaces it.
 * Must be called during the drop event - its data is gone afterwards.
 */
function openDropped(event, intoTab) {
  const link = droppedLink(event);
  const files = [...(event.dataTransfer?.files || [])];
  if (link && (/^https?:/i.test(link) || !files.length)) {
    if (intoTab) invoke('tabs:navigate', { id: intoTab, input: link });
    else invoke('tabs:new', { url: link });
    return true;
  }
  if (!files.length) return false;
  (async () => {
    const payload = [];
    for (const file of files.slice(0, 20)) {
      const path = window.browser.filePath?.(file) || '';
      if (path) payload.push({ path });
      else if (file.size && file.size <= 64 * 1024 * 1024) payload.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    }
    if (payload.length) invoke('tabs:open-files', { files: payload, intoTab });
  })();
  return true;
}

/** A zero-size anchor at the pointer, in this view's coordinates. */
function pointAt(event) {
  return { left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY, width: 0, height: 0 };
}

/**
 * Right-click menu for a tab. Main builds it (organizer/menu.js), because the
 * vertical tab list offers exactly the same one. Right-clicked inside a
 * selection, it acts on every selected tab.
 */
function tabContextMenu(tab, event) {
  event.preventDefault();
  closeOverlayMenu();
  const ids = local.picked.has(tab.id) ? [...local.picked] : [tab.id];
  invoke('tabs:menu', { id: tab.id, ids, anchor: pointAt(event) });
}

/** Ctrl on Windows and Linux, Cmd on a Mac: add a tab to the selection. */
const pickKey = (event) => (state.platform === 'darwin' ? event.metaKey : event.ctrlKey);

/**
 * Click a tab: open it. Ctrl/Cmd-click: add it to (or take it out of) the
 * selection; Shift-click: select every tab from the open one to this one.
 * The selection is what the tab menu, pinning and grouping then act on.
 */
function clickTab(tab, event, visible) {
  if (pickKey(event) || event.shiftKey) {
    const activeId = state.tabs.find((t) => t.active)?.id;
    if (!local.picked.size && activeId) local.picked.add(activeId);
    if (event.shiftKey) {
      const ids = visible.map((t) => t.id);
      const [a, b] = [ids.indexOf(activeId), ids.indexOf(tab.id)].sort((x, y) => x - y);
      local.picked = new Set(ids.slice(Math.max(0, a), b + 1));
    } else if (local.picked.has(tab.id) && local.picked.size > 1) local.picked.delete(tab.id);
    else local.picked.add(tab.id);
    renderTabs();
    return;
  }
  local.picked.clear();
  invoke('tabs:select', { id: tab.id });
  renderTabs();
}

/** Right-click menu for a bookmark. */
function bookmarkContextMenu(item, event) {
  contextMenu([
    { label: 'Open', icon: 'forward', action: action('tabs:navigate', { input: item.url }) },
    { label: 'Open in new tab', icon: 'plus', action: action('tabs:new', { url: item.url }) },
    { separator: true },
    { label: 'Remove', icon: 'trash', danger: true, action: action('bookmarks:remove', { id: item.id }) },
  ], event);
}

/* ---- rendering ----------------------------------------------------------- */

function render() {
  applyTheme(state.settings || {});
  document.body.classList.toggle('mac', state.platform === 'darwin');
  document.body.classList.toggle('incognito', !!state.incognito);
  document.body.classList.toggle('vertical-tabs', state.settings?.tabLayout === 'vertical');
  document.getElementById('incognito-pill').hidden = !state.incognito;
  renderWindowControls();
  renderTabs();
  renderToolbar();
  renderBookmarks();
  renderNotice();
}

/** A tab's icon: its favicon, a spinner while it loads, or a letter. */
function tabIcon(tab, size = 16) {
  if (tab.loading) {
    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    return spinner;
  }
  // A pinned tab is ONLY its icon, so a page without one gets its initial
  // rather than the same anonymous glyph as every other.
  const letter = () => {
    const mark = document.createElement('span');
    mark.className = 'tab-letter';
    mark.textContent = (tab.title || tab.url || '?').replace(/^[^\p{L}\p{N}]+/u, '').charAt(0).toUpperCase() || '·';
    return mark;
  };
  const fallback = () => (tab.pinned ? letter() : window.ui.icon('search', { size: 14 }));
  if (!tab.favicon) return fallback();
  const img = document.createElement('img');
  img.className = 'favicon';
  img.width = size; img.height = size;
  img.src = tab.favicon;
  img.onerror = () => img.replaceWith(fallback());
  return img;
}

function tabNode(tab, organizer, visible, group) {
  const sleeping = organizer.sleeping.includes(tab.id);
  const node = document.createElement('div');
  node.className = 'tab' + (tab.active ? ' active' : '') + (tab.pinned ? ' pinned' : '')
    + (tab.splitSide ? ' split-' + tab.splitSide : '') + (sleeping ? ' sleeping' : '')
    + (group ? ' grouped' : '') + (local.picked.has(tab.id) ? ' picked' : '');
  node.draggable = true;
  node.dataset.id = tab.id;
  node.title = (tab.title || 'New tab') + (tab.pinned ? ' (pinned)' : '') + (sleeping ? ' - sleeping' : '');
  node.setAttribute('role', 'tab');
  node.setAttribute('aria-selected', String(!!tab.active));
  node.append(tabIcon(tab));

  // A pinned tab is a small square with just its icon, as in Chrome: no
  // title, no close button. Its title is in the tooltip.
  if (!tab.pinned) {
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = (sleeping ? '◌ ' : '') + (tab.title || 'New tab');
    node.append(title);

    const close = document.createElement('button');
    close.className = 'close';
    close.type = 'button';
    close.title = 'Close tab';
    close.append(window.ui.icon('close', { size: 13 }));
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      invoke('tabs:close', { id: tab.id });
    });
    node.append(close);
  }

  node.addEventListener('click', (event) => clickTab(tab, event, visible));
  node.addEventListener('auxclick', (event) => {
    if (event.button === 1) invoke('tabs:close', { id: tab.id });
  });
  node.addEventListener('contextmenu', (event) => tabContextMenu(tab, event));
  return node;
}

/**
 * A group's chip: a filled pill in the group's colour, its name, and how
 * many tabs it holds when folded. Click folds and unfolds; right-click opens
 * the group's own menu (rename, colour, ungroup, close).
 */
function groupChip(group, count) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'tab-group-chip' + (group.collapsed ? ' collapsed' : '');
  chip.dataset.groupId = group.id;
  chip.title = (group.collapsed ? 'Expand ' : 'Collapse ') + group.name + ' (' + count + (count === 1 ? ' tab)' : ' tabs)');
  chip.setAttribute('aria-expanded', String(!group.collapsed));
  const name = document.createElement('span');
  name.className = 'chip-name';
  name.textContent = group.name;
  chip.append(name);
  if (group.collapsed) {
    const badge = document.createElement('span');
    badge.className = 'chip-count';
    badge.textContent = String(count);
    chip.append(badge);
  }
  chip.addEventListener('click', () => invoke('organizer:group', { id: group.id, collapsed: !group.collapsed }));
  chip.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    closeOverlayMenu();
    invoke('organizer:chip-menu', { id: group.id, anchor: pointAt(event) });
  });
  return chip;
}

function renderTabs() {
  // Replacing dragged DOM nodes cancels Chromium's native drag session.
  if (local.dragId) return;
  const active = state.tabs.find(t => t.active);
  el.windowTitle.textContent = active?.title ? active.title + ' — static' : 'static';
  const organizer = state.organizer || { groups: [], workspaces: [], activeWorkspace: 'main', sleeping: [] };
  // The workspace switch says "Main" to someone who has only ever had one
  // workspace, which means nothing to them. It appears once there is a second;
  // workspaces stay in the main menu and the Organizer either way.
  const switcher = $('workspace-switch');
  switcher.hidden = (organizer.workspaces || []).length < 2;
  switcher.textContent = organizer.workspaces.find(w => w.id === organizer.activeWorkspace)?.name || 'Main';
  const visible = state.tabs.filter(t => (t.workspaceId || 'main') === organizer.activeWorkspace);
  for (const id of [...local.picked]) if (!visible.some((t) => t.id === id)) local.picked.delete(id);

  // Pinned squares first, then a hairline, then everything else - groups
  // wrapped so their colour runs under the chip and every tab in them.
  const nodes = [];
  const pinned = visible.filter((t) => t.pinned);
  for (const tab of pinned) nodes.push(tabNode(tab, organizer, visible, null));
  const rest = visible.filter((t) => !t.pinned);
  if (pinned.length && rest.length) {
    const rule = document.createElement('span');
    rule.className = 'pinned-rule';
    nodes.push(rule);
  }
  const wrappers = new Map();
  for (const tab of rest) {
    const group = organizer.groups.find(g => g.id === tab.groupId);
    if (!group) { nodes.push(tabNode(tab, organizer, visible, null)); continue; }
    let wrap = wrappers.get(group.id);
    if (!wrap) {
      const count = rest.filter((t) => t.groupId === group.id).length;
      wrap = document.createElement('div');
      wrap.className = 'tab-group' + (group.collapsed ? ' collapsed' : '');
      wrap.dataset.group = group.id;
      wrap.style.setProperty('--group-color', group.color);
      wrap.append(groupChip(group, count));
      wrappers.set(group.id, wrap);
      nodes.push(wrap);
    }
    // A folded group still shows the tab you are on, so it never vanishes.
    if (group.collapsed && !tab.active) continue;
    wrap.append(tabNode(tab, organizer, visible, group));
  }
  el.tabs.replaceChildren(...nodes);
  // A crowded strip shrinks a group's tabs to their 56px minimum like any
  // other, and no further (see .tab-group in chrome.css): the chip, then each
  // tab and the 2px gap before it.
  for (const wrap of wrappers.values()) {
    const chip = wrap.querySelector('.tab-group-chip');
    wrap.style.minWidth = (chip.offsetWidth + 2 + wrap.querySelectorAll('.tab').length * 58) + 'px';
  }
}

function renderToolbar() {
  const active = state.active || {};
  el.back.disabled = !active.canGoBack;
  el.forward.disabled = !active.canGoForward;

  // Reload doubles as Stop while a page is loading.
  const loading = !!active.loading;
  el.reload.replaceChildren(window.ui.icon(loading ? 'close' : 'reload'));
  el.reload.title = loading ? 'Stop' : 'Reload (' + accel('page:reload') + ')';

  if (!local.typing && document.activeElement !== el.address) {
    el.address.value = displayUrl(active.url);
  }

  const marks = { secure: 'lock', insecure: 'warn', error: 'warn', internal: 'gear', extension: 'puzzle', file: 'doc' };
  el.security.replaceChildren(window.ui.icon(marks[active.security] || 'search', { size: 14 }));
  el.security.className = 'security ' + (active.security || '');
  el.security.title = {
    secure: 'Connection is secure (HTTPS)',
    insecure: 'Not secure (HTTP)',
    error: 'Page failed to load',
    internal: 'Built-in page',
    extension: 'Extension page',
    file: 'A file from this computer, opened only because you dragged it in',
  }[active.security] || '';

  // The key: this site has saved logins or passkeys. One click lists them.
  const saved = state.saved;
  el.key.hidden = !saved;
  if (saved) {
    const parts = [saved.logins ? saved.logins + (saved.logins === 1 ? ' saved login' : ' saved logins') : '',
      saved.passkeys ? saved.passkeys + (saved.passkeys === 1 ? ' passkey' : ' passkeys') : ''].filter(Boolean);
    el.key.title = parts.join(' and ') + ' for this site' + (saved.locked ? ' (locked)' : '') + ' - click to fill';
    el.key.classList.toggle('locked', !!saved.locked);
  }

  el.star.classList.toggle('on', !!state.bookmarked);
  el.star.title = (state.bookmarked ? 'Remove bookmark' : 'Bookmark this page') +
    ' (' + accel('bookmarks:toggle') + ')';

  const engine = state.settings?.searchEngine === 'brave' ? 'Brave Search' : 'Google';
  el.address.placeholder = `Search ${engine} or type a URL`;
}

function displayUrl(url) {
  if (!url || url === 'browser://newtab' || url === 'about:blank') return '';
  return url;
}

function renderBookmarks() {
  const show = !!state.settings?.bookmarksBar;
  el.bookmarks.hidden = !show;
  if (!show) return;

  if (!state.bookmarks.length) {
    const empty = document.createElement('span');
    empty.className = 'empty';
    empty.textContent = 'Bookmark pages with the star to see them here';
    el.bookmarks.replaceChildren(empty);
    return;
  }

  el.bookmarks.replaceChildren(...state.bookmarks.map((item) => {
    const node = document.createElement('div');
    node.className = 'bookmark';
    node.title = item.url;

    const img = document.createElement('img');
    img.src = faviconFor(item.url);
    img.onerror = () => img.classList.add('hidden');
    node.append(img);

    const label = document.createElement('span');
    label.textContent = item.title || item.url;
    node.append(label);

    node.addEventListener('click', () => invoke('tabs:navigate', { input: item.url }));
    node.addEventListener('auxclick', (event) => {
      if (event.button === 1) invoke('tabs:new', { url: item.url, background: true });
    });
    node.addEventListener('contextmenu', (event) => bookmarkContextMenu(item, event));
    return node;
  }));
}

/** Google's favicon service: the site's real icon without us fetching it. */
function faviconFor(url) {
  try {
    return 'https://www.google.com/s2/favicons?sz=32&domain=' + new URL(url).hostname;
  } catch { return ''; }
}

function renderNotice() {
  const notice = state.notice;
  el.notice.hidden = !notice;
  if (notice) el.notice.textContent = notice.message;
}

/* ---- omnibox suggestions -------------------------------------------------- */

/** Last state told to main, so the view is not resized on every keystroke. */
let suggestionsWereOpen = false;

function renderSuggestions() {
  const items = local.suggestions;
  el.suggestions.hidden = !items.length;

  // The chrome view is only as tall as the toolbar, so the dropdown was being
  // clipped to a few pixels - it looked like suggestions never appeared. Main
  // grows the view while the list is open.
  const open = items.length > 0;
  if (open !== suggestionsWereOpen) {
    suggestionsWereOpen = open;
    invoke('ui:suggestions', { open }).catch(() => {});
  }

  if (!items.length) return;

  el.suggestions.replaceChildren(...items.map((item, index) => {
    const node = document.createElement('div');
    node.className = 'suggestion' + (index === local.selected ? ' selected' : '');

    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.append(window.ui.icon(
      item.source === 'bookmark' ? 'star' : item.source === 'search' ? 'search' : 'clock',
      { size: 14 }));
    node.append(kind);

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = item.title || item.url;
    node.append(label);

    if (item.url && item.source !== 'search') {
      const url = document.createElement('span');
      url.className = 'url';
      url.textContent = ' — ' + item.url;
      node.append(url);
    }

    node.addEventListener('mousedown', (event) => {
      event.preventDefault();
      commit(item.url || item.query);
    });
    return node;
  }));
}

async function updateSuggestions() {
  const query = el.address.value.trim();
  if (!query) {
    local.suggestions = [];
    local.selected = -1;
    renderSuggestions();
    return;
  }
  const results = (await invoke('omnibox:suggest', { query })) || [];
  const engine = state.settings?.searchEngine === 'brave' ? 'Brave Search' : 'Google';
  local.suggestions = [
    { source: 'search', title: `${query} — search ${engine}`, query },
    ...results,
  ].slice(0, 9);
  local.selected = -1;
  renderSuggestions();
}

function closeSuggestions() {
  local.suggestions = [];
  local.selected = -1;
  local.typing = false;
  renderSuggestions();
}

function commit(input) {
  const value = input ?? el.address.value;
  if (!value) return;
  closeSuggestions();
  el.address.blur();
  invoke('tabs:navigate', { input: value });
}

/* ---- events -------------------------------------------------------------- */

el.newtab.addEventListener('click', () => act('tab:new'));
/**
 * Organise in one click, right here.
 *
 * It used to open a whole page, which is a lot of ceremony for "tidy my
 * tabs". Now it analyses and applies immediately and reports what it did on
 * the button itself, with an undo that stays for ten seconds - fast by
 * default, recoverable when it guesses wrong.
 */
const organiseButton = $('organise-tabs');
let organiseTimer = null;
let organiseUndo = false;

function organiseLabel(text, undo) {
  clearTimeout(organiseTimer);
  organiseUndo = !!undo;
  organiseButton.textContent = text;
  organiseButton.classList.toggle('is-undo', !!undo);
  if (text !== 'Organise Tabs') {
    organiseTimer = setTimeout(() => organiseLabel('Organise Tabs', false), undo ? 10000 : 2600);
  }
}

organiseButton.addEventListener('click', async () => {
  // While the undo is showing, the button IS the undo.
  if (organiseUndo) {
    try { await invoke('organizer:undo'); organiseLabel('Put back', false); }
    catch (error) { organiseLabel(String(error.message).slice(0, 28), false); }
    return;
  }

  organiseButton.disabled = true;
  organiseLabel('Organising…', false);
  try {
    const analysed = await invoke('organizer:analyze', {});
    const groups = (analysed && analysed.plan && analysed.plan.groups) || [];
    if (!groups.length) { organiseLabel('Nothing to group', false); return; }

    await invoke('organizer:apply', {});
    const tabs = groups.reduce((total, group) => total + group.ids.length, 0);
    // Say what actually happened, in numbers that can be checked against the
    // tab strip, rather than a generic "Done".
    organiseLabel(groups.length + (groups.length === 1 ? ' group' : ' groups')
      + ' · ' + tabs + ' tabs · Undo', true);
  } catch (error) {
    organiseLabel(String(error.message).slice(0, 30), false);
  } finally {
    organiseButton.disabled = false;
  }
});
$('workspace-switch').addEventListener('click', () => toggleMenu($('workspace-switch'), [
  ...(state.organizer?.workspaces || []).map(w => ({ label: w.name, icon: 'grid',
    checked: w.id === state.organizer.activeWorkspace, action: action('organizer:select-workspace', { id: w.id }) })),
  { separator: true }, { label: 'Manage workspaces & tabs', icon: 'gear', action: doAction('open:organizer') },
]));
el.back.addEventListener('click', () => act('page:back'));
el.forward.addEventListener('click', () => act('page:forward'));
el.home.addEventListener('click', () => act('page:home'));
el.reload.addEventListener('click', () => act(state.active?.loading ? 'page:stop' : 'page:reload'));
el.star.addEventListener('click', () => act('bookmarks:toggle'));
el.key.addEventListener('click', () => {
  const box = el.key.getBoundingClientRect();
  invoke('passwords:key-menu', { anchor: { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height } });
});

el.appMenu.addEventListener('click', () => toggleMenu(el.appMenu, mainMenuItems(), 'left'));
el.overflow.addEventListener('click', () => toggleMenu(el.overflow, mainMenuItems(), 'right'));

// Double-clicking the drag region maximises, matching platform convention.
$('titlebar-drag').addEventListener('dblclick', () => invoke('window:control', { action: 'maximize' }));

el.address.addEventListener('input', () => { local.typing = true; updateSuggestions(); });
el.address.addEventListener('focus', () => el.address.select());
el.address.addEventListener('blur', () => closeSuggestions());

el.address.addEventListener('keydown', (event) => {
  const items = local.suggestions;
  if (event.key === 'ArrowDown' && items.length) {
    event.preventDefault();
    local.selected = (local.selected + 1) % items.length;
    el.address.value = items[local.selected].url || items[local.selected].query;
    renderSuggestions();
  } else if (event.key === 'ArrowUp' && items.length) {
    event.preventDefault();
    local.selected = (local.selected - 1 + items.length) % items.length;
    el.address.value = items[local.selected].url || items[local.selected].query;
    renderSuggestions();
  } else if (event.key === 'Enter') {
    const picked = local.selected >= 0 ? items[local.selected] : null;
    commit(picked ? (picked.url || picked.query) : undefined);
  } else if (event.key === 'Escape') {
    closeSuggestions();
    el.address.value = displayUrl(state.active?.url);
    el.address.blur();
  }
});

/* ---- dragging tabs -------------------------------------------------------
   Drag to reorder, and into or out of groups. While a tab is dragged, a bar
   shows where it will land, in the colour of the group it will join (or the
   accent when it joins none):
   - onto a group's chip, or onto any tab in a group: it joins that group;
   - between two tabs of the same group: it joins that group;
   - anywhere else, including just past a group's edge: it belongs to none.
   Pinned tabs move only among pinned tabs, and the rest only among the rest,
   so a drag never pins or unpins anything by accident. */

/** Where a drop at this pointer position would put the dragged tabs. */
function dropTarget(event) {
  const dragged = state.tabs.find((t) => t.id === local.dragId);
  if (!dragged) return null;
  const moving = dragIds();
  const chip = event.target.closest?.('.tab-group-chip');
  if (chip && !dragged.pinned) return { groupId: chip.dataset.groupId, beforeId: null, chip };

  const nodes = [...el.tabs.querySelectorAll('.tab')]
    .filter((n) => !moving.includes(n.dataset.id) && n.classList.contains('pinned') === !!dragged.pinned);
  if (!nodes.length) return { groupId: null, beforeId: null };
  // Past the last tab - over the + button or the empty strip - is the end of
  // the row, in no group: the way out of a group that is last in the strip.
  if (!el.tabs.contains(event.target)) return { groupId: null, beforeId: null, node: nodes.at(-1), side: 'after' };
  const boxes = nodes.map((n) => n.getBoundingClientRect());
  const tabOf = (n) => state.tabs.find((t) => t.id === n?.dataset.id);
  const x = event.clientX;
  const over = boxes.findIndex((b) => x >= b.left && x <= b.right);
  if (over >= 0) {
    // On a tab: its left half goes before it, its right half after - and
    // into the tab's group, if it has one.
    const left = x < boxes[over].left + boxes[over].width / 2;
    return {
      groupId: dragged.pinned ? null : tabOf(nodes[over])?.groupId || null,
      beforeId: left ? nodes[over].dataset.id : nodes[over + 1]?.dataset.id || null,
      node: nodes[over], side: left ? 'before' : 'after',
    };
  }
  // In a gap, or past either end: inside a group only between two of its tabs.
  let before = boxes.findIndex((b) => x < b.left);
  if (before < 0) before = nodes.length;
  const left = tabOf(nodes[before - 1]);
  const right = tabOf(nodes[before]);
  return {
    groupId: !dragged.pinned && left?.groupId && left.groupId === right?.groupId ? left.groupId : null,
    beforeId: nodes[before]?.dataset.id || null,
    node: nodes[before] || nodes[before - 1], side: nodes[before] ? 'before' : 'after',
  };
}

/** The tabs a drag carries: the selection, if the dragged tab is in it. */
function dragIds() {
  return local.picked.has(local.dragId) && local.picked.size > 1 ? [...local.picked] : [local.dragId];
}

function clearDropMarks() {
  el.tabs.querySelectorAll('.drop-before, .drop-after, .drop-into, .drop-plain, .chip-target')
    .forEach((n) => n.classList.remove('drop-before', 'drop-after', 'drop-into', 'drop-plain', 'chip-target'));
}

function showDrop(target) {
  clearDropMarks();
  if (!target) return;
  // The bar takes the colour of where the tab is going (see chrome.css): a
  // bar beside a grouped tab is the accent when the tab will join no group.
  const group = target.groupId ? el.tabs.querySelector(`.tab-group[data-group="${CSS.escape(target.groupId)}"]`) : null;
  group?.classList.add('drop-into');
  if (target.chip) { target.chip.classList.add('chip-target'); return; }
  target.node?.classList.add(target.side === 'before' ? 'drop-before' : 'drop-after');
  if (!target.groupId) target.node?.classList.add('drop-plain');
}

/** Drop the dragged tabs where `target` says. */
function dropTabs(target) {
  const ids = dragIds();
  clearDropMarks();
  local.dragId = null;
  document.body.classList.remove('tab-dragging');
  if (!target) return;
  const workspaceId = state.organizer?.activeWorkspace;
  invoke('organizer:move', { ids, groupId: target.groupId, workspaceId, beforeId: target.beforeId });
}

el.tabs.addEventListener('dragstart', (event) => {
  const tab = event.target.closest('.tab');
  if (!tab) return;
  local.dragId = tab.dataset.id;
  for (const id of dragIds()) el.tabs.querySelector(`.tab[data-id="${CSS.escape(id)}"]`)?.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/x-static-tab', local.dragId);
  // The empty strip drags the window, and Windows gives a window-dragging
  // area no drops; while a tab is dragged it is an ordinary drop zone.
  document.body.classList.add('tab-dragging');
  // Drop zones appear over the page: drag a tab there to split with it.
  invoke('split:drag', { id: local.dragId });
});

// Past the end of the tabs (the + button, the empty strip): see dropTarget.
document.querySelector('.strip')?.addEventListener('dragover', (event) => {
  if (!local.dragId || el.tabs.contains(event.target)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  showDrop(dropTarget(event));
});
document.querySelector('.strip')?.addEventListener('drop', (event) => {
  if (!local.dragId || el.tabs.contains(event.target)) return;
  event.preventDefault();
  dropTabs(dropTarget(event));
});
document.querySelector('.strip')?.addEventListener('dragleave', (event) => {
  if (local.dragId && !event.currentTarget.contains(event.relatedTarget)) clearDropMarks();
});

el.tabs.addEventListener('dragover', (event) => {
  if (!local.dragId) {
    // A link, an image or a file: onto a tab replaces it, anywhere else opens one.
    if (!canOpen(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    el.tabs.querySelectorAll('.link-target').forEach((n) => n.classList.remove('link-target'));
    event.target.closest('.tab')?.classList.add('link-target');
    return;
  }
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  showDrop(dropTarget(event));
});

el.tabs.addEventListener('dragleave', (event) => {
  el.tabs.querySelectorAll('.link-target').forEach((n) => n.classList.remove('link-target'));
  if (local.dragId && !el.tabs.contains(event.relatedTarget)) clearDropMarks();
});

el.tabs.addEventListener('drop', (event) => {
  if (!local.dragId) {
    el.tabs.querySelectorAll('.link-target').forEach((n) => n.classList.remove('link-target'));
    event.preventDefault();
    openDropped(event, event.target.closest('.tab')?.dataset.id);
    return;
  }
  event.preventDefault();
  dropTabs(dropTarget(event));
});

el.tabs.addEventListener('dragend', () => {
  local.dragId = null;
  document.body.classList.remove('tab-dragging');
  clearDropMarks();
  invoke('split:drag', { id: null });
  el.tabs.querySelectorAll('.dragging').forEach((node) => node.classList.remove('dragging'));
  renderTabs();
});

/**
 * Windows never delivers a drop to a window-dragging area (the empty strip
 * and the title bar are -webkit-app-region: drag): a photo dragged from
 * Explorer onto the empty tab bar was simply refused. While something from
 * outside is being dragged over the browser, those areas stop dragging the
 * window and become drop zones; they go back the moment the drag ends.
 */
let dropTimer = null;
const endDropping = () => { clearTimeout(dropTimer); document.body.classList.remove('dropping'); };
for (const type of ['dragenter', 'dragover']) {
  document.addEventListener(type, (event) => {
    if (local.dragId || !canOpen(event)) return;
    document.body.classList.add('dropping');
    // dragleave is unreliable across the native drag regions: a quiet
    // moment without dragover means the drag has gone.
    clearTimeout(dropTimer);
    dropTimer = setTimeout(endDropping, 700);
  }, true);
}
for (const type of ['drop', 'dragend']) document.addEventListener(type, endDropping, true);
// Dropped anywhere else in the chrome (the toolbar, the title bar): a new tab too.
document.addEventListener('dragover', (event) => {
  if (local.dragId || !canOpen(event) || event.defaultPrevented) return;
  if (event.target.closest('input, textarea')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('drop', (event) => {
  if (local.dragId || event.defaultPrevented || !canOpen(event)) return;
  if (event.target.closest('input, textarea')) return;
  event.preventDefault();
  openDropped(event);
});

// Links, images and files dropped on the + button or the empty strip open in a new tab.
for (const target of [el.newtab, document.querySelector('.strip-drag'), document.querySelector('.strip')]) {
  if (!target) continue;
  target.addEventListener('dragover', (event) => {
    if (local.dragId || !canOpen(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  target.addEventListener('drop', (event) => {
    if (local.dragId || event.defaultPrevented || !canOpen(event)) return;
    event.preventDefault();
    openDropped(event);
  });
}

// Right-click on the empty strip: the strip's own menu.
document.querySelector('.strip')?.addEventListener('contextmenu', (event) => {
  if (event.target.closest('.tab, .tab-group-chip, .tab-group, button')) return;
  contextMenu([
    { label: 'New tab', icon: 'plus', shortcut: accel('tab:new'), action: doAction('tab:new') },
    { label: 'Reopen closed tab', shortcut: accel('tab:reopen'), action: doAction('tab:reopen') },
    { label: 'Organise tabs', icon: 'grid', action: doAction('open:organizer') },
    { separator: true },
    ...tabLayoutItems(),
  ], event);
});

// Suppress the default context menu everywhere we have not built our own.
document.addEventListener('contextmenu', (event) => {
  if (event.target.closest('#address')) return; // keep text editing menu
  if (event.target.closest('.tab') || event.target.closest('.bookmark')) return;
  event.preventDefault();
});

// Ctrl+L and friends are handled in main via before-input-event, so the only
// key work left here is menu dismissal, which ui.js already owns.

window.browser.on('app:state', (payload) => { state = payload; render(); });
window.browser.on('ui:focus-address', () => { el.address.focus(); el.address.select(); });
window.browser.on('ui:open-menu', () => toggleMenu(el.appMenu, mainMenuItems(), 'left'));

buildChrome();

// Shortcut table first, so menus render their accelerators on the first paint.
invoke('ui:shortcuts').then((list) => {
  shortcuts = new Map();
  for (const entry of list || []) if (!shortcuts.has(entry.id)) shortcuts.set(entry.id, entry);
  return invoke('app:state');
}).then((payload) => {
  if (payload) { state = payload; render(); }
});
