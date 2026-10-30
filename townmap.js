// The town, as ground you can walk on. Browser: window.TownMap. Node: module.exports.
//
// Turns the town's buildings into a PLACE, so "Kess is at the smithy" is somewhere she can be
// rather than a row in a table.
//
// Where things stand comes from baselayout.js: a procedural layout seeded per save, with the
// square at the centre, the crystal north of it, workshops round the east, south and west,
// homes round the crystal, and one road out south to the gate. Placements are stored in
// state.base, so a new building never moves an old one. This file rasterises that layout onto a
// mapgen.js grid (tile = layout position + (map.ox, map.oz)) so the distance fields and the pathing in
// townlife.js work on it as they do on a mission map, and keeps the layout on map.layout for the
// 3D view.
//
// Raster rules: a finished building is a ring of WALL tiles round FLOOR, with one DOOR on its
// square-facing side. A construction site is open FLOOR, so builders can stand anywhere on it.
// Roads are ROAD. The crystal, the fountain and the pond are WALL, and so is everything within
// RIM tiles of the island's edge and beyond it: nobody walks off the island. Everything else is FLOOR.
// The map is rebuilt only when `signature` changes.

(() => {
const MG = (typeof Mapgen !== 'undefined') ? Mapgen : require('./mapgen.js');
const E = () => (typeof Econ !== 'undefined') ? Econ : require('./economy.js');
const LO = () => (typeof Lodging !== 'undefined') ? Lodging : (typeof require !== 'undefined' ? require('./lodging.js') : null);
const FL = () => (typeof Floors !== 'undefined') ? Floors : require('./floors.js');
const T = MG.T;

const BL = () => (typeof BaseLayout !== 'undefined') ? BaseLayout : require('./baselayout.js');
const SQUARE_R = 5;
const FOUNTAIN_R = 1.6;    // tiles round the square's centre nobody stands on
const EDGE = 2;            // tiles past the island's box (lay.bounds), all of it beyond the rim
const RIM = 0.8;           // tiles inside the island's edge that are still wall

// Footprints. A building's plot grows with its tier, which is the only way the town ever looks
// bigger: an Abyssal Mine is a hole you can see from the road and a Quarry is a scrape.
const workSize = (tier) => ({ w: 5 + tier, h: 4 + Math.floor(tier / 2) });
// Lodgings are sized by what they are rather than by a tier, because they are not a ladder.
const BED_SIZE = {
  tent:      { w: 3, h: 3 },
  bunkhouse: { w: 6, h: 4 },
  longhouse: { w: 6, h: 4 },
  barracks:  { w: 7, h: 5 },
  cottages:  { w: 6, h: 4 },
  manor:     { w: 8, h: 6 },
  sanctum:   { w: 5, h: 5 },
  // taverns
  alehouse:  { w: 5, h: 4 },
  inn:       { w: 6, h: 5 },
  salon:     { w: 6, h: 5 },
  crownhall: { w: 7, h: 6 },
};

/**
 * Everything the layout depends on. The map is rebuilt when and only when this string changes,
 * so raising a building moves the town and an ordinary tick does not.
 */
function signature(state) {
  const lo = LO();
  const beds = lo ? lo.ensure(state).map(b => b.type + b.id + (b.site ? '~' : '')).sort().join(',') : '';
  return [state.base ? state.base.seed : 0, state.town, Object.entries(state.buildings).map(([k, v]) => k + v).sort().join(','), beds].join('|');
}

/** Every workshop, in a fixed order (the order they are first placed in on a new save). */
function workPlots(state) {
  const econ = E();
  const ORDER = ['farm', 'mine', 'garden', 'kitchen', 'smithy', 'lab', 'training'];
  return ORDER.filter(k => econ.BUILDINGS[k]).map(k => {
    const def = econ.BUILDINGS[k];
    const tier = state.buildings[k] || 0;
    // the spot is chosen for a bigger footprint than the building has now, so it can grow in
    // place: every tier on the ground, where there is room, and one tier ahead on a platform
    const floor = def.floor || 0;
    const room = workSize(floor ? Math.min(tier + 1, def.tiers.length - 1) : def.tiers.length - 1);
    return { key: k, kind: 'work', floor, job: def.job || null, icon: def.icon, label: def.tiers[tier].name, tier, ...workSize(tier), rw: room.w, rh: room.h };
  });
}

/** Everywhere anybody sleeps or drinks, in the order it was built, then the altar. */
function bedPlots(state) {
  const lo = LO(), econ = E();
  const out = (lo ? lo.ensure(state) : []).map(b => {
    const def = econ.LODGINGS[b.type] || econ.LODGINGS.tent;
    // taverns live in the lodging yard too (economy.js LODGINGS tavern: true); their key keeps the
    // 'bed:' prefix so a builder's goal ('bed:' + site id) finds either
    return { key: 'bed:' + b.id, bedId: b.id, kind: def.tavern ? 'tavern' : 'bed', type: b.type, floor: b.floor || 0, site: !!b.site, icon: def.icon, label: def.label, ...(BED_SIZE[b.type] || BED_SIZE.tent) };
  });
  const altarTier = state.buildings.altar || 0;
  out.push({ key: 'altar', kind: 'altar', floor: econ.BUILDINGS.altar.floor || 0, icon: '⚱️', label: econ.BUILDINGS.altar.tiers[altarTier].name, w: 4, h: 4 });
  return out;
}

/**
 * Build the town. Returns a mapgen-shaped grid plus the plots on it, so field.js's distance
 * fields, fieldview's palette and anything else that reads a map all work unchanged.
 */
function build(state) {
  const lay = BL().layout(state, [...workPlots(state), ...bedPlots(state)], { top: FL().top(state) });
  // the grid covers the built-up box plus EDGE: tile (tx, ty) is layout (tx - OX, ty - OZ)
  const b = lay.bounds;
  const OX = Math.ceil(EDGE - b.x0), OZ = Math.ceil(EDGE - b.z0);
  const w = Math.ceil(b.x1 + EDGE) + OX + 1, h = Math.ceil(b.z1 + EDGE) + OZ + 1;
  const g = MG.grid(w, h, T.FLOOR);
  const tileOf = (x, z) => ({ x: Math.floor(x + OX), y: Math.floor(z + OZ) });
  const centreOf = (tx, ty) => ({ x: tx - OX + 0.5, z: ty - OZ + 0.5 });

  // roads: every tile whose centre is within half a road's width of the polyline
  const stamp = (pts, half) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      const len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(len * 4));
      for (let k = 0; k <= n; k++) {
        const x = ax + (bx - ax) * k / n, z = az + (bz - az) * k / n;
        for (let ty = Math.floor(z - half + OZ); ty <= Math.floor(z + half + OZ); ty++)
          for (let tx = Math.floor(x - half + OX); tx <= Math.floor(x + half + OX); tx++) {
            const c = centreOf(tx, ty);
            if (Math.hypot(c.x - x, c.z - z) <= half) g.set(tx, ty, T.ROAD);
          }
      }
    }
  };
  for (const r of lay.roads) stamp(r.pts, r.width / 2);

  const disc = (cx, cz, rad, code) => {
    for (let ty = Math.floor(cz - rad + OZ); ty <= Math.ceil(cz + rad + OZ); ty++)
      for (let tx = Math.floor(cx - rad + OX); tx <= Math.ceil(cx + rad + OX); tx++) {
        const c = centreOf(tx, ty);
        if (Math.hypot(c.x - cx, c.z - cz) <= rad) g.set(tx, ty, code);
      }
  };
  disc(0, 0, SQUARE_R, T.ROAD);
  disc(0, 0, FOUNTAIN_R, T.WALL);
  disc(lay.crystal.x, lay.crystal.z, 1.6, T.WALL);

  // floors: the upper edge of every platform is a wall, except where a stair crosses it; the
  // stairs themselves are road. Done after the roads, so a road never runs off a cliff.
  if (lay.top > 0) {
    const fl = new Int8Array(w * h);
    for (let ty = 0; ty < h; ty++) for (let tx = 0; tx < w; tx++) { const c = centreOf(tx, ty); fl[ty * w + tx] = BL().floorAt(lay, c.x, c.z); }
    const at = (tx, ty) => (tx < 0 || ty < 0 || tx >= w || ty >= h) ? 0 : fl[ty * w + tx];
    for (let ty = 0; ty < h; ty++) for (let tx = 0; tx < w; tx++) {
      const c = centreOf(tx, ty);
      if (BL().onStair(lay, c.x, c.z, 0.2)) { g.set(tx, ty, T.ROAD); continue; }
      const f = fl[ty * w + tx];
      if (f > 0 && (at(tx + 1, ty) < f || at(tx - 1, ty) < f || at(tx, ty + 1) < f || at(tx, ty - 1) < f)) g.set(tx, ty, T.WALL);
    }
    for (const pz of lay.plazas) disc(pz.x, pz.z, pz.r, T.ROAD);
  }

  // the island's edge and the pond
  if (lay.pond) disc(lay.pond.x, lay.pond.z, lay.pond.r + 0.3, T.WALL);
  for (let ty = 0; ty < h; ty++) for (let tx = 0; tx < w; tx++) {
    const c = centreOf(tx, ty);
    if (BL().islandSdf(lay, c.x, c.z) < RIM) g.set(tx, ty, T.WALL);
  }

  const plots = {}, zones = {};
  for (const s of lay.structures) {
    const hw = s.w / 2, hd = s.h / 2, rad = s.r + 1;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const inside = [];
    for (let ty = Math.floor(s.z - rad + OZ); ty <= Math.ceil(s.z + rad + OZ); ty++)
      for (let tx = Math.floor(s.x - rad + OX); tx <= Math.ceil(s.x + rad + OX); tx++) {
        const c = centreOf(tx, ty), l = BL().toLocal(s, c.x, c.z);
        if (Math.abs(l.u) > hw || Math.abs(l.v) > hd) continue;
        x0 = Math.min(x0, tx); y0 = Math.min(y0, ty); x1 = Math.max(x1, tx); y1 = Math.max(y1, ty);
        const edge = Math.abs(l.u) > hw - 1 || Math.abs(l.v) > hd - 1;
        if (edge && !s.site) g.set(tx, ty, T.WALL);
        else { g.set(tx, ty, T.FLOOR); inside.push({ x: tx, y: ty }); }
      }
    const dw = BL().toWorld(s, 0, hd - 0.5), dt = tileOf(dw.x, dw.z);
    if (!s.site) g.set(dt.x, dt.y, T.DOOR);
    const iw = BL().toWorld(s, 0, hd - 1.5), it = tileOf(iw.x, iw.z);
    if (!s.site && hd > 1.5) g.set(it.x, it.y, T.FLOOR);
    const at = tileOf(s.step.x, s.step.z);
    if (!g.passable(at.x, at.y)) g.set(at.x, at.y, T.ROAD);
    if (!inside.length) inside.push(at);
    const { x: _x, z: _z, ...rest } = s;
    plots[s.key] = {
      ...rest, wx: s.x, wz: s.z,
      x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1,
      inside, at, door: dt,
    };
    zones[s.key] = { x: s.x + OX, y: s.z + OZ, r: s.r };
  }

  // THE SQUARE: open ground round the fountain, where anybody with nowhere to be ends up
  const sqAt = tileOf(0, SQUARE_R - 1.5);
  const sqIn = [];
  for (let ty = -SQUARE_R; ty <= SQUARE_R; ty++) for (let tx = -SQUARE_R; tx <= SQUARE_R; tx++) {
    const d = Math.hypot(tx + 0.5, ty + 0.5);
    if (d <= SQUARE_R - 1 && d > FOUNTAIN_R + 0.6) sqIn.push({ x: tx + OX, y: ty + OZ });
  }
  plots.square = {
    key: 'square', kind: 'square', icon: '⛲', label: 'The square',
    x: OX - SQUARE_R, y: OZ - SQUARE_R, w: SQUARE_R * 2, h: SQUARE_R * 2,
    at: sqAt, door: sqAt, inside: sqIn,
  };

  // THE GATE: where the road out leaves the base. Every mission leaves through it.
  const gt = tileOf(lay.gate.x, lay.gate.z);
  for (let dx = -1; dx <= 1; dx++) g.set(gt.x + dx, gt.y, T.GATE);
  const gateIn = [];
  for (let dy = -2; dy <= -1; dy++) for (let dx = -1; dx <= 1; dx++) gateIn.push({ x: gt.x + dx, y: gt.y + dy });
  plots.gate = {
    key: 'gate', kind: 'gate', icon: '🌀', label: 'The gate',
    x: gt.x - 1, y: gt.y - 2, w: 3, h: 3,
    at: { x: gt.x, y: gt.y - 1 }, door: gt, inside: gateIn,
  };

  return {
    w, h, tiles: g, at: g.at, passable: g.passable, opaque: g.opaque, set: g.set,
    archetype: 'settlement', plots, zones, layout: lay, ox: OX, oz: OZ,
    sig: signature(state),
  };
}

/** Cached distance field to one plot, for anybody walking there. */
function fieldTo(map, key) {
  map._fields = map._fields || {};
  if (map._fields[key]) return map._fields[key];
  const p = map.plots[key];
  if (!p) return null;
  const starts = p.inside.length ? p.inside.map(t => [t.x, t.y]) : [[p.at.x, p.at.y]];
  return (map._fields[key] = MG.distanceField(map.tiles, starts));
}

const plotAt = (map, x, y) => Object.values(map.plots).find(p =>
  p.kind !== 'square' && x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h) || null;

/** Which plot a job is done in, or null for work with no building (maintenance is everywhere). */
function plotForJob(map, job) {
  const econ = E();
  const def = econ.JOBS[job];
  if (!def) return null;
  if (!def.building) return map.plots.square;                 // maintenance is done in the street
  return map.plots[def.building] || null;
}

const TownMapAPI = { T, SQUARE_R, BED_SIZE, workSize, signature, build, fieldTo, plotAt, plotForJob, workPlots, bedPlots };
if (typeof module !== 'undefined') module.exports = TownMapAPI;
if (typeof window !== 'undefined') window.TownMap = TownMapAPI;
})();
