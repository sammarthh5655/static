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
let clockTimer = null;

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

/* ---- utility row ----------------------------------------------------------- */

function renderUtility() {
  const now = new Date();
  const time = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const date = now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

  const tabs = (state.tabs || []).filter((tab) => tab.url && !tab.url.startsWith('browser://'));
  const recent = tabs[0];

  const resources = state.modes?.resources || {};
  const focus = state.modes?.focus || {};
  const safety = state.modes?.safety || {};

  const cards = [
    card('Now', time, date),
    recent
      ? card('Recent tab', recent.title || recent.url, hostOf(recent.url),
          () => invoke('tabs:select', { id: recent.id }))
      : card('Session', plural(state.tabs?.length || 0, 'tab'), 'Nothing else open'),
    card(
      focus.active ? 'Focus' : 'System',
      focus.active ? focus.badge + ' left' : (resources.badge || 'Ready'),
      safety.active ? 'Protection on' : 'Protection off',
      () => invoke('tabs:navigate', { input: 'browser://resources' }),
      focus.active || safety.active ? 'good' : '',
    ),
  ];

  $('#utility').replaceChildren(...cards);
}

function card(label, value, sub, onclick, tone = '') {
  const children = [
    element('div', { class: 'util-label', text: label }),
    element('div', { class: 'util-value' + (tone ? ' ' + tone : ''), text: value }),
    element('div', { class: 'util-sub', text: sub }),
  ];
  return onclick
    ? element('button', { class: 'util-card', onclick }, children)
    : element('div', { class: 'util-card' }, children);
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

onState((next) => {
  state = next;
  renderActions();
  renderFrequent();
  renderUtility();
  renderHint();
});

// The clock is the only thing on this page that needs a timer.
clockTimer = setInterval(renderUtility, 30000);
window.addEventListener('pagehide', () => clearInterval(clockTimer));

queryInput.focus();

})();
