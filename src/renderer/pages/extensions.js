'use strict';

renderNav('extensions');

const grid = document.getElementById('grid');
const status = document.getElementById('status');

function setStatus(text, ms = 3000) {
  status.textContent = text;
  if (ms) setTimeout(() => { if (status.textContent === text) status.textContent = ''; }, ms);
}

function render(items) {
  grid.replaceChildren();
  if (!items.length) {
    grid.appendChild(h('div', { class: 'empty', style: { gridColumn: '1 / -1' } },
      'No extensions installed. Install one from the Chrome Web Store, or load an unpacked folder.'));
    return;
  }
  for (const ext of items) {
    const toggle = h('label', { class: 'switch', title: ext.enabled ? 'Disable' : 'Enable' },
      h('input', { type: 'checkbox', checked: ext.enabled, onchange: (e) => pages.invoke(e.target.checked ? 'extensions:enable' : 'extensions:disable', ext.id) }),
      h('span', { class: 'track' }));

    grid.appendChild(h('div', { class: `ext${ext.enabled ? '' : ' disabled'}` },
      h('div', { class: 'head' },
        h('div', { class: 'icon', style: faviconStyle(ext.icon) }),
        h('div', { style: { minWidth: 0, flex: 1 } },
          h('div', { class: 'name' }, ext.name, h('span', { class: 'ver' }, ext.version), ' ',
            h('span', { class: 'tag' }, ext.type === 'unpacked' ? 'unpacked' : 'web store'), ' ',
            h('span', { class: 'tag' }, `MV${ext.manifestVersion}`)),
          h('div', { class: 'desc' }, ext.description),
          h('div', { class: 'id', title: ext.path }, `ID: ${ext.id}`))),
      h('div', { class: 'foot' },
        ext.optionsUrl ? h('button', { disabled: !ext.enabled, onclick: () => pages.invoke('extensions:open-options', ext.id) }, 'Options') : null,
        ext.homepageUrl ? h('a', { class: 'btn', style: { fontSize: '12px', padding: '5px 10px' }, href: ext.homepageUrl, target: '_blank' }, 'Website') : null,
        h('button', { class: 'danger', onclick: () => remove(ext) }, 'Remove'),
        h('span', { class: 'spacer' }),
        toggle)));
  }
}

async function remove(ext) {
  if (!window.confirm(`Remove “${ext.name}”?${ext.type === 'unpacked' ? '\n\nThe folder on disk is left untouched.' : ''}`)) return;
  try {
    await pages.invoke('extensions:remove', ext.id);
    setStatus(`Removed ${ext.name}.`);
  } catch (err) {
    setStatus(`Failed to remove: ${err.message}`, 6000);
  }
}

document.getElementById('unpacked').addEventListener('click', async () => {
  const id = await pages.invoke('extensions:load-unpacked');
  if (id) setStatus(`Loaded ${id}.`);
});

document.getElementById('updates').addEventListener('click', async () => {
  setStatus('Checking for updates…', 0);
  try {
    await pages.invoke('extensions:check-updates');
    setStatus('Update check complete.');
  } catch (err) {
    setStatus(`Update check failed: ${err.message}`, 6000);
  }
});

pages.on('extensions:changed', render);
pages.invoke('extensions:list').then(render);
