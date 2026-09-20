'use strict';
(function () {
/**
 * AI sidebar.
 *
 * Contextual AI that sits beside the page rather than replacing it. Distinct
 * from browser://ai, which is the full page with saved history - this is for
 * asking about what is on screen right now.
 *
 * THE PERMISSION LINE IS NOT DECORATION
 * The strip at the top always states what the AI can currently see, and it is
 * driven by the same classification main uses to decide. A sidebar able to
 * read the page is also able to read a bank statement, so "what can this see"
 * must never be a thing the user has to guess at.
 *
 * Page content is only ever read when an action needs it, and a sensitive page
 * requires confirmation for every request. Nothing is remembered as consent.
 */

const { invoke, onState, $, element } = window.page;

/** Rendered conversation. Kept in memory: this is a scratch conversation. */
let turns = [];
let busy = false;
let permission = null;

const transcript = $('#transcript');
const input = $('#input');

/* ---- permission strip ---------------------------------------------------- */

async function refreshPermission() {
  try {
    permission = await invoke('ai:page-permission');
  } catch (error) {
    permission = { level: 'blocked', reason: error.message };
  }

  const dot = $('#perm-dot');
  const text = $('#perm-text');
  dot.className = 'perm-dot is-' + (permission.level || 'blocked');

  if (permission.level === 'ordinary') {
    let host = '';
    try { host = new URL(permission.url).hostname.replace(/^www\./, ''); } catch { host = ''; }
    text.textContent = host ? 'Can read this page · ' + host : 'Can read this page';
  } else if (permission.level === 'sensitive') {
    text.textContent = permission.reason + ' Asks before reading.';
  } else {
    text.textContent = permission.reason || 'Cannot read this page.';
  }
  renderActions();
}

/* ---- quick actions ------------------------------------------------------- */

/** Formats offered as one-click actions. The rest live in the full AI page. */
const QUICK = [
  { id: 'short', label: 'Summarise' },
  { id: 'bullets', label: 'Key points' },
  { id: 'actions', label: 'Actions' },
  { id: 'facts', label: 'Facts' },
];

function renderActions() {
  const host = $('#actions');
  if (permission && permission.level === 'blocked') {
    host.replaceChildren();
    return;
  }
  host.replaceChildren(...QUICK.map((quick) => {
    const button = element('button', { class: 'side-action', text: quick.label });
    button.disabled = busy;
    button.addEventListener('click', () => summarise(quick.id, quick.label));
    return button;
  }));
}

/* ---- transcript ---------------------------------------------------------- */

function addTurn(role, text, meta) {
  turns.push({ role, text, meta });
  renderTranscript();
}

function renderTranscript() {
  if (!turns.length) {
    transcript.replaceChildren(element('p', {
      class: 'side-empty',
      text: 'Ask about this page, or pick an action above.',
    }));
    return;
  }

  transcript.replaceChildren(...turns.map((turn) => {
    const node = element('div', { class: 'side-turn is-' + turn.role });
    if (turn.meta) node.appendChild(element('div', { class: 'side-meta', text: turn.meta }));
    // textContent, never innerHTML: model output is untrusted text and this
    // page has a strict CSP precisely so a model cannot inject markup.
    node.appendChild(element('div', { class: 'side-text', text: turn.text }));

    if (turn.role === 'ai') {
      const tools = element('div', { class: 'side-turn-tools' });
      const copy = element('button', { class: 'side-tool-small', text: 'Copy' });
      copy.addEventListener('click', () => navigator.clipboard?.writeText(turn.text));
      const note = element('button', { class: 'side-tool-small', text: 'Save to notes' });
      note.addEventListener('click', async () => {
        try {
          await invoke('notes:add', { kind: 'summary', body: turn.text, url: permission?.url || '' });
          note.textContent = 'Saved';
        } catch (error) {
          note.textContent = 'Could not save';
        }
      });
      tools.append(copy, note);
      node.appendChild(tools);
    }
    return node;
  }));
  transcript.scrollTop = transcript.scrollHeight;
}

/* ---- actions ------------------------------------------------------------- */

function setBusy(on) {
  busy = on;
  $('#send').disabled = on;
  input.disabled = on;
  renderActions();
}

/**
 * Summarise the current page.
 *
 * A sensitive page returns `needsConfirmation` rather than a summary, and the
 * confirmation is asked here and passed back with the retry. It is never
 * stored: agreeing to read one bank page is not agreement to read the next.
 */
async function summarise(format, label) {
  if (busy) return;
  setBusy(true);
  addTurn('you', label);
  addTurn('ai', 'Reading the page…', 'working');

  try {
    let result = await invoke('ai:summarise-page', { format });

    if (result && result.needsConfirmation) {
      turns.pop();
      const ok = window.confirm(
        result.reason + '\n\nSend the contents of this page to the AI?');
      if (!ok) {
        addTurn('ai', 'Not sent. The page was not read.');
        setBusy(false);
        return;
      }
      addTurn('ai', 'Reading the page…', 'working');
      result = await invoke('ai:summarise-page', { format, confirmed: true });
    }

    turns.pop();
    addTurn('ai', result.text,
      result.truncated ? result.model + ' · page was long, summary may be partial' : result.model);
  } catch (error) {
    turns.pop();
    addTurn('ai', error.message);
  }
  setBusy(false);
}

/** Free-form question. Answered with page context when it is permitted. */
async function ask(question) {
  if (busy || !question) return;
  setBusy(true);
  addTurn('you', question);
  addTurn('ai', 'Thinking…', 'working');

  try {
    const history = turns
      .filter((turn) => turn.meta !== 'working')
      .slice(-8)
      .map((turn) => ({ role: turn.role === 'you' ? 'user' : 'model', text: turn.text }));

    const result = await invoke('ai:ask', {
      prompt: question,
      system: 'You are a browser sidebar assistant. Answer briefly and concretely.',
      history,
    });
    turns.pop();
    addTurn('ai', result.text, result.model);
  } catch (error) {
    turns.pop();
    addTurn('ai', error.message);
  }
  setBusy(false);
}

/* ---- wiring -------------------------------------------------------------- */

$('#compose').addEventListener('submit', (event) => {
  event.preventDefault();
  const question = input.value.trim();
  if (!question) return;
  input.value = '';
  ask(question);
});

// Enter sends, Shift+Enter makes a new line - the convention every chat box
// uses, and the reason the field is a textarea rather than an input.
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('#compose').dispatchEvent(new Event('submit', { cancelable: true }));
  }
});

$('#new-chat').addEventListener('click', () => { turns = []; renderTranscript(); });
$('#open-full').addEventListener('click', () => invoke('tabs:navigate', { input: 'browser://ai' }));
$('#close').addEventListener('click', () => invoke('sidebar:toggle', { open: false }));

// The permission line must follow the page, so it is re-read whenever the
// active tab or its URL changes.
let lastUrl = null;
onState((state) => {
  const url = state.active?.url || '';
  if (url !== lastUrl) {
    lastUrl = url;
    refreshPermission();
  }
});

renderTranscript();
refreshPermission();

})();
