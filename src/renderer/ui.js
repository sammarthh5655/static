'use strict';

/**
 * Browser chrome renderer. Pure function of the state pushed from main:
 *   - `tabs:changed`      -> full tab list + active id   (renderTabs / renderToolbar)
 *   - `bookmarks:changed` -> bookmarks bar
 *   - `downloads:changed` -> downloads button badge
 *   - `settings:changed`  -> bookmarks bar visibility, placeholder text
 * User actions go the other way through `staticUI.invoke(channel, ...)`.
 * The only local state kept here is what the omnibox is being edited to.
 */
const api = window.staticUI;

const $ = (sel) => document.querySelector(sel);
const els = {
  chrome: $('#chrome'),
  tabs: $('#tabs'),
  newTab: $('#btn-newtab'),
  back: $('#btn-back'),
  forward: $('#btn-forward'),
  reload: $('#btn-reload'),
  home: $('#btn-home'),
  omnibox: $('#omnibox'),
  security: $('#security'),
  url: $('#url'),
  star: $('#btn-star'),
  downloads: $('#btn-downloads'),
  dlProgress: $('#dl-progress'),
  extensions: $('#btn-extensions'),
  menu: $('#btn-menu'),
  bookmarksBar: $('#bookmarks-bar'),
};

document.body.classList.add(`platform-${api.platform}`);

/** Latest snapshot from main. */
let state = { tabs: [], activeId: null };
let settings = {};

// ---------------------------------------------------------------------------
// Tab strip
// ---------------------------------------------------------------------------

/** id -> DOM element, so we update in place instead of re-creating. */
const tabEls = new Map();

function createTabEl(tab) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.dataset.id = String(tab.id);
  el.innerHTML = `
    <div class="favicon generic"></div>
    <span class="title"></span>
    <svg class="audio" viewBox="0 0 24 24" hidden><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>
    <button class="close" title="Close tab" tabindex="-1">
      <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
    </button>`;

  el.addEventListener('pointerdown', (e) => {
    if (e.button === 1) return; // middle click handled on auxclick
    if (e.target.closest('.close')) return;
    if (e.button === 0) {
      api.invoke('tabs:select', tab.id);
      startDrag(e, el);
    }
  });
  el.addEventListener('auxclick', (e) => {
    if (e.button === 1) api.invoke('tabs:close', tab.id);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.invoke('tabs:context-menu', tab.id);
  });
  el.querySelector('.close').addEventListener('click', (e) => {
    e.stopPropagation();
    api.invoke('tabs:close', tab.id);
  });
  return el;
}

function updateTabEl(el, tab, active) {
  el.classList.toggle('active', active);
  const fav = el.querySelector('.favicon');
  let spinner = el.querySelector('.spinner');
  if (tab.loading) {
    if (!spinner) {
      spinner = document.createElement('div');
      spinner.className = 'spinner';
      fav.replaceWith(spinner);
    }
  } else if (spinner) {
    const nf = document.createElement('div');
    nf.className = 'favicon generic';
    spinner.replaceWith(nf);
  }
  const favNow = el.querySelector('.favicon');
  if (favNow) {
    if (tab.favicon) {
      favNow.classList.remove('generic');
      favNow.style.backgroundImage = `url("${tab.favicon.replace(/"/g, '%22')}")`;
    } else {
      favNow.classList.add('generic');
      favNow.style.backgroundImage = '';
    }
  }
  const title = el.querySelector('.title');
  if (title.textContent !== tab.title) title.textContent = tab.title;
  el.title = tab.title + (tab.url ? `\n${tab.url}` : '');
  el.querySelector('.audio').hidden = !(tab.audible && !tab.muted);
}

function renderTabs() {
  const seen = new Set();
  const order = [];
  for (const tab of state.tabs) {
    let el = tabEls.get(tab.id);
    if (!el) {
      el = createTabEl(tab);
      tabEls.set(tab.id, el);
    }
    updateTabEl(el, tab, tab.id === state.activeId);
    seen.add(tab.id);
    order.push(el);
  }
  for (const [id, el] of tabEls) {
    if (!seen.has(id)) {
      el.remove();
      tabEls.delete(id);
    }
  }
  // Reorder DOM to match state without touching elements already in place.
  if (!drag.active) {
    order.forEach((el, i) => {
      if (els.tabs.children[i] !== el) els.tabs.insertBefore(el, els.tabs.children[i] || null);
    });
  }
  // Collapse close buttons when tabs get narrow.
  const narrow = order.length && order[0].getBoundingClientRect().width < 90;
  for (const el of order) el.classList.toggle('narrow', narrow);
}

