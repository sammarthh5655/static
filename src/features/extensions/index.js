'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, dialog, BrowserWindow } = require('electron');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');
const {
  installChromeWebStore,
  uninstallExtension,
  updateExtensions,
} = require('electron-chrome-web-store');
const { JsonStore } = require('../../main/lib/json-store');
const ipc = require('../../main/ipc');

/**
 * Extensions feature — the bridge between our tabs/windows and the Chrome
 * extension platform provided by two libraries:
 *
 *  - electron-chrome-extensions: implements chrome.tabs / windows / action /
 *    contextMenus / ... on top of Electron's built-in extension loader. It
 *    needs to be told about our tabs (`addTab` / `selectTab` / `removeTab`)
 *    and asks us to create tabs/windows through the `createTab` etc. hooks.
 *  - electron-chrome-web-store: makes chromewebstore.google.com's "Add to
 *    Chrome" button work by injecting a preload on the tab session, downloads
 *    the .crx, unpacks it to `userData/Extensions/<id>/<version>/`, loads it,
 *    and auto-updates.
 *
 * Enable/disable: Electron has no concept of a disabled extension — an
 * extension is either loaded or not. We implement "disabled" as: unload it
 * and remember the id in `extensions.json` so startup skips it. The
 * extensions page still lists it by reading its manifest from disk.
 *
 * Persisted state (`userData/extensions.json`):
 *   { disabled: string[], unpacked: [{ id, path }] }
 */
class Extensions {
  constructor(ctx) {
    this.ctx = ctx;
    this.session = ctx.tabSession;
    this.extensionsPath = path.join(app.getPath('userData'), 'Extensions');
    this.store = new JsonStore('extensions', { disabled: [], unpacked: [] });
    this.api = null;
    this.urlOverrides = {};
  }

  get sessionExtensions() {
    return this.session.extensions;
  }

  async init() {
    const { windows } = this.ctx;

    this.api = new ElectronChromeExtensions({
      // See LICENSE note in README: GPL-3.0 or a Patron license is required.
      license: 'GPL-3.0',
      session: this.session,

      // chrome.tabs.create -> new tab in the focused window (or the one the
      // extension asked for).
      createTab: async (details) => {
        let controller = null;
        if (typeof details.windowId === 'number') {
          const win = BrowserWindow.fromId(details.windowId);
          controller = win ? windows.fromBrowserWindow(win) : null;
        }
        controller = controller || windows.focused() || windows.createWindow();
        const tab = controller.tabs.create({
          url: details.url || this.ctx.settings.newTabUrl(),
          active: details.active !== false,
          index: typeof details.index === 'number' ? details.index : undefined,
        });
        return [tab.wc, controller.win];
      },
      selectTab: (wc, win) => {
        const controller = windows.fromBrowserWindow(win);
        const tab = controller?.tabs.fromWebContents(wc);
        if (tab) controller.tabs.select(tab.id);
      },
      removeTab: (wc, win) => {
        const controller = windows.fromBrowserWindow(win);
        const tab = controller?.tabs.fromWebContents(wc);
        if (tab) controller.tabs.close(tab.id);
      },
      createWindow: async (details) => {
        const url = Array.isArray(details.url) ? details.url[0] : details.url;
        const controller = windows.createWindow({ url });
        return controller.win;
      },
      removeWindow: (win) => win.close(),
      requestPermissions: (extension, permissions) => this._promptPermissions(extension, permissions),
    });

    // `crx://` serves extension action icons to <browser-action-list> which
    // lives in the UI chrome (default session), so handle it there — and in
    // the tab session too so internal pages could use it later.
    ElectronChromeExtensions.handleCRXProtocol(this.ctx.uiSession);
    ElectronChromeExtensions.handleCRXProtocol(this.session);

    this.api.on('url-overrides-updated', (overrides) => {
      this.urlOverrides = overrides || {};
    });

    this.sessionExtensions.on('extension-loaded', () => this._changed());
    this.sessionExtensions.on('extension-unloaded', () => this._changed());

    await installChromeWebStore({
      session: this.session,
      extensionsPath: this.extensionsPath,
      // We do our own loading below so disabled extensions stay unloaded.
      loadExtensions: false,
      autoUpdate: true,
      beforeInstall: (details) => this._promptInstall(details),
    });

    await this.loadInstalled();
    this.ctx.extensions = this.api;
  }

