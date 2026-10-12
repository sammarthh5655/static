'use strict';

/**
 * Wallpapers for the new tab page.
 *
 * Two sources, merged into one catalogue the page never has to think about:
 *   - the built-in set, shipped with the app (src/shared/wallpapers.json, made
 *     by scripts/make-wallpapers.cjs), which always works offline;
 *   - Static's wallpaper service (Supabase), which can add wallpapers and
 *     categories without an app update. Its list is cached on disk and
 *     refreshed at most every six hours; if it cannot be reached, the cached
 *     or built-in set is used and nothing breaks.
 *
 * A wallpaper present in both keeps its built-in copy: local is faster and
 * works offline. Remote rows are validated here even though the database
 * checks them too, and images are only ever loaded from the project's own
 * public storage address.
 */

const fs = require('node:fs');
const BUILT_IN = require('../../shared/wallpapers.json');

const MODES = ['fixed', 'newtab', 'launch'];
const REFRESH_MS = 6 * 60 * 60 * 1000;

const remote = { categories: [], wallpapers: [], fetchedAt: 0 };
let config = null;
let refreshing = null;

/** Where the remote catalogue lives and how to reach it. Called once by main. */
function configure({ cacheFile, url, key, fetcher, onChange } = {}) {
  const base = String(url || '').replace(/\/+$/, '');
  config = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(base) && key && typeof fetcher === 'function'
    ? { cacheFile, base, key: String(key), fetcher, onChange: onChange || (() => {}) }
    : null;
  if (cacheFile) {
    try { adopt(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))); } catch { /* no cache yet */ }
  }
  return !!config;
}

/** Take a fetched or cached catalogue, keeping only well-formed rows. */
function adopt(data) {
  const base = config?.base || data?.base || '';
  const storage = base + '/storage/v1/object/public/wallpapers/';
  const path = /^[a-z0-9/._-]{1,200}$/;
  remote.categories = (Array.isArray(data?.categories) ? data.categories : [])
    .filter((c) => /^[a-z0-9-]{1,40}$/.test(c?.id) && typeof c.name === 'string')
    .map((c) => ({ id: c.id, name: c.name.slice(0, 60), sort: Number(c.sort) || 0 }));
  remote.wallpapers = (Array.isArray(data?.wallpapers) ? data.wallpapers : [])
    .filter((w) => /^[a-z0-9-]{1,90}$/.test(w?.id) && /^#[0-9a-f]{6}$/.test(w.tone) &&
      path.test(w.file_path) && path.test(w.thumb_path) && typeof w.category === 'string')
    .map((w) => ({
      id: w.id, category: w.category,
      file: storage + w.file_path, thumb: storage + w.thumb_path,
      width: Number(w.width) || 0, height: Number(w.height) || 0, tone: w.tone,
      credit: { by: String(w.photographer || 'Unknown').slice(0, 120), source: String(w.source || '').slice(0, 60), licence: String(w.licence || '').slice(0, 80) },
      remote: true,
    }));
  remote.fetchedAt = Number(data?.fetchedAt) || 0;
}

/** Fetch the remote catalogue if it is stale. Never throws. */
function refresh({ force = false } = {}) {
  if (!config) return Promise.resolve(false);
  if (!force && Date.now() - remote.fetchedAt < REFRESH_MS) return Promise.resolve(false);
  if (refreshing) return refreshing;
  const headers = { apikey: config.key, accept: 'application/json' };
  // The legacy anon key is a JWT and also goes as a bearer token; the newer
  // publishable key must not.
  if (config.key.startsWith('eyJ')) headers.authorization = 'Bearer ' + config.key;
  const get = async (path) => {
    const response = await config.fetcher(config.base + '/rest/v1/' + path, { headers });
    if (!response.ok) throw new Error('wallpaper service answered ' + response.status);
    return response.json();
  };
  refreshing = Promise.all([
    get('wallpaper_categories?select=id,name,sort&order=sort'),
    get('wallpapers?select=id,category,photographer,source,licence,width,height,tone,file_path,thumb_path,sort&order=sort'),
  ]).then(([categories, wallpapers]) => {
    const data = { base: config.base, categories, wallpapers, fetchedAt: Date.now() };
    adopt(data);
    if (config.cacheFile) {
      try { fs.writeFileSync(config.cacheFile + '.tmp', JSON.stringify(data)); fs.renameSync(config.cacheFile + '.tmp', config.cacheFile); } catch { /* cache is optional */ }
    }
    config.onChange();
    return true;
  }).catch((error) => {
    console.error('[wallpapers] could not refresh:', error.message);
    return false;
  }).finally(() => { refreshing = null; });
  return refreshing;
}

