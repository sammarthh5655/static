const path = require('node:path');
const fs = require('node:fs');
const { dialog } = require('electron');
const { randomUUID } = require('node:crypto');
const { JsonStore } = require('../../main/storage');
const { unpackCrxFile } = require('./crx');

/** The system file picker, over `parent` when there is a window to put it over. */
function openDialog(parent, options) {
  return parent && !parent.isDestroyed?.() ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options);
}

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
 *
 * Where each kind of extension lives, which decides how it comes back after
 * a restart and what "remove" deletes:
 * - Web Store installs and .crx files: unpacked into `Extensions/<id>/<version>_0`
 *   with the public key in manifest.json. electron-chrome-web-store finds and
 *   loads everything there at startup. Removing deletes that folder.
 * - "Load unpacked": stays in the folder the person picked, as in Chrome, so
 *   edits show after a reload. Only its { id, path } is recorded (in
 *   extensions.json, `unpacked`) and loaded again at startup. Removing forgets
 *   the record and NEVER deletes the person's folder.
 */
class Extensions {
  /**
   * `getWindow()` is the window in front: where an extension's dialogs sit,
   * and where chrome.tabs.create opens a tab. `createTab` answers with the
   * new tab's contents and the window it opened in.
   */
  constructor({ dir, session, getWindow, onChange, createTab, selectTab, removeTab }) {
    this.session = session;
    this.getWindow = getWindow || (() => null);
    this.onChange = onChange;
    this.store = new JsonStore(dir, 'extensions', { disabled: [], unpacked: [] });
    this.path = path.join(dir, 'Extensions');
    // .crx files are unpacked here first and moved into Extensions/ only once
    // they verified and unpacked completely, so the startup loader never sees
    // half an extension.
    this.staging = path.join(dir, 'ExtensionStaging');
    fs.mkdirSync(this.path, { recursive: true });
    this.api = null;

    this.impl = {
      // chrome.tabs.create -> a real tab; must resolve with the webContents so
      // the API can report the new tab back to the calling extension.
      createTab: async (details) => {
        const made = createTab(details);
        if (!made?.contents) throw new Error('Unable to create tab');
        return [made.contents, made.window];
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

    // Unpacked extensions are not in Extensions/, so the web store loader
    // never sees them: load each recorded folder ourselves. A folder that has
    // gone (a moved project, an unplugged drive) is skipped, not forgotten -
    // it stays listed so it can be removed, and loads again if it comes back.
    const disabled = new Set(this.disabled());
    for (const record of this.unpacked()) {
      if (disabled.has(record.id) || this.ext.getExtension(record.id)) continue;
      try {
        await this.ext.loadExtension(record.path, { allowFileAccess: true });
      } catch (error) {
        console.error('Unpacked extension did not load:', record.path, error.message);
      }
    }
    // Leftovers from an install interrupted by a crash.
    fs.rmSync(this.staging, { recursive: true, force: true });

    this.session.on('extension-loaded', () => this.onChange?.());
    this.session.on('extension-unloaded', () => this.onChange?.());
    this.onChange?.();
  }

  disabled() { return this.store.data.disabled || []; }

  /** Recorded "Load unpacked" folders: [{ id, path }]. */
  unpacked() { return this.store.data.unpacked || []; }

  unpackedRecord(id) { return this.unpacked().find((record) => record.id === id) || null; }

  /**
   * Electron 44 moved extension methods to `session.extensions` and deprecated
   * the old `session.*` ones. Resolve through this so we use the modern API
   * where present without breaking on older Electron.
   */
  get ext() { return this.session.extensions || this.session; }

  list() {
    const disabled = new Set(this.disabled());
    const loaded = this.ext.getAllExtensions().map((ext) => ({
      id: ext.id,
      name: ext.name,
      version: ext.version,
      description: ext.manifest?.description || '',
      manifestVersion: ext.manifest?.manifest_version || 2,
      optionsPage: ext.manifest?.options_page || ext.manifest?.options_ui?.page || null,
      path: ext.path,
      unpacked: !!this.unpackedRecord(ext.id),
      enabled: true,
    }));
    // Disabled extensions are unloaded, and an unpacked folder that has gone
    // missing never loaded: read their manifests off disk so they stay
    // visible - and can be re-enabled or removed - in the manager.
    const offline = [...new Set([...disabled, ...this.unpacked().map((record) => record.id)])]
      .filter((id) => !loaded.some((ext) => ext.id === id))
      .map((id) => this.readManifest(id))
      .filter(Boolean);
    return [...loaded, ...offline].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Manifest of an extension that is not loaded: from its recorded folder if
   * it was loaded unpacked, else from the versioned install layout.
   */
  readManifest(id) {
    const record = this.unpackedRecord(id);
    if (record) {
      try {
        const text = fs.readFileSync(path.join(record.path, 'manifest.json'), 'utf8').replace(/^﻿/, '');
        return this.#describe(id, JSON.parse(text), record.path, { unpacked: true, enabled: false });
      } catch {
        // Listed anyway, so it can be removed; it loads again if the folder returns.
        return {
          id,
          name: path.basename(record.path) || id,
          version: '',
          description: 'Folder not found: ' + record.path,
          manifestVersion: 3,
          optionsPage: null,
          path: record.path,
          unpacked: true,
          missing: true,
          enabled: false,
        };
      }
    }
    try {
      const base = path.join(this.path, id);
      const versions = fs.readdirSync(base).filter((entry) =>
        fs.statSync(path.join(base, entry)).isDirectory());
      if (!versions.length) return null;
      const dir = path.join(base, versions.sort().pop());
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      return this.#describe(id, manifest, dir, { unpacked: false, enabled: false });
    } catch { return null; }
  }

  #describe(id, manifest, dir, extra) {
    return {
      id,
      name: manifest.name || id,
      version: manifest.version || '',
      description: manifest.description || '',
      manifestVersion: manifest.manifest_version || 2,
      optionsPage: manifest.options_page || manifest.options_ui?.page || null,
      path: dir,
      ...extra,
    };
  }

  unload(id) {
    try { this.ext.removeExtension(id); } catch { /* already unloaded */ }
  }

  async setEnabled(id, enabled) {
    if (typeof id !== 'string' || !id) return;
    const disabled = new Set(this.disabled());
    if (enabled) {
      disabled.delete(id);
      const info = this.readManifest(id);
      if (info && !info.missing && !this.ext.getExtension(id)) {
        await this.ext.loadExtension(info.path, { allowFileAccess: true });
      }
    } else {
      disabled.add(id);
      this.unload(id);
    }
    this.store.save({ ...this.store.data, disabled: [...disabled] });
    this.onChange?.();
  }

  async remove(id) {
    if (typeof id !== 'string' || !id) return;
    if (this.unpackedRecord(id)) {
      // An unpacked extension lives in the person's own folder: forget it,
      // never delete it. That folder may be their source code.
      this.unload(id);
      this.store.save({ ...this.store.data, unpacked: this.unpacked().filter((record) => record.id !== id) });
    } else {
      const { uninstallExtension } = require('electron-chrome-web-store');
      try {
        // Unloads it and deletes Extensions/<id> - our copy, nothing else.
        await uninstallExtension(id, { session: this.session, extensionsPath: this.path });
      } catch {
        this.unload(id);
      }
    }
    this.store.save({ ...this.store.data, disabled: this.disabled().filter((x) => x !== id) });
    this.onChange?.();
  }

  /**
   * "Load unpacked" - the developer-mode button on the extensions page.
   * `dir` skips the folder picker (tests, and anything that already knows it).
   * Returns { ok, id, name } or { ok: false, error } for the page to show.
   */
  async loadUnpacked(parent = this.getWindow(), dir = null) {
    if (!dir) {
      const result = await openDialog(parent, { title: 'Select extension folder', properties: ['openDirectory'] });
      if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
      dir = result.filePaths[0];
    }
    dir = path.resolve(dir);
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
      return { ok: false, error: 'That folder has no manifest.json. Choose the folder that contains it.' };
    }
    let ext;
    try {
      // Loading the same folder again picks up edits, as Chrome's reload does.
      const already = this.unpacked().find((record) => path.resolve(record.path) === dir);
      if (already) this.unload(already.id);
      ext = await this.ext.loadExtension(dir, { allowFileAccess: true });
    } catch (error) {
      return { ok: false, error: 'The extension did not load: ' + (error?.message || error) };
    }
    const records = this.unpacked().filter((record) => record.id !== ext.id && path.resolve(record.path) !== dir);
    this.store.save({
      ...this.store.data,
      unpacked: [...records, { id: ext.id, path: dir }],
      disabled: this.disabled().filter((x) => x !== ext.id),
    });
    this.onChange?.();
    return { ok: true, id: ext.id, name: ext.name };
  }

  /**
   * "Install .crx file". `file` skips the file picker.
   *
   * The package is verified and unpacked by ./crx.js (signature checked, no
   * adm-zip), staged outside Extensions/, then moved to the same versioned
   * layout a Web Store install uses - so it loads at every startup and
   * "remove" deletes it like any other install. Installing a package whose ID
   * is already installed replaces it, as an update would.
   */
  async loadCrx(parent = this.getWindow(), file = null) {
    if (!file) {
      const result = await openDialog(parent, {
        title: 'Select .crx file',
        properties: ['openFile'],
        filters: [{ name: 'Chrome extension', extensions: ['crx'] }],
      });
      if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
      file = result.filePaths[0];
    }
    const stage = path.join(this.staging, randomUUID());
    try {
      fs.mkdirSync(this.staging, { recursive: true });
      const { id, manifest } = unpackCrxFile(file, stage);

      // A .crx carrying an unpacked extension's ID replaces that record too.
      if (this.unpackedRecord(id)) {
        this.store.save({ ...this.store.data, unpacked: this.unpacked().filter((record) => record.id !== id) });
      }
      this.unload(id);
      const home = path.join(this.path, id);
      fs.rmSync(home, { recursive: true, force: true });
      fs.mkdirSync(home, { recursive: true });
      const target = path.join(home, manifest.version + '_0');
      fs.renameSync(stage, target);

      let ext;
      try {
        ext = await this.ext.loadExtension(target);
      } catch (error) {
        fs.rmSync(home, { recursive: true, force: true });
        return { ok: false, error: 'The extension did not load: ' + (error?.message || error) };
      }
      if (ext.id !== id) {
        // Electron derives the ID from the manifest key we wrote. A mismatch
        // means that derivation changed: refuse rather than install under a
        // different identity than the one that was verified.
        this.unload(ext.id);
        fs.rmSync(home, { recursive: true, force: true });
        return { ok: false, error: 'The extension loaded under an unexpected ID, so it was not installed.' };
      }
      this.store.save({ ...this.store.data, disabled: this.disabled().filter((x) => x !== id) });
      this.onChange?.();
      return { ok: true, id, name: ext.name };
    } catch (error) {
      const message = error?.name === 'CrxError' ? error.message : 'The .crx could not be installed: ' + (error?.message || error);
      return { ok: false, error: message };
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
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
