'use strict';

const { Menu, app, shell } = require('electron');
const { INTERNAL_SCHEME } = require('./lib/url');

/**
 * The "⋮" menu (Chrome's three-dot menu), shown as a native popup anchored to
 * the toolbar button. Also used to build the macOS application menu so the
 * standard Edit/Window roles exist there.
 */
const isMac = process.platform === 'darwin';
const mod = isMac ? 'Cmd' : 'Ctrl';

/** @param {import('./window').BrowserWindowController} c */
function buildAppMenuTemplate(c) {
  const open = (page) => () => c.tabs.create({ url: `${INTERNAL_SCHEME}://${page}/` });
  const wc = () => c.tabs.active?.wc;
  return [
    { label: 'New tab', accelerator: `${mod}+T`, click: () => c.tabs.create({ url: c.ctx.settings.newTabUrl() }) },
    { label: 'New window', accelerator: `${mod}+N`, click: () => c.ctx.windows.createWindow() },
    { type: 'separator' },
    { label: 'History', accelerator: `${mod}+H`, click: open('history') },
    { label: 'Downloads', accelerator: `${mod}+J`, click: open('downloads') },
    { label: 'Bookmarks', accelerator: `${mod}+Shift+O`, click: open('bookmarks') },
    {
      label: 'Show bookmarks bar',
      type: 'checkbox',
      accelerator: `${mod}+Shift+B`,
      checked: !!c.ctx.settings.get('showBookmarksBar'),
      click: (item) => c.ctx.settings.set({ showBookmarksBar: item.checked }),
    },
    { label: 'Extensions', click: open('extensions') },
    { type: 'separator' },
    {
      label: 'Zoom',
      submenu: [
        { label: 'Zoom in', accelerator: `${mod}+=`, click: () => wc() && wc().setZoomLevel(wc().getZoomLevel() + 0.5) },
        { label: 'Zoom out', accelerator: `${mod}+-`, click: () => wc() && wc().setZoomLevel(wc().getZoomLevel() - 0.5) },
        { label: 'Reset zoom', accelerator: `${mod}+0`, click: () => wc() && wc().setZoomLevel(0) },
      ],
    },
    { label: 'Print…', accelerator: `${mod}+P`, click: () => wc()?.print() },
    { label: 'Find in page…', enabled: false },
    { type: 'separator' },
    {
      label: 'More tools',
      submenu: [
        { label: 'Load unpacked extension…', click: () => c.ctx.extensionsFeature.loadUnpackedDialog(c.win) },
        { label: 'Clear browsing data…', accelerator: `${mod}+Shift+Delete`, click: () => c.tabs.create({ url: `${INTERNAL_SCHEME}://settings/#clear` }) },
        { type: 'separator' },
        { label: 'Developer tools (page)', accelerator: isMac ? 'Cmd+Alt+I' : 'F12', click: () => wc()?.toggleDevTools() },
        { label: 'Developer tools (browser UI)', click: () => c.win.webContents.toggleDevTools() },
        { label: 'Open user data folder', click: () => shell.openPath(app.getPath('userData')) },
      ],
    },
    { label: 'Settings', click: open('settings') },
    { type: 'separator' },
    { label: `About ${app.getName()}`, click: () => c.tabs.create({ url: `${INTERNAL_SCHEME}://settings/#about` }) },
    { label: 'Exit', accelerator: isMac ? 'Cmd+Q' : 'Alt+F4', click: () => app.quit() },
  ];
}

/** Popup the ⋮ menu at the given window-relative coordinates. */
function showAppMenu(controller, x, y) {
  const menu = Menu.buildFromTemplate(buildAppMenuTemplate(controller));
  menu.popup({ window: controller.win, x: Math.round(x), y: Math.round(y) });
}

/**
 * Application menu bar. Windows/Linux get none (Chrome has none; all
 * shortcuts are handled by shortcuts.js). macOS needs its standard app menu
 * with Edit roles, otherwise Cmd+C/V don't work in text fields.
 */
function installApplicationMenu(windows) {
  if (!isMac) {
    Menu.setApplicationMenu(null);
    return;
  }
  const template = [
    { label: app.getName(), submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [{ label: 'New window', accelerator: 'Cmd+N', click: () => windows.createWindow() }] },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { showAppMenu, installApplicationMenu };
