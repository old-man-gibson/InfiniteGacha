// Character models for the 3D view. Browser only: window.Figure3D.
// Depends on three.js (window.THREE, loaded by the page before the first create()). Reads lpc.js
// (LPC.catalog) for palette colours when it is loaded; without it, colours fall back to a table.
//
// LOOK. describe(ch) reads the same record lpc.js composites into a sprite: race, bodyType,
// skinTarget, selections[] and equipment. Each selection that changes the sprite changes the model:
//   - head item: head shape (human jaw/cheek variants, or one of 14 muzzle/skull builds)
//   - hair item: one of ~25 hair builds (cap hairline, volume, ponytail, buns, spikes, braids...)
//     and its palette colour
//   - shirt / legs / feet items: garment cut (sleeve length, neckline, tunic, robe, skirt, shorts,
//     boots...) and palette colour
//   - ears, furry ears, horns, fins, tail, wings, beard, mustache, visor, armour: extra parts
//   - equipment: weapon, shield, helm, mail and boots, with the quality's metal (gear.js scale)
// Proportions come from bodyType and race. A per-character jitter seeded by id moves height,
// shoulder width, girth and limb thickness by a few percent, so two characters wearing the same
// items still differ.
//
// MESH. One SkinnedMesh per figure. Body, garments, hair and parts are merged into one geometry
// with vertex colours and skin weights (one draw call), plus an outline pass that shares the
// skeleton, plus one small mesh per held prop. Torso and limbs are lofts of elliptical rings; rings
// near a joint are weighted to both bones, so knees, elbows, waist and neck bend instead of
// hinging. Garments are painted onto the body rings, with a duplicated ring at each hem so the
// colour edge stays hard, and the rings are widened where a garment stands off the body. Skirts,
// robes, tunic hems and cuffs are separate lofts weighted between the hips and the thighs.
//
// MOTION. Procedural, recomputed every frame from the inputs update() is given (position, the
// activity, a point to face, events) and four per-character axes:
//   mass    0..1   body type, race size, girth, armour weight, STR + CON.
//                  Higher: lower cadence, deeper bob, wider stance, arms held off the body.
//   poise   0..1   DEX. Higher: less bob and sway, faster turns and blends, faster wind-ups.
//   energy  0..1   stamina x morale in town, HP fraction in the field (caller supplies it).
//                  Lower: slouch, head down, smaller arm swing and knee lift, slower work cycles.
//   nerve  -1..1   temper.js nerve tilt. +1: chest and head up, wider swing, forward fight
//                  stance. -1: shoulders forward, head down, guard held closer.
// A wound adds a limp on one leg. No code path branches on a named gait. Idle gestures (hands
// on hips, arms crossed, stretch, look around) are drawn with weights that are functions of the
// axes, so a bold character puts hands on hips more often and a tired one stretches more often.
//
// Gait is driven by distance moved, not by time: phase advances by distance / stride, and the
// stride follows from leg length, stance fraction and swing amplitude, so planted feet do not
// slide. Hip height each frame is the vertical reach of the planted leg, so the body bobs from
// leg geometry rather than from a separate sine.

(() => {
const TAU = Math.PI * 2;
const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
const clamp01 = (x) => clamp(x, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
const sstep = (a, b, x) => smooth(clamp01((x - a) / (b - a)));
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const wrapPi = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
const E = () => window.THREE;

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// 3D value noise for hair and fur lumps
function hash3(x, y, z) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const u = smooth(x - xi), v = smooth(y - yi), w = smooth(z - zi);
  let n = 0;
  for (let k = 0; k < 8; k++) {
    const a = k & 1, b = (k >> 1) & 1, c = (k >> 2) & 1;
    n += hash3(xi + a, yi + b, zi + c) * (a ? u : 1 - u) * (b ? v : 1 - v) * (c ? w : 1 - w);
  }
  return n;
}

// ---------- tables ----------

// Per body type. H is crown height in tiles (a door lintel is 1.25). Widths are full widths in
// tiles at H; `legs` is hip-joint height as a fraction of H; `limb` scales limb radii.
const BODY = {
  male:     { H: 1.12, sh: 0.30,  hip: 0.155, chest: [0.25, 0.165], waist: [0.205, 0.145], pelvis: [0.23, 0.155], limb: 1.0,  thigh: 1.0,  bust: 0, pec: 0.07, legs: 0.52, head: 1.0,  mass: 0.45 },
  female:   { H: 1.07, sh: 0.255, hip: 0.165, chest: [0.215, 0.145], waist: [0.172, 0.13], pelvis: [0.245, 0.16], limb: 0.86, thigh: 1.12, bust: 1, pec: 0, legs: 0.53, head: 0.97, mass: 0.32 },
  muscular: { H: 1.2,  sh: 0.37,  hip: 0.175, chest: [0.32, 0.2],   waist: [0.25, 0.17],  pelvis: [0.265, 0.17], limb: 1.24, thigh: 1.05, bust: 0, pec: 0.12, legs: 0.5,  head: 1.0,  mass: 0.75 },
  teen:     { H: 0.86, sh: 0.30,  hip: 0.17,  chest: [0.28, 0.19],  waist: [0.26, 0.18],  pelvis: [0.26, 0.17],  limb: 1.2,  thigh: 1.05, bust: 0, pec: 0.05, legs: 0.43, head: 1.06, mass: 0.6 },
};
// Per race: height, girth, limb thickness and head size multipliers, arm length.
const RACE = {
  human: {}, elf: { scale: 1.04, width: 0.92, limb: 0.88 }, darkelf: { scale: 1.02, width: 0.94, limb: 0.9 },
  dwarf: { width: 1.06 }, halfgiant: { scale: 1.18, width: 1.1, limb: 1.08 }, orc: { scale: 1.05, width: 1.08, limb: 1.1, arm: 1.04 },
  goblin: { scale: 0.8, width: 0.9, limb: 0.85, head: 1.16, arm: 1.08 }, therian: {}, draconic: { scale: 1.04 },
  celestial: { scale: 1.03, width: 0.95 }, demonic: { scale: 1.02 }, android: {}, robot: {}, bug: { scale: 0.96, width: 0.9, limb: 0.85 },
};
const METAL = ['copper', 'iron', 'steel', 'silver', 'gold', 'gold'];      // by quality 0..5, as gear.js
const FALLBACK = {
  black: '#2c2a30', white: '#e6e3dc', blue: '#3c5ea6', bluegray: '#5d6e86', brown: '#6a472e', charcoal: '#3d3e46',
  forest: '#3e6a3a', gray: '#888888', green: '#4e8a3a', lavender: '#9f8ac6', leather: '#86542f', maroon: '#6a2a2a',
  navy: '#2b3a6a', orange: '#cf783a', pink: '#d68aa6', purple: '#6a3a8a', red: '#a63a32', rose: '#c66a7a', sky: '#78aede',
  slate: '#59636f', tan: '#c49e6e', teal: '#3a8888', walnut: '#5a3a24', yellow: '#d6be4a', blonde: '#d8b860', ash: '#9a8c78',
  copper: '#b46a3c', iron: '#7a7c82', steel: '#a4aab4', silver: '#cfd3da', gold: '#d6a83a', brass: '#b08a36', bronze: '#9a6a34',
};
const DARK = '#1c1a20';

// ---------- colours from catalog.json (via lpc.js) ----------

function catalog() { return (typeof LPC !== 'undefined' && LPC.catalog) ? LPC.catalog() : null; }

/** A palette ramp (6 hex colours, dark to light) by material, ref ('body.ulpc', 'all.lpcr', 'ulpc') and name. */
function ramp(material, ref, name) {
  const C = catalog();
  if (!C || !name) return null;
  name = String(name).replace(/ /g, '_');
  let mat = material, ver = ref || (C.materials[material] && C.materials[material].default);
  if (ref && ref.includes('.')) [mat, ver] = ref.split('.');
  const t = C.palettes[mat] && C.palettes[mat][ver];
  return t && t[name] ? t[name] : null;
}
/** A ramp for a bare colour word (an item variant like 'forest' or 'bluegray'), searching the usual tables. */
function rampByName(name) {
  const C = catalog();
  if (!C || !name) return null;
  const n = String(name).replace(/^_+/, '').replace(/ /g, '_');
  for (const [m, v] of [['cloth', 'ulpc'], ['hair', 'ulpc'], ['all', 'lpcr'], ['body', 'ulpc'], ['metal', 'ulpc'], ['hair', 'lpcr'], ['body', 'lpcr']]) {
    const t = C.palettes[m] && C.palettes[m][v];
    if (t && t[n]) return t[n];
  }
  return null;
}
const tone = (r, i = 3) => r ? r[Math.min(r.length - 1, i)] : null;
function hashColour(s) {
  const h = hashStr(s);
  return '#' + [h & 255, (h >> 8) & 255, (h >> 16) & 255].map(v => (64 + (v >> 1)).toString(16).padStart(2, '0')).join('');
}
// Position between ramp index 3 and 4 used for lit metal, by metal name.
const METAL_MIX = { iron: 1.3, steel: 0.45, silver: 0.5, gold: 0.7, brass: 0.45, copper: 0.1, bronze: 0.4, ceramic: 0.4 };
function metalTone(r, name) {
  if (!r) return null;
  const k = METAL_MIX[name] != null ? METAL_MIX[name] : 0.4;
  const a = Math.min(r.length - 1, 3 + Math.floor(k)), b = Math.min(r.length - 1, a + 1);
  const hex = colourHexMix(r[a], r[b], k - Math.floor(k));
  return '#' + (name === 'copper' ? colourHexMix('#' + hex, '#6e6660', 0.3) : hex);
}
function colourHexMix(a, b, t) {
  const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16)), pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16));
  return pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
const metalOf = (q) => { const n = METAL[clamp(q | 0, 0, 5)]; return metalTone(ramp('metal', 'metal.ulpc', n), n) || FALLBACK[n]; };

/**
 * The colour a selection is drawn in: its recolor target at ramp index `idx`, else its material's
 * base colour, else its variant name, else a hash of the id. `which` picks the recolor slot.
 */
function selColour(sel, which = 0, idx = 3) {
  if (!sel) return null;
  const C = catalog();
  const item = C && C.items[sel.id];
  if (item && item.recolors && item.recolors.length) {
    const i = Math.min(which, item.recolors.length - 1), rc = item.recolors[i];
    const tg = sel.targets && sel.targets[i];
    let r = tg ? ramp(rc.material, tg.ref, tg.name) : null;
    if (r && rc.material === 'metal' && idx === 3) return metalTone(r, tg.name);
    if (!r) {
      const meta = C.materials[rc.material];
      if (meta) {
        let ver = meta.default, nm = meta.base;
        if (rc.base) { if (rc.base.includes('.')) [ver, nm] = rc.base.split('.'); else nm = rc.base; }
        r = ramp(rc.material, ver, nm);
      }
    }
    if (r) return tone(r, idx);
  }
  if (sel.variant) {
    const r = rampByName(sel.variant);
    if (r) return tone(r, idx);
    const word = String(sel.variant).replace(/^_+/, '').split('_')[0];
    if (FALLBACK[word]) return FALLBACK[word];
  }
  return hashColour(sel.id + (sel.variant || ''));
}

// ---------- look: the character record -> parts and numbers ----------

function headKind(id, bt) {
  const female = /female/.test(id) || (bt === 'female' && !/_male/.test(id));
  const h = { kind: 'human', female, jaw: female ? 0.3 : 0.62, chin: female ? 0.2 : 0.35, cheek: 0, size: 1, w: 1, d: 1, nose: female ? 0.8 : 1, brow: female ? 0.25 : 0.55 };
  if (/gaunt/.test(id)) Object.assign(h, { jaw: 0.45, cheek: -0.7, w: 0.93, nose: 1.15 });
  if (/plump/.test(id)) Object.assign(h, { jaw: 0.95, cheek: 0.7, w: 1.1, d: 1.04, nose: 1.1 });
  if (/small/.test(id)) h.size = 0.93;
  if (/elderly/.test(id)) Object.assign(h, { elderly: true, cheek: -0.35 });
  const set = (o) => Object.assign(h, o);
  if (/lizard/.test(id)) set({ kind: 'lizard', jaw: 0.5, nose: 0 });
  else if (/wolf/.test(id)) set({ kind: 'wolf', nose: 0 });
  else if (/wartotaur/.test(id)) set({ kind: 'boar', size: 1.08, nose: 0 });
  else if (/boarman/.test(id)) set({ kind: 'boar', nose: 0 });
  else if (/minotaur/.test(id)) set({ kind: 'bull', size: 1.06, nose: 0 });
  else if (/rabbit/.test(id)) set({ kind: 'rabbit', nose: 0 });
  else if (/mouse/.test(id)) set({ kind: 'mouse', nose: 0 });
  else if (/rat/.test(id)) set({ kind: 'rat', nose: 0 });
  else if (/sheep/.test(id)) set({ kind: 'sheep', nose: 0 });
  else if (/pig/.test(id)) set({ kind: 'pig', nose: 0 });
  else if (/orc/.test(id)) set({ kind: 'orc', jaw: female ? 0.65 : 0.95, chin: 0.45, brow: 0.9, w: 1.05, nose: 1.2 });
  else if (/goblin/.test(id)) set({ kind: 'goblin', jaw: 0.25, chin: 0.3, w: 1.04, nose: 2.0 });
  else if (/troll/.test(id)) set({ kind: 'troll', jaw: 0.8, chin: 0.5, brow: 1.0, nose: 2.4, d: 1.05 });
  else if (/vampire/.test(id)) set({ kind: 'vampire', jaw: 0.4, cheek: -0.6, nose: 1.1, w: 0.95 });
  else if (/skeleton/.test(id)) set({ kind: 'skull', jaw: 0.5, cheek: -0.8, nose: 0 });
  else if (/alien/.test(id)) set({ kind: 'alien', jaw: 0.1, chin: 0.1, nose: 0, size: 1.05, d: 1.12 });
  else if (/zombie/.test(id)) set({ cheek: -0.6, jaw: 0.5 });
  else if (/frankenstein/.test(id)) set({ jaw: 0.9, flat: true });
  h.muzzle = ['lizard', 'wolf', 'boar', 'bull', 'rabbit', 'mouse', 'rat', 'sheep', 'pig'].includes(h.kind);
  return h;
}

// Hair builds. Hairline elevations are angles above the head centre's horizon (radians) at the
// front, side and back; eye level is about 0.05, the brow 0.25, an ear top 0.15, the nape -0.5.
// vol: how far the hair stands off the skull as a fraction of head radius. Optional pieces:
// long (length below the chin as a fraction of H), tail {at, len, braid}, bun, pigtails, spikes,
// hawk, locks, strand, flat, bald, noise, flare, swoop, tuft, stripes, hive.
function hairStyle(id) {
  const n = id.split('/').pop().replace(/^hair_/, '');
  const S = (front, side, back, vol, o = {}) => Object.assign({ front, side, back, vol }, o);
  const m = (re) => re.test(n);
  if (m(/^cornrows/)) return S(0.55, 0.05, -0.5, 0.035, { stripes: 9 });
  if (m(/^dreadlocks_long/)) return S(0.5, 0.0, -0.45, 0.08, { locks: 0.3 });
  if (m(/^dreadlocks_short/)) return S(0.5, 0.05, -0.45, 0.08, { locks: 0.12 });
  if (m(/^flat_top/)) return S(0.5, m(/fade/) ? 0.3 : 0.05, -0.4, 0.22, { flat: true });
  if (m(/^twists/)) return S(0.5, m(/fade/) ? 0.3 : 0.0, -0.45, 0.14, { noise: 0.5, nscale: 9 });
  if (m(/^afro/)) return S(0.5, -0.2, -0.55, 0.6, { noise: 0.22 });
  if (m(/^natural/)) return S(0.5, -0.12, -0.5, 0.36, { noise: 0.22 });
  if (m(/^jewfro/)) return S(0.45, -0.1, -0.5, 0.36, { noise: 0.35 });
  if (m(/^balding/)) return S(0.5, 0.0, -0.5, 0.06, { bald: 0.7 });
  if (m(/^buzzcut/)) return S(0.55, 0.05, -0.5, 0.025);
  if (m(/^high_and_tight/)) return S(0.55, 0.3, -0.15, 0.05);
  if (m(/^longhawk/)) return S(0.6, 0.35, -0.45, 0.02, { hawk: 0.42 });
  if (m(/^shorthawk/)) return S(0.6, 0.35, -0.45, 0.02, { hawk: 0.2 });
  if (m(/^bob|^relm_short/)) return S(m(/side/) ? 0.3 : 0.25, -0.62, -0.62, 0.17, { flare: 0.25, swoop: m(/side/) ? 0.6 : 0 });
  if (m(/^lob/)) return S(0.3, -0.9, -0.9, 0.17, { flare: 0.2 });
  if (m(/^bangs_bun/)) return S(0.14, -0.05, -0.45, 0.1, { bun: 'back' });
  if (m(/^braid/)) return S(0.5, -0.05, -0.45, 0.1, { tail: { at: 'back', len: m(/2/) ? 0.34 : 0.42, braid: true } });
  if (m(/^half_up/)) return S(0.45, -0.7, -0.95, 0.12, { long: 0.22, bun: 'backtop' });
  if (m(/^high_ponytail/)) return S(0.5, 0.0, -0.4, 0.09, { tail: { at: 'crown', len: 0.4 } });
  if (m(/^long_tied|^ponytail|^relm_ponytail/)) return S(0.5, -0.05, -0.5, 0.1, { tail: { at: 'back', len: m(/long_tied/) ? 0.42 : 0.34 } });
  if (m(/^relm_xlong/)) return S(0.4, -0.8, -1.0, 0.13, { long: 0.52, strands: true });
  if (m(/^shoulder/)) return S(0.4, -0.55, -0.9, 0.12, { long: 0.18, strand: m(/l$/) ? 1 : -1 });
  if (m(/^topknot_long/)) return S(0.5, 0.05, -0.45, 0.08, { bun: 'top', tail: { at: 'top', len: 0.22 } });
  if (m(/^topknot/)) return S(0.5, 0.05, -0.45, 0.08, { bun: 'top' });
  if (m(/^curls_large_xlong/)) return S(0.45, -0.7, -1.0, 0.26, { long: 0.5, noise: 0.35 });
  if (m(/^curls_large/)) return S(0.45, -0.4, -0.75, 0.26, { long: 0.08, noise: 0.35 });
  if (m(/^curly_long/)) return S(0.45, -0.65, -0.95, 0.2, { long: 0.3, noise: 0.3 });
  if (m(/^curly_short/)) return S(0.45, -0.05, -0.5, 0.18, { noise: 0.38 });
  if (m(/^bangslong/)) return S(0.15, -0.65, -0.95, 0.12, { long: 0.3, strands: true });
  if (m(/^curtains_long/)) return S(0.3, -0.7, -0.95, 0.12, { long: 0.3, strands: true, part: true });
  if (m(/^long_messy/)) return S(0.4, -0.65, -0.95, 0.15, { long: 0.3, noise: 0.28, strands: true });
  if (m(/^long|^loose|^wavy/)) return S(0.45, -0.65, -0.95, 0.12, { long: 0.3, strands: true, noise: m(/wavy/) ? 0.18 : 0 });
  if (m(/^bunches/)) return S(0.45, -0.05, -0.45, 0.1, { pigtails: 0.16 });
  if (m(/^pigtails/)) return S(m(/bangs/) ? 0.14 : 0.45, -0.05, -0.45, 0.1, { pigtails: 0.32 });
  if (m(/^bangs/)) return S(0.12, 0.0, -0.5, 0.1);
  if (m(/^bedhead|^messy|^unkempt|^halfmessy/)) return S(0.42, 0.0, -0.5, 0.15, { noise: 0.4 });
  if (m(/^mop/)) return S(0.15, -0.18, -0.55, 0.17, { noise: 0.15 });
  if (m(/^cowlick/)) return S(0.45, 0.05, -0.45, 0.11, { tuft: m(/tall/) ? 0.5 : 0.3 });
  if (m(/^curtains/)) return S(0.3, -0.12, -0.5, 0.13, { part: true });
  if (m(/^idol/)) return S(0.22, -0.05, -0.5, 0.14, { spikes: 6, spikeLen: 0.22, front: true });
  if (m(/^page/)) return S(0.15, -0.3, -0.5, 0.15);
  if (m(/^pixie/)) return S(0.3, 0.05, -0.4, 0.09, { swoop: 0.4 });
  if (m(/^swoop|side_bangs/)) return S(0.3, 0.05, -0.45, 0.12, { swoop: 1 });
  if (m(/^spiked_beehive/)) return S(0.45, 0.0, -0.45, 0.12, { hive: 0.7 });
  if (m(/^spiked_liberty/)) return S(0.5, 0.05, -0.4, 0.06, { spikes: 7, spikeLen: 0.7 });
  if (m(/^spiked_porcupine/)) return S(0.45, 0.0, -0.45, 0.08, { spikes: 18, spikeLen: 0.4 });
  if (m(/^spiked/)) return S(0.45, 0.05, -0.45, 0.1, { spikes: 11, spikeLen: 0.32 });
  if (m(/^xlong|^princess|^sara|^long_band/)) return S(m(/princess|sara/) ? 0.2 : 0.42, -0.75, -1.0, 0.13, { long: 0.55, strands: true, noise: m(/wavy/) ? 0.2 : 0 });
  return S(0.5, 0.05, -0.45, 0.1);                       // plain, parted, single, short
}

function shirtCut(id) {
  const c = { sleeve: 'long', body: 'shirt', neck: 'crew', stripes: false };
  if (/blouse_longsleeve/.test(id)) Object.assign(c, { body: 'blouse', neck: 'scoop' });
  else if (/blouse/.test(id)) Object.assign(c, { body: 'blouse', sleeve: 'puff', neck: 'scoop' });
  else if (/robe/.test(id)) c.body = 'robe';
  else if (/tunic/.test(id)) c.body = 'tunic';
  else if (/shortsleeve|tshirt/.test(id)) c.sleeve = 'short';
  else if (/sleeveless|tanktop/.test(id)) c.sleeve = 'none';
  if (/vneck/.test(id)) c.neck = 'v';
  else if (/scoop|tanktop/.test(id)) c.neck = 'scoop';
  else if (/polo/.test(id)) c.neck = 'polo';
  else if (/buttoned/.test(id)) c.neck = 'buttoned';
  else if (/cardigan/.test(id)) c.neck = 'cardigan';
  else if (/laced/.test(id)) c.neck = 'laced';
  else if (/formal/.test(id)) c.neck = 'polo';
  if (/striped/.test(id)) c.stripes = true;
  return c;
}
function legsCut(id) {
  if (/legs_armour/.test(id)) return 'plate';
  if (/hose|leggings/.test(id)) return 'tights';
  if (/pantaloons/.test(id)) return 'puffy';
  if (/widepants/.test(id)) return 'wide';
  if (/shorts_short/.test(id)) return 'short';
  if (/shorts/.test(id)) return 'shorts';
  if (/legion/.test(id)) return 'legion';
  if (/skirt_belle/.test(id)) return 'gown';
  if (/skirts_slit|skirt_straight|skirts_plain/.test(id)) return 'skirt';
  if (/cuffed/.test(id)) return 'cuffed';
  return 'pants';
}
function feetCut(id) {
  if (/feet_armour/.test(id)) return 'plate';
  if (/hoofs/.test(id)) return 'hoofs';
  if (/sandals/.test(id)) return 'sandals';
  if (/slippers/.test(id)) return 'slippers';
  if (/boots_fold/.test(id)) return 'fold';
  if (/boots_rim/.test(id)) return 'rim';
  if (/boots/.test(id)) return 'boots';
  return 'shoes';
}

/** Read a stat 0..1 from the born + advanced block, if the record carries one. */
function statOf(ch, k) {
  const b = ch.stats && ch.stats.base;
  return b && typeof b[k] === 'number' ? clamp01((b[k] - 4) / 18) : 0.5;
}
/** temper.js nerve tilt in -1..1, read without writing (Temper.ensure would roll one onto the record). */
function nerveOf(ch) {
  const mid = (typeof Temper !== 'undefined' && Temper.MID) || 50;
  return ch.temper && typeof ch.temper.nerve === 'number' ? clamp((ch.temper.nerve - mid) / mid, -1, 1) : 0;
}

