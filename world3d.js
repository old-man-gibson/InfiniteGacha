// The mission field in three dimensions. Browser only: window.World3D.
// Depends on three.js (window.THREE, put there by the page's loader — see THREE_LOADER below),
// mapgen.js (tile codes), tokens.js (rim colours, grade sizes), lpc.js (walk sheets) and
// fieldview.js (the zone and portal drawing, and the token follow). Uses figure3d.js (character
// models) when the page loads it.
//
// It also draws the home town (renderTown), from townmap.js's ground and townlife.js's walkers,
// on the same terrain and scenery code with a style of its own. The town's floors are raised
// platforms: the terrain takes its height from BaseLayout.heightAt (the same function the walking
// grid is cut from), and buildTown adds stone retaining walls along each platform's foot, stairs
// between floors, and a plaza with a banner on each floor. The town is a floating island
// (BaseLayout.islandSdf): the terrain is cut at its rim, and skyIsland() hangs a layered rock
// underside below it, with roots, a few islets, a waterfall from its pond and clouds below. How
// finished the town is follows its tier (FINISH): road surfaces from worn dirt to cobbles, roofs
// from thatch to slate, houses from bare walls to half-timbering, shutters and quoins, and what
// stands in the square, from a fire ring to a tiered fountain. The town's static meshes are merged
// by material once built (bake), so the detail costs a few dozen draw calls. Lodgings are furnished
// inside (seen once the roofs fade) and keep woodpiles, barrels and hay outside.
//
// The field and the town share their living scenery: trees of three kinds by stand (forest()),
// and grass tufts, flowers and pebbles on open ground (groundCover()), instanced, the leaves and
// grass swaying on U.uTime.
//
// This is a second way of DRAWING the same field state, not a second simulation. Nothing in
// here writes to the field; it reads `s.map`, `s.seen`, `s.actors` and `s.portal` and turns
// them into a scene. The flat view in fieldview.js stays, and is what the page falls back to
// when WebGL or three.js is missing.
//
// The look is a high, tilted perspective camera over a smooth heightfield, the way the
// GameCube-era action RPGs framed a dungeon floor: walls are not boxes but ground that rises.
//   - The terrain is one mesh. Each tile centre is 0 (open) or 1 (wall); heights between
//     centres are a smoothstepped bilinear blend, so a wall mass reads as a hill or a ridge and
//     every open tile centre is exactly on the floor (actors stand on heightAt()).
//   - Built maps (settlement, outpost, stronghold, arena) keep the ground flat and put cut
//     stone blocks on the wall tiles instead, because masonry should have edges.
//   - Colour is per vertex (grass/dirt/rock by slope and wall-ness) times a greyscale painted
//     texture, so there is no tile seam anywhere.
//   - Fog of war and the zone/portal rings are both textures over map space, sampled in the
//     terrain shader by world x,z. The rings are drawn by fieldview.js's own drawZones() into
//     an offscreen canvas, so the 3D view shows exactly what the flat one does.
//   - Squad members and townsfolk are figure3d.js models (one skinned mesh each, animated from
//     what the field or the town says they are doing) when figure3d.js is loaded. Monsters, and
//     characters without an LPC record, are billboards. Every fragment of a billboard is written
//     at the depth of the actor's feet, so a figure is hidden by what stands in front of where it
//     stands and never clipped by a wall or slope behind it — the usual 2.5D sorting, done in the
//     depth buffer.

(() => {
const T = Mapgen.T;

const SUB = 3;                 // terrain vertices per tile edge
const MARGIN = 7;              // tiles of scenery past the map edge, so the view never shows the void
const PITCH = 58 * Math.PI / 180;
const FOV = 30;                // vertical, degrees: narrow, so the perspective is gentle
const PX = 16;                 // overlay canvas pixels per tile

// Per archetype family (fieldview.js FAMILY). `hill` is how high a wall mass rises; 0 means
// the family builds walls as blocks instead.
const STYLE = {
  outdoor: {
    hill: 1.25, roll: 0.10, blocks: 0,
    grass: ['#5f8f3c', '#7cae48'], dry: '#b3b45a', moss: '#4a7a30', dirt: '#a88a5e', road: '#b89b6c',
    rock: '#8c7b62', top: '#557f34',
    sky: '#d6ecff', groundLight: '#6e5a3a', sun: '#fff0d2', sunI: 2.6, hemiI: 1.15,
    fog: '#bcd3d6', mote: '#fff6c8', vignette: 0.42,
  },
  built: {
    hill: 0, roll: 0.03, blocks: 1.3,
    grass: ['#8c8478', '#9d9483'], dry: '#a49c86', moss: '#6f7a52', dirt: '#9a8466', road: '#8f8676',
    rock: '#7e7468', top: '#8c8478',
    stone: '#b59f7e', cap: '#c4b391',
    sky: '#ffeccf', groundLight: '#6a5844', sun: '#ffe2b0', sunI: 2.7, hemiI: 1.05,
    fog: '#e2d3b8', mote: '#fff0d0', vignette: 0.4,
  },
  // the home town: open meadow, packed-dirt roads, buildings from baselayout.js (buildTown),
  // forest past the layout's extent
  town: {
    hill: 0, roll: 0.05,
    grass: ['#6a9a40', '#86b54e'], dry: '#bdb860', moss: '#55853a', dirt: '#b0905f', road: '#c2a675',
    rock: '#8c7b62', top: '#557f34',
    sky: '#d9eeff', groundLight: '#76603e', sun: '#fff0cf', sunI: 2.7, hemiI: 1.15,
    fog: '#bfe2f6', mote: '#fff6c8', vignette: 0.3, skyTop: '#dcf1ff', skyLow: '#9fcdee',
  },
  under: {
    hill: 1.1, roll: 0.06, blocks: 0,
    grass: ['#5a5163', '#6a6072'], dry: '#6e6478', moss: '#4c5a5a', dirt: '#5c5260', road: '#655a69',
    rock: '#5a4f64', top: '#3d3448',
    sky: '#a39ee0', groundLight: '#3a3040', sun: '#c4ccff', sunI: 0.95, hemiI: 1.15,
    fog: '#17131f', mote: '#9fe8ff', vignette: 0.6, lantern: '#ffb06a',
  },
};

/**
 * How finished the town is at each town tier (economy.js TOWN: Camp, Outpost, Village, Town,
 * City; the layout's `top`). Each tier keeps what the one below has and adds to it.
 *   path     road surface, and its two colours: worn dirt that frays into the grass, packed earth
 *            with pebbles, gravel with a timber edging, flagstones, cobbles (PAVE_GLSL draws 1-4)
 *   roof     covering of every ordinary roof (ROOF_LOOK): texture, palette and ridge
 *   plinth   tiles of stone footing under a house's walls
 *   timber   0 corner posts, 1 and a beam at each storey, 2 and studs and braces (half-timbered)
 *   window   0 a dark opening in a timber frame, 1 and plank shutters, 2 a white frame with a
 *            mullion cross and painted shutters, 3 and a flower box, 4 and a stone sill and lintel
 *   door     0 an opening under a lintel, 1 and a frame, 2 and a canopy, 3 and a step and a lantern
 *   quoins   dressed stone blocks up a plastered house's corners in place of its corner posts
 *   fence    the surround of a fenced workshop: stakes, rails, white pickets, iron railing
 *   lamps    tiles between street lamps along the roads (0: none)
 *   square   what stands in the square: fire ring, well, basin, fountain, tiered fountain
 *   terrace  the top of a raised floor's wall: bare, merlons, coping, coping and a balustrade
 */
const FINISH = [
  { path: 0, paths: ['#a3845a', '#8c7150'], roof: 'thatch',  plinth: 0,    timber: 0, window: 0, door: 0, quoins: false, fence: 'stakes',  lamps: 0,  square: 'fire',     terrace: 'bare' },
  { path: 1, paths: ['#b09670', '#9c835e'], roof: 'thatch',  plinth: 0.14, timber: 1, window: 1, door: 1, quoins: false, fence: 'rails',   lamps: 0,  square: 'well',     terrace: 'bare' },
  { path: 2, paths: ['#b9ad97', '#a69b86'], roof: 'shingle', plinth: 0.26, timber: 2, window: 2, door: 2, quoins: false, fence: 'rails',   lamps: 12, square: 'basin',    terrace: 'merlons' },
  { path: 3, paths: ['#cfc6b4', '#bdb3a0'], roof: 'tile',    plinth: 0.36, timber: 2, window: 3, door: 3, quoins: false, fence: 'pickets', lamps: 9,  square: 'fountain', terrace: 'coping' },
  { path: 4, paths: ['#aba59a', '#959084'], roof: 'slate',   plinth: 0.46, timber: 2, window: 4, door: 3, quoins: true,  fence: 'railing', lamps: 7,  square: 'tiered',   terrace: 'balustrade' },
];
const finishOf = (lay) => FINISH[Math.max(0, Math.min(FINISH.length - 1, (lay && lay.top) || 0))];

/** Each roof covering: the palette of an ordinary roof, overhang added, and what caps the ridge. */
const ROOF_LOOK = {
  thatch:  { colours: ['#c4a45e', '#b8944a', '#a98b52', '#cbb06c'], oh: 0.14, ridge: 'roll' },
  shingle: { colours: ['#7d5d40', '#6e4f33', '#8a6b4c', '#5f4a36'], oh: 0, ridge: 'board' },
  tile:    { colours: ['#b5532f', '#c46a3c', '#a8452f', '#9c4d33'], oh: 0, ridge: 'cap' },
  slate:   { colours: ['#55657d', '#5c6470', '#46506a', '#61707f', '#7a4a3a', '#5f6b58'], oh: 0, ridge: 'cap' },
};
const SHUTTERS = ['#4d6c9a', '#5f7d3c', '#8e4a3a', '#3f5f5a', '#7a5233', '#6a4c94'];

// ---------- noise, deterministic per map ----------

function hash(x, y) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x, y) => vnoise(x, y) * 0.57 + vnoise(x * 2.07, y * 2.07) * 0.29 + vnoise(x * 4.3, y * 4.3) * 0.14;
const smooth = (t) => t * t * (3 - 2 * t);
const sstep = (a, b, x) => smooth(Math.max(0, Math.min(1, (x - a) / (b - a))));

// ---------- painted textures (greyscale; the hue comes from vertex colour) ----------

function canvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** Soft blotches and short strokes, tiled, all near white so they shade rather than darken. */
function paintTexture(kind) {
  const N = 256, c = canvas(N), g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, N, N);
  const wrap = (fn) => { for (const dx of [-N, 0, N]) for (const dy of [-N, 0, N]) fn(dx, dy); };
  let k = 1;
  const r = () => hash(k++, 7);
  if (kind === 'flag') {
    // 4x4 flagstones per repeat (2 per tile), each a slightly different grey, with dark grout
    g.fillStyle = '#9c968c';
    g.fillRect(0, 0, N, N);
    const s = N / 4;
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const off = (y % 2) * s / 2, v = 214 + Math.floor(r() * 40);
      g.fillStyle = `rgb(${v},${v - 2},${v - 6})`;
      wrap((dx, dy) => {
        g.beginPath();
        g.roundRect(x * s + off + 3 + dx, y * s + 3 + dy, s - 6, s - 6, 7);
        g.fill();
      });
    }
  }
  for (let i = 0; i < 700; i++) {
    const x = r() * N, y = r() * N, rad = 3 + r() * 14, v = 205 + Math.floor(r() * 50);
    g.fillStyle = `rgba(${v},${v},${v},.22)`;
    wrap((dx, dy) => { g.beginPath(); g.arc(x + dx, y + dy, rad, 0, Math.PI * 2); g.fill(); });
  }
  if (kind === 'grass') {
    g.lineWidth = 1.2;
    for (let i = 0; i < 1600; i++) {
      const x = r() * N, y = r() * N, v = 175 + Math.floor(r() * 80), len = 2 + r() * 4;
      g.strokeStyle = `rgba(${v},${v},${v},.5)`;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + (r() - 0.5) * 2, y - len); g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * A roof covering, greyscale (the roof's colour multiplies it), one tile per repeat: u runs along
 * the ridge and v down the slope, so courses lie along the ridge with their lower edge in shadow.
 *   thatch   2 courses of straw a tile; shingle 4 courses of staggered shingles; tile 3 courses of
 *            round clay tiles 6 to the tile; slate 5 courses of staggered slates
 */
function roofTexture(kind) {
  const N = 128, c = canvas(N), g = c.getContext('2d');
  let k = 1;
  const r = () => hash(k++, 23);
  const wrap = (fn) => { for (const dx of [-N, 0, N]) for (const dy of [-N, 0, N]) fn(dx, dy); };
  const course = (y0, hgt, lo) => {             // a course: light at its top, shadow at its foot
    const grd = g.createLinearGradient(0, y0, 0, y0 + hgt);
    grd.addColorStop(0, '#f4f4f4'); grd.addColorStop(0.75, '#dedede'); grd.addColorStop(1, lo);
    g.fillStyle = grd; g.fillRect(0, y0, N, hgt);
  };
  if (kind === 'thatch') {
    for (let row = 0; row < 2; row++) course(row * N / 2, N / 2, '#8c8c8c');
    g.lineWidth = 1.1;
    for (let i = 0; i < 1100; i++) {
      const x = r() * N, y = r() * N, len = 6 + r() * 16, v = 140 + Math.floor(r() * 110);
      g.strokeStyle = `rgba(${v},${v},${v},.5)`;
      const dx = (r() - 0.5) * 2;
      wrap((ox, oy) => { g.beginPath(); g.moveTo(x + ox, y + oy); g.lineTo(x + dx + ox, y + len + oy); g.stroke(); });
    }
  } else if (kind === 'shingle' || kind === 'slate') {
    const rows = kind === 'shingle' ? 4 : 5, rh = N / rows;
    for (let row = 0; row < rows; row++) {
      const y0 = row * rh;
      let x = -(row % 2) * (kind === 'shingle' ? 13 : 16);
      while (x < N) {
        const sw = kind === 'shingle' ? 18 + r() * 14 : 30 + r() * 4, v = (kind === 'shingle' ? 190 : 205) + Math.floor(r() * 45);
        const grd = g.createLinearGradient(0, y0, 0, y0 + rh);
        grd.addColorStop(0, `rgb(${v},${v},${v})`); grd.addColorStop(0.8, `rgb(${v - 18},${v - 18},${v - 18})`); grd.addColorStop(1, `rgb(${v - 80},${v - 80},${v - 80})`);
        g.fillStyle = grd;
        wrap((ox) => g.fillRect(x + ox, y0, sw - 1.5, rh - 1));
        x += sw;
      }
    }
  } else if (kind === 'tile') {
    const rows = 3, cols = 6, rh = N / rows, cw = N / cols;
    for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
      const x0 = col * cw, y0 = row * rh, v = 215 + Math.floor(r() * 35);
      const grd = g.createLinearGradient(x0, 0, x0 + cw, 0);         // round across: lit, crest, shade
      grd.addColorStop(0, `rgb(${v - 70},${v - 70},${v - 70})`); grd.addColorStop(0.35, `rgb(${v},${v},${v})`); grd.addColorStop(1, `rgb(${v - 90},${v - 90},${v - 90})`);
      g.fillStyle = grd; g.fillRect(x0, y0, cw, rh);
      g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(x0, y0 + rh - 5, cw, 5);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * A tiling normal map of small ripples (linear, not sRGB): the height is four sine waves with
 * whole-number frequencies across the tile, so it repeats without a seam.
 */
function rippleTexture() {
  const N = 128, c = canvas(N), g = c.getContext('2d'), img = g.createImageData(N, N);
  const H = (x, y) => {
    const u = x / N * Math.PI * 2, v = y / N * Math.PI * 2;
    return Math.sin(u * 3 + v * 2) * 0.5 + Math.sin(u * 5 - v * 4 + 1.3) * 0.3 + Math.sin(u * 2 + v * 7 + 2.1) * 0.25 + Math.sin(-u * 8 + v * 3 + 0.4) * 0.15;
  };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let nx = -(H(x + 1, y) - H(x - 1, y)) * 2.5, ny = -(H(x, y + 1) - H(x, y - 1)) * 2.5, nz = 1;
    const l = Math.hypot(nx, ny, nz), i = (y * N + x) * 4;
    img.data[i] = (nx / l * 0.5 + 0.5) * 255; img.data[i + 1] = (ny / l * 0.5 + 0.5) * 255; img.data[i + 2] = (nz / l * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.repeat.set(1.5, 1.5);
  return t;
}

function radialTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)', size = 64) {
  const c = canvas(size), g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, inner);
  grd.addColorStop(1, outer);
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------- shader patches ----------

// Fog of war and the ground overlay, added to any lit material. Both textures are over map
// space (0..w, 0..h in tiles), sampled by world x,z; outside the map nothing is hidden.
// `fade` is for scenery tall enough to stand between the camera and the squad (tree crowns,
// masonry): inside a narrow cylinder from the squad toward the camera it is screen-door
// dithered away, so the party is never hidden behind a tree.
// `roof` is for town roofs: dithered out by U.uRoofCut (0..1), which renderTown raises as the
// camera closes in, so a close view shows who is inside.
// `sway` (amplitude, tiles; `swayBase` the local height it is measured from) is for leaves and grass:
// each vertex moves sideways by sway x (local y + swayBase) on a slow wave keyed to where the
// instance stands, from U.uTime.
// `pave` is for the town's terrain: on roads (the aRoad vertex attribute, 1 on a road) it draws
// the surface the town tier has laid (U.uPave, FINISH.path in buildTown): 1 packed earth with
// pebbles, 2 gravel with a timber edging, 3 flagstones, 4 cobbles, the last two with a kerb of
// dressed stone along each edge. 0 leaves the worn dirt the vertex colours give.
const PAVE_GLSL = `
  float paveHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  vec2 paveHash2(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
  // nearest and second-nearest distance to jittered cell points, and the nearest cell's hash
  vec3 paveCells(vec2 p, float jit) {
    vec2 i = floor(p), f = fract(p);
    float d1 = 8.0, d2 = 8.0, id = 0.0;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 r = g + 0.5 + (paveHash2(i + g) - 0.5) * jit - f;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; id = paveHash(i + g); } else if (d < d2) { d2 = d; }
    }
    return vec3(sqrt(d1), sqrt(d2), id);
  }`;
function patchMaterial(mat, U, { overlay = false, fade = false, roof = false, pave = false, sway = 0, swayBase = 0 } = {}) {
  if (sway) mat.defines = Object.assign(mat.defines || {}, { SWAY: sway.toFixed(4), SWAY_BASE: swayBase.toFixed(3) });
  if (overlay) mat.defines = Object.assign(mat.defines || {}, { WORLD_OVERLAY: '' });
  if (fade) mat.defines = Object.assign(mat.defines || {}, { OCCLUDER_FADE: '' });
  if (roof) mat.defines = Object.assign(mat.defines || {}, { ROOF_FADE: '' });
  if (pave) mat.defines = Object.assign(mat.defines || {}, { TOWN_PAVE: '' });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uSeen = U.uSeen;
    sh.uniforms.uOverlay = U.uOverlay;
    sh.uniforms.uMapSize = U.uMapSize;
    sh.uniforms.uFocus = U.uFocus;
    sh.uniforms.uRoofCut = U.uRoofCut;
    sh.uniforms.uPave = U.uPave;
    sh.uniforms.uTime = U.uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWorld3;
        #ifdef TOWN_PAVE
          attribute float aRoad;
          varying float vRoad;
        #endif
        #ifdef SWAY
          uniform float uTime;
        #endif`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef SWAY
          vec4 swayAt = vec4(0.0, 0.0, 0.0, 1.0);
          #ifdef USE_INSTANCING
            swayAt = instanceMatrix * swayAt;
          #endif
          swayAt = modelMatrix * swayAt;
          float swayPh = dot(swayAt.xz, vec2(0.37, 0.53));
          float swayK = SWAY * max(0.0, position.y + SWAY_BASE);
          transformed.x += sin(uTime * 1.6 + swayPh) * swayK;
          transformed.z += cos(uTime * 1.25 + swayPh * 1.3) * swayK * 0.6;
        #endif`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 w3 = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          w3 = instanceMatrix * w3;
        #endif
        vWorld3 = (modelMatrix * w3).xyz;
        #ifdef TOWN_PAVE
          vRoad = aRoad;
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWorld3;
        uniform sampler2D uSeen;
        uniform sampler2D uOverlay;
        uniform vec2 uMapSize;
        uniform vec4 uFocus;
        uniform float uRoofCut;
        #ifdef TOWN_PAVE
          uniform float uPave;
          varying float vRoad;
          ${PAVE_GLSL}
        #endif`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        #ifdef TOWN_PAVE
          if (uPave > 0.5) {
            vec2 pp = vWorld3.xz;
            vec3 base = vColor.rgb;                     // the road's colour, without the grass texture
            vec3 pv = base;
            float on = smoothstep(0.42, 0.66, vRoad);
            if (uPave < 1.5) {
              // packed earth: a scatter of pebbles on it
              vec3 c = paveCells(pp * 3.2, 0.9);
              float peb = (1.0 - smoothstep(0.14, 0.2, c.x)) * step(0.7, c.z);
              pv = mix(diffuseColor.rgb, base * (1.15 + 0.3 * c.z), peb);
            } else if (uPave < 2.5) {
              // gravel: grains about a tenth of a tile, and a timber edging along each side
              vec3 c = paveCells(pp * 8.0, 1.0);
              pv = base * (0.66 + 0.6 * c.z) * (0.7 + 0.3 * smoothstep(0.0, 0.25, c.y - c.x));
              float edge = smoothstep(0.34, 0.4, vRoad) * (1.0 - smoothstep(0.48, 0.54, vRoad));
              pv = mix(pv, vec3(0.34, 0.24, 0.15), edge);
              on = max(on, edge);
            } else {
              // flagstones (3, about 0.6 tiles across) or cobbles (4, about 0.3), grouted, the
              // cobbles domed; a kerb of long dressed stones along each edge
              float flags = step(uPave, 3.5);
              vec3 c = paveCells(pp * mix(3.4, 1.65, flags), mix(0.85, 0.55, flags));
              float grout = smoothstep(0.025, mix(0.13, 0.07, flags), c.y - c.x);
              float dome = mix(1.0 - 0.32 * smoothstep(0.08, 0.5, c.x), 1.0, flags);
              vec3 stone = base * (0.84 + 0.3 * c.z) * dome;
              pv = mix(base * 0.5, stone, grout);
              float kerb = smoothstep(0.34, 0.4, vRoad) * (1.0 - smoothstep(0.5, 0.56, vRoad));
              vec3 kc = paveCells(pp * 1.3, 0.4);
              pv = mix(pv, vec3(0.8, 0.77, 0.7) * (0.92 + 0.12 * kc.z) * smoothstep(0.0, 0.05, kc.y - kc.x), kerb);
              on = max(on, kerb);
            }
            diffuseColor.rgb = mix(diffuseColor.rgb, pv, on);
          }
        #endif`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        #if defined(OCCLUDER_FADE) || defined(ROOF_FADE)
          // 4x4 ordered dither: an even screen-door rather than speckle
          const float BAYER[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
          ivec2 q = ivec2(mod(gl_FragCoord.xy, 4.0));
          float bayer = (BAYER[q.y * 4 + q.x] + 0.5) / 16.0;
        #endif
        #ifdef OCCLUDER_FADE
          if (uFocus.w > 0.0) {
            vec3 toCam = normalize(cameraPosition - uFocus.xyz);
            vec3 rel = vWorld3 - uFocus.xyz;
            float along = dot(rel, toCam);
            float off = length(rel - toCam * along);
            float cut = (1.0 - smoothstep(0.6 * uFocus.w, uFocus.w, off)) * smoothstep(0.2, 0.8, along);
            if (bayer < cut * 0.92) discard;
          }
        #endif
        #ifdef ROOF_FADE
          if (bayer < uRoofCut) discard;
        #endif`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
        vec2 fuv = vWorld3.xz / uMapSize;
        float inside = step(0.0, fuv.x) * step(fuv.x, 1.0) * step(0.0, fuv.y) * step(fuv.y, 1.0);
        float seen = mix(1.0, texture2D(uSeen, fuv).r, inside);
        vec3 grey = vec3(dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114)));
        gl_FragColor.rgb = mix(mix(grey, gl_FragColor.rgb, 0.5) * vec3(0.55, 0.57, 0.66), gl_FragColor.rgb, seen);
        #ifdef WORLD_OVERLAY
          vec4 ov = texture2D(uOverlay, fuv) * inside;
          gl_FragColor.rgb = mix(gl_FragColor.rgb, ov.rgb, ov.a);
        #endif`);
  };
  return mat;
}

// A camera-facing quad whose every fragment is written at the depth of its anchor (the feet),
// lifted a little toward the camera so the ground it stands on never wins. See the header.
const BILLBOARD_VS = `
  uniform vec2 uSize;
  uniform float uFoot;
  uniform vec4 uUv;
  uniform float uLift;
  varying vec2 vUv;
  varying float vFogDepth;
  varying float vDepth;
  void main() {
    vec4 anchor = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vec4 mv = anchor;
    mv.xy += vec2(position.x * uSize.x, (position.y - uFoot) * uSize.y);
    vec4 lifted = anchor;
    lifted.z += uLift;
    vec4 cd = projectionMatrix * lifted;
    vDepth = clamp(cd.z / cd.w * 0.5 + 0.5, 0.0, 1.0);
    vUv = uv * uUv.zw + uUv.xy;
    vFogDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;
const BILLBOARD_FS = `
  uniform sampler2D map;
  uniform float uOpacity;
  uniform vec3 uTint;
  uniform vec3 fogColor;
  uniform float fogNear;
  uniform float fogFar;
  varying vec2 vUv;
  varying float vFogDepth;
  varying float vDepth;
  void main() {
    vec4 t = texture2D(map, vUv);
    if (t.a < 0.35) discard;
    vec3 col = t.rgb * uTint;
    col = mix(col, fogColor, smoothstep(fogNear, fogFar, vFogDepth));
    gl_FragColor = vec4(col, t.a * uOpacity);
    gl_FragDepth = vDepth;
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

// The quad: x in [-0.5, 0.5], y in [0, 1], so (0, 0) is the bottom middle.
let BB_GEO = null;
function billboardGeo() {
  if (!BB_GEO) { BB_GEO = new THREE.PlaneGeometry(1, 1); BB_GEO.translate(0, 0.5, 0); }
  return BB_GEO;
}

function billboard(tex, fogU, { w = 1, h = 1, foot = 0, lift = 0.35 } = {}) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: tex },
      uSize: { value: new THREE.Vector2(w, h) },
      uFoot: { value: foot },
      uUv: { value: new THREE.Vector4(0, 0, 1, 1) },
      uLift: { value: lift },
      uOpacity: { value: 1 },
      uTint: { value: new THREE.Color(1, 1, 1) },
      fogColor: fogU.fogColor, fogNear: fogU.fogNear, fogFar: fogU.fogFar,
    },
    vertexShader: BILLBOARD_VS,
    fragmentShader: BILLBOARD_FS,
    transparent: true,
  });
  const m = new THREE.Mesh(billboardGeo(), mat);
  m.frustumCulled = false;            // the quad's bounds are not where it is drawn
  return m;
}

