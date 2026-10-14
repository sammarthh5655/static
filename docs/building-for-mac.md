# Building Static for macOS

Written for whoever builds and ships the Mac version — not for end users.

## The short version

On a Mac, with Node 22+ installed:

```bash
npm install
npm run dist:mac
```

You get `dist/static-0.1.0-mac-universal.dmg`, one download that runs natively
on Apple Silicon and Intel Macs with macOS 13 Ventura or later (Electron 44's
minimum).

**A Mac build requires a Mac.** Apple's signing and packaging tools only run on
macOS; electron-builder refuses on Windows with
*"Build for macOS is supported only on macOS"*. There is no way around this
locally. `.github/workflows/release.yml` builds it on a `macos-latest` runner;
see [releasing.md](releasing.md) for publishing it.

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

No `LSMinimumSystemVersion` is set: Electron's own Info.plist carries the right
one (macOS 13 Ventura for Electron 44, per its breaking-changes notes). An
older value here would let Macs that cannot run static install it.

---

## Signing and notarization

Nothing in the config needs editing: `electron-builder.config.cjs` signs and
notarizes when the credentials are present, and otherwise builds unsigned.

**Without a certificate**, electron-builder skips signing, and
`scripts/after-pack.cjs` signs the app *ad hoc* instead. That matters: the
build changes Electron's app after Electron signed it, and a downloaded app
with a broken signature is reported as *damaged*, with no way to open it. Ad
hoc, macOS instead says it *could not verify* static, and the person can allow
it once in *System Settings > Privacy & Security > Open Anyway*. (Since macOS
15, right-click > Open no longer gets past this.) An ad-hoc app cannot update
itself.

**To ship properly** you need the Apple Developer Program:

1. Create a *Developer ID Application* certificate. Either install it in the
   login keychain and set `CSC_NAME`, or export it as a `.p12` and set
   `CSC_LINK` (path or base64) and `CSC_KEY_PASSWORD`.
2. Provide notarization credentials. An App Store Connect API key is best:

```bash
export APPLE_API_KEY=/path/to/AuthKey_XXXXXXXXXX.p8
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
npm run dist:mac
```

   Or `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` (from appleid.apple.com,
   never the account password) and `APPLE_TEAM_ID`.

The release workflow takes the same values as repository secrets; see
[releasing.md](releasing.md).

---

## Testing on a Mac

The probes run there unchanged:

```bash
npm test              # the unit tests, no browser needed
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
