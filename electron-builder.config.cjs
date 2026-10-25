/**
 * electron-builder configuration: the installers people download from the
 * static website. See docs/releasing.md for the whole release process.
 *
 * A JavaScript file rather than package.json "build", because signing,
 * notarization and updates switch on only when their credentials or address
 * are actually present - a build without them must still succeed, unsigned.
 *
 * Environment (every one optional):
 *
 *   STATIC_UPDATE_URL   https folder on the website holding the release files,
 *                       e.g. https://example.com/download/ - turns on automatic
 *                       updates (the app checks it for latest.yml / latest-mac.yml)
 *   STATIC_WEBSITE      the website, linked from Windows' installed-apps list
 *                       (defaults to the update address's site)
 *   STATIC_PUBLISHER    the publisher name shown in Windows (default "static").
 *                       With Azure Trusted Signing it is REQUIRED and must be the
 *                       exact name (CN) on the certificate; with other Windows
 *                       certificates it is read from the certificate when unset.
 *                       Installed copies only accept updates signed by this name.
 *
 *   Windows code signing, either:
 *     Azure Trusted Signing: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET,
 *       STATIC_AZURE_ENDPOINT, STATIC_AZURE_ACCOUNT, STATIC_AZURE_PROFILE
 *     or a certificate on a USB token or cloud signing service, which appears
 *       in the Windows certificate store: STATIC_WIN_CERT_SHA1 (its thumbprint)
 *     or a .pfx certificate file: WIN_CSC_LINK (or CSC_LINK), WIN_CSC_KEY_PASSWORD (or CSC_KEY_PASSWORD)
 *
 *   macOS code signing (on a Mac): CSC_LINK + CSC_KEY_PASSWORD (a Developer ID
 *     Application .p12), or CSC_NAME for one already in the keychain
 *   macOS notarization: APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER,
 *     or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
 */
const env = process.env;
const set = (...names) => names.every((name) => typeof env[name] === 'string' && env[name].trim() !== '');

