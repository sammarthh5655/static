(function () {
  const { invoke, onState, icon } = window.page;
  const { e, button, row, muted, card, duration, nameDialog, confirm, modal, field } = window.productivityUI;
  const content = e('div', { class: 'p-page' }), status = e('div', { class: 'p-status', role: 'status' });
  let state = null, running = false, dragged = null;
  const selected = new Set();
  const api = window.shell.mount({ mode: 'organizer', title: 'Tab Organizer', subtitle: 'A little order. More headspace.', content });
  async function refresh() { if (!running) { state = await invoke('organizer:state'); render(); } }
  async function run(channel, payload) {
    if (running) return;
    running = true; status.classList.remove('error'); status.textContent = channel === 'organizer:summary' || payload?.ai ? 'Gemini is thinking…' : 'Working…';
    try { await invoke(channel, payload); state = await invoke('organizer:state'); render(); }
    catch (error) { status.classList.add('error'); status.textContent = error.message; }
    finally { running = false; }
  }
  const command = (label, channel, payload, primary = false, disabled = false) => button(label, () => run(channel, payload), primary, disabled || !!state?.busy);
  const metric = (value, label) => e('div', { class: 'p-metric' }, [e('strong', { text: value }), e('span', { text: label })]);
  function rename(group) {
    modal('Edit group', body => {
      const name = e('input', { type: 'text', value: group.name, required: '', maxlength: 80 });
      const color = e('select', {}, state.colors.map((value, i) => e('option', { value, text: 'Colour ' + (i + 1), selected: value === group.color ? '' : null })));
      body.append(field('Group name', name), field('Accent', color));
      return async () => { await invoke('organizer:group', { id: group.id, name: name.value, color: color.value }); await refresh(); };
    });
  }
  function tabCard(tab) {
    const check = e('input', { type: 'checkbox', 'aria-label': 'Select ' + tab.title, checked: selected.has(tab.id) ? '' : null,
      onchange: event => { event.target.checked ? selected.add(tab.id) : selected.delete(tab.id); renderSelection(); } });
    let host = ''; try { host = new URL(tab.url).hostname; } catch {}
    const info = [host, tab.memoryMb ? tab.memoryMb + ' MB' + (tab.sharedProcess ? ' shared' : '') : '', tab.sleeping ? 'Sleeping' : '',
      tab.pinned ? 'Pinned' : '', !tab.active && Date.now() - tab.lastActiveAt > 60000 ? duration(Date.now() - tab.lastActiveAt) + ' idle' : ''].filter(Boolean).join(' · ');
    const node = e('div', { class: 'p-tab', draggable: 'true', 'data-tab-id': tab.id, tabindex: 0 }, [
      check, e('div', {}, [
        e('button', { class: 'p-tab-title', text: tab.title || tab.url, title: tab.url, onclick: () => invoke('tabs:select', { id: tab.id }) }),
        e('div', { class: 'p-tab-detail', text: info, title: info }),
      ]),
      button(tab.pinned ? 'Unpin' : 'Pin', () => run('organizer:pin', { ids: [tab.id], pinned: !tab.pinned })),
    ]);
    node.addEventListener('dragstart', event => { dragged = tab.id; event.dataTransfer.setData('text/plain', tab.id); event.dataTransfer.effectAllowed = 'move'; node.classList.add('dragging'); });
    node.addEventListener('dragend', () => { dragged = null; node.classList.remove('dragging'); });
    node.addEventListener('drop', event => {
      if (!dragged || dragged === tab.id) return;
      event.preventDefault(); event.stopPropagation();
      run('organizer:move', { ids: [dragged], groupId: tab.groupId, workspaceId: tab.workspaceId, beforeId: tab.id }); dragged = null;
    });
    return node;
  }
  /**
   * Show what applying the plan would do, and let the user narrow it, BEFORE
   * anything changes.
   *
   * The rule this follows: a bulk action over someone's tabs is not allowed to
   * be a surprise. The dialog states the counts in words first ("4 groups, 11
   * tabs"), lists every group with the tabs it would take, and applies only
   * what is still ticked. Untick everything and the apply button is disabled
   * rather than silently doing nothing.
   */
  function previewGroups() {
    const plan = state?.plan;
    if (!plan || !plan.groups.length) return;

    // Only tabs that are actually still open can be moved, so the preview
    // counts the same set the engine would.
    const live = new Set(state.tabs.map(t => t.id));
    const groups = plan.groups
      .map(group => ({ ...group, ids: group.ids.filter(id => live.has(id)) }))
      .filter(group => group.ids.length);
    if (!groups.length) return;

    // Name -> Set of ids still ticked. Everything starts ticked, because the
    // plan is a proposal the user asked for, not something to opt into twice.
    const picked = new Map(groups.map(group => [group.name, new Set(group.ids)]));
    const already = state.tabs.filter(t => t.groupId).length;

    modal('Review the grouping', (body, close, submit) => {
      const summary = e('p', { class: 'p-preview-summary' });
      const list = e('div', { class: 'p-preview-list' });

      const tally = () => {
        const liveGroups = [...picked.values()].filter(ids => ids.size);
        const tabs = liveGroups.reduce((total, ids) => total + ids.size, 0);
        return { groups: liveGroups.length, tabs };
      };

      const retally = () => {
        const { groups: groupCount, tabs } = tally();
        summary.textContent = groupCount
          ? 'We found ' + groupCount + (groupCount === 1 ? ' group' : ' groups')
            + ' covering ' + tabs + (tabs === 1 ? ' tab' : ' tabs') + '.'
            + (already ? ' ' + already + ' already-grouped tabs will be regrouped.' : '')
          : 'Nothing is selected, so nothing will change.';
        submit.disabled = !groupCount;
      };

      for (const group of groups) {
        const chosen = picked.get(group.name);
        const count = e('span', { class: 'p-tag' });
        const tabsBox = e('div', { class: 'p-preview-tabs' });

        const refreshCount = () => {
          count.textContent = chosen.size + ' of ' + group.ids.length;
          retally();
        };

        const head = e('label', { class: 'p-preview-head' }, [
          e('input', {
            type: 'checkbox', checked: '',
            onchange: event => {
              // Toggling a group toggles every tab in it, so the header and the
              // rows can never disagree about what is about to happen.
              const on = event.target.checked;
              chosen.clear();
              if (on) for (const id of group.ids) chosen.add(id);
              for (const box of tabsBox.querySelectorAll('input')) box.checked = on;
              refreshCount();
            },
          }),
          e('strong', { text: group.name }),
          count,
        ]);

        for (const id of group.ids) {
          const tab = state.tabs.find(t => t.id === id);
          let host = '';
          try { host = new URL(tab.url).hostname.replace(/^www\./, ''); } catch {}
          tabsBox.append(e('label', { class: 'p-preview-tab' }, [
            e('input', {
              type: 'checkbox', checked: '',
              onchange: event => {
                event.target.checked ? chosen.add(id) : chosen.delete(id);
                head.querySelector('input').checked = chosen.size === group.ids.length;
                head.querySelector('input').indeterminate = chosen.size > 0 && chosen.size < group.ids.length;
                refreshCount();
              },
            }),
            e('span', { class: 'p-preview-title', text: tab?.title || tab?.url || 'Tab', title: tab?.url || '' }),
            e('span', { class: 'p-preview-host', text: host }),
          ]));
        }

        const box = e('section', { class: 'p-preview-group' }, [head, tabsBox]);
        if (group.color) box.style.setProperty('--group-color', group.color);
        list.append(box);
        refreshCount();
      }

      body.append(
        summary,
        muted('Grouping only rearranges tabs. Nothing is closed, and Undo puts it back.'),
        list,
      );

      retally();

      return async () => {
        const selection = {
          groups: [...picked].filter(([, ids]) => ids.size).map(([name]) => name),
          ids: [...picked.values()].flatMap(ids => [...ids]),
        };
        await run('organizer:apply', { selection });
      };
    }, 'Apply grouping');
  }

  let selectionBar = null;
  function renderSelection() {
    if (!selectionBar || !state) return;
    const destinations = e('select', { 'aria-label': 'Move selected tabs to' }, [
      e('option', { value: '', text: 'Move selected to…' }),
      ...state.workspaces.map(w => e('option', { value: 'workspace:' + w.id, text: w.name + ' / Ungrouped' })),
      ...state.groups.map(g => e('option', { value: 'group:' + g.id, text: (state.workspaces.find(w => w.id === g.workspaceId)?.name || '') + ' / ' + g.name })),
    ]);
    destinations.addEventListener('change', () => {
      if (!destinations.value) return;
      const [kind, id] = destinations.value.split(':');
      run('organizer:move', { ids: [...selected], ...(kind === 'group' ? { groupId: id } : { workspaceId: id }) });
    });
    destinations.disabled = !selected.size;
    selectionBar.replaceChildren(e('span', { class: 'p-tag', text: selected.size + ' selected' }),
      button('Select web tabs', () => { for (const t of state.tabs.filter(t => /^https?:/.test(t.url))) selected.add(t.id); render(); }),
      button('Clear', () => { selected.clear(); render(); }),
      command('Sleep selected', 'organizer:sleep', { ids: [...selected] }, false, !selected.size),
      command('Wake selected', 'organizer:wake', { id: [...selected][0] }, false, selected.size !== 1),
      command('Pin selected', 'organizer:pin', { ids: [...selected], pinned: true }, false, !selected.size), destinations);
  }
  function board() {
    const wrap = e('div', { class: 'p-board' });
    for (const workspace of state.workspaces) {
      const workspaceTabs = state.tabs.filter(t => t.workspaceId === workspace.id);
      const groups = [{ id: null, name: 'Ungrouped', color: null, workspaceId: workspace.id },
        ...state.groups.filter(g => g.workspaceId === workspace.id)];
      for (const group of groups) {
        const tabs = workspaceTabs.filter(t => (t.groupId || null) === group.id);
        if (!tabs.length && !group.id && workspaceTabs.length) continue;
        const head = e('div', { class: 'p-group-head' }, [
          e('strong', { text: workspace.name + ' / ' + group.name }), e('span', { class: 'p-tag', text: tabs.length }),
          group.id ? button('Edit', () => rename(group)) : null,
        ]);
        const box = e('section', { class: 'p-group', 'data-group-id': group.id || '', 'aria-label': workspace.name + ' ' + group.name },
          [head, ...tabs.map(tabCard), !tabs.length ? muted('Drop tabs here, or move selected tabs with the control above.') : null]);
        if (group.color) box.style.setProperty('--group-color', group.color);
        box.addEventListener('dragover', event => { if (dragged) { event.preventDefault(); box.classList.add('dragover'); } });
        box.addEventListener('dragleave', () => box.classList.remove('dragover'));
        box.addEventListener('drop', event => {
          event.preventDefault(); box.classList.remove('dragover');
          if (dragged) run('organizer:move', { ids: [dragged], groupId: group.id, workspaceId: workspace.id });
          dragged = null;
        });
        wrap.append(box);
      }
    }
    return wrap;
  }
  function render() {
    if (!state) return;
    for (const id of selected) if (!state.tabs.some(t => t.id === id)) selected.delete(id);
    const plan = state.plan, duplicateCount = plan?.duplicates.reduce((n, c) => n + c.ids.length, 0) || 0;
    status.classList.remove('error'); status.textContent = state.lastResult || '';
    const hero = e('div', { class: 'p-hero' }, [
      e('span', { class: 'p-eyebrow', text: 'Your tabs, with a sense of direction' }),
      e('h2', { text: 'Less searching. More doing.' }),
      muted('Preview smart groups, put a research session away for later, or give quiet tabs a rest. You choose what changes.'),
      row([command('Organise Tabs', 'organizer:analyze', {}, true),
        command(state.aiBusy ? 'Gemini is thinking…' : 'Refine with Gemini', 'organizer:analyze', { ai: true }, false, state.aiBusy || !state.aiAvailable),
        command('Save as Session', 'organizer:save-session', {}),
        command(state.undoLabel ? 'Undo ' + state.undoLabel.toLowerCase() : 'Undo', 'organizer:undo', {}, false, !state.undoLabel)]),
      muted('Local suggestions stay on this device. Gemini refinement and summaries send up to 200 tab titles and domains to Google; no page contents or full URLs.'),
    ]);
    const suggestions = card(plan ? 'Suggestions · ' + (plan.source === 'gemini' ? 'Gemini' : 'On-device') : 'Ready when you are', [
      plan ? row(plan.groups.map(g => e('span', { class: 'p-tag', text: g.name + ' · ' + g.ids.length }))) : muted('Open a few web pages, then choose Organise Tabs. Suggestions also refresh automatically when eight or more web tabs are open.'),
      plan ? muted('Groups use page titles and domains. ' + plan.sameDomain.length + ' sets share a domain. Review before applying; important, audible and edited tabs are protected during cleanup.') : null,
      plan ? row([button('Review and apply groups', previewGroups, true, !plan.groups.length || !!state.busy),
        button('Close ' + duplicateCount + ' duplicates', () => confirm('Close duplicate tabs?', 'Active, pinned, playing and edited tabs are kept. Undo reopens URLs; it cannot restore form state or navigation history.',
          () => run('organizer:close-duplicates')), false, !duplicateCount),
        command('Sleep inactive tabs', 'organizer:sleep', { ids: plan.inactive }, false, !plan.inactive.length),
        command('Sleep heavy tabs', 'organizer:sleep', { ids: plan.heavy }, false, !plan.heavy.length)]) : null,
    ]);
    selectionBar = row([]); selectionBar.classList.add('p-selection');
    const workspaces = row([
      ...state.workspaces.map(w => button(w.name + (state.activeWorkspace === w.id ? ' · current' : ''),
        () => run('organizer:select-workspace', { id: w.id }), state.activeWorkspace === w.id)),
      button('+ Workspace', () => nameDialog('New workspace', '', async name => { await invoke('organizer:workspace', { name }); await refresh(); })),
    ]);
    const sessions = card('Saved sessions', [
      muted('Stored locally with URLs, pinned tabs, groups, workspaces and the latest summary. Restore adds tabs to your current session.'),
      ...state.sessions.map(s => e('div', { class: 'p-session' }, [
        e('div', {}, [e('strong', { text: s.name }), e('div', { class: 'p-tab-detail', text: s.count + ' tabs · ' + new Date(s.savedAt).toLocaleString() })]),
        command('Restore', 'organizer:restore-session', { id: s.id }),
        button('Delete', () => confirm('Delete saved session?', s.name + ' will be removed from this device. Open tabs stay as they are.', () => run('organizer:delete-session', { id: s.id }), 'Delete')),
      ])), !state.sessions.length ? muted('Your first saved session will appear here.') : null,
    ], 'bookmark');
    content.replaceChildren(hero, status, e('div', { class: 'p-metrics' }, [
      metric(state.tabs.length, 'Open tabs'), metric(duplicateCount, 'Duplicate candidates'),
      metric(plan?.inactive.length || 0, 'Unused for 30+ minutes'), metric(state.sleeping.length, 'Sleeping tabs'),
    ]), suggestions, card('Workspaces', [workspaces]), selectionBar, board(),
    e('div', { class: 'p-grid' }, [sessions, card('Session overview', [
      muted('Gemini can describe the topics in your open tabs and suggest next steps. This is a title-based overview, not a summary of the actual articles.'),
      command('Create overview with Gemini', 'organizer:summary', {}, false, state.aiBusy || !state.aiAvailable),
      state.summary ? e('div', { class: 'p-summary', text: state.summary }) : null,
      state.summary ? button('Save overview to Notes', () => run('notes:add', { kind: 'text', title: 'Tab session overview', body: state.summary, tags: ['session'] })) : null,
    ], 'sparkle')]), muted('Memory is measured by renderer process and may be shared by tabs. Sleep freezes page work; it does not promise a fixed RAM saving. Pinned, active, audible, loading and edited pages are skipped.'));
    renderSelection();
  }
  let tabFingerprint = '', refreshTimer;
  onState(app => {
    api.setState(app.modes);
    const next = JSON.stringify([app.tabs, app.organizer]);
    if (next !== tabFingerprint) {
      tabFingerprint = next; clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { if (!dragged) refresh().catch(() => {}); }, 200);
    }
  });
  window.browser.on('organizer:changed', () => refresh().catch(() => {}));
  refresh().catch(error => { content.textContent = error.message; });
})();
