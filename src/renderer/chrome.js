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
  tabs: $('tabs'), newtab: $('newtab'), tabSearch: $('tab-search'),
  back: $('back'), forward: $('forward'), reload: $('reload'), home: $('home'),
  address: $('address'), security: $('security'), star: $('star'), key: $('key'),
  reader: $('reader'), qr: $('qr'),
  suggestions: $('suggestions'), bookmarks: $('bookmarks'),
  overflow: $('overflow'), notice: $('notice'), downloads: $('downloads'),
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
  // "id:muted" for each tab showing a speaker at the last redraw.
  sounding: new Set(),
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
// Bumped whenever the theme changes, so measurements that depend on it
// (a font size, a radius) are taken again.
let themeGeneration = 0;

function applyTheme(settings) {
  const key = JSON.stringify(window.theme.cssVariables(settings));
  if (key === appliedTheme) return;
  appliedTheme = key;
  themeGeneration++;
  const vars = window.theme.cssVariables(settings);
  for (const [name, value] of Object.entries(vars)) {
    document.documentElement.style.setProperty(name, value);
  }
  // Animations just turned off: anything still moving lands at once.
  if (!motion.duration()) motion.settle();
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
  setIcon(el.reader, 'reader');
  setIcon(el.qr, 'qr');
  setIcon(el.newtab, 'plus');
  setIcon(el.overflow, 'menu');
  el.tabSearch.append(icon('tab_search', { size: 17 }));
  // The downloads button: its arrow, and a ring for the progress.
  const ring = document.createElement('span');
  ring.className = 'dl-ring';
  el.downloads.append(icon('download', { size: 17 }), ring);
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
    { label: 'New window', icon: 'window_new', shortcut: accel('window:new'), action: doAction('window:new') },
    // In split view, the way out; otherwise the list of what to put beside it.
    (state.tabs || []).some((t) => t.active && t.splitWith)
      ? { label: 'Exit split view', icon: 'split', action: action('split:exit') }
      : { label: 'Split view', icon: 'split', more: true, action: action('split:pick-menu') },
    { label: 'Find in page', icon: 'search', shortcut: accel('find:open'), action: doAction('find:open') },
    { label: 'Print…', icon: 'doc', shortcut: accel('page:print'), action: doAction('page:print') },
    // Its three kinds open in this menu's place (see main's shot:menu).
    { label: 'Screenshot', icon: 'camera', more: true, action: action('shot:menu') },
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
      // Every window, as Exit is in every browser; the window's own close
      // button closes just the one.
      { label: 'Exit', danger: true, action: action('window:control', { action: 'quit' }) },
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
  renderDownloads();
  renderBookmarks();
  renderNotice();
  if (!drawnOnce && state.window?.arriving) arrive();
  drawnOnce = true;
}

/**
 * A window opened from inside Static - Ctrl+N, a tab moved out of another -
 * arrives rather than appearing: the tab strip and the toolbar settle into
 * place, one just behind the other. The first draw only, and not at all
 * with animations off or reduced motion asked for: the window is there
 * either way, this is only how it lands.
 */
function arrive() {
  const ms = motion.duration();
  if (!ms) return;
  const parts = [document.querySelector('.strip'), document.querySelector('.toolbar'), el.bookmarks.hidden ? null : el.bookmarks]
    .filter((node) => node && node.offsetHeight);
  parts.forEach((node, i) => node.animate([
    { opacity: 0, transform: 'translateY(-6px)' },
    { opacity: 1, transform: 'none' },
  ], {
    duration: Math.round(ms * 1.3), delay: i * 45, easing: motion.ease(),
    // Held at the start through its delay, so nothing shows before it moves;
    // the id lets motion.settle() finish it if animations are turned off.
    fill: 'backwards', id: 'motion-enter',
  }));
}

/** The first letter of a tab's title, for a pinned tab with no favicon. */
const initialOf = (tab) => (tab.title || tab.url || '?').replace(/^[^\p{L}\p{N}]+/u, '').charAt(0).toUpperCase() || '·';

/**
 * What a tab's icon shows, as a key: the icon is only rebuilt when this
 * changes, so a favicon is not reloaded (and a spinner not restarted) on
 * every state push.
 */
const iconKey = (tab) => (tab.loading ? 'spin' : tab.favicon ? 'img:' + tab.favicon : tab.pinned ? 'letter:' + initialOf(tab) : 'glyph');

/**
 * A tab's icon: its favicon, a spinner while it loads, or a letter.
 * `swapped` hears about a favicon that failed and was replaced.
 */
function tabIcon(tab, size = 16, swapped = () => {}) {
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
    mark.textContent = initialOf(tab);
    return mark;
  };
  const fallback = () => (tab.pinned ? letter() : window.ui.icon('search', { size: 14 }));
  if (!tab.favicon) return fallback();
  const img = document.createElement('img');
  img.className = 'favicon';
  img.width = size; img.height = size;
  img.src = tab.favicon;
  img.onerror = () => {
    const stand = fallback();
    img.replaceWith(stand);
    swapped(stand, img);
  };
  return img;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * A speaker whose two sound waves pulse in turn while the tab plays, or the
 * struck-out one of a muted tab. Drawn here rather than from the icon set
 * because the waves have to be separate paths to move on their own.
 */
function speakerGlyph(muted, size) {
  if (muted) return window.ui.icon('muted', { size });
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon-svg', 'speaker');
  for (const [d, cls] of [['M4 9.5h3.5L12 5.5v13l-4.5-4H4Z', 'cone'], ['M15.5 9a4 4 0 0 1 0 6', 'wave wave-1'], ['M18 6.5a7.5 7.5 0 0 1 0 11', 'wave wave-2']]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('class', cls);
    svg.append(path);
  }
  return svg;
}

