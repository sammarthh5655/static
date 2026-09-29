// Wrapped in an IIFE: widget files load as plain <script> tags and classic
// scripts share one global scope.
(function () {
/**
 * The Customise studio for the new tab page.
 *
 * A panel down the right edge with three places to be: Wallpaper, Widgets
 * and Layouts. It is built once when customising starts and then only
 * refreshed from state, so choosing a wallpaper does not rebuild the
 * gallery, lose its scroll position or flash.
 *
 * Everything writes through settings:update, which validates every value;
 * nothing here assumes its write succeeded - what is shown is always what
 * main pushed back.
 */

const RENDERERS = window.widgetRenderers || (window.widgetRenderers = {});

const PRESETS = {
  minimal: { name: 'Minimal', widgets: ['clock'], blurb: 'The clock and nothing else' },
  privacy: { name: 'Privacy', widgets: ['clock', 'privacy'], blurb: 'Time, and what was blocked' },
  productivity: { name: 'Productivity', widgets: ['clock', 'notes', 'reading', 'shortcuts'], blurb: 'Notes, links and a queue' },
  student: { name: 'Student', widgets: ['clock', 'notes', 'reading', 'privacy'], blurb: 'Notes and reading' },
  everything: { name: 'Everything', widgets: ['clock', 'privacy', 'notes', 'reading', 'shortcuts', 'recent', 'downloads'], blurb: 'Every widget out' },
};

const MODES = [
  { id: 'fixed', label: 'This one', hint: 'The wallpaper you pick stays.' },
  { id: 'newtab', label: 'Every tab', hint: 'A different wallpaper on every new tab.' },
  { id: 'launch', label: 'Every launch', hint: 'A new wallpaper each time Static starts.' },
];

const SIZES = [
  { id: 'compact', label: 'Compact' },
  { id: 'comfortable', label: 'Comfortable' },
  { id: 'large', label: 'Large' },
];

let catalogPromise = null;
window.browser?.on?.('wallpapers:changed', () => { catalogPromise = null; });
function catalog(ctx) {
  if (!catalogPromise) catalogPromise = ctx.invoke('wallpapers:catalog').catch(() => ({ categories: [], wallpapers: [] }));
  return catalogPromise;
}

function remember(key, value) {
  try { sessionStorage.setItem('studio:' + key, value); } catch { /* storage may be off */ }
}
function recall(key, fallback) {
  try { return sessionStorage.getItem('studio:' + key) || fallback; } catch { return fallback; }
}

/** A row of choices that behaves like one control. */
function segmented(ctx, options, current, onPick) {
  const host = ctx.element('div', { class: 'studio-seg', role: 'radiogroup' });
  for (const option of options) {
    const button = ctx.element('button', {
      class: 'studio-seg-item', role: 'radio', 'data-id': option.id,
      'aria-checked': String(option.id === current), text: option.label,
    });
    button.addEventListener('click', () => onPick(option.id));
    host.append(button);
  }
  host.select = (id) => {
    for (const b of host.children) b.setAttribute('aria-checked', String(b.dataset.id === id));
  };
  return host;
}

function build(ctx, { getLayout, setLayout, onExit }) {
  const registry = (window.widgets && window.widgets.WIDGETS) || {};
  const settingsOf = () => ctx.state().settings?.newTab || {};
  const update = (patch) => ctx.invoke('settings:update', { newTab: patch }).catch((error) => console.error(error));

  const panel = ctx.element('div', { class: 'studio', role: 'dialog', 'aria-label': 'Customise this page' });

  // ---- head ----
  const done = ctx.element('button', { class: 'studio-done', text: 'Done' });
  done.addEventListener('click', onExit);
  panel.append(ctx.element('header', { class: 'studio-head' }, [
    ctx.element('div', {}, [
      ctx.element('strong', { text: 'Make it yours' }),
      ctx.element('span', { text: 'Everything saves as you go' }),
    ]),
    done,
  ]));

  // ---- tabs ----
  const panes = {};
  const tabs = ctx.element('nav', { class: 'studio-tabs', role: 'tablist' });
  const show = (id) => {
    remember('pane', id);
    for (const [key, pane] of Object.entries(panes)) pane.hidden = key !== id;
    for (const tab of tabs.children) tab.setAttribute('aria-selected', String(tab.dataset.pane === id));
  };
  for (const [id, label, glyph] of [['wallpaper', 'Wallpaper', 'image'], ['widgets', 'Widgets', 'grid'], ['layouts', 'Layouts', 'sidebar']]) {
    const tab = ctx.element('button', { class: 'studio-tab', role: 'tab', 'data-pane': id }, [ctx.icon(glyph, { size: 15 }), ctx.element('span', { text: label })]);
    tab.addEventListener('click', () => show(id));
    tabs.append(tab);
  }
  panel.append(tabs);

  // ---- wallpaper pane ----
  const wallpaperPane = ctx.element('section', { class: 'studio-pane' });
  panes.wallpaper = wallpaperPane;
  const modeHint = ctx.element('p', { class: 'studio-hint' });
  const mode = segmented(ctx, MODES, settingsOf().wallpaperMode || 'fixed', (id) => {
    const tab = settingsOf();
    const patch = { wallpaperMode: id };
    // Random modes need a wallpaper background to draw from.
    if (id !== 'fixed' && tab.background !== 'wallpaper') patch.background = 'wallpaper';
    update(patch);
  });
  const pills = ctx.element('div', { class: 'studio-pills', role: 'tablist', 'aria-label': 'Categories' });
  const gallery = ctx.element('div', { class: 'studio-gallery' });
  const credit = ctx.element('p', { class: 'studio-credit' });
  wallpaperPane.append(
    ctx.element('div', { class: 'studio-label', text: 'Change it' }), mode, modeHint,
    ctx.element('div', { class: 'studio-label', text: 'Browse' }), pills, gallery, credit);

  let filter = recall('filter', 'all');
  let data = { categories: [], wallpapers: [] };

  const tile = (entry) => {
    const button = ctx.element('button', {
      class: 'studio-thumb', 'data-id': entry.id,
      title: 'Photo: ' + entry.credit.by + ' on ' + entry.credit.source,
      'aria-label': 'Wallpaper by ' + entry.credit.by,
    });
    button.style.backgroundColor = entry.tone;
    const thumb = /^https:\/\//.test(entry.thumb) ? entry.thumb : '../assets/' + entry.thumb;
    const img = ctx.element('img', { src: thumb, alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('load', () => button.classList.add('is-loaded'));
    const heart = ctx.element('span', { class: 'studio-heart', role: 'button', tabindex: '0', title: 'Favourite', 'aria-label': 'Favourite' },
      [ctx.icon('heart', { size: 14 })]);
    const toggleFavourite = (event) => {
      event.stopPropagation();
      const current = settingsOf().wallpaperFavourites || [];
      update({ wallpaperFavourites: current.includes(entry.id) ? current.filter((id) => id !== entry.id) : [...current, entry.id] });
    };
    heart.addEventListener('click', toggleFavourite);
    heart.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') toggleFavourite(event); });
    button.append(img, heart);
    // Picking a particular wallpaper means wanting THAT one.
    button.addEventListener('click', () => update({ background: 'wallpaper', backgroundValue: entry.id, wallpaperMode: 'fixed' }));
    return button;
  };

  const special = (id, label, glyph, onClick) => {
    const button = ctx.element('button', { class: 'studio-thumb is-special', 'data-special': id }, [
      ctx.icon(glyph, { size: 20 }), ctx.element('span', { text: label }),
    ]);
    button.addEventListener('click', onClick);
    return button;
  };

  const paintGallery = () => {
    const favourites = settingsOf().wallpaperFavourites || [];
    const shown = data.wallpapers.filter((w) =>
      filter === 'all' || (filter === 'favourites' ? favourites.includes(w.id) : w.category === filter));
    const extras = filter === 'all' ? [
      special('none', 'No wallpaper', 'close', () => update({ background: 'plain', backgroundValue: '', wallpaperMode: 'fixed' })),
      special('photo', 'Your own photo…', 'import', async (event) => {
        const label = event.currentTarget.querySelector('span');
        const result = await ctx.invoke('newtab:wallpaper').catch((error) => ({ error }));
        if (result?.error) label.textContent = String(result.error.message).slice(0, 24);
      }),
    ] : [];
    const empty = filter === 'favourites' && !shown.length
      ? [ctx.element('p', { class: 'studio-empty', text: 'Tap the heart on any wallpaper to keep it here.' })]
      : [];
    gallery.replaceChildren(...extras, ...shown.map(tile), ...empty);
    refresh();
  };

  const paintPills = () => {
    const favourites = settingsOf().wallpaperFavourites || [];
    const entries = [
      { id: 'all', label: 'All', count: data.wallpapers.length },
      { id: 'favourites', label: '♥ Favourites', count: favourites.length },
      ...data.categories.map((c) => ({ id: c.id, label: c.name, count: c.count })),
    ];
    pills.replaceChildren(...entries.map((entry) => {
      const pill = ctx.element('button', { class: 'studio-pill', role: 'tab', 'data-id': entry.id, 'aria-selected': String(entry.id === filter) }, [
        ctx.element('span', { text: entry.label }), ctx.element('em', { text: String(entry.count) }),
      ]);
      pill.addEventListener('click', () => {
        filter = entry.id;
        remember('filter', filter);
        // In a random mode the pill you are on is also what it draws from.
        if (settingsOf().wallpaperMode !== 'fixed') update({ wallpaperPool: filter });
        paintPills();
        paintGallery();
      });
      return pill;
    }));
  };

  catalog(ctx).then((result) => {
    data = result || data;
    if (filter !== 'all' && filter !== 'favourites' && !data.categories.some((c) => c.id === filter)) filter = 'all';
    paintPills();
    paintGallery();
  });

  // ---- widgets pane ----
  const widgetsPane = ctx.element('section', { class: 'studio-pane' });
  panes.widgets = widgetsPane;
  const size = segmented(ctx, SIZES, settingsOf().widgetSize || 'comfortable', (id) => update({ widgetSize: id }));
  const list = ctx.element('div', { class: 'studio-widgets' });
  const tidy = ctx.element('button', { class: 'studio-action', text: 'Tidy up: put every widget back at the sides' });
  tidy.addEventListener('click', () => update({ positions: {} }));
  widgetsPane.append(
    ctx.element('p', { class: 'studio-hint is-lead', text: 'Drag any widget anywhere on the page: top, bottom, either side or the middle. Outside this panel, grab a widget by the dots in its corner.' }),
    ctx.element('div', { class: 'studio-label', text: 'Size' }), size,
    ctx.element('div', { class: 'studio-label', text: 'On the page' }), list, tidy);

  const paintWidgets = () => {
    const layout = getLayout();
    list.replaceChildren(...Object.values(registry).map((widget) => {
      const on = layout.includes(widget.id);
      const row = ctx.element('button', { class: 'studio-widget' + (on ? ' is-on' : ''), role: 'switch', 'aria-checked': String(on) }, [
        ctx.element('span', { class: 'studio-widget-icon' }, [ctx.icon(widget.icon || 'grid', { size: 16 })]),
        ctx.element('span', { class: 'studio-widget-text' }, [
          ctx.element('strong', { text: widget.name }),
          ctx.element('span', { text: widget.description || '' }),
        ]),
        ctx.element('span', { class: 'studio-switch', 'aria-hidden': 'true' }),
      ]);
      row.addEventListener('click', () => {
        const next = getLayout();
        setLayout(on ? next.filter((id) => id !== widget.id) : [...next, widget.id]);
      });
      return row;
    }));
  };

  // ---- layouts pane ----
  const layoutsPane = ctx.element('section', { class: 'studio-pane' });
  panes.layouts = layoutsPane;
  const presetGrid = ctx.element('div', { class: 'studio-presets' });
  for (const [id, preset] of Object.entries(PRESETS)) {
    const dots = ctx.element('span', { class: 'studio-preset-map', 'aria-hidden': 'true' },
      preset.widgets.map((w, i) => {
        const dot = ctx.element('i');
        dot.style.setProperty('--i', String(i));
        dot.classList.add(w === 'clock' ? 'is-clock' : i % 2 ? 'is-left' : 'is-right');
        return dot;
      }));
    const button = ctx.element('button', { class: 'studio-preset', 'data-preset': id }, [
      dots, ctx.element('strong', { text: preset.name }), ctx.element('span', { text: preset.blurb }),
    ]);
    button.addEventListener('click', () => { setLayout([...preset.widgets]); update({ positions: {} }); });
    presetGrid.append(button);
  }
  const reset = ctx.element('button', { class: 'studio-action', text: 'Back to the default layout' });
  reset.addEventListener('click', () => {
    setLayout([...((window.widgets && window.widgets.DEFAULT_LAYOUT) || ['clock'])]);
    update({ positions: {} });
  });
  layoutsPane.append(presetGrid, reset);

  panel.append(wallpaperPane, widgetsPane, layoutsPane);

  /** Reflect the current settings without rebuilding anything. */
  function refresh() {
    const tab = settingsOf();
    mode.select(tab.wallpaperMode || 'fixed');
    size.select(tab.widgetSize || 'comfortable');
    const pool = tab.wallpaperPool || 'all';
    const poolName = pool === 'all' ? 'every category' : pool === 'favourites' ? 'your favourites'
      : (data.categories.find((c) => c.id === pool)?.name || pool);
    const chosen = MODES.find((m) => m.id === (tab.wallpaperMode || 'fixed'));
    modeHint.textContent = chosen.hint + (chosen.id === 'fixed' ? '' : ' Drawing from ' + poolName + ' - pick a category below to change it.');
    const favourites = tab.wallpaperFavourites || [];
    const active = tab.background === 'wallpaper' ? (tab.wallpaperMode === 'fixed' ? tab.backgroundValue : '') : '';
    for (const node of gallery.querySelectorAll('.studio-thumb[data-id]')) {
      node.classList.toggle('is-chosen', node.dataset.id === active);
      node.classList.toggle('is-favourite', favourites.includes(node.dataset.id));
    }
    for (const node of gallery.querySelectorAll('[data-special]')) {
      node.classList.toggle('is-chosen',
        (node.dataset.special === 'none' && (tab.background || 'plain') === 'plain') ||
        (node.dataset.special === 'photo' && tab.background === 'photo'));
    }
    const favouritesPill = pills.querySelector('[data-id="favourites"] em');
    if (favouritesPill) favouritesPill.textContent = String(favourites.length);
    const current = data.wallpapers.find((w) => w.id === (window.currentWallpaperId || active));
    credit.textContent = current
      ? 'Now showing a photo by ' + current.credit.by + ' on ' + current.credit.source + '.'
      : 'Photos from Unsplash, Pexels and Pixabay, credited on the licences page.';
    paintWidgets();
  }

  show(recall('pane', 'wallpaper'));
  panel.refresh = () => {
    // A favourite added while filtered to favourites has to appear.
    if (filter === 'favourites') paintGallery();
    else refresh();
  };
  return panel;
}

RENDERERS.__customise = { build, PRESETS };

})();
