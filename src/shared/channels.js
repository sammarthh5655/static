// This is the complete application IPC contract. Never expose raw ipcRenderer.
module.exports = {
  requests: [
    'app:state', 'ui:layout', 'ui:shortcuts', 'ui:action',
    'window:control', 'menu:open', 'menu:state', 'menu:ready', 'menu:pending',
    'tabs:new', 'tabs:close', 'tabs:select', 'tabs:reorder', 'tabs:navigate',
    'navigation:back', 'navigation:forward', 'navigation:reload', 'navigation:stop', 'navigation:home',
    'omnibox:suggest', 'bookmarks:toggle', 'bookmarks:remove',
    'history:search', 'history:remove',
    'extensions:load-unpacked', 'extensions:load-crx', 'extensions:set-enabled', 'extensions:remove', 'extensions:options',
    'downloads:reveal', 'downloads:cancel', 'downloads:clear',
    'settings:update', 'settings:clear-data',
    'newtab:notes',
    'ai:ask', 'ai:cancel', 'ai:status',
  ],
  events: ['app:state', 'ui:focus-address', 'ui:notice', 'ui:open-menu', 'ui:render-menu'],
};