const updateUrl = (env.STATIC_UPDATE_URL || '').trim();
// https only: an http address would let anyone on the network serve an
// "update". The one exception is this computer itself (loopback), which is
// how the update path is tested locally - no network can reach it.
if (updateUrl && !/^https:\/\/[^/]+/i.test(updateUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(updateUrl)) {
  throw new Error('STATIC_UPDATE_URL must be an https:// address, got: ' + updateUrl);
}
const website = (env.STATIC_WEBSITE || '').trim() || (updateUrl ? new URL(updateUrl).origin : '');
const publisher = (env.STATIC_PUBLISHER || '').trim() || 'static';

const azure = set('AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'STATIC_AZURE_ENDPOINT', 'STATIC_AZURE_ACCOUNT', 'STATIC_AZURE_PROFILE');
// Code-signing certificates are no longer issued as files: since 2023 their
// keys must live on a hardware token or a cloud service. Such a certificate
// shows up in the Windows certificate store and is used by its thumbprint.
const storeCert = !azure && set('STATIC_WIN_CERT_SHA1');
const pfx = !azure && !storeCert && (set('WIN_CSC_LINK') || (process.platform === 'win32' && set('CSC_LINK')));
// Installed copies accept an update only when its signer's name matches the
// name recorded at build time (electron-updater, verifyUpdateCodeSignature).
// For a certificate electron-builder reads that name from the certificate;
// Azure cannot, so the name must be given - a wrong guess here would leave
// every installed copy unable to update, with no way to fix it remotely.
if (azure && !set('STATIC_PUBLISHER')) {
  throw new Error('Azure Trusted Signing needs STATIC_PUBLISHER set to the exact name (CN) on the certificate.');
}
const signerName = set('STATIC_PUBLISHER') ? env.STATIC_PUBLISHER.trim() : null;

const macCertificate = process.platform === 'darwin' && (set('CSC_LINK') || set('CSC_NAME'));
const notarize = macCertificate && (set('APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER') || set('APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'));

/** File types static opens, for macOS "Open with" (Windows: build/installer.nsh). */
const documentTypes = [
  { CFBundleTypeName: 'HTML document', CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Alternate', LSItemContentTypes: ['public.html'] },
  { CFBundleTypeName: 'XHTML document', CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Alternate', LSItemContentTypes: ['public.xhtml'] },
  { CFBundleTypeName: 'SVG image', CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Alternate', LSItemContentTypes: ['public.svg-image'] },
  { CFBundleTypeName: 'WebP image', CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Alternate', LSItemContentTypes: ['org.webmproject.webp'] },
];

module.exports = {
  appId: 'dev.staticbrowser.desktop',
  productName: 'static',
  copyright: `Copyright © ${new Date().getFullYear()} ${publisher}`,
  // The publisher Windows shows in Apps & features and in static.exe's
  // properties. It came from package.json "author", which was a personal
  // email address - shown to everyone who installed static.
  extraMetadata: { author: { name: publisher } },
  asar: true,
  directories: { output: 'dist', buildResources: 'build' },
  // Only what the app reads at runtime. build/ also holds installer
  // artwork, entitlements and scripts that have no business in the app.
  files: [
    'src/**/*',
    '!src/main/secure/keys.example.js',
    'build/*.preload.cjs',
    'build/icon.png',
    'package.json',
    'LICENSE',
  ],
  // Fuses, and ad-hoc signing for an unsigned Mac build: see the script.
  afterPack: './scripts/after-pack.cjs',
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',

  // Automatic updates come from STATIC_UPDATE_URL: the latest GitHub
  // Release when built by .github/workflows/release.yml, or a website folder.
  // Without an address no update file is written and the app never checks.
  publish: updateUrl ? [{ provider: 'generic', url: updateUrl, channel: 'latest' }] : null,

  win: {
    // One installer per architecture: half the download of a combined one.
    // x64 runs everywhere, including Windows on Arm (emulated); arm64 is
    // native for Snapdragon laptops.
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }],
    icon: 'build/icon.ico',
    legalTrademarks: 'static',
    // Version details and the icon are written into static.exe whether or
    // not it is signed; without this Windows shows Electron's.
    signAndEditExecutable: true,
    ...(azure ? {
      azureSignOptions: {
        publisherName: signerName,
        endpoint: env.STATIC_AZURE_ENDPOINT,
        codeSigningAccountName: env.STATIC_AZURE_ACCOUNT,
        certificateProfileName: env.STATIC_AZURE_PROFILE,
      },
    } : {}),
    ...(pfx || storeCert ? {
      signtoolOptions: {
        ...(storeCert ? { certificateSha1: env.STATIC_WIN_CERT_SHA1.replace(/[^0-9a-f]/gi, '') } : {}),
        ...(signerName ? { publisherName: signerName } : {}),
        signingHashAlgorithms: ['sha256'],
        rfc3161TimeStampServer: 'http://timestamp.digicert.com',
      },
    } : {}),
  },
  nsis: {
    // Like Chrome's installer: no questions, no administrator prompt. It
    // installs for this Windows user in %LOCALAPPDATA%\Programs\static,
    // adds Start menu and desktop shortcuts, and opens static when done.
    oneClick: true,
    perMachine: false,
    runAfterFinish: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'static',
    uninstallDisplayName: 'static',
    // Uninstalling keeps bookmarks, passwords and history, as browsers do;
    // reinstalling finds them again.
    deleteAppDataOnUninstall: false,
    // Per-user install: the elevation helper is never used.
    packElevateHelper: false,
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
    // Registers static as a browser Windows can make the default.
    include: 'build/installer.nsh',
    buildUniversalInstaller: false,
    // Updates download only the parts that changed.
    differentialPackage: true,
    artifactName: '${productName}-${version}-setup-${arch}.${ext}',
    ...(website ? { uninstallUrlInfoAbout: website, uninstallUrlHelp: website, uninstallUrlUpdateInfo: website } : {}),
  },

  mac: {
    // One download for every Mac since 2020: Apple Silicon and Intel.
    target: [
      { target: 'dmg', arch: ['universal'] },
      // The zip is what automatic updates download on a Mac.
      { target: 'zip', arch: ['universal'] },
    ],
    category: 'public.app-category.productivity',
    icon: 'build/icon-mac.png',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.inherit.plist',
    // No Developer ID: null skips electron-builder's signing, and
    // scripts/after-pack.cjs signs ad hoc instead so the app still opens.
    identity: macCertificate ? undefined : null,
    notarize,
    extendInfo: {
      NSCameraUsageDescription: 'A website you visit may ask to use the camera. Static only allows it when you agree.',
      NSMicrophoneUsageDescription: 'A website you visit may ask to use the microphone. Static only allows it when you agree.',
      NSLocationWhenInUseUsageDescription: 'A website you visit may ask for your location. Static only shares it when you agree.',
      NSDownloadsFolderUsageDescription: 'Static saves files you download to your Downloads folder.',
      NSDocumentsFolderUsageDescription: 'Static can save pages and notes to a folder you choose.',
      // http and https: how macOS knows static is a browser, and lists it in
      // System Settings > Desktop & Dock > Default web browser.
      CFBundleURLTypes: [{ CFBundleURLName: 'Web site URL', CFBundleURLSchemes: ['http', 'https'] }],
      CFBundleDocumentTypes: documentTypes,
      // No LSMinimumSystemVersion here on purpose: Electron's own Info.plist
      // carries the right one (Electron 44 needs macOS 13 Ventura). Setting
      // an older one let Macs that cannot run it install it anyway.
    },
  },
  dmg: {
    title: '${productName} ${version}',
    // 540x380, with background@2x.png beside it for Retina screens.
    // Drawn by scripts/make-dmg-background.cjs.
    background: 'build/background.png',
    iconSize: 100,
    window: { width: 540, height: 380 },
    contents: [
      { x: 140, y: 190, type: 'file' },
      { x: 400, y: 190, type: 'link', path: '/Applications' },
    ],
    artifactName: '${productName}-${version}-mac-universal.${ext}',
  },

  linux: {
    target: ['AppImage', 'deb'],
    category: 'Network',
    maintainer: 'static contributors',
    icon: 'build/icon.png',
  },
};
