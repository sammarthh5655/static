// Keyboard shortcuts.
//
// There is no native Menu in this app, so Electron's accelerator system is not
// available. Instead main listens to `before-input-event` on every tab and on
// the chrome, which fires BEFORE the key reaches page content. That matters:
// it means Ctrl+T works while focus is inside google.com, and a web page
// cannot swallow our shortcuts by calling preventDefault itself.
//
// The display strings here are also what the custom menus render right-aligned
// next to each item, so the menu and the actual binding can never drift apart.

const isMac = process.platform === 'darwin';

/**
 * @typedef {object} Accelerator
 * @property {string} id       action id, dispatched by application.js
 * @property {string} label    human-readable name (used in menus)
 * @property {string} display  what the menu shows, e.g. "Ctrl+T"
 * @property {object} match    key/modifier test applied to an input event
 */

/** `mod` means Cmd on macOS, Ctrl everywhere else. */
function accel(id, label, key, { mod = false, shift = false, alt = false } = {}) {
  const parts = [];
  if (mod) parts.push(isMac ? 'Cmd' : 'Ctrl');
  if (alt) parts.push(isMac ? 'Opt' : 'Alt');
  if (shift) parts.push('Shift');
  parts.push(key.length === 1 ? key.toUpperCase() : key);
  return { id, label, display: parts.join('+'), match: { key, mod, shift, alt } };
}

const ACCELERATORS = [
  accel('tab:new', 'New tab', 't', { mod: true }),
  accel('tab:close', 'Close tab', 'w', { mod: true }),
  accel('tab:next', 'Next tab', 'Tab', { mod: !isMac, alt: isMac }),
  accel('tab:previous', 'Previous tab', 'Tab', { mod: !isMac, alt: isMac, shift: true }),
  accel('tab:reopen', 'Reopen closed tab', 't', { mod: true, shift: true }),

  // Ctrl+J is Downloads in every browser, so the sidebar has its own key.
  accel('sidebar:toggle', 'AI sidebar', '.', { mod: true }),
  accel('window:incognito', 'New incognito window', 'n', { mod: true, shift: true }),
  ...Array.from({ length: 9 }, (_, i) => accel('tab:' + (i + 1), i === 8 ? 'Last tab' : 'Tab ' + (i + 1), String(i + 1), { mod: true })),
  accel('tab:next', 'Next tab', 'PageDown', { mod: true }),
  accel('tab:previous', 'Previous tab', 'PageUp', { mod: true }),

  accel('omnibox:focus', 'Focus address bar', 'l', { mod: true }),
  accel('omnibox:focus', 'Search', 'k', { mod: true }),
  accel('omnibox:focus', 'Search', 'e', { mod: true }),
  ...(isMac ? [] : [accel('omnibox:focus', 'Focus address bar', 'd', { alt: true }), accel('omnibox:focus', 'Focus address bar', 'F6', {})]),
  accel('page:reload', 'Reload', 'r', { mod: true }),
  accel('page:reload', 'Reload', 'F5', {}),
  accel('page:reload-hard', 'Reload without cache', 'r', { mod: true, shift: true }),
  accel('page:reload-hard', 'Reload without cache', 'F5', { mod: true }),
  accel('page:reload-hard', 'Reload without cache', 'F5', { shift: true }),
  accel('find:open', 'Find in page', 'f', { mod: true }),
  accel('find:open', 'Find in page', 'F3', {}),
  accel('find:open', 'Find in page', 'g', { mod: true }),
  accel('page:save', 'Save page as', 's', { mod: true }),
  accel('page:print', 'Print', 'p', { mod: true }),
  accel('page:source', 'View page source', 'u', { mod: true }),
  accel('page:zoom-in', 'Zoom in', '=', { mod: true }),
  accel('page:zoom-in', 'Zoom in', '+', { mod: true }),
  accel('page:zoom-in', 'Zoom in', '+', { mod: true, shift: true }),
  accel('page:zoom-out', 'Zoom out', '-', { mod: true }),
  accel('page:zoom-out', 'Zoom out', '_', { mod: true, shift: true }),
  accel('page:zoom-reset', 'Actual size', '0', { mod: true }),
  ...(isMac ? [] : [accel('window:fullscreen', 'Full screen', 'F11', {})]),
  accel('data:clear', 'Clear browsing data', 'Delete', { mod: true, shift: true }),
  accel('page:stop', 'Stop', 'Escape', {}),
  accel('page:back', 'Back', 'ArrowLeft', isMac ? { mod: true } : { alt: true }),
  accel('page:forward', 'Forward', 'ArrowRight', isMac ? { mod: true } : { alt: true }),
  accel('page:home', 'Home', 'Home', { alt: true }),

  accel('bookmarks:toggle', 'Bookmark this page', 'd', { mod: true }),
  accel('open:bookmarks', 'Bookmarks', 'b', { mod: true, shift: true }),
  accel('open:history', 'History', 'h', { mod: true }),
  accel('open:history', 'History', 'y', { mod: true }),
  accel('open:downloads', 'Downloads', 'j', { mod: true }),
  accel('open:settings', 'Settings', ',', { mod: true }),
  accel('open:ai', 'AI chat', 'g', { mod: true, shift: true }),
  accel('open:dashboard', 'Dashboard', 'd', { mod: true, shift: true }),
  accel('open:notes', 'Notes', 'k', { mod: true, shift: true }),
  accel('open:focus', 'Focus mode', 'f', { mod: true, shift: true }),
  accel('open:organizer', 'Organise tabs', 'o', { mod: true, shift: true }),
  accel('open:screentime', 'Screen Time', 'u', { mod: true, shift: true }),
  accel('open:resources', 'Resources', 'p', { mod: true, shift: true }),
  accel('notes:capture', 'Save to notes', 's', { mod: true, shift: true }),
  accel('open:extensions', 'Extensions', 'e', { mod: true, shift: true }),

  accel('window:devtools', 'Toggle developer tools', 'F12', {}),
  accel('window:devtools', 'Toggle developer tools', 'i', isMac ? { mod: true, alt: true } : { mod: true, shift: true }),
  accel('window:console', 'JavaScript console', 'j', isMac ? { mod: true, alt: true } : { mod: true, shift: true }),
  accel('menu:main', 'Open menu', 'F10', {}),
];

/** Quick lookup for menus: ACCEL.get('tab:new').display === 'Ctrl+T' */
const ACCEL = new Map(ACCELERATORS.map((a) => [a.id, a]));

/**
 * Match an Electron `before-input-event` input object against the table.
 *
 * Only keyDown is considered, and the modifier test is exact: without that,
 * Ctrl+Shift+T would also fire the plain Ctrl+T action.
 *
 * @returns {string|null} the action id, or null if nothing matched
 */
function matchAccelerator(input) {
  if (input.type !== 'keyDown') return null;
  const mod = isMac ? input.meta : input.control;
  // On macOS, Ctrl is a separate modifier from Cmd and must not be held.
  const strayMod = isMac ? input.control : input.meta;
  if (strayMod) return null;

  for (const entry of ACCELERATORS) {
    const m = entry.match;
    if (input.key.toLowerCase() !== m.key.toLowerCase()) continue;
    if (!!m.mod !== !!mod) continue;
    if (!!m.shift !== !!input.shift) continue;
    if (!!m.alt !== !!input.alt) continue;
    return entry.id;
  }
  return null;
}

module.exports = { ACCELERATORS, ACCEL, matchAccelerator, isMac };
