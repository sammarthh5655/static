'use strict';

renderNav('history');

const q = document.getElementById('q');
const results = document.getElementById('results');
const count = document.getElementById('count');
let timer = null;

async function refresh() {
  const visits = await pages.invoke('history:search', q.value, { limit: 500 });
  count.textContent = visits.length ? `${visits.length} item${visits.length === 1 ? '' : 's'}` : '';
  results.replaceChildren();
  if (!visits.length) {
    results.appendChild(h('div', { class: 'empty' }, q.value ? 'No matching history.' : 'Pages you visit will show up here.'));
    return;
  }
  // Group by day, newest first (the list already is).
  let currentDay = null;
  let list = null;
  for (const v of visits) {
    const day = fmtDay(v.time);
    if (day !== currentDay) {
      currentDay = day;
      results.appendChild(h('div', { class: 'group-title' }, day));
      list = h('div', { class: 'list' });
      results.appendChild(list);
    }
    let host = '';
    try { host = new URL(v.url).host; } catch { /* ignore */ }
    list.appendChild(h('div', { class: 'item' },
      h('span', { class: 'time' }, fmtTime(v.time)),
      h('div', { class: 'text' },
        h('a', { class: 'title', href: v.url, title: v.url }, v.title || v.url),
        h('span', { class: 'sub' }, host)),
      h('div', { class: 'actions' },
        h('button', { class: 'icon', title: 'Remove from history', html: ICON_DELETE, onclick: () => pages.invoke('history:remove', v.id) }))));
  }
}

q.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(refresh, 120);
});

document.getElementById('clear').addEventListener('click', () => {
  location.href = 'static://settings/#clear';
});

pages.on('history:changed', refresh);
refresh();
