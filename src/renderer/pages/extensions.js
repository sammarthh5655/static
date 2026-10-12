'use strict';
const { invoke, onState, $, element } = window.page;

function row(ext) {
  return element('div', { class: 'row' }, [
    element('div', { class: 'grow' }, [
      element('div', { class: 'title' }, [
        element('span', { text: ext.name }),
        element('span', { class: 'tag gap ' + (ext.enabled ? 'on' : 'off'), text: ext.enabled ? 'On' : 'Off' }),
        element('span', { class: 'tag gap', text: 'MV' + ext.manifestVersion }),
        // Loaded from a folder of the person's own, which "Remove" never deletes.
        ext.unpacked ? element('span', { class: 'tag gap', text: ext.missing ? 'Folder not found' : 'Unpacked' }) : null,
      ]),
      element('div', {
        class: 'sub',
        text: [ext.version ? 'v' + ext.version : '', ext.description].filter(Boolean).join(' \u2014 '),
      }),
    ]),
    ext.optionsPage
      ? element('button', { text: 'Options', onclick: () => invoke('extensions:options', { id: ext.id }) })
      : null,
    element('button', {
      text: ext.enabled ? 'Disable' : 'Enable',
      // A folder that has gone cannot be switched on until it is back.
      disabled: ext.missing ? 'true' : null,
      onclick: () => invoke('extensions:set-enabled', { id: ext.id, enabled: !ext.enabled }),
    }),
    element('button', {
      class: 'danger', text: 'Remove',
      onclick: () => { if (confirm(`Remove ${ext.name}?`)) invoke('extensions:remove', { id: ext.id }); },
    }),
  ]);
}

/** What happened, in one line under the buttons. It stays until the next try. */
function say(text) {
  const status = $('#status');
  status.textContent = text || '';
  status.hidden = !text;
}

/**
 * Both load buttons answer { ok, name } or { ok: false, error }. A cancelled
 * picker says nothing. Failures used to be unhandled rejections, so a bad
 * file appeared to do nothing at all.
 */
async function load(channel) {
  say('');
  let result;
  try {
    result = await invoke(channel);
  } catch (error) {
    const message = String(error?.message || error).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');
    result = { ok: false, error: message };
  }
  if (result?.ok) say('Installed ' + result.name + '.');
  else if (result && !result.canceled) say(result.error || 'The extension could not be installed.');
}

$('#unpacked').addEventListener('click', () => load('extensions:load-unpacked'));
$('#crx').addEventListener('click', () => load('extensions:load-crx'));
$('#store').addEventListener('click', () =>
  invoke('tabs:navigate', { input: 'https://chromewebstore.google.com/' }));

onState((state) => {
  const items = state.extensions || [];
  $('#list').replaceChildren(...(items.length
    ? items.map(row)
    : [element('div', { class: 'empty', text: 'No extensions installed. Install one from the Chrome Web Store.' })]));
});