// --- drag to reorder -------------------------------------------------------
const drag = { active: false, el: null, startX: 0, offsetX: 0, order: [], pointerId: null };

function startDrag(e, el) {
  drag.el = el;
  drag.startX = e.clientX;
  drag.pointerId = e.pointerId;
  drag.active = false;
  el.setPointerCapture(e.pointerId);
  el.addEventListener('pointermove', onDragMove);
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
}

function onDragMove(e) {
  const dx = e.clientX - drag.startX;
  if (!drag.active) {
    if (Math.abs(dx) < 6) return;
    drag.active = true;
    drag.el.classList.add('dragging');
    drag.order = [...els.tabs.children];
  }
  drag.el.style.transform = `translateX(${dx}px)`;

  // Work out where the dragged tab's centre now sits and shift neighbours.
  const rect = drag.el.getBoundingClientRect();
  const center = rect.left + rect.width / 2;
  const others = drag.order.filter((t) => t !== drag.el);
  let newIndex = others.length;
  for (let i = 0; i < others.length; i++) {
    const r = others[i].getBoundingClientRect();
    // getBoundingClientRect includes the transform; undo it for the static slot.
    const shift = parseFloat(others[i].dataset.shift || '0');
    const mid = r.left - shift + r.width / 2;
    if (center < mid) { newIndex = i; break; }
  }
  const from = drag.order.indexOf(drag.el);
  others.forEach((t, i) => {
    let shift = 0;
    if (i >= newIndex && i < from) shift = rect.width;          // moved left: push right
    else if (i < newIndex && i >= from) shift = -rect.width;    // moved right: push left
    t.dataset.shift = String(shift);
    t.style.transform = shift ? `translateX(${shift}px)` : '';
  });
  drag.newIndex = newIndex;
}

function endDrag(e) {
  const el = drag.el;
  if (!el) return;
  el.removeEventListener('pointermove', onDragMove);
  el.removeEventListener('pointerup', endDrag);
  el.removeEventListener('pointercancel', endDrag);
  try { el.releasePointerCapture(drag.pointerId); } catch { /* ignore */ }

  if (drag.active) {
    const others = drag.order.filter((t) => t !== el);
    others.splice(drag.newIndex, 0, el);
    for (const t of drag.order) { t.style.transform = ''; delete t.dataset.shift; }
    el.classList.remove('dragging');
    // Apply the new DOM order immediately so nothing jumps, then tell main.
    others.forEach((t) => els.tabs.appendChild(t));
    api.invoke('tabs:reorder', others.map((t) => Number(t.dataset.id)));
  }
  drag.active = false;
  drag.el = null;
}

// ---------------------------------------------------------------------------
// Toolbar + omnibox
// ---------------------------------------------------------------------------

function activeTab() {
  return state.tabs.find((t) => t.id === state.activeId) || null;
}

/** URL shown in the omnibox for a tab ('' for the new tab page). */
function displayUrl(tab) {
  if (!tab || !tab.url) return '';
  if (tab.url.startsWith('static://newtab')) return '';
  if (tab.url === 'about:blank') return '';
  return tab.url;
}

function renderToolbar() {
  const tab = activeTab();
  els.back.disabled = !tab || !tab.canGoBack;
  els.forward.disabled = !tab || !tab.canGoForward;
  els.reload.classList.toggle('loading', !!(tab && tab.loading));
  els.reload.title = tab && tab.loading ? 'Stop loading (Esc)' : 'Reload (Ctrl+R)';
  els.star.classList.toggle('on', !!(tab && tab.bookmarked));
  els.star.title = tab && tab.bookmarked ? 'Edit bookmark' : 'Bookmark this tab (Ctrl+D)';
  els.security.className = `security ${tab ? tab.security : 'none'}`;
  els.security.title = {
    secure: 'Connection is secure',
    insecure: 'Your connection to this site is not secure',
    internal: 'Static page',
    file: 'Local file',
    none: '',
  }[tab ? tab.security : 'none'];

  // Don't clobber what the user is typing.
  if (!omni.editing) {
    els.url.value = displayUrl(tab);
  }
  document.title = tab ? `${tab.title} - Static` : 'Static';
}

