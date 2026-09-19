'use strict';

/**
 * browser://dashboard - the control centre.
 *
 * Cards for every mode, each showing live state pulled from `modes:state` in
 * main. This is the page that makes the separate modes read as one product,
 * so it deliberately shows real numbers rather than static descriptions.
 */
(function () {

const { invoke, onState, element, icon } = window.page;

let summary = {};
let shellApi = null;

const content = element('div');

function render() {
  const { orderedModes } = window.modes;

  const cards = orderedModes()
    .filter((mode) => mode.id !== 'dashboard')
    .map((mode) => {
      const state = summary[mode.id] || {};
      return element('button', {
        class: 'mode-card',
        onclick: () => invoke('tabs:navigate', { input: mode.page }),
      }, [
        element('div', { class: 'mode-card-head' }, [
          icon(mode.icon, { size: 17 }),
          element('span', { class: 'mode-card-name', text: mode.name }),
          state.active ? element('span', { class: 'shell-badge on', text: 'On' }) : null,
        ]),
        element('div', { class: 'mode-card-tagline', text: mode.tagline }),
        element('div', {
          class: 'mode-card-state' + (state.active ? ' active' : ''),
          text: state.summary || '',
        }),
      ]);
    });

  content.replaceChildren(
    element('div', { class: 'section-heading', text: 'Modes' }),
    element('div', { class: 'card-grid' }, cards),
    element('div', { class: 'section-heading', text: 'Quick actions' }),
    element('div', { class: 'pill-row' }, [
      quickAction('Save this page to Notes', 'bookmark', () => invoke('notes:capture', {})),
      quickAction('Screenshot to Notes', 'grid', () => invoke('notes:screenshot', {})),
      quickAction('Start a 50 minute focus session', 'clock',
        () => invoke('focus:start', { preset: 'study', minutes: 50 })),
      quickAction('Toggle Game Mode', 'gear',
        () => invoke('resources:game-mode', { on: !summary.resources?.active })),
      quickAction('Ask Gemini', 'sparkle',
        () => invoke('tabs:navigate', { input: 'browser://ai' })),
    ]),
  );

  shellApi?.setState(summary);
}

function quickAction(label, iconName, onclick) {
  return element('button', { class: 'pill', onclick }, [
    icon(iconName, { size: 13 }),
    element('span', { text: ' ' + label }),
  ]);
}

shellApi = window.shell.mount({
  mode: 'dashboard',
  title: 'Dashboard',
  subtitle: 'Everything in one place',
  content,
});

async function refresh() {
  summary = (await invoke('modes:state')) || {};
  render();
}

// State pushes carry the mode summary, so the cards update without polling.
onState((state) => {
  if (state?.modes) { summary = state.modes; render(); }
});

refresh();

})();
