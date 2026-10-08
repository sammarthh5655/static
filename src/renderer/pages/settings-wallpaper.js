'use strict';
(function () {
/**
 * Settings -> Appearance -> Wallpaper.
 *
 * "A different wallpaper on every new tab" used to live only inside the new
 * tab's Customise panel, where nobody looking in Settings would find it. This
 * is the same choice, made where people look for it: a preview of the new
 * tab, how the wallpaper changes, which categories a random one comes from,
 * and every wallpaper as a picture.
 *
 * It writes the same settings as the Customise panel (newTab.background,
 * backgroundValue, wallpaperMode, wallpaperPool, wallpaperFavourites), so the
 * two always agree. Nothing here assumes a write succeeded: what is shown is
 * what main pushed back.
 */
const { $, element, icon, invoke, onState } = window.page;
const picker = window.wallpaperPicker;
const host = $('#wallpaper-settings');
if (!host || !picker) return;

let tab = {};
let launchWallpaper = null;
let data = { categories: [], wallpapers: [] };

const update = (patch) => invoke('settings:update', { newTab: patch }).catch((error) => {
  $('#settings-status').textContent = error.message;
});

/* ---- the preview: a small new tab wearing the wallpaper ---- */
const wall = element('div', { class: 'ws-wall' });
const clock = element('strong', { class: 'ws-clock' });
const badge = element('span', { class: 'ws-badge' });
const credit = element('span', { class: 'ws-credit' });
const stage = element('div', { class: 'ws-stage', 'aria-hidden': 'true' }, [
  wall,
  element('div', { class: 'ws-scrim' }),
  element('div', { class: 'ws-mock' }, [
    clock,
    element('span', { class: 'ws-search' }, [icon('search', { size: 11 }), element('i')]),
    element('span', { class: 'ws-dots' }, [element('i'), element('i'), element('i'), element('i')]),
  ]),
  badge,
  credit,
]);
// The time as the new tab's clock shows it, 12 or 24 hours included.
const tick = () => {
  const chosen = tab.clockFormat || 'system';
  clock.textContent = new Date().toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', ...(chosen === 'system' ? {} : { hour12: chosen === '12' }),
  });
};
tick();
setInterval(tick, 15000);

/* ---- how it changes ---- */
const modes = element('div', { class: 'ws-modes', role: 'radiogroup', 'aria-label': 'How the wallpaper changes' });
for (const mode of picker.MODES) {
  modes.append(element('button', {
    type: 'button', class: 'ws-mode', role: 'radio', 'data-mode': mode.id, 'aria-checked': 'false', tabindex: '-1',
  }, [
    element('span', { class: 'ws-mode-glyph' }, [icon(mode.glyph, { size: 16 })]),
    element('span', { class: 'ws-mode-text' }, [element('strong', { text: mode.label }), element('small', { text: mode.hint })]),
  ]));
}

/* ---- which categories a random one comes from ---- */
const pool = element('div', { class: 'ws-pool-chips', role: 'radiogroup', 'aria-label': 'Pick from' });
const poolWrap = element('div', { class: 'ws-pool' }, [
  element('div', { class: 'ws-pool-inner' }, [
    element('div', { class: 'ws-label', text: 'Pick from' }),
    pool,
  ]),
]);

/* ---- every wallpaper ---- */
const grid = picker.build({ element, icon }, {
  label: 'Wallpapers',
  value: null,
  hearts: true,
  extras: [
    { value: '', kind: 'none', label: 'None', sub: 'Just the planet’s own sky' },
    { value: picker.RANDOM, kind: 'random', label: 'Random on every new tab', sub: 'A different photo each time' },
  ],
  onPick: (value) => {
    // Picking a particular wallpaper means wanting THAT one, as in Customise.
    if (value === picker.RANDOM) update({ background: 'wallpaper', wallpaperMode: 'newtab' });
    else if (!value) update({ background: 'plain', backgroundValue: '', wallpaperMode: 'fixed' });
    else update({ background: 'wallpaper', backgroundValue: value, wallpaperMode: 'fixed' });
  },
  onFavourite: (id) => {
    const current = tab.wallpaperFavourites || [];
    update({ wallpaperFavourites: current.includes(id) ? current.filter((x) => x !== id) : [...current, id] });
  },
});

