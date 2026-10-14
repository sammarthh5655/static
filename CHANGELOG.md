# Changelog

All notable changes to static are recorded here. This project will grow over
many sessions; add an entry for every feature or behaviour change.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added — Installers for your own website

- **Windows installer like Chrome's:** one click, no administrator prompt,
  installed per user, Start menu and desktop shortcuts, opens when done.
  Separate x64 and Arm64 installers. static.exe carries its own name, icon and
  version. It registers static as a browser, so it appears in Windows' Default
  apps and "Open with", and uninstalling removes all of it.
- **Mac disk image:** one universal app for Apple Silicon and Intel, a
  drag-to-Applications window with its own artwork, listed by macOS as a
  browser. Without a Developer ID it is signed ad hoc, so macOS offers
  "Open Anyway" instead of calling it damaged; with one it is signed and
  notarized.
- **Links and files from other apps open in a tab**, on first launch and
  when static is already running (src/main/system-open.js). Only http(s)
  addresses and real local pages, images and documents are accepted.
- **Automatic updates from your website**, switched on by building with
  `STATIC_UPDATE_URL`: checked in the background, verified by SHA-512,
  installed on the next close. About shows the status, with Check for
  updates and Restart to update. Tested end to end against a local feed: the
  packaged app found, downloaded and verified an update.
- **`npm run release`** builds and assembles `release/` for the website:
  installers under stable and versioned names, update files, checksums, and
  a self-contained download page that picks Windows, Windows on Arm or Mac.
- **Release workflow** (.github/workflows/release.yml) builds Windows and Mac
  together, installs and launches the Windows build, checks the Mac build's
  signature, fuses and launch, and produces the release folder.
- **Hardened app binary** (Electron fuses): no running as plain Node, no
  `NODE_OPTIONS` or debugger flags, and the app refuses to start if its
  packaged code was changed.
- Signing switches on from environment variables: Azure Trusted Signing, a
  certificate on a token or cloud service, or a .pfx for Windows; Developer
  ID and notarization for macOS. See docs/releasing.md.

### Fixed — packaging

- The installed app showed a personal email address as its publisher in
  Windows. It now shows the publisher name (`STATIC_PUBLISHER`, default
  "static").
- Windows builds failed on PCs with Smart App Control, which refuses to run
  the unsigned helper electron-builder executes to make the uninstaller.
  `scripts/dist.cjs` reads the uninstaller out of it instead.
- Installers no longer carry the installer artwork, entitlements and build
  scripts inside the app.

### Fixed — from an adversarial review of the installers

Seventeen defects reported by independent reviewers, each confirmed by a
second reviewer trying to disprove it, all fixed:

- **A link that launched static lost the saved session.** It arrived before
  the window restored the last tabs, so they were skipped and then
  overwritten. Startup tabs now open first (tests/linklaunch.cjs fails
  without the fix).
- **A failed update download showed Electron's "A JavaScript error occurred"
  box.** The download's promise is now handled.
- **Signed Windows builds could never update** when the recorded publisher
  name differed from the certificate's. The name is read from the
  certificate, Azure signing requires it to be given, and `npm run release`
  stops on a mismatch.
- **The Arm64 installer run on an ordinary PC** removed the working static and
  installed nothing. It now refuses before changing anything (tested here).
- **The Mac app claimed macOS 11**, but Electron 44 needs macOS 13 Ventura.
  Electron's own minimum now applies, and the page and docs say macOS 13.
- "Restart to update" on a Mac kept only the last window in the session, and
  installing an update closed open incognito windows unasked; it now waits
  for them.
- Switching profile after a link launch relaunched with the link and opened
  it again; .xhtml, .xht and .shtml files downloaded instead of showing.
- The download page claimed Mac support when a release had none, hid help
  for signed builds that SmartScreen can still question, and only worked in
  the same folder as the installers; it now links to the update folder in
  full when one is set. The release workflow decides "signed" from the built
  installer, not from which secrets exist. The docs say to keep earlier
  `.blockmap` files so updates stay small, and that signing does not
  instantly remove every SmartScreen warning.

### Security

- **Electron 44.4.3 → 44.7.0**, the six 44.x releases it was behind, each
  carrying Chromium security fixes. All 77 off-screen probes and 329 unit
  tests pass on it.

### Fixed

- **The AI probes pass again, without spending the Gemini allowance.** Test
  runs were stopped from calling Gemini to protect the allowance, and four
  probes that need answers then failed by construction. They now answer
  through a stand-in at the HTTP layer (`tests/fixtures/gemini.cjs`), which
  works out its answers from the request, so a dropped conversation history
  still fails "remembers earlier turns". `--live-gemini` runs them against
  the real API on purpose; `aispeed`, which times the real API, runs only
  then and is otherwise reported as skipped, not passed.

