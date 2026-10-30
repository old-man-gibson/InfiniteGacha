// The base as a procedural layout. Browser: window.BaseLayout. Node: module.exports.
//
// Input: the structures the town has (townmap.js workPlots/bedPlots: key, kind, floor, footprint
// w x h in tiles), the number of open floors, and state.base. Output: positions in tiles with
// (0, 0) at the centre of the square and -z as north, the floor platforms, and the roads. Nothing
// here knows about tiles or drawing; townmap.js rasterises the result for walking and world3d.js
// builds meshes from it. heightAt() and floorAt() are shared by both, so where a walker can go and
// what is drawn under them come from the same function.
//
// Placement is greedy and stored. A structure is placed the first time it appears on its floor,
// against everything already standing, and { x, z, rot, floor, r, annex } goes into
// state.base.placed[key]. A later structure never moves an earlier one. A structure is placed
// again when its floor changes (a workshop whose floor has just opened), when it has outgrown
// the radius it was placed with (townmap.js reserves one tier ahead on upper floors), or when an
// open floor's platform covers it (only a save laid out before floors existed). Demolishing
// deletes the entry.
//
// Variation per save: state.base.seed is rolled once with Rng. Each structure's candidate search
// runs on its own mulberry32 stream seeded from (seed, key); the floor stack and its shapes on one
// seeded from (seed, 'floors'). Two saves with the same buildings differ; one save keeps its layout.
//
// Fixed points on floor 0:
//   square   radius SQUARE_R at the origin; every floor-0 door has a road to its rim
//   crystal  CRYSTAL_D tiles north of the square's centre, with a clear plaza of CRYSTAL_R
//   road out leaves the square's south rim and runs to the gate past the southernmost building
//
// FLOORS. Floor k >= 1 is a platform FLOOR_H x k tiles up, centred on a stack point north of the
// crystal, climbing in a zigzag (ZIG). The stack (all MAX_FLOOR floors) and every floor's SHAPE are fixed the first time the
// layout runs, before those floors open, and nothing is placed where it would end up under one.
// Every convex shape FACES its stair: its local +v axis points at what the stair heads for, and
// its front (the side on that axis) is CORE_R from its centre and never moves, so the landing
// keeps its room. Its BACK (-v) points away from the floor below, out of the town.
// GROWING. For every floor opened above it, an open floor's back moves out GROW_PER_FLOOR tiles
// past whatever its buildings need: the shape is swept backward from its widest row (bodySdf), so
// the terraces grow out of the town and the island grows with them (THE ISLAND) instead of the
// platforms covering more of the ground floor. Buildings below a floor keep clear of the size it will reach once
// every floor is open, and off the land behind it, so growing never covers anything and the
// buildings on a floor can always take its body further back.
// A base rolls one shape style for all its floors (STYLES), or 'mixed' for one per floor. Bases
// laid out before 'lobed' left the roll keep it:
//   oval   an ellipse, CORE_R / aspect wide and CORE_R deep; grows wider, and deeper away from its
//          front, taking the width and depth that hold its buildings in the least area. It may sit
//          forward of its front (OVAL_CUTS) and be cut flat there, a D with its straight side to
//          the stair, so a building beside the stair does not need the whole oval to swell.
// Ovals and polygons may also sit off to one side of the stair line (SHIFTS), as long as their flat
// front still spans the stair's top: a floor whose other side is under the floor above grows
// toward the side it can use.
//   rect   a rounded rectangle, CORE_R / aspect wide and CORE_R deep; its sides and back are each
//          pushed out on their own to hold its buildings
//   poly   a regular hexagon or octagon, apothem CORE_R, one flat side as its front; stretched
//          wider and deeper the same way as the oval
//   lobed  a disc of CORE_R plus one PAD round every building and one WAY (its road, raised)
//          back to the plaza, so the platform is the shape of what stands on it
// Every shape contains the disc of CORE_R. A building joins the convex body of oval/rect/poly
// floors, which grows to hold it, but only where the grown body would not cover anything below it
// (buildings, plazas, stairs, the square, the crystal) and its buildings need no more than
// SHAPE_MAX; a building on a lower floor keeps RESERVE tiles from a higher floor's edge
// (RESERVE_EMPTY while that floor has nothing on it) so it has room to, and the ground keeps ZONE
// tiles from every floor's final shape and the land behind it. When that body
// is boxed in, the building stands on an ANNEX instead: its own pad and a way back to the plaza,
// as on a lobed floor. Consecutive floors overlap by OVERLAP tiles along the line between them.
// Each floor's STAIR runs from its platform's edge, along the line toward the floor below (the
// crystal for floor 1), STAIR_LEN down; that whole line is a CORRIDOR kept clear of buildings.
//
// THE ISLAND. The base is a floating island as big as what is built on it. On each of ISLE_N
// bearings from its centre the rim lies ISLAND_M tiles past the farthest thing on the ground (the
// square, the crystal, ground structures) and TERRACE_M past the farthest platform edge, so the
// island grows where the terraces grow. A dip between two parts of the town is filled across
// (ISLE_FILL), the rim is smoothed (ISLE_SMOOTH) and pushed out by up to ISLAND_WOBBLE tiles of
// three seeded sine waves. islandSdf() is positive on it (measured along the bearing). The road out
// leaves the square south and ends at the GATE, a portal just inside the rim. A POND sits on open
// ground near the rim where nothing is within reach, and spills over the rim as a waterfall (lay.fall).
//
// Where things go (bearing measured from north, clockwise), floor 0 only:
//   work     penalised by cos(bearing) * WORK_NORTH: east, south and west of the square
//   bed      penalised by |cos(bearing)| * BED_SIDE: east and west
// Score = ring distance + penalty + jitter in [0, JITTER). Lowest valid score wins. On an upper
// floor the search rings out from the floor's plaza and the nearest valid spot wins.