/** Everything the builder and the animator need, as plain data. Deterministic per character. */
function describe(ch) {
  const sels = (ch.selections || []).filter(s => s && s.id);
  const find = (re) => sels.find(s => re.test(s.id)) || null;
  const key = ch.id != null ? 'id:' + ch.id : 'sel:' + sels.map(s => s.id + ':' + (s.variant || '') + ':' + JSON.stringify(s.targets || {})).join('|');
  const seed = hashStr(key);
  const rnd = mulberry32(seed);
  const jit = (k) => 1 + (rnd() * 2 - 1) * k;
  const race = ch.race || 'human';
  const bt = BODY[ch.bodyType] ? ch.bodyType : 'male';
  const B = BODY[bt], RC = RACE[race] || {};
  const headSel = find(/^head\/heads\//);
  const head = headKind(headSel ? headSel.id : '', bt);
  const skeletal = !!find(/body_skeleton/) || head.kind === 'skull';
  const skinRamp = ch.skinTarget ? ramp('body', ch.skinTarget.ref, ch.skinTarget.name) : null;
  // 30% of the way to the next lighter ramp step: the mid step alone reads orange under the toon ramp
  const skin = skeletal ? '#e2dccb' : skinRamp ? '#' + colourHexMix(skinRamp[3], skinRamp[4], 0.3) : '#e4a47c';
  const eye = tone(headSel && headSel.targets && headSel.targets[1] ? ramp('eye', headSel.targets[1].ref, headSel.targets[1].name) : null, 1) || '#3a3040';

  // ----- proportions -----
  const H = B.H * (RC.scale || 1) * jit(0.03);
  const k = H / B.H;
  const wid = (RC.width || 1) * jit(0.045);
  const limb = B.limb * (RC.limb || 1) * jit(0.06);
  const headS = 1.07 * B.head * (RC.head || 1) * head.size * jit(0.025);
  const legs = H * B.legs;
  const headH = H * 0.14 * headS;
  const neck = H * 0.034;
  const torso = H - legs - neck - headH;
  const arm = (RC.arm || 1) * jit(0.02);
  const p = {
    H, legs, thigh: legs * 0.48, shin: legs * 0.45, ankle: legs * 0.07,
    pelvis: torso * 0.2, waist: torso * 0.33, chest: torso * 0.47, neck,
    headH, headW: headH * 0.8 * head.w, headD: headH * 0.92 * head.d,
    shoulder: B.sh * k * wid * jit(0.04) / 2, hip: B.hip * k * wid / 2,
    chestW: B.chest[0] * k * wid / 2, chestD: B.chest[1] * k * wid / 2,
    waistW: B.waist[0] * k * wid / 2 * jit(0.05), waistD: B.waist[1] * k * wid / 2,
    pelvisW: B.pelvis[0] * k * wid / 2, pelvisD: B.pelvis[1] * k * wid / 2,
    upperArm: H * 0.185 * arm, forearm: H * 0.155 * arm, hand: H * 0.07,
    foot: legs * 0.27, footW: 0.034 * k * Math.sqrt(limb),
    bust: B.bust, pec: B.pec, belly: (head.cheek > 0.3 ? 0.5 : 0) + (race === 'halfgiant' || race === 'dwarf' ? 0.3 : 0) + rnd() * 0.2,
  };
  const L = (v) => v * k * limb;
  p.r = {
    thigh: L(0.06) * B.thigh, knee: L(0.037), calf: L(0.043), ankle: L(0.024),
    arm: L(0.037), elbow: L(0.027), fore: L(0.031), wrist: L(0.021), neck: L(0.031) * (bt === 'female' ? 0.88 : 1),
  };

  const look = { seed, race, bt, p, skin, eye, head, skeletal };

  // ----- hair and face hair -----
  const hairSel = find(/^hair\/(?!beards|mustaches)/);
  const hairCol = hairSel ? selColour(hairSel, 0, 3) : null;
  look.hair = hairSel ? Object.assign(hairStyle(hairSel.id), { colour: hairCol }) : null;
  const beardSel = find(/^hair\/beards\//), stacheSel = find(/^hair\/mustaches\//);
  if (beardSel) look.beard = { kind: (beardSel.id.match(/beards_(\w+)$/) || [])[1] || 'beard', colour: selColour(beardSel, 0, 3) };
  if (stacheSel) look.stache = { kind: (stacheSel.id.match(/beards_(\w+)$/) || [])[1] || 'mustache', colour: selColour(stacheSel, 0, 3) };

  // ----- head parts -----
  const earSel = find(/^head\/ears\//), furSel = find(/^head\/furry_ears\//);
  if (furSel) look.ears = { kind: (furSel.id.match(/ears_(\w+)$/) || [])[1] || 'wolf', colour: selColour(furSel, 0, 3), inner: selColour(furSel, 1, 4) || skin, furry: true };
  else if (earSel) look.ears = { kind: (earSel.id.match(/ears_(\w+)$/) || [])[1] || 'medium', colour: skin };
  const hornSel = find(/^head\/appendages\/head_horns/);
  if (hornSel) look.horns = { kind: /curled/.test(hornSel.id) ? 'curled' : 'back', colour: selColour(hornSel, 0, 2) };
  const finSel = find(/^head\/appendages\/head_fins/);
  if (finSel) look.fins = { short: /short/.test(finSel.id), colour: selColour(finSel, 0, 2) };
  const visorSel = find(/^headwear\/helmets\/visors\//);
  if (visorSel) look.visor = { kind: (visorSel.id.match(/visor_(\w+)$/) || [])[1] || 'slit', metal: selColour(visorSel, 0, 3) };

  // ----- body parts -----
  const tailSel = find(/tail_/);
  if (tailSel) {
    const id = tailSel.id;
    look.tail = { kind: /lizard/.test(id) ? 'lizard' : /fluffy/.test(id) ? 'fluffy' : /cat/.test(id) ? 'cat' : 'wolf', colour: /tail_lizard$/.test(id) ? skin : selColour(tailSel, 0, 3) };
  }
  const wingSel = find(/wings_/);
  if (wingSel) {
    const id = wingSel.id;
    const kind = /feathered/.test(id) ? 'feather' : /lunar|pixie|monarch|dragonfly/.test(id) ? 'insect' : 'membrane';
    let colour = /body\/lizard\/wings_lizard($|_bat)/.test(id) ? skin : selColour(wingSel, 0, 3);
    look.wings = { kind, colour, light: /transparent/.test(id), monarch: /monarch/.test(id), dragonfly: /dragonfly/.test(id) };
  }

  // ----- garments -----
  const shirtSel = find(/^torso\/shirts\//), legSel = find(/^legs\//), feetSel = find(/^feet\//);
  const armourSel = find(/^torso\/armour\//);
  if (shirtSel) look.shirt = Object.assign(shirtCut(shirtSel.id), { colour: selColour(shirtSel, 0, 3) || '#888' });
  if (legSel) look.legs = { cut: legsCut(legSel.id), colour: selColour(legSel, 0, legsCut(legSel.id) === 'plate' ? 3 : 3) || '#555' };
  if (!look.legs) look.legs = { cut: 'short', colour: '#5a4636' };
  if (feetSel) look.feet = { cut: feetCut(feetSel.id), colour: selColour(feetSel, 0, 2) || '#3a2a20' };
  if (armourSel) look.mail = { kind: /leather/.test(armourSel.id) ? 'light' : /legion/.test(armourSel.id) ? 'medium' : 'heavy', metal: selColour(armourSel, /leather/.test(armourSel.id) ? 1 : 0, 3), leather: '#7a4a2a' };
  if (find(/^arms\/arms_armour/)) look.armPlate = selColour(find(/^arms\/arms_armour/), 0, 3);

  // ----- equipment (gear.js looks, in 3D) -----
  const eq = ch.equipment || {};
  const leather = tone(ramp('cloth', 'cloth.ulpc', 'leather'), 3) || FALLBACK.leather;
  if (eq.weapon) look.weapon = { kind: eq.weapon.type || eq.weapon.key, q: eq.weapon.quality | 0 };
  if (eq.offhand) look.shield = { kind: eq.offhand.type || eq.offhand.key, q: eq.offhand.quality | 0 };
  if (eq.head) look.helm = { kind: eq.head.type || String(eq.head.key).split('_')[0], metal: metalOf(eq.head.quality), leather };
  if (eq.body) look.mail = { kind: eq.body.type || String(eq.body.key).split('_')[0], metal: metalOf(eq.body.quality), leather };
  if (eq.feet) look.boots = { kind: eq.feet.type || String(eq.feet.key).split('_')[0], metal: metalOf(eq.feet.quality), leather };

  // ----- axes -----
  const armourMass = { light: 0.04, medium: 0.1, heavy: 0.2 };
  const mass = clamp01(B.mass + ((RC.scale || 1) - 1) * 1.2 + (wid - 1) * 1.5 + (look.mail ? armourMass[look.mail.kind] || 0 : 0)
    + (statOf(ch, 'str') + statOf(ch, 'con') - 1) * 0.15);
  look.axes = { mass, poise: clamp01(0.15 + statOf(ch, 'dex') * 0.85), nerve: nerveOf(ch) };
  look.limpSide = rnd() < 0.5 ? 'L' : 'R';
  look.sig = signature(ch);
  return look;
}

/** What has to change for the model to be rebuilt: selections and equipped items. */
function signature(ch) {
  const eq = ch.equipment || {};
  return (ch.selections || []).map(s => s && s.id + (s.variant || '')).join(',') + '|' +
    Object.keys(eq).sort().map(k => eq[k] ? k + ':' + eq[k].key + ':' + (eq[k].quality | 0) : '').join(',');
}

// ---------- rig ----------

const BONES = ['root', 'hips', 'spine', 'chest', 'neck', 'head', 'eyes',
  'clavL', 'armL', 'foreL', 'handL', 'gripL', 'clavR', 'armR', 'foreR', 'handR', 'gripR',
  'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR',
  'tail0', 'tail1', 'tail2', 'wingL', 'wingR', 'earL', 'earR', 'hair0', 'hair1'];
const BI = Object.fromEntries(BONES.map((n, i) => [n, i]));
const NB = BONES.length;
const PARENT = {
  root: null, hips: 'root', spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck', eyes: 'head',
  clavL: 'chest', armL: 'clavL', foreL: 'armL', handL: 'foreL', gripL: 'handL',
  clavR: 'chest', armR: 'clavR', foreR: 'armR', handR: 'foreR', gripR: 'handR',
  thighL: 'hips', shinL: 'thighL', footL: 'shinL', thighR: 'hips', shinR: 'thighR', footR: 'shinR',
  tail0: 'hips', tail1: 'tail0', tail2: 'tail1', wingL: 'chest', wingR: 'chest', earL: 'head', earR: 'head', hair0: 'head', hair1: 'hair0',
};

/** Bind-pose positions of every bone in model space (figure faces +z, its left is +x). */
function bindPositions(look) {
  const p = look.p, V = (x, y, z) => ({ x, y, z });
  const P = {};
  P.root = V(0, 0, 0);
  P.hips = V(0, p.legs, 0);
  P.spine = V(0, p.legs + p.pelvis, -0.004);
  P.chest = V(0, P.spine.y + p.waist, -0.008);
  P.neck = V(0, P.chest.y + p.chest, -0.012);
  P.head = V(0, P.neck.y + p.neck, -0.004);
  P.headC = V(0, P.head.y + p.headH * 0.47, p.headD * 0.05);         // head centre (not a bone)
  P.eyes = V(0, P.headC.y + p.headH * 0.02, P.headC.z + p.headD * 0.36);
  const shY = P.chest.y + p.chest * 0.8;
  for (const [s, side] of [[1, 'L'], [-1, 'R']]) {
    P['clav' + side] = V(s * p.chestW * 0.25, shY + 0.01, -0.01);
    P['arm' + side] = V(s * p.shoulder, shY, -0.01);
    P['fore' + side] = V(s * p.shoulder, shY - p.upperArm, -0.01);
    P['hand' + side] = V(s * p.shoulder, shY - p.upperArm - p.forearm, -0.004);
    P['grip' + side] = V(s * p.shoulder, P['hand' + side].y - p.hand * 0.55, 0.004);
    P['thigh' + side] = V(s * p.hip, p.legs - 0.01, 0);
    P['shin' + side] = V(s * (p.hip - 0.008), p.legs - 0.01 - p.thigh, 0.004);
    P['foot' + side] = V(s * (p.hip - 0.01), p.ankle, -0.004);
    P['wing' + side] = V(s * p.chestW * 0.4, P.chest.y + p.chest * 0.62, -p.chestD * 0.85);
    P['ear' + side] = V(s * p.headW * 0.42, P.headC.y + p.headH * 0.12, P.headC.z - p.headD * 0.05);
  }
  P.tail0 = V(0, p.legs + p.pelvis * 0.1, -p.pelvisD * 0.92);
  P.tail1 = V(0, P.tail0.y - p.H * 0.08, P.tail0.z - p.H * 0.12);
  P.tail2 = V(0, P.tail1.y - p.H * 0.07, P.tail1.z - p.H * 0.13);
  P.hair0 = V(0, P.headC.y + p.headH * 0.15, P.headC.z - p.headD * 0.5);
  P.hair1 = V(0, P.hair0.y - p.H * 0.12, P.hair0.z - 0.02);
  return P;
}

// ---------- geometry ----------

/**
 * Collects triangles in model space with colour and skin attributes. add() takes a geometry that
 * already carries `color`, `skinIndex`, `skinWeight` (from paint()) or paints it uniformly.
 */
// Surface kinds, written per vertex as the `surf` attribute and read by the figure shader
// (stylize): metal and hair get a highlight, chain gets a ring pattern, skin a warm floor.
const SURF = { cloth: 0, skin: 1, hair: 2, metal: 3, leather: 4, gloss: 5, chain: 6 };
// hex (lower case) -> surface kind, filled for the duration of one build (buildBody, propGeometry)
let SURFS = null;
/** Surface kind of a colour value: a tagged Color carries its own, a hex is looked up in SURFS. */
function surfOf(v) {
  if (v && v.isColor) return v.surf || 0;
  return (SURFS && typeof v === 'string' && SURFS.get(v.toLowerCase())) || 0;
}
const tagged = (c, surf) => { c.surf = surf; return c; };

class Mesher {
  constructor() { this.parts = []; }
  add(geo, colour = null, weights = null) {
    if (colour != null || weights != null) paint(geo, colour, weights);
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    this.parts.push(geo.index ? geo.toNonIndexed() : geo);
    return geo;
  }
  build() {
    const T = E();
    let n = 0;
    for (const g of this.parts) n += g.getAttribute('position').count;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
    const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4), sf = new Float32Array(n);
    let o = 0;
    for (const g of this.parts) {
      const c = g.getAttribute('position').count;
      pos.set(g.getAttribute('position').array, o * 3);
      nor.set(g.getAttribute('normal').array, o * 3);
      col.set(g.getAttribute('color').array, o * 3);
      if (g.getAttribute('surf')) sf.set(g.getAttribute('surf').array, o);
      si.set(g.getAttribute('skinIndex').array, o * 4);
      sw.set(g.getAttribute('skinWeight').array, o * 4);
      o += c;
      g.dispose();
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new T.BufferAttribute(nor, 3));
    geo.setAttribute('color', new T.BufferAttribute(col, 3));
    geo.setAttribute('skinIndex', new T.BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new T.BufferAttribute(sw, 4));
    geo.setAttribute('surf', new T.BufferAttribute(sf, 1));
    geo.computeBoundingSphere();
    return geo;
  }
}

const COL = new Map();
function colour(hex) {
  if (hex && hex.isColor) return hex;
  let c = COL.get(hex);
  if (!c) { c = new (E().Color)(hex || '#ff00ff'); COL.set(hex, c); }
  return c;
}
/** weights: a bone name, [[bone, w], ...], or a function (x, y, z) -> either. Results are cached by input. */
const W_STR = new Map(), W_ARR = new WeakMap();
function normWeights(w) {
  if (typeof w === 'string') { let r = W_STR.get(w); if (!r) W_STR.set(w, r = [[BI[w], 1]]); return r; }
  if (Array.isArray(w)) { let r = W_ARR.get(w); if (!r) W_ARR.set(w, r = normWeightsRaw(w)); return r; }
  return normWeightsRaw(w);
}
function normWeightsRaw(w) {
  if (typeof w === 'number') return [[w, 1]];
  const out = w.map(([b, v]) => [typeof b === 'string' ? BI[b] : b, v]).filter(e => e[1] > 0.001);
  const s = out.reduce((t, e) => t + e[1], 0) || 1;
  return out.slice(0, 4).map(([b, v]) => [b, v / s]);
}
/** Write color / surf / skinIndex / skinWeight attributes. colourFn and weightFn may be constants. */
function paint(geo, colourFn, weightFn) {
  const T = E(), P = geo.getAttribute('position'), n = P.count;
  const col = new Float32Array(n * 3), sf = new Float32Array(n), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  const cConst = typeof colourFn === 'function' ? null : colour(colourFn), sConst = surfOf(colourFn);
  const wConst = typeof weightFn === 'function' ? null : normWeights(weightFn || 'root');
  for (let i = 0; i < n; i++) {
    const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
    const v = cConst ? null : colourFn(x, y, z, i), c = cConst || colour(v);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    sf[i] = cConst ? sConst : surfOf(v);
    const w = wConst || normWeights(weightFn(x, y, z, i));
    for (let j = 0; j < w.length; j++) { si[i * 4 + j] = w[j][0]; sw[i * 4 + j] = w[j][1]; }
  }
  geo.setAttribute('color', new T.BufferAttribute(col, 3));
  geo.setAttribute('surf', new T.BufferAttribute(sf, 1));
  geo.setAttribute('skinIndex', new T.BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new T.BufferAttribute(sw, 4));
  return geo;
}

/**
 * computeVertexNormals, then average normals across vertices that share a position, so the UV
 * seam and poles of a deformed SphereGeometry do not show as a crease.
 */
function smoothNormals(geo) {
  geo.computeVertexNormals();
  const P = geo.getAttribute('position'), N = geo.getAttribute('normal'), groups = new Map();
  for (let i = 0; i < P.count; i++) {
    const key = Math.round(P.getX(i) * 1e4) + ',' + Math.round(P.getY(i) * 1e4) + ',' + Math.round(P.getZ(i) * 1e4);
    let g = groups.get(key);
    if (!g) groups.set(key, g = []);
    g.push(i);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    let x = 0, y = 0, z = 0;
    for (const i of g) { x += N.getX(i); y += N.getY(i); z += N.getZ(i); }
    const l = Math.hypot(x, y, z) || 1;
    for (const i of g) N.setXYZ(i, x / l, y / l, z / l);
  }
  return geo;
}

/**
 * A tube of rings along y. Each ring: { y, rx, rz, rzF?, rzB?, x?, z?, sq?, w, c? }.
 * rzF / rzB are the depth in front of and behind the centre (bust, calves, belly). sq > 2 makes
 * the section boxier. `c` is a colour or (angle, y) -> colour; angle 0 is the front (+z), pi/2
 * the figure's left (+x). Rings may share a y (a hem): the zero-height band between them is
 * degenerate and only carries the colour change. Ends are domed by `cap` (0 = flat, open = null).
 */
function loft(rings, seg, { capTop = 0.6, capBottom = 0.6, colourOf = null } = {}) {
  const T = E();
  // rounded ends: rings on a quarter circle above (below) the end ring, then a small final fan
  const domeOf = (g, dir, dome) => {
    if (dome == null || dome < 0.3) return [];
    const h = dome * Math.min(g.rx, g.rz), out = [];
    for (const th of [0.5, 0.95, 1.3]) {
      const c = Math.cos(th);
      out.push(Object.assign({}, g, { y: g.y + dir * h * Math.sin(th), rx: g.rx * c, rz: g.rz * c, rzF: g.rzF != null ? g.rzF * c : undefined, rzB: g.rzB != null ? g.rzB * c : undefined }));
    }
    return out;
  };
  {
    const up0 = rings[rings.length - 1].y > rings[0].y;
    const hi = up0 ? rings[rings.length - 1] : rings[0], lo = up0 ? rings[0] : rings[rings.length - 1];
    const top = domeOf(hi, 1, capTop), bot = domeOf(lo, -1, capBottom);
    rings = up0 ? [...bot.reverse(), ...rings, ...top] : [...top.reverse(), ...rings, ...bot];
    // the fan closes the last 4% of the dome height over a ring of 27% radius
    if (top.length) capTop *= 0.15;
    if (bot.length) capBottom *= 0.15;
  }
  const R = rings.length, pos = [], col = [], sf = [], si = [], sw = [], idx = [];
  const push = (x, y, z, ring, a, w) => {
    pos.push(x, y, z);
    const v = colourOf ? colourOf(a, y, ring) : (typeof ring.c === 'function' ? ring.c(a, y) : ring.c || '#ff00ff'), cc = colour(v);
    col.push(cc.r, cc.g, cc.b);
    sf.push(surfOf(v));
    for (let j = 0; j < 4; j++) { si.push(w[j] ? w[j][0] : 0); sw.push(w[j] ? w[j][1] : 0); }
  };
  for (const g of rings) {
    const sq = g.sq || 2, w = normWeights(g.w || 'root');
    for (let k = 0; k < seg; k++) {
      const a = k / seg * TAU;
      let sx = Math.sin(a), cz = Math.cos(a);
      if (sq !== 2) { sx = Math.sign(sx) * Math.pow(Math.abs(sx), 2 / sq); cz = Math.sign(cz) * Math.pow(Math.abs(cz), 2 / sq); }
      const rz = cz >= 0 ? (g.rzF != null ? g.rzF : g.rz) : (g.rzB != null ? g.rzB : g.rz);
      push((g.x || 0) + sx * g.rx, g.y, (g.z || 0) + cz * rz, g, a, w);
    }
  }
  const up = rings[R - 1].y > rings[0].y;
  for (let r = 0; r < R - 1; r++) for (let k = 0; k < seg; k++) {
    const a = r * seg + k, b = r * seg + (k + 1) % seg, c = a + seg, d = b + seg;
    if (up) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d);
  }
  // a dome over one end ring; isMax says whether that end is the higher one
  const cap = (ri, dome) => {
    const g = rings[ri], isMax = g.y >= rings[ri === 0 ? R - 1 : 0].y;
    const ci = pos.length / 3;
    push(g.x || 0, g.y + (isMax ? 1 : -1) * dome * Math.min(g.rx, g.rz), g.z || 0, g, 0, normWeights(g.w || 'root'));
    for (let k = 0; k < seg; k++) {
      const a = ri * seg + k, b = ri * seg + (k + 1) % seg;
      if (isMax) idx.push(ci, a, b); else idx.push(ci, b, a);
    }
  };
  if (capTop != null) cap(up ? R - 1 : 0, capTop);
  if (capBottom != null) cap(up ? 0 : R - 1, capBottom);
  const geo = new T.BufferGeometry();
  geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new T.Float32BufferAttribute(col, 3));
  geo.setAttribute('surf', new T.Float32BufferAttribute(sf, 1));
  geo.setAttribute('skinIndex', new T.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new T.Float32BufferAttribute(sw, 4));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * A tube along a polyline. radius(t) -> r or [r1, r2] (r2 along the up direction); up(i) is an
 * optional orientation vector per point. Frames by parallel transport. Winding is checked
 * against the outward direction of the first ring and flipped if needed.
 */
function sweep(path, radius, seg, colourFn, weightFn, { up = null, cap0 = 0.5, cap1 = 0.5 } = {}) {
  const T = E(), V = T.Vector3;
  const n = path.length, pos = [], col = [], sf = [], si = [], sw = [], idx = [];
  const tan = [], nor = [], bin = [];
  for (let i = 0; i < n; i++) {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(n - 1, i + 1)];
    tan.push(new V().subVectors(b, a).normalize());
  }
  let N0 = up ? up(0).clone() : new V(0, 1, 0);
  if (Math.abs(N0.dot(tan[0])) > 0.95) N0 = new V(1, 0, 0);
  for (let i = 0; i < n; i++) {
    let N = up ? up(i).clone() : (i ? nor[i - 1].clone() : N0);
    N.sub(tan[i].clone().multiplyScalar(N.dot(tan[i]))).normalize();
    if (!isFinite(N.x) || N.lengthSq() < 0.5) N = new V(1, 0, 0).sub(tan[i].clone().multiplyScalar(tan[i].x)).normalize();
    nor.push(N);
    bin.push(new V().crossVectors(tan[i], N).normalize());
  }
  const ringOf = (t) => {
    const v = typeof colourFn === 'function' ? colourFn(t) : colourFn;
    return [colour(v), normWeights(typeof weightFn === 'function' ? weightFn(t) : weightFn), surfOf(v)];
  };
  const pushV = (p, [c, w, f]) => {
    pos.push(p.x, p.y, p.z);
    col.push(c.r, c.g, c.b);
    sf.push(f);
    for (let j = 0; j < 4; j++) { si.push(w[j] ? w[j][0] : 0); sw.push(w[j] ? w[j][1] : 0); }
  };
  const tmp = new V();
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0;
    let r = radius(t);
    const [r1, r2] = Array.isArray(r) ? r : [r, r], cw = ringOf(t);
    for (let k = 0; k < seg; k++) {
      const a = k / seg * TAU;
      tmp.copy(path[i]).addScaledVector(nor[i], Math.cos(a) * r2).addScaledVector(bin[i], Math.sin(a) * r1);
      pushV(tmp, cw);
    }
  }
  // winding test on the first quad
  let flip = false;
  if (n > 1) {
    const p0 = new V().fromArray(pos, 0), p1 = new V().fromArray(pos, 3), p2 = new V().fromArray(pos, seg * 3);
    const fn = new V().crossVectors(new V().subVectors(p1, p0), new V().subVectors(p2, p0));
    const out = new V().subVectors(p0, path[0]);
    flip = fn.dot(out) < 0;
  }
  const tri = (a, b, c) => { if (flip) idx.push(a, c, b); else idx.push(a, b, c); };
  for (let i = 0; i < n - 1; i++) for (let k = 0; k < seg; k++) {
    const a = i * seg + k, b = i * seg + (k + 1) % seg, c = a + seg, d = b + seg;
    tri(a, b, c); tri(b, d, c);
  }
  const capAt = (i, dome, end) => {
    const t = n > 1 ? i / (n - 1) : 0, r = radius(t), rr = Array.isArray(r) ? Math.min(r[0], r[1]) : r;
    const c = path[i].clone().addScaledVector(tan[i], (end ? 1 : -1) * dome * rr);
    const ci = pos.length / 3;
    pushV(c, ringOf(t));
    for (let k = 0; k < seg; k++) {
      const a = i * seg + k, b = i * seg + (k + 1) % seg;
      if (end) tri(ci, a, b); else tri(ci, b, a);
    }
  };
  if (cap0 != null) capAt(0, cap0, false);
  if (cap1 != null) capAt(n - 1, cap1, true);
  const geo = new T.BufferGeometry();
  geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new T.Float32BufferAttribute(col, 3));
  geo.setAttribute('surf', new T.Float32BufferAttribute(sf, 1));
  geo.setAttribute('skinIndex', new T.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new T.Float32BufferAttribute(sw, 4));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** An ellipsoid centred at (x, y, z) with radii (rx, ry, rz); flat = cut at the local bottom. */
function blob(x, y, z, rx, ry, rz, { w = 12, h = 8, flatBottom = false, rot = null } = {}) {
  const T = E();
  const g = new T.SphereGeometry(1, w, h);
  const P = g.getAttribute('position');
  for (let i = 0; i < P.count; i++) {
    let px = P.getX(i), py = P.getY(i), pz = P.getZ(i);
    if (flatBottom && py < 0) py *= 0.15;
    P.setXYZ(i, px * rx, py * ry, pz * rz);
  }
  if (rot) g.applyMatrix4(new T.Matrix4().makeRotationFromEuler(new T.Euler(rot[0], rot[1], rot[2])));
  g.translate(x, y, z);
  g.computeVertexNormals();
  return g;
}
/** A cone from base point b to tip t with base radius r (flattened by `flat` across `side`). */
function spike(b, t, r, seg = 6, flat = 1, side = null) {
  const T = E();
  const len = b.distanceTo(t);
  const g = new T.ConeGeometry(r, len, seg, 1);
  g.scale(1, 1, flat);
  g.translate(0, len / 2, 0);
  const dir = new T.Vector3().subVectors(t, b).normalize();
  const q = new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 1, 0), dir);
  if (side) {
    // roll so the flat side faces `side`
    const m = new T.Matrix4().makeRotationFromQuaternion(q);
    const zAxis = new T.Vector3(0, 0, 1).applyMatrix4(m);
    const want = side.clone().sub(dir.clone().multiplyScalar(side.dot(dir))).normalize();
    const ang = Math.atan2(new T.Vector3().crossVectors(zAxis, want).dot(dir), zAxis.dot(want));
    q.premultiply(new T.Quaternion().setFromAxisAngle(dir, ang));
  }
  g.applyQuaternion(q);
  g.translate(b.x, b.y, b.z);
  return g;
}
/** A flat polygon (triangle fan from pts[0]) with both faces, for wings and fins. */
function sheet(pts, thick = 0.003) {
  const T = E(), pos = [];
  const nrm = new T.Vector3().crossVectors(new T.Vector3().subVectors(pts[1], pts[0]), new T.Vector3().subVectors(pts[2], pts[0])).normalize();
  const off = nrm.clone().multiplyScalar(thick / 2);
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[0], b = pts[i], c = pts[i + 1];
    pos.push(a.x + off.x, a.y + off.y, a.z + off.z, b.x + off.x, b.y + off.y, b.z + off.z, c.x + off.x, c.y + off.y, c.z + off.z);
    pos.push(a.x - off.x, a.y - off.y, a.z - off.z, c.x - off.x, c.y - off.y, c.z - off.z, b.x - off.x, b.y - off.y, b.z - off.z);
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// ---------- body ----------

const mix = (a, b, t) => tagged(colour(a).clone().lerp(colour(b), t), surfOf(a));
const shade = (hex, k) => tagged(colour(hex).clone().multiplyScalar(k), surfOf(hex));
/** Metal under a fixed highlight: brighter toward the front-left of the ring, darker behind. */
const sheen = (hex, a) => shade(hex, 0.86 + 0.32 * Math.max(0, Math.cos(a - 0.7)) ** 2);

/** Head surface for a unit direction, in head-local units (centre origin, before scaling). */
function headShape(hd, x, y, z) {
  const low = sstep(0.05, -0.95, y);                 // 0 above the cheekbones, 1 at the chin
  let jaw = hd.jaw;
  x *= 1 - low * (1 - jaw) * 0.42;
  if (z > 0) z *= 1 - low * 0.12 + low * hd.chin * 0.1;
  if (y > 0) x *= 1 + y * 0.04;
  if (z < 0) z *= 1.08 + 0.04 * Math.max(0, y);
  // cheeks: in at the sides below the eyes when hollow, out when plump
  const cheekBand = Math.exp(-Math.pow((y + 0.25) / 0.25, 2)) * Math.max(0, z);
  x *= 1 + hd.cheek * 0.07 * cheekBand;
  if (!hd.muzzle && hd.kind !== 'alien') {
    if (z > 0.55) z = 0.55 + (z - 0.55) * 0.8;                                                   // face plane
    x *= 1 + 0.045 * Math.exp(-Math.pow((y + 0.05) / 0.14, 2)) * sstep(0.2, 0.7, z);           // cheekbones
    x *= 1 - 0.05 * Math.exp(-Math.pow((y - 0.3) / 0.18, 2)) * sstep(0.3, 0.8, z);              // temples
    z += 0.06 * (0.4 + hd.brow) * Math.exp(-Math.pow((y - 0.2) / 0.07, 2)) * sstep(0.5, 0.8, z) * (1 - x * x);   // brow ridge
    z += 0.07 * (0.5 + hd.chin) * Math.exp(-Math.pow((y + 0.84) / 0.13, 2)) * sstep(0.2, 0.7, z) * (1 - 2 * x * x); // chin
  }
  if (hd.flat && y > 0.6) y = 0.6 + (y - 0.6) * 0.4;
  if (hd.kind === 'alien') { if (y > 0) { y *= 1.35; z -= y * 0.25; } x *= 1 - low * 0.3; }
  if (hd.kind === 'skull') { x *= 1 - low * 0.2; }
  if (hd.kind === 'lizard' || hd.kind === 'wolf' || hd.kind === 'rat' || hd.kind === 'mouse') { if (y > 0) y *= 0.9; }
  return [x, y, z];
}

/** Which of a character's colours are skin, hair, metal, chain, leather or gloss. */
function surfacesOf(look) {
  const m = new Map(), reg = (hex, kind) => { if (typeof hex === 'string' && !m.has(hex.toLowerCase())) m.set(hex.toLowerCase(), kind); };
  reg(look.skin, SURF.skin);
  for (const h of [look.hair, look.beard, look.stache]) if (h) reg(h.colour, SURF.hair);
  if (look.ears && look.ears.furry) reg(look.ears.colour, SURF.hair);
  if (look.tail && look.tail.kind !== 'lizard') reg(look.tail.colour, SURF.hair);
  if (look.mail) { reg(look.mail.metal, look.mail.kind === 'medium' ? SURF.chain : SURF.metal); reg(look.mail.leather, SURF.leather); }
  for (const g of [look.helm, look.boots]) if (g) { reg(g.metal, SURF.metal); reg(g.leather, SURF.leather); }
  if (look.armPlate) reg(look.armPlate, SURF.metal);
  if (look.visor) reg(look.visor.metal, SURF.metal);
  if (look.legs && look.legs.cut === 'plate') reg(look.legs.colour, SURF.metal);
  if (look.feet) reg(look.feet.colour, look.feet.cut === 'plate' ? SURF.metal : /boots|fold|rim|shoes|hoofs/.test(look.feet.cut) ? SURF.leather : SURF.cloth);
  if (look.horns) reg(look.horns.colour, SURF.leather);
  for (const g of ['#efece6', '#d6c24a', look.eye, '#efe6cc', '#f4f0e6', '#1c140c', '#0c0a12', '#79c8ff']) reg(g, SURF.gloss);
  reg('#2a2420', SURF.leather);
  return m;
}

function buildBody(look) {
  const prev = SURFS;
  SURFS = surfacesOf(look);
  try { return buildBodyRaw(look); } finally { SURFS = prev; }
}

function buildBodyRaw(look) {
  const T = E(), V = T.Vector3;
  const p = look.p, r = p.r, Bp = bindPositions(look);
  const M = new Mesher();
  const SEG = 14;
  const skin = look.skin;
  const sh = look.shirt, lg = look.legs, ft = look.feet, mail = look.mail, boots = look.boots;
  const metal = mail ? mail.metal : null;
  const hipY = Bp.hips.y, spineY = Bp.spine.y, chestY = Bp.chest.y, neckY = Bp.neck.y, headY = Bp.head.y;

  // ----- torso colours -----
  const waistY = spineY + p.waist * 0.35;            // trouser waistband
  const shirtBottom = sh ? (sh.body === 'tunic' || sh.body === 'robe' ? hipY - p.pelvis * 0.4 : waistY + p.waist * 0.07) : waistY;
  const legCol = lg ? (lg.cut === 'plate' ? lg.colour : lg.colour) : skin;
  const belt = shade(sh ? sh.colour : legCol, 0.45);
  const mailCol = mail ? (mail.kind === 'light' ? mail.leather : mail.metal) : null;
  const torsoColour = (a, y) => {
    const front = Math.cos(a), sideAbs = Math.abs(Math.sin(a));
    // neckline cut-outs
    if (sh && !mailCol && front > 0) {
      const topY = neckY - 0.005;
      if (sh.neck === 'v' && y > topY - p.chest * (0.45 - sideAbs * 1.2)) return skin;
      if (sh.neck === 'scoop' && y > topY - p.chest * (0.3 - sideAbs * 0.5) && front > 0.4) return skin;
    }
    if (mailCol && y > waistY - p.waist * 0.2 && y < neckY + 0.01) {
      if (mail.kind === 'light' && front > 0.85 && Math.abs(y - chestY - p.chest * 0.45) < p.chest * 0.25 && (Math.round(y * 160) % 3 === 0)) return mail.metal;
      if (mail.kind === 'medium') return mix(mailCol, '#ffffff', (hash3(Math.round(a * 20), Math.round(y * 300), 3) - 0.5) * 0.25 + 0.0);
      if (mail.kind === 'heavy') return Math.abs(y - (chestY - p.waist * 0.15)) < p.waist * 0.06 ? shade(mailCol, 0.6) : sheen(mailCol, a);
      return mailCol;
    }
    if (y > shirtBottom && sh) {
      let c = sh.colour;
      if (sh.stripes && Math.floor((neckY - y) / (p.H * 0.022)) % 2) c = shade(c, 0.6);
      if ((sh.neck === 'cardigan' || sh.neck === 'buttoned' || sh.neck === 'laced') && Math.abs(Math.sin(a)) < (sh.neck === 'cardigan' ? 0.16 : 0.05) && front > 0) {
        return sh.neck === 'cardigan' ? mix(sh.colour, '#f0ece0', 0.6) : shade(sh.colour, 0.55);
      }
      return c;
    }
    if (Math.abs(y - waistY) < p.waist * 0.07 && lg && lg.cut !== 'plate') return belt;
    if (y < waistY) return lg ? (lg.cut === 'gown' || lg.cut === 'skirt' || lg.cut === 'legion' ? (sh ? sh.colour : legCol) : legCol) : skin;
    return sh ? sh.colour : skin;
  };

  // ----- torso -----
  const bulk = mail && mail.kind === 'heavy' ? 1.1 : mail ? 1.05 : 1;
  const belly = p.belly;
  const bustF = p.bust ? 1 + 0.32 * p.bust : 1;
  const hemYs = [waistY - p.waist * 0.07, waistY + p.waist * 0.07, shirtBottom];
  const shoulderTop = Math.min(p.chestW * 1.02, p.shoulder - r.arm * 0.3);
  const pecF = 1 + p.pec, pecChest = Math.max(bustF, pecF);
  let torso = [
    { y: hipY - p.pelvis * 0.4, rx: p.pelvisW * 0.52, rz: p.pelvisD * 0.62, w: 'hips' },
    { y: hipY - p.pelvis * 0.08, rx: p.pelvisW * 0.94, rz: p.pelvisD * 0.95, rzB: p.pelvisD * 1.05, w: 'hips' },
    { y: hipY + p.pelvis * 0.4, rx: p.pelvisW, rz: p.pelvisD, rzB: p.pelvisD * 1.08, w: 'hips' },
    { y: spineY, rx: lerp(p.pelvisW, p.waistW, 0.6), rz: lerp(p.pelvisD, p.waistD, 0.6) * (1 + belly * 0.1), w: [['hips', 0.5], ['spine', 0.5]] },
    { y: spineY + p.waist * 0.55, rx: p.waistW * bulk, rz: p.waistD * bulk, rzF: p.waistD * bulk * (1 + belly * 0.25), w: 'spine' },
    { y: chestY, rx: lerp(p.waistW, p.chestW, 0.6) * bulk, rz: lerp(p.waistD, p.chestD, 0.6) * bulk, rzF: lerp(p.waistD, p.chestD, 0.6) * bulk * (1 + belly * 0.12), w: [['spine', 0.5], ['chest', 0.5]] },
    { y: chestY + p.chest * 0.42, rx: p.chestW * bulk, rz: p.chestD * bulk, rzF: p.chestD * bulk * pecChest, sq: 2.15, w: 'chest' },
    { y: chestY + p.chest * 0.58, rx: lerp(p.chestW, shoulderTop, 0.5) * bulk, rz: p.chestD * bulk, rzF: p.chestD * bulk * lerp(1, pecChest, 0.75), rzB: p.chestD * bulk * 1.07, sq: 2.2, w: 'chest' },
    { y: chestY + p.chest * 0.74, rx: shoulderTop * bulk, rz: p.chestD * 0.9 * bulk, rzB: p.chestD * 0.96 * bulk, sq: 2.2, w: 'chest' },
    { y: chestY + p.chest * 0.88, rx: shoulderTop * 0.82 * bulk, rz: p.chestD * 0.76, sq: 2.1, w: 'chest' },
    { y: chestY + p.chest * 0.97, rx: lerp(r.neck * 1.5, p.chestW * 0.62, 0.65), rz: p.chestD * 0.6, w: [['chest', 0.85], ['neck', 0.15]] },
    { y: neckY + p.neck * 0.35, rx: r.neck * 1.32, rz: r.neck * 1.22, w: [['chest', 0.35], ['neck', 0.65]] },
  ];
  const torsoAt = (y) => {
    for (let i = 0; i < torso.length - 1; i++) {
      const a = torso[i], b = torso[i + 1];
      if (y >= a.y && y <= b.y) {
        const t = (y - a.y) / (b.y - a.y), d = (g) => Math.max(g.rz, g.rzF || 0, g.rzB || 0);
        return [lerp(a.rx, b.rx, t), lerp(d(a), d(b), t)];
      }
    }
    return y < torso[0].y ? [torso[0].rx, torso[0].rz] : [p.chestW, p.chestD];
  };
  torso = refine(torso, hemYs);
  M.add(loft(torso, 20, { capTop: null, capBottom: 0.35, colourOf: (a, y) => torsoColour(a, y) }));
  // neck
  const neckCol = look.helm && look.helm.kind === 'light' ? look.helm.leather : skin;
  M.add(loft([
    { y: neckY - p.neck * 0.3, rx: r.neck, rz: r.neck, w: 'neck', c: neckCol },
    { y: headY + p.headH * 0.12, rx: r.neck * 0.95, rz: r.neck * 0.95, z: 0.004, w: [['neck', 0.3], ['head', 0.7]], c: neckCol },
    { y: headY + p.headH * 0.3, rx: r.neck * 0.9, rz: r.neck * 0.9, z: 0.006, w: 'head', c: neckCol },
  ], 10, { capTop: null, capBottom: null }));

  // ----- arms -----
  const sleeve = sh ? sh.sleeve : 'none';
  for (const [s, side] of [[1, 'L'], [-1, 'R']]) {
    const J = Bp['arm' + side], ex = J.x, elbowY = J.y - p.upperArm, wristY = elbowY - p.forearm;
    const A = 'arm' + side, F = 'fore' + side, Hd = 'hand' + side, C = 'clav' + side;
    const sleeveEnd = sleeve === 'long' ? wristY + p.forearm * 0.04 : sleeve === 'short' ? J.y - p.upperArm * 0.5 : sleeve === 'puff' ? J.y - p.upperArm * 0.42 : J.y + 0.02;
    const plate = (mail && mail.kind === 'heavy') || look.armPlate;
    const chain = mail && mail.kind === 'medium';
    const plateCol = look.armPlate || (mail && mail.metal);
    const armColour = (a, y) => {
      if (plate && y < J.y + 0.03) {
        if (y < wristY + p.forearm * 0.1) return skin;
        if (Math.abs(y - elbowY) < p.forearm * 0.07) return shade(plateCol, 0.55);
        return Math.floor((J.y - y) / (p.H * 0.05)) % 2 ? shade(sheen(plateCol, a), 0.88) : sheen(plateCol, a);
      }
      if (chain && y > elbowY - p.forearm * 0.05) return mix(mail.metal, '#ffffff', 0.05);
      if (chain && y < wristY + p.forearm * 0.45 && y > wristY + p.forearm * 0.05) return mail.metal;    // bracers
      if (mail && mail.kind === 'light' && y > J.y - p.upperArm * 0.25) return mail.leather;
      if (sh && y > sleeveEnd) return sh.colour;
      return skin;
    };
    const puff = sleeve === 'puff' ? 1.35 : sh && sh.body === 'robe' ? 1.15 : sleeve === 'long' ? 1.07 : 1;
    const pl = plate ? 1.15 : chain ? 1.06 : 1;
    let rings = [
      { y: J.y, rx: r.arm * 1.07 * pl, rz: r.arm * 1.12 * pl, x: ex - s * r.arm * 0.15, w: [[A, 0.65], [C, 0.35]] },
      { y: J.y - p.upperArm * 0.2, rx: r.arm * 1.1 * puff * pl, rz: r.arm * 1.1 * puff * pl, x: ex + s * r.arm * 0.06, w: A },
      { y: J.y - p.upperArm * 0.55, rx: r.arm * 0.94 * puff * pl, rz: r.arm * 1.0 * puff * pl, x: ex, w: A },
      { y: J.y - p.upperArm * 0.86, rx: r.elbow * 1.05 * pl, rz: r.elbow * 1.08 * pl, x: ex, w: A },
      { y: elbowY, rx: r.elbow * pl, rz: r.elbow * pl, x: ex, w: [[A, 0.5], [F, 0.5]] },
      { y: elbowY - p.forearm * 0.25, rx: r.fore * 1.08 * pl, rz: r.fore * 1.1 * pl, x: ex, w: F },
      { y: elbowY - p.forearm * 0.6, rx: r.fore * 0.86 * pl, rz: r.fore * 0.92 * pl, x: ex, w: F },
      { y: wristY + p.forearm * 0.12, rx: r.wrist * 1.1 * (chain ? 1.25 : pl), rz: r.wrist * 1.0 * (chain ? 1.25 : pl), x: ex, w: F },
      { y: wristY, rx: r.wrist, rz: r.wrist * 0.9, x: ex, w: [[F, 0.6], [Hd, 0.4]] },
    ];
    rings = refine(rings, [sleeveEnd, wristY + p.forearm * 0.45, wristY + p.forearm * 0.05, elbowY - p.forearm * 0.05]);
    M.add(loft(rings, 12, { capTop: 0.7, capBottom: 0.3, colourOf: (a, y) => armColour(a, y) }));
    if (sh && !mail && (sleeve === 'short' || sleeve === 'long' || sleeve === 'puff')) {
      const [cr, cz] = radiusAt(rings, sleeveEnd), lip = sleeve === 'puff' ? 1.05 : 1.12, F2 = sleeveEnd < elbowY ? F : A;
      M.add(loft([
        { y: sleeveEnd + p.H * 0.008, rx: cr * lip, rz: cz * lip, x: ex, w: F2, c: shade(sh.colour, 0.9) },
        { y: sleeveEnd - p.H * 0.003, rx: cr * lip, rz: cz * lip, x: ex, w: F2, c: shade(sh.colour, 0.72) },
      ], 12, { capTop: null, capBottom: null }));
    }
    // cuffs and robe sleeves
    if (sh && sh.body === 'robe') {
      M.add(loft([
        { y: elbowY - p.forearm * 0.3, rx: r.fore * 1.25, rz: r.fore * 1.25, x: ex, w: F, c: sh.colour },
        { y: wristY + p.forearm * 0.05, rx: r.fore * 2.0, rz: r.fore * 1.9, x: ex, z: -0.006, w: F, c: shade(sh.colour, 0.85) },
      ], 10, { capTop: null, capBottom: null }));
    }
    // hand: a flat palm, the fingers curled a little toward the thigh, and a thumb in front
    const hc = plate && look.armPlate ? plateCol : skin;
    M.add(blob(ex, wristY - p.hand * 0.3, 0.003, r.wrist * 0.92, p.hand * 0.38, r.wrist * 1.5, { w: 10, h: 6 }), hc, Hd);
    M.add(blob(ex - s * r.wrist * 0.22, wristY - p.hand * 0.72, 0.001, r.wrist * 0.82, p.hand * 0.34, r.wrist * 1.38, { w: 10, h: 6, rot: [0, 0, s * 0.3] }), shade(hc, 0.96), Hd);
    M.add(blob(ex - s * r.wrist * 0.15, wristY - p.hand * 0.36, 0.003 + r.wrist * 1.32, r.wrist * 0.42, p.hand * 0.3, r.wrist * 0.42, { w: 6, h: 5, rot: [0.35, 0, s * 0.35] }), hc, Hd);
  }

  // ----- legs -----
  const cut = lg ? lg.cut : 'bare';
  const feetCutv = boots ? (boots.kind === 'heavy' ? 'plate' : boots.kind === 'medium' ? 'rim' : 'boots') : ft ? ft.cut : 'bare';
  const bootCol = boots ? (boots.kind === 'light' ? boots.leather : boots.kind === 'heavy' ? boots.metal : boots.leather) : ft ? ft.colour : skin;
  for (const [s, side] of [[1, 'L'], [-1, 'R']]) {
    const J = Bp['thigh' + side], kneeY = J.y - p.thigh, ankY = p.ankle;
    const Th = 'thigh' + side, Sh = 'shin' + side, Ft = 'foot' + side;
    const kx = Bp['shin' + side].x, ax = Bp['foot' + side].x;
    const bootTop = feetCutv === 'plate' ? kneeY - p.shin * 0.02 : feetCutv === 'boots' || feetCutv === 'rim' || feetCutv === 'fold' ? kneeY - p.shin * 0.42 : ankY + p.shin * 0.02;
    // legEnd: the garment's lower hem; the leg below it is bare
    const legEnd = cut === 'short' ? J.y - p.thigh * 0.3 : cut === 'shorts' ? J.y - p.thigh * 0.72 : cut === 'skirt' || cut === 'gown' || cut === 'legion' ? J.y + 1 : ankY;
    const greaves = cut === 'plate' || (mail && mail.kind === 'heavy');
    const legColour = (a, y) => {
      if (y < bootTop) return feetCutv === 'bare' || feetCutv === 'sandals' ? skin : feetCutv === 'rim' && y > bootTop - p.shin * 0.08 ? (boots ? boots.metal : shade(bootCol, 1.4)) : feetCutv === 'plate' ? sheen(bootCol, a) : bootCol;
      if (greaves) {
        const gc = (mail && mail.kind === 'heavy') ? mail.metal : legCol;
        return Math.floor((J.y - y) / (p.H * 0.055)) % 2 ? shade(sheen(gc, a), 0.88) : sheen(gc, a);
      }
      if (cut === 'bare' || y < legEnd) return skin;
      if (cut === 'cuffed' && y < ankY + p.shin * 0.12) return shade(legCol, 0.75);
      return cut === 'tights' ? shade(legCol, 0.85) : legCol;
    };
    const loose = cut === 'puffy' ? 1.3 : cut === 'wide' ? 1.22 : cut === 'pants' || cut === 'cuffed' ? 1.06 : 1;
    const g = greaves ? 1.12 : 1;
    const bootR = feetCutv === 'boots' || feetCutv === 'rim' || feetCutv === 'fold' || feetCutv === 'plate' ? 1.18 : 1;
    let rings = [
      { y: J.y + 0.04, rx: r.thigh * 1.04, rz: r.thigh * 1.0, x: J.x * 0.84, w: [[Th, 0.55], ['hips', 0.45]] },
      { y: J.y - p.thigh * 0.15, rx: r.thigh * loose * g, rz: r.thigh * loose * g, x: J.x, w: Th },
      { y: J.y - p.thigh * 0.72, rx: lerp(r.thigh, r.knee, 0.65) * loose * g, rz: lerp(r.thigh, r.knee, 0.65) * loose * g, x: lerp(J.x, kx, 0.72), w: Th },
      { y: kneeY, rx: r.knee * (loose * 0.6 + 0.4) * g, rz: r.knee * 1.05 * (loose * 0.6 + 0.4) * g, x: kx, w: [[Th, 0.5], [Sh, 0.5]] },
      { y: kneeY - p.shin * 0.25, rx: r.calf * loose * g, rz: r.calf * loose * g, rzB: r.calf * 1.25 * loose * g, x: kx, w: Sh },
      { y: kneeY - p.shin * 0.78, rx: r.ankle * 1.2 * (cut === 'puffy' ? 1.5 : loose) * g * bootR, rz: r.ankle * 1.2 * loose * g * bootR, x: lerp(kx, ax, 0.8), w: Sh },
      { y: ankY, rx: r.ankle * bootR, rz: r.ankle * bootR, x: ax, w: [[Sh, 0.6], [Ft, 0.4]] },
    ];
    rings = refine(rings, [bootTop, bootTop - p.shin * 0.08, legEnd, ankY + p.shin * 0.12, kneeY + p.thigh * 0.2]);
    M.add(loft(rings, 10, { capTop: null, capBottom: 0.2, colourOf: (a, y) => legColour(a, y) }));
    if (feetCutv === 'boots' || feetCutv === 'plate') {
      const [br, bz] = radiusAt(rings, bootTop), bc = feetCutv === 'plate' ? sheen(bootCol, 0.7) : shade(bootCol, 1.1);
      M.add(loft([
        { y: bootTop + p.H * 0.006, rx: br * 1.1, rz: bz * 1.1, x: lerp(kx, ax, 0.35), w: Sh, c: bc },
        { y: bootTop - p.H * 0.01, rx: br * 1.06, rz: bz * 1.06, x: lerp(kx, ax, 0.42), w: Sh, c: shade(bootCol, 0.85) },
      ], 10, { capTop: null, capBottom: null }));
    }
    if (cut === 'puffy' && bootTop < kneeY - p.shin * 0.62) {
      // gathered cuff below the knee
      M.add(loft([
        { y: kneeY - p.shin * 0.55, rx: r.calf * 1.15, rz: r.calf * 1.15, x: kx, w: Sh, c: shade(legCol, 0.8) },
        { y: kneeY - p.shin * 0.62, rx: r.calf * 1.15, rz: r.calf * 1.15, x: kx, w: Sh, c: shade(legCol, 0.8) },
      ], 10, { capTop: null, capBottom: null }));
    }
    if (greaves) M.add(blob(kx, kneeY, 0.025, r.knee * 0.9, r.knee * 0.8, r.knee * 0.6, { w: 8, h: 6 }), mail && mail.kind === 'heavy' ? mail.metal : legCol, [[Th, 0.5], [Sh, 0.5]]);
    if (feetCutv === 'fold' || feetCutv === 'rim') {
      M.add(loft([
        { y: bootTop + p.shin * 0.06, rx: r.calf * 1.32, rz: r.calf * 1.32, rzB: r.calf * 1.45, x: lerp(kx, ax, 0.3), w: Sh, c: feetCutv === 'rim' ? (boots ? boots.metal : shade(bootCol, 1.4)) : shade(bootCol, 1.2) },
        { y: bootTop - p.shin * 0.04, rx: r.calf * 1.25, rz: r.calf * 1.25, rzB: r.calf * 1.38, x: lerp(kx, ax, 0.38), w: Sh, c: feetCutv === 'rim' ? (boots ? boots.metal : shade(bootCol, 1.4)) : shade(bootCol, 1.2) },
      ], 10, { capTop: null, capBottom: null }));
    }
    // foot
    const fc = feetCutv === 'bare' ? skin : feetCutv === 'hoofs' ? '#2a2420' : bootCol;
    const fl = feetCutv === 'plate' ? 1.12 : feetCutv === 'bare' || feetCutv === 'sandals' ? 0.95 : 1.05;
    if (feetCutv === 'hoofs') {
      M.add(blob(ax, ankY * 0.5, 0.01, p.footW * 1.1, ankY * 0.62, p.footW * 1.25, { w: 8, h: 6, flatBottom: true }), fc, Ft);
    } else {
      M.add(blob(ax, ankY * 0.42, p.foot * 0.28, p.footW * fl, ankY * 0.62 * fl, p.foot * 0.55 * fl, { w: 10, h: 6, flatBottom: true }), fc, Ft);
      if (feetCutv === 'sandals') M.add(blob(ax, 0.006, p.foot * 0.28, p.footW * 1.1, 0.008, p.foot * 0.58, { w: 8, h: 4 }), ft ? ft.colour : '#6a4a2a', Ft);
    }
  }

  // ----- skirts, robes, tunic hems, mail skirts -----
  const skirt = (topY, botY, rTop, rBot, c, { slit = false, flareB = 1 } = {}) => {
    const n = 4, rings = [];
    const legLoose = lg && lg.cut === 'puffy' ? 1.3 : lg && lg.cut === 'wide' ? 1.22 : 1.06;
    const thighOut = p.hip + r.thigh * legLoose * 1.1;
    for (let i = 0; i <= n; i++) {
      const t = i / n, y = lerp(topY, botY, t);
      const [tx, tz] = torsoAt(y);
      const legX = y < hipY + 0.04 ? thighOut : 0;
      const rx = Math.max(lerp(rTop[0], rBot[0], Math.pow(t, 0.9)), tx * 1.08 + 0.004, legX * 1.06), rz = Math.max(lerp(rTop[1], rBot[1], Math.pow(t, 0.9)), tz * 1.08 + 0.004, y < hipY + 0.04 ? r.thigh * 1.6 : 0);
      rings.push({ y, rx, rz, rzB: rz * (t > 0 ? flareB : 1), c: typeof c === 'function' ? (a) => c(a, t) : (t > 0.85 ? shade(c, 0.85) : c), w: null, t });
    }
    // weights: top on the hips; lower down shared with the thigh on the same side
    const geo = loft(rings, 18, { capTop: null, capBottom: null, colourOf: (a, y, ring) => (typeof ring.c === 'function' ? ring.c(a) : ring.c) });
    const Pp = geo.getAttribute('position'), si = geo.getAttribute('skinIndex'), sw = geo.getAttribute('skinWeight');
    for (let i = 0; i < Pp.count; i++) {
      const x = Pp.getX(i), y = Pp.getY(i);
      const t = clamp01((topY - y) / (topY - botY));
      const leg = x >= 0 ? BI.thighL : BI.thighR;
      const side = clamp01(Math.abs(x) / (rBot[0] * 0.6));
      const wl = t * 0.55 * (0.4 + 0.6 * side);
      si.setXYZW(i, BI.hips, leg, 0, 0);
      sw.setXYZW(i, 1 - wl, wl, 0, 0);
    }
    return M.add(geo);
  };
  const pelvisR = [p.pelvisW * 1.05, p.pelvisD * 1.1];
  const kneeY = hipY - p.thigh;
  if (lg && (lg.cut === 'skirt' || lg.cut === 'gown' || lg.cut === 'legion')) {
    const bot = lg.cut === 'gown' ? p.ankle + p.shin * 0.05 : lg.cut === 'legion' ? hipY - p.thigh * 0.55 : kneeY + p.thigh * 0.05;
    const wide = lg.cut === 'gown' ? 2.5 : lg.cut === 'legion' ? 1.35 : 1.55;
    const legion = lg.cut === 'legion';
    skirt(waistY, bot, [p.waistW * 1.06, p.waistD * 1.08], [pelvisR[0] * wide, pelvisR[1] * wide],
      legion ? (a) => (Math.floor((a / TAU) * 8 + 0.5) % 2 ? lg.colour : shade(lg.colour, 0.62)) : lg.colour, { flareB: 1.1 });
  }
  if (sh && (sh.body === 'robe' || sh.body === 'tunic')) {
    const bot = sh.body === 'robe' ? p.ankle + p.shin * 0.08 : hipY - p.thigh * 0.45;
    const wide = sh.body === 'robe' ? 2.2 : 1.35;
    skirt(waistY - p.waist * 0.05, bot, [p.waistW * 1.08, p.waistD * 1.1], [pelvisR[0] * wide, pelvisR[1] * wide], sh.colour, { flareB: 1.12 });
    M.add(loft([
      { y: waistY + p.waist * 0.08, rx: p.waistW * 1.1, rz: p.waistD * 1.12, w: 'spine', c: shade(sh.colour, 0.45) },
      { y: waistY - p.waist * 0.08, rx: p.waistW * 1.12, rz: p.waistD * 1.14, w: 'spine', c: shade(sh.colour, 0.45) },
    ], 16, { capTop: null, capBottom: null }));
  }
  const clothSkirt = (lg && (lg.cut === 'skirt' || lg.cut === 'gown' || lg.cut === 'legion')) || (sh && (sh.body === 'robe' || sh.body === 'tunic'));
  if (mail && mail.kind !== 'light' && !clothSkirt) {
    skirt(waistY, hipY - p.thigh * (mail.kind === 'heavy' ? 0.2 : 0.4), [p.waistW * 1.12, p.waistD * 1.12], [pelvisR[0] * (mail.kind === 'heavy' ? 1.12 : 1.25), pelvisR[1] * (mail.kind === 'heavy' ? 1.12 : 1.25)],
      mail.kind === 'heavy' ? (a, t) => (t > 0.5 ? shade(sheen(mail.metal, a), 0.82) : sheen(mail.metal, a)) : (a, t) => mix(mail.metal, '#ffffff', hash3(Math.round(a * 30), Math.round(t * 9), 5) * 0.2));
  }
  if (mail && mail.kind === 'heavy') {
    for (const [s, side] of [[1, 'L'], [-1, 'R']]) {
      const J = Bp['arm' + side];
      M.add(blob(J.x + s * 0.006, J.y + 0.01, J.z, r.arm * 1.5, r.arm * 0.95, r.arm * 1.45, { w: 12, h: 6, rot: [0, 0, s * -0.35] }), mix(mail.metal, '#ffffff', 0.1), [['arm' + side, 0.55], ['clav' + side, 0.45]]);
    }
  } else if (mail && mail.kind === 'light') {
    for (const [s, side] of [[1, 'L'], [-1, 'R']]) {
      const J = Bp['arm' + side];
      M.add(blob(J.x, J.y + 0.008, J.z, r.arm * 1.45, r.arm * 0.9, r.arm * 1.4, { w: 8, h: 5, rot: [0, 0, s * -0.3] }), shade(mail.leather, 0.85), [['arm' + side, 0.5], ['clav' + side, 0.5]]);
    }
  }
  if (sh && sh.neck === 'polo') {
    M.add(loft([
      { y: neckY + p.neck * 0.05, rx: r.neck * 1.45, rz: r.neck * 1.4, w: [['chest', 0.6], ['neck', 0.4]], c: shade(sh.colour, 1.1) },
      { y: neckY - p.neck * 0.25, rx: r.neck * 1.6, rz: r.neck * 1.55, w: 'chest', c: shade(sh.colour, 1.1) },
    ], 12, { capTop: null, capBottom: null }));
  }

  buildHead(M, look, Bp);
  buildParts(M, look, Bp);
  const geo = M.build();
  const P = geo.getAttribute('position'), Cc = geo.getAttribute('color');
  for (let i = 0; i < P.count; i++) {
    const k = lerp(0.74, 1, sstep(0, p.H * 0.55, P.getY(i)));
    Cc.setXYZ(i, Cc.getX(i) * k, Cc.getY(i) * k, Cc.getZ(i) * k);
  }
  return { geo, bind: Bp };
}

/** [rx, rz] of a ring list at height y, interpolated (rings sorted by y in either direction). */
function radiusAt(rings, y) {
  for (let i = 0; i < rings.length - 1; i++) {
    const a = rings[i], b = rings[i + 1];
    if ((y - a.y) * (y - b.y) <= 0 && a.y !== b.y) {
      const t = (y - a.y) / (b.y - a.y);
      return [lerp(a.rx, b.rx, t), lerp(a.rz, b.rz, t)];
    }
  }
  const e = Math.abs(y - rings[0].y) < Math.abs(y - rings[rings.length - 1].y) ? rings[0] : rings[rings.length - 1];
  return [e.rx, e.rz];
}

/**
 * Insert rings at each y in `ys` (interpolated from the neighbours), duplicated so a colour edge
 * can sit exactly there. Rings must be sorted by y (either direction).
 */
function refine(rings, ys) {
  let out = rings.slice();
  for (const y of ys) {
    if (y == null || !isFinite(y)) continue;
    for (let i = 0; i < out.length - 1; i++) {
      const a = out[i], b = out[i + 1];
      if ((y - a.y) * (y - b.y) >= 0 || Math.abs(y - a.y) < 1e-4 || Math.abs(y - b.y) < 1e-4) continue;
      const t = (y - a.y) / (b.y - a.y);
      const ring = (dy) => ({
        y: y + dy, rx: lerp(a.rx, b.rx, t), rz: lerp(a.rz, b.rz, t),
        rzF: a.rzF != null || b.rzF != null ? lerp(a.rzF != null ? a.rzF : a.rz, b.rzF != null ? b.rzF : b.rz, t) : undefined,
        rzB: a.rzB != null || b.rzB != null ? lerp(a.rzB != null ? a.rzB : a.rz, b.rzB != null ? b.rzB : b.rz, t) : undefined,
        x: lerp(a.x || 0, b.x || 0, t), z: lerp(a.z || 0, b.z || 0, t), sq: lerp(a.sq || 2, b.sq || 2, t),
        w: t < 0.5 ? a.w : b.w, c: t < 0.5 ? a.c : b.c,
      });
      const dir = Math.sign(b.y - a.y);
      out.splice(i + 1, 0, ring(-dir * 2e-4), ring(dir * 2e-4));
      break;
    }
  }
  return out;
}

// ---------- head, face, hair ----------

function buildHead(M, look, Bp) {
  const T = E(), V = T.Vector3;
  const p = look.p, hd = look.head, C = Bp.headC;
  const hw = p.headW / 2, hh = p.headH / 2, hdp = p.headD / 2;
  const skin = look.skin;
  const helm = look.helm, visor = look.visor;
  const closed = helm && helm.kind === 'heavy';
  const hood = helm && helm.kind === 'light';
  const toModel = (x, y, z) => new V(C.x + x * hw, C.y + y * hh, C.z + z * hdp);
  const surf = (x, y, z) => { const s = headShape(hd, x, y, z); return toModel(s[0], s[1], s[2]); };
  const hairC = look.hair ? look.hair.colour : null;
  const stubble = look.beard && look.beard.kind === '5oclock' ? look.beard.colour : null;

  // skull
  const g = new T.SphereGeometry(1, 22, 16);
  const P = g.getAttribute('position');
  const cols = [];
  for (let i = 0; i < P.count; i++) {
    const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
    const q = surf(x, y, z);
    P.setXYZ(i, q.x, q.y, q.z);
    let c = skin;
    if (hd.kind === 'skull' && z > 0.55 && Math.abs(y - 0.08) < 0.18 && Math.abs(Math.abs(x) - 0.33) < 0.18) c = DARK;
    else if (z > 0.75 && Math.abs(x) < 0.32 && y < -0.42 && y > -0.56 && !hd.muzzle) c = shade(skin, 0.72);      // mouth
    else if (stubble && y < -0.15 && z > -0.1) c = mix(skin, stubble, 0.35);
    cols.push(c);
  }
  smoothNormals(g);
  M.add(g, (x, y, z, i) => cols[i], 'head');

  if (!closed) {
    // eyes on their own bone so they can blink
    const eyeY = hd.kind === 'lizard' ? 0.12 : hd.kind === 'goblin' ? 0.02 : 0.05;
    const eyeX = hd.kind === 'lizard' ? 0.5 : hd.kind === 'alien' ? 0.38 : 0.33;
    const big = hd.kind === 'alien' ? 2.1 : hd.kind === 'goblin' ? 1.25 : hd.kind === 'mouse' || hd.kind === 'rabbit' ? 1.15 : 1;
    for (const s of [1, -1]) {
      const zs = Math.sqrt(Math.max(0, 1 - eyeX * eyeX - eyeY * eyeY));
      const e = surf(s * eyeX, eyeY, zs);
      const er = p.headW * 0.075 * big;
      if (hd.kind === 'alien') {
        M.add(blob(e.x, e.y, e.z - er * 0.2, er * 1.1, er * 0.75, er * 0.5, { w: 10, h: 6, rot: [0, 0, s * 0.5] }), '#0c0a12', 'eyes');
      } else if (hd.kind !== 'skull') {
        M.add(blob(e.x, e.y, e.z - er * 0.35, er, er * 0.68, er * 0.45, { w: 8, h: 6 }), hd.kind === 'lizard' ? '#d6c24a' : '#efece6', 'eyes');
        M.add(blob(e.x + s * er * 0.05, e.y - er * 0.02, e.z - er * 0.02, er * 0.55, er * 0.6, er * 0.3, { w: 8, h: 6 }), hd.kind === 'lizard' ? '#1c140c' : look.eye, 'eyes');
        // brow
        if (!hd.muzzle && hd.kind !== 'lizard') {
          const bc = hairC ? shade(hairC, 0.85) : shade(skin, 0.7);
          const b = surf(s * eyeX * 1.02, eyeY + 0.2, Math.sqrt(Math.max(0, 1 - eyeX * eyeX - 0.07)));
          M.add(blob(b.x, b.y, b.z, er * 1.25, er * (0.22 + hd.brow * 0.12), er * 0.35, { w: 6, h: 4, rot: [0, 0, s * (0.12 - (look.seed % 7) * 0.03)] }), bc, 'head');
        }
      }
    }
    // nose
    if (hd.nose > 0) {
      const n = surf(0, -0.15, 1);
      const len = p.headD * 0.09 * hd.nose;
      const tip = new V(n.x, n.y - len * (hd.kind === 'goblin' ? 0.1 : 0.45), n.z + len);
      M.add(spike(new V(n.x, n.y + len * 0.4, n.z - len * 0.5), tip, p.headW * 0.06 * Math.sqrt(hd.nose), 6, 0.8), shade(skin, 0.94), 'head');
      if (hd.kind === 'troll' || hd.kind === 'orc') M.add(blob(n.x, n.y - len * 0.3, n.z + len * 0.4, p.headW * 0.09, p.headW * 0.06, p.headW * 0.06, { w: 8, h: 6 }), shade(skin, 0.92), 'head');
    }
    if (hd.kind === 'orc' || hd.kind === 'troll') {
      for (const s of [1, -1]) {
        const b = surf(s * 0.26, -0.62, 0.8);
        M.add(spike(b, new V(b.x + s * 0.004, b.y + p.headH * 0.13, b.z + 0.008), p.headW * 0.045, 6), '#efe6cc', 'head');
      }
    }
    if (hd.kind === 'vampire') {
      for (const s of [1, -1]) { const b = surf(s * 0.12, -0.52, 0.95); M.add(spike(b, new V(b.x, b.y - p.headH * 0.07, b.z), p.headW * 0.02, 4), '#f4f0e6', 'head'); }
    }
  }

  // muzzles
  const muzzle = (len, rw, rh, drop, noseCol, opts = {}) => {
    const base = surf(0, -0.25 - drop * 0.3, 0.75);
    const path = [];
    for (let i = 0; i <= 4; i++) { const t = i / 4; path.push(new V(base.x, base.y - drop * p.headH * 0.4 * t, base.z - p.headD * 0.15 + len * p.headD * t)); }
    M.add(sweep(path, (t) => [rw * p.headW * lerp(1, opts.tip || 0.55, t), rh * p.headH * lerp(1, opts.tipH || 0.6, t)], 10, skin, 'head', { cap0: 0, cap1: 0.6 }));
    const tipP = path[4];
    if (noseCol) M.add(blob(tipP.x, tipP.y + rh * p.headH * 0.25, tipP.z + rh * p.headH * 0.2, rw * p.headW * (opts.noseW || 0.4), rh * p.headH * 0.3, rh * p.headH * 0.25, { w: 8, h: 6 }), noseCol, 'head');
    return tipP;
  };
  if (hd.kind === 'wolf') muzzle(0.75, 0.32, 0.26, 0.15, '#1a1618', { tip: 0.5 });
  else if (hd.kind === 'lizard') muzzle(0.8, 0.38, 0.22, 0.05, null, { tip: 0.6, tipH: 0.7 });
  else if (hd.kind === 'rat') muzzle(0.75, 0.26, 0.24, 0.2, '#d88a96', { tip: 0.35, noseW: 0.6 });
  else if (hd.kind === 'mouse') muzzle(0.5, 0.26, 0.24, 0.2, '#d88a96', { tip: 0.4, noseW: 0.6 });
  else if (hd.kind === 'rabbit') muzzle(0.3, 0.3, 0.26, 0.15, '#d88a96', { tip: 0.8, noseW: 0.45 });
  else if (hd.kind === 'sheep') muzzle(0.45, 0.32, 0.3, 0.25, '#3a2a2a', { tip: 0.8 });
  else if (hd.kind === 'bull') muzzle(0.45, 0.42, 0.34, 0.25, shade(skin, 0.6), { tip: 0.95, noseW: 0.7 });
  else if (hd.kind === 'boar' || hd.kind === 'pig') {
    const t = muzzle(0.42, 0.34, 0.3, 0.15, null, { tip: 0.9, tipH: 0.95 });
    M.add(blob(t.x, t.y, t.z + 0.004, p.headW * 0.28, p.headH * 0.2, p.headD * 0.05, { w: 10, h: 6 }), mix(skin, '#d88a96', 0.5), 'head');
    if (hd.kind === 'boar') for (const s of [1, -1]) M.add(spike(new V(t.x + s * p.headW * 0.22, t.y - p.headH * 0.12, t.z - p.headD * 0.1), new V(t.x + s * p.headW * 0.34, t.y + p.headH * 0.08, t.z - p.headD * 0.02), p.headW * 0.05, 6), '#efe6cc', 'head');
  }

  // ears
  const ear = (side, kind, col, inner) => {
    const s = side === 'L' ? 1 : -1, bone = 'ear' + side;
    const base = surf(s * 0.92, 0.0, -0.15);
    const add = (geo, c) => M.add(geo, c, bone);
    const dirTip = (dx, dy, dz, len, w, flat = 0.45) => {
      const tip = new V(base.x + s * dx * len, base.y + dy * len, base.z + dz * len);
      add(spike(base, tip, w, 6, flat, new V(s, 0, 0)), col);
      return tip;
    };
    const L0 = p.headH;
    switch (kind) {
      case 'human': add(blob(base.x, base.y - p.headH * 0.02, base.z, p.headW * 0.07, p.headH * 0.14, p.headD * 0.11, { w: 6, h: 6 }), shade(col, 0.95)); break;
      case 'elven': dirTip(0.55, 0.5, -0.55, L0 * 0.42, p.headH * 0.1); break;
      case 'medium': dirTip(0.6, 0.45, -0.5, L0 * 0.28, p.headH * 0.1); break;
      case 'down': dirTip(0.6, -0.45, -0.55, L0 * 0.3, p.headH * 0.1); break;
      case 'hang': dirTip(0.35, -0.85, -0.3, L0 * 0.45, p.headH * 0.12); break;
      case 'long': dirTip(0.92, 0.25, -0.25, L0 * 0.55, p.headH * 0.12); break;
      case 'big': add(blob(base.x + s * p.headW * 0.12, base.y + p.headH * 0.06, base.z - p.headD * 0.04, p.headW * 0.05, p.headH * 0.2, p.headD * 0.14, { w: 8, h: 6, rot: [0.25, s * 0.35, s * -0.45] }), shade(col, 0.95)); break;
      case 'dragon': { dirTip(0.7, 0.35, -0.6, L0 * 0.4, p.headH * 0.14, 0.3); dirTip(0.75, 0.0, -0.65, L0 * 0.28, p.headH * 0.1, 0.3); break; }
      case 'wolf': case 'cat': {
        const b = surf(s * 0.5, 0.78, -0.1), len = kind === 'wolf' ? L0 * 0.38 : L0 * 0.3;
        const tip = new V(b.x + s * len * 0.25, b.y + len, b.z - len * 0.1);
        add(spike(b, tip, p.headW * (kind === 'wolf' ? 0.18 : 0.17), 6, 0.45, new V(0, 0, 1)), col);
        add(spike(new V(b.x, b.y + 0.004, b.z + 0.008), new V(tip.x, tip.y - len * 0.25, tip.z + 0.006), p.headW * 0.09, 5, 0.3, new V(0, 0, 1)), inner);
        break;
      }
      case 'lykon': case 'zabos': case 'avyon': {
        const b = surf(s * 0.85, 0.35, -0.15);
        const len = L0 * (kind === 'avyon' ? 0.42 : 0.36);
        add(spike(b, new V(b.x + s * len * 0.75, b.y + len * 0.55, b.z - len * 0.3), p.headW * 0.16, 6, 0.45, new V(0, 0, 1)), col);
        break;
      }
      case 'rabbit': {
        const b = surf(s * 0.3, 0.85, -0.1), len = L0 * 0.95;
        const path = [b, new V(b.x + s * len * 0.08, b.y + len * 0.5, b.z - len * 0.06), new V(b.x + s * len * 0.15, b.y + len, b.z - len * 0.14)];
        M.add(sweep(path, (t) => [p.headW * 0.13 * (1 - t * 0.35), p.headW * 0.05], 8, col, bone, { cap0: 0, cap1: 1 }));
        break;
      }
      case 'mouse': case 'rat': {
        const b = surf(s * 0.62, 0.62, -0.2), rr = kind === 'mouse' ? 0.3 : 0.2;
        add(blob(b.x + s * p.headW * 0.1, b.y + p.headH * rr * 0.6, b.z, p.headW * rr * 1.05, p.headH * rr, p.headD * 0.05, { w: 10, h: 6, rot: [0, s * 0.35, 0] }), col);
        add(blob(b.x + s * p.headW * 0.1, b.y + p.headH * rr * 0.6, b.z + p.headD * 0.03, p.headW * rr * 0.7, p.headH * rr * 0.68, p.headD * 0.03, { w: 8, h: 6, rot: [0, s * 0.35, 0] }), '#d8a0a6');
        break;
      }
      case 'boar': case 'pig': dirTip(0.8, 0.5, 0.2, L0 * 0.25, p.headH * 0.12); break;
      case 'bull': dirTip(1.0, 0.0, -0.1, L0 * 0.3, p.headH * 0.1); break;
      case 'sheep': dirTip(0.85, -0.3, 0.0, L0 * 0.3, p.headH * 0.11); break;
      default: break;
    }
  };
  const animalEars = { wolf: 'wolf', boar: 'boar', pig: 'pig', bull: 'bull', rabbit: 'rabbit', mouse: 'mouse', rat: 'rat', sheep: 'sheep' };
  const earKind = look.ears ? look.ears.kind : animalEars[hd.kind] || (hd.kind === 'goblin' ? 'long' : hd.kind === 'vampire' ? 'medium' : hd.kind === 'lizard' || hd.kind === 'skull' || hd.kind === 'alien' ? null : 'human');
  const earCol = look.ears && look.ears.furry ? look.ears.colour : skin;
  if (earKind && !closed && !(hood && (earKind === 'human' || earKind === 'medium' || earKind === 'down'))) {
    // furry ears on a human face keep the small human ear underneath
    if (look.ears && look.ears.furry && (look.ears.kind === 'wolf' || look.ears.kind === 'cat') && hd.kind === 'human') { ear('L', 'human', skin, skin); ear('R', 'human', skin, skin); }
    ear('L', earKind, earCol, look.ears ? look.ears.inner : shade(skin, 0.8));
    ear('R', earKind, earCol, look.ears ? look.ears.inner : shade(skin, 0.8));
  }

  // horns
  const horns = look.horns ? look.horns.kind : hd.kind === 'bull' ? 'bull' : null;
  if (horns && !closed) {
    const hc = look.horns ? mix(look.horns.colour, '#efe6cc', 0.45) : '#efe6cc';
    for (const s of [1, -1]) {
      let path;
      if (horns === 'curled') {
        const b = surf(s * 0.55, 0.55, 0.1);
        path = [];
        for (let i = 0; i <= 8; i++) {
          const t = i / 8, a = t * 4.2;
          path.push(new V(b.x + s * (p.headW * 0.1 + t * p.headW * 0.25), b.y + Math.cos(a) * p.headH * 0.25 * (1 - t * 0.3) - p.headH * 0.05 * t, b.z - Math.sin(a) * p.headD * 0.3 * (1 - t * 0.2)));
        }
      } else if (horns === 'back') {
        const b = surf(s * 0.35, 0.75, 0.35);
        path = [b, new V(b.x + s * p.headW * 0.08, b.y + p.headH * 0.28, b.z - p.headD * 0.18), new V(b.x + s * p.headW * 0.14, b.y + p.headH * 0.38, b.z - p.headD * 0.55), new V(b.x + s * p.headW * 0.16, b.y + p.headH * 0.32, b.z - p.headD * 0.85)];
      } else {
        const b = surf(s * 0.7, 0.6, 0.0);
        path = [b, new V(b.x + s * p.headW * 0.35, b.y + p.headH * 0.05, b.z + 0.01), new V(b.x + s * p.headW * 0.62, b.y + p.headH * 0.3, b.z + 0.015), new V(b.x + s * p.headW * 0.6, b.y + p.headH * 0.58, b.z)];
      }
      M.add(sweep(path, (t) => p.headW * (horns === 'bull' ? 0.13 : 0.1) * (1 - t * 0.85), 8, (t) => mix(hc, shade(hc, 0.6), t * 0.3), 'head', { cap0: 0, cap1: 1 }));
    }
  }
  if (look.fins && !closed) {
    const pts = [];
    const n = look.fins.short ? 5 : 7;
    for (let i = 0; i < n; i++) {
      const e = lerp(1.25, -0.6, i / (n - 1));
      const d = new V(0, Math.sin(e), Math.cos(e));
      pts.push(surf(0, d.y, d.z));
    }
    const top = pts.map((q, i) => { const d = new V().subVectors(q, toModel(0, 0, 0)).normalize(); return q.clone().addScaledVector(d, p.headH * (look.fins.short ? 0.12 : 0.22) * Math.sin(Math.PI * (i + 0.5) / n)); });
    const poly = [pts[0], ...top, pts[n - 1]];
    M.add(sheet(poly, 0.006), look.fins.colour, 'head');
  }

  // hair
  const hair = look.hair;
  if (hair && !closed && !hood) buildHair(M, look, Bp, surf, toModel, helm && helm.kind === 'medium');
  else if (hair && (hood || closed) && hair.long) buildHair(M, look, Bp, surf, toModel, true, true);
  if (look.beard && look.beard.kind !== '5oclock' && !closed) buildBeard(M, look, surf);
  if (look.stache && !closed) buildStache(M, look, surf);

  // headgear
  if (helm) buildHelm(M, look, Bp, surf, toModel);
  if (visor && !helm) buildVisor(M, look, surf, toModel);
}

/**
 * Hair cap: the skull surface pushed out by `vol` where the elevation is above the hairline.
 * The push fades to zero over 0.3 rad at the hairline so the cut edge sits on the scalp.
 */
function buildHair(M, look, Bp, surf, toModel, capped = false, onlyLong = false) {
  const T = E(), V = T.Vector3;
  const p = look.p, h = look.hair, col = h.colour, C = Bp.headC;
  const hl = (a) => {                         // hairline elevation at azimuth a (0 front, pi back)
    const c = Math.cos(a);
    return c >= 0 ? lerp(h.side, h.front, Math.pow(c, 1.4)) : lerp(h.side, h.back, Math.pow(-c, 1.1));
  };
  const seed = look.seed;
  const cap = Math.min(h.vol * 0.8, capped ? 0.04 : 9);
  if (!onlyLong) {
    const g = new T.SphereGeometry(1, 32, 22);
    const P = g.getAttribute('position'), keep = new Uint8Array(P.count);
    const cols = [];
    // locks along the cut edge: a triangle wave of 9 teeth, +-0.09 rad, phase from the seed
    const locks = cap > 0.06 && !h.flat ? 1 : 0, nz = h.noise || (cap > 0.06 ? 0.1 : 0);
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
      const a = Math.atan2(x, z), e = Math.asin(clamp(y, -1, 1));
      let line = hl(a);
      const tooth = ((a / TAU * 9 + (seed % 11) / 11) % 1 + 1) % 1;
      line += locks * 0.18 * (Math.abs(tooth * 2 - 1) - 0.5);
      if (h.swoop && Math.cos(a) > 0) line += h.swoop * 0.12 * Math.sin(a);
      if (h.part && Math.cos(a) > 0.2) line -= 0.12 * (1 - Math.abs(Math.sin(a)) * 3);
      if (capped) line = Math.max(line, 0.05);
      const bald = h.bald && e > h.bald && Math.cos(a) > -0.4;
      keep[i] = (e > line - 0.05 && !bald) ? 1 : 0;
      const f = sstep(line - 0.05, line + 0.16, e);
      let v = cap * f;
      if (nz) v += nz * f * (noise3(x * (h.nscale || 4) + seed % 13, y * (h.nscale || 4), z * (h.nscale || 4)) - 0.35) * Math.max(0.12, cap) * 1.6;
      if (h.flare && y < 0) v += h.flare * f * (-y) * 0.6;
      if (h.swoop && Math.cos(a) > 0 && y > 0.2) v += 0.06 * h.swoop * Math.max(0, Math.sin(a)) * f;
      if (h.tuft && z < -0.2 && y > 0.6) v += h.tuft * sstep(0.6, 1, y) * sstep(-0.2, -0.6, z);
      if (h.hive && y > 0) v += h.hive * y * y;
      let s = headShape(look.head, x, y, z);
      let q = new V(s[0] * (1 + v), s[1] * (1 + v), s[2] * (1 + v));
      if (h.flat && q.y > 1.02) q.y = 1.02 + (q.y - 1.02) * 0.2;
      const m = toModel(q.x, q.y, q.z);
      P.setXYZ(i, m.x, m.y, m.z);
      let c = shade(col, 0.78 + 0.32 * (y * 0.5 + 0.5));
      if (h.stripes && Math.floor((a + Math.PI) / TAU * h.stripes * 2) % 2) c.multiplyScalar(0.55);
      cols.push(c);
    }
    const idx = g.index.array, nidx = [];
    for (let t = 0; t < idx.length; t += 3) if (keep[idx[t]] && keep[idx[t + 1]] && keep[idx[t + 2]]) nidx.push(idx[t], idx[t + 1], idx[t + 2]);
    g.setIndex(nidx);
    smoothNormals(g);
    M.add(g, (x, y, z, i) => cols[i], 'head');
  }
  const hp = (e, a, extra = 0) => {            // a point on the hair surface at elevation e, azimuth a
    const d = new V(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
    const s = headShape(look.head, d.x, d.y, d.z);
    const v = (capped ? 0.04 : h.vol) + extra;
    return toModel(s[0] * (1 + v), s[1] * (1 + v), s[2] * (1 + v));
  };
  const dark = shade(col, 0.82);
  const headToChest = (y) => {
    const t = sstep(Bp.head.y + p.headH * 0.2, Bp.neck.y - p.chest * 0.2, y);
    return [['head', 1 - t], ['chest', t]];
  };
  // long hair: a sheet down the back, and strands in front of the shoulders
  if (h.long) {
    const top = C.y + p.headH * 0.1, bot = Bp.head.y - h.long * p.H;
    const rings = [];
    const n = 7;
    for (let i = 0; i <= n; i++) {
      const t = i / n, y = lerp(top, bot, t);
      const belowHead = y < Bp.head.y;
      const backZ = belowHead ? -(lerp(p.chestD, p.waistD, sstep(Bp.chest.y + p.chest, Bp.spine.y, y)) + 0.012) + Bp.chest.z : C.z - p.headD * 0.42;
      const rz = lerp(p.headD * 0.3, p.headD * 0.12, t);
      const rx = lerp(p.headW * 0.6, p.headW * (0.42 + (h.noise || 0) * 0.4), Math.pow(t, 0.7));
      rings.push({ y, rx, rz, z: backZ - rz * 0.4, w: headToChest(y), c: t > 0.9 ? dark : col });
    }
    M.add(loft(rings, 12, { capTop: 0.4, capBottom: 0.5 }));
    if (h.strands || h.strand) {
      for (const s of h.strand ? [h.strand] : [1, -1]) {
        const a = s * 1.45;
        const b = hp(0.05, a);
        const len = Math.min(h.long, 0.22) * p.H * (h.strand ? 1.6 : 1);
        const path = [b, new V(b.x + s * 0.012, b.y - len * 0.4, b.z + 0.02), new V(b.x + s * (p.chestW - p.headW * 0.4) * 0.8, b.y - len, b.z + p.chestD * 0.6)];
        M.add(sweep(path, (t) => [p.headW * 0.16 * (1 - t * 0.4), p.headW * 0.08], 8, (t) => t > 0.85 ? dark : col, (t) => headToChest(lerp(b.y, b.y - len, t)), { cap0: 0.3, cap1: 0.6 }));
      }
    }
  }
  if (onlyLong) return;
  // ponytail / braid on the hair bones
  if (h.tail) {
    const root = h.tail.at === 'crown' ? hp(0.95, Math.PI) : h.tail.at === 'top' ? hp(1.35, Math.PI) : hp(0.2, Math.PI);
    const len = h.tail.len * p.H;
    const path = [];
    const n = h.tail.braid ? 12 : 6;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      path.push(new V(root.x, root.y + (h.tail.at === 'crown' ? 0.03 * Math.sin(Math.PI * t) : 0) - len * Math.pow(t, 1.15), root.z - 0.03 - len * 0.18 * Math.sin(t * 1.6)));
    }
    const r0 = p.headW * (h.tail.braid ? 0.13 : 0.16);
    M.add(sweep(path, (t) => r0 * (h.tail.braid ? (0.78 + 0.22 * Math.abs(Math.sin(t * n * Math.PI / 2))) * (1 - t * 0.35) : (0.7 + 0.5 * Math.sin(Math.PI * Math.min(1, t * 1.6))) * (1 - t * 0.6)), 8,
      (t) => t > 0.92 ? dark : col, (t) => t < 0.15 ? [['head', 1 - t / 0.15], ['hair0', t / 0.15]] : t < 0.55 ? [['hair0', (0.55 - t) / 0.4], ['hair1', (t - 0.15) / 0.4]] : 'hair1', { cap0: 0.4, cap1: 0.8 }));
    M.add(blob(root.x, root.y, root.z - 0.008, r0 * 0.9, r0 * 0.7, r0 * 0.7, { w: 8, h: 6 }), shade(col, 0.6), 'head');
  }
  if (h.bun) {
    const at = h.bun === 'top' ? hp(1.3, Math.PI, 0.05) : h.bun === 'backtop' ? hp(0.8, Math.PI, 0.05) : hp(0.35, Math.PI, 0.05);
    const br = p.headW * 0.26;
    M.add(blob(at.x, at.y, at.z, br, br * 0.9, br, { w: 10, h: 8 }), col, 'head');
  }
  if (h.pigtails) {
    for (const s of [1, -1]) {
      const root = hp(0.35, s * 1.75);
      const len = h.pigtails * p.H;
      const path = [root, new V(root.x + s * 0.03, root.y - len * 0.3, root.z - 0.01), new V(root.x + s * 0.04, root.y - len, root.z - 0.015)];
      M.add(sweep(path, (t) => p.headW * 0.14 * (0.7 + 0.5 * Math.sin(Math.PI * Math.min(1, t * 1.4))) * (1 - t * 0.5), 8, (t) => t > 0.9 ? dark : col, (t) => headToChest(lerp(root.y, root.y - len, t)), { cap0: 0.4, cap1: 0.8 }));
    }
  }
  if (h.spikes) {
    const rnd = mulberry32(look.seed ^ 0x51ed);
    for (let i = 0; i < h.spikes; i++) {
      const a = h.front ? (rnd() - 0.5) * 1.6 : rnd() * TAU, e = h.front ? 0.35 + rnd() * 0.3 : 0.35 + rnd() * 1.0;
      const b = hp(e, a, -0.02), out = new V().subVectors(b, toModel(0, 0, 0)).normalize();
      out.y += 0.35; out.normalize();
      const len = p.headH * h.spikeLen * (0.7 + rnd() * 0.5);
      M.add(spike(b, b.clone().addScaledVector(out, len), p.headW * 0.11, 5), col, 'head');
    }
  }
  if (h.hawk) {
    const path = [], ups = [];
    for (let i = 0; i <= 8; i++) {
      const e = lerp(0.75, Math.PI + 0.4, i / 8);
      const pt = hp(Math.PI / 2 - Math.abs(Math.PI / 2 - e), e > Math.PI / 2 ? Math.PI : 0, 0.0);
      path.push(pt);
      ups.push(new V().subVectors(pt, toModel(0, 0, 0)).normalize());
    }
    M.add(sweep(path, (t) => [p.headW * 0.05, p.headH * h.hawk * (0.6 + 0.4 * Math.sin(Math.PI * t))], 6, col, 'head', { up: (i) => ups[i], cap0: 0.5, cap1: 0.5 }));
  }
  if (h.locks) {
    const rnd = mulberry32(look.seed ^ 0xd2ead);
    for (let i = 0; i < 16; i++) {
      const a = Math.PI + (i / 15 - 0.5) * 4.2, e = lerp(0.1, -0.35, rnd());
      const b = hp(e, a);
      const len = h.locks * p.H * (0.8 + rnd() * 0.4);
      const path = [b, new V(b.x * 1.0 + Math.sin(a) * 0.01, b.y - len * 0.5, b.z + Math.cos(a) * 0.01), new V(b.x + Math.sin(a) * 0.015, b.y - len, b.z + Math.cos(a) * 0.015 - 0.01)];
      M.add(sweep(path, (t) => p.headW * 0.055 * (1 - t * 0.3), 5, i % 3 ? col : dark, (t) => headToChest(lerp(b.y, b.y - len, t)), { cap0: 0.3, cap1: 0.6 }));
    }
  }
}

