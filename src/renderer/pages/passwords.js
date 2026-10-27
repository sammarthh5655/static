'use strict';

/**
 * browser://passwords - the saved-login vault.
 *
 * Passwords are never in this page's memory unless the user explicitly asks
 * to see one: the listing carries only origins and usernames, and a single
 * plaintext crosses IPC at a time through `passwords:reveal`.
 */
(function () {

const { invoke, onState, element, icon, timeAgo } = window.page;
const security = window.passwordSecurity;

// `encryption.available` is undefined until main answers. That is not the
// same as "unavailable", which would wrongly say passwords cannot be saved
// on the first paint, so the page treats it as "assume fine, correct in a
// moment" (see render).
let state = { count: 0, encryption: {}, unreadable: 0, loaded: false };
let entries = [];
let query = '';
/** id of the one entry currently revealed, if any. */
let revealed = null;
let revealedValue = '';
let shellApi = null;

const content = element('div');

/* ---- encryption status ----------------------------------------------------- */

/** Which part of the operating system holds the key. */
function backendLabel() {
  const encryption = state.encryption || {};
  return {
    dpapi: 'Windows data protection',
    keychain: 'macOS Keychain',
    gnome_libsecret: 'GNOME Keyring',
    kwallet: 'KWallet', kwallet5: 'KWallet', kwallet6: 'KWallet',
  }[encryption.backend] || encryption.backend || 'unknown';
}

function statusCard() {
  const encryption = state.encryption || {};

  if (!encryption.available) {
    return element('div', { class: 'panel-card warning-panel' }, [
      element('div', { class: 'panel-card-head' }, [
        icon('warn', { size: 15 }),
        element('span', { class: 'panel-card-title', text: 'Passwords cannot be saved' }),
      ]),
      element('p', {
        class: 'muted',
        text: encryption.reason
          || 'This system did not offer an encryption key, so nothing will be stored.',
      }),
      element('p', {
        class: 'muted limits-note',
        text: 'Storing passwords without encryption would be worse than not storing them, '
          + 'so saving is disabled rather than falling back to plain text.',
      }),
    ]);
  }

  return element('div', { class: 'panel-card' }, [
    element('div', { class: 'stat-grid' }, [
      stat(String(state.count), 'saved logins'),
      stat(String(state.passkeys || 0), 'passkeys'),
      stat(state.hasMaster ? 'On' : 'Off', 'master password'),
      stat(state.unreadable ? String(state.unreadable) : '0', 'unreadable'),
    ]),
    state.unreadable
      ? element('p', {
          class: 'muted limits-note',
          text: state.unreadable + ' entr' + (state.unreadable === 1 ? 'y' : 'ies')
            + ' cannot be decrypted. They were saved by a different user account or '
            + 'on another machine, and cannot be recovered here.',
        })
      : null,
  ].filter(Boolean));
}

function stat(value, label) {
  return element('div', { class: 'stat' }, [
    element('div', { class: 'stat-value', text: value }),
    element('div', { class: 'stat-label', text: label }),
  ]);
}

/* ---- generator -------------------------------------------------------------- */

const generated = element('div', { class: 'generated-value', text: '' });

function generatorCard() {
  return element('div', { class: 'panel-card' }, [
    element('div', { class: 'panel-card-head' }, [
      icon('sparkle', { size: 15 }),
      element('span', { class: 'panel-card-title', text: 'Generate a password' }),
      element('button', {
        class: 'pill selected', text: 'Generate',
        onclick: async () => {
          const result = await invoke('passwords:generate', { length: 20, symbols: true });
          generated.textContent = result?.password || '';
        },
      }),
      element('button', {
        class: 'pill', text: 'Copy',
        onclick: (event) => {
          if (!generated.textContent) return;
          const button = event.currentTarget;
          navigator.clipboard.writeText(generated.textContent).then(
            () => { button.textContent = 'Copied'; },
            () => { button.textContent = 'Copy failed'; },
          );
          setTimeout(() => { button.textContent = 'Copy'; }, 1400);
        },
      }),
    ]),
    generated,
    element('p', {
      class: 'muted',
      text: '20 characters from a cryptographic random source, with the easily '
        + 'confused ones (l, I, O, 0, 1) left out.',
    }),
  ]);
}

/* ---- adding and editing -------------------------------------------------------- */

/**
 * The add / edit form. Built once per opening and kept across re-renders, so
 * nothing typed into it is lost when the list refreshes underneath.
 */
let editor = null;

const errorText = (error) => String(error?.message || error || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function openEditor(values = {}, id = null) {
  const field = (label, control, extra) => element('label', { class: 'pw-field' + (extra ? ' ' + extra : '') }, [element('span', { text: label }), control]);
  const url = element('input', { type: 'text', placeholder: 'github.com', autocomplete: 'off', spellcheck: 'false', value: values.url ? values.url.replace(/^https:\/\//, '') : '' });
  const username = element('input', { type: 'text', placeholder: 'you@example.com', autocomplete: 'off', spellcheck: 'false', value: values.username || '' });
  const password = element('input', { type: 'password', placeholder: id ? 'Leave empty to keep the current one' : '', autocomplete: 'new-password', value: values.password || '' });
  const note = element('textarea', { rows: '3', placeholder: 'Security questions, recovery codes, PINs… (optional, encrypted like the password)' });
  note.value = values.note || '';
  const eye = element('button', { type: 'button', class: 'pv-eye', text: 'Show' });
  const setShown = (show) => { password.type = show ? 'text' : 'password'; eye.textContent = show ? 'Hide' : 'Show'; };
  eye.addEventListener('click', () => setShown(password.type === 'password'));
  const generate = element('button', { type: 'button', class: 'pill', text: 'Generate' });
  generate.addEventListener('click', async () => {
    const result = await invoke('passwords:generate', { length: 20, symbols: true });
    if (result?.password) { password.value = result.password; setShown(true); }
  });
  const error = element('p', { class: 'pw-error', role: 'alert' });
  const save = element('button', { type: 'submit', class: 'pill selected', text: id ? 'Save changes' : 'Save password' });
  const cancel = element('button', { type: 'button', class: 'pill', text: 'Cancel', onclick: () => { editor = null; render(); } });
  const form = element('form', { class: 'pv-editor' }, [
    element('div', { class: 'pv-editor-head' }, [
      element('span', { class: 'pv-editor-glyph' }, [icon('key', { size: 16 })]),
      element('strong', { text: id ? 'Edit login' : 'Add a password' }),
      element('span', { class: 'muted', text: id ? 'Change what you need; the rest stays as it is.' : 'For a site you signed up to somewhere else, or to keep a password safe here.' }),
    ]),
    element('div', { class: 'pv-editor-grid' }, [
      field('Website', url),
      field('Username or email', username),
      field('Password', element('div', { class: 'pv-password' }, [password, eye, generate]), 'wide'),
      field('Note', note, 'wide'),
    ]),
    error,
    element('div', { class: 'pw-row' }, [save, cancel]),
  ]);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    if (!url.value.trim()) { error.textContent = 'Enter the website.'; url.focus(); return; }
    if (!id && !password.value) { error.textContent = 'Enter the password.'; password.focus(); return; }
    save.disabled = true;
    const payload = { url: url.value.trim(), username: username.value.trim(), note: note.value };
    if (password.value) payload.password = password.value;
    const result = await invoke(id ? 'passwords:update' : 'passwords:add', id ? { id, ...payload } : payload)
      .catch((e) => ({ ok: false, error: errorText(e) }));
    save.disabled = false;
    if (!result?.ok) { error.textContent = result?.error || 'That did not work.'; return; }
    editor = null;
    revealed = null;
    revealedValue = '';
    refresh();
  });
  editor = { node: form, id };
  render();
  setTimeout(() => (values.url ? username : url).focus(), 30);
}

async function editEntry(entry) {
  const details = await invoke('passwords:details', { id: entry.id }).catch((e) => ({ ok: false, error: errorText(e) }));
  if (!details?.ok) { alert(details?.error || 'That login could not be opened.'); return; }
  openEditor(details, entry.id);
}

/* ---- vault ------------------------------------------------------------------ */

// Kept across re-renders so typing in it never loses focus.
const search = element('input', {
  class: 'notes-search',
  type: 'search',
  placeholder: 'Search saved logins',
  autocomplete: 'off',
});
search.addEventListener('input', () => { query = search.value; refresh(); });

function vaultCard() {
  return element('div', { class: 'panel-card' }, [
    element('div', { class: 'notes-toolbar' }, [
      search,
      element('button', {
        class: 'pill selected pv-add', text: '+ Add password',
        onclick: () => openEditor({}),
      }),
      entries.length
        ? element('button', {
            class: 'pill', text: 'Remove all',
            onclick: async () => {
              if (!confirm('Delete every saved login and passkey? This cannot be undone.')) return;
              await invoke('passwords:clear');
              refresh();
            },
          })
        : null,
    ].filter(Boolean)),

    editor && !editor.id ? editor.node : null,

    entries.length
      ? element('div', { class: 'blocked-list' }, entries.map((entry) => (editor && editor.id === entry.id ? editor.node : entryRow(entry))))
      : element('p', {
          class: 'muted',
          text: query
            ? 'Nothing matches that.'
            : 'No saved logins yet. Passwords you save while signing in appear here, or add one with "+ Add password".',
        }),
  ].filter(Boolean));
}

function entryRow(entry) {
  const isRevealed = revealed === entry.id;

  return element('div', { class: 'password-row' }, [
    element('div', { class: 'password-main' }, [
      element('div', { class: 'password-origin', text: entry.origin.replace(/^https?:\/\//, '') }),
      element('div', { class: 'password-user' }, [
        element('span', { text: entry.username || '(no username)' }),
        entry.hasNote ? element('span', { class: 'pv-note-tag', text: 'note' }) : null,
        entry.lastUsed
          ? element('span', { class: 'muted', text: '  ·  used ' + timeAgo(entry.lastUsed) })
          : null,
      ].filter(Boolean)),
      isRevealed
        ? element('div', { class: 'password-plain', text: revealedValue })
        : null,
      !entry.readable
        ? element('div', { class: 'password-error', text: 'Cannot be decrypted on this machine' })
        : null,
    ].filter(Boolean)),

    entry.readable
      ? element('button', {
          class: 'turn-tool',
          text: isRevealed ? 'Hide' : 'Show',
          onclick: async () => {
            if (isRevealed) { revealed = null; revealedValue = ''; render(); return; }
            const result = await invoke('passwords:reveal', { id: entry.id });
            if (result?.ok) { revealed = entry.id; revealedValue = result.password; }
            else { revealed = null; revealedValue = result?.error || 'Could not decrypt.'; }
            render();
          },
        })
      : null,
    entry.readable
      ? element('button', {
          class: 'turn-tool', text: 'Copy',
          onclick: async (event) => {
            const button = event.currentTarget;
            const result = await invoke('passwords:reveal', { id: entry.id });
            if (result?.ok) {
              try { await navigator.clipboard.writeText(result.password); button.textContent = 'Copied'; }
              catch { button.textContent = 'Copy failed'; }
            } else {
              button.textContent = 'Failed';
            }
            setTimeout(() => { button.textContent = 'Copy'; }, 1500);
          },
        })
      : null,
    entry.readable
      ? element('button', { class: 'turn-tool', text: 'Edit', onclick: () => editEntry(entry) })
      : null,
    element('button', {
      class: 'turn-tool danger', text: 'Delete',
      onclick: async () => {
        if (!confirm('Delete the login for ' + entry.origin + '?')) return;
        await invoke('passwords:remove', { id: entry.id });
        if (revealed === entry.id) { revealed = null; revealedValue = ''; }
        refresh();
      },
    }),
  ].filter(Boolean));
}

/* ---- honesty ---------------------------------------------------------------- */

function limitsCard() {
  return element('div', { class: 'panel-card' }, [
    element('div', { class: 'panel-card-head' }, [
      icon('lock', { size: 15 }),
      element('span', { class: 'panel-card-title', text: 'What this protects against' }),
    ]),
    element('p', {
      class: 'muted',
      text: 'Passwords are encrypted with a key held by your operating system and tied '
        + 'to your user account. If the vault file is copied to another machine it is '
        + 'unreadable.',
    }),
    element('p', { class: 'muted', text: 'Encrypted by ' + backendLabel() + (state.hasMaster ? ' and your master password.' : '.') }),
    element('p', {
      class: 'muted limits-note',
      text: state.hasMaster
        ? 'With a master password, a locked vault cannot be read even by software running '
          + 'as you - it needs your master password or your ' + (security.state.device?.label || 'device unlock') + '. '
          + 'While it is unlocked, it is as open as any running password manager. There is '
          + 'no sync: these logins and passkeys exist only on this device.'
        : 'Without a master password it does not defend against malware already running as '
          + 'you - that can ask the same system to decrypt, exactly as this browser does. '
          + 'Set a master password above to close that gap. There is no sync: these logins '
          + 'and passkeys exist only on this device.',
    }),
  ]);
}

/* ---- render ----------------------------------------------------------------- */

let lockNode = null;

/**
 * Three tabs instead of one long scroll:
 *   - Passwords: the vault list, add, and the generator;
 *   - Checkup:   password health and the leak check;
 *   - Settings:  the master password and recovery, passkeys, how sign-in
 *                works, import and export, and the never-save lists.
 * The choice is remembered for the visit only.
 */
const TABS = [
  ['vault', 'Passwords', 'key'],
  ['checkup', 'Checkup', 'shield'],
  ['settings', 'Settings', 'gear'],
];
let tab = 'vault';
try { const saved = sessionStorage.getItem('pw-tab'); if (saved && TABS.some(([id]) => id === saved)) tab = saved; } catch { /* storage off */ }

function tabBar() {
  return element('div', { class: 'pw-tabs', role: 'tablist', 'aria-label': 'Passwords' }, TABS.map(([id, label, glyph]) => {
    const button = element('button', {
      type: 'button', role: 'tab', class: 'pw-tab' + (id === tab ? ' is-active' : ''), 'aria-selected': String(id === tab),
    }, [icon(glyph, { size: 15 }), element('span', { text: label })]);
    button.addEventListener('click', () => {
      if (tab === id) return;
      tab = id;
      try { sessionStorage.setItem('pw-tab', id); } catch { /* storage off */ }
      render();
    });
    return button;
  }));
}

function render() {
  // Locked: only the lock screen. Kept across refreshes so a half-typed
  // master password is not wiped by an unrelated change.
  if (security.state.locked) {
    if (!lockNode || !content.contains(lockNode)) {
      lockNode = security.lockScreen(state, () => { lockNode = null; refresh(); });
      content.replaceChildren(lockNode);
    }
    return;
  }
  lockNode = null;
  // Moving a focused box to a new card drops its focus; put it back, caret and all.
  const active = content.contains(document.activeElement) ? document.activeElement : null;
  const caret = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;

  // Before main has answered, assume encryption is fine: saying it is not
  // would be a false alarm, and it is corrected a moment later either way.
  const available = state.loaded ? state.encryption?.available : true;
  let cards;
  if (!available) {
    // No encryption: just the plain explanation, no tabs to offer.
    cards = [statusCard(), limitsCard()];
  } else if (tab === 'checkup') {
    const checkup = window.passwordExtras?.checkupCard();
    cards = [checkup || element('div', { class: 'panel-card' }, [element('p', { class: 'muted', text: 'Password health will show here once there are saved logins to check.' })])];
  } else if (tab === 'settings') {
    cards = [
      security.securityCard(render),
      security.passkeysCard(render),
      ...(window.passwordExtras?.settingsCards() || []),
      limitsCard(),
    ];
  } else {
    cards = [statusCard(), vaultCard(), generatorCard()];
  }

  content.replaceChildren(...[
    available ? tabBar() : null,
    ...cards,
    // The extras host stays in the tree (hidden when not on a tab that uses
    // it) so an open form there is never lost to a refresh.
    window.passwordExtras?.host,
  ].filter(Boolean));
  // The host is only the mounting point now; its own cards are placed above.
  if (window.passwordExtras?.host) window.passwordExtras.host.hidden = true;

  if (active && active.isConnected && document.activeElement !== active) {
    active.focus({ preventScroll: true });
    if (caret) try { active.setSelectionRange(caret[0], caret[1]); } catch { /* not a text box */ }
  }
}

shellApi = window.shell.mount({
  mode: 'passwords',
  title: 'Passwords',
  subtitle: 'Saved logins, encrypted by your OS',
  content,
});

// Draw the tabs and empty cards straight away. refresh() fills them in a
// moment; without this the panel is blank until every IPC call has answered,
// which on a cold start is long enough to look broken.
render();

async function refresh() {
  try {
    await load();
  } catch (error) {
    // A failed load must not leave the page blank for good: draw what is
    // known, with the reason, rather than an empty panel.
    console.error('passwords: could not load', error);
    content.replaceChildren(element('div', { class: 'panel-card' }, [
      element('p', { class: 'muted', text: 'Passwords could not be loaded: ' + String(error?.message || error) }),
    ]));
  }
}

async function load() {
  state = { ...((await invoke('passwords:state')) || state), loaded: true };
  await security.load();
  entries = security.state.locked ? [] : (await invoke('passwords:list', { query })) || [];
  // Checkup and Settings read the extras module's data, so keep it current -
  // loadData fetches without drawing, so this does not loop back here.
  if (!security.state.locked) await window.passwordExtras?.loadData();
  render();
}

onState((next) => { if (next?.modes) shellApi?.setState(next.modes); });
window.browser.on('passwords:changed', async () => {
  const wasLocked = security.state.locked;
  const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) && content.contains(document.activeElement);
  await security.load();
  // Locking or unlocking always redraws; anything else waits for the person
  // to finish typing.
  if (typing && wasLocked === security.state.locked) return;
  refresh();
});

// `redraw` repaints from the data already loaded (a toggle, a finished leak
// check); `refresh` refetches first. The extras module uses `redraw` so it
// never loops back through a fetch.
window.passwordPage = { refresh, redraw: render };

// browser://passwords#add=https%3A%2F%2Fgithub.com - from the key in the address bar.
function addFromLink() {
  const add = /^#add=(.+)$/.exec(location.hash);
  if (!add || security.state.locked) return;
  let site = '';
  try { site = decodeURIComponent(add[1]); } catch { /* ignore a bad link */ }
  if (/^https?:\/\//.test(site)) openEditor({ url: site });
}
window.addEventListener('hashchange', addFromLink);
refresh().then(addFromLink);

})();
