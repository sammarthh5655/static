// Wrapped in an IIFE: these files are also loaded as plain <script> tags, and
// classic scripts share one global scope - two files with a top-level `const
// shared` would collide on any page that loads both.
(function () {
// New tab widget registry.
//
// A widget is declared here and implemented in renderer/pages/widgets/<id>.js.
// Adding one means: add an entry below, add the matching file, and it appears
// in the new tab customiser automatically - no changes to the page itself.
//
// Required by main (to validate settings) and loaded as a plain script by the
// new tab page, so it must stay free of Electron and Node imports.

/**
 * Widget declarations.
 *
 * `needsCredential` marks a widget that cannot run until the user supplies an
 * API key. The page renders those in a "needs setup" state rather than hiding
 * them, so the extension point is visible before any key exists. Nothing here
 * hardcodes a particular provider - `credentialKey` just names the settings
 * field the widget will read once that field is added.
 */
const WIDGETS = {
  clock: {
    id: 'clock',
    name: 'Clock',
    description: 'Current time and date.',
    icon: 'clock',
    size: 'small',
  },
  privacy: {
    id: 'privacy',
    name: 'Privacy',
    description: 'What Shields actually blocked, by day.',
    icon: 'lock',
    size: 'medium',
  },
  shortcuts: {
    id: 'shortcuts',
    name: 'Quick links',
    description: 'Your bookmarks, one click away.',
    icon: 'bookmark',
    size: 'medium',
  },
  reading: {
    id: 'reading',
    name: 'Reading queue',
    description: 'Saved links and sessions to come back to.',
    icon: 'bookmark',
    size: 'medium',
  },
  recent: {
    id: 'recent',
    name: 'Recently closed',
    description: 'Jump back into pages from your history.',
    icon: 'clock',
    size: 'medium',
  },
  downloads: {
    id: 'downloads',
    name: 'Recent downloads',
    description: 'The last few files you downloaded.',
    icon: 'download',
    size: 'medium',
  },
  notes: {
    id: 'notes',
    name: 'Scratchpad',
    description: 'Quick notes, shared with Notes and Auto Notes.',
    icon: 'bookmark',
    size: 'medium',
  },
  assistant: {
    id: 'assistant',
    name: 'AI assistant',
    description: 'Ask a question from the new tab page.',
    icon: 'sparkle',
    size: 'large',
    // Not yet usable: no key is configured, and no provider is wired up. The
    // widget renders a setup prompt until `settings.ai.apiKey` exists.
    needsCredential: true,
    credentialKey: 'ai.apiKey',
    experimental: true,
  },
};

/** Widgets shown on a fresh profile. Deliberately minimal: search + 2. */
const DEFAULT_LAYOUT = ['clock', 'privacy', 'shortcuts'];

/** New tab background treatments. */
const BACKGROUNDS = {
  plain: { id: 'plain', name: 'Plain' },
  gradient: { id: 'gradient', name: 'Gradient' },
  image: { id: 'image', name: 'Image URL', takesValue: true },
};

const shared = { WIDGETS, DEFAULT_LAYOUT, BACKGROUNDS };

if (typeof module !== 'undefined' && module.exports) module.exports = shared;
if (typeof window !== 'undefined') window.widgets = shared;

})();