  // ---- loading --------------------------------------------------------------

  /** Load every store + unpacked extension that isn't disabled. */
  async loadInstalled() {
    const disabled = new Set(this.store.data.disabled);

    for (const ext of this._discoverStoreExtensions()) {
      if (disabled.has(ext.id)) continue;
      await this._load(ext.path);
    }

    const stillValid = [];
    for (const entry of this.store.data.unpacked) {
      if (!fs.existsSync(path.join(entry.path, 'manifest.json'))) continue; // folder gone
      stillValid.push(entry);
      if (disabled.has(entry.id)) continue;
      const loaded = await this._load(entry.path, { allowFileAccess: true });
      if (loaded) entry.id = loaded.id;
    }
    this.store.data.unpacked = stillValid;
    this.store.save();
  }

  async _load(extPath, options = {}) {
    try {
      const ext = await this.sessionExtensions.loadExtension(extPath, options);
      // MV3 background service workers don't start on their own in Electron.
      if (ext.manifest.manifest_version === 3 && ext.manifest.background?.service_worker) {
        await this.session.serviceWorkers.startWorkerForScope(`chrome-extension://${ext.id}`).catch((err) => {
          console.error(`extensions: failed to start service worker for ${ext.id}`, err);
        });
      }
      return ext;
    } catch (err) {
      console.error(`extensions: failed to load ${extPath}`, err);
      return null;
    }
  }

  /**
   * Web-store extensions live at Extensions/<id>/<version>/. Pick the newest
   * version directory per id.
   * @returns {{id: string, path: string, manifest: object}[]}
   */
  _discoverStoreExtensions() {
    const out = [];
    let ids = [];
    try {
      ids = fs.readdirSync(this.extensionsPath, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return out;
    }
    for (const id of ids) {
      const idDir = path.join(this.extensionsPath, id);
      let best = null;
      for (const entry of fs.readdirSync(idDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(idDir, entry.name);
        const manifest = readManifest(dir);
        if (!manifest) continue;
        if (!best || compareVersions(manifest.version, best.manifest.version) > 0) {
          best = { id, path: dir, manifest };
        }
      }
      if (best) out.push(best);
    }
    return out;
  }

  // ---- queries --------------------------------------------------------------

  /** Extension id -> install type, based on where it lives on disk. */
  _typeOf(id, extPath) {
    if (this.store.data.unpacked.some((u) => u.id === id)) return 'unpacked';
    if (extPath && extPath.startsWith(this.extensionsPath)) return 'store';
    return 'unpacked';
  }

  /** Full list for the extensions page: loaded ones + disabled ones on disk. */
  list() {
    const disabled = new Set(this.store.data.disabled);
    const items = [];
    const seen = new Set();

    for (const ext of this.sessionExtensions.getAllExtensions()) {
      seen.add(ext.id);
      items.push(this._describe(ext.id, ext.path, ext.manifest, !disabled.has(ext.id)));
    }

    // Disabled extensions aren't loaded, so describe them from disk.
    for (const ext of this._discoverStoreExtensions()) {
      if (seen.has(ext.id)) continue;
      seen.add(ext.id);
      items.push(this._describe(ext.id, ext.path, ext.manifest, false));
    }
    for (const entry of this.store.data.unpacked) {
      if (seen.has(entry.id)) continue;
      const manifest = readManifest(entry.path);
      if (!manifest) continue;
      seen.add(entry.id);
      items.push(this._describe(entry.id, entry.path, manifest, false));
    }

    return items.sort((a, b) => a.name.localeCompare(b.name));
  }

  _describe(id, extPath, manifest, enabled) {
    const name = localize(manifest.name, extPath) || id;
    const optionsPage = manifest.options_ui?.page || manifest.options_page || '';
    return {
      id,
      name,
      version: manifest.version,
      description: localize(manifest.description, extPath) || '',
      enabled,
      manifestVersion: manifest.manifest_version,
      type: this._typeOf(id, extPath),
      path: extPath,
      icon: iconDataUrl(extPath, manifest),
      optionsUrl: optionsPage ? `chrome-extension://${id}/${optionsPage.replace(/^\//, '')}` : '',
      homepageUrl: manifest.homepage_url || '',
      permissions: manifest.permissions || [],
      hostPermissions: manifest.host_permissions || [],
    };
  }

  /** chrome_url_overrides.newtab from an enabled extension, if any. */
  newTabOverride() {
    return this.urlOverrides.newtab || null;
  }

  // ---- mutations ------------------------------------------------------------

  async enable(id) {
    this.store.data.disabled = this.store.data.disabled.filter((d) => d !== id);
    this.store.save();
    if (this.sessionExtensions.getExtension(id)) return this._changed();

    const unpacked = this.store.data.unpacked.find((u) => u.id === id);
    if (unpacked) {
      await this._load(unpacked.path, { allowFileAccess: true });
    } else {
      const found = this._discoverStoreExtensions().find((e) => e.id === id);
      if (found) await this._load(found.path);
    }
    this._changed();
  }

  async disable(id) {
    if (!this.store.data.disabled.includes(id)) this.store.data.disabled.push(id);
    this.store.save();
    if (this.sessionExtensions.getExtension(id)) this.sessionExtensions.removeExtension(id);
    this._changed();
  }

  async remove(id) {
    const unpackedIdx = this.store.data.unpacked.findIndex((u) => u.id === id);
    if (unpackedIdx !== -1) {
      if (this.sessionExtensions.getExtension(id)) this.sessionExtensions.removeExtension(id);
      this.store.data.unpacked.splice(unpackedIdx, 1);
    } else {
      // Store extension: unloads + deletes Extensions/<id>/ from disk.
      await uninstallExtension(id, { session: this.session, extensionsPath: this.extensionsPath });
    }
    this.store.data.disabled = this.store.data.disabled.filter((d) => d !== id);
    this.store.save();
    this._changed();
  }

  /** "Load unpacked" — pick a folder containing manifest.json. */
  async loadUnpackedDialog(win) {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Select the extension directory',
      properties: ['openDirectory'],
    });
    if (canceled || !filePaths[0]) return null;
    const dir = filePaths[0];
    if (!readManifest(dir)) {
      dialog.showErrorBox('Not an extension', `No manifest.json found in:\n${dir}`);
      return null;
    }
    const ext = await this._load(dir, { allowFileAccess: true });
    if (!ext) {
      dialog.showErrorBox('Failed to load extension', `Could not load the extension in:\n${dir}\n\nCheck the terminal for details.`);
      return null;
    }
    if (!this.store.data.unpacked.some((u) => u.path === dir)) {
      this.store.data.unpacked.push({ id: ext.id, path: dir });
    }
    this.store.data.disabled = this.store.data.disabled.filter((d) => d !== ext.id);
    this.store.save();
    this._changed();
    return ext.id;
  }

