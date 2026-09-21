'use strict';

renderNav('downloads');

const results = document.getElementById('results');

function statusText(d) {
  switch (d.state) {
    case 'progressing': {
      const pct = d.totalBytes ? Math.round((d.receivedBytes / d.totalBytes) * 100) : null;
      const size = d.totalBytes ? `${fmtBytes(d.receivedBytes)} / ${fmtBytes(d.totalBytes)}` : fmtBytes(d.receivedBytes);
      return `${d.paused ? 'Paused' : 'Downloading'} · ${size}${pct != null ? ` (${pct}%)` : ''}`;
    }
    case 'completed': return `${fmtBytes(d.totalBytes || d.receivedBytes)} · ${fmtDay(d.endTime || d.startTime)} ${fmtTime(d.endTime || d.startTime)}`;
    case 'cancelled': return 'Cancelled';
    case 'interrupted': return 'Failed – interrupted';
    default: return d.state;
  }
}

function render(items) {
  results.replaceChildren();
  if (!items.length) {
    results.appendChild(h('div', { class: 'empty' }, 'Files you download appear here.'));
    return;
  }
  const list = h('div', { class: 'list' });
  for (const d of items) {
    const ext = (d.filename.match(/\.([a-z0-9]{1,4})$/i) || [])[1] || 'file';
    const done = d.state === 'completed';
    const actions = [];
    if (d.state === 'progressing') {
      actions.push(h('button', { onclick: () => pages.invoke(d.paused ? 'downloads:resume' : 'downloads:pause', d.id) }, d.paused ? 'Resume' : 'Pause'));
      actions.push(h('button', { class: 'danger', onclick: () => pages.invoke('downloads:cancel', d.id) }, 'Cancel'));
    } else {
      if (done) actions.push(h('button', { onclick: () => pages.invoke('downloads:show-in-folder', d.id) }, 'Show in folder'));
      actions.push(h('button', { class: 'icon', title: 'Remove from list', html: ICON_CLOSE, onclick: () => pages.invoke('downloads:remove', d.id) }));
    }
    const pct = d.totalBytes ? (d.receivedBytes / d.totalBytes) * 100 : 0;
    list.appendChild(h('div', { class: 'item dl' },
      h('div', { class: 'fileicon' }, ext.slice(0, 4)),
      h('div', { class: 'text' },
        h('span', { class: `title${done ? ' done' : ''}`, title: d.savePath || d.url, onclick: () => done && pages.invoke('downloads:open', d.id) }, d.filename),
        h('span', { class: 'sub' }, d.url),
        h('div', { class: `status${d.state === 'interrupted' ? ' err' : ''}` }, statusText(d)),
        d.state === 'progressing' && d.totalBytes ? h('div', { class: 'bar' }, h('div', { style: { width: `${pct}%` } })) : null),
      h('div', { class: 'actions' }, actions)));
  }
  results.appendChild(list);
}

document.getElementById('clear').addEventListener('click', () => pages.invoke('downloads:clear'));
pages.on('downloads:changed', render);
pages.invoke('downloads:list').then(render);