function buildBeard(M, look, surf) {
  const T = E(), V = T.Vector3, b = look.beard, p = look.p;
  const spec = { beard: [0.16, 0.22], medium: [0.12, 0.12], trimmed: [0.06, 0.03], winter: [0.28, 0.45] }[b.kind] || [0.14, 0.18];
  const [thick, drop] = spec;
  const g = new T.SphereGeometry(1, 22, 16);
  const P = g.getAttribute('position'), keep = new Uint8Array(P.count);
  const center = surf(0, 0, 0);
  for (let i = 0; i < P.count; i++) {
    const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
    const inside = y < -0.12 + (z < 0.4 ? 0.12 : 0) && z > -0.25 - (y < -0.6 ? 0.3 : 0);
    const mouth = z > 0.7 && Math.abs(x) < 0.3 && y > -0.56 && y < -0.42 && b.kind !== 'winter';
    keep[i] = inside && !mouth ? 1 : 0;
    const f = sstep(-0.12, -0.4, y) * sstep(-0.3, 0.2, z);
    const q = surf(x, y, z);
    const out = new V().subVectors(q, center).normalize();
    q.addScaledVector(out, thick * p.headW * 0.5 * f);
    q.y -= drop * p.headH * sstep(-0.55, -1, y) * Math.max(0, z + 0.2);
    P.setXYZ(i, q.x, q.y, q.z);
  }
  const idx = g.index.array, nidx = [];
  for (let t = 0; t < idx.length; t += 3) if (keep[idx[t]] && keep[idx[t + 1]] && keep[idx[t + 2]]) nidx.push(idx[t], idx[t + 1], idx[t + 2]);
  g.setIndex(nidx);
  smoothNormals(g);
  M.add(g, (x, y) => shade(b.colour, 0.8 + 0.4 * clamp01((y - (center.y - p.headH)) / p.headH)), 'head');
}

