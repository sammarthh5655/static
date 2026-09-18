'use strict';

/**
 * New tab page.
 *
 * Default view is deliberately minimal: a search box plus two widgets. Layout,
 * widgets, background and the most-visited section are all user-configurable
 * through the customiser panel, and every change persists via settings.
 */
(function () {

const { invoke, onState, $, element, icon, favicon, openUrl } = window.page;

let state = { settings: {}, catalog: { widgets: [], backgrounds: [] } };

/** Live widget nodes, so timers can be cleared when a widget is removed. */
let mounted = [];

/* ---- search --------------------------------------------------------------- */

$('#search-icon').append(icon('search', { size: 17 }));

$('#search').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = $('#query').value.trim();
  // Routed through the omnibox pipeline in main so engine choice and the
  // URL-vs-search decision live in exactly one place.
  if (value) invoke('tabs:navigate', { input: value });
});

/* ---- widgets -------------------------------------------------------------- */

/**
 * Context handed to every widget renderer. Widgets never reach for globals
 * directly - this is the whole surface they are allowed to use, which keeps
 * adding one a local change.
 */
function widgetContext() {
  return {
    state,
    catalog: state.catalog || { widgets: [] },
    invoke,
    element,
    icon,
    favicon,
    openUrl,
    /**
     * Look up a stored credential by its dotted path, e.g. "ai.apiKey".
     * No such field exists yet; the AI widget uses this to decide whether to
     * show its setup state, and it starts working the moment one is added.
     */
    credential(path) {
      if (!path) return null;
      return path.split('.').reduce((value, key) => (value ? value[key] : null), state.settings);
    },
    /**
     * The single seam a future AI integration replaces. Kept here rather than
     * inside the widget so the widget's layout code needs no changes.
     */
    async ask() {
      throw new Error('No assistant provider is configured yet');
    },
  };
}

function renderWidgets() {
  // Let outgoing widgets clean up (timers, listeners) before they are dropped.
  mounted.forEach((node) => node.dispose?.());
  mounted = [];

  const ids = state.settings?.newTab?.widgets || [];
  const ctx = widgetContext();
  const nodes = [];
  for (const id of ids) {
    const render = window.widgetRenderers[id];
    if (!render) continue; // declared but not implemented yet
    try {
      const node = render(ctx);
      nodes.push(node);
      mounted.push(node);
    } catch (error) {
      console.error('widget failed:', id, error);
    }
  }
  $('#widgets').replaceChildren(...nodes);
}

/* ---- most visited --------------------------------------------------------- */

function renderMostVisited() {
  const show = state.settings?.newTab?.showMostVisited !== false;
  $('#most-visited-section').hidden = !show;
  if (!show) return;

  // Collapse history by host, keeping the most recent URL per host.
  const byHost = new Map();
  for (const entry of state.history || []) {
    let host;
    try { host = new URL(entry.url).hostname; } catch { continue; }
    const current = byHost.get(host);
    if (current) current.visits += 1;
    else byHost.set(host, { url: entry.url, title: entry.title, host, visits: 1 });
  }
  const top = [...byHost.values()].sort((a, b) => b.visits - a.visits).slice(0, 10);

  const tiles = top.map((entry) => element('button', {
    class: 'tile',
    title: entry.url,
    onclick: (event) => openUrl(entry.url, event),
  }, [
    favicon(entry.url, 24),
    element('span', {
      class: 'tile-name',
      text: entry.title || entry.host.replace(/^www\./, ''),
    }),
  ]));

  // Placeholders keep the grid from collapsing on a fresh profile.
  while (tiles.length < 5) {
    tiles.push(element('div', { class: 'tile placeholder' }, [
      element('span', { class: 'favicon-slot' }),
      element('span', { class: 'tile-name', text: '\u2014' }),
    ]));
  }
  $('#tiles').replaceChildren(...tiles);
}

/* ---- background ----------------------------------------------------------- */

function renderBackground() {
  const config = state.settings?.newTab || {};
  const backdrop = $('#backdrop');
  backdrop.className = 'backdrop bg-' + (config.background || 'plain');
  // Image URLs are user-supplied, so set it through CSSOM rather than building
  // a style attribute, and let the CSP img-src rules police the origin.
  backdrop.style.backgroundImage =
    config.background === 'image' && config.backgroundValue
      ? 'url("' + config.backgroundValue.replace(/["\\]/g, '') + '")'
      : '';
}

/* ---- customiser ----------------------------------------------------------- */

const panel = $('#panel');
let panelOpen = false;

function togglePanel(open) {
  panelOpen = open ?? !panelOpen;
  if (panelOpen) {
    panel.hidden = false;
    renderPanel();
    // Force a style flush so the browser records the closed state (hidden
    // elements have no transition start point), then open on the next frame.
    // Without the flush the class can land in the same frame as unhiding and
    // the transition is skipped, leaving the panel parked off-screen.
    void panel.offsetHeight;
    requestAnimationFrame(() => panel.classList.add('open'));
    // rAF can be starved in a background view; open on a timer as a backstop.
    setTimeout(() => { if (panelOpen) panel.classList.add('open'); }, 50);
  } else {
    panel.classList.remove('open');
    const ms = parseInt(getComputedStyle(document.documentElement)
      .getPropertyValue('--motion-base'), 10) || 0;
    setTimeout(() => { if (!panelOpen) panel.hidden = true; }, ms);
  }
}

$('#customize').append(icon('grid', { size: 16 }));
$('#customize').addEventListener('click', () => togglePanel());
$('#panel-close').append(icon('close', { size: 15 }));
$('#panel-close').addEventListener('click', () => togglePanel(false));

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && panelOpen) togglePanel(false);
});

