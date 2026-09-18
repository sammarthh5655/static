# Changelog

All notable changes to static are recorded here. This project will grow over
many sessions; add an entry for every feature or behaviour change.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

**AI (Gemini)**
- Gemini client in the main process; the API key never crosses an IPC boundary
  and is never present in renderer or page context
- AI search box on the new tab page: Enter searches, Tab switches to AI Mode,
  Enter then asks Gemini. Escape or Tab returns to search
- AI Mode is signalled by an accent border, an animated AI badge, an icon swap
  and a hint line, because a field that silently changes what Enter does is a
  trap
- Answer panel with copy button and follow-up suggestions
- Uses `-latest` model aliases rather than pinned ids, since Google retires
  specific versions; falls back to the lite model and backs off exponentially
  when the preferred model reports high demand
- The key is baked into the build and is not visible or editable in Settings,
  by request. It lives in `src/main/secure/keys.js`, which is gitignored; see
  `keys.example.js` for the security caveat on embedded keys

**Full customisation**
- Six font choices, adjustable base font size, and three density settings that
  scale type and spacing together
- Seven accent presets plus a custom hex accent, with the dim variant computed
  from it
- Per-widget overrides on the new tab page: background, text, accent and border
  colour, font, font size, corner radius, alignment, opacity and column span.
  Anything not overridden keeps following the global theme
- Every colour from a page is parsed before use, so an unparseable value is
  dropped rather than written through to CSS

**Custom window chrome**
- Frameless window with a title bar drawn entirely in the renderer
- Custom minimize / maximize / close buttons themed to the app, with the
  maximise glyph swapping to a restore glyph when the window is maximised
- Correct drag regions: the bar and the empty tab-strip area drag the window,
  every control opts out, and double-clicking the bar maximises

**Custom menu system (no native menus anywhere)**
- Every menu is DOM built in the renderer; `Menu.setApplicationMenu(null)`
  removes the default menu Electron would otherwise install
- Main menu grouped under LIBRARY / BROWSER headings with subtle dividers and
  the real accelerator right-aligned on each item
- Right-click menus for tabs and bookmarks
- Menus render in a dedicated transparent overlay view spanning the window, so
  they are never clipped by the chrome strip and float over page content
- Keyboard shortcuts moved to `before-input-event` interception in main, so
  they still fire while a web page has focus - verified against a live page

**Design system**
- `src/shared/theme.js` is the single source for colours, radius, blur, motion
  and the icon set; the chrome, the menu overlay and every internal page build
  their CSS variables from it
- Three themes (Dark, Light, Midnight)
- Menu background selectable: frosted glass, flat solid, or soft shadow
- Corner radius from one variable, four presets, applied to buttons, menus,
  tabs, dialogs and the title bar
- One outline icon set, filled on hover/active, with no layout shift
- Menu and panel motion at 170ms, subtle fade and slide, no bounce; a single
  setting collapses every duration to zero

**New tab page**
- Minimal by default: search box plus two widgets
- Customiser panel: add, remove and drag-reorder widgets, toggle the
  most-visited section, and pick a background (plain, gradient, image URL)
- Most-visited tiles show real site favicons, with a letter avatar only as the
  fallback when an icon fails to load
- Widget registry in `src/shared/widgets.js`: declare a widget there, implement
  it in `renderer/pages/widgets/`, and it appears in the customiser with no
  other changes
- An AI assistant widget is declared as the extension point for a future
  Gemini integration. It renders a setup state until a key exists, and the
  provider call is a single seam (`ctx.ask`) - nothing is hardcoded to a
  provider yet

**Settings**
- New Appearance section: theme, menu background, corner radius, animations
- New tab section: most-visited toggle and a shortcut to the customiser

### Fixed
- Menus opened before the overlay view finished loading were silently dropped.
  Requests are now held and replayed once the overlay reports ready.
- Menus intermittently stayed invisible: the overlay was detached from the view
  tree while idle, and a view that is not composited does not run CSS
  transitions or animations, so the menu froze on its first frame. The overlay
  now stays attached and is shrunk to a 1x1 corner when idle instead.
- The new tab customiser panel could stay parked off-screen, because the slide
  transition had no recorded start state when the panel was unhidden in the
  same frame.
- `src/shared/theme.js` and `src/shared/widgets.js` are wrapped in IIFEs: both
  are loaded as classic scripts on the new tab page, and their top-level
  `const shared` declarations collided.

### Added (earlier this round)
- `npm run shortcut` creates a desktop shortcut that launches the browser
  without a terminal window, rebuilding stale preloads first so it always runs
  current code. Windows (.lnk via a VBScript launcher), Linux (.desktop) and
  macOS (.command).

