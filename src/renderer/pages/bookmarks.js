'use strict';

renderNav('bookmarks');

const q = document.getElementById('q');
const results = document.getElementById('results');
const count = document.getElementById('count');
let all = [];

function render() {
  const term = q.value.trim().toLowerCase();
  const items = term
    ? all.filter((b) => b.title.toLowerCase().includes(term) || b.url.toLowerCase().includes(term))
    : all;
  count.textContent = items.length ? `${items.length} bookmark${items.length === 1 ? '' : 's'}` : '';
  results.replaceChildren();
  if (!items.length) {
    results.appendChild(h('div', { class: 'empty' }, term ? 'No matching bookmarks.' : 'Bookmark pages with the ☆ in the address bar (Ctrl+D).'));
    return;
  }
  const list = h('div', { class: 'list' });
  for (const b of items) {
    let host = '';
    try { host = new URL(b.url).host; } catch { /* ignore */ }
    const titleEl = h('a', { class: 'title', href: b.url, title: b.url }, b.title || b.url);
    list.appendChild(h('div', { class: 'item' },
      h('span', { class: 'favicon', style: faviconStyle(b.favicon) }),
      h('div', { class: 'text' }, titleEl, h('span', { class: 'sub' }, host)),
      h('div', { class: 'actions' },
        h('button', { class: 'icon', title: 'Open in new tab', html: ICON_OPEN, onclick: () => pages.invoke('tabs:new', { url: b.url, active: false }) }),
        h('button', { class: 'icon', title: 'Rename', html: '<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>', onclick: () => rename(b) }),
        h('button', { class: 'icon', title: 'Delete', html: ICON_DELETE, onclick: () => pages.invoke('bookmarks:remove', b.id) }))));
  }
  results.appendChild(list);
}

function rename(b) {
  const title = window.prompt('Bookmark name', b.title);
  if (title != null && title.trim()) pages.invoke('bookmarks:update', b.id, { title: title.trim() });
}

async function refresh() {
  all = await pages.invoke('bookmarks:list');
  render();
}

q.addEventListener('input', render);
pages.on('bookmarks:changed', (list) => { all = list; render(); });
refresh();
