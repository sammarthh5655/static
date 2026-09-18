'use strict';

/**
 * Browser chrome renderer.
 *
 * This is a pure render of the state object pushed from main on 'app:state'.
 * It holds no browser state of its own; every action round-trips through IPC
 * and comes back as a new state. The one exception is transient input state
 * (what the user is typing, which suggestion is highlighted) held in `local`.
 */

const $ = (id) => document.getElementById(id);
const el = {
  tabs: $('tabs'), newtab: $('newtab'),
  back: $('back'), forward: $('forward'), reload: $('reload'), home: $('home'),
  address: $('address'), security: $('security'), star: $('star'),
  suggestions: $('suggestions'), bookmarks: $('bookmarks'),
  menu: $('menu'), notice: $('notice'),
};

let state = { tabs: [], active: {}, bookmarks: [], settings: {}, downloads: [] };

/** Transient UI state that must survive a re-render. */
const local = {
  typing: false,      // true while the user edits the address bar
  suggestions: [],
  selected: -1,
  dragId: null,
};

const invoke = (channel, payload) => window.browser.invoke(channel, payload).catch((error) => {
  console.error(channel, error);
});

/* ---- rendering ----------------------------------------------------------- */

function render() {
  renderTabs();
  renderToolbar();
  renderBookmarks();
  renderNotice();
}

function renderTabs() {
  el.tabs.replaceChildren(...state.tabs.map((tab) => {
    const node = document.createElement('div');
    node.className = 'tab' + (tab.active ? ' active' : '');
    node.draggable = true;
    node.dataset.id = tab.id;
    node.title = tab.title || '';

    // Spinner while loading, favicon once loaded, blank square as fallback.
    if (tab.loading) {
      const spinner = document.createElement('div');
      spinner.className = 'spinner';
      node.append(spinner);
    } else {
      const icon = document.createElement('img');
      icon.className = 'favicon';
      icon.src = tab.favicon || '';
      icon.onerror = () => { icon.style.visibility = 'hidden'; };
      node.append(icon);
    }

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = tab.title || 'New tab';
    node.append(title);

    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '×';
    close.title = 'Close tab';
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      invoke('tabs:close', { id: tab.id });
    });
    node.append(close);

    node.addEventListener('click', () => invoke('tabs:select', { id: tab.id }));
    node.addEventListener('auxclick', (event) => {
      if (event.button === 1) invoke('tabs:close', { id: tab.id }); // middle-click
    });
    return node;
  }));
}

function renderToolbar() {
  const active = state.active || {};
  el.back.disabled = !active.canGoBack;
  el.forward.disabled = !active.canGoForward;
  el.reload.textContent = active.loading ? '×' : '↻';
  el.reload.title = active.loading ? 'Stop' : 'Reload';

  // Never clobber what the user is typing.
  if (!local.typing && document.activeElement !== el.address) {
    el.address.value = displayUrl(active.url);
  }

  // Internal/extension pages get a neutral glyph, not the star - the star is
  // the bookmark control and must not appear twice in the omnibox.
  const marks = { secure: '🔒', insecure: '⚠', error: '⚠', internal: '⚙', extension: '🧩' };
  el.security.textContent = marks[active.security] || '';
  el.security.className = 'security ' + (active.security || '');
  el.security.title = {
    secure: 'Connection is secure (HTTPS)',
    insecure: 'Not secure (HTTP)',
    error: 'Page failed to load',
    internal: 'Built-in page',
    extension: 'Extension page',
  }[active.security] || '';

  el.star.classList.toggle('on', !!state.bookmarked);
  el.star.textContent = state.bookmarked ? '★' : '☆';
  el.star.title = state.bookmarked ? 'Remove bookmark' : 'Bookmark this page (Ctrl+D)';

  const engine = state.settings?.searchEngine === 'brave' ? 'Brave Search' : 'Google';
  el.address.placeholder = `Search ${engine} or type a URL`;
}

