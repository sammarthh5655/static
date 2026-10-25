# Releasing static

Written for whoever publishes static. It covers building the Windows and Mac
installers, signing them, and publishing them.

**The default: GitHub Releases.** Push a version tag and
`.github/workflows/release.yml` builds both installers, tests them, and
publishes a GitHub Release. The README's download links
(`releases/latest/download/static-setup.exe` and so on) always point at the
newest one, and installed copies update from it. Nothing has to be uploaded
by hand.

**Optional: your own website.** The same files can be hosted on a website
instead (below). Decide before many people install static, because installed
copies only ever check the address they were built with.

## What a release is

One folder, `release/`, published as the GitHub Release's files (or uploaded
as-is to a folder on your website):

| File | What it is |
| --- | --- |
| `index.html` | The download page. Picks Windows, Windows on Arm or Mac for the visitor. Self-contained; its download links point at the update folder (or, without one, at the files beside it). |
| `static-setup.exe` | Windows installer, x64. Runs on Windows on Arm too. |
| `static-setup-arm64.exe` | Windows installer for Arm laptops (Snapdragon). |
| `static.dmg` | Mac installer, for Apple Silicon and Intel in one file. |
| `static-<version>-…` | The same files under versioned names. Automatic updates use these. |
| `latest.yml`, `latest-mac.yml`, `*.blockmap` | What installed copies check for updates. Only present when built with an update address. |
| `SHA256SUMS.txt`, `downloads.json` | Checksums, and a machine-readable list for your own site to use. |

The plain names (`static-setup.exe`, `static.dmg`) never change, so "Download"
buttons elsewhere on your site keep working from one release to the next.

## Before the first release

### 1. Choose where the files will live

With GitHub Releases there is nothing to choose: leave the `STATIC_UPDATE_URL`
variable unset. To use your own website instead, pick one https folder, for example `https://yoursite.com/download/`. Installers
are about 120 to 130 MB each. Many website hosts cap single files below that:
GitHub Pages at 100 MB and Cloudflare Pages at 25 MB, for example. Object
storage behind your domain (Cloudflare R2, Backblaze B2, Amazon S3, or a paid
Supabase Storage plan) handles large files and heavy download traffic well.
The download page can live on your normal site: when `STATIC_UPDATE_URL` is
set, its links point at that folder in full. Built without it, keep
`index.html` in the same folder as the installers.

Automatic updates need the server to answer byte-range requests, which all of
the storage services above do.

### 2. Get the installers signed

Unsigned installers work, but badly:

- **Windows:** most people see "Windows protected your PC" and must click
  *More info*, then *Run anyway*. On PCs with **Smart App Control** turned on,
  which is the default on new Windows 11 installs, an unsigned installer is
  blocked outright and cannot be run at all. An unsigned uninstaller is blocked
  there too. Signing removes the Smart App Control block and puts your name on
  the warning. A newly signed app can still show "Windows protected your PC"
  for a while, until enough people have downloaded it for Windows to trust it;
  the download page tells visitors to check the publisher name and continue.
- **Mac:** macOS refuses to open the app until the person allows it in
  *System Settings > Privacy & Security > Open Anyway*. Automatic updates also
  do not work on a Mac until the app is signed. Signing plus Apple
  notarization removes both.

**Windows** — one of:

