'use strict';

/**
 * browser://ai - the dedicated AI page.
 *
 * A conversation list on the left, a transcript in the middle, a composer at
 * the bottom. Conversations live in the main process (features/ai/chats.js),
 * so a transcript survives closing the tab, and the Gemini call that continues
 * a conversation reads prior turns there rather than the renderer resending
 * them on every message.
 */
(function () {

const { invoke, onState, $, element, icon, timeAgo } = window.page;

let chats = [];
let activeId = null;
let activeChat = null;
let busy = false;
/** True while an answer is in flight, so renderTranscript draws the row. */
let pending = false;
let filter = '';
let sidebarHidden = false;

const SUGGESTIONS = [
  'Explain a hard topic in simple terms',
  'Summarise an article I paste below',
  'Draft a reply to an email',
  'Compare two products for me',
];

const SYSTEM_PROMPT = [
  'You are the assistant built into a web browser.',
  'Answer directly and usefully. Prefer short paragraphs and simple dashes for lists.',
  'Do not use markdown headings or bold markers.',
  'If you are unsure, or the question needs current information you do not have,',
  'say so plainly instead of guessing.',
].join(' ');

/* ---- sidebar -------------------------------------------------------------- */

function renderChatList() {
  const query = filter.trim().toLowerCase();
  const visible = query
    ? chats.filter((chat) => chat.title.toLowerCase().includes(query))
    : chats;

  if (!visible.length) {
    $('#chat-list').replaceChildren(element('div', {
      class: 'chat-list-empty',
      text: query ? 'No matching chats.' : 'No chats yet.',
    }));
    return;
  }

  // Pinned first, then most recently updated.
  const ordered = [...visible].sort((a, b) => {
    if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
    return b.updatedAt - a.updatedAt;
  });

  $('#chat-list').replaceChildren(...ordered.map((chat) => element('button', {
    class: 'chat-item' + (chat.id === activeId ? ' active' : ''),
    title: chat.title,
    onclick: () => openChat(chat.id),
  }, [
    chat.pinned ? icon('bookmark', { size: 12, filled: true }) : null,
    element('div', { class: 'chat-item-text' }, [
      element('div', { class: 'chat-item-title', text: chat.title }),
      element('div', {
        class: 'chat-item-meta',
        text: `${chat.turns} message${chat.turns === 1 ? '' : 's'} · ${timeAgo(chat.updatedAt)}`,
      }),
    ]),
  ])));
}

/* ---- transcript ----------------------------------------------------------- */

function renderTranscript() {
  const turns = activeChat?.turns || [];
  $('#empty').hidden = turns.length > 0;
  $('#chat-title').textContent = activeChat?.title || 'New chat';
  $('#pin-chat').textContent = activeChat?.pinned ? 'Unpin' : 'Pin';

  const last = [...turns].reverse().find((turn) => turn.model);
  $('#chat-model').textContent = last?.model || '';

  const nodes = turns.map((turn) => {
    const isUser = turn.role === 'user';
    const bubble = element('div', { class: 'turn ' + (isUser ? 'user' : 'model') }, [
      element('div', { class: 'turn-role', text: isUser ? 'You' : 'Gemini' }),
      // textContent, never innerHTML: the answer is untrusted model output and
      // must never be parsed as markup.
      element('div', { class: 'turn-text', text: turn.text }),
    ]);

    if (!isUser) {
      bubble.append(element('div', { class: 'turn-tools' }, [
        element('button', {
          class: 'turn-tool', text: 'Copy',
          onclick: (event) => copyText(turn.text, event.currentTarget),
        }),
        element('button', {
          class: 'turn-tool', text: 'Retry',
          onclick: () => retryFrom(turn),
        }),
      ]));
    }
    return bubble;
  });

  // The pending row is part of the transcript render, not a node appended
  // afterwards: renderTranscript uses replaceChildren, so anything appended
  // separately is wiped by the next render.
  if (pending) {
    nodes.push(element('div', { class: 'turn model pending' }, [
      element('div', { class: 'turn-role', text: 'Gemini' }),
      element('div', { class: 'turn-text', text: 'Thinking…' }),
    ]));
  }
  $('#turns').replaceChildren(...nodes);

  // Pin to the bottom: a chat that does not follow the newest message is
  // unusable while an answer is arriving.
  const scroll = $('#scroll');
  scroll.scrollTop = scroll.scrollHeight;
}

function copyText(text, button) {
  navigator.clipboard.writeText(text).then(
    () => flash(button, 'Copied'),
    () => flash(button, 'Copy failed'),
  );
}

function flash(button, message) {
  const original = button.textContent;
  button.textContent = message;
  setTimeout(() => { button.textContent = original; }, 1400);
}

/** Re-ask the question that produced this answer. */
function retryFrom(modelTurn) {
  const turns = activeChat?.turns || [];
  const index = turns.indexOf(modelTurn);
  for (let i = index - 1; i >= 0; i--) {
    if (turns[i].role === 'user') { send(turns[i].text); return; }
  }
}

/* ---- sending -------------------------------------------------------------- */

function setBusy(next) {
  busy = next;
  $('#send').disabled = busy;
  $('#stop').hidden = !busy;
  $('#foot').textContent = busy
    ? 'Waiting for Gemini…  Esc or Stop to cancel'
    : 'Enter to send · Shift+Enter for a new line';
}

async function send(text) {
  const prompt = String(text ?? $('#input').value).trim();
  if (!prompt || busy) return;
  $('#input').value = '';
  autoGrow();
  setBusy(true);

  // Show the question immediately; main stores it before calling Gemini, so a
  // failure still leaves it in the transcript.
  //
  // On a fresh page there is no active chat yet - main creates one. Stand up a
  // local placeholder so the question and the pending row are visible straight
  // away, rather than the empty state sitting there until the answer lands.
  if (!activeChat) activeChat = { id: null, title: prompt, pinned: false, turns: [] };
  activeChat.turns.push({ role: 'user', text: prompt, at: Date.now() });
  pending = true;
  renderTranscript();

  const result = await invoke('chat:send', { id: activeId, prompt, system: SYSTEM_PROMPT });
  pending = false;
  setBusy(false);

  if (result?.id && result.id !== activeId) activeId = result.id;
  await refresh();

  if (result && !result.ok) {
    $('#turns').append(element('div', { class: 'turn error' }, [
      element('div', { class: 'turn-role', text: 'Could not answer' }),
      element('div', { class: 'turn-text', text: result.error || 'Unknown error.' }),
    ]));
    $('#scroll').scrollTop = $('#scroll').scrollHeight;
  }
}

/* ---- data ----------------------------------------------------------------- */

async function refresh() {
  chats = (await invoke('chat:list')) || [];
  if (activeId) activeChat = await invoke('chat:get', { id: activeId });
  if (!activeChat) { activeId = null; activeChat = null; }
  renderChatList();
  renderTranscript();
}

async function openChat(id) {
  activeId = id;
  activeChat = await invoke('chat:get', { id });
  renderChatList();
  renderTranscript();
  $('#input').focus();
}

async function newChat() {
  const chat = await invoke('chat:new');
  if (chat?.id) await openChat(chat.id);
  await refresh();
  $('#input').focus();
}

/* ---- composer ------------------------------------------------------------- */

const input = $('#input');

/** Grow the textarea with its content, up to a cap. */
function autoGrow() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
}

input.addEventListener('input', autoGrow);

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send();
  } else if (event.key === 'Escape' && busy) {
    invoke('ai:cancel');
  }
});