(() => {
const R = () => (typeof Rng !== 'undefined') ? Rng : require('./rng.js');

const SQUARE_R = 5;
const CRYSTAL_D = 9;           // crystal centre, tiles north of the square centre
const CRYSTAL_R = 3.2;         // plaza kept clear round the crystal
const GAP = 1.4;               // tiles between bounding circles on one floor
const CLIFF_GAP = 2.4;         // extra gap between structures on different floors
const ROAD_CLEAR = 2.2;        // half-width of the corridor kept clear for the road out
const WORK_NORTH = 7, BED_SIDE = 2, JITTER = 2.2;
const ANGLES = 28;             // candidate bearings per ring
const RING_STEP = 0.9;         // tiles between candidate rings
const SEARCH = 5;              // rings searched past the first ring that had a valid spot
const MIN_EXTENT = 16;         // base radius before anything is built

const MAX_FLOOR = 4;
const FLOOR_H = 2.4;                           // tiles of height per floor
const CORE_R = [0, 9, 8, 7.5, 7.5];            // smallest half-extent of each floor's shape
const OVERLAP = 2.5;                           // how far a floor reaches back over the one below
const STAIR_LEN = 3.6, STAIR_W = 2.2;
const PAD = 1.1;                               // platform margin round a building on an upper floor
const PLAZA_R = 2.2;                           // kept clear round each floor's centre
const CLIFF = 0.35;                            // half-width of the cliff band in heightAt
const WAY_MARGIN = 0.9;                        // a way's platform half-width past its road's
const WAY_CLEAR = 2.4;                         // kept clear either side of a way's centreline at placement
const WAY_MAX = 14;                            // longest causeway, tiles past the body's edge
const SHAPE_MAX = 30;                          // largest half-extent the buildings on a convex body may need
const GROW_PER_FLOOR = 4;                      // tiles a floor's back moves out per floor opened above it
const RESERVE = 1.6;                           // a lower building keeps this far from a higher floor's edge (growth needs 1.4)
const RESERVE_EMPTY = 8;                       // ... and this far while that floor has nothing on it, so its first buildings fit
const ZONE = 5;                                // the ground keeps this far from every floor's final shape and the land behind it
const RC = 1.4;                                // corner radius of a rect platform
const STYLES = [['oval', 0.32], ['rect', 0.32], ['poly', 0.2], ['mixed', 0.16]];
const ISLAND_M = 6;                            // tiles of ground past the farthest ground structure to the island's rim
const TERRACE_M = 2.2;                         // ... and past the farthest platform edge
const ISLE_N = 180;                            // bearings the rim is worked out on
const ISLE_FILL = 30;                          // bearings either side that a dip in the rim is filled across (60 degrees)
const ISLE_SMOOTH = 4;                         // bearings either side the rim is widened over, then averaged over
const ISLAND_WOBBLE = 2.6;                     // how far the rim is pushed out
const POND_R = 2.0;                            // the pond that feeds the waterfall
const ZIG = [0, 0, 1.15, 0.15, -1.0];          // bearing of floor k from floor k-1, radians from north (x side)

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
const smooth = (t) => t * t * (3 - 2 * t);
const sstep = (a, b, x) => smooth(Math.max(0, Math.min(1, (x - a) / (b - a))));

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

/** Distance from (x, z) to the segment a-b. */
function segDist(x, z, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2));
  return Math.hypot(x - a.x - dx * t, z - a.z - dz * t);
}

// ---------- shapes ----------

function pickStyle(rnd, mixed = true) {
  const list = mixed ? STYLES : STYLES.filter(([s]) => s !== 'mixed');
  const total = list.reduce((a, [, w]) => a + w, 0);
  let x = rnd() * total;
  for (const [s, w] of list) if ((x -= w) < 0) return s;
  return list[0][0];
}

/** A floor's shape parameters, rolled with the stack; its facing is set when it is placed. */
function rollShape(rnd, style, r) {
  if (style === 'oval') { const asp = 0.62 + rnd() * 0.28; return { style, a0: r / asp, b0: r }; }
  if (style === 'rect') { const asp = 0.62 + rnd() * 0.33; return { style, hx0: r / asp, hz0: r }; }
  if (style === 'poly') return { style, sides: rnd() < 0.5 ? 6 : 8, a0: r };
  return { style: 'lobed' };
}

/** Normals of a regular polygon's sides in its local frame, one of them +v (the front). */
const OVAL_CUTS = [1, 0.8, 0.62];             // where an oval's centre sits: front - depth x this (1 = no cut)
const SHIFTS = [0, -4, 4, -8, 8, -12, 12];      // tiles an oval or polygon may sit to one side of its stair line
const polyNormals = (n) => Array.from({ length: n }, (_, i) => { const t = Math.PI / 2 + i * 2 * Math.PI / n; return [Math.cos(t), Math.sin(t)]; });

/** Tiles floor k's back has moved out once floors up to `top` are open. */
const extraAt = (k, top) => GROW_PER_FLOOR * Math.max(0, top - k);

/**
 * The shape of floor `c` (a stack entry) holding `pads` (circles: building + PAD) in its body,
 * then swept `extra` tiles further back (extraAt; a lobed floor grows all round instead). S.fit is
 * the largest half-extent the pads need. Annex pads and ways are attached afterwards. Older stacks
 * carry no style: they are lobed.
 */
