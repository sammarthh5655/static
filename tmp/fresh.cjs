var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// src/shared/channels.js
var require_channels = __commonJS({
  "src/shared/channels.js"(exports2, module2) {
    module2.exports = {
      requests: [
        "app:state",
        "ui:layout",
        "ui:shortcuts",
        "ui:action",
        "window:control",
        "menu:open",
        "menu:state",
        "menu:ready",
        "menu:pending",
        "tabs:new",
        "tabs:close",
        "tabs:select",
        "tabs:reorder",
        "tabs:navigate",
        "navigation:back",
        "navigation:forward",
        "navigation:reload",
        "navigation:stop",
        "navigation:home",
        "omnibox:suggest",
        "bookmarks:toggle",
        "bookmarks:remove",
        "history:search",
        "history:remove",
        "extensions:load-unpacked",
        "extensions:load-crx",
        "extensions:set-enabled",
        "extensions:remove",
        "extensions:options",
        "downloads:reveal",
        "downloads:cancel",
        "downloads:clear",
        "settings:update",
        "settings:clear-data",
        "newtab:notes",
        "ai:ask",
        "ai:cancel",
        "ai:status",
        "chat:list",
        "chat:get",
        "chat:new",
        "chat:send",
        "chat:rename",
        "chat:pin",
        "chat:delete",
        "chat:clear",
        "resources:state",
        "resources:update",
        "resources:suspend",
        "resources:resume",
        "resources:resume-all",
        "resources:game-mode",
        "resources:watch",
        "focus:state",
        "focus:start",
        "focus:stop",
        "focus:update",
        "focus:unlock",
        "notes:list",
        "notes:add",
        "notes:update",
        "notes:remove",
        "notes:state",
        "notes:capture",
        "notes:screenshot",
        "notes:export",
        "notes:summarise",
        "notes:workspace-add",
        "notes:workspace-remove",
        "notes:workspace-select",
        "safety:state",
        "safety:assess",
        "safety:trust",
        "safety:untrust",
        "safety:enabled",
        "safety:proceed",
        "modes:state",
        "shields:state",
        "shields:update",
        "shields:site",
        "shields:report",
        "shields:refresh",
        "passwords:state",
        "passwords:list",
        "passwords:save",
        "passwords:for-url",
        "passwords:reveal",
        "passwords:remove",
        "passwords:clear",
        "passwords:generate",
        "workspace:tasks",
        "workspace:page-text",
        "workspace:run",
        "shopping:compare"
      ],
      events: ["app:state", "ui:focus-address", "ui:notice", "ui:open-menu", "ui:render-menu", "chat:changed", "resources:changed", "focus:changed", "notes:changed", "safety:changed", "shields:changed"]
    };
  }
});

