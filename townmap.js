// The town, as ground you can walk on. Browser: window.TownMap. Node: module.exports.
//
// Everything the town already has is a number in a panel: a farm at tier 3, four tents, a
// bunkhouse, eleven people. This turns that into a PLACE — a road, plots either side of it, a
// square at one end and the gate to the field at the other — so that "Kess is at the smithy"
// is somewhere she can be rather than a row in a table.
//
// The layout is deterministic. There is no randomness in this file, so the same buildings always
// produce the same town and the player sees the same place each time. It grows when
// you build — a Field becomes Terraces and its footprint doubles, a new lodging takes the next
// plot along the south side — and it is rebuilt only when `signature` changes, so the map is
// stable for as long as the town is.
//
// Shape. One road, west to east. Work on the north side, beds on the south side, so no bed is
// next to a workshop. The SQUARE is the west end of the road and is where anybody with nowhere
// to be ends up. The GATE is the east end, and is the only way out: every mission in the game
// leaves through it.
//
// Tiles are mapgen.js's codes so the tile palette, the distance fields and the pathing all work
// on this map exactly as they do on a mission map. Nothing here knows how to draw.

(() => {
const MG = (typeof Mapgen !== 'undefined') ? Mapgen : require('./mapgen.js');
const E = () => (typeof Econ !== 'undefined') ? Econ : require('./economy.js');
const LO = () => (typeof Lodging !== 'undefined') ? Lodging : (typeof require !== 'undefined' ? require('./lodging.js') : null);
const T = MG.T;

const GAP = 2;             // tiles between neighbouring plots
const MARGIN = 2;          // tiles of ground inside the palisade
const LANE = 3;            // how far a building sits off the road
const SQUARE_R = 5;        // the plaza at the west end
const FORECOURT = 7;       // ground in front of the gate

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
};

/**
 * Everything the layout depends on. The map is rebuilt when and only when this string changes,
 * so raising a building moves the town and an ordinary tick does not.
 */
function signature(state) {
  const lo = LO();
  const beds = lo ? lo.ensure(state).map(b => b.type + b.id).sort().join(',') : '';
  return [state.town, Object.entries(state.buildings).map(([k, v]) => k + v).sort().join(','), beds].join('|');
}

/** What goes on the north side of the road, west to east, in a fixed order. */
function workPlots(state) {
  const econ = E();
  const ORDER = ['farm', 'mine', 'garden', 'kitchen', 'smithy', 'lab', 'training'];
  return ORDER.filter(k => econ.BUILDINGS[k]).map(k => {
    const def = econ.BUILDINGS[k];
    const tier = state.buildings[k] || 0;
    return { key: k, kind: 'work', job: def.job || null, icon: def.icon, label: def.tiers[tier].name, ...workSize(tier) };
  });
}

/** And the south side: everywhere anybody sleeps, then the altar at the far end. */
function bedPlots(state) {
  const lo = LO(), econ = E();
  const out = (lo ? lo.ensure(state) : []).map(b => {
    const def = econ.LODGINGS[b.type] || econ.LODGINGS.tent;
    return { key: 'bed:' + b.id, bedId: b.id, kind: 'bed', icon: def.icon, label: def.label, ...(BED_SIZE[b.type] || BED_SIZE.tent) };
  });
  const altarTier = state.buildings.altar || 0;
  out.push({ key: 'altar', kind: 'altar', icon: '⚱️', label: econ.BUILDINGS.altar.tiers[altarTier].name, w: 4, h: 4 });
  return out;
}

/**
 * Split a side's plots into a front row and a back row. A town of one enormously long street is
 * a town nobody can see; two streets and a back lane is a town. Front row first, so the things
 * you look at most are on the main street.
 */
function wrap(plots, maxW) {
  const front = [], back = [];
  let w = 0;
  for (const p of plots) {
    if (w + p.w > maxW && front.length) back.push(p);
    else { front.push(p); w += p.w + GAP; }
  }
  return { front, back };
}

/** Lay a row of plots out left to right from `x0`, and say how wide it ended up. */
function shelf(plots, x0) {
  let x = x0;
  for (const p of plots) { p.x = x; x += p.w + GAP; }
  return Math.max(x0, x - GAP);
}

const rowH = (plots) => plots.length ? Math.max(...plots.map(p => p.h)) : 0;

/**
 * Build the town. Returns a mapgen-shaped grid plus the plots on it, so field.js's distance
 * fields, fieldview's palette and anything else that reads a map all work unchanged.
 */
const WRAP = 40;           // tiles of frontage before a side starts a back row

function build(state) {
  const north = wrap(workPlots(state), WRAP);
  const south = wrap(bedPlots(state), WRAP);

  // width: whichever row needs the most frontage, plus a square at one end and the gate's
  // forecourt at the other
  const x0 = MARGIN + SQUARE_R * 2 + GAP;
  const rightEdge = Math.max(x0 + 16,
    ...[north.front, north.back, south.front, south.back].map(r => shelf(r, x0)));
  const w = rightEdge + FORECOURT + MARGIN + 1;

  // Four rows and three streets. Front rows face the main street; back rows face a lane of their
  // own. Every door opens onto a road, so the layout does not read as a warehouse yard, and the
  // roads are where everybody walks.
  const nbH = rowH(north.back), sbH = rowH(south.back);
  const yNorthLane = MARGIN + nbH + 1;
  const yRoad = yNorthLane + (nbH ? 2 : 0) + LANE + rowH(north.front);
  const ySouthLane = yRoad + LANE + rowH(south.front) + (sbH ? 2 : 0);
  const h = ySouthLane + (sbH ? LANE + sbH : 0) + MARGIN + 1;

  const g = MG.grid(w, h, T.FLOOR);
  // the palisade, and the ground inside it
  for (let x = 0; x < w; x++) { g.set(x, 0, T.WALL); g.set(x, h - 1, T.WALL); }
  for (let y = 0; y < h; y++) { g.set(0, y, T.WALL); g.set(w - 1, y, T.WALL); }

  const street = (y, wide) => { for (let x = 1; x < w - 1; x++) for (let d = wide ? -1 : 0; d <= (wide ? 1 : 0); d++) g.set(x, y + d, T.ROAD); };
  street(yRoad, true);
  if (nbH) street(yNorthLane, false);
  if (sbH) street(ySouthLane, false);

  const zones = {};
  const plots = {};
  /** Put a plot down with its door facing `lane`, and run a path from the door to it. */
  const put = (p, top, lane) => {
    p.y = top;
    for (let y = p.y; y < p.y + p.h; y++) for (let x = p.x; x < p.x + p.w; x++) {
      const edge = y === p.y || y === p.y + p.h - 1 || x === p.x || x === p.x + p.w - 1;
      g.set(x, y, edge ? T.WALL : T.FLOOR);
    }
    const down = lane > p.y;                        // is the street below this plot or above it
    const dx = p.x + Math.floor(p.w / 2);
    const dy = down ? p.y + p.h - 1 : p.y;
    g.set(dx, dy, T.DOOR);
    p.door = { x: dx, y: dy };
    const step = down ? 1 : -1;
    for (let y = dy + step; down ? y < lane : y > lane; y += step) g.set(dx, y, T.ROAD);
    // where somebody stands when they are here: the inside of the building, or the doorstep for
    // anything too small to have one
    p.inside = [];
    for (let y = p.y + 1; y < p.y + p.h - 1; y++) for (let x = p.x + 1; x < p.x + p.w - 1; x++) p.inside.push({ x, y });
    if (!p.inside.length) p.inside.push({ x: dx, y: dy + step });
    p.at = { x: dx, y: dy + step };                 // the tile just outside the door
    plots[p.key] = p;
    zones[p.key] = { x: p.x + p.w / 2, y: p.y + p.h / 2, r: Math.max(p.w, p.h) / 2 };
  };

  for (const p of north.front) put(p, yRoad - LANE - p.h, yRoad - 1);
  for (const p of north.back) put(p, yNorthLane - LANE - p.h + 1, yNorthLane);
  for (const p of south.front) put(p, yRoad + LANE, yRoad + 1);
  for (const p of south.back) put(p, ySouthLane + LANE, ySouthLane);

  // THE SQUARE. Open ground at the west end of the road, and the one place in the town that is
  // nobody's workplace and nobody's bed — which is exactly why anybody with a day off is in it.
  const square = { x: MARGIN + SQUARE_R, y: yRoad, r: SQUARE_R };
  for (let y = square.y - SQUARE_R; y <= square.y + SQUARE_R; y++) {
    for (let x = square.x - SQUARE_R; x <= square.x + SQUARE_R; x++) {
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
      if ((x - square.x) ** 2 + (y - square.y) ** 2 <= SQUARE_R * SQUARE_R) g.set(x, y, T.ROAD);
    }
  }
  plots.square = {
    key: 'square', kind: 'square', icon: '⛲', label: 'The square',
    x: square.x - SQUARE_R, y: square.y - SQUARE_R, w: SQUARE_R * 2, h: SQUARE_R * 2,
    at: { x: square.x, y: square.y }, door: { x: square.x, y: square.y },
    inside: (() => {
      const out = [];
      for (let y = square.y - SQUARE_R + 1; y <= square.y + SQUARE_R - 1; y++)
        for (let x = square.x - SQUARE_R + 1; x <= square.x + SQUARE_R - 1; x++)
          if ((x - square.x) ** 2 + (y - square.y) ** 2 <= (SQUARE_R - 1) ** 2) out.push({ x, y });
      return out;
    })(),
  };

  // THE GATE. The east end of the road and the only way out of the town: every mission in the
  // game leaves through this tile and every survivor comes back through it.
  const gx = w - 1, gy = yRoad;
  for (let dy = -1; dy <= 1; dy++) g.set(gx, gy + dy, T.GATE);
  plots.gate = {
    key: 'gate', kind: 'gate', icon: '🌀', label: 'The gate',
    x: gx - 3, y: gy - 2, w: 4, h: 5,
    at: { x: gx - 1, y: gy }, door: { x: gx, y: gy },
    inside: [{ x: gx - 1, y: gy }, { x: gx - 2, y: gy }, { x: gx - 1, y: gy - 1 }, { x: gx - 1, y: gy + 1 }],
  };

  return {
    w, h, tiles: g, at: g.at, passable: g.passable, opaque: g.opaque, set: g.set,
    archetype: 'settlement', yRoad, plots, zones,
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

const TownMapAPI = { T, GAP, MARGIN, LANE, SQUARE_R, BED_SIZE, workSize, signature, build, fieldTo, plotAt, plotForJob, workPlots, bedPlots };
if (typeof module !== 'undefined') module.exports = TownMapAPI;
if (typeof window !== 'undefined') window.TownMap = TownMapAPI;
})();
