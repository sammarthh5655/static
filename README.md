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

Other scripts:

| Command | What it does |
| --- | --- |
| `npm start` | Build preloads, then launch the browser |
| `npm run build` | Bundle the preload scripts into `build/` |
| `npm test` | Unit tests for URL/omnibox parsing (plain Node, no Electron) |
| `npm run test:smoke` | Boots the real app in Electron and drives it end-to-end |
| `npm run test:probe` | Loads every `browser://` page and fails on console errors |
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
    application.js       Owns the window, wires features, registers all IPC
    storage.js           Atomic JSON store used by every feature
  preload/               Context-isolated bridges (bundled into build/)
    chrome.js            For the browser UI - exposes the IPC whitelist
    tab.js               For tab content - exposes IPC ONLY on browser:// pages
  renderer/              The browser UI itself
    index.html/.css/.js  Tab strip, toolbar, omnibox, bookmarks bar
    pages/               Built-in browser:// pages
      newtab.*           New tab page: search box + most-visited grid
      history.*          Searchable history with per-entry delete
      bookmarks.*        Bookmark manager
      downloads.*        Download manager
      extensions.*       Extension manager (enable/disable/remove/load)
      settings.*         Settings, including clear-browsing-data
      common.js          Shared helpers for every internal page
  features/              One folder per feature, each a self-contained module
    tabs/                Tab lifecycle, WebContentsView management, navigation
    bookmarks/           Bookmark storage and toggling
    history/             Visit recording, search, omnibox suggestions
    downloads/           Download tracking via the session's will-download
    extensions/          Chrome extension loading, enable/disable, web store
    settings/            Validated preferences
  shared/                Code used by both main and renderer
    channels.js          The complete IPC contract - the security allowlist
    urls.js              URL vs search detection, scheme allowlist, security state
scripts/
  build.cjs              esbuild preload bundler
  start.cjs              Launcher (strips ELECTRON_RUN_AS_NODE)
  check.cjs              Syntax checker
tests/
  urls.test.cjs          Unit tests for omnibox parsing
  smoke.cjs              End-to-end test, runs inside Electron
```

### Where to make changes

- **Adding a feature** → new folder under `src/features/`, constructed in
  `application.js#start`.
- **Adding an IPC call** → declare the channel in `src/shared/channels.js`,
  then add a handler in `application.js#registerIpc`. The handler map is
  checked against the declared list at startup, so a declared channel with no
  handler throws immediately rather than failing silently later.
- **Changing the UI chrome** → `src/renderer/`. The renderer is a pure render
  of the state object pushed from main on `app:state`; it holds no browser
  state of its own.
- **Changing chrome height** → `CHROME_HEIGHT` / `BOOKMARKS_BAR_HEIGHT` in
  `application.js` must stay in sync with the heights in `renderer/chrome.css`,
  because main positions the tab view directly below the chrome.

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

## License

GPL-3.0-or-later.

This is not incidental: `electron-chrome-extensions` is dual-licensed, and the
free option is GPL-3.0. The alternative is a paid patron license from its
author. Using it under GPL-3.0 requires this project to be GPL-3.0 as well —
so if you plan to distribute this commercially as closed source, you need to
buy that license first.
