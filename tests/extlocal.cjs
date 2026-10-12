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

      // Leave the .crx switched off: the second launch checks that holds too.
      await ex.setEnabled(pkg.id, false);
      fs.writeFileSync(marker, JSON.stringify({ dir, unpackedDir, unpackedId: loaded.id, crxId: pkg.id }));
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

      fs.rmSync(m.dir, { recursive: true, force: true });
    }
  } catch (error) {
    check('probe ran', false, error && error.stack ? error.stack : String(error));
  }

  console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
  app.exit(fails ? 1 : 0);
}

module.exports = { run };