function grow(c, pads = [], extra = 0) {
  const style = c.style || 'lobed';
  const S = { style, x: c.x, z: c.z, r: c.r, rot: c.rot || 0, annexPads: [], ways: [] };
  S.cos = Math.cos(S.rot); S.sin = Math.sin(S.rot);
  const loc = (x, z) => { const dx = x - S.x, dz = z - S.z; return [dx * S.cos - dz * S.sin, dx * S.sin + dz * S.cos]; };
  if (style === 'oval' || style === 'poly') {
    // Pads in the frame of the stack centre. For each depth (half-extent along v) the front stays at
    // v = front, so the centre sits at v = front - depth; the width that holds every pad at that
    // depth is worked out, and the depth with the least area wins.
    const front = style === 'oval' ? c.b0 : c.a0;
    const P = pads.map(p => { const [u, v] = loc(p.x, p.z); return { u, v, r: p.r }; });
    const normals = style === 'poly' ? polyNormals(c.sides) : null;
    let best = null;
    for (let depth = front; depth <= SHAPE_MAX + 1e-9; depth += style === 'poly' ? 1 : 0.5) for (const cut of style === 'oval' ? OVAL_CUTS : [1]) for (const cu of pads.length ? SHIFTS : [0]) {
      const cv = front - depth * cut;
      let width;
      if (style === 'oval') {
        width = c.a0;
        for (const p of P) {
          const q = (Math.abs(p.v - cv) + p.r) / depth;
          if (q >= 1 || p.v + p.r > front) { width = Infinity; break; }
          width = Math.max(width, (Math.abs(p.u - cu) + p.r) / Math.sqrt(1 - q * q));
        }
        // the flat front has to reach past the stair line on both sides of it
        const chord = width * Math.sqrt(Math.max(0, 1 - ((front - cv) / depth) ** 2));
        if (cu && Math.abs(cu) > chord - STAIR_W) continue;
      } else {
        // stretched polygon: holds(sx) is monotone in the lateral stretch, so bisect it
        const sz = depth / front;
        const holds = (sx) => P.every(p => {
          const pu = (p.u - cu) / sx, pv = (p.v - cv) / sz, rr = p.r / Math.min(sx, sz);
          let m = -Infinity;
          for (const [nu, nv] of normals) m = Math.max(m, pu * nu + pv * nv);
          return c.a0 - m >= rr;
        });
        if (holds(1)) width = c.a0;
        else if (!holds(SHAPE_MAX / c.a0)) width = Infinity;
        else {
          let lo = 1, hi = SHAPE_MAX / c.a0;
          for (let i = 0; i < 14; i++) { const mid = (lo + hi) / 2; if (holds(mid)) hi = mid; else lo = mid; }
          width = c.a0 * hi;
        }
      }
      if (width > SHAPE_MAX) continue;
      // a polygon's front side reaches A tan(pi/n) x stretch each way from its middle
      if (style === 'poly' && cu && Math.abs(cu) > c.a0 * Math.tan(Math.PI / c.sides) * (width / c.a0) - STAIR_W) continue;
      const cost = width * depth * (1 + cut) / 2;      // a cut oval is that much smaller
      if (!best || cost < best.cost - 1e-9) best = { cost, width, depth, cv, cu };
      if (!pads.length) break;                         // nothing to hold: the shape at rest
    }
    if (!best) best = { width: SHAPE_MAX * 2, depth: SHAPE_MAX * 2, cv: front - SHAPE_MAX * 2 };   // too big: valid() refuses it
    const cu = best.cu || 0;
    // local +v is (sin rot, cos rot) in the world and local +u is (cos rot, -sin rot)
    S.x = c.x + S.sin * best.cv + S.cos * cu; S.z = c.z + S.cos * best.cv - S.sin * cu;
    S.fit = Math.max(best.width, best.depth);
    S.back = extra;                                // the floors above sweep it back from its widest row (bodySdf)
    if (style === 'oval') { S.a = best.width; S.b = best.depth; S.clip = front - best.cv; }   // the flat front, from the centre
    else { S.sides = c.sides; S.normals = normals; S.A = c.a0; S.sx = best.width / c.a0; S.sz = best.depth / front; }
  } else if (style === 'rect') {
    S.x0 = -c.hx0; S.x1 = c.hx0; S.z0 = -c.hz0; S.z1 = c.hz0;
    for (const p of pads) {
      const [u, v] = loc(p.x, p.z);
      S.x0 = Math.min(S.x0, u - p.r); S.x1 = Math.max(S.x1, u + p.r); S.z0 = Math.min(S.z0, v - p.r); S.z1 = Math.max(S.z1, v + p.r);
    }
    S.fit = Math.max(-S.x0, S.x1, -S.z0, S.z1);
    S.z0 -= extra;                                 // then the floors above push its back out; the front (+v) and sides stay
  } else {
    S.r = c.r + extra;
    S.fit = S.r;
    S.pads = pads.slice();
  }
  return S;
}

/**
 * Signed distance into the body of a shape: positive inside, in tiles. A convex body is swept
 * `back` tiles backward from its widest row (v = 0 in its frame): a point up to that far behind the
 * row is measured as if it were on it. back = Infinity gives the body and all the land behind it.
 */
function bodySdf(S, x, z, back = S.back || 0) {
  const dx = x - S.x, dz = z - S.z;
  const u = dx * S.cos - dz * S.sin;
  let v = dx * S.sin + dz * S.cos;
  if (v < 0 && back && S.style !== 'lobed') v = Math.min(0, v + back);
  if (S.style === 'oval') {
    const q = Math.hypot(u / S.a, v / S.b);
    const d = q < 1e-6 ? Math.min(S.a, S.b) : (1 - q) * q / Math.hypot(u / (S.a * S.a), v / (S.b * S.b));   // first-order distance to the ellipse
    return S.clip == null ? d : Math.min(d, S.clip - v);                         // cut flat at the front
  }
  if (S.style === 'rect') {
    const cx = (S.x0 + S.x1) / 2, cz = (S.z0 + S.z1) / 2, hx = (S.x1 - S.x0) / 2, hz = (S.z1 - S.z0) / 2;
    const px = Math.abs(u - cx) - (hx - RC), pz = Math.abs(v - cz) - (hz - RC);
    return -(Math.hypot(Math.max(px, 0), Math.max(pz, 0)) + Math.min(Math.max(px, pz), 0) - RC);
  }
  if (S.style === 'poly') {
    // a regular polygon stretched by (sx, sz); the distance is scaled back by the smaller stretch
    const pu = u / S.sx, pv = v / S.sz;
    let m = -Infinity;
    for (const [nu, nv] of S.normals) m = Math.max(m, pu * nu + pv * nv);
    return (S.A - m) * Math.min(S.sx, S.sz);
  }
  let best = S.r - Math.hypot(dx, dz);
  for (const p of S.pads) best = Math.max(best, p.r - Math.hypot(x - p.x, z - p.z));
  return best;
}

/** Signed distance into the whole platform: body, annex pads and ways. */
function shapeSdf(S, x, z) {
  let best = bodySdf(S, x, z);
  for (const p of S.annexPads) best = Math.max(best, p.r - Math.hypot(x - p.x, z - p.z));
  for (const w of S.ways) best = Math.max(best, w.half - segDist(x, z, w.a, w.b));
  return best;
}

/** Distance from (ox, oz), inside the shape, to its edge along (ux, uz), by bisection. */
function edgeFrom(S, ox, oz, ux, uz, max = 80) {
  let lo = 0, hi = max;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (shapeSdf(S, ox + ux * mid, oz + uz * mid) >= 0) lo = mid; else hi = mid;
  }
  return lo;
}
/** Distance from the shape's centre to its edge along (ux, uz). */
const edgeAlong = (S, ux, uz, max = 80) => edgeFrom(S, S.x, S.z, ux, uz, max);

/** The point floor k's stair heads for: the crystal for floor 1, the floor below's centre above that. */
const targetOf = (stack, k) => k === 1 ? crystalAt() : stack[k - 1];

/**
 * The stack and its shapes, fixed once per base. `obstacles` are the structures standing when it
 * is first worked out (an older save already has buildings north of the crystal); a floor avoids
 * covering them where it can, and the search takes the spot with the fewest covered if it cannot.
 */
