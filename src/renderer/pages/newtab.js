'use strict';

/**
 * New tab page.
 *
 * Deliberately minimal: a mark, a search box, five actions, a thin row of
 * frequent sites and one small utility row. Nothing else - the restraint is
 * the point. Every other mode is reachable from the browser menu, the command
 * bar, or its own browser:// address; none of them needs to sit on the page
 * you open a hundred times a day.
 *
 * The search box has two modes. Enter searches; Tab switches to AI and Enter
 * then asks Gemini. Both states are obvious at a glance, because a field that
 * silently changes what Enter does is a trap.
 */
(function () {

const { invoke, onState, $, element, icon, favicon, openUrl } = window.page;

let state = { settings: {}, ai: {}, modes: {} };
let aiMode = false;
let busy = false;
let lastQuestion = '';

/* ---- mode ----------------------------------------------------------------- */

const queryInput = $('#query');

function setMode(next) {
  aiMode = next;
  document.body.classList.toggle('ai', aiMode);
  $('#search-badge').hidden = !aiMode;
  queryInput.placeholder = aiMode
    ? 'Ask Gemini anything…'
    : 'Search the web or press Tab for AI';
  $('#search-icon').replaceChildren(icon(aiMode ? 'sparkle' : 'search', { size: 17 }));
  renderHint();
}

/** The hint is the only place the two-key interaction is explained. */
function renderHint() {
  const hint = $('#keyhint');
  if (!state.ai?.available) { hint.replaceChildren(); return; }
  if (busy) { hint.replaceChildren(element('span', { text: 'Asking Gemini…  Esc to cancel' })); return; }

  hint.replaceChildren(...(aiMode
    ? [
        element('kbd', { text: 'Enter' }),
        element('span', { text: ' to ask Gemini · ' }),
        element('kbd', { text: 'Tab' }),
        element('span', { text: ' or ' }),
        element('kbd', { text: 'Esc' }),
        element('span', { text: ' for search' }),
      ]
    : [
        element('kbd', { text: 'Enter' }),
        element('span', { text: ' to search · ' }),
        element('kbd', { text: 'Tab' }),
        element('span', { text: ' then ' }),
        element('kbd', { text: 'Enter' }),
        element('span', { text: ' for an AI answer' }),
      ]));
}

queryInput.addEventListener('keydown', (event) => {
  if (event.key === 'Tab' && !event.shiftKey) {
    // Tab is the mode switch, not a focus move: this field is the only control
    // that matters here, so moving focus away is never what is wanted.
    if (!state.ai?.available) return;
    event.preventDefault();
    setMode(!aiMode);
    return;
  }
  if (event.key === 'Escape') {
    if (busy) { invoke('ai:cancel'); busy = false; renderHint(); return; }
    if (aiMode) { event.preventDefault(); setMode(false); }
  }
});

$('#search').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = queryInput.value.trim();
  if (!value) return;
  if (aiMode && state.ai?.available) return ask(value);
  invoke('tabs:navigate', { input: value });
});

/* ---- AI answer ------------------------------------------------------------- */

const SYSTEM_PROMPT = [
  'You are the assistant built into a web browser. Answer directly and briefly -',
  'two or three short paragraphs at most. Plain text only: no markdown headings,',
  'no bold markers, simple dashes for lists. If the question needs current',
  'information you do not have, say so rather than guessing.',
].join(' ');

async function ask(prompt) {
  lastQuestion = prompt;
  busy = true;
  renderHint();
  $('#answer').hidden = false;
  $('#answer-label').textContent = 'Gemini';
  $('#answer-text').textContent = 'Thinking…';

  const result = await invoke('ai:ask', { prompt, system: SYSTEM_PROMPT });
  busy = false;
  renderHint();
  if (!result) return;

  if (result.ok) {
    $('#answer-text').textContent = result.text;
    $('#answer-label').textContent = 'Gemini · ' + (result.model || '');
  } else {
    $('#answer-text').textContent = result.error || 'The assistant could not answer.';
  }
}

$('#answer-close').addEventListener('click', () => { $('#answer').hidden = true; });

