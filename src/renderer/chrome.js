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
  address: $('address'), security: $('security'), star: $('star'),
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
    { label: 'New tab', icon: 'plus', shortcut: accel('tab:new'), action: doAction('tab:new') },
    { label: 'New incognito window', icon: 'incognito', shortcut: accel('window:incognito'), action: doAction('window:incognito') },
    { label: 'Workspaces', icon: 'grid', shortcut: accel('open:dashboard'), action: doAction('open:dashboard') },
    { label: 'Organise Tabs', icon: 'grid', shortcut: accel('open:organizer'), action: doAction('open:organizer') },
    { label: 'Screen Time', icon: 'clock', shortcut: accel('open:screentime'), action: doAction('open:screentime') },
    { separator: true },
    { label: 'AI chat', icon: 'sparkle', shortcut: accel('open:ai'), action: doAction('open:ai') },
    { separator: true },
    { label: 'Bookmarks', icon: 'bookmark', shortcut: accel('open:bookmarks'), action: doAction('open:bookmarks') },
    { label: 'History', icon: 'clock', shortcut: accel('open:history'), action: doAction('open:history') },
    { label: 'Downloads', icon: 'download', shortcut: accel('open:downloads'), action: doAction('open:downloads') },
    { separator: true },
    { label: 'Sidebar', icon: 'sidebar', hint: 'Workspace sidebar', value: s.sidebarMode || 'on', choices: [
      { label: 'On', value: 'on', action: action('settings:update', { sidebarMode: 'on' }) },
      { label: 'Autohide', value: 'autohide', action: action('settings:update', { sidebarMode: 'autohide' }) },
      { label: 'Off', value: 'off', action: action('settings:update', { sidebarMode: 'off' }) },
    ] },
    { separator: true },
    { label: 'Extensions', icon: 'puzzle', shortcut: accel('open:extensions'), action: doAction('open:extensions') },
    { label: 'Settings', icon: 'gear', shortcut: accel('open:settings'), action: doAction('open:settings') },
    { separator: true },
    {
      label: 'Show bookmarks bar',
      icon: 'bookmark',
      checked: !!s.bookmarksBar,
      action: action('settings:update', { bookmarksBar: !s.bookmarksBar }),
    },
    { separator: true },
    { label: 'Developer tools', icon: 'code', shortcut: accel('window:devtools'), action: doAction('window:devtools') },
    { separator: true },
    { label: 'Help & about Static', icon: 'help', action: action('tabs:new', { url: 'browser://settings#about' }) },
    { label: 'Exit', icon: 'close', action: action('window:control', { action: 'close' }) },
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
 * The layout choice, offered wherever the tab strip is right-clicked. The
 * hint says what vertical tabs are for, because the name alone does not.
 */