// src/features/shields/youtube.js
var require_youtube = __commonJS({
  "src/features/shields/youtube.js"(exports2, module2) {
    var AD_KEYS = ["adPlacements", "playerAds", "adSlots", "adBreakHeartbeatParams"];
    function isYouTubeHost2(host) {
      const clean = String(host || "").toLowerCase().replace(/^www\./, "");
      return clean === "youtube.com" || clean.endsWith(".youtube.com") || clean === "youtube-nocookie.com" || clean === "youtu.be" || clean === "youtubekids.com";
    }
    var PAGE_SCRIPT2 = `
(function(){
  if (window.__staticYt) return;
  window.__staticYt = true;
  var KEYS = ${JSON.stringify(AD_KEYS)};
  var removed = 0;

  // Delete ad keys from a player-response-shaped object, in place.
  function prune(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    try {
      for (var i = 0; i < KEYS.length; i++) {
        if (KEYS[i] in obj) { delete obj[KEYS[i]]; removed++; }
      }
      // Some responses nest the real payload one level down.
      if (obj.playerResponse && typeof obj.playerResponse === 'object') prune(obj.playerResponse);
    } catch (e) {}
    return obj;
  }
  window.__staticAdsRemoved = function(){ return removed; };

  // --- the var trap -----------------------------------------------------
  // A top-level \`var x = ...\` does not redefine an existing own property of
  // window; it assigns through the setter below. That is what lets us get in
  // front of a declaration we cannot otherwise intercept.
  function trap(name) {
    try {
      var current;
      var existing = Object.getOwnPropertyDescriptor(window, name);
      if (existing && !existing.configurable) return;
      if (existing && 'value' in existing) current = prune(existing.value);
      Object.defineProperty(window, name, {
        configurable: true,
        get: function(){ return current; },
        set: function(v){ current = prune(v); }
      });
    } catch (e) {}
  }
  trap('ytInitialPlayerResponse');
  trap('playerResponse');

  // --- fetch ------------------------------------------------------------
  // This is the path that actually serves ads for the 2nd and later videos in
  // a session. Missing it was why ads kept playing.
  try {
    var nativeFetch = window.fetch;
    var wrapped = function(input, init) {
      var url = '';
      try { url = typeof input === 'string' ? input : (input && input.url) || ''; } catch (e) {}
      var promise = nativeFetch.apply(this, arguments);
      if (url.indexOf('/youtubei/v1/player') === -1) return promise;
      return promise.then(function(response){
        try {
          // Clone so the page still gets a readable, unconsumed body if
          // anything below throws.
          return response.clone().json().then(function(data){
            prune(data);
            return new Response(JSON.stringify(data), {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers
            });
          }).catch(function(){ return response; });
        } catch (e) { return response; }
      });
    };
    wrapped.__static = true;
    window.fetch = wrapped;
  } catch (e) {}

  // --- XMLHttpRequest ---------------------------------------------------
  // Older code paths and some clients still use XHR.
  try {
    var open = XMLHttpRequest.prototype.open;
    var send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url){
      try { this.__staticUrl = String(url || ''); } catch (e) {}
      return open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function(){
      var xhr = this;
      try {
        if (xhr.__staticUrl && xhr.__staticUrl.indexOf('/youtubei/v1/player') !== -1) {
          xhr.addEventListener('readystatechange', function(){
            if (xhr.readyState !== 4) return;
            try {
              var data = JSON.parse(xhr.responseText);
              prune(data);
              var text = JSON.stringify(data);
              Object.defineProperty(xhr, 'responseText', { configurable: true, get: function(){ return text; } });
              Object.defineProperty(xhr, 'response', { configurable: true, get: function(){ return text; } });
            } catch (e) {}
          });
        }
      } catch (e) {}
      return send.apply(this, arguments);
    };
  } catch (e) {}
})();
`;
    module2.exports = { PAGE_SCRIPT: PAGE_SCRIPT2, isYouTubeHost: isYouTubeHost2, AD_KEYS };
  }
});

// src/preload/tab.js
var { contextBridge, ipcRenderer, webFrame } = require("electron");
var { requests, events } = require_channels();
var { PAGE_SCRIPT, isYouTubeHost } = require_youtube();
var isInternalPage = location.protocol === "file:" && /[\\/]renderer[\\/]pages[\\/][a-z]+\.html$/.test(location.pathname);
if (isInternalPage) {
  contextBridge.exposeInMainWorld("browser", Object.freeze({
    invoke(channel, payload) {
      if (!requests.includes(channel)) return Promise.reject(new Error("Unknown browser operation"));
      return ipcRenderer.invoke(channel, payload);
    },
    on(channel, callback) {
      if (!events.includes(channel) || typeof callback !== "function") throw new Error("Unknown browser event");
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
    platform: process.platform
  }));
}
if (!isInternalPage && isYouTubeHost(location.hostname)) {
  let enabled = false;
  try {
    enabled = ipcRenderer.sendSync("shields:video-ads-for-host", location.hostname) === true;
  } catch {
  }
  if (enabled) {
    try {
      webFrame.executeJavaScript(PAGE_SCRIPT);
    } catch {
    }
  }
}