const omni = {
  editing: false,
  items: [],
  selected: -1,
  typed: '',
  suggestSeq: 0,
};

function omniboxAnchor() {
  const r = els.omnibox.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function showDropdown() {
  if (!omni.items.length) return hideDropdown();
  api.invoke('omnibox:dropdown-show', { items: omni.items, selected: omni.selected, anchor: omniboxAnchor() });
}

function hideDropdown() {
  omni.items = [];
  omni.selected = -1;
  api.invoke('omnibox:dropdown-hide');
}

async function refreshSuggestions() {
  const text = els.url.value;
  omni.typed = text;
  const seq = ++omni.suggestSeq;
  if (!text.trim()) { hideDropdown(); return; }
  const items = await api.invoke('omnibox:suggest', text);
  if (seq !== omni.suggestSeq) return; // stale
  omni.items = items;
  omni.selected = -1;
  showDropdown();
}

els.url.addEventListener('focus', () => {
  omni.editing = true;
  els.omnibox.classList.add('focused');
  // Chrome selects everything on focus so typing replaces the URL.
  requestAnimationFrame(() => els.url.select());
});

els.url.addEventListener('blur', () => {
  omni.editing = false;
  els.omnibox.classList.remove('focused');
  // Delay so a click in the dropdown overlay lands before we hide it.
  setTimeout(() => { if (!omni.editing) { hideDropdown(); renderToolbar(); } }, 150);
});

els.url.addEventListener('input', refreshSuggestions);

els.url.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const item = omni.selected >= 0 ? omni.items[omni.selected] : null;
    const text = item ? item.url : els.url.value;
    omni.editing = false;
    hideDropdown();
    if (e.altKey) {
      api.invoke('omnibox:submit', text, { newTab: true });
    } else {
      api.invoke('omnibox:submit', text);
    }
    els.url.blur();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    if (omni.items.length) {
      hideDropdown();
      els.url.value = omni.typed;
    } else {
      omni.editing = false;
      renderToolbar();
      els.url.blur();
      api.invoke('ui:focus-tab');
    }
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!omni.items.length) return;
    e.preventDefault();
    const n = omni.items.length;
    omni.selected = e.key === 'ArrowDown'
      ? (omni.selected + 1) % n
      : (omni.selected <= 0 ? n - 1 : omni.selected - 1);
    const item = omni.items[omni.selected];
    els.url.value = item.kind === 'search' ? item.title : item.url;
    showDropdown();
  }
});

els.omnibox.addEventListener('mousedown', (e) => {
  if (e.target === els.omnibox || e.target === els.security) {
    e.preventDefault();
    els.url.focus();
  }
});

els.newTab.addEventListener('click', () => api.invoke('tabs:new'));
els.back.addEventListener('click', () => api.invoke('tabs:back'));
els.forward.addEventListener('click', () => api.invoke('tabs:forward'));
els.reload.addEventListener('click', () => {
  const tab = activeTab();
  api.invoke(tab && tab.loading ? 'tabs:stop' : 'tabs:reload');
});
els.home.addEventListener('click', () => api.invoke('tabs:home'));
els.star.addEventListener('click', () => {
  const tab = activeTab();
  if (tab && tab.url) api.invoke('bookmarks:toggle', tab.url, tab.title, tab.favicon);
});
els.downloads.addEventListener('click', () => api.invoke('tabs:new', { url: 'static://downloads/' }));
els.extensions.addEventListener('click', () => api.invoke('tabs:new', { url: 'static://extensions/' }));
els.menu.addEventListener('click', () => {
  const r = els.menu.getBoundingClientRect();
  api.invoke('ui:app-menu', { x: r.right - 260, y: r.bottom + 4 });
});

// Right-click on empty toolbar/strip space shouldn't show the default menu.
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('#url')) e.preventDefault();
});

