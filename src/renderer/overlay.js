'use strict';

/**
 * Menu overlay renderer.
 *
 * Menus live here rather than in the chrome view because they are taller than
 * the chrome strip and would otherwise be clipped by it. This view spans the
 * whole window and floats above both the chrome and the page.
 *
 * The chrome sends a serialisable menu description (labels, icons, shortcuts,
 * and an `action` per item) over IPC; functions cannot cross that boundary, so
 * selecting an item sends the action back rather than invoking a callback.
 */
(function () {

const invoke = (channel, payload) => window.browser.invoke(channel, payload)
  .catch((error) => console.error(channel, error));

let state = { settings: {} };
let appliedTheme = '';

function applyTheme(settings) {
  const key = JSON.stringify(window.theme.cssVariables(settings));
  if (key === appliedTheme) return;
  appliedTheme = key;
  for (const [name, value] of Object.entries(window.theme.cssVariables(settings))) {
    document.documentElement.style.setProperty(name, value);
  }
}

/**
 * Tell main whether to route mouse events here. While no menu is open the
 * overlay must be click-through, or it would swallow every click meant for the
 * toolbar or the page underneath.
 */
function setInteractive(open) {
  invoke('menu:state', { open });
}

/** Turn a serialised item into one the menu builder can use. */
function hydrate(item) {
  // The brand row carries an action too (switch profile), so it is given the
  // same treatment rather than passed through untouched.
  if (item && item.brand && item.profile && item.profile.action) {
    const act = item.profile.action;
    return {
      ...item,
      profile: {
        ...item.profile,
        onOpen: () => { setInteractive(false); invoke(act.channel, act.payload); },
      },
    };
  }
  if (item && item.field && item.field.action) {
    const act = item.field.action;
    return {
      ...item,
      // Main answers { ok: false, error } to keep the menu open with a reason.
      onSubmit: (value) => window.browser.invoke(act.channel, { ...act.payload, value })
        .catch((error) => ({ ok: false, error: String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })),
    };
  }
  // Colours keep the menu open: each one just sends its action.
  if (item && item.swatches) {
    return {
      ...item,
      swatches: item.swatches.map((swatch) => ({
        ...swatch,
        onSelect: () => { if (swatch.action) invoke(swatch.action.channel, swatch.action.payload); },
      })),
    };
  }
  // The tab search list sends its rows' actions itself, and needs main's
  // answer back (closing a tab answers with the list as it now is).
  if (item && item.tabsearch) {
    return { ...item, run: (act) => (act ? invoke(act.channel, act.payload) : Promise.resolve(null)) };
  }
  if (!item || item.separator || item.heading || item.brand) return item;
  // "Add tab to group": its menu opens the next one in the same place. The
  // overlay stays up for it; if no menu follows, it steps aside after all.
  if (item.more && item.action) {
    return {
      ...item,
      onSelect: () => {
        const settle = () => { if (!window.ui.menuIsOpen()) setInteractive(false); };
        invoke(item.action.channel, item.action.payload).then((shown) => { if (!shown) settle(); });
        setTimeout(settle, 1500);
      },
    };
  }
  if (item.zoom) {
    return { ...item, zoom: { ...item.zoom, in: hydrate(item.zoom.in), out: hydrate(item.zoom.out), full: hydrate(item.zoom.full) } };
  }
  return {
    ...item,
    choices: item.choices?.map(hydrate),
    tiles: item.tiles?.map(hydrate),
    footer: item.footer?.map(hydrate),
    onSelect: () => {
      setInteractive(false);
      if (item.action) invoke(item.action.channel, item.action.payload);
    },
  };
}

/**
 * Wait, briefly, for this view's viewport to reach the size main has just
 * given it. Usually it already has; but straight after a tab's hover card
 * the view goes lane, corner, whole window in quick succession, and a menu
 * placed against a size that is about to change is closed by the resize
 * that follows (ui.js dismisses a menu whose window really changed size).
 */
async function settled(size) {
  if (!size || !size.width) return;
  for (let i = 0; i < 15 && (window.innerWidth !== size.width || window.innerHeight !== size.height); i++) {
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
}

/** True while one menu is being swapped for another. */
let replacing = false;

/** Draw a menu from a request, if there is one. */
async function renderMenu(payload) {
  const items = (payload?.items || []).map(hydrate);
  if (!items.length) { window.ui.closeMenu(); return; }
  // A menu and a tab's hover card never share the overlay.
  window.tabPreview?.hide();
  // Dismiss first, quietly: a menu being REPLACED has not been closed, and
  // telling main it had would both shrink the overlay under the replacement
  // and answer a question main has only just asked (see #prompt).
  replacing = true;
  try { window.ui.closeMenu(); } finally { replacing = false; }

  // Size the overlay to the window BEFORE building the menu, and wait for that
  // to land: a 1x1 view has nowhere to paint a menu.
  const passive = !!payload.passive;
  await settled(await invoke('menu:state', { open: true, passive }));

  window.ui.menu(items, {
    anchor: payload.anchor,
    align: payload.align || 'left',
    passive,
    onClose: (how) => { if (!replacing && !how?.handoff) setInteractive(false); },
    onOutside: (event) => invoke('menu:passthrough', { x: event.clientX, y: event.clientY, button: event.button === 2 ? 'right' : 'left' }),
  });
}

// Two delivery paths, because a `webContents.send` issued while this view is
// mid-commit is silently dropped: the push below is the fast path, and the
// poll underneath catches anything that was dropped.
window.browser.on('ui:render-menu', () => {
  invoke('menu:pending').then((payload) => { if (payload) renderMenu(payload); });
});

setInterval(() => {
  if (window.ui.menuIsOpen()) return;
  invoke('menu:pending').then((payload) => { if (payload) renderMenu(payload); });
}, 120);

// The down arrow in a field whose suggestions are showing.
window.browser.on('ui:menu-focus', () => window.ui.focusMenu());

window.browser.on('app:state', (next) => {
  state = next;
  applyTheme(state.settings || {});
});

invoke('app:state').then((next) => {
  if (next) { state = next; applyTheme(state.settings || {}); }
});

// Start click-through; a menu turns this on only while it is open.
setInteractive(false);

// Tell main the listeners above are live; it hands back any menu that was
// requested while this view was still loading.
invoke('menu:ready').then((payload) => { if (payload) renderMenu(payload); });

})();
