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

// The shortcuts row and its menus (newtab-shortcuts.js) share this page's
// helpers. Handed over before anything draws, because the quick buttons and
// Customise can both open one of its menus before the row itself has drawn.
window.newtabShortcuts.init({ state: () => state, element, favicon, icon, invoke, openUrl });
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
  // A question for Gemini is not a search, so it gets no search suggestions.
  if (aiMode) closeSuggestions();
  else if (queryInput.value.trim() && document.activeElement === queryInput) refreshSuggestions();
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
  // Keys mid-composition (Japanese, Chinese, Korean input) belong to the
  // input method, not to the list.
  if (event.isComposing) return;
  const open = suggestionsOpen();
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !aiMode) {
    event.preventDefault();
    if (open) moveSelection(event.key === 'ArrowDown' ? 1 : -1);
    else if (queryInput.value.trim()) refreshSuggestions();
    return;
  }
  if (event.key === 'Tab' && !event.shiftKey) {
    // With a suggestion chosen, Tab writes it into the box to carry on
    // typing from - the way a shell completes a word.
    if (open && suggestions.selected >= 0) {
      event.preventDefault();
      fillIn(suggestions.rows[suggestions.selected]);
      return;
    }
    // Otherwise Tab is the mode switch, not a focus move: this field is the
    // only control that matters here, so moving focus away is never wanted.
    if (!state.ai?.available) return;
    event.preventDefault();
    setMode(!aiMode);
    return;
  }
  if (event.key === 'Escape') {
    // First Escape puts back what was typed and closes the list; only the
    // next one leaves AI mode, so one key never undoes two things.
    if (open) {
      event.preventDefault();
      queryInput.value = suggestions.typed;
      closeSuggestions();
      return;
    }
    if (busy) { invoke('ai:cancel'); busy = false; renderHint(); return; }
    if (aiMode) { event.preventDefault(); setMode(false); }
  }
});

$('#search').addEventListener('submit', (event) => {
  event.preventDefault();
  const chosen = suggestionsOpen() && suggestions.selected >= 0 ? suggestions.rows[suggestions.selected] : null;
  if (chosen) return commitRow(chosen);
  const value = queryInput.value.trim();
  if (!value) return;
  if (aiMode && state.ai?.available) return ask(value);
  closeSuggestions();
  invoke('tabs:navigate', { input: value });
});

/* ---- suggestions -----------------------------------------------------------
 * Live suggestions under the box while typing, in the same order as the
 * address bar's (shared/suggest.js builds both lists).
 *
 * Two sources, at two speeds. History and bookmarks answer at once, on every
 * keystroke. The search engine is asked once typing pauses, by main - this
 * page cannot reach the network, and main applies every privacy rule. While
 * its next answer is on the way, the last one stays up narrowed to what is
 * typed now, so the list tightens letter by letter instead of collapsing and
 * growing back.
 *
 * Rows are painted into the nodes already there, so a keystroke changes text
 * in place: only rows the list did not have before animate in, and favicons
 * are not reloaded on every letter.
 */

const suggestBox = $('#suggest');
const suggestions = {
  typed: '',       // what the person typed, kept while the arrows preview rows
  rows: [],
  selected: -1,    // the keyboard's choice; -1 is "what was typed"
  pages: [],
  searches: [],    // the engine's latest answer
  seq: 0,          // bumped on every change, so a late answer is dropped
  timer: 0,
  asked: false,
};
let lastSuggestSetup = '';
/** Long enough to skip the middle of a word, short enough to feel live. */
const REMOTE_DELAY_MS = 120;

const suggestionsOpen = () => !suggestBox.hidden && suggestions.rows.length > 1;
const remoteOn = () => state.settings?.searchSuggestions !== false && !state.incognito;
const engineLabel = () => (state.settings?.searchEngine === 'brave' ? 'Brave' : 'Google');

