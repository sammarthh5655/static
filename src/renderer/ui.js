'use strict';

/**
 * Shared UI primitives for the browser chrome: icons and the custom menu
 * system. No native Electron Menu is used anywhere in this app, so everything
 * here is ordinary DOM that we style and position ourselves.
 *
 * Loaded as a classic script, so the whole file is an IIFE that publishes a
 * single `window.ui` - see the note in renderer/pages/common.js about why.
 */
(function () {

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Build an icon. Outline by default; `filled` swaps in the solid variant where
 * one exists. Both variants share a 24x24 viewBox, so swapping on hover never
 * shifts layout.
 */
function icon(name, { filled = false, size = 18 } = {}) {
  const spec = window.theme.ICONS[name];
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon-svg');
  if (!spec) return svg;

  const path = document.createElementNS(SVG_NS, 'path');
  const useFill = filled && spec.fill;
  path.setAttribute('d', useFill ? spec.fill : spec.outline);
  path.setAttribute('fill', useFill ? 'currentColor' : 'none');
  path.setAttribute('stroke', useFill ? 'none' : 'currentColor');
  path.setAttribute('stroke-width', '1.7');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

/**
 * A button with an icon that fills on hover/active. Both variants are rendered
 * and CSS toggles between them, so there is no work on the hover event itself.
 */
function iconButton(name, { title, onClick, className = '', size = 18 } = {}) {
  const button = document.createElement('button');
  button.className = ('icon-btn ' + className).trim();
  if (title) button.title = title;
  button.type = 'button';
  button.append(icon(name, { size }), icon(name, { size, filled: true }));
  button.firstChild.classList.add('icon-outline');
  button.lastChild.classList.add('icon-filled');
  if (onClick) button.addEventListener('click', onClick);
  return button;
}

/* ---- menus ---------------------------------------------------------------
 * One menu is open at a time. The open menu is tracked here rather than in
 * each caller so that opening a second menu, clicking away, pressing Escape
 * or resizing all close the first one through the same path.
 */

let openMenu = null;

/**
 * @typedef {object} MenuItem
 * @property {string}  [label]     item text; omit for a separator
 * @property {boolean} [separator] render a divider instead of an item
 * @property {string}  [icon]      icon name from the theme icon set
 * @property {string}  [shortcut]  right-aligned accelerator text
 * @property {boolean} [checked]   show a check mark
 * @property {boolean} [disabled]
 * @property {string}  [danger]    style as a destructive action
 * @property {Function}[onSelect]
 */

/**
 * Open a menu anchored to a rectangle (usually a button's bounding box).
 *
 * `align` picks which corner of the anchor the menu hangs from. The menu is
 * then clamped to the viewport, because the chrome view is only as tall as the
 * browser chrome - a menu that overflows it would be clipped, not scrolled.
 */
function menu(items, { anchor, align = 'left', onClose } = {}) {
  closeMenu();
  // Drop any menu still playing its close animation, so only one menu node is
  // ever in the document.
  document.querySelectorAll('.menu-ghost').forEach((node) => node.remove());

  const root = document.createElement('div');
  root.className = 'menu';
  root.setAttribute('role', 'menu');
  root.setAttribute('aria-label', 'Browser menu');
  if (items.some(item => item?.brand)) root.classList.add('browser-menu');

  for (const item of items) {
    if (item?.brand) {
      const header = document.createElement('div');
      header.className = 'menu-brand';
      const mark = document.createElement('img');
      mark.src = 'assets/static-mark.svg';
      mark.alt = '';
      const text = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = 'Static';
      const subtitle = document.createElement('span');
      // The brand row was two lines of decoration at the top of every menu.
      // It now carries the one thing worth having there: which profile you
      // are in, and a way to change it.
      subtitle.textContent = item.profile
        ? item.profile.name + ' · switch profile'
        : 'Browse smarter with AI.';
      text.append(title, subtitle);
      if (item.profile) {
        text.className = 'menu-brand-profile';
        text.setAttribute('role', 'button');
        text.setAttribute('tabindex', '0');
        text.title = 'Choose a different profile';
        // onOpen is attached by the overlay when it hydrates the item; the
        // payload that crossed IPC carried only data.
        const open = () => { closeMenu(); item.profile.onOpen?.(); };
        text.addEventListener('click', open);
        text.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
        });
      }
      const dismiss = iconButton('close', { title: 'Close menu', onClick: closeMenu, size: 16 });
      header.append(mark, text, dismiss);
      root.append(header);
      continue;
    }
    if (!item || item.separator) {
      const divider = document.createElement('div');
      divider.className = 'menu-divider';
      root.append(divider);
      continue;
    }

    // A grid of big glowing tiles for the things people do most.
    if (item.tiles) {
      const grid = document.createElement('div');
      grid.className = 'menu-tiles';
      item.tiles.forEach((tile, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'menu-tile';
        button.setAttribute('role', 'menuitem');
        button.style.setProperty('--i', String(index));
        button.style.setProperty('--hue', String((index * 37) % 360));
        button.title = tile.shortcut ? tile.label + ' (' + tile.shortcut + ')' : tile.label;
        const plate = document.createElement('span');
        plate.className = 'menu-tile-plate';
        plate.append(icon(tile.icon, { size: 20 }));
        const name = document.createElement('span');
        name.className = 'menu-tile-label';
        name.textContent = tile.label;
        button.append(plate, name);
        button.addEventListener('click', () => { closeMenu(); tile.onSelect?.(); });
        grid.append(button);
      });
      root.append(grid);
      continue;
    }

    // Zoom, the way every browser menu shows it: minus, the level, plus,
    // and full screen, on one line that does not close the menu.
    if (item.zoom) {
      const row = document.createElement('div');
      row.className = 'menu-zoom';
      const label = document.createElement('span');
      label.textContent = 'Zoom';
      const level = document.createElement('output');
      level.textContent = Math.round((item.zoom.level || 1) * 100) + '%';
      const step = (target, delta) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = delta;
        b.title = target.label;
        b.addEventListener('click', () => {
          target.onSelect?.();
          const next = delta === '+' ? item.zoom.level * 1.1 : item.zoom.level / 1.1;
          item.zoom.level = Math.min(5, Math.max(0.25, next));
          level.textContent = Math.round(item.zoom.level * 100) + '%';
        });
        return b;
      };
      const full = document.createElement('button');
      full.type = 'button';
      full.className = 'menu-zoom-full';
      full.title = 'Full screen';
      full.append(icon('window_maximize', { size: 15 }));
      full.addEventListener('click', () => { closeMenu(); item.zoom.full?.onSelect?.(); });
      row.append(label, step(item.zoom.out, '−'), level, step(item.zoom.in, '+'), full);
      root.append(row);
      continue;
    }

    // Small links along the bottom: help, about, exit.
    if (item.footer) {
      const row = document.createElement('div');
      row.className = 'menu-footer';
      for (const link of item.footer) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = link.danger ? 'danger' : '';
        b.textContent = link.label;
        b.addEventListener('click', () => { closeMenu(); link.onSelect?.(); });
        row.append(b);
      }
      root.append(row);
      continue;
    }

    if (item.choices) {
      const row = document.createElement('div');
      row.className = 'menu-segment-row';
      row.title = item.hint || item.label;
      row.append(icon(item.icon, { size: 20 }));
      const label = document.createElement('span');
      label.textContent = item.label;
      const choices = document.createElement('div');
      choices.className = 'menu-segment';
      choices.setAttribute('role', 'group');
      choices.setAttribute('aria-label', item.hint || item.label);
      for (const choice of item.choices) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = choice.label;
        button.setAttribute('role', 'menuitemradio');
        button.setAttribute('aria-checked', String(choice.value === item.value));
        button.addEventListener('click', () => { closeMenu(); choice.onSelect?.(); });
        choices.append(button);
      }
      row.append(label, choices);
      root.append(row);
      continue;
    }
    // A secret typed into the menu itself - the master password when a login
    // is chosen while the vault is locked. The menu stays open until main
    // answers, and shows why if the answer is no.
    if (item.field) {
      const form = document.createElement('form');
      form.className = 'menu-field';
      const lockGlyph = document.createElement('span');
      lockGlyph.className = 'menu-field-glyph';
      lockGlyph.append(icon(item.icon || 'lock', { size: 15 }));
      const input = document.createElement('input');
      input.type = item.field.type || 'password';
      input.placeholder = item.field.placeholder || '';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.setAttribute('aria-label', item.field.placeholder || item.label || 'Password');
      const go = document.createElement('button');
      go.type = 'submit';
      go.className = 'menu-field-go';
      go.textContent = item.field.button || 'OK';
      const error = document.createElement('div');
      error.className = 'menu-field-error';
      error.setAttribute('role', 'alert');
      if (item.field.error) error.textContent = item.field.error;
      form.append(lockGlyph, input, go, error);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!input.value || go.disabled) return;
        go.disabled = true;
        form.classList.add('is-busy');
        error.textContent = '';
        const result = await item.onSubmit?.(input.value);
        go.disabled = false;
        form.classList.remove('is-busy');
        if (result && result.ok === false) {
          error.textContent = result.error || 'That did not work.';
          input.select();
          form.classList.remove('is-wrong');
          void form.offsetWidth;
          form.classList.add('is-wrong');
          return;
        }
        closeMenu();
      });
      root.append(form);
      continue;
    }
    if (item.heading) {
      const heading = document.createElement('div');
      heading.className = 'menu-heading';
      heading.textContent = typeof item.heading === 'string' ? item.heading : item.label;
      root.append(heading);
      continue;
    }

    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'menu-item' + (item.danger ? ' danger' : '') + (item.checked ? ' checked' : '');
    node.setAttribute('role', typeof item.checked === 'boolean' ? 'menuitemcheckbox' : 'menuitem');
    if (typeof item.checked === 'boolean') node.setAttribute('aria-checked', String(item.checked));
    if (item.disabled) node.disabled = true;

    const glyph = document.createElement('span');
    glyph.className = 'menu-icon';
    if (item.checked) glyph.append(icon('check', { size: 15 }));
    else if (item.icon) {
      glyph.append(icon(item.icon, { size: 16 }), icon(item.icon, { size: 16, filled: true }));
      glyph.firstChild.classList.add('icon-outline');
      glyph.lastChild.classList.add('icon-filled');
    }
    node.append(glyph);

    const label = document.createElement('span');
    label.className = 'menu-label';
    label.textContent = item.label;
    // A hint says what the item is for, under its name.
    if (item.hint) {
      const hint = document.createElement('small');
      hint.className = 'menu-hint';
      hint.textContent = item.hint;
      label.append(hint);
      node.classList.add('has-hint');
    }
    node.append(label);

    if (item.shortcut) {
      const accel = document.createElement('span');
      accel.className = 'menu-shortcut';
      accel.textContent = item.shortcut;
      node.append(accel);
    }

    if (!item.disabled) {
      node.addEventListener('click', () => {
        closeMenu();
        item.onSelect?.();
      });
    }
    root.append(node);
  }

  document.body.append(root);

  // Position after insertion so the menu has real dimensions to clamp against.
  const box = root.getBoundingClientRect();
  const margin = 8;
  let left = align === 'right' ? anchor.right - box.width : anchor.left;
  let top = anchor.bottom + 4;
  left = Math.max(margin, Math.min(left, window.innerWidth - box.width - margin));
  if (top + box.height > window.innerHeight - margin) {
    // Flip above the anchor when there is no room below.
    top = anchor.top - box.height - 4;
  }
  // Clamp after flipping: a menu taller than the space on either side would
  // otherwise sit partly off-screen. Its own max-height makes it scroll.
  top = Math.max(margin, Math.min(top, window.innerHeight - box.height - margin));
  if (box.height > window.innerHeight - margin * 2) top = margin;
  root.style.left = Math.round(left) + 'px';
  root.style.top = Math.round(top) + 'px';

  // No class toggle is needed to open: the .menu rule runs its open animation
  // on insertion, and `animation-fill-mode: both` guarantees it settles on the
  // final frame even if the view was not composited while it played.
  root.classList.add('open');

  openMenu = { root, onClose, width: window.innerWidth, height: window.innerHeight };
  (root.querySelector('.menu-field input') || root.querySelector('.menu-item:not(:disabled)'))?.focus({ preventScroll: true });
  return root;
}