function buildStache(M, look, surf) {
  const T = E(), V = T.Vector3, b = look.stache, p = look.p, k = b.kind;
  const size = { bigstache: 1.4, walrus: 1.6, lampshade: 1.3, chevron: 1.2, french: 0.7, handlebar: 1, horseshoe: 1, mustache: 1 }[k] || 1;
  for (const s of [1, -1]) {
    const a = surf(s * 0.04, -0.33, 1), c = surf(s * 0.3 * Math.min(1.3, size), k === 'walrus' ? -0.55 : -0.42, 0.92);
    c.z += 0.004;
    M.add(sweep([a, new V((a.x + c.x) / 2, (a.y + c.y) / 2 + 0.002, (a.z + c.z) / 2 + 0.006), c], (t) => p.headW * 0.05 * size * (1 - t * 0.5), 6, b.colour, 'head', { cap0: 0.6, cap1: 0.6 }));
    if (k === 'handlebar') M.add(blob(c.x + s * 0.008, c.y + 0.012, c.z, p.headW * 0.035, p.headW * 0.05, p.headW * 0.03, { w: 6, h: 4 }), b.colour, 'head');
    if (k === 'horseshoe') {
      const d = surf(s * 0.33, -0.85, 0.75);
      M.add(sweep([c, d], () => p.headW * 0.04, 6, b.colour, 'head', { cap0: 0.5, cap1: 0.6 }));
    }
  }
}