function refreshSuggestions() {
  const typed = queryInput.value.trim();
  suggestions.typed = queryInput.value;
  suggestions.selected = -1;
  clearTimeout(suggestions.timer);
  const seq = ++suggestions.seq;
  if (!typed || aiMode) { closeSuggestions(); return; }

  suggestions.searches = window.suggest.stillMatching(suggestions.searches, typed);
  invoke('omnibox:suggest', { query: typed }).catch(() => []).then((pages) => {
    if (seq !== suggestions.seq) return;
    suggestions.pages = Array.isArray(pages) ? pages : [];
    renderSuggestions();
  });

  // Checked here only to save a pointless round trip; main checks again and
  // is the one that decides.
  if (!remoteOn() || !window.suggest.remoteAllowed(typed)) { suggestions.searches = []; return; }
  suggestions.timer = setTimeout(() => {
    suggestions.asked = true;
    invoke('search:suggest', { query: typed }).catch(() => null).then((answer) => {
      if (seq !== suggestions.seq || !answer || answer.stale) return;
      suggestions.searches = Array.isArray(answer.searches) ? answer.searches : [];
      renderSuggestions();
    });
  }, REMOTE_DELAY_MS);
}

function closeSuggestions() {
  suggestions.seq++;
  clearTimeout(suggestions.timer);
  // Tell main to drop a request still in flight; nobody will read it.
  if (suggestions.asked) { suggestions.asked = false; invoke('search:suggest', { query: '' }).catch(() => {}); }
  hideSuggestions();
}

/** Take the list down without abandoning the engine's answer on its way. */
function hideSuggestions() {
  suggestions.rows = [];
  suggestions.selected = -1;
  suggestBox.hidden = true;
  suggestBox.classList.remove('is-open');
  $('#search').classList.remove('is-suggesting');
  queryInput.setAttribute('aria-expanded', 'false');
  queryInput.removeAttribute('aria-activedescendant');
}

const rowKey = (row) => row ? row.kind + '\u0000' + (row.query || row.url) : '';
const rowText = (row) => (row.kind === 'search' ? row.query : row.url);

function renderSuggestions() {
  const typed = suggestions.typed.trim();
  // Switched off while the list was up: the engine's rows go at once.
  if (!remoteOn()) suggestions.searches = [];
  const chosen = rowKey(suggestions.rows[suggestions.selected]);
  const rows = window.suggest.mergeSuggestions(typed, {
    searches: suggestions.searches,
    pages: suggestions.pages,
    engine: state.settings?.searchEngine || 'google',
  });
  // A single row would only repeat the box back, so the page stays calm -
  // but the engine may still be about to answer, so nothing is cancelled.
  if (rows.length < 2 || aiMode || !typed) { hideSuggestions(); return; }

  // An answer landing while the arrows are in use keeps the same row chosen.
  suggestions.selected = chosen ? rows.findIndex((row) => rowKey(row) === chosen) : -1;
  suggestions.rows = rows;

  const opening = suggestBox.hidden;
  let list = suggestBox.querySelector('.suggest-list');
  if (!list) {
    list = element('div', { class: 'suggest-list' }, [element('div', { class: 'suggest-glide', 'aria-hidden': 'true' })]);
    list.addEventListener('mouseleave', () => glideTo(suggestions.selected));
    suggestBox.replaceChildren(list, element('div', { class: 'suggest-foot' }));
  }
  const nodes = [...list.querySelectorAll('.suggest-row')];
  rows.forEach((row, index) => {
    let node = nodes[index];
    if (!node) {
      node = makeRow(index);
      // Rows the list did not have before arrive with a short rise; rows it
      // already had just change their words.
      if (!opening) node.classList.add('is-new');
      list.append(node);
    }
    paintRow(node, row, typed);
  });
  for (const extra of nodes.slice(rows.length)) extra.remove();
  paintFoot(typed);

  suggestBox.classList.toggle('is-opening', opening);
  suggestBox.hidden = false;
  suggestBox.classList.add('is-open');
  $('#search').classList.add('is-suggesting');
  queryInput.setAttribute('aria-expanded', 'true');
  fitSuggestions();
  showSelection(!opening);
}

