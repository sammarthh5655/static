'use strict';

/**
 * The new tab's row of site shortcuts, as in Chrome:
 *
 * - "Most visited": the sites you visit most, less any you removed;
 * - "My shortcuts": your own list, up to twelve, in your order.
 *
 * Right-click a shortcut, or press the ⋮ that appears on it, for Open in new
 * tab / new window / incognito window, Edit shortcut, Remove and Copy link.
 * "Add shortcut" (the + at the end) and Edit open a small dialog with a name
 * and an address. Adding or editing while showing the most visited sites
 * turns them into your own list first, so nothing you can see disappears.
 *
 * Everything is saved in settings.newTab.shortcuts (main checks it:
 * features/settings#normaliseShortcuts). Site names and titles come from web
 * pages, so they are set as text, never markup.
 */
(function () {

const MAX_CUSTOM = 12;
const MAX_FREQUENT = 8;

let ctx = null;
let menuNode = null;

const hostOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
};
const nameOf = (entry) => entry.title || hostOf(entry.url).split('.')[0] || entry.url;

function settings() {
  return ctx.state().settings?.newTab?.shortcuts || { mode: 'frequent', custom: [], hidden: [] };
}

/** The most visited sites, one per host, less the removed ones. */
function frequent() {
  const hidden = new Set(settings().hidden || []);
  const byHost = new Map();
  for (const entry of ctx.state().history || []) {
    const host = hostOf(entry.url);
    if (!host || hidden.has(host) || !/^https?:/.test(entry.url)) continue;
    const current = byHost.get(host);
    if (current) current.visits += 1;
    else byHost.set(host, { url: entry.url, title: host.split('.')[0], host, visits: 1 });
  }
  return [...byHost.values()].sort((a, b) => b.visits - a.visits).slice(0, MAX_FREQUENT);
}

/** What the row shows now. */
function entries() {
  const s = settings();
  return s.mode === 'custom' ? s.custom.map((item) => ({ ...item })) : frequent();
}

function save(next) {
  const merged = { ...settings(), ...next };
  // Kept here at once too, so the row redraws without waiting for main.
  const state = ctx.state();
  if (state.settings) state.settings.newTab = { ...(state.settings.newTab || {}), shortcuts: merged };
  ctx.invoke('settings:update', { newTab: { shortcuts: merged } }).catch((error) => console.error('shortcuts:', error.message));
  render(ctx);
}

/** Your own list, starting from what is on screen when you first change it. */
function ownList() {
  const s = settings();
  if (s.mode === 'custom') return s.custom.map((item) => ({ ...item }));
  return frequent().map((entry) => ({ title: entry.title, url: entry.url }));
}

function remove(index, entry) {
  if (settings().mode === 'custom') {
    const list = ownList();
    list.splice(index, 1);
    save({ custom: list });
  } else {
    save({ hidden: [...(settings().hidden || []), hostOf(entry.url)] });
  }
}

/** "youtube.com" becomes https://youtube.com/; anything not a web address is refused. */
function normaliseAddress(text) {
  let value = String(text || '').trim();
  if (!value) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) value = 'https://' + value;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname.includes('.') && url.hostname !== 'localhost') return '';
    return url.href;
  } catch { return ''; }
}

/* ---- menu ------------------------------------------------------------------ */

function closeMenu() {
  if (!menuNode) return;
  menuNode.remove();
  menuNode = null;
}

/**
 * A small menu of this page's own at (x, y). `items` are
 * { label, icon, run, danger } or null for a dividing line. Also used by the
 * quick buttons (newtab.js#renderActions).
 */
function popup(x, y, label, items) {
  closeMenu();
  if (!ctx) return;
  const { element, icon } = ctx;
  menuNode = element('div', { class: 'nt-menu', role: 'menu', 'aria-label': label }, items.map((it) => {
    if (!it) return element('div', { class: 'nt-menu-line' });
    const b = element('button', { class: 'nt-menu-item' + (it.danger ? ' is-danger' : ''), role: 'menuitem' }, [icon(it.icon, { size: 15 }), element('span', { text: it.label })]);
    b.addEventListener('click', () => { closeMenu(); it.run(); });
    return b;
  }));
  document.body.append(menuNode);
  const box = menuNode.getBoundingClientRect();
  menuNode.style.left = Math.max(8, Math.min(x, innerWidth - box.width - 8)) + 'px';
  menuNode.style.top = Math.max(8, Math.min(y, innerHeight - box.height - 8)) + 'px';
  menuNode.querySelector('button')?.focus({ preventScroll: true });
}

function openMenu(x, y, index, entry) {
  const { invoke } = ctx;
  popup(x, y, nameOf(entry), [
    { label: 'Open in new tab', icon: 'plus', run: () => invoke('tabs:new', { url: entry.url }) },
    { label: 'Open in new window', icon: 'window_new', run: () => invoke('newtab:open', { url: entry.url, where: 'window' }) },
    { label: 'Open in incognito window', icon: 'incognito', run: () => invoke('newtab:open', { url: entry.url, where: 'incognito' }) },
    null,
    { label: 'Edit shortcut…', icon: 'edit', run: () => openDialog(index, entry) },
    { label: 'Copy link', icon: 'copy', run: () => navigator.clipboard.writeText(entry.url).catch(() => {}) },
    { label: 'Remove', icon: 'trash', danger: true, run: () => remove(index, entry) },
  ]);
}

