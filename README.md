# static

A desktop web browser built on Electron, with real Chromium tabs, a real
omnibox, and real Chrome Web Store extensions.

This is not a webview wrapper around a single page. Every tab is a genuine
Chromium `WebContentsView` running sandboxed, and extensions are the actual
`.crx` packages from the Chrome Web Store, running through a reimplementation
of the Chrome extension APIs.

---

## Running it in dev mode

Requires Node.js 22+ and npm.

```bash
npm install
npm start
```

`npm start` runs the preload bundler first (`npm run build`) and then launches
Electron. Use `npm run dev` for the same thing with `--dev` passed through.

### Launching without a terminal

`npm run shortcut` puts a **static** shortcut on the Desktop that launches the
browser with no console window. It rebuilds the preloads first if they are
stale, so the shortcut always runs current code — edit something in `src/` and
just double-click it again.

This runs the dev build (Electron plus `src/`), so the project folder has to
stay where it is. For something you can move or install, package it properly
with `npm run dist:win` — see below.

Other scripts:

| Command | What it does |
| --- | --- |
| `npm start` | Build preloads, then launch the browser |
| `npm run build` | Bundle the preload scripts into `build/` |
| `npm test` | URL/settings tests plus screen-time schedules, quotas, accounting and organizer metadata |
| `npm run test:productivity` | Real Electron organizer, session, sleep/wake, Screen Time and Focus integration checks |
| `npm run test:smoke` | Boots the real app in Electron and drives it end-to-end |
| `npm run test:probe` | Loads the chrome, menu overlay and every `browser://` page; fails on console errors |
| `npm run test:appearance` | Theme, menu keyboard controls, searchable Settings, sidebar, reset and responsive-layout checks |
| `npm run test:ai` | AI mode switching and a real Gemini call |
| `npm run test:aipage` | The AI page: transcript, history, multi-turn memory |
| `npm run test:modes` | Focus blocking, safety scoring, notes and resource metrics |
| `npm run test:homepage` | New tab page: restraint, AI mode, tools panel |
| `npm run test:shields` | Ad/tracker blocking, HTTPS upgrade, real-site check |
| `npm run test:privacy` | Password vault encryption and non-leakage |
| `npm run check:security` | Whether the pinned Electron is behind upstream |
| `npm run test:shot` | Screenshots the chrome and key pages into `.test-output/` |
| `npm run check` | Syntax-checks every JS file in `src/`, `scripts/`, `tests/` |

After changing main-process code, run `test:smoke`: it launches the browser,
opens and reorders tabs, exercises bookmarks/history/settings, confirms the
extension subsystem started, and loads a live HTTPS page.

After changing anything in `renderer/`, run `test:probe`. Internal pages fail
quietly — a CSP violation or a script error leaves a page that still looks
plausible but never applies its state — so the probe asserts each page renders
*and* logs no console errors. `test:shot` is the visual check; the PNGs it
writes can be opened directly.

All test modes run against a throwaway profile under `.test-profile/`, so they
never touch real browsing data.

---

## Packaging installers

## Organizer and Screen Time

Use **Organise Tabs** in the tab strip (Ctrl/Cmd+Shift+O), or open
`browser://organizer`. Preview local topic groups, optionally refine them with
Gemini, review the proposed membership, and apply. Drag cards between groups;
use the selection controls to pin, sleep or move tabs to another workspace.
The workspace selector sits at the start of the tab strip. Group labels collapse
and expand, and Organizer keeps an undo stack for tab actions.

**Save as Session** stores web URLs, pins, groups and workspaces locally in
`organizer.json`. Restoring adds tabs alongside your current ones. Closed-tab
undo restores URLs, not form contents or navigation history. Active, pinned,
audible, loading or edited tabs are protected during automatic cleanup. Tab sleep
freezes Chromium page work and wakes on selection; it is not a hard RAM limit.

Open **Screen Time** from the menu/sidebar (Ctrl/Cmd+Shift+U), or
`browser://screentime`. Add any domain, a daily allowance, and optional pause
schedules. Schedules use local time and support overnight ranges. Allowances
combine a domain and its subdomains and reset at local midnight. YouTube has no
default limit. Presets add social-site limits while preserving your custom rules.

The reports count foreground web browsing while the window is focused and the
computer is active (less than five minutes idle). Background tabs, internal pages,
locked time and sleep are excluded. Counts are sampled once per second and saved
periodically; an abrupt termination can lose up to fifteen seconds. Domain totals
and seven-day reports stay in `screen-time.json`, retained for ninety days.

Focus and Screen Time share one request-blocking path. Allowlist entries and
five-minute emergency exceptions override both; stopping a focus timer does not
remove daily allowances. Tracking/limits can be switched off and reports cleared
separately. This is a self-management tool, not a tamper-proof parental-control system.

