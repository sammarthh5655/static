# Changelog

All notable changes to static are recorded here. This project will grow over
many sessions; add an entry for every feature or behaviour change.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
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
