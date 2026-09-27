'use strict';

/**
 * The right-click menu for web pages.
 *
 * Chromium reports what was under the pointer (`context-menu` params); this
 * turns that into a data-only menu for the overlay to draw, and runs the
 * command the user picks. Items carry only a command name: the URLs they act
 * on stay here in main, taken from the params Chromium produced, so nothing
 * the overlay sends back can point a command at a different address.
 */

const { clipboard, dialog, app } = require('electron');
const path = require('node:path');

/** The overlay sends one of these back; anything else is ignored. */
const run = (command, arg) => ({ channel: 'context:run', payload: arg === undefined ? { command } : { command, arg } });

function short(text, max = 28) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

function isWeb(url) { return /^https?:\/\//i.test(url || ''); }

/**
 * Build the menu for one right-click.
 *
 * @param {Electron.ContextMenuParams} params
 * @param {object} ctx { canGoBack, canGoForward, pageUrl, extensionItems, has: {incognito, split} }
 */
function buildItems(params, ctx) {
  const items = [];
  const section = (list) => {
    const kept = list.filter(Boolean);
    if (!kept.length) return;
    if (items.length) items.push({ separator: true });
    items.push(...kept);
  };
  const edit = params.editFlags || {};
  const selection = String(params.selectionText || '').trim();

  // Spelling first, where the eye already is.
  if (params.isEditable && params.misspelledWord) {
    const suggestions = (params.dictionarySuggestions || []).slice(0, 5);
    section([
      ...suggestions.map((word) => ({ label: word, icon: 'check', action: run('spell', word) })),
      suggestions.length ? null : { label: 'No spelling suggestions', disabled: true },
      { label: 'Add to dictionary', icon: 'plus', action: run('add-word') },
    ]);
  }

  if (params.linkURL && isWeb(params.linkURL)) {
    section([
      { label: 'Open link in new tab', icon: 'plus', action: run('link-tab') },
      ctx.has.split ? { label: 'Open link in split view', icon: 'split', action: run('link-split') } : null,
      ctx.has.incognito ? { label: 'Open link in incognito window', icon: 'incognito', action: run('link-incognito') } : null,
    ]);
    section([
      { label: 'Save link as…', icon: 'download', action: run('save-link') },
      { label: 'Copy link address', icon: 'bookmark', action: run('copy-link') },
      params.linkText ? { label: 'Copy link text', icon: 'doc', action: run('copy-link-text') } : null,
    ]);
  }

  if (params.mediaType === 'image' && params.srcURL) {
    section([
      isWeb(params.srcURL) ? { label: 'Open image in new tab', icon: 'image', action: run('image-tab') } : null,
      { label: 'Save image as…', icon: 'download', action: run('save-image') },
      { label: 'Copy image', icon: 'image', action: run('copy-image') },
      isWeb(params.srcURL) ? { label: 'Copy image address', icon: 'bookmark', action: run('copy-image-url') } : null,
      isWeb(params.srcURL) ? { label: 'Search image with Google Lens', icon: 'search', action: run('search-image') } : null,
    ]);
  } else if ((params.mediaType === 'video' || params.mediaType === 'audio') && params.srcURL) {
    const flags = params.mediaFlags || {};
    section([
      { label: flags.isPaused ? 'Play' : 'Pause', icon: 'forward', action: run('media-toggle') },
      { label: flags.isMuted ? 'Unmute' : 'Mute', icon: 'warn', action: run('media-mute') },
      { label: 'Loop', icon: 'reload', checked: !!flags.isLooping, action: run('media-loop') },
      params.mediaType === 'video' && flags.canShowPictureInPicture !== false
        ? { label: 'Picture in picture', icon: 'window_restore', action: run('media-pip') } : null,
      isWeb(params.srcURL) ? { label: 'Open ' + params.mediaType + ' in new tab', icon: 'plus', action: run('media-tab') } : null,
      isWeb(params.srcURL) ? { label: 'Save ' + params.mediaType + ' as…', icon: 'download', action: run('save-media') } : null,
      isWeb(params.srcURL) ? { label: 'Copy ' + params.mediaType + ' address', icon: 'bookmark', action: run('copy-media-url') } : null,
    ]);
  }

  if (params.isEditable) {
    section([
      { label: 'Undo', action: run('undo'), disabled: !edit.canUndo, shortcut: 'Ctrl+Z' },
      { label: 'Redo', action: run('redo'), disabled: !edit.canRedo, shortcut: 'Ctrl+Y' },
    ]);
    section([
      { label: 'Cut', action: run('cut'), disabled: !edit.canCut, shortcut: 'Ctrl+X' },
      { label: 'Copy', action: run('copy'), disabled: !edit.canCopy, shortcut: 'Ctrl+C' },
      { label: 'Paste', action: run('paste'), disabled: !edit.canPaste, shortcut: 'Ctrl+V' },
      { label: 'Paste as plain text', action: run('paste-plain'), disabled: !edit.canPaste, shortcut: 'Ctrl+Shift+V' },
      { label: 'Select all', action: run('select-all'), disabled: !edit.canSelectAll, shortcut: 'Ctrl+A' },
    ]);
    if (process.platform !== 'linux') section([{ label: 'Emoji', icon: 'sparkle', action: run('emoji') }]);
  } else if (selection) {
    section([
      { label: 'Copy', icon: 'doc', action: run('copy'), shortcut: 'Ctrl+C' },
      { label: 'Search the web for “' + short(selection) + '”', icon: 'search', action: run('search-selection') },
      { label: 'Translate selection', icon: 'chat', action: run('translate-selection') },
      { label: 'Save selection to Notes', icon: 'bookmark', action: run('save-note') },
    ]);
  }

  // The page itself, when nothing more specific was clicked.
  if (!params.linkURL && !params.isEditable && !selection && params.mediaType === 'none') {
    section([
      { label: 'Back', icon: 'back', action: run('back'), disabled: !ctx.canGoBack, shortcut: 'Alt+Left' },
      { label: 'Forward', icon: 'forward', action: run('forward'), disabled: !ctx.canGoForward, shortcut: 'Alt+Right' },
      { label: 'Reload', icon: 'reload', action: run('reload'), shortcut: 'Ctrl+R' },
    ]);
    section([
      { label: 'Save page as…', icon: 'download', action: run('save-page'), shortcut: 'Ctrl+S' },
      { label: 'Print…', icon: 'doc', action: run('print'), shortcut: 'Ctrl+P' },
      isWeb(ctx.pageUrl) ? { label: 'Translate to ' + languageName(), icon: 'chat', action: run('translate') } : null,
      { label: 'Select all', action: run('select-all'), shortcut: 'Ctrl+A' },
    ]);
  }

  // Anything extensions registered with chrome.contextMenus.
  if (ctx.extensionItems?.length) {
    section(ctx.extensionItems.map((item, index) => ({
      label: short(item.label || 'Extension', 48), icon: 'puzzle', action: run('extension', index),
    })));
  }

  section([
    ctx.has.blockElement && isWeb(ctx.pageUrl) ? { label: 'Block element…', icon: 'shield', action: run('block-element') } : null,
    isWeb(ctx.pageUrl) ? { label: 'View page source', icon: 'code', action: run('view-source'), shortcut: 'Ctrl+U' } : null,
    { label: 'Inspect', icon: 'code', action: run('inspect'), shortcut: 'Ctrl+Shift+I' },
  ]);

  return items.map((item) => ({
    ...item,
    shortcut: item.shortcut && process.platform === 'darwin'
      ? item.shortcut.replace('Ctrl+', 'Cmd+').replace('Alt+Left', 'Cmd+[').replace('Alt+Right', 'Cmd+]')
      : item.shortcut,
  }));
}

function language() {
  return (app.getLocale() || 'en').split('-')[0];
}

function languageName() {
  try {
    return new Intl.DisplayNames([app.getLocale() || 'en'], { type: 'language' }).of(language()) || 'your language';
  } catch {
    return 'your language';
  }
}

function safeFileName(name, fallback) {
  const clean = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 120);
  return clean || fallback;
}