Local organizer analysis sends nothing to an AI service. **Refine with Gemini**
and **Create overview with Gemini** send at most 200 titles and domains through
the main-process Gemini client, pinned to `gemini-3-flash-preview`. Page contents,
cookies and full URLs are excluded. If the service/model is unavailable, local
suggestions still work. Overviews describe tab topics, not the contents of articles.

## Packaging installers

Packaging uses electron-builder. Build on the platform you are targeting where
possible; cross-building macOS from Windows or Linux is not supported by Apple's
toolchain.

```bash
npm run dist:win     # Windows  -> NSIS installer (.exe)
npm run dist:mac     # macOS    -> .dmg and .zip
npm run dist:linux   # Linux    -> AppImage and .deb
npm run dist         # current platform, all its configured targets
npm run pack         # unpacked build in dist/ (fast, for testing)
```

Artifacts land in `dist/`, named `static-<version>-<os>-<arch>.<ext>`.

The builds are unsigned. On macOS you will need to right-click → Open the first
time (or sign it with your own Developer ID); on Windows SmartScreen will warn
until the binary is signed.

---

## Project structure

```
src/
  main/                  Main process (Node side)
    main.js              Entry point: app lifecycle, single-instance lock
    secure/keys.js       Baked-in API keys - GITIGNORED, see keys.example.js
    application.js       Owns the window, wires features, registers all IPC
    shortcuts.js         Keyboard accelerator table and matcher
    storage.js           Atomic JSON store used by every feature
  preload/               Context-isolated bridges (bundled into build/)
    chrome.js            For the browser UI - exposes the IPC whitelist
    tab.js               For tab content - exposes IPC ONLY on browser:// pages
  renderer/              The browser UI itself
    index.html/.css/.js  Title bar, tab strip, toolbar, omnibox, bookmarks bar
    ui.js                Icon builder and the custom menu system
    overlay.html/.css/.js  Transparent full-window view that draws menus
    pages/               Built-in browser:// pages
      newtab.*           New tab page: mark, search, five actions, tools panel
      history.*          Searchable history with per-entry delete
      bookmarks.*        Bookmark manager
      downloads.*        Download manager
      extensions.*       Extension manager (enable/disable/remove/load)
      settings.*         Settings, including clear-browsing-data
      ai.*               AI page: chat sidebar, transcript, composer
      dashboard.*        Control centre: live cards for every mode
      focus.*            Focus sessions, blocklist, block interstitial
      notes.*            Captured text, links, screenshots
      resources.*        Memory, CPU and Game Mode
      organizer.*        Grouping board, workspaces, session saving and undo
      screentime.*       Daily allowances, schedules, reports and block page
      productivity.*     Shared controls and themed dialogs for these pages
      safety.*           Fake-site warnings and trust list
      student/legal.*    AI workspaces (share workspace.js)
      shopping.*         Product comparison
      shell.js/.css      Sidebar, header and command bar shared by mode pages
      common.js          Shared helpers for every internal page
      widgets/           New tab widget implementations
  features/              One folder per feature, each a self-contained module
    ai/                  Gemini client + chat history - main process only
    focus/               Site blocking, sessions, presets
    organizer/           Tab classification, group metadata, sessions and sleep
    screen-time/         Local time accounting, quota and schedule policy
    productivity/        Integration with tabs, Focus, request blocking and IPC
    notes/               Captured notes and workspaces
    resources/           Per-tab metrics, suspension, Game Mode
    safety/              Phishing and lookalike-domain heuristics
    workspaces/          Prompt definitions for Student, Legal and Shopping
    shields/             Ad/tracker filter engine, HTTPS upgrade, URL cleaning
    passwords/           OS-encrypted credential vault
    tabs/                Tab lifecycle, WebContentsView management, navigation
    bookmarks/           Bookmark storage and toggling
    history/             Visit recording, search, omnibox suggestions
    downloads/           Download tracking via the session's will-download
    extensions/          Chrome extension loading, enable/disable, web store
    settings/            Validated preferences
  shared/                Code used by both main and renderer
    channels.js          The complete IPC contract - the security allowlist
    urls.js              URL vs search detection, scheme allowlist, security state
    theme.js             Colours, radius, blur, motion, fonts, icon set - one source
    modes.js             Mode registry: sidebar, cards and command bar build from it
    widgets.js           New tab widget registry
scripts/
  build.cjs              esbuild preload bundler
  start.cjs              Launcher (strips ELECTRON_RUN_AS_NODE)
  check.cjs              Syntax checker
tests/
  urls.test.cjs          Unit tests for omnibox parsing
  smoke.cjs              End-to-end test, runs inside Electron
  probe.cjs              Renders every surface, fails on console errors
  appearance.cjs         Theme, motion, window controls, shortcuts
  screenshot.cjs         Writes PNGs of the UI to .test-output/
```