/** Persist a change to the newTab settings object. */
function updateNewTab(patch) {
  const next = { ...(state.settings?.newTab || {}), ...patch };
  invoke('settings:update', { newTab: next }).catch((error) => console.error(error));
}

function renderPanel() {
  const config = state.settings?.newTab || {};
  const active = config.widgets || [];
  const catalog = state.catalog?.widgets || [];

  // Active widgets first (in their order), then the rest as "add" options.
  const rows = [];
  active.forEach((id, index) => {
    const meta = catalog.find((w) => w.id === id);
    if (!meta) return;
    rows.push(widgetRow(meta, true, index));
  });
  catalog.filter((w) => !active.includes(w.id)).forEach((meta) => {
    rows.push(widgetRow(meta, false));
  });
  $('#widget-list').replaceChildren(...rows);

  $('#toggle-most-visited').checked = config.showMostVisited !== false;

  const backgrounds = state.catalog?.backgrounds || [];
  $('#background-choices').replaceChildren(...backgrounds.map((bg) => element('button', {
    class: 'choice' + (config.background === bg.id ? ' selected' : ''),
    text: bg.name,
    onclick: () => updateNewTab({ background: bg.id }),
  })));

  const valueInput = $('#background-value');
  valueInput.hidden = config.background !== 'image';
  if (document.activeElement !== valueInput) valueInput.value = config.backgroundValue || '';
}

function widgetRow(meta, isActive, index) {
  const row = element('div', {
    class: 'widget-row-item' + (isActive ? ' active' : ''),
    draggable: isActive ? 'true' : null,
  }, [
    icon(meta.icon || 'grid', { size: 15 }),
    element('div', { class: 'widget-row-text' }, [
      element('div', { class: 'widget-row-name' }, [
        element('span', { text: meta.name }),
        meta.experimental
          ? element('span', { class: 'widget-badge', text: 'Soon' })
          : null,
      ]),
      element('div', { class: 'widget-row-desc', text: meta.description || '' }),
    ]),
    element('button', {
      class: 'widget-toggle',
      text: isActive ? 'Remove' : 'Add',
      onclick: () => {
        const current = state.settings?.newTab?.widgets || [];
        updateNewTab({
          widgets: isActive
            ? current.filter((id) => id !== meta.id)
            : [...current, meta.id],
        });
      },
    }),
  ]);

  if (isActive) {
    row.dataset.id = meta.id;
    row.dataset.index = index;
  }
  return row;
}

// Drag to reorder active widgets.
let dragId = null;
$('#widget-list').addEventListener('dragstart', (event) => {
  const row = event.target.closest('.widget-row-item.active');
  if (!row) return;
  dragId = row.dataset.id;
  row.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
});
$('#widget-list').addEventListener('dragover', (event) => {
  if (dragId) event.preventDefault();
});
$('#widget-list').addEventListener('drop', (event) => {
  if (!dragId) return;
  event.preventDefault();
  const rows = [...$('#widget-list').querySelectorAll('.widget-row-item.active')];
  let target = rows.findIndex((row) => {
    const box = row.getBoundingClientRect();
    return event.clientY < box.top + box.height / 2;
  });
  if (target === -1) target = rows.length - 1;

  const current = [...(state.settings?.newTab?.widgets || [])];
  const from = current.indexOf(dragId);
  if (from !== -1) {
    current.splice(from, 1);
    current.splice(Math.max(0, Math.min(target, current.length)), 0, dragId);
    updateNewTab({ widgets: current });
  }
  dragId = null;
});
$('#widget-list').addEventListener('dragend', () => {
  dragId = null;
  $('#widget-list').querySelectorAll('.dragging').forEach((n) => n.classList.remove('dragging'));
});

$('#toggle-most-visited').addEventListener('change', (event) =>
  updateNewTab({ showMostVisited: event.target.checked }));

const bgValue = $('#background-value');
bgValue.addEventListener('change', () => updateNewTab({ backgroundValue: bgValue.value.trim() }));
bgValue.addEventListener('keydown', (event) => { if (event.key === 'Enter') bgValue.blur(); });

/* ---- state ---------------------------------------------------------------- */

onState((next) => {
  state = next;
  renderBackground();
  renderMostVisited();
  renderWidgets();
  if (panelOpen) renderPanel();
});

$('#query').focus();

})();