/**
 * The speaker on a tab that is making sound, or has been muted: one click
 * silences it or lets it be heard again. A pinned tab, which is only its
 * icon, wears the same thing as a small badge on the corner instead.
 */
function soundButton(tab, { badge = false } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = (badge ? 'tab-sound-badge' : 'tab-sound') + (tab.muted ? ' is-muted' : ' is-playing');
  button.title = tab.muted ? 'Unmute tab' : 'Mute tab';
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-pressed', String(!!tab.muted));
  button.draggable = false;
  // Only a speaker that has just appeared pops in - not one on a tab that
  // was drawn again (unfolded, say) - and the waves keep their beat.
  if (!local.sounding.has(tab.id + ':' + !!tab.muted)) button.classList.add('is-new');
  const glyph = speakerGlyph(!!tab.muted, badge ? 10 : 15);
  glyph.style.setProperty('--wave-phase', -(Date.now() % 1190) + 'ms');
  button.append(glyph);
  button.addEventListener('click', (event) => {
    // A press on the speaker is not a press on the tab: no switching to it.
    event.stopPropagation();
    invoke('tabs:mute', { ids: [tab.id], muted: !tab.muted });
  });
  return button;
}

/* ---- the tab strip ---------------------------------------------------------
   Kept, not redrawn. Each tab has one node for as long as it is open, found
   by its id and brought up to date in place, and a change inserts, moves or
   removes only the nodes it touched. The strip used to be rebuilt from
   nothing on every state push, so a closing tab simply vanished, a new one
   popped in and a dragged one jumped. Kept nodes can move instead (see
   shared/motion.js):
   - a closing tab narrows to nothing as it fades, and its neighbours close
     the gap; it is only a picture by then - no clicks, no hover card;
   - a new tab grows into its place while its neighbours make room;
   - a tab moved - dragged, pinned, grouped, organised - glides there;
   - a folded group's tabs slide into its chip, and back out of it.
   Every move is short and answers something the person just did; nothing
   moves on its own, and the animations setting stills all of it. */

const strip = {
  host: document.querySelector('.strip'),
  tabs: new Map(),      // tab id -> its node
  parts: new WeakMap(), // tab node -> its icon, title, speaker and close button
  groups: new Map(),    // group id -> the wrapper its tabs sit in
  chips: new Map(),     // group id -> its chip
  rule: null,           // the hairline after the pinned tabs
  shape: '',            // the order drawn at the last change
  workspace: null,
  folded: new Set(),    // tab ids tucked into a folded group at the last change
  floors: '',           // what the groups' minimum widths were worked out for
  unclip: 0,
};

const tabById = (id) => state.tabs.find((t) => t.id === id);

/** The tabs on the strip: those in the workspace being shown. */
function visibleTabs() {
  const workspace = state.organizer?.activeWorkspace || 'main';
  return state.tabs.filter((t) => (t.workspaceId || 'main') === workspace);
}

/**
 * A tab's node, made once. Its listeners look the tab up when they fire,
 * because the node outlives any one state.
 */
function makeTab(id) {
  const node = document.createElement('div');
  node.className = 'tab';
  node.draggable = true;
  node.dataset.id = id;
  node.setAttribute('role', 'tab');
  node.addEventListener('click', (event) => {
    const tab = tabById(id);
    if (tab) clickTab(tab, event, visibleTabs());
  });
  node.addEventListener('auxclick', (event) => {
    if (event.button === 1) invoke('tabs:close', { id });
  });
  node.addEventListener('contextmenu', (event) => {
    const tab = tabById(id);
    if (tab) tabContextMenu(tab, event);
    else event.preventDefault();
  });
  strip.tabs.set(id, node);
  strip.parts.set(node, {});
  return node;
}

function closeButton(id) {
  const close = document.createElement('button');
  close.className = 'close';
  close.type = 'button';
  close.title = 'Close tab';
  close.append(window.ui.icon('close', { size: 13 }));
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    invoke('tabs:close', { id });
  });
  return close;
}