function stackFloors(base, obstacles) {
  const rnd = mulberry32(hashStr('floors', base.seed));
  const style = pickStyle(rnd);
  const side = rnd() < 0.5 ? 1 : -1;
  const stack = [null];
  const crystal = crystalAt();
  for (let k = 1; k <= MAX_FLOOR; k++) {
    const r = CORE_R[k];
    const params = rollShape(rnd, style === 'mixed' ? pickStyle(rnd, false) : style, r);
    const prev = k === 1 ? null : stack[k - 1], prevShape = prev && grow(prev);
    const from = k === 1 ? crystal : prev;
    // A zigzag up the hill: floor 1 north of the crystal, then each floor to one side of the last,
    // alternating, so no floor sits on the back of the one below and every floor keeps its back
    // and one side to grow into. ZIG[k] is the bearing from the floor below, x this base's side.
    const spread = k === 1 ? 0.5 : 0.4;                                        // radians either side of that
    const lean = (k === 1 ? (rnd() - 0.5) * 0.5 : ZIG[k] * side) + (rnd() - 0.5) * 0.2;
    let best = null;
    for (let dd = 0; dd <= (k === 1 ? 10 : 2.5); dd += 0.5) {
      for (let i = 0; i <= 16; i++) {
        const theta = lean + (i / 16 - 0.5) * 2 * spread;
        const ux = Math.sin(theta), uz = -Math.cos(theta);
        // the floor faces back along this line, and its front is r from its centre: reach the
        // crystal plaza's edge plus a stair, or OVERLAP into the floor below
        const rot = Math.atan2(-ux, -uz);
        const d0 = (k === 1 ? CRYSTAL_R + STAIR_LEN - 0.4 : edgeAlong(prevShape, ux, uz) - OVERLAP) + r;
        const x = from.x + ux * (d0 + dd), z = from.z + uz * (d0 + dd);
        const S = grow({ x, z, r, rot, ...params }, [], extraAt(k, MAX_FLOOR));
        let hits = 0;
        for (const o of obstacles) if (bodySdf(S, o.x, o.z) > -(o.r + 1.0)) hits++;
        if (bodySdf(S, 0, 0) > -(SQUARE_R + 2)) hits += 50;
        if (bodySdf(S, crystal.x, crystal.z) > -(CRYSTAL_R + (k === 1 ? STAIR_LEN - 0.6 : 1.5))) hits += 50;
        for (let j = 1; j < k; j++) if (bodySdf(S, stack[j].x, stack[j].z) > -(PLAZA_R + 1.0)) hits += 50;
        for (let j = 1; j < k; j++) {                                         // the stairs below stay open
          const a = stack[j], b = targetOf(stack, j);
          for (let t = 0; t <= 1; t += 0.25) if (bodySdf(S, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t) > -(STAIR_W / 2 + 0.6)) { hits += 50; break; }
        }
        const score = hits * 1000 + dd * 2 + Math.abs(theta - lean) * 3 + rnd();
        if (!best || score < best.score) best = { x, z, rot, score };
      }
    }
    stack.push({ x: +best.x.toFixed(3), z: +best.z.toFixed(3), r, rot: +best.rot.toFixed(4), ...params });
  }
  return stack;
}

// ---------- placement ----------

/**
 * Everything placement needs to know about the floors: the stack, the corridors, and each
 * floor's shape as it stands (open floors grow as buildings are placed; closed floors are their
 * unexpanded shape). `body[k]` and `annex[k]` are the pads on floor k; `lines[k]` the straight
 * stand-ins for annex ways until the roads exist.
 */
function placeContext(stack, top) {
  const ctx = { stack, top, body: [], annex: [], lines: [], shapes: [], reserve: [], corridors: [] };
  for (let k = 1; k <= MAX_FLOOR; k++) {
    ctx.body[k] = []; ctx.annex[k] = []; ctx.lines[k] = [];
    ctx.corridors.push({ k, a: stack[k], b: targetOf(stack, k) });
  }
  // shapes[k]: floor k as it stands now; reserve[k]: as it will stand with every floor open,
  // which is what everything below it keeps clear of
  ctx.rebuild = (k) => {
    for (const [list, extra] of [[ctx.shapes, extraAt(k, top)], [ctx.reserve, extraAt(k, MAX_FLOOR)]]) {
      const S = grow(stack[k], ctx.body[k], extra);
      S.annexPads = ctx.annex[k].slice();
      S.ways = ctx.lines[k].slice();
      list[k] = S;
    }
  };
  for (let k = 1; k <= MAX_FLOOR; k++) ctx.rebuild(k);
  ctx.add = (o) => {
    if (!o.floor) return;
    const pad = { x: o.x, z: o.z, r: o.r + PAD };
    const lobed = (stack[o.floor].style || 'lobed') === 'lobed';
    if (lobed || o.annex) {
      (lobed ? ctx.body : ctx.annex)[o.floor].push(pad);
      ctx.lines[o.floor].push({ a: { x: o.x, z: o.z }, b: { x: stack[o.floor].x, z: stack[o.floor].z }, half: 1.3 });
    } else ctx.body[o.floor].push(pad);
    ctx.rebuild(o.floor);
  };
  return ctx;
}

/** Would the grown body G of floor f leave everything below it uncovered? */
function clearBelow(G, f, standing, ctx) {
  const { stack } = ctx;
  for (const o of standing) if (o.floor < f && bodySdf(G, o.x, o.z) > -(o.r + 1.4)) return false;
  for (let j = 1; j < f; j++) if (bodySdf(G, stack[j].x, stack[j].z) > -(PLAZA_R + 1.0)) return false;
  for (const cor of ctx.corridors) {
    if (cor.k > f) continue;
    if (cor.k === f) {                                   // this floor's own stair needs its landing
      const room = f === 1 ? CRYSTAL_R + STAIR_LEN - 0.6 : PLAZA_R + 1.0;
      if (bodySdf(G, cor.b.x, cor.b.z) > -room) return false;
      continue;
    }
    for (let t = 0; t <= 1; t += 0.2) {
      if (bodySdf(G, cor.a.x + (cor.b.x - cor.a.x) * t, cor.a.z + (cor.b.z - cor.a.z) * t) > -(STAIR_W / 2 + 0.6)) return false;
    }
  }
  // the raised ways of annexes below: covering one would cut its building off from its plaza
  for (let j = 1; j < f; j++) for (const w of ctx.lines[j]) {
    for (let t = 0; t <= 1; t += 0.2) if (bodySdf(G, w.a.x + (w.b.x - w.a.x) * t, w.a.z + (w.b.z - w.a.z) * t) > -(w.half + 0.6)) return false;
  }
  if (bodySdf(G, 0, 0) > -(SQUARE_R + 1.5)) return false;
  const c = crystalAt();
  if (f !== 1 && bodySdf(G, c.x, c.z) > -(CRYSTAL_R + 1.5)) return false;
  return true;
}

