'use strict';

/**
 * Wallpapers for the new tab page.
 *
 * The built-in set ships with the app (src/shared/wallpapers.json, made by
 * scripts/make-wallpapers.cjs). `sources` is a list so an online catalogue
 * can be added beside it later without the page or the settings changing:
 * each source returns entries of the same shape, and the page only ever sees
 * the merged catalogue.
 */

const BUILT_IN = require('../../shared/wallpapers.json');

const MODES = ['fixed', 'newtab', 'launch'];

/** Everything the picker can show: categories, and every wallpaper. */
function catalog() {
  return {
    categories: BUILT_IN.categories.map((c) => ({
      ...c, count: BUILT_IN.wallpapers.filter((w) => w.category === c.id).length,
    })),
    wallpapers: BUILT_IN.wallpapers,
  };
}

function find(id) {
  return BUILT_IN.wallpapers.find((w) => w.id === id) || null;
}

/**
 * The wallpapers a random pick draws from.
 * `pool` is 'all', 'favourites', or a category id.
 */
function poolOf(pool, favourites = []) {
  if (pool === 'favourites') {
    const liked = BUILT_IN.wallpapers.filter((w) => favourites.includes(w.id));
    return liked.length ? liked : BUILT_IN.wallpapers;
  }
  if (BUILT_IN.categories.some((c) => c.id === pool)) {
    return BUILT_IN.wallpapers.filter((w) => w.category === pool);
  }
  return BUILT_IN.wallpapers;
}

/** A random wallpaper from the pool, avoiding `previous` when there is a choice. */
function pick(pool, favourites, previous, random = Math.random) {
  const list = poolOf(pool, favourites);
  const options = list.length > 1 ? list.filter((w) => w.id !== previous) : list;
  return options[Math.floor(random() * options.length)] || null;
}

module.exports = { catalog, find, pick, poolOf, MODES };