  openOptions(controller, id) {
    const ext = this.sessionExtensions.getExtension(id);
    if (!ext) return false;
    const page = ext.manifest.options_ui?.page || ext.manifest.options_page;
    if (!page) return false;
    controller.tabs.create({ url: `chrome-extension://${id}/${page.replace(/^\//, '')}` });
    return true;
  }

  async checkUpdates() {
    await updateExtensions(this.session);
    this._changed();
    return true;
  }

  // ---- prompts --------------------------------------------------------------

  /** Chrome Web Store "Add to Chrome" confirmation. */
  async _promptInstall(details) {
    const perms = describePermissions(details.manifest);
    const win = details.browserWindow || BrowserWindow.getFocusedWindow() || undefined;
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Add extension', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: `Add “${details.localizedName}”?`,
      message: `Add “${details.localizedName}”?`,
      detail: perms.length ? `It can:\n• ${perms.join('\n• ')}` : 'This extension requests no special permissions.',
      icon: details.icon && !details.icon.isEmpty() ? details.icon : undefined,
    });
    return { action: response === 0 ? 'allow' : 'deny' };
  }

  /** chrome.permissions.request */
  async _promptPermissions(extension, permissions) {
    const list = [...(permissions.permissions || []), ...(permissions.origins || [])];
    const { response } = await dialog.showMessageBox(BrowserWindow.getFocusedWindow() || undefined, {
      type: 'question',
      buttons: ['Allow', 'Deny'],
      defaultId: 1,
      cancelId: 1,
      title: `“${extension.name}” requests additional permissions`,
      message: `“${extension.name}” requests additional permissions`,
      detail: list.length ? `• ${list.join('\n• ')}` : '',
    });
    return response === 0;
  }

  _changed() {
    ipc.broadcastPages('extensions:changed', this.list());
  }

  registerIpc() {
    const { windows } = this.ctx;
    ipc.handle('extensions:list', () => this.list());
    ipc.handle('extensions:enable', (_e, id) => this.enable(String(id)));
    ipc.handle('extensions:disable', (_e, id) => this.disable(String(id)));
    ipc.handle('extensions:remove', (_e, id) => this.remove(String(id)));
    ipc.handle('extensions:load-unpacked', (e) => this.loadUnpackedDialog(windows.fromWebContents(e.sender)?.win));
    ipc.handle('extensions:open-options', (e, id) => {
      const c = windows.fromWebContents(e.sender);
      return c ? this.openOptions(c, String(id)) : false;
    });
    ipc.handle('extensions:check-updates', () => this.checkUpdates());
  }
}

