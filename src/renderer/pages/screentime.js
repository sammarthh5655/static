(function () {
  const { invoke, onState } = window.page;
  const { e, button, row, muted, card, duration, modal, field, confirm } = window.productivityUI;
  const content = e('div', { class: 'p-page' }), status = e('div', { class: 'p-status', role: 'status' });
  let state = null, running = false, lastConfig = '', focusDeadline = 0;
  const params = new URLSearchParams(location.search), candidate = params.get('blocked');
  let blockedUrl = null;
  try { if (/^https?:$/.test(new URL(candidate).protocol)) blockedUrl = candidate; } catch {}
  const api = window.shell.mount({ mode: 'screentime', title: 'Screen Time', subtitle: 'Make room for what matters.', content });
  const metric = (id, value, label) => e('div', { class: 'p-metric' }, [e('strong', { id, text: value }), e('span', { text: label })]);
  async function refresh(force = false) {
    if (running) return;
    state = await invoke('screentime:state');
    focusDeadline = state.focus.active ? Date.now() + state.focus.remainingMs : 0;
    const config = JSON.stringify([state.enabled, state.preset, state.allowlist,
      state.rules.map(({ usedMs, ...r }) => r), state.focus.active, state.focus.session?.preset, state.unlocks]);
    // Usage updates replace only report nodes, leaving inputs and keyboard focus intact.
    if (force || config !== lastConfig) { lastConfig = config; render(); } else reports();
  }
  async function run(channel, payload) {
    if (running) return;
    running = true; status.classList.remove('error'); status.textContent = '';
    try { await invoke(channel, payload); running = false; await refresh(true); }
    catch (error) { status.classList.add('error'); status.textContent = error.message; }
    finally { running = false; }
  }
  function editRule(rule = null, presetDomain = '') {
    modal(rule ? 'Edit website limit' : 'Add website limit', body => {
      const domain = e('input', { type: 'text', value: rule?.domain || presetDomain, placeholder: 'e.g. reddit.com', required: '', maxlength: 500 });
      const minutes = e('input', { type: 'number', value: rule?.dailyMinutes ?? '', min: 0, max: 1440, step: 1, placeholder: 'Blank for schedules only' });
      const enabled = e('input', { type: 'checkbox', checked: rule?.enabled !== false ? '' : null });
      const schedules = e('div'), entries = [];
      function addSchedule(value = { start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] }) {
        if (entries.length >= 8) return;
        const start = e('input', { type: 'time', value: value.start, required: '' });
        const end = e('input', { type: 'time', value: value.end, required: '' });
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((name, i) => {
          const check = e('input', { type: 'checkbox', checked: value.days.includes(i) ? '' : null });
          return { i, check, node: e('label', {}, [check, name]) };
        });
        const entry = { start, end, days }, box = e('div', { class: 'p-schedule' }, [
          row([field('Pause from', start), field('Until', end)]), e('div', { class: 'p-days' }, days.map(d => d.node)),
          button('Remove schedule', () => { entries.splice(entries.indexOf(entry), 1); box.remove(); }),
        ]);
        // Buttons inside a form must not accidentally submit the rule.
        box.querySelectorAll('button').forEach(b => b.type = 'button');
        entries.push(entry); schedules.append(box);
      }
      for (const schedule of rule?.schedules || []) addSchedule(schedule);
      const add = button('+ Pause schedule', () => addSchedule()); add.type = 'button';
      body.append(field('Website (includes subdomains)', domain), field('Daily allowance in minutes', minutes),
        muted('0 pauses the site all day. Blank uses schedules only. Usage resets at local midnight.'),
        e('label', { class: 'p-row' }, [enabled, 'Enable this rule']), schedules, add,
        muted('Schedules pause access during the selected hours, in this computer’s local timezone. An overnight schedule continues into the next day. Equal times mean the whole selected day.'));
      return async () => {
        await invoke('screentime:save-rule', { id: rule?.id, domain: domain.value, dailyMinutes: minutes.value,
          enabled: enabled.checked, schedules: entries.map(s => ({ start: s.start.value, end: s.end.value, days: s.days.filter(d => d.check.checked).map(d => d.i) })) });
        await refresh(true);
      };
    });
  }
  function blockCard() {
    if (!blockedUrl) return null;
    const domain = new URL(blockedUrl).hostname;
    const reason = { limit: 'You’ve reached the daily allowance you chose.', schedule: 'This website is in a scheduled pause.', focus: 'Your focus session is keeping this website paused.' }[params.get('reason')] || 'This website is taking a short break.';
    return e('section', { class: 'p-hero p-block' }, [
      e('span', { class: 'p-eyebrow', text: 'A moment for your priorities' }),
      e('h2', { text: domain + ' can wait.' }), muted(reason + ' Your tabs are safe, and you remain in control.'),
      row([button('Back to a fresh tab', () => invoke('tabs:navigate', { input: 'browser://newtab' }), true),
        button('Try again', () => invoke('tabs:navigate', { input: blockedUrl })),
        button('Emergency unlock · 5 minutes', () => confirm('Take a five-minute break?', 'Allow ' + domain + ' for five minutes. Your focus timer keeps running and this exception appears in your local stats.',
          async () => { await invoke('screentime:unlock', { url: blockedUrl }); await invoke('tabs:navigate', { input: blockedUrl }); }, 'Unlock for 5 minutes'))]),
      muted('Adjust your limits below whenever your plans change.'),
    ]);
  }
  function focusCard() {
    return card('Focus timer', [
      e('div', { class: 'p-timer', id: 'focus-countdown', text: state.focus.active ? duration(state.focus.remainingMs) : 'Your next clear hour' }),
      muted(state.focus.active ? 'Your existing Focus and social blocking session is running. YouTube stays available unless you choose a rule for it.' :
        'Start a distraction-free session with your existing Focus blocklist. Daily allowances and scheduled pauses continue alongside it.'),
      state.focus.active ? button('End focus session', () => run('focus:stop')) : row(state.presets.map(p =>
        button(p.name + ' · ' + p.focusMinutes + 'm', () => run('focus:start', { preset: p.id, minutes: p.focusMinutes })))),
      button('Edit Focus blocklist', () => invoke('tabs:navigate', { input: 'browser://focus' })),
    ], 'clock');
  }
  function ruleList() {
    return e('div', {}, state.rules.map(rule => {
      const allowance = rule.dailyMinutes === null ? 'Schedule only' : rule.dailyMinutes + 'm per day';
      const schedules = rule.schedules.map(s => s.days.map(d => ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][d]).join(' ') + ' ' + s.start + '–' + s.end).join('; ');
      return e('div', { class: 'p-rule' }, [
        e('div', {}, [e('strong', { text: rule.domain + (rule.enabled ? '' : ' · paused') }),
          e('div', { class: 'p-tab-detail', text: allowance + (schedules ? ' · ' + schedules : ''), title: schedules }),
          e('div', { class: 'p-tab-detail', 'data-rule-usage': rule.id, text: duration(rule.usedMs) + ' used today' })]),
        button('Edit', () => editRule(rule)),
        button('Remove', () => confirm('Remove website limit?', rule.domain + ' will no longer have this daily limit or schedule. Focus rules still apply.',
          () => run('screentime:remove-rule', { id: rule.id }), 'Remove')),
      ]);
    }));
  }
  function render() {
    if (!state) return;
    const enabled = e('input', { type: 'checkbox', checked: state.enabled ? '' : null, onchange: event => run('screentime:update', { enabled: event.target.checked }) });
    const allowlist = e('textarea', { rows: 4, placeholder: 'One domain per line', 'aria-label': 'Always allowed websites' });
    allowlist.value = state.allowlist.join('\n');
    content.replaceChildren(...[
      blockCard(), e('div', { class: 'p-hero' }, [
        e('span', { class: 'p-eyebrow', text: 'Small boundaries. Better days.' }),
        e('h2', { text: 'Spend your attention well.' }),
        muted('Choose a daily allowance, protect your study hours, and see where your time goes. YouTube is unrestricted by default; add it only if you want a limit.'),
        row([button('+ Website limit', () => editRule(), true),
          e('label', { class: 'p-row' }, [enabled, 'Track time and apply limits'])]),
      ]), status,
      e('div', { class: 'p-metrics' }, [metric('today-total', duration(state.todayMs), 'Active browsing today'),
        metric('week-total', duration(state.weekMs), 'Last seven days'),
        metric('block-total', state.weekly.reduce((n, d) => n + d.blocks, 0), 'Pauses this week'),
        metric('unlock-total', state.weekly.reduce((n, d) => n + d.unlocks, 0), 'Five-minute breaks')]),
      e('div', { class: 'p-grid' }, [
        card('Your week', [e('div', { id: 'weekly-report', class: 'p-week' }),
          muted('Foreground web tabs count while Static is focused. Time after five minutes without input, locked time and sleep do not count. Reports stay on this device for 90 days.')], 'clock'),
        card('Today by website', [e('div', { id: 'site-report' })], 'search'),
      ]),
      focusCard(),
      card('Daily-limit presets', [
        muted('Study: 20m · Work: 30m · Gaming: 45m · Legal Research: 15m per social site daily. Applying a preset replaces previous preset rules and preserves your custom rules. It does not start a focus session.'),
        row(state.presets.map(p => button(p.name, () => run('screentime:preset', { id: p.id }), state.preset === p.id))),
      ]),
      card('Website allowances & schedules', [
        state.rules.length ? ruleList() : muted('No website limits yet. Pick a site below, add your own, or choose a preset.'),
        row(state.catalog.map(([domain, label]) => button(label, () => editRule(state.rules.find(r => r.domain === domain), domain)))),
        muted('Allowances combine the domain and its subdomains. Only a matching limit or schedule pauses a website.'),
      ], 'lock'),
      e('div', { class: 'p-grid' }, [
        card('Always allowed', [
          muted('These domains bypass both website limits and Focus blocking. Domains already allowed in Focus also apply here.'),
          allowlist, button('Save allowlist', () => run('screentime:update', { allowlist: allowlist.value.split(/[\s,]+/).filter(Boolean) })),
          state.focus.config.allowlist.length ? muted('From Focus: ' + state.focus.config.allowlist.join(', ')) : null,
        ], 'lock'),
        card('Your data, your control', [
          muted('Only website domains and time totals are saved for Screen Time. Turning tracking off pauses this feature’s rules; your separate Focus timer can still run.'),
          ...state.unlocks.map(u => muted(u.domain + ' is allowed until ' + new Date(u.until).toLocaleTimeString())),
          button('Clear time reports', () => confirm('Clear local time reports?', 'Deletes browsing-time totals and pause statistics. Website rules stay in place. Daily allowances start fresh.',
            () => run('screentime:clear-usage'), 'Clear reports')),
        ], 'gear'),
      ]),
    ].filter(Boolean));
    reports();
  }
  function reports() {
    if (!state) return;
    const set = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = value; };
    set('today-total', duration(state.todayMs)); set('week-total', duration(state.weekMs));
    set('block-total', state.weekly.reduce((n, d) => n + d.blocks, 0)); set('unlock-total', state.weekly.reduce((n, d) => n + d.unlocks, 0));
    const max = Math.max(60000, ...state.weekly.map(d => d.ms));
    document.getElementById('weekly-report')?.replaceChildren(...state.weekly.map(day => {
      const bar = e('div', { class: 'p-day-bar' }); bar.style.setProperty('--bar-height', Math.max(4, day.ms / max * 110) + 'px');
      const date = new Date(day.day + 'T12:00:00');
      return e('div', { class: 'p-day', title: day.day + ': ' + duration(day.ms) }, [
        e('span', { text: duration(day.ms) }), bar, e('span', { text: date.toLocaleDateString(undefined, { weekday: 'short' }) }),
      ]);
    }));
    document.getElementById('site-report')?.replaceChildren(...(state.sites.length ? state.sites.slice(0, 12).map(site =>
      e('div', { class: 'p-site' }, [e('span', { text: site.domain }), e('strong', { text: duration(site.ms) })])) :
      [muted('Your first active browsing minutes will appear here. Built-in pages are excluded.')]));
    for (const node of document.querySelectorAll('[data-rule-usage]')) {
      const rule = state.rules.find(r => r.id === node.dataset.ruleUsage);
      if (rule) node.textContent = duration(rule.usedMs) + ' used today' + (rule.dailyMinutes === null ? '' : ' · ' + duration(Math.max(0, rule.dailyMinutes * 60000 - rule.usedMs)) + ' left');
    }
  }
  setInterval(() => {
    if (!focusDeadline) return;
    const node = document.getElementById('focus-countdown'), seconds = Math.max(0, Math.ceil((focusDeadline - Date.now()) / 1000));
    if (node) node.textContent = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  }, 1000);
  onState(app => api.setState(app.modes));
  window.browser.on('screentime:changed', () => refresh().catch(() => {}));
  window.browser.on('focus:changed', () => refresh().catch(() => {}));
  refresh(true).catch(error => { content.textContent = error.message; });
})();