function allWallpapers() {
  const local = new Set(BUILT_IN.wallpapers.map((w) => w.id));
  return [...BUILT_IN.wallpapers, ...remote.wallpapers.filter((w) => !local.has(w.id))];
}

/** Everything the picker can show: categories, and every wallpaper. */
function catalog() {
  const list = allWallpapers();
  const byId = new Map(BUILT_IN.categories.map((c) => [c.id, { ...c }]));
  for (const c of remote.categories) if (!byId.has(c.id)) byId.set(c.id, { id: c.id, name: c.name });
  const categories = [...byId.values()]
    .map((c) => ({ ...c, count: list.filter((w) => w.category === c.id).length }))
    .filter((c) => c.count > 0);
  return { categories, wallpapers: list, online: remote.fetchedAt > 0 };
}

function find(id) {
  return allWallpapers().find((w) => w.id === id) || null;
}

/**
 * The wallpapers a random pick draws from.
 * `pool` is 'all', 'favourites', or a category id.
 */
function poolOf(pool, favourites = []) {
  const all = allWallpapers();
  if (pool === 'favourites') {
    const liked = all.filter((w) => favourites.includes(w.id));
    return liked.length ? liked : all;
  }
  if (all.some((w) => w.category === pool)) return all.filter((w) => w.category === pool);
  return all;
}

/**
 * A random wallpaper from the pool, avoiding `previous` when there is a
 * choice. `previous` is one id, or the last few shown (oldest first): if
 * avoiding them all leaves nothing, at least the most recent is avoided.
 */
function pick(pool, favourites, previous, random = Math.random) {
  const list = poolOf(pool, favourites);
  const recent = [].concat(previous || []).filter(Boolean);
  let options = list.filter((w) => !recent.includes(w.id));
  if (!options.length) options = list.filter((w) => w.id !== recent[recent.length - 1]);
  if (!options.length) options = list;
  return options[Math.floor(random() * options.length)] || null;
}

/** The most recent random picks remembered, whatever the pool's size. */
const RECENT_MAX = 24;

/**
 * The next wallpaper for "a different one on every new tab".
 *
 * Different from the last few tabs too, not merely random: two tabs landing
 * on the same photo, or flicking between the same two, reads as the setting
 * not working. So it steers clear of the last half of the pool's worth of
 * picks (up to RECENT_MAX), which leaves a small category room to vary
 * instead of becoming a fixed loop. It used to remember only the last four,
 * so with fifty photos the sixth tab could repeat the first - about one run
 * of eight tabs in eight.
 *
 * `recent` is what was handed out lately, oldest first; `previous` is the one
 * the asking page showed last. Returns the pick and the updated `recent`.
 *
 * Each photo takes ONE place in the memory. `previous` is usually the last
 * pick already, and adding it again gave every photo two places, which
 * halved the memory and let a photo come back twice as soon.
 */
function nextRandom(pool, favourites, recent, previous, random = Math.random) {
  const size = poolOf(pool, favourites).length;
  const keep = Math.max(1, Math.min(RECENT_MAX, Math.floor(size / 2)));
  const ids = [...[].concat(recent || []), previous].filter(Boolean).map((id) => String(id).slice(0, 120));
  const seen = uniqueTail(ids, RECENT_MAX);
  const entry = pick(pool, favourites, seen.slice(-keep), random);
  return { entry, recent: entry ? uniqueTail([...seen, entry.id], RECENT_MAX) : seen };
}

/** The last `max` distinct ids, oldest first; a repeat counts where it last appeared. */
function uniqueTail(ids, max) {
  const out = [];
  for (let i = ids.length - 1; i >= 0 && out.length < max; i--) if (!out.includes(ids[i])) out.unshift(ids[i]);
  return out;
}

module.exports = { catalog, find, pick, nextRandom, poolOf, configure, refresh, MODES };