function makeRow(index) {
  const node = element('div', { class: 'suggest-row', role: 'option', id: 'suggest-' + index });
  node.style.setProperty('--i', index);
  node.dataset.index = index;
  // mousedown would take focus from the box and close the list before the
  // click lands; keep the box focused and act on the click.
  node.addEventListener('mousedown', (event) => event.preventDefault());
  node.addEventListener('click', (event) => {
    const row = suggestions.rows[Number(node.dataset.index)];
    if (row) commitRow(row, event);
  });
  node.addEventListener('auxclick', (event) => {
    const row = suggestions.rows[Number(node.dataset.index)];
    if (event.button === 1 && row?.kind === 'page') { event.preventDefault(); commitRow(row, event); }
  });
  node.addEventListener('mouseenter', () => glideTo(Number(node.dataset.index)));
  node.addEventListener('animationend', () => node.classList.remove('is-new'));
  return node;
}

function paintRow(node, row, typed) {
  // The icon is rebuilt only when it changes, so a favicon is not refetched
  // and does not flicker on every keystroke.
  const iconKey = row.kind === 'page' ? 'page:' + row.source + ':' + hostOf(row.url) : row.kind + (row.past ? ':past' : '');
  if (node.dataset.icon !== iconKey) {
    node.dataset.icon = iconKey;
    const glyph = row.kind === 'page'
      ? (row.source === 'bookmark' ? withBadge(favicon(row.url, 16), 'star') : favicon(row.url, 16))
      : icon(row.kind === 'go' ? 'forward' : row.past ? 'clock' : 'search', { size: 15 });
    node.replaceChildren(
      element('span', { class: 'suggest-icon' }, [glyph]),
      element('span', { class: 'suggest-text' }),
      element('span', { class: 'suggest-tail' }),
    );
  }
  node.className = 'suggest-row' + (node.classList.contains('is-new') ? ' is-new' : '') +
    ' is-' + row.kind + (row.typed ? ' is-typed' : '') + (row.past ? ' is-past' : '');

  const text = node.querySelector('.suggest-text');
  const tail = node.querySelector('.suggest-tail');
  if (row.kind === 'page') {
    text.replaceChildren(
      element('span', { class: 'suggest-title' }, highlighted(row.title, typed)),
      element('span', { class: 'suggest-url' }, highlighted(shortUrl(row.url), typed)),
    );
    tail.replaceChildren(element('span', { class: 'suggest-tag', text: row.source === 'bookmark' ? 'Bookmark' : 'Visited' }));
  } else if (row.kind === 'go') {
    text.replaceChildren(element('span', { class: 'suggest-title' }, highlighted(row.url, typed)));
    tail.replaceChildren(element('span', { class: 'suggest-tag', text: 'Open' }));
  } else {
    text.replaceChildren(element('span', { class: 'suggest-title' }, highlighted(row.query, typed)));
    tail.replaceChildren(row.typed
      ? element('span', { class: 'suggest-tag', text: 'Search ' + engineLabel() })
      : fillButton(row));
  }
  node.title = row.kind === 'page' ? row.url : '';
}

/** Text with the typed part marked - as text nodes, never as markup. */
function highlighted(value, typed) {
  const [before, match, after] = window.suggest.highlightParts(value, typed);
  return [before, match ? element('mark', { class: 'suggest-match', text: match }) : null, after]
    .filter(Boolean).map((part) => (typeof part === 'string' ? document.createTextNode(part) : part));
}

function withBadge(node, name) {
  node.append(element('span', { class: 'suggest-badge' }, [icon(name, { size: 9, filled: true })]));
  return node;
}

/** Chrome's little arrow: put this search in the box and keep typing. */
function fillButton(row) {
  const button = element('button', {
    type: 'button', class: 'suggest-fill', title: 'Fill in "' + row.query + '"',
    'aria-label': 'Fill in ' + row.query, tabindex: '-1',
  }, [fillArrow()]);
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', (event) => { event.stopPropagation(); fillIn(row); });
  return button;
}

/** An arrow pointing up and back into the box. Not in the shared icon set. */
function fillArrow() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M17.5 17.5 7 7M7 15.5V7h8.5');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.9');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname) + u.search;
  } catch { return url; }
}