// ---- helpers ----------------------------------------------------------------

function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** "1.2.10" vs "1.2.9" numeric comparison, tolerant of odd formats. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Resolve "__MSG_name__" via _locales/<default_locale>/messages.json. */
function localize(value, extPath) {
  if (typeof value !== 'string') return value;
  const m = value.match(/^__MSG_(.+)__$/);
  if (!m) return value;
  try {
    const manifest = readManifest(extPath);
    const locale = manifest?.default_locale || 'en';
    const candidates = [locale, 'en', 'en_US'];
    for (const loc of candidates) {
      const file = path.join(extPath, '_locales', loc, 'messages.json');
      if (!fs.existsSync(file)) continue;
      const messages = JSON.parse(fs.readFileSync(file, 'utf8'));
      const entry = messages[m[1]] || messages[m[1].toLowerCase()];
      if (entry?.message) return entry.message;
    }
  } catch {
    // fall through
  }
  return value;
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.webp': 'image/webp' };

/** Best icon (largest <= 128px) from manifest.icons or the action icon. */
function iconDataUrl(extPath, manifest) {
  const sources = [manifest.icons, manifest.action?.default_icon, manifest.browser_action?.default_icon];
  for (const src of sources) {
    let rel = null;
    if (typeof src === 'string') rel = src;
    else if (src && typeof src === 'object') {
      const sizes = Object.keys(src).map(Number).filter((n) => n <= 128).sort((a, b) => b - a);
      rel = src[sizes[0]] || src[Object.keys(src)[0]];
    }
    if (!rel) continue;
    const file = path.join(extPath, rel.replace(/^\//, ''));
    try {
      const data = fs.readFileSync(file);
      const mime = MIME[path.extname(file).toLowerCase()] || 'image/png';
      return `data:${mime};base64,${data.toString('base64')}`;
    } catch {
      // try next source
    }
  }
  return '';
}

/** Human-readable permission warnings for the install prompt. */
function describePermissions(manifest) {
  const out = [];
  const perms = new Set(manifest.permissions || []);
  const hosts = [...(manifest.host_permissions || []), ...[...perms].filter((p) => p.includes('://'))];
  if (hosts.some((h) => h === '<all_urls>' || h.startsWith('*://*/') || h.startsWith('http://*/') || h.startsWith('https://*/'))) {
    out.push('Read and change all your data on all websites');
  } else if (hosts.length) {
    out.push(`Read and change your data on: ${hosts.slice(0, 5).join(', ')}${hosts.length > 5 ? '…' : ''}`);
  }
  const labels = {
    tabs: 'Read your browsing history',
    history: 'Read and change your browsing history',
    bookmarks: 'Read and change your bookmarks',
    cookies: 'Read and change cookies',
    downloads: 'Manage your downloads',
    clipboardRead: 'Read data you copy and paste',
    clipboardWrite: 'Modify data you copy and paste',
    geolocation: 'Detect your physical location',
    notifications: 'Display notifications',
    webRequest: 'Observe network requests',
    webRequestBlocking: 'Block network requests',
    declarativeNetRequest: 'Block content on any page you visit',
    management: 'Manage your other extensions',
    nativeMessaging: 'Communicate with native applications',
    tabCapture: 'Capture tab content',
    desktopCapture: 'Capture your screen',
    identity: 'Know your email address',
  };
  for (const p of perms) if (labels[p]) out.push(labels[p]);
  return out;
}

module.exports = { Extensions };
