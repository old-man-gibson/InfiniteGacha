// The town, with people in it. Browser: window.TownLife. Node: module.exports.
//
// townmap.js makes the ground; this walks the roster around on it. It owns NOTHING — every
// decision it makes is read back out of the town's own state, so it can be thrown away and
// rebuilt at any moment and nobody loses anything. Positions are not saved: a reload puts
// everybody where they are supposed to be and they carry on from there.
//
// Where a character goes follows from what the rest of the game already tracks about them, with
// a destination attached:
//
//   on a mission   →  the gate, and then out through it. They walk there first, which is the
//                     only reason the gate is a place rather than a button.
//   at a post      →  the building that post is done in (maintenance is done in the street)
//   building       →  the construction site they are on (lodging.js construct)
//   hurt or spent  →  their own bed, whichever lodging billeted them
//   off shift      →  whoever they would rather be with. This is the ONE decision in the file
//                     that is not already made somewhere else: a character with a close friend
//                     also off shift goes and finds them, and everyone else drifts to the best
//                     tavern their standing lets them into (floors.js), or the square if none.
//                     Two friends meet at the best tavern both may enter.
//
// So the town at a glance is the roster at a glance. A row of people standing in the mine is a
// mine that is fully staffed; a crowd in the square is a town with nothing to do; two people who
// are always in the same place are two people who like each other.
//
// WALKING is one cached distance field per plot — a dozen fields for the whole town, not one
// path per person — and a step down the gradient each frame. Inside a building they wander from
// tile to tile, because a workshop with six statues in it does not look staffed, it looks haunted.

