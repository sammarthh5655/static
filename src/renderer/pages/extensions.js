'use strict';
const { invoke, onState, $, element } = window.page;

function row(ext) {
  return element('div', { class: 'row' }, [
    element('div', { class: 'grow' }, [
      element('div', { class: 'title' }, [
        element('span', { text: ext.name }),
        element('span', { class: 'tag gap ' + (ext.enabled ? 'on' : 'off'), text: ext.enabled ? 'On' : 'Off' }),
        element('span', { class: 'tag gap', text: 'MV' + ext.manifestVersion }),
      ]),
      element('div', { class: 'sub', text: `v${ext.version}${ext.description ? ' \u2014 ' + ext.description : ''}` }),
    ]),
    ext.optionsPage
      ? element('button', { text: 'Options', onclick: () => invoke('extensions:options', { id: ext.id }) })
      : null,
    element('button', {
      text: ext.enabled ? 'Disable' : 'Enable',
      onclick: () => invoke('extensions:set-enabled', { id: ext.id, enabled: !ext.enabled }),
    }),
    element('button', {
      class: 'danger', text: 'Remove',
      onclick: () => { if (confirm(`Remove ${ext.name}?`)) invoke('extensions:remove', { id: ext.id }); },
    }),
  ]);
}

$('#unpacked').addEventListener('click', () => invoke('extensions:load-unpacked'));
$('#crx').addEventListener('click', () => invoke('extensions:load-crx'));
$('#store').addEventListener('click', () =>
  invoke('tabs:navigate', { input: 'https://chromewebstore.google.com/' }));

onState((state) => {
  const items = state.extensions || [];
  $('#list').replaceChildren(...(items.length
    ? items.map(row)
    : [element('div', { class: 'empty', text: 'No extensions installed. Install one from the Chrome Web Store.' })]));
});