/** The causeway rules for a building on a pad of its own, joined to the plaza by a way. */
function wayClear(x, z, r, f, standing, ctx) {
  const { stack } = ctx;
  const S = ctx.shapes[f], c = stack[f], d = Math.hypot(x - c.x, z - c.z);
  const edge = edgeFrom(S, c.x, c.z, (x - c.x) / (d || 1), (z - c.z) / (d || 1));
  if (d - r - edge > WAY_MAX) return false;
  if (d <= edge + r) return true;
  const ux = (c.x - x) / d, uz = (c.z - z) / d;
  const a = { x: x + ux * r, z: z + uz * r }, b = { x: c.x - ux * (edge - 0.5), z: c.z - uz * (edge - 0.5) };
  for (const o of standing) {
    // a way can run past a building on its own floor; one on another floor needs the cliff room
    if (segDist(o.x, o.z, a, b) < o.r + (o.floor === f ? 0.4 : WAY_CLEAR + CLIFF_GAP - 1)) return false;
  }
  for (let j = 1; j <= MAX_FLOOR; j++) {
    if (j === f) continue;
    const cj = stack[j];
    if (segDist(cj.x, cj.z, a, b) < (j > f ? cj.r : PLAZA_R) + WAY_CLEAR) return false;
  }
  for (const cor of ctx.corridors) if (cor.k !== f && segDist(cor.b.x, cor.b.z, a, b) < STAIR_W / 2 + WAY_CLEAR) return false;
  if (segDist(0, 0, a, b) < SQUARE_R + WAY_CLEAR) return false;
  if (segDist(crystalAt().x, crystalAt().z, a, b) < CRYSTAL_R + WAY_CLEAR) return false;
  return true;
}

/**
 * Can a structure of radius r stand at (x, z) on floor f, and how? Returns null, 'body' (inside a
 * convex floor's grown body, or anywhere on the ground), or 'annex' (its own pad and way).
 * `level` relaxes the rules for the fallback passes in place():
 *   0 strict: the body on convex floors, the way rules on lobed ones
 *   1 the body again, with empty floors above reserving only RESERVE and RELAX more size allowed
 *   2 an annex with the way rules (convex floors)
 *   3 an annex without them
 *   4 only overlap with standing structures and the square
 */
const RELAX = 8;
function valid(x, z, r, f, standing, ctx, level = 0) {
  if (level >= 4) {
    if (Math.hypot(x, z) < SQUARE_R + r + GAP) return null;
    for (const o of standing) if (Math.hypot(x - o.x, z - o.z) < r + o.r + GAP) return null;
    return f && (ctx.stack[f].style || 'lobed') !== 'lobed' ? 'annex' : 'body';
  }
  const { stack } = ctx, crystal = crystalAt();
  if (Math.hypot(x, z) < SQUARE_R + r + (f ? PAD + 1 : GAP)) return null;
  if (Math.hypot(x - crystal.x, z - crystal.z) < CRYSTAL_R + r + (f ? PAD + 0.5 : GAP * 0.5)) return null;
  if (f === 0 && z > 0 && Math.abs(x) < r + ROAD_CLEAR) return null;            // the road out, south
  for (const o of standing) {
    if (Math.hypot(x - o.x, z - o.z) < r + o.r + GAP + (o.floor !== f ? CLIFF_GAP : 0)) return null;
  }
  for (let j = 1; j <= MAX_FLOOR; j++) {
    if (j === f) { if (Math.hypot(x - stack[j].x, z - stack[j].z) < PLAZA_R + r + 0.8) return null; continue; }
    if (j > f) {                                       // under floor j, or in the way of its growing
      const empty = !ctx.body[j].length && !ctx.annex[j].length;
      // an empty floor's own growth (extraAt) already counts toward the room its first buildings need
      const margin = empty && level === 0 ? Math.max(RESERVE, RESERVE_EMPTY - extraAt(j, MAX_FLOOR)) : RESERVE;
      if (shapeSdf(ctx.reserve[j], x, z) > -(r + margin)) return null;
      // nor behind it, where its buildings take it; the ground keeps ZONE from all of that
      if (bodySdf(ctx.reserve[j], x, z, Infinity) > -(r + (f ? margin : ZONE))) return null;
    }
    else if (Math.hypot(x - stack[j].x, z - stack[j].z) < PLAZA_R + r + PAD + 0.5) return null;   // would bury floor j's plaza
  }
  for (const cor of ctx.corridors) if (segDist(x, z, cor.a, cor.b) < r + STAIR_W / 2 + (f ? PAD : 0.8)) return null;
  if (f === 0) return 'body';
  const convex = (stack[f].style || 'lobed') !== 'lobed';
  if (convex && level <= 1) {
    const pads = [...ctx.body[f], { x, z, r: r + PAD }];
    const G = grow(stack[f], pads, extraAt(f, ctx.top)), F = grow(stack[f], pads, extraAt(f, MAX_FLOOR));
    if (F.fit > SHAPE_MAX + (level ? RELAX : 0)) return null;   // the cap is on what the buildings need
    ctx.grown = G.fit;                             // place() scores a body spot by what it costs the shape
    return clearBelow(G, f, standing, ctx) && clearBelow(F, f, standing, ctx) ? 'body' : null;
  }
  if (!convex && (level === 1 || level === 2)) return null;   // lobed floors go straight from strict to relaxed
  if (level <= 2 && !wayClear(x, z, r, f, standing, ctx)) return null;
  return convex ? 'annex' : 'body';
}

function penalty(kind, bearing) {
  const c = Math.cos(bearing);                    // 1 north, -1 south
  if (kind === 'work') return Math.max(0, c) * WORK_NORTH;
  if (kind === 'bed') return Math.abs(c) * BED_SIDE;
  return 0;
}

/**
 * Find a spot for one structure on its floor. Returns { x, z, rot, floor, r, annex }. On a convex
 * floor's body the score is what the spot costs the shape (its largest half-extent once grown, x
 * GROW_COST) plus a little distance, so buildings fill the room the shape already has and then
 * extend it along its long side; everywhere else it is ring distance plus the floor-0 penalty.
 */