function buildHelm(M, look, Bp, surf, toModel) {
  const T = E(), V = T.Vector3, h = look.helm, p = look.p, C = Bp.headC;
  if (h.kind === 'light') {
    // hood: a shell over the head with an opening for the face, and a cowl to the shoulders
    const g = new T.SphereGeometry(1, 22, 16);
    const P = g.getAttribute('position'), keep = new Uint8Array(P.count);
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
      keep[i] = !(z > 0.2 && (x / 0.66) ** 2 + ((y + 0.12) / 0.66) ** 2 < 1) && y > -0.85 ? 1 : 0;
      const s = headShape(look.head, x, y, z);
      const v = 0.2 + (z < 0 ? 0.06 : 0);
      const q = toModel(s[0] * (1 + v), s[1] * (1 + v) + (y > 0.6 ? 0.05 : 0), s[2] * (1 + v));
      P.setXYZ(i, q.x, q.y, q.z);
    }
    const idx = g.index.array, nidx = [];
    for (let t = 0; t < idx.length; t += 3) if (keep[idx[t]] && keep[idx[t + 1]] && keep[idx[t + 2]]) nidx.push(idx[t], idx[t + 1], idx[t + 2]);
    g.setIndex(nidx);
    smoothNormals(g);
    M.add(g, h.leather, 'head');
    M.add(loft([
      { y: Bp.head.y + p.headH * 0.15, rx: p.headW * 0.55, rz: p.headD * 0.55, z: C.z - 0.01, w: 'head', c: h.leather },
      { y: Bp.neck.y - 0.005, rx: p.chestW * 0.8, rz: p.chestD * 0.95, z: Bp.chest.z, w: [['chest', 0.7], ['neck', 0.3]], c: shade(h.leather, 0.9) },
      { y: Bp.neck.y - p.chest * 0.16, rx: p.chestW * 1.02, rz: p.chestD * 1.08, z: Bp.chest.z, w: 'chest', c: shade(h.leather, 0.8) },
    ], 16, { capTop: null, capBottom: null }));
  } else if (h.kind === 'medium') {
    const g = new T.SphereGeometry(1, 20, 12, 0, TAU, 0, Math.PI * 0.55);
    const P = g.getAttribute('position');
    for (let i = 0; i < P.count; i++) {
      const s = headShape(look.head, P.getX(i), P.getY(i), P.getZ(i));
      const q = toModel(s[0] * 1.17, s[1] * 1.17 + 0.05, s[2] * 1.17);
      P.setXYZ(i, q.x, q.y, q.z);
    }
    smoothNormals(g);
    M.add(g, h.metal, 'head');
    const rimY = C.y + p.headH * 0.12;
    M.add(loft([
      { y: rimY + 0.012, rx: p.headW * 0.6, rz: p.headD * 0.6, z: C.z, w: 'head', c: shade(h.metal, 0.8) },
      { y: rimY - 0.006, rx: p.headW * 0.6, rz: p.headD * 0.6, z: C.z, w: 'head', c: shade(h.metal, 0.8) },
    ], 18, { capTop: null, capBottom: null }));
    const nb = surf(0, 0.2, 1);
    M.add(blob(nb.x, nb.y - p.headH * 0.05, nb.z + 0.01, p.headW * 0.05, p.headH * 0.2, 0.008, { w: 6, h: 4 }), h.metal, 'head');
  } else {
    // great helm: a closed can with an eye slit
    const bot = Bp.head.y + p.headH * 0.02, top = C.y + p.headH * 0.58;
    const slit = C.y + p.headH * 0.06;
    let rings = [
      { y: bot, rx: p.headW * 0.6, rz: p.headD * 0.62, z: C.z, w: 'head' },
      { y: C.y, rx: p.headW * 0.64, rz: p.headD * 0.66, rzF: p.headD * 0.72, z: C.z, w: 'head' },
      { y: top - p.headH * 0.12, rx: p.headW * 0.62, rz: p.headD * 0.64, z: C.z, w: 'head' },
      { y: top, rx: p.headW * 0.52, rz: p.headD * 0.54, z: C.z, w: 'head' },
    ];
    rings = refine(rings, [slit - p.headH * 0.04, slit + p.headH * 0.04]);
    M.add(loft(rings, 18, { capTop: 0.15, capBottom: 0.1, colourOf: (a, y) => (y > slit - p.headH * 0.04 && y < slit + p.headH * 0.04 && Math.cos(a) > 0.45 ? DARK : Math.abs(Math.sin(a)) < 0.06 && Math.cos(a) > 0 ? mix(h.metal, '#ffffff', 0.25) : h.metal) }));
  }
}

function buildVisor(M, look, surf, toModel) {
  const T = E(), V = T.Vector3, v = look.visor, p = look.p;
  const g = new T.SphereGeometry(1, 20, 14);
  const P = g.getAttribute('position'), cols = [];
  for (let i = 0; i < P.count; i++) {
    const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
    const s = headShape(look.head, x, y, z);
    const q = toModel(s[0] * 1.14, s[1] * 1.14, s[2] * 1.14 + (v.kind.startsWith('pig') && z > 0.7 && y < 0 && y > -0.6 ? 0.25 : 0));
    P.setXYZ(i, q.x, q.y, q.z);
    let c = v.metal;
    const front = z > 0.55;
    if (front && /slit/.test(v.kind) && Math.abs(y - 0.08) < (v.kind.includes('narrow') ? 0.05 : 0.09)) c = DARK;
    if (front && /grated/.test(v.kind) && y < 0.15 && y > -0.6 && Math.floor((x + 1) * 9) % 2) c = DARK;
    if (front && /round/.test(v.kind) && (x * x + (y - 0.05) * (y - 0.05)) < 0.12) c = '#79c8ff';
    if (front && /pig|horned/.test(v.kind) && Math.abs(y - 0.12) < 0.07 && Math.abs(x) < 0.55) c = DARK;
    cols.push(c);
  }
  smoothNormals(g);
  M.add(g, (x, y, z, i) => cols[i], 'head');
  if (/horned/.test(v.kind)) for (const s of [1, -1]) { const b = surf(s * 0.65, 0.5, 0.2); M.add(spike(b, new V(b.x + s * p.headW * 0.35, b.y + p.headH * 0.35, b.z - 0.02), p.headW * 0.09, 6), '#efe6cc', 'head'); }
}

// ---------- tails and wings ----------

function buildParts(M, look, Bp) {
  const T = E(), V = T.Vector3, p = look.p;
  if (look.tail) {
    const tk = look.tail.kind, base = Bp.tail0, H = p.H;
    const len = { lizard: 0.6, wolf: 0.42, fluffy: 0.42, cat: 0.5 }[tk] * H;
    const path = [];
    const n = 10;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      let y, z;
      if (tk === 'lizard') { y = base.y - len * 0.65 * Math.sin(t * 1.3) + len * 0.05 * t; z = base.z - len * t; }
      else if (tk === 'cat') { y = base.y - len * 0.5 * Math.sin(t * 2.2) + len * 0.35 * t * t; z = base.z - len * 0.75 * t; }
      else { y = base.y - len * 0.55 * Math.sin(t * 1.4); z = base.z - len * 0.7 * Math.sin(t * 1.2); }
      path.push(new V(0, y, z));
    }
    const rad = {
      lizard: (t) => H * 0.05 * (1 - t * 0.85),
      wolf: (t) => H * (0.018 + 0.035 * Math.sin(Math.PI * Math.min(1, t * 1.1))),
      fluffy: (t) => H * (0.022 + 0.05 * Math.sin(Math.PI * Math.min(1, t * 1.05))),
      cat: (t) => H * 0.018 * (1 - t * 0.35),
    }[tk];
    const col = look.tail.colour;
    const tipCol = tk === 'wolf' || tk === 'fluffy' ? mix(col, '#ffffff', 0.35) : shade(col, 0.85);
    const w = (t) => t < 0.33 ? [['tail0', 1 - t / 0.66], ['tail1', t / 0.66]] : t < 0.66 ? [['tail1', 1 - (t - 0.33) / 0.66], ['tail2', (t - 0.33) / 0.66]] : 'tail2';
    M.add(sweep(path, rad, 10, (t) => t > 0.85 ? tipCol : col, (t) => t < 0.05 ? [['hips', 1 - t / 0.05], ['tail0', t / 0.05]] : w(t), { cap0: 0.3, cap1: 0.9 }));
  }
  if (look.wings) {
    const wk = look.wings.kind, col = look.wings.colour, H = p.H;
    for (const [s, side] of [[1, 'L'], [-1, 'R']]) {
      const o = Bp['wing' + side], bone = 'wing' + side;
      const at = (x, y, z) => new V(o.x + s * x * H, o.y + y * H, o.z + z * H);
      if (wk === 'membrane') {
        const wrist = at(0.26, 0.2, -0.06);
        M.add(sweep([at(0, 0, 0), at(0.12, 0.12, -0.03), wrist], (t) => H * 0.014 * (1 - t * 0.4), 6, shade(col, 0.7), bone, { cap0: 0.5, cap1: 0.5 }));
        const tips = [at(0.42, 0.12, -0.12), at(0.46, -0.06, -0.12), at(0.38, -0.2, -0.1), at(0.24, -0.26, -0.08), at(0.08, -0.16, -0.04)];
        for (const t of tips.slice(0, 3)) M.add(sweep([wrist, t], () => H * 0.006, 4, shade(col, 0.6), bone, { cap0: 0.4, cap1: 0.4 }));
        const poly = [at(0, 0, 0), wrist];
        for (let i = 0; i < tips.length; i++) {
          poly.push(tips[i]);
          if (i < tips.length - 1) { const mid = tips[i].clone().lerp(tips[i + 1], 0.5).lerp(wrist, 0.22); poly.push(mid); }
        }
        poly.push(at(0, -0.02, -0.01));
        M.add(sheet(poly, 0.004), shade(col, 0.95), bone);
      } else if (wk === 'feather') {
        const rows = [[0.0, 0.42, 0.22], [0.02, 0.36, 0.16], [0.05, 0.28, 0.1]];
        rows.forEach(([dz, span, drop], ri) => {
          const poly = [at(0, 0.02, -dz)];
          const N = 7;
          for (let i = 0; i <= N; i++) {
            const t = i / N;
            poly.push(at(span * (1 - t * 0.55) * (i === 0 ? 1 : 0.98), 0.16 - t * (0.38 + drop) , -0.05 - dz - t * 0.02));
            if (i < N) poly.push(at(span * (1 - (t + 0.5 / N) * 0.55) * 0.86, 0.16 - (t + 0.5 / N) * (0.38 + drop) + 0.03, -0.05 - dz - t * 0.02));
          }
          poly.push(at(0, -0.12, -dz));
          M.add(sheet(poly, 0.006), mix(col, '#ffffff', ri * 0.12), bone);
        });
      } else {
        const lobe = (cx, cy, rx, ry, rot, c) => {
          const poly = [at(cx, cy, -0.04)];
          for (let i = 0; i <= 14; i++) {
            const a = i / 14 * TAU;
            const lx = Math.cos(a) * rx, ly = Math.sin(a) * ry;
            poly.push(at(cx + lx * Math.cos(rot) - ly * Math.sin(rot), cy + lx * Math.sin(rot) + ly * Math.cos(rot), -0.04));
          }
          M.add(sheet(poly, 0.003), c, bone);
        };
        const c1 = look.wings.light ? mix(col, '#ffffff', 0.55) : col;
        const c2 = look.wings.monarch ? '#1a1418' : shade(c1, 0.75);
        if (look.wings.dragonfly) { lobe(0.2, 0.1, 0.2, 0.045, 0.25, c1); lobe(0.18, -0.02, 0.18, 0.04, -0.15, c1); }
        else { lobe(0.16, 0.12, 0.16, 0.12, 0.5, c2); lobe(0.15, 0.12, 0.13, 0.095, 0.5, c1); lobe(0.12, -0.06, 0.1, 0.08, -0.4, c2); lobe(0.115, -0.06, 0.08, 0.06, -0.4, c1); }
      }
    }
  }
}

// ---------- props (non-skinned, in grip space: the shaft runs along +y from the fist) ----------

function propGeometry(kind, q, k, opts = {}) {
  const prev = SURFS, metal = metalOf(q);
  SURFS = new Map([[metal.toLowerCase(), SURF.metal], ['#8a8c90', SURF.metal], ['#6a6c72', SURF.metal], ['#d6a83a', SURF.metal],
    ['#7a5232', SURF.leather], ['#4e3420', SURF.leather], ['#3a2618', SURF.leather], ['#c9a06a', SURF.leather], ['#9a7244', SURF.leather], ['#8a2a24', SURF.leather], ['#b08a5a', SURF.leather],
    ['#9fdcff', SURF.gloss], ['#62b6ff', SURF.gloss], ['#f4fbff', SURF.gloss], ['#6ad48a', SURF.gloss], ['#7ad4ff', SURF.gloss], ['#c8a060', SURF.gloss], ['#d8e6e8', SURF.gloss]]);
  try { return propGeometryRaw(kind, q, k, opts); } finally { SURFS = prev; }
}

