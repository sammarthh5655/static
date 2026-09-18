'use strict';
const { invoke, $, element, timeAgo, openUrl } = window.page;

let query = '';

function row(entry) {
  return element('div', { class: 'row' }, [
    element('div', { class: 'grow' }, [
      element('div', {
        class: 'title link', text: entry.title || entry.url, title: entry.url,
        onclick: (event) => openUrl(entry.url, event),
      }),
      element('div', { class: 'sub', text: entry.url }),
    ]),
    element('div', { class: 'sub', text: timeAgo(entry.visitedAt) }),
    element('button', { text: 'Remove', onclick: () => remove(entry.id) }),
  ]);
}

async function refresh() {
  const entries = await invoke('history:search', { query, limit: 500 });
  $('#list').replaceChildren(...(entries.length
    ? entries.map(row)
    : [element('div', { class: 'empty', text: query ? 'No matching history.' : 'No browsing history yet.' })]));
}

async function remove(id) {
  await invoke('history:remove', { id });
  refresh();
}

$('#search').addEventListener('input', (event) => {
  query = event.target.value;
  refresh();
});

$('#clear').addEventListener('click', async () => {
  await invoke('settings:clear-data', { history: true });
  refresh();
});

refresh();