- **Extensions from disk, hardened after an adversarial review.** Seven
  defects in the .crx and unpacked fixes were reported and each reproduced
  before being fixed. A crafted .crx whose entries shared one blob could
  stall the browser for an hour; shared data is now refused. The library's
  auto-updater could delete an unpacked extension's folder; updates now see
  only the app's own copies. Reinstalling a .crx no longer deletes the working
  copy before the new one loads. A folder with an installed extension's key
  replaces the install, a folder whose ID changes is re-recorded, and the
  manager stopped re-reading manifests on every refresh.
- **Ctrl+Tab and Ctrl+Shift+Tab switch tabs on the Mac**, as in Chrome, along
  with Cmd+Option+Right and Left. They were Option+Tab, and Ctrl+Tab did
  nothing. The shortcut table is now built per platform, so the Mac rules are
  unit tested on any machine.
- **"A different one on every new tab" no longer repeats** within eight tabs.
  It remembered only four picks and counted each photo twice.
- **Switching animations off stills the wallpaper preview at once.** A slide
  that was already loading used to swap in afterwards.
- **Closing a tab no longer logs "Unauthorized sender"** for a request it had
  in flight. The request had no access either way; it is now dropped quietly.
- **README:** the security section no longer claims web pages get an inert
  preload. It lists the messages web pages do send, why, and what the main
  process trusts in each. The folder map now covers every feature, main
  process file and preload.

- **Install .crx file works.** It used to hand the file's path to the Web
  Store installer, which treats its argument as a store ID, so it asked Google
  for an extension named after the path and always failed. A new reader
  (`src/features/extensions/crx.js`) verifies every signature in a CRX3
  package, requires the extension ID to belong to a key that signed it, and
  unpacks without adm-zip, refusing escaping paths, symlinks, duplicate
  names, encrypted entries, ZIP64 and size lies. The package is installed in
  the Web Store layout, so it survives restarts and Remove deletes it.
- **Unpacked extensions survive a restart.** "Load unpacked" loaded the
  folder for the current session only. The folder is now recorded and loaded
  at every startup, as in Chrome. Remove forgets it and never deletes the
  folder; a folder that has gone missing stays listed so it can be removed.
- **Disabling an unpacked extension no longer loses it.** It vanished from
  the list and could not be re-enabled, because its manifest was looked for
  only in the installed-extensions folder.
- The Extensions page now says what happened when loading fails, instead of
  silently doing nothing. A new probe (`tests/extlocal.cjs`, run twice by
  `npm run probes`) covers all of this across a restart, and 37 unit tests
  cover the CRX reader.
- The planetarium theme picker no longer renders blank. Its animation loop
  re-armed itself as the last statement of its drawing code, so a single
  throw mid-frame stopped the loop permanently - blank until Settings was
  reopened, about one open in four. The re-arm is now in a `finally`, so one
  bad frame costs one frame; the star field is treated as optional scenery,
  and a faulting frame logs once instead of every frame. A new probe
  (`npm start -- --planetblank`) breaks one frame on purpose and checks the
  planets are still moving, and opens Settings on its default section six
  times to cover the path where the picker is built inside a hidden section.

### Added — Reading view, screenshots and QR codes