/**
 * Carry out a command against the right-click it came from.
 *
 * @param {object} browser the BrowserApplication
 * @param {{ tabId: string, contents: Electron.WebContents, params: object, extensionItems: object[] }} target
 */
async function runCommand(browser, target, command, arg) {
  const { contents, params, tabId } = target;
  if (!contents || contents.isDestroyed()) return false;
  const history = contents.navigationHistory;
  const nextIndex = Math.max(0, browser.tabs.order.indexOf(tabId) + 1);
  const openTab = (url, background = true) => browser.tabs.create({ url, background, index: nextIndex });
  const pageUrl = contents.getURL();
  const selection = String(params.selectionText || '').trim();
  const media = (script) => contents.executeJavaScript(
    `(() => { const el = document.elementFromPoint(${Number(params.x) || 0}, ${Number(params.y) || 0});
      const m = el && (el.closest('video, audio') || el.querySelector?.('video, audio'));
      if (!m) return false; ${script}; return true; })()`, true).catch(() => false);

  switch (command) {
    case 'back': if (history.canGoBack()) history.goBack(); break;
    case 'forward': if (history.canGoForward()) history.goForward(); break;
    case 'reload': contents.reload(); break;
    case 'print': contents.print({}, () => {}); break;
    case 'inspect': contents.inspectElement(params.x, params.y); break;
    case 'view-source': if (isWeb(pageUrl)) openTab('view-source:' + pageUrl, false); break;
    case 'translate':
      if (isWeb(pageUrl)) {
        openTab('https://translate.google.com/translate?sl=auto&tl=' + language() + '&u=' + encodeURIComponent(pageUrl), false);
      }
      break;
    case 'save-page': {
      const result = await dialog.showSaveDialog(browser.window, {
        defaultPath: path.join(app.getPath('downloads'), safeFileName(contents.getTitle(), 'page') + '.html'),
        filters: [
          { name: 'Web page, complete', extensions: ['html', 'htm'] },
          { name: 'Web page, HTML only', extensions: ['html', 'htm'] },
        ],
      });
      if (!result.canceled && result.filePath) await contents.savePage(result.filePath, 'HTMLComplete');
      break;
    }

    case 'link-tab': if (isWeb(params.linkURL)) openTab(params.linkURL); break;
    case 'link-split': if (isWeb(params.linkURL)) browser.openSplit?.(params.linkURL, tabId); break;
    case 'link-incognito': if (isWeb(params.linkURL)) browser.openIncognito?.(params.linkURL); break;
    case 'save-link': if (isWeb(params.linkURL)) contents.downloadURL(params.linkURL); break;
    case 'copy-link': clipboard.writeText(params.linkURL || ''); break;
    case 'copy-link-text': clipboard.writeText(params.linkText || ''); break;

    case 'image-tab': if (isWeb(params.srcURL)) openTab(params.srcURL); break;
    case 'save-image': contents.downloadURL(params.srcURL); break;
    case 'copy-image': contents.copyImageAt(params.x, params.y); break;
    case 'copy-image-url': clipboard.writeText(params.srcURL || ''); break;
    case 'search-image':
      if (isWeb(params.srcURL)) openTab('https://lens.google.com/uploadbyurl?url=' + encodeURIComponent(params.srcURL), false);
      break;

    case 'media-toggle': await media('m.paused ? m.play() : m.pause()'); break;
    case 'media-mute': await media('m.muted = !m.muted'); break;
    case 'media-loop': await media('m.loop = !m.loop'); break;
    case 'media-pip': await media('document.pictureInPictureElement === m ? document.exitPictureInPicture() : m.requestPictureInPicture()'); break;
    case 'media-tab': if (isWeb(params.srcURL)) openTab(params.srcURL); break;
    case 'save-media': if (isWeb(params.srcURL)) contents.downloadURL(params.srcURL); break;
    case 'copy-media-url': clipboard.writeText(params.srcURL || ''); break;

    case 'undo': contents.undo(); break;
    case 'redo': contents.redo(); break;
    case 'cut': contents.cut(); break;
    case 'copy': contents.copy(); break;
    case 'paste': contents.paste(); break;
    case 'paste-plain': contents.pasteAndMatchStyle(); break;
    case 'select-all': contents.selectAll(); break;
    case 'emoji': app.showEmojiPanel(); break;
    case 'spell': if (typeof arg === 'string') contents.replaceMisspelling(arg); break;
    case 'add-word':
      if (params.misspelledWord) contents.session.addWordToSpellCheckerDictionary(params.misspelledWord);
      break;

    case 'search-selection': if (selection) openTab(selection, false); break;
    case 'translate-selection':
      if (selection) {
        openTab('https://translate.google.com/?sl=auto&tl=' + language() + '&op=translate&text=' +
          encodeURIComponent(selection.slice(0, 5000)), false);
      }
      break;
    case 'save-note': await browser.captureNote?.(); break;

    case 'block-element': browser.startElementPicker?.(tabId, params.x, params.y); break;
    case 'extension': {
      const item = target.extensionItems?.[Number(arg)];
      if (item && typeof item.click === 'function') item.click();
      break;
    }
    default: return false;
  }
  return true;
}

module.exports = { buildItems, runCommand };
