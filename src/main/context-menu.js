'use strict';

const { Menu, MenuItem, clipboard, shell } = require('electron');
const { NEW_TAB_URL } = require('./lib/url');

/**
 * Native context menus.
 *
 * `buildTabContextMenu` is the right-click menu inside a web page. It mirrors
 * Chrome's ordering and appends extension-provided items obtained from
 * electron-chrome-extensions (`chrome.contextMenus` bridge).
 *
 * `buildTabStripMenu` is the right-click menu on a tab in the strip.
 */

/** @param {import('../features/tabs').Tab} tab */
function buildTabContextMenu(tab, params) {
  const { wc, controller, ctx } = tab;
  const tabs = controller.tabs;
  const menu = new Menu();
  const add = (opts) => menu.append(new MenuItem(opts));
  const sep = () => menu.append(new MenuItem({ type: 'separator' }));

  if (params.linkURL) {
    add({ label: 'Open link in new tab', click: () => tabs.create({ url: params.linkURL, active: false, openerId: tab.id }) });
    add({ label: 'Open link in new window', click: () => ctx.windows.createWindow({ url: params.linkURL }) });
    add({ label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) });
    sep();
  }

  if (params.mediaType === 'image' && params.srcURL) {
    add({ label: 'Open image in new tab', click: () => tabs.create({ url: params.srcURL, active: false, openerId: tab.id }) });
    add({ label: 'Save image as…', click: () => wc.downloadURL(params.srcURL) });
    add({ label: 'Copy image', click: () => wc.copyImageAt(params.x, params.y) });
    add({ label: 'Copy image address', click: () => clipboard.writeText(params.srcURL) });
    sep();
  }

  if (params.isEditable) {
    add({ label: 'Undo', role: 'undo', enabled: params.editFlags.canUndo });
    add({ label: 'Redo', role: 'redo', enabled: params.editFlags.canRedo });
    sep();
    add({ label: 'Cut', role: 'cut', enabled: params.editFlags.canCut });
    add({ label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy });
    add({ label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste });
    add({ label: 'Select all', role: 'selectAll' });
    sep();
  } else if (params.selectionText) {
    const text = params.selectionText.trim();
    const short = text.length > 30 ? `${text.slice(0, 30)}…` : text;
    add({ label: 'Copy', role: 'copy' });
    add({
      label: `Search ${ctx.searchEngineName()} for “${short}”`,
      click: () => tabs.create({ url: ctx.searchUrl(text), openerId: tab.id }),
    });
    sep();
  }

  if (!params.linkURL && !params.isEditable && !params.selectionText && params.mediaType === 'none') {
    add({ label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() });
    add({ label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() });
    add({ label: 'Reload', click: () => tab.reload() });
    sep();
    add({ label: 'Save as…', click: () => wc.downloadURL(wc.getURL()) });
    add({ label: 'Print…', click: () => wc.print() });
    sep();
  }

  // Extension context menu items (chrome.contextMenus.create).
  const extItems = ctx.extensions ? ctx.extensions.getContextMenuItems(wc, params) : [];
  if (extItems.length) {
    for (const item of extItems) menu.append(item);
    sep();
  }

  add({ label: 'View page source', click: () => tabs.create({ url: `view-source:${wc.getURL()}`, openerId: tab.id }) });
  add({ label: 'Inspect', click: () => { wc.inspectElement(params.x, params.y); if (wc.isDevToolsOpened()) wc.devToolsWebContents?.focus(); } });

  return menu;
}

/** @param {import('./window').BrowserWindowController} controller */
function buildTabStripMenu(controller, tabId) {
  const tabs = controller.tabs;
  const tab = tabs.get(tabId);
  const menu = new Menu();
  const add = (opts) => menu.append(new MenuItem(opts));
  const sep = () => menu.append(new MenuItem({ type: 'separator' }));

  add({ label: 'New tab to the right', click: () => {
    const idx = tabs.tabs.findIndex((t) => t.id === tabId);
    tabs.create({ url: NEW_TAB_URL, index: idx + 1 });
  } });
  sep();
  if (tab) {
    add({ label: 'Reload', click: () => tab.reload() });
    add({ label: 'Duplicate', click: () => tabs.duplicate(tabId) });
    add({
      label: tab.wc.isAudioMuted() ? 'Unmute site' : 'Mute site',
      click: () => { tab.wc.setAudioMuted(!tab.wc.isAudioMuted()); tabs.emitChanged(); },
    });
    sep();
    add({ label: 'Close tab', click: () => tabs.close(tabId) });
    add({ label: 'Close other tabs', enabled: tabs.tabs.length > 1, click: () => tabs.closeOthers(tabId) });
    add({ label: 'Close tabs to the right', enabled: tabs.tabs.at(-1) !== tab, click: () => tabs.closeToRight(tabId) });
  }
  sep();
  add({ label: 'Reopen closed tab', enabled: tabs.closedStack.length > 0, click: () => tabs.reopenClosed() });
  return menu;
}

module.exports = { buildTabContextMenu, buildTabStripMenu, shell };
