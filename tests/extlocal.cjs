/**
 * Extensions from your own disk: "Load unpacked" and "Install .crx file".
 *
 * Runs twice in a row with the same profile (see RUNS in scripts/probes.cjs):
 * the first launch installs and switches things, the second checks what a
 * restart kept. Off-screen; the file pickers are skipped by passing the path.
 *
 * Before this probe, all three of these were broken and nothing noticed:
 * - Install .crx asked the Web Store for an extension "named" after the file
 *   path and always failed.
 * - Unpacked extensions were gone after a restart.
 * - Disabling an unpacked extension dropped it from the list for good.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fx = require('./fixtures/crx.cjs');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(browser) {
  const { app } = require('electron');
  let fails = 0;
  const check = (name, ok, detail) => {
    console.log((ok ? '  ok  ' : 'FAIL  ') + name + (detail !== undefined ? ' :: ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 160) : ''));
    if (!ok) fails++;
  };
  const ex = browser.extensions;
  const marker = path.join(app.getPath('userData'), 'extlocal-marker.json');
  const find = (id) => ex.list().find((e) => e.id === id);

  try {
    for (let i = 0; i < 50 && !ex.api; i++) await wait(200);
    await wait(800);

    if (!fs.existsSync(marker)) {
      /* ---------------- first launch ---------------- */
      // A clean slate: anything an earlier, interrupted run left behind.
      for (const e of ex.list()) if (/^Fixture /.test(e.name)) await ex.remove(e.id);

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-extlocal-'));
      const unpackedDir = path.join(dir, 'unpacked');
      fs.mkdirSync(unpackedDir);
      fs.writeFileSync(path.join(unpackedDir, 'manifest.json'), JSON.stringify({
        manifest_version: 3, name: 'Fixture Unpacked', version: '1.0.0', description: 'extlocal probe',
      }));

      const noManifest = await ex.loadUnpacked(null, dir);
      check('a folder without manifest.json is refused with a reason', !noManifest.ok && /manifest\.json/.test(noManifest.error || ''), noManifest);

      const loaded = await ex.loadUnpacked(null, unpackedDir);
      check('Load unpacked loads the folder', loaded.ok && !!ex.ext.getExtension(loaded.id), loaded);
      check('and lists it as unpacked', find(loaded.id)?.unpacked === true, find(loaded.id));

      await ex.setEnabled(loaded.id, false);
      check('disabling it keeps it in the list, switched off', find(loaded.id)?.enabled === false, find(loaded.id) || 'NOT LISTED');
      await ex.setEnabled(loaded.id, true);
      check('enabling it loads it again', !!ex.ext.getExtension(loaded.id) && find(loaded.id)?.enabled === true);

      // A real CRX3, signed with a fresh key.
      const pkg = fx.crx(fx.extensionArchive({ name: 'Fixture Crx', version: '1.2.0' }));
      const crxFile = path.join(dir, 'fixture.crx');
      fs.writeFileSync(crxFile, pkg.buffer);
      const installed = await ex.loadCrx(null, crxFile);
      check('Install .crx installs a signed package from disk', installed.ok && installed.id === pkg.id, installed);
      check('under the ID its signing key owns', !!ex.ext.getExtension(pkg.id), pkg.id);
      check('into the same layout as a Web Store install', fs.existsSync(path.join(ex.path, pkg.id, '1.2.0_0', 'manifest.json')));
      check('and nothing is left in staging', !fs.existsSync(ex.staging) || fs.readdirSync(ex.staging).length === 0);

      // A tampered copy: one byte of the archive changed.
      const tampered = Buffer.from(pkg.buffer);
      tampered[tampered.length - 30] ^= 0x01;
      const badFile = path.join(dir, 'tampered.crx');
      fs.writeFileSync(badFile, tampered);
      const refused = await ex.loadCrx(null, badFile);
      check('a tampered .crx is refused, saying why', !refused.ok && /signature/i.test(refused.error || ''), refused);

      // Someone else's ID: signed by its own key, claiming a victim's.
      const victim = fx.crx(fx.extensionArchive({ name: 'Fixture Victim' }));
      const impostor = fx.crx(fx.extensionArchive({ name: 'Fixture Impostor' }), { claimDer: victim.signer.publicDer });
      const impostorFile = path.join(dir, 'impostor.crx');
      fs.writeFileSync(impostorFile, impostor.buffer);
      const notReplaced = await ex.loadCrx(null, impostorFile);
      check('a .crx claiming another extension\'s ID is refused', !notReplaced.ok && !fs.existsSync(path.join(ex.path, victim.id)), notReplaced);

      // Reinstalling the same ID with a newer version replaces it.
      const update = fx.crx(fx.extensionArchive({ name: 'Fixture Crx', version: '1.3.0' }), { signer: pkg.signer });
      const updateFile = path.join(dir, 'update.crx');
      fs.writeFileSync(updateFile, update.buffer);
      const updated = await ex.loadCrx(null, updateFile);
      const versions = fs.readdirSync(path.join(ex.path, pkg.id));
      check('installing a newer .crx of the same extension replaces it', updated.ok && find(pkg.id)?.version === '1.3.0' && versions.join() === '1.3.0_0', { updated, versions });

      // The manager page shows both, the unpacked one marked as such.
      browser.tabs.navigate(browser.tabs.activeId, 'browser://extensions');
      const wc = browser.tabs.active.view.webContents;
      for (let i = 0; i < 40 && wc.isLoading(); i++) await wait(100);
      await wait(700);
      const page = await wc.executeJavaScript(`[...document.querySelectorAll('#list .row')].map((r) => r.textContent)`);
      check('the Extensions page lists the unpacked one, marked Unpacked', page.some((t) => /Fixture Unpacked/.test(t) && /Unpacked/.test(t.replace('Fixture Unpacked', ''))), page);
      check('and the installed .crx', page.some((t) => /Fixture Crx/.test(t)), page);

      // A reinstall that fails to load must leave the working version alone.
      // Electron's loader is made to refuse once, as it would a broken package.
      const real = ex.session.extensions.loadExtension.bind(ex.session.extensions);
      ex.session.extensions.loadExtension = async (where, options) => {
        if (/1\.4\.0_0/.test(String(where))) throw new Error('simulated load failure');
        return real(where, options);
      };
      const broken = fx.crx(fx.extensionArchive({ name: 'Fixture Crx', version: '1.4.0' }), { signer: pkg.signer });
      const brokenFile = path.join(dir, 'broken.crx');
      fs.writeFileSync(brokenFile, broken.buffer);
      const failed = await ex.loadCrx(null, brokenFile);
      ex.session.extensions.loadExtension = real;
      check('a reinstall that does not load is reported', !failed.ok && /did not load/.test(failed.error || ''), failed);
      check('and the working version is still installed and running',
        find(pkg.id)?.version === '1.3.0' && !!ex.ext.getExtension(pkg.id) && fs.readdirSync(path.join(ex.path, pkg.id)).join() === '1.3.0_0',
        { listed: find(pkg.id)?.version, folders: fs.readdirSync(path.join(ex.path, pkg.id)) });

      // A folder whose manifest key gives it an installed extension's ID
      // replaces that install, as in Chrome.
      const twin = fx.crx(fx.extensionArchive({ name: 'Fixture Twin', version: '1.0.0' }));
      const twinFile = path.join(dir, 'twin.crx');
      fs.writeFileSync(twinFile, twin.buffer);
      await ex.loadCrx(null, twinFile);
      const twinDir = path.join(dir, 'twin-dev');
      fs.mkdirSync(twinDir);
      fs.writeFileSync(path.join(twinDir, 'manifest.json'), JSON.stringify({
        manifest_version: 3, name: 'Fixture Twin (dev)', version: '9.9.9', key: twin.signer.publicDer.toString('base64'),
      }));
      const twinLoaded = await ex.loadUnpacked(null, twinDir);
      check('loading a folder with an installed extension\'s key replaces the install',
        twinLoaded.ok && twinLoaded.id === twin.id && find(twin.id)?.version === '9.9.9' && find(twin.id)?.unpacked === true &&
        !fs.existsSync(path.join(ex.path, twin.id)), { twinLoaded, listed: find(twin.id) });

      // A folder recorded under one ID that will load under another next time.
      const rekeyDir = path.join(dir, 'rekey');
      fs.mkdirSync(rekeyDir);
      fs.writeFileSync(path.join(rekeyDir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Fixture Rekey', version: '1.0.0' }));
      const rekeyed = await ex.loadUnpacked(null, rekeyDir);
      const newKey = fx.keyPair();
      fs.writeFileSync(path.join(rekeyDir, 'manifest.json'), JSON.stringify({
        manifest_version: 3, name: 'Fixture Rekey', version: '1.0.1', key: newKey.publicDer.toString('base64'),
      }));

      // Updates may only ever replace the app's own copies.
      const updatable = ex.updaterView.extensions.getAllExtensions().map((e) => e.id);
      check('the updater sees the installed .crx', updatable.includes(pkg.id), updatable);
      check('but never an unpacked folder', !updatable.includes(loaded.id) && !updatable.includes(twin.id) && !updatable.includes(rekeyed.id), updatable);

      // The list does not go back to disk for what it already knows.
      await ex.setEnabled(loaded.id, false);
      ex.list();
      let reads = 0;
      const readFile = fs.readFileSync;
      fs.readFileSync = function (...args) { if (/manifest\.json$/.test(String(args[0]))) reads++; return readFile.apply(this, args); };
      for (let i = 0; i < 5; i++) ex.list();
      fs.readFileSync = readFile;
      check('refreshing the list does not re-read manifests from disk', reads === 0, reads + ' reads');
      await ex.setEnabled(loaded.id, true);

      // Leave the .crx switched off: the second launch checks that holds too.
      await ex.setEnabled(pkg.id, false);
      fs.writeFileSync(marker, JSON.stringify({
        dir, unpackedDir, unpackedId: loaded.id, crxId: pkg.id,
        twinId: twin.id, twinDir, rekeyDir, oldRekeyId: rekeyed.id, newRekeyId: fx.idOf(newKey.publicDer),
      }));
      console.log('first launch done; run again to check the restart');
    } else {
      /* ---------------- second launch: what a restart kept ---------------- */
      const m = JSON.parse(fs.readFileSync(marker, 'utf8'));
      fs.rmSync(marker, { force: true });

      check('after a restart the unpacked extension is loaded again', !!ex.ext.getExtension(m.unpackedId) && find(m.unpackedId)?.enabled === true, find(m.unpackedId) || 'NOT LISTED');
      check('the .crx install is still there', !!find(m.crxId), find(m.crxId) || 'NOT LISTED');
      check('and still switched off, as it was left', find(m.crxId)?.enabled === false && !ex.ext.getExtension(m.crxId), find(m.crxId));
      await ex.setEnabled(m.crxId, true);
      check('switching it back on loads it', !!ex.ext.getExtension(m.crxId));

      await ex.remove(m.unpackedId);
      check('removing the unpacked extension takes it out of the list', !find(m.unpackedId));
      check('but never deletes the person\'s folder', fs.existsSync(path.join(m.unpackedDir, 'manifest.json')));

      await ex.remove(m.crxId);
      check('removing the .crx install deletes its copy', !find(m.crxId) && !fs.existsSync(path.join(ex.path, m.crxId)));

      // An unpacked folder that has gone (moved, or on an unplugged drive).
      const gone = path.join(m.dir, 'moved-away');
      const fakeId = 'a'.repeat(32);
      ex.store.save({ ...ex.store.data, unpacked: [...ex.unpacked(), { id: fakeId, path: gone }] });
      const missing = find(fakeId);
      check('a missing unpacked folder stays listed so it can be removed', missing?.missing === true && missing?.enabled === false, missing);
      await ex.remove(fakeId);
      check('and removing it forgets it', !find(fakeId) && !ex.unpackedRecord(fakeId));

      // The folder that replaced an install is what loads after a restart.
      const twin = find(m.twinId);
      check('after a restart the folder, not the old install, is what runs',
        twin?.version === '9.9.9' && twin?.unpacked === true && !fs.existsSync(path.join(ex.path, m.twinId)), twin);
      await ex.remove(m.twinId);
      check('and removing it leaves nothing behind but the person\'s folder',
        !find(m.twinId) && !fs.existsSync(path.join(ex.path, m.twinId)) && fs.existsSync(path.join(m.twinDir, 'manifest.json')));

      // The folder whose ID changed is listed once, under its new ID.
      check('a folder whose ID changed is loaded under the new ID', !!ex.ext.getExtension(m.newRekeyId) && find(m.newRekeyId)?.unpacked === true, find(m.newRekeyId));
      check('and no ghost of the old ID is left', !find(m.oldRekeyId) && !ex.unpackedRecord(m.oldRekeyId), ex.unpacked());
      await ex.remove(m.newRekeyId);
      check('and it can be removed', !find(m.newRekeyId) && !ex.unpackedRecord(m.newRekeyId) && fs.existsSync(path.join(m.rekeyDir, 'manifest.json')));

      fs.rmSync(m.dir, { recursive: true, force: true });
    }
  } catch (error) {
    check('probe ran', false, error && error.stack ? error.stack : String(error));
  }

  console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
  app.exit(fails ? 1 : 0);
}

module.exports = { run };