$('#answer-copy').addEventListener('click', async (event) => {
  const text = $('#answer-text').textContent || '';
  if (!text) return;
  const button = event.currentTarget;
  try { await navigator.clipboard.writeText(text); button.textContent = 'Copied'; }
  catch { button.textContent = 'Copy failed'; }
  setTimeout(() => { button.textContent = 'Copy'; }, 1400);
});

// Carry the question into the full AI page, where it becomes a saved
// conversation rather than a one-shot answer.
$('#answer-open').addEventListener('click', async () => {
  const question = lastQuestion;
  await invoke('tabs:navigate', { input: 'browser://ai' });
  if (question) invoke('chat:send', { prompt: question, system: SYSTEM_PROMPT });
});

/* ---- actions --------------------------------------------------------------- */

/**
 * Five, and only five. A homepage that offers everything offers nothing;
 * anything beyond these lives in the menu or the command bar.
 */
function renderActions() {
  const gameOn = !!state.modes?.resources?.active;
  const focusOn = !!state.modes?.focus?.active;

  const actions = [
    {
      name: 'Ask AI', icon: 'sparkle',
      run: () => { queryInput.focus(); if (!aiMode) setMode(true); },
    },
    {
      name: 'Summarise', icon: 'bookmark',
      run: () => invoke('tabs:navigate', { input: 'browser://student' }),
    },
    {
      name: 'Research', icon: 'search',
      run: () => invoke('tabs:navigate', { input: 'browser://ai' }),
    },
    {
      name: 'Focus', icon: 'clock', on: focusOn,
      run: () => invoke('tabs:navigate', { input: 'browser://focus' }),
    },
    {
      name: 'Game Mode', icon: 'gear', on: gameOn,
      run: () => invoke('resources:game-mode', { on: !gameOn }),
    },
  ];

  $('#actions').replaceChildren(...actions.map((action) => element('button', {
    class: 'action' + (action.on ? ' on' : ''),
    onclick: action.run,
  }, [
    icon(action.icon, { size: 14 }),
    element('span', { text: action.name }),
  ])));
}

/* ---- frequent sites -------------------------------------------------------- */

function renderFrequent() {
  const byHost = new Map();
  for (const entry of state.history || []) {
    let host;
    try { host = new URL(entry.url).hostname.replace(/^www\./, ''); } catch { continue; }
    const current = byHost.get(host);
    if (current) current.visits += 1;
    else byHost.set(host, { url: entry.url, title: entry.title, host, visits: 1 });
  }
  const top = [...byHost.values()].sort((a, b) => b.visits - a.visits).slice(0, 6);

  // Hidden entirely on a fresh profile rather than showing empty placeholders:
  // a row of grey circles is worse than no row.
  $('#frequent').hidden = top.length === 0;
  if (!top.length) return;

  $('#frequent-row').replaceChildren(...top.map((entry) => element('button', {
    class: 'frequent-item',
    title: entry.url,
    onclick: (event) => openUrl(entry.url, event),
  }, [
    favicon(entry.url, 20),
    element('span', { class: 'frequent-name', text: entry.host.split('.')[0] }),
  ])));
}

/* ---- widgets --------------------------------------------------------------- */

/**
 * Render the widgets the user has chosen, in their chosen order.
 *
 * The widget registry (shared/widgets.js) and its renderers
 * (pages/widgets/*.js) already existed but nothing ever called them - the page
 * drew a fixed row of cards instead, so declaring a widget had no effect and
 * the layout in settings was inert. This is the render path that was missing.
 */
let mounted = [];
let customising = false;

/** The layout the user has chosen, or the default for a fresh profile. */
function currentLayout() {
  const chosen = state.settings?.newTab?.widgets;
  return Array.isArray(chosen) && chosen.length
    ? [...chosen]
    : [...((window.widgets && window.widgets.DEFAULT_LAYOUT) || [])];
}

/**
 * Persist a layout.
 *
 * Main validates it - unknown ids are dropped and duplicates removed - and
 * pushes new state back, which re-renders through onState. Nothing here
 * updates the DOM directly, so what is on screen is always what was saved.
 */
