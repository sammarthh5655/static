'use strict';
(function () {

const { invoke, onState, $, element } = window.page;

// Guards against re-emitting a change while we are populating the controls
// from pushed state (which would loop settings:update -> state -> update).
let applying = false;

function update(patch) {
  if (applying) return;
  invoke('settings:update', patch).catch((error) => {
    $('#settings-status').textContent = error.message;
  });
}

$('#engine').addEventListener('change', (e) => update({ searchEngine: e.target.value }));
$('#behavior').addEventListener('change', (e) => update({ newTabBehavior: e.target.value }));
$('#bookmarksBar').addEventListener('change', (e) => update({ bookmarksBar: e.target.checked }));

// Appearance. Every one of these feeds shared/theme.js, so a change repaints
// the chrome and every open internal page through the pushed state.
/* ---- the planetarium ------------------------------------------------------
   Replaces the theme dropdown. Choosing applies immediately, because the only
   way to judge a theme is to see the browser wearing it. */
let planetarium = null;
let forgeLight = 'dark';

function mountPlanetarium(catalog, currentTheme) {
  const host = $('#planetarium-host');
  if (!host || planetarium) return;

  // The catalog arrives with the state push, and the first push can land
  // before it is populated. Building with an empty list produced a canvas
  // that drew nothing and was never rebuilt, because the host was no longer
  // empty - the planetarium was simply blank about one launch in three.
  const planets = (catalog?.planets || []).filter((planet) => planet && planet.palette);
  if (!planets.length) {
    host.replaceChildren();   // leave nothing behind to mistake for a mount
    return;
  }

  planetarium = window.planetarium.build(
    { element, icon: window.page.icon },
    {
      planets,
      current: currentTheme,
      onPick: (id) => update({ theme: id }),
    },
  );
  host.replaceChildren(planetarium.node);
}

// The forge: any colour becomes a complete, consistent world.
$('#forge-light')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-light]');
  if (!button) return;
  forgeLight = button.dataset.light;
  for (const option of $('#forge-light').querySelectorAll('[data-light]')) {
    option.classList.toggle('is-on', option === button);
  }
});

$('#forge-apply')?.addEventListener('click', () => {
  update({ theme: 'custom', customColour: $('#forge-colour').value, customLight: forgeLight === 'light' });
});
$('#surfaceStyle').addEventListener('change', (e) => update({ surfaceStyle: e.target.value }));
$('#radius').addEventListener('change', (e) => update({ radius: e.target.value }));
$('#animations').addEventListener('change', (e) => update({ animations: e.target.checked }));
for (const id of ['font', 'density', 'accent', 'sidebarMode']) {
  $('#' + id).addEventListener('change', event => update({ [id]: event.target.value }));
}
$('#fontSize').addEventListener('change', event => update({ fontSize: Number(event.target.value) }));
$('#accentCustom').addEventListener('change', event => update({ accentCustom: event.target.value, accent: 'custom' }));
$('#reduce-motion').addEventListener('change', event => update({ animations: !event.target.checked }));

$('#showMostVisited').addEventListener('change', (e) =>
  update({ newTab: { showMostVisited: e.target.checked } }));
$('#showStatusStrip').addEventListener('change', (e) =>
  update({ newTab: { showStatusStrip: e.target.checked } }));
$('#clockFormat').addEventListener('change', (e) =>
  update({ newTab: { clockFormat: e.target.value } }));

$('#open-newtab').addEventListener('click', () =>
  invoke('tabs:new', { url: 'browser://newtab' }));

// Homepage commits on blur/Enter rather than each keystroke, since main
// normalises the value and would fight the cursor position.
const homepage = $('#homepage');
homepage.addEventListener('change', () => update({ homepage: homepage.value.trim() }));
homepage.addEventListener('keydown', (e) => { if (e.key === 'Enter') homepage.blur(); });

$('#extensions').addEventListener('click', () =>
  invoke('tabs:navigate', { input: 'browser://extensions' }));

$('#clear').addEventListener('click', async () => {
  const options = {
    history: $('#clear-history').checked,
    cookies: $('#clear-cookies').checked,
    cache: $('#clear-cache').checked,
    downloads: $('#clear-downloads').checked,
  };
  if (!Object.values(options).some(Boolean)) {
    $('#clear-status').textContent = 'Select at least one thing to clear.';
    return;
  }
  $('#clear').disabled = true;
  $('#clear-status').textContent = 'Clearing…';
  try {
    await invoke('settings:clear-data', options);
    $('#clear-status').textContent = 'Browsing data cleared.';
  } catch (error) {
    $('#clear-status').textContent = error.message;
  } finally {
    $('#clear').disabled = false;
  }
});

