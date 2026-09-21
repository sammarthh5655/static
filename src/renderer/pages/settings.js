'use strict';

renderNav('settings');

const $ = (id) => document.getElementById(id);

async function load() {
  const [settings, engines] = await Promise.all([
    pages.invoke('settings:get'),
    pages.invoke('settings:search-engines'),
  ]);

  const sel = $('searchEngine');
  sel.replaceChildren(...engines.map((e) => h('option', { value: e.id }, e.name)));
  sel.value = settings.searchEngine;
  $('homepage').value = settings.homepage;
  $('newTabBehavior').value = settings.newTabBehavior;
  $('showBookmarksBar').checked = !!settings.showBookmarksBar;
  $('askWhereToSave').checked = !!settings.askWhereToSave;
}

function bind(id, key, read) {
  const el = $(id);
  el.addEventListener('change', () => pages.invoke('settings:set', { [key]: read(el) }));
}
bind('searchEngine', 'searchEngine', (el) => el.value);
bind('homepage', 'homepage', (el) => el.value.trim() || 'static://newtab/');
bind('newTabBehavior', 'newTabBehavior', (el) => el.value);
bind('showBookmarksBar', 'showBookmarksBar', (el) => el.checked);
bind('askWhereToSave', 'askWhereToSave', (el) => el.checked);

// Keep the page in sync if settings change elsewhere (e.g. Ctrl+Shift+B).
pages.on('settings:changed', (s) => {
  $('showBookmarksBar').checked = !!s.showBookmarksBar;
  $('askWhereToSave').checked = !!s.askWhereToSave;
  $('searchEngine').value = s.searchEngine;
  $('newTabBehavior').value = s.newTabBehavior;
  if (document.activeElement !== $('homepage')) $('homepage').value = s.homepage;
});

// Clear browsing data
$('cbd-all').addEventListener('click', () => {
  for (const id of ['cbd-history', 'cbd-cookies', 'cbd-downloads']) $(id).checked = true;
});
$('cbd-go').addEventListener('click', async () => {
  const opts = {
    history: $('cbd-history').checked,
    cookiesAndCache: $('cbd-cookies').checked,
    downloads: $('cbd-downloads').checked,
  };
  if (!opts.history && !opts.cookiesAndCache && !opts.downloads) {
    $('cbd-status').textContent = 'Nothing selected.';
    return;
  }
  $('cbd-go').disabled = true;
  $('cbd-status').textContent = 'Clearing…';
  try {
    await pages.invoke('settings:clear-browsing-data', opts);
    $('cbd-status').textContent = 'Done.';
  } catch (err) {
    $('cbd-status').textContent = `Failed: ${err.message}`;
  } finally {
    $('cbd-go').disabled = false;
    setTimeout(() => { $('cbd-status').textContent = ''; }, 3000);
  }
});

$('ver').textContent = navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1]
  ? `Static 0.1.0 · Chromium ${navigator.userAgent.match(/Chrome\/([\d.]+)/)[1]}`
  : 'Static 0.1.0';

load().then(() => {
  // Deep links: static://settings/#clear, #about
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView({ behavior: 'smooth' });
});
