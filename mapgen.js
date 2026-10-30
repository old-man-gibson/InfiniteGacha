// Map generation: turns a mission's map SPEC (missiontypes.js) into actual tiles, named zones
// and spawn points. Browser: window.Mapgen. Node: module.exports (rot.js is UMD, so a map can
// be generated and checked without a browser).
//
// Five of the archetypes are rot.js generators (Cellular, Uniform, Digger, Rogue, Arena) and
// two are ours (route, settlement), because a road with flanking ground and a walled town with
// gates do not fall out of a dungeon generator.
//
// Placement uses one mechanism for every zone name. Objectives name zones — keep, vault, cells, point, route,
// garrison, extraction — and every type invents another one. Rather than a special case per
// name, the generator walks a distance field out from wherever the squad enters and hands out
// SLOTS along it: `entry` where they came in, `mid` halfway, `deep` at the far end of the walk,
// `far` the exit on the other side, `scatter` spread out and biased away from the entry. A zone
// name is then a lookup into that (ZONE_SLOT), so a new mission type asking for a new zone name
// costs one line and no new generator code. Distance is walking distance, not straight-line, so
// "deep" means a long way round rather than a wall's width away.
//
// Nothing here knows what a mission IS. It reads map.archetype, the zone names the atoms
// mention, and the cast's `at` fields; it does not read the type.