/** Bring a tab's node up to date, rebuilding only the parts that changed. */
function drawTab(tab, sleeping, group) {
  const node = strip.tabs.get(tab.id) || makeTab(tab.id);
  const parts = strip.parts.get(node);
  const sound = !!(tab.audible || tab.muted);
  // Toggled one by one, never assigned: a drop marker or the narrow flag
  // set elsewhere must survive a redraw.
  node.classList.toggle('active', !!tab.active);
  node.classList.toggle('pinned', !!tab.pinned);
  node.classList.toggle('split-left', tab.splitSide === 'left');
  node.classList.toggle('split-right', tab.splitSide === 'right');
  node.classList.toggle('sleeping', sleeping);
  node.classList.toggle('grouped', !!group);
  node.classList.toggle('picked', local.picked.has(tab.id));
  node.classList.toggle('has-sound', sound);
  // With hover cards on, the card says all this and more; a tooltip on top
  // of it would only cover it.
  if (state.settings?.tabPreviews === false) {
    node.title = (tab.title || 'New tab') + (tab.pinned ? ' (pinned)' : '') + (sleeping ? ' - sleeping' : '');
  } else node.removeAttribute('title');
  node.setAttribute('aria-selected', String(!!tab.active));
  node.setAttribute('aria-label', (tab.title || 'New tab') + (tab.muted ? ', muted' : tab.audible ? ', playing sound' : ''));

  // A favicon that failed once is not asked for again: the tab shows what
  // stands in for it, which follows pinning (a letter) and unpinning (a
  // glyph) and the title like the icon of any tab without one.
  const shown = tab.favicon && parts.broken === tab.favicon ? { ...tab, favicon: '' } : tab;
  const icon = iconKey(shown);
  if (parts.iconKey !== icon) {
    parts.iconKey = icon;
    parts.icon = tabIcon(shown, 16, (stand, img) => {
      // Only while it is still the icon shown: a spinner or a newer favicon
      // may have taken its place before it failed.
      if (parts.icon !== img) return;
      parts.icon = stand;
      parts.broken = shown.favicon;
      parts.iconKey = iconKey({ ...shown, favicon: '' });
    });
  }
  // A pinned tab is a small square with just its icon, as in Chrome: no
  // title, no close button. Its title is in the tooltip; sound is a badge.
  const speaker = sound ? (tab.pinned ? 'badge:' : 'row:') + !!tab.muted : '';
  if (parts.speaker !== speaker) {
    parts.speaker = speaker;
    parts.sound = sound ? soundButton(tab, { badge: !!tab.pinned }) : null;
  }
  if (!tab.pinned) {
    if (!parts.title) {
      parts.title = document.createElement('span');
      parts.title.className = 'title';
    }
    const text = (sleeping ? '◌ ' : '') + (tab.title || 'New tab');
    if (parts.title.textContent !== text) parts.title.textContent = text;
    parts.close ||= closeButton(tab.id);
  }
  const wanted = (tab.pinned ? [parts.icon, parts.sound] : [parts.icon, parts.title, parts.sound, parts.close]).filter(Boolean);
  const children = node.children;
  if (children.length !== wanted.length || wanted.some((part, i) => children[i] !== part)) node.replaceChildren(...wanted);
  return node;
}

/**
 * A group's chip: a filled pill in the group's colour, its name, and how
 * many tabs it holds when folded. Click folds and unfolds; right-click opens
 * the group's own menu (rename, colour, ungroup, close).
 */
function makeChip(id) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'tab-group-chip';
  chip.dataset.groupId = id;
  const name = document.createElement('span');
  name.className = 'chip-name';
  chip.append(name);
  chip.addEventListener('click', () => {
    const group = state.organizer?.groups?.find((g) => g.id === id);
    if (group) invoke('organizer:group', { id, collapsed: !group.collapsed });
  });
  chip.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    closeOverlayMenu();
    invoke('organizer:chip-menu', { id, anchor: pointAt(event) });
  });
  return chip;
}

function drawChip(chip, group, count) {
  chip.classList.toggle('collapsed', !!group.collapsed);
  chip.title = (group.collapsed ? 'Expand ' : 'Collapse ') + group.name + ' (' + count + (count === 1 ? ' tab)' : ' tabs)');
  chip.setAttribute('aria-expanded', String(!group.collapsed));
  if (chip.firstChild.textContent !== group.name) chip.firstChild.textContent = group.name;
  // Folded: how many tabs are inside. The badge pops in once, when it folds.
  let badge = chip.querySelector('.chip-count');
  if (group.collapsed) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'chip-count';
      chip.append(badge);
    }
    if (badge.textContent !== String(count)) badge.textContent = String(count);
  } else badge?.remove();
}

/** A group's wrapper, which runs its colour under the chip and every tab in it. */
function drawGroup(group, count) {
  let wrap = strip.groups.get(group.id);
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'tab-group';
    wrap.dataset.group = group.id;
    strip.groups.set(group.id, wrap);
    strip.chips.set(group.id, makeChip(group.id));
  }
  wrap.classList.toggle('collapsed', !!group.collapsed);
  wrap.style.setProperty('--group-color', group.color);
  drawChip(strip.chips.get(group.id), group, count);
  return wrap;
}

function renderTabs() {
  // Moving a dragged node cancels Chromium's native drag session.
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
  const sleeping = new Set(organizer.sleeping || []);
  const groups = new Map((organizer.groups || []).map((g) => [g.id, g]));
  const top = [];
  const inside = new Map(); // group wrapper -> its chip, then its tabs
  const folded = new Set();
  const shape = [];
  const pinned = visible.filter((t) => t.pinned);
  for (const tab of pinned) {
    top.push(drawTab(tab, sleeping.has(tab.id), null));
    shape.push(tab.id);
  }
  const rest = visible.filter((t) => !t.pinned);
  if (pinned.length && rest.length) {
    if (!strip.rule) {
      strip.rule = document.createElement('span');
      strip.rule.className = 'pinned-rule';
    }
    top.push(strip.rule);
    shape.push('|');
  }
  const counts = new Map();
  for (const tab of rest) if (groups.has(tab.groupId)) counts.set(tab.groupId, (counts.get(tab.groupId) || 0) + 1);
  for (const tab of rest) {
    const group = groups.get(tab.groupId);
    if (!group) {
      top.push(drawTab(tab, sleeping.has(tab.id), null));
      shape.push(tab.id);
      continue;
    }
    let wrap = strip.groups.get(group.id);
    if (!wrap || !inside.has(wrap)) {
      wrap = drawGroup(group, counts.get(group.id));
      inside.set(wrap, [strip.chips.get(group.id)]);
      top.push(wrap);
      shape.push('[' + group.id);
    }
    // A folded group still shows the tab you are on, so it never vanishes.
    if (group.collapsed && !tab.active) {
      folded.add(tab.id);
      continue;
    }
    inside.get(wrap).push(drawTab(tab, sleeping.has(tab.id), group));
    shape.push(group.id + '>' + tab.id);
  }
  const key = shape.join(' ');
  if (key !== strip.shape || organizer.activeWorkspace !== strip.workspace) {
    placeTabs(top, inside, { key, workspace: organizer.activeWorkspace, folded });
  } else setFloors(inside);
  markNarrowTabs();
  local.sounding = new Set(visible.filter((t) => t.audible || t.muted).map((t) => t.id + ':' + !!t.muted));
  // The tab under the pointer may have just closed.
  if (hover.id && !state.tabs.some((t) => t.id === hover.id)) hidePreview();
}

