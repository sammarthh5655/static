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

/** A random wallpaper from the pool, avoiding `previous` when there is a choice. */
function pick(pool, favourites, previous, random = Math.random) {
  const list = poolOf(pool, favourites);
  const options = list.length > 1 ? list.filter((w) => w.id !== previous) : list;
  return options[Math.floor(random() * options.length)] || null;
}

module.exports = { catalog, find, pick, poolOf, configure, refresh, MODES };
