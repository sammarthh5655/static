'use strict';

/**
 * Single source of truth for every IPC channel in the app.
 *
 * Naming convention: "<feature>:<action>" (kebab-case action). Adding a new
 * handler means (1) adding the channel here with its allowed scopes and
 * (2) registering the handler through `src/main/ipc.js`. Preloads read this
 * file to build their whitelists, so a channel that isn't listed here is
 * unreachable from any renderer, full stop.
 *
 * Scopes:
 *   UI   - the browser chrome renderer (tab strip / toolbar) and the omnibox
 *          dropdown overlay. Both are local files we ship, loaded with the
 *          UI preload.
 *   PAGE - internal `static://` pages (new tab, settings, history, ...) that
 *          run inside a normal tab with the tab preload. They are still
 *          sandboxed web content; only the channels flagged PAGE are exposed.
 */
const UI = 'ui';
const PAGE = 'page';

/** Renderer -> main request/response channels (ipcRenderer.invoke). */
const INVOKE = {
  // ---- tabs -------------------------------------------------------------
  'tabs:list': [UI, PAGE],
  'tabs:new': [UI, PAGE],
  'tabs:close': [UI],
  'tabs:select': [UI],
  'tabs:reorder': [UI],
  'tabs:navigate': [UI, PAGE], // PAGE: internal pages navigate their own tab
  'tabs:back': [UI],
  'tabs:forward': [UI],
  'tabs:reload': [UI],
  'tabs:stop': [UI],
  'tabs:home': [UI],
  'tabs:duplicate': [UI],
  'tabs:reopen-closed': [UI],
  'tabs:context-menu': [UI],

  // ---- omnibox ----------------------------------------------------------
  'omnibox:suggest': [UI],
  'omnibox:submit': [UI, PAGE], // PAGE: new-tab page search box
  'omnibox:dropdown-show': [UI],
  'omnibox:dropdown-hide': [UI],
  'omnibox:dropdown-pick': [UI],

  // ---- bookmarks --------------------------------------------------------
  'bookmarks:list': [UI, PAGE],
  'bookmarks:add': [UI, PAGE],
  'bookmarks:remove': [UI, PAGE],
  'bookmarks:toggle': [UI],
  'bookmarks:update': [PAGE],

  // ---- history ----------------------------------------------------------
  'history:list': [PAGE],
  'history:search': [PAGE],
  'history:remove': [PAGE],
  'history:clear': [PAGE],
  'history:top-sites': [PAGE],

  // ---- downloads --------------------------------------------------------
  'downloads:list': [UI, PAGE],
  'downloads:open': [UI, PAGE],
  'downloads:show-in-folder': [UI, PAGE],
  'downloads:cancel': [UI, PAGE],
  'downloads:pause': [PAGE],
  'downloads:resume': [PAGE],
  'downloads:remove': [PAGE],
  'downloads:clear': [UI, PAGE],

  // ---- settings ---------------------------------------------------------
  'settings:get': [UI, PAGE],
  'settings:set': [PAGE],
  'settings:search-engines': [PAGE],
  'settings:clear-browsing-data': [PAGE],

  // ---- extensions -------------------------------------------------------
  'extensions:list': [PAGE],
  'extensions:enable': [PAGE],
  'extensions:disable': [PAGE],
  'extensions:remove': [PAGE],
  'extensions:load-unpacked': [PAGE],
  'extensions:open-options': [PAGE],
  'extensions:check-updates': [PAGE],

  // ---- ui chrome --------------------------------------------------------
  'ui:layout': [UI], // renderer reports its chrome height so tabs fit below
  'ui:app-menu': [UI],
  'ui:platform': [UI],
  'ui:focus-tab': [UI],
};

/** Main -> renderer push channels (webContents.send / ipcRenderer.on). */
const EVENTS = {
  'tabs:changed': [UI],
  'bookmarks:changed': [UI, PAGE],
  'history:changed': [PAGE],
  'downloads:changed': [UI, PAGE],
  'settings:changed': [UI, PAGE],
  'extensions:changed': [PAGE],
  'omnibox:focus': [UI],
  'omnibox:dropdown-render': [UI],
  'ui:fullscreen': [UI],
};

function channelsForScope(map, scope) {
  return Object.keys(map).filter((ch) => map[ch].includes(scope));
}

module.exports = {
  UI,
  PAGE,
  INVOKE,
  EVENTS,
  channelsForScope,
};
