const path = require('node:path');
const fs = require('node:fs');
const { app, dialog } = require('electron');
const { randomUUID } = require('node:crypto');
const { JsonStore } = require('../../main/storage');
const { unpackCrxFile, idFromKey } = require('./crx');

// Web Store update checks: as often as electron-chrome-web-store ran them.
const UPDATE_EVERY = 5 * 60 * 60 * 1000;
const UPDATE_MIN_GAP = 3 * 60 * 60 * 1000;

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
    // What list() shows for an extension that is not loaded, by ID. Reading
    // it off disk on every state push froze the browser for as long as a
    // folder on an unreachable network share took to time out.
    this.offline = new Map();

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
      // Updates run through #startUpdater instead. The library's own updater
      // considers EVERY loaded extension and deletes the old version's folder
      // afterwards - for an unpacked one, a folder that is the person's (say,
      // one loaded straight out of Chrome's profile, named 1.2.3_0, with a
      // key and Google's update_url in its manifest).
      autoUpdate: false,
      minimumManifestVersion: 2,
    });

    // Leftovers from an install interrupted by a crash.
    fs.rmSync(this.staging, { recursive: true, force: true });
    this.offline.clear();

    // Honour the persisted disabled list on this launch.
    for (const id of this.disabled()) this.unload(id);

    await this.#loadUnpackedRecords();
    this.#startUpdater();

    this.session.on('extension-loaded', () => this.onChange?.());
    this.session.on('extension-unloaded', () => this.onChange?.());
    this.onChange?.();
  }

  /**
   * Unpacked extensions are not in Extensions/, so the web store loader never
   * sees them: load each recorded folder here. A folder that has gone (a
   * moved project, an unplugged drive) is skipped, not forgotten - it stays
   * listed so it can be removed, and loads again if it comes back.
   */
  async #loadUnpackedRecords() {
    const disabled = new Set(this.disabled());
    let records = this.unpacked();
    let changed = false;
    for (const record of this.unpacked()) {
      // An install of the same ID in Extensions/ - a Web Store or .crx install
      // made while this folder was switched off - is the newer choice. The
      // record goes; the folder itself is never touched.
      if (fs.existsSync(path.join(this.path, record.id))) {
        records = records.filter((r) => r !== record);
        changed = true;
        continue;
      }
      if (disabled.has(record.id) || this.ext.getExtension(record.id)) continue;
      try {
        const ext = await this.ext.loadExtension(record.path, { allowFileAccess: true });
        if (ext.id !== record.id) {
          // The folder now loads under another ID - a "key" was added to its
          // manifest. Same folder, so fix the record rather than keep a ghost
          // of the old ID next to an extension that cannot be removed.
          records = records.filter((r) => r !== record && r.id !== ext.id).concat({ id: ext.id, path: record.path });
          changed = true;
          if (disabled.has(ext.id)) this.unload(ext.id);
        }
      } catch (error) {
        console.error('Unpacked extension did not load:', record.path, error.message);
      }
    }
    if (changed) this.store.save({ ...this.store.data, unpacked: records });
  }

  /**
   * Whether an update may replace `ext`: only our own installs, laid out as
   * Extensions/<id>/<version>_0, and never one that came from a recorded
   * unpacked folder.
   */
  updatable(ext) {
    if (!ext?.path || !ext.id || this.unpackedRecord(ext.id)) return false;
    const relative = path.relative(this.path, ext.path);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
    const parts = relative.split(/[\\/]/);
    return parts.length === 2 && parts[0] === ext.id;
  }

  /**
   * Web Store updates, as the library ran them (on start, every few hours,
   * and when the browser comes to the front, at most every three hours), but
   * through a view of the session that shows the updater only what
   * updatable() allows - so nothing outside Extensions/ can be deleted.
   */
  #startUpdater() {
    const { updateExtensions } = require('electron-chrome-web-store');
    const real = this.ext;
    this.updaterView = {
      extensions: {
        getAllExtensions: () => real.getAllExtensions().filter((ext) => this.updatable(ext)),
        getExtension: (id) => real.getExtension(id),
        removeExtension: (id) => real.removeExtension(id),
        loadExtension: (where, options) => real.loadExtension(where, options),
      },
    };
    let last = 0;
    const check = () => {
      if (this.updating || Date.now() - last < UPDATE_MIN_GAP) return;
      last = Date.now();
      this.updating = updateExtensions(this.updaterView)
        .catch((error) => console.error('Extension update check failed:', error?.message || error))
        .finally(() => { this.updating = null; this.onChange?.(); });
    };
    this.updateTimer = setInterval(check, UPDATE_EVERY);
    app.on(process.platform === 'darwin' ? 'did-become-active' : 'browser-window-focus', check);
    // Not in the middle of startup: give the first windows a moment.
    setTimeout(check, 30 * 1000).unref?.();
  }

  disabled() { return this.store.data.disabled || []; }

  /**
   * Recorded "Load unpacked" folders: [{ id, path }]. Anything malformed in
   * extensions.json (an edited file, say) is ignored rather than allowed to
   * break startup or the list.
   */
  unpacked() {
    const list = this.store.data.unpacked;
    return Array.isArray(list)
      ? list.filter((r) => r && typeof r.id === 'string' && /^[a-p]{32}$/.test(r.id) && typeof r.path === 'string' && r.path)
      : [];
  }

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
   * What the manager shows for an extension that is not loaded: from its
   * recorded folder if it was loaded unpacked, else from the versioned
   * install layout. Cached (see `offline`); every action that can change the
   * answer forgets it first.
   */
  readManifest(id) {
    if (this.offline.has(id)) return this.offline.get(id);
    const info = this.#readManifest(id);
    this.offline.set(id, info);
    return info;
  }

  #readManifest(id) {
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
    this.offline.delete(id);
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
    this.offline.delete(id);
    this.store.save({ ...this.store.data, disabled: [...disabled] });
    this.onChange?.();
  }

  /**
   * Remove, whatever kind it is: unload it, forget any unpacked record, and
   * delete the app's OWN copy in Extensions/<id> if there is one - which also
   * covers an ID that was both installed and recorded. A recorded folder is
   * the person's and is never deleted.
   */
  async remove(id) {
    if (typeof id !== 'string' || !/^[a-p]{32}$/.test(id)) return;
    const { uninstallExtension } = require('electron-chrome-web-store');
    try {
      // Unloads it and deletes Extensions/<id>; nothing outside that folder.
      await uninstallExtension(id, { session: this.session, extensionsPath: this.path });
    } catch {
      this.unload(id);
    }
    this.offline.delete(id);
    this.store.save({
      ...this.store.data,
      unpacked: this.unpacked().filter((record) => record.id !== id),
      disabled: this.disabled().filter((x) => x !== id),
    });
    this.onChange?.();
  }

  /**
   * "Load unpacked" - the developer-mode button on the extensions page.
   * `dir` skips the folder picker (tests, and anything that already knows it).
   * Returns { ok, id, name } or { ok: false, error } for the page to show.
   *
   * As in Chrome, a folder whose manifest key gives it the ID of an installed
   * extension replaces that install: the app's copy is deleted, the folder is
   * recorded, and from then on the folder is what loads.
   */
  async loadUnpacked(parent = this.getWindow(), dir = null) {
    if (!dir) {
      const result = await openDialog(parent, { title: 'Select extension folder', properties: ['openDirectory'] });
      if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
      dir = result.filePaths[0];
    }
    dir = path.resolve(dir);
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8').replace(/^﻿/, ''));
    } catch (error) {
      return error?.code === 'ENOENT'
        ? { ok: false, error: 'That folder has no manifest.json. Choose the folder that contains it.' }
        : { ok: false, error: 'That folder\'s manifest.json could not be read: ' + (error?.message || error) };
    }
    // A key fixes the ID. Unload whatever has that ID now, rather than rely on
    // Electron replacing it, which it does not promise.
    let keyed = null;
    if (typeof manifest?.key === 'string') {
      try { keyed = idFromKey(Buffer.from(manifest.key, 'base64')); } catch { keyed = null; }
    }
    const same = (a, b) => (process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase());
    let ext;
    try {
      // Loading the same folder again picks up edits, as Chrome's reload does.
      const already = this.unpacked().find((record) => same(path.resolve(record.path), dir));
      if (already) this.unload(already.id);
      if (keyed) this.unload(keyed);
      ext = await this.ext.loadExtension(dir, { allowFileAccess: true });
    } catch (error) {
      return { ok: false, error: 'The extension did not load: ' + (error?.message || error) };
    }
    const home = path.join(this.path, ext.id);
    const inside = path.relative(home, dir);
    if (inside.startsWith('..') || path.isAbsolute(inside)) fs.rmSync(home, { recursive: true, force: true });
    const records = this.unpacked().filter((record) => record.id !== ext.id && !same(path.resolve(record.path), dir));
    this.offline.delete(ext.id);
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
   * "remove" deletes it like any other install. A package whose ID is
   * already installed replaces it, as an update would, but nothing of the
   * old install is destroyed until the new one has loaded: on any failure
   * the old one is put back exactly as it was, running if it was running.
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
    let aside = null;
    // Set when the old install could not be put back: it is then kept where
    // it is (startup clears staging later) rather than deleted with the rest.
    let keepAside = false;
    try {
      fs.mkdirSync(this.staging, { recursive: true });
      const { id, manifest } = unpackCrxFile(file, stage);

      const home = path.join(this.path, id);
      const target = path.join(home, manifest.version + '_0');
      const running = this.ext.getExtension(id);
      const before = running ? { path: running.path, unpacked: !!this.unpackedRecord(id) } : null;

      // Put everything back as it was: called on any failure from here on.
      const restore = async (message) => {
        this.unload(id);
        fs.rmSync(home, { recursive: true, force: true });
        if (aside) { try { fs.renameSync(aside, home); aside = null; } catch { keepAside = true; } }
        if (before) {
          try { await this.ext.loadExtension(before.path, before.unpacked ? { allowFileAccess: true } : undefined); } catch { /* reported below */ }
        }
        this.offline.delete(id);
        this.onChange?.();
        return { ok: false, error: message };
      };

      this.unload(id);
      if (fs.existsSync(home)) {
        // Set aside, not deleted. ExtensionStaging sits next to Extensions,
        // so this is a rename on one volume.
        aside = path.join(this.staging, randomUUID());
        try {
          fs.renameSync(home, aside);
        } catch (error) {
          aside = null;
          return await restore('The installed copy could not be replaced (' + (error?.code || error?.message || error) + '). Close anything using it and try again.');
        }
      }
      try {
        fs.mkdirSync(home, { recursive: true });
        fs.renameSync(stage, target);
      } catch (error) {
        return await restore('The .crx could not be installed: ' + (error?.message || error));
      }

      let ext;
      try {
        ext = await this.ext.loadExtension(target);
      } catch (error) {
        return await restore('The extension did not load: ' + (error?.message || error));
      }
      if (ext.id !== id) {
        // Electron derives the ID from the manifest key we wrote. A mismatch
        // means that derivation changed: refuse rather than install under a
        // different identity than the one that was verified.
        this.unload(ext.id);
        return await restore('The extension loaded under an unexpected ID, so it was not installed.');
      }

      // Installed and running: only now is the old install let go.
      this.offline.delete(id);
      this.store.save({
        ...this.store.data,
        unpacked: this.unpacked().filter((record) => record.id !== id),
        disabled: this.disabled().filter((x) => x !== id),
      });
      this.onChange?.();
      return { ok: true, id, name: ext.name };
    } catch (error) {
      const message = error?.name === 'CrxError' ? error.message : 'The .crx could not be installed: ' + (error?.message || error);
      return { ok: false, error: message };
    } finally {
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* startup clears staging */ }
      if (aside && !keepAside) { try { fs.rmSync(aside, { recursive: true, force: true }); } catch { /* startup clears staging */ } }
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