/**
 * Put the strip's nodes where `top` and `inside` say, and play the change.
 *
 * Reads and writes are kept apart so the browser lays the strip out twice
 * in all, however many tabs there are: once to see where everything is
 * drawn now, once to see where it has landed.
 */
function placeTabs(top, inside, next) {
  // Moves only ever answer a change on this strip: not the first draw, not
  // a switch to another workspace's tabs, and not while the strip is hidden.
  const animate = motion.duration() > 0 && !!strip.shape && next.workspace === strip.workspace
    && !document.body.classList.contains('vertical-tabs');
  const wasFolded = strip.folded;
  strip.shape = next.key;
  strip.workspace = next.workspace;
  strip.folded = next.folded;

  const wanted = new Set(top);
  for (const list of inside.values()) for (const node of list) wanted.add(node);
  const going = [...el.tabs.querySelectorAll('.tab, .tab-group-chip, .pinned-rule')].filter((node) => !wanted.has(node));
  for (const [id, node] of strip.tabs) if (!wanted.has(node)) strip.tabs.delete(id);
  for (const [id, wrap] of strip.groups) {
    if (!wanted.has(wrap)) { strip.groups.delete(id); strip.chips.delete(id); }
  }
  // A hairline on its way out is a ghost now; the next one is made afresh.
  if (strip.rule && !wanted.has(strip.rule)) strip.rule = null;

  // READ: where everything is drawn now, and how each leaving node looks.
  let first = null;
  let gone = [];
  let hostBox = null;
  let crowded = false;
  if (animate) {
    first = motion.measure([...wanted, el.newtab]);
    hostBox = strip.host.getBoundingClientRect();
    const view = el.tabs.getBoundingClientRect();
    crowded = el.tabs.scrollWidth > el.tabs.clientWidth + 1;
    gone = going.map((node) => {
      const box = node.getBoundingClientRect();
      const look = getComputedStyle(node);
      // A tab closed while it was still growing in leaves from the width it
      // had reached, not its full one.
      const clip = /^inset\(\S+ ([\d.]+)%/.exec(look.clipPath);
      const shown = clip ? Math.max(0, 1 - clip[1] / 100) : 1;
      return {
        node, id: node.dataset.id,
        box: { left: box.left, top: box.top, width: box.width * shown, height: box.height },
        opacity: Number(look.opacity),
        paint: { background: look.backgroundColor, color: look.color },
        // Only what can be seen leaves slowly; a tab scrolled out of sight just goes.
        seen: box.width > 0 && box.right > view.left && box.left < view.right,
      };
    });
  }

  // WRITE: lift the leaving nodes out where they are, then put every node
  // that stays in its new place.
  if (animate) {
    motion.halt(first.keys());
    for (const leaving of gone) if (leaving.seen) motion.lift(leaving.node, strip.host, leaving.box, hostBox, leaving.paint);
  }
  motion.arrange(el.tabs, top);
  for (const [wrap, list] of inside) motion.arrange(wrap, list);
  setFloors(inside);
  if (!animate) return;

  // READ: where everything has landed.
  const entering = [...wanted].filter((node) => !first.has(node));
  const last = motion.measure([...first.keys(), ...entering]);
  // A strip that has just filled up scrolls now; letting it spill would draw
  // its tabs over the buttons beside it. (Laid out already: no extra cost.)
  crowded ||= el.tabs.scrollWidth > el.tabs.clientWidth + 1;

  // WRITE: play it all, from where it was to where it is. While it plays, an
  // uncrowded strip lets tabs slide past its edge rather than clipping them.
  if (crowded) {
    clearTimeout(strip.unclip);
    el.tabs.classList.remove('is-moving');
  } else {
    el.tabs.classList.add('is-moving');
    clearTimeout(strip.unclip);
    strip.unclip = setTimeout(() => el.tabs.classList.remove('is-moving'), motion.duration() + 80);
  }
  motion.glide(first, last, {
    parentOf: (node) => (node.parentElement?.classList.contains('tab-group') ? node.parentElement : null),
    stretch: (node) => node.classList.contains('tab'),
  });
  const chipOf = (id) => {
    const groupId = tabById(id)?.groupId;
    return groupId ? last.get(strip.chips.get(groupId)) : null;
  };
  for (const node of entering) {
    const box = last.get(node);
    if (!box) continue;
    if (node.classList.contains('tab')) {
      const id = node.dataset.id;
      const chip = wasFolded.has(id) ? chipOf(id) : null;
      // Unfolded: out from under the chip. New: grows into its place.
      if (chip) {
        motion.enter(node, [
          { transform: 'translateX(' + (chip.right - box.left) + 'px)', clipPath: 'inset(0 100% 0 0)', opacity: 0 },
          { transform: 'none', clipPath: 'inset(0 0 0 0)', opacity: 1 },
        ]);
      } else {
        motion.enter(node, [
          { clipPath: 'inset(0 100% 0 0 round 8px 8px 0 0)', opacity: 0 },
          { opacity: 1, offset: 0.55 },
          { clipPath: 'inset(0 0 0 0 round 8px 8px 0 0)', opacity: 1 },
        ]);
      }
    } else if (node.classList.contains('tab-group-chip')) {
      motion.enter(node, [{ transform: 'scale(.6)', opacity: 0 }, { transform: 'none', opacity: 1 }]);
    } else if (node === strip.rule) {
      motion.enter(node, [{ opacity: 0 }, { opacity: 1 }]);
    }
  }
  // A group's coloured underline stretches and shrinks with it, rather than
  // jumping to its new length while its tabs are still on the way.
  for (const wrap of inside.keys()) {
    const now = last.get(wrap);
    if (!now || now.width <= 0) continue;
    const was = first.get(wrap);
    const from = Math.min(8, was ? was.width / now.width : 0);
    if (Math.abs(from - 1) < 0.01) continue;
    motion.enter(wrap, [
      { transform: 'scaleX(' + from + ')', transformOrigin: '0 0' },
      { transform: 'none', transformOrigin: '0 0' },
    ], { pseudoElement: '::after', moving: true });
  }
  for (const leaving of gone) {
    if (!leaving.seen) continue;
    const node = leaving.node;
    if (node.classList.contains('tab-group-chip')) {
      motion.leave(node, [{ transform: 'none', opacity: 1 }, { transform: 'scale(.6)', opacity: 0 }]);
    } else if (node.classList.contains('pinned-rule')) {
      motion.leave(node, [{ opacity: 1 }, { opacity: 0 }]);
    } else {
      // Folded away: into its chip. Closed: narrows to nothing where it was.
      // It stays mostly solid while it narrows and fades in the last part
      // of the move, so the eye sees the tab itself close up rather than a
      // gap that was already empty.
      const chip = next.folded.has(leaving.id) ? chipOf(leaving.id) : null;
      const end = { width: '0px', paddingLeft: '0px', paddingRight: '0px', opacity: 0 };
      if (chip) end.transform = 'translateX(' + (chip.right - leaving.box.left) + 'px)';
      motion.leave(node, [
        { width: leaving.box.width + 'px', opacity: leaving.opacity, transform: 'none' },
        { opacity: leaving.opacity * 0.85, offset: 0.45 },
        end,
      ]);
    }
  }
}

/**
 * A crowded strip shrinks a group's tabs to their 56px minimum like any
 * other, and no further (see .tab-group in chrome.css): the chip, then each
 * tab and the 2px gap before it. Worked out only when a group's contents
 * change, and every chip is measured before any floor is written, so the
 * strip is laid out once rather than once per group.
 */
function setFloors(inside) {
  const key = themeGeneration + (document.body.classList.contains('vertical-tabs') ? 'v' : 'h') + [...inside]
    .map(([wrap, list]) => wrap.dataset.group + ':' + list[0].textContent + ':' + list.length).join('|');
  if (key === strip.floors) return;
  strip.floors = key;
  const widths = [...inside].map(([wrap, list]) => [wrap, list[0].offsetWidth, list.length - 1]);
  for (const [wrap, chip, tabs] of widths) wrap.style.minWidth = (chip + 2 + tabs * 58) + 'px';
}

/**
 * A crowded strip squeezes tabs down to 56px, where an icon, a speaker and a
 * close button cannot all fit. There the speaker takes the icon's place, as
 * in Chrome, and a tab in the background gives up its close button (middle
 * click still closes it). Only tabs making sound change at all - all of them
 * measured first, then all of them marked, so the strip is laid out once.
 */
function markNarrowTabs() {
  const nodes = [...el.tabs.querySelectorAll('.tab.has-sound:not(.pinned)')];
  const narrow = nodes.map((node) => node.offsetWidth < 96);
  nodes.forEach((node, i) => node.classList.toggle('narrow', narrow[i]));
}
new ResizeObserver(() => markNarrowTabs()).observe(el.tabs);

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

  const marks = { secure: 'lock', insecure: 'warn', error: 'warn', danger: 'warn', internal: 'gear', extension: 'puzzle', file: 'doc' };
  el.security.replaceChildren(window.ui.icon(marks[active.security] || 'search', { size: 14 }));
  el.security.className = 'security ' + (active.security || '');
  el.security.title = ({
    secure: 'Connection is secure',
    insecure: 'Not secure',
    error: 'Page failed to load',
    danger: 'Static stopped this page opening: see the warning',
    internal: 'Static page',
    extension: 'Extension page',
    file: 'A file from this computer, opened only because you dragged it in',
  }[active.security] || 'This page') + (active.security === 'internal' ? ' - click for Settings' : ' - click for site information');

  // The key: this site has saved logins or passkeys. One click lists them.
  const saved = state.saved;
  el.key.hidden = !saved;
  if (saved) {
    const parts = [saved.logins ? saved.logins + (saved.logins === 1 ? ' saved login' : ' saved logins') : '',
      saved.passkeys ? saved.passkeys + (saved.passkeys === 1 ? ' passkey' : ' passkeys') : ''].filter(Boolean);
    el.key.title = parts.join(' and ') + ' for this site' + (saved.locked ? ' (locked)' : '') + ' - click to fill';
    el.key.classList.toggle('locked', !!saved.locked);
  }

  // Reading view: the book appears on pages that read like articles, and
  // stays lit while the article is open on its own.
  const reader = state.reader || {};
  const offered = !!(reader.available || reader.active);
  if (offered && el.reader.hidden) el.reader.classList.add('is-new');
  el.reader.hidden = !offered;
  el.reader.classList.toggle('on', !!reader.active);
  el.reader.setAttribute('aria-pressed', String(!!reader.active));
  el.reader.title = (reader.active ? 'Back to the page' : 'Reading view') + (accel('page:reader') ? ' (' + accel('page:reader') + ')' : '');
  // The QR code is for web addresses, which are what a phone can open.
  el.qr.hidden = !/^https?:\/\//i.test(active.url || '');

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

/** Whether the chrome has drawn once: nothing eases in on the first paint. */
let drawnOnce = false;

function renderBookmarks() {
  const show = !!state.settings?.bookmarksBar;
  const appearing = show && el.bookmarks.hidden && drawnOnce;
  el.bookmarks.hidden = !show;
  if (!show) return;
  fillBookmarks();
  // Turned on: main makes room for the bar at once (the page is not slid
  // down frame by frame), and its bookmarks settle into it one after another.
  if (appearing) {
    [...el.bookmarks.children].slice(0, 16).forEach((node, i) => {
      motion.enter(node, [{ opacity: 0, transform: 'translateY(-5px)' }, { opacity: 1, transform: 'none' }], { delay: Math.min(i * 12, 48) });
    });
  }
}

function fillBookmarks() {
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

/**
 * The notice: it rises in, and fades away rather than vanishing mid-word. A
 * second message while one is up just takes its place.
 */
const notice = { leaving: null };

function renderNotice() {
  const current = state.notice;
  if (current) {
    if (notice.leaving) {
      const leaving = notice.leaving;
      notice.leaving = null;
      leaving.cancel();
    }
    const appearing = el.notice.hidden;
    el.notice.textContent = current.message;
    el.notice.hidden = false;
    if (appearing && drawnOnce) {
      motion.enter(el.notice, [
        { opacity: 0, transform: 'translate(-50%, 8px) scale(.97)' },
        { opacity: 1, transform: 'translate(-50%, 0) scale(1)' },
      ], { scale: 1.2 });
    }
    return;
  }
  if (el.notice.hidden || notice.leaving) return;
  const ms = motion.duration();
  if (!ms) { el.notice.hidden = true; return; }
  const leaving = el.notice.animate([
    { opacity: 1, transform: 'translate(-50%, 0)' },
    { opacity: 0, transform: 'translate(-50%, 4px)' },
  ], { duration: ms, easing: motion.ease(), fill: 'forwards', id: 'motion-leave' });
  notice.leaving = leaving;
  const done = () => {
    if (notice.leaving !== leaving) return;
    notice.leaving = null;
    el.notice.hidden = true;
    leaving.cancel();
  };
  leaving.finished.then(done, done);
  // A view that is not being composited may never finish it.
  setTimeout(done, ms + 160);
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

  const typed = omni.typed.trim();
  const engine = state.settings?.searchEngine === 'brave' ? 'Brave' : 'Google';
  el.suggestions.replaceChildren(...items.map((item, index) => {
    const node = document.createElement('div');
    node.className = 'suggestion is-' + item.kind + (index === local.selected ? ' selected' : '') +
      (item.typed ? ' is-typed' : '');

    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.append(window.ui.icon(
      item.kind === 'page' ? (item.source === 'bookmark' ? 'star' : 'clock')
        : item.kind === 'go' ? 'forward' : item.past ? 'clock' : 'search',
      { size: 14 }));
    node.append(kind);

    const label = document.createElement('span');
    label.className = 'label';
    label.append(...highlighted(item.kind === 'search' ? item.query : item.kind === 'go' ? item.url : item.title, typed));
    node.append(label);

    if (item.kind === 'page') {
      const url = document.createElement('span');
      url.className = 'url';
      url.append(document.createTextNode(' — '), ...highlighted(item.url, typed));
      node.append(url);
    }

    if (item.typed) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = item.kind === 'go' ? 'Open' : 'Search ' + engine;
      node.append(tag);
    }

    node.addEventListener('mousedown', (event) => {
      event.preventDefault();
      // Middle-click on a page opens it behind, as a link would.
      if (event.button === 1 && item.kind === 'page') {
        closeSuggestions();
        invoke('tabs:new', { url: item.url, background: true });
        return;
      }
      if (event.button === 0) commit(item.url || item.query);
    });
    return node;
  }));
}

/** Text with the typed part marked, as text nodes - never parsed as markup. */
function highlighted(value, typed) {
  const [before, match, after] = window.suggest.highlightParts(value, typed);
  const parts = [document.createTextNode(before)];
  if (match) {
    const mark = document.createElement('mark');
    mark.className = 'match';
    mark.textContent = match;
    parts.push(mark, document.createTextNode(after));
  }
  return parts;
}

/**
 * The address bar's half of search suggestions. The list itself is built by
 * shared/suggest.js, exactly as on the new tab page, so both offer the same
 * rows in the same order. History and bookmarks come back at once; the
 * engine is asked by main once typing pauses, and only when main's privacy
 * rules allow. Until its answer arrives, the last one stays up narrowed to
 * what is typed now.
 */
const omni = { typed: '', pages: [], searches: [], seq: 0, timer: 0, asked: false };
const REMOTE_DELAY_MS = 120;
const remoteOn = () => state.settings?.searchSuggestions !== false && !state.incognito;

async function updateSuggestions() {
  const query = el.address.value.trim();
  omni.typed = el.address.value;
  clearTimeout(omni.timer);
  const seq = ++omni.seq;
  if (!query) {
    local.suggestions = [];
    local.selected = -1;
    renderSuggestions();
    return;
  }
  // Checked here only to skip a pointless round trip; main decides.
  const remote = remoteOn() && window.suggest.remoteAllowed(query);
  omni.searches = remote ? window.suggest.stillMatching(omni.searches, query) : [];
  const pages = (await invoke('omnibox:suggest', { query })) || [];
  if (seq !== omni.seq) return;
  omni.pages = pages;
  local.selected = -1;
  showMerged(query);
  if (!remote) return;
  omni.timer = setTimeout(async () => {
    omni.asked = true;
    const answer = await invoke('search:suggest', { query }).catch(() => null);
    if (seq !== omni.seq || !answer || answer.stale) return;
    omni.searches = Array.isArray(answer.searches) ? answer.searches : [];
    showMerged(query);
  }, REMOTE_DELAY_MS);
}

function showMerged(query) {
  const key = (item) => item ? item.kind + '\u0000' + (item.query || item.url) : '';
  const chosen = key(local.suggestions[local.selected]);
  local.suggestions = window.suggest.mergeSuggestions(query, {
    searches: remoteOn() ? omni.searches : [],
    pages: omni.pages,
    engine: state.settings?.searchEngine || 'google',
  });
  // An answer landing while the arrows are in use keeps the same row chosen.
  local.selected = chosen ? local.suggestions.findIndex((item) => key(item) === chosen) : -1;
  renderSuggestions();
}

function closeSuggestions() {
  omni.seq++;
  clearTimeout(omni.timer);
  // Main drops a request still in flight; nothing would read its answer.
  if (omni.asked) { omni.asked = false; invoke('search:suggest', { query: '' }).catch(() => {}); }
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
// Every open tab, searchable. Main draws the list in the overlay.
el.tabSearch.addEventListener('click', () => {
  hidePreview();
  invoke('tabs:search', { anchor: anchorRect(el.tabSearch) });
});

/* ---- hover previews -------------------------------------------------------
   Rest the pointer on a tab for half a second and its card comes up under
   it: the title, the site and a picture of the page (drawn by the overlay;
   see main/application.js#tabPreview). Once a card is up, moving along the
   strip carries it to each tab at once rather than waiting again, as in
   Chrome. A click, a drag, a scroll or leaving the tabs puts it away, and
   it stays away from a tab just clicked until the pointer moves on. */

const PREVIEW_DELAY_MS = 500;
const hover = { id: null, timer: 0, leave: 0, shown: false, asking: 0, warmUntil: 0, pressed: null };
const previewsOn = () => state.settings?.tabPreviews !== false;

function hoverTab(id) {
  clearTimeout(hover.leave);
  if (id !== hover.pressed) hover.pressed = null;
  if (!previewsOn() || local.dragId || menuOpenFor || id === hover.pressed) return;
  if (id === hover.id && (hover.shown || hover.timer)) return;
  clearTimeout(hover.timer);
  hover.id = id;
  const warm = hover.shown || Date.now() < hover.warmUntil;
  hover.timer = setTimeout(() => { hover.timer = 0; showPreview(id); }, warm ? 0 : PREVIEW_DELAY_MS);
}

async function showPreview(id) {
  let node = el.tabs.querySelector(`.tab[data-id="${CSS.escape(id)}"]`);
  if (!node) return;
  // A tab still sliding into place is measured where it comes to rest.
  await motion.settled(node);
  node = el.tabs.querySelector(`.tab[data-id="${CSS.escape(id)}"]`);
  if (!node || hover.id !== id || local.dragId) return;
  hover.asking++;
  const shown = await invoke('tabs:preview', { id, anchor: anchorRect(node) }).finally(() => { hover.asking--; });
  // Requests reach main in order, so a later hide has already won; only
  // remember the card if this is still the tab being hovered.
  if (hover.id === id) hover.shown = !!shown;
}

/** Put the card away - now, or after a moment in case the pointer is only crossing a gap. */
function hidePreview({ soon = false } = {}) {
  clearTimeout(hover.timer);
  hover.timer = 0;
  clearTimeout(hover.leave);
  const away = () => {
    // A card still on its way counts as up: main has not answered yet, and
    // would otherwise draw it after this, with nothing left to put it away.
    if (hover.shown || hover.asking) {
      hover.warmUntil = Date.now() + 400;
      invoke('tabs:preview', { id: null });
    }
    hover.shown = false;
    hover.id = null;
  };
  if (soon) hover.leave = setTimeout(away, 90);
  else away();
}

el.tabs.addEventListener('pointerover', (event) => {
  const node = event.target.closest('.tab');
  if (node) hoverTab(node.dataset.id);
  else hidePreview({ soon: true });
});
el.tabs.addEventListener('pointerleave', () => { hover.pressed = null; hidePreview({ soon: true }); });
el.tabs.addEventListener('pointerdown', (event) => {
  hover.pressed = event.target.closest('.tab')?.dataset.id || null;
  hidePreview();
}, true);
el.tabs.addEventListener('wheel', () => hidePreview(), { passive: true });
el.tabs.addEventListener('dragstart', () => hidePreview(), true);
el.tabs.addEventListener('contextmenu', () => hidePreview(), true);
window.addEventListener('blur', () => hidePreview());
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
el.reader.addEventListener('click', () => invoke('reader:toggle'));
el.reader.addEventListener('animationend', () => el.reader.classList.remove('is-new'));
el.qr.addEventListener('click', () => invoke('qr:show', { anchor: anchorRect(el.qr) }));
// The icon before the address: the site card (on Static's own pages, the way to Settings).
const siteInfo = () => invoke('site:info', { anchor: anchorRect(el.security) });
el.security.addEventListener('click', siteInfo);
el.security.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); siteInfo(); }
});
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
  if (event.isComposing) return;
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && items.length) {
    event.preventDefault();
    // -1 sits between the last row and the first, as on the new tab page:
    // arrowing past either end brings back exactly what was typed.
    let next = local.selected + (event.key === 'ArrowDown' ? 1 : -1);
    if (next >= items.length) next = -1;
    else if (next < -1) next = items.length - 1;
    local.selected = next;
    el.address.value = next < 0 ? omni.typed : (items[next].url || items[next].query);
    renderSuggestions();
  } else if (event.key === 'Enter') {
    const picked = local.selected >= 0 ? items[local.selected] : null;
    commit(picked ? (picked.url || picked.query) : undefined);
  } else if (event.key === 'Tab' && !event.shiftKey && local.selected >= 0 && items[local.selected]) {
    // Tab writes the chosen suggestion in to keep typing from, as on the
    // new tab page. With nothing chosen it moves focus as usual.
    event.preventDefault();
    const picked = items[local.selected];
    el.address.value = (picked.url || picked.query) + (picked.kind === 'search' ? ' ' : '');
    updateSuggestions();
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

el.tabs.addEventListener('dragend', (event) => {
  const ids = local.dragId ? dragIds() : [];
  local.dragId = null;
  document.body.classList.remove('tab-dragging');
  clearDropMarks();
  invoke('split:drag', { id: null });
  el.tabs.querySelectorAll('.dragging').forEach((node) => node.classList.remove('dragging'));
  renderTabs();
  // Let go where nothing took it, outside this window: the tabs go into a
  // window of their own there, or into the Static window they were let go
  // over. Main decides from where the pointer really is (tabs:drag-out).
  if (ids.length && event.dataTransfer?.dropEffect === 'none' && outsideWindow(event)) invoke('tabs:drag-out', { ids });
});

/** Whether a pointer event happened beyond this window's edges, in screen pixels. */
function outsideWindow(event) {
  const x = event.screenX;
  const y = event.screenY;
  if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) return false;
  return x < window.screenX || y < window.screenY || x >= window.screenX + window.outerWidth || y >= window.screenY + window.outerHeight;
}

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