function closeMenu() {
  if (!openMenu) return;
  const { root, onClose } = openMenu;
  openMenu = null;

  // Drop the `menu` class straight away so a closing node can never be picked
  // up as the current menu by anything querying the DOM. It keeps `menu-ghost`
  // purely to play the exit animation, and is removed once that is done.
  //
  // This matters because the exit animation uses `both` fill, which pins the
  // element at opacity 0 - if that node were still matched as `.menu`, it
  // would look exactly like a menu that failed to open.
  root.classList.remove('menu', 'open');
  root.classList.add('menu-ghost');
  root.setAttribute('aria-hidden', 'true');
  onClose?.();

  // Remove once the close animation has played; the duration comes from the
  // theme and is 0ms when the user has turned animations off.
  const ms = parseInt(getComputedStyle(document.documentElement)
    .getPropertyValue('--motion-base'), 10) || 0;
  setTimeout(() => root.remove(), ms + 20);
}

function menuIsOpen() { return !!openMenu; }

/** Anchor helper: the bounding box of an element. */
function anchorOf(element) {
  return element.getBoundingClientRect();
}

/** Anchor helper: a zero-size box at the pointer, for context menus. */
function anchorAt(x, y) {
  return { left: x, right: x, top: y, bottom: y, width: 0, height: 0 };
}