function saveLayout(next) {
  invoke('settings:update', { newTab: { widgets: next } }).catch((error) => {
    console.error('could not save layout:', error.message);
  });
}

function setCustomising(on) {
  customising = on;
  document.body.classList.toggle('customising', on);
  renderWidgets();
}

function renderWidgets() {
  // Widgets own timers and listeners; dropping the nodes without disposing
  // would leave those running for the life of the page.
  for (const node of mounted) {
    if (typeof node.dispose === 'function') {
      try { node.dispose(); } catch { /* a broken widget must not block the rest */ }
    }
  }
  mounted = [];

  const host = $('#widgets');
  if (!host) return;

  const chosen = state.settings?.newTab?.widgets || [];
  const renderers = window.widgetRenderers || {};

  const ctx = {
    element, icon, favicon, openUrl, invoke, state,
    // Subscribe to a main-process event. Returns an unsubscribe function,
    // which the widget calls from dispose() - a widget that outlives its
    // listener would keep re-rendering a detached node.
    on: (channel, handler) => window.browser.on(channel, handler),
    // Whether AI is available in this build. The key itself never reaches the
    // renderer, so this only reports availability.
    credential: () => !!state.ai?.available,
    ask: async (prompt) => {
      const result = await invoke('ai:ask', { prompt });
      return result?.text || '';
    },
  };

  const nodes = [];
  for (const id of chosen) {
    const render = renderers[id];
    if (typeof render !== 'function') continue;
    try {
      const node = render(ctx);
      if (node) { nodes.push(node); mounted.push(node); }
    } catch (error) {
      // One failing widget must not take the page with it.
      nodes.push(element('section', { class: 'widget' }, [
        element('p', { class: 'widget-empty', text: 'This widget could not load.' }),
      ]));
      console.error('widget failed:', id, error);
    }
  }
  host.replaceChildren(...nodes);

  // Customise mode: the bar mounts above the grid and the cards become
  // draggable. Both are rebuilt on every render so they always reflect the
  // saved layout rather than a stale copy.
  const tools = (window.widgetRenderers || {}).__customise;
  const bar = $('#customise-bar');
  if (bar) {
    if (customising && tools) {
      bar.replaceChildren(tools.build(ctx, {
        getLayout: currentLayout,
        setLayout: saveLayout,
        onExit: () => setCustomising(false),
      }));
      bar.hidden = false;
      tools.makeDraggable(host, { getLayout: currentLayout, setLayout: saveLayout });
    } else {
      bar.replaceChildren();
      bar.hidden = true;
    }
  }
}

