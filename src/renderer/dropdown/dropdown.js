'use strict';

/**
 * Omnibox suggestion list. Rendered from `omnibox:dropdown-render` pushed by
 * main (which relays what the chrome renderer computed). Keyboard selection
 * is owned by the omnibox input; this view only handles mouse.
 */
const api = window.staticUI;
const panel = document.getElementById('panel');

const ICONS = {
  search: '<svg class="ico" viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>',
  url: '<svg class="ico" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>',
  history: '<svg class="ico" viewBox="0 0 24 24"><path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>',
  bookmark: '<svg class="ico" viewBox="0 0 24 24"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>',
};

function render({ items, selected }) {
  panel.replaceChildren();
  items.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = `row kind-${item.kind}${i === selected ? ' selected' : ''}`;
    row.innerHTML = ICONS[item.kind] || ICONS.url;
    const main = document.createElement('span');
    main.className = 'main';
    main.textContent = item.title;
    row.appendChild(main);
    if (item.subtitle && item.subtitle !== item.title) {
      const sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = item.subtitle;
      row.appendChild(sub);
    }
    // mousedown (not click) so it fires before the omnibox blur hides us.
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      api.invoke('omnibox:dropdown-pick', { url: item.url, fallbackUrl: item.fallbackUrl || null });
    });
    panel.appendChild(row);
  });
}

api.on('omnibox:dropdown-render', render);