function paintFoot(typed) {
  const foot = suggestBox.querySelector('.suggest-foot');
  let source;
  if (state.incognito) source = 'Incognito: nothing you type is sent anywhere';
  else if (!remoteOn()) source = 'From your history and bookmarks';
  else if (window.suggest.looksLikeAddress(typed)) source = 'Addresses stay on this computer';
  else if (!window.suggest.remoteAllowed(typed)) source = 'Looks private, so it stays on this computer';
  else source = 'Suggestions from ' + engineLabel();
  const keys = suggestions.selected >= 0
    ? [element('kbd', { text: 'Tab' }), ' to fill in · ', element('kbd', { text: 'Enter' }), ' to go']
    : [element('kbd', { text: '↑' }), element('kbd', { text: '↓' }), ' to choose · ', element('kbd', { text: 'Esc' }), ' to close'];
  const local = !remoteOn() || !window.suggest.remoteAllowed(typed);
  foot.replaceChildren(
    element('span', { class: 'suggest-source' + (local ? ' is-local' : '') }, [
      local ? icon('lock', { size: 11 }) : element('span', { class: 'suggest-dot' }),
      element('span', { text: source }),
    ]),
    element('span', { class: 'suggest-keys' }, keys.map((part) => (typeof part === 'string' ? document.createTextNode(part) : part))),
  );
}

/** Keep the list on screen in a short window: it scrolls rather than clips. */
function fitSuggestions() {
  const box = $('#search').getBoundingClientRect();
  const room = Math.max(140, window.innerHeight - box.bottom - 24);
  suggestBox.style.setProperty('--suggest-room', room + 'px');
}

function moveSelection(step) {
  const count = suggestions.rows.length;
  // -1 sits between the last row and the first: arrowing past either end
  // brings back exactly what was typed.
  let next = suggestions.selected + step;
  if (next >= count) next = -1;
  else if (next < -1) next = count - 1;
  suggestions.selected = next;
  queryInput.value = next < 0 ? suggestions.typed : rowText(suggestions.rows[next]);
  const end = queryInput.value.length;
  queryInput.setSelectionRange(end, end);
  showSelection(true);
  paintFoot(suggestions.typed.trim());
}

function showSelection(animate) {
  const rows = suggestBox.querySelectorAll('.suggest-row');
  rows.forEach((node, index) => {
    node.classList.toggle('is-selected', index === suggestions.selected);
    node.setAttribute('aria-selected', index === suggestions.selected ? 'true' : 'false');
  });
  if (suggestions.selected >= 0) queryInput.setAttribute('aria-activedescendant', 'suggest-' + suggestions.selected);
  else queryInput.removeAttribute('aria-activedescendant');
  glideTo(suggestions.selected, animate);
  rows[suggestions.selected]?.scrollIntoView({ block: 'nearest' });
}

/**
 * One highlight that slides between rows, under the keyboard's choice or the
 * pointer. A single moving shape reads as one thing travelling; a background
 * switching on and off between rows reads as flicker.
 */
function glideTo(index, animate = true) {
  const glide = suggestBox.querySelector('.suggest-glide');
  const node = suggestBox.querySelectorAll('.suggest-row')[index];
  if (!glide) return;
  if (!node) {
    // Parked at the top: left where a removed row was, it would stretch the
    // list's scroll area and conjure a scrollbar for a list that fits.
    glide.classList.add('no-slide');
    glide.classList.remove('is-on');
    glide.style.setProperty('transform', 'translateY(0)');
    return;
  }
  const arriving = !glide.classList.contains('is-on');
  // Appearing from nowhere it fades in where it is, rather than sliding in
  // from wherever it last was.
  glide.classList.toggle('no-slide', arriving || !animate);
  glide.style.setProperty('transform', 'translateY(' + node.offsetTop + 'px)');
  glide.style.setProperty('height', node.offsetHeight + 'px');
  glide.classList.add('is-on');
}

function fillIn(row) {
  queryInput.value = rowText(row) + (row.kind === 'search' ? ' ' : '');
  queryInput.focus();
  refreshSuggestions();
}

function commitRow(row, event) {
  closeSuggestions();
  if (row.kind === 'page') return openUrl(row.url, event);
  invoke('tabs:navigate', { input: rowText(row) });
}