$('#composer').addEventListener('submit', (event) => { event.preventDefault(); send(); });
$('#stop').addEventListener('click', () => invoke('ai:cancel'));
$('#new-chat').addEventListener('click', newChat);

$('#chat-search').addEventListener('input', (event) => {
  filter = event.target.value;
  renderChatList();
});

$('#toggle-sidebar').addEventListener('click', () => {
  sidebarHidden = !sidebarHidden;
  document.body.classList.toggle('sidebar-hidden', sidebarHidden);
});

$('#pin-chat').addEventListener('click', async () => {
  if (!activeId) return;
  await invoke('chat:pin', { id: activeId, pinned: !activeChat?.pinned });
  await refresh();
});

$('#rename-chat').addEventListener('click', async () => {
  if (!activeId) return;
  const title = prompt('Rename this chat', activeChat?.title || '');
  if (title === null) return;
  await invoke('chat:rename', { id: activeId, title });
  await refresh();
});

$('#delete-chat').addEventListener('click', async () => {
  if (!activeId) return;
  if (!confirm('Delete this chat?')) return;
  await invoke('chat:delete', { id: activeId });
  activeId = null;
  activeChat = null;
  await refresh();
});

$('#clear-chats').addEventListener('click', async () => {
  if (!confirm('Clear chat history? Pinned chats are kept.')) return;
  await invoke('chat:clear');
  activeId = null;
  activeChat = null;
  await refresh();
});

/* ---- init ----------------------------------------------------------------- */

$('#toggle-sidebar').append(icon('menu', { size: 16 }));
$('#send').append(icon('forward', { size: 16 }));
$('#empty-mark').append(icon('sparkle', { size: 30 }));

$('#suggestions').replaceChildren(...SUGGESTIONS.map((text) => element('button', {
  class: 'chat-suggestion',
  text,
  onclick: () => { input.value = text; autoGrow(); input.focus(); },
})));

// Theme variables arrive with app state; chat data is fetched separately.
onState(() => {});
window.browser.on('chat:changed', () => { refresh(); });

refresh().then(() => input.focus());

})();
