'use strict';

(async () => {
  const settings = await pages.invoke('settings:get');
  const engines = { google: 'Google', brave: 'Brave Search' };
  document.getElementById('q').placeholder = `Search ${engines[settings.searchEngine] || 'the web'} or type a URL`;

  document.getElementById('search').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = document.getElementById('q').value.trim();
    if (text) pages.invoke('omnibox:submit', text);
  });

  // Most visited sites from history (real data; empty until you browse).
  const sites = await pages.invoke('history:top-sites', 8);
  const grid = document.getElementById('shortcuts');
  for (const s of sites) {
    const letter = (s.host || '?').replace(/^www\./, '')[0].toUpperCase();
    grid.appendChild(h('a', { class: 'shortcut', href: s.url, title: s.url },
      h('div', { class: 'icon' }, letter),
      h('span', {}, (s.host || s.url).replace(/^www\./, ''))));
  }
})();