function propGeometryRaw(kind, q, k, opts = {}) {
  const T = E(), V = T.Vector3, parts = [];
  const add = (geo, c) => parts.push(paint(geo, c, 'root'));
  const box = (w, h, d, x, y, z, c, rx = 0) => { const g = new T.BoxGeometry(w, h, d); if (rx) g.rotateX(rx); g.translate(x, y, z); add(g, c); };
  const cyl = (r0, r1, y0, y1, c, seg = 6, x = 0, z = 0) => { const g = new T.CylinderGeometry(r1, r0, y1 - y0, seg); g.translate(x, (y0 + y1) / 2, z); add(g, c); };
  const metal = metalOf(q), wood = '#7a5232', dwood = '#4e3420', grip = '#3a2618';
  const s = k;
  let glow = null;
  switch (kind) {
    case 'sword': {
      const L = 0.36 * s, glowing = q >= 5;
      cyl(0.011 * s, 0.011 * s, -0.05 * s, 0.05 * s, grip);
      add(blob(0, -0.058 * s, 0, 0.016 * s, 0.016 * s, 0.016 * s, { w: 6, h: 4 }), metal);
      box(0.1 * s, 0.014 * s, 0.018 * s, 0, 0.056 * s, 0, metal);
      const bc = glowing ? '#9fdcff' : mix(metal, '#ffffff', 0.35);
      const b = new T.CylinderGeometry(0.001, 0.016 * s, L, 4); b.scale(1, 1, 0.3); b.translate(0, 0.063 * s + L / 2, 0); add(b, bc);
      if (glowing) glow = { y: 0.06 * s + L * 0.5, colour: '#7fc8ff', size: L * 1.6 };
      break;
    }
    case 'axe': {
      const war = q >= 4, L = (war ? 0.5 : 0.36) * s;
      cyl(0.012 * s, 0.012 * s, -0.06 * s, L, wood);
      for (const side of war ? [1, -1] : [1]) {
        const g = new T.CylinderGeometry(0.075 * s, 0.075 * s, 0.012 * s, 10, 1, false, 0, Math.PI); g.rotateX(Math.PI / 2); g.rotateZ(side > 0 ? 0 : Math.PI);
        g.scale(war ? 1 : 0.8, war ? 1.1 : 0.8, 1); g.rotateY(Math.PI / 2); g.translate(0, L - 0.05 * s, 0); add(g, mix(metal, '#ffffff', 0.2));
      }
      if (!war) box(0.02 * s, 0.04 * s, 0.03 * s, 0, L - 0.05 * s, -0.02 * s, metal);
      break;
    }
    case 'spear': {
      const shaft = ['#c9a06a', '#c9a06a', '#9a7244', '#9a7244', '#4e3420', '#8a2a24'][clamp(q, 0, 5)];
      cyl(0.01 * s, 0.01 * s, -0.42 * s, 0.62 * s, shaft);
      const g = new T.CylinderGeometry(0.001, 0.024 * s, 0.13 * s, 4); g.scale(1, 1, 0.35); g.translate(0, 0.62 * s + 0.065 * s, 0); add(g, mix(metal, '#ffffff', 0.3));
      box(0.03 * s, 0.012 * s, 0.03 * s, 0, 0.62 * s, 0, metal);
      break;
    }
    case 'dagger': {
      if (q >= 4) {
        cyl(0.009 * s, 0.009 * s, -0.045 * s, 0.04 * s, grip);
        const cup = new T.SphereGeometry(0.03 * s, 8, 6, 0, TAU, 0, Math.PI / 2); cup.translate(0, 0.04 * s, 0); add(cup, metal);
        const b = new T.CylinderGeometry(0.0015, 0.006 * s, 0.42 * s, 4); b.translate(0, 0.045 * s + 0.21 * s, 0); add(b, mix(metal, '#ffffff', 0.4));
      } else {
        cyl(0.01 * s, 0.01 * s, -0.04 * s, 0.035 * s, grip);
        box(0.06 * s, 0.01 * s, 0.014 * s, 0, 0.04 * s, 0, metal);
        const b = new T.CylinderGeometry(0.001, 0.014 * s, 0.15 * s, 4); b.scale(1, 1, 0.3); b.translate(0, 0.045 * s + 0.075 * s, 0); add(b, mix(metal, '#ffffff', 0.35));
      }
      break;
    }
    case 'staff': {
      const top = 0.72 * s;
      if (q <= 1) { cyl(0.012 * s, 0.014 * s, -0.32 * s, top, wood); add(blob(0, top, 0, 0.022 * s, 0.022 * s, 0.022 * s, { w: 6, h: 4 }), dwood); }
      else {
        const path = [];
        for (let i = 0; i <= 8; i++) { const t = i / 8; path.push(new V(Math.sin(t * 7) * 0.012 * s, lerp(-0.32, 0.7, t) * s, Math.cos(t * 5) * 0.01 * s)); }
        if (q <= 3) { path.push(new V(0.03 * s, 0.76 * s, 0)); path.push(new V(0.05 * s, 0.72 * s, 0)); }
        parts.push(sweep(path, (t) => 0.015 * s * (1 - t * 0.3), 6, dwood, 'root', { cap0: 0.5, cap1: 0.5 }));
        if (q >= 4) {
          const g = new T.OctahedronGeometry(0.04 * s, 0); g.scale(1, 1.6, 1); g.translate(0, top + 0.06 * s, 0);
          add(g, q >= 5 ? '#f4fbff' : '#62b6ff');
          glow = { y: top + 0.06 * s, colour: q >= 5 ? '#e8f6ff' : '#5fb0ff', size: 0.26 * s };
        }
      }
      break;
    }
    case 'bow': {
      const path = [];
      for (let i = 0; i <= 10; i++) { const t = i / 10 * 2 - 1; path.push(new V(0, t * 0.4 * s, (0.06 - 0.06 * t * t) * s + (Math.abs(t) > 0.8 ? (Math.abs(t) - 0.8) * -0.15 * s : 0))); }
      parts.push(sweep(path, (t) => 0.011 * s * (1 - Math.abs(t * 2 - 1) * 0.5), 5, wood, 'root', { cap0: 0.5, cap1: 0.5 }));
      cyl(0.0025 * s, 0.0025 * s, -0.4 * s, 0.4 * s, '#e8e0cc', 3, 0, 0);
      cyl(0.014 * s, 0.014 * s, -0.04 * s, 0.04 * s, grip, 6, 0, 0.06 * s);
      break;
    }
    case 'arrow': { cyl(0.004 * s, 0.004 * s, -0.25 * s, 0.25 * s, '#c9a06a', 4); const g = new T.ConeGeometry(0.01 * s, 0.04 * s, 4); g.translate(0, 0.27 * s, 0); add(g, '#8a8c90'); box(0.024 * s, 0.05 * s, 0.002, 0, -0.22 * s, 0, '#e8e2d6'); break; }
    case 'buckler': {
      const g = new T.SphereGeometry(0.12 * s, 14, 6, 0, TAU, 0, Math.PI * 0.32); g.rotateZ(-Math.PI / 2); add(g, '#7a5232');
      const b = new T.SphereGeometry(0.035 * s, 8, 6, 0, TAU, 0, Math.PI / 2); b.rotateZ(-Math.PI / 2); b.translate(0.045 * s, 0, 0); add(b, metal);
      break;
    }
    case 'kite': {
      const face = q >= 3 ? '#3a5ea8' : '#8a8e96';
      const pts = [new V(0.012, 0.13 * s, 0), new V(0.012, 0.1 * s, 0.11 * s), new V(0.012, -0.05 * s, 0.09 * s), new V(0.012, -0.22 * s, 0), new V(0.012, -0.05 * s, -0.09 * s), new V(0.012, 0.1 * s, -0.11 * s)];
      const g = sheet([new V(0.016, 0, 0), ...pts, pts[0]], 0.014); add(g, face);
      add(blob(0.022, 0.0, 0, 0.012, 0.03 * s, 0.03 * s, { w: 6, h: 4 }), metal);
      break;
    }
    case 'tower': {
      const g = new T.CylinderGeometry(0.28 * s, 0.28 * s, 0.46 * s, 12, 1, true, -0.45, 0.9);
      g.rotateY(Math.PI / 2); g.translate(-0.26 * s, 0, 0); add(g, '#9a2a24');
      const g2 = g.clone(); g2.scale(0.995, 1, 1); g2.translate(-0.003, 0, 0); g2.index && g2.setIndex(Array.from(g2.index.array).reverse()); add(g2, '#6a1e1a');
      add(blob(0.03, 0, 0, 0.02, 0.04 * s, 0.04 * s, { w: 8, h: 6 }), q >= 3 ? '#d6a83a' : metal);
      if (q >= 3) { box(0.01, 0.46 * s, 0.012, 0.022, 0, 0.12 * s, '#d6a83a'); box(0.01, 0.46 * s, 0.012, 0.022, 0, -0.12 * s, '#d6a83a'); }
      break;
    }
    // work tools
    case 'pick': {
      cyl(0.011 * s, 0.011 * s, -0.08 * s, 0.4 * s, wood);
      const path = [new V(0, 0.36 * s, -0.13 * s), new V(0, 0.4 * s, -0.04 * s), new V(0, 0.41 * s, 0.04 * s), new V(0, 0.37 * s, 0.13 * s)];
      parts.push(sweep(path, (t) => 0.014 * s * (1 - Math.abs(t * 2 - 1) * 0.8), 5, '#8a8c90', 'root', { cap0: 0.5, cap1: 0.5 }));
      break;
    }
    case 'hammer': { cyl(0.01 * s, 0.01 * s, -0.04 * s, 0.2 * s, wood); box(0.04 * s, 0.045 * s, 0.09 * s, 0, 0.2 * s, 0, '#6a6c72'); break; }
    case 'hoe': { cyl(0.01 * s, 0.01 * s, -0.25 * s, 0.6 * s, wood); box(0.08 * s, 0.01 * s, 0.06 * s, 0, 0.6 * s, 0.03 * s, '#6a6c72', 0.3); break; }
    case 'broom': {
      cyl(0.01 * s, 0.01 * s, -0.45 * s, 0.35 * s, wood);
      const g = new T.ConeGeometry(0.06 * s, 0.16 * s, 8); g.scale(1, 1, 0.45); g.translate(0, -0.45 * s - 0.03 * s, 0); add(g, '#c9a85a');
      break;
    }
    case 'ladle': { cyl(0.006 * s, 0.006 * s, -0.2 * s, 0.06 * s, wood); const g = new T.SphereGeometry(0.03 * s, 8, 4, 0, TAU, Math.PI / 2, Math.PI / 2); g.translate(0, -0.2 * s, 0); add(g, '#9a7a52'); break; }
    case 'flask': { add(blob(0, -0.03 * s, 0.02 * s, 0.035 * s, 0.035 * s, 0.035 * s, { w: 8, h: 6 }), opts.liquid || '#6ad48a'); cyl(0.01 * s, 0.01 * s, 0, 0.04 * s, '#d8e6e8', 6, 0, 0.02 * s); break; }
    case 'basket': {
      const g = new T.CylinderGeometry(0.07 * s, 0.05 * s, 0.07 * s, 10, 1, true); g.translate(0, -0.08 * s, 0.02 * s); add(g, '#a8824a');
      const g2 = g.clone(); g2.setIndex(Array.from(g2.index.array).reverse()); add(g2, '#8a6a3a');
      add(blob(0, -0.05 * s, 0.02 * s, 0.055 * s, 0.025 * s, 0.055 * s, { w: 8, h: 4 }), '#5f9a3a');
      break;
    }
    case 'practice': { cyl(0.012 * s, 0.012 * s, -0.05 * s, 0.05 * s, grip); box(0.08 * s, 0.014 * s, 0.018 * s, 0, 0.056 * s, 0, wood); box(0.028 * s, 0.32 * s, 0.012 * s, 0, 0.06 * s + 0.16 * s, 0, '#b08a5a'); break; }
    default: return null;
  }
  const M = new Mesher();
  for (const g of parts) M.add(g);
  return { geo: M.build(), glow };
}

// ---------- materials ----------

let SHARED = null;
function shared() {
  if (SHARED) return SHARED;
  const T = E();
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.35, 'rgba(255,255,255,.55)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  const glowTex = new T.CanvasTexture(c);
  glowTex.colorSpace = T.SRGBColorSpace;
  SHARED = {
    glowTex,
    outline: { uPx: { value: new T.Vector2(2 / 1000, 2 / 700) }, uWidth: { value: 1.25 } },
  };
  return SHARED;
}

const OUTLINE_VS = `
  #include <common>
  #include <skinning_pars_vertex>
  uniform vec2 uPx;
  uniform float uWidth;
  varying vec3 vCol;
  varying float vFogDepth;
  void main() {
    #include <skinbase_vertex>
    #include <begin_vertex>
    #include <beginnormal_vertex>
    #include <skinnormal_vertex>
    #include <skinning_vertex>
    vec4 mv = modelViewMatrix * vec4(transformed, 1.0);
    vec4 clip = projectionMatrix * mv;
    vec3 nv = normalize(normalMatrix * objectNormal);
    vec2 dir = (projectionMatrix * vec4(nv, 0.0)).xy;
    float l = length(dir);
    if (l > 1e-5) clip.xy += dir / l * uPx * uWidth * clip.w;
    gl_Position = clip;
    vCol = color;
    vFogDepth = -mv.z;
  }`;
const OUTLINE_FS = `
  uniform vec3 fogColor;
  uniform float fogNear;
  uniform float fogFar;
  uniform float uDissolve;
  uniform float uOpacity;
  varying vec3 vCol;
  varying float vFogDepth;
  const float BAYER[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
  void main() {
    ivec2 q = ivec2(mod(gl_FragCoord.xy, 4.0));
    if ((BAYER[q.y * 4 + q.x] + 0.5) / 16.0 < uDissolve) discard;
    vec3 col = vCol * 0.22 + vec3(0.01, 0.008, 0.015);
    col = mix(col, fogColor, smoothstep(fogNear, fogFar, vFogDepth) * 0.85);
    gl_FragColor = vec4(col, uOpacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

// Toon ramp for the direct light, indexed by dotNL * 0.5 + 0.5: three soft bands at 0.26 (turned
// away), 0.64 and 1.0 (facing the sun), with 0.08-wide transitions. Linear filtering over 32 texels.
let RAMP = null;
function toonRamp() {
  if (RAMP) return RAMP;
  const T = E(), N = 32, d = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const x = (i + 0.5) / N;
    d[i] = Math.round(255 * (0.26 + 0.38 * sstep(0.44, 0.52, x) + 0.36 * sstep(0.64, 0.72, x)));
  }
  RAMP = new T.DataTexture(d, N, 1, T.RedFormat);
  RAMP.minFilter = RAMP.magFilter = T.LinearFilter;
  RAMP.generateMipmaps = false;
  RAMP.needsUpdate = true;
  return RAMP;
}

// Per-surface shading added to the toon light, in view space so highlights sit at the same place
// on screen whatever the figure's heading (a fixed key light above-left of the camera, KEY).
//   metal   diffuse x0.75, highlight pow 30 x1.0 + pow 6 x0.25, rim x2
//   chain   ring pattern on the bind-pose position (rows offset by half a ring), faded out by
//           fwidth when a ring is under ~3 px, highlight pow 14 x0.5
//   hair    streaks around the head's vertical axis (30 per turn, x0.8..1.0, faded by fwidth), and a
//           highlight band (smoothstep 0.8..0.96 of N.KEY) x0.2
//   gloss   pow 50 x0.7 (eyes, tusks, crystals)
//   leather pow 10 x0.12
//   skin    pow 12 x0.05, plus a warm floor of 8% of the albedo in red, 3% green
//   all     rim = (1 - N.V)^3, sky-tinted, x0.3
const STYLE_VS = 'attribute float surf;\nvarying float vSurf;\nvarying vec3 vBind;';
const STYLE_COLOUR = `
  float fMetal = 1.0 - step(0.5, abs(vSurf - 3.0));
  float fChain = 1.0 - step(0.5, abs(vSurf - 6.0));
  float fHair = 1.0 - step(0.5, abs(vSurf - 2.0));
  float fGloss = 1.0 - step(0.5, abs(vSurf - 5.0));
  float fLeather = 1.0 - step(0.5, abs(vSurf - 4.0));
  float fSkin = 1.0 - step(0.5, abs(vSurf - 1.0));
  vec3 fAlbedo = diffuseColor.rgb;
  if (fChain > 0.5) {
    vec2 cq = vec2((vBind.x + vBind.z) * 150.0, vBind.y * 150.0);
    cq.x += 0.5 * mod(floor(cq.y), 2.0);
    float cd = length(fract(cq) - 0.5);
    float ring = smoothstep(0.16, 0.24, cd) * (1.0 - smoothstep(0.38, 0.47, cd));
    float fade = 1.0 - smoothstep(0.25, 0.45, fwidth(cq.y));
    diffuseColor.rgb *= mix(0.82, mix(0.45, 1.2, ring), fade);
  }
  if (fHair > 0.5) {
    float ha = atan(vBind.x, vBind.z + 0.01) * 30.0 + sin(vBind.y * 60.0) * 0.9;
    float hf = 1.0 - smoothstep(0.35, 0.7, fwidth(ha));
    diffuseColor.rgb *= mix(1.0, 0.8 + 0.2 * sin(ha), hf);
  }
  diffuseColor.rgb *= mix(1.0, 0.75, fMetal);`;
const STYLE_LIGHT = `
  {
    vec3 nV = normalize(normal);
    float ndv = clamp(dot(nV, normalize(vViewPosition)), 0.0, 1.0);
    float nh = max(dot(nV, normalize(vec3(-0.4, 0.62, 0.68))), 0.0);
    float spec = fMetal * (pow(nh, 30.0) + 0.25 * pow(nh, 6.0))
      + fChain * 0.5 * pow(nh, 14.0)
      + fHair * 0.2 * smoothstep(0.8, 0.96, nh)
      + fGloss * 0.7 * pow(nh, 50.0)
      + fLeather * 0.12 * pow(nh, 10.0)
      + fSkin * 0.05 * pow(nh, 12.0);
    outgoingLight += spec * mix(vec3(1.0), fAlbedo * 1.6 + 0.2, fMetal * 0.6);
    outgoingLight += fSkin * fAlbedo * vec3(0.08, 0.03, 0.0);
    outgoingLight += pow(1.0 - ndv, 3.0) * (0.3 + 0.6 * fMetal) * vec3(0.55, 0.62, 0.75);
  }`;

/** The figure look on top of a MeshToonMaterial: surface highlights, chain rings, rim light. */
function stylize(mat) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    if (prev) prev(sh, r);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + STYLE_VS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSurf = surf;\nvBind = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vSurf;\nvarying vec3 vBind;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + STYLE_COLOUR)
      .replace('#include <opaque_fragment>', STYLE_LIGHT + '\n#include <opaque_fragment>');
  };
  return mat;
}

/** Body and prop material: toon ramp, the caller's patch (fog of war), dissolve, then stylize. */
function figureMaterial(opts, dissolve) {
  const T = E();
  let m = new T.MeshToonMaterial({ vertexColors: true, gradientMap: toonRamp() });
  if (opts.patch) m = opts.patch(m) || m;
  withDissolve(m, dissolve);
  return stylize(m);
}

/** Adds a per-material dither dissolve (uDissolve, 0..1) after any patch the caller applied. */
function withDissolve(mat, u) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    if (prev) prev(sh, r);
    sh.uniforms.uDissolve = u;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uDissolve;')
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        {
          const float BAYERD[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
          ivec2 qd = ivec2(mod(gl_FragCoord.xy, 4.0));
          if ((BAYERD[qd.y * 4 + qd.x] + 0.5) / 16.0 < uDissolve) discard;
        }`);
  };
  return mat;
}

// ---------- the figure ----------

const OFF = NB * 3;            // pose buffer: NB*3 bone rotations, then hips offset (3), root offset (3), root rotation (3)
const PLEN = OFF + 9;
const LAYERS = ['idle', 'move', 'fight', 'work', 'talk', 'sit', 'down'];

/**
 * A figure for one character. opts.patch(material) is applied to the body and prop materials (the
 * world's fog of war); opts.fog is { fogColor, fogNear, fogFar } uniforms for the outline pass.
 */
function create(ch, opts = {}) {
  const T = E();
  const look = describe(ch);
  const { geo, bind } = buildBody(look);
  const S = shared();
  const dissolve = { value: 0 };
  const mat = figureMaterial(opts, dissolve);

  const bones = BONES.map(() => new T.Bone());
  BONES.forEach((n, i) => {
    const par = PARENT[n], b = bones[i], P = bind[n], Q = par ? bind[par] : { x: 0, y: 0, z: 0 };
    b.name = n;
    b.position.set(P.x - Q.x, P.y - Q.y, P.z - Q.z);
    if (par) bones[BI[par]].add(b);
  });
  const mesh = new T.SkinnedMesh(geo, mat);
  mesh.add(bones[0]);
  mesh.updateMatrixWorld(true);
  const skeleton = new T.Skeleton(bones);
  mesh.bind(skeleton);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;

  const group = new T.Group();
  group.add(mesh);
  let outline = null;
  if (opts.outline !== false) {
    const fog = opts.fog || { fogColor: { value: new T.Color('#000') }, fogNear: { value: 1e6 }, fogFar: { value: 1e7 } };
    const omat = new T.ShaderMaterial({
      uniforms: { uPx: S.outline.uPx, uWidth: S.outline.uWidth, fogColor: fog.fogColor, fogNear: fog.fogNear, fogFar: fog.fogFar, uDissolve: dissolve, uOpacity: { value: 1 } },
      vertexShader: OUTLINE_VS, fragmentShader: OUTLINE_FS, vertexColors: true, side: T.BackSide,
    });
    outline = new T.SkinnedMesh(geo, omat);
    outline.bind(skeleton, mesh.bindMatrix);
    outline.frustumCulled = false;
    group.add(outline);
  }

  // props
  const k = look.p.H / 1.12;
  const pmat = figureMaterial(opts, dissolve);
  const propCache = new Map();
  const prop = (kind, q, o) => {
    const key = kind + ':' + q;
    if (propCache.has(key)) return propCache.get(key);
    const built = propGeometry(kind, q, k, o);
    let obj = null;
    if (built) {
      obj = new T.Mesh(built.geo, pmat);
      obj.frustumCulled = false;
      if (built.glow) {
        const sp = new T.Sprite(new T.SpriteMaterial({ map: S.glowTex, color: built.glow.colour, blending: T.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.7 }));
        sp.position.y = built.glow.y;
        sp.scale.setScalar(built.glow.size);
        obj.add(sp);
        obj.userData.glow = sp;
      }
      obj.visible = false;
    }
    propCache.set(key, obj);
    return obj;
  };
  const W = look.weapon, SH = look.shield;
  const cls = !W ? 'unarmed' : W.kind === 'axe' && W.q >= 4 ? 'twohand' : W.kind === 'dagger' && W.q >= 4 ? 'sword' : W.kind;
  const gear = {
    weapon: W ? prop(W.kind, W.q) : null,
    shield: SH ? prop(SH.kind, SH.q) : null,
  };
  if (gear.weapon) bones[BI[W.kind === 'bow' ? 'gripL' : 'gripR']].add(gear.weapon);
  if (gear.shield) {
    gear.shield.position.set(look.p.r.fore + 0.012, -look.p.forearm * 0.5, 0.01);
    bones[BI.foreL].add(gear.shield);
  }
  const arrow = W && W.kind === 'bow' ? prop('arrow', 0) : null;
  if (arrow) { arrow.rotation.set(Math.PI, 0, 0); arrow.position.set(0, -0.22 * k, 0); bones[BI.gripR].add(arrow); }
  const tools = {};
  const tool = (kind, hand = 'R', o) => {
    const key = kind + hand;
    if (!(key in tools)) {
      const m = prop(kind, 0, o);
      if (m) bones[BI['grip' + hand]].add(m);
      tools[key] = m;
    }
    return tools[key];
  };

  const strideOf = (v) => strideFor(look, v);
  const ax = look.axes;
  const A = {
    t: (look.seed % 1000) / 37, phase: 0, speed: 0, yaw: 0, yawRate: 0, px: null, pz: null, accel: 0, lastSpeed: 0,
    w: Object.fromEntries(LAYERS.map(n => [n, n === 'idle' ? 1 : 0])),
    mode: 'idle', job: null, props: 'gear',
    clip: null, clipQueue: [], nextFeint: 1 + (look.seed % 7) * 0.3,
    flinch: 0, flinchV: 0, dodge: 0, dodgeDir: 1, block: 0, flash: 0, flashCol: new T.Color('#ffffff'),
    look: { yaw: 0, pitch: 0 }, glanceAt: 2 + (look.seed % 5), glanceYaw: 0, glancePitch: 0,
    blinkAt: 1 + (look.seed % 3), blink: 0,
    gesture: null, gestureAt: 4 + (look.seed % 6),
    down: 0, dead: false, deadAt: 0, fallDir: (look.seed & 1) ? 1 : -1,
    tail: { a: 0, v: 0 }, hair: { a: 0, v: 0, s: 0, sv: 0 }, ears: { L: 0, R: 0, at: 3 }, wing: { open: 0, beat: 0, until: 0 },
    energy: 1, hurt: 0, face: null, faceY: null,
    emit: null,
  };
  const pose = {};
  for (const n of LAYERS) pose[n] = new Float32Array(PLEN);
  const out = new Float32Array(PLEN), add = new Float32Array(PLEN);
  const bindHips = bones[BI.hips].position.clone(), bindRoot = bones[0].position.clone();

  const fig = {
    look, group, mesh, outline, bones, height: look.p.H, cls,
    get busy() { return !!A.clip; },
    /** Per frame. dt in seconds. in: { x, y, z, mode, job, face: {x, z}, energy, hurt, props } */
    update(dt, inp) { step(dt, inp); },
    /** strike(at), hit(from), dodge, block, heal, fall: see trigger() below. */
    trigger(ev, data) { trigger(ev, data || {}); },
    set opacity(v) { dissolve.value = 1 - clamp01(v); },
    tint(k) { mat.color.setScalar(k); pmat.color.setScalar(k); },
    onEmit(fn) { A.emit = fn; },
    worldPoint(boneName, local = null) {
      const v = new T.Vector3();
      if (local) v.copy(local);
      return bones[BI[boneName]].localToWorld(v);
    },
    dispose() {
      geo.dispose(); mat.dispose(); pmat.dispose();
      if (outline) outline.material.dispose();
      for (const o of propCache.values()) if (o) { o.geometry.dispose(); if (o.userData.glow) o.userData.glow.material.dispose(); }
      skeleton.dispose();
    },
  };

  // ----- events -----
  function trigger(ev, d) {
    if (A.dead) return;
    if (ev === 'strike') {
      if (A.clip && A.clip.t < A.clip.dur * 0.6) { A.clipQueue.length < 2 && A.clipQueue.push(d); return; }
      startClip(attackClip(cls), d);
    } else if (ev === 'hit') {
      A.flinchV += 9 + 4 * (1 - ax.poise);
      A.flash = 1; A.flashCol.set(d.colour || '#ff5a3a');
      if (d.from) A.face = d.from;
      if (look.wings) A.wing.until = A.t + 0.5;
      A.ears.L = A.ears.R = -0.5;
    } else if (ev === 'dodge') { A.dodge = 1; A.dodgeDir = (look.seed + Math.floor(A.t * 3)) & 1 ? 1 : -1; }
    else if (ev === 'block') { A.block = 1; if (d.from) A.face = d.from; }
    else if (ev === 'heal') { A.flash = 0.8; A.flashCol.set('#7dffa0'); }
    else if (ev === 'fall') { A.dead = true; A.deadAt = A.t; if (d.from) A.fallDir = 1; }
    else if (ev === 'cast') startClip(attackClip('cast'), d);
  }
  function startClip(c, d) {
    A.clip = { ...c, t: 0, at: d.at || null, feint: !!d.feint, fired: !!d.feint, dur: c.dur * lerp(1.2, 0.8, ax.poise) };
  }

  // ----- the frame -----
  function step(dt, inp) {
    dt = clamp(dt, 0, 0.1);
    A.t += dt;
    const x = inp.x, z = inp.z;
    if (A.px == null) { A.px = x; A.pz = z; }
    const dx = x - A.px, dz = z - A.pz, dist = Math.hypot(dx, dz);
    A.px = x; A.pz = z;
    const inst = dt > 0 ? dist / dt : 0;
    const v = inst > 8 ? A.speed : inst;            // a jump of more than 8 tiles/s is a teleport
    A.speed = damp(A.speed, v, 9, dt);
    A.accel = damp(A.accel, (A.speed - A.lastSpeed) / Math.max(dt, 1e-3), 6, dt);
    A.lastSpeed = A.speed;
    A.energy = inp.energy != null ? clamp01(inp.energy) : 1;
    A.hurt = damp(A.hurt, inp.hurt ? 1 : 0, 3, dt);
    A.job = inp.job || null;
    if (inp.face !== undefined && inp.face !== null) A.face = inp.face;
    else if (inp.face === null && !A.clip) A.face = null;

    // gait phase by distance: one cycle is two steps
    if (inst <= 8) A.phase = (A.phase + dist / strideOf(A.speed)) % 1;

    // heading: travel direction when moving, else the point to face
    let want = A.yaw;
    if (A.speed > 0.3 && dist > 1e-4) want = Math.atan2(dx, dz);
    else if (A.face) want = Math.atan2(A.face.x - x, A.face.z - z);
    const diff = wrapPi(want - A.yaw), rate = (5 + 7 * ax.poise) * (A.dead ? 0 : 1);
    const turn = clamp(diff, -rate * dt, rate * dt) * (A.speed > 0.3 ? 1 : 0.85);
    A.yaw = wrapPi(A.yaw + turn);
    A.yawRate = damp(A.yawRate, dt > 0 ? turn / dt : 0, 10, dt);
    group.position.set(x, inp.y || 0, z);
    group.rotation.y = A.yaw;

    // which layer is active
    const moving = A.speed > 0.3;
    let mode = A.dead ? 'down' : moving ? 'move' : (inp.mode || 'idle');
    if (!LAYERS.includes(mode)) mode = 'idle';
    A.mode = mode;
    const props = A.dead ? A.props : (inp.props || 'gear');
    A.props = props;
    const blendRate = lerp(5, 9, ax.poise);
    let wsum = 0;
    for (const n of LAYERS) { A.w[n] = damp(A.w[n], n === mode ? 1 : 0, n === 'down' ? 4 : blendRate, dt); wsum += A.w[n]; }

    // clips advance
    if (A.clip) {
      A.clip.t += dt;
      if (!A.clip.fired && A.clip.t >= A.clip.dur * A.clip.hit) {
        A.clip.fired = true;
        if (A.emit) A.emit(A.clip.shot ? { type: A.clip.shot, from: A.clip.shot === 'arrow' ? fig.worldPoint('gripL') : fig.worldPoint('gripR', new T.Vector3(0, look.p.H * 0.62, 0)), to: A.clip.at } : { type: 'swing', at: A.clip.at });
      }
      if (A.clip.t >= A.clip.dur) { A.clip = null; if (A.clipQueue.length) startClip(attackClip(cls), A.clipQueue.shift()); }
    }
    // fight feints keep a stance from freezing between logged blows
    if (mode === 'fight' && !A.clip && A.t > A.nextFeint) {
      A.nextFeint = A.t + lerp(3.2, 1.6, ax.poise) * (0.7 + 0.6 * hash3(look.seed, Math.floor(A.t), 1));
      if (hash3(look.seed, Math.floor(A.t * 7), 2) < 0.35) startClip(attackClip(cls), { feint: true });
    }

    // compute and blend layers
    out.fill(0);
    for (const n of LAYERS) {
      if (A.w[n] < 0.004) continue;
      const P = pose[n];
      P.fill(0);
      LAYER_FN[n](fig, A, P);
      const k2 = A.w[n] / wsum;
      for (let i = 0; i < PLEN; i++) out[i] += P[i] * k2;
    }
    additive(fig, A, out, dt);
    apply(out, dt);
  }

  function apply(P, dt) {
    for (let i = 0; i < NB; i++) bones[i].rotation.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
    bones[BI.hips].position.set(bindHips.x + P[OFF], bindHips.y + P[OFF + 1], bindHips.z + P[OFF + 2]);
    bones[0].position.set(bindRoot.x + P[OFF + 3], bindRoot.y + P[OFF + 4], bindRoot.z + P[OFF + 5]);
    bones[0].rotation.set(P[OFF + 6], P[OFF + 7], P[OFF + 8]);
    // blink: the eyes bone flattens for ~0.12 s
    const blink = A.blink > 0 ? Math.sin(Math.PI * clamp01(A.blink / 0.13)) : 0;
    const shut = A.dead || (A.mode === 'sit' && A.energy < 0.25 && Math.sin(A.t * 0.3) > 0.3) ? 1 : 0;
    bones[BI.eyes].scale.set(1, 1 - 0.88 * Math.max(blink, shut), 1);
    // props by activity
    const show = (o, on) => { if (o) o.visible = on; };
    const fighting = A.props === 'gear';
    show(gear.weapon, fighting);
    show(gear.shield, fighting);
    show(arrow, fighting && A.clip && A.clip.shot === 'arrow' && A.clip.t < A.clip.dur * A.clip.hit);
    for (const key in tools) show(tools[key], false);
    if (A.props === 'tool' && A.job) {
      const spec = JOB_TOOLS[A.job];
      if (spec) for (const [kind, hand] of spec) show(tool(kind, hand, kind === 'flask' ? { liquid: A.job === 'alchemy' ? '#7ad4ff' : '#c8a060' } : null), true);
    }
    if (A.props === 'drill') show(gear.weapon || tool('practice', 'R'), true);
    // hit flash
    if (A.flash > 0) {
      A.flash = Math.max(0, A.flash - dt * 4);
      mat.emissive.copy(A.flashCol).multiplyScalar(A.flash * 0.7);
    } else mat.emissive.setRGB(0, 0, 0);
  }

  return fig;
}

