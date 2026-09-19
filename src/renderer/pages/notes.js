'use strict';

/**
 * browser://notes - captured text, links, screenshots and AI summaries.
 */
(function () {

const { invoke, onState, element, icon, timeAgo, openUrl } = window.page;

let notes = [];
let meta = { workspaces: [], tags: [], activeWorkspace: 'default' };
let query = '';
let activeTag = null;
let shellApi = null;

const content = element('div');

/* ---- toolbar -------------------------------------------------------------- */

function toolbar() {
  const search = element('input', {
    class: 'notes-search',
    type: 'search',
    placeholder: 'Search notes',
    value: query,
    autocomplete: 'off',
  });
  search.addEventListener('input', () => { query = search.value; refresh(); });

  const workspaceRow = element('div', { class: 'pill-row' }, [
    ...meta.workspaces.map((workspace) => element('button', {
      class: 'pill' + (workspace.id === meta.activeWorkspace ? ' selected' : ''),
      text: workspace.name,
      onclick: async () => {
        await invoke('notes:workspace-select', { id: workspace.id });
        refresh();
      },
    })),
    element('button', {
      class: 'pill', text: '+ Workspace',
      onclick: async () => {
        const name = prompt('Name this workspace');
        if (!name) return;
        await invoke('notes:workspace-add', { name });
        refresh();
      },
    }),
  ]);

  const tagRow = meta.tags.length
    ? element('div', { class: 'pill-row' }, [
        element('button', {
          class: 'pill' + (activeTag ? '' : ' selected'),
          text: 'All',
          onclick: () => { activeTag = null; refresh(); },
        }),
        ...meta.tags.slice(0, 20).map(({ tag, count }) => element('button', {
          class: 'pill' + (tag === activeTag ? ' selected' : ''),
          text: `${tag} ${count}`,
          onclick: () => { activeTag = tag === activeTag ? null : tag; refresh(); },
        })),
      ])
    : null;

  return element('div', { class: 'panel-card' }, [
    element('div', { class: 'notes-toolbar' }, [
      search,
      element('button', {
        class: 'pill', text: 'Save this page',
        onclick: async () => { await invoke('notes:capture', {}); refresh(); },
      }),
      element('button', {
        class: 'pill', text: 'Screenshot',
        onclick: async () => { await invoke('notes:screenshot', {}); refresh(); },
      }),
      element('button', {
        class: 'pill', text: 'Export',
        onclick: exportNotes,
      }),
    ]),
    workspaceRow,
    tagRow,
  ].filter(Boolean));
}

async function exportNotes() {
  const text = await invoke('notes:export', {
    format: 'markdown', workspace: meta.activeWorkspace,
  });
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    flashNotice('Notes copied as Markdown');
  } catch {
    flashNotice('Could not copy to the clipboard');
  }
}

let noticeTimer = null;
function flashNotice(message) {
  const node = document.querySelector('.notes-notice');
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { node.hidden = true; }, 2400);
}

/* ---- note cards ----------------------------------------------------------- */

function noteCard(note) {
  const tools = element('div', { class: 'note-tools' }, [
    element('button', {
      class: 'turn-tool', text: note.pinned ? 'Unpin' : 'Pin',
      onclick: async () => { await invoke('notes:update', { id: note.id, pinned: !note.pinned }); refresh(); },
    }),
    element('button', {
      class: 'turn-tool', text: 'Copy',
      onclick: () => navigator.clipboard.writeText(note.body || note.url || '')
        .then(() => flashNotice('Copied'), () => flashNotice('Copy failed')),
    }),
    note.body
      ? element('button', {
          class: 'turn-tool', text: 'Summarise',
          onclick: async (event) => {
            event.currentTarget.textContent = 'Working…';
            const result = await invoke('notes:summarise', { id: note.id });
            flashNotice(result?.ok ? 'Summary added' : (result?.error || 'Could not summarise'));
            refresh();
          },
        })
      : null,
    element('button', {
      class: 'turn-tool danger', text: 'Delete',
      onclick: async () => { await invoke('notes:remove', { id: note.id }); refresh(); },
    }),
  ].filter(Boolean));

  const card = element('article', { class: 'note-card' + (note.pinned ? ' pinned' : '') }, [
    element('div', { class: 'note-head' }, [
      icon(kindIcon(note.kind), { size: 14 }),
      element('div', { class: 'note-title', text: note.title }),
      element('div', { class: 'note-time', text: timeAgo(note.createdAt) }),
    ]),
    note.body ? element('div', { class: 'note-body', text: note.body }) : null,
    note.image ? noteImage(note) : null,
    note.comment ? element('div', { class: 'note-comment', text: note.comment }) : null,
    note.url
      ? element('button', {
          class: 'note-source',
          text: note.url,
          onclick: (event) => openUrl(note.url, event),
        })
      : null,
    note.tags.length
      ? element('div', { class: 'note-tags' }, note.tags.map((tag) =>
          element('span', { class: 'note-tag', text: tag })))
      : null,
    tools,
  ].filter(Boolean));

  return card;
}

/**
 * Screenshots live on disk, and this page cannot read files. The note records
 * the filename so a future viewer can load it; for now the card shows that a
 * screenshot exists rather than pretending to render it.
 */
function noteImage(note) {
  return element('div', { class: 'note-image-placeholder' }, [
    icon('grid', { size: 14 }),
    element('span', { text: ' Screenshot saved' }),
  ]);
}

function kindIcon(kind) {
  return { text: 'bookmark', link: 'forward', screenshot: 'grid', summary: 'sparkle' }[kind] || 'bookmark';
}

/* ---- render --------------------------------------------------------------- */

function render() {
  const notice = element('div', { class: 'notes-notice', hidden: 'true' });
  content.replaceChildren(
    notice,
    toolbar(),
    notes.length
      ? element('div', { class: 'note-list' }, notes.map(noteCard))
      : element('div', { class: 'panel-card' }, [
          element('p', {
            class: 'muted',
            text: query || activeTag
              ? 'Nothing matches that.'
              : 'Nothing saved yet. Select text on any page and press Ctrl+Shift+S, or use "Save this page" above.',
          }),
        ]),
  );
}

shellApi = window.shell.mount({
  mode: 'notes',
  title: 'Notes',
  subtitle: 'Capture anything from any page',
  content,
});

async function refresh() {
  meta = (await invoke('notes:state')) || meta;
  notes = (await invoke('notes:list', {
    query, tag: activeTag, workspace: meta.activeWorkspace,
  })) || [];
  render();
}

onState((next) => { if (next?.modes) shellApi?.setState(next.modes); });
window.browser.on('notes:changed', refresh);

refresh();

})();