// Prevent the browser chrome from navigating on file drops.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// ---------------------------------------------------------------------------
// Bookmarks bar
// ---------------------------------------------------------------------------
let bookmarks = [];

function renderBookmarksBar() {
  const show = !!settings.showBookmarksBar;
  els.bookmarksBar.hidden = !show;
  if (!show) return;
  els.bookmarksBar.replaceChildren();
  if (!bookmarks.length) {
    const hint = document.createElement('span');
    hint.className = 'bm-empty';
    hint.textContent = 'For quick access, bookmark a page with the ☆ in the address bar.';
    els.bookmarksBar.appendChild(hint);
    return;
  }
  for (const b of bookmarks) {
    const el = document.createElement('a');
    el.className = 'bm';
    el.title = `${b.title}\n${b.url}`;
    const fav = document.createElement('span');
    fav.className = 'favicon';
    if (b.favicon) fav.style.backgroundImage = `url("${b.favicon.replace(/"/g, '%22')}")`;
    else fav.classList.add('generic');
    const t = document.createElement('span');
    t.className = 'bm-title';
    t.textContent = b.title || b.url;
    el.append(fav, t);
    el.addEventListener('click', () => api.invoke('tabs:navigate', b.url));
    el.addEventListener('auxclick', (e) => { if (e.button === 1) api.invoke('tabs:new', { url: b.url, active: false }); });
    els.bookmarksBar.appendChild(el);
  }
}

// ---------------------------------------------------------------------------
// Downloads badge
// ---------------------------------------------------------------------------
function renderDownloads(items) {
  const active = items.filter((d) => d.state === 'progressing');
  els.downloads.hidden = items.length === 0;
  els.downloads.classList.toggle('active', active.length > 0);
  if (active.length) {
    const received = active.reduce((s, d) => s + d.receivedBytes, 0);
    const total = active.reduce((s, d) => s + Math.max(d.totalBytes, d.receivedBytes), 0);
    const pct = total ? Math.round((received / total) * 100) : 0;
    els.dlProgress.style.setProperty('--pct', `${pct}%`);
    els.downloads.title = `Downloading ${active.length} file${active.length > 1 ? 's' : ''} (${pct}%)`;
  } else {
    els.downloads.title = 'Downloads (Ctrl+J)';
  }
}

// ---------------------------------------------------------------------------
// Layout reporting: main needs to know how tall the chrome is so the tab view
// starts right underneath it (bookmarks bar toggling changes this).
// ---------------------------------------------------------------------------
let lastHeight = 0;
function reportLayout() {
  if (els.chrome.classList.contains('fullscreen')) return;
  const h = Math.ceil(els.chrome.getBoundingClientRect().height);
  if (h && h !== lastHeight) {
    lastHeight = h;
    api.invoke('ui:layout', { height: h });
  }
}
new ResizeObserver(reportLayout).observe(els.chrome);

// ---------------------------------------------------------------------------
// Events from main
// ---------------------------------------------------------------------------
api.on('tabs:changed', (snapshot) => {
  state = snapshot;
  renderTabs();
  renderToolbar();
});

api.on('bookmarks:changed', (list) => {
  bookmarks = list;
  renderBookmarksBar();
});

api.on('downloads:changed', renderDownloads);

api.on('settings:changed', (s) => {
  settings = s;
  applySettings();
});

api.on('omnibox:focus', () => {
  els.url.focus();
  els.url.select();
});

api.on('ui:fullscreen', (on) => {
  els.chrome.classList.toggle('fullscreen', on);
  if (!on) reportLayout();
});

async function applySettings() {
  renderBookmarksBar();
  const engines = { google: 'Google', brave: 'Brave Search' };
  els.url.placeholder = `Search ${engines[settings.searchEngine] || 'the web'} or type a URL`;
}

// Initial state
(async () => {
  settings = await api.invoke('settings:get');
  bookmarks = await api.invoke('bookmarks:list');
  applySettings();
  renderDownloads(await api.invoke('downloads:list'));
  const snap = await api.invoke('tabs:list');
  if (snap) { state = snap; renderTabs(); renderToolbar(); }
  reportLayout();
})();

window.addEventListener('resize', () => { renderTabs(); if (omni.editing && omni.items.length) showDropdown(); });
