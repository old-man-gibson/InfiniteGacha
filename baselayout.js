// The base as a procedural layout. Browser: window.BaseLayout. Node: module.exports.
//
// Input: the structures the town has (townmap.js workPlots/bedPlots: key, kind, footprint w x h
// in tiles) and state.base. Output: positions in tiles with (0, 0) at the centre of the square
// and -z as north. Nothing here knows about tiles or drawing; townmap.js rasterises the result
// for walking and world3d.js builds meshes from it.
//
// Placement is greedy and stored. A structure is placed the first time it appears, against
// everything already standing, and { x, z, rot } goes into state.base.placed[key]. A later
// structure never moves an earlier one. Demolishing a structure deletes its entry.
//
// Variation per save: state.base.seed is rolled once with Rng. Each structure's candidate search
// runs on its own mulberry32 stream seeded from (seed, key), so the stream a structure gets does
// not depend on what was placed before it. Two saves with the same buildings get different
// layouts; one save keeps its layout across reloads.
//
// Fixed points:
//   square   radius SQUARE_R at the origin; every door has a road to its rim
//   crystal  CRYSTAL_D tiles north of the square's centre, with a clear plaza of CRYSTAL_R
//   road out leaves the square's south rim and runs to the gate at the edge of the base
//
// Where things go (bearing measured from north, clockwise):
//   work     penalised by cos(bearing) * WORK_NORTH: workshops sit east, south and west
//   bed      penalised by -cos(bearing) * BED_SOUTH: homes sit round the crystal
//   altar    penalised by (1 - cos(bearing)) * ALTAR_PULL: next to the crystal
// Score = ring distance + penalty + jitter in [0, JITTER). Lowest valid score wins.

(() => {
const R = () => (typeof Rng !== 'undefined') ? Rng : require('./rng.js');

const SQUARE_R = 5;
const CRYSTAL_D = 9;           // crystal centre, tiles north of the square centre
const CRYSTAL_R = 3.2;         // plaza kept clear round the crystal
const GAP = 1.4;               // tiles between bounding circles
const ROAD_CLEAR = 2.2;        // half-width of the corridor kept clear for the road out
const WORK_NORTH = 7, BED_SOUTH = 4, ALTAR_PULL = 3, JITTER = 2.2;
const ANGLES = 28;             // candidate bearings per ring
const RING_STEP = 0.9;         // tiles between candidate rings
const SEARCH = 5;              // rings searched past the first ring that had a valid spot
const MIN_EXTENT = 16;         // base radius before anything is built

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s, seed) {
  let h = seed | 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 2654435761);
  return (h ^ (h >>> 16)) >>> 0;
}

/** state.base, created on first use. The seed is the only random draw the layout ever makes. */
function ensure(state) {
  if (!state.base || typeof state.base.seed !== 'number') {
    state.base = { seed: R().randInt(1, 2147483646), placed: {} };
  }
  state.base.placed = state.base.placed || {};
  return state.base;
}

const radiusOf = (s) => 0.5 * Math.hypot(s.rw || s.w, s.rh || s.h);
const crystalAt = () => ({ x: 0, z: -CRYSTAL_D });

function valid(x, z, r, standing) {
  if (Math.hypot(x, z) < SQUARE_R + r + GAP) return false;
  const c = crystalAt();
  if (Math.hypot(x - c.x, z - c.z) < CRYSTAL_R + r + GAP * 0.5) return false;
  if (z > 0 && Math.abs(x) < r + ROAD_CLEAR) return false;           // the road out, south
  for (const o of standing) if (Math.hypot(x - o.x, z - o.z) < r + o.r + GAP) return false;
  return true;
}

function penalty(kind, bearing) {
  const c = Math.cos(bearing);                    // 1 north, -1 south
  if (kind === 'work') return Math.max(0, c) * WORK_NORTH;
  if (kind === 'bed') return Math.max(0, -c) * BED_SOUTH;
  if (kind === 'altar') return (1 - c) * ALTAR_PULL;
  return 0;
}

/** Find a spot for one structure. Returns { x, z, rot }. */
function place(seed, s, standing) {
  const rnd = mulberry32(hashStr(s.key, seed));
  const r = radiusOf(s);
  const phase = rnd() * Math.PI * 2;
  let best = null, firstRing = null;
  for (let d = SQUARE_R + r + GAP; d < SQUARE_R + r + 200; d += RING_STEP) {
    if (firstRing !== null && d > firstRing + SEARCH * RING_STEP) break;
    for (let k = 0; k < ANGLES; k++) {
      const bearing = phase + (k + rnd() * 0.8) * (Math.PI * 2 / ANGLES);
      const x = Math.sin(bearing) * d, z = -Math.cos(bearing) * d;
      if (!valid(x, z, r, standing)) continue;
      if (firstRing === null) firstRing = d;
      const score = d + penalty(s.kind, bearing) + rnd() * JITTER;
      if (!best || score < best.score) best = { x, z, score };
    }
  }
  // the door (local +z) faces the square's centre, give or take ROT_JITTER
  const rot = Math.atan2(-best.x, -best.z) + (rnd() - 0.5) * 0.4;
  return { x: +best.x.toFixed(3), z: +best.z.toFixed(3), rot: +rot.toFixed(4) };
}