### Where to make changes

Organizer and Screen Time handlers live in the productivity module and are spread
into the guarded IPC handler map. Keep every new channel in shared/channels.js.
The classifier and screen-time policy are independent of Electron for clock-based
unit tests; the runtime owns window/idle measurements and the single request filter.

- **Adding a feature** → new folder under `src/features/`, constructed in
  `application.js#start`.
- **Adding an IPC call** → declare the channel in `src/shared/channels.js`,
  then add a handler in `application.js#registerIpc`. The handler map is
  checked against the declared list at startup, so a declared channel with no
  handler throws immediately rather than failing silently later.
- **Changing the UI chrome** → `src/renderer/`. The renderer is a pure render
  of the state object pushed from main on `app:state`; it holds no browser
  state of its own.
- **Changing chrome height** → `TITLEBAR_HEIGHT` / `TABSTRIP_HEIGHT` /
  `TOOLBAR_HEIGHT` / `BOOKMARKS_BAR_HEIGHT` in `application.js` must stay in
  sync with the heights in `renderer/chrome.css`, because main positions the
  tab view directly below the chrome.
- **Adding a keyboard shortcut** → add it to `ACCELERATORS` in
  `main/shortcuts.js` and handle its id in `application.js#dispatch`. Menus
  read their accelerator labels from the same table, so the two cannot drift.
- **Adding a new tab widget** → declare it in `shared/widgets.js`, implement it
  in `renderer/pages/widgets/index.js`. It appears in the customiser
  automatically.
- **Changing colours, radius, blur or motion** → `shared/theme.js` only. Every
  surface builds its CSS variables from it; a hardcoded value in a stylesheet
  will survive theme switching and look wrong.

### Window composition

```
BaseWindow.contentView
  +- chrome view    the title bar, tab strip, toolbar and bookmarks bar
  +- active tab     positioned directly below the chrome
  +- menu overlay   transparent, spans the window, always the topmost child
```

The menu overlay exists because menus are taller than the chrome strip and
would be clipped if drawn inside it. It stays attached permanently — a view
that is detached is not composited, and a view that is not composited does not
run CSS animations, which left menus frozen and invisible. It is shrunk to a
1×1 corner while idle so clicks pass through to whatever is underneath.

### Menus and keyboard shortcuts

There is no native `Menu` anywhere in this app, and `main.js` explicitly clears
the default one Electron installs. That also removes Electron's accelerator
system, so shortcuts are intercepted in main via `before-input-event`, which
fires before a key reaches page content. This is why `Ctrl+T` still works while
focus is inside a web page, and why a page cannot swallow a browser shortcut.

Menu descriptions cross an IPC boundary to reach the overlay, so items carry a
`{ channel, payload }` action rather than a callback — functions do not
survive that trip.

---

## Security model

All web content runs with `contextIsolation: true`, `sandbox: true`,
`nodeIntegration: false`, and `webSecurity: true`. There are no exceptions.

The IPC surface is locked down in three independent layers:

1. **Declared channels.** `src/shared/channels.js` is the complete contract.
   Preloads only forward channels on that list; anything else is rejected in
   the renderer before it reaches main.
2. **Sender validation.** Every handler in main validates the sender against
   the known chrome WebContents or a trusted `browser://` page, *and* checks
   its current top-level URL. Checking identity alone would let a tab that
   navigated to a web page keep privileges it should have lost.
3. **Preload scoping.** The tab preload exposes nothing at all unless the page
   is a built-in `browser://` page. Web pages get an inert preload.

Beyond IPC: permissions default to denied (only fullscreen, pointer lock and
sanitized clipboard writes are even considered), `webview` tag attachment is
blocked, navigation is restricted to an allowlist of schemes (`javascript:`
and `file:` are rejected by the omnibox), and every internal page carries a
restrictive CSP.

---

## Known extension API gaps vs real Chrome

Extensions run through `electron-chrome-extensions`, which reimplements the
Chrome extension platform on top of Electron rather than shipping Chromium's
own extension system. Most real-world extensions work — content scripts,
browser action popups, context menus, options pages, storage, alarms, and the
tabs/windows APIs are all supported — but some things differ:

- **`declarativeNetRequest` is incomplete.** This is the big one: MV3 content
  blockers depend on it, and rule matching is only partially implemented.
  Blockers that still offer an MV2 build, or that use `webRequest`, work much
  better than MV3-only ones.
- **`webRequest` blocking is limited.** Electron's own `webRequest` is used
  underneath, which does not expose everything Chrome's blocking variant does.
