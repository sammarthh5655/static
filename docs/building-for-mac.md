# Building Static for macOS

Written for whoever builds and ships the Mac version — not for end users.

## The short version

On a Mac, with Node 22+ installed:

```bash
npm install
npm run dist:mac
```

You get `dist/static-0.1.0-mac-universal.dmg`, which runs on every Mac made
since 2020 — Apple Silicon (M1 through M4) and Intel, from one download.

**A Mac build requires a Mac.** Apple's signing and packaging tools only run on
macOS; electron-builder refuses on Windows with
*"Build for macOS is supported only on macOS"*. There is no way around this
locally. For CI, use a `macos-latest` runner.

---

## What was Windows-only, and was fixed

These were real bugs, not polish. Each one made the browser unusable or
near-unusable on a Mac.

### The window had no close button

`BaseWindow` was created with `frame: false`. On Windows that removes the OS
title bar so the browser can draw its own. On macOS it removes the **traffic
lights** as well — a Mac user had no way to close, minimise or zoom the
window.

macOS now gets `titleBarStyle: 'hiddenInset'` with
`trafficLightPosition: { x: 13, y: 13 }`, which keeps the real traffic lights
inset into our chrome. The browser's own drawn window buttons are hidden there
(`body.mac .window-controls { display: none }`), because two sets of window
buttons on one window is worse than either alone.

### Copy and paste did not work

`Menu.setApplicationMenu(null)` is correct on Windows: every menu in this app
is custom DOM, and Electron would otherwise install a default menu bar with
its own accelerators.

On macOS the menu bar belongs to the **system**, and the standard edit commands
are menu items rather than key handlers. Clearing it broke Cmd+C, Cmd+V,
Cmd+X, Cmd+A, Cmd+Z, Cmd+Q and Cmd+H. A Mac user could not copy a URL or quit
the app.

macOS now gets a minimal menu carrying only the roles the system expects —
About, Services, Hide, Quit, the Edit commands, and the Window roles. Nothing
in it duplicates the browser's own in-window menus.

### Everything else was already portable

Checked rather than assumed:

- **Shortcuts** already map `mod` to Cmd on macOS (`src/main/shortcuts.js`).
- **The password vault** already selects the macOS Keychain
  (`src/features/passwords/index.js`), and reports honestly when encryption is
  unavailable rather than storing plaintext.
- **Dock behaviour** already works: `activate` reopens a window through
  `ensureWindow()`, and `window-all-closed` correctly does *not* quit on
  darwin.
- **No hardcoded paths.** A scan for `C:\`, `%APPDATA%`, `.exe`, `cmd /c` and
  PowerShell found nothing outside generated files.

---

## Packaging configuration

### Universal binary

```json
"target": [
  { "target": "dmg", "arch": ["universal"] },
  { "target": "zip", "arch": ["universal"] }
]
```

Universal means one download for every Mac, and no "which chip do I have?"
question at install time. It roughly doubles the download size, which is the
right trade for a browser people install once.

To build for a single architecture instead:

```bash
npm run dist:mac:arm      # Apple Silicon only
npm run dist:mac:intel    # Intel only
```

### Hardened runtime and entitlements

`hardenedRuntime: true` is **required** for notarization on macOS 10.15+.
It also restricts what the process may do, so Electron needs three
entitlements to run at all (`build/entitlements.mac.plist`):

| Entitlement | Why Electron needs it |
|---|---|
| `allow-jit` | V8 compiles JavaScript to machine code. Without it, no page runs any script. |
| `allow-unsigned-executable-memory` | Chromium maps writable pages executable in places JIT alone does not cover. |
| `disable-library-validation` | Electron loads framework dylibs signed under a different team ID. |

Plus `network.client` (a browser is a network client) and
`files.user-selected.read-write` (unpacked extensions and download locations).

`build/entitlements.mac.inherit.plist` adds `com.apple.security.inherit`, so
renderer, GPU and utility processes inherit the parent's sandbox rather than
declaring their own.

### Info.plist additions

macOS **crashes** rather than prompting when an app touches a protected
resource it has not declared a reason for. Declared: camera, microphone,
location, Downloads folder, Documents folder.

`CFBundleURLTypes` registers `http` and `https`, without which macOS never
offers Static in *Settings → Desktop & Dock → Default web browser*.

`LSMinimumSystemVersion: 11.0` — Big Sur, the oldest release Electron 44
supports.

---

## Signing and notarization

The config sets `"identity": null`, so a local build succeeds without any
certificate. The result runs, but Gatekeeper shows *"static cannot be opened
because the developer cannot be verified"* on another Mac, and the user has to
right-click → Open to get past it.

To ship properly you need an **Apple Developer account** ($99/year):

1. Create a *Developer ID Application* certificate and install it in the login
   keychain.
2. Remove `"identity": null` from `build.mac`, or set it to the certificate
   name.
3. Provide notarization credentials as environment variables:

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"
npm run dist:mac
```

electron-builder notarizes automatically when those are present. Use an
app-specific password from appleid.apple.com, never the account password.

Without notarization the app still works — it is just a worse first
impression.

---

## Testing on a Mac

The probes run there unchanged:

```bash
npm test              # 120 unit tests, no browser needed
npm run test:smoke    # launches the browser and drives it
npm run test:ads      # random YouTube videos
```

Worth checking by hand, because they are the things that were broken:

- The traffic lights are present, in the usual place, and all three work.
- Cmd+C and Cmd+V work in the address bar and in a page.
- Cmd+Q quits; Cmd+H hides.
- Closing the last window leaves the app in the dock, and clicking the dock
  icon brings a window back.
- Static appears under *Settings → Desktop & Dock → Default web browser*.
