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
  if (!item || item.separator || item.heading || item.brand) return item;
  return {
    ...item,
    choices: item.choices?.map(hydrate),
    onSelect: () => {
      setInteractive(false);
      if (item.action) invoke(item.action.channel, item.action.payload);
    },
  };
}

/** Draw a menu from a request, if there is one. */
async function renderMenu(payload) {
  const items = (payload?.items || []).map(hydrate);
  // Dismiss first: otherwise the old menu's close callback can shrink the
  // native overlay after the replacement menu has already been opened.
  window.ui.closeMenu();
  if (!items.length) return;

  // Size the overlay to the window BEFORE building the menu, and wait for that
  // to land: a 1x1 view has nowhere to paint a menu.
  await invoke('menu:state', { open: true });

  window.ui.menu(items, {
    anchor: payload.anchor,
    align: payload.align || 'left',
    onClose: () => setInteractive(false),
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