- **Service worker background scripts** are supported but have lifecycle
  differences from Chrome — they may not suspend and revive on exactly the
  same schedule, which can surface bugs in extensions that rely on that timing.
- **Enterprise/managed APIs** (`enterprise.*`, `managedStorage` policies) are
  not implemented.
- **Sync APIs** (`chrome.storage.sync`, `identity`, anything backed by a Google
  account) have no backing service. `storage.sync` falls back to local storage
  semantics and does not sync anywhere.
- **`chrome.tabs` covers the common surface**, but less-used members such as
  tab groups, `chrome.tabCapture`, and `chrome.debugger` are absent.
- **Chrome Web Store install flow** works, but the store page itself sometimes
  renders differently than in Chrome since it detects the browser.
- **No extension sync, no Chrome profile import.** Extensions installed here
  are local to this browser's profile.

"Disable" is also emulated: Electron can only load or unload an extension, so
disabling unloads it and records the id, and enabling loads it back from disk.
A disabled extension is genuinely not running, which is stricter than Chrome.

---

## Data storage

Everything is stored as JSON under Electron's `userData` directory
(`%APPDATA%/static` on Windows, `~/Library/Application Support/static` on
macOS, `~/.config/static` on Linux):

| File | Contents |
| --- | --- |
| `settings.json` | Preferences |
| `bookmarks.json` | Bookmarks |
| `history.json` | Visit history (capped at 50,000 entries) |
| `downloads.json` | Download history |
| `extensions.json` | Which extensions are disabled |
| `Extensions/` | Installed extension packages |

**Why JSON and not SQLite:** the data volumes here are small and read entirely
into memory at startup, so SQLite's query engine buys nothing — while a native
module would have to be rebuilt against Electron's ABI for every platform we
package, which is the single most common source of Electron build breakage.
Writes are atomic (temp file + rename) and history writes are debounced so
logging every visit doesn't hammer the disk. If history ever needs to grow past
a few hundred thousand rows, that is the point to revisit this.

---

## What the resource controls can and cannot do

Electron reports real per-process CPU and memory through `app.getAppMetrics()`,
so the numbers in Resources are genuine. But there is **no API to cap a
renderer's memory or throttle its CPU to a percentage** — Chromium does not
expose one.

So the memory modes and CPU profiles are *policies*, not enforcement: they
decide when to warn, mute, throttle or suspend. The real levers are
`setBackgroundThrottling`, `setAudioMuted` and discarding a tab. Game Mode is
those same levers applied at once, with a measured before/after.

A slider claiming to cap RAM at 2 GB would be a lie the user only discovers
when it fails, so the UI says this on the page itself.

---

## AI and the Gemini key

All AI features use Gemini. The key is baked into the build rather than being a
user setting, and it lives in `src/main/secure/keys.js`, which is gitignored —
copy `keys.example.js` to `keys.js` and fill it in to build. `GEMINI_API_KEY` in
the environment overrides it for development.

Every Gemini call is made from the main process. A renderer sends a prompt over
IPC and receives text back; the key is never in renderer or page context, never
in a URL, and is scrubbed from any error message before it is shown.

**A key embedded in a desktop app is not secret.** The app ships to the user's
disk, so anyone can extract it from the bundle or watch the network call —
obfuscation only raises the effort. The protection that actually works is on
Google's side: restrict the key and cap its quota in Google AI Studio so a leak
is bounded rather than open-ended.

---

## License

GPL-3.0-or-later.

This is not incidental: `electron-chrome-extensions` is dual-licensed, and the
free option is GPL-3.0. The alternative is a paid patron license from its
author. Using it under GPL-3.0 requires this project to be GPL-3.0 as well —
so if you plan to distribute this commercially as closed source, you need to
buy that license first.

## Menu and Settings design

The browser menu and Settings share the Static mark, theme tokens and outline
icons. Eclipse uses the midnight/cyan look; light and other themes remain available.
Open Settings from the browser menu, then choose a category in the sidebar.
Ctrl+K (Cmd+K on macOS) searches settings across categories. Section links such as
`browser://settings#appearance` and `browser://settings#about` open directly.

Appearance includes font, size, density, accent, menu surface and corner controls.
The menu's Sidebar selector controls navigation on workspace pages: On keeps it
visible, Autohide reveals it from the left edge or keyboard focus, and Off hides it.
The workspace header button restores a hidden sidebar. Reset settings requires a
confirmation and affects preferences only; saved browsing data and extensions stay.

The implementation lives in `src/renderer/ui.js`, `overlay.css`, and
`pages/settings-navigation.js` / `settings.css`. Settings validation and reset
scopes live in `src/features/settings`; colors and icons stay in `src/shared/theme.js`.
The redesign exposes existing browser capabilities; private/multiple windows,
full autofill and language management are not added by this visual update.
