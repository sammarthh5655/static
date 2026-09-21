'use strict';

/**
 * Search engines selectable in Settings. `%s` is replaced with the
 * URL-encoded query. Add a new engine here and it shows up in Settings
 * automatically.
 */
const SEARCH_ENGINES = {
  google: {
    id: 'google',
    name: 'Google',
    searchUrl: 'https://www.google.com/search?q=%s',
  },
  brave: {
    id: 'brave',
    name: 'Brave Search',
    searchUrl: 'https://search.brave.com/search?q=%s',
  },
};

const DEFAULT_ENGINE = 'google';

function getEngine(id) {
  return SEARCH_ENGINES[id] || SEARCH_ENGINES[DEFAULT_ENGINE];
}

function buildSearchUrl(engineId, query) {
  return getEngine(engineId).searchUrl.replace('%s', encodeURIComponent(query));
}

module.exports = { SEARCH_ENGINES, DEFAULT_ENGINE, getEngine, buildSearchUrl };