function tabLayoutItems() {
  return [
    { heading: true, label: 'Tab layout' },
    {
      label: 'Show tabs vertically', icon: 'sidebar',
      hint: 'See whole titles, manage groups easily and free up vertical space. Best with many tabs open.',
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

/** Right-click menu for a tab. */
function tabContextMenu(tab, event) {
  contextMenu([
    { label: tab.pinned ? 'Unpin tab' : 'Pin tab', icon: 'bookmark', action: action('organizer:pin', { ids: [tab.id], pinned: !tab.pinned }) },
    { label: state.organizer?.sleeping.includes(tab.id) ? 'Wake tab' : 'Sleep tab', icon: 'clock',
      action: state.organizer?.sleeping.includes(tab.id) ? action('organizer:wake', { id: tab.id }) : action('organizer:sleep', { ids: [tab.id] }) },
    { label: 'Reload', icon: 'reload', action: doAction('page:reload') },
    { label: 'Duplicate', icon: 'plus', action: action('tabs:new', { url: tab.url }) },
    { separator: true },
    { label: 'Bookmark', icon: 'star', action: action('bookmarks:toggle', { url: tab.url, title: tab.title }) },
    { separator: true },
    ...tabLayoutItems(),
    { separator: true },
    {
      label: 'Close tab', icon: 'close', danger: true, shortcut: accel('tab:close'),
      action: action('tabs:close', { id: tab.id }),
    },
  ], event);
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

function renderTabs() {
  // Replacing dragged DOM nodes cancels Chromium's native drag session.
  if (local.dragId) return;
  const active = state.tabs.find(t => t.active);
  el.windowTitle.textContent = active?.title ? active.title + ' — static' : 'static';
  const organizer = state.organizer || { groups: [], workspaces: [], activeWorkspace: 'main', sleeping: [] };
  $('workspace-switch').textContent = organizer.workspaces.find(w => w.id === organizer.activeWorkspace)?.name || 'Main';
  const visible = state.tabs.filter(t => (t.workspaceId || 'main') === organizer.activeWorkspace);
  const painted = new Set();
  el.tabs.replaceChildren(...visible.flatMap((tab) => {
    const group = organizer.groups.find(g => g.id === tab.groupId), nodes = [];
    if (group && !painted.has(group.id)) {
      painted.add(group.id);
      const chip = document.createElement('button');
      chip.className = 'tab-group-chip'; chip.textContent = (group.collapsed ? '▸ ' : '▾ ') + group.name;
      chip.title = 'Collapse or expand ' + group.name; chip.dataset.groupId = group.id;
      chip.style.setProperty('--group-color', group.color); chip.setAttribute('aria-expanded', String(!group.collapsed));
      chip.addEventListener('click', () => invoke('organizer:group', { id: group.id, collapsed: !group.collapsed }));
      chip.addEventListener('contextmenu', event => contextMenu([
        { label: 'Edit in Organizer', icon: 'grid', action: doAction('open:organizer') },
        { label: 'Save all tabs as session', icon: 'bookmark', action: action('organizer:save-session') },
      ], event));
      nodes.push(chip);
    }
    if (group?.collapsed && !tab.active) return nodes;
    const node = document.createElement('div');
    node.className = 'tab' + (tab.active ? ' active' : '') + (organizer.sleeping.includes(tab.id) ? ' sleeping' : '') + (group ? ' grouped' : '');
    if (group) node.style.setProperty('--group-color', group.color);
    node.draggable = true;
    node.dataset.id = tab.id;
    node.title = tab.title || '';

    if (tab.loading) {
      const spinner = document.createElement('div');
      spinner.className = 'spinner';
      node.append(spinner);
    } else if (tab.favicon) {
      const img = document.createElement('img');
      img.className = 'favicon';
      img.src = tab.favicon;
      img.onerror = () => img.replaceWith(window.ui.icon('search', { size: 14 }));
      node.append(img);
    } else {
      node.append(window.ui.icon('search', { size: 14 }));
    }

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = (tab.pinned ? '◆ ' : '') + (organizer.sleeping.includes(tab.id) ? '◌ ' : '') + (tab.title || 'New tab');
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

    node.addEventListener('click', () => invoke('tabs:select', { id: tab.id }));
    node.addEventListener('auxclick', (event) => {
      if (event.button === 1) invoke('tabs:close', { id: tab.id });
    });
    node.addEventListener('contextmenu', (event) => tabContextMenu(tab, event));
    return [...nodes, node];
  }));
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

  const marks = { secure: 'lock', insecure: 'warn', error: 'warn', internal: 'gear', extension: 'puzzle' };
  el.security.replaceChildren(window.ui.icon(marks[active.security] || 'search', { size: 14 }));
  el.security.className = 'security ' + (active.security || '');
  el.security.title = {
    secure: 'Connection is secure (HTTPS)',
    insecure: 'Not secure (HTTP)',
    error: 'Page failed to load',
    internal: 'Built-in page',
    extension: 'Extension page',
  }[active.security] || '';

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

/* Drag to reorder tabs. The drop index comes from the midpoint of each tab so
   the insertion point matches where the cursor visually sits. */
el.tabs.addEventListener('dragstart', (event) => {
  const tab = event.target.closest('.tab');
  if (!tab) return;
  local.dragId = tab.dataset.id;
  tab.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
});

el.tabs.addEventListener('dragover', (event) => {
  if (!local.dragId) {
    // A link from a page: onto a tab replaces it, anywhere else opens one.
    const types = event.dataTransfer?.types || [];
    if (!types.includes('text/uri-list') && !types.includes('text/plain')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    el.tabs.querySelectorAll('.link-target').forEach((n) => n.classList.remove('link-target'));
    event.target.closest('.tab')?.classList.add('link-target');
    return;
  }
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
});

el.tabs.addEventListener('dragleave', () => {
  el.tabs.querySelectorAll('.link-target').forEach((n) => n.classList.remove('link-target'));
});

el.tabs.addEventListener('drop', (event) => {
  if (!local.dragId) {
    el.tabs.querySelectorAll('.link-target').forEach((n) => n.classList.remove('link-target'));
    const url = droppedLink(event);
    if (!url) return;
    event.preventDefault();
    const over = event.target.closest('.tab');
    if (over) invoke('tabs:navigate', { id: over.dataset.id, input: url });
    else invoke('tabs:new', { url });
    return;
  }
  event.preventDefault();
  const groupChip = event.target.closest('[data-group-id]');
  if (groupChip) {
    invoke('organizer:move', { ids: [local.dragId], groupId: groupChip.dataset.groupId });
    local.dragId = null; return;
  }
  const nodes = [...el.tabs.querySelectorAll('.tab')].filter(n => n.dataset.id !== local.dragId);
  let index = nodes.findIndex((node) => {
    const box = node.getBoundingClientRect();
    return event.clientX < box.left + box.width / 2;
  });
  const targetId = index === -1 ? nodes.at(-1)?.dataset.id : nodes[index]?.dataset.id;
  const target = state.tabs.find(t => t.id === targetId);
  if (target) invoke('organizer:move', { ids: [local.dragId], groupId: target.groupId, workspaceId: target.workspaceId,
    beforeId: index === -1 ? null : targetId });
  local.dragId = null;
});

el.tabs.addEventListener('dragend', () => {
  local.dragId = null;
  el.tabs.querySelectorAll('.dragging').forEach((node) => node.classList.remove('dragging'));
  renderTabs();
});

// Links dropped on the + button or the empty strip open in a new tab.
for (const target of [el.newtab, document.querySelector('.strip-drag')]) {
  if (!target) continue;
  target.addEventListener('dragover', (event) => {
    const types = event.dataTransfer?.types || [];
    if (local.dragId || (!types.includes('text/uri-list') && !types.includes('text/plain'))) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  target.addEventListener('drop', (event) => {
    const url = droppedLink(event);
    if (!url || local.dragId) return;
    event.preventDefault();
    invoke('tabs:new', { url });
  });
}

// Right-click on the empty strip: the strip's own menu.
document.querySelector('.strip')?.addEventListener('contextmenu', (event) => {
  if (event.target.closest('.tab, .tab-group-chip, button')) return;
  contextMenu([
    { label: 'New tab', icon: 'plus', shortcut: accel('tab:new'), action: doAction('tab:new') },
    { label: 'Reopen closed tab', icon: 'reload', shortcut: accel('tab:reopen'), action: doAction('tab:reopen') },
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
  shortcuts = new Map((list || []).map((entry) => [entry.id, entry]));
  return invoke('app:state');
}).then((payload) => {
  if (payload) { state = payload; render(); }
});