(() => {
const ROTLIB = (typeof ROT !== 'undefined') ? ROT : require('./vendor/rot.js');
const R = (typeof Rng !== 'undefined') ? Rng : require('./rng.js');

const T = { FLOOR: 0, WALL: 1, DOOR: 2, COVER: 3, DOWN: 4, UP: 5, GATE: 6, ROAD: 7 };
const GLYPH = { 0: '.', 1: '#', 2: '+', 3: '"', 4: '>', 5: '<', 6: 'П', 7: ',' };
const BLOCKED = new Set([T.WALL]);
const OPAQUE = new Set([T.WALL, T.COVER, T.DOOR]);

// Which slot along the walk each zone name lands in. Unknown names fall back to 'mid', which is
// wrong but never crashes — and shows up immediately when you look at the map.
const ZONE_SLOT = {
  extraction: 'entry', entry: 'entry', start: 'entry',
  keep: 'deep', vault: 'deep', cells: 'deep', nest: 'deep', objective: 'deep',
  'floor-end': 'deep', 'last-floor': 'deep', stairs: 'deep',
  point: 'mid', garrison: 'mid', rearguard: 'mid', route: 'route', walls: 'ring',
  gate: 'gate', 'far-exit': 'far', bodyguard: 'deep',
  works: 'scatter', node: 'scatter', trap: 'scatter', patrol: 'scatter',
  // the slots are addressable by name too, so a type can say `at: 'deep'` and mean it
  mid: 'mid', deep: 'deep', far: 'far', ring: 'ring',
};

// `at` values that are a MOMENT rather than a place. They get no zone, and their spawn group is
// marked deferred: the clock decides when those arrive, not the map.
const TEMPORAL = new Set(['last-wave', 'last-bout', 'last-minute', 'last-phase']);

// ---------- grid ----------

function grid(w, h, fill = T.WALL, cells = null) {
  const g = {
    w, h, cells: cells || new Uint8Array(w * h).fill(fill),
    at: (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? T.WALL : g.cells[y * w + x],
    set: (x, y, v) => { if (x >= 0 && y >= 0 && x < w && y < h) g.cells[y * w + x] = v; },
    passable: (x, y) => !BLOCKED.has(g.at(x, y)),
    opaque: (x, y) => OPAQUE.has(g.at(x, y)),
  };
  return g;
}

const inBounds = (g, x, y) => x >= 0 && y >= 0 && x < g.w && y < g.h;
const rect = (g, x0, y0, x1, y1, v) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) g.set(x, y, v); };
const border = (g, x0, y0, x1, y1, v) => {
  for (let x = x0; x <= x1; x++) { g.set(x, y0, v); g.set(x, y1, v); }
  for (let y = y0; y <= y1; y++) { g.set(x0, y, v); g.set(x1, y, v); }
};

/** rot.js keeps its own RNG. Seed it from ours so one source of entropy drives everything. */
function seedRot() { ROTLIB.RNG.setSeed(Math.floor(R.rand() * 2147483647)); }

// ---------- generators ----------
// Each returns { g, rooms } where rooms is [{x, y, w, h}] when the generator knows about rooms.

function genCellular(w, h) {
  const m = new ROTLIB.Map.Cellular(w, h);
  m.randomize(0.5);
  for (let i = 0; i < 4; i++) m.create();
  const g = grid(w, h, T.WALL);
  // connect() guarantees one walkable component; cellular calls back 1 for a live (floor) cell
  m.connect((x, y, v) => g.set(x, y, v ? T.FLOOR : T.WALL), 1);
  return { g, rooms: [] };
}

function roomsFrom(m) {
  return (m.getRooms ? m.getRooms() : []).map(r => ({
    x: r.getLeft(), y: r.getTop(),
    w: r.getRight() - r.getLeft() + 1, h: r.getBottom() - r.getTop() + 1,
    cx: Math.round((r.getLeft() + r.getRight()) / 2), cy: Math.round((r.getTop() + r.getBottom()) / 2),
    room: r,
  }));
}

function genRooms(w, h, Kind, opts) {
  const m = new Kind(w, h, opts);
  const g = grid(w, h, T.WALL);
  m.create((x, y, v) => g.set(x, y, v ? T.WALL : T.FLOOR));
  const rooms = roomsFrom(m);
  for (const r of rooms) if (r.room.getDoors) r.room.getDoors((x, y) => g.set(x, y, T.DOOR));
  return { g, rooms };
}

function genArena(w, h) {
  const g = grid(w, h, T.WALL);
  rect(g, 1, 1, w - 2, h - 2, T.FLOOR);
  return { g, rooms: [{ x: 1, y: 1, w: w - 2, h: h - 2, cx: w >> 1, cy: h >> 1 }] };
}

/** A road across the map with open ground either side: escorts, pursuits, ambushes. */
function genRoute(w, h) {
  const g = grid(w, h, T.FLOOR);
  border(g, 0, 0, w - 1, h - 1, T.WALL);
  let y = h >> 1;
  const road = [];
  for (let x = 1; x < w - 1; x++) {
    if (R.chance(0.22)) y += R.chance(0.5) ? 1 : -1;
    y = Math.max(3, Math.min(h - 4, y));
    for (let d = -1; d <= 1; d++) { g.set(x, y + d, T.ROAD); road.push([x, y + d]); }
  }
  return { g, rooms: [], road };
}

/** A walled place with gates and a keep: sieges, sabotage, rescues, assassinations. */
function genSettlement(w, h) {
  const g = grid(w, h, T.FLOOR);
  border(g, 0, 0, w - 1, h - 1, T.WALL);
  const m = 3;
  border(g, m, m, w - 1 - m, h - 1 - m, T.WALL);              // curtain wall
  const gates = [];
  const gy = h >> 1, gx = w >> 1;
  for (const [x, y] of [[m, gy], [w - 1 - m, gy], [gx, m], [gx, h - 1 - m]]) {
    g.set(x, y, T.GATE); g.set(x, y - (x === m || x === w - 1 - m ? 1 : 0), T.GATE);
    gates.push({ x, y });
  }
  // the keep, in the far third
  const kw = Math.max(6, Math.round(w * 0.16)), kh = Math.max(5, Math.round(h * 0.2));
  const kx = w - m - 4 - kw, ky = (h >> 1) - (kh >> 1);
  border(g, kx, ky, kx + kw, ky + kh, T.WALL);
  g.set(kx, ky + (kh >> 1), T.DOOR);
  const rooms = [{ x: kx, y: ky, w: kw, h: kh, cx: kx + (kw >> 1), cy: ky + (kh >> 1), keep: true }];
  // ordinary buildings
  for (let i = 0; i < Math.round(w * h / 260); i++) {
    const bw = R.randInt(4, 8), bh = R.randInt(3, 6);
    const bx = R.randInt(m + 2, w - m - bw - 3), by = R.randInt(m + 2, h - m - bh - 3);
    if (bx + bw > kx - 2 && bx < kx + kw + 2 && by + bh > ky - 2 && by < ky + kh + 2) continue;
    border(g, bx, by, bx + bw, by + bh, T.WALL);
    g.set(bx + 1 + R.randInt(0, bw - 2), by + bh, T.DOOR);
    rooms.push({ x: bx, y: by, w: bw, h: bh, cx: bx + (bw >> 1), cy: by + (bh >> 1) });
  }
  return { g, rooms, gates };
}

const GENERATORS = {
  cellular:   (w, h) => genCellular(w, h),
  uniform:    (w, h) => genRooms(w, h, ROTLIB.Map.Uniform, { roomWidth: [4, 10], roomHeight: [3, 7], roomDugPercentage: 0.25 }),
  digger:     (w, h) => genRooms(w, h, ROTLIB.Map.Digger, { roomWidth: [4, 9], roomHeight: [3, 6], corridorLength: [2, 8], dugPercentage: 0.22 }),
  rogue:      (w, h) => genRooms(w, h, ROTLIB.Map.Rogue, {}),
  arena:      (w, h) => genArena(w, h),
  route:      (w, h) => genRoute(w, h),
  settlement: (w, h) => genSettlement(w, h),
};

// ---------- distance field ----------

/** Breadth-first walking distance from one or more starts. -1 where you cannot get. */
function distanceField(g, starts) {
  const d = new Int32Array(g.w * g.h).fill(-1);
  const q = [];
  for (const [x, y] of starts) { if (g.passable(x, y)) { d[y * g.w + x] = 0; q.push(y * g.w + x); } }
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (let head = 0; head < q.length; head++) {
    const i = q[head], x = i % g.w, y = (i / g.w) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy, ni = ny * g.w + nx;
      if (!inBounds(g, nx, ny) || d[ni] !== -1 || !g.passable(nx, ny)) continue;
      d[ni] = d[i] + 1;
      q.push(ni);
    }
  }
  return d;
}