// ---- Shields ---------------------------------------------------------
// Each toggle patches one key of the shields config. Main is the authority:
// it persists the change and pushes new state back, which repaints these
// controls through onState below.
function shields(patch) {
  if (applying) return;
  invoke('shields:update', patch).catch((error) => {
    $('#sh-status').textContent = error.message;
  });
}

const SHIELD_TOGGLES = [
  ['#sh-enabled', 'enabled'],
  ['#sh-trackers', 'blockTrackers'],
  ['#sh-video', 'blockVideoAds'],
  ['#sh-cosmetic', 'hideAdSlots'],
  ['#sh-https', 'upgradeHttps'],
  ['#sh-params', 'stripTracking'],
  ['#sh-cookies', 'blockThirdPartyCookies'],
];
for (const [selector, key] of SHIELD_TOGGLES) {
  $(selector).addEventListener('change', (e) => shields({ [key]: e.target.checked }));
}

$('#sh-refresh').addEventListener('click', async () => {
  $('#sh-refresh').disabled = true;
  $('#sh-status').textContent = 'Updating filter lists…';
  try {
    const result = await invoke('shields:refresh');
    const count = result?.count ?? result?.ruleCount;
    $('#sh-status').textContent = count
      ? Number(count).toLocaleString() + ' rules loaded.'
      : 'Filter lists updated.';
  } catch (error) {
    $('#sh-status').textContent = error.message;
  }
  $('#sh-refresh').disabled = false;
});

$('#sh-open').addEventListener('click', () => invoke('tabs:navigate', { input: 'browser://shields' }));

// ---- Safety ----------------------------------------------------------
$('#sf-enabled').addEventListener('change', (e) =>
  invoke('safety:enabled', { enabled: e.target.checked }).catch(() => {}));
$('#sf-open').addEventListener('click', () => invoke('tabs:navigate', { input: 'browser://safety' }));

// ---- Performance -----------------------------------------------------
$('#rs-game').addEventListener('change', (e) =>
  invoke('resources:game-mode', { on: e.target.checked }).catch(() => {}));
$('#rs-open').addEventListener('click', () => invoke('tabs:navigate', { input: 'browser://resources' }));

// ---- Focus -----------------------------------------------------------
// Only ending a session is offered here. STARTING one needs a preset and a
// duration, which belongs on the Focus page rather than duplicated here.
$('#fc-stop').addEventListener('click', () =>
  invoke('focus:stop', { reason: 'stopped' }).catch(() => {}));
$('#fc-open').addEventListener('click', () => invoke('tabs:navigate', { input: 'browser://focus' }));

/**
 * Every mode, as one grid. Built from the shared registry rather than a list
 * written out here, so a mode added later shows up without touching Settings.
 */
function renderModes() {
  const list = $('#mode-list');
  if (!list || list.childElementCount) return;
  const modes = (window.modes && window.modes.orderedModes()) || [];
  list.replaceChildren(...modes.map((mode) => {
    const card = element('button', { class: 'mode-card' });
    card.appendChild(element('strong', { class: 'mode-name', text: mode.name }));
    card.appendChild(element('span', { class: 'mode-tag', text: mode.tagline }));
    card.addEventListener('click', () => invoke('tabs:navigate', { input: mode.page }));
    return card;
  }));
}

/**
 * Fill a <select> from a catalogue supplied by main, so the options here can
 * never drift from what the theme module actually supports.
 */
function fillSelect(select, options, value) {
  const wanted = options.map((option) => option.id).join('|');
  if (select.dataset.filled !== wanted) {
    select.replaceChildren(...options.map((option) =>
      element('option', { value: option.id, text: option.name })));
    select.dataset.filled = wanted;
  }
  select.value = value;
}

