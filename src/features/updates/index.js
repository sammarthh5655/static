/**
 * Updates, from the website the installers are downloaded from.
 *
 * How it is switched on: build with STATIC_UPDATE_URL set to the folder on
 * the website that holds the release files (see docs/releasing.md).
 * electron-builder then writes resources/app-update.yml into the app, and
 * this checks that address for latest.yml (Windows) / latest-mac.yml (macOS).
 * A build without it - every developer build, and any packaged build made
 * without the address - has no app-update.yml, and this does nothing at all:
 * no network request, no timer.
 *
 * What happens:
 * - A check 90 seconds after start, then every four hours, and whenever the
 *   person presses "Check for updates" in About.
 * - A newer version downloads in the background. electron-updater checks
 *   its SHA-512 against latest.yml before using it, and on Windows, once the
 *   installers are code-signed, that the new installer is signed by the same
 *   publisher (verifyUpdateCodeSignature).
 * - It installs when static is next closed, and the person is told once.
 *
 * macOS only accepts updates for a code-signed app. An ad-hoc build (no Apple
 * Developer ID yet) says so in About instead of failing on every check.
 */
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const FIRST_CHECK = 90 * 1000;
const EVERY = 4 * 60 * 60 * 1000;

class Updates {
  /**
   * `notify(text)` shows a notice in the window in front.
   * `beforeInstall()` runs just before "Restart to update" closes static, so
   *   every window is kept in the saved session (as on an ordinary quit).
   * `holdInstall()` says an update must not install now: true while an
   *   incognito window is open, which the installer would close unasked.
   */
  constructor({ notify = () => {}, onChange = () => {}, beforeInstall = () => {}, holdInstall = () => false } = {}) {
    this.notify = notify;
    this.onChange = onChange;
    this.beforeInstall = beforeInstall;
    this.holdInstall = holdInstall;
    this.status = 'off';          // off | incognito | unsigned-mac | idle | checking | downloading | ready | current | error
    this.version = null;          // the version found or downloaded
    this.progress = 0;            // percent, while downloading
    this.checkedAt = 0;
    this.error = '';
    this.updater = null;
  }

  /** Where electron-builder put the update address, if it did. */
  static feedFile() {
    return app.isPackaged ? path.join(process.resourcesPath, 'app-update.yml') : null;
  }

  start() {
    const feed = Updates.feedFile();
    if (!feed || !fs.existsSync(feed)) return; // built without an update address
    if (process.platform === 'darwin' && !Updates.macSigned()) {
      this.status = 'unsigned-mac';
      return;
    }
    const { autoUpdater } = require('electron-updater');
    this.updater = autoUpdater;
    // Served from GitHub's "latest release" folder, the installed version's
    // own block map is not there (it is in that version's release), so an
    // update could never download only what changed. Point it at the release
    // this copy came from.
    const github = /url:\s*['"]?https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/releases\/latest\/download\/?/.exec(fs.readFileSync(feed, 'utf8'));
    if (github) autoUpdater.previousBlockmapBaseUrlOverride = 'https://github.com/' + github[1] + '/' + github[2] + '/releases/download/v' + app.getVersion() + '/';
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false;
    // Its own logging goes to the console only when something is wrong.
    autoUpdater.logger = { info() {}, debug() {}, warn: (m) => console.warn('[updates]', m), error: (m) => console.error('[updates]', m) };

    autoUpdater.on('checking-for-update', () => this.#set('checking'));
    autoUpdater.on('update-not-available', () => { this.checkedAt = Date.now(); this.#set('current'); });
    autoUpdater.on('update-available', (info) => { this.version = info?.version || null; this.progress = 0; this.#set('downloading'); });
    autoUpdater.on('download-progress', (p) => { this.progress = Math.round(p?.percent || 0); this.onChange(); });
    autoUpdater.on('update-downloaded', (info) => {
      this.checkedAt = Date.now();
      this.version = info?.version || this.version;
      this.#set('ready');
      this.notify(`static ${this.version} is ready. It installs the next time you close static.`);
    });
    autoUpdater.on('error', (error) => {
      this.checkedAt = Date.now();
      this.error = String(error?.message || error).split('\n')[0].slice(0, 200);
      this.#set('error');
    });

    // Installing on quit closes every static process. While an incognito
    // window is open, leave the update for a later close instead.
    app.on('before-quit', () => {
      if (this.updater && this.status === 'ready' && this.holdInstall()) this.updater.autoInstallOnAppQuit = false;
    });

    this.status = 'idle';
    this.firstTimer = setTimeout(() => this.check(), FIRST_CHECK);
    this.timer = setInterval(() => this.check(), EVERY);
    this.firstTimer.unref?.();
  }

  /** Ask now. Resolves with describe() once the check has an answer. */
  async check() {
    if (!this.updater) return this.describe();
    if (this.status === 'checking' || this.status === 'downloading' || this.status === 'ready') return this.describe();
    try {
      const result = await this.updater.checkForUpdates();
      // The download is a promise of its own. A failed one is reported
      // through 'error'; left unhandled it would surface as Electron's
      // "A JavaScript error occurred in the main process" box.
      result?.downloadPromise?.catch(() => {});
    } catch { /* reported through 'error' */ }
    return this.describe();
  }

  /** Restart into a downloaded update right away, instead of at the next close. */
  installNow() {
    if (this.status !== 'ready' || !this.updater) return false;
    if (this.holdInstall()) {
      this.notify('Close your incognito windows first: installing the update closes every static window.');
      return false;
    }
    this.beforeInstall();
    // isSilent: no installer window on Windows; forceRunAfter: open again.
    setImmediate(() => this.updater.quitAndInstall(true, true));
    return true;
  }

  /** For About: what the person can act on, in a sentence. */
  describe() {
    const text = {
      off: app.isPackaged
        ? 'This build does not update itself. Download new versions from github.com/sammarthh5655/static/releases.'
        : 'Developer build: updates come from the source code.',
      incognito: 'Updates are checked and installed by your normal static windows.',
      'unsigned-mac': 'Automatic updates need an Apple-signed Mac build. Download the new static.dmg from github.com/sammarthh5655/static/releases.',
      idle: 'static checks for updates automatically.',
      checking: 'Checking for updates…',
      downloading: `Downloading static ${this.version || ''}… ${this.progress}%`,
      ready: `static ${this.version || ''} is ready and installs the next time you close static.`,
      current: 'static is up to date.',
      error: 'The last update check did not finish' + (this.error ? ': ' + this.error : '.') + ' It will try again later.',
    }[this.status];
    return { status: this.status, text, version: this.version, progress: this.progress, checkedAt: this.checkedAt, canCheck: !!this.updater, canInstall: this.status === 'ready' };
  }

  #set(status) {
    this.status = status;
    if (status !== 'error') this.error = '';
    this.onChange();
  }

  /**
   * Whether this Mac app is signed by a Developer ID, which macOS requires
   * before it will apply an update. Ad-hoc builds have no TeamIdentifier.
   */
  static macSigned() {
    try {
      const appPath = path.resolve(process.execPath, '..', '..', '..');
      // codesign -dv writes its report to stderr, even when it succeeds.
      const result = require('node:child_process').spawnSync('/usr/bin/codesign', ['-dv', appPath], { encoding: 'utf8', timeout: 10000 });
      return /TeamIdentifier=(?!not set)\S+/.test((result.stdout || '') + (result.stderr || ''));
    } catch {
      return false;
    }
  }

  stop() {
    clearTimeout(this.firstTimer);
    clearInterval(this.timer);
  }
}

module.exports = { Updates };