queryInput.addEventListener('input', () => refreshSuggestions());
queryInput.addEventListener('blur', () => closeSuggestions());
queryInput.addEventListener('focus', () => { if (queryInput.value.trim() && !aiMode) refreshSuggestions(); });
window.addEventListener('resize', () => { if (!suggestBox.hidden) fitSuggestions(); });

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

  // ai:ask now REJECTS on failure rather than resolving {ok:false}, so a
  // caller that only reads result.text can no longer print undefined.
  try {
    const result = await invoke('ai:ask', { prompt, system: SYSTEM_PROMPT });
    busy = false;
    renderHint();
    if (!result) return;
    $('#answer-text').textContent = result.text;
    $('#answer-label').textContent = 'Gemini · ' + (result.model || '');
  } catch (error) {
    busy = false;
    renderHint();
    $('#answer-text').textContent = error.message || 'The assistant could not answer.';
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
 * anything beyond these lives in the menu or the command bar. Each can be
 * hidden (right-click it, or Customise > Widgets), and so can the whole row.
 */
function renderActions() {
  const gameOn = !!state.modes?.resources?.active;
  const focusOn = !!state.modes?.focus?.active;
  const tab = state.settings?.newTab || {};
  const hidden = new Set(tab.hiddenActions || []);

  const actions = [
    {
      id: 'ask', name: 'Ask AI', icon: 'sparkle',
      run: () => { queryInput.focus(); if (!aiMode) setMode(true); },
    },
    {
      id: 'summarise', name: 'Summarise', icon: 'bookmark',
      run: () => invoke('tabs:navigate', { input: 'browser://student' }),
    },
    {
      id: 'research', name: 'Research', icon: 'search',
      run: () => invoke('tabs:navigate', { input: 'browser://ai' }),
    },
    {
      id: 'focus', name: 'Focus', icon: 'clock', on: focusOn,
      run: () => invoke('tabs:navigate', { input: 'browser://focus' }),
    },
    {
      id: 'game', name: 'Game Mode', icon: 'gear', on: gameOn,
      run: () => invoke('resources:game-mode', { on: !gameOn }),
    },
  ];

  const shown = tab.showActions === false ? [] : actions.filter((action) => !hidden.has(action.id));
  $('#actions').hidden = !shown.length;
  $('#actions').replaceChildren(...shown.map((action) => {
    const button = element('button', {
      class: 'action' + (action.on ? ' on' : ''),
      onclick: action.run,
    }, [
      icon(action.icon, { size: 14 }),
      element('span', { text: action.name }),
    ]);
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      window.newtabShortcuts.popup(event.clientX, event.clientY, action.name, [
        { label: 'Hide "' + action.name + '"', icon: 'close', run: () => saveNewTab({ hiddenActions: [...hidden, action.id] }) },
        { label: 'Hide all these buttons', icon: 'trash', run: () => saveNewTab({ showActions: false }) },
        null,
        { label: 'Customise this page…', icon: 'palette', run: () => setCustomising(true) },
      ]);
    });
    return button;
  }));
}

/** Save part of the new tab's settings, kept here at once as well. */
function saveNewTab(patch) {
  if (state.settings) state.settings.newTab = { ...(state.settings.newTab || {}), ...patch };
  renderActions();
  invoke('settings:update', { newTab: patch }).catch((error) => console.error('new tab:', error.message));
}

/* ---- frequent sites -------------------------------------------------------- */