/** Stride (two steps) at a speed: legs reach + stance fraction, so the planted foot does not slide. */
function strideFor(look, v) {
  const p = look.p, legL = p.thigh + p.shin, u = v / p.H;
  const run = sstep(1.0, 2.6, u);
  const beta = lerp(0.6, 0.38, run);
  const amp = lerp(lerp(0.3, 0.46, sstep(0.2, 1.0, u)), lerp(0.5, 0.68, sstep(2.0, 4.0, u)), run);
  return Math.max(0.2, 2 * legL * Math.sin(amp) * lerp(0.92, 0.85, run) / beta);
}

// ---------- poses ----------

const R3 = (P, b, x, y, z) => { const i = BI[b] * 3; P[i] = x; P[i + 1] = y; P[i + 2] = z; };
const A3 = (P, b, x, y = 0, z = 0) => { const i = BI[b] * 3; P[i] += x; P[i + 1] += y; P[i + 2] += z; };
/** Arm: pitch (- forward), abduct (+ away from the body), twist, elbow flexion (+ bends), wrist. */
function arm(P, side, pitch, abduct, twist, elbow, wrist = 0) {
  const s = side === 'L' ? 1 : -1;
  R3(P, 'arm' + side, pitch, twist * s, abduct * s);
  R3(P, 'fore' + side, -elbow, 0, 0);
  R3(P, 'hand' + side, wrist, 0, 0);
}
/** Leg: pitch (- forward), spread (+ out), knee flexion (+), foot pitch (+ toe down). */
function leg(P, side, pitch, spread, knee, foot, twist = 0) {
  const s = side === 'L' ? 1 : -1;
  R3(P, 'thigh' + side, pitch, twist * s, spread * s);
  R3(P, 'shin' + side, knee, 0, 0);
  R3(P, 'foot' + side, foot, 0, 0);
}
const get = (P, b, k = 0) => P[BI[b] * 3 + k];
/** Rotate the grip so a prop held along +y points at world pitch `pitch` (0 up, pi/2 forward). */
function gripTo(P, side, pitch) {
  const chain = get(P, 'hips') + get(P, 'spine') + get(P, 'chest') + get(P, 'arm' + side) + get(P, 'fore' + side) + get(P, 'hand' + side);
  R3(P, 'grip' + side, pitch - chain, 0, 0);
}
/** Feet flat on the ground: foot pitch cancels the leg chain. */
function footFlat(P, side, extra = 0) {
  const chain = get(P, 'hips') + get(P, 'thigh' + side) + get(P, 'shin' + side);
  P[BI['foot' + side] * 3] = -chain + extra;
}
/** Vertical reach from hip joint to sole for a leg pose (planar). */
function reach(p, hipPitch, thigh, knee) {
  return p.thigh * Math.cos(hipPitch + thigh) + p.shin * Math.cos(hipPitch + thigh + knee) + p.ankle;
}

function carry(fig, A, P, swing) {
  // how the held things change the arms while standing or moving
  const cls = fig.cls, armed = A.props === 'gear';
  if (!armed) return;
  if (cls === 'staff' || cls === 'spear') {
    arm(P, 'R', -0.25 + swing * 0.3, 0.12, 0.1, 0.75, 0);
    gripTo(P, 'R', cls === 'spear' ? 0.08 : 0.04);
  } else if (cls === 'twohand') {
    arm(P, 'R', -0.35, 0.08, 0.2, 0.9); arm(P, 'L', -0.55, 0.0, -0.2, 1.1);
    gripTo(P, 'R', -0.55);
  } else if (cls === 'bow') {
    arm(P, 'L', -0.1 - swing * 0.3, 0.12, 0, 0.3);
    gripTo(P, 'L', 0.15);
    P[BI.gripL * 3 + 1] = -Math.PI / 2;
  } else if (cls !== 'unarmed') {
    const i = BI.armR * 3;
    P[i] *= 0.6;
    P[BI.foreR * 3] = Math.min(P[BI.foreR * 3], -0.45);
    gripTo(P, 'R', 2.15);
  }
  if (fig.look.shield) {
    const i = BI.armL * 3;
    P[i] *= 0.5; P[i + 2] = Math.max(P[i + 2], 0.18);
    P[BI.foreL * 3] = Math.min(P[BI.foreL * 3], -0.55);
    P[BI.foreL * 3 + 1] = 0.6;
  }
}

function idleLayer(fig, A, P) {
  const p = fig.look.p, ax = fig.look.axes, t = A.t, e = A.energy, n = ax.nerve, m = ax.mass;
  const breath = Math.sin(t * (1.5 + (1 - e) * 0.9));
  const shift = Math.sin(t * 0.42 + (fig.look.seed % 10));
  const slouch = (1 - e) * 0.2 - n * 0.06 + A.hurt * 0.12;
  P[OFF] = shift * 0.011 * (1 + m) * p.H;
  P[OFF + 1] = -0.004 - Math.abs(shift) * 0.004 - (1 - e) * 0.01 - A.hurt * 0.015;
  R3(P, 'hips', 0.02, 0, -shift * 0.035);
  R3(P, 'spine', slouch * 0.5, 0, shift * 0.025);
  R3(P, 'chest', slouch * 0.45 - breath * 0.015, 0, shift * 0.012);
  R3(P, 'neck', slouch * 0.3, 0, 0);
  R3(P, 'head', -slouch * 0.55 + (1 - e) * 0.18 - n * 0.05, 0, -shift * 0.02);
  const sp = 0.035 + m * 0.05;
  leg(P, 'L', -0.03, sp, 0.04 + Math.max(0, -shift) * 0.1 + A.hurt * (fig.look.limpSide === 'L' ? 0.25 : 0), 0);
  leg(P, 'R', 0.02, sp, 0.04 + Math.max(0, shift) * 0.1 + A.hurt * (fig.look.limpSide === 'R' ? 0.25 : 0), 0);
  footFlat(P, 'L'); footFlat(P, 'R');
  const lift = breath * 0.02 + (n < 0 ? -n * 0.08 : 0);
  R3(P, 'clavL', 0, n < 0 ? n * 0.12 : 0, lift); R3(P, 'clavR', 0, n < 0 ? -n * 0.12 : 0, -lift);
  const ab = 0.07 + m * 0.13;
  arm(P, 'L', 0.03 + shift * 0.02, ab, 0.1, 0.14 + (1 - e) * 0.05, 0.1);
  arm(P, 'R', 0.03 - shift * 0.02, ab, 0.1, 0.14 + (1 - e) * 0.05, 0.1);
  carry(fig, A, P, 0);
  gesture(fig, A, P);
}

/** Occasional idle gestures, picked with weights that are functions of the axes. */
function gesture(fig, A, P) {
  const ax = fig.look.axes, t = A.t;
  if (!A.gesture && t > A.gestureAt && A.mode === 'idle' && A.props !== 'gear') {
    const opts = [
      ['hips', Math.max(0, ax.nerve) * 1.2 + 0.1],
      ['cross', Math.max(0, -ax.nerve) * 1.0 + 0.15],
      ['stretch', (1 - A.energy) * 1.2 + 0.05],
      ['look', 0.6],
      ['scratch', 0.25],
    ];
    const tot = opts.reduce((s, o) => s + o[1], 0);
    let r = hash3(fig.look.seed, Math.floor(t), 9) * tot, kind = 'look';
    for (const [k, w] of opts) { r -= w; if (r < 0) { kind = k; break; } }
    A.gesture = { kind, t0: t, dur: kind === 'look' ? 2.5 : kind === 'stretch' ? 3 : kind === 'scratch' ? 1.6 : 4 + hash3(fig.look.seed, Math.floor(t), 4) * 4 };
  }
  if (!A.gesture) return;
  const g = A.gesture, k = (t - g.t0) / g.dur;
  if (k >= 1 || A.mode !== 'idle') { A.gesture = null; A.gestureAt = t + 3 + hash3(fig.look.seed, Math.floor(t), 6) * 6; return; }
  const env = sstep(0, 0.15, k) * sstep(1, 0.85, k);
  const mixArm = (side, pitch, ab, tw, el) => {
    const s = side === 'L' ? 1 : -1, i = BI['arm' + side] * 3, f = BI['fore' + side] * 3;
    P[i] = lerp(P[i], pitch, env); P[i + 1] = lerp(P[i + 1], tw * s, env); P[i + 2] = lerp(P[i + 2], ab * s, env);
    P[f] = lerp(P[f], -el, env);
  };
  if (g.kind === 'hips') { mixArm('L', 0.25, 0.75, -0.5, 1.7); mixArm('R', 0.25, 0.75, -0.5, 1.7); A3(P, 'chest', -0.05 * env); }
  else if (g.kind === 'cross') { mixArm('L', -0.55, 0.15, -0.9, 1.85); mixArm('R', -0.45, 0.1, -0.9, 1.95); A3(P, 'head', 0.06 * env); }
  else if (g.kind === 'stretch') { const e2 = Math.sin(Math.PI * k); mixArm('L', -2.8 * e2, 0.3, 0, 0.5); mixArm('R', -2.8 * e2, 0.3, 0, 0.5); A3(P, 'chest', -0.2 * e2); A3(P, 'head', -0.3 * e2); }
  else if (g.kind === 'scratch') { mixArm('R', -1.2, 0.35, -0.3, 2.4); A3(P, 'head', 0.1 * env, 0.15 * env, 0.1 * env); }
  else if (g.kind === 'look') { A.glanceYaw = Math.sin(k * Math.PI * 2) * 0.9; }
}

function moveLayer(fig, A, P) {
  const look = fig.look, p = look.p, ax = look.axes, e = A.energy, n = ax.nerve, m = ax.mass;
  const v = A.speed, u = v / p.H;
  const run = sstep(1.0, 2.6, u);
  const beta = lerp(0.6, 0.38, run);
  const amp = lerp(lerp(0.3, 0.46, sstep(0.2, 1.0, u)), lerp(0.5, 0.68, sstep(2.0, 4.0, u)), run) * (1 - A.hurt * 0.25);
  const ph = A.phase;
  const hipPitch = 0.02 + 0.12 * run;
  R3(P, 'hips', hipPitch, 0, 0);
  let wsum = 0, ysum = 0;
  for (const [side, off] of [['L', 0], ['R', 0.5]]) {
    let q = (ph + off) % 1;
    const limp = A.hurt * (look.limpSide === side ? 1 : 0);
    const b = beta * (1 - limp * 0.25);
    let th, kn, fw;
    if (q < b) {
      const s = q / b;
      th = lerp(-amp, amp * 0.85, s);
      kn = (0.08 + 0.3 * run) * Math.sin(Math.PI * s) + limp * 0.15;
      fw = s < 0.15 ? lerp(-0.22, 0, s / 0.15) : s < 0.7 ? 0 : lerp(0, 0.45 * (0.6 + 0.4 * run), (s - 0.7) / 0.3);
    } else {
      const s = (q - b) / (1 - b);
      th = lerp(amp * 0.85, -amp * 1.03, smooth(s)) + (s > 0.85 ? (s - 0.85) * amp * 0.2 : 0);
      kn = (0.75 + 0.9 * run) * (0.72 + 0.28 * e) * Math.pow(Math.sin(Math.PI * Math.min(1, s * 1.08)), 0.9) * (1 - limp * 0.4);
      fw = s < 0.4 ? lerp(0.45, -0.1, s / 0.4) : lerp(-0.1, -0.2, (s - 0.4) / 0.6);
    }
    leg(P, side, th, 0.02 + m * 0.03, kn, 0);
    P[BI['foot' + side] * 3] = fw - (hipPitch + th + kn);
    if (q < b) { const w = Math.sin(Math.PI * q / b) + 0.05; wsum += w; ysum += w * reach(p, hipPitch, th, kn); }
  }
  const rest = p.thigh + p.shin + p.ankle;
  const walkY = wsum > 0 ? ysum / wsum : rest * 0.96;
  const runY = rest * 0.94 + 0.03 * p.H * Math.abs(Math.sin(TAU * ph)) * (1 - m * 0.4);
  P[OFF + 1] = lerp(walkY, runY, run) - rest - A.hurt * 0.01;
  P[OFF] = (0.01 + 0.01 * m) * p.H * Math.sin(TAU * ph) * (1 - run * 0.6) * (1 - ax.poise * 0.4);
  const yawA = (0.1 + 0.08 * run), rollA = (0.045 + 0.03 * m) * (1 - ax.poise * 0.3) * (1 - 0.5 * run);
  const c = Math.cos(TAU * ph), s1 = Math.sin(TAU * ph);
  P[BI.hips * 3 + 1] = -yawA * c;
  P[BI.hips * 3 + 2] = rollA * s1;
  const slouch = (1 - e) * 0.2 - n * 0.05 + A.hurt * 0.1;
  R3(P, 'spine', 0.03 + 0.12 * run + slouch * 0.5 + clamp(A.accel * 0.04, -0.1, 0.15), yawA * 0.5 * c, -rollA * 0.5 * s1);
  R3(P, 'chest', slouch * 0.4 + 0.04 * run, yawA * 0.7 * c, -rollA * 0.3 * s1);
  const lean = get(P, 'hips') + get(P, 'spine') + get(P, 'chest');
  R3(P, 'neck', 0, -yawA * 0.3 * c, 0);
  R3(P, 'head', -lean * 0.75 + (1 - e) * 0.12 - n * 0.06, -yawA * 0.6 * c, rollA * 0.3 * s1);
  const S = (0.26 + 0.42 * run) * (0.55 + 0.45 * e) * (1 + 0.2 * n) * (1 - 0.3 * m);
  const el = (fwd) => lerp(0.2 + 0.25 * Math.max(0, fwd), 1.35, run);
  const ab = 0.06 + 0.12 * m;
  arm(P, 'L', S * c, ab, 0.1, el(-c));
  arm(P, 'R', -S * c, ab, 0.1, el(c));
  R3(P, 'clavL', 0, 0.04 * c, 0.03 * Math.abs(s1) * run);
  R3(P, 'clavR', 0, 0.04 * c, -0.03 * Math.abs(s1) * run);
  carry(fig, A, P, c * S);
}

// stance per weapon class: arms, grip pitch, and how far the hips turn
const STANCE = {
  sword:   (P, sh) => { arm(P, 'R', -0.55, 0.28, 0, 1.25, 0.2); gripTo(P, 'R', 0.55); if (sh) arm(P, 'L', -0.75, 0.35, -0.55, 1.7); else arm(P, 'L', -0.5, 0.22, 0, 1.0); },
  dagger:  (P, sh) => { arm(P, 'R', -0.6, 0.25, 0, 1.55); gripTo(P, 'R', 1.4); if (sh) arm(P, 'L', -0.75, 0.35, -0.55, 1.7); else arm(P, 'L', -0.9, 0.15, -0.3, 2.0); },
  axe:     (P, sh) => { arm(P, 'R', -0.8, 0.3, 0, 1.4); gripTo(P, 'R', 0.2); if (sh) arm(P, 'L', -0.75, 0.35, -0.55, 1.7); else arm(P, 'L', -0.5, 0.2, 0, 1.0); },
  twohand: (P) => { arm(P, 'R', -0.95, 0.1, 0.3, 1.25); arm(P, 'L', -1.0, -0.05, -0.3, 1.45); gripTo(P, 'R', -0.25); },
  spear:   (P) => { arm(P, 'R', 0.15, 0.15, 0.2, 1.45); arm(P, 'L', -0.95, -0.05, -0.2, 0.55); gripTo(P, 'R', 1.42); },
  staff:   (P) => { arm(P, 'R', -0.45, 0.15, 0.1, 0.95); gripTo(P, 'R', 0.18); arm(P, 'L', -1.15, 0.12, 0, 0.35, -0.4); },
  bow:     (P) => { arm(P, 'L', -0.15, 1.45, 0, 0.05); R3(P, 'gripL', 0, 0, -1.5); arm(P, 'R', -0.1, 1.15, 0.2, 2.1); },
  unarmed: (P) => { arm(P, 'R', -0.85, 0.32, -0.3, 2.1); arm(P, 'L', -1.0, 0.32, -0.3, 2.0); },
};

function stanceLayer(fig, A, P, cls = fig.cls) {
  const look = fig.look, p = look.p, ax = look.axes, t = A.t, n = ax.nerve;
  const bob = Math.sin(t * lerp(5, 8, ax.poise)) * lerp(0.4, 1, ax.poise);
  const crouch = (cls === 'dagger' ? 0.55 : cls === 'bow' ? 0.15 : 0.32) + 0.06 * (1 - n) + A.hurt * 0.1;
  const turn = cls === 'bow' ? -1.15 : cls === 'spear' ? -0.6 : -0.35;
  R3(P, 'hips', 0.06 + n * 0.04, turn, 0);
  leg(P, 'L', -0.35 - crouch * 0.5, 0.1, crouch * 1.1 + bob * 0.03, 0);
  leg(P, 'R', 0.3, 0.14, crouch * 0.9 - bob * 0.03, 0, -0.2);
  footFlat(P, 'L'); footFlat(P, 'R');
  P[OFF + 1] = reach(p, 0.06, -0.35 - crouch * 0.5, crouch * 1.1) - (p.thigh + p.shin + p.ankle) + bob * 0.004;
  R3(P, 'spine', 0.06 + n * 0.06, -turn * 0.35, 0);
  R3(P, 'chest', 0.04 + n * 0.04, -turn * 0.25, 0);
  R3(P, 'neck', 0, -turn * 0.2, 0);
  R3(P, 'head', -0.12 - n * 0.04, -turn * 0.2, 0);
  (STANCE[cls] || STANCE.unarmed)(P, !!look.shield && cls !== 'twohand' && cls !== 'spear' && cls !== 'bow' && cls !== 'staff');
  if (cls === 'bow') { A3(P, 'chest', 0, 0.3); A3(P, 'head', 0, 0.5); }
  if (A.clip) applyClip(fig, A, P);
  if (A.block > 0 && look.shield) { const k = Math.sin(Math.PI * A.block); A3(P, 'armL', -0.35 * k, 0, 0); A3(P, 'chest', -0.05 * k); }
  if (look.shield && !['twohand', 'spear', 'bow', 'staff'].includes(cls)) P[BI.foreL * 3 + 1] = 0.6;
}

function fightLayer(fig, A, P) { stanceLayer(fig, A, P); }

// Attack clips: additive keys over the stance. hit = normalised time of the blow.
const CLIPS = {
  sword: { dur: 0.62, hit: 0.5, keys: [[0, {}], [0.38, { armR: [-1.0, 0, 0.55], foreR: [-0.5, 0, 0], chest: [0, 0.45, 0], spine: [0, 0.2, 0], handR: [0.4, 0, 0] }],
    [0.52, { armR: [0.15, 0, -0.65], foreR: [0.85, 0, 0], chest: [0.15, -0.55, 0], spine: [0.1, -0.25, 0], root: [0, 0, 0.12] }], [0.7, { armR: [0.12, 0, -0.6], foreR: [0.8, 0, 0], chest: [0.12, -0.45, 0], root: [0, 0, 0.1] }], [1, {}]] },
  dagger: { dur: 0.55, hit: 0.3, keys: [[0, {}], [0.15, { armR: [0.3, 0, 0], foreR: [-0.3, 0, 0] }], [0.3, { armR: [-0.55, 0, 0], foreR: [1.1, 0, 0], chest: [0.1, -0.3, 0], root: [0, 0, 0.14] }],
    [0.45, { armR: [0.2, 0, 0], foreR: [-0.2, 0, 0] }], [0.62, { armR: [-0.5, 0, 0.1], foreR: [1.0, 0, 0], chest: [0.08, -0.25, 0], root: [0, 0, 0.12] }], [1, {}]] },
  axe: { dur: 0.75, hit: 0.55, keys: [[0, {}], [0.42, { armR: [-1.6, 0, 0.1], foreR: [-0.4, 0, 0], chest: [-0.15, 0.25, 0], spine: [-0.1, 0, 0] }],
    [0.57, { armR: [0.5, 0, -0.1], foreR: [0.9, 0, 0], chest: [0.35, -0.3, 0], spine: [0.15, 0, 0], root: [0, -0.02, 0.1] }], [0.75, { armR: [0.45, 0, -0.1], foreR: [0.85, 0, 0], chest: [0.3, -0.2, 0], root: [0, -0.02, 0.08] }], [1, {}]] },
  twohand: { dur: 0.85, hit: 0.58, keys: [[0, {}], [0.45, { armR: [-1.55, 0, 0], armL: [-1.45, 0, 0], foreR: [-0.3, 0, 0], foreL: [-0.3, 0, 0], chest: [-0.2, 0, 0], spine: [-0.1, 0, 0] }],
    [0.6, { armR: [0.65, 0, 0], armL: [0.7, 0, 0], foreR: [0.9, 0, 0], foreL: [1.0, 0, 0], chest: [0.4, 0, 0], spine: [0.25, 0, 0], root: [0, -0.03, 0.12] }], [0.78, { armR: [0.6, 0, 0], armL: [0.65, 0, 0], foreR: [0.85, 0, 0], foreL: [0.9, 0, 0], chest: [0.35, 0, 0], spine: [0.2, 0, 0], root: [0, -0.03, 0.1] }], [1, {}]] },
  spear: { dur: 0.6, hit: 0.48, keys: [[0, {}], [0.32, { armR: [0.35, 0, 0], armL: [0.3, 0, 0], chest: [0, 0.35, 0], root: [0, 0, -0.06] }],
    [0.5, { armR: [-1.0, 0, -0.1], foreR: [1.1, 0, 0], armL: [-0.35, 0, 0], foreL: [0.4, 0, 0], chest: [0.12, -0.35, 0], spine: [0.08, -0.15, 0], root: [0, 0, 0.2] }], [0.68, { armR: [-0.9, 0, -0.1], foreR: [1.0, 0, 0], armL: [-0.3, 0, 0], chest: [0.1, -0.3, 0], root: [0, 0, 0.17] }], [1, {}]] },
  staff: { dur: 0.8, hit: 0.55, shot: 'orb', keys: [[0, {}], [0.4, { armR: [-1.6, 0, 0.1], foreR: [0.4, 0, 0], armL: [-1.0, 0, 0.2], chest: [-0.12, 0, 0], head: [-0.15, 0, 0] }],
    [0.56, { armR: [-0.9, 0, 0], foreR: [0.6, 0, 0], armL: [-0.4, 0, 0], foreL: [0.3, 0, 0], chest: [0.15, -0.1, 0], root: [0, 0, 0.06] }], [0.75, { armR: [-0.8, 0, 0], foreR: [0.5, 0, 0], chest: [0.1, 0, 0], root: [0, 0, 0.04] }], [1, {}]] },
  bow: { dur: 1.0, hit: 0.62, shot: 'arrow', keys: [[0, {}], [0.15, { armR: [-0.45, 0, -0.35], foreR: [-0.2, 0, 0] }], [0.5, { armR: [-0.1, 0, 0.05], foreR: [0.6, 0, 0], chest: [-0.05, 0.08, 0], handR: [0.3, 0, 0] }],
    [0.6, { armR: [-0.1, 0, 0.05], foreR: [0.6, 0, 0], chest: [-0.05, 0.08, 0] }], [0.66, { armR: [0.15, 0, 0.15], foreR: [0.3, 0, 0], chest: [-0.03, 0.12, 0] }], [1, {}]] },
  unarmed: { dur: 0.6, hit: 0.42, keys: [[0, {}], [0.2, { armL: [-0.55, 0, 0], foreL: [1.6, 0, 0], chest: [0, 0.25, 0], root: [0, 0, 0.05] }], [0.32, {}],
    [0.45, { armR: [-0.7, 0, -0.2], foreR: [1.8, 0, 0], chest: [0.1, -0.45, 0], spine: [0, -0.2, 0], root: [0, 0, 0.1] }], [0.65, {}], [1, {}]] },
  cast: { dur: 0.9, hit: 0.5, keys: [[0, {}], [0.4, { armR: [-2.3, 0, 0.2], armL: [-2.3, 0, 0.2], foreR: [0.5, 0, 0], foreL: [0.5, 0, 0], head: [-0.25, 0, 0], chest: [-0.1, 0, 0] }], [0.7, { armR: [-2.0, 0, 0.6], armL: [-2.0, 0, 0.6] }], [1, {}]] },
};
function attackClip(cls) { return CLIPS[cls] || CLIPS.unarmed; }

