'use strict';
(function () {

const { invoke, onState, $, element } = window.page;

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

// Appearance. Every one of these feeds shared/theme.js, so a change repaints
// the chrome and every open internal page through the pushed state.
$('#theme').addEventListener('change', (e) => update({ theme: e.target.value }));
$('#surfaceStyle').addEventListener('change', (e) => update({ surfaceStyle: e.target.value }));
$('#radius').addEventListener('change', (e) => update({ radius: e.target.value }));
$('#animations').addEventListener('change', (e) => update({ animations: e.target.checked }));

$('#showMostVisited').addEventListener('change', (e) =>
  update({ newTab: { showMostVisited: e.target.checked } }));

$('#open-newtab').addEventListener('click', () =>
  invoke('tabs:new', { url: 'browser://newtab' }));

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
  $('#clear-status').textContent = 'Clearing…';
  await invoke('settings:clear-data', options);
  $('#clear').disabled = false;
  $('#clear-status').textContent = 'Browsing data cleared.';
});

/**
 * Fill a <select> from a catalogue supplied by main, so the options here can
 * never drift from what the theme module actually supports.
 */
function fillSelect(select, options, value) {
  const wanted = options.map((option) => option.id).join('|');
  if (select.dataset.filled !== wanted) {
    select.replaceChildren(...options.map((option) =>
      element('option', { value: option.id, text: option.name })));
    select.dataset.filled = wanted;
  }
  select.value = value;
}

onState((state) => {
  const s = state.settings || {};
  const catalog = state.catalog || {};
  applying = true;

  $('#engine').value = s.searchEngine || 'google';
  $('#behavior').value = s.newTabBehavior || 'newtab';
  $('#bookmarksBar').checked = !!s.bookmarksBar;
  if (document.activeElement !== homepage) homepage.value = s.homepage || '';

  fillSelect($('#theme'), catalog.themes || [], s.theme || 'dark');
  fillSelect($('#surfaceStyle'), catalog.surfaceStyles || [], s.surfaceStyle || 'frosted');
  fillSelect($('#radius'), catalog.radii || [], s.radius || 'rounded');
  $('#animations').checked = s.animations !== false;
  $('#showMostVisited').checked = s.newTab?.showMostVisited !== false;

  applying = false;
});

})();
