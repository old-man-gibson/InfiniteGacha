// Drawing the town and the people in it. Browser only: window.TownView.
// Depends on townmap.js (the ground), townlife.js (who is walking where), tokens.js (faces),
// lpc.js (the art) and bonds.js (who is standing with whom).
//
// The map is drawn once per change and cached to an offscreen canvas — the ground only moves
// when somebody builds — and every frame after that is a blit plus however many people are out.
// A hundred-character town is a hundred cached discs, which is nothing.
//
// With three.js loaded and the 3D view switched on (the same preference as the field map, see
// pref3d), the town is drawn by world3d.js instead: same sim, same camera numbers, same picking.
// A canvas cannot hand out both a 2D and a WebGL context, so switching makes a new canvas.
//
// Friendship is the only relation drawn here that is not also written down. Two characters who
// like each other and are standing together get a line between them. The line is faint and is
// drawn only while they are together.

(() => {
const T = Mapgen.T;

// Warmer than a dungeon: this is somewhere people live.
const PAL = {
  [T.FLOOR]: '#37402e',
  [T.WALL]:  '#4b4438',
  [T.DOOR]:  '#a5793f',
  [T.COVER]: '#2b3325',
  [T.ROAD]:  '#6d6350',
  [T.GATE]:  '#8b5fd0',
  [T.DOWN]:  '#6a5a9a',
  [T.UP]:    '#4a4a6a',
};
const INSIDE = {                      // a tint over each kind of plot's floor, so a roof reads as a roof
  work:   'rgba(190,150,90,.20)',
  bed:    'rgba(110,168,255,.18)',
  altar:  'rgba(200,110,200,.18)',
  gate:   'rgba(139,95,208,.22)',
  square: 'rgba(0,0,0,0)',
};

let cv = null, fx = null, raf = null, last = 0, host = null;
let ground = null, groundSig = '';
let cam = { zoom: 1, cx: null, cy: null };
let drag = null, hover = null;
let onPick = null, getState = null;
let world3d = null, lastView = null;       // the 3D renderer while it is in use, and its last view

const PREF = 'ig.view3d';
const pref3d = () => { try { return localStorage.getItem(PREF) !== '0'; } catch (e) { return true; } };
/** 3D wanted and three.js loaded. While three.js is still loading this is false and pending() true. */
const three = () => pref3d() && typeof World3D !== 'undefined' && World3D.ready();
const pending = () => pref3d() && typeof World3D !== 'undefined' && World3D.pending();

// ---------- the camera ----------
function layout() {
  const map = TownLife.current().map;
  const pad = 6;
  const fit = Math.min((cv.width - pad * 2) / map.w, (cv.height - pad * 2) / map.h);
  const scale = fit * Math.max(1, cam.zoom);
  const axis = (span, tiles, centre) => {
    const total = tiles * scale;
    if (total <= span || centre == null) return (span - total) / 2;
    return Math.max(span - total, Math.min(0, span / 2 - (centre + 0.5) * scale));
  };
  return { scale, fit, ox: axis(cv.width, map.w, cam.cx), oy: axis(cv.height, map.h, cam.cy) };
}

const tileAt = (ev, view) => {
  const r = cv.getBoundingClientRect();
  const px = (ev.clientX - r.left) * (cv.width / r.width);
  const py = (ev.clientY - r.top) * (cv.height / r.height);
  if (view.tileAt) {                       // 3D: through the camera onto the ground
    const t = view.tileAt(ev) || { x: -99, y: -99 };
    return { x: t.x + 0.5, y: t.y + 0.5, px, py };
  }
  return { x: (px - view.ox) / view.scale, y: (py - view.oy) / view.scale, px, py };
};
/** The view the handlers measure against: the flat layout, or what the 3D renderer last drew. */
const viewNow = () => (world3d ? lastView : layout());

// ---------- the ground ----------
/** Everything that does not move, baked once. */
function bakeGround(map, scale) {
  const c = document.createElement('canvas');
  c.width = Math.ceil(map.w * scale);
  c.height = Math.ceil(map.h * scale);
  const g = c.getContext('2d');
  const px = Math.ceil(scale);
  for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) {
    g.fillStyle = PAL[map.at(x, y)] || PAL[T.FLOOR];
    g.fillRect(x * scale, y * scale, px, px);
  }
  // roofs: a tint over the inside of every plot, so a building is a building and not a wall
  for (const p of Object.values(map.plots)) {
    const tint = INSIDE[p.kind];
    if (!tint || p.kind === 'square') continue;
    g.fillStyle = tint;
    g.fillRect((p.x + 1) * scale, (p.y + 1) * scale, (p.w - 2) * scale, (p.h - 2) * scale);
    g.strokeStyle = 'rgba(0,0,0,.35)';
    g.lineWidth = Math.max(1, scale * 0.08);
    g.strokeRect(p.x * scale + 0.5, p.y * scale + 0.5, p.w * scale - 1, p.h * scale - 1);
  }
  return c;
}

function drawLabels(view) {
  const map = TownLife.current().map;
  const { scale, ox, oy } = view;
  const size = Math.max(9, Math.min(15, scale * 0.85));
  fx.textAlign = 'center';
  fx.textBaseline = 'alphabetic';
  for (const p of Object.values(map.plots)) {
    const cxp = ox + (p.x + p.w / 2) * scale;
    const top = oy + p.y * scale;
    fx.font = `${Math.round(size * 1.15)}px system-ui, sans-serif`;
    fx.fillStyle = 'rgba(0,0,0,.55)';
    fx.fillText(p.icon, cxp + 1, top - 3);
    fx.fillStyle = '#e8e4dc';
    fx.fillText(p.icon, cxp, top - 4);
    if (scale < 9) continue;                    // zoomed out: icons only, or it is a wall of text
    fx.font = `${Math.round(size * 0.8)}px system-ui, sans-serif`;
    fx.fillStyle = 'rgba(0,0,0,.6)';
    fx.fillText(p.label, cxp + 1, top - size - 3);
    fx.fillStyle = 'rgba(232,228,220,.85)';
    fx.fillText(p.label, cxp, top - size - 4);
  }
}

// ---------- the people ----------
const POG_MIN = 15, POG_MAX = 36;
let pogSize = 22;
const pogFont = (s) => Math.max(8, Math.round(s / 3));

function bake(a) {
  const ch = a.char && a.char.selections ? a.char : null;
  if (!ch || a.baking) return;
  a.baking = true;
  LPC.buildLayers(ch).then(layers => {
    a.layers = layers;
    a.token = Tokens.pog(layers, { name: a.label, size: pogSize, font: pogFont(pogSize), ring: ringFor(a) });
    a.ring = ringFor(a);
    a.baked = pogSize;
    a.baking = false;
  }).catch(() => { a.baking = false; });
}

/** The rim says what state somebody is in, at a glance, without a bar over their head. */
function ringFor(a) {
  const c = a.char;
  if (c.injured > 0) return Tokens.RINGS.down;
  if (typeof Condition !== 'undefined' && Condition.isSpent(c)) return Tokens.RINGS.hurt;
  if (c.job) return Tokens.RINGS.squad;
  return Tokens.RINGS.ally;
}

function drawFolk(view, state) {
  const { scale, ox, oy } = view;
  const want = Math.round(Math.max(POG_MIN, Math.min(POG_MAX, scale * 1.7)));
  if (want !== pogSize) { pogSize = want; for (const a of TownLife.onFoot()) { a.token = null; a.baked = 0; } }

  const folk = TownLife.onFoot();
  const sx = (a) => ox + (a.x + .5) * scale;
  const sy = (a) => oy + (a.y + .5) * scale;

  // friendships first, under the faces: a thread between two people standing together
  for (const k of TownLife.knots(state)) {
    fx.strokeStyle = k.tier.color;
    fx.globalAlpha = 0.5;
    fx.lineWidth = Math.max(1, scale * 0.09);
    fx.setLineDash(k.v < 0 ? [3, 3] : []);
    fx.beginPath();
    fx.moveTo(sx(k.a), sy(k.a));
    fx.lineTo(sx(k.b), sy(k.b));
    fx.stroke();
    fx.setLineDash([]);
    fx.globalAlpha = 1;
  }

  for (const a of folk.slice().sort((p, q) => p.y - q.y)) {
    if (!a.token || a.baked !== pogSize) bake(a);
    const x = sx(a), y = sy(a);
    if (!a.token) {                              // art still loading: a disc with a letter in it
      fx.fillStyle = '#2a2a34';
      fx.beginPath(); fx.arc(x, y, pogSize / 2, 0, Math.PI * 2); fx.fill();
      fx.strokeStyle = ringFor(a); fx.lineWidth = 2; fx.stroke();
      fx.fillStyle = '#ddd'; fx.font = `${Math.round(pogSize / 2)}px system-ui`; fx.textAlign = 'center';
      fx.fillText((a.label || '?')[0], x, y + pogSize / 6);
      continue;
    }
    const ring = ringFor(a);
    if (ring !== a.ring && a.layers) {
      a.token = Tokens.pog(a.layers, { name: a.label, size: pogSize, font: pogFont(pogSize), ring });
      a.ring = ring;
    }
    Tokens.drawShadow(fx, x, y + pogSize * 0.34, pogSize * 0.7, 0.25);
    Tokens.drawPog(fx, a.token, x, y);
    if (hover && hover.id === a.id) {
      fx.strokeStyle = '#ffd740';
      fx.lineWidth = 2;
      fx.beginPath(); fx.arc(x, y, pogSize / 2 + 3, 0, Math.PI * 2); fx.stroke();
    }
  }
}

// ---------- the loop ----------
function frame(now) {
  raf = requestAnimationFrame(frame);
  if (!cv && host && !pending()) swapCanvas();     // mounted while three.js was still loading
  if (!cv || !cv.isConnected || cv.offsetParent === null) return;
  const state = getState && getState();
  if (!state) return;
  const dt = Math.min(0.1, (now - last) / 1000 || 0);
  last = now;

  TownLife.sync(state);
  TownLife.step(state, dt);
  if (pending()) return;                      // three.js still loading: no 2D context yet
  if (three() !== !!world3d) swapCanvas();
  if (world3d) {
    for (const a of TownLife.onFoot()) if (!a.layers) bake(a);
    lastView = world3d.renderTown(TownLife.current(), TownLife.knots(state), cam, dt * 1000, { hoverId: hover && hover.id, ringFor, state });
    return;
  }
  resize();
  const map = TownLife.current().map;
  const view = layout();

  const sig = map.sig + '@' + Math.round(view.scale * 4);
  if (!ground || groundSig !== sig) { ground = bakeGround(map, view.scale); groundSig = sig; }

  fx.fillStyle = '#14141a';
  fx.fillRect(0, 0, cv.width, cv.height);
  fx.imageSmoothingEnabled = false;
  fx.drawImage(ground, view.ox, view.oy);
  drawLabels(view);
  drawFolk(view, state);
}

function resize() {
  const r = host.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(320, Math.round(r.width * dpr));
  const h = Math.max(240, Math.round(r.height * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; ground = null; }
}

// ---------- wiring ----------
/** A fresh canvas for whichever view is wanted now, in place of the old one. */
function swapCanvas() {
  if (world3d) { world3d.dispose(); world3d = null; lastView = null; }
  const next = document.createElement('canvas');
  next.className = 'townmap';
  if (cv) cv.replaceWith(next); else if (host) host.append(next);
  cv = next;
  wire();
  ground = null;
  if (three()) { fx = null; world3d = World3D.create(cv, { fill: true }); }
  else fx = cv.getContext('2d');
}

function wire() {
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const view = viewNow();
    if (!view) return;
    const t = tileAt(e, view);
    cam.zoom = Math.max(1, Math.min(6, cam.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    if (cam.zoom > 1) { cam.cx = t.x; cam.cy = t.y; } else { cam.cx = cam.cy = null; }
  }, { passive: false });

  cv.addEventListener('pointerdown', (e) => {
    const view = viewNow();
    if (!view) return;
    drag = { ...tileAt(e, view), cx: cam.cx, cy: cam.cy, moved: false };
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', (e) => {
    const view = viewNow();
    if (!view) return;
    const t = tileAt(e, view);
    if (drag) {
      const dx = (t.px - drag.px) / view.scale, dy = (t.py - drag.py) / (view.scaleY || view.scale);
      if (Math.abs(dx) + Math.abs(dy) > 0.4) drag.moved = true;
      if (cam.zoom > 1) {
        cam.cx = (drag.cx == null ? TownLife.current().map.w / 2 : drag.cx) - dx;
        cam.cy = (drag.cy == null ? TownLife.current().map.h / 2 : drag.cy) - dy;
      }
      return;
    }
    hover = pick(t) || null;
    cv.style.cursor = hover ? 'pointer' : (cam.zoom > 1 ? 'grab' : 'default');
  });
  cv.addEventListener('pointerup', (e) => {
    const moved = drag && drag.moved;
    drag = null;
    if (moved || !viewNow()) return;
    const hit = pick(tileAt(e, viewNow()));
    if (hit && onPick) onPick(hit.char);
  });
  cv.addEventListener('pointerleave', () => { drag = null; hover = null; });
}

/** Whoever is standing nearest this tile, if anybody is standing near enough to have been meant. */
function pick(t) {
  let best = null, bestD = 1.6;
  for (const a of TownLife.onFoot()) {
    const d = Math.hypot(a.x + .5 - t.x, a.y + .5 - t.y);
    if (d < bestD) { bestD = d; best = a; }
  }
  return best;
}

/**
 * Put the town on screen. `element` is the box it fills, `state` a getter for the town's state,
 * and `pickCharacter` is called with a character when somebody is clicked.
 */
function mount(element, stateGetter, { pickCharacter = null } = {}) {
  host = element;
  getState = stateGetter;
  onPick = pickCharacter;
  if (!cv && !pending()) swapCanvas();
  if (cv && cv.parentElement !== host) { host.innerHTML = ''; host.append(cv); }
  ground = null;
  if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
}

function unmount() {
  if (raf) cancelAnimationFrame(raf);
  raf = null;
}

/** Centre the view on one character and zoom in far enough to see their face. */
function focus(charId, zoom = 3) {
  const a = TownLife.onFoot().find(x => x.id === charId);
  if (!a) return false;
  cam.zoom = zoom; cam.cx = a.x; cam.cy = a.y;
  return true;
}

/** Switch between the 3D and the flat town. Shared with the field map, so it is one setting. */
function set3d(on) {
  try { localStorage.setItem(PREF, on ? '1' : '0'); } catch (e) { /* private window: this visit only */ }
}

window.TownView = { mount, unmount, focus, set3d, get is3d() { return pref3d(); }, PAL, get camera() { return cam; } };
})();