function renderFrequent() {
  // Most visited, or your own shortcuts, with their menu (newtab-shortcuts.js).
  window.newtabShortcuts.render();
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

/**
 * The layout the user has chosen, or the default for a fresh profile. An
 * empty list is a choice too - every widget switched off. Read as "use the
 * defaults", it brought them all back the moment one was switched on again.
 */
function currentLayout() {
  const chosen = state.settings?.newTab?.widgets;
  return Array.isArray(chosen)
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
  // Kept here at once as well, so a second switch flipped before main's
  // answer arrives builds on the first instead of undoing it.
  if (state.settings) state.settings.newTab = { ...(state.settings.newTab || {}), widgets: [...next] };
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
      // A widget asking a question should get text or a thrown error, never
      // an empty string that looks like a blank answer.
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
      if (node) {
        node.dataset.widget = id;
        node.tabIndex = 0;
        node.prepend(element('span', { class: 'widget-grip', title: 'Drag to move', 'aria-hidden': 'true' }));
        nodes.push(node);
        mounted.push(node);
      }
    } catch (error) {
      // One failing widget must not take the page with it.
      nodes.push(element('section', { class: 'widget' }, [
        element('p', { class: 'widget-empty', text: 'This widget could not load.' }),
      ]));
      console.error('widget failed:', id, error);
    }
  }
  host.replaceChildren(...nodes);

  // Widgets float: each sits where the user put it, or down a side.
  const float = (window.widgetRenderers || {}).__float;
  if (float) {
    float.place(host, state.settings?.newTab?.positions || {});
    float.enableDrag(host, {
      customising: () => customising,
      positions: () => state.settings?.newTab?.positions || {},
      save: (positions) => invoke('settings:update', { newTab: { positions } }).catch(() => {}),
    });
  }

  // The studio is built once per visit to customise mode and refreshed from
  // state after that, so a change never rebuilds (and flashes) the gallery.
  const tools = (window.widgetRenderers || {}).__customise;
  const bar = $('#customise-bar');
  if (bar) {
    if (customising && tools) {
      if (!bar.firstChild) {
        bar.replaceChildren(tools.build({ element, icon, invoke, state: () => state }, {
          getLayout: currentLayout,
          setLayout: saveLayout,
          onExit: () => setCustomising(false),
        }));
      } else {
        bar.firstChild.refresh?.();
      }
      bar.hidden = false;
    } else {
      bar.replaceChildren();
      bar.hidden = true;
    }
  }
}

window.addEventListener('resize', () => {
  const float = (window.widgetRenderers || {}).__float;
  const host = $('#widgets');
  if (float && host) float.place(host, state?.settings?.newTab?.positions || {});
});

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

/* ---- background -----------------------------------------------------------
   The chosen wallpaper. This setting existed and was validated and stored,
   and nothing ever painted it - so choosing a background did nothing at all. */

/** The wallpaper catalogue, fetched once per page (and again if it changes). */
let wallpaperCatalog = null;
window.browser.on('wallpapers:changed', () => { wallpaperCatalog = null; renderBackground(); });
function wallpaperList() {
  if (!wallpaperCatalog) wallpaperCatalog = invoke('wallpapers:catalog').catch(() => ({ wallpapers: [] }));
  return wallpaperCatalog;
}

/**
 * Which wallpaper this page shows. 'fixed' is the chosen one, 'launch' is
 * the one main drew at startup, 'newtab' is drawn afresh for this page and
 * then kept for as long as the page is open.
 */
let pageWallpaper = null;
let pageWallpaperDraw = null;
async function resolveWallpaper(config) {
  const { wallpapers } = await wallpaperList();
  const byId = (id) => wallpapers.find((w) => w.id === id) || null;
  if (config.wallpaperMode === 'launch' && state.launchWallpaper) return byId(state.launchWallpaper);
  if (config.wallpaperMode === 'newtab') {
    if (pageWallpaper && pageWallpaperFits(config)) return pageWallpaper;
    // One draw at a time. State arrives in bursts as a page opens, and two
    // draws in flight meant main handed out two wallpapers for one tab - so
    // the next tab could land on the one this tab drew but never showed.
    if (!pageWallpaperDraw) {
      pageWallpaperDraw = invoke('wallpapers:random', { previous: pageWallpaper?.id || '' })
        .catch(() => null)
        .then((entry) => { pageWallpaper = entry; pageWallpaperDraw = null; return entry; });
    }
    return pageWallpaperDraw;
  }
  return byId(config.backgroundValue);
}
function pageWallpaperFits(config) {
  const pool = config.wallpaperPool || 'all';
  if (!pageWallpaper || pool === 'all') return !!pageWallpaper;
  if (pool === 'favourites') return (config.wallpaperFavourites || []).includes(pageWallpaper.id);
  return pageWallpaper.category === pool;
}

