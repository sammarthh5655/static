'use strict';

/**
 * browser://focus - focus sessions and site blocking.
 *
 * This page has two faces. Normally it is the focus control panel. When a
 * blocked navigation is redirected here (`?blocked=<url>`), it leads with the
 * block notice instead, because someone who just hit a wall needs to be told
 * why before anything else.
 */
(function () {

const { invoke, onState, element, icon } = window.page;

let state = { config: {}, catalog: [], presets: [], stats: {} };
let shellApi = null;
let ticker = null;

/** The URL that was blocked, when this page was reached by a redirect. */
const blockedUrl = new URLSearchParams(location.search.replace(/^\?/, '')).get('blocked');

const content = element('div');

/* ---- block notice --------------------------------------------------------- */

function blockNotice() {
  if (!blockedUrl) return null;
  let host = blockedUrl;
  try { host = new URL(blockedUrl).hostname.replace(/^www\./, ''); } catch { /* keep raw */ }

  return element('div', { class: 'panel-card block-notice' }, [
    element('div', { class: 'block-mark' }, [icon('clock', { size: 26 })]),
    element('h2', { class: 'block-title', text: host + ' is blocked right now' }),
    element('p', {
      class: 'block-body',
      text: 'You started a focus session, so this site is paused until it ends. '
        + 'That was the point - it is still here afterwards.',
    }),
    element('div', { class: 'pill-row block-actions' }, [
      element('button', {
        class: 'pill', text: 'Go back',
        onclick: () => invoke('navigation:back'),
      }),
      element('button', {
        class: 'pill', text: 'Open the new tab page',
        onclick: () => invoke('tabs:navigate', { input: 'browser://newtab' }),
      }),
    ]),
  ]);
}

/* ---- timer ---------------------------------------------------------------- */

function timerCard() {
  if (state.active) {
    const minutes = Math.floor(state.remainingMs / 60000);
    const seconds = Math.floor((state.remainingMs % 60000) / 1000);
    const preset = state.presets.find((p) => p.id === state.session?.preset);

    return element('div', { class: 'panel-card timer-card' }, [
      element('div', { class: 'timer-value', text: `${minutes}:${String(seconds).padStart(2, '0')}` }),
      element('div', {
        class: 'timer-label',
        text: (preset?.name || 'Focus') + ' session · '
          + (state.session?.blocked || 0) + ' blocked',
      }),
      element('div', { class: 'pill-row timer-actions' }, [
        element('button', {
          class: 'pill', text: 'End session',
          onclick: () => invoke('focus:stop'),
        }),
        unlockButton(),
      ]),
    ]);
  }

  return element('div', { class: 'panel-card' }, [
    element('div', { class: 'panel-card-head' }, [
      icon('clock', { size: 15 }),
      element('span', { class: 'panel-card-title', text: 'Start a session' }),
    ]),
    element('div', { class: 'pill-row' }, state.presets.map((preset) =>
      element('button', {
        class: 'pill' + (preset.id === state.config.preset ? ' selected' : ''),
        text: `${preset.name} · ${preset.minutes}m`,
        onclick: () => invoke('focus:start', { preset: preset.id, minutes: preset.minutes }),
      }))),
    element('p', {
      class: 'muted',
      text: 'A preset swaps the blocklist below. Custom keeps whatever you have chosen.',
    }),
  ]);
}

/**
 * Emergency unlock. The first press starts a wait; only a second press after
 * it actually ends the session.
 */
function unlockButton() {
  const requested = state.unlockRequestedAt;
  if (!requested) {
    return element('button', {
      class: 'pill', text: 'Emergency unlock',
      onclick: async () => { await invoke('focus:unlock'); refresh(); },
    });
  }
  const waited = Date.now() - requested;
  const left = Math.max(0, Math.ceil((state.unlockDelayMs - waited) / 1000));
  return element('button', {
    class: 'pill' + (left ? '' : ' selected'),
    text: left ? `Unlock in ${left}s…` : 'Confirm unlock',
    onclick: async () => { await invoke('focus:unlock'); refresh(); },
  });
}

/* ---- blocklist ------------------------------------------------------------ */

function blocklistCard() {
  const blocked = new Set(state.config.blocked || []);

  return element('div', { class: 'panel-card' }, [
    element('div', { class: 'panel-card-head' }, [
      icon('lock', { size: 15 }),
      element('span', { class: 'panel-card-title', text: 'Sites to block' }),
    ]),
    element('div', { class: 'site-grid' }, state.catalog.map((site) => {
      const on = blocked.has(site.id);
      return element('button', {
        class: 'site-toggle' + (on ? ' on' : ''),
        title: site.note || '',
        onclick: () => {
          const next = on
            ? [...blocked].filter((id) => id !== site.id)
            : [...blocked, site.id];
          invoke('focus:update', { blocked: next, preset: 'custom' });
        },
      }, [
        element('span', { class: 'site-name', text: site.name }),
        element('span', {
          class: 'site-state',
          text: on ? 'Blocked' : 'Allowed',
        }),
        site.note ? element('span', { class: 'site-note', text: site.note }) : null,
      ]);
    })),
  ]);
}

/* ---- stats ---------------------------------------------------------------- */

function statsCard() {
  const stats = state.stats || {};
  return element('div', { class: 'panel-card' }, [
    element('div', { class: 'panel-card-head' }, [
      icon('grid', { size: 15 }),
      element('span', { class: 'panel-card-title', text: 'Your focus' }),
    ]),
    element('div', { class: 'stat-grid' }, [
      stat(stats.todayMinutes || 0, 'minutes today'),
      stat(stats.weekMinutes || 0, 'minutes this week'),
      stat(stats.sessionCount || 0, 'sessions'),
      stat(stats.blockedHits || 0, 'sites blocked'),
    ]),
  ]);
}

function stat(value, label) {
  return element('div', { class: 'stat' }, [
    element('div', { class: 'stat-value', text: String(value) }),
    element('div', { class: 'stat-label', text: label }),
  ]);
}

/* ---- render --------------------------------------------------------------- */

function render() {
  content.replaceChildren(...[
    blockNotice(),
    timerCard(),
    blocklistCard(),
    statsCard(),
  ].filter(Boolean));

  // A running session needs a live countdown; nothing else here does.
  clearInterval(ticker);
  if (state.active) {
    ticker = setInterval(() => {
      state.remainingMs = Math.max(0, state.remainingMs - 1000);
      if (state.remainingMs <= 0) refresh();
      else render();
    }, 1000);
  }
}

shellApi = window.shell.mount({
  mode: 'focus',
  title: 'Focus',
  subtitle: 'Block distractions, keep YouTube',
  content,
});

async function refresh() {
  state = (await invoke('focus:state')) || state;
  render();
}

onState((next) => { if (next?.modes) shellApi?.setState(next.modes); });
window.browser.on('focus:changed', refresh);

refresh();

})();