host.append(
  element('div', { class: 'ws-top' }, [
    stage,
    element('div', { class: 'ws-side' }, [
      element('div', {}, [
        element('label', { text: 'New tab wallpaper' }),
        element('div', { class: 'hint', text: 'What sits behind every new tab. Hover a photo to see who took it; the heart keeps it in your favourites.' }),
      ]),
      element('div', { class: 'ws-label', text: 'How it changes' }),
      modes,
    ]),
  ]),
  poolWrap,
  element('div', { class: 'ws-browse' }, [grid.node]),
);

/* ---- choosing ---- */
function pickMode(id) {
  const patch = { wallpaperMode: id };
  if (id === 'fixed') {
    // "This wallpaper" keeps the one you are looking at in the preview.
    const showing = wall.dataset.showing || '';
    const known = (value) => data.wallpapers.some((w) => w.id === value);
    const keep = known(showing) ? showing
      : known(tab.backgroundValue) ? tab.backgroundValue
        : picker.poolOf(data, tab.wallpaperPool, tab.wallpaperFavourites)[0]?.id;
    if (keep) Object.assign(patch, { background: 'wallpaper', backgroundValue: keep });
  } else if (tab.background !== 'wallpaper') {
    // A random mode needs a wallpaper background to draw from.
    patch.background = 'wallpaper';
  }
  update(patch);
}

modes.addEventListener('click', (event) => {
  const button = event.target.closest('.ws-mode');
  if (button) pickMode(button.dataset.mode);
});
pool.addEventListener('click', (event) => {
  const chip = event.target.closest('.ws-chip');
  if (chip) update({ wallpaperPool: chip.dataset.pool });
});

/* Radio groups: arrows move AND choose, as radio buttons do everywhere. */
function radioKeys(group, selector, onChoose) {
  group.addEventListener('keydown', (event) => {
    const list = [...group.querySelectorAll(selector)];
    const at = list.indexOf(document.activeElement);
    if (at < 0) return;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = list[(at + step + list.length) % list.length];
    next.focus();
    onChoose(next);
  });
}
radioKeys(modes, '.ws-mode', (button) => pickMode(button.dataset.mode));
radioKeys(pool, '.ws-chip', (chip) => update({ wallpaperPool: chip.dataset.pool }));

/* ---- painting from state ---- */
function paintPool() {
  const favourites = tab.wallpaperFavourites || [];
  const current = tab.wallpaperPool || 'all';
  const entries = [
    { id: 'all', label: 'Everything', count: data.wallpapers.length, glyph: 'sparkle' },
    ...(favourites.length || current === 'favourites' ? [{ id: 'favourites', label: 'Favourites', count: favourites.length, glyph: 'heart' }] : []),
    ...data.categories.map((c) => ({ id: c.id, label: c.name, count: c.count, cover: data.wallpapers.find((w) => w.category === c.id) })),
  ];
  const signature = entries.map((e) => e.id + e.count).join('|') + '>' + current;
  if (pool.dataset.signature === signature) return;
  pool.dataset.signature = signature;
  const focused = document.activeElement?.closest?.('.ws-chip')?.dataset.pool;
  pool.replaceChildren(...entries.map((entry) => {
    const on = entry.id === current;
    let face;
    if (entry.cover) {
      face = element('span', { class: 'ws-chip-cover' });
      face.style.setProperty('background-color', entry.cover.tone);
      face.style.setProperty('background-image', picker.cssUrl(picker.imageOf(entry.cover)));
    } else {
      face = element('span', { class: 'ws-chip-cover is-glyph' }, [icon(entry.glyph, { size: 12 })]);
    }
    return element('button', {
      type: 'button', class: 'ws-chip', role: 'radio', 'data-pool': entry.id,
      'aria-checked': String(on), tabindex: on ? '0' : '-1',
    }, [face, element('span', { text: entry.label }), element('em', { text: String(entry.count) })]);
  }));
  if (focused) pool.querySelector('[data-pool="' + CSS.escape(focused) + '"]')?.focus();
}

