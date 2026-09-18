const path = require('node:path');
const fs = require('node:fs');
const { dialog } = require('electron');
const { JsonStore } = require('../../main/storage');

/**
 * Chrome extension support.
 *
 * Two libraries cooperate here and it matters which does what:
 * - `electron-chrome-extensions` implements the chrome.* APIs (tabs, runtime,
 *   contextMenus, browserAction popups) against OUR tab model. It needs the
 *   impl callbacks below so `chrome.tabs.create` opens a real tab in our strip.
 * - `electron-chrome-web-store` implements the Chrome Web Store install flow
 *   and loads previously installed extensions off disk at startup.
 *
 * Disabled extensions: Electron has no "disable" concept, only load/unload.
 * We persist the disabled id list ourselves and unload/reload accordingly,
 * which is why `setEnabled` reaches into the session rather than a library.
 */
class Extensions {
  constructor({ dir, session, window, onChange, createTab, selectTab, removeTab }) {
    this.session = session;
    this.window = window;
    this.onChange = onChange;
    this.store = new JsonStore(dir, 'extensions', { disabled: [] });
    this.path = path.join(dir, 'Extensions');
    fs.mkdirSync(this.path, { recursive: true });
    this.api = null;

    this.impl = {
      // chrome.tabs.create -> a real tab; must resolve with the webContents so
      // the API can report the new tab back to the calling extension.
      createTab: async (details) => {
        const contents = createTab(details);
        if (!contents) throw new Error('Unable to create tab');
        return [contents, window];
      },
      selectTab: (contents) => selectTab(contents),
      removeTab: (contents) => removeTab(contents),
      // Extensions may not prompt for new permissions at runtime; everything
      // they need is declared in the manifest at install time.
      requestPermissions: async () => false,
    };
  }

  /** Must run after app 'ready'. Loads installed extensions and the store API. */
  async start() {
    const { ElectronChromeExtensions } = require('electron-chrome-extensions');
    const { installChromeWebStore } = require('electron-chrome-web-store');

    this.api = new ElectronChromeExtensions({
      // GPL-3.0 is the free license option for this library; it is why this
      // project is also GPL-3.0. See README "License".
      license: 'GPL-3.0',
      session: this.session,
      ...this.impl,
    });

    // Required for <browser-action-list> icons in our chrome to resolve.
    ElectronChromeExtensions.handleCRXProtocol(this.session);

    await installChromeWebStore({
      session: this.session,
      extensionsPath: this.path,
      loadExtensions: true,
      allowUnpackedExtensions: true,
      autoUpdate: true,
      minimumManifestVersion: 2,
    });

    // Honour the persisted disabled list on this launch.
    for (const id of this.disabled()) this.unload(id);

    this.session.on('extension-loaded', () => this.onChange?.());
    this.session.on('extension-unloaded', () => this.onChange?.());
    this.onChange?.();
  }

  disabled() { return this.store.data.disabled || []; }

  /**
   * Electron 44 moved extension methods to `session.extensions` and deprecated
   * the old `session.*` ones. Resolve through this so we use the modern API
   * where present without breaking on older Electron.
   */
  get ext() { return this.session.extensions || this.session; }

  list() {
    const disabled = new Set(this.disabled());
    const loaded = this.ext.getAllExtensions().map(ext => ({
      id: ext.id,
      name: ext.name,
      version: ext.version,
      description: ext.manifest?.description || '',
      manifestVersion: ext.manifest?.manifest_version || 2,
      optionsPage: ext.manifest?.options_page || ext.manifest?.options_ui?.page || null,
      path: ext.path,
      enabled: true,
    }));
    // Disabled extensions are unloaded, so read their manifests off disk to
    // keep them visible (and re-enableable) in the manager.
    const offline = [...disabled]
      .filter(id => !loaded.some(ext => ext.id === id))
      .map(id => this.readManifest(id))
      .filter(Boolean);
    return [...loaded, ...offline].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Read a disabled extension's manifest from the versioned install layout. */
  readManifest(id) {
    try {
      const base = path.join(this.path, id);
      const versions = fs.readdirSync(base).filter(entry =>
        fs.statSync(path.join(base, entry)).isDirectory());
      if (!versions.length) return null;
      const dir = path.join(base, versions.sort().pop());
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      return {
        id,
        name: manifest.name || id,
        version: manifest.version || '',
        description: manifest.description || '',
        manifestVersion: manifest.manifest_version || 2,
        optionsPage: manifest.options_page || manifest.options_ui?.page || null,
        path: dir,
        enabled: false,
      };
    } catch { return null; }
  }

  unload(id) {
    try { this.ext.removeExtension(id); } catch { /* already unloaded */ }
  }

  async setEnabled(id, enabled) {
    const disabled = new Set(this.disabled());
    if (enabled) {
      disabled.delete(id);
      const info = this.readManifest(id);
      if (info) await this.ext.loadExtension(info.path, { allowFileAccess: true });
    } else {
      disabled.add(id);
      this.unload(id);
    }
    this.store.save({ ...this.store.data, disabled: [...disabled] });
    this.onChange?.();
  }

  async remove(id) {
    const { uninstallExtension } = require('electron-chrome-web-store');
    try {
      await uninstallExtension(id, { session: this.session, extensionsPath: this.path });
    } catch {
      // Unpacked extensions were never "installed" by the web store; just drop
      // them from the session so they disappear until loaded again.
      this.unload(id);
    }
    this.store.save({ ...this.store.data, disabled: this.disabled().filter(x => x !== id) });
    this.onChange?.();
  }

  /** "Load unpacked" - the developer-mode button on the extensions page. */
  async loadUnpacked() {
    const result = await dialog.showOpenDialog(this.window, {
      title: 'Select extension folder',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const ext = await this.ext.loadExtension(result.filePaths[0], { allowFileAccess: true });
    this.onChange?.();
    return { id: ext.id, name: ext.name };
  }

  /** Packed .crx picked from disk, installed through the web store loader. */
  async loadCrx() {
    const result = await dialog.showOpenDialog(this.window, {
      title: 'Select .crx file',
      properties: ['openFile'],
      filters: [{ name: 'Chrome extension', extensions: ['crx'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const { installExtension } = require('electron-chrome-web-store');
    const ext = await installExtension(result.filePaths[0], {
      session: this.session, extensionsPath: this.path,
    });
    this.onChange?.();
    return ext ? { id: ext.id, name: ext.name } : null;
  }

  /** Open an extension's options page in a new tab. */
  optionsUrl(id) {
    const ext = this.list().find(e => e.id === id);
    if (!ext?.optionsPage) return null;
    return `chrome-extension://${id}/${String(ext.optionsPage).replace(/^\//, '')}`;
  }

  /** Context menu items contributed by extensions, for our tab context menu. */
  contextMenuItems(contents, params) {
    try { return this.api?.getContextMenuItems(contents, params) || []; }
    catch { return []; }
  }

  addTab(contents, window) { try { this.api?.addTab(contents, window); } catch { /* noop */ } }
  selectTab(contents) { try { this.api?.selectTab(contents); } catch { /* noop */ } }
  removeTab(contents) { try { this.api?.removeTab(contents); } catch { /* noop */ } }
}

module.exports = { Extensions };
