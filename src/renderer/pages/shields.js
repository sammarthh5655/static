'use strict';

/**
 * browser://shields - ad and tracker blocking, HTTPS upgrades, URL cleaning.
 *
 * The page is honest about what it does and does not cover. Claiming parity
 * with Brave Shields or uBlock Origin would be a lie the user discovers the
 * first time an empty ad box appears, so the gap is stated here instead.
 */
(function () {

const { invoke, onState, element, icon } = window.page;

let state = { config: {}, rules: 0, totalBlocked: 0 };
let report = { host: '', count: 0, sources: [] };
let shellApi = null;

const content = element('div');

/* ---- summary -------------------------------------------------------------- */

function summaryCard() {
  return element('div', { class: 'panel-card' }, [
    element('div', { class: 'stat-grid' }, [
      stat(compact(state.totalBlocked), 'blocked all time'),
      stat(compact(state.rules), 'filter rules'),
      stat(String(report.count || 0), 'on this page'),
      stat(state.config.enabled ? 'On' : 'Off', 'shields'),
    ]),
  ]);
}

function stat(value, label) {
  return element('div', { class: 'stat' }, [
    element('div', { class: 'stat-value', text: value }),
    element('div', { class: 'stat-label', text: label }),
  ]);
}

function compact(value) {
  const n = Number(value) || 0;
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  return String(n);
}

/* ---- toggles -------------------------------------------------------------- */

function toggleRow(key, label, hint) {
  const on = !!state.config[key];
  return element('div', { class: 'switch-row' }, [
    element('div', { class: 'switch-row-text' }, [
      element('div', { class: 'switch-row-label', text: label }),
      element('div', { class: 'switch-row-hint', text: hint }),
    ]),
    element('button', {
      class: 'pill' + (on ? ' selected' : ''),
      text: on ? 'On' : 'Off',
      onclick: () => invoke('shields:update', { [key]: !on }),
    }),
  ]);
}

function settingsCard() {
  return element('div', { class: 'panel-card' }, [
    element('div', { class: 'panel-card-head' }, [
      icon('lock', { size: 15 }),
      element('span', { class: 'panel-card-title', text: 'Protection' }),
      element('button', {
        class: 'pill', text: 'Update lists',
        onclick: async (event) => {
          const button = event.currentTarget;
          button.textContent = 'Updating…';
          const result = await invoke('shields:refresh');
          button.textContent = result?.ok
            ? 'Updated'
            : 'Could not update';
          setTimeout(() => { button.textContent = 'Update lists'; }, 2200);
          refresh();
        },
      }),
    ]),
    toggleRow('enabled', 'Shields', 'The master switch for everything below.'),
    toggleRow('blockTrackers', 'Block ads and trackers',
      'Stops requests to known ad and tracking networks before they leave.'),
    toggleRow('upgradeHttps', 'Upgrade to HTTPS',
      'Rewrites http:// to https:// on sites that support it. Localhost is left alone.'),
    toggleRow('stripTracking', 'Remove tracking parameters',
      'Strips utm_*, fbclid, gclid and similar from addresses you open.'),
    toggleRow('blockThirdPartyCookies', 'Block third-party cookies',
      'Cookies are not sent to or set by sites other than the one you are on.'),
    toggleRow('blockVideoAds', 'Block video ads',
      'Stops pre-rolls and mid-rolls on YouTube and players that use the common ad SDKs.'),
    toggleRow('hideAdSlots', 'Hide leftover ad space',
      'Collapses the empty boxes a blocked ad would have filled.'),
  ]);
}

/* ---- this page ------------------------------------------------------------ */

function pageCard() {
  if (!report.host) {
    return element('div', { class: 'panel-card' }, [
      element('p', { class: 'muted', text: 'Open a web page to see what was blocked on it.' }),
    ]);
  }

  return element('div', { class: 'panel-card' }, [
    element('div', { class: 'panel-card-head' }, [
      icon('grid', { size: 15 }),
      element('span', { class: 'panel-card-title', text: report.host }),
      element('button', {
        class: 'pill' + (report.active ? ' selected' : ''),
        text: report.active ? 'Shields on' : 'Shields off',
        onclick: () => invoke('shields:site', { host: report.host, enabled: !report.active }),
      }),
    ]),
    report.sources.length
      ? element('div', { class: 'blocked-list' }, report.sources.map((source) =>
          element('div', { class: 'blocked-row' }, [
            element('span', { class: 'blocked-host', text: source.host }),
            element('span', { class: 'blocked-count', text: String(source.count) }),
          ])))
      : element('p', {
          class: 'muted',
          text: report.active
            ? 'Nothing blocked on this page.'
            : 'Shields are off for this site.',
        }),
  ]);
}

/* ---- honesty -------------------------------------------------------------- */

function limitsCard() {
  return element('div', { class: 'panel-card' }, [
    element('div', { class: 'panel-card-head' }, [
      icon('warn', { size: 15 }),
      element('span', { class: 'panel-card-title', text: 'What this does not do' }),
    ]),
    element('p', {
      class: 'muted',
      text: 'Network requests are blocked using EasyList and EasyPrivacy, so ad and '
        + 'tracking servers never receive the request. Video ads need a second '
        + 'approach: on YouTube the ad is served from the same address as the video, '
        + 'so it cannot be blocked by address. Those are removed inside the page '
        + 'instead, before the player ever learns an ad exists.',
    }),
    element('div', { class: 'blocked-list' }, [
      element('div', { class: 'blocked-row' }, [
        element('span', {
          class: 'blocked-host',
          text: 'No fingerprint randomisation — that needs changes to Chromium '
            + 'itself, which this browser cannot make.',
        }),
      ]),
      element('div', { class: 'blocked-row' }, [
        element('span', {
          class: 'blocked-host',
          text: 'Sites change. A player that reworks how it delivers ads can '
            + 'outrun these rules until they are updated.',
        }),
      ]),
    ]),
    element('p', {
      class: 'muted limits-note',
      text: state.usingCache
        ? 'Using downloaded filter lists.'
        : 'Using the small built-in list. Press "Update lists" to download the full ones.',
    }),
  ]);
}

/* ---- render --------------------------------------------------------------- */

function render() {
  content.replaceChildren(
    summaryCard(),
    pageCard(),
    settingsCard(),
    limitsCard(),
  );
}

shellApi = window.shell.mount({
  mode: 'shields',
  title: 'Shields',
  subtitle: 'Block ads and trackers',
  content,
});

async function refresh() {
  state = (await invoke('shields:state')) || state;
  report = (await invoke('shields:report')) || report;
  render();
}

onState((next) => { if (next?.modes) shellApi?.setState(next.modes); });
window.browser.on('shields:changed', refresh);

refresh();

})();
