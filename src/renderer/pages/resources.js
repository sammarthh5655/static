'use strict';

/**
 * browser://resources - memory, CPU and Game Mode.
 *
 * The page is deliberate about what these controls are: policies that decide
 * when to suspend or warn, not hard caps. Electron cannot cap a renderer's
 * memory or throttle its CPU, and a UI implying otherwise would be a lie the
 * user only discovers when it fails to work.
 */
(function () {

const { invoke, onState, element, icon, formatBytes } = window.page;

let state = { tabs: [], totals: {}, config: {}, modes: { memory: [], cpu: [] } };
let shellApi = null;
let poll = null;

const content = element('div');

/* ---- totals --------------------------------------------------------------- */

function totalsCard() {
  const totals = state.totals || {};
  return element('div', { class: 'panel-card' }, [
    element('div', { class: 'stat-grid' }, [
      stat(gb(totals.totalMemoryMb), 'total memory'),
      stat(gb(totals.tabMemoryMb), 'used by tabs'),
      stat((totals.cpuPercent ?? 0) + '%', 'cpu'),
      stat(String(totals.tabCount ?? 0), 'open tabs'),
      stat(String(totals.suspendedCount ?? 0), 'suspended'),
    ]),
  ]);
}

function gb(mb) {
  if (!mb) return '0';
  return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB';
}

function stat(value, label) {
  return element('div', { class: 'stat' }, [
    element('div', { class: 'stat-value', text: value }),
    element('div', { class: 'stat-label', text: label }),
  ]);
}

/* ---- game mode ------------------------------------------------------------ */

function gameModeCard() {
  const on = !!state.config.gameMode;
  const savings = state.savings;

  return element('div', { class: 'panel-card game-card' + (on ? ' on' : '') }, [
    element('div', { class: 'panel-card-head' }, [
      icon('gear', { size: 15 }),
      element('span', { class: 'panel-card-title', text: 'Game Mode' }),
      element('button', {
        class: 'pill' + (on ? ' selected' : ''),
        text: on ? 'Turn off' : 'Turn on',
        onclick: () => invoke('resources:game-mode', { on: !on }),
      }),
    ]),
    element('p', {
      class: 'muted',
      text: on
        ? 'Inactive tabs are suspended, background audio is muted and the tightest policy is active.'
        : 'Suspends every inactive tab, mutes background audio and applies the tightest policy. One click restores everything.',
    }),
    savings && savings.freedMb > 0
      ? element('div', { class: 'savings' }, [
          element('span', { class: 'savings-value', text: gb(savings.freedMb) + ' freed' }),
          element('span', {
            class: 'muted',
            text: ` · ${savings.suspendedCount} tabs suspended · was ${gb(savings.beforeMb)}`,
          }),
        ])
      : null,
  ]);
}

/* ---- policies ------------------------------------------------------------- */

function policyCard() {
  return element('div', { class: 'panel-card' }, [
    element('div', { class: 'panel-card-head' }, [
      icon('grid', { size: 15 }),
      element('span', { class: 'panel-card-title', text: 'Policies' }),
    ]),

    element('div', { class: 'switch-row' }, [
      element('div', { class: 'switch-row-text' }, [
        element('div', { class: 'switch-row-label', text: 'Memory policy' }),
        element('div', {
          class: 'switch-row-hint',
          text: 'Decides when a heavy background tab gets suspended.',
        }),
      ]),
    ]),
    element('div', { class: 'pill-row' }, (state.modes.memory || []).map((mode) =>
      element('button', {
        class: 'pill' + (mode.id === state.config.memoryMode ? ' selected' : ''),
        text: mode.name,
        onclick: () => invoke('resources:update', { memoryMode: mode.id }),
      }))),

    element('div', { class: 'switch-row' }, [
      element('div', { class: 'switch-row-text' }, [
        element('div', { class: 'switch-row-label', text: 'CPU profile' }),
        element('div', {
          class: 'switch-row-hint',
          text: 'Decides how quickly an idle tab is suspended, and what counts as heavy.',
        }),
      ]),
    ]),
    element('div', { class: 'pill-row' }, (state.modes.cpu || []).map((mode) =>
      element('button', {
        class: 'pill' + (mode.id === state.config.cpuMode ? ' selected' : ''),
        text: mode.name,
        onclick: () => invoke('resources:update', { cpuMode: mode.id }),
      }))),

    element('div', { class: 'switch-row' }, [
      element('div', { class: 'switch-row-text' }, [
        element('div', { class: 'switch-row-label', text: 'Suspend tabs automatically' }),
        element('div', {
          class: 'switch-row-hint',
          text: 'The active tab and anything playing audio are never suspended.',
        }),
      ]),
      element('button', {
        class: 'pill' + (state.config.autoSuspend ? ' selected' : ''),
        text: state.config.autoSuspend ? 'On' : 'Off',
        onclick: () => invoke('resources:update', { autoSuspend: !state.config.autoSuspend }),
      }),
    ]),

    // Being straight about the mechanism, rather than implying a hard cap.
    element('p', {
      class: 'muted limits-note',
      text: 'These are policies, not hard limits. A browser cannot cap a page’s '
        + 'memory or throttle its CPU to a set percentage — what it can do is '
        + 'measure, then suspend or mute what is costing the most.',
    }),
  ]);
}

/* ---- tab table ------------------------------------------------------------ */

function tabsCard() {
  const tabs = state.tabs || [];
  if (!tabs.length) {
    return element('div', { class: 'panel-card' }, [
      element('p', { class: 'muted', text: 'No tabs are open.' }),
    ]);
  }
  const peak = Math.max(...tabs.map((tab) => tab.memoryMb), 1);

  return element('div', { class: 'panel-card' }, [
    element('div', { class: 'panel-card-head' }, [
      icon('grid', { size: 15 }),
      element('span', { class: 'panel-card-title', text: 'Tabs by memory' }),
      state.suspended?.length
        ? element('button', {
            class: 'pill', text: 'Restore all',
            onclick: () => invoke('resources:resume-all'),
          })
        : null,
    ]),
    element('div', { class: 'tab-rows' }, tabs.map((tab) => {
      const row = element('div', { class: 'tab-row' + (tab.heavy ? ' heavy' : '') }, [
        element('div', { class: 'tab-row-main' }, [
          element('div', { class: 'tab-row-title', text: tab.title, title: tab.url }),
          element('div', { class: 'tab-row-bar' }),
        ]),
        element('div', { class: 'tab-row-metric', text: gb(tab.memoryMb) }),
        element('div', { class: 'tab-row-metric', text: tab.cpuPercent + '%' }),
        tab.active
          ? element('span', { class: 'shell-badge', text: 'Active' })
          : tab.suspended
            ? element('button', {
                class: 'pill', text: 'Restore',
                onclick: () => invoke('resources:resume', { id: tab.id }),
              })
            : element('button', {
                class: 'pill', text: 'Suspend',
                onclick: () => invoke('resources:suspend', { id: tab.id }),
              }),
      ]);
      // Bar width via a custom property: the CSP forbids inline style attributes.
      row.querySelector('.tab-row-bar')
        .style.setProperty('--bar', Math.round((tab.memoryMb / peak) * 100) + '%');
      return row;
    })),
  ]);
}

/* ---- render --------------------------------------------------------------- */

function render() {
  content.replaceChildren(
    totalsCard(),
    gameModeCard(),
    policyCard(),
    tabsCard(),
  );
}

shellApi = window.shell.mount({
  mode: 'resources',
  title: 'Resources',
  subtitle: 'Memory, CPU and Game Mode',
  content,
});

async function refresh() {
  state = (await invoke('resources:state')) || state;
  render();
}

// Sampling only runs while this page is watching, so the browser is not
// measuring itself for no reason in the background.
invoke('resources:watch', { watch: true }).then((next) => {
  if (next) { state = next; render(); }
});
poll = setInterval(refresh, 2000);

window.addEventListener('pagehide', () => {
  clearInterval(poll);
  invoke('resources:watch', { watch: false });
});

onState((next) => { if (next?.modes) shellApi?.setState(next.modes); });

refresh();

})();
