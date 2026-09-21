'use strict';

const ipc = require('../../main/ipc');
const { parseOmniboxInput, hostOf } = require('../../main/lib/url');
const { getEngine } = require('../../main/lib/search-engines');

/**
 * Omnibox feature: turns typed text into a navigation and produces the
 * suggestion list shown in the dropdown overlay.
 *
 * Suggestion item shape (consumed by renderer/dropdown):
 *   { kind: 'url'|'search'|'history'|'bookmark', title, url, subtitle }
 * Item 0 is always the "what you typed" row so Enter without arrowing does the
 * obvious thing.
 */
const MAX_ITEMS = 8;

class Omnibox {
  constructor(ctx) {
    this.ctx = ctx;
  }

  suggest(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return [];
    const engineId = this.ctx.settings.get('searchEngine');
    const engine = getEngine(engineId);
    const parsed = parseOmniboxInput(trimmed, engineId);
    const items = [];

    if (parsed.type === 'url') {
      items.push({ kind: 'url', title: trimmed, url: parsed.url, fallbackUrl: parsed.fallbackUrl, subtitle: parsed.url });
    } else {
      items.push({ kind: 'search', title: trimmed, url: parsed.url, subtitle: `${engine.name} Search` });
    }

    const seen = new Set([parsed.url]);
    for (const b of this.ctx.bookmarks.suggest(trimmed, 3)) {
      if (seen.has(b.url)) continue;
      seen.add(b.url);
      items.push({ kind: 'bookmark', title: b.title, url: b.url, subtitle: hostOf(b.url) });
    }
    for (const h of this.ctx.history.suggest(trimmed, 6)) {
      if (seen.has(h.url)) continue;
      seen.add(h.url);
      items.push({ kind: 'history', title: h.title || h.url, url: h.url, subtitle: h.url });
    }

    // If it's a plausible URL, also offer a search for it as the 2nd row.
    if (parsed.type === 'url' && !/^[a-z]+:/i.test(trimmed)) {
      items.splice(1, 0, {
        kind: 'search',
        title: trimmed,
        url: getEngine(engineId).searchUrl.replace('%s', encodeURIComponent(trimmed)),
        subtitle: `${engine.name} Search`,
      });
    }

    return items.slice(0, MAX_ITEMS);
  }

  /** Navigate the calling window's active tab (or the calling tab) to `text`. */
  submit(event, text, opts = {}) {
    const controller = this.ctx.windows.fromWebContents(event.sender);
    if (!controller) return;
    const parsed = parseOmniboxInput(text, this.ctx.settings.get('searchEngine'));
    if (!parsed) return;
    const tab = controller.tabs.fromWebContents(event.sender) || controller.tabs.active;
    if (opts.newTab || !tab) {
      controller.tabs.create({ url: parsed.url });
    } else {
      tab.navigate(parsed.url, { fallbackUrl: parsed.fallbackUrl });
      tab.wc.focus();
    }
    controller.hideDropdown();
  }

  registerIpc() {
    ipc.handle('omnibox:suggest', (_e, text) => this.suggest(text));
    ipc.handle('omnibox:submit', (e, text, opts) => this.submit(e, text, opts || {}));

    ipc.handle('omnibox:dropdown-show', (e, payload) => {
      const c = this.ctx.windows.fromWebContents(e.sender);
      if (!c) return;
      if (!payload || !payload.items || !payload.items.length) return c.hideDropdown();
      c.showDropdown(payload);
    });
    ipc.handle('omnibox:dropdown-hide', (e) => this.ctx.windows.fromWebContents(e.sender)?.hideDropdown());

    // Click on a suggestion row inside the overlay.
    ipc.handle('omnibox:dropdown-pick', (e, item) => {
      const c = this.ctx.windows.fromWebContents(e.sender);
      if (!c || !item || typeof item.url !== 'string') return;
      const tab = c.tabs.active;
      if (tab) {
        tab.navigate(item.url, { fallbackUrl: item.fallbackUrl || null });
        tab.wc.focus();
      }
      c.hideDropdown();
    });
  }
}

module.exports = { Omnibox };
