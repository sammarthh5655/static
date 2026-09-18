'use strict';
const { invoke, onState, $ } = window.page;

// Guards against re-emitting a change while we are populating the controls
// from pushed state (which would loop settings:update -> state -> update).
let applying = false;

function update(patch) {
  if (applying) return;
  invoke('settings:update', patch).catch((error) => {
    $('#clear-status').textContent = error.message;
  });
}

$('#engine').addEventListener('change', (e) => update({ searchEngine: e.target.value }));
$('#behavior').addEventListener('change', (e) => update({ newTabBehavior: e.target.value }));
$('#bookmarksBar').addEventListener('change', (e) => update({ bookmarksBar: e.target.checked }));

// Homepage commits on blur/Enter rather than each keystroke, since main
// normalises the value and would fight the cursor position.
const homepage = $('#homepage');
homepage.addEventListener('change', () => update({ homepage: homepage.value.trim() }));
homepage.addEventListener('keydown', (e) => { if (e.key === 'Enter') homepage.blur(); });

$('#extensions').addEventListener('click', () =>
  invoke('tabs:navigate', { input: 'browser://extensions' }));

$('#clear').addEventListener('click', async () => {
  const options = {
    history: $('#clear-history').checked,
    cookies: $('#clear-cookies').checked,
    cache: $('#clear-cache').checked,
    downloads: $('#clear-downloads').checked,
  };
  if (!Object.values(options).some(Boolean)) {
    $('#clear-status').textContent = 'Select at least one thing to clear.';
    return;
  }
  $('#clear').disabled = true;
  $('#clear-status').textContent = 'Clearing\u2026';
  await invoke('settings:clear-data', options);
  $('#clear').disabled = false;
  $('#clear-status').textContent = 'Browsing data cleared.';
});

onState((state) => {
  const s = state.settings || {};
  applying = true;
  $('#engine').value = s.searchEngine || 'google';
  $('#behavior').value = s.newTabBehavior || 'newtab';
  $('#bookmarksBar').checked = !!s.bookmarksBar;
  if (document.activeElement !== homepage) homepage.value = s.homepage || '';
  applying = false;
});