// ---------- the renderer ----------

const ready = () => typeof window.THREE === 'object' && window.THREE !== null;

/**
 * A 3D view bound to one canvas. The canvas must not have had a 2D context taken from it.
 * render(s, { zoom, cx, cy }, dt) draws a frame and returns a view object that the camera
 * controls in sortie.js read the same way they read FieldView.layout's: `scale` is canvas
 * pixels per tile at the view centre, `scaleY` the same for vertical drags, and `tileAt(ev)`
 * turns a pointer event into a map tile.
 */
function create(cv, { fill = false } = {}) {
  // fixed: the canvas keeps the size its attributes give it (the sortie map). fill: it is sized
  // by CSS and the drawing buffer follows its box every frame (the town map).
  const baseW = cv.width, baseH = cv.height;
  if (!fill && !cv.style.width) cv.style.width = baseW + 'px';
  let sizeW = baseW, sizeH = baseH;
  const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(baseW, baseH, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;          // nothing that casts a shadow moves
  renderer.autoClear = false;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, baseW / baseH, 0.5, 600);
  function fitSize() {
    if (!fill) return;
    const w = Math.max(1, cv.clientWidth), h = Math.max(1, cv.clientHeight);
    if (w === sizeW && h === sizeH) return;
    sizeW = w; sizeH = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const U = {
    uSeen: { value: null },
    uOverlay: { value: null },
    uMapSize: { value: new THREE.Vector2(1, 1) },
    uFocus: { value: new THREE.Vector4(0, 0, 0, 0) },      // xyz = squad centre, w = fade radius (0 = off)
    uRoofCut: { value: 0 },                                  // town: fraction of roof fragments discarded
    uPave: { value: 0 },                                     // town: the road surface (FINISH.path)
    uTime: { value: 0 },                                     // seconds, for swaying leaves and grass
  };
  const fogU = { fogColor: { value: new THREE.Color() }, fogNear: { value: 10 }, fogFar: { value: 100 } };

  // vignette: one full-screen quad drawn over the scene
  const vigScene = new THREE.Scene(), vigCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const vigMat = new THREE.ShaderMaterial({
    uniforms: { uStrength: { value: 0.45 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `uniform float uStrength; varying vec2 vUv;
      void main() { vec2 d = (vUv - 0.5) * vec2(1.0, 1.2);
        gl_FragColor = vec4(0.04, 0.03, 0.07, smoothstep(0.32, 0.85, length(d)) * uStrength); }`,
    transparent: true, depthTest: false, depthWrite: false,
  });
  vigScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), vigMat));

  const shared = {
    shadowTex: radialTexture('rgba(0,0,0,.55)', 'rgba(0,0,0,0)'),
    glowTex: radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)'),
    ringGeo: new THREE.RingGeometry(0.26, 0.34, 28).rotateX(-Math.PI / 2),
    discGeo: new THREE.CircleGeometry(0.5, 20).rotateX(-Math.PI / 2),
  };

  let world = null;             // everything built for the current map
  const objs = new Map();       // actor id -> its scene objects
  const enemyTex = new Map();   // Image or icon -> { n, f } (normal and mirrored)
  const camState = { tx: null, tz: null, d: null };
  let lastSeenAt = -1, lastOverlayAt = -1, clockMs = 0;

  // ---------- building a map ----------

  function disposeWorld() {
    if (!world) return;
    scene.remove(world.root);
    world.root.traverse(o => {
      if (o.geometry && o.geometry !== BB_GEO && !Object.values(shared).includes(o.geometry)) o.geometry.dispose();
      const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of ms) m.dispose();
    });
    for (const t of world.textures) t.dispose();
    world = null;
    for (const o of objs.values()) disposeActor(o);
    objs.clear();
    if (fx) fx.clear();
    blows.length = 0;
  }

  /** `at` answers for the margin too: Mapgen's at() says wall out of bounds, the town says grass. */
  function build(map, fam, at = map.at) {
    disposeWorld();
    const st = STYLE[fam];
    const root = new THREE.Group();
    const textures = [];
    world = { map, fam, st, root, textures, w: map.w, h: map.h };

    // tile grids over the map plus the margin; out of bounds is wall (Mapgen's at() says so)
    const W = map.w + 2 * MARGIN, H = map.h + 2 * MARGIN;
    const wallG = new Float32Array(W * H), roadG = new Float32Array(W * H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const t = at(i - MARGIN, j - MARGIN);
      wallG[j * W + i] = t === T.WALL ? 1 : 0;
      roadG[j * W + i] = t === T.ROAD || t === T.GATE || t === T.DOOR ? 1 : 0;
    }
    // a field's roads are whole tiles; blurred twice (3 x 3), the band follows the road's line
    // instead of stepping round each tile's corners
    if (!map.layout) for (let pass = 0; pass < 2; pass++) {
      const src = roadG.slice();
      for (let j = 1; j < H - 1; j++) for (let i = 1; i < W - 1; i++) {
        let sum = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) sum += src[(j + dj) * W + i + di];
        roadG[j * W + i] = sum / 9;
      }
    }
    let seed = 0;
    const cells = map.tiles.cells;
    for (let i = 0; i < cells.length; i += 5) seed = (Math.imul(seed, 31) + cells[i]) | 0;
    const so = (seed >>> 0) % 997;

    // A value at world (px, pz) blended from tile centres: smoothstep on each axis.
    const field = (G, px, pz) => {
      const u = px + MARGIN - 0.5, v = pz + MARGIN - 0.5;
      const i = Math.max(0, Math.min(W - 2, Math.floor(u))), j = Math.max(0, Math.min(H - 2, Math.floor(v)));
      const fx = smooth(Math.max(0, Math.min(1, u - i))), fz = smooth(Math.max(0, Math.min(1, v - j)));
      const a = G[j * W + i], b = G[j * W + i + 1], c = G[(j + 1) * W + i], d = G[(j + 1) * W + i + 1];
      return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
    };

    // town roads: distance to the layout's polylines, so a road is a smooth band, not tiles
    const roadAt = map.layout ? layoutRoads(map.layout, map.ox, map.oz) : null;

    // heights
    const nx = W * SUB + 1, nz = H * SUB + 1;
    const heights = new Float32Array(nx * nz), wallness = new Float32Array(nx * nz), roadness = new Float32Array(nx * nz);
    const island = !!(map.layout && map.layout.island), isl = island ? new Float32Array(nx * nz) : null;
    for (let gz = 0; gz < nz; gz++) for (let gx = 0; gx < nx; gx++) {
      const px = gx / SUB - MARGIN, pz = gz / SUB - MARGIN, k = gz * nx + gx;
      const m = field(wallG, px, pz), rd = roadAt ? roadAt(px, pz) : field(roadG, px, pz);
      let h = (fbm(px * 0.22 + so, pz * 0.22) - 0.5) * st.roll * 2 * (1 - m);
      if (st.hill) h += Math.pow(m, 0.8) * st.hill * (0.7 + 0.6 * fbm(px * 0.3 + so, pz * 0.3 + 40)) + m * m * (fbm(px * 1.4, pz * 1.4 + so) - 0.3) * 0.5;
      h -= rd * 0.04;
      if (map.layout) h += BaseLayout.heightAt(map.layout, px - map.ox, pz - map.oz);
      if (island) {
        const e = BaseLayout.islandSdf(map.layout, px - map.ox, pz - map.oz);
        isl[k] = e;
        h -= 0.7 * (1 - sstep(0, 2.2, e));                  // the ground rounds down at the rim
      }
      heights[k] = h; wallness[k] = m; roadness[k] = rd;
    }
    const heightAt = (x, z) => {
      const gx = Math.max(0, Math.min(nx - 1.001, (x + MARGIN) * SUB)), gz = Math.max(0, Math.min(nz - 1.001, (z + MARGIN) * SUB));
      const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j;
      const a = heights[j * nx + i], b = heights[j * nx + i + 1], c = heights[(j + 1) * nx + i], d = heights[(j + 1) * nx + i + 1];
      return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
    };
    world.heightAt = heightAt;

    // terrain mesh
    const pos = new Float32Array(nx * nz * 3), uv = new Float32Array(nx * nz * 2);
    for (let gz = 0; gz < nz; gz++) for (let gx = 0; gx < nx; gx++) {
      const k = gz * nx + gx, px = gx / SUB - MARGIN, pz = gz / SUB - MARGIN;
      pos[k * 3] = px; pos[k * 3 + 1] = heights[k]; pos[k * 3 + 2] = pz;
      const tscale = fam === 'built' ? 0.5 : 0.28;
      uv[k * 2] = px * tscale; uv[k * 2 + 1] = pz * tscale;
    }
    const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
    let n = 0;
    // on an island, a triangle with any corner past the rim is left out: skyIsland's lip covers the cut
    const on = (i) => !island || isl[i] > -0.15;
    for (let gz = 0; gz < nz - 1; gz++) for (let gx = 0; gx < nx - 1; gx++) {
      const a = gz * nx + gx, b = a + 1, c = a + nx, d = c + 1;
      if (on(a) && on(c) && on(b)) { idx[n++] = a; idx[n++] = c; idx[n++] = b; }
      if (on(b) && on(c) && on(d)) { idx[n++] = b; idx[n++] = c; idx[n++] = d; }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx.subarray(0, n), 1));
    geo.computeVertexNormals();

    // vertex colour: ground by noise, dirt on roads, rock on slopes, darker tops, and a band of
    // darkening where the ground meets a wall so the floor sits INTO the rise
    const nrm = geo.getAttribute('normal');
    const col = new Float32Array(nx * nz * 3);
    const C = (hex) => new THREE.Color(hex);
    const gA = C(st.grass[0]), gB = C(st.grass[1]), dry = C(st.dry), moss = C(st.moss), dirt = C(st.dirt),
      road = C(st.road), rock = C(st.rock), top = C(st.top);
    const c = new THREE.Color(), tmp = new THREE.Color();
    // the town's roads take its tier's surface; worn dirt and packed earth fray into the grass
    const fin = map.layout ? finishOf(map.layout) : null;
    const pathA = fin ? C(fin.paths[0]) : dirt, pathB = fin ? C(fin.paths[1]) : road;
    const fray = fin ? [0.55, 0.2, 0, 0, 0][fin.path] : 0;
    for (let k = 0; k < nx * nz; k++) {
      const px = pos[k * 3], pz = pos[k * 3 + 2], m = wallness[k], rd = roadness[k];
      const slope = 1 - nrm.getY(k);
      c.lerpColors(gA, gB, fbm(px * 0.18 + so, pz * 0.18));
      const patch = sstep(0.58, 0.72, fbm(px * 0.11 + 90, pz * 0.11 + so));
      c.lerp(dry, patch * 0.55);
      c.lerp(moss, sstep(0.55, 0.75, vnoise(px * 0.5, pz * 0.5 + so)) * 0.35);
      if (fam === 'town' || fam === 'outdoor') c.multiplyScalar(0.91 + 0.18 * vnoise(px * 1.4 + so, pz * 1.4));   // clumps about a tile across
      tmp.lerpColors(pathA, pathB, fbm(px * 0.6, pz * 0.6));
      const ragged = fin ? 0 : (fbm(px * 1.1 + 31, pz * 1.1) - 0.5) * 0.3;    // a field road's edge wanders a little
      c.lerp(tmp, sstep(0.3, 0.75, rd - fray * (1 - fbm(px * 0.9 + 17, pz * 0.9)) + ragged));
      if (map.layout) c.lerp(rock, sstep(0.3, 0.65, slope));      // town: a platform's edge is rock
      if (st.hill) {
        c.lerp(top, sstep(0.55, 0.95, m) * 0.85);
        c.lerp(rock, sstep(0.16, 0.42, slope) * sstep(0.02, 0.15, m));
      }
      // the darkening where ground meets a wall; not on the town's roads and square, which are laid round them
      const ao = 1 - 0.32 * sstep(0.0, 0.3, m) * (1 - sstep(0.35, 0.8, m)) * (st.hill ? 1 : 1.4) * (fin ? 1 - sstep(0.3, 0.7, rd) : 1);
      col[k * 3] = c.r * ao; col[k * 3 + 1] = c.g * ao; col[k * 3 + 2] = c.b * ao;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (fin) geo.setAttribute('aRoad', new THREE.BufferAttribute(roadness, 1));
    U.uPave.value = fin ? fin.path : 0;
    const groundTex = paintTexture(fam === 'built' ? 'flag' : fam === 'outdoor' || fam === 'town' ? 'grass' : 'stone');
    textures.push(groundTex);
    const terrain = new THREE.Mesh(geo, patchMaterial(new THREE.MeshLambertMaterial({ vertexColors: true, map: groundTex }), U, { overlay: true, pave: !!fin }));
    terrain.receiveShadow = true;
    terrain.castShadow = !!st.hill;
    root.add(terrain);

    buildProps(map, st, fam, heightAt, root, so, at);

    // lights
    const hemi = new THREE.HemisphereLight(st.sky, st.groundLight, st.hemiI);
    root.add(hemi);
    const sun = new THREE.DirectionalLight(st.sun, st.sunI);
    const cx = map.w / 2, cz = map.h / 2, span = Math.max(map.w, map.h) / 2 + MARGIN;
    sun.position.set(cx - span * 0.55, span * 1.3, cz + span * 0.35);
    sun.target.position.set(cx, 0, cz);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -span * 1.15; sc.right = span * 1.15; sc.top = span * 1.15; sc.bottom = -span * 1.15;
    sc.near = 1; sc.far = span * 5;
    sun.shadow.bias = -0.0008;
    sun.shadow.normalBias = 0.03;
    sun.shadow.radius = 3;
    root.add(sun, sun.target);
    if (st.lantern) {
      world.lantern = new THREE.PointLight(st.lantern, 20, 14, 1.3);
      root.add(world.lantern);
    }
    scene.fog = new THREE.Fog(st.fog, 30, 120);
    if (st.skyTop) {                     // the town floats: a sky lighter at the top of the view than at the bottom
      const sc = canvas(2, 256), sg = sc.getContext('2d'), grd = sg.createLinearGradient(0, 0, 0, 256);
      grd.addColorStop(0, st.skyTop); grd.addColorStop(1, st.skyLow);
      sg.fillStyle = grd; sg.fillRect(0, 0, 2, 256);
      const skyTex = new THREE.CanvasTexture(sc);
      skyTex.colorSpace = THREE.SRGBColorSpace;
      textures.push(skyTex);
      scene.background = skyTex;
    } else scene.background = new THREE.Color(st.fog);
    fogU.fogColor.value.set(st.fog);
    vigMat.uniforms.uStrength.value = st.vignette;

    // fog of war: one byte per tile, linearly filtered so the edge of the known is soft
    const seenData = new Uint8Array(map.w * map.h).fill(255);
    const seenTex = new THREE.DataTexture(seenData, map.w, map.h, THREE.RedFormat, THREE.UnsignedByteType);
    seenTex.magFilter = seenTex.minFilter = THREE.LinearFilter;
    seenTex.needsUpdate = true;
    textures.push(seenTex);
    world.seenData = seenData; world.seenTex = seenTex;
    U.uSeen.value = seenTex;

    // the ground overlay: zone rings, labels and the portal, drawn by fieldview.js
    const oc = canvas(map.w * PX, map.h * PX);
    const overTex = new THREE.CanvasTexture(oc);
    overTex.flipY = false;
    overTex.colorSpace = THREE.NoColorSpace;      // mixed straight into the output, which is sRGB already
    overTex.anisotropy = 4;
    textures.push(overTex);
    world.overlay = { canvas: oc, ctx: oc.getContext('2d'), tex: overTex };
    U.uOverlay.value = overTex;
    U.uMapSize.value.set(map.w, map.h);

    // the portal column, shown while the way home is open or being forced
    const colGeo = new THREE.CylinderGeometry(1, 1, 5, 32, 1, true);
    colGeo.translate(0, 2.5, 0);
    const colTex = (() => {
      const cc = canvas(4, 64), g = cc.getContext('2d'), grd = g.createLinearGradient(0, 0, 0, 64);
      grd.addColorStop(0, 'rgba(255,255,255,0)'); grd.addColorStop(1, 'rgba(255,255,255,1)');
      g.fillStyle = grd; g.fillRect(0, 0, 4, 64);
      return new THREE.CanvasTexture(cc);
    })();
    textures.push(colTex);
    world.column = new THREE.Mesh(colGeo, new THREE.MeshBasicMaterial({
      color: '#7dffd0', map: colTex, transparent: true, opacity: 0.5, side: THREE.DoubleSide,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    world.column.visible = false;
    root.add(world.column);

    world.motes = buildMotes(st, textures);
    root.add(world.motes);

    scene.add(root);
    renderer.shadowMap.needsUpdate = true;
    camState.tx = camState.tz = camState.d = null;
    lastSeenAt = lastOverlayAt = -1;
  }

  // ---------- living scenery: trees and ground cover, shared by the field and the town ----------

  /** Vertex colours on a geometry: `dark` (0..1) at local y = lo, rising to white at y = hi. */
  function shadeByHeight(g, lo, hi, dark) {
    const p = g.getAttribute('position'), col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = dark + (1 - dark) * sstep(lo, hi, p.getY(i));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  }

  /** A shaggy cone, base on y = 0, radius 0.5 and 0.8 high, its edge pushed in and out by noise. */
  function lumpyCone() {
    const g = new THREE.ConeGeometry(0.5, 0.8, 10, 3).translate(0, 0.4, 0);
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      if (Math.hypot(x, z) < 1e-4) continue;
      const k = 1 + (vnoise(x * 7 + 2, z * 7 + y * 5) - 0.5) * 0.45;
      p.setXYZ(i, x * k, y < 0.01 ? -0.05 * vnoise(x * 9, z * 9) : y, z * k);
    }
    g.computeVertexNormals();
    return g;
  }

  /**
   * A tuft of seven grass blades from one root, 0.14-0.3 high, at uneven bearings (the golden
   * angle) and leaning out by a third to a half of their height, so a tuft seen from the camera's
   * height covers ground rather than showing as a stroke or a star; normals up (lit like the
   * ground under it), a little darker at the root. Each blade is
   * in twice, once each way round, and drawn front faces only: a double-sided material would turn
   * a back face's normal down and draw it dark.
   */
  function tuftGeo() {
    const pos = [], col = [], nrm = [];
    for (let b = 0; b < 7; b++) {
      const a = b * 2.39996, ca = Math.cos(a), sa = Math.sin(a), k = hash(b, 71);
      const w = 0.04 + k * 0.015, h = 0.14 + hash(b, 72) * 0.16, lean = h * (0.33 + hash(b, 73) * 0.17);
      // the blade's base runs across its lean, so it faces outward
      const a0 = [-sa * w, 0, ca * w], a1 = [sa * w, 0, -ca * w], tip = [ca * lean, h, sa * lean];
      pos.push(...a0, ...a1, ...tip, ...a1, ...a0, ...tip);
      for (let k = 0; k < 2; k++) col.push(0.78, 0.78, 0.78, 0.78, 0.78, 0.78, 1.05, 1.05, 1.05);
      for (let k = 0; k < 6; k++) nrm.push(0, 1, 0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    return g;
  }

  const LEAF = { broad: ['#3c7329', '#6a9c35'], pine: ['#2b5530', '#3f6d37'], birch: ['#7da63c', '#a4bb48'], turning: ['#b9862c', '#cf9f3a'] };
  const BARK = new THREE.Color('#6b4a2e'), BIRCH_BARK = new THREE.Color('#e2ddd0');

  /**
   * Trees of three kinds, one kind to a stand (a slow noise over the ground decides): broadleaf,
   * a forked trunk under a crown of five to seven lumps, one in twenty turning; pine, three
   * stacked cones on a short trunk; birch, a slim pale trunk with a few small lumps high up.
   * Crowns are darker underneath and sway a little. add() plants one with its foot at (x, y, z),
   * about s tiles tall to the crown; build() adds one instanced mesh per part, in `material(o)`.
   */
  function forest(so) {
    const parts = { trunk: [], branch: [], blob: [], cone: [] };
    const q = new THREE.Quaternion(), eu = new THREE.Euler();
    const M = (x, y, z, sx, sy, sz, ry = 0, rz = 0) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q.setFromEuler(eu.set(0, ry, rz)), new THREE.Vector3(sx, sy, sz));
    const leaf = (kind, k) => new THREE.Color(LEAF[kind][0]).lerp(new THREE.Color(LEAF[kind][1]), k);
    function add(x, y, z, s, seed) {
      const r = (k) => hash(seed * 31 + k * 7, seed * 17 + k * 13);
      const stand = vnoise(x * 0.07 + so * 0.13, z * 0.07), ry = r(1) * Math.PI * 2;
      if (stand > 0.6) {
        const h = 0.45 * s;
        parts.trunk.push({ m: M(x, y, z, s * 0.9, h, s * 0.9), c: BARK });
        for (let i = 0; i < 3; i++) {
          const w = s * (1.2 - i * 0.28), hh = s * (0.9 - i * 0.12);
          parts.cone.push({ m: M(x, y + h * 0.8 + i * s * 0.4, z, w, hh, w, ry + i * 0.9), c: leaf('pine', r(2 + i)) });
        }
      } else if (stand < 0.33 && r(2) < 0.65) {
        const h = 1.15 * s;
        parts.trunk.push({ m: M(x, y, z, s * 0.55, h, s * 0.55), c: BIRCH_BARK });
        for (let i = 0; i < 4; i++) {
          const a = ry + i * 1.9, rr = 0.17 * s;
          parts.blob.push({ m: M(x + Math.cos(a) * rr, y + h * (0.72 + 0.11 * i), z + Math.sin(a) * rr, 0.5 * s, 0.58 * s, 0.5 * s, a), c: leaf('birch', r(3 + i)) });
        }
      } else {
        const h = 0.7 * s, kind = r(4) < 0.05 ? 'turning' : 'broad', n = 5 + Math.floor(r(5) * 3);
        parts.trunk.push({ m: M(x, y, z, s, h, s), c: BARK });
        for (const side of [-1, 1]) parts.branch.push({ m: M(x, y + h * 0.62, z, s, 0.48 * s, s, ry, side * 0.7), c: BARK });
        for (let i = 0; i < n; i++) {
          const top = i === 0, a = ry + i / (n - 1) * Math.PI * 2;
          const rr = top ? 0 : 0.33 * s, yy = top ? h + 0.5 * s : h + (0.2 + r(10 + i) * 0.18) * s, bs = (top ? 0.95 : 0.72 + r(20 + i) * 0.2) * s;
          parts.blob.push({ m: M(x + Math.cos(a) * rr, y + yy, z + Math.sin(a) * rr, bs, bs * 0.86, bs, a), c: leaf(kind, r(30 + i)) });
        }
      }
    }
    function build(root, material) {
      const G = {
        trunk: new THREE.CylinderGeometry(0.05, 0.09, 1, 7).translate(0, 0.5, 0),
        branch: new THREE.CylinderGeometry(0.022, 0.042, 1, 5).translate(0, 0.5, 0),
        blob: shadeByHeight(lumpySphere(0.5, 1), -0.45, 0.35, 0.58),      // 240 vertices: there are a thousand of them
        cone: shadeByHeight(lumpyCone(), 0, 0.55, 0.55),
      };
      for (const [k, list] of Object.entries(parts)) {
        if (!list.length) continue;
        const crown = k === 'blob' || k === 'cone';
        const im = new THREE.InstancedMesh(G[k], material({ vertexColors: crown, sway: crown ? 0.035 : 0, swayBase: k === 'blob' ? 0.5 : 0 }), list.length);
        list.forEach((pt, i) => { im.setMatrixAt(i, pt.m); im.setColorAt(i, pt.c); });
        im.castShadow = im.receiveShadow = true;
        root.add(im);
      }
    }
    return { add, build };
  }

  /**
   * Ground cover over [x0, x1) x [z0, z1): grass tufts (when `grass` gives the two colours of the
   * ground), flowers in patches, and pebbles, most of them along road edges. Candidates sit on a
   * jittered grid COVER_STEP apart; `open(x, z)` says where cover grows and `edge(x, z)` (0..1)
   * how near a road's edge a spot is. Tufts are thicker where a slow noise is high, and sway.
   */
  const COVER_STEP = 0.7;
  const BLOOMS = ['#ffffff', '#f2d04a', '#e86a9a', '#9a6ae8', '#6fa0e8', '#f08a4a'].map(c => new THREE.Color(c));
  const TUFT_TIP = new THREE.Color('#a6c95a');                 // tufts are a little yellower than the ground
  function groundCover(root, heightAt, so, { x0, z0, x1, z1 }, open, edge, grass, material) {
    const tufts = [], blooms = [], pebbles = [];
    const gA = grass && new THREE.Color(grass[0]), gB = grass && new THREE.Color(grass[1]);
    const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    const M = (x, y, z, s, sy, ry) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q.setFromAxisAngle(up, ry), new THREE.Vector3(s, sy, s));
    for (let z = z0; z < z1; z += COVER_STEP) for (let x = x0; x < x1; x += COVER_STEP) {
      const i = Math.round(x / COVER_STEP), j = Math.round(z / COVER_STEP);
      const r1 = hash(i * 3 + so, j * 5), r2 = hash(i * 7, j * 11 + so), r3 = hash(i + 41, j - so);
      const px = x + (r2 - 0.5) * COVER_STEP, pz = z + (r3 - 0.5) * COVER_STEP;
      const rd = edge(px, pz);
      if (rd > 0.08 && rd < 0.5) {
        if (r1 < 0.25) pebbles.push({ m: M(px, heightAt(px, pz), pz, 0.05 + r2 * 0.07, 0.6, r3 * 6), c: r3 });
        continue;
      }
      if (!open(px, pz)) continue;
      const gy = heightAt(px, pz), thick = vnoise(px * 0.22 + so, pz * 0.22);
      if (grass && r1 < 0.2 + thick * 0.75) {
        const c = new THREE.Color().lerpColors(gA, gB, vnoise(px * 0.5, pz * 0.5 + so)).lerp(TUFT_TIP, 0.25 + r2 * 0.25).multiplyScalar(0.95 + r3 * 0.2);
        tufts.push({ m: M(px, gy, pz, 0.8 + r3 * 0.6, 0.8 + r1 * 0.7, r2 * 6.283), c });
      }
      if (vnoise(px * 0.13 + 40, pz * 0.13 + so) > 0.68 && r2 < 0.3) {
        const col = BLOOMS[Math.floor(hash(Math.round(px * 0.2), Math.round(pz * 0.2) + so) * BLOOMS.length)];
        for (let k = 0; k < 4; k++) {
          const bx = px + (hash(i + k, j) - 0.5) * 0.55, bz = pz + (hash(i, j + k) - 0.5) * 0.55;
          blooms.push({ m: M(bx, heightAt(bx, bz), bz, 1, 0.8 + hash(i * k, j) * 0.6, 0), c: col });
        }
      } else if (r3 < 0.025) pebbles.push({ m: M(px, gy, pz, 0.06 + r2 * 0.08, 0.6, r1 * 6), c: r2 });
    }
    const add = (geo, m, list, colour, shadow = false) => {
      if (!list.length) return;
      const im = new THREE.InstancedMesh(geo, m, list.length);
      list.forEach((e, k) => { im.setMatrixAt(k, e.m); im.setColorAt(k, colour(e)); });
      im.castShadow = shadow; im.receiveShadow = true;
      root.add(im);
    };
    add(tuftGeo(), material({ vertexColors: true, sway: 0.09, swayBase: 0 }), tufts, e => e.c);
    const stem = new THREE.CylinderGeometry(0.01, 0.01, 0.16, 3, 1, true).translate(0, 0.08, 0);
    const head = new THREE.OctahedronGeometry(0.065, 0).translate(0, 0.18, 0);
    const bloomGeo = mergeSimple([stem, head]);
    add(bloomGeo, material({ sway: 0.12, swayBase: 0 }), blooms, e => e.c);
    const pebbleA = new THREE.Color('#a39b8c'), pebbleB = new THREE.Color('#7d756a');
    add(new THREE.DodecahedronGeometry(0.5, 0).translate(0, 0.15, 0), material({ flat: true }), pebbles, e => new THREE.Color().lerpColors(pebbleA, pebbleB, e.c), true);
  }

  /** Position and normal of several geometries in one (no index, no uv); for small shared shapes. */
  function mergeSimple(geos) {
    const pos = [], nrm = [];
    for (const g0 of geos) {
      const g = g0.index ? g0.toNonIndexed() : g0;
      pos.push(...g.getAttribute('position').array);
      nrm.push(...g.getAttribute('normal').array);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    return g;
  }

  // ---------- scenery ----------

  function buildProps(map, st, fam, heightAt, root, so, at) {
    if (fam === 'town') return buildTown(map, heightAt, root, so);
    const W = map.w + 2 * MARGIN, H = map.h + 2 * MARGIN;
    const isWall = (x, y) => at(x, y) === T.WALL;
    const openNear = (x, y) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !isWall(x + dx, y + dy) && map.at(x + dx, y + dy) !== undefined && x + dx >= 0 && y + dy >= 0 && x + dx < map.w && y + dy < map.h);
    const lists = { rock: [], bush: [], block: [], cap: [], crate: [], barrel: [], crystal: [], post: [] };
    const M4 = (x, y, z, sx, sy, sz, ry = 0) =>
      new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry), new THREE.Vector3(sx, sy, sz));

    const trees = forest(so);
    const tree = (x, y, wx, wz, r2) => trees.add(wx, heightAt(wx, wz), wz, 0.75 + r2 * 0.65, (x * 92821) ^ (y * 68917));
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const x = i - MARGIN, y = j - MARGIN, t = at(x, y);
      const r1 = hash(x * 3 + so, y * 7), r2 = hash(x * 11, y * 5 + so), r3 = hash(x + 99, y - so);
      const wx = x + 0.5 + (r2 - 0.5) * 0.5, wz = y + 0.5 + (r3 - 0.5) * 0.5;
      const inside = x >= 0 && y >= 0 && x < map.w && y < map.h;
      if (t === T.WALL) {
        if (fam === 'outdoor') {
          if (r1 < 0.5) {
            tree(x, y, wx, wz, r2);
          } else if (r1 < 0.72 || openNear(x, y)) {
            if (r2 < 0.5) lists.rock.push({ m: M4(wx, heightAt(wx, wz) + 0.05, wz, 0.5 + r3 * 0.6, 0.35 + r1 * 0.4, 0.5 + r2 * 0.5, r3 * 6) });
          }
        } else if (fam === 'under') {
          if (openNear(x, y) && r1 < 0.09) {
            lists.crystal.push({ m: M4(wx, heightAt(wx, wz) - 0.05, wz, 0.22 + r2 * 0.18, 0.6 + r3 * 0.7, 0.22 + r2 * 0.18, r1 * 40), c: r2, at: [wx, heightAt(wx, wz), wz] });
          } else if (r1 < 0.18 && openNear(x, y)) {
            lists.rock.push({ m: M4(wx, heightAt(wx, wz), wz, 0.5 + r3 * 0.7, 0.4 + r1 * 1.2, 0.5 + r2 * 0.6, r3 * 6) });
          }
        } else {
          // masonry: blocks of slightly varied height, with a paler cap course on top
          const h = st.blocks * (0.92 + r1 * 0.22) + (x >= 0 && y >= 0 && x < map.w && y < map.h ? 0 : 0.4);
          lists.block.push({ m: M4(x + 0.5, h / 2 - 0.1, y + 0.5, 1, h + 0.2, 1), c: r2 });
          lists.cap.push({ m: M4(x + 0.5, h + 0.05, y + 0.5, 1.06, 0.14, 1.06), c: r3 });
        }
      } else if (t === T.COVER) {
        const gy = heightAt(wx, wz);
        if (fam === 'outdoor') {
          for (let b = 0; b < 3; b++) {
            const bx = wx + (hash(x + b, y) - 0.5) * 0.5, bz = wz + (hash(x, y + b) - 0.5) * 0.5, bs = 0.32 + hash(x * b, y) * 0.18;
            lists.bush.push({ m: M4(bx, gy + bs * 0.4, bz, bs, bs * 0.8, bs), c: hash(x, y + b * 3) });
          }
        } else if (fam === 'built') {
          if (r1 < 0.55) lists.crate.push({ m: M4(wx, gy + 0.22, wz, 0.45, 0.45, 0.45, r2 * 1.5) });
          else lists.barrel.push({ m: M4(wx, gy, wz, 1, 1, 1) });
        } else {
          lists.rock.push({ m: M4(wx, gy, wz, 0.35 + r2 * 0.3, 0.25 + r3 * 0.3, 0.35 + r1 * 0.3, r3 * 6) });
          if (r1 < 0.3) lists.crystal.push({ m: M4(wx + 0.2, gy, wz - 0.1, 0.12, 0.35, 0.12, r1 * 9), c: r2, at: null });
        }
      } else if (t === T.DOOR || t === T.GATE) {
        // two posts and a lintel across the tile, oriented along whichever axis the walls run
        const along = isWall(x - 1, y) || isWall(x + 1, y);
        const ph = t === T.GATE ? 1.9 : 1.35, gy = heightAt(x + 0.5, y + 0.5);
        for (const sgn of [-1, 1]) {
          const px = x + 0.5 + (along ? sgn * 0.42 : 0), pz = y + 0.5 + (along ? 0 : sgn * 0.42);
          lists.post.push({ m: M4(px, gy + ph / 2, pz, 0.16, ph, 0.16) });
        }
        lists.post.push({ m: M4(x + 0.5, gy + ph, y + 0.5, along ? 1.05 : 0.18, 0.16, along ? 0.18 : 1.05) });
      } else if (t === T.DOWN || t === T.UP) {
        const pit = new THREE.Mesh(new THREE.CircleGeometry(0.45, 24).rotateX(-Math.PI / 2),
          new THREE.MeshBasicMaterial({ color: t === T.DOWN ? '#0c0814' : '#d8d2ff', transparent: true, opacity: t === T.DOWN ? 0.85 : 0.35 }));
        pit.position.set(x + 0.5, heightAt(x + 0.5, y + 0.5) + 0.02, y + 0.5);
        root.add(pit);
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: shared.glowTex, color: '#9f8aff', blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.7 }));
        glow.position.set(x + 0.5, pit.position.y + 0.3, y + 0.5);
        glow.scale.set(1.4, 1.4, 1);
        root.add(glow);
      }
    }

    // geometries
    const canopyGeo = lumpySphere(0.48, 2);
    const rockGeo = new THREE.DodecahedronGeometry(0.5, 0).translate(0, 0.2, 0);
    const blockGeo = new THREE.BoxGeometry(1, 1, 1);
    const crateGeo = new THREE.BoxGeometry(1, 1, 1);
    const barrelGeo = new THREE.CylinderGeometry(0.17, 0.17, 0.5, 12).translate(0, 0.25, 0);
    const crystalGeo = new THREE.OctahedronGeometry(0.5, 0).translate(0, 0.45, 0);

    const lam = (o, fade = false) => patchMaterial(new THREE.MeshLambertMaterial(o), U, { fade });
    const inst = (geo, mat, list, colourOf = null, shadows = true) => {
      if (!list.length) return null;
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((e, i) => {
        im.setMatrixAt(i, e.m);
        if (colourOf) im.setColorAt(i, colourOf(e));
      });
      im.castShadow = shadows;
      im.receiveShadow = true;
      root.add(im);
      return im;
    };
    // trees fade out between the camera and the squad like the rest of the masonry (`fade`)
    const living = (fade) => (o) => patchMaterial(new THREE.MeshLambertMaterial({ color: '#ffffff', vertexColors: !!o.vertexColors, flatShading: !!o.flat,
      side: o.double ? THREE.DoubleSide : THREE.FrontSide }), U, { fade, sway: o.sway || 0, swayBase: o.swayBase || 0 });
    trees.build(root, living(true));
    // ground cover on open floor at least 0.4 tiles from a wall or cover; grass only outdoors
    const tile = (x, z) => at(Math.floor(x), Math.floor(z));
    const blocked = (t) => t === T.WALL || t === T.COVER;
    const open = (x, z) => x >= 0 && z >= 0 && x < map.w && z < map.h && tile(x, z) === T.FLOOR
      && ![[0.4, 0], [-0.4, 0], [0, 0.4], [0, -0.4]].some(([dx, dz]) => blocked(tile(x + dx, z + dz)));
    const edge = (x, z) => tile(x, z) === T.ROAD ? 1 : [[0.45, 0], [-0.45, 0], [0, 0.45], [0, -0.45]].some(([dx, dz]) => tile(x + dx, z + dz) === T.ROAD) ? 0.3 : 0;
    groundCover(root, heightAt, so, { x0: 0, z0: 0, x1: map.w, z1: map.h }, open, edge, fam === 'outdoor' ? st.grass : null, living(false));
    inst(rockGeo, lam({ color: fam === 'under' ? '#5b5266' : '#9a8b73', flatShading: true }), lists.rock);
    const bushA = new THREE.Color('#3d6e2a'), bushB = new THREE.Color('#5d8f34');
    inst(shadeByHeight(canopyGeo, -0.4, 0.3, 0.6), lam({ color: '#ffffff', vertexColors: true }), lists.bush, (e) => new THREE.Color().lerpColors(bushA, bushB, e.c));
    const stoneA = new THREE.Color(st.stone || '#b0a088'), stoneB = stoneA.clone().multiplyScalar(0.84);
    const blockTex = paintTexture('stone');
    world.textures.push(blockTex);
    inst(blockGeo, lam({ color: '#ffffff', map: blockTex, bumpMap: blockTex, bumpScale: 1.5 }, true), lists.block,
      (e) => new THREE.Color().lerpColors(stoneA, stoneB, e.c));
    inst(blockGeo, lam({ color: '#ffffff' }, true), lists.cap, (e) => new THREE.Color(e.col || st.cap || '#d8ccb0').multiplyScalar(0.9 + e.c * 0.1));
    inst(crateGeo, lam({ color: '#9a6e3e' }), lists.crate);
    inst(barrelGeo, lam({ color: '#7a5532' }), lists.barrel);
    inst(blockGeo, lam({ color: '#7a5a3a' }), lists.post);
    const cyan = new THREE.Color('#7fe6ff'), violet = new THREE.Color('#c08cff');
    inst(crystalGeo, lam({ color: '#ffffff', emissive: '#5a6aff', emissiveIntensity: 0.9, transparent: true, opacity: 0.92 }), lists.crystal,
      (e) => new THREE.Color().lerpColors(cyan, violet, e.c), false);
    for (const e of lists.crystal) {
      if (!e.at) continue;
      const g = new THREE.Sprite(new THREE.SpriteMaterial({ map: shared.glowTex, color: e.c < 0.5 ? '#6fd8ff' : '#b58aff', blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.55 }));
      g.position.set(e.at[0], e.at[1] + 0.6, e.at[2]);
      g.scale.set(2.2, 2.2, 1);
      root.add(g);
    }
  }

  // ---------- the town ----------
  // Built from map.layout (baselayout.js), not from tiles. A layout position plus (map.ox, map.oz) is
  // the tile space the walkers use. Each structure is a group in its own frame: origin at its
  // centre, local +z toward its door, rotation.y = the layout's rot (same convention as
  // BaseLayout.toWorld). Local width is the structure's w (x) and depth its h (z).
  //
  // Look per structure is drawn from a stream seeded by (layout seed, key), so a given building
  // keeps its colours across reloads and two saves differ.

  /**
   * Road-ness at a terrain point: 1 on a road, falling to 0 over 0.65 tiles past its edge. The
   * segments and discs are bucketed in ROAD_CELL-tile cells, so a lookup tests only the nearby ones.
   */
  const ROAD_CELL = 6;
  function layoutRoads(lay, OX, OZ) {
    const segs = [], discs = [];
    for (const r of lay.roads) {
      for (let i = 0; i + 1 < r.pts.length; i++) {
        segs.push([r.pts[i][0] + OX, r.pts[i][1] + OZ, r.pts[i + 1][0] + OX, r.pts[i + 1][1] + OZ, r.width / 2]);
      }
    }
    for (const st of lay.stairs || []) segs.push([st.a.x + OX, st.a.z + OZ, st.b.x + OX, st.b.z + OZ, st.w / 2]);
    discs.push([OX, OZ, lay.square.r], [lay.crystal.x + OX, lay.crystal.z + OZ, lay.crystal.r],
      ...(lay.plazas || []).map(pz => [pz.x + OX, pz.z + OZ, pz.r]));
    const cells = new Map(), reach = 1.2;                      // the fade past a road's edge, rounded up
    const key = (i, j) => i * 100003 + j;
    const file = (item, x0, z0, x1, z1) => {
      for (let i = Math.floor(x0 / ROAD_CELL); i <= Math.floor(x1 / ROAD_CELL); i++)
        for (let j = Math.floor(z0 / ROAD_CELL); j <= Math.floor(z1 / ROAD_CELL); j++) {
          const k = key(i, j);
          if (!cells.has(k)) cells.set(k, { segs: [], discs: [] });
          item(cells.get(k));
        }
    };
    for (const sg of segs) {
      const pad = sg[4] + reach;
      file(c => c.segs.push(sg), Math.min(sg[0], sg[2]) - pad, Math.min(sg[1], sg[3]) - pad, Math.max(sg[0], sg[2]) + pad, Math.max(sg[1], sg[3]) + pad);
    }
    for (const dc of discs) file(c => c.discs.push(dc), dc[0] - dc[2] - reach, dc[1] - dc[2] - reach, dc[0] + dc[2] + reach, dc[1] + dc[2] + reach);
    return (px, pz) => {
      const cell = cells.get(key(Math.floor(px / ROAD_CELL), Math.floor(pz / ROAD_CELL)));
      if (!cell) return 0;
      let best = Infinity;
      for (const [ax, az, bx, bz, half] of cell.segs) {
        const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
        const d = Math.hypot(px - ax - dx * t, pz - az - dz * t) - half;
        if (d < best) best = d;
      }
      for (const [cx, cz, r] of cell.discs) best = Math.min(best, Math.hypot(px - cx, pz - cz) - r);
      return 1 - sstep(-0.3, 0.35, best);
    };
  }

  const PLASTER = ['#efe3c8', '#e8d6b0', '#f2e8d5', '#dcc9a5', '#e6d9c0'];
  const TIMBER = '#6b4a2e', STONE = '#b9ad97';

  function buildTown(map, heightAt, root, so) {
    const lay = map.layout, OX = map.ox, OZ = map.oz;
    const fin = finishOf(lay), look = ROOF_LOOK[fin.roof];
    const mats = new Map();
    /** One material per look. Roof materials fade with uRoofCut. */
    const mat = (color, { roof = false, emissive = null, ei = 0.8, double = false, flat = false, map = null, bump = 0 } = {}) => {
      const key = [color, roof, emissive, ei, double, flat, map ? map.uuid : '', bump].join('|');
      if (!mats.has(key)) {
        const m = new THREE.MeshLambertMaterial({ color, flatShading: flat, side: double ? THREE.DoubleSide : THREE.FrontSide, map });
        if (bump && map) { m.bumpMap = map; m.bumpScale = bump; }
        if (emissive) { m.emissive.set(emissive); m.emissiveIntensity = ei; }
        mats.set(key, patchMaterial(m, U, { roof }));
      }
      return mats.get(key);
    };
    const roofTex = roofTexture(fin.roof);
    world.textures.push(roofTex);
    /** A roof slope in `colour`, covered as this tier covers its roofs. */
    const roofMat = (colour) => mat(colour, { roof: true, double: true, map: roofTex, bump: 1.5 });
    let houseNo = 0;                       // picks each house's shutter colour, in layout order
    /**
     * Merge a static group's meshes that share a material into one mesh per material: the whole
     * town (`town`, below) is merged once it is built, so it is a few dozen draw calls rather than
     * thousands. Anything marked userData.live (it animates), and everything under it, stays as it
     * is; so do sprites and instanced meshes. Only position, normal and uv are kept.
     */
    function bake(g) {
      g.updateMatrixWorld(true);
      const inv = new THREE.Matrix4().copy(g.matrixWorld).invert(), byMat = new Map(), done = [];
      g.traverse(o => {
        if (!o.isMesh || o.isInstancedMesh) return;
        for (let p = o; p && p !== g; p = p.parent) if (p.userData.live) return;
        const geo = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
        geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
        if (!byMat.has(o.material)) byMat.set(o.material, []);
        byMat.get(o.material).push(geo);
        done.push(o);
      });
      for (const o of done) { o.parent.remove(o); o.geometry.dispose(); }
      for (const [m, geos] of byMat) {
        let n = 0;
        for (const ge of geos) n += ge.attributes.position.count;
        const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), uv = m.map ? new Float32Array(n * 2) : null;
        let at = 0;
        for (const ge of geos) {
          const c = ge.attributes.position.count;
          pos.set(ge.attributes.position.array, at * 3);
          if (ge.attributes.normal) nrm.set(ge.attributes.normal.array, at * 3);
          if (uv && ge.attributes.uv) uv.set(ge.attributes.uv.array, at * 2);
          at += c;
          ge.dispose();
        }
        const merged = new THREE.BufferGeometry();
        merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        merged.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
        if (uv) merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        const out = new THREE.Mesh(merged, m);
        out.castShadow = out.receiveShadow = true;
        g.add(out);
      }
      return g;
    }
    const mesh = (geo, m, x = 0, y = 0, z = 0, ry = 0) => {
      const o = new THREE.Mesh(geo, m);
      o.position.set(x, y, z);
      o.rotation.y = ry;
      o.castShadow = o.receiveShadow = true;
      return o;
    };
    /** A box standing on y = 0. */
    const box = (w, h, d) => new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0);
    const pick = (rnd, list) => list[Math.floor(rnd() * list.length) % list.length];
    world.sites = []; world.smoke = []; world.flames = []; world.signs = [];
    const town = new THREE.Group();        // everything static, merged by bake() at the end
    root.add(town);

    // ----- pieces -----

    /**
     * Gable roof with the ridge along local x. Slopes (roof material, uv in tiles: u along the
     * ridge, v down the slope) and gable ends (wall material). The covering adds its own: a
     * thatch roll along the ridge and thick eaves, a ridge board over shingles, a row of ridge
     * tiles over tile and slate; at City a finial at each end of the ridge.
     */
    function gable(len, span, h, oh, roofM, wallM) {
      const g = new THREE.Group();
      oh += look.oh;
      const L = len / 2 + oh, S = span / 2 + oh, y0 = h * oh / S, X = len / 2, s2 = span / 2, sl = Math.hypot(S, h);
      const slopes = new THREE.BufferGeometry();
      slopes.setAttribute('position', new THREE.Float32BufferAttribute([
        -L, 0, S, L, 0, S, L, h, 0, -L, 0, S, L, h, 0, -L, h, 0,
        L, 0, -S, -L, 0, -S, -L, h, 0, L, 0, -S, -L, h, 0, L, h, 0,
      ], 3));
      slopes.setAttribute('uv', new THREE.Float32BufferAttribute([
        -L, sl, L, sl, L, 0, -L, sl, L, 0, -L, 0,
        L, sl, -L, sl, -L, 0, L, sl, -L, 0, L, 0,
      ], 2));
      slopes.computeVertexNormals();
      const ends = new THREE.BufferGeometry();
      ends.setAttribute('position', new THREE.Float32BufferAttribute([
        X, y0, s2, X, y0, -s2, X, h, 0,
        -X, y0, -s2, -X, y0, s2, -X, h, 0,
      ], 3));
      ends.computeVertexNormals();
      g.add(mesh(slopes, roofM), mesh(ends, wallM));
      if (roofM.map) {                     // a covered roof (not a tent or a lean-to): its ridge
        const rc = new THREE.Color(roofM.color).multiplyScalar(0.78), ridgeM = mat('#' + rc.getHexString(), { roof: true });
        if (look.ridge === 'roll') g.add(mesh(new THREE.CylinderGeometry(0.15, 0.15, 2 * L, 8).rotateZ(Math.PI / 2), ridgeM, 0, h - 0.05, 0));
        else if (look.ridge === 'board') g.add(mesh(new THREE.BoxGeometry(2 * L, 0.07, 0.22), ridgeM, 0, h + 0.01, 0));
        else g.add(mesh(new THREE.CylinderGeometry(0.1, 0.1, 2 * L + 0.04, 8, 1, false, 0, Math.PI).rotateZ(Math.PI / 2), ridgeM, 0, h - 0.02, 0));
        if (look.ridge === 'roll') for (const sz of [-1, 1]) g.add(mesh(new THREE.BoxGeometry(2 * L, 0.16, 0.14), ridgeM, 0, -0.06, sz * (S - 0.05)));
        if (fin.quoins) for (const sx of [-1, 1]) g.add(mesh(new THREE.ConeGeometry(0.07, 0.36, 6).translate(0, 0.18, 0), mat('#3a3530', { roof: true }), sx * (L - 0.05), h + 0.06, 0));
      }
      g.userData.base = y0;                // height of the slope above the eave line at the wall face
      return g;
    }
    /** Gable over a w x d footprint, ridge along the longer side, eaves at wall height H. */
    function roofOver(w, d, H, h, oh, roofM, wallM) {
      const along = w >= d;
      const g = gable(along ? w : d, along ? d : w, h, oh, roofM, wallM);
      g.position.y = H - g.userData.base;
      if (!along) g.rotation.y = Math.PI / 2;
      return g;
    }
    /** Four-sided pyramid roof over a w x d footprint. */
    function pyramid(w, d, h, roofM) {
      const geo = new THREE.ConeGeometry(Math.SQRT1_2, h, 4).rotateY(Math.PI / 4).translate(0, h / 2, 0);
      geo.scale(w, 1, d);
      geo.computeVertexNormals();
      return mesh(geo, roofM);
    }
    /** A window as this tier makes them (FINISH.window); `shutter` colours painted shutters. */
    function addWindow(g, x, y, z, ry, glow = false, { shutter = SHUTTERS[0], box: flowerBox = false } = {}) {
      const w = new THREE.Group(), L = fin.window, frameC = L >= 2 ? '#efe6d2' : '#5a3d24';
      w.add(mesh(new THREE.BoxGeometry(0.54, 0.62, 0.04), mat(frameC)));
      const pane = L === 0 && !glow ? mat('#1d1712') : mat('#2b3240', { emissive: '#ffc06a', ei: glow ? 0.95 : 0.18 });
      w.add(mesh(new THREE.PlaneGeometry(0.42, 0.5), pane, 0, 0, 0.025));
      if (L >= 2) {                         // a mullion cross
        w.add(mesh(new THREE.BoxGeometry(0.035, 0.5, 0.02), mat(frameC), 0, 0, 0.035));
        w.add(mesh(new THREE.BoxGeometry(0.42, 0.035, 0.02), mat(frameC), 0, 0.04, 0.035));
      }
      if (L >= 1) {                         // shutters, folded back against the wall
        const sm = mat(L === 1 ? '#7a5a3a' : shutter);
        for (const sx of [-1, 1]) w.add(mesh(new THREE.BoxGeometry(0.24, 0.6, 0.03), sm, sx * 0.41, 0, 0.0));
      }
      if (L >= 3 && flowerBox) {            // a flower box under it
        w.add(mesh(new THREE.BoxGeometry(0.62, 0.13, 0.15), mat('#6b4a2e'), 0, -0.38, 0.09));
        const bloom = ['#e86a9a', '#f2d04a', '#ffffff', '#e8584a'][Math.floor(hash(houseNo, Math.round(x * 10 + y * 7)) * 4)];
        for (const bx of [-0.2, 0, 0.2]) w.add(mesh(new THREE.SphereGeometry(0.075, 6, 4), mat(bloom), bx, -0.27, 0.1));
        w.add(mesh(new THREE.BoxGeometry(0.58, 0.06, 0.12), mat('#4f8f3a'), 0, -0.3, 0.09));
      }
      if (L >= 4) for (const sy of [-1, 1]) w.add(mesh(new THREE.BoxGeometry(0.7, 0.07, 0.1), mat('#ddd3c0'), 0, sy * 0.35, 0.03));
      w.position.set(x, y, z);
      w.rotation.y = ry;
      g.add(w);
    }
    /**
     * Walls with a door gap on +z, a plank floor, timber corners, windows, and (unless `bare`)
     * a gable roof and chimneys. Returns { group, top, chimneys: [Vector3 local] }.
     */
    /**
     * Walls with a door gap on +z, a plank floor, windows, and (unless `bare`) a gable roof and
     * chimneys, finished as this tier finishes a house (FINISH): a stone plinth, timber from corner
     * posts up to half-timbering on plastered walls, quoins at City, a door frame, canopy, step
     * and lantern (no canopy or lantern where the caller builds a porch, `o.porch`). `o.roof` is the
     * roof's colour. Returns { group, top, chimneys: [Vector3 local] }.
     */
    function house(w, d, o) {
      const g = new THREE.Group(), t = 0.18, H = o.wallH, storeys = o.storeys || 1, sh = H / storeys;
      const wallM = mat(o.plaster), timM = mat(o.timber || TIMBER);
      const plastered = new THREE.Color(o.plaster).getHSL({}).l > 0.55;
      const shutter = SHUTTERS[Math.floor(hash(++houseNo, 41) * SHUTTERS.length)];
      g.add(mesh(new THREE.PlaneGeometry(w - 0.3, d - 0.3).rotateX(-Math.PI / 2), mat(o.floor || '#9c7a55'), 0, 0.04, 0));
      const side = Math.max(0.1, (w - 1.1) / 2);
      // the walls, and the plinth under them, both open at the door
      const walls = (m, y, hgt, out) => {
        g.add(mesh(box(w + out, hgt, t + out), m, 0, y, -d / 2 + t / 2));
        g.add(mesh(box(t + out, hgt, d + out), m, -w / 2 + t / 2, y, 0));
        g.add(mesh(box(t + out, hgt, d + out), m, w / 2 - t / 2, y, 0));
        g.add(mesh(box(side + out / 2, hgt, t + out), m, -(w / 2 - side / 2) - out / 4, y, d / 2 - t / 2));
        g.add(mesh(box(side + out / 2, hgt, t + out), m, w / 2 - side / 2 + out / 4, y, d / 2 - t / 2));
      };
      walls(wallM, 0, H, 0);
      if (fin.plinth) walls(mat('#a39882'), 0, fin.plinth, 0.1);
      if (H > 1.3) g.add(mesh(box(1.1, H - 1.25, t), wallM, 0, 1.25, d / 2 - t / 2));
      g.add(mesh(new THREE.BoxGeometry(1.24, 0.1, t + 0.08), timM, 0, 1.25, d / 2 - t / 2));
      // a timber on a face, from (ua, ya) to (ub, yb) in that face's (along, up) coordinates
      const faces = [
        { id: 'front', len: w, at: (u, y) => [u, y, d / 2 + 0.03], ry: 0 },
        { id: 'back', len: w, at: (u, y) => [-u, y, -d / 2 - 0.03], ry: Math.PI },
        { id: 'side', len: d, at: (u, y) => [w / 2 + 0.03, y, -u], ry: Math.PI / 2 },
        { id: 'side', len: d, at: (u, y) => [-w / 2 - 0.03, y, u], ry: -Math.PI / 2 },
      ];
      const beam = (f, ua, ya, ub, yb, thick = 0.07) => {
        const b = mesh(new THREE.BoxGeometry(Math.hypot(ub - ua, yb - ya) + thick, thick, 0.05), timM);
        b.position.set(...f.at((ua + ub) / 2, (ya + yb) / 2));
        b.rotation.set(0, f.ry, Math.atan2(yb - ya, ub - ua), 'YXZ');
        g.add(b);
      };
      // where the windows go, per face and storey (in that face's along coordinate)
      const nWin = Math.max(1, Math.floor(w / 2.3));
      const xs = Array.from({ length: nWin }, (_, i) => (i - (nWin - 1) / 2) * (w / nWin));
      const winAt = (f, k) => f.id === 'front' ? xs.filter(wx => k > 0 || Math.abs(wx) > 1.0)
        : f.id === 'back' ? xs.map(wx => -wx) : d >= 2.6 ? [0] : [];
      const winHalf = fin.window >= 1 ? 0.56 : 0.34;           // a window and its shutters, either side of its middle
      // corners: dressed stone quoins on a plastered house at City, timber posts otherwise
      if (fin.quoins && plastered) {
        const qm = mat('#ddd3c0');
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (let y = fin.plinth, i = 0; y < H - 0.1; y += 0.3, i++) {
          const long = i % 2 ? [0.4, 0.24] : [0.24, 0.4];
          g.add(mesh(box(long[0], 0.24, long[1]), qm, sx * (w / 2 - long[0] / 2 + 0.03), y, sz * (d / 2 - long[1] / 2 + 0.03)));
        }
      } else {
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(mesh(box(0.16, H + 0.04, 0.16), timM, sx * (w / 2 - 0.06), 0, sz * (d / 2 - 0.06)));
      }
      if (fin.timber >= 1) for (let k = 1; k <= storeys; k++) for (const f of faces) beam(f, -f.len / 2, sh * k - 0.05, f.len / 2, sh * k - 0.05, 0.1);
      // half-timbering on plaster: studs between the windows and a brace in each clear end bay
      if (fin.timber >= 2 && plastered) for (const f of faces) for (let k = 0; k < storeys; k++) {
        const y0 = sh * k + (k ? 0 : fin.plinth), y1 = sh * (k + 1) - 0.1, wins = winAt(f, k);
        const m = Math.max(2, Math.round(f.len / 1.1)), bay = f.len / m;
        const clear = (u0, u1) => wins.every(wx => wx + winHalf < Math.min(u0, u1) || wx - winHalf > Math.max(u0, u1))
          && !(f.id === 'front' && k === 0 && Math.min(u0, u1) < 0.7 && Math.max(u0, u1) > -0.7);
        for (let j = 1; j < m; j++) { const u = -f.len / 2 + bay * j; if (clear(u - 0.05, u + 0.05)) beam(f, u, y0, u, y1); }
        for (const e of [-1, 1]) {
          const ua = e * (f.len / 2 - 0.1), ub = e * (f.len / 2 - bay);
          if (clear(ua, ub)) beam(f, ua, y0, ub, y0 + (y1 - y0) * 0.75);
        }
      }
      for (let k = 0; k < storeys; k++) {
        const y = H * (k + 0.55) / storeys;
        for (const wx of winAt(faces[1], k)) addWindow(g, -wx, y, -d / 2 - 0.02, Math.PI, o.glow, { shutter });
        for (const wx of winAt(faces[0], k)) addWindow(g, wx, y, d / 2 + 0.02, 0, o.glow, { shutter, box: true });
        if (d >= 2.6) for (const sx of [-1, 1]) addWindow(g, sx * (w / 2 + 0.02), y, 0, sx * Math.PI / 2, o.glow, { shutter, box: true });
      }
      // the door: a frame, then a canopy over it, then a step and a lantern beside it
      const dz = d / 2;
      if (fin.door >= 1) for (const sx of [-1, 1]) g.add(mesh(box(0.1, 1.25, t + 0.08), timM, sx * 0.6, 0, dz - t / 2));
      if (fin.door >= 2 && !o.bare && !o.porch) {
        const c = mesh(new THREE.BoxGeometry(1.5, 0.06, 0.66), roofMat(o.roof), 0, 1.52, dz + 0.3);
        c.rotation.x = 0.32;
        g.add(c);
        for (const sx of [-1, 1]) beam(faces[0], sx * 0.62, 1.12, sx * 0.62, 1.4, 0.06);
      }
      if (fin.door >= 3) g.add(mesh(box(1.3, 0.12, 0.44), mat('#b9ad97'), 0, 0, dz + 0.22));
      if (fin.door >= 3 && !o.porch && !o.glow) {          // a tavern hangs its own lanterns (tavern())
        g.add(mesh(new THREE.BoxGeometry(0.06, 0.06, 0.22), mat('#3a3530'), 0.85, 1.3, dz + 0.11));
        g.add(mesh(new THREE.BoxGeometry(0.15, 0.2, 0.15), mat('#ffd38a', { emissive: '#ffb04a', ei: 1.1 }), 0.85, 1.15, dz + 0.2));
      }
      const chimneys = [];
      if (!o.bare) {
        g.add(roofOver(w, d, H, o.roofH, o.oh == null ? 0.3 : o.oh, roofMat(o.roof), mat(o.plaster, { roof: true })));
        const tiled = fin.roof === 'tile' || fin.roof === 'slate';
        for (let i = 0; i < (o.chimneys || 0); i++) {
          const cx = (i ? -1 : 1) * w * 0.27, cz = -d * 0.18, ch = H + o.roofH * 0.85 + 0.35;
          g.add(mesh(box(0.38, ch, 0.38), mat(STONE, { roof: true }), cx, 0, cz));
          let top = ch;
          if (tiled) { g.add(mesh(box(0.5, 0.08, 0.5), mat('#cfc4ad', { roof: true }), cx, ch, cz)); top += 0.08; }
          if (fin.quoins) { for (const px of [-0.09, 0.09]) g.add(mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.2, 8).translate(0, 0.1, 0), mat('#b5532f', { roof: true }), cx + px, top, cz)); top += 0.2; }
          chimneys.push(new THREE.Vector3(cx, top + 0.1, cz));
        }
      }
      return { group: g, top: H + (o.bare ? 0 : o.roofH), chimneys };
    }
    /**
     * A low surround along the footprint edge with a gap at the door: fence, hedge or stone. A fence
     * is this tier's (FINISH.fence): leaning stakes, posts and rails, white pickets, or iron railing
     * between stone pillars. A stone wall is rough until Town, then capped; a hedge has clipped
     * balls at its corners at City.
     */
    function surround(w, d, kind, rnd) {
      const g = new THREE.Group();
      const style = kind === 'fence' ? fin.fence : kind;
      const h = kind === 'stone' ? 0.55 : style === 'railing' ? 0.85 : 0.75;
      const m = mat(kind === 'stone' ? STONE : kind === 'hedge' ? '#4f7f33' : style === 'pickets' ? '#efe9dc' : style === 'railing' ? '#2f2f36' : '#8a6542');
      const edges = [
        [-w / 2, -d / 2, w / 2, -d / 2], [-w / 2, d / 2, -0.6, d / 2], [0.6, d / 2, w / 2, d / 2],
        [-w / 2, -d / 2, -w / 2, d / 2], [w / 2, -d / 2, w / 2, d / 2],
      ];
      // posts every `step` tiles along an edge, ends included
      const along = (ax, az, bx, bz, step, fn) => {
        const len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(len / step));
        for (let k = 0; k <= n; k++) fn(ax + (bx - ax) * k / n, az + (bz - az) * k / n, k, n);
      };
      for (const [ax, az, bx, bz] of edges) {
        const len = Math.hypot(bx - ax, bz - az), mx = (ax + bx) / 2, mz = (az + bz) / 2, ry = Math.atan2(bz - az, bx - ax);
        const rail = (y, hgt = 0.06, dep = 0.05, rm = m) => g.add(mesh(new THREE.BoxGeometry(len, hgt, dep), rm, mx, y, mz, -ry));
        if (style === 'stakes') {
          along(ax, az, bx, bz, 0.45, (x, z) => {
            const s = mesh(box(0.08, 0.6 + rnd() * 0.25, 0.08), m, x, 0, z);
            s.rotation.set((rnd() - 0.5) * 0.18, 0, (rnd() - 0.5) * 0.18);
            g.add(s);
          });
          rail(0.42);
        } else if (style === 'rails') {
          along(ax, az, bx, bz, 1, (x, z) => g.add(mesh(box(0.1, h, 0.1), m, x, 0, z)));
          rail(0.3); rail(0.6);
        } else if (style === 'pickets') {
          along(ax, az, bx, bz, 0.26, (x, z) => {
            g.add(mesh(box(0.07, 0.68, 0.05), m, x, 0, z));
            g.add(mesh(new THREE.ConeGeometry(0.05, 0.1, 4).translate(0, 0.73, 0), m, x, 0, z));
          });
          rail(0.22, 0.06, 0.04); rail(0.55, 0.06, 0.04);
        } else if (style === 'railing') {
          const pillar = mat('#cfc4ad');
          along(ax, az, bx, bz, 0.2, (x, z, k, n) => { if (k > 0 && k < n) g.add(mesh(box(0.03, h - 0.05, 0.03), m, x, 0, z)); });
          along(ax, az, bx, bz, 2.2, (x, z) => {
            g.add(mesh(box(0.26, h + 0.12, 0.26), pillar, x, 0, z));
            g.add(mesh(box(0.32, 0.07, 0.32), pillar, x, h + 0.12, z));
          });
          rail(0.08, 0.05, 0.05); rail(h - 0.05, 0.05, 0.05);
        } else {
          g.add(mesh(new THREE.BoxGeometry(len + 0.2, h, kind === 'hedge' ? 0.45 : 0.3).translate(0, h / 2, 0), m, mx, 0, mz, -ry));
          if (kind === 'stone' && (fin.terrace === 'coping' || fin.terrace === 'balustrade')) rail(h + 0.04, 0.08, 0.42, mat('#d6ccb8'));
        }
      }
      if (kind === 'hedge' && fin.quoins) for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        g.add(mesh(new THREE.SphereGeometry(0.32, 12, 8), m, sx * w / 2, h + 0.22, sz * d / 2));
      }
      return g;
    }
    /** A flame: emissive cone and a glow sprite, flickered by animateTown. */
    function flame(g, x, y, z, colour = '#ffb347', size = 1) {
      const f = mesh(new THREE.ConeGeometry(0.16 * size, 0.42 * size, 8).translate(0, 0.21 * size, 0), mat(colour, { emissive: colour, ei: 1.6 }), x, y, z);
      f.castShadow = false;
      f.userData.live = true;
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: shared.glowTex, color: colour, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.55 }));
      glow.position.set(x, y + 0.25 * size, z);
      glow.scale.setScalar(1.6 * size);
      g.add(f, glow);
      world.flames.push({ f, glow, seed: Math.random() * 10, size });
    }

    /**
     * A tavern's furnishing on top of its house: tables with benches inside (seen once the roofs
     * fade), barrels at the back, lanterns by the door, a hanging sign in its floor's colour, and
     * `columns` columns on a porch for the grander ones.
     */
    function tavern(h, w, d, colour, bare, columns) {
      if (bare) return h;
      const g = h.group, wood = mat('#7a5233');
      for (const sx of [-1, 1]) {
        const tx = sx * w / 4;
        g.add(mesh(new THREE.BoxGeometry(1.0, 0.07, 0.62), wood, tx, 0.56, -0.1));
        for (const lx of [-0.42, 0.42]) for (const lz of [-0.24, 0.24]) g.add(mesh(box(0.07, 0.53, 0.07), wood, tx + lx, 0, -0.1 + lz));
        for (const bz of [-0.55, 0.35]) g.add(mesh(new THREE.BoxGeometry(1.0, 0.06, 0.24), wood, tx, 0.33, -0.1 + bz));
        g.add(mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.55, 12).translate(0, 0.27, 0), mat('#6b4a2e'), sx * (w / 2 - 0.55), 0, -d / 2 + 0.55));
        g.add(mesh(new THREE.BoxGeometry(0.2, 0.26, 0.2), mat('#ffd38a', { emissive: '#ffb04a', ei: 1.3 }), sx * 0.85, 1.55, d / 2 + 0.12));
      }
      g.add(mesh(box(0.08, 2.1, 0.08), mat(TIMBER), w / 2 + 0.35, 0, d / 2 + 0.1));
      g.add(mesh(new THREE.BoxGeometry(0.6, 0.06, 0.06), mat(TIMBER), w / 2 + 0.1, 2.0, d / 2 + 0.1));
      g.add(mesh(new THREE.BoxGeometry(0.5, 0.4, 0.05), mat(colour, { emissive: colour, ei: 0.25 }), w / 2 - 0.05, 1.7, d / 2 + 0.1));
      for (let i = 0; i < columns; i++) {
        const cx = (i / Math.max(1, columns - 1) - 0.5) * Math.min(w - 1, 3.2);
        g.add(mesh(new THREE.CylinderGeometry(0.11, 0.13, 1.6, 10).translate(0, 0.8, 0), mat('#efe6d2'), cx, 0, d / 2 + 0.85));
      }
      if (columns) g.add(mesh(new THREE.BoxGeometry(Math.min(w - 0.6, 3.8), 0.14, 1.3), mat(colour === '#e0b84a' ? '#3f4a6b' : '#4d6c9a', { roof: true }), 0, 1.66, d / 2 + 0.6));
      return h;
    }

    // ----- lodgings -----
    function lodging(s, rnd) {
      const w = s.w, d = s.h, bare = !!s.site;
      // an ordinary roof is in this tier's covering (FINISH.roof); the barracks, manor, salon and
      // crown hall keep their own colours once roofs are tile or slate, which come in colours
      const plaster = pick(rnd, PLASTER), roof = pick(rnd, look.colours);
      const own = (c) => fin.roof === 'tile' || fin.roof === 'slate' ? c : roof;
      switch (s.type) {
        case 'tent': {
          const g = new THREE.Group();
          const canvasC = pick(rnd, ['#d9c9a3', '#cdb98f', '#c9a77a', '#b9c4a0', '#c7b2a0']);
          if (!bare) {
            g.add(pyramid(w * 0.92, d * 0.92, 1.9, mat(canvasC, { roof: true, double: true })));
            g.add(mesh(new THREE.PlaneGeometry(0.7, 1.0).translate(0, 0.5, 0), mat('#3a2d22', { roof: true }), 0, 0, d * 0.46 / 2 + 0.25));
          }
          g.add(mesh(box(0.08, 2.15, 0.08), mat(TIMBER)));
          return { group: g, top: 2.1, chimneys: [] };
        }
        case 'bunkhouse': return house(w, d, { wallH: 1.4, roofH: 0.9, plaster: '#9a7550', roof, bare });
        case 'longhouse': return house(w, d, { wallH: 1.05, roofH: 1.8, oh: 0.5, plaster: '#8a6a48', roof, chimneys: 1, bare });
        case 'barracks': {
          const h = house(w, d, { wallH: 1.65, roofH: 1.1, plaster: STONE, roof: own('#4d5f7a'), floor: '#8f8a80', bare });
          h.group.add(mesh(box(0.08, 3.2, 0.08), mat(TIMBER), w / 2 + 0.4, 0, d / 2));
          h.group.add(mesh(new THREE.PlaneGeometry(0.7, 0.5), mat(pick(rnd, SHUTTERS), { double: true }), w / 2 + 0.77, 2.85, d / 2));
          return h;
        }
        case 'cottages': {
          // a terrace of two cottages under two roofs of different colours
          const h = house(w, d, { wallH: 1.45, roofH: 1.2, plaster, roof, bare: true });
          if (!bare) {
            const r2 = pick(rnd, look.colours.filter(c => c !== roof));
            for (const [sx, rc] of [[-1, roof], [1, r2]]) {
              const half = roofOver(w / 2, d, 1.45, 1.2, 0.25, roofMat(rc), mat(plaster, { roof: true }));
              half.position.x = sx * w / 4;
              h.group.add(half);
              const cx = sx * w / 4, ch = 1.45 + 1.15;
              h.group.add(mesh(box(0.34, ch, 0.34), mat(STONE, { roof: true }), cx + sx * 0.5, 0, -d * 0.2));
              h.chimneys.push(new THREE.Vector3(cx + sx * 0.5, ch + 0.1, -d * 0.2));
            }
            h.top = 1.45 + 1.2;
          }
          return h;
        }
        case 'manor': {
          const h = house(w, d, { wallH: 2.5, storeys: 2, roofH: 1.4, plaster: '#efe6d6', roof: own('#4d6c9a'), chimneys: 2, porch: true, bare });
          for (const sx of [-1, 1]) h.group.add(mesh(new THREE.CylinderGeometry(0.1, 0.12, 1.4, 10).translate(0, 0.7, 0), mat('#efe6d2'), sx * 0.7, 0, d / 2 + 0.9));
          h.group.add(mesh(new THREE.BoxGeometry(1.8, 0.12, 1.2), mat('#4d6c9a', { roof: true }), 0, 1.46, d / 2 + 0.55));
          return h;
        }
        case 'sanctum': {
          const g = new THREE.Group();
          g.add(mesh(box(w + 0.4, 0.25, d + 0.4), mat(STONE)));
          const h = house(w, d, { wallH: 1.4, roofH: 0, plaster: '#f2ece0', timber: '#a83a2c', bare: true });
          h.group.position.y = 0.25;
          g.add(h.group);
          if (!bare) {
            const rm = mat('#3f6b5a', { roof: true, double: true });
            const r1 = pyramid(w + 1.0, d + 1.0, 1.0, rm); r1.position.y = 1.65; g.add(r1);
            const r2 = pyramid(w * 0.6, d * 0.6, 1.0, rm); r2.position.y = 2.35; g.add(r2);
            g.add(mesh(new THREE.SphereGeometry(0.16, 12, 8), mat('#e0b84a', { roof: true, emissive: '#7a5a10', ei: 0.4 }), 0, 3.4, 0));
          }
          return { group: g, top: 3.4, chimneys: [] };
        }
        case 'alehouse': return tavern(house(w, d, { wallH: 1.4, roofH: 1.2, oh: 0.45, plaster: '#c8a878', timber: '#5a3a22', roof, chimneys: 1, glow: true, bare }), w, d, '#c9963f', bare, 0);
        case 'inn': return tavern(house(w, d, { wallH: 2.4, storeys: 2, roofH: 1.3, plaster: '#efe3c8', roof, chimneys: 2, glow: true, bare }), w, d, '#5f8fc9', bare, 0);
        case 'salon': return tavern(house(w, d, { wallH: 1.8, roofH: 1.0, plaster: '#f4efe4', timber: '#8a8f9a', roof: own('#4d6c9a'), glow: true, porch: true, bare }), w, d, '#a45fc9', bare, 2);
        case 'crownhall': return tavern(house(w, d, { wallH: 2.8, storeys: 2, roofH: 1.5, plaster: STONE, timber: '#7a6a4a', roof: own('#3f4a6b'), chimneys: 2, glow: true, porch: true, bare }), w, d, '#e0b84a', bare, 4);
        default: return house(w, d, { wallH: 1.4, roofH: 1.0, plaster, roof, bare });
      }
    }

    // ----- workshops; footprint grows with tier (townmap.js workSize) -----
    function workshop(s, rnd) {
      const w = s.w, d = s.h, g = new THREE.Group();
      let top = 1.6, chimneys = [];
      const put = (h, x, z) => { h.group.position.set(x, 0, z); g.add(h.group); top = Math.max(top, h.top); chimneys.push(...h.chimneys.map(v => v.clone().add(new THREE.Vector3(x, 0, z)))); };
      switch (s.key) {
        case 'farm': {
          g.add(surround(w, d, 'fence', rnd));
          const bw = Math.min(3.2, w * 0.42), bd = Math.min(2.6, d * 0.6);
          put(house(bw, bd, { wallH: 1.5, roofH: 1.1, plaster: '#a8452f', timber: '#e8dcc0', roof: pick(rnd, look.colours) }), -w / 2 + bw / 2 + 0.4, -d / 2 + bd / 2 + 0.4);
          const x0 = -w / 2 + bw + 0.9, x1 = w / 2 - 0.5, crop = pick(rnd, ['#7fae3e', '#c9b24a', '#9bbf4a']);
          const tufts = [];
          for (let z = -d / 2 + 0.6; z <= d / 2 - 0.6; z += 0.6) {
            g.add(mesh(new THREE.BoxGeometry(x1 - x0, 0.06, 0.38), mat('#7a5a3a'), (x0 + x1) / 2, 0.03, z));
            for (let x = x0 + 0.2; x <= x1 - 0.2; x += 0.35) tufts.push([x, z]);
          }
          const tg = new THREE.ConeGeometry(0.1, 0.42, 5).translate(0, 0.27, 0);
          const im = new THREE.InstancedMesh(tg, mat(crop), tufts.length);
          tufts.forEach(([x, z], i) => im.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, 0, z)));
          im.castShadow = true;
          g.add(im);
          break;
        }
        case 'mine': {
          g.add(surround(w, d, 'fence', rnd));
          const mound = mesh(lumpySphere(1, 2), mat('#8a7f70', { flat: false }), 0, 0, -d * 0.12);
          mound.scale.set(w * 0.4, 1.7, d * 0.36);
          g.add(mound);
          g.add(mesh(box(1.0, 1.15, 0.3), mat('#17130f'), 0, 0, -d * 0.12 + d * 0.3));
          for (const sx of [-1, 1]) g.add(mesh(box(0.16, 1.35, 0.16), mat(TIMBER), sx * 0.58, 0, -d * 0.12 + d * 0.33));
          g.add(mesh(new THREE.BoxGeometry(1.4, 0.16, 0.18), mat(TIMBER), 0, 1.35, -d * 0.12 + d * 0.33));
          for (const sx of [-1, 1]) g.add(mesh(new THREE.BoxGeometry(0.05, 0.05, d * 0.3), mat('#4a4a52'), sx * 0.3, 0.03, d * 0.25));
          g.add(mesh(box(0.7, 0.4, 0.5), mat('#6b4a2e'), 0, 0.18, d * 0.22));
          for (let i = 0; i < 4; i++) g.add(mesh(new THREE.DodecahedronGeometry(0.22, 0), mat('#5b6a80', { flat: true }), w * 0.3 + (rnd() - 0.5), 0.15, d * 0.15 + (rnd() - 0.5)));
          top = 2.2;
          break;
        }
        case 'garden': {
          g.add(surround(w, d, 'hedge', rnd));
          const beds = Math.max(2, Math.floor((d - 1.2) / 1.1));
          const flowers = ['#e86a9a', '#f2d04a', '#9a6ae8', '#f08a4a', '#ffffff'];
          for (let i = 0; i < beds; i++) {
            const z = -d / 2 + 0.9 + i * 1.1;
            g.add(mesh(box(w - 1.6, 0.3, 0.7), mat('#6b4a2e'), 0.3, 0, z));
            for (let x = -w / 2 + 1.4; x < w / 2 - 0.6; x += 0.45) {
              const b = mesh(lumpySphere(0.2, 1), mat(rnd() < 0.5 ? '#4f8f3a' : '#6aa845'), x, 0.42, z);
              g.add(b);
              if (rnd() < 0.5) g.add(mesh(new THREE.SphereGeometry(0.07, 6, 4), mat(pick(rnd, flowers)), x + 0.08, 0.6, z + 0.05));
            }
          }
          put(house(1.6, 1.6, { wallH: 1.2, roofH: 0.6, plaster: '#8a6a48', roof: pick(rnd, look.colours) }), -w / 2 + 1.1, -d / 2 + 1.1);
          break;
        }
        case 'kitchen': {
          put(house(w - 0.4, d - 0.4, { wallH: 1.5, roofH: 1.2, plaster: pick(rnd, PLASTER), roof: pick(rnd, look.colours), chimneys: 1 }), 0, 0);
          break;
        }
        case 'smithy': {
          g.add(surround(w, d, 'stone', rnd));
          const sw = w - 0.8, sd = d * 0.6;
          for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(mesh(box(0.2, 1.7, 0.2), mat(TIMBER), sx * sw / 2, 0, -d / 2 + 0.4 + (sz + 1) / 2 * sd));
          const r = roofOver(sw + 0.2, sd + 0.2, 1.7, 0.8, 0.25, mat('#4a4a52', { roof: true, double: true }), mat(TIMBER, { roof: true }));
          r.position.z = -d / 2 + 0.4 + sd / 2;
          g.add(r);
          const fz = -d / 2 + 0.9;
          g.add(mesh(box(1.3, 0.8, 0.9), mat('#8a7f70'), -sw / 4, 0, fz));
          flame(g, -sw / 4, 0.8, fz, '#ff7a2a', 1.1);
          g.add(mesh(box(0.5, 3.0, 0.5), mat(STONE, { roof: true }), -sw / 4, 0, fz - 0.3));
          chimneys.push(new THREE.Vector3(-sw / 4, 3.1, fz - 0.3));
          g.add(mesh(box(0.5, 0.45, 0.25), mat('#2f2f36'), sw / 4, 0, fz + 0.4));
          top = 2.6;
          break;
        }
        case 'lab': {
          g.add(surround(w, d, 'stone', rnd));
          const r = Math.min(w, d) * 0.3;
          g.add(mesh(new THREE.CylinderGeometry(r, r * 1.05, 2.8, 16).translate(0, 1.4, 0), mat(STONE), 0, 0, -d * 0.12));
          g.add(mesh(new THREE.ConeGeometry(r * 1.25, 1.7, 16).translate(0, 0.85, 0), mat('#6a4c94', { roof: true, double: true }), 0, 2.8, -d * 0.12));
          for (const a of [0.4, -0.4, Math.PI]) {
            const win = mesh(new THREE.PlaneGeometry(0.35, 0.55), mat('#2b3a2b', { emissive: '#7dff9a', ei: 0.9 }));
            win.position.set(Math.sin(a) * (r + 0.02), 1.9, -d * 0.12 + Math.cos(a) * (r + 0.02));
            win.rotation.y = a;
            g.add(win);
          }
          top = 4.6;
          break;
        }
        case 'training': {
          g.add(mesh(new THREE.PlaneGeometry(w - 0.2, d - 0.2).rotateX(-Math.PI / 2), mat('#d8c08a'), 0, 0.03, 0));
          g.add(surround(w, d, 'fence', rnd));
          const n = Math.max(2, Math.floor(w / 2));
          for (let i = 0; i < n; i++) {
            const x = (i - (n - 1) / 2) * (w / n), z = -d / 2 + 1.0;
            g.add(mesh(box(0.1, 1.3, 0.1), mat(TIMBER), x, 0, z));
            g.add(mesh(new THREE.BoxGeometry(0.8, 0.08, 0.08), mat(TIMBER), x, 1.0, z));
            g.add(mesh(new THREE.SphereGeometry(0.2, 10, 8), mat('#d6b77a'), x, 1.38, z));
            g.add(mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.5, 10).translate(0, 0.75, 0), mat('#c9a865'), x, 0, z));
          }
          break;
        }
        default:
          put(house(w - 0.4, d - 0.4, { wallH: 1.5, roofH: 1.0, plaster: pick(rnd, PLASTER), roof: pick(rnd, look.colours) }), 0, 0);
      }
      return { group: g, top, chimneys };
    }

    function altar(s, rnd) {
      const w = s.w, d = s.h, g = new THREE.Group();
      g.add(surround(w, d, 'stone', rnd));
      g.add(mesh(box(w - 1.0, 0.2, d - 1.0), mat(STONE)));
      g.add(mesh(box(w - 1.8, 0.2, d - 1.8), mat('#cfc4ad'), 0, 0.2, 0));
      const q = (Math.min(w, d) - 2.0) / 2;
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(mesh(new THREE.CylinderGeometry(0.13, 0.15, 1.6, 10).translate(0, 0.8, 0), mat('#e6dccb'), sx * q, 0.4, sz * q));
      g.add(mesh(new THREE.BoxGeometry(q * 2 + 0.4, 0.18, q * 2 + 0.4), mat('#e6dccb', { roof: true }), 0, 2.08, 0));
      g.add(mesh(new THREE.CylinderGeometry(0.3, 0.18, 0.35, 12).translate(0, 0.17, 0), mat('#5a4a3a'), 0, 0.4, 0));
      flame(g, 0, 0.75, 0, '#b58aff', 1.0);
      return { group: g, top: 2.4, chimneys: [] };
    }

    /** A construction site: foundation, a frame, the building rising inside it, and materials. */
    function site(s, rnd) {
      const w = s.w, d = s.h, g = new THREE.Group();
      g.add(mesh(box(w, 0.14, d), mat('#a39882')));
      const rise = new THREE.Group();
      rise.add(lodging(s, rnd).group);
      rise.position.y = 0.14;
      rise.userData.live = true;
      g.add(rise);
      const H = s.type === 'manor' ? 2.5 : s.type === 'tent' ? 2.1 : 1.7, pole = mat('#a7845a');
      const n = Math.max(1, Math.round(w / 1.5)), m = Math.max(1, Math.round(d / 1.5));
      for (let i = 0; i <= n; i++) for (const sz of [-1, 1]) g.add(mesh(box(0.09, H, 0.09), pole, -w / 2 + w * i / n, 0.14, sz * d / 2));
      for (let j = 1; j < m; j++) for (const sx of [-1, 1]) g.add(mesh(box(0.09, H, 0.09), pole, sx * w / 2, 0.14, -d / 2 + d * j / m));
      for (const sz of [-1, 1]) g.add(mesh(new THREE.BoxGeometry(w, 0.08, 0.08), pole, 0, H * 0.55, sz * d / 2));
      for (let i = 0; i < 4; i++) g.add(mesh(new THREE.BoxGeometry(1.4, 0.1, 0.18), mat('#b08a5a'), w / 2 + 0.9, 0.05 + i * 0.11, d / 2 - 0.3 - (i % 2) * 0.05, 0.05 * i));
      for (let i = 0; i < 5; i++) g.add(mesh(new THREE.DodecahedronGeometry(0.2, 0), mat('#a8a090', { flat: true }), -w / 2 - 0.7 + (rnd() - 0.5) * 0.5, 0.15, d / 2 - 0.4 + (rnd() - 0.5) * 0.6));
      world.sites.push({ id: s.bedId, rise });
      return { group: g, top: H + 0.3, chimneys: [] };
    }

    const QUILTS = ['#8e4a3a', '#4d6c9a', '#5f7d3c', '#a8873a', '#7a5a8a', '#b5532f'];
    /**
     * Inside a lodging, seen once the roofs fade: its beds (economy.js LODGINGS) side by side along
     * the back wall with their heads to it, as bunks two high where there are more than six; a
     * table with two stools and a rug in the front half; a hearth with embers against the right
     * wall. A tent has two bedrolls and a chest.
     */
    function furnish(h, s, rnd) {
      const def = typeof Econ !== 'undefined' && Econ.LODGINGS[s.type];
      const g = h.group, w = s.w, d = s.h, beds = def ? def.beds : 0;
      if (!beds) return;
      const wood = mat('#7a5233'), linen = mat('#ece4d2'), quilt = mat(pick(rnd, QUILTS));
      if (s.type === 'tent') {
        for (const sx of [-0.45, 0.45]) {
          g.add(mesh(box(0.55, 0.08, 1.2), quilt, sx, 0.04, 0));
          g.add(mesh(box(0.35, 0.08, 0.2), linen, sx, 0.08, -0.45));
        }
        g.add(mesh(box(0.5, 0.35, 0.35), wood, 0, 0.04, 0.85));
        return;
      }
      const bunk = beds > 6, n = bunk ? Math.ceil(beds / 2) : beds;
      const step = Math.min(0.82, (w - 0.6) / n), z0 = -d / 2 + 0.18 + 0.56;
      for (let i = 0; i < n; i++) {
        const b = new THREE.Group();
        const level = (y) => {
          b.add(mesh(box(0.62, 0.1, 1.05), wood, 0, y, 0));
          b.add(mesh(box(0.56, 0.08, 0.98), linen, 0, y + 0.1, 0));
          b.add(mesh(box(0.58, 0.05, 0.6), quilt, 0, y + 0.17, 0.2));
          b.add(mesh(box(0.4, 0.07, 0.2), linen, 0, y + 0.18, -0.36));
        };
        level(0.12);
        for (const sx of [-0.29, 0.29]) for (const sz of [-0.5, 0.5]) b.add(mesh(box(0.06, bunk ? 1.25 : 0.4, 0.06), wood, sx, 0.04, sz));
        if (bunk) level(0.85);
        b.position.set(-(n - 1) / 2 * step + i * step, 0, z0);
        g.add(b);
      }
      if (d >= 3.5) {
        const tx = -w / 4, tz = d / 2 - 1.25;
        g.add(mesh(box(0.9, 0.06, 0.55), wood, tx, 0.55, tz));
        for (const lx of [-0.38, 0.38]) for (const lz of [-0.22, 0.22]) g.add(mesh(box(0.06, 0.52, 0.06), wood, tx + lx, 0.04, tz + lz));
        for (const sx of [-0.65, 0.65]) g.add(mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.34, 8).translate(0, 0.17, 0), wood, tx + sx, 0.04, tz));
        g.add(mesh(box(1.3, 0.02, 0.9), mat(pick(rnd, QUILTS)), w / 6, 0.04, 0.1));
      }
      g.add(mesh(box(0.42, 0.5, 0.8), mat('#9a8f7c'), w / 2 - 0.39, 0.04, -0.2));
      g.add(mesh(box(0.2, 0.08, 0.5), mat('#ff8a3a', { emissive: '#ff6a1a', ei: 1.2 }), w / 2 - 0.46, 0.42, -0.2));
    }

    /**
     * What is kept outside a building, at its back and sides (its front is the road's): a woodpile
     * against a lodging's side wall, barrels and crates at a workshop's back corner, hay bales
     * beside the farm's barn.
     */
    function yard(h, s, rnd) {
      const g = h.group, w = s.w, d = s.h, sx = rnd() < 0.5 ? -1 : 1;
      if (s.kind === 'bed' && s.type !== 'tent' && rnd() < 0.7) {
        const logM = mat('#7a5a3a'), z = -d / 4;
        for (let row = 0; row < 3; row++) for (let i = 0; i < 3 - row; i++) {
          g.add(mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.0, 7).rotateX(Math.PI / 2), logM, sx * (w / 2 + 0.2 + (i + row * 0.5) * 0.18), 0.09 + row * 0.15, z));
        }
      }
      if (s.kind === 'work' && ['smithy', 'kitchen', 'mine', 'lab'].includes(s.key)) {
        const x = sx * (w / 2 + 0.4), z = -d / 2 + 0.4;
        for (let i = 0; i < 2 + Math.floor(rnd() * 2); i++) {
          g.add(mesh(new THREE.CylinderGeometry(0.2, 0.17, 0.55, 10).translate(0, 0.275, 0), mat('#7a5532'), x, 0, z + i * 0.45));
          g.add(mesh(new THREE.TorusGeometry(0.19, 0.02, 4, 12).rotateX(Math.PI / 2), mat('#3a3530'), x, 0.42, z + i * 0.45));
        }
        const c = mesh(box(0.45, 0.45, 0.45), mat('#9a6e3e'), x - sx * 0.55, 0, z + 0.2);
        c.rotation.y = rnd() * 0.6;
        g.add(c);
      }
      if (s.key === 'farm') {
        for (let i = 0; i < 3; i++) g.add(mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.55, 12).rotateZ(Math.PI / 2), mat('#d8c070'), -w / 2 + 0.7 + i * 0.62, 0.32, d / 2 - 0.55));
      }
    }

    // ----- structures -----
    for (const s of lay.structures) {
      const rnd = BaseLayout.mulberry32(BaseLayout.hashStr(s.key + ':look', lay.seed));
      const x = s.x + OX, z = s.z + OZ;
      const built = s.kind === 'work' ? workshop(s, rnd) : s.kind === 'altar' ? altar(s, rnd) : s.site ? site(s, rnd) : lodging(s, rnd);
      if (!s.site) {
        const extra = BaseLayout.mulberry32(BaseLayout.hashStr(s.key + ':yard', lay.seed));      // a stream of its own: the look stays put
        if (s.kind === 'bed') furnish(built, s, extra);
        yard(built, s, extra);
      }
      const g = built.group;
      g.position.set(x, heightAt(x, z), z);
      g.rotation.y = s.rot;
      town.add(g);                         // a construction site's rising part is marked live
      g.updateMatrixWorld(true);
      for (const c of built.chimneys) addSmoke(g.localToWorld(c.clone()), s.key === 'smithy' ? 0.55 : 0.85);
      // sign over the door
      const p = map.plots[s.key];
      const label = s.site ? `${p.label} (building)` : p.label;
      const icon = signTexture(s.site ? '🚧' : p.icon, null), full = signTexture(s.site ? '🚧' : p.icon, label);
      world.textures.push(icon, full);
      const b = billboard(icon, fogU, { w: 0.5, h: 0.5, lift: 0.4 });
      const sp = g.localToWorld(new THREE.Vector3(0, built.top + 0.35, s.h / 2 - 0.3));
      b.position.copy(sp);
      root.add(b);
      world.signs.push({ mesh: b, icon, full });
    }

    /**
     * A light as this tier puts them up: a torch (a stake and a flame) until there are street lamps
     * (FINISH.lamps), then a timber post with a lantern (Village), an iron post with a capped
     * lantern on a stone foot (Town), an iron post with two lanterns on a crossbar (City). `glow`
     * adds a glow sprite at each lantern.
     */
    function lampPost(glow = true) {
      const g = new THREE.Group(), lit = mat('#ffd38a', { emissive: '#ffb04a', ei: 1.2 }), iron = mat('#2f2f36');
      const lanterns = [];
      if (!fin.lamps) {
        g.add(mesh(box(0.07, 1.45, 0.07), mat(TIMBER)));
        flame(g, 0, 1.45, 0, '#ffb347', 0.7);
        return g;
      }
      if (fin.path <= 2) {
        g.add(mesh(box(0.1, 1.9, 0.1), mat(TIMBER)));
        g.add(mesh(new THREE.BoxGeometry(0.24, 0.28, 0.24), lit, 0, 2.02, 0));
        g.add(mesh(new THREE.ConeGeometry(0.21, 0.16, 4).rotateY(Math.PI / 4).translate(0, 2.24, 0), mat('#3a3530')));
        lanterns.push([0, 2.02]);
      } else {
        g.add(mesh(box(0.22, 0.24, 0.22), mat('#b9ad97')));
        g.add(mesh(new THREE.CylinderGeometry(0.035, 0.05, 2.0, 8).translate(0, 1.0, 0), iron));
        const arms = fin.path === 3 ? [0] : [-0.38, 0.38];
        if (arms.length > 1) g.add(mesh(new THREE.BoxGeometry(0.86, 0.05, 0.05), iron, 0, 1.98, 0));
        for (const ax of arms) {
          const y = arms.length > 1 ? 1.78 : 2.12;
          g.add(mesh(new THREE.BoxGeometry(0.2, 0.26, 0.2), lit, ax, y, 0));
          g.add(mesh(new THREE.ConeGeometry(0.18, 0.18, 4).rotateY(Math.PI / 4).translate(0, y + 0.22, 0), iron));
          lanterns.push([ax, y]);
        }
      }
      if (glow) for (const [x, y] of lanterns) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: shared.glowTex, color: '#ffc46a', blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.45 }));
        sp.position.set(x, y, 0); sp.scale.setScalar(1.3);
        g.add(sp);
      }
      return g;
    }

    // ----- the floors: retaining walls at each platform's foot, stairs between floors, plazas -----
    floorsOf(lay, OX, OZ, heightAt, root, mat, mesh, box, { fin, lampPost, town });

    // ----- the square: what stands in it (FINISH.square), lights round it, benches from Town -----
    {
      const gy = heightAt(OX, OZ), stone = mat('#cfc4ad');
      const waterM = waterMaterial();
      const f = new THREE.Group();
      /** A round stone basin of radius r and height h standing at y, with water in it. */
      const basin = (r, h, y = 0) => {
        f.add(mesh(new THREE.CylinderGeometry(r, r + 0.1, h, 28, 1, true).translate(0, y + h / 2, 0), mat('#cfc4ad', { double: true })));
        f.add(mesh(new THREE.TorusGeometry(r + 0.02, 0.07, 6, 28).rotateX(Math.PI / 2), stone, 0, y + h, 0));
        f.add(mesh(new THREE.CircleGeometry(r - 0.03, 28).rotateX(-Math.PI / 2), waterM, 0, y + h - 0.07, 0));
      };
      switch (fin.square) {
        case 'fire': {                       // a ring of stones round a fire on crossed logs
          for (let i = 0; i < 9; i++) {
            const a = i / 9 * Math.PI * 2;
            f.add(mesh(new THREE.DodecahedronGeometry(0.2, 0), mat('#8f877a', { flat: true }), Math.cos(a) * 0.75, 0.1, Math.sin(a) * 0.75));
          }
          for (let i = 0; i < 3; i++) f.add(mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.8, 6).rotateZ(Math.PI / 2), mat('#5a3d24'), 0, 0.08 + i * 0.05, 0, i * 1.05));
          flame(f, 0, 0.12, 0, '#ff9a3a', 1.4);
          break;
        }
        case 'well': {                       // a stone well with a winding beam under a small roof
          f.add(mesh(new THREE.CylinderGeometry(0.75, 0.8, 0.7, 20, 1, true).translate(0, 0.35, 0), mat('#a39882', { double: true })));
          f.add(mesh(new THREE.TorusGeometry(0.77, 0.08, 6, 20).rotateX(Math.PI / 2), mat('#a39882'), 0, 0.7, 0));
          f.add(mesh(new THREE.CircleGeometry(0.72, 20).rotateX(-Math.PI / 2), mat('#1f2a30'), 0, 0.3, 0));
          for (const sx of [-1, 1]) f.add(mesh(box(0.1, 1.7, 0.1), mat(TIMBER), sx * 0.8, 0, 0));
          f.add(mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.7, 8).rotateZ(Math.PI / 2), mat(TIMBER), 0, 1.3, 0));
          f.add(roofOver(1.9, 1.1, 1.7, 0.55, 0.12, roofMat(look.colours[0]), mat(TIMBER, { roof: true })));
          f.add(mesh(new THREE.CylinderGeometry(0.12, 0.1, 0.22, 10), mat('#6b4a2e'), 0.3, 0.95, 0));
          break;
        }
        case 'basin': basin(1.15, 0.35); break;
        case 'fountain': {                   // the basin, a column and a bowl on it
          basin(1.15, 0.35);
          f.add(mesh(new THREE.CylinderGeometry(0.14, 0.2, 0.9, 12).translate(0, 0.45, 0), stone));
          f.add(mesh(new THREE.CylinderGeometry(0.42, 0.18, 0.18, 16).translate(0, 0.95, 0), stone));
          f.add(mesh(new THREE.CircleGeometry(0.37, 16).rotateX(-Math.PI / 2), waterM, 0, 1.12, 0));
          break;
        }
        case 'tiered': {                     // a stepped base, a wider basin, two bowls up a column, a gilt ball
          f.add(mesh(new THREE.CylinderGeometry(1.62, 1.7, 0.14, 32).translate(0, 0.07, 0), mat('#d6ccb8')));
          basin(1.38, 0.4, 0.14);
          f.add(mesh(new THREE.CylinderGeometry(0.16, 0.24, 1.6, 12).translate(0, 0.94, 0), stone));
          for (const [y, r] of [[1.0, 0.64], [1.7, 0.36]]) {
            f.add(mesh(new THREE.CylinderGeometry(r, r * 0.35, 0.2, 20).translate(0, y, 0), stone));
            f.add(mesh(new THREE.CircleGeometry(r - 0.05, 20).rotateX(-Math.PI / 2), waterM, 0, y + 0.09, 0));
          }
          f.add(mesh(new THREE.CylinderGeometry(0.07, 0.11, 0.45, 10).translate(0, 1.92, 0), stone));
          f.add(mesh(new THREE.SphereGeometry(0.14, 12, 8), mat('#e0b84a', { emissive: '#7a5a10', ei: 0.35 }), 0, 2.4, 0));
          break;
        }
      }
      f.position.set(OX, gy, OZ);
      town.add(f);
      for (let i = 0; i < 6; i++) {
        const a = (i + 0.5) / 6 * Math.PI * 2, lx = OX + Math.sin(a) * (lay.square.r + 0.4), lz = OZ - Math.cos(a) * (lay.square.r + 0.4);
        const lamp = lampPost();
        lamp.position.set(lx, heightAt(lx, lz), lz);
        town.add(lamp);
      }
      // benches facing the middle on bearings no road comes in on, and from City a planter behind each
      if (fin.path >= 3) {
        const inAt = [];
        for (const r of lay.roads) {
          if (r.floor) continue;
          for (const p of [r.pts[0], r.pts[r.pts.length - 1]]) if (Math.hypot(p[0], p[1]) < lay.square.r + 0.5) inAt.push(Math.atan2(p[1], p[0]));
        }
        const gap = (a) => Math.min(Math.PI, ...inAt.map(b => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))));
        const benches = new THREE.Group();
        let n = 0;
        for (let i = 0; i < 8 && n < 4; i++) {
          const a = (i + 0.5) / 8 * Math.PI * 2;
          if (gap(a) < 0.42) continue;
          n++;
          const rr = lay.square.r - 0.9, bx = OX + Math.cos(a) * rr, bz = OZ + Math.sin(a) * rr;
          const b = new THREE.Group(), wood = mat('#8a6542'), iron = mat('#2f2f36');
          b.add(mesh(new THREE.BoxGeometry(1.2, 0.07, 0.38), wood, 0, 0.42, 0));
          b.add(mesh(new THREE.BoxGeometry(1.2, 0.3, 0.06), wood, 0, 0.66, -0.19));
          for (const sx of [-0.5, 0.5]) b.add(mesh(box(0.07, 0.42, 0.34), iron, sx, 0, 0));
          b.position.set(bx, heightAt(bx, bz), bz);
          b.rotation.y = Math.atan2(OX - bx, OZ - bz);
          benches.add(b);
          if (fin.quoins) {
            const pr = rr + 2.0, px = OX + Math.cos(a) * pr, pz = OZ + Math.sin(a) * pr;
            const pl = new THREE.Group();
            pl.add(mesh(box(0.7, 0.45, 0.7), mat('#cfc4ad')));
            pl.add(mesh(lumpySphere(0.36, 1), mat('#4f8a34'), 0, 0.68, 0));
            for (let k = 0; k < 4; k++) pl.add(mesh(new THREE.SphereGeometry(0.08, 6, 4), mat(['#e86a9a', '#f2d04a', '#ffffff', '#e8584a'][k]), Math.cos(k * 1.7) * 0.28, 0.62, Math.sin(k * 1.7) * 0.28));
            pl.position.set(px, heightAt(px, pz), pz);
            benches.add(pl);
          }
        }
        town.add(benches);
      }
    }

    // ----- street lamps along the roads, FINISH.lamps tiles apart, on alternate sides -----
    if (fin.lamps) {
      const onRoad = layoutRoads(lay, OX, OZ), spots = [], lamps = new THREE.Group();
      for (const r of lay.roads) {
        if (r.key.startsWith('stair:')) continue;
        let next = 1.5, walked = 0, side = 1;          // next: distance along the road of the next lamp
        for (let i = 0; i + 1 < r.pts.length; i++) {
          const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1], len = Math.hypot(bx - ax, bz - az);
          if (len < 1e-6) continue;
          const ux = (bx - ax) / len, uz = (bz - az) / len;
          for (; next < walked + len; next += fin.lamps) {
            const t = next - walked;
            side = -side;
            const off = r.width / 2 + 0.55, x = ax + ux * t - uz * off * side, z = az + uz * t + ux * off * side;
            const wx = x + OX, wz = z + OZ;
            const ok = onRoad(wx, wz) < 0.12 && Math.hypot(x, z) > lay.square.r + 1.4
              && BaseLayout.islandSdf(lay, x, z) > 1.5 && BaseLayout.floorAt(lay, x, z) === r.floor && !BaseLayout.onStair(lay, x, z, 0.6)
              && lay.structures.every(s => Math.hypot(x - s.x, z - s.z) > s.r + 0.5)
              && spots.every(([px, pz]) => Math.hypot(x - px, z - pz) > fin.lamps * 0.6);
            if (!ok) continue;
            spots.push([x, z]);
            const lamp = lampPost(false);
            lamp.position.set(wx, heightAt(wx, wz), wz);
            lamps.add(lamp);
          }
          walked += len;
        }
      }
      town.add(lamps);
    }

    // ----- the crystal, north of the square -----
    {
      const cx = lay.crystal.x + OX, cz = lay.crystal.z + OZ, gy = heightAt(cx, cz);
      const base = new THREE.Group();
      base.add(mesh(new THREE.CylinderGeometry(1.35, 1.6, 0.35, 8).translate(0, 0.175, 0), mat('#b3aa98', { flat: true })));
      base.add(mesh(new THREE.CylinderGeometry(0.9, 1.05, 0.3, 8).translate(0, 0.5, 0), mat('#cfc4ad', { flat: true })));
      // standing stones round it: rough and leaning at Camp and Outpost, then dressed pillars, gilt at City
      for (let i = 0; i < 6; i++) {
        const a = i / 6 * Math.PI * 2, sx = Math.sin(a) * 2.5, sz = Math.cos(a) * 2.5;
        if (fin.path >= 2) {
          base.add(mesh(new THREE.CylinderGeometry(0.17, 0.21, 1.35, 8).translate(0, 0.675, 0), mat('#d6ccb8'), sx, 0, sz));
          base.add(mesh(box(0.34, 0.1, 0.34), mat('#d6ccb8'), sx, 1.35, sz));
          if (fin.quoins) base.add(mesh(new THREE.SphereGeometry(0.11, 10, 6), mat('#e0b84a', { emissive: '#7a5a10', ei: 0.35 }), sx, 1.55, sz));
        } else {
          const st = mesh(box(0.35, 1.1 + (i % 2) * 0.4, 0.28), mat('#a39882', { flat: true }), sx, 0, sz, a);
          st.rotation.z = (i % 3 - 1) * 0.06;
          base.add(st);
        }
      }
      base.position.set(cx, gy, cz);
      town.add(base);
      const crystal = mesh(new THREE.OctahedronGeometry(0.9, 0).scale(0.75, 2.1, 0.75), mat('#bfe8ff', { emissive: '#4aa8ff', ei: 0.9, flat: true }), cx, gy + 3.0, cz);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: shared.glowTex, color: '#8fd4ff', blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.55 }));
      halo.scale.setScalar(5.5);
      halo.position.set(cx, gy + 3.0, cz);
      const light = new THREE.PointLight('#9fdcff', 9, 12, 1.4);
      light.position.set(cx, gy + 2.6, cz);
      root.add(crystal, halo, light);
      world.crystal = { mesh: crystal, halo, y: gy + 3.0 };
    }

    // ----- the gate: a portal at the end of the road out, just inside the rim -----
    {
      const gx = lay.gate.x + OX, gz = lay.gate.z + OZ, gy = heightAt(gx, gz);
      const g = new THREE.Group(), stone = mat('#cfc4ad', { flat: true });
      for (const sx of [-1, 1]) g.add(mesh(new THREE.CylinderGeometry(0.32, 0.4, 3.0, 8).translate(0, 1.5, 0), stone, sx * 1.95, 0, 0));
      g.add(mesh(new THREE.TorusGeometry(1.95, 0.24, 8, 24, Math.PI).translate(0, 3.0, 0), stone));
      const tex = portalTexture();
      world.textures.push(tex);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(1.75, 40), new THREE.MeshBasicMaterial({
        map: tex, color: '#b48cff', transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      disc.position.y = 2.1;
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: shared.glowTex, color: '#a07cff', blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.55 }));
      glow.position.y = 2.1; glow.scale.setScalar(5);
      g.add(disc, glow);
      g.position.set(gx, gy, gz);
      g.rotation.y = Math.atan2(lay.gate.ux, lay.gate.uz);         // the disc faces down the road
      root.add(g);
      world.portal = { disc, glow };
    }

    // ----- the island's underside, roots, islets, the pond and its waterfall, clouds -----
    skyIsland(lay, OX, OZ, heightAt, root, mat, mesh, box);

    // ----- trees in a ring just inside the rim, a few bushes inside, and ground cover -----
    const bushes = [];
    const M4 = (x, y, z, sx, sy, sz, ry = 0) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry), new THREE.Vector3(sx, sy, sz));
    const near = (x, z) => lay.structures.some(s => Math.hypot(x - OX - s.x, z - OZ - s.z) < s.r + 1.3)
      || Math.hypot(x - OX - lay.crystal.x, z - OZ - lay.crystal.z) < 3.4 || Math.hypot(x - OX, z - OZ) < lay.square.r + 1.2;
    const road = layoutRoads(lay, OX, OZ);
    const onPlatform = (x, z) => { for (let k = 1; k <= lay.top; k++) if (BaseLayout.floorSdf(lay, k, x - OX, z - OZ) > -2.2) return true; return false; };
    // a ring of trees just inside the rim, thickest 1-3 tiles in and gone by 7; nothing past the edge
    const rim = (x, z) => BaseLayout.islandSdf(lay, x - OX, z - OZ);
    const wet = (x, z) => lay.pond && Math.hypot(x - OX - lay.pond.x, z - OZ - lay.pond.z) < lay.pond.r + 1.6;
    const trees = forest(so);
    for (let ty = -MARGIN; ty < map.h + MARGIN; ty++) for (let tx = -MARGIN; tx < map.w + MARGIN; tx++) {
      const r1 = hash(tx * 3 + so, ty * 7), r2 = hash(tx * 11, ty * 5 + so), r3 = hash(tx + 99, ty - so);
      const x = tx + 0.5 + (r2 - 0.5) * 0.6, z = ty + 0.5 + (r3 - 0.5) * 0.6;
      const e = rim(x, z);
      if (e < 0.9 || road(x, z) > 0.05 || onPlatform(x, z) || wet(x, z)) continue;
      const out = e < 7 && !near(x, z) ? (1 - e / 7) : 0;
      const gy = heightAt(x, z);
      if (out > 0 ? r1 < 0.08 + out * 0.5 : (!near(x, z) && r1 < 0.015)) {
        trees.add(x, gy, z, 0.8 + r2 * 0.7, (tx * 92821) ^ (ty * 68917));
      } else if (out <= 0 && !near(x, z) && r1 > 0.94) {
        const bs = 0.28 + r2 * 0.2;
        bushes.push({ m: M4(x, gy + bs * 0.35, z, bs, bs * 0.8, bs, r3 * 6), c: r3 });
      }
    }
    const living = (o) => patchMaterial(new THREE.MeshLambertMaterial({ color: '#ffffff', vertexColors: !!o.vertexColors, flatShading: !!o.flat,
      side: o.double ? THREE.DoubleSide : THREE.FrontSide }), U, { sway: o.sway || 0, swayBase: o.swayBase || 0 });
    trees.build(root, living);
    if (bushes.length) {
      const im = new THREE.InstancedMesh(shadeByHeight(lumpySphere(0.48, 2), -0.4, 0.3, 0.6), living({ vertexColors: true, sway: 0.02, swayBase: 0.5 }), bushes.length);
      const bA = new THREE.Color('#3d6e2a'), bB = new THREE.Color('#5d8f34');
      bushes.forEach((e, i) => { im.setMatrixAt(i, e.m); im.setColorAt(i, new THREE.Color().lerpColors(bA, bB, e.c)); });
      im.castShadow = im.receiveShadow = true;
      root.add(im);
    }
    // grass, flowers and pebbles wherever the ground is open and level: not on roads, under
    // buildings, on stairs, in the pond, or on a terrace's cliff
    const level = (x, z) => Math.abs(heightAt(x + 0.3, z) - heightAt(x - 0.3, z)) + Math.abs(heightAt(x, z + 0.3) - heightAt(x, z - 0.3)) < 0.25;
    const clearOf = (x, z) => lay.structures.every(s => Math.hypot(x - OX - s.x, z - OZ - s.z) > s.r + 0.15);
    const open = (x, z) => rim(x, z) > 0.9 && road(x, z) < 0.04 && !wet(x, z) && clearOf(x, z) && !BaseLayout.onStair(lay, x - OX, z - OZ, 0.3) && level(x, z);
    const bx = lay.bounds;
    groundCover(root, heightAt, so, { x0: bx.x0 + OX, z0: bx.z0 + OZ, x1: bx.x1 + OX, z1: bx.z1 + OZ },
      open, (x, z) => (rim(x, z) > 0.9 ? road(x, z) : 0), STYLE.town.grass, living);
    bake(town);
  }

  /**
   * The platforms' masonry. For each open floor: the outline of its platform at the cliff's foot
   * (BaseLayout.floorSdf = -CLIFF, by marching squares on a WALL_STEP grid), and a wall along it
   * from the ground outside up to the platform, open where a stair crosses. Its top is the tier's
   * (FINISH.terrace): bare rough stone, a merlon on about a third of the segments, a continuous
   * coping of dressed stone, or the coping with a balustrade on it. Then each stair as treads and
   * side walls, and on each plaza a banner in the floor's colour (floors.js) and two lamps.
   */
  const WALL_STEP = 0.5;
  const TERRACE_STONE = { bare: ['#a49579', 0.36], merlons: ['#b8aa90', 0.1], coping: ['#c6b99e', 0.08], balustrade: ['#c6b99e', 0.08] };
  function floorsOf(lay, OX, OZ, heightAt, root, mat, mesh, box, { fin, lampPost, town }) {
    if (!lay.top) return;
    const tex = paintTexture('stone');
    world.textures.push(tex);
    const wallM = patchMaterial(new THREE.MeshLambertMaterial({ color: '#ffffff', map: tex, bumpMap: tex, bumpScale: 1.5, vertexColors: true, side: THREE.DoubleSide }), U);
    const [stoneHex, rough] = TERRACE_STONE[fin.terrace];
    const stoneA = new THREE.Color(stoneHex), tmp = new THREE.Color();
    const merlons = [], coping = [], balusters = [], rails = [];
    const yAxis = new THREE.Vector3(0, 1, 0);
    /** A piece laid along a wall segment: centred at (x, y, z), turned to angle `a`, `len` long. */
    const along = (x, y, z, a, len) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(yAxis, -a), new THREE.Vector3(len, 1, 1));
    const props = new THREE.Group();
    for (let k = 1; k <= lay.top; k++) {
      const F = lay.floors[k];
      const sdf = (x, z) => BaseLayout.floorSdf(lay, k, x, z) + BaseLayout.CLIFF;
      let { x0, x1, z0, z1 } = F.box;
      x0 -= 2; z0 -= 2; x1 += 2; z1 += 2;
      const nx = Math.ceil((x1 - x0) / WALL_STEP) + 1, nz = Math.ceil((z1 - z0) / WALL_STEP) + 1;
      const v = new Float32Array(nx * nz);
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) v[j * nx + i] = sdf(x0 + i * WALL_STEP, z0 + j * WALL_STEP);
      const pos = [], nrm = [], col = [], uv = [];
      const cut = (ax, az, av, bx, bz, bv) => { const t = av / (av - bv); return { x: ax + (bx - ax) * t, z: az + (bz - az) * t }; };
      const top = F.elev + 0.12;
      const segment = (p, q) => {
        const mx = (p.x + q.x) / 2, mz = (p.z + q.z) / 2;
        if (BaseLayout.onStair(lay, mx, mz, 0.35)) return;
        // outward: down the gradient of the floor's distance field
        const e = 0.05, gx = sdf(mx + e, mz) - sdf(mx - e, mz), gz = sdf(mx, mz + e) - sdf(mx, mz - e), gl = Math.hypot(gx, gz) || 1;
        const ox = -gx / gl, oz = -gz / gl;
        const foot = (pt) => heightAt(pt.x + OX + ox * 0.45, pt.z + OZ + oz * 0.45) - 0.3;
        const pb = foot(p), qb = foot(q);
        const quad = [[p, pb], [q, qb], [q, top], [p, pb], [q, top], [p, top]];
        for (const [pt, y] of quad) {
          pos.push(pt.x + OX, y, pt.z + OZ);
          nrm.push(ox, 0, oz);
          uv.push((pt.x + pt.z) * 0.5, y * 0.5);
          const shade = 0.72 + 0.28 * Math.max(0, Math.min(1, (y - pb) / Math.max(0.1, top - pb))) + (hash(Math.round(pt.x * 2), Math.round(pt.z * 2)) - 0.5) * rough;
          tmp.copy(stoneA).multiplyScalar(shade);
          col.push(tmp.r, tmp.g, tmp.b);
        }
        const len = Math.hypot(q.x - p.x, q.z - p.z), ang = Math.atan2(q.z - p.z, q.x - p.x);
        if (fin.terrace === 'merlons') {
          if (hash(Math.round(mx * 2) + k, Math.round(mz * 2)) < 0.34) merlons.push(new THREE.Matrix4().makeTranslation(mx + OX + ox * 0.08, top + 0.14, mz + OZ + oz * 0.08));
        } else if (fin.terrace !== 'bare') {
          coping.push(along(mx + OX + ox * 0.04, top + 0.06, mz + OZ + oz * 0.04, ang, len + 0.06));
          if (fin.terrace === 'balustrade') {
            balusters.push(new THREE.Matrix4().makeTranslation(mx + OX - ox * 0.04, top + 0.12, mz + OZ - oz * 0.04));
            rails.push(along(mx + OX - ox * 0.04, top + 0.6, mz + OZ - oz * 0.04, ang, len + 0.06));
          }
        }
      };
      for (let j = 0; j + 1 < nz; j++) for (let i = 0; i + 1 < nx; i++) {
        const ax = x0 + i * WALL_STEP, az = z0 + j * WALL_STEP, bx = ax + WALL_STEP, bz = az + WALL_STEP;
        const va = v[j * nx + i], vb = v[j * nx + i + 1], vc = v[(j + 1) * nx + i + 1], vd = v[(j + 1) * nx + i];
        const pts = [];
        if ((va > 0) !== (vb > 0)) pts.push(cut(ax, az, va, bx, az, vb));
        if ((vb > 0) !== (vc > 0)) pts.push(cut(bx, az, vb, bx, bz, vc));
        if ((vc > 0) !== (vd > 0)) pts.push(cut(bx, bz, vc, ax, bz, vd));
        if ((vd > 0) !== (va > 0)) pts.push(cut(ax, bz, vd, ax, az, va));
        if (pts.length === 2) segment(pts[0], pts[1]);
        else if (pts.length === 4) { segment(pts[0], pts[1]); segment(pts[2], pts[3]); }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      const wall = new THREE.Mesh(geo, wallM);
      wall.castShadow = wall.receiveShadow = true;
      root.add(wall);

      // the plaza: a banner in the floor's colour and two lamps
      const colour = typeof Floors !== 'undefined' ? Floors.FLOORS[k].colour : '#c9963f';
      const px = F.core.x + OX, pz = F.core.z + OZ, py = heightAt(px, pz);
      props.add(mesh(box(0.1, 3.6, 0.1), mat('#3a3530'), px + 1.3, py, pz));
      props.add(mesh(new THREE.PlaneGeometry(1.0, 0.7), mat(colour, { double: true, emissive: colour, ei: 0.15 }), px + 1.85, py + 3.15, pz));
      for (const a of [Math.PI * 0.75, Math.PI * 1.25]) {
        const lx = px + Math.sin(a) * 2.6, lz = pz - Math.cos(a) * 2.6;
        const lamp = lampPost();
        lamp.position.set(lx, heightAt(lx, lz), lz);
        props.add(lamp);
      }
    }
    const instanced = (geo, m, list) => {
      if (!list.length) return;
      const im = new THREE.InstancedMesh(geo, m, list.length);
      list.forEach((mx, i) => im.setMatrixAt(i, mx));
      im.castShadow = im.receiveShadow = true;
      root.add(im);
    };
    instanced(new THREE.BoxGeometry(0.42, 0.28, 0.42), mat('#bcae94'), merlons);
    instanced(new THREE.BoxGeometry(1, 0.12, 0.52), mat('#d6ccb8'), coping);
    instanced(new THREE.CylinderGeometry(0.05, 0.07, 0.42, 8).translate(0, 0.21, 0), mat('#ddd3c0'), balusters);
    instanced(new THREE.BoxGeometry(1, 0.08, 0.2), mat('#d6ccb8'), rails);
    // stairs: STEPS treads on the ramp heightAt gives the walkers, with a low wall each side
    const STEPS = 12, tread = mat('#cfc4ad'), side = mat(fin.terrace === 'bare' ? '#a49579' : stoneHex);
    for (const st of lay.stairs) {
      const ax = st.a.x + OX, az = st.a.z + OZ, bx = st.b.x + OX, bz = st.b.z + OZ;
      const len = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / len, uz = (bz - az) / len, ry = Math.atan2(ux, uz);
      const hiY = BaseLayout.FLOOR_H * st.k, loY = BaseLayout.FLOOR_H * (st.k - 1) - 0.3;
      for (let i = 0; i < STEPS; i++) {
        const t = (i + 0.5) / STEPS, cx = ax + ux * len * t, cz = az + uz * len * t;
        const y = hiY - BaseLayout.FLOOR_H * t;
        const g = new THREE.Group();
        g.add(mesh(box(st.w, y - loY, len / STEPS + 0.02), tread));
        for (const sx of [-1, 1]) g.add(mesh(box(0.26, y - loY + 0.4, len / STEPS + 0.02), side, sx * (st.w / 2 + 0.13), 0, 0));
        g.position.set(cx, loY, cz);
        g.rotation.y = ry;
        props.add(g);
      }
    }
    town.add(props);
  }

  /**
   * The floating island below the town, from BaseLayout.islandSdf.
   *   underside  ISLE_RINGS rings under the rim (found on ISLE_N rays from the island's centre),
   *              each at a depth below 0 and a radius of (rim radius - inset) x scale, jittered,
   *              down to a tip; faceted, coloured grass at the lip, then soil, then banded rock.
   *              For the first ~20 tiles down the cliff comes in no faster than 0.3 tiles per tile
   *              of drop: the near rim is at the bottom of the view, where the line of sight is
   *              PITCH + FOV / 2 = 73 degrees down and runs 0.3 out per unit of drop, so a cliff that
   *              comes in faster than that is hidden behind the rock above it
   *   roots      thin dangling cylinders from the soil ring
   *   islets     ISLETS small islands round it, each a grass disc on a short cone, that bob
   *   pond       lay.pond: water and a ring of rocks; a stream to the rim and a waterfall over it
   *   clouds     CLOUDS sprites below the island and a few high ones off to its sides, drifting
   * Depths scale with the island's size (depthScale).
   */
  const ISLE_N = 144, ISLETS = 5, CLOUDS = 44;
  const ISLE_RINGS = [   // [depth, inset from the rim (negative: out), then scale]
    [0.1, -0.25, 1], [0.9, -0.35, 1], [2.0, -0.4, 1], [4.0, 0.2, 1], [7.5, 1.2, 1], [12, 2.5, 1],
    [17.5, 4.2, 1], [23, 7.5, 0.9], [28, 11, 0.7], [33, 14, 0.45], [37, 15, 0.2],
  ];
  const ISLE_TIP = 40;
  const STRATA = ['#9b8467', '#7d6a55', '#a0896b', '#6e5e4d', '#8a7a64', '#77685a'].map(c => new THREE.Color(c));

  /** A tapering faceted body: `ring(i)` gives rim point i (layout space); returns its geometry. */
  function taper(rim, cx, cz, depthScale, OX, OZ, top = 0) {
    const N = rim.length, rings = [];
    ISLE_RINGS.forEach(([d, inset, sc], j) => {
      rings.push(rim.map((p, i) => {
        const jit = (hash(i * 7 + 3, j * 13) - 0.5) * (0.4 + j * 0.5);
        const rad = Math.max(0.5, (p.e - inset * depthScale) * sc + jit);
        return [cx + p.ux * rad + OX, top - d * depthScale + (hash(i, j * 5 + 1) - 0.5) * j * 0.35, cz + p.uz * rad + OZ];
      }));
    });
    const tip = [cx + OX + (hash(9, 9) - 0.5) * 2, top - ISLE_TIP * depthScale, cz + OZ + (hash(8, 8) - 0.5) * 2];
    const pos = [], col = [], c = new THREE.Color();
    const shade = (y, j, i) => {
      if (j === 0) return c.set('#5d8f3c');                           // the grass lip
      if (j === 1) return c.set('#6e4b2e');                           // soil
      const band = Math.floor((-y + hash(i >> 3, j) * 1.6) / 1.9) % STRATA.length;
      c.copy(STRATA[(band + STRATA.length) % STRATA.length]);
      if (j === 2 && hash(i, 77) < 0.35) c.lerp(new THREE.Color('#4f7a33'), 0.5);    // moss under the lip
      return c.multiplyScalar(0.92 - j * 0.035);
    };
    const tri = (a, b, d, j, i) => {
      pos.push(...a, ...b, ...d);
      shade((a[1] + b[1] + d[1]) / 3, j, i);
      for (let k = 0; k < 3; k++) col.push(c.r, c.g, c.b);
    };
    for (let j = 0; j + 1 < rings.length; j++) for (let i = 0; i < N; i++) {
      const a = rings[j][i], b = rings[j][(i + 1) % N], d = rings[j + 1][i], e = rings[j + 1][(i + 1) % N];
      tri(a, d, b, j, i); tri(b, d, e, j, i);
    }
    const last = rings[rings.length - 1];
    for (let i = 0; i < N; i++) tri(last[i], tip, last[(i + 1) % N], rings.length - 1, i);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();
    return { geo, rings };
  }

  function skyIsland(lay, OX, OZ, heightAt, root, mat, mesh, box) {
    const I = lay.island;
    if (!I) return;
    const rimAlong = (ux, uz) => {
      let lo = 0, hi = 4 * (I.hx + I.hz);
      for (let k = 0; k < 36; k++) { const m = (lo + hi) / 2; if (BaseLayout.islandSdf(lay, I.cx + ux * m, I.cz + uz * m) >= 0) lo = m; else hi = m; }
      return lo;
    };
    const rim = [];
    for (let i = 0; i < ISLE_N; i++) { const t = i / ISLE_N * Math.PI * 2, ux = Math.cos(t), uz = Math.sin(t); rim.push({ ux, uz, e: rimAlong(ux, uz) }); }
    const depthScale = Math.max(0.8, Math.min(1.5, (I.hx + I.hz) / 90));
    const rock = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });
    const body = taper(rim, I.cx, I.cz, depthScale, OX, OZ);
    const under = new THREE.Mesh(body.geo, rock);
    under.castShadow = true; under.receiveShadow = true;
    root.add(under);

    // rocks along the rim, sunk into the lip, clear of the gate and the waterfall
    const rocks = [];
    for (let i = 0; i < ISLE_N; i += 2) {
      if (hash(i, 91) > 0.45) continue;
      const p = rim[i], e = p.e - 0.3 - hash(i, 92) * 0.5, x = I.cx + p.ux * e, z = I.cz + p.uz * e;
      if (Math.hypot(x - lay.gate.x, z - lay.gate.z) < 2.6 || (lay.fall && Math.hypot(x - lay.fall.x, z - lay.fall.z) < 1.6)) continue;
      const sc = 0.3 + hash(i, 93) * 0.55, wx = x + OX, wz = z + OZ;
      rocks.push(new THREE.Matrix4().compose(new THREE.Vector3(wx, heightAt(wx, wz) - sc * 0.3, wz),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(hash(i, 94) - 0.5, hash(i, 95) * 6.283, hash(i, 96) - 0.5)), new THREE.Vector3(sc * 1.3, sc, sc)));
    }
    if (rocks.length) {
      const im = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(0.5, 0), mat('#9a8d78', { flat: true }), rocks.length);
      rocks.forEach((m, k) => im.setMatrixAt(k, m));
      im.castShadow = im.receiveShadow = true;
      root.add(im);
    }

    // roots off the soil ring
    const roots = [];
    for (let i = 0; i < ISLE_N; i += 5) {
      if (hash(i, 31) < 0.45) continue;
      const [x, y, z] = body.rings[1][i], len = 1.5 + hash(i, 32) * 4;
      const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y - len / 2, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler((hash(i, 33) - 0.5) * 0.5, 0, (hash(i, 34) - 0.5) * 0.5)), new THREE.Vector3(1, len, 1));
      roots.push(m);
    }
    if (roots.length) {
      const im = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05, 0.11, 1, 5), mat('#5a3d22'), roots.length);
      roots.forEach((m, i) => im.setMatrixAt(i, m));
      root.add(im);
    }

    // islets: small islands round it at different heights, bobbing
    world.islets = [];
    const R = Math.max(I.hx, I.hz);
    for (let k = 0; k < ISLETS; k++) {
      const t = hash(k, 51) * Math.PI * 2, ux = Math.cos(t), uz = Math.sin(t);
      const dist = rimAlong(ux, uz) + 7 + hash(k, 52) * 12, size = 1.8 + hash(k, 53) * 2.4;
      const cx = I.cx + ux * dist, cz = I.cz + uz * dist, y = -6 + hash(k, 54) * 9;
      const small = [];
      for (let i = 0; i < 24; i++) { const a = i / 24 * Math.PI * 2; small.push({ ux: Math.cos(a), uz: Math.sin(a), e: size * (0.85 + hash(i + k * 31, 55) * 0.3) }); }
      const isl = taper(small, 0, 0, size / 10, 0, 0);
      const g = new THREE.Group();
      g.add(new THREE.Mesh(isl.geo, rock));
      const top = new THREE.Mesh(new THREE.CircleGeometry(size * 1.02, 24).rotateX(-Math.PI / 2), mat('#6a9a40'));
      top.position.y = 0.02;
      g.add(top);
      if (size > 2.6) {
        g.add(mesh(new THREE.CylinderGeometry(0.06, 0.1, 0.7, 7).translate(0, 0.35, 0), mat(TIMBER)));
        const crown = mesh(lumpySphere(0.5, 1), mat('#4f8a34'), 0, 1.0, 0);
        g.add(crown);
      }
      g.position.set(cx + OX, y, cz + OZ);
      root.add(g);
      world.islets.push({ g, y, phase: hash(k, 56) * 6 });
    }

    // the pond, a stream to the rim, and the waterfall over it
    world.falls = [];
    if (lay.pond && lay.fall) {
      const P = lay.pond, F = lay.fall;
      const px = P.x + OX, pz = P.z + OZ, py = heightAt(px, pz);
      const water = waterMaterial(0.94);
      const pond = new THREE.Mesh(new THREE.CircleGeometry(P.r, 28).rotateX(-Math.PI / 2), water);
      pond.position.set(px, py + 0.06, pz);
      root.add(pond);
      for (let i = 0; i < 10; i++) {
        const a = i / 10 * Math.PI * 2, rx = px + Math.cos(a) * (P.r + 0.2), rz = pz + Math.sin(a) * (P.r + 0.2);
        root.add(mesh(new THREE.DodecahedronGeometry(0.28 + hash(i, 61) * 0.15, 0), mat('#a39882', { flat: true }), rx, heightAt(rx, rz) + 0.1, rz));
      }
      // stream: a strip from the pond's edge to the rim, laid on the ground
      const sx0 = px + F.ux * P.r, sz0 = pz + F.uz * P.r, sx1 = F.x + OX, sz1 = F.z + OZ;
      const segs = 8, spos = [];
      const nxv = -F.uz * 0.45, nzv = F.ux * 0.45;
      for (let i = 0; i < segs; i++) {
        const t0 = i / segs, t1 = (i + 1) / segs;
        const p0 = [sx0 + (sx1 - sx0) * t0, sz0 + (sz1 - sz0) * t0], p1 = [sx0 + (sx1 - sx0) * t1, sz0 + (sz1 - sz0) * t1];
        const y0 = heightAt(p0[0], p0[1]) + 0.05, y1 = heightAt(p1[0], p1[1]) + 0.05;
        spos.push(p0[0] - nxv, y0, p0[1] - nzv, p1[0] - nxv, y1, p1[1] - nzv, p1[0] + nxv, y1, p1[1] + nzv,
          p0[0] - nxv, y0, p0[1] - nzv, p1[0] + nxv, y1, p1[1] + nzv, p0[0] + nxv, y0, p0[1] + nzv);
      }
      const sgeo = new THREE.BufferGeometry();
      sgeo.setAttribute('position', new THREE.Float32BufferAttribute(spos, 3));
      sgeo.computeVertexNormals();
      root.add(new THREE.Mesh(sgeo, new THREE.MeshLambertMaterial({ color: '#5fb6d8', emissive: '#1f5f7a', emissiveIntensity: 0.55, side: THREE.DoubleSide })));
      // the fall: a ribbon off the rim into the clouds, its texture scrolling down
      const tex = fallTexture();
      world.textures.push(tex);
      const H = 22 * depthScale;
      const fall = new THREE.Mesh(new THREE.PlaneGeometry(1.5, H, 1, 8).translate(0, -H / 2, 0), new THREE.MeshBasicMaterial({
        map: tex, color: '#ffffff', transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false,
      }));
      fall.position.set(sx1 + F.ux * 0.5, heightAt(sx1, sz1) - 0.2, sz1 + F.uz * 0.5);
      fall.rotation.y = Math.atan2(F.ux, F.uz);
      root.add(fall);
      const mist = new THREE.Sprite(new THREE.SpriteMaterial({ map: shared.glowTex, color: '#ffffff', depthWrite: false, opacity: 0.5 }));
      mist.position.set(fall.position.x + F.ux * 0.3, fall.position.y - 0.3, fall.position.z + F.uz * 0.3);
      mist.scale.setScalar(2.4);
      root.add(mist);
      world.falls.push({ tex });
    }

    // clouds: a layer below the island and a few high ones beside it, drifting east
    world.clouds = [];
    const ctex = cloudTexture();
    world.textures.push(ctex);
    for (let k = 0; k < CLOUDS; k++) {
      const high = k < 8;
      const t = hash(k, 71) * Math.PI * 2, rr = high ? R * (1.25 + hash(k, 72) * 0.6) : R * hash(k, 72) * 1.9;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: ctex, color: high ? '#ffffff' : '#f2f8ff', transparent: true, depthWrite: false,
        opacity: high ? 0.75 : 0.55 + hash(k, 73) * 0.3, fog: true }));
      const sc = (high ? 9 : 12) + hash(k, 74) * 14;
      sp.scale.set(sc, sc * 0.55, 1);
      const x = I.cx + Math.cos(t) * rr + OX, z = I.cz + Math.sin(t) * rr + OZ, y = high ? 3 + hash(k, 75) * 6 : -12 - hash(k, 76) * 24;
      sp.position.set(x, y, z);
      root.add(sp);
      world.clouds.push({ sp, speed: 0.0006 + hash(k, 77) * 0.0008, span: R * 2.4, cx: I.cx + OX });
    }
  }

  function cloudTexture() {
    const c = canvas(128, 64), g = c.getContext('2d');
    for (let i = 0; i < 14; i++) {
      const x = 22 + hash(i, 1) * 84, y = 26 + hash(i, 2) * 18, r = 12 + hash(i, 3) * 18;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, 'rgba(255,255,255,.9)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  function fallTexture() {
    const c = canvas(32, 128), g = c.getContext('2d');
    g.fillStyle = 'rgba(214,238,255,.78)'; g.fillRect(0, 0, 32, 128);
    for (let i = 0; i < 40; i++) {
      const x = hash(i, 11) * 32, y = hash(i, 12) * 128, l = 10 + hash(i, 13) * 40;
      g.fillStyle = `rgba(255,255,255,${0.35 + hash(i, 14) * 0.5})`;
      g.fillRect(x, y, 1.5, l); g.fillRect(x, y - 128, 1.5, l);
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1, 3);
    return t;
  }
  function portalTexture() {
    const c = canvas(128), g = c.getContext('2d');
    const grd = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.5, 'rgba(190,150,255,.6)'); grd.addColorStop(1, 'rgba(120,80,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 3;
    for (let i = 0; i < 5; i++) {
      g.beginPath();
      for (let t = 0; t < 40; t++) { const a = i * 1.256 + t * 0.12, r = t * 1.5; g.lineTo(64 + Math.cos(a) * r, 64 + Math.sin(a) * r); }
      g.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /** Smoke puffs over one chimney: SMOKE sprites cycling up, growing and fading. */
  const SMOKE = 6;
  function addSmoke(at, shade) {
    for (let i = 0; i < SMOKE; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: shared.glowTex, color: new THREE.Color(shade, shade, shade), transparent: true, depthWrite: false, opacity: 0 }));
      world.root.add(sp);
      world.smoke.push({ sp, at, phase: i / SMOKE });
    }
  }

  /** Per frame in town: sites rise with their work done, smoke drifts, flames flicker, the crystal turns. */
  function animateTown(dt, state) {
    const lo = typeof Lodging !== 'undefined' ? Lodging : null;
    for (const s of world.sites || []) {
      const inst = state && lo ? lo.find(state, s.id) : null;
      const f = inst && inst.site ? Math.min(1, inst.site.done / inst.site.work) : 0;
      s.rise.scale.y = 0.04 + 0.96 * f;
    }
    const t = clockMs * 0.00025;
    for (const p of world.smoke || []) {
      const k = (t + p.phase) % 1;
      p.sp.position.set(p.at.x + k * 0.9, p.at.y + k * 2.4, p.at.z - k * 0.3);
      p.sp.scale.setScalar(0.35 + k * 1.1);
      p.sp.material.opacity = 0.42 * Math.sin(Math.PI * k);
    }
    for (const fl of world.flames || []) {
      const k = 0.85 + 0.15 * Math.sin(clockMs * 0.013 + fl.seed) + 0.08 * Math.sin(clockMs * 0.031 + fl.seed * 3);
      fl.f.scale.set(1, k, 1);
      fl.glow.material.opacity = 0.45 * k;
    }
    if (world.crystal) {
      world.crystal.mesh.rotation.y += dt * 0.0005;
      world.crystal.mesh.position.y = world.crystal.y + Math.sin(clockMs * 0.0012) * 0.15;
      world.crystal.halo.material.opacity = 0.45 + 0.12 * Math.sin(clockMs * 0.002);
    }
    if (world.portal) {
      world.portal.disc.rotation.z -= dt * 0.0012;
      world.portal.glow.material.opacity = 0.45 + 0.15 * Math.sin(clockMs * 0.003);
    }
    for (const it of world.islets || []) it.g.position.y = it.y + Math.sin(clockMs * 0.0006 + it.phase) * 0.6;
    for (const f of world.falls || []) f.tex.offset.y += dt * 0.0009;
    if (world.ripples) { world.ripples.offset.x += dt * 0.00004; world.ripples.offset.y += dt * 0.000027; }
    for (const c of world.clouds || []) {
      c.sp.position.x += dt * c.speed;
      if (c.sp.position.x > c.cx + c.span) c.sp.position.x -= c.span * 2;
    }
  }

  function signTexture(icon, text) {
    const c = canvas(text ? 320 : 64, 64), g = c.getContext('2d');
    g.textBaseline = 'middle';
    if (text) {
      g.font = '600 26px system-ui, sans-serif';
      const w = Math.min(316, g.measureText(text).width + 70);
      g.fillStyle = 'rgba(30,22,14,.72)';
      g.beginPath(); g.roundRect(160 - w / 2, 8, w, 48, 24); g.fill();
      g.font = '30px system-ui, "Segoe UI Emoji", sans-serif';
      g.textAlign = 'left';
      g.fillText(icon, 160 - w / 2 + 10, 33);
      g.font = '600 26px system-ui, sans-serif';
      g.fillStyle = '#f2ead8';
      g.fillText(text, 160 - w / 2 + 52, 33);
    } else {
      g.fillStyle = 'rgba(30,22,14,.72)';
      g.beginPath(); g.arc(32, 32, 29, 0, Math.PI * 2); g.fill();
      g.font = '34px system-ui, "Segoe UI Emoji", sans-serif';
      g.textAlign = 'center';
      g.fillText(icon, 32, 35);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.userData.aspect = c.width / c.height;
    return t;
  }

  /** An icosphere pushed in and out by noise, with sphere normals so it shades round. */
  function lumpySphere(r, detail) {
    const g = new THREE.IcosahedronGeometry(r, detail);
    const p = g.getAttribute('position'), nArr = new Float32Array(p.count * 3), v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const k = 1 + (vnoise(v.x * 6 + 3, v.y * 6 + v.z * 4) - 0.5) * 0.35;
      v.normalize();
      nArr[i * 3] = v.x; nArr[i * 3 + 1] = v.y; nArr[i * 3 + 2] = v.z;
      v.multiplyScalar(r * k);
      p.setXYZ(i, v.x, v.y, v.z);
    }
    g.setAttribute('normal', new THREE.BufferAttribute(nArr, 3));
    return g;
  }

  /**
   * Water for the town's pools: blue and a little emissive so it reads in shade, its ripples (a
   * normal map that animateTown slides along) catching the sun. One map per build, shared.
   */
  function waterMaterial(opacity = 1) {
    if (!world.ripples) { world.ripples = rippleTexture(); world.textures.push(world.ripples); }
    return new THREE.MeshPhongMaterial({ color: '#4fa6cf', emissive: '#1a5570', emissiveIntensity: 0.45, specular: '#ffffff', shininess: 90,
      normalMap: world.ripples, normalScale: new THREE.Vector2(0.28, 0.28), transparent: opacity < 1, opacity });
  }

  /** Drifting specks of light round the view centre: pollen outdoors, spores underground. */
  function buildMotes(st, textures) {
    const N = 220, g = new THREE.BufferGeometry(), p = new Float32Array(N * 3), seedArr = new Float32Array(N);
    for (let i = 0; i < N; i++) { p[i * 3] = hash(i, 1) * 30 - 15; p[i * 3 + 1] = hash(i, 2) * 3; p[i * 3 + 2] = hash(i, 3) * 30 - 15; seedArr[i] = hash(i, 4) * 100; }
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    const tex = radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)', 32);
    textures.push(tex);
    const pts = new THREE.Points(g, new THREE.PointsMaterial({
      color: st.mote, size: 0.12, map: tex, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    pts.userData = { base: p.slice(), seed: seedArr };
    pts.frustumCulled = false;
    return pts;
  }

  // ---------- actors ----------

  function disposeActor(o) {
    scene.remove(o.group);
    if (o.fig) { scene.remove(o.fig.group); o.fig.dispose(); o.fig = null; }
    o.group.traverse(c => {
      if (c.material) c.material.dispose();
      if (c.geometry && c.geometry !== BB_GEO && !Object.values(shared).includes(c.geometry)) c.geometry.dispose();
    });
    if (o.ownTex) for (const t of o.ownTex) t.dispose();
  }

  function enemyTexture(a) {
    const key = a.sprite && a.sprite.complete && a.sprite.naturalWidth ? a.sprite : (a.icon || '•');
    let t = enemyTex.get(key);
    if (t) return t;
    let n;
    if (typeof key === 'string') {
      const c = canvas(96), g = c.getContext('2d');
      g.font = '72px system-ui, "Segoe UI Emoji", sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'bottom';
      g.fillText(key, 48, 92);
      n = new THREE.CanvasTexture(c);
    } else {
      n = new THREE.Texture(key);
      n.needsUpdate = true;
    }
    n.colorSpace = THREE.SRGBColorSpace;
    n.anisotropy = 4;
    t = { n, key, aspect: typeof key === 'string' ? 1 : key.naturalWidth / key.naturalHeight };
    enemyTex.set(key, t);
    return t;
  }

  function label(text, colour = '#e8e8f0') {
    const c = canvas(256, 48), g = c.getContext('2d');
    g.font = '600 26px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const w = Math.min(250, g.measureText(text).width + 22);
    g.fillStyle = 'rgba(14,12,20,.62)';
    g.beginPath(); g.roundRect(128 - w / 2, 6, w, 36, 18); g.fill();
    g.fillStyle = colour;
    g.fillText(text, 128, 25);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /** One walk sheet per character: the LPC layers composited once (9 frames x 4 rows). */
  function walkSheet(layers) {
    const c = canvas(LPC.FRAME * LPC.FRAMES, LPC.FRAME * 4), g = c.getContext('2d');
    for (const l of layers) g.drawImage(l.img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    return t;
  }

  // ---------- 3D figures (figure3d.js) ----------
  // A character with an LPC record is drawn as a Figure3D model when figure3d.js is loaded; the
  // walk-sheet billboard stays as the fallback. A model takes about 10 ms to build, so models are
  // built until FIG_BUDGET_MS of the frame is spent (in practice one per frame) and the rest keep
  // their billboard until a later frame. A model is rebuilt when Figure3D.signature changes
  // (selections or equipped items), checked once a second.
  const FIG_BUDGET_MS = 8;
  let figBudget = 0, fx = null;
  const figPatch = (m) => patchMaterial(m, U);
  const effects = () => fx || (typeof Figure3D !== 'undefined' ? (fx = Figure3D.effects(scene)) : null);

  function figureFor(o, ch) {
    if (o.fig && clockMs - (o.sigAt || 0) > 1000) {
      o.sigAt = clockMs;
      if (Figure3D.signature(ch) !== o.figSig) { scene.remove(o.fig.group); o.fig.dispose(); o.fig = null; }
    }
    if (o.fig) return o.fig;
    if (!ch || !ch.selections || typeof Figure3D === 'undefined' || performance.now() > figBudget) return null;
    o.fig = Figure3D.create(ch, { patch: figPatch, fog: fogU });
    o.figSig = Figure3D.signature(ch);
    o.sigAt = clockMs;
    o.fig.onEmit((e) => figEmit(e));
    scene.add(o.fig.group);
    if (o.body) { o.group.remove(o.body); o.body.material.dispose(); o.body = null; }
    if (o.label) o.label.position.y = o.fig.height + 0.22;
    o.shadow.scale.setScalar(o.fig.height * 0.75);
    return o.fig;
  }

  /** Projectiles and work sparks a figure emits at the moment of release or impact. */
  function figEmit(e) {
    const f = effects();
    if (!f) return;
    if ((e.type === 'arrow' || e.type === 'orb') && e.to) f.shoot(e.type, e.from, e.to);
    else if (e.type === 'sparks') f.burst(e.from, 'spark');
    else if (e.type === 'thud') f.burst(e.from, 'dust');
  }

  // ---------- fight playback ----------
  // field.js resolves a skirmish when it opens and plays its log out over its duration (sk.at is
  // the number of lines played). Each newly played line is read for the names of the actors in that
  // skirmish: the first name found is the one acting, a later name is the one acted on, and the verb
  // picks the reaction (hits / takes a hit -> hit, dodges / is missed -> dodge, parries -> block,
  // falls / goes down -> fall, heals -> heal). Lines that arrive in one step are spread across that
  // step. A line that names one actor ("X takes a hit", the plain resolver) gets its nearest
  // opponent as the attacker. Nothing here is written back to the field.
  const skSeen = new WeakMap();
  const blows = [];                   // { at: clockMs, fn }

  function playSkirmishes(s) {
    const step = (typeof MissionTypes !== 'undefined' && MissionTypes.TIME) ? MissionTypes.TIME.stepMs : 200;
    for (const sk of s.skirmishes || []) {
      let seen = skSeen.get(sk);
      if (seen == null) { seen = sk.at || 0; skSeen.set(sk, seen); }
      if ((sk.at || 0) <= seen) continue;
      const lines = sk.log.slice(seen, sk.at);
      skSeen.set(sk, sk.at);
      lines.forEach((line, i) => blows.push({ at: clockMs + (i + 0.3 * Math.random()) * step / lines.length, fn: () => blow(sk, line) }));
    }
    for (let i = blows.length - 1; i >= 0; i--) if (blows[i].at <= clockMs) { const b = blows[i]; blows.splice(i, 1); b.fn(); }
  }

  /** Actors named in a line, in the order they appear. Shared names go to a random bearer. */
  function namesIn(line, cast) {
    const byName = new Map();
    for (const a of cast) {
      for (const n of new Set([a.label, a.name, a.char && a.char.name, a.fighter && a.fighter.name])) {
        if (!n || n.length < 2) continue;
        if (!byName.has(n)) byName.set(n, []);
        byName.get(n).push(a);
      }
    }
    const names = [...byName.keys()].sort((p, q) => q.length - p.length), taken = [], out = [];
    for (const n of names) {
      for (let i = line.indexOf(n); i >= 0; i = line.indexOf(n, i + 1)) {
        if (taken.some(([s0, e0]) => i < e0 && i + n.length > s0)) continue;
        taken.push([i, i + n.length]);
        const who = byName.get(n);
        out.push({ a: who[Math.floor(Math.random() * who.length)], at: i });
      }
    }
    return out.sort((p, q) => p.at - q.at);
  }

  function blow(sk, line) {
    const found = namesIn(line, [...sk.ours, ...sk.theirs]);
    if (!found.length) return;
    const actor = found[0].a, target = found.find(f => f.a !== actor);
    const t = target ? target.a : null, L = line.toLowerCase();
    // a fall is the last blow: the nearest opponent swings it, then the target goes down
    if (/falls|goes down|is down|is dead/.test(L)) return strike(nearestFoe(sk, actor), actor, 'fall');
    if (/takes a hit/.test(L)) return strike(nearestFoe(sk, actor), actor, 'hit');
    if (!t) return;
    if (/parries/.test(L)) { strike(t, actor, 'block'); setTimeout(() => strike(actor, t, 'hit'), 260); return; }
    if (/dodges|is missed/.test(L)) return strike(actor, t, 'dodge');
    if (/heals/.test(L)) { const o = objs.get(actor.id); if (o && o.fig) o.fig.trigger('cast', {}); react(t, 'heal', actor, 450); return; }
    if (/\bhits\b|→| for \d/.test(line)) strike(actor, t, 'hit');
  }

  function nearestFoe(sk, a) {
    const foes = (sk.ours.includes(a) ? sk.theirs : sk.ours).filter(f => f.alive);
    let best = null, bd = Infinity;
    for (const f of foes) { const d = (f.x - a.x) ** 2 + (f.y - a.y) ** 2; if (d < bd) { bd = d; best = f; } }
    return best;
  }

  /** Where an actor is drawn, at a fraction of its height. */
  function pointOf(a, k = 0.6) {
    const o = objs.get(a.id);
    if (!o) return null;
    const p = o.group.position, h = o.fig ? o.fig.height : (o.h || 1);
    return new THREE.Vector3(p.x, p.y + h * k, p.z);
  }

  /** The attacker swings (a figure) or lunges (a billboard); the target reacts when the blow lands. */
  function strike(att, tgt, outcome) {
    if (!tgt) return;
    if (!att && outcome === 'fall') return fell(tgt);
    const oa = att && objs.get(att.id), at = pointOf(tgt);
    let delay = 120;
    if (oa && oa.fig && at) {
      oa.fig.trigger('strike', { at });
      delay = oa.fig.cls === 'bow' || oa.fig.cls === 'staff' ? 760 : 360;
    } else if (oa && oa.kind === 'enemy' && at) {
      const p = oa.group.position, dx = at.x - p.x, dz = at.z - p.z, l = Math.hypot(dx, dz) || 1;
      oa.kick = { t0: clockMs, dx: dx / l * 0.3, dz: dz / l * 0.3 };
      delay = 170;
    }
    react(tgt, outcome, att, delay);
  }

  function react(tgt, outcome, att, delay) {
    setTimeout(() => {
      const o = objs.get(tgt.id);
      if (!o) return;
      const from = att ? pointOf(att) : null;
      if (outcome === 'fall') fell(tgt);
      else if (o.fig) o.fig.trigger(outcome, { from: from ? { x: from.x, z: from.z } : null });
      else if (o.kind === 'enemy') {
        if (outcome === 'hit') o.flashAt = clockMs;
        if (outcome === 'dodge') o.kick = { t0: clockMs, dx: (Math.random() - 0.5) * 0.4, dz: (Math.random() - 0.5) * 0.4 };
      }
      const f = effects(), p = pointOf(tgt, outcome === 'heal' ? 0.5 : 0.62);
      if (f && p && (outcome === 'hit' || outcome === 'fall' || outcome === 'heal')) f.burst(p, outcome === 'heal' ? 'heal' : 'hit');
    }, delay);
  }

  function fell(a) {
    const o = objs.get(a.id);
    if (!o) return;
    if (o.fig) o.fig.trigger('fall', {});
    else if (o.kind === 'enemy' && !o.downAt) o.downAt = clockMs;
  }

  /** Field input for a squad member's figure: fight stance toward the nearest foe while engaged. */
  function driveSquad(a, o, x, y, z, dt) {
    const sk = a.engaged;
    let face = null;
    if (sk && sk.ours) {
      const foe = nearestFoe(sk, a);
      if (foe && foe.rx != null) face = { x: foe.rx + 0.5, z: foe.ry + 0.5 };
    }
    const frac = a.fighter ? a.fighter.hp / a.fighter.maxHp : a.maxHp ? a.hp / a.maxHp : 1;
    o.fig.update(dt / 1000, {
      x, y, z, mode: sk ? 'fight' : 'idle', face, props: 'gear',
      energy: Math.min(1, 0.35 + frac), hurt: frac < 0.4 || a.ringColour === Tokens.RINGS.hurt,
    });
  }

  /**
   * Town input for a walker's figure, from facts the town already has: at their post (or their
   * construction site) they work with the job's tool; off shift beside the friend they came to
   * find, they talk; hurt or spent at their own lodging, they sit; heading out on a mission they
   * carry their weapon. Energy is stamina and morale (condition.js).
   */
  function folkInput(sim, a, x, y, z) {
    const c = a.char || {};
    const arrived = !!a.spot && Math.hypot(a.spot.x - a.x, a.spot.y - a.y) < 0.6;
    const co = typeof Condition !== 'undefined' && c.cond ? Condition : null;
    const spent = co ? co.isSpent(c) : false;
    let mode = 'idle', job = null, props = 'none', face = null;
    const jobPlot = c.job && typeof TownMap !== 'undefined' ? TownMap.plotForJob(sim.map, c.job) : null;
    if (c.mission) props = 'gear';
    else if (c.building && a.goal === 'bed:' + c.building) { job = 'building'; props = 'tool'; if (arrived) mode = 'work'; }
    else if (jobPlot && a.goal === jobPlot.key) { job = c.job; props = c.job === 'training' ? 'none' : 'tool'; if (arrived) mode = 'work'; }
    else if (arrived && a.goal && a.goal.startsWith('bed:') && (c.injured > 0 || spent)) mode = 'sit';
    else if (a.near != null) {
      const f = sim.folk.find(b => b.id === a.near && !b.gone);
      if (f && Math.hypot(f.x - a.x, f.y - a.y) < 2.4) { mode = 'talk'; face = { x: f.x + 0.5, z: f.y + 0.5 }; }
    }
    const energy = co ? 0.6 * co.staminaFrac(c) + 0.4 * co.moraleFrac(c) : 1;
    return { x, y, z, mode, job, face, props, energy, hurt: c.injured > 0 };
  }

  function makeActor(a) {
    const group = new THREE.Group();
    const o = { group, kind: null, ownTex: [] };
    const shadow = new THREE.Mesh(shared.discGeo, new THREE.MeshBasicMaterial({ map: shared.shadowTex, transparent: true, depthWrite: false }));
    shadow.position.y = 0.03;
    group.add(shadow);
    o.shadow = shadow;
    if (a.role === 'structure') {
      o.kind = 'structure';
      const hut = new THREE.Group();
      const base = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.9, 1.3).translate(0, 0.45, 0), patchMaterial(new THREE.MeshLambertMaterial({ color: '#b07a40' }), U));
      const roof = new THREE.Mesh(new THREE.ConeGeometry(1.15, 0.8, 4).rotateY(Math.PI / 4).translate(0, 1.3, 0), patchMaterial(new THREE.MeshLambertMaterial({ color: '#8a3f2a' }), U));
      hut.add(base, roof);
      group.add(hut);
      o.hut = hut; o.mats = [base.material, roof.material];
      shadow.scale.setScalar(3);
    } else if (a.side === 'ours' && a.role !== 'squad') {
      o.kind = 'ally';
      const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.22, 0).translate(0, 0.9, 0), new THREE.MeshLambertMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 0.4 }));
      group.add(gem);
      o.gem = gem;
    } else if (a.role === 'squad') {
      o.kind = 'squad';
      o.ring = new THREE.Mesh(shared.ringGeo, new THREE.MeshBasicMaterial({ color: Tokens.RINGS.squad, transparent: true, opacity: 0.9, depthWrite: false }));
      o.ring.position.y = 0.04;
      group.add(o.ring);
      o.facing = 2; o.stride = 0;
    } else {
      o.kind = 'enemy';
    }
    if (a.role !== 'structure') {
      const nameTex = label(a.label || a.name || '', a.side === 'ours' ? '#e8eeff' : '#ffd9cf');
      o.ownTex.push(nameTex);
      o.label = billboard(nameTex, fogU, { w: 1.2, h: 0.225, lift: 0.6 });
      o.label.visible = a.role === 'squad';
      group.add(o.label);
    }
    scene.add(group);
    return o;
  }

  // the squad walks one distance field and would stand in a single spot: fan them out at draw
  // time, keyed on the actor so nobody shifts sideways when somebody else drops
  const FAN = 0.55;
  const fanOf = (a) => { const i = a.id % 6; return [((i % 3) - 1) * FAN, (Math.floor(i / 3) - 0.5) * FAN]; };

  function syncActors(s, dt) {
    const live = s.actors.filter(a => (a.alive || a.subdued) && !a.extracted);
    const ids = new Set();
    figBudget = performance.now() + FIG_BUDGET_MS;
    const ours = live.filter(a => a.role === 'squad');
    const faceX = ours.length ? ours.reduce((n, a) => n + a.x, 0) / ours.length : s.map.w / 2;
    for (const a of live) {
      ids.add(a.id);
      const prevX = a.rx, prevY = a.ry;
      FieldView.follow(a, dt);
      let o = objs.get(a.id);
      if (!o) { o = makeActor(a); objs.set(a.id, o); }
      let x = a.rx + 0.5, z = a.ry + 0.5;
      if (o.kind === 'squad') { const [fx, fz] = fanOf(a); x += fx; z += fz; }
      const gy = world.heightAt(x, z);
      o.group.position.set(x, gy, z);
      const lit = s.seen[a.y * s.map.w + a.x] ? 1 : 0.38;

      if (o.kind === 'structure') {
        const dead = a.done || !a.alive;
        o.mats[0].color.set(dead ? '#6a6670' : '#b07a40');
        o.mats[1].color.set(dead ? '#4a4650' : '#8a3f2a');
        continue;
      }
      if (o.kind === 'ally') {
        const col = a.role === 'ward' ? Tokens.RINGS.ward : a.role === 'prize' ? Tokens.RINGS.carrier : Tokens.RINGS.ally;
        o.gem.material.color.set(col); o.gem.material.emissive.set(col);
        o.gem.rotation.y += dt * 0.002;
        o.gem.position.y = Math.sin(clockMs * 0.003 + a.id) * 0.08;
        continue;
      }
      if (o.kind === 'enemy') {
        const tex = enemyTexture(a);
        if (!o.body || o.texKey !== tex.key) {
          if (o.body) { o.group.remove(o.body); o.body.material.dispose(); }
          const h = (Tokens.GRADE_SIZE[a.grade] || Tokens.GRADE_SIZE.basic) * 0.78;
          o.body = billboard(tex.n, fogU, { w: h * tex.aspect, h, foot: 0.03 });
          o.texKey = tex.key;
          o.h = h;
          o.group.add(o.body);
          o.shadow.scale.setScalar(Math.max(0.8, h * tex.aspect * 0.55));
          o.label.position.y = h + 0.12;
        }
        // the art faces left: mirror it when it stands left of the squad, so it faces them
        const mirror = Tokens.facesRight(a.x, faceX);
        const u = o.body.material.uniforms;
        u.uUv.value.set(mirror ? 1 : 0, 0, mirror ? -1 : 1, 1);
        // fight playback: a lunge toward the target, a flash when hit, a slump when down
        if (o.kick) {
          const k = (clockMs - o.kick.t0) / 320;
          if (k >= 1) o.kick = null;
          else { const e = Math.sin(Math.PI * k); o.group.position.x += o.kick.dx * e; o.group.position.z += o.kick.dz * e; }
        }
        const fl = o.flashAt ? Math.max(0, 1 - (clockMs - o.flashAt) / 260) : 0;
        u.uTint.value.setRGB(1 + fl * 1.4, 1 + fl * 0.5, 1 + fl * 0.4);
        const down = o.downAt ? Math.min(1, (clockMs - o.downAt) / 500) : 0;
        u.uSize.value.y = o.h * (1 - 0.45 * down);
        u.uOpacity.value = (a.subdued ? 0.5 : 1) * lit * (1 - 0.35 * down);
        o.shadow.material.opacity = lit;
        continue;
      }
      if (o.ring) o.ring.material.color.set(a.ringColour || Tokens.RINGS.squad);
      // squad: a 3D model when the character has an LPC record (FieldView.faces keeps the one it
      // generated for a squad without a character as a.lookChar)
      if (figureFor(o, a.char && a.char.selections ? a.char : a.lookChar)) { driveSquad(a, o, x, gy, z, dt); continue; }
      // ...else a walking LPC billboard, row chosen by the direction of travel on screen
      if (a.layers && !o.body) {
        const sheet = walkSheet(a.layers);
        o.ownTex.push(sheet);
        o.body = billboard(sheet, fogU, { w: 1.55, h: 1.55, foot: 3 / 64 });
        o.group.add(o.body);
        o.label.position.y = 1.5;
      }
      if (!o.body) continue;
      stepWalk(o, prevX == null ? 0 : a.rx - prevX, prevY == null ? 0 : a.ry - prevY, dt);
      const hurt = a.ringColour === Tokens.RINGS.down;
      o.body.material.uniforms.uTint.value.setScalar(hurt ? 0.55 : 1);
    }
    // Gone from the field. The dead stay where they fell for a while: a squad model plays its fall
    // and lies there for CORPSE_MS, then dissolves; a monster's billboard slumps and fades.
    const CORPSE_MS = 4500, FADE_MS = 700;
    for (const [id, o] of objs) {
      if (ids.has(id)) continue;
      if (!o.goneAt) {
        const a = s.actors.find(x => x.id === id);
        if (a && !a.alive && !a.extracted && (o.fig || o.kind === 'enemy')) {
          o.goneAt = clockMs;
          o.group.children.forEach(c => { if (c !== o.body) c.visible = false; });
          if (o.fig) o.fig.trigger('fall', {});
          else if (!o.downAt) o.downAt = clockMs;
        }
      }
      if (o.goneAt) {
        const left = o.fig ? CORPSE_MS : 0, k = (clockMs - o.goneAt - left) / FADE_MS;
        if (k < 1) {
          if (o.fig) {
            const p = o.fig.group.position;
            o.fig.update(dt / 1000, { x: p.x, y: p.y, z: p.z, mode: 'down' });
            o.fig.opacity = 1 - Math.max(0, k);
          } else if (o.body) {
            const u = o.body.material.uniforms;
            u.uSize.value.y = o.h * 0.55 * (1 - 0.5 * Math.max(0, k));
            u.uOpacity.value = 0.65 * (1 - Math.max(0, k));
          }
          continue;
        }
      }
      disposeActor(o);
      objs.delete(id);
    }
  }

  /** Pick the walk row from the direction of travel and step the frame by distance walked. */
  function stepWalk(o, dx, dz, dt) {
    const dist = Math.hypot(dx, dz);
    if (dist > 0.0004 * dt) {
      o.facing = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 3 : 1) : (dz > 0 ? 2 : 0);
      o.stride += dist;
      o.frame = 1 + (Math.floor(o.stride / 0.11) % 8);
    } else o.frame = 0;
    o.body.material.uniforms.uUv.value.set(o.frame / LPC.FRAMES, 1 - (o.facing + 1) / 4, 1 / LPC.FRAMES, 1 / 4);
  }

  /**
   * The town's people, from TownLife.onFoot(). They are drawn where the town sim puts them
   * (it moves them smoothly already), with the rim colour townview.js would give them.
   */
  function syncFolk(folk, dt, { hoverId = null, ringFor = null, sim = null } = {}) {
    const ids = new Set();
    figBudget = performance.now() + FIG_BUDGET_MS;
    for (const a of folk) {
      ids.add(a.id);
      let o = objs.get(a.id);
      if (!o) { o = makeActor({ role: 'squad', side: 'ours', label: a.label }); objs.set(a.id, o); }
      const x = a.x + 0.5, z = a.y + 0.5;
      const dx = o.px == null ? 0 : x - o.px, dz = o.pz == null ? 0 : z - o.pz;
      o.px = x; o.pz = z;
      const gy = world.heightAt(x, z);
      o.group.position.set(x, gy, z);
      if (sim && figureFor(o, a.char)) o.fig.update(dt / 1000, folkInput(sim, a, x, gy, z));
      else if (a.layers && !o.body) {
        const sheet = walkSheet(a.layers);
        o.ownTex.push(sheet);
        o.body = billboard(sheet, fogU, { w: 1.55, h: 1.55, foot: 3 / 64 });
        o.group.add(o.body);
        o.label.position.y = 1.5;
      }
      const hovered = hoverId != null && a.id === hoverId;
      o.ring.material.color.set(hovered ? '#ffd740' : (ringFor ? ringFor(a) : Tokens.RINGS.squad));
      o.ring.scale.setScalar(hovered ? 1.35 : 1);
      o.hovered = hovered;
      if (o.body && !o.fig) stepWalk(o, dx, dz, dt);
    }
    for (const [id, o] of objs) if (!ids.has(id)) { disposeActor(o); objs.delete(id); }
  }

  // ---------- per frame ----------

  function updateSeen(s) {
    const { seenData, seenTex, map } = world;
    for (let i = 0; i < seenData.length; i++) {
      seenData[i] = s.seen[i] || !map.passable(i % map.w, Math.floor(i / map.w)) ? 255 : 0;
    }
    seenTex.needsUpdate = true;
  }

  function updateOverlay(s) {
    const { ctx, canvas: oc, tex } = world.overlay;
    ctx.clearRect(0, 0, oc.width, oc.height);
    FieldView.drawZones(ctx, s, { scale: PX, ox: 0, oy: 0 });
    tex.needsUpdate = true;
  }

  function updatePortal(s) {
    const pt = s.portal, col = world.column;
    if (!pt || pt.x == null || (pt.state !== 'open' && pt.state !== 'opening')) { col.visible = false; return; }
    const r = Math.max(0.6, (pt.r || 3) * 0.55), x = pt.x + 0.5, z = pt.y + 0.5;
    col.visible = true;
    col.position.set(x, world.heightAt(x, z), z);
    col.scale.set(r, 1, r);
    const frac = pt.state === 'open' ? 1 : (pt.progress || 0) / MissionTypes.PORTAL.open;
    col.material.opacity = (0.25 + 0.3 * frac) * (0.85 + 0.15 * Math.sin(clockMs * 0.004));
    col.rotation.y += 0.003;
  }

  function updateMotes(dt) {
    const m = world.motes, p = m.geometry.getAttribute('position'), { base, seed } = m.userData;
    const t = clockMs * 0.001;
    for (let i = 0; i < p.count; i++) {
      const sd = seed[i];
      let y = (base[i * 3 + 1] + t * 0.12 + sd) % 3;
      p.setXYZ(i, base[i * 3] + Math.sin(t * 0.5 + sd) * 0.6, y + 0.2, base[i * 3 + 2] + Math.cos(t * 0.4 + sd) * 0.6);
    }
    p.needsUpdate = true;
    m.position.set(camState.tx, world.heightAt(camState.tx, camState.tz), camState.tz);
  }

  /** How far back the camera sits to fit the whole map, before any zoom. */
  function fitDistance(aspect, w, h) {
    const vf = FOV * Math.PI / 180, hf = 2 * Math.atan(Math.tan(vf / 2) * aspect);
    const dW = w / (2 * Math.tan(hf / 2));
    const dH = (h * Math.sin(PITCH) + 1.5 * Math.cos(PITCH)) / (2 * Math.tan(vf / 2));
    return Math.max(dW, dH) * 1.04;
  }

  function placeCamera(want, dt) {
    const aspect = sizeW / sizeH, vf = FOV * Math.PI / 180, hf = 2 * Math.atan(Math.tan(vf / 2) * aspect);
    // the whole-view frames world.focus (the town's built-up box) when there is one, else the map
    const box = world.focus || { x0: 0, z0: 0, x1: world.w, z1: world.h };
    const fit = fitDistance(aspect, box.x1 - box.x0, box.z1 - box.z0), zoom = Math.max(1, want.zoom || 1), d = fit / zoom;
    const halfW = d * Math.tan(hf / 2), halfD = d * Math.tan(vf / 2) / Math.sin(PITCH);
    // a zoomed view may look past the edge by `pad` tiles (the town's forest edge)
    const pad = world.fam === 'town' ? 6 : 0;
    const axis = (span, half, centre, dflt) => centre == null ? dflt : span <= half * 2 ? span / 2
      : Math.max(half - pad, Math.min(span + pad - half, centre + 0.5));
    const tx = axis(world.w, halfW, want.cx, (box.x0 + box.x1) / 2), tz = axis(world.h, halfD, want.cy, (box.z0 + box.z1) / 2);
    if (camState.tx == null) { camState.tx = tx; camState.tz = tz; camState.d = d; }
    const k = 1 - Math.exp(-dt / 70);
    camState.tx += (tx - camState.tx) * k;
    camState.tz += (tz - camState.tz) * k;
    camState.d += (d - camState.d) * k;
    const ty = zoom > 1.5 ? world.heightAt(camState.tx, camState.tz) * 0.6 : 0;
    camera.position.set(camState.tx, ty + camState.d * Math.sin(PITCH), camState.tz + camState.d * Math.cos(PITCH));
    camera.lookAt(camState.tx, ty, camState.tz);
    scene.fog.near = camState.d * 0.85;
    scene.fog.far = camState.d * (world.fam === 'under' ? 1.9 : 2.8);
    fogU.fogNear.value = scene.fog.near; fogU.fogFar.value = scene.fog.far;
    return { fit, zoom, d: camState.d };
  }

  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit = new THREE.Vector3();
  /** Pointer event -> map tile, through the camera and onto the ground (two passes for height). */
  function tileAt(ev) {
    if (!world) return null;
    const r = cv.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    plane.constant = 0;
    if (!ray.ray.intersectPlane(plane, hit)) return null;
    for (let i = 0; i < 3; i++) {                 // raised floors: walk the hit onto the ground's height
      plane.constant = -world.heightAt(hit.x, hit.z);
      ray.ray.intersectPlane(plane, hit);
    }
    return { x: hit.x - 0.5, y: hit.z - 0.5 };
  }

  function render(s, want = {}, dt = 16) {
    if (!s || !s.map) return null;
    clockMs += dt;
    U.uTime.value = clockMs / 1000;
    fitSize();
    if (!world || world.map !== s.map) build(s.map, FieldView.FAMILY[s.map.archetype] || 'outdoor');
    if (clockMs - lastSeenAt > 150 || lastSeenAt < 0) { updateSeen(s); lastSeenAt = clockMs; }
    if (clockMs - lastOverlayAt > 100 || lastOverlayAt < 0) { updateOverlay(s); lastOverlayAt = clockMs; }
    const cam = placeCamera(want, dt);
    syncActors(s, dt);
    playSkirmishes(s);
    if (fx) fx.update(dt / 1000);
    updatePortal(s);
    updateMotes(dt);
    const ours = s.actors.filter(a => a.role === 'squad' && a.alive && !a.extracted && a.rx != null);
    U.uFocus.value.w = 0;
    if (ours.length) {
      const lx = ours.reduce((n, a) => n + a.rx, 0) / ours.length + 0.5, lz = ours.reduce((n, a) => n + a.ry, 0) / ours.length + 0.5;
      const gy = world.heightAt(lx, lz);
      if (world.lantern) world.lantern.position.set(lx, gy + 2.2, lz);
      const spread = Math.max(...ours.map(a => Math.hypot(a.rx + 0.5 - lx, a.ry + 0.5 - lz)));
      U.uFocus.value.set(lx, gy + 0.7, lz, cam.zoom >= 2 ? Math.min(2.2, 1.2 + spread * 0.5) : 0);
    }
    const pxPerUnit = sizeLabels(cam, (o) => o.kind === 'squad' || cam.zoom >= 3.5);
    return draw(cam, pxPerUnit);
  }

  /** Names at a fixed size on screen, and only once the view is close enough for them to help. */
  function sizeLabels(cam, show) {
    const pxPerUnit = cv.height / (2 * cam.d * Math.tan(FOV * Math.PI / 360));
    const lh = 15 * renderer.getPixelRatio() / pxPerUnit;
    for (const o of objs.values()) {
      if (!o.label) continue;
      o.label.visible = cam.zoom >= 2.2 && show(o);
      o.label.material.uniforms.uSize.value.set(lh * 256 / 48, lh);
    }
    return pxPerUnit;
  }

  function draw(cam, pxPerUnit) {
    // figure outlines are a fixed width in drawing-buffer pixels
    if (typeof Figure3D !== 'undefined') Figure3D.viewport(cv.width, cv.height, 1.2 * renderer.getPixelRatio());
    renderer.clear();
    renderer.render(scene, camera);
    renderer.render(vigScene, vigCam);
    return { scale: pxPerUnit, scaleY: pxPerUnit * Math.sin(PITCH), fit: cam.fit, zoom: cam.zoom, tileAt };
  }

  /** Friendships as threads on the ground between the two people, as townview.js draws them. */
  function drawThreads(knots) {
    const { ctx, canvas: oc, tex } = world.overlay;
    ctx.clearRect(0, 0, oc.width, oc.height);
    ctx.lineWidth = PX * 0.12;
    ctx.lineCap = 'round';
    for (const k of knots) {
      ctx.strokeStyle = k.tier.color;
      ctx.globalAlpha = 0.75;
      ctx.setLineDash(k.v < 0 ? [PX * 0.3, PX * 0.3] : []);
      ctx.beginPath();
      ctx.moveTo((k.a.x + 0.5) * PX, (k.a.y + 0.5) * PX);
      ctx.lineTo((k.b.x + 0.5) * PX, (k.b.y + 0.5) * PX);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    tex.needsUpdate = true;
  }

  /**
   * Draw the town. `sim` is TownLife.current(), `knots` TownLife.knots(state). `want` is
   * townview.js's camera ({ zoom, cx, cy }); the return value is a view like render()'s.
   */
  function renderTown(sim, knots, want = {}, dt = 16, opts = {}) {
    if (!sim || !sim.map) return null;
    fitSize();
    clockMs += dt;
    U.uTime.value = clockMs / 1000;
    const map = sim.map;
    if (!world || world.map !== map) {
      build(map, 'town', (x, y) => (x >= 0 && y >= 0 && x < map.w && y < map.h) ? map.at(x, y) : T.FLOOR);
      // Room south of the island for the cliff under its near rim. A view centred on a box shows less
      // ground in front of the centre than past it (the bottom of the view looks PITCH + FOV / 2
      // down): `front` is that share of the box's depth when the depth sets the distance
      // (fitDistance). The box reaches south until the rim and the cliff's first 20 tiles fit.
      const b = map.layout.bounds, vf = FOV * Math.PI / 180, low = PITCH + vf / 2;
      const front = (Math.cos(PITCH) - Math.sin(PITCH) / Math.tan(low)) * Math.sin(PITCH) / (2 * Math.tan(vf / 2)) * 1.04;
      const room = (20 / Math.tan(low) + (0.5 - front) * (b.z1 - b.z0)) / (0.5 + front);
      world.focus = { x0: b.x0 + map.ox, x1: b.x1 + map.ox, z0: b.z0 + map.oz, z1: b.z1 + map.oz + room };
    }
    if (clockMs - lastOverlayAt > 66 || lastOverlayAt < 0) { drawThreads(knots || []); lastOverlayAt = clockMs; }
    const cam = placeCamera(want, dt);
    syncFolk(sim.folk ? sim.folk.filter(a => !a.gone) : [], dt, Object.assign({ sim }, opts));
    if (fx) fx.update(dt / 1000);
    updateMotes(dt);
    animateTown(dt, opts.state || null);
    U.uRoofCut.value = sstep(2.2, 3.2, cam.zoom);
    const pxPerUnit = sizeLabels(cam, (o) => o.hovered || cam.zoom >= 3);
    // signs: a fixed size on screen; the name joins the icon once a tile is big enough to read
    const sh = 22 * renderer.getPixelRatio() / pxPerUnit, named = pxPerUnit >= 14 * renderer.getPixelRatio();
    for (const sg of world.signs || []) {
      const tex = named ? sg.full : sg.icon, u = sg.mesh.material.uniforms;
      if (u.map.value !== tex) u.map.value = tex;
      u.uSize.value.set(sh * tex.userData.aspect, sh);
    }
    return draw(cam, pxPerUnit);
  }

  function dispose() {
    disposeWorld();
    if (fx) { fx.dispose(); fx = null; }
    for (const t of enemyTex.values()) t.n.dispose();
    enemyTex.clear();
    for (const v of Object.values(shared)) v.dispose();
    vigMat.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }

  return { canvas: cv, render, renderTown, tileAt, dispose };
}

// The page loads three.js as an ES module (it ships no plain script build since r160) and puts
// it on window. Until it lands window.THREE is undefined; if it fails it is null, and callers
// draw the flat map instead. A page that wants the 3D view includes this snippet:
//   <script>import('./vendor/three.module.min.js').then(m => { window.THREE = m; },
//     () => { window.THREE = null; });</script>
const pending = () => typeof window.THREE === 'undefined';

window.World3D = { create, ready, pending, STYLE };
})();
