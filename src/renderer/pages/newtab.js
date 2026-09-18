'use strict';
const { invoke, onState, $, element } = window.page;

// The search box submits through the same omnibox pipeline as the address bar,
// so engine choice and URL-vs-search detection stay in one place (main).
$('#search').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = $('#query').value.trim();
  if (value) invoke('tabs:navigate', { input: value });
});

function shortcut(entry) {
  const host = (() => { try { return new URL(entry.url).hostname.replace(/^www\./, ''); } catch { return entry.url; } })();
  return element('div', {
    class: 'shortcut',
    title: entry.url,
    onclick: (event) => window.page.openUrl(entry.url, event),
  }, [
    element('div', { class: 'dot', text: host.charAt(0) || '?' }),
    element('div', { class: 'name', text: entry.title || host }),
  ]);
}

// Most-visited comes from history: count visits per host, keep the newest URL.
onState((state) => {
  const counts = new Map();
  for (const item of state.history || []) {
    try {
      const host = new URL(item.url).hostname;
      const current = counts.get(host);
      if (current) current.visits += 1;
      else counts.set(host, { url: item.url, title: item.title, visits: 1 });
    } catch { /* skip unparseable */ }
  }
  const top = [...counts.values()].sort((a, b) => b.visits - a.visits).slice(0, 10);

  const nodes = top.map(shortcut);
  // Pad the grid so the layout does not jump around on a fresh profile.
  while (nodes.length < 5) {
    nodes.push(element('div', { class: 'shortcut placeholder' }, [
      element('div', { class: 'dot', text: '\u00b7' }),
      element('div', { class: 'name', text: '\u2014' }),
    ]));
  }
  $('#shortcuts').replaceChildren(...nodes);
});

$('#query').focus();
