'use strict';

/**
 * Shared mode shell: sidebar, header and command bar.
 *
 * Every mode page calls `window.shell.mount(...)` and gets the same navigation
 * chrome, which is what makes the modes read as one product. A page supplies
 * only its own content; the shell owns everything around it.
 *
 * Loaded as a classic script, so the file is an IIFE publishing `window.shell`.
 */
(function () {

const { invoke, $, element, icon } = window.page;

let currentMode = null;
/** Live per-mode state for the sidebar badges and dashboard cards. */
let modeState = {};

/* ---- sidebar -------------------------------------------------------------- */

function buildSidebar() {
  const { MODES, GROUPS, orderedModes } = window.modes;

  const nav = element('nav', { class: 'shell-nav' });
  for (const group of GROUPS) {
    const inGroup = orderedModes().filter((mode) => mode.group === group.id);
    if (!inGroup.length) continue;
    nav.append(element('div', { class: 'shell-group-label', text: group.name }));
    for (const mode of inGroup) nav.append(navLink(mode));
  }

  return element('aside', { class: 'shell-sidebar' }, [
    element('div', { class: 'shell-brand' }, [icon('sparkle', { size: 16 }), 'static']),
    nav,
    element('div', { class: 'shell-sidebar-foot' }, [
      element('button', {
        class: 'shell-command-hint',
        onclick: () => openCommandBar(),
      }, [
        element('span', { text: 'Search and commands' }),
        element('kbd', { text: 'Ctrl K' }),
      ]),
    ]),
  ]);
}

function navLink(mode) {
  const badge = modeState[mode.id]?.badge;
  return element('button', {
    class: 'shell-link' + (mode.id === currentMode ? ' active' : ''),
    'data-mode': mode.id,
    onclick: () => invoke('tabs:navigate', { input: mode.page }),
  }, [
    icon(mode.icon, { size: 15 }),
    element('div', { class: 'shell-link-text' }, [
      element('div', { class: 'shell-link-name', text: mode.name }),
    ]),
    badge
      ? element('span', {
          class: 'shell-badge' + (modeState[mode.id]?.active ? ' on' : ''),
          text: badge,
        })
      : null,
  ]);
}

/** Refresh just the badges, without rebuilding the whole sidebar. */
function refreshBadges() {
  for (const link of document.querySelectorAll('.shell-link')) {
    const id = link.dataset.mode;
    const state = modeState[id] || {};
    const existing = link.querySelector('.shell-badge');
    if (!state.badge) { existing?.remove(); continue; }
    if (existing) {
      existing.textContent = state.badge;
      existing.classList.toggle('on', !!state.active);
    } else {
      link.append(element('span', {
        class: 'shell-badge' + (state.active ? ' on' : ''),
        text: state.badge,
      }));
    }
  }
}

/* ---- command bar ---------------------------------------------------------- */

let commandOpen = false;
let commandItems = [];
let commandIndex = 0;

/**
 * Actions the command bar can run beyond navigation. Each mode can contribute
 * more through `mount({ commands })`.
 */
let extraCommands = [];

function baseCommands() {
  const navigation = window.modes.orderedModes().map((mode) => ({
    kind: 'Mode',
    label: mode.name,
    hint: mode.tagline,
    icon: mode.icon,
    run: () => invoke('tabs:navigate', { input: mode.page }),
  }));
  const actions = [
    { kind: 'Action', label: 'New tab', icon: 'plus', run: () => invoke('ui:action', { action: 'tab:new' }) },
    { kind: 'Action', label: 'Settings', icon: 'gear', run: () => invoke('tabs:navigate', { input: 'browser://settings' }) },
    { kind: 'Action', label: 'History', icon: 'clock', run: () => invoke('tabs:navigate', { input: 'browser://history' }) },
    { kind: 'Action', label: 'Downloads', icon: 'download', run: () => invoke('tabs:navigate', { input: 'browser://downloads' }) },
    { kind: 'Action', label: 'Bookmarks', icon: 'bookmark', run: () => invoke('tabs:navigate', { input: 'browser://bookmarks' }) },
  ];
  return [...navigation, ...actions, ...extraCommands];
}

function openCommandBar() {
  if (commandOpen) return;
  commandOpen = true;

  const input = element('input', {
    class: 'command-input',
    type: 'text',
    placeholder: 'Search modes, actions and tabs…',
    spellcheck: 'false',
  });
  const results = element('div', { class: 'command-results' });
  const panel = element('div', { class: 'command-panel' }, [input, results]);
  const backdrop = element('div', { class: 'command-backdrop' }, [panel]);

  const close = () => {
    commandOpen = false;
    backdrop.remove();
  };

  const render = async (query) => {
    const q = query.trim().toLowerCase();
    let items = baseCommands();

    // Open tabs and recent history become searchable once there is a query -
    // showing every tab on an empty command bar would bury the modes.
    if (q) {
      const [tabs, historyRows] = await Promise.all([
        invoke('tabs:list').catch(() => []),
        invoke('history:search', { query: q, limit: 6 }).catch(() => []),
      ]);
      for (const tab of tabs || []) {
        items.push({
          kind: 'Tab', label: tab.title || tab.url, hint: tab.url, icon: 'search',
          run: () => invoke('tabs:select', { id: tab.id }),
        });
      }
      for (const row of historyRows || []) {
        items.push({
          kind: 'History', label: row.title || row.url, hint: row.url, icon: 'clock',
          run: () => invoke('tabs:navigate', { input: row.url }),
        });
      }
      items = items.filter((item) =>
        (item.label + ' ' + (item.hint || '')).toLowerCase().includes(q));
    }

    commandItems = items.slice(0, 40);
    commandIndex = 0;
    paint();
  };

  const paint = () => {
    if (!commandItems.length) {
      results.replaceChildren(element('div', { class: 'command-empty', text: 'Nothing matches.' }));
      return;
    }
    results.replaceChildren(...commandItems.map((item, index) => element('button', {
      class: 'command-item' + (index === commandIndex ? ' selected' : ''),
      onclick: () => { close(); item.run(); },
    }, [
      icon(item.icon || 'search', { size: 15 }),
      element('div', { class: 'command-item-text' }, [
        element('div', { class: 'command-item-label', text: item.label }),
        item.hint ? element('div', { class: 'command-item-hint', text: item.hint }) : null,
      ]),
      element('span', { class: 'command-kind', text: item.kind }),
    ])));
  };

  input.addEventListener('input', () => render(input.value));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      commandIndex = (commandIndex + 1) % Math.max(1, commandItems.length);
      paint();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      commandIndex = (commandIndex - 1 + commandItems.length) % Math.max(1, commandItems.length);
      paint();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = commandItems[commandIndex];
      if (item) { close(); item.run(); }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });

  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close();
  });

  document.body.append(backdrop);
  input.focus();
  render('');
}