const GROW_COST = 2;
function place(seed, s, standing, ctx) {
  const rnd = mulberry32(hashStr(s.key + (s.floor ? '@' + s.floor : ''), seed));
  const r = radiusOf(s), f = s.floor || 0;
  const centre = f ? ctx.stack[f] : { x: 0, z: 0 };
  const start = f ? PLAZA_R + r + 0.8 : SQUARE_R + r + GAP;
  const convex = f > 0 && (ctx.stack[f].style || 'lobed') !== 'lobed';
  const phase = rnd() * Math.PI * 2;
  let best = null;
  // strict first; if a crowded floor has no legal spot, an annex, then relaxed rules, then
  // everything but overlap, so a building is never left without a place
  for (let level = 0; level <= 4 && !best; level++) {
    let firstRing = null;
    const rings = convex && level <= 1 ? SEARCH * 4 : SEARCH;
    for (let d = start; d < start + 200; d += RING_STEP) {
      if (firstRing !== null && d > firstRing + rings * RING_STEP) break;
      for (let k = 0; k < ANGLES; k++) {
        const bearing = phase + (k + rnd() * 0.8) * (Math.PI * 2 / ANGLES);
        const x = centre.x + Math.sin(bearing) * d, z = centre.z - Math.cos(bearing) * d;
        ctx.grown = 0;
        const how = valid(x, z, r, f, standing, ctx, level);
        if (!how) continue;
        if (firstRing === null) firstRing = d;
        const score = convex && how === 'body'
          ? ctx.grown * GROW_COST + d * 0.25 + rnd() * 0.5
          : d + (f ? 0 : penalty(s.kind, bearing)) + rnd() * JITTER;
        if (!best || score < best.score) best = { x, z, score, annex: how === 'annex' };
      }
    }
  }
  // the door (local +z) faces the centre of its floor (the square, or the floor's plaza)
  const rot = Math.atan2(centre.x - best.x, centre.z - best.z) + (rnd() - 0.5) * 0.4;
  const out = { x: +best.x.toFixed(3), z: +best.z.toFixed(3), rot: +rot.toFixed(4), floor: f, r: +r.toFixed(3) };
  if (best.annex) out.annex = true;
  return out;
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
 * entry is { key, kind, floor, w, h } plus optional reserve size { rw, rh } (the footprint the
 * spot is chosen for, so a workshop has room to grow into its later tiers) and anything else the
 * caller wants carried through. `top` is the highest open floor.
 */
function layout(state, list, { top = 0 } = {}) {
  const base = ensure(state);
  top = Math.max(0, Math.min(MAX_FLOOR, top));
  const keys = new Set(list.map(s => s.key));
  for (const k of Object.keys(base.placed)) if (!keys.has(k)) delete base.placed[k];

  // a structure keeps its spot only while it is still meant for the same floor
  const floorOf = (s) => Math.min(top, s.floor || 0);
  const standing = [];
  for (const s of list) {
    const p = base.placed[s.key];
    const moved = p && ((p.floor || 0) !== floorOf(s) || (p.r != null && radiusOf(s) > p.r + 0.01));
    if (moved) delete base.placed[s.key];
    else if (p) standing.push({ key: s.key, x: p.x, z: p.z, r: radiusOf(s), floor: p.floor || 0, annex: !!p.annex });
  }
  if (!base.stack) base.stack = stackFloors(base, standing);
  const stack = base.stack;
  // A save laid out under older rules (before floors existed, or before they grew backward) can have
  // a building where a higher open floor now stands (stackFloors avoids them where it can). That
  // building is placed again on its own floor.
  for (let i = standing.length - 1; i >= 0; i--) {
    const o = standing[i];
    for (let k = o.floor + 1; k <= top; k++) {
      if (bodySdf(grow(stack[k], [], extraAt(k, top)), o.x, o.z) > -(o.r + 0.8)) { delete base.placed[o.key]; standing.splice(i, 1); break; }
    }
  }
  const ctx = placeContext(stack, top);
  for (const o of standing) ctx.add(o);

  const structures = [];
  for (const s of list) {
    const f = floorOf(s);
    let p = base.placed[s.key];
    if (!p) {
      p = base.placed[s.key] = place(base.seed, { ...s, floor: f }, standing, ctx);
      const o = { key: s.key, x: p.x, z: p.z, r: radiusOf(s), floor: f, annex: !!p.annex };
      standing.push(o);
      ctx.add(o);
    }
    const st = { ...s, floor: f, x: p.x, z: p.z, rot: p.rot, r: radiusOf(s), annex: !!p.annex };
    st.door = toWorld(st, 0, s.h / 2);
    st.step = toWorld(st, 0, s.h / 2 + 0.9);            // just outside the door
    structures.push(st);
  }

  let extent = Math.max(MIN_EXTENT, ...structures.map(s => Math.hypot(s.x, s.z) + s.r + 3));
  const rnd = mulberry32(hashStr('roads', base.seed));

  // a road from every door to the centre of its floor, bent once to one side
  const roads = structures.map(s => {
    const c = s.floor ? stack[s.floor] : { x: 0, z: 0 };
    const rim = s.floor ? PLAZA_R - 0.4 : SQUARE_R - 0.5;
    const a = s.step, dx = a.x - c.x, dz = a.z - c.z, len = Math.hypot(dx, dz) || 1;
    const end = { x: c.x + dx / len * rim, z: c.z + dz / len * rim };
    const bend = (rnd() - 0.5) * (s.floor ? 1.2 : 2.4);
    const mid = { x: (a.x + end.x) / 2 - (dz / len) * bend, z: (a.z + end.z) / 2 + (dx / len) * bend };
    return { key: s.key, floor: s.floor, raised: s.floor > 0 && (s.annex || (stack[s.floor].style || 'lobed') === 'lobed'),
      width: s.kind === 'work' ? 1.5 : 1.1, pts: [[s.door.x, s.door.z], [a.x, a.z], [mid.x, mid.z], [end.x, end.z]] };
  });

  // the open floors: the body grown round its buildings, annex pads, and the raised roads
  const floors = [null];
  for (let k = 1; k <= top; k++) {
    const on = structures.filter(s => s.floor === k);
    const lobed = (stack[k].style || 'lobed') === 'lobed';
    const S = grow(stack[k], on.filter(s => lobed || !s.annex).map(s => ({ x: s.x, z: s.z, r: s.r + PAD })), extraAt(k, top));
    S.annexPads = lobed ? [] : on.filter(s => s.annex).map(s => ({ x: s.x, z: s.z, r: s.r + PAD }));
    S.ways = roads.filter(r => r.floor === k && r.raised).flatMap(r => r.pts.slice(1).map((p, i) => ({
      a: { x: r.pts[i][0], z: r.pts[i][1] }, b: { x: p[0], z: p[1] }, half: r.width / 2 + WAY_MARGIN,
    })));
    // the box the platform fits in, from its edge on 72 rays plus its annexes
    const box = { x0: S.x, x1: S.x, z0: S.z, z1: S.z };
    const take = (x, z, r = 0) => { box.x0 = Math.min(box.x0, x - r); box.x1 = Math.max(box.x1, x + r); box.z0 = Math.min(box.z0, z - r); box.z1 = Math.max(box.z1, z + r); };
    for (let i = 0; i < 72; i++) { const t = i / 72 * Math.PI * 2, e = edgeAlong(S, Math.cos(t), Math.sin(t)); take(S.x + Math.cos(t) * e, S.z + Math.sin(t) * e); }
    for (const p of S.annexPads) take(p.x, p.z, p.r);
    for (const w of S.ways) { take(w.a.x, w.a.z, w.half); take(w.b.x, w.b.z, w.half); }
    floors.push({ k, elev: FLOOR_H * k, style: S.style, core: { x: stack[k].x, z: stack[k].z, r: stack[k].r }, shape: S, box });
    extent = Math.max(extent, Math.hypot(box.x0, box.z0) + 3, Math.hypot(box.x1, box.z0) + 3, Math.hypot(box.x0, box.z1) + 3, Math.hypot(box.x1, box.z1) + 3);
  }

  // the stairs: from each open floor's edge along its corridor, STAIR_LEN down
  const stairs = [];
  for (let k = 1; k <= top; k++) {
    const c = stack[k], b = targetOf(stack, k), len = Math.hypot(b.x - c.x, b.z - c.z) || 1;
    const ux = (b.x - c.x) / len, uz = (b.z - c.z) / len, e = edgeFrom(floors[k].shape, c.x, c.z, ux, uz, len);
    const a = { x: c.x + ux * (e - 0.4), z: c.z + uz * (e - 0.4) };
    stairs.push({ k, a, b: { x: a.x + ux * STAIR_LEN, z: a.z + uz * STAIR_LEN }, w: STAIR_W });
  }
  // each stair: its top to its own plaza
  for (const st of stairs) {
    const c = stack[st.k];
    roads.push({ key: 'stair:' + st.k, floor: st.k, width: STAIR_W, pts: [[st.a.x, st.a.z], [c.x, c.z]] });
  }

  // the island: what has to be on it, ISLAND_M round the ground's things and TERRACE_M round the
  // platforms (structures on them are inside them already)
  const crystal = crystalAt();
  const need = [[0, 0, SQUARE_R + ISLAND_M], [crystal.x, crystal.z, CRYSTAL_R + ISLAND_M], [0, MIN_EXTENT * 0.6, ISLAND_M]];
  for (const s of structures) need.push([s.x, s.z, s.r + (s.floor ? TERRACE_M : ISLAND_M)]);
  for (let k = 1; k <= top; k++) {
    const S = floors[k].shape;
    for (let i = 0; i < 72; i++) { const t = i / 72 * Math.PI * 2, e = edgeAlong(S, Math.cos(t), Math.sin(t)); need.push([S.x + Math.cos(t) * e, S.z + Math.sin(t) * e, TERRACE_M]); }
    for (const p of S.annexPads) need.push([p.x, p.z, p.r + TERRACE_M]);
    for (const w of S.ways) for (let t = 0; t <= 1; t += 0.25) need.push([w.a.x + (w.b.x - w.a.x) * t, w.a.z + (w.b.z - w.a.z) * t, w.half + TERRACE_M]);
  }
  const irnd = mulberry32(hashStr('island', base.seed));
  const island = islandRound(need, irnd);
  const lay0 = { island };
  // walk out from a point to the rim
  const rimFrom = (ox, oz, ux, uz) => {
    let lo = 0, hi = 4 * (island.hx + island.hz);
    for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (islandSdf(lay0, ox + ux * m, oz + uz * m) >= 0) lo = m; else hi = m; }
    return lo;
  };

  // the road out: south from the square to the gate, a portal just inside the rim
  const ga = (rnd() - 0.5) * 0.3, gux = Math.sin(ga), guz = Math.cos(ga);
  const reach = rimFrom(0, 0, gux, guz) - 2.2;
  const gate = { x: gux * reach, z: guz * reach, ux: gux, uz: guz };
  roads.push({
    key: 'out', floor: 0, width: 2.4,
    pts: [[0, SQUARE_R - 0.5], [gate.x * 0.4 + (rnd() - 0.5) * 2, gate.z * 0.4], [gate.x * 0.75 + (rnd() - 0.5) * 3, gate.z * 0.75], [gate.x, gate.z]],
  });
  // a short path from the square up to the crystal
  roads.push({ key: 'crystal', floor: 0, width: 2.0, pts: [[0, -SQUARE_R + 0.5], [crystal.x, crystal.z + CRYSTAL_R - 0.5]] });

  // the pond: open ground near the rim, as far as it can be from anything built, spilling over the
  // rim as a waterfall
  let pond = null, fall = null;
  {
    const segs = [];
    for (const r of roads) for (let i = 0; i + 1 < r.pts.length; i++) segs.push([{ x: r.pts[i][0], z: r.pts[i][1] }, { x: r.pts[i + 1][0], z: r.pts[i + 1][1] }, r.width / 2]);
    const lay1 = { island, floors, top, stairs };
    let best = null;
    const phase = irnd() * 6.283;
    for (let i = 0; i < 72; i++) {
      const t = phase + i / 72 * 6.283, ux = Math.cos(t), uz = Math.sin(t);
      const e = rimFrom(island.cx, island.cz, ux, uz);
      const rx = island.cx + ux * e, rz = island.cz + uz * e;
      const px = rx - ux * (POND_R + 2.2), pz = rz - uz * (POND_R + 2.2);
      let clear = Infinity;
      for (const s of structures) clear = Math.min(clear, Math.hypot(px - s.x, pz - s.z) - s.r - POND_R);
      for (const [a, b, half] of segs) clear = Math.min(clear, segDist(px, pz, a, b) - half - POND_R);
      for (let k = 1; k <= top; k++) clear = Math.min(clear, -floorSdf(lay1, k, px, pz) - POND_R);
      clear = Math.min(clear, Math.hypot(px - gate.x, pz - gate.z) - 6, Math.hypot(px, pz) - SQUARE_R - 4, Math.hypot(px - crystal.x, pz - crystal.z) - CRYSTAL_R - 4);
      if (clear >= 2 && (!best || clear > best.clear)) best = { clear, px, pz, rx, rz, ux, uz };
    }
    if (best) {
      pond = { x: best.px, z: best.pz, r: POND_R };
      fall = { x: best.rx, z: best.rz, ux: best.ux, uz: best.uz };
    }
  }

  // the box the town is drawn and walked in: the island's
  const bounds = { ...island.box };
  extent =Math.max(extent, Math.hypot(bounds.x0, bounds.z0), Math.hypot(bounds.x1, bounds.z0), Math.hypot(bounds.x0, bounds.z1), Math.hypot(bounds.x1, bounds.z1));

  return {
    seed: base.seed, top, style: stack[1] ? (new Set(stack.slice(1).map(c => c.style || 'lobed')).size > 1 ? 'mixed' : (stack[1].style || 'lobed')) : 'lobed',
    square: { x: 0, z: 0, r: SQUARE_R }, crystal: { ...crystal, r: CRYSTAL_R },
    gate, extent, bounds, island, pond, fall, structures, roads, floors, stairs,
    plazas: floors.filter(Boolean).map(F => ({ k: F.k, x: F.core.x, z: F.core.z, r: PLAZA_R })),
  };
}