/* ---- downloads button ------------------------------------------------------
 * As in Chrome: it appears once something has been downloaded in the last
 * day, its ring fills with the progress of whatever is still downloading,
 * and a download starting in this window drops an arrow into it and opens
 * the downloads bubble for a moment (main says which window it started in).
 */
const DOWNLOADS_RECENT_MS = 24 * 60 * 60 * 1000;
let downloadsFinished = null;

/** Play a one-off animation class again, even if it is already set. */
function replay(node, cls) {
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
}

function renderDownloads() {
  const list = Array.isArray(state.downloads) ? state.downloads : [];
  const now = Date.now();
  const going = list.filter((d) => d.state === 'progressing');
  if (going.length || list.some((d) => now - (d.startedAt || 0) < DOWNLOADS_RECENT_MS)) el.downloads.hidden = false;
  else if (!el.downloads.classList.contains('is-arriving')) el.downloads.hidden = true;
  const sized = going.filter((d) => d.total > 0);
  const total = sized.reduce((sum, d) => sum + d.total, 0);
  const received = sized.reduce((sum, d) => sum + Math.min(d.received, d.total), 0);
  el.downloads.classList.toggle('is-active', going.length > 0);
  el.downloads.classList.toggle('is-unknown', going.length > 0 && !total);
  el.downloads.style.setProperty('--progress', total ? (received / total).toFixed(3) : '0.3');
  el.downloads.title = going.length
    ? 'Downloading ' + (going.length === 1 ? going[0].name : going.length + ' files') + (total ? ' (' + Math.floor(received / total * 100) + '%)' : '')
    : 'Downloads';
  // A download finishing gives the button a ripple.
  const finished = new Set(list.filter((d) => d.state === 'completed').map((d) => d.id));
  if (downloadsFinished && [...finished].some((id) => !downloadsFinished.has(id))) replay(el.downloads, 'is-finished');
  downloadsFinished = finished;
}

