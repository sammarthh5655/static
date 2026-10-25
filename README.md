# static

A fast, private desktop web browser built on Chromium, with real Chrome extensions, built-in ad and tracker blocking, and a password manager.

**[Download for Windows](https://github.com/sammarthh5655/static/releases/latest/download/static-setup.exe)** · **[Download for Mac](https://github.com/sammarthh5655/static/releases/latest/download/static.dmg)** · [All downloads](https://github.com/sammarthh5655/static/releases/latest)

## Install

### Windows 10 and 11

**Method 1: the installer (easiest)**

1. Download **[static-setup.exe](https://github.com/sammarthh5655/static/releases/latest/download/static-setup.exe)**.
   On a Windows on Arm laptop (Snapdragon), use [static-setup-arm64.exe](https://github.com/sammarthh5655/static/releases/latest/download/static-setup-arm64.exe) instead.
2. Open the downloaded file. static installs itself in a few seconds and opens. There are no questions and no administrator password.
3. If your browser warns that the file isn't commonly downloaded, choose **Keep**.
   If Windows shows **"Windows protected your PC"**, choose **More info**, then **Run anyway**.
   Both happen because the installer isn't code-signed yet.

If Windows blocks it completely with no **Run anyway** button, Smart App Control is on. Use Method 2, which works on those PCs.

**Method 2: from the source code (works with Smart App Control)**

1. Install [Node.js](https://nodejs.org) (the LTS version) and [Git](https://git-scm.com/download/win), accepting the default options.
2. Open **PowerShell** and run:

   ```powershell
   git clone https://github.com/sammarthh5655/static.git
   cd static
   npm install
   npm start
   ```

   `npm install` takes a few minutes the first time.
3. To open static later without PowerShell, run `npm run shortcut` once in the same folder. It adds static to your desktop and Start menu.

To update, open PowerShell in the `static` folder and run `git pull`, then `npm install`.

### Mac (macOS 13 Ventura or later)

**Method 1: the disk image (easiest)**

1. Download **[static.dmg](https://github.com/sammarthh5655/static/releases/latest/download/static.dmg)**. It works on Apple Silicon and Intel Macs.
2. Open it and drag **static** onto the **Applications** folder.
3. Open static from Applications. macOS says it can't verify the app: choose **Done**.
4. Open **System Settings > Privacy & Security**, scroll down, and choose **Open Anyway** next to static. Enter your Mac password if asked.

From then on, static opens normally. macOS asks this once because the app isn't notarized by Apple yet.

**Method 2: from the source code (no security prompt)**

1. Install [Node.js](https://nodejs.org) (the LTS version).
2. Open **Terminal**. If `git --version` says Git is missing, run `xcode-select --install` and follow the prompt.
3. Run:

   ```bash
   git clone https://github.com/sammarthh5655/static.git
   cd static
   npm install
   npm start
   ```

4. To open static later without Terminal, run `npm run shortcut` once in the same folder. It adds a launcher to your Desktop.

To update, run `git pull`, then `npm install`, in the `static` folder.

## Updating and uninstalling

- **Windows installer:** static updates itself. New versions download in the background and install the next time you close static. **About Static**, at the bottom of the main menu, shows the status.
- **Mac disk image:** download the new `static.dmg` and drag it into Applications again. Automatic updates on a Mac need an Apple-signed app.
- **Uninstall on Windows:** *Settings > Apps > Installed apps > static > Uninstall*.
- **Uninstall on a Mac:** drag static from Applications to the Bin.

Uninstalling keeps your bookmarks, history and passwords, so reinstalling brings them back.

## What's inside

- **Tabs that behave like Chrome's:** drag to reorder, tab groups, vertical tabs, split view and sleeping tabs.
- **Real Chrome extensions:** installed straight from the Chrome Web Store.
- **Shields:** blocks ads and trackers, upgrades connections to HTTPS and checks for unsafe sites.
- **Password manager:** passwords and passkeys in an encrypted vault, with autofill.
- **Bring your stuff:** imports bookmarks, history and passwords from Chrome, Edge, Brave, Firefox and Safari.
- **AI assistant:** asks Gemini about the page you're on, when a Gemini key is set.
- **Reading view, screenshots, QR codes, notes, Focus mode and Screen Time.**

## For developers

- [docs/development.md](docs/development.md): running and testing, project structure, security model, extension API gaps.
- [docs/releasing.md](docs/releasing.md): building, signing and publishing the installers.
- [CHANGELOG.md](CHANGELOG.md): what changed in each release.

## License

GPL-3.0-or-later. static uses `electron-chrome-extensions` under its free GPL-3.0 licence, so static is GPL-3.0 too. Closed-source distribution needs that library's paid licence.