const floorTiles = (g) => {
  const out = [];
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) if (g.passable(x, y)) out.push([x, y]);
  return out;
};

// ---------- zones ----------

/**
 * Hand out the slots along the walk. Everything a mission can point at is one of these, so a
 * new zone name is a line in ZONE_SLOT rather than a new branch here.
 */
function slots(g, dist, built) {
  const reach = [];
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
    const v = dist[y * g.w + x];
    if (v >= 0) reach.push({ x, y, d: v });
  }
  reach.sort((a, b) => a.d - b.d);
  const deepest = reach[reach.length - 1] || { x: 1, y: 1, d: 0 };
  const median = reach[Math.floor(reach.length * 0.5)] || deepest;
  const keep = (built.rooms || []).find(r => r.keep);
  return {
    entry: reach[0] || deepest,
    mid: median,
    deep: keep ? { x: keep.cx, y: keep.cy, d: dist[keep.cy * g.w + keep.cx] } : deepest,
    far: reach[Math.floor(reach.length * 0.92)] || deepest,
    ring: reach[Math.floor(reach.length * 0.75)] || deepest,
    gate: (built.gates && built.gates[0]) ? { ...built.gates[0], d: 0 } : median,
    route: (built.road && built.road.length) ? { x: built.road[built.road.length - 1][0], y: built.road[built.road.length - 1][1], d: 0 } : median,
    all: reach,
  };
}

/** Radius of a zone: big enough to hold a fight, small enough to mean something. */
const ZONE_R = { entry: 4, mid: 5, deep: 5, far: 3, ring: 6, gate: 3, route: 3, scatter: 2 };