- Reading view: a book in the address bar on pages that read like articles
  (F9, or the page's right-click menu). The article is extracted in an isolated
  world, rebuilt in main from an allow-list (no scripts, handlers, styles or
  non-http(s) addresses) and shown at browser://reader with its title, site,
  byline, date and reading time; text size, column width, serif or sans, and
  light, sepia or dark are remembered. Pictures load with no referrer. One
  click, or Escape, goes back to the page.
- Screenshots from the page's right-click menu and the main menu: the visible
  area, the full page (DevTools protocol, captured beyond the viewport) or a
  dragged, adjustable area, to a card with Copy and Save (Pictures › Static
  Screenshots).
- QR code for this page, from the address bar and the right-click menu, made
  by Static's own encoder with no network, with Copy image and Save.
- Unit tests for the QR encoder (checked by an independent strict decoder) and
  the reading view sanitiser; an off-screen probe (tests/pagetools.cjs) that
  uses all three with real clicks and decodes the QR codes it shows and saves,
  and one (tests/readerweb.cjs, needs the network) that opens reading view on
  real sites: an encyclopaedia, documentation, a hand-made essay laid out in
  tables with <br> paragraphs, GOV.UK's folded accordions and two blogs.
  A third (tests/pagetoolsedge.cjs) leans on the corners: a hostile article
  that rewrites the DOM in its own world and hides script in SVG, MathML,
  frames and odd addresses; Back through two articles read in one tab; full
  page captures of scrolled, zoomed and over-tall pages; and the area picker
  resized and moved by its handles.

### Added — Organizer and Screen Time

- Organizer Mode with local topic suggestions and optional Gemini 3 Flash Preview
  refinement, duplicate/unused/heavy/same-domain detection, editable coloured
  groups, tab-strip collapse, drag-and-drop moves, pinned tabs, and tab workspaces.
- One-click local session saving, restoration alongside current tabs, title-based
  AI session overviews, and undo for organizer tab actions.
- Chromium lifecycle tab sleep with automatic wake on selection. Cleanup protects
  active, pinned, audible, loading and edited pages and leaves existing debuggers alone.
- Screen Time with foreground website accounting, daily and seven-day reports,
  daily allowances, multiple local-time schedules, advance warnings, a friendly
  block page, five-minute emergency exceptions and a shared Focus allowlist policy.
- Study, Work, Gaming, Legal Research and Custom presets; YouTube remains
  unrestricted unless the user explicitly adds a rule.
- Organizer/Screen Time dashboard cards, sidebar and command-bar entries, browser
  menu links, an Organise Tabs strip button, and Ctrl/Cmd+Shift+O / Shift+U shortcuts.
- Unit coverage for clock boundaries, overnight schedules, allowances, exceptions
  and metadata validation; native Electron tests for guarded IPC, grouping,
  drag/drop, undo, sleep/wake, sessions, forms and request blocking.

### Fixed — Tab and Focus integration

- Background tabs no longer steal focus when the extension bridge registers them,
  including during session restoration.
- Shared renderer-process memory is counted once in resource totals.
- Focus blocks now load the actual local Screen Time page instead of redirecting
  to an unhandled network protocol. Internal query parameters survive routing.

### Fixed

- Fixed live font/accent propagation to chrome, menus and internal pages.
- Fixed stale menu-trigger state after keyboard opening, replacement-menu
  ordering, and delayed overlay resize events; menus support keyboard navigation.

- Fixed the main-process crash when opening static while it is already running:
  Focus Mode had shadowed the window activation method. Second launches now
  restore and show the existing window, and app activation uses the same path.
- Added an Electron regression check that launches a second process with both
  minimized and hidden windows, verifies the original tabs and Focus Mode stay
  intact, and checks app activation.

### Added

**Static menu and Settings design**
- Cyan/blue Static mark, midnight glass surfaces, grouped menu rows and shared
  outline icons based on the supplied visual reference. Other themes remain selectable.
- Searchable Settings sidebar with fourteen functional categories, section links,
  keyboard search, responsive layouts, and real application/engine version details.
- Typeface, size, density and accent controls, plus workspace sidebar On/Autohide/Off.
- Confirmed appearance-only or full preference reset; saved browsing data is retained.
- Electron coverage for menu reopening/keyboard use, settings search, live appearance,
  reset cancellation/confirmation, sidebar behavior, section links and compact/light views.

**Video ad blocking** (scriptlets)
- Blocks YouTube pre-rolls, mid-rolls and post-rolls by emptying the ad slots
  in the player response before the player reads them - so there is nothing to
  skip or wait through, because the player never learns an ad exists
- Stubs the common video ad SDKs (Google IMA, GPT, Prebid) everywhere, so
  players on other sites see "no ads available" - the same path they already
  handle when an ad request goes unfilled
- Cosmetic CSS collapses the empty boxes a blocked ad would have filled, which
  closes the gap previously documented as permanent
- Verified: YouTube ad placements drop to zero and the real video plays, while
  Wikipedia, GitHub and CNN all still render correctly

**Shields** (`browser://shields`)
- Ad and tracker blocking using EasyList + EasyPrivacy (113,000+ rules),
  cached on disk and refreshed weekly, with a built-in list so a first run is
  never unprotected
- HTTPS upgrade, tracking-parameter stripping (utm_*, fbclid, gclid), and
  third-party cookie blocking
- Per-site toggle and a per-tab report of exactly what was blocked
- States its own gaps: no cosmetic filtering, no fingerprint randomisation

**Passwords** (`browser://passwords`)
- Encrypted with Electron safeStorage, which delegates to the OS - DPAPI on
  Windows, Keychain on macOS, libsecret/kwallet on Linux
- Listings never contain a password; plaintext crosses IPC one entry at a time
- Strong password generator using crypto.randomInt, avoiding confusable
  characters
- Refuses to save at all when the OS offers no real encryption, rather than
  silently falling back to plaintext

**Security maintenance**
- `npm run check:security` compares the pinned Electron against npm and exits
  non-zero when behind. It found we were a patch behind on first run;
  bumped 44.4.2 to 44.4.3.

### Changed
- **Redesigned the new tab page.** It was a widget grid; it is now a calm,
  spacious page with a mark, one large search box, five actions, a thin row of
  round site icons and three small utility cards. Everything advanced moved
  behind a floating AI tools panel, so the page you see a hundred times a day
  asks nothing of you.
- New **Eclipse** theme, now the default: deep black with a midnight-blue lift,
  cyan primary and violet secondary. Kept low-saturation on purpose - saturated
  accents on black are what make an interface look cheap.
- The ambient glow is built from the accent with `color-mix`, so it follows
  whichever theme is active instead of being hardcoded to one palette.
- Every theme gained an `accent-alt` token.
- Frequent sites are hidden entirely on a fresh profile rather than showing
  placeholder circles, and their favicons are clipped to circles so square
  white-ground icons stop reading as tiles.

### Added

**Control centre**
- `browser://dashboard` with a card per mode showing LIVE state, a persistent
  sidebar with badges, and a Ctrl+K command bar that searches modes, actions,
  open tabs and history
- `shared/modes.js` is the single registry the sidebar, cards and command bar
  all build from - adding a mode means one entry plus a page

**Focus mode** (`browser://focus`)
- Blocks top-level loads via webRequest; a blocked navigation redirects to the
  page itself, which explains why rather than showing a browser error
- YouTube allowed by default and in every preset, stated visibly in the UI
- Pomodoro timer, presets (Study/Work/Legal/Gaming/Custom), per-site toggles,
  productivity stats, and an emergency unlock with a one-minute wait

**Resources** (`browser://resources`)
- Real per-tab memory and CPU from app.getAppMetrics()
- Memory modes and CPU profiles, auto-suspend, and Game Mode with a savings
  report and one-click restore
- The page states its own limits: a browser cannot cap memory or throttle CPU,
  so these are policies, not enforcement

**Notes** (`browser://notes`)
- Capture selected text, links or screenshots from any page (Ctrl+Shift+S)
- Workspaces, tags, search, pin, AI summarise, and Markdown export

**Safety** (`browser://safety`)
- Local heuristics for lookalike domains, brand imitation, punycode, risky
  TLDs, IP hosts and unencrypted sign-in forms
- Full interstitial explaining WHY, with go back / continue / always trust
- Tuned against false positives: verified silent on google, github, wikipedia,
  amazon.in and hdfcbank

**Student and Legal** (`browser://student`, `browser://legal`)
- Student: summarise, explain simply, notes, quiz, flashcards, translate
- Legal: Indian practice - judgment summary, case brief, provisions, timeline,
  issues, para-wise notes, and drafting for notices, replies and submissions.
  Prompts name both current and former provisions (BNS/IPC, BNSS/CrPC) and use
  Indian citation form. A verification disclaimer is always visible.

**Shopping** (`browser://shopping`)
- Compares product pages already open in tabs; missing fields show as "not
  found" rather than being guessed

### Fixed
- Menus could open invisible. A RUNNING animation overrides the base rule
  whatever its fill mode, so an animation stalled mid-flight (which happens
  when the overlay view is not composited) pinned the menu at opacity 0. The
  entrance now animates transform only, so no animation state can hide it.
- The menu had no max-height and overflowed the window once it grew past nine
  items; it now caps to the viewport and scrolls.
- Legal pinned itself to the Pro model with `model`, so a quota error failed
  the request outright. `preferModel` now puts it first in the chain but still
  falls back.


### Added

**AI page (browser://ai)**
- A dedicated AI page with a conversation sidebar, transcript and composer
- Chat history persists in the main process, so a transcript survives closing
  the tab; conversations are searchable, renameable, pinnable and deletable
- Multi-turn: prior turns are sent with each question, so the assistant
  remembers what was said earlier in the conversation
- Chats title themselves from the first question
- Copy and retry on any answer; Enter sends, Shift+Enter newlines, Esc cancels
- "Open in AI" carries a new-tab answer into a saved conversation
- Reachable from the menu, Ctrl+Shift+G, or browser://ai
- Pinned chats survive "clear history" - losing a kept chat to a misclick is
  worse than leaving a few behind

**AI (Gemini)**
- Gemini client in the main process; the API key never crosses an IPC boundary
  and is never present in renderer or page context
- AI search box on the new tab page: Enter searches, Tab switches to AI Mode,
  Enter then asks Gemini. Escape or Tab returns to search
- AI Mode is signalled by an accent border, an animated AI badge, an icon swap
  and a hint line, because a field that silently changes what Enter does is a
  trap
- Answer panel with copy button and follow-up suggestions
- Walks a chain of verified models when one fails. Google retires ids faster
  than expected (gemini-2.0-flash, 2.5-flash and 2.5-flash-lite are all already
  "no longer available" against this key), and on the free tier each model has
  its OWN daily quota - so a single fallback is not enough, because that one
  can be exhausted too. Quota and retirement skip to the next model
  immediately; overload retries the same one with exponential backoff first
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