/* ---- mount ---------------------------------------------------------------- */

/**
 * Build the shell around a page's content.
 *
 * @param {object}      options
 * @param {string}      options.mode      mode id, for highlighting the sidebar
 * @param {string}      options.title
 * @param {string}      [options.subtitle]
 * @param {HTMLElement} options.content   the page's own body
 * @param {Array}       [options.actions] header buttons
 * @param {Array}       [options.commands] extra command-bar entries
 * @returns {{ content: HTMLElement, setState: Function }}
 */
function mount({ mode, title, subtitle, content, actions = [], commands = [] }) {
  currentMode = mode;
  extraCommands = commands;
  document.body.classList.add('shell');

  const header = element('header', { class: 'shell-header' }, [
    element('button', {
      class: 'shell-toggle',
      title: 'Toggle sidebar',
      onclick: () => document.body.classList.toggle('sidebar-collapsed'),
    }, [icon('menu', { size: 16 })]),
    element('h1', { class: 'shell-title', text: title }),
    subtitle ? element('span', { class: 'shell-subtitle', text: subtitle }) : null,
    element('div', { class: 'shell-header-spacer' }),
    ...actions,
  ]);

  const main = element('div', { class: 'shell-main' }, [
    header,
    element('div', { class: 'shell-content' }, [
      element('div', { class: 'shell-inner' }, [content]),
    ]),
  ]);

  document.body.replaceChildren(buildSidebar(), main);

  // Ctrl/Cmd+K anywhere in a mode page.
  document.addEventListener('keydown', (event) => {
    const mod = window.page.platform === 'darwin' ? event.metaKey : event.ctrlKey;
    if (mod && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openCommandBar();
    }
  });

  return {
    content,
    /** Update sidebar badges from live mode state. */
    setState(next) {
      modeState = next || {};
      refreshBadges();
    },
  };
}

window.shell = { mount, openCommandBar };

})();
