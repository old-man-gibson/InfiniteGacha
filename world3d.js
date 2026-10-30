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
// between floors, and a plaza with a banner on each floor.
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
    fog: '#c6dbe0', mote: '#fff6c8', vignette: 0.38,
  },
  under: {
    hill: 1.1, roll: 0.06, blocks: 0,
    grass: ['#5a5163', '#6a6072'], dry: '#6e6478', moss: '#4c5a5a', dirt: '#5c5260', road: '#655a69',
    rock: '#5a4f64', top: '#3d3448',
    sky: '#a39ee0', groundLight: '#3a3040', sun: '#c4ccff', sunI: 0.95, hemiI: 1.15,
    fog: '#17131f', mote: '#9fe8ff', vignette: 0.6, lantern: '#ffb06a',
  },
};

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
function patchMaterial(mat, U, { overlay = false, fade = false, roof = false } = {}) {
  if (overlay) mat.defines = Object.assign(mat.defines || {}, { WORLD_OVERLAY: '' });
  if (fade) mat.defines = Object.assign(mat.defines || {}, { OCCLUDER_FADE: '' });
  if (roof) mat.defines = Object.assign(mat.defines || {}, { ROOF_FADE: '' });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uSeen = U.uSeen;
    sh.uniforms.uOverlay = U.uOverlay;
    sh.uniforms.uMapSize = U.uMapSize;
    sh.uniforms.uFocus = U.uFocus;
    sh.uniforms.uRoofCut = U.uRoofCut;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorld3;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 w3 = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          w3 = instanceMatrix * w3;
        #endif
        vWorld3 = (modelMatrix * w3).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWorld3;
        uniform sampler2D uSeen;
        uniform sampler2D uOverlay;
        uniform vec2 uMapSize;
        uniform vec4 uFocus;
        uniform float uRoofCut;`)
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
    for (let gz = 0; gz < nz; gz++) for (let gx = 0; gx < nx; gx++) {
      const px = gx / SUB - MARGIN, pz = gz / SUB - MARGIN, k = gz * nx + gx;
      const m = field(wallG, px, pz), rd = roadAt ? roadAt(px, pz) : field(roadG, px, pz);
      let h = (fbm(px * 0.22 + so, pz * 0.22) - 0.5) * st.roll * 2 * (1 - m);
      if (st.hill) h += Math.pow(m, 0.8) * st.hill * (0.7 + 0.6 * fbm(px * 0.3 + so, pz * 0.3 + 40)) + m * m * (fbm(px * 1.4, pz * 1.4 + so) - 0.3) * 0.5;
      h -= rd * 0.04;
      if (map.layout) h += BaseLayout.heightAt(map.layout, px - map.ox, pz - map.oz);
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
    for (let gz = 0; gz < nz - 1; gz++) for (let gx = 0; gx < nx - 1; gx++) {
      const a = gz * nx + gx, b = a + 1, c = a + nx, d = c + 1;
      idx[n++] = a; idx[n++] = c; idx[n++] = b;
      idx[n++] = b; idx[n++] = c; idx[n++] = d;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();

    // vertex colour: ground by noise, dirt on roads, rock on slopes, darker tops, and a band of
    // darkening where the ground meets a wall so the floor sits INTO the rise
    const nrm = geo.getAttribute('normal');
    const col = new Float32Array(nx * nz * 3);
    const C = (hex) => new THREE.Color(hex);
    const gA = C(st.grass[0]), gB = C(st.grass[1]), dry = C(st.dry), moss = C(st.moss), dirt = C(st.dirt),
      road = C(st.road), rock = C(st.rock), top = C(st.top);
    const c = new THREE.Color(), tmp = new THREE.Color();
    for (let k = 0; k < nx * nz; k++) {
      const px = pos[k * 3], pz = pos[k * 3 + 2], m = wallness[k], rd = roadness[k];
      const slope = 1 - nrm.getY(k);
      c.lerpColors(gA, gB, fbm(px * 0.18 + so, pz * 0.18));
      const patch = sstep(0.58, 0.72, fbm(px * 0.11 + 90, pz * 0.11 + so));
      c.lerp(dry, patch * 0.55);
      c.lerp(moss, sstep(0.55, 0.75, vnoise(px * 0.5, pz * 0.5 + so)) * 0.35);
      tmp.lerpColors(dirt, road, fbm(px * 0.6, pz * 0.6));
      c.lerp(tmp, sstep(0.3, 0.75, rd));
      if (map.layout) c.lerp(rock, sstep(0.3, 0.65, slope));      // town: a platform's edge is rock
      if (st.hill) {
        c.lerp(top, sstep(0.55, 0.95, m) * 0.85);
        c.lerp(rock, sstep(0.16, 0.42, slope) * sstep(0.02, 0.15, m));
      }
      const ao = 1 - 0.32 * sstep(0.0, 0.3, m) * (1 - sstep(0.35, 0.8, m)) * (st.hill ? 1 : 1.4);
      col[k * 3] = c.r * ao; col[k * 3 + 1] = c.g * ao; col[k * 3 + 2] = c.b * ao;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const groundTex = paintTexture(fam === 'built' ? 'flag' : fam === 'outdoor' || fam === 'town' ? 'grass' : 'stone');
    textures.push(groundTex);
    const terrain = new THREE.Mesh(geo, patchMaterial(new THREE.MeshLambertMaterial({ vertexColors: true, map: groundTex }), U, { overlay: true }));
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
    scene.background = new THREE.Color(st.fog);
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

  // ---------- scenery ----------

  function buildProps(map, st, fam, heightAt, root, so, at) {
    if (fam === 'town') return buildTown(map, heightAt, root, so);
    const W = map.w + 2 * MARGIN, H = map.h + 2 * MARGIN;
    const isWall = (x, y) => at(x, y) === T.WALL;
    const openNear = (x, y) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !isWall(x + dx, y + dy) && map.at(x + dx, y + dy) !== undefined && x + dx >= 0 && y + dy >= 0 && x + dx < map.w && y + dy < map.h);
    const lists = { canopy: [], trunk: [], rock: [], bush: [], block: [], cap: [], crate: [], barrel: [], crystal: [], post: [] };
    const M4 = (x, y, z, sx, sy, sz, ry = 0) =>
      new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry), new THREE.Vector3(sx, sy, sz));

    const tree = (x, y, wx, wz, r2) => {
      const s = 0.75 + r2 * 0.65, gy = heightAt(wx, wz), hue = hash(x, y * 13);
      lists.trunk.push({ m: M4(wx, gy, wz, s, s, s) });
      const blobs = [[0, 0.95, 0, 1], [0.22, 0.72, 0.12, 0.72], [-0.2, 0.75, -0.1, 0.68]];
      for (const [ox, oy, oz, bs] of blobs) {
        lists.canopy.push({ m: M4(wx + ox * s, gy + oy * s, wz + oz * s, bs * s, bs * s * 0.9, bs * s, r2 * 6), c: hue });
      }
    };
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
    const trunkGeo = new THREE.CylinderGeometry(0.06, 0.1, 0.7, 7).translate(0, 0.35, 0);
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
    const leafA = new THREE.Color('#3f7a2c'), leafB = new THREE.Color('#79a83a'), leafC = new THREE.Color('#a9a43c');
    inst(canopyGeo, lam({ color: '#ffffff' }, true), lists.canopy, (e) => {
      const c = new THREE.Color().lerpColors(leafA, leafB, e.c);
      return e.c > 0.9 ? c.lerp(leafC, 0.6) : c;
    });
    inst(trunkGeo, lam({ color: '#6b4a2e' }), lists.trunk);
    inst(rockGeo, lam({ color: fam === 'under' ? '#5b5266' : '#9a8b73', flatShading: true }), lists.rock);
    const bushA = new THREE.Color('#3d6e2a'), bushB = new THREE.Color('#5d8f34');
    inst(canopyGeo, lam({ color: '#ffffff' }), lists.bush, (e) => new THREE.Color().lerpColors(bushA, bushB, e.c));
    const stoneA = new THREE.Color(st.stone || '#b0a088'), stoneB = stoneA.clone().multiplyScalar(0.84);
    inst(blockGeo, lam({ color: '#ffffff', map: (() => { const t = paintTexture('stone'); world.textures.push(t); return t; })() }, true), lists.block,
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
  const ROOFS = ['#b5532f', '#c46a3c', '#4d6c9a', '#5f7d3c', '#7a5233', '#8e4a3a'];
  const TIMBER = '#6b4a2e', STONE = '#b9ad97';

  function buildTown(map, heightAt, root, so) {
    const lay = map.layout, OX = map.ox, OZ = map.oz;
    const mats = new Map();
    /** One material per look. Roof materials fade with uRoofCut. */
    const mat = (color, { roof = false, emissive = null, ei = 0.8, double = false, flat = false } = {}) => {
      const key = [color, roof, emissive, ei, double, flat].join('|');
      if (!mats.has(key)) {
        const m = new THREE.MeshLambertMaterial({ color, flatShading: flat, side: double ? THREE.DoubleSide : THREE.FrontSide });
        if (emissive) { m.emissive.set(emissive); m.emissiveIntensity = ei; }
        mats.set(key, patchMaterial(m, U, { roof }));
      }
      return mats.get(key);
    };
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

    // ----- pieces -----

    /** Gable roof with the ridge along local x. Slopes (roof material) and gable ends (wall material). */
    function gable(len, span, h, oh, roofM, wallM) {
      const g = new THREE.Group();
      const L = len / 2 + oh, S = span / 2 + oh, y0 = h * oh / S, X = len / 2, s2 = span / 2;
      const slopes = new THREE.BufferGeometry();
      slopes.setAttribute('position', new THREE.Float32BufferAttribute([
        -L, 0, S, L, 0, S, L, h, 0, -L, 0, S, L, h, 0, -L, h, 0,
        L, 0, -S, -L, 0, -S, -L, h, 0, L, 0, -S, -L, h, 0, L, h, 0,
      ], 3));
      slopes.computeVertexNormals();
      const ends = new THREE.BufferGeometry();
      ends.setAttribute('position', new THREE.Float32BufferAttribute([
        X, y0, s2, X, y0, -s2, X, h, 0,
        -X, y0, -s2, -X, y0, s2, -X, h, 0,
      ], 3));
      ends.computeVertexNormals();
      g.add(mesh(slopes, roofM), mesh(ends, wallM));
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
    function addWindow(g, x, y, z, ry, glow = false) {
      const w = new THREE.Group();
      w.add(mesh(new THREE.BoxGeometry(0.54, 0.62, 0.04), mat('#efe6d2')));
      const pane = mesh(new THREE.PlaneGeometry(0.42, 0.5), mat('#2b3240', { emissive: '#ffc06a', ei: glow ? 0.95 : 0.18 }), 0, 0, 0.025);
      w.add(pane);
      w.position.set(x, y, z);
      w.rotation.y = ry;
      g.add(w);
    }
    /**
     * Walls with a door gap on +z, a plank floor, timber corners, windows, and (unless `bare`)
     * a gable roof and chimneys. Returns { group, top, chimneys: [Vector3 local] }.
     */
    function house(w, d, o) {
      const g = new THREE.Group(), t = 0.18, H = o.wallH, storeys = o.storeys || 1;
      const wallM = mat(o.plaster), timM = mat(o.timber || TIMBER);
      g.add(mesh(new THREE.PlaneGeometry(w - 0.3, d - 0.3).rotateX(-Math.PI / 2), mat(o.floor || '#9c7a55'), 0, 0.04, 0));
      g.add(mesh(box(w, H, t), wallM, 0, 0, -d / 2 + t / 2));
      g.add(mesh(box(t, H, d), wallM, -w / 2 + t / 2, 0, 0));
      g.add(mesh(box(t, H, d), wallM, w / 2 - t / 2, 0, 0));
      const side = Math.max(0.1, (w - 1.1) / 2);
      g.add(mesh(box(side, H, t), wallM, -(w / 2 - side / 2), 0, d / 2 - t / 2));
      g.add(mesh(box(side, H, t), wallM, w / 2 - side / 2, 0, d / 2 - t / 2));
      if (H > 1.3) g.add(mesh(box(1.1, H - 1.25, t), wallM, 0, 1.25, d / 2 - t / 2));
      g.add(mesh(new THREE.BoxGeometry(1.24, 0.1, t + 0.08), timM, 0, 1.25, d / 2 - t / 2));
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(mesh(box(0.16, H + 0.04, 0.16), timM, sx * (w / 2 - 0.06), 0, sz * (d / 2 - 0.06)));
      for (let k = 1; k <= storeys; k++) {
        const y = H * k / storeys - 0.05;
        for (const sz of [-1, 1]) g.add(mesh(new THREE.BoxGeometry(w + 0.04, 0.1, 0.06), timM, 0, y, sz * (d / 2 + 0.01)));
        for (const sx of [-1, 1]) g.add(mesh(new THREE.BoxGeometry(0.06, 0.1, d + 0.04), timM, sx * (w / 2 + 0.01), y, 0));
      }
      for (let k = 0; k < storeys; k++) {
        const y = H * (k + 0.55) / storeys, n = Math.max(1, Math.floor(w / 2.3));
        for (let i = 0; i < n; i++) {
          const wx = (i - (n - 1) / 2) * (w / n);
          addWindow(g, wx, y, -d / 2 - 0.02, Math.PI, o.glow);
          if (k > 0 || Math.abs(wx) > 1.0) addWindow(g, wx, y, d / 2 + 0.02, 0, o.glow);
        }
        if (d >= 2.6) for (const sx of [-1, 1]) addWindow(g, sx * (w / 2 + 0.02), y, 0, sx * Math.PI / 2, o.glow);
      }
      const chimneys = [];
      if (!o.bare) {
        const roofM = mat(o.roof, { roof: true, double: true });
        g.add(roofOver(w, d, H, o.roofH, o.oh == null ? 0.3 : o.oh, roofM, mat(o.plaster, { roof: true })));
        for (let i = 0; i < (o.chimneys || 0); i++) {
          const cx = (i ? -1 : 1) * w * 0.27, cz = -d * 0.18, ch = H + o.roofH * 0.85 + 0.35;
          g.add(mesh(box(0.38, ch, 0.38), mat(STONE, { roof: true }), cx, 0, cz));
          chimneys.push(new THREE.Vector3(cx, ch + 0.1, cz));
        }
      }
      return { group: g, top: H + (o.bare ? 0 : o.roofH), chimneys };
    }
    /** A low surround along the footprint edge with a gap at the door: fence, hedge or stone. */
    function surround(w, d, kind, rnd) {
      const g = new THREE.Group();
      const h = kind === 'stone' ? 0.55 : 0.75;
      const m = mat(kind === 'stone' ? STONE : kind === 'hedge' ? '#4f7f33' : '#8a6542');
      const edges = [
        [-w / 2, -d / 2, w / 2, -d / 2], [-w / 2, d / 2, -0.6, d / 2], [0.6, d / 2, w / 2, d / 2],
        [-w / 2, -d / 2, -w / 2, d / 2], [w / 2, -d / 2, w / 2, d / 2],
      ];
      for (const [ax, az, bx, bz] of edges) {
        const len = Math.hypot(bx - ax, bz - az), mx = (ax + bx) / 2, mz = (az + bz) / 2, ry = Math.atan2(bz - az, bx - ax);
        if (kind === 'fence') {
          for (let k = 0; k <= Math.round(len); k++) {
            const f = len ? k / Math.round(len || 1) : 0;
            g.add(mesh(box(0.1, h, 0.1), m, ax + (bx - ax) * f, 0, az + (bz - az) * f));
          }
          for (const y of [0.3, 0.6]) g.add(mesh(new THREE.BoxGeometry(len, 0.06, 0.05), m, mx, y, mz, -ry));
        } else {
          g.add(mesh(new THREE.BoxGeometry(len + 0.2, h, kind === 'hedge' ? 0.45 : 0.3).translate(0, h / 2, 0), m, mx, 0, mz, -ry));
        }
      }
      return g;
    }
    /** A flame: emissive cone and a glow sprite, flickered by animateTown. */
    function flame(g, x, y, z, colour = '#ffb347', size = 1) {
      const f = mesh(new THREE.ConeGeometry(0.16 * size, 0.42 * size, 8).translate(0, 0.21 * size, 0), mat(colour, { emissive: colour, ei: 1.6 }), x, y, z);
      f.castShadow = false;
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
      const plaster = pick(rnd, PLASTER), roof = pick(rnd, ROOFS);
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
        case 'bunkhouse': return house(w, d, { wallH: 1.4, roofH: 0.9, plaster: '#9a7550', roof: '#6e4a2c', bare });
        case 'longhouse': return house(w, d, { wallH: 1.05, roofH: 1.8, oh: 0.5, plaster: '#8a6a48', roof: '#c9a55a', chimneys: 1, bare });
        case 'barracks': {
          const h = house(w, d, { wallH: 1.65, roofH: 1.1, plaster: STONE, roof: '#4d5f7a', floor: '#8f8a80', bare });
          h.group.add(mesh(box(0.08, 3.2, 0.08), mat(TIMBER), w / 2 + 0.4, 0, d / 2));
          h.group.add(mesh(new THREE.PlaneGeometry(0.7, 0.5), mat(roof, { double: true }), w / 2 + 0.77, 2.85, d / 2));
          return h;
        }
        case 'cottages': {
          // a terrace of two cottages under two roofs of different colours
          const h = house(w, d, { wallH: 1.45, roofH: 1.2, plaster, roof, bare: true });
          if (!bare) {
            const r2 = pick(rnd, ROOFS.filter(c => c !== roof));
            for (const [sx, rc] of [[-1, roof], [1, r2]]) {
              const half = roofOver(w / 2, d, 1.45, 1.2, 0.25, mat(rc, { roof: true, double: true }), mat(plaster, { roof: true }));
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
          const h = house(w, d, { wallH: 2.5, storeys: 2, roofH: 1.4, plaster: '#efe6d6', roof: '#4d6c9a', chimneys: 2, bare });
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
        case 'alehouse': return tavern(house(w, d, { wallH: 1.4, roofH: 1.2, oh: 0.45, plaster: '#c8a878', timber: '#5a3a22', roof: '#b8944a', chimneys: 1, glow: true, bare }), w, d, '#c9963f', bare, 0);
        case 'inn': return tavern(house(w, d, { wallH: 2.4, storeys: 2, roofH: 1.3, plaster: '#efe3c8', roof: '#a8452f', chimneys: 2, glow: true, bare }), w, d, '#5f8fc9', bare, 0);
        case 'salon': return tavern(house(w, d, { wallH: 1.8, roofH: 1.0, plaster: '#f4efe4', timber: '#8a8f9a', roof: '#4d6c9a', glow: true, bare }), w, d, '#a45fc9', bare, 2);
        case 'crownhall': return tavern(house(w, d, { wallH: 2.8, storeys: 2, roofH: 1.5, plaster: STONE, timber: '#7a6a4a', roof: '#3f4a6b', chimneys: 2, glow: true, bare }), w, d, '#e0b84a', bare, 4);
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
          put(house(bw, bd, { wallH: 1.5, roofH: 1.1, plaster: '#a8452f', timber: '#e8dcc0', roof: '#5a3a28' }), -w / 2 + bw / 2 + 0.4, -d / 2 + bd / 2 + 0.4);
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
          put(house(1.6, 1.6, { wallH: 1.2, roofH: 0.6, plaster: '#8a6a48', roof: '#5f7d3c' }), -w / 2 + 1.1, -d / 2 + 1.1);
          break;
        }
        case 'kitchen': {
          put(house(w - 0.4, d - 0.4, { wallH: 1.5, roofH: 1.2, plaster: pick(rnd, PLASTER), roof: '#b5532f', chimneys: 1 }), 0, 0);
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
          put(house(w - 0.4, d - 0.4, { wallH: 1.5, roofH: 1.0, plaster: pick(rnd, PLASTER), roof: pick(rnd, ROOFS) }), 0, 0);
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

    // ----- structures -----
    for (const s of lay.structures) {
      const rnd = BaseLayout.mulberry32(BaseLayout.hashStr(s.key + ':look', lay.seed));
      const x = s.x + OX, z = s.z + OZ;
      const built = s.kind === 'work' ? workshop(s, rnd) : s.kind === 'altar' ? altar(s, rnd) : s.site ? site(s, rnd) : lodging(s, rnd);
      const g = built.group;
      g.position.set(x, heightAt(x, z), z);
      g.rotation.y = s.rot;
      root.add(g);
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

    // ----- the floors: retaining walls at each platform's foot, stairs between floors, plazas -----
    floorsOf(lay, OX, OZ, heightAt, root, mat, mesh, box);

    // ----- the square: fountain and lamps -----
    {
      const gy = heightAt(OX, OZ), stone = mat('#cfc4ad');
      const f = new THREE.Group();
      f.add(mesh(new THREE.CylinderGeometry(1.15, 1.25, 0.35, 28, 1, true).translate(0, 0.175, 0), mat('#cfc4ad', { double: true })));
      const water = mesh(new THREE.CircleGeometry(1.1, 28).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: '#5fb6d8', emissive: '#1f5f7a', emissiveIntensity: 0.6 }), 0, 0.3, 0);
      f.add(water, mesh(new THREE.CylinderGeometry(0.14, 0.2, 0.9, 12).translate(0, 0.45, 0), stone), mesh(new THREE.CylinderGeometry(0.42, 0.18, 0.18, 16).translate(0, 0.95, 0), stone));
      f.position.set(OX, gy, OZ);
      root.add(f);
      for (let i = 0; i < 6; i++) {
        const a = (i + 0.5) / 6 * Math.PI * 2, lx = OX + Math.sin(a) * (lay.square.r + 0.4), lz = OZ - Math.cos(a) * (lay.square.r + 0.4);
        const lamp = new THREE.Group();
        lamp.add(mesh(box(0.08, 1.9, 0.08), mat('#3a3530')));
        lamp.add(mesh(new THREE.BoxGeometry(0.26, 0.3, 0.26), mat('#ffd38a', { emissive: '#ffb04a', ei: 1.2 }), 0, 2.0, 0));
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: shared.glowTex, color: '#ffc46a', blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.45 }));
        glow.position.y = 2.0; glow.scale.setScalar(1.4);
        lamp.add(glow);
        lamp.position.set(lx, heightAt(lx, lz), lz);
        root.add(lamp);
      }
    }

    // ----- the crystal, north of the square -----
    {
      const cx = lay.crystal.x + OX, cz = lay.crystal.z + OZ, gy = heightAt(cx, cz);
      const base = new THREE.Group();
      base.add(mesh(new THREE.CylinderGeometry(1.35, 1.6, 0.35, 8).translate(0, 0.175, 0), mat('#b3aa98', { flat: true })));
      base.add(mesh(new THREE.CylinderGeometry(0.9, 1.05, 0.3, 8).translate(0, 0.5, 0), mat('#cfc4ad', { flat: true })));
      for (let i = 0; i < 6; i++) {
        const a = i / 6 * Math.PI * 2;
        const st = mesh(box(0.35, 1.1 + (i % 2) * 0.4, 0.28), mat('#a39882', { flat: true }), Math.sin(a) * 2.5, 0, Math.cos(a) * 2.5, a);
        st.rotation.z = (i % 3 - 1) * 0.06;
        base.add(st);
      }
      base.position.set(cx, gy, cz);
      root.add(base);
      const crystal = mesh(new THREE.OctahedronGeometry(0.9, 0).scale(0.75, 2.1, 0.75), mat('#bfe8ff', { emissive: '#4aa8ff', ei: 0.9, flat: true }), cx, gy + 3.0, cz);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: shared.glowTex, color: '#8fd4ff', blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.55 }));
      halo.scale.setScalar(5.5);
      halo.position.set(cx, gy + 3.0, cz);
      const light = new THREE.PointLight('#9fdcff', 9, 12, 1.4);
      light.position.set(cx, gy + 2.6, cz);
      root.add(crystal, halo, light);
      world.crystal = { mesh: crystal, halo, y: gy + 3.0 };
    }

    // ----- the gate on the road out -----
    {
      const gx = lay.gate.x + OX, gz = lay.gate.z + OZ, gy = heightAt(gx, gz), wood = mat(TIMBER);
      for (const dx of [-2.0, 2.0]) root.add(mesh(new THREE.BoxGeometry(0.34, 2.8, 0.34).translate(0, 1.4, 0), wood, gx + dx, gy, gz));
      root.add(mesh(new THREE.BoxGeometry(4.6, 0.3, 0.38), wood, gx, gy + 2.7, gz));
      root.add(mesh(new THREE.PlaneGeometry(0.8, 1.0), mat('#7a5cc0', { double: true }), gx, gy + 2.05, gz + 0.2));
    }

    // ----- trees past the extent, and a little green inside it -----
    const trunks = [], canopy = [], bushes = [], blooms = [];
    const M4 = (x, y, z, sx, sy, sz, ry = 0) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry), new THREE.Vector3(sx, sy, sz));
    const near = (x, z) => lay.structures.some(s => Math.hypot(x - OX - s.x, z - OZ - s.z) < s.r + 1.3)
      || Math.hypot(x - OX - lay.crystal.x, z - OZ - lay.crystal.z) < 3.4 || Math.hypot(x - OX, z - OZ) < lay.square.r + 1.2;
    const road = layoutRoads(lay, OX, OZ);
    const onPlatform = (x, z) => { for (let k = 1; k <= lay.top; k++) if (BaseLayout.floorSdf(lay, k, x - OX, z - OZ) > -2.2) return true; return false; };
    // forest starts 1.5 tiles past the built-up box and thickens over the next 5
    const bx = lay.bounds;
    const outside = (x, z) => Math.hypot(Math.max(bx.x0 - (x - OX), 0, (x - OX) - bx.x1), Math.max(bx.z0 - (z - OZ), 0, (z - OZ) - bx.z1));
    for (let ty = -MARGIN; ty < map.h + MARGIN; ty++) for (let tx = -MARGIN; tx < map.w + MARGIN; tx++) {
      const r1 = hash(tx * 3 + so, ty * 7), r2 = hash(tx * 11, ty * 5 + so), r3 = hash(tx + 99, ty - so);
      const x = tx + 0.5 + (r2 - 0.5) * 0.6, z = ty + 0.5 + (r3 - 0.5) * 0.6;
      if (road(x, z) > 0.05 || onPlatform(x, z)) continue;
      const out = (outside(x, z) - 1.5) / 5;
      const gy = heightAt(x, z);
      if (out > 0 ? r1 < Math.min(1, out) * 0.6 : (!near(x, z) && r1 < 0.015)) {
        const sc = 0.8 + r2 * 0.7, hue = hash(tx, ty * 13);
        trunks.push(M4(x, gy, z, sc, sc, sc));
        for (const [ox, oy, oz, bs] of [[0, 0.95, 0, 1], [0.22, 0.72, 0.12, 0.72], [-0.2, 0.75, -0.1, 0.68]]) {
          canopy.push({ m: M4(x + ox * sc, gy + oy * sc, z + oz * sc, bs * sc, bs * sc * 0.9, bs * sc, r2 * 6), c: hue });
        }
      } else if (out <= 0 && !near(x, z) && r1 > 0.94) {
        const bs = 0.28 + r2 * 0.2;
        bushes.push({ m: M4(x, gy + bs * 0.35, z, bs, bs * 0.8, bs), c: r3 });
        if (r3 < 0.6) for (let k = 0; k < 3; k++) blooms.push({ m: M4(x + (hash(tx + k, ty) - 0.5) * 0.7, gy + 0.08, z + (hash(tx, ty + k) - 0.5) * 0.7, 1, 1, 1), c: hash(tx * k, ty) });
      }
    }
    const instanced = (geo, m, list, colourOf = null) => {
      if (!list.length) return;
      const im = new THREE.InstancedMesh(geo, m, list.length);
      list.forEach((e, i) => { im.setMatrixAt(i, e.m || e); if (colourOf) im.setColorAt(i, colourOf(e)); });
      im.castShadow = im.receiveShadow = true;
      root.add(im);
    };
    const leafA = new THREE.Color('#3f7a2c'), leafB = new THREE.Color('#79a83a'), leafC = new THREE.Color('#a9a43c');
    const canopyGeo = lumpySphere(0.48, 2);
    instanced(new THREE.CylinderGeometry(0.06, 0.1, 0.7, 7).translate(0, 0.35, 0), mat(TIMBER), trunks);
    instanced(canopyGeo, mat('#ffffff'), canopy, (e) => { const c = new THREE.Color().lerpColors(leafA, leafB, e.c); return e.c > 0.9 ? c.lerp(leafC, 0.6) : c; });
    instanced(canopyGeo, mat('#ffffff'), bushes, (e) => new THREE.Color().lerpColors(new THREE.Color('#3d6e2a'), new THREE.Color('#5d8f34'), e.c));
    const BLOOM = ['#e86a9a', '#f2d04a', '#9a6ae8', '#ffffff'].map(c => new THREE.Color(c));
    instanced(new THREE.SphereGeometry(0.07, 6, 4), mat('#ffffff'), blooms, (e) => BLOOM[Math.floor(e.c * BLOOM.length) % BLOOM.length]);
  }

  /**
   * The platforms' masonry. For each open floor: the outline of its platform at the cliff's foot
   * (BaseLayout.floorSdf = -CLIFF, by marching squares on a WALL_STEP grid), and a wall along it
   * from the ground outside up to the platform, with a merlon on about a third of the segments;
   * open where a stair crosses. Then each stair as treads and side walls, and on each plaza a
   * banner in the floor's colour (floors.js) and two lamps.
   */
  const WALL_STEP = 0.5;
  function floorsOf(lay, OX, OZ, heightAt, root, mat, mesh, box) {
    if (!lay.top) return;
    const tex = paintTexture('stone');
    world.textures.push(tex);
    const wallM = patchMaterial(new THREE.MeshLambertMaterial({ color: '#ffffff', map: tex, vertexColors: true, side: THREE.DoubleSide }), U);
    const stoneA = new THREE.Color('#b8aa90'), tmp = new THREE.Color();
    const merlons = [];
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
          const shade = 0.72 + 0.28 * Math.max(0, Math.min(1, (y - pb) / Math.max(0.1, top - pb))) + (hash(Math.round(pt.x * 2), Math.round(pt.z * 2)) - 0.5) * 0.1;
          tmp.copy(stoneA).multiplyScalar(shade);
          col.push(tmp.r, tmp.g, tmp.b);
        }
        if (hash(Math.round(mx * 2) + k, Math.round(mz * 2)) < 0.34) merlons.push(new THREE.Matrix4().makeTranslation(mx + OX + ox * 0.08, top + 0.14, mz + OZ + oz * 0.08));
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
      root.add(mesh(box(0.1, 3.6, 0.1), mat('#3a3530'), px + 1.3, py, pz));
      root.add(mesh(new THREE.PlaneGeometry(1.0, 0.7), mat(colour, { double: true, emissive: colour, ei: 0.15 }), px + 1.85, py + 3.15, pz));
      for (const a of [Math.PI * 0.75, Math.PI * 1.25]) {
        const lx = px + Math.sin(a) * 2.6, lz = pz - Math.cos(a) * 2.6;
        root.add(mesh(box(0.08, 1.9, 0.08), mat('#3a3530'), lx, heightAt(lx, lz), lz));
        root.add(mesh(new THREE.BoxGeometry(0.26, 0.3, 0.26), mat('#ffd38a', { emissive: '#ffb04a', ei: 1.2 }), lx, heightAt(lx, lz) + 2.0, lz));
      }
    }
    if (merlons.length) {
      const im = new THREE.InstancedMesh(new THREE.BoxGeometry(0.42, 0.28, 0.42), mat('#c9bea6'), merlons.length);
      merlons.forEach((m, i) => im.setMatrixAt(i, m));
      im.castShadow = im.receiveShadow = true;
      root.add(im);
    }
    // stairs: STEPS treads on the ramp heightAt gives the walkers, with a low wall each side
    const STEPS = 12, tread = mat('#cfc4ad'), side = mat('#b8aa90');
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
        root.add(g);
      }
    }
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
    const map = sim.map;
    if (!world || world.map !== map) {
      build(map, 'town', (x, y) => (x >= 0 && y >= 0 && x < map.w && y < map.h) ? map.at(x, y) : T.FLOOR);
      const b = map.layout.bounds;
      world.focus = { x0: b.x0 + map.ox, x1: b.x1 + map.ox, z0: b.z0 + map.oz, z1: b.z1 + map.oz };
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
