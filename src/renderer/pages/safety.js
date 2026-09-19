'use strict';

/**
 * browser://safety - fake-site warnings, the trust list, and the warning log.
 *
 * When a navigation is flagged, this page is shown as an interstitial with the
 * assessment in `?url=`. Otherwise it is the settings and history view.
 */
(function () {

const { invoke, onState, element, icon, timeAgo } = window.page;

let state = { enabled: true, trusted: [], warnings: [], blockedCount: 0 };
let assessment = null;
let shellApi = null;

const params = new URLSearchParams(location.search.replace(/^\?/, ''));
const flaggedUrl = params.get('url');

const content = element('div');

/* ---- interstitial --------------------------------------------------------- */

function warningPanel() {
  if (!assessment || !flaggedUrl) return null;

  return element('div', { class: 'panel-card warning-panel risk-' + assessment.risk }, [
    element('div', { class: 'warning-mark' }, [icon('warn', { size: 28 })]),
    element('h2', {
      class: 'warning-title',
      text: assessment.risk === 'high'
        ? 'This site looks like a fake'
        : 'This site looks suspicious',
    }),
    element('p', {
      class: 'warning-host',
      text: assessment.host,
    }),
    element('p', {
      class: 'warning-body',
      text: 'The address has signals commonly seen on fake and phishing pages. '
        + 'Nothing is certain — this is a local check on how the address is built, '
        + 'not a report that the site is known to be bad.',
    }),

    element('div', { class: 'reason-list' }, assessment.reasons.map((reason) =>
      element('div', { class: 'reason' }, [
        element('div', { class: 'reason-title', text: reason.title }),
        element('div', { class: 'reason-detail', text: reason.detail }),
      ]))),

    element('div', { class: 'pill-row warning-actions' }, [
      element('button', {
        class: 'pill selected', text: 'Go back',
        onclick: () => invoke('navigation:back'),
      }),
      element('button', {
        class: 'pill', text: 'Continue anyway',
        onclick: () => invoke('safety:proceed', { url: flaggedUrl, host: assessment.host }),
      }),
      element('button', {
        class: 'pill', text: 'Always trust this site',
        onclick: () => invoke('safety:trust', { host: assessment.host, url: flaggedUrl }),
      }),
    ]),
  ]);
}

/* ---- settings ------------------------------------------------------------- */

function settingsCard() {
  return element('div', { class: 'panel-card' }, [
    element('div', { class: 'switch-row' }, [
      element('div', { class: 'switch-row-text' }, [
        element('div', { class: 'switch-row-label', text: 'Warn about suspicious sites' }),
        element('div', {
          class: 'switch-row-hint',
          text: 'Checks how an address is built before the page is shown.',
        }),
      ]),
      element('button', {
        class: 'pill' + (state.enabled ? ' selected' : ''),
        text: state.enabled ? 'On' : 'Off',
        onclick: () => invoke('safety:enabled', { enabled: !state.enabled }),
      }),
    ]),
    element('p', {
      class: 'muted limits-note',
      text: 'This runs entirely on your device and checks the shape of the address '
        + '— lookalike spellings, brand names on the wrong domain, raw IP hosts, '
        + 'sign-in forms without encryption. It is not a threat database, so it will '
        + 'miss phishing that looks ordinary. Treat it as a second pair of eyes, not a guarantee.',
    }),
  ]);
}

function trustedCard() {
  if (!state.trusted.length) return null;
  return element('div', { class: 'panel-card' }, [
    element('div', { class: 'panel-card-head' }, [
      icon('lock', { size: 15 }),
      element('span', { class: 'panel-card-title', text: 'Always trusted' }),
    ]),
    element('div', { class: 'pill-row' }, state.trusted.map((host) =>
      element('button', {
        class: 'pill', text: host + ' ×',
        title: 'Stop trusting ' + host,
        onclick: () => invoke('safety:untrust', { host }),
      }))),
  ]);
}

function logCard() {
  if (!state.warnings.length) {
    return element('div', { class: 'panel-card' }, [
      element('p', { class: 'muted', text: 'No warnings yet.' }),
    ]);
  }
  return element('div', { class: 'panel-card' }, [
    element('div', { class: 'panel-card-head' }, [
      icon('clock', { size: 15 }),
      element('span', { class: 'panel-card-title', text: 'Recent warnings' }),
    ]),
    element('div', { class: 'note-list' }, state.warnings.map((entry) =>
      element('div', { class: 'warning-row' }, [
        element('div', { class: 'warning-row-main' }, [
          element('div', { class: 'warning-row-host', text: entry.host }),
          element('div', {
            class: 'warning-row-reasons',
            text: (entry.reasons || []).join(' · ') || entry.risk,
          }),
        ]),
        element('div', { class: 'warning-row-meta', text: timeAgo(entry.at) }),
      ]))),
  ]);
}

/* ---- render --------------------------------------------------------------- */

function render() {
  content.replaceChildren(...[
    warningPanel(),
    settingsCard(),
    trustedCard(),
    logCard(),
  ].filter(Boolean));
}

shellApi = window.shell.mount({
  mode: 'safety',
  title: 'Safety',
  subtitle: 'Warn about fake and risky sites',
  content,
});

async function refresh() {
  state = (await invoke('safety:state')) || state;
  if (flaggedUrl) assessment = await invoke('safety:assess', { url: flaggedUrl });
  render();
}

onState((next) => { if (next?.modes) shellApi?.setState(next.modes); });
window.browser.on('safety:changed', refresh);

refresh();

})();
