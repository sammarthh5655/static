'use strict';

/**
 * Screenshots: what is on screen, the whole page top to bottom, or a part of
 * it, and saving them where people look for pictures.
 *
 * Everything here works on a tab's own WebContents, so a screenshot never
 * contains Static's toolbar, a menu or the overlay - only the page.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, nativeImage } = require('electron');

/** Chromium will not composite a single picture taller than this (device pixels). */
const MAX_FULL_HEIGHT = 16000;

/**
 * The visible part of the page. A page that has not produced its first frame
 * yet fails with a compositor error rather than waiting, so this retries
 * briefly, as main/application.js#capture does.
 */
async function visible(contents) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const image = await contents.capturePage();
      if (!image.isEmpty()) return image;
    } catch { /* not ready yet */ }
    contents.invalidate?.();
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

/**
 * The whole page, in one picture, through the DevTools protocol: Chromium
 * lays the page out at its full height and photographs it, which is far
 * cleaner than scrolling and stitching (no repeated sticky headers, no seams).
 * Pages longer than Chromium can photograph at once are cut at that height,
 * and say so.
 *
 * @returns {Promise<{ image: Electron.NativeImage, trimmed: boolean } | null>}
 */
async function fullPage(contents) {
  const dbg = contents.debugger;
  let attached = false;
  try {
    if (!dbg.isAttached()) { dbg.attach('1.3'); attached = true; }
    const metrics = await dbg.sendCommand('Page.getLayoutMetrics');
    const size = metrics.cssContentSize || metrics.contentSize;
    // The clip is measured in the window's own units, not the page's CSS
    // pixels: a page zoomed to 150% is half as large again on screen, and a
    // clip of its CSS size would stop two thirds of the way down. The
    // page's devicePixelRatio is zoom times the screen's own scale, so the
    // screen's scale is what turns window units into pixels in the picture.
    const zoom = Number(metrics.cssVisualViewport?.zoom) || contents.getZoomFactor() || 1;
    const ratio = Number(await contents.executeJavaScript('window.devicePixelRatio', true).catch(() => zoom)) || zoom;
    const screenScale = Math.max(0.25, ratio / zoom);
    const most = Math.floor(MAX_FULL_HEIGHT / screenScale);
    const width = Math.max(1, Math.min(most, Math.ceil(size.width * zoom - 0.05)));
    const fullHeight = Math.max(1, Math.ceil(size.height * zoom - 0.05));
    const height = Math.min(fullHeight, most);
    const shot = await dbg.sendCommand('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true, fromSurface: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    const image = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'));
    if (image.isEmpty()) return null;
    return { image, trimmed: height < fullHeight };
  } catch {
    // DevTools protocol unavailable (another debugger holds the page, or the
    // page went away mid-capture): the visible part is better than nothing.
    const image = await visible(contents);
    return image ? { image, trimmed: true, fallback: true } : null;
  } finally {
    if (attached) { try { dbg.detach(); } catch { /* already gone */ } }
  }
}

/**
 * Cut `rect` (in the page's CSS pixels, as the selection was drawn) out of a
 * picture of a view `viewWidth` CSS pixels wide.
 */
function crop(image, rect, viewWidth) {
  const { width, height } = image.getSize();
  const scale = width / Math.max(1, viewWidth);
  const x = Math.max(0, Math.min(width - 1, Math.round(rect.x * scale)));
  const y = Math.max(0, Math.min(height - 1, Math.round(rect.y * scale)));
  const w = Math.max(1, Math.min(width - x, Math.round(rect.width * scale)));
  const h = Math.max(1, Math.min(height - y, Math.round(rect.height * scale)));
  return image.crop({ x, y, width: w, height: h });
}

/** A small picture for the preview card: at most `width` across, and not endlessly tall. */
function thumbnail(image, { width = 600, maxHeight = 900 } = {}) {
  const size = image.getSize();
  let small = size.width > width ? image.resize({ width, quality: 'best' }) : image;
  const after = small.getSize();
  if (after.height > maxHeight) small = small.crop({ x: 0, y: 0, width: after.width, height: maxHeight });
  return small.toDataURL();
}

function safeName(text, fallback) {
  // "Story | Site" keeps its separator as a dash rather than losing it.
  const clean = String(text || '').replace(/\s*\|\s*/g, ' - ').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 80).trim();
  return clean || fallback;
}

const two = (n) => String(n).padStart(2, '0');

/** Where screenshots go: Pictures, in a folder of their own. */
function folder() {
  return path.join(app.getPath('pictures'), 'Static Screenshots');
}

/**
 * Save a picture as PNG under `dir`, named the way people find them again -
 * when it was taken and what it was of - and never over an existing file.
 */
function savePng(image, { dir = folder(), title = '', prefix = 'Screenshot', now = new Date() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const when = now.getFullYear() + '-' + two(now.getMonth() + 1) + '-' + two(now.getDate()) +
    ' at ' + two(now.getHours()) + '.' + two(now.getMinutes()) + '.' + two(now.getSeconds());
  const base = prefix + ' ' + when + (title ? ' - ' + safeName(title, '') : '');
  let file = path.join(dir, base + '.png');
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, base + ' (' + n + ').png');
  fs.writeFileSync(file, image.toPNG());
  return file;
}

module.exports = { visible, fullPage, crop, thumbnail, savePng, folder, safeName, MAX_FULL_HEIGHT };
