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

let state = { count: 0, encryption: {}, unreadable: 0 };
let entries = [];
let query = '';
/** id of the one entry currently revealed, if any. */
let revealed = null;
let revealedValue = '';
let shellApi = null;

const content = element('div');

/* ---- encryption status ----------------------------------------------------- */

function statusCard() {
  const encryption = state.encryption || {};
  const backendName = {
    dpapi: 'Windows data protection',
    keychain: 'macOS Keychain',
    gnome_libsecret: 'GNOME Keyring',
    kwallet: 'KWallet', kwallet5: 'KWallet', kwallet6: 'KWallet',
  }[encryption.backend] || encryption.backend || 'unknown';

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
      stat(backendName, 'encrypted by'),
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

/* ---- vault ------------------------------------------------------------------ */

function vaultCard() {
  const search = element('input', {
    class: 'notes-search',
    type: 'search',
    placeholder: 'Search saved logins',
    value: query,
    autocomplete: 'off',
  });
  search.addEventListener('input', () => { query = search.value; refresh(); });

  return element('div', { class: 'panel-card' }, [
    element('div', { class: 'notes-toolbar' }, [
      search,
      entries.length
        ? element('button', {
            class: 'pill', text: 'Remove all',
            onclick: async () => {
              if (!confirm('Delete every saved login? This cannot be undone.')) return;
              await invoke('passwords:clear');
              refresh();
            },
          })
        : null,
    ].filter(Boolean)),

    entries.length
      ? element('div', { class: 'blocked-list' }, entries.map(entryRow))
      : element('p', {
          class: 'muted',
          text: query
            ? 'Nothing matches that.'
            : 'No saved logins yet. Passwords you save while signing in will appear here.',
        }),
  ]);
}

function entryRow(entry) {
  const isRevealed = revealed === entry.id;

  return element('div', { class: 'password-row' }, [
    element('div', { class: 'password-main' }, [
      element('div', { class: 'password-origin', text: entry.origin.replace(/^https?:\/\//, '') }),
      element('div', { class: 'password-user' }, [
        element('span', { text: entry.username || '(no username)' }),
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
    element('p', {
      class: 'muted limits-note',
      text: 'It does not defend against malware already running as you — that can ask '
        + 'the same system to decrypt, exactly as this browser does. No local password '
        + 'manager can prevent that, including the ones in Chrome and Brave. There is '
        + 'also no sync: these logins exist only on this device.',
    }),
  ]);
}

/* ---- render ----------------------------------------------------------------- */

function render() {
  content.replaceChildren(...[
    statusCard(),
    state.encryption?.available ? generatorCard() : null,
    vaultCard(),
    limitsCard(),
    // Health, import/export and autofill: drawn by passwords-extra.js, kept
    // across re-renders so an open form is not lost.
    window.passwordExtras?.host,
  ].filter(Boolean));
}

shellApi = window.shell.mount({
  mode: 'passwords',
  title: 'Passwords',
  subtitle: 'Saved logins, encrypted by your OS',
  content,
});

async function refresh() {
  state = (await invoke('passwords:state')) || state;
  entries = (await invoke('passwords:list', { query })) || [];
  render();
}

onState((next) => { if (next?.modes) shellApi?.setState(next.modes); });

refresh();

})();