(() => {
const TM = (typeof TownMap !== 'undefined') ? TownMap : require('./townmap.js');
const BO = () => (typeof Bonds !== 'undefined') ? Bonds : (typeof require !== 'undefined' ? require('./bonds.js') : null);
const LO = () => (typeof Lodging !== 'undefined') ? Lodging : (typeof require !== 'undefined' ? require('./lodging.js') : null);
const CO = () => (typeof Condition !== 'undefined') ? Condition : (typeof require !== 'undefined' ? require('./condition.js') : null);
const R = () => (typeof Rng !== 'undefined') ? Rng : require('./rng.js');
const FL = () => (typeof Floors !== 'undefined') ? Floors : (typeof require !== 'undefined' ? require('./floors.js') : null);

const SPEED = 2.4;            // tiles a second: a walk, not a march
const MILL_MIN = 3, MILL_MAX = 9;   // seconds between deciding to stand somewhere else
const THINK = 2.5;            // seconds between asking where somebody ought to be
const ARRIVE = 0.35;          // tiles: close enough to be standing on it

let sim = null;

const plotOf = (map, key) => (key && map.plots[key]) || null;

/**
 * Where this character ought to be. Everything but the last case is a fact the town already
 * knows; the last case is the only opinion in the file.
 */
function whereTo(state, c, map) {
  if (c.mission) return { goal: 'gate' };
  if (c.building && map.plots['bed:' + c.building]) return { goal: 'bed:' + c.building };   // a construction site (lodging.js)
  const lo = LO();
  const bed = lo ? lo.bedOf(state, c) : null;
  const home = bed ? 'bed:' + bed.id : null;

  if (c.injured > 0) return { goal: home || 'square' };
  if (c.job) {
    const p = TM.plotForJob(map, c.job);
    if (p) return { goal: p.key };
  }
  // off shift. Somebody worth finding, if there is somebody worth finding and they are free too
  const fl = FL();
  const local = (limit = null) => {
    const t = fl ? fl.tavernFor(state, c, limit) : null;
    return t && map.plots['bed:' + t.id] ? 'bed:' + t.id : 'square';
  };
  const bo = BO();
  if (bo) {
    const friend = bo.closestTo(state, c, state.characters);
    if (friend && !friend.c.mission && !friend.c.job && friend.c.injured <= 0) {
      // They meet where the friend is going and stand next to them, not only in the same
      // building. Two characters who like each other being visibly together is the only bond
      // shown without a prompt, so the goal is a position.
      const fbed = lo ? lo.bedOf(state, friend.c) : null;
      const co = CO();
      const tired = co && co.isSpent(friend.c);
      return { goal: tired && fbed ? 'bed:' + fbed.id : local(fl ? fl.reach(state, friend.c) : null), near: friend.c.id };
    }
  }
  const co = CO();
  if (co && co.isSpent(c) && home) return { goal: home };   // no company and no energy: go to bed
  return { goal: home && R().chance(0.35) ? home : local() };
}

/** A tile inside this plot to stand on, avoiding the exact one somebody else already has. */
function spotIn(sim, plot) {
  if (!plot || !plot.inside.length) return null;
  const rng = R();
  for (let i = 0; i < 6; i++) {
    const t = plot.inside[Math.floor(rng.rand() * plot.inside.length)];
    if (!sim.folk.some(a => a.spot && a.spot.x === t.x && a.spot.y === t.y)) return t;
  }
  return plot.inside[Math.floor(rng.rand() * plot.inside.length)];
}

function makeActor(c, at) {
  return {
    id: c.id, char: c, label: c.name,
    x: at.x, y: at.y, rx: at.x, ry: at.y,
    goal: null, spot: null, mill: 0, think: 0, gone: false,
    token: null, layers: null, ring: null,
  };
}

/**
 * Bring the sim in line with the town: rebuild the ground if anything was built, add anybody who
 * was summoned, drop anybody who died, and put everyone who is out on a mission through the gate.
 */
function sync(state) {
  const sig = TM.signature(state);
  if (!sim || sim.sig !== sig) {
    const map = TM.build(state);
    const keep = sim ? sim.folk : [];
    sim = { map, sig, folk: [], clock: 0, chatter: [] };
    // a rebuilt town keeps its people, clamped onto the new ground
    for (const a of keep) {
      const c = state.characters.find(x => x.id === a.id);
      if (!c) continue;
      a.x = Math.min(map.w - 2, Math.max(1, a.x)); a.y = Math.min(map.h - 2, Math.max(1, a.y));
      a.rx = a.x; a.ry = a.y; a.goal = null; a.spot = null;
      a.char = c;
      sim.folk.push(a);
    }
  }
  const map = sim.map;
  const live = new Set(state.characters.map(c => c.id));
  sim.folk = sim.folk.filter(a => live.has(a.id));

  for (const c of state.characters) {
    let a = sim.folk.find(x => x.id === c.id);
    if (!a) {
      // everybody arrives through the gate, including the ones who were summoned this second
      a = makeActor(c, map.plots.gate.at);
      sim.folk.push(a);
    }
    a.char = c;
    // back from a mission: they come in through the gate on foot like everyone else
    if (a.gone && !c.mission) { a.gone = false; a.x = a.rx = map.plots.gate.at.x; a.y = a.ry = map.plots.gate.at.y; a.goal = null; }
  }
  return sim;
}

/** Ask one person where they should be, and send them there. */
function retarget(state, a) {
  const map = sim.map;
  const want = whereTo(state, a.char, map);
  if (want.goal !== a.goal) { a.goal = want.goal; a.spot = null; }
  a.near = want.near || null;
  const plot = plotOf(map, a.goal);
  if (!plot) return;
  if (!a.spot || a.mill <= 0) {
    a.spot = (a.near != null ? beside(sim, a, plot) : null) || spotIn(sim, plot) || plot.at;
    a.mill = MILL_MIN + R().rand() * (MILL_MAX - MILL_MIN);
  }
}

/** A tile next to whoever this character went looking for, if they are somewhere standable. */
function beside(sim, a, plot) {
  const f = sim.folk.find(x => x.id === a.near && !x.gone);
  if (!f) return null;
  const fx = Math.round(f.x), fy = Math.round(f.y);
  const near = plot.inside.filter(t => Math.abs(t.x - fx) <= 2 && Math.abs(t.y - fy) <= 2);
  const free = near.filter(t => !sim.folk.some(o => o !== a && o.spot && o.spot.x === t.x && o.spot.y === t.y));
  const pick = (free.length ? free : near);
  return pick.length ? pick[Math.floor(R().rand() * pick.length)] : null;
}

/** One step down the cached gradient toward the goal plot, then straight at the chosen tile. */
function walk(sim, a, dt) {
  const map = sim.map;
  const plot = plotOf(map, a.goal);
  if (!plot || !a.spot) return;
  const dx = a.spot.x - a.x, dy = a.spot.y - a.y;
  const near = Math.abs(dx) <= 1.5 && Math.abs(dy) <= 1.5;
  let tx, ty;
  if (near) { tx = a.spot.x; ty = a.spot.y; }
  else {
    // downhill on the plot's distance field. Inside the building the field is flat, so the
    // straight line above takes over for the last couple of tiles.
    const f = TM.fieldTo(map, a.goal);
    const ix = Math.round(a.x), iy = Math.round(a.y);
    let best = null, bestD = f[iy * map.w + ix];
    if (bestD < 0) bestD = Infinity;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      if (!ox && !oy) continue;
      const nx = ix + ox, ny = iy + oy;
      if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
      const d = f[ny * map.w + nx];
      if (d < 0 || d >= bestD) continue;
      bestD = d; best = { x: nx, y: ny };
    }
    if (!best) { tx = a.spot.x; ty = a.spot.y; } else { tx = best.x; ty = best.y; }
  }
  const vx = tx - a.x, vy = ty - a.y;
  const len = Math.hypot(vx, vy);
  if (len < 0.01) return;
  const move = Math.min(len, SPEED * dt);
  a.x += vx / len * move;
  a.y += vy / len * move;
  // through the gate and out: a character on a mission stops being drawn once they reach it
  if (a.goal === 'gate' && a.char.mission && Math.hypot(a.spot.x - a.x, a.spot.y - a.y) < ARRIVE) a.gone = true;
}

/** One frame of town life. `dt` is real seconds. */
function step(state, dt) {
  if (!sim) sync(state);
  dt = Math.min(0.25, Math.max(0, dt));
  sim.clock += dt;
  for (const a of sim.folk) {
    if (a.gone) continue;
    a.think -= dt;
    a.mill -= dt;
    if (a.think <= 0) { a.think = THINK * (0.6 + R().rand() * 0.8); retarget(state, a); }
    if (!a.goal) retarget(state, a);
    walk(sim, a, dt);
  }
  return sim;
}

/** Everybody actually standing in the town right now. */
const onFoot = (s) => (s || sim || { folk: [] }).folk.filter(a => !a.gone);

/**
 * Pairs of close friends standing together. The view draws a link between them; it is the only
 * place a bond is ever visible without opening a sheet, and it is the reason the square looks
 * like a square rather than a queue.
 */
const NEAR = 2.6;
function knots(state, s = sim) {
  if (!s) return [];
  const bo = BO();
  if (!bo) return [];
  const here = onFoot(s);
  const out = [];
  for (let i = 0; i < here.length; i++) for (let j = i + 1; j < here.length; j++) {
    const a = here[i], b = here[j];
    if (Math.hypot(a.x - b.x, a.y - b.y) > NEAR) continue;
    const v = bo.value(state, a.id, b.id);
    const t = bo.tierOf(v);
    if (!t.close && v > -32) continue;
    out.push({ a, b, v, tier: t });
  }
  return out;
}

/** Who is where, for a caption under the map. */
function census(state, s = sim) {
  if (!s) return [];
  const counts = {};
  for (const a of onFoot(s)) {
    const k = a.goal || 'square';
    counts[k] = (counts[k] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([k, n]) => ({ plot: s.map.plots[k], n }))
    .filter(x => x.plot)
    .sort((a, b) => b.n - a.n);
}

const current = () => sim;
const reset = () => { sim = null; };

const TownLifeAPI = { SPEED, sync, step, whereTo, retarget, onFoot, knots, census, current, reset };
if (typeof module !== 'undefined') module.exports = TownLifeAPI;
if (typeof window !== 'undefined') window.TownLife = TownLifeAPI;
})();