- **Azure Trusted Signing.** The cheapest route. Check its current eligibility
  rules for your country and whether you sign as a person or a company. Then
  set `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
  `STATIC_AZURE_ENDPOINT`, `STATIC_AZURE_ACCOUNT` and `STATIC_AZURE_PROFILE`.
- **A code-signing certificate from a certificate authority** (for example
  Certum, SSL.com or Sectigo). Since 2023 these keys live on a USB token or a
  cloud service rather than in a file. Once it shows up in the Windows
  certificate store, set `STATIC_WIN_CERT_SHA1` to its thumbprint and build on
  that PC.
- An older `.pfx` file: `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`.

**The publisher name matters for updates.** Installed copies accept an update
only if it is signed by the name recorded when they were built.

- With Azure Trusted Signing, set `STATIC_PUBLISHER` to the exact name (CN) on
  the certificate. The build refuses to start without it.
- With a certificate on a token or in a file, leave `STATIC_PUBLISHER` unset
  and the name is read from the certificate, or set it to exactly that name.

`npm run release` stops if a signed build's recorded name and its real signer
differ. A mismatch cannot be fixed later, because the wrong name is inside every
copy already installed.

**Mac** — join the Apple Developer Program, create a *Developer ID
Application* certificate, export it as a `.p12`, and create an App Store
Connect API key for notarization. The release workflow takes them as secrets:
`MAC_CSC_LINK` (the `.p12`, base64), `MAC_CSC_KEY_PASSWORD`, `APPLE_API_KEY`
(the `.p8` text), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.

## Making a release

1. Raise `version` in `package.json` (for example `0.2.0` to `0.3.0`) with
   `npm version 0.3.0 --no-git-tag-version`. Updates only go to a higher
   version.
2. Add the release to `CHANGELOG.md`, and commit.
3. Push the commit, then a tag with the same version:

   ```bash
   git push origin main
   git tag v0.3.0
   git push origin v0.3.0
   ```

   The **Release** workflow (*Actions* tab) builds Windows and Mac, installs
   and launches the Windows build, checks the Mac build, and publishes the
   GitHub Release. It refuses a tag that does not match `package.json`. Add
   `GEMINI_API_KEY` (and `SUPABASE_URL`, `SUPABASE_KEY`) under *Settings >
   Secrets and variables > Actions* first, or the AI assistant is off in that
   release. That is all for GitHub Releases; steps 4 and 5 are for a website.

   Running the workflow from the *Actions* tab instead builds without
   publishing; its `static-release` artifact is the `release/` folder.

   **Windows only, on this PC, for a website:**

   ```bash
   STATIC_UPDATE_URL=https://yoursite.com/download/ npm run release
   ```

   (In PowerShell: `$env:STATIC_UPDATE_URL='https://yoursite.com/download/'; npm run release`.)

4. Website only: upload everything in `release/` to the folder in `STATIC_UPDATE_URL`,
   overwriting files with the same names. Upload the installers first and
   `latest.yml` / `latest-mac.yml` last. Installed copies then never see a
   new version before its file is there. **Keep the earlier versions'
   `.blockmap` files in the folder.** Installed copies use their own version's
   block map to download only what changed; without it every update is a full
   download. Old versioned installers can be deleted.
5. Website only: point your site's "Download" link at `index.html` in that folder, or link
   straight to `static-setup.exe` and `static.dmg`.

### Keep the update address the same

Every installed copy remembers the update address it was built with: the
latest GitHub Release, unless `STATIC_UPDATE_URL` was set. If you change it,
copies installed before the change never hear about new versions. So with
GitHub Releases, keep publishing releases there; to move to a website, keep
publishing to GitHub as well until older copies have updated.

### What automatic updates do

Installed copies check about 90 seconds after starting and every four hours.
A newer version downloads in the background, is checked against its SHA-512
in `latest.yml`, and installs the next time static is closed. **About
Static**, at the bottom of the main menu, shows the status, with *Check for
updates* and *Restart to update*. Windows downloads only the changed parts of
the installer when it can; from GitHub, the installed version's block map is
read from its own release.

## What the installers do

**Windows** (`static-setup.exe`): a one-click installer like Chrome's. It asks
no questions and needs no administrator password. It installs for the current
Windows user in `%LOCALAPPDATA%\Programs\static`, adds Start menu and desktop
shortcuts, and opens static. It also registers static as a browser, so it is
listed in *Settings > Apps > Default apps* and under *Open with* for web pages.
Windows does not let any installer make itself the default browser; that
choice is always the person's. Uninstalling, from *Apps* or the Start menu,
removes all of that again and keeps the person's bookmarks and passwords.

**Mac** (`static.dmg`): the familiar window with the app on the left and the
Applications folder on the right. One universal app runs natively on Apple
Silicon and Intel. macOS 13 Ventura or later, which Electron 44 requires. It is listed as a browser in *System
Settings > Desktop & Dock > Default web browser*.

**Both:** the app is hardened with Electron fuses. It cannot be run as plain
Node, accepts no `NODE_OPTIONS` or debugger flags, and refuses to start if its
packaged code was modified (`scripts/after-pack.cjs`). Links and files opened
from other apps open in a tab (`src/main/system-open.js`).

## Checking a build before you publish it

- `npm run release` prints whether each installer is signed and whether
  updates are on. Do not publish a build that says updates are OFF unless you
  mean to: those copies will never update themselves.
- The **Release** workflow installs the Windows build, checks its browser
  registration, launches it, and uninstalls it. On the Mac it checks the
  signature, the fuses and that the app launches.

## Building on a PC with Smart App Control

electron-builder normally makes the Windows uninstaller by running a freshly
built, unsigned helper program, which Smart App Control blocks. `scripts/dist.cjs`
makes it read the uninstaller out of that helper instead, as it already does
on macOS, so builds work on such a PC. The installers it makes are the same.
