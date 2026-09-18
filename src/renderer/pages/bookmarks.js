'use strict';
const { invoke, onState, $, element, openUrl } = window.page;

let all = [];
let query = '';

function row(item) {
  return element('div', { class: 'row' }, [
    element('div', { class: 'grow' }, [
      element('div', {
        class: 'title link', text: item.title || item.url, title: item.url,
        onclick: (event) => openUrl(item.url, event),
      }),
      element('div', { class: 'sub', text: item.url }),
    ]),
    element('button', { text: 'Remove', onclick: () => invoke('bookmarks:remove', { id: item.id }) }),
  ]);
}

function render() {
  const q = query.trim().toLowerCase();
  const items = q
    ? all.filter(b => (b.url + ' ' + (b.title || '')).toLowerCase().includes(q))
    : all;
  $('#list').replaceChildren(...(items.length
    ? items.map(row)
    : [element('div', { class: 'empty', text: q ? 'No matching bookmarks.' : 'No bookmarks yet. Use the star in the address bar.' })]));
}

$('#search').addEventListener('input', (event) => { query = event.target.value; render(); });

// Bookmarks arrive with pushed state, so removals reflect instantly.
onState((state) => { all = state.bookmarks || []; render(); });