window.browser.on('ui:download-started', () => {
  // Shown at once, before the state that lists the download arrives.
  el.downloads.hidden = false;
  const arrow = document.createElement('span');
  arrow.className = 'dl-drop';
  arrow.append(window.ui.icon('download', { size: 17 }));
  el.downloads.append(arrow);
  arrow.addEventListener('animationend', () => arrow.remove());
  setTimeout(() => arrow.remove(), 2000);
  replay(el.downloads, 'is-arriving');
  invoke('downloads:bubble', { anchor: anchorRect(el.downloads), auto: true });
});
el.downloads.addEventListener('animationend', (event) => {
  if (event.target === el.downloads) el.downloads.classList.remove('is-arriving');
});
el.downloads.addEventListener('click', () => invoke('downloads:bubble', { anchor: anchorRect(el.downloads) }));

window.browser.on('app:state', (payload) => { state = payload; render(); });
window.browser.on('ui:focus-address', () => { el.address.focus(); el.address.select(); });
window.browser.on('ui:open-menu', () => toggleMenu(el.appMenu, mainMenuItems(), 'left'));

buildChrome();

// Shortcut table first, so menus render their accelerators on the first paint.
invoke('ui:shortcuts').then((list) => {
  shortcuts = new Map();
  for (const entry of list || []) if (!shortcuts.has(entry.id)) shortcuts.set(entry.id, entry);
  // The key as this platform writes it: Ctrl+Shift+A, or ⇧⌘A on a Mac.
  if (accel('tab:search')) el.tabSearch.title = 'Search tabs (' + accel('tab:search') + ')';
  return invoke('app:state');
}).then((payload) => {
  if (payload) { state = payload; render(); }
});