## [0.1.0] - 2026-09-18

Initial build: a working browser with tabs, omnibox, extensions and the full
set of built-in pages.

### Added

**Tabs**
- Real Chromium tabs, each a sandboxed `WebContentsView`
- New / close / switch tabs, with drag-to-reorder in the tab strip
- Per-tab title, favicon, and a loading spinner while navigating
- Middle-click to close a tab
- Closing the last tab opens a fresh one rather than leaving an empty window
- Closing a tab selects the one to its right, falling back to the left
- Popups and `target="_blank"` open as tabs instead of new windows
- Keyboard shortcuts: `Ctrl/Cmd+T`, `Ctrl/Cmd+W`, `Ctrl+Tab`, `Ctrl+Shift+Tab`

**Omnibox**
- Detects whether input is a URL or a search query, including bare hostnames,
  `localhost:3000`, IPv4/IPv6 literals and ports
- Searches with Google (default) or Brave Search, switchable in Settings
- Autocomplete drawing on both history and bookmarks, with keyboard navigation
- Security indicator showing HTTPS / HTTP / internal / extension / error state
- `Ctrl/Cmd+L` focuses the address bar from anywhere in the app
- Rejects `javascript:` and `file:` URLs typed into the bar

**Navigation**
- Back, Forward, Reload, Stop and Home, all reflecting real navigation state
- Back/Forward disable themselves when there is no history in that direction
- Reload becomes Stop while a page is loading

**Bookmarks**
- Star button in the address bar toggles a bookmark for the current page
- Optional bookmarks bar, toggleable in Settings
- Bookmark manager at `browser://bookmarks` with search, open and delete
- Stored as JSON in the user data directory

**History**
- Every visited URL logged with title and timestamp, titles patched in when
  they arrive after the navigation commits
- Searchable history view at `browser://history` with per-entry removal
- Capped at 50,000 entries; writes are debounced

**New tab page**
- Centred search box using the configured engine
- Most-visited shortcuts grid built from browsing history

**Extensions**
- Install real extensions from the Chrome Web Store
- Load unpacked extension folders, or install a local `.crx` file
- Toolbar action icons, popups, context menu entries and options pages
- Extension manager at `browser://extensions`: enable, disable, remove
- Disabled state persists across restarts

**Downloads**
- Download manager at `browser://downloads` tracking active and finished items
- Progress, cancel, show-in-folder, and clear-finished
- Downloads interrupted by a quit are marked as such on next launch

**Settings**
- Default search engine (Google / Brave Search)
- New tab behaviour (new tab page or homepage) and homepage URL
- Bookmarks bar toggle
- Shortcut to the extensions manager
- Clear browsing data, independently selecting history, cookies and site data,
  cached files, and download history

**Security**
- `contextIsolation`, `sandbox` and `webSecurity` on with `nodeIntegration`
  off for all web content, with no exceptions
- Complete IPC contract declared in `src/shared/channels.js`; a channel not on
  that list is unreachable from any renderer
- Main validates both sender identity and the sender's current top-level URL
  on every IPC call, so a tab that navigates away loses its privileges
- The tab preload exposes nothing unless the page is a built-in `browser://`
  page
- Permissions denied by default; `webview` tag attachment blocked; restrictive
  CSP on every internal page

**Project**
- README covering dev mode, packaging for all three platforms, the folder
  layout, the security model, and known extension API gaps vs real Chrome
- Unit tests for omnibox URL parsing and an end-to-end smoke test that boots
  the real browser in Electron
- electron-builder configuration for Windows (NSIS), macOS (dmg/zip) and
  Linux (AppImage/deb)

### Fixed
- Loopback addresses of the form `127.0.0.1:8080` were resolved as `https://`
  instead of `http://`, because the `127.` branch of the loopback test shared a
  lookahead that only suited the `localhost` form.
- Internal pages never applied their state: `common.js` declared `const invoke`
  at top level and each page script destructured the same name, which is a
  redeclaration in the shared classic-script scope and killed the page script
  on load. `common.js` is now wrapped in an IIFE.
- The settings page showed an empty homepage field and an unchecked bookmarks
  bar for the same reason.
- Inline `style` attributes on internal pages were blocked by their own CSP
  (`style-src 'self'`) and silently dropped; they are CSS classes now.
- The `crx:` scheme was not registered as privileged, which would have stopped
  extension toolbar icons from loading.
- The omnibox security indicator used a star glyph for internal pages, directly
  beside the bookmark star.