onState((state) => {
  const s = state.settings || {};
  const catalog = state.catalog || {};
  applying = true;

  $('#engine').value = s.searchEngine || 'google';
  $('#behavior').value = s.newTabBehavior || 'newtab';
  $('#bookmarksBar').checked = !!s.bookmarksBar;
  if (document.activeElement !== homepage) homepage.value = s.homepage || '';

  mountPlanetarium(catalog, s.theme);
  if (planetarium) planetarium.setCurrent(s.theme);
  fillSelect($('#surfaceStyle'), catalog.surfaceStyles || [], s.surfaceStyle || 'frosted');
  fillSelect($('#radius'), catalog.radii || [], s.radius || 'rounded');
  $('#animations').checked = s.animations !== false;
  $('#reduce-motion').checked = s.animations === false;
  $('#sidebarMode').value = s.sidebarMode || 'on';
  fillSelect($('#font'), Object.values(window.theme.FONTS), s.font || 'system');
  fillSelect($('#density'), Object.values(window.theme.DENSITY), s.density || 'comfortable');
  fillSelect($('#accent'), Object.values(window.theme.ACCENTS), s.accent || 'default');
  if (document.activeElement !== $('#fontSize')) $('#fontSize').value = s.fontSize || 13;
  if (document.activeElement !== $('#accentCustom')) $('#accentCustom').value = s.accentCustom || '#47baff';
  $('#showMostVisited').checked = s.newTab?.showMostVisited !== false;
  $('#showStatusStrip').checked = s.newTab?.showStatusStrip !== false;
  $('#clockFormat').value = s.newTab?.clockFormat || 'system';

  // Shields. Read from state.features, which carries the raw config flags -
  // state.modes carries display strings for the dashboard and cannot drive a
  // checkbox.
  const features = state.features || {};
  const sh = features.shields || {};
  $('#sh-enabled').checked = sh.enabled !== false;
  $('#sh-trackers').checked = sh.blockTrackers !== false;
  $('#sh-video').checked = sh.blockVideoAds !== false;
  $('#sh-cosmetic').checked = sh.hideAdSlots !== false;
  $('#sh-https').checked = sh.upgradeHttps !== false;
  $('#sh-params').checked = sh.stripTracking !== false;
  $('#sh-cookies').checked = sh.blockThirdPartyCookies !== false;
  // Every toggle below the master switch is meaningless while it is off.
  for (const [selector] of SHIELD_TOGGLES.slice(1)) {
    $(selector).disabled = sh.enabled === false;
  }

  // Safety.
  const sf = features.safety || {};
  $('#sf-enabled').checked = sf.enabled !== false;
  const trusted = sf.trusted?.length || 0;
  $('#sf-trusted').textContent = trusted
    ? trusted + (trusted === 1 ? ' site you chose to trust.' : ' sites you chose to trust.')
    : 'No sites trusted yet.';

  // Performance.
  const rs = features.resources || {};
  $('#rs-game').checked = !!rs.gameMode;
  $('#rs-usage').textContent = rs.totals?.totalMemoryMb
    ? rs.totals.totalMemoryMb + ' MB across ' + rs.totals.tabCount +
      (rs.totals.tabCount === 1 ? ' tab.' : ' tabs.')
    : 'Measuring…';

  // Focus.
  const fc = features.focus || {};
  const minutesLeft = Math.ceil((fc.remainingMs || 0) / 60000);
  $('#fc-status').textContent = fc.active
    ? (fc.session?.presetName || fc.session?.preset || 'Session') + ' running · ' +
      minutesLeft + (minutesLeft === 1 ? ' minute left' : ' minutes left')
    : (fc.stats?.todayMinutes
        ? 'No session running · ' + fc.stats.todayMinutes + 'm focused today.'
        : 'No session running.');
  $('#fc-stop').disabled = !fc.active;
  const blocked = fc.config?.blocked?.length || 0;
  $('#fc-sites').textContent = blocked
    ? blocked + (blocked === 1 ? ' site is blocked during a session.' : ' sites are blocked during a session.')
    : 'Nothing blocked yet.';

  renderModes();

  // First-time setup. The line says what was chosen last time, so running it
  // again is an informed decision rather than a leap.
  const setup = features.onboarding;
  if (setup) {
    const parts = [];
    if (setup.profile) parts.push(setup.profile + ' profile');
    if (setup.privacy) parts.push(setup.privacy + ' privacy');
    $('#setup-state').textContent = setup.completed
      ? (parts.length
        ? 'You chose the ' + parts.join(' and ') + '. Running setup again lets you change them.'
        : 'Setup was dismissed without any choices. Static is running on its defaults.')
      : 'Setup has not been completed on this profile.';
  }

  applying = false;
});

$('#rerun-setup')?.addEventListener('click', async () => {
  // Navigates this tab to the welcome page, so there is no dead end and no
  // second window to find.
  try { await invoke('onboarding:restart'); } catch { /* the page will say */ }
});

})();
