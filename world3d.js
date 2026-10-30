// The mission field in three dimensions. Browser only: window.World3D.
// Depends on three.js (window.THREE, put there by the page's loader — see THREE_LOADER below),
// mapgen.js (tile codes), tokens.js (rim colours, grade sizes), lpc.js (walk sheets) and
// fieldview.js (the zone and portal drawing, and the token follow).
//
// It also draws the home town (renderTown), from townmap.js's ground and townlife.js's walkers,
// on the same terrain and scenery code with a style of its own.
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
//   - Actors are billboards. Every fragment of a billboard is written at the depth of the
//     actor's feet, so a figure is hidden by what stands in front of where it stands and never
//     clipped by a wall or slope behind it — the usual 2.5D sorting, done in the depth buffer.

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
  // the home town: open meadow ground, roads of packed dirt, houses as walls without roofs so
  // the people inside can be seen, a palisade round it and forest beyond
  town: {
    hill: 0, roll: 0.05, blocks: 1.05,
    grass: ['#6a9a40', '#86b54e'], dry: '#bdb860', moss: '#55853a', dirt: '#b0905f', road: '#c2a675',
    rock: '#8c7b62', top: '#557f34',
    plaster: '#e8dcc0', stake: '#7a5636',
    roof: { work: '#b0583a', bed: '#4f74a8', altar: '#8a4c94', gate: '#7a5cc0' },
    floor: { work: '#a9825a', bed: '#9a8670', altar: '#9890a6' },
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
function patchMaterial(mat, U, { overlay = false, fade = false } = {}) {
  if (overlay) mat.defines = Object.assign(mat.defines || {}, { WORLD_OVERLAY: '' });
  if (fade) mat.defines = Object.assign(mat.defines || {}, { OCCLUDER_FADE: '' });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uSeen = U.uSeen;
    sh.uniforms.uOverlay = U.uOverlay;
    sh.uniforms.uMapSize = U.uMapSize;
    sh.uniforms.uFocus = U.uFocus;
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
        uniform vec4 uFocus;`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        #ifdef OCCLUDER_FADE
          if (uFocus.w > 0.0) {
            vec3 toCam = normalize(cameraPosition - uFocus.xyz);
            vec3 rel = vWorld3 - uFocus.xyz;
            float along = dot(rel, toCam);
            float off = length(rel - toCam * along);
            float cut = (1.0 - smoothstep(0.6 * uFocus.w, uFocus.w, off)) * smoothstep(0.2, 0.8, along);
            // 4x4 ordered dither: an even screen-door rather than speckle
            const float BAYER[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
            ivec2 q = ivec2(mod(gl_FragCoord.xy, 4.0));
            if ((BAYER[q.y * 4 + q.x] + 0.5) / 16.0 < cut * 0.92) discard;
          }
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

    // town: the floor inside each plot, coloured by what the plot is
    const floorG = fam === 'town' ? [new Float32Array(W * H), new Float32Array(W * H), new Float32Array(W * H), new Float32Array(W * H)] : null;
    if (floorG) {
      const fc = new THREE.Color();
      for (const p of Object.values(map.plots)) {
        if (!st.floor[p.kind]) continue;
        fc.set(st.floor[p.kind]);
        for (let y = p.y; y < p.y + p.h; y++) for (let x = p.x; x < p.x + p.w; x++) {
          const k = (y + MARGIN) * W + x + MARGIN;
          floorG[0][k] = 1; floorG[1][k] = fc.r; floorG[2][k] = fc.g; floorG[3][k] = fc.b;
        }
      }
    }

    // heights
    const nx = W * SUB + 1, nz = H * SUB + 1;
    const heights = new Float32Array(nx * nz), wallness = new Float32Array(nx * nz), roadness = new Float32Array(nx * nz);
    for (let gz = 0; gz < nz; gz++) for (let gx = 0; gx < nx; gx++) {
      const px = gx / SUB - MARGIN, pz = gz / SUB - MARGIN, k = gz * nx + gx;
      const m = field(wallG, px, pz), rd = field(roadG, px, pz);
      let h = (fbm(px * 0.22 + so, pz * 0.22) - 0.5) * st.roll * 2 * (1 - m);
      if (st.hill) h += Math.pow(m, 0.8) * st.hill * (0.7 + 0.6 * fbm(px * 0.3 + so, pz * 0.3 + 40)) + m * m * (fbm(px * 1.4, pz * 1.4 + so) - 0.3) * 0.5;
      h -= rd * 0.04;
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
      if (st.hill) {
        c.lerp(top, sstep(0.55, 0.95, m) * 0.85);
        c.lerp(rock, sstep(0.16, 0.42, slope) * sstep(0.02, 0.15, m));
      }
      if (floorG) {
        const f = field(floorG[0], px, pz);
        if (f > 0.01) c.lerp(tmp.setRGB(field(floorG[1], px, pz) / f, field(floorG[2], px, pz) / f, field(floorG[3], px, pz) / f), sstep(0.35, 0.8, f));
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
    const W = map.w + 2 * MARGIN, H = map.h + 2 * MARGIN;
    const isWall = (x, y) => at(x, y) === T.WALL;
    const openNear = (x, y) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !isWall(x + dx, y + dy) && map.at(x + dx, y + dy) !== undefined && x + dx >= 0 && y + dy >= 0 && x + dx < map.w && y + dy < map.h);
    const lists = { canopy: [], trunk: [], rock: [], bush: [], block: [], cap: [], crate: [], barrel: [], crystal: [], post: [], stake: [] };
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
    // town: which plot a tile belongs to, so a wall knows whose roof colour it carries
    const plotOf = new Map();
    if (fam === 'town') {
      for (const p of Object.values(map.plots)) {
        if (!st.roof[p.kind] || p.kind === 'gate') continue;
        for (let y = p.y; y < p.y + p.h; y++) for (let x = p.x; x < p.x + p.w; x++) plotOf.set(y * map.w + x, p);
      }
    }

    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const x = i - MARGIN, y = j - MARGIN, t = at(x, y);
      const r1 = hash(x * 3 + so, y * 7), r2 = hash(x * 11, y * 5 + so), r3 = hash(x + 99, y - so);
      const wx = x + 0.5 + (r2 - 0.5) * 0.5, wz = y + 0.5 + (r3 - 0.5) * 0.5;
      const inside = x >= 0 && y >= 0 && x < map.w && y < map.h;
      if (fam === 'town' && t === T.GATE) continue;           // the gateway is one arch, built in townFeatures
      if (fam === 'town' && t !== T.DOOR) {
        if (!inside) {
          // forest beyond the palisade, thinning to a clear strip along it and round the road out
          const edge = Math.max(-x - 1, x - map.w, -y - 1, y - map.h);
          const byRoad = x >= map.w && Math.abs(y - map.yRoad) <= 2 + (x - map.w) * 0.15;
          if (t !== T.ROAD && !byRoad && edge >= 1 && r1 < 0.25 + edge * 0.12) tree(x, y, wx, wz, r2);
        } else if (t === T.WALL && (x === 0 || y === 0 || x === map.w - 1 || y === map.h - 1)) {
          // the palisade: two sharpened stakes a tile
          for (const o of [0.25, 0.75]) {
            const across = y === 0 || y === map.h - 1;
            const sx = x + (across ? o : 0.5), sz = y + (across ? 0.5 : o);
            const sh = 1.25 + hash(x * 7 + o * 10, y) * 0.3;
            lists.stake.push({ m: M4(sx, heightAt(sx, sz), sz, 1, sh, 1, r1 * 6) });
          }
        } else if (t === T.WALL) {
          const p = plotOf.get(y * map.w + x);
          const h = st.blocks * (0.96 + r1 * 0.08);
          lists.block.push({ m: M4(x + 0.5, h / 2 - 0.1, y + 0.5, 1, h + 0.2, 1), c: r2 });
          lists.cap.push({ m: M4(x + 0.5, h + 0.06, y + 0.5, 1.12, 0.16, 1.12), c: r3, col: p ? st.roof[p.kind] : st.roof.work });
        }
        continue;
      }
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
    const stoneA = new THREE.Color(st.plaster || st.stone || '#b0a088'), stoneB = stoneA.clone().multiplyScalar(0.84);
    inst(blockGeo, lam({ color: '#ffffff', map: (() => { const t = paintTexture('stone'); world.textures.push(t); return t; })() }, true), lists.block,
      (e) => new THREE.Color().lerpColors(stoneA, stoneB, e.c));
    inst(blockGeo, lam({ color: '#ffffff' }, true), lists.cap, (e) => new THREE.Color(e.col || st.cap || '#d8ccb0').multiplyScalar(0.9 + e.c * 0.1));
    const stakeGeo = new THREE.CylinderGeometry(0.13, 0.15, 1, 7).translate(0, 0.5, 0);
    const tipGeo = new THREE.ConeGeometry(0.13, 0.25, 7);
    inst(stakeGeo, lam({ color: st.stake || '#7a5636' }), lists.stake);
    inst(tipGeo, lam({ color: st.stake || '#7a5636' }), lists.stake.map(e => {
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
      e.m.decompose(p, q, sc);
      return { m: M4(p.x, p.y + sc.y + 0.12, p.z, 1, 1, 1) };
    }));
    if (fam === 'town') townFeatures(map, st, heightAt, root, lam);
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

  /**
   * The parts of the town that are not tiles: a fountain in the square, the crystal on the road
   * past the gate (every mission leaves towards it), stock in the workshops, and a sign over
   * each plot naming it — the 3D view's version of townview.js's drawLabels.
   */
  function townFeatures(map, st, heightAt, root, lam) {
    const sq = map.plots.square;
    if (sq) {
      const x = sq.at.x + 0.5, z = sq.at.y + 0.5, gy = heightAt(x, z);
      const stone = lam({ color: '#cfc4ad' });
      const basin = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.25, 0.35, 28, 1, true).translate(0, 0.175, 0), stone);
      const water = new THREE.Mesh(new THREE.CircleGeometry(1.0, 28).rotateX(-Math.PI / 2),
        new THREE.MeshLambertMaterial({ color: '#5fb6d8', emissive: '#1f5f7a', emissiveIntensity: 0.6 }));
      water.position.y = 0.36;
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, 0.9, 12).translate(0, 0.45, 0), stone);
      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.18, 0.18, 16).translate(0, 0.95, 0), stone);
      const fountain = new THREE.Group();
      fountain.add(basin, water, pillar, bowl);
      fountain.position.set(x, gy, z);
      fountain.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      root.add(fountain);
    }
    // the gateway: two tall posts either side of the gate tiles, a beam across, a banner under it
    const gate = map.plots.gate;
    if (gate) {
      const gx = gate.door.x + 0.5, gz = gate.door.y + 0.5, gy0 = heightAt(gx, gz), wood = lam({ color: '#6b4a2e' });
      for (const dz of [-1.6, 1.6]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.32, 2.6, 0.32).translate(0, 1.3, 0), wood);
        post.position.set(gx, gy0, gz + dz);
        post.castShadow = true;
        root.add(post);
      }
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.3, 3.9), wood);
      beam.position.set(gx, gy0 + 2.55, gz);
      beam.castShadow = true;
      const banner = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.9),
        lam({ color: st.roof.gate, side: THREE.DoubleSide }));
      banner.position.set(gx, gy0 + 1.95, gz + 0.2);
      root.add(beam, banner);
    }

    // the crystal stands on the road out, a few tiles past the gate
    const cx = map.w + 3.5, cz = map.yRoad + 0.5, cy = heightAt(cx, cz);
    const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.9, 0).scale(0.75, 1.9, 0.75),
      lam({ color: '#b9a4ff', emissive: '#6a4cff', emissiveIntensity: 0.85, transparent: true, opacity: 0.92 }));
    crystal.position.set(cx, cy + 2.3, cz);
    crystal.castShadow = true;
    const plinth = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.25, 0.4, 8).translate(0, 0.2, 0), lam({ color: '#a89c88' }));
    plinth.position.set(cx, cy, cz);
    plinth.receiveShadow = plinth.castShadow = true;
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: shared.glowTex, color: '#a58cff', blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.6 }));
    halo.position.set(cx, cy + 2.3, cz);
    halo.scale.set(5, 5, 1);
    root.add(crystal, plinth, halo);
    world.crystal = crystal;

    // stock: a few crates and barrels in the corners of each workshop
    const crates = [], barrels = [];
    for (const p of Object.values(map.plots)) {
      if (p.kind !== 'work' || p.w < 4 || p.h < 4) continue;
      const corners = [[p.x + 1, p.y + 1], [p.x + p.w - 2, p.y + 1]];
      corners.forEach(([x, y], i) => {
        const r = hash(x, y), wx = x + 0.5, wz = y + 0.5, gy = heightAt(wx, wz);
        const m = new THREE.Matrix4().compose(new THREE.Vector3(wx, gy + (i ? 0 : 0.2), wz),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r * 1.5), new THREE.Vector3(i ? 1 : 0.4, i ? 1 : 0.4, i ? 1 : 0.4));
        (i ? barrels : crates).push(m);
      });
    }
    const put = (geo, mat, ms) => {
      if (!ms.length) return;
      const im = new THREE.InstancedMesh(geo, mat, ms.length);
      ms.forEach((m, i) => im.setMatrixAt(i, m));
      im.castShadow = im.receiveShadow = true;
      root.add(im);
    };
    put(new THREE.BoxGeometry(1, 1, 1), lam({ color: '#9a6e3e' }), crates);
    put(new THREE.CylinderGeometry(0.17, 0.17, 0.5, 12).translate(0, 0.25, 0), lam({ color: '#7a5532' }), barrels);

    // signs: an icon always, the name once the view is close enough to read it
    world.signs = [];
    for (const p of Object.values(map.plots)) {
      const icon = signTexture(p.icon, null), full = signTexture(p.icon, p.label);
      world.textures.push(icon, full);
      const b = billboard(icon, fogU, { w: 0.5, h: 0.5, lift: 0.4 });
      const x = p.x + p.w / 2, z = p.y + 0.5;
      b.position.set(x, heightAt(x, z) + (p.kind === 'square' ? 0.3 : st.blocks + 0.35), z);
      root.add(b);
      world.signs.push({ mesh: b, icon, full });
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
        o.body.material.uniforms.uUv.value.set(mirror ? 1 : 0, 0, mirror ? -1 : 1, 1);
        o.body.material.uniforms.uOpacity.value = (a.subdued ? 0.5 : 1) * lit;
        o.shadow.material.opacity = lit;
        continue;
      }
      // squad: a walking LPC figure, row chosen by the direction of travel on screen
      if (a.layers && !o.body) {
        const sheet = walkSheet(a.layers);
        o.ownTex.push(sheet);
        o.body = billboard(sheet, fogU, { w: 1.55, h: 1.55, foot: 3 / 64 });
        o.group.add(o.body);
        o.label.position.y = 1.5;
      }
      if (o.ring) o.ring.material.color.set(a.ringColour || Tokens.RINGS.squad);
      if (!o.body) continue;
      stepWalk(o, prevX == null ? 0 : a.rx - prevX, prevY == null ? 0 : a.ry - prevY, dt);
      const hurt = a.ringColour === Tokens.RINGS.down;
      o.body.material.uniforms.uTint.value.setScalar(hurt ? 0.55 : 1);
    }
    for (const [id, o] of objs) if (!ids.has(id)) { disposeActor(o); objs.delete(id); }
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
  function syncFolk(folk, dt, { hoverId = null, ringFor = null } = {}) {
    const ids = new Set();
    for (const a of folk) {
      ids.add(a.id);
      let o = objs.get(a.id);
      if (!o) { o = makeActor({ role: 'squad', side: 'ours', label: a.label }); objs.set(a.id, o); }
      const x = a.x + 0.5, z = a.y + 0.5;
      const dx = o.px == null ? 0 : x - o.px, dz = o.pz == null ? 0 : z - o.pz;
      o.px = x; o.pz = z;
      o.group.position.set(x, world.heightAt(x, z), z);
      if (a.layers && !o.body) {
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
      if (o.body) stepWalk(o, dx, dz, dt);
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
  function fitDistance(aspect) {
    const vf = FOV * Math.PI / 180, hf = 2 * Math.atan(Math.tan(vf / 2) * aspect);
    const dW = world.w / (2 * Math.tan(hf / 2));
    const dH = (world.h * Math.sin(PITCH) + 1.5 * Math.cos(PITCH)) / (2 * Math.tan(vf / 2));
    return Math.max(dW, dH) * 1.04;
  }

  function placeCamera(want, dt) {
    const aspect = sizeW / sizeH, vf = FOV * Math.PI / 180, hf = 2 * Math.atan(Math.tan(vf / 2) * aspect);
    const fit = fitDistance(aspect), zoom = Math.max(1, want.zoom || 1), d = fit / zoom;
    const halfW = d * Math.tan(hf / 2), halfD = d * Math.tan(vf / 2) / Math.sin(PITCH);
    // a zoomed view may look past the edge by `pad` tiles (the town's road out to the crystal)
    const pad = world.fam === 'town' ? 6 : 0;
    const axis = (span, half, centre) => (centre == null || span <= half * 2) ? span / 2
      : Math.max(half - pad, Math.min(span + pad - half, centre + 0.5));
    const tx = axis(world.w, halfW, want.cx), tz = axis(world.h, halfD, want.cy);
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
    plane.constant = -world.heightAt(hit.x, hit.z);
    ray.ray.intersectPlane(plane, hit);
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
      build(map, 'town', (x, y) => (x >= 0 && y >= 0 && x < map.w && y < map.h) ? map.at(x, y)
        : (x >= map.w && Math.abs(y - map.yRoad) <= 1 ? T.ROAD : T.FLOOR));
    }
    if (clockMs - lastOverlayAt > 66 || lastOverlayAt < 0) { drawThreads(knots || []); lastOverlayAt = clockMs; }
    const cam = placeCamera(want, dt);
    syncFolk(sim.folk ? sim.folk.filter(a => !a.gone) : [], dt, opts);
    updateMotes(dt);
    if (world.crystal) {
      world.crystal.rotation.y += dt * 0.0006;
      world.crystal.position.y = world.heightAt(map.w + 3.5, map.yRoad + 0.5) + 2.3 + Math.sin(clockMs * 0.0015) * 0.12;
    }
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