let stopSlides = () => {};
let stageKey = '';
// The thumbnails are 480 pixels across: plenty for the preview on an
// ordinary screen, soft on a sharp one, where the full photo is worth it.
const stageImage = () => (devicePixelRatio > 1.2 || stage.clientWidth > 480 ? 'file' : 'thumb');
function paintStage() {
  const kind = tab.background || 'plain';
  const mode = tab.wallpaperMode || 'fixed';
  const byId = (id) => data.wallpapers.find((w) => w.id === id) || null;
  const list = picker.poolOf(data, tab.wallpaperPool || 'all', tab.wallpaperFavourites || []);
  let key;
  let entry = null;
  if (kind !== 'wallpaper') key = kind;
  else if (mode === 'newtab') key = 'newtab:' + list.map((w) => w.id).join(',');
  else {
    entry = (mode === 'launch' && byId(launchWallpaper)) || byId(tab.backgroundValue);
    key = entry ? 'one:' + entry.id : 'newtab:' + list.map((w) => w.id).join(',');
  }
  stage.dataset.mode = kind === 'wallpaper' ? mode : kind;
  // The slow drift across each photo is motion like any other.
  stage.classList.toggle('is-live', picker.motionAllowed());
  badge.replaceChildren();
  if (kind === 'wallpaper' && mode !== 'fixed') {
    const chosen = picker.MODES.find((m) => m.id === mode);
    badge.append(icon(chosen.glyph, { size: 11 }), element('span', { text: mode === 'newtab' ? 'New on every tab' : 'New each launch' }));
  }
  badge.hidden = !badge.childElementCount;
  if (key === stageKey) return;
  stageKey = key;
  stopSlides();
  stopSlides = () => {};
  wall.removeAttribute('data-showing');
  if (kind === 'photo') {
    wall.replaceChildren();
    credit.textContent = 'Your own photo, chosen on the new tab';
  } else if (kind !== 'wallpaper') {
    wall.replaceChildren();
    credit.textContent = 'No wallpaper: the planet’s own sky';
  } else if (entry) {
    stopSlides = picker.slideshow({ element }, wall, [entry], { key: stageImage() });
    credit.textContent = 'Photo: ' + entry.credit.by + ' · ' + entry.credit.source;
  } else {
    stopSlides = picker.slideshow({ element }, wall, list, { key: stageImage() });
    const where = (tab.wallpaperPool || 'all') === 'all' ? 'every category'
      : tab.wallpaperPool === 'favourites' ? 'your favourites'
        : (data.categories.find((c) => c.id === tab.wallpaperPool)?.name || 'one category');
    credit.textContent = list.length + ' photos from ' + where;
  }
}

function paint() {
  tick();
  // With no wallpaper at all, none of the three is true yet; the first is
  // still where Tab lands.
  const mode = tab.background === 'wallpaper' ? (tab.wallpaperMode || 'fixed') : null;
  const focused = document.activeElement?.closest?.('.ws-mode');
  for (const button of modes.querySelectorAll('.ws-mode')) {
    const on = button.dataset.mode === mode;
    button.setAttribute('aria-checked', String(on));
    if (!focused) button.tabIndex = on || (!mode && button.dataset.mode === 'fixed') ? 0 : -1;
  }
  const random = !!mode && mode !== 'fixed';
  poolWrap.classList.toggle('is-open', random);
  poolWrap.inert = !random;
  paintPool();
  paintStage();
  grid.set(mode
    ? (mode === 'newtab' ? picker.RANDOM : mode === 'fixed' ? tab.backgroundValue : null)
    : (tab.background || 'plain') === 'plain' ? '' : null);
  grid.setFavourites(tab.wallpaperFavourites || []);
}

picker.onCatalog(invoke, (result) => {
  data = result || data;
  stageKey = '';
  pool.dataset.signature = '';
  grid.setData(data);
  paint();
});

onState((state) => {
  tab = state.settings?.newTab || {};
  launchWallpaper = state.launchWallpaper || null;
  paint();
});
})();
