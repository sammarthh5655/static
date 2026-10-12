'use strict';
// Wrapped in an IIFE: classic scripts share one global scope.
(function () {
/**
 * The wallpaper picker.
 *
 * Wallpapers are chosen by looking at them, not by reading a photographer's
 * name in a list. One picker serves Settings -> Appearance -> Wallpaper and
 * the forge's "Wallpaper it brings"; the new tab's Customise studio shares
 * its modes and image addresses, so the three never describe the same choice
 * in different words.
 *
 * The picker only reports what was clicked (`onPick`). Whoever built it
 * decides what that means and writes it through settings:update, which
 * validates every value - and then calls `set` with what main pushed back,
 * so what is ringed is always what was saved.
 */

/** How the new tab's wallpaper changes. `short` is for the narrow studio panel. */
const MODES = [
  { id: 'fixed', label: 'This wallpaper', short: 'This one', glyph: 'image', hint: 'The wallpaper you pick stays.' },
  { id: 'newtab', label: 'A different one on every new tab', short: 'Every tab', glyph: 'shuffle', hint: 'A different wallpaper on every new tab.' },
  { id: 'launch', label: 'A new one each time Static starts', short: 'Every launch', glyph: 'rocket', hint: 'A new wallpaper each time Static starts.' },
];

/** The value a planet carries when it brings a different wallpaper on every tab. */
const RANDOM = 'random';

/**
 * Where a wallpaper's image lives. Built-in ones ship beside the pages; ones
 * from the wallpaper service arrive as full https addresses (main only ever
 * accepts the service's own storage address).
 */
function imageOf(entry, key = 'thumb') {
  const value = String(entry?.[key] || '');
  return /^https:\/\//.test(value) ? value : '../assets/' + value;
}

/** A CSS url() that a crafted value cannot close early to append CSS of its own. */
function cssUrl(source) {
  return 'url("' + String(source).replace(/["'()\\]/g, '') + '")';
}

/** What wearing a planet does to the new tab: the wallpaper it brings, a new one every tab, or nothing. */
function planetNewTab(wallpaper) {
  if (wallpaper === RANDOM) return { background: 'wallpaper', wallpaperMode: 'newtab' };
  if (wallpaper) return { background: 'wallpaper', backgroundValue: wallpaper, wallpaperMode: 'fixed' };
  return null;
}

/** The same pool main draws from (features/wallpapers poolOf), for previews. */
function poolOf(data, pool, favourites = []) {
  const all = data.wallpapers || [];
  if (pool === 'favourites') {
    const liked = all.filter((w) => favourites.includes(w.id));
    return liked.length ? liked : all;
  }
  const inCategory = all.filter((w) => w.category === pool);
  return inCategory.length ? inCategory : all;
}

/** Off when the person turned animations off in Static, or motion off in the system. */
function motionAllowed() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  return getComputedStyle(document.documentElement).getPropertyValue('--motion-base').trim() !== '0ms';
}

/* ---- the catalogue ------------------------------------------------------- */

let catalogPromise = null;
const catalogListeners = new Set();
window.browser?.on?.('wallpapers:changed', () => {
  catalogPromise = null;
  for (const listener of catalogListeners) catalog(listener.invoke).then(listener.callback);
});
function catalog(invoke) {
  if (!catalogPromise) catalogPromise = invoke('wallpapers:catalog').catch(() => ({ categories: [], wallpapers: [] }));
  return catalogPromise;
}
/** Call back with the catalogue now, and again whenever the wallpaper service adds to it. */
function onCatalog(invoke, callback) {
  catalogListeners.add({ invoke, callback });
  catalog(invoke).then(callback);
}

/* ---- a slideshow, for previews of "a different one every time" ---------- */

/**
 * Cross-fade through `entries` on `host`, a few seconds each. Two layers take
 * turns so a photo is only shown once it has loaded - never a blank flash.
 * Returns a function that stops it. Without motion it holds still on the
 * one showing.
 */
function slideshow(ctx, host, entries, { every = 2600, key = 'thumb' } = {}) {
  const layers = [ctx.element('i', { class: 'wp-slide' }), ctx.element('i', { class: 'wp-slide' })];
  host.replaceChildren(...layers);
  if (!entries.length) return () => {};
  const order = [...entries].sort(() => Math.random() - 0.5);
  let at = 0;
  let front = 0;
  let timer = 0;
  let stopped = false;
  const show = (first = false) => {
    const entry = order[at % order.length];
    const source = imageOf(entry, key);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (stopped) return;
      // A photo can take a moment to load. If motion was switched off while
      // it did, it must not swap in afterwards: "off" means still at once,
      // not after the slide already on its way. The first photo always shows.
      if (!first && !motionAllowed()) return;
      front = 1 - front;
      layers[front].style.setProperty('background-color', entry.tone);
      layers[front].style.setProperty('background-image', cssUrl(source));
      layers[front].classList.add('is-on');
      layers[1 - front].classList.remove('is-on');
      host.dataset.showing = entry.id;
    };
    img.src = source;
    at++;
  };
  show(true);
  // Only while it can be seen: not behind another settings section, not in
  // a background tab. Motion is asked about on every turn, not once: the
  // animations switch sits on the same page as these previews, and turning
  // it off should still them at once - and turning it back on, restart them.
  if (order.length > 1) {
    timer = setInterval(() => { if (!document.hidden && host.offsetParent !== null && motionAllowed()) show(); }, every);
  }
  return () => { stopped = true; clearInterval(timer); };
}

/* ---- the picker ---------------------------------------------------------- */

/**
 * Build a picker.
 *
 *   label      what the grid is called, for screen readers
 *   value      what is chosen to begin with (null: nothing ringed)
 *   extras     tiles before the photos: [{ value, label, sub, kind: 'none' | 'random' }]
 *   onPick     (value) => void, with an extra's value or a wallpaper id
 *   hearts     show a heart on each photo; onFavourite(id) toggles it
 *   compact    smaller tiles and a shorter window, for the forge
 *
 * Returns { node, setData(catalogue), set(value), setFavourites(ids), reveal() }.
 */
function build(ctx, options) {
  const { element, icon } = ctx;
  const extras = options.extras || [];
  let data = { categories: [], wallpapers: [] };
  let value = options.value ?? '';
  let favourites = [];
  let tab = 'all';
  let painted = false;

  const root = element('div', { class: 'wp' + (options.compact ? ' is-compact' : '') });
  const gridId = 'wp-grid-' + Math.random().toString(36).slice(2, 8);
  const tabs = element('div', { class: 'wp-tabs', role: 'tablist', 'aria-label': 'Wallpaper categories' });
  const grid = element('div', {
    class: 'wp-grid', id: gridId, role: 'listbox', 'aria-label': options.label || 'Wallpapers',
  });
  // The window scrolls, not the grid: a grid with a height limit of its own
  // squeezes its rows to fit it, and the photos then overlap.
  const scroller = element('div', { class: 'wp-scroll' }, [grid]);
  root.append(tabs, scroller);

  const categoryName = (id) => data.categories.find((c) => c.id === id)?.name || '';

  /* A photo. Its own average colour paints at once and the thumbnail fades in
     over it, so a slow remote image never leaves a grey hole. */
  const photo = (entry) => {
    const by = entry.credit?.by || 'Unknown';
    const tile = element('button', {
      type: 'button', class: 'wp-tile', role: 'option', tabindex: '-1', 'data-id': entry.id,
      'aria-selected': 'false', 'aria-label': 'Photo by ' + by + ', ' + (categoryName(entry.category) || 'wallpaper'),
    });
    tile.style.setProperty('background-color', entry.tone);
    const img = element('img', { src: imageOf(entry), alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
    img.addEventListener('load', () => tile.classList.add('is-loaded'));
    tile.append(img, element('span', { class: 'wp-by', text: by }));
    if (options.hearts) {
      // The heart is for the mouse; on the keyboard, F favourites the tile in focus.
      const heart = element('span', { class: 'wp-heart', 'aria-hidden': 'true' }, [icon('heart', { size: 13 })]);
      heart.addEventListener('click', (event) => { event.stopPropagation(); options.onFavourite?.(entry.id); });
      tile.append(heart);
    }
    return tile;
  };

  /* "None" and "Random" are tiles like any other, so they are found where the
     eye already is. Random shows a little mosaic of what it might bring. */
  const extra = (spec) => {
    const tile = element('button', {
      type: 'button', class: 'wp-tile wp-extra is-' + spec.kind, role: 'option', tabindex: '-1',
      'data-value': spec.value, 'aria-selected': 'false', 'aria-label': spec.label + (spec.sub ? '. ' + spec.sub : ''),
    });
    if (spec.kind === 'random') {
      const mosaic = element('span', { class: 'wp-mosaic', 'aria-hidden': 'true' });
      const seen = new Set();
      const picks = [];
      for (const w of [...data.wallpapers].sort(() => Math.random() - 0.5)) {
        if (picks.length < 4 && !seen.has(w.category)) { seen.add(w.category); picks.push(w); }
      }
      for (const w of picks) {
        const cell = element('i');
        cell.style.setProperty('background-color', w.tone);
        cell.style.setProperty('background-image', cssUrl(imageOf(w)));
        mosaic.append(cell);
      }
      tile.append(mosaic);
    }
    tile.append(element('span', { class: 'wp-extra-face' }, [
      element('span', { class: 'wp-extra-glyph' }, [icon(spec.kind === 'random' ? 'shuffle' : 'close', { size: 18 })]),
      element('strong', { text: spec.label }),
      spec.sub ? element('small', { text: spec.sub }) : null,
    ]));
    return tile;
  };

  const tiles = () => [...grid.querySelectorAll('.wp-tile')];
  const valueOf = (tile) => tile.dataset.id || tile.dataset.value || '';

  /** Ring the chosen tile, and make it the one Tab lands on. */
  function mark() {
    const all = tiles();
    let landing = null;
    for (const tile of all) {
      const chosen = value !== null && valueOf(tile) === value;
      tile.classList.toggle('is-chosen', chosen);
      tile.setAttribute('aria-selected', String(chosen));
      tile.classList.toggle('is-favourite', !!tile.dataset.id && favourites.includes(tile.dataset.id));
      if (chosen) landing = tile;
    }
    const focused = all.find((tile) => tile === document.activeElement);
    for (const tile of all) tile.tabIndex = tile === (focused || landing || all[0]) ? 0 : -1;
  }

  function paintTabs() {
    const entries = [
      { id: 'all', label: 'All', count: data.wallpapers.length },
      ...(options.hearts && favourites.length ? [{ id: 'favourites', label: 'Favourites', count: favourites.length }] : []),
      ...data.categories.map((c) => ({ id: c.id, label: c.name, count: c.count })),
    ];
    if (!entries.some((e) => e.id === tab)) tab = 'all';
    tabs.replaceChildren(...entries.map((entry) => {
      const button = element('button', {
        type: 'button', class: 'wp-tab', role: 'tab', 'data-tab': entry.id, 'aria-controls': gridId,
        'aria-selected': String(entry.id === tab), tabindex: entry.id === tab ? '0' : '-1',
      }, [element('span', { text: entry.label }), element('em', { text: String(entry.count) })]);
      return button;
    }));
  }

  function paintGrid() {
    const nodes = extras.map(extra);
    const groups = tab === 'all'
      ? data.categories.map((c) => ({ name: c.name, list: data.wallpapers.filter((w) => w.category === c.id) }))
      : tab === 'favourites'
        ? [{ list: data.wallpapers.filter((w) => favourites.includes(w.id)) }]
        : [{ list: data.wallpapers.filter((w) => w.category === tab) }];
    for (const group of groups) {
      if (!group.list.length) continue;
      if (group.name) {
        nodes.push(element('div', { class: 'wp-group', role: 'presentation' }, [
          element('span', { text: group.name }), element('em', { text: String(group.list.length) }),
        ]));
      }
      nodes.push(...group.list.map(photo));
    }
    // Tiles arrive in a quick ripple. The step is a fraction of the motion
    // setting, so with animations off there is no delay at all.
    let i = 0;
    for (const node of nodes) node.style.setProperty('--i', String(Math.min(i++, 28)));
    grid.replaceChildren(...nodes);
    scroller.scrollTop = 0;
    mark();
  }

  /** Bring the chosen tile into the window without scrolling the page around it. */
  function reveal() {
    const chosen = grid.querySelector('.wp-tile.is-chosen[data-id]');
    if (!chosen) return;
    const top = chosen.offsetTop - scroller.clientHeight / 2 + chosen.offsetHeight / 2;
    scroller.scrollTop = Math.max(0, top);
  }

  function choose(id) {
    tab = id;
    paintTabs();
    paintGrid();
  }

  tabs.addEventListener('click', (event) => {
    const button = event.target.closest('.wp-tab');
    if (button) choose(button.dataset.tab);
  });
  // Arrow keys move along the tabs and show each one (it changes only what
  // is on screen, so following the focus is safe).
  tabs.addEventListener('keydown', (event) => {
    const list = [...tabs.querySelectorAll('.wp-tab')];
    const at = list.indexOf(document.activeElement);
    if (at < 0) return;
    const next = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: list.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const target = list[(next + list.length) % list.length];
    choose(target.dataset.tab);
    tabs.querySelector('[data-tab="' + CSS.escape(target.dataset.tab) + '"]')?.focus();
  });

  grid.addEventListener('click', (event) => {
    const tile = event.target.closest('.wp-tile');
    if (!tile) return;
    options.onPick?.(valueOf(tile));
  });

  /* Arrow keys move through the grid; Enter or Space picks. Picking can change
     a setting, so focus moving is never a choice in itself. Up and down go to
     the nearest tile in the row above or below, which stays right even where
     a category heading breaks the rows. */
  grid.addEventListener('keydown', (event) => {
    const tile = event.target.closest('.wp-tile');
    if (!tile) return;
    if ((event.key === 'f' || event.key === 'F') && options.hearts && tile.dataset.id && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      options.onFavourite?.(tile.dataset.id);
      return;
    }
    const all = tiles();
    const at = all.indexOf(tile);
    let target = null;
    if (event.key === 'ArrowRight') target = all[at + 1];
    else if (event.key === 'ArrowLeft') target = all[at - 1];
    else if (event.key === 'Home') target = all[0];
    else if (event.key === 'End') target = all[all.length - 1];
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const down = event.key === 'ArrowDown';
      const from = tile.getBoundingClientRect();
      const rows = all
        .map((node) => ({ node, box: node.getBoundingClientRect() }))
        .filter(({ box }) => (down ? box.top >= from.bottom - 2 : box.bottom <= from.top + 2));
      if (rows.length) {
        const rowTop = down ? Math.min(...rows.map((r) => r.box.top)) : Math.max(...rows.map((r) => r.box.top));
        const row = rows.filter((r) => Math.abs(r.box.top - rowTop) < 4);
        row.sort((a, b) => Math.abs(a.box.left - from.left) - Math.abs(b.box.left - from.left));
        target = row[0].node;
      }
    } else return;
    event.preventDefault();
    if (!target) return;
    for (const node of all) node.tabIndex = node === target ? 0 : -1;
    target.focus();
  });

  return {
    node: root,
    /** The catalogue arrived (or changed). */
    setData(next) {
      data = next || data;
      paintTabs();
      paintGrid();
      if (!painted && data.wallpapers.length) { painted = true; requestAnimationFrame(reveal); }
    },
    /** What is chosen now: an extra's value, a wallpaper id, or null for nothing shown. */
    set(next) {
      if (next === value) return;
      value = next;
      mark();
    },
    setFavourites(ids) {
      const next = Array.isArray(ids) ? ids : [];
      // State is pushed often (memory figures, focus timers); repaint only
      // for a real change, or a tab in keyboard focus would lose it.
      if (next.join('|') === favourites.join('|')) return;
      const before = tab;
      favourites = next;
      // The Favourites tab appears with the first heart and goes with the
      // last, and its count follows every heart in between.
      if (options.hearts) paintTabs();
      if (tab === 'favourites' || tab !== before) paintGrid();
      else mark();
    },
    reveal,
  };
}

window.wallpaperPicker = {
  MODES, RANDOM, imageOf, cssUrl, planetNewTab, poolOf, motionAllowed, catalog, onCatalog, slideshow, build,
};
})();
