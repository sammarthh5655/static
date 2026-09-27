/**
 * Turn a folder of photos into Static's built-in wallpapers.
 *
 *   npx electron scripts/make-wallpapers.cjs "<folder>"
 *
 * Each sub-folder becomes a category. Every photo is resized to at most
 * 2560px wide and re-encoded, a 480px thumbnail is made for the picker, and
 * its average colour is sampled so the page can paint a matching colour
 * before the image arrives. The photographer and source site are read from
 * the file name (Unsplash, Pexels and Pixabay all name downloads that way)
 * so the licences page can credit them.
 *
 * Output: src/renderer/assets/wallpapers/ and src/shared/wallpapers.json.
 * Run through Electron because nativeImage is already here and needs no
 * image library.
 */
const { app, nativeImage } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = process.argv.find((a, i) => i > 1 && fs.existsSync(a) && fs.statSync(a).isDirectory());
const OUT = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'wallpapers');
const MANIFEST = path.join(__dirname, '..', 'src', 'shared', 'wallpapers.json');
const FULL_WIDTH = 2560;
const THUMB_WIDTH = 480;

/** Folder name -> category. A folder nobody named gets a name from its photos. */
const CATEGORY_NAMES = {
  'new folder': { id: 'landscapes', name: 'Landscapes' },
  cityscapes: { id: 'cityscapes', name: 'Cityscapes' },
  colours: { id: 'colours', name: 'Colours' },
  colors: { id: 'colours', name: 'Colours' },
  patterns: { id: 'patterns', name: 'Patterns' },
  space: { id: 'space', name: 'Space' },
};

const title = (words) => words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/** Photographer and source from the download's file name. */
function credit(file) {
  // "photo (1).jpg" is the same download saved twice.
  const base = path.basename(file, path.extname(file)).replace(/\s*\(\d+\)$/, '');
  let m = base.match(/^(.*)-[A-Za-z0-9_-]{11}-unsplash$/);
  if (m) return { by: title(m[1].split('-')), source: 'Unsplash', licence: 'Unsplash License' };
  m = base.match(/^pexels-(.*?)(?:-\d+)+$/);
  if (m) return { by: title(m[1].split('-').filter((w) => !/^\d+$/.test(w))) || 'Pexels', source: 'Pexels', licence: 'Pexels License' };
  m = base.match(/^([a-z0-9]+)-.*-\d+_\d+$/i);
  if (m) return { by: m[1], source: 'Pixabay', licence: 'Pixabay Content License' };
  return { by: 'Unknown', source: 'Unknown', licence: 'Unknown' };
}

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function averageColour(image) {
  const bitmap = image.resize({ width: 1, height: 1, quality: 'best' }).toBitmap();
  // BGRA on every platform nativeImage runs on.
  const hex = (n) => n.toString(16).padStart(2, '0');
  return '#' + hex(bitmap[2]) + hex(bitmap[1]) + hex(bitmap[0]);
}

app.disableHardwareAcceleration();
app.whenReady().then(() => {
  if (!SOURCE) { console.error('usage: electron scripts/make-wallpapers.cjs <folder>'); app.exit(1); return; }
  fs.rmSync(OUT, { recursive: true, force: true });
  const categories = [];
  const wallpapers = [];
  let before = 0;
  let after = 0;
  const seen = new Set();

  for (const folder of fs.readdirSync(SOURCE).sort()) {
    const dir = path.join(SOURCE, folder);
    if (!fs.statSync(dir).isDirectory()) continue;
    const category = CATEGORY_NAMES[folder.toLowerCase()] || { id: slug(folder), name: title(folder.split(/[\s_-]+/)) };
    if (!categories.some((c) => c.id === category.id)) categories.push(category);
    fs.mkdirSync(path.join(OUT, category.id, 'thumbs'), { recursive: true });

    for (const file of fs.readdirSync(dir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort()) {
      const input = path.join(dir, file);
      const hash = crypto.createHash('sha1').update(fs.readFileSync(input)).digest('hex');
      if (seen.has(hash)) { console.log('  skipped (duplicate):', file); continue; }
      seen.add(hash);
      let image = nativeImage.createFromPath(input);
      if (image.isEmpty()) { console.warn('  skipped (unreadable):', file); continue; }
      // The browser is wider than it is tall. A portrait photo would be
      // cropped to a band by background-size: cover anyway, so crop it here
      // to 16:10 around the centre and do not ship the pixels nobody sees.
      let size = image.getSize();
      if (size.width / size.height < 1.5) {
        const height = Math.round(size.width / 1.6);
        image = image.crop({ x: 0, y: Math.round((size.height - height) / 2), width: size.width, height });
        size = image.getSize();
      }
      const full = size.width > FULL_WIDTH ? image.resize({ width: FULL_WIDTH, quality: 'best' }) : image;
      const thumb = image.resize({ width: THUMB_WIDTH, quality: 'best' });
      const who = credit(file);
      const id = category.id + '-' + slug(path.basename(file, path.extname(file))).replace(/-unsplash$/, '').slice(0, 40);
      const name = id.slice(category.id.length + 1) + '.jpg';
      const fullBytes = full.toJPEG(82);
      fs.writeFileSync(path.join(OUT, category.id, name), fullBytes);
      fs.writeFileSync(path.join(OUT, category.id, 'thumbs', name), thumb.toJPEG(74));
      before += fs.statSync(input).size;
      after += fullBytes.length;
      const fullSize = full.getSize();
      wallpapers.push({
        id,
        category: category.id,
        file: 'wallpapers/' + category.id + '/' + name,
        thumb: 'wallpapers/' + category.id + '/thumbs/' + name,
        width: fullSize.width,
        height: fullSize.height,
        tone: averageColour(image),
        credit: who,
      });
      console.log('  ' + category.id.padEnd(11) + ' ' + name + '  ' + fullSize.width + 'x' + fullSize.height +
        '  ' + Math.round(fullBytes.length / 1024) + ' KB  ' + who.by + ' / ' + who.source);
    }
  }

  fs.writeFileSync(MANIFEST, JSON.stringify({ categories, wallpapers }, null, 1) + '\n');
  console.log('\n' + wallpapers.length + ' wallpapers in ' + categories.length + ' categories: ' +
    Math.round(before / 1048576) + ' MB -> ' + Math.round(after / 1048576) + ' MB');
  app.exit(0);
});
