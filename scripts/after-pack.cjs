/**
 * electron-builder afterPack hook: harden the packaged Electron binary, and
 * on macOS make an unsigned build launchable.
 *
 * 1. Fuses. Electron ships switches compiled into its binary that a
 *    published app should turn off, so the installed static.exe / static.app
 *    cannot be reused to run arbitrary code:
 *      RunAsNode                     ELECTRON_RUN_AS_NODE=1 turns it into plain Node
 *      EnableNodeOptionsEnvironmentVariable   NODE_OPTIONS could inject code
 *      EnableNodeCliInspectArguments --inspect would open a debugger port
 *    and on:
 *      OnlyLoadAppFromAsar           only ever run the packaged app.asar
 *      EnableEmbeddedAsarIntegrityValidation  refuse an app.asar that was
 *                                    changed after packaging (its hash is
 *                                    stored in Info.plist / the .exe)
 *    Cookie encryption is left off for now: developer builds share the
 *    profile folder, and turning it on is one-way for that profile.
 *
 * 2. macOS without an Apple Developer ID. electron-builder then skips signing
 *    entirely - but packaging has already changed the app (Info.plist, the
 *    fuses above), so Electron's original signature no longer matches. A
 *    downloaded app in that state is reported as "damaged and can't be
 *    opened", with no way past it. Ad-hoc signing makes it a valid, merely
 *    unidentified app: macOS then says it "could not verify" it, and the
 *    person can allow it in System Settings > Privacy & Security.
 *
 * Why here and not electron-builder's own `electronFuses` option: it flips
 * fuses AFTER this hook, which would break the ad-hoc signature made here.
 * Doing both in order, in one place, is correct with or without a real
 * certificate: when there is one, electron-builder signs after this hook.
 */
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

exports.default = async function afterPack(context) {
  const { electronPlatformName: platform, appOutDir, packager } = context;
  // A universal Mac build packs an x64 and an arm64 app into "-temp" folders
  // and merges them. electron-builder hardens and signs only the merged app
  // (the halves must stay identical apart from their binaries to merge), so
  // this does too.
  if (/-(x64|arm64)-temp$/.test(appOutDir)) return;
  const name = packager.appInfo.productFilename;
  const appBundle = path.join(appOutDir, name + '.app');
  const binary = platform === 'darwin' || platform === 'mas'
    ? path.join(appBundle, 'Contents', 'MacOS', name)
    : platform === 'win32'
      ? path.join(appOutDir, name + '.exe')
      : path.join(appOutDir, packager.executableName);

  await flipFuses(binary, {
    version: FuseVersion.V1,
    // Flipping edits the binary; on Apple Silicon an edited binary must be
    // re-signed (ad hoc) or it will not start at all.
    resetAdHocDarwinSignature: platform === 'darwin',
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  });
  console.log(`  • fuses set       file=${path.relative(process.cwd(), binary)}`);

  const unsignedMac = platform === 'darwin' && packager.platformSpecificBuildOptions.identity === null;
  if (unsignedMac) {
    // --deep reaches every helper app and framework inside the bundle.
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appBundle], { stdio: 'inherit' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', appBundle], { stdio: 'inherit' });
    console.log(`  • ad-hoc signed   file=${path.relative(process.cwd(), appBundle)} (no Apple Developer ID set)`);
  }
};
