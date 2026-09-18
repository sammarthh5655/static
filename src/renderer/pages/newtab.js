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

/**
 * The search box has two modes.
 *
 *   Search mode  Enter -> normal search or navigation (the omnibox pipeline)
 *   AI mode      Enter -> the query goes to Gemini and the answer appears below
 *
 * Tab switches between them, Escape leaves AI mode. The mode is visible at a
 * glance through the badge, the accent border and the hint line, because a
 * text field that silently changes what Enter does would be a trap.
 */
let aiMode = false;
let aiBusy = false;

const queryInput = $('#query');

function setMode(next) {
  aiMode = next;
  document.body.classList.toggle('ai-mode', aiMode);
  $('#ai-badge').hidden = !aiMode;
  queryInput.placeholder = aiMode ? 'Ask Gemini anything\u2026' : 'Search the web';
  renderHint();
}

function renderHint() {
  const hint = $('#search-hint');
  if (!state.ai?.available) { hint.textContent = ''; return; }
  if (aiBusy) { hint.textContent = 'Asking Gemini\u2026  Esc to cancel'; return; }
  hint.textContent = aiMode
    ? 'AI Mode active \u2014 Press Enter to ask Gemini  \u00b7  Tab or Esc for search'
    : 'Press Tab for an AI answer';
}

function setSearchIcon() {
  $('#search-icon').replaceChildren(icon(aiMode ? 'sparkle' : 'search', { size: 17 }));
}

setSearchIcon();
renderHint();

queryInput.addEventListener('keydown', (event) => {
  if (event.key === 'Tab' && !event.shiftKey) {
    // Tab is the mode switch rather than a focus move: this field is the
    // primary control on the page, so moving focus away is never what is
    // wanted here.
    if (!state.ai?.available) return;
    event.preventDefault();
    setMode(!aiMode);
    setSearchIcon();
    return;
  }
  if (event.key === 'Escape') {
    if (aiBusy) { invoke('ai:cancel'); aiBusy = false; renderHint(); return; }
    if (aiMode) { event.preventDefault(); setMode(false); setSearchIcon(); }
  }
});

$('#search').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = queryInput.value.trim();
  if (!value) return;
  if (aiMode && state.ai?.available) return askGemini(value);
  // Routed through the omnibox pipeline in main so engine choice and the
  // URL-vs-search decision live in exactly one place.
  invoke('tabs:navigate', { input: value });
});

/* ---- Gemini answers ------------------------------------------------------- */

const SYSTEM_PROMPT = [
  'You are the built-in assistant in a web browser.',
  'Answer directly and concisely - usually two or three short paragraphs.',
  'Use plain text with simple dashes for lists; no markdown headings or bold.',
  'If you are unsure or the question needs current information you do not have,',
  'say so plainly rather than guessing.',
  'End with a line "FOLLOWUPS:" followed by up to three short follow-up',
  'questions separated by " | ".',
].join(' ');

async function askGemini(prompt) {
  aiBusy = true;
  renderHint();
  const panel = $('#ai-panel');
  panel.hidden = false;
  $('#ai-panel-title').textContent = 'Gemini';
  $('#ai-answer').textContent = 'Thinking\u2026';
  $('#ai-followups').replaceChildren();

  const result = await invoke('ai:ask', { prompt, system: SYSTEM_PROMPT });
  aiBusy = false;
  renderHint();

  if (!result) return;
  if (!result.ok) {
    $('#ai-answer').textContent = result.error || 'The assistant could not answer.';
    return;
  }

  // Split the trailing FOLLOWUPS: line off the answer body.
  const match = /\n?FOLLOWUPS:\s*(.+)$/is.exec(result.text);
  const body = match ? result.text.slice(0, match.index).trim() : result.text.trim();
  $('#ai-answer').textContent = body;
  $('#ai-panel-title').textContent = 'Gemini \u00b7 ' + (result.model || '');

  const followups = match
    ? match[1].split('|').map((item) => item.trim()).filter(Boolean).slice(0, 3)
    : [];
  $('#ai-followups').replaceChildren(...followups.map((question) =>
    element('button', {
      class: 'ai-followup',
      text: question,
      onclick: () => { queryInput.value = question; askGemini(question); },
    })));
}

$('#ai-copy').addEventListener('click', async () => {
  const text = $('#ai-answer').textContent || '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    $('#ai-copy').textContent = 'Copied';
    setTimeout(() => { $('#ai-copy').textContent = 'Copy'; }, 1400);
  } catch {
    $('#ai-copy').textContent = 'Copy failed';
    setTimeout(() => { $('#ai-copy').textContent = 'Copy'; }, 1400);
  }
});

$('#ai-close').addEventListener('click', () => { $('#ai-panel').hidden = true; });

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
     * Whether AI is available. The key itself is never here - it lives only in
     * the main process - so this reports availability, not the credential.
     */
    credential() {
      return state.ai?.available ? true : null;
    },
    /** Ask Gemini. The prompt goes to main, which holds the key. */
    async ask(prompt, options = {}) {
      const result = await invoke('ai:ask', { prompt, ...options });
      if (!result?.ok) throw new Error(result?.error || 'The assistant could not answer.');
      return result.text;
    },
  };
}

/**
 * Apply one widget's appearance overrides.
 *
 * Written as CSS custom properties scoped to the widget element, which is what
 * lets two widgets look completely different while both still inherit anything
 * the user has not overridden from the global theme.
 */
function applyWidgetStyle(node, id) {
  const style = state.settings?.newTab?.widgetStyles?.[id];
  if (!style) return;
  const vars = window.theme.widgetVariables(style);
  for (const [name, value] of Object.entries(vars)) node.style.setProperty(name, value);
  if (style.align) node.style.textAlign = style.align;
  if (style.span === 'full') node.classList.add('span-full');
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
      applyWidgetStyle(node, id);
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
  renderHint();
  renderBackground();
  renderMostVisited();
  renderWidgets();
  if (panelOpen) renderPanel();
});

$('#query').focus();

})();
