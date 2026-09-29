'use strict';
(function () {
/**
 * Settings -> Appearance -> Forge a planet.
 *
 * The preview is painted from the same forgePlanet() the browser uses, so
 * what you see here is exactly what the browser will wear. Nothing is saved
 * until "Add to the solar system"; editing an existing planet saves over it.
 */
const { $, element, invoke, onState } = window.page;

let settings = {};
let editing = null;
let light = false;

const inputs = {
  name: $('#forge-name'),
  primary: $('#forge-primary'),
  secondary: $('#forge-secondary'),
  deep: $('#forge-deep'),
  accent: $('#forge-accent'),
  glow: $('#forge-glow'),
  glass: $('#forge-glass'),
  wallpaper: $('#forge-wallpaper'),
};

function draft() {
  return {
    id: editing || undefined,
    name: inputs.name.value.trim() || 'Your planet',
    primary: inputs.primary.value,
    secondary: inputs.secondary.value,
    deep: inputs.deep.value,
    accent: inputs.accent.value,
    glow: Number(inputs.glow.value) / 100,
    glass: Number(inputs.glass.value) / 100,
    light,
    wallpaper: inputs.wallpaper.value,
  };
}

function orbFill(p) {
  return 'radial-gradient(circle at 32% 28%, ' + p.primary + ', ' + p.secondary + ' 55%, ' + p.deep + ')';
}

/** Paint the preview from the real theme builder. */
function paint() {
  const def = draft();
  const planet = window.theme.forgePlanet(def);
  const preview = $('#forge-preview');
  for (const [key, value] of Object.entries(planet.tokens)) preview.style.setProperty('--f-' + key, value);
  preview.style.setProperty('--f-ambient', planet.ambient);
  preview.style.setProperty('--f-glow', String(def.glow));
  const orb = $('#forge-orb');
  orb.style.background = orbFill(planet.palette);
  orb.style.boxShadow = '0 0 ' + Math.round(10 + def.glow * 50) + 'px ' + planet.palette.primary +
    ', inset -10px -12px 22px rgba(0,0,0,0.4)';
  $('#forge-title').textContent = def.name;
  $('#forge-glow-value').textContent = inputs.glow.value + '%';
  $('#forge-glass-value').textContent = inputs.glass.value + '%';
  for (const button of $('#forge-light').querySelectorAll('[data-light]')) {
    button.classList.toggle('is-on', (button.dataset.light === 'light') === light);
  }
}

/** A palette that hangs together: hues from one wheel, not four random picks. */
function surprise() {
  const hue = Math.floor(Math.random() * 360);
  const turn = [30, 150, 180, 210, 330][Math.floor(Math.random() * 5)];
  const hsl = (h, s, l) => {
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
      const k = (n + h / 30) % 12;
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0');
    };
    return '#' + f(0) + f(8) + f(4);
  };
  inputs.primary.value = hsl(hue, 0.62, 0.6);
  inputs.secondary.value = hsl((hue + turn) % 360, 0.5, 0.58);
  inputs.deep.value = hsl((hue + 200) % 360, 0.42, 0.16);
  inputs.accent.value = hsl(hue, 0.72, 0.62);
  inputs.glow.value = String(30 + Math.floor(Math.random() * 60));
  inputs.glass.value = String(Math.floor(Math.random() * 60));
  if (!inputs.name.value.trim()) {
    const names = ['Aurelia', 'Kepler', 'Nyx', 'Solace', 'Vesper', 'Halcyon', 'Oriel', 'Tethys', 'Lumen', 'Zephyr'];
    inputs.name.value = names[Math.floor(Math.random() * names.length)];
  }
  paint();
}

function say(text) { $('#forge-status').textContent = text || ''; }

function load(def) {
  editing = def ? def.id : null;
  inputs.name.value = def?.name || '';
  inputs.primary.value = def?.primary || '#4d90f0';
  inputs.secondary.value = def?.secondary || '#8b7cf0';
  inputs.deep.value = def?.deep || '#12224a';
  inputs.accent.value = def?.accent || def?.primary || '#4d90f0';
  inputs.glow.value = String(Math.round((def?.glow ?? 0.5) * 100));
  inputs.glass.value = String(Math.round((def?.glass ?? 0.3) * 100));
  inputs.wallpaper.value = def?.wallpaper || '';
  light = !!def?.light;
  $('#forge-apply').textContent = editing ? 'Save ' + (def.name || 'planet') : 'Add to the solar system';
  $('#forge-cancel').hidden = !editing;
  paint();
}

async function save() {
  const def = draft();
  if (!inputs.name.value.trim()) { say('Give your planet a name first.'); inputs.name.focus(); return; }
  const list = [...(settings.customPlanets || [])];
  if (!editing && list.length >= 12) { say('The solar system holds twelve planets of your own. Delete one to make room.'); return; }
  if (!editing && list.some((p) => p.name.toLowerCase() === def.name.toLowerCase())) {
    say('You already have a planet called ' + def.name + '.');
    return;
  }
  const at = editing ? list.findIndex((p) => p.id === editing) : -1;
  if (at >= 0) list[at] = { ...list[at], ...def, id: editing };
  else list.push({ ...def, id: undefined });
  try {
    const next = await invoke('settings:update', { customPlanets: list });
    const saved = at >= 0 ? next.customPlanets[at] : next.customPlanets[next.customPlanets.length - 1];
    const patch = { theme: saved.id };
    if (saved.wallpaper) patch.newTab = { background: 'wallpaper', backgroundValue: saved.wallpaper, wallpaperMode: 'fixed' };
    await invoke('settings:update', patch);
    say(saved.name + (at >= 0 ? ' saved.' : ' has joined the solar system. The browser is wearing it now.'));
    load(null);
  } catch (error) {
    say(error.message || String(error));
  }
}

function renderMade() {
  const list = settings.customPlanets || [];
  const host = $('#forge-made');
  if (!list.length) { host.replaceChildren(); return; }
  host.replaceChildren(
    element('div', { class: 'forge-made-label', text: 'Your planets' }),
    ...list.map((def) => {
      const planet = window.theme.forgePlanet(def);
      const orb = element('span', { class: 'forge-made-orb' });
      orb.style.background = orbFill(planet.palette);
      let armed = null;
      const remove = element('button', { type: 'button', class: 'danger', text: 'Delete' });
      remove.addEventListener('click', async () => {
        if (!armed) {
          remove.textContent = 'Click again';
          armed = setTimeout(() => { armed = null; remove.textContent = 'Delete'; }, 3000);
          return;
        }
        clearTimeout(armed);
        await invoke('settings:update', { customPlanets: list.filter((p) => p.id !== def.id) }).catch((e) => say(e.message));
        if (editing === def.id) load(null);
      });
      return element('div', { class: 'forge-made-item' + (settings.theme === def.id ? ' is-worn' : '') }, [
        orb,
        element('strong', { text: def.name }),
        element('button', {
          type: 'button', text: settings.theme === def.id ? 'Wearing' : 'Wear',
          onclick: () => {
            const patch = { theme: def.id };
            if (def.wallpaper) patch.newTab = { background: 'wallpaper', backgroundValue: def.wallpaper, wallpaperMode: 'fixed' };
            invoke('settings:update', patch).catch((e) => say(e.message));
          },
        }),
        element('button', { type: 'button', text: 'Edit', onclick: () => { load(def); inputs.name.focus(); } }),
        remove,
      ]);
    }),
  );
}

for (const input of Object.values(inputs)) input.addEventListener('input', paint);
$('#forge-light').addEventListener('click', (event) => {
  const button = event.target.closest('[data-light]');
  if (!button) return;
  light = button.dataset.light === 'light';
  paint();
});
$('#forge-shuffle').addEventListener('click', surprise);
$('#forge-apply').addEventListener('click', save);
$('#forge-cancel').addEventListener('click', () => { load(null); say(''); });

invoke('wallpapers:catalog').then(({ categories, wallpapers }) => {
  for (const category of categories) {
    const group = element('optgroup', { label: category.name });
    for (const w of wallpapers.filter((item) => item.category === category.id)) {
      group.append(element('option', { value: w.id, text: w.credit.by + ' (' + category.name + ')' }));
    }
    inputs.wallpaper.append(group);
  }
}).catch(() => {});

onState((state) => {
  settings = state.settings || {};
  renderMade();
});
paint();
})();