// ---------- the ground the layout implies ----------

/** Signed distance into floor k's platform: positive inside, in tiles. -Infinity for a closed floor. */
function floorSdf(lay, k, x, z) {
  const F = lay.floors[k];
  return F ? shapeSdf(F.shape, x, z) : -Infinity;
}

/** The stair whose corridor (x, z) is in, with how far down it is (0 top .. 1 bottom), or null. */
function onStair(lay, x, z, slack = 0) {
  for (const st of lay.stairs) {
    const dx = st.b.x - st.a.x, dz = st.b.z - st.a.z, l2 = dx * dx + dz * dz;
    const t = ((x - st.a.x) * dx + (z - st.a.z) * dz) / l2;
    if (t < -0.05 || t > 1.05) continue;
    const lat = Math.abs((x - st.a.x) * dz - (z - st.a.z) * dx) / Math.sqrt(l2);
    if (lat <= st.w / 2 + slack) return { st, t: Math.max(0, Math.min(1, t)) };
  }
  return null;
}

/**
 * The island round `need` (discs [x, z, r] that have to be on it): its centre (the middle of their
 * box), its rim's distance from there on each of ISLE_N bearings (bearing i at 2 pi i / ISLE_N, from
 * +x toward +z), and the box the rim fits in. Uses three numbers from `rnd` for the wobble.
 */