function applyClip(fig, A, P) {
  const c = A.clip, k = clamp01(c.t / c.dur), keys = c.keys;
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1][0] < k) i++;
  const [t0, a] = keys[i], [t1, b] = keys[i + 1];
  const f = smooth(clamp01((k - t0) / Math.max(1e-4, t1 - t0)));
  const feint = c.feint ? 0.35 : 1;
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const n of names) {
    const va = a[n] || [0, 0, 0], vb = b[n] || [0, 0, 0];
    const x = lerp(va[0], vb[0], f) * feint, y = lerp(va[1], vb[1], f) * feint, z = lerp(va[2], vb[2], f) * feint;
    if (n === 'root') { P[OFF + 3] += x; P[OFF + 4] += y; P[OFF + 5] += z * fig.look.p.H; }
    else A3(P, n, x, y, z);
  }
  // the grip keeps its stance angle relative to the hand, so the weapon swings with the arm
}

// ---------- work ----------

// tools in hand per job: [kind, hand]
const JOB_TOOLS = {
  mining: [['pick', 'R']], smithing: [['hammer', 'R']], farming: [['hoe', 'R']], foraging: [['basket', 'L']],
  alchemy: [['flask', 'L'], ['ladle', 'R']], cooking: [['ladle', 'R']], maintenance: [['broom', 'R']], building: [['hammer', 'R']],
};

/** Keyframed absolute poses for one work cycle, sampled with smoothing. */
function cycle(keys, k) {
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1][0] <= k) i++;
  const [t0, a] = keys[i], [t1, b] = keys[i + 1];
  const f = smooth(clamp01((k - t0) / Math.max(1e-4, t1 - t0)));
  const o = {};
  for (const n of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const va = a[n] || b[n], vb = b[n] || a[n];
    o[n] = va.map((v, j) => lerp(v, vb[j], f));
  }
  return o;
}
const WORK = {
  // two-handed overhead strike at the ground ahead
  mining: { T: 1.5, keys: [[0, { armR: [-0.95, 0.1, 0], armL: [-0.85, -0.1, 0], foreR: [0.35], foreL: [0.4], spine: [0.42], chest: [0.15], grip: [2.75] }],
    [0.45, { armR: [-2.75, 0.05, 0], armL: [-2.6, -0.05, 0], foreR: [1.1], foreL: [1.2], spine: [-0.08], chest: [-0.15], grip: [3.2] }],
    [0.6, { armR: [-0.95, 0.1, 0], armL: [-0.85, -0.1, 0], foreR: [0.35], foreL: [0.4], spine: [0.45], chest: [0.18], grip: [2.75] }], [1, { armR: [-0.95, 0.1, 0], armL: [-0.85, -0.1, 0], foreR: [0.35], foreL: [0.4], spine: [0.42], chest: [0.15], grip: [2.75] }]], strikeAt: 0.6, crouch: 0.25 },
  farming: { T: 1.7, keys: [[0, { armR: [-0.7, 0.1, 0], armL: [-0.75, -0.1, 0], foreR: [0.5], foreL: [0.6], spine: [0.5], chest: [0.15], grip: [2.8] }],
    [0.4, { armR: [-1.7, 0.05, 0], armL: [-1.6, -0.05, 0], foreR: [1.1], foreL: [1.2], spine: [0.15], chest: [0], grip: [3.5] }],
    [0.55, { armR: [-0.7, 0.1, 0], armL: [-0.75, -0.1, 0], foreR: [0.5], foreL: [0.6], spine: [0.55], chest: [0.15], grip: [2.85] }], [0.8, { armR: [-0.6, 0.1, 0], armL: [-0.65, -0.1, 0], foreR: [0.4], foreL: [0.5], spine: [0.5], chest: [0.1], grip: [2.9] }], [1, { armR: [-0.7, 0.1, 0], armL: [-0.75, -0.1, 0], foreR: [0.5], foreL: [0.6], spine: [0.5], chest: [0.15], grip: [2.8] }]], strikeAt: 0.55, crouch: 0.3 },
  smithing: { T: 0.95, keys: [[0, { armR: [-0.75, 0.25, 0], foreR: [0.6], spine: [0.25], grip: [3.0] }], [0.5, { armR: [-1.1, 0.3, 0], foreR: [2.1], spine: [0.15], grip: [3.0] }], [0.62, { armR: [-0.75, 0.25, 0], foreR: [0.6], spine: [0.28], grip: [3.0] }], [1, { armR: [-0.75, 0.25, 0], foreR: [0.6], spine: [0.25], grip: [3.0] }]],
    left: [-0.55, 0.15, 0, 1.0], strikeAt: 0.62, crouch: 0.15, sparks: true },
  building: { T: 1.0, kneel: true, keys: [[0, { armR: [-0.55, 0.25, 0], foreR: [0.3], spine: [0.55], grip: [3.0] }], [0.5, { armR: [-1.0, 0.3, 0], foreR: [1.9], spine: [0.4], grip: [3.0] }], [0.62, { armR: [-0.55, 0.25, 0], foreR: [0.3], spine: [0.58], grip: [3.0] }], [1, { armR: [-0.55, 0.25, 0], foreR: [0.3], spine: [0.55], grip: [3.0] }]],
    left: [-0.6, 0.2, 0, 0.5], strikeAt: 0.62 },
  maintenance: { T: 1.3, sweep: true, keys: [[0, { armR: [-0.35, 0.15, 0], armL: [-0.75, -0.15, 0], foreR: [0.5], foreL: [0.7], spine: [0.3], gripR: [0.35] }], [1, { armR: [-0.35, 0.15, 0], armL: [-0.75, -0.15, 0], foreR: [0.5], foreL: [0.7], spine: [0.3], gripR: [0.35] }]] },
  foraging: { T: 3.4, keys: [[0, { armR: [-0.3, 0.1, 0], foreR: [0.4], spine: [0.15], squat: [0] }], [0.25, { armR: [-0.7, 0.1, 0], foreR: [0.15], spine: [0.7], squat: [1] }],
    [0.42, { armR: [-0.6, 0.15, 0], foreR: [0.4], spine: [0.7], squat: [1] }], [0.62, { armR: [-0.35, -0.3, 0], foreR: [1.5], spine: [0.25], squat: [0.3] }], [0.8, { armR: [-0.3, 0.1, 0], foreR: [0.4], spine: [0.1], squat: [0], look: [0.8] }], [1, { armR: [-0.3, 0.1, 0], foreR: [0.4], spine: [0.15], squat: [0] }]], left: [-0.15, 0.25, 0, 1.4] },
  alchemy: { T: 1.6, stir: true, left: [-0.5, 0.1, -0.3, 1.35], pour: true },
  cooking: { T: 1.3, stir: true, left: [-0.45, 0.1, -0.3, 1.25] },
};

function workLayer(fig, A, P) {
  const look = fig.look, p = look.p, ax = look.axes, job = A.job;
  if (job === 'training') { A.props = 'drill'; const c = fig.cls === 'unarmed' ? 'sword' : fig.cls; stanceLayer(fig, A, P, c); drill(fig, A, c); return; }
  const W = WORK[job];
  idleLayer(fig, A, P);
  if (!W) return;
  const T = W.T * lerp(1.15, 0.85, ax.poise) * lerp(1.3, 1, A.energy);
  const ph = ((A.t + (look.seed % 97) * 0.1) / T);
  const k = ph % 1, nth = Math.floor(ph);
  if (W.strikeAt != null && A.emit) {
    const was = A.workK || 0;
    if (was < W.strikeAt && k >= W.strikeAt) A.emit({ type: W.sparks ? 'sparks' : 'thud', from: fig.worldPoint('gripR', new (E().Vector3)(0, p.H * 0.18, 0)) });
  }
  A.workK = k;
  // lower body
  if (W.kneel) {
    R3(P, 'hips', 0.05, 0, 0);
    leg(P, 'L', -1.35, 0.12, 1.55, 0); leg(P, 'R', 0.35, 0.08, 2.1, 0);
    footFlat(P, 'L'); P[BI.footR * 3] = 0.9;
    P[OFF + 1] = -(p.thigh + p.shin) * 0.42;
  } else {
    const cr = W.crouch || 0.1;
    leg(P, 'L', -0.25 - cr * 0.4, 0.1, cr, 0); leg(P, 'R', 0.15, 0.1, cr * 0.8, 0);
    footFlat(P, 'L'); footFlat(P, 'R');
    P[OFF + 1] = reach(p, 0, -0.25 - cr * 0.4, cr) - (p.thigh + p.shin + p.ankle);
  }
  if (W.stir) {
    const w = TAU * k;
    arm(P, 'R', -0.75 + 0.12 * Math.sin(w), 0.05 + 0.12 * Math.cos(w), -0.2, 1.4 + 0.15 * Math.sin(w));
    const [lp, la, lt, le] = W.left;
    let lpitch = lp, lel = le, tilt = 0;
    if (W.pour && nth % 3 === 2) { const q = Math.sin(Math.PI * k); lpitch -= 0.5 * q; lel += 0.3 * q; tilt = -1.6 * q; }
    arm(P, 'L', lpitch, la, lt, lel);
    R3(P, 'spine', 0.12, 0, 0); R3(P, 'head', 0.35, 0, 0);
    gripTo(P, 'R', 0.25);
    gripTo(P, 'L', 0);
    P[BI.gripL * 3 + 2] = tilt;
    return;
  }
  const o = cycle(W.keys, k);
  if (o.armR) arm(P, 'R', o.armR[0], o.armR[1], o.armR[2], o.foreR ? o.foreR[0] : 0.2);
  if (o.armL) arm(P, 'L', o.armL[0], o.armL[1], o.armL[2], o.foreL ? o.foreL[0] : 0.2);
  else if (W.left) arm(P, 'L', W.left[0], W.left[1], W.left[2], W.left[3]);
  if (o.spine) A3(P, 'spine', o.spine[0] - get(P, 'spine'));
  if (o.chest) R3(P, 'chest', o.chest[0], 0, 0);
  R3(P, 'head', 0.25 - (o.spine ? o.spine[0] * 0.4 : 0), o.look ? o.look[0] * Math.sin(A.t) : 0, 0);
  if (o.squat) {
    const q = o.squat[0];
    leg(P, 'L', -0.25 - 1.15 * q, 0.15, 0.2 + 1.5 * q, 0); leg(P, 'R', 0.1 - 1.0 * q, 0.15, 0.15 + 1.6 * q, 0);
    footFlat(P, 'L'); footFlat(P, 'R');
    P[OFF + 1] = reach(p, 0, -0.25 - 1.15 * q, 0.2 + 1.5 * q) - (p.thigh + p.shin + p.ankle);
  }
  if (W.sweep) {
    const sw = Math.sin(TAU * k);
    A3(P, 'chest', 0, 0.35 * sw); A3(P, 'spine', 0, 0.15 * sw); A3(P, 'hips', 0, 0.1 * sw);
    R3(P, 'head', 0.4, -0.3 * sw, 0);
    gripTo(P, 'R', -0.45);
    P[BI.gripR * 3 + 2] = -0.25 * sw;
  } else if (o.grip) {
    P[BI.gripR * 3] = o.grip[0];
  }
  if (job === 'foraging') gripTo(P, 'L', 0);
}

function drill(fig, A, cls) {
  if (!A.clip && A.t > A.nextFeint) {
    A.nextFeint = A.t + lerp(2.2, 1.2, fig.look.axes.poise) * (0.7 + 0.6 * hash3(fig.look.seed, Math.floor(A.t), 3));
    A.clip = { ...attackClip(cls), t: 0, at: null, fired: true, dur: attackClip(cls).dur * lerp(1.2, 0.85, fig.look.axes.poise) };
  }
}

function talkLayer(fig, A, P) {
  idleLayer(fig, A, P);
  const t = A.t, seed = fig.look.seed;
  // speaking and listening alternate on a slow clock offset by the seed, so two partners trade turns
  const speaking = Math.sin(t * 0.55 + (seed % 2) * Math.PI) > 0;
  if (speaking) {
    const g1 = noise3(t * 1.3, seed % 50, 1), g2 = noise3(t * 1.1, seed % 50, 7);
    arm(P, 'R', -0.45 - g1 * 0.5, 0.2 + g1 * 0.2, -0.3, 1.3 + g1 * 0.4, -0.3);
    arm(P, 'L', -0.2 - g2 * 0.45, 0.15 + g2 * 0.2, -0.3, 0.9 + g2 * 0.6, -0.3);
    A3(P, 'head', 0.05 * Math.sin(t * 3.1), 0.08 * Math.sin(t * 1.7), 0.05 * Math.sin(t * 2.3));
    A3(P, 'chest', 0, 0.06 * Math.sin(t * 1.3));
  } else {
    A3(P, 'head', 0.06 * Math.max(0, Math.sin(t * 2.4)) ** 4, 0, 0.1);
  }
}

function sitLayer(fig, A, P) {
  const p = fig.look.p, t = A.t, e = A.energy;
  const breath = Math.sin(t * 1.4);
  leg(P, 'L', -1.25, 0.18, 2.05, 0); leg(P, 'R', -1.2, 0.14, 2.0, 0);
  footFlat(P, 'L'); footFlat(P, 'R');
  P[OFF + 1] = -(p.thigh + p.shin + p.ankle) + p.thigh * 0.18 + 0.01;
  P[OFF + 2] = -p.thigh * 0.45;
  R3(P, 'hips', -0.25, 0, 0);
  R3(P, 'spine', 0.3 + (1 - e) * 0.15, 0, 0);
  R3(P, 'chest', 0.12 - breath * 0.015, 0, 0);
  const nod = e < 0.25 ? sstep(0.3, 0.8, Math.sin(t * 0.3)) * 0.5 : 0;
  R3(P, 'head', 0.05 + nod, 0.15 * Math.sin(t * 0.21), 0);
  arm(P, 'L', -0.75, 0.12, -0.2, 0.7); arm(P, 'R', -0.7, 0.1, -0.2, 0.75);
}

function downLayer(fig, A, P) {
  const p = fig.look.p, k = clamp01((A.t - A.deadAt) / 0.5), f = clamp01((A.t - A.deadAt - 0.35) / 0.55);
  const kneel = smooth(k), fall = smooth(f);
  leg(P, 'L', lerp(-1.3, 0, fall) * kneel, 0.1, lerp(2.2, 0.15, fall) * kneel, 0);
  leg(P, 'R', lerp(-1.1, 0.1, fall) * kneel, 0.12, lerp(2.3, 0.2, fall) * kneel, 0);
  R3(P, 'spine', lerp(0.5 * kneel, 0.05, fall), 0, 0);
  R3(P, 'chest', lerp(0.3 * kneel, 0, fall), 0, 0);
  R3(P, 'head', lerp(0.5 * kneel, -0.2 * A.fallDir, fall), 0.4 * fall, 0);
  arm(P, 'L', lerp(0.1, -1.2 * fall, fall), lerp(0.1, 0.9, fall), 0, 0.3);
  arm(P, 'R', lerp(0.1, -0.4, fall), lerp(0.1, 0.5, fall), 0, 0.5);
  P[OFF + 1] = -(p.thigh + p.shin) * 0.5 * kneel * (1 - fall);
  P[OFF + 6] = -A.fallDir * (Math.PI / 2 - 0.06) * fall;
  P[OFF + 4] = 0.05 * fall;
  P[OFF + 5] = A.fallDir * p.H * 0.05 * fall;
}

const LAYER_FN = { idle: idleLayer, move: moveLayer, fight: fightLayer, work: workLayer, talk: talkLayer, sit: sitLayer, down: downLayer };

/** Layers added on top of the blend: look-at, flinch, dodge, turn lean, secondary motion. */
function additive(fig, A, P, dt) {
  const look = fig.look, ax = look.axes, t = A.t;
  // blink
  A.blink -= dt;
  if (t > A.blinkAt) { A.blink = 0.13; A.blinkAt = t + 1.8 + hash3(look.seed, Math.floor(t), 11) * 4; }
  // head: glance in idle, face the point otherwise
  if (A.mode === 'idle' && t > A.glanceAt) {
    A.glanceAt = t + 2 + hash3(look.seed, Math.floor(t), 12) * 5;
    A.glanceYaw = (hash3(look.seed, Math.floor(t), 13) - 0.5) * 1.6;
    A.glancePitch = (hash3(look.seed, Math.floor(t), 14) - 0.6) * 0.3;
  }
  let wy = 0, wp = 0;
  if (A.mode === 'idle' || A.mode === 'talk') { wy = A.glanceYaw * (A.mode === 'talk' ? 0.2 : 1); wp = A.glancePitch; }
  if (A.face && A.mode !== 'move' && A.mode !== 'down') {
    const dx = A.face.x - fig.group.position.x, dz = A.face.z - fig.group.position.z;
    if (dx * dx + dz * dz > 0.01) wy += clamp(wrapPi(Math.atan2(dx, dz) - A.yaw), -1.2, 1.2) * 0.8;
  }
  A.look.yaw = damp(A.look.yaw, clamp(wy, -1.3, 1.3), 4 + 4 * ax.poise, dt);
  A.look.pitch = damp(A.look.pitch, wp, 4, dt);
  A3(P, 'neck', A.look.pitch * 0.4, A.look.yaw * 0.4, 0);
  A3(P, 'head', A.look.pitch * 0.6, A.look.yaw * 0.6, 0);
  // flinch spring
  A.flinchV += (-A.flinch * 140 - A.flinchV * 16) * dt;
  A.flinch += A.flinchV * dt;
  const fl = A.flinch * 0.06;
  if (Math.abs(fl) > 1e-4) {
    A3(P, 'spine', -0.4 * fl); A3(P, 'chest', -0.35 * fl); A3(P, 'head', -0.5 * fl);
    A3(P, 'armL', 0, 0, 0.3 * fl); A3(P, 'armR', 0, 0, -0.3 * fl);
    P[OFF + 5] -= fl * 0.1 * look.p.H;
  }
  if (A.dodge > 0) {
    A.dodge = Math.max(0, A.dodge - dt / 0.4);
    const k = Math.sin(Math.PI * (1 - A.dodge));
    P[OFF + 3] += A.dodgeDir * 0.16 * look.p.H * k;
    A3(P, 'spine', 0, 0, -A.dodgeDir * 0.25 * k);
    A3(P, 'shinL', 0.3 * k); A3(P, 'shinR', 0.3 * k);
    P[OFF + 1] -= 0.03 * k;
  }
  if (A.block > 0) A.block = Math.max(0, A.block - dt / 0.35);
  // lean into turns while moving
  const lean = clamp(-A.yawRate * A.speed * 0.05, -0.25, 0.25);
  A3(P, 'hips', 0, 0, lean); A3(P, 'head', 0, 0, -lean * 0.6);

  // tail: counter-swing with the hips, lag on turns, wag when idle
  if (look.tail) {
    const tk = look.tail.kind;
    A.tail.v += (-A.yawRate * 0.35 - A.tail.a * 30 - A.tail.v * 6) * dt;
    A.tail.a += A.tail.v * dt;
    const idleWag = A.mode === 'idle' || A.mode === 'talk';
    const wagA = tk === 'lizard' ? 0.12 : idleWag ? 0.22 + 0.2 * A.energy : 0.1;
    const wagF = tk === 'lizard' ? 1.3 : tk === 'cat' ? 1.6 : idleWag ? 6 : 3;
    const hy = get(P, 'hips', 1);
    const droop = (1 - A.energy) * 0.35 - Math.max(0, ax.nerve) * 0.15;
    const run = sstep(1.0, 2.6, A.speed / look.p.H);
    for (const [b, k, lag] of [['tail0', 0.5, 0], ['tail1', 0.8, 0.9], ['tail2', 1.0, 1.8]]) {
      // +x raises a tail that points back: tired tails hang, running tails stream out behind
      const pitch = -droop * k * 0.5 + run * (tk === 'lizard' ? 0.15 : 0.4) * k + (tk === 'lizard' ? 0 : 0.06 * Math.sin(TAU * A.phase * 2) * run);
      R3(P, b, pitch, (-hy * 1.2 + A.tail.a) * k + wagA * Math.sin(t * wagF - lag), 0);
    }
  }
  // ponytail and braids: hang under gravity against the head pitch, swing on acceleration and turns
  if (look.hair && look.hair.tail) {
    const tilt = get(P, 'hips') + get(P, 'spine') + get(P, 'chest') + get(P, 'neck') + get(P, 'head');
    A.hair.v += (-A.accel * 0.08 - A.hair.a * 40 - A.hair.v * 7) * dt;
    A.hair.a += A.hair.v * dt;
    A.hair.sv += (-A.yawRate * 0.3 - A.hair.s * 40 - A.hair.sv * 7) * dt;
    A.hair.s += A.hair.sv * dt;
    const bounce = 0.08 * Math.sin(TAU * A.phase * 2) * sstep(0.3, 1.5, A.speed);
    R3(P, 'hair0', -tilt * 0.8 + A.hair.a + bounce, 0, A.hair.s);
    R3(P, 'hair1', -tilt * 0.15 + A.hair.a * 0.6 + bounce * 0.7, 0, A.hair.s * 0.7);
  }
  // ears: a twitch every few seconds, flop with the stride
  A.ears.L = damp(A.ears.L, 0, 9, dt); A.ears.R = damp(A.ears.R, 0, 9, dt);
  if (t > A.ears.at) { A.ears.at = t + 2 + hash3(look.seed, Math.floor(t), 15) * 5; if (hash3(look.seed, Math.floor(t), 16) < 0.5) A.ears.L = 0.45; else A.ears.R = 0.45; }
  const flop = 0.15 * Math.sin(TAU * A.phase * 2) * sstep(0.3, 1.5, A.speed);
  R3(P, 'earL', A.ears.L * 0.5 + flop, 0, A.ears.L);
  R3(P, 'earR', A.ears.R * 0.5 + flop, 0, -A.ears.R);
  // wings: folded; they open on a hit, in a fight swing and at a run
  if (look.wings) {
    const run = sstep(1.5, 2.6, A.speed / look.p.H);
    const open = A.t < A.wing.until || (A.clip && A.mode === 'fight') ? 1 : run * 0.35;
    A.wing.open = damp(A.wing.open, open, 5, dt);
    const beat = Math.sin(t * 14) * A.wing.open * 0.35;
    const fold = 1 - A.wing.open;
    const insect = look.wings.kind === 'insect';
    const flutter = insect ? 0.08 * Math.sin(t * 20) : 0.03 * Math.sin(t * 1.5);
    R3(P, 'wingL', 0.1 * fold, (insect ? 0.7 : 1.15) * fold + flutter, -0.35 * fold + beat);
    R3(P, 'wingR', 0.1 * fold, -(insect ? 0.7 : 1.15) * fold - flutter, 0.35 * fold - beat);
  }
}

// ---------- effects: projectiles, sparks, hit bursts ----------

/** Short-lived world effects for one scene. update(dt) every frame; shoot/burst spawn. */
function effects(scene) {
  const T = E(), S = shared();
  const live = [];
  const arrowGeo = (() => { const g = propGeometry('arrow', 0, 1); return g ? g.geo : null; })();
  const arrowMat = new T.MeshLambertMaterial({ vertexColors: true });
  const sprite = (colour, size, opacity = 0.9) => {
    const s = new T.Sprite(new T.SpriteMaterial({ map: S.glowTex, color: colour, blending: T.AdditiveBlending, depthWrite: false, transparent: true, opacity }));
    s.scale.setScalar(size);
    scene.add(s);
    return s;
  };
  return {
    /** kind 'arrow' | 'orb'; from, to: Vector3 (world). onLand() fires when it arrives. */
    shoot(kind, from, to, { colour = '#7fc8ff', onLand = null } = {}) {
      const d = from.distanceTo(to), dur = clamp(d / (kind === 'arrow' ? 14 : 8), 0.12, 0.6);
      let obj;
      if (kind === 'arrow' && arrowGeo) { obj = new T.Mesh(arrowGeo, arrowMat); scene.add(obj); }
      else obj = sprite(colour, 0.32);
      live.push({ obj, kind, from: from.clone(), to: to.clone(), t: 0, dur, arc: kind === 'arrow' ? d * 0.12 : d * 0.05, onLand, trail: kind === 'orb' ? sprite(colour, 0.18, 0.5) : null });
    },
    /** A flash at a point: 'hit' (orange), 'spark' (yellow, small), 'heal' (green, rising), 'dust' (grey). */
    burst(at, kind = 'hit') {
      const look = { hit: ['#ffb070', 0.55, 0.22], spark: ['#ffe08a', 0.3, 0.25], heal: ['#7dffa0', 0.7, 0.6], dust: ['#b8a890', 0.5, 0.45], magic: ['#9fd0ff', 0.7, 0.3] }[kind] || ['#ffffff', 0.4, 0.25];
      const s = sprite(look[0], look[1] * 0.4);
      live.push({ obj: s, kind: 'burst', at: at.clone(), t: 0, dur: look[2], size: look[1], rise: kind === 'heal' ? 0.6 : 0 });
      if (kind === 'spark') for (let i = 0; i < 5; i++) {
        const sp = sprite('#ffd060', 0.06);
        const v = new T.Vector3((Math.random() - 0.5) * 2, 1 + Math.random() * 1.5, (Math.random() - 0.5) * 2);
        live.push({ obj: sp, kind: 'spark', at: at.clone(), v, t: 0, dur: 0.35 });
      }
    },
    update(dt) {
      for (let i = live.length - 1; i >= 0; i--) {
        const e = live[i];
        e.t += dt;
        const k = clamp01(e.t / e.dur);
        if (e.kind === 'arrow' || e.kind === 'orb') {
          const p = new T.Vector3().lerpVectors(e.from, e.to, k);
          p.y += Math.sin(Math.PI * k) * e.arc;
          if (e.kind === 'arrow') {
            const p2 = new T.Vector3().lerpVectors(e.from, e.to, Math.min(1, k + 0.02)); p2.y += Math.sin(Math.PI * Math.min(1, k + 0.02)) * e.arc;
            e.obj.position.copy(p);
            e.obj.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), p2.sub(p).normalize());
          } else {
            e.obj.position.copy(p);
            if (e.trail) e.trail.position.lerpVectors(e.from, p, 0.85);
          }
        } else if (e.kind === 'burst') {
          e.obj.position.set(e.at.x, e.at.y + e.rise * k, e.at.z);
          e.obj.scale.setScalar(e.size * (0.4 + k));
          e.obj.material.opacity = 0.9 * (1 - k);
        } else if (e.kind === 'spark') {
          e.v.y -= 6 * dt;
          e.at.addScaledVector(e.v, dt);
          e.obj.position.copy(e.at);
          e.obj.material.opacity = 1 - k;
        }
        if (k >= 1) {
          if (e.onLand) e.onLand();
          scene.remove(e.obj);
          if (e.obj.material && e.obj.material !== arrowMat) e.obj.material.dispose();
          if (e.trail) { scene.remove(e.trail); e.trail.material.dispose(); }
          live.splice(i, 1);
        }
      }
    },
    clear() { for (const e of live) { scene.remove(e.obj); if (e.trail) scene.remove(e.trail); } live.length = 0; },
    dispose() { this.clear(); arrowMat.dispose(); if (arrowGeo) arrowGeo.dispose(); },
  };
}

/** Called by the renderer before drawing: keeps the outline a fixed width in pixels. */
function viewport(width, height, widthPx = 1.25) {
  const S = shared();
  S.outline.uPx.value.set(2 / Math.max(1, width), 2 / Math.max(1, height));
  S.outline.uWidth.value = widthPx;
}

window.Figure3D = {
  describe, signature, create, effects, viewport, BONES, JOB_TOOLS,
  ready: () => typeof window.THREE === 'object' && window.THREE !== null,
};
})();