function zoneFor(name, sl) {
  const slot = ZONE_SLOT[name] || 'mid';
  if (slot === 'scatter') return null;                        // scattered things are spawns, not a zone
  const p = sl[slot] || sl.mid;
  return { name, slot, x: p.x, y: p.y, r: ZONE_R[slot] || 4 };
}

/** Every zone name a mission mentions, from its atoms and from where its cast starts. */
function zoneNames(mission) {
  const names = new Set(['extraction']);
  for (const a of [...mission.win, ...mission.lose, ...mission.bonus]) {
    if (a.zone) names.add(a.zone);
    if (a.what) names.add(a.what);          // destroy('gate'), breached('keep')
  }
  for (const g of mission.cast) {
    if (g.at && !TEMPORAL.has(g.at)) names.add(g.at);
    if (g.escapesAt) names.add(g.escapesAt);
    if (!g.at && g.role === 'structure' && g.kind) names.add(g.kind);
  }
  if (mission.map.floors > 1) names.add('stairs');
  return [...names];
}

/** Spread n points over the reachable floor, biased toward the far end and away from each other. */
function scatter(sl, n, { minDist = 6, from = 0.35 } = {}) {
  const pool = sl.all.slice(Math.floor(sl.all.length * from));
  const out = [];
  for (let tries = 0; out.length < n && tries < n * 40; tries++) {
    const p = pool[Math.floor(R.rand() * pool.length)];
    if (!p) break;
    if (out.every(q => Math.abs(q.x - p.x) + Math.abs(q.y - p.y) >= minDist)) out.push({ x: p.x, y: p.y });
  }
  return out;
}

/**
 * Where a horde stands. Scattered evenly across a map it is not a horde — it is forty separate
 * fights, each of them one rat, and the squad wins every one of them. So a swarmed group is
 * placed as PACKS: `size` bodies within arm's reach of a centre, the centres themselves scattered
 * the way single hostiles used to be. Walking into one is walking into all of it.
 */
function packs(sl, n, size, opts = {}) {
  const centres = scatter(sl, Math.max(1, Math.ceil(n / size)), { minDist: 10, from: 0.4, ...opts });
  if (!centres.length) return scatter(sl, n, { minDist: 1, from: 0.4 });
  const out = [];
  for (let i = 0; out.length < n; i++) {
    const c = centres[i % centres.length];
    out.push(...around(sl, c, Math.min(size, n - out.length), 2));
  }
  return out.slice(0, n);
}

