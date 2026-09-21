'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { protocol, net } = require('electron');
const { pathToFileURL } = require('node:url');
const { INTERNAL_SCHEME } = require('./lib/url');

/**
 * `static://` — the scheme for built-in pages (Chrome's equivalent is
 * chrome://). Pages live in `src/renderer/pages/`:
 *
 *   static://newtab/            -> pages/newtab.html
 *   static://settings/          -> pages/settings.html
 *   static://newtab/assets/x.css -> pages/assets/x.css   (any path with a file)
 *
 * The scheme must be registered as privileged *before* app 'ready' so it
 * behaves like http (standard URL parsing, secure context, fetch allowed).
 */
const PAGES_DIR = path.join(__dirname, '..', 'renderer', 'pages');

const VALID_PAGE = /^[a-z0-9-]+$/;

/**
 * IMPORTANT: Electron only honours ONE call to registerSchemesAsPrivileged —
 * a later call replaces the earlier list. electron-chrome-extensions registers
 * `crx` when its module is first required, so main.js requires that module
 * first and then we register the union of both schemes here.
 */
function registerPrivilegedSchemes() {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'crx', privileges: { bypassCSP: true } },
    {
      scheme: INTERNAL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
        allowServiceWorkers: false,
      },
    },
  ]);
}

/** Install the request handler on a session (call after app 'ready'). */
function handleInternalProtocol(session) {
  session.protocol.handle(INTERNAL_SCHEME, async (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('Bad URL', { status: 400 });
    }

    const page = url.hostname;
    if (!VALID_PAGE.test(page)) return new Response('Not found', { status: 404 });

    let relative;
    if (url.pathname === '/' || url.pathname === '') {
      relative = `${page}.html`;
    } else {
      relative = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    }

    // Resolve and make sure we never escape the pages directory.
    const filePath = path.normalize(path.join(PAGES_DIR, relative));
    if (!filePath.startsWith(PAGES_DIR + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      await fs.access(filePath);
    } catch {
      return new Response('Not found', { status: 404 });
    }

    // net.fetch on a file:// URL gives us correct MIME types for free.
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

module.exports = { registerPrivilegedSchemes, handleInternalProtocol, PAGES_DIR };