/** browser://newtab reads as an empty bar, like Chrome's. */
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
    node.textContent = item.title || item.url;
    node.title = item.url;
    node.addEventListener('click', () => invoke('tabs:navigate', { input: item.url }));
    node.addEventListener('auxclick', (event) => {
      if (event.button === 1) invoke('tabs:new', { url: item.url, background: true });
    });
    return node;
  }));
}

function renderNotice() {
  const notice = state.notice;
  el.notice.hidden = !notice;
  if (notice) el.notice.textContent = notice.message;
}

/* ---- omnibox suggestions -------------------------------------------------- */

function renderSuggestions() {
  const items = local.suggestions;
  el.suggestions.hidden = !items.length;
  if (!items.length) return;

  el.suggestions.replaceChildren(...items.map((item, index) => {
    const node = document.createElement('div');
    node.className = 'suggestion' + (index === local.selected ? ' selected' : '');

    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = item.source === 'bookmark' ? '★' : item.source === 'search' ? '🔍' : '↺';
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
      event.preventDefault(); // keep focus so blur doesn't close first
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
  // Always offer the raw query as a search, the way Chrome does.
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

el.newtab.addEventListener('click', () => invoke('tabs:new', {}));
el.back.addEventListener('click', () => invoke('navigation:back'));
el.forward.addEventListener('click', () => invoke('navigation:forward'));
el.home.addEventListener('click', () => invoke('navigation:home'));
el.reload.addEventListener('click', () =>
  invoke(state.active?.loading ? 'navigation:stop' : 'navigation:reload'));
el.star.addEventListener('click', () => invoke('bookmarks:toggle', {}));
el.menu.addEventListener('click', () => invoke('ui:menu'));

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

/* Drag to reorder tabs. We compute the drop index from the midpoint of each
   tab so the insertion point matches where the cursor visually sits. */
el.tabs.addEventListener('dragstart', (event) => {
  const tab = event.target.closest('.tab');
  if (!tab) return;
  local.dragId = tab.dataset.id;
  tab.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
});

el.tabs.addEventListener('dragover', (event) => {
  if (!local.dragId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
});

el.tabs.addEventListener('drop', (event) => {
  if (!local.dragId) return;
  event.preventDefault();
  const nodes = [...el.tabs.querySelectorAll('.tab')];
  let index = nodes.findIndex((node) => {
    const box = node.getBoundingClientRect();
    return event.clientX < box.left + box.width / 2;
  });
  if (index === -1) index = nodes.length - 1;
  invoke('tabs:reorder', { id: local.dragId, to: index });
  local.dragId = null;
});

el.tabs.addEventListener('dragend', () => {
  local.dragId = null;
  el.tabs.querySelectorAll('.dragging').forEach((node) => node.classList.remove('dragging'));
});

/* Keyboard shortcuts that must work while the chrome has focus. The same
   accelerators are registered in the application menu so they also fire when
   a tab holds focus. */
window.addEventListener('keydown', (event) => {
  const mod = window.browser.platform === 'darwin' ? event.metaKey : event.ctrlKey;
  if (mod && event.key.toLowerCase() === 'l') { event.preventDefault(); el.address.focus(); }
  else if (mod && event.key.toLowerCase() === 't') { event.preventDefault(); invoke('tabs:new', {}); }
  else if (mod && event.key.toLowerCase() === 'w') { event.preventDefault(); invoke('tabs:close', {}); }
  else if (mod && event.key.toLowerCase() === 'd') { event.preventDefault(); invoke('bookmarks:toggle', {}); }
  else if (event.ctrlKey && event.key === 'Tab') { event.preventDefault(); }
});

window.browser.on('app:state', (payload) => { state = payload; render(); });
window.browser.on('ui:focus-address', () => { el.address.focus(); el.address.select(); });

// Ask for the current state once the renderer is live.
invoke('app:state').then((payload) => { if (payload) { state = payload; render(); } });