/** A ring of points around a zone, for a garrison or a bodyguard. */
function around(sl, zone, n, spread = 6) {
  const near = sl.all.filter(p => Math.abs(p.x - zone.x) <= spread && Math.abs(p.y - zone.y) <= spread);
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = near.length ? near[Math.floor(R.rand() * near.length)] : zone;
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

// ---------- build ----------

/**
 * Build one floor of a mission's map. Returns tiles, the zones its objectives name, and a spawn
 * list per cast group. Temporal `at` values (wave, phase, bout, minute, last-*) are NOT placed
 * here — they belong to whoever is running the clock; this only answers "where".
 */
function build(mission, { floor = 1 } = {}) {
  seedRot();
  const spec = mission.map;
  const gen = GENERATORS[spec.gen] || GENERATORS.cellular;
  let built = null;
  // cellular can still isolate a pocket; a map whose walkable area is a tenth of the floor is a
  // bad roll rather than a bad generator, so take another one
  for (let tries = 0; tries < 6; tries++) {
    built = gen(spec.w, spec.h);
    if (floorTiles(built.g).length > spec.w * spec.h * 0.12) break;
  }
  const g = built.g;
  const open = floorTiles(g);

  // where the squad walks in: the leftmost open tile, or the up-stairs on a lower floor
  const entry = built.road ? { x: built.road[0][0], y: built.road[0][1] }
    : open.reduce((best, [x, y]) => (x < best.x ? { x, y } : best), { x: g.w, y: 0 });
  if (floor > 1) g.set(entry.x, entry.y, T.UP);

  const dist = distanceField(g, [[entry.x, entry.y]]);
  const sl = slots(g, dist, built);
  sl.entry = { x: entry.x, y: entry.y, d: 0 };

  const zones = {};
  for (const name of zoneNames(mission)) {
    const z = zoneFor(name, sl);
    if (z) zones[name] = z;
  }
  // a delivery ends at the far end of the map, not back where they walked in
  if (mission.exit === 'far') zones.extraction = { name: 'extraction', slot: 'far', x: sl.far.x, y: sl.far.y, r: 3 };
  if (mission.map.floors > 1 && zones.stairs) g.set(zones.stairs.x, zones.stairs.y, T.DOWN);

  // spawns, group by group, in whatever the group's `at` resolves to
  const spawns = [];
  for (const group of mission.cast) {
    const n = group.count || 0;
    // a structure with no `at` is placed by what it IS: a gate on the wall, nodes scattered
    const where = group.at && !TEMPORAL.has(group.at) ? group.at
      : (!group.at && group.role === 'structure' ? group.kind : null);
    const slot = where ? ZONE_SLOT[where] : null;
    let points;
    if (group.role === 'ward' && !group.captive) points = around(sl, sl.entry, n, 3);
    else if (slot === 'scatter') points = scatter(sl, n);
    // a horde stands together, wherever it was going to stand (missiontypes.js swarm)
    else if (group.pack && where && zones[where]) points = packs(sl, n, group.pack, { from: 0.2 });
    else if (group.pack) points = packs(sl, n, group.pack);
    // a gate belongs ON its gate, not somewhere near it; people can stand about
    else if (where && zones[where]) points = around(sl, zones[where], n, group.role === 'structure' ? 1 : 6);
    else if (group.role === 'patrol') points = scatter(sl, n, { minDist: 8, from: 0.2 });
    else points = scatter(sl, n, { minDist: 3, from: 0.45 });
    // `per` groups arrive per wave/floor/phase/bout and TEMPORAL ones on their cue: the points
    // are where they will come in, not who is standing there when the squad walks on
    spawns.push({ ...group, points, deferred: !!(group.per || TEMPORAL.has(group.at)) });
  }

  return {
    w: g.w, h: g.h, floor, floors: spec.floors, archetype: spec.archetype, gen: spec.gen,
    tiles: g, dist, zones, spawns, rooms: built.rooms || [], entry,
    at: g.at, passable: g.passable, opaque: g.opaque,
  };
}

/** Plain-text dump, for tests and for looking at a generator that has gone wrong. */
function ascii(map, { zones = true } = {}) {
  const rows = [];
  for (let y = 0; y < map.h; y++) {
    let line = '';
    for (let x = 0; x < map.w; x++) line += GLYPH[map.tiles.at(x, y)] || '?';
    rows.push(line.split(''));
  }
  for (const s of map.spawns) for (const p of s.points) {
    const c = { squad: '@', hostile: 'h', patrol: 'p', mark: 'M', ward: 'w', prize: '$', structure: 'X', civilian: 'c' }[s.role] || '?';
    if (rows[p.y]) rows[p.y][p.x] = c;
  }
  if (zones) for (const z of Object.values(map.zones)) if (rows[z.y]) rows[z.y][z.x] = z.name[0].toUpperCase();
  return rows.map(r => r.join('')).join('\n');
}

/** Rebuild a grid around tiles that came out of a save. */
const gridFrom = (w, h, cells) => grid(w, h, T.WALL, cells);

const MapgenAPI = { T, GLYPH, ZONE_SLOT, GENERATORS, build, ascii, distanceField, grid, gridFrom, floorTiles, scatter, around, packs };
if (typeof module !== 'undefined') module.exports = MapgenAPI;
if (typeof window !== 'undefined') window.Mapgen = MapgenAPI;
})();