function islandRound(need, rnd) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z, r] of need) { x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r); z0 = Math.min(z0, z - r); z1 = Math.max(z1, z + r); }
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, step = 2 * Math.PI / ISLE_N;
  const at = (a, i) => a[((i % ISLE_N) + ISLE_N) % ISLE_N];
  // the far side of every disc, on every bearing that passes through it
  const reach = new Array(ISLE_N).fill(0);
  for (const [x, z, r] of need) {
    const dx = x - cx, dz = z - cz, rho = Math.hypot(dx, dz), phi = Math.atan2(dz, dx);
    const span = rho <= r ? Math.PI : Math.asin(r / rho);
    for (let i = Math.ceil((phi - span) / step); i <= Math.floor((phi + span) / step); i++) {
      const d = i * step - phi, s = rho * Math.sin(d);
      if (Math.abs(s) > r) continue;
      const b = ((i % ISLE_N) + ISLE_N) % ISLE_N;
      reach[b] = Math.max(reach[b], rho * Math.cos(d) + Math.sqrt(r * r - s * s));
    }
  }
  // a dip between two parts of the town is filled across: each bearing reaches at least as far as
  // the nearer of any two bearings up to ISLE_FILL either side of it
  const filled = reach.map((r0, i) => {
    let r = r0;
    for (let j = 1; j <= ISLE_FILL; j++) r = Math.max(r, Math.min(at(reach, i - j), at(reach, i + j)));
    return r;
  });
  // widened over ISLE_SMOOTH bearings each side, then averaged over as many, so no bearing comes in
  const wide = filled.map((_, i) => { let r = 0; for (let j = -ISLE_SMOOTH; j <= ISLE_SMOOTH; j++) r = Math.max(r, at(filled, i + j)); return r; });
  const waves = [[3, rnd() * 6.283, 0.5], [5, rnd() * 6.283, 0.3], [9, rnd() * 6.283, 0.2]];
  const rim = wide.map((_, i) => {
    let s = 0, w = 0;
    for (let j = -ISLE_SMOOTH; j <= ISLE_SMOOTH; j++) s += at(wide, i + j);
    for (const [n, ph, a] of waves) w += Math.sin(n * i * step + ph) * a;      // in [-1, 1]
    return +(s / (2 * ISLE_SMOOTH + 1) + ISLAND_WOBBLE * (1 + w) / 2).toFixed(3);
  });
  const box = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
  rim.forEach((r, i) => {
    const x = cx + Math.cos(i * step) * r, z = cz + Math.sin(i * step) * r;
    box.x0 = Math.min(box.x0, x - 1); box.x1 = Math.max(box.x1, x + 1); box.z0 = Math.min(box.z0, z - 1); box.z1 = Math.max(box.z1, z + 1);
  });
  return { cx, cz, rim, box, hx: Math.max(box.x1 - cx, cx - box.x0), hz: Math.max(box.z1 - cz, cz - box.z0) };
}

/**
 * Signed distance into the island: positive on it, in tiles, measured along the bearing from its
 * centre (so only roughly the nearest distance where the rim runs slantwise).
 */
function islandSdf(lay, x, z) {
  const I = lay.island;
  if (!I) return Infinity;
  const dx = x - I.cx, dz = z - I.cz, N = I.rim.length;
  const f = (Math.atan2(dz, dx) / (2 * Math.PI) * N + N) % N, i = Math.floor(f), w = f - i;
  return I.rim[i] * (1 - w) + I.rim[(i + 1) % N] * w - Math.hypot(dx, dz);
}

/** Which floor (x, z) is on: the highest platform it is inside. */
function floorAt(lay, x, z) {
  for (let k = lay.top; k >= 1; k--) if (floorSdf(lay, k, x, z) >= 0) return k;
  return 0;
}

/** Ground height at (x, z): platforms with a CLIFF-wide edge, and the stairs as ramps between them. */
function heightAt(lay, x, z) {
  const s = onStair(lay, x, z);
  if (s) return FLOOR_H * (s.st.k - s.t);
  let h = 0;
  for (let k = 1; k <= lay.top; k++) h = Math.max(h, FLOOR_H * k * sstep(-CLIFF, CLIFF, floorSdf(lay, k, x, z)));
  return h;
}

const BaseLayoutAPI = {
  SQUARE_R, CRYSTAL_D, CRYSTAL_R, MAX_FLOOR, FLOOR_H, CORE_R, STAIR_LEN, STAIR_W, PAD, PLAZA_R, CLIFF, STYLES,
  ensure, layout, toWorld, toLocal, radiusOf, mulberry32, hashStr, segDist,
  grow, extraAt, bodySdf, shapeSdf, edgeAlong, edgeFrom, floorSdf, floorAt, onStair, heightAt, islandSdf, GROW_PER_FLOOR, ZONE, TERRACE_M,
};
if (typeof module !== 'undefined') module.exports = BaseLayoutAPI;
if (typeof window !== 'undefined') window.BaseLayout = BaseLayoutAPI;
})();