/** Local (u, v) in a structure's frame to world (x, z). Local +v is the door side. */
const toWorld = (s, u, v) => ({
  x: s.x + u * Math.cos(s.rot) + v * Math.sin(s.rot),
  z: s.z - u * Math.sin(s.rot) + v * Math.cos(s.rot),
});
/** World (x, z) to a structure's local (u, v). */
function toLocal(s, x, z) {
  const dx = x - s.x, dz = z - s.z;
  return { u: dx * Math.cos(s.rot) - dz * Math.sin(s.rot), v: dx * Math.sin(s.rot) + dz * Math.cos(s.rot) };
}

/**
 * The layout. `list` is every structure the town has now, in the order they were added; each
 * entry is { key, kind, w, h } plus optional reserve size { rw, rh } (the footprint the spot is
 * chosen for, so a workshop has room to grow into its later tiers) and anything else the
 * caller wants carried through.
 */
function layout(state, list) {
  const base = ensure(state);
  const keys = new Set(list.map(s => s.key));
  for (const k of Object.keys(base.placed)) if (!keys.has(k)) delete base.placed[k];

  const standing = [];
  for (const s of list) {
    const p = base.placed[s.key];
    if (p) standing.push({ x: p.x, z: p.z, r: radiusOf(s) });
  }
  const structures = [];
  for (const s of list) {
    let p = base.placed[s.key];
    if (!p) {
      p = base.placed[s.key] = place(base.seed, s, standing);
      standing.push({ x: p.x, z: p.z, r: radiusOf(s) });
    }
    const st = { ...s, x: p.x, z: p.z, rot: p.rot, r: radiusOf(s) };
    st.door = toWorld(st, 0, s.h / 2);
    st.step = toWorld(st, 0, s.h / 2 + 0.9);            // just outside the door
    structures.push(st);
  }

  const extent = Math.max(MIN_EXTENT, ...structures.map(s => Math.hypot(s.x, s.z) + s.r + 3));
  const rnd = mulberry32(hashStr('roads', base.seed));

  // a road from every door to the square's rim, bent once to one side
  const roads = structures.map(s => {
    const a = s.step, len = Math.hypot(a.x, a.z) || 1;
    const rim = { x: a.x / len * (SQUARE_R - 0.5), z: a.z / len * (SQUARE_R - 0.5) };
    const bend = (rnd() - 0.5) * 2.4;
    const mid = { x: (a.x + rim.x) / 2 - (a.z / len) * bend, z: (a.z + rim.z) / 2 + (a.x / len) * bend };
    return { key: s.key, width: s.kind === 'work' ? 1.5 : 1.1, pts: [[s.door.x, s.door.z], [a.x, a.z], [mid.x, mid.z], [rim.x, rim.z]] };
  });
  // the road out: south from the square to the gate, with two bends
  const gate = { x: (rnd() - 0.5) * 3, z: extent + 1 };
  roads.push({
    key: 'out', width: 2.4,
    pts: [[0, SQUARE_R - 0.5], [(rnd() - 0.5) * 2, extent * 0.4], [(rnd() - 0.5) * 3, extent * 0.75], [gate.x, gate.z], [gate.x + (rnd() - 0.5) * 4, extent + 12]],
  });
  // and a short path from the square up to the crystal
  const crystal = crystalAt();
  roads.push({ key: 'crystal', width: 2.0, pts: [[0, -SQUARE_R + 0.5], [crystal.x, crystal.z + CRYSTAL_R - 0.5]] });

  return { seed: base.seed, square: { x: 0, z: 0, r: SQUARE_R }, crystal: { ...crystal, r: CRYSTAL_R }, gate, extent, structures, roads };
}

const BaseLayoutAPI = { SQUARE_R, CRYSTAL_D, CRYSTAL_R, ensure, layout, toWorld, toLocal, radiusOf, mulberry32, hashStr };
if (typeof module !== 'undefined') module.exports = BaseLayoutAPI;
if (typeof window !== 'undefined') window.BaseLayout = BaseLayoutAPI;
})();
