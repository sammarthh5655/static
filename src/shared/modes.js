// Wrapped in an IIFE: this file is also loaded as a plain <script> tag, and
// classic scripts share one global scope.
(function () {
// Mode registry.
//
// One declaration per feature mode. The dashboard cards, the sidebar, the
// command bar and the menu all build themselves from this list, so adding a
// mode means adding an entry here and a page - no other surface needs editing.
//
// Required by main (to validate settings and route pages) and loaded as a
// plain script by renderers, so it must stay free of Electron and Node imports.

const MODES = {
  organizer: { id: 'organizer', name: 'Organizer', tagline: 'Find clarity in your open tabs', icon: 'grid',
    page: 'browser://organizer', group: 'productivity', order: 3.1 },
  screentime: { id: 'screentime', name: 'Screen Time', tagline: 'Make room for what matters', icon: 'clock',
    page: 'browser://screentime', group: 'productivity', order: 3.2 },
  dashboard: {
    id: 'dashboard',
    name: 'Dashboard',
    tagline: 'Everything in one place',
    icon: 'grid',
    page: 'browser://dashboard',
    group: 'core',
    order: 0,
  },
  ai: {
    id: 'ai',
    name: 'AI',
    tagline: 'Ask Gemini, keep the conversation',
    icon: 'sparkle',
    page: 'browser://ai',
    group: 'core',
    order: 1,
  },
  notes: {
    id: 'notes',
    name: 'Notes',
    tagline: 'Capture anything from any page',
    icon: 'bookmark',
    page: 'browser://notes',
    group: 'productivity',
    order: 2,
  },
  focus: {
    id: 'focus',
    name: 'Focus',
    tagline: 'Block distractions, keep YouTube',
    icon: 'clock',
    page: 'browser://focus',
    group: 'productivity',
    order: 3,
  },
  student: {
    id: 'student',
    name: 'Student',
    tagline: 'Summarise, quiz, revise',
    icon: 'bookmark',
    page: 'browser://student',
    group: 'work',
    order: 4,
  },
  legal: {
    id: 'legal',
    name: 'Legal',
    tagline: 'Indian legal research and drafting',
    icon: 'bookmark',
    page: 'browser://legal',
    group: 'work',
    order: 5,
  },
  shopping: {
    id: 'shopping',
    name: 'Shopping',
    tagline: 'Compare products side by side',
    icon: 'search',
    page: 'browser://shopping',
    group: 'work',
    order: 6,
  },
  resources: {
    id: 'resources',
    name: 'Resources',
    tagline: 'Memory, CPU and Game Mode',
    icon: 'gear',
    page: 'browser://resources',
    group: 'system',
    order: 7,
  },
  shields: {
    id: 'shields',
    name: 'Shields',
    tagline: 'Block ads and trackers',
    icon: 'lock',
    page: 'browser://shields',
    group: 'system',
    order: 8,
  },
  passwords: {
    id: 'passwords',
    name: 'Passwords',
    tagline: 'Saved logins, encrypted by your OS',
    icon: 'lock',
    page: 'browser://passwords',
    group: 'system',
    order: 9,
  },
  autofill: {
    id: 'autofill',
    name: 'Autofill',
    tagline: 'Addresses, cards, IDs and more',
    icon: 'user',
    page: 'browser://autofill',
    group: 'system',
    order: 9.5,
  },
  health: {
    id: 'health',
    name: 'Health',
    tagline: 'Performance, privacy, security and storage',
    icon: 'gear',
    page: 'browser://health',
    group: 'system',
    order: 11,
  },
  safety: {
    id: 'safety',
    name: 'Safety',
    tagline: 'Warn about fake and risky sites',
    icon: 'lock',
    page: 'browser://safety',
    group: 'system',
    order: 10,
  },
};

/** Section headings for the sidebar, in display order. */
const GROUPS = [
  { id: 'core', name: 'Core' },
  { id: 'productivity', name: 'Focus' },
  { id: 'work', name: 'Work' },
  { id: 'system', name: 'System' },
];

/** Modes in display order. */
function orderedModes() {
  return Object.values(MODES).sort((a, b) => a.order - b.order);
}

/** browser://<page> -> mode id, for highlighting the active sidebar entry. */
function modeForPage(page) {
  const found = Object.values(MODES).find((mode) => mode.page === page ||
    mode.page === `browser://${page}`);
  return found ? found.id : null;
}

const shared = { MODES, GROUPS, orderedModes, modeForPage };

if (typeof module !== 'undefined' && module.exports) module.exports = shared;
if (typeof window !== 'undefined') window.modes = shared;

})();