let wallpaperDrawn = '';
function paintWallpaper(layer, entry) {
  const credit = $('#wallpaper-credit');
  window.currentWallpaperId = entry?.id || '';
  if (!entry) return false;
  if (wallpaperDrawn !== entry.id) {
    wallpaperDrawn = entry.id;
    // The average colour paints at once; the photo fades in over it.
    layer.style.setProperty('background-color', entry.tone);
    const img = new Image();
    img.decoding = 'async';
    // Built-in wallpapers ship with the app; ones from the wallpaper service
    // arrive as full https addresses.
    const source = window.wallpaperPicker.imageOf(entry, 'file');
    img.src = source;
    layer.classList.remove('is-ready');
    img.onload = () => {
      if (wallpaperDrawn !== entry.id) return;
      layer.style.setProperty('background-image',
        'linear-gradient(180deg, rgba(0,0,0,0.45), rgba(0,0,0,0.18) 40%, rgba(0,0,0,0.55)), url("' + source.replace(/["'()\\]/g, '') + '")');
      layer.style.setProperty('background-size', 'cover');
      layer.style.setProperty('background-position', 'center');
      layer.classList.add('is-ready');
    };
  }
  if (credit) {
    credit.hidden = false;
    credit.textContent = 'Photo: ' + entry.credit.by + ' · ' + entry.credit.source;
  }
  document.body.classList.add('has-photo');
  return true;
}

function renderBackground() {
  const config = state.settings?.newTab || {};
  const layer = $('#ambient');
  if (!layer) return;

  const kind = config.background || 'plain';
  const value = config.backgroundValue || '';
  if (kind !== 'wallpaper') {
    wallpaperDrawn = '';
    window.currentWallpaperId = '';
    const credit = $('#wallpaper-credit');
    if (credit) credit.hidden = true;
    layer.style.removeProperty('background-color');
    layer.classList.remove('is-ready');
  }

  if (kind === 'wallpaper') {
    resolveWallpaper(config).then((entry) => {
      if ((state.settings?.newTab?.background || 'plain') !== 'wallpaper') return;
      if (!paintWallpaper(layer, entry)) document.body.classList.remove('has-photo');
    });
    return;
  }

  if ((kind === 'photo' || kind === 'image') && value) {
    // A photo needs a scrim, or text over a bright picture is unreadable.
    // The value came from main (a file path it wrote, or a URL the settings
    // allowlist accepted), but quotes are stripped anyway so a crafted value
    // cannot close the url() and append CSS of its own.
    const safe = String(value).replace(/["'()\\]/g, '');
    layer.style.setProperty('background-image',
      'linear-gradient(180deg, rgba(0,0,0,0.55), rgba(0,0,0,0.35) 40%, rgba(0,0,0,0.65)), ' +
      'url("' + safe + '")');
    layer.style.setProperty('background-size', 'cover');
    layer.style.setProperty('background-position', 'center');
    document.body.classList.add('has-photo');
  } else {
    layer.style.removeProperty('background-image');
    layer.style.removeProperty('background-size');
    layer.style.removeProperty('background-position');
    document.body.classList.remove('has-photo');
  }
}

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
  document.body.classList.toggle('incognito', !!state.incognito);
  document.getElementById('incognito-note').hidden = !state.incognito;
  renderActions();
  renderFrequent();
  renderWidgets();
  renderSense();
  renderHint();
  renderEngine();
  renderStatusStrip();
  // Redrawn only when the engine or the Search suggestions switch changes:
  // state arrives often, and a redraw would pull the highlight from under
  // the pointer.
  const suggestSetup = (state.settings?.searchEngine || '') + '|' + remoteOn();
  if (suggestSetup !== lastSuggestSetup) {
    lastSuggestSetup = suggestSetup;
    if (!suggestBox.hidden) renderSuggestions();
  }
  // Widget card size, chosen by the user.
  document.body.dataset.widgetSize = state.settings?.newTab?.widgetSize || 'comfortable';
  renderBackground();
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