// Global dismissal. Pointerdown rather than click so the menu closes before a
// click lands on whatever is underneath it.
document.addEventListener('pointerdown', (event) => {
  if (openMenu && !openMenu.root.contains(event.target)) closeMenu();
}, true);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && openMenu) {
    event.preventDefault();
    closeMenu();
    return;
  }
  // Arrow keys belong to a text box while one has focus.
  const typing = event.target instanceof HTMLInputElement && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key);
  if (openMenu && !typing && ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab'].includes(event.key)) {
    event.preventDefault();
    const buttons = [...openMenu.root.querySelectorAll('input, button:not(:disabled)')];
    let index = buttons.indexOf(document.activeElement);
    const step = event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey) ? -1 : 1;
    if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = buttons.length - 1;
    else index = (index + step + buttons.length) % buttons.length;
    buttons[index]?.focus();
  }
});

window.addEventListener('resize', () => {
  // Native view resizing can deliver its event after the menu has already
  // measured the new viewport. Ignore that late notification; only an actual
  // change from the dimensions used to place this menu should dismiss it.
  if (openMenu && (openMenu.width !== window.innerWidth || openMenu.height !== window.innerHeight)) closeMenu();
});
window.addEventListener('blur', closeMenu);

window.ui = { icon, iconButton, menu, closeMenu, menuIsOpen, anchorOf, anchorAt };

})();