document.addEventListener('pointerdown', (event) => {
  if (menuNode && !menuNode.contains(event.target)) closeMenu();
}, true);
document.addEventListener('keydown', (event) => {
  if (!menuNode) return;
  if (event.key === 'Escape') { event.preventDefault(); closeMenu(); return; }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const items = [...menuNode.querySelectorAll('.nt-menu-item')];
    const at = items.indexOf(document.activeElement);
    items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  }
});
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);
document.addEventListener('scroll', closeMenu, true);

/* ---- add / edit dialog ------------------------------------------------------ */

function openDialog(index = -1, entry = null) {
  closeMenu();
  document.querySelector('.nt-dialog-veil')?.remove();
  if (!ctx) return;
  const { element } = ctx;
  const name = element('input', { type: 'text', maxlength: '60', placeholder: 'YouTube', value: entry ? nameOf(entry) : '' });
  const address = element('input', { type: 'text', maxlength: '2048', placeholder: 'youtube.com', value: entry?.url || '', spellcheck: 'false' });
  const error = element('p', { class: 'nt-dialog-error', role: 'alert' });
  const done = element('button', { class: 'nt-btn is-primary', type: 'submit', text: 'Done' });
  const cancel = element('button', { class: 'nt-btn', type: 'button', text: 'Cancel' });
  const form = element('form', { class: 'nt-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': entry ? 'Edit shortcut' : 'Add shortcut' }, [
    element('h2', { text: entry ? 'Edit shortcut' : 'Add shortcut' }),
    element('label', {}, [element('span', { text: 'Name' }), name]),
    element('label', {}, [element('span', { text: 'URL' }), address]),
    error,
    element('div', { class: 'nt-dialog-buttons' }, [cancel, done]),
  ]);
  const veil = element('div', { class: 'nt-dialog-veil' }, [form]);
  const close = () => veil.remove();
  cancel.addEventListener('click', close);
  veil.addEventListener('pointerdown', (event) => { if (event.target === veil) close(); });
  form.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); close(); } });
  const check = () => { done.disabled = !normaliseAddress(address.value); };
  address.addEventListener('input', () => { error.textContent = ''; check(); });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const url = normaliseAddress(address.value);
    if (!url) { error.textContent = 'Type a web address, like youtube.com'; return; }
    const list = ownList();
    const item = { title: name.value.trim().slice(0, 60), url };
    if (index >= 0 && index < list.length) list[index] = item;
    else if (list.length >= MAX_CUSTOM) { error.textContent = 'You can have up to ' + MAX_CUSTOM + ' shortcuts. Remove one first.'; return; }
    else list.push(item);
    save({ mode: 'custom', custom: list });
    close();
  });
  check();
  document.body.append(veil);
  (entry ? name : address).focus();
  (entry ? name : address).select();
}

/* ---- the row ------------------------------------------------------------------ */

function render(context) {
  if (context) ctx = context;
  if (!ctx) return;
  const { element, favicon, openUrl } = ctx;
  const host = document.getElementById('frequent');
  const row = document.getElementById('frequent-row');
  const show = ctx.state().settings?.newTab?.showMostVisited !== false;
  const list = show ? entries() : [];
  // Hidden only when shortcuts are switched off. A fresh profile has no
  // history yet, and hiding the row then left no way to add a first
  // shortcut - the + tile below is how anyone starts their own list.
  host.hidden = !show;
  if (host.hidden) { row.replaceChildren(); return; }

  const tiles = list.map((entry, index) => {
    const more = element('span', { class: 'frequent-more', role: 'button', tabindex: '-1', title: 'More actions', 'aria-label': 'More actions for ' + nameOf(entry), text: '⋮' });
    more.addEventListener('click', (event) => {
      event.stopPropagation();
      const box = more.getBoundingClientRect();
      openMenu(box.left, box.bottom + 4, index, entry);
    });
    const tile = element('button', {
      class: 'frequent-item',
      title: nameOf(entry) + '\n' + entry.url,
      onclick: (event) => openUrl(entry.url, event),
    }, [favicon(entry.url, 20), element('span', { class: 'frequent-name', text: nameOf(entry) }), more]);
    tile.addEventListener('auxclick', (event) => { if (event.button === 1) openUrl(entry.url, event); });
    tile.addEventListener('contextmenu', (event) => {
      // Our own menu, not the page's image menu.
      event.preventDefault();
      openMenu(event.clientX, event.clientY, index, entry);
    });
    tile.addEventListener('keydown', (event) => {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault();
        const box = tile.getBoundingClientRect();
        openMenu(box.left, box.bottom + 4, index, entry);
      }
    });
    return tile;
  });

  if (list.length < MAX_CUSTOM) {
    // The tile is as narrow as the site tiles beside it, so the label has to
    // fit in one short word rather than being clipped to "Add short...".
    const add = element('button', { class: 'frequent-item frequent-add', title: 'Add shortcut', onclick: () => openDialog() }, [
      element('span', { class: 'favicon-slot frequent-plus' }, [ctx.icon('plus', { size: 18 })]),
      element('span', { class: 'frequent-name', text: 'Add' }),
    ]);
    tiles.push(add);
  }
  row.replaceChildren(...tiles);
}

/**
 * Hand over the page's helpers once, at startup. The quick buttons and
 * Customise can both open a menu before the shortcuts row has drawn, and
 * neither should have to care which ran first.
 */
function init(context) { ctx = context; }

window.newtabShortcuts = { init, render, openDialog, popup, hostOf };

})();
