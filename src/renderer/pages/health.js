'use strict';
(function () {
/**
 * Browser health centre.
 *
 * Every number on this page is measured or counted - process metrics, the
 * blocking counters, the password vault, real file sizes. Nothing is scored
 * out of 100, and the status is always shown next to the findings that
 * produced it, so it can be traced rather than merely trusted.
 */

const { invoke, $, element } = window.page;

const STATUS_TEXT = {
  excellent: ['Excellent', 'Nothing needs your attention.'],
  good: ['Good', 'A few things worth knowing about.'],
  attention: ['Needs attention', 'Some protections or resources need a look.'],
  critical: ['Critical', 'Something important is switched off.'],
};

/** Bytes -> "1.4 GB". */
function bytes(value) {
  const n = Number(value) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  if (n < 1024 ** 3) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 ** 3)).toFixed(2) + ' GB';
}

function row(label, value, sub) {
  return element('div', { class: 'field' }, [
    element('div', {}, [
      element('label', { text: label }),
      ...(sub ? [element('div', { class: 'hint', text: sub })] : []),
    ]),
    element('div', { class: 'control right' }, [
      element('span', { class: 'health-value', text: String(value) }),
    ]),
  ]);
}

function actionRow(label, sub, buttonText, action, onDone) {
  const button = element('button', { text: buttonText });
  button.addEventListener('click', async () => {
    button.disabled = true;
    const original = buttonText;
    button.textContent = 'Working...';
    try {
      const result = await invoke('health:fix', { action });
      // Report what actually happened rather than a generic success: "Slept 3"
      // is checkable, "Done" is not.
      if (result.slept !== undefined) {
        button.textContent = result.slept
          ? 'Slept ' + result.slept + (result.freedMb ? ' - ' + result.freedMb + ' MB' : '')
          : 'Nothing to sleep';
      } else if (result.rules !== undefined) {
        button.textContent = Number(result.rules).toLocaleString() + ' rules';
      } else {
        button.textContent = 'Done';
      }
      if (onDone) setTimeout(onDone, 900);
    } catch (error) {
      button.textContent = String(error.message).slice(0, 40);
    }
    setTimeout(() => { button.disabled = false; button.textContent = original; }, 2600);
  });

  return element('div', { class: 'field' }, [
    element('div', {}, [
      element('label', { text: label }),
      ...(sub ? [element('div', { class: 'hint', text: sub })] : []),
    ]),
    element('div', { class: 'control right' }, [button]),
  ]);
}

function render(report) {
  const [title, sub] = STATUS_TEXT[report.status] || STATUS_TEXT.good;
  $('#status').replaceChildren(element('div', { class: 'status-card is-' + report.status }, [
    element('span', { class: 'status-dot' }),
    element('div', {}, [
      element('div', { class: 'status-title', text: title }),
      element('div', { class: 'status-sub', text: sub }),
    ]),
  ]));

  const order = { critical: 0, attention: 1, good: 2 };
  const findings = [...(report.findings || [])]
    .sort((a, b) => (order[a.level] ?? 3) - (order[b.level] ?? 3));

  $('#findings').replaceChildren(...(findings.length
    ? findings.map((finding) => {
      const node = element('div', { class: 'finding is-' + finding.level }, [
        element('div', { class: 'finding-body' }, [
          element('div', { class: 'finding-title', text: finding.title }),
          element('div', { class: 'finding-detail', text: finding.detail || '' }),
        ]),
      ]);
      if (finding.action) {
        const fix = element('button', { class: 'finding-fix', text: 'Fix' });
        fix.addEventListener('click', async () => {
          fix.disabled = true;
          fix.textContent = 'Working...';
          try {
            await invoke('health:fix', { action: finding.action });
            load();
          } catch (error) {
            fix.textContent = String(error.message).slice(0, 30);
          }
        });
        node.appendChild(fix);
      }
      return node;
    })
    : [element('p', { class: 'empty', text: 'Nothing needs attention.' })]));

  const perf = report.sections.performance;
  $('#performance').replaceChildren(
    row('Memory in use', perf.memoryMb ? perf.memoryMb + ' MB' : 'Not measured'),
    row('Tabs', perf.activeTabs + ' active - ' + perf.sleepingTabs + ' asleep'),
    row('Game Mode', perf.gameMode ? 'On' : 'Off'),
    actionRow('Sleep heavy background tabs',
      'Frees memory. The tab you are reading is never slept.',
      'Sleep tabs', 'sleep-heavy', load),
  );

  const privacy = report.sections.privacy;
  $('#privacy').replaceChildren(
    row('Shields', privacy.enabled ? 'On' : 'Off'),
    row('Blocked today', privacy.isEmpty ? 'No activity yet'
      : Number(privacy.today && privacy.today.total || 0).toLocaleString()),
    row('Blocked all time', privacy.isEmpty ? 'No activity yet'
      : Number(privacy.allTime && privacy.allTime.total || 0).toLocaleString()),
    row('Filter rules', Number(privacy.ruleCount).toLocaleString() + ' network - ' +
      Number(privacy.cosmeticCount).toLocaleString() + ' cosmetic'),
    row('Site exceptions', privacy.exceptions || 'None'),
    actionRow('Update filter lists',
      privacy.lastFetch
        ? 'Last updated ' + new Date(privacy.lastFetch).toLocaleDateString()
        : 'Never updated on this profile.',
      'Update', 'update-lists', load),
  );

  const security = report.sections.security;
  $('#security').replaceChildren(
    row('Saved logins', security.vault.count),
    row('Vault encryption', security.vault.available ? 'Available' : 'Unavailable'),
    row('Logins reused across sites',
      security.vault.checked ? (security.vault.reused || 'None') : 'Not checked',
      'Checked by username only. Passwords are never read for this.'),
  );

  const storage = report.sections.storage;
  $('#storage').replaceChildren(
    row('Cache', bytes(storage.cacheBytes) + (storage.truncated ? ' (at least)' : '')),
    row('Cookies and site data', bytes(storage.cookieBytes)),
    row('Filter lists', bytes(storage.filterListBytes)),
    row('Profile data', bytes(storage.profileBytes)),
    row('History entries', Number(storage.historyEntries).toLocaleString()),
    actionRow('Clear the cache', 'Frees space. Sites will load more slowly once.',
      'Clear cache', 'clear-cache', load),
  );

  const extensions = report.sections.extensions;
  $('#extensions').replaceChildren(
    row('Installed', extensions.count + ' - ' + extensions.enabled + ' enabled'),
    ...(extensions.items.length
      ? extensions.items.map((item) => row(
        item.name,
        item.enabled ? 'Enabled' : 'Disabled',
        item.broad ? 'Can read every site you visit' : item.permissions + ' permissions'))
      : [element('p', { class: 'empty', text: 'No extensions installed.' })]),
  );
}

async function load() {
  try {
    render(await invoke('health:report'));
  } catch (error) {
    $('#status').replaceChildren(element('p', {
      class: 'empty',
      text: 'Could not build the report: ' + error.message,
    }));
  }
}

$('#status').replaceChildren(element('p', { class: 'empty', text: 'Checking...' }));
load();

})();
