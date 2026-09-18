'use strict';
const { invoke, onState, $, element, timeAgo, formatBytes } = window.page;

const LABELS = {
  progressing: 'Downloading',
  completed: 'Completed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

function row(item) {
  const active = item.state === 'progressing';
  const progress = active && item.total
    ? ` \u2014 ${formatBytes(item.received)} of ${formatBytes(item.total)}`
    : item.total ? ` \u2014 ${formatBytes(item.total)}` : '';

  return element('div', { class: 'row' }, [
    element('div', { class: 'grow' }, [
      element('div', { class: 'title', text: item.name, title: item.path || item.url }),
      element('div', { class: 'sub', text: `${LABELS[item.state] || item.state}${progress} \u00b7 ${timeAgo(item.startedAt)}` }),
    ]),
    active
      ? element('button', { text: 'Cancel', onclick: () => invoke('downloads:cancel', { id: item.id }) })
      : element('button', {
          text: 'Show in folder',
          disabled: item.state === 'completed' ? null : 'true',
          onclick: () => invoke('downloads:reveal', { id: item.id }),
        }),
  ]);
}

$('#clear').addEventListener('click', () => invoke('downloads:clear'));

onState((state) => {
  const items = state.downloads || [];
  $('#list').replaceChildren(...(items.length
    ? items.map(row)
    : [element('div', { class: 'empty', text: 'No downloads yet.' })]));
});