function plural(count, noun) {
  return count + ' ' + noun + (count === 1 ? '' : 's');
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

/* ---- init ------------------------------------------------------------------ */

$('#mark-glyph').append(icon('sparkle', { size: 30 }));
setMode(false);

/* ---- search engine ------------------------------------------------------- */

/** Engines a plain search can use. Matches shared/urls.js#ENGINES. */
const ENGINE_NAMES = { google: 'Google', brave: 'Brave' };

function renderEngine() {
  const select = $('#search-engine');
  if (!select) return;
  const current = state.settings?.searchEngine || 'google';

  // Rebuilt only when the options are missing, so reopening the select while
  // a state push arrives does not snap it shut.
  if (select.options.length !== Object.keys(ENGINE_NAMES).length) {
    select.replaceChildren(...Object.entries(ENGINE_NAMES).map(([id, name]) =>
      element('option', { value: id, text: name })));
  }
  if (select.value !== current) select.value = current;
}

$('#search-engine')?.addEventListener('change', async (event) => {
  const engine = event.target.value;
  try {
    await invoke('settings:update', { searchEngine: engine });
  } catch {
    // Put it back to what actually stuck rather than showing a choice that
    // was not saved.
    renderEngine();
  }
});

/* ---- status strip -------------------------------------------------------- */

/**
 * A quiet line of facts the browser already knows.
 *
 * Every figure here is counted, never estimated, and anything not yet
 * measured is left out rather than shown as a zero - a strip that says
 * "0 blocked" on a fresh profile reads as broken rather than new.
 */
function renderStatusStrip() {
  const strip = $('#status-strip');
  if (!strip) return;

  if (state.settings?.newTab?.showStatusStrip === false) {
    strip.hidden = true;
    return;
  }

  const parts = [];

  const shields = state.features?.shields;
  if (shields) {
    if (shields.enabled === false) {
      parts.push(['Shields off', 'browser://shields']);
    } else {
      const blocked = Number(shields.totalBlocked || 0);
      if (blocked > 0) {
        parts.push([blocked.toLocaleString() + ' blocked', 'browser://shields']);
      }
      const rules = Number(shields.ruleCount || 0);
      if (rules > 0) parts.push([rules.toLocaleString() + ' filter rules', 'browser://shields']);
    }
  }

  const tabs = Array.isArray(state.tabs) ? state.tabs.length : 0;
  if (tabs > 1) parts.push([tabs + ' tabs open', 'browser://organizer']);

  const focus = state.features?.focus;
  if (focus?.active) {
    const left = Math.ceil((focus.remainingMs || 0) / 60000);
    parts.push(['Focus · ' + left + (left === 1 ? ' minute left' : ' minutes left'), 'browser://focus']);
  }

  const memory = state.features?.resources?.totals?.totalMemoryMb;
  if (memory) parts.push([memory + ' MB in use', 'browser://resources']);

  if (!parts.length) {
    strip.hidden = true;
    return;
  }

  strip.hidden = false;
  strip.replaceChildren(...parts.map(([text, url]) => element('button', {
    class: 'status-item',
    type: 'button',
    text,
    onclick: (event) => openUrl(url, event),
  })));
}

onState((next) => {
  state = next;
  renderActions();
  renderFrequent();
  renderWidgets();
  renderSense();
  renderHint();
  renderEngine();
  renderStatusStrip();
  // Widget card size, chosen by the user.
  document.body.dataset.widgetSize = state.settings?.newTab?.widgetSize || 'comfortable';
});

// Widgets run their own timers and clean them up in dispose().
window.addEventListener('pagehide', () => {
  for (const node of mounted) {
    if (typeof node.dispose === 'function') {
      try { node.dispose(); } catch { /* tearing down anyway */ }
    }
  }
});

/* ---- Static Sense ---------------------------------------------------------
 * One suggestion at most, and only when something actually warrants saying.
 * Every suggestion can be dismissed for now or silenced for good - a browser
 * that keeps suggesting things is one people learn to ignore.
 */

async function renderSense() {
  const host = $('#sense');
  if (!host) return;
  let suggestion = null;
  try { suggestion = await invoke('sense:current'); } catch { suggestion = null; }

  if (!suggestion) { host.hidden = true; host.replaceChildren(); return; }

  const act = element('button', { class: 'sense-act', text: suggestion.actionLabel });
  act.addEventListener('click', async () => {
    await invoke('sense:accept', { id: suggestion.id, action: suggestion.action });
    renderSense();
  });

  const later = element('button', { class: 'sense-dismiss', text: 'Not now' });
  later.addEventListener('click', async () => {
    await invoke('sense:snooze', { id: suggestion.id });
    renderSense();
  });

  const never = element('button', { class: 'sense-dismiss', text: 'Never' });
  never.title = 'Do not suggest this again';
  never.addEventListener('click', async () => {
    await invoke('sense:silence', { id: suggestion.id });
    renderSense();
  });

  host.replaceChildren(element('div', { class: 'sense-card' }, [
    element('div', { class: 'sense-body' }, [
      element('div', { class: 'sense-title', text: suggestion.title }),
      element('div', { class: 'sense-detail', text: suggestion.detail }),
    ]),
    element('div', { class: 'sense-tools' }, [act, later, never]),
  ]));
  host.hidden = false;
}

$('#customise-open').addEventListener('click', () => setCustomising(!customising));

// Escape leaves customise mode, matching how AI mode already behaves.
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && customising) setCustomising(false);
});

queryInput.focus();

})();
