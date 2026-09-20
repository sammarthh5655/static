'use strict';
(function () {
/**
 * The theme picker: a planetarium.
 *
 * Choosing how the browser looks should be done by LOOKING, not by reading
 * names in a dropdown. So the planets are drawn as actual bodies, orbiting,
 * each rendered from its own three-colour identity: a lit limb in the primary
 * colour, a secondary band, and a shadow side in the deep colour.
 *
 * Interaction, in order of how people reach for it:
 *   - hover a planet   -> it swells, names itself, and the ring lights up
 *   - click a planet   -> the whole browser changes to it, immediately
 *   - drag the system  -> the orbits rotate under the pointer
 *   - the Forge        -> build your own world from a colour and a light/dark
 *
 * Applying on click rather than behind a Save button is deliberate: the only
 * way to judge a theme is to see the browser wearing it, and every choice here
 * is one click to undo.
 *
 * Drawn on a canvas rather than as DOM nodes. Eleven animated bodies with
 * gradients and shadows are eleven composited layers recalculating on every
 * frame; a canvas is one.
 */

function build(ctx, options) {
  const settings = options || {};
  const planets = (settings.planets || []).slice().sort((a, b) => a.order - b.order);
  const onPick = settings.onPick || (() => {});
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const wrap = ctx.element('div', { class: 'planetarium' });
  const canvas = ctx.element('canvas', { class: 'planetarium-canvas' });
  const caption = ctx.element('div', { class: 'planetarium-caption' }, [
    ctx.element('span', { class: 'planetarium-name' }),
    ctx.element('span', { class: 'planetarium-blurb' }),
  ]);
  wrap.append(canvas, caption);

  const context = canvas.getContext('2d');
  let width = 0;
  let height = 0;
  let ratio = 1;

  // Where each planet currently is, recomputed every frame and used for both
  // drawing and hit-testing, so what is clicked is exactly what is drawn.
  let bodies = [];
  let hovered = -1;
  let current = settings.current || '';
  let spin = 0;          // the whole system's rotation
  let dragging = false;
  let dragFrom = 0;
  let spinFrom = 0;
  let time = 0;

  const resize = () => {
    ratio = Math.min(window.devicePixelRatio || 1, 2);
    const box = wrap.getBoundingClientRect();
    const w = Math.max(280, box.width || 640);
    // The system is wider than it is tall, and must not push the page down.
    const h = Math.max(220, Math.min(340, w * 0.46));
    canvas.width = Math.floor(w * ratio);
    canvas.height = Math.floor(h * ratio);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    width = w;
    height = h;
  };

  /** Draw one planet as a lit sphere from its own three colours. */
  const drawPlanet = (planet, x, y, r, lit) => {
    const palette = planet.palette || {};
    const primary = palette.primary || '#888888';
    const secondary = palette.secondary || primary;
    const deep = palette.deep || '#222222';

    context.save();
    context.translate(x * ratio, y * ratio);
    const radius = r * ratio;

    // Glow, stronger for the hovered and the current planet.
    if (lit > 0) {
      const glow = context.createRadialGradient(0, 0, radius * 0.7, 0, 0, radius * 2.6);
      glow.addColorStop(0, primary + Math.round(lit * 90).toString(16).padStart(2, '0'));
      glow.addColorStop(1, primary + '00');
      context.fillStyle = glow;
      context.beginPath();
      context.arc(0, 0, radius * 2.6, 0, Math.PI * 2);
      context.fill();
    }

    // The body: lit limb in primary, terminator into deep.
    const face = context.createLinearGradient(-radius, -radius, radius, radius);
    face.addColorStop(0, primary);
    face.addColorStop(0.5, secondary);
    face.addColorStop(1, deep);
    context.fillStyle = face;
    context.beginPath();
    context.arc(0, 0, radius, 0, Math.PI * 2);
    context.fill();

    // A band across the middle, so a planet reads as a body rather than a dot.
    context.save();
    context.beginPath();
    context.arc(0, 0, radius, 0, Math.PI * 2);
    context.clip();
    context.globalAlpha = 0.34;
    context.fillStyle = secondary;
    context.beginPath();
    context.ellipse(0, radius * 0.12, radius * 1.2, radius * 0.22, 0, 0, Math.PI * 2);
    context.fill();
    context.globalAlpha = 0.2;
    context.beginPath();
    context.ellipse(0, -radius * 0.34, radius * 1.2, radius * 0.14, 0, 0, Math.PI * 2);
    context.fill();
    context.restore();

    // Shadow side, so the light has a direction.
    const shade = context.createLinearGradient(-radius * 0.2, -radius, radius, radius);
    shade.addColorStop(0, 'rgba(0,0,0,0)');
    shade.addColorStop(1, 'rgba(0,0,0,0.55)');
    context.fillStyle = shade;
    context.beginPath();
    context.arc(0, 0, radius, 0, Math.PI * 2);
    context.fill();

    // Saturn gets its rings, because a gold circle is not Saturn.
    if (planet.id === 'saturn') {
      context.save();
      context.rotate(-0.42);
      context.strokeStyle = secondary;
      context.globalAlpha = 0.85;
      context.lineWidth = Math.max(1, radius * 0.1);
      context.beginPath();
      context.ellipse(0, 0, radius * 1.75, radius * 0.42, 0, 0, Math.PI * 2);
      context.stroke();
      context.globalAlpha = 0.45;
      context.lineWidth = Math.max(1, radius * 0.06);
      context.beginPath();
      context.ellipse(0, 0, radius * 2.1, radius * 0.5, 0, 0, Math.PI * 2);
      context.stroke();
      context.restore();
    }

    // The current planet wears a ring, so the chosen one is obvious at rest.
    if (planet.id === current) {
      context.strokeStyle = primary;
      context.globalAlpha = 0.9;
      context.lineWidth = 1.6 * ratio;
      context.beginPath();
      context.arc(0, 0, radius * 1.45, 0, Math.PI * 2);
      context.stroke();
      context.globalAlpha = 1;
    }
    context.restore();
  };

  const frame = () => {
    if (!wrap.isConnected) return;
    if (!reduced) time += 0.0022;

    context.clearRect(0, 0, canvas.width, canvas.height);

    const cx = width / 2;
    const cy = height / 2;
    // Orbits are ellipses so the system reads as tilted rather than flat.
    const maxA = width * 0.44;
    const maxB = height * 0.38;

    bodies = [];
    planets.forEach((planet, index) => {
      const step = (index + 1) / planets.length;
      const a = maxA * (0.24 + step * 0.76);
      const b = maxB * (0.24 + step * 0.76);
      // Outer planets move more slowly, which is both true and easier to read.
      const angle = spin + time * (1.6 / (index + 2)) + index * 0.9;
      const x = cx + Math.cos(angle) * a;
      const y = cy + Math.sin(angle) * b;

      // Orbit path.
      context.save();
      context.strokeStyle = (planet.palette && planet.palette.primary) || '#ffffff';
      context.globalAlpha = hovered === index ? 0.4 : 0.08;
      context.lineWidth = 1 * ratio;
      context.beginPath();
      context.ellipse(cx * ratio, cy * ratio, a * ratio, b * ratio, 0, 0, Math.PI * 2);
      context.stroke();
      context.restore();

      const base = Math.max(9, Math.min(19, width / 44));
      const r = base * (hovered === index ? 1.45 : planet.id === current ? 1.18 : 1);
      bodies.push({ planet, x, y, r, index });
    });

    // Draw far-to-near so nearer planets overlap correctly.
    bodies.slice().sort((one, two) => one.y - two.y).forEach((body) => {
      const lit = hovered === body.index ? 1 : body.planet.id === current ? 0.55 : 0.18;
      drawPlanet(body.planet, body.x, body.y, body.r, lit);
    });

    requestAnimationFrame(frame);
  };

  /** Which planet is under this pointer position, if any. */
  const hitTest = (event) => {
    const box = canvas.getBoundingClientRect();
    const px = event.clientX - box.left;
    const py = event.clientY - box.top;
    let best = -1;
    let bestDistance = Infinity;
    for (const body of bodies) {
      const distance = Math.hypot(px - body.x, py - body.y);
      // A generous radius: these are small targets and a near miss should
      // still select rather than silently do nothing.
      if (distance < body.r + 12 && distance < bestDistance) {
        bestDistance = distance;
        best = body.index;
      }
    }
    return best;
  };

  const showCaption = (index) => {
    const planet = index >= 0 ? planets[index] : planets.find((item) => item.id === current);
    caption.querySelector('.planetarium-name').textContent = planet ? planet.name : '';
    caption.querySelector('.planetarium-blurb').textContent = planet ? (planet.blurb || '') : '';
    if (planet && planet.palette) {
      caption.style.setProperty('--caption-tone', planet.palette.primary);
    }
  };

  canvas.addEventListener('pointermove', (event) => {
    if (dragging) {
      spin = spinFrom + (event.clientX - dragFrom) * 0.006;
      return;
    }
    const at = hitTest(event);
    if (at !== hovered) {
      hovered = at;
      canvas.style.cursor = at >= 0 ? 'pointer' : 'grab';
      showCaption(at);
    }
  });

  canvas.addEventListener('pointerleave', () => {
    hovered = -1;
    dragging = false;
    showCaption(-1);
  });

  canvas.addEventListener('pointerdown', (event) => {
    dragging = true;
    dragFrom = event.clientX;
    spinFrom = spin;
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener('pointerup', (event) => {
    const moved = Math.abs(event.clientX - dragFrom) > 4;
    dragging = false;
    try { canvas.releasePointerCapture(event.pointerId); } catch { /* already gone */ }
    if (moved) return;                       // a drag is not a choice
    const at = hitTest(event);
    if (at < 0) return;
    current = planets[at].id;
    showCaption(at);
    onPick(planets[at].id);
  });

  // Keyboard: the planetarium is one control that steps through the planets.
  canvas.setAttribute('tabindex', '0');
  canvas.setAttribute('role', 'listbox');
  canvas.setAttribute('aria-label', 'Theme, as a planet');
  canvas.addEventListener('keydown', (event) => {
    const at = planets.findIndex((planet) => planet.id === current);
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      hovered = Math.min(planets.length - 1, at + 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      hovered = Math.max(0, at - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      if (hovered >= 0) { current = planets[hovered].id; onPick(current); }
      event.preventDefault();
      return;
    } else return;
    event.preventDefault();
    current = planets[hovered].id;
    showCaption(hovered);
    onPick(current);
  });

  addEventListener('resize', resize);
  resize();
  showCaption(-1);
  requestAnimationFrame(frame);

  return {
    node: wrap,
    setCurrent(id) { current = id; showCaption(-1); },
    dispose() { removeEventListener('resize', resize); },
  };
}

window.planetarium = { build };

})();
