'use strict';
(function () {
/**
 * Settings -> Profiles.
 *
 * Every row is drawn from `profiles:state` and redrawn from it after each
 * action, so what is shown is always what main actually holds.
 */

const { $, element, invoke } = window.page;

let state = null;

function planetFill(themeId) {
  const planet = window.theme?.THEMES?.[themeId];
  if (!planet) return 'var(--accent)';
  const p = planet.palette;
  return `radial-gradient(circle at 32% 28%, ${p.primary}, ${p.secondary} 55%, ${p.deep})`;
}

function say(message) { $('#settings-status').textContent = message || ''; }

async function act(promise, done) {
  try {
    await promise;
    if (done) say(done);
    await load();
  } catch (error) {
    say(error.message || String(error));
  }
}

/** A destructive button that needs a second click within a few seconds. */
function confirming(label, confirmLabel, run) {
  let armed = null;
  const button = element('button', {
    type: 'button', class: 'danger', text: label,
    onclick: () => {
      if (armed) { clearTimeout(armed); armed = null; run(); return; }
      button.textContent = confirmLabel;
      armed = setTimeout(() => { armed = null; button.textContent = label; }, 3500);
    },
  });
  return button;
}

function renameInline(row, profile) {
  const input = element('input', { type: 'text', maxlength: 40, value: profile.name, 'aria-label': 'Profile name' });
  const save = () => act(invoke('profiles:update', { id: profile.id, name: input.value }), 'Renamed.');
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') save();
    if (event.key === 'Escape') render();
  });
  input.addEventListener('blur', save, { once: true });
  row.querySelector('.profile-name').replaceWith(input);
  input.focus();
  input.select();
}

function pinInline(row, profile) {
  const input = element('input', {
    type: 'password', inputmode: 'numeric', maxlength: 12, placeholder: '4 to 12 digits',
    'aria-label': 'New PIN for ' + profile.name,
  });
  const save = () => act(invoke('profiles:set-pin', { id: profile.id, pin: input.value }), 'PIN set. The picker will ask for it.');
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') save();
    if (event.key === 'Escape') render();
  });
  row.querySelector('.profile-actions').replaceChildren(input,
    element('button', { type: 'button', text: 'Save PIN', onclick: save }),
    element('button', { type: 'button', text: 'Cancel', onclick: render }));
  input.focus();
}

function row(profile) {
  const orb = element('span', { class: 'profile-orb', 'aria-hidden': 'true' },
    [element('span', { text: (profile.name[0] || '?').toUpperCase() })]);
  orb.style.background = planetFill(profile.theme);

  const badges = [
    profile.isActive ? element('span', { class: 'status-badge on', text: 'You are here' }) : null,
    profile.isDefault ? element('span', { class: 'status-badge', text: 'Default' }) : null,
    profile.locked ? element('span', { class: 'status-badge', text: 'PIN locked' }) : null,
  ];

  const node = element('div', { class: 'field profile-row', 'data-keywords': 'profile user ' + profile.name }, [
    element('div', { class: 'profile-who' }, [
      orb,
      element('div', {}, [
        element('div', { class: 'profile-name', text: profile.name }),
        element('div', { class: 'profile-badges' }, badges),
      ]),
    ]),
    element('div', { class: 'control right profile-actions' }, [
      profile.isActive ? null : element('button', {
        type: 'button', class: 'primary', text: 'Switch',
        onclick: () => act(invoke('profiles:switch', { id: profile.id })),
      }),
      element('button', { type: 'button', text: 'Rename', onclick: () => renameInline(node, profile) }),
      element('details', { class: 'profile-more' }, [
        element('summary', { text: 'More' }),
        element('div', { class: 'profile-menu' }, [
          profile.locked
            ? element('button', {
              type: 'button', text: 'Remove PIN',
              onclick: () => act(invoke('profiles:set-pin', { id: profile.id, pin: null }), 'PIN removed.'),
            })
            : element('button', { type: 'button', text: 'Lock with a PIN', onclick: () => pinInline(node, profile) }),
          profile.isDefault ? null : element('button', {
            type: 'button', text: 'Make default',
            onclick: () => act(invoke('profiles:set-default', { id: profile.id }), profile.name + ' is now the default.'),
          }),
          element('button', {
            type: 'button', text: 'Duplicate',
            onclick: () => act(invoke('profiles:duplicate', { id: profile.id }), 'Duplicated.'),
          }),
          confirming('Clear browsing data', 'Click again to clear', () =>
            act(invoke('profiles:clear-data', { id: profile.id }), 'Browsing data cleared for ' + profile.name + '.')),
          profile.isActive || state.profiles.length < 2 ? null : confirming('Delete profile', 'Click again to delete', () =>
            act(invoke('profiles:remove', { id: profile.id }), profile.name + ' deleted.')),
        ]),
      ]),
    ]),
  ]);
  return node;
}

function render() {
  if (!state) return;
  $('#profile-list').replaceChildren(...state.profiles.map(row));
  const startup = $('#profile-startup');
  startup.replaceChildren(...(state.startupModes || []).map((mode) =>
    element('option', { value: mode.id, text: mode.name })));
  startup.value = state.startup;
}

async function load() {
  try {
    state = await invoke('profiles:state');
    render();
  } catch (error) {
    say('Could not read profiles: ' + error.message);
  }
}

$('#profile-new').addEventListener('click', () => invoke('tabs:navigate', { input: 'browser://profiles#new' }));
$('#profile-startup').addEventListener('change', (event) =>
  act(invoke('profiles:startup', { mode: event.target.value }), 'Saved.'));

load();
})();
