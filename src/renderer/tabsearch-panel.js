'use strict';

/**
 * The tab search list, drawn inside a menu in the overlay (see ui.js#menu):
 * a box to type in, and every open tab, narrowed as each letter is typed.
 *
 * Main sends the whole list once, as data (main/application.js
 * #tabSearchEntries); matching happens here, with shared/tabsearch.js, so the
 * list follows the keyboard without a round trip per letter. Choosing a tab
 * or closing one sends the action main attached to that row - this file never
 * decides anything about tabs itself.
 *
 * Keys: type to search, Up and Down to move, Enter to switch, Escape to close
 * (ui.js already handles Escape for every menu).
 */
(function () {

/** Text with the matched letters marked, built from text nodes only. */
function marked(text, hits) {
  const out = document.createDocumentFragment();
  for (const [part, on] of window.tabSearch.runs(text, hits)) {
    if (!on) { out.append(document.createTextNode(part)); continue; }
    const mark = document.createElement('mark');
    mark.textContent = part;
    out.append(mark);
  }
  return out;
}

/** The small picture at the start of a row: the favicon, or the site's first letter. */
function rowIcon(tab) {
  const tile = document.createElement('span');
  tile.className = 'ts-icon';
  const letter = () => {
    const mark = document.createElement('span');
    mark.className = 'ts-letter';
    mark.textContent = (tab.title || tab.site || '?').replace(/^[^\p{L}\p{N}]+/u, '').charAt(0).toUpperCase() || '·';
    return mark;
  };
  if (tab.favicon) {
    const img = document.createElement('img');
    img.alt = '';
    img.width = 16; img.height = 16;
    img.src = tab.favicon;
    img.onerror = () => img.replaceWith(letter());
    tile.append(img);
  } else tile.append(letter());
  return tile;
}

/**
 * Build the panel. `item.tabsearch` carries the tabs and words; `item.run`
 * (attached by overlay.js) sends a row's action to main and resolves with
 * main's answer. `close` closes the whole menu.
 */
function tabSearchPanel(item, { close }) {
  const { icon } = window.ui;
  const spec = item.tabsearch || {};
  let tabs = Array.isArray(spec.tabs) ? spec.tabs : [];
  let results = [];
  let selected = -1;

  const panel = document.createElement('div');
  panel.className = 'tabsearch';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Search tabs');

  const head = document.createElement('label');
  head.className = 'ts-head';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tabsearch-input';
  input.placeholder = spec.placeholder || 'Search your tabs';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-controls', 'ts-list');
  const count = document.createElement('span');
  count.className = 'ts-count';
  head.append(icon('search', { size: 16 }), input, count);

  const list = document.createElement('div');
  list.className = 'ts-list';
  list.id = 'ts-list';
  list.setAttribute('role', 'listbox');

  const foot = document.createElement('div');
  foot.className = 'ts-foot';
  const hint = (keys, words) => {
    const span = document.createElement('span');
    for (const key of keys) {
      const kbd = document.createElement('kbd');
      kbd.textContent = key;
      span.append(kbd);
    }
    span.append(document.createTextNode(' ' + words));
    return span;
  };
  foot.append(hint(['↑', '↓'], 'move'), hint(['Enter'], 'switch'), hint(['Esc'], 'close'));
  if (spec.shortcut) {
    const again = document.createElement('span');
    again.className = 'ts-foot-key';
    again.textContent = spec.shortcut;
    again.title = 'Opens this list from anywhere';
    foot.append(again);
  }

  panel.append(head, list, foot);

  const choose = (index) => {
    const tab = results[index]?.tab;
    if (!tab) return;
    close();
    item.run?.(tab.select);
  };

  /** Close one tab from the list. The row folds away; main answers with the list as it now is. */
  const closeTab = async (tab, row) => {
    row.classList.add('is-closing');
    const next = await item.run?.(tab.close);
    if (Array.isArray(next)) tabs = next;
    else tabs = tabs.filter((t) => t.id !== tab.id);
    const ms = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--motion-base'), 10) || 0;
    setTimeout(() => render({ keep: true }), Math.min(ms, 200));
    input.focus({ preventScroll: true });
  };

  const select = (index, { scroll = true } = {}) => {
    selected = results.length ? Math.max(0, Math.min(index, results.length - 1)) : -1;
    list.querySelectorAll('.ts-row').forEach((row, i) => {
      const on = i === selected;
      row.classList.toggle('is-selected', on);
      row.setAttribute('aria-selected', String(on));
      if (on) {
        input.setAttribute('aria-activedescendant', row.id);
        if (scroll) row.scrollIntoView({ block: 'nearest' });
      }
    });
  };

  const row = (result, index) => {
    const { tab, titleHits, siteHits } = result;
    const node = document.createElement('div');
    node.className = 'ts-row' + (tab.active ? ' is-current' : '') + (tab.sleeping ? ' is-sleeping' : '');
    node.id = 'ts-row-' + index;
    node.setAttribute('role', 'option');
    node.style.setProperty('--i', String(Math.min(index, 12)));
    if (tab.group?.color) {
      node.classList.add('is-grouped');
      node.style.setProperty('--swatch', tab.group.color);
    }

    const text = document.createElement('span');
    text.className = 'ts-text';
    const title = document.createElement('span');
    title.className = 'ts-title';
    title.append(marked(tab.title, titleHits));
    const sub = document.createElement('span');
    sub.className = 'ts-sub';
    const site = document.createElement('span');
    site.className = 'ts-site';
    site.append(marked(tab.site, siteHits));
    sub.append(site);
    if (tab.workspace) {
      const where = document.createElement('span');
      where.className = 'ts-workspace';
      where.textContent = tab.workspace;
      sub.append(where);
    }
    text.append(title, sub);

    const tags = document.createElement('span');
    tags.className = 'ts-tags';
    if (tab.group) {
      const chip = document.createElement('span');
      chip.className = 'ts-group';
      chip.textContent = tab.group.name;
      chip.title = 'In the group “' + tab.group.name + '”';
      tags.append(chip);
    }
    if (tab.muted || tab.audible) {
      const sound = document.createElement('span');
      sound.className = 'ts-sound' + (tab.muted ? ' is-muted' : ' is-playing');
      sound.title = tab.muted ? 'Muted' : 'Playing sound';
      sound.append(icon(tab.muted ? 'muted' : 'volume', { size: 14 }));
      tags.append(sound);
    }
    if (tab.pinned) {
      const pin = document.createElement('span');
      pin.className = 'ts-flag';
      pin.title = 'Pinned';
      pin.append(icon('pin', { size: 13 }));
      tags.append(pin);
    }
    if (tab.sleeping) {
      const moon = document.createElement('span');
      moon.className = 'ts-flag';
      moon.title = 'Asleep - wakes when you open it';
      moon.append(icon('moon', { size: 13 }));
      tags.append(moon);
    }
    if (tab.active) {
      const here = document.createElement('span');
      here.className = 'ts-here';
      here.textContent = 'Current';
      tags.append(here);
    }

    const shut = document.createElement('button');
    shut.type = 'button';
    shut.className = 'ts-close';
    shut.tabIndex = -1;
    shut.title = 'Close tab';
    shut.setAttribute('aria-label', 'Close ' + tab.title);
    shut.append(icon('close', { size: 13 }));
    shut.addEventListener('click', (event) => {
      event.stopPropagation();
      closeTab(tab, node);
    });

    node.append(rowIcon(tab), text, tags, shut);
    node.addEventListener('click', () => choose(index));
    // Middle-click closes, as it does on a tab.
    node.addEventListener('auxclick', (event) => { if (event.button === 1) closeTab(tab, node); });
    node.addEventListener('pointermove', () => { if (selected !== index) select(index, { scroll: false }); });
    return node;
  };

  /** Draw the rows for what is typed now. `keep` holds the same tab chosen. */
  function render({ keep = false, first = false } = {}) {
    const chosenId = keep ? results[selected]?.tab.id : null;
    const query = input.value;
    results = window.tabSearch.searchTabs(tabs, query);
    list.classList.toggle('is-entering', first);
    list.replaceChildren(...results.map(row));
    const n = tabs.length;
    count.textContent = query.trim()
      ? results.length + ' of ' + n
      : n + (n === 1 ? ' tab' : ' tabs');
    if (!results.length) {
      const empty = document.createElement('div');
      empty.className = 'ts-empty';
      empty.append(icon('tab_search', { size: 22 }));
      const words = document.createElement('span');
      words.textContent = n ? 'No open tab matches “' + query.trim() + '”' : 'No tabs are open';
      empty.append(words);
      list.append(empty);
    }
    let index = chosenId ? results.findIndex((r) => r.tab.id === chosenId) : -1;
    // Nothing typed: the tab you were on before this one, one Enter away.
    if (index < 0) index = !query.trim() && results.length > 1 && results[0].tab.active ? 1 : 0;
    select(index);
  }

  input.addEventListener('input', () => render());
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 6, PageUp: -6 }[event.key];
    if (step) {
      event.preventDefault();
      event.stopPropagation();
      if (!results.length) return;
      // Round the ends one row at a time; a page jump stops at the end.
      const next = Math.abs(step) === 1 ? (selected + step + results.length) % results.length : selected + step;
      select(next);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(selected);
    } else if (event.key === 'Tab') {
      // The box keeps the keyboard; Tab moves down the list like Down does.
      event.preventDefault();
      event.stopPropagation();
      if (results.length) select((selected + (event.shiftKey ? -1 : 1) + results.length) % results.length);
    }
  });

  render({ first: true });
  return panel;
}

window.tabSearchPanel = tabSearchPanel;

})();
