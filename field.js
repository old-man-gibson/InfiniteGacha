// The field: one mission, played out. Browser: window.Field. Node: module.exports.
//
// start() puts a rolled mission (missiontypes.js) on a generated map (mapgen.js) and step()
// advances it by one in-game second, returning the log lines that second produced. Nothing here
// draws anything — tokens.js does that — and nothing here knows what type of mission it is, only
// what its atoms say.
//
// Movement. A goal is a distance field: one breadth-first walk out from the destination,
// cached, and an actor steps to whichever neighbour is closer. Fifty actors sharing four goals
// cost four fields rather than fifty paths, and they route around walls for free.
//
// Aim. The squad reads its own win atoms and walks at the first one that is not met yet: an
// unbroken gate, an unworked node, a mark still breathing, a zone nobody is standing on. ORDERS
// then bend that — `guard` will not leave the ward, `avoid` refuses to close on anything it does
// not have to. So the sixteen mission types need no type-specific code here: a type that wants
// something new says so in its atoms, and the squad walks at it.
//
// Knowledge. The squad does not know the map. An objective it has never seen cannot be walked
// to: until the tile has been revealed, or the thing standing on it seen, the squad is
// SEARCHING — it picks a spot on the edge of the dark and goes to look, and picks another when
// that one turns out to be empty. How well it picks is the party's SCOUTING (ai.js): a poor one
// takes a random piece of the frontier and can spend a mission walking the wrong way, a good one
// almost always steps toward the nearest unexplored ground. At SCOUT_PERFECT the party stops
// guessing altogether and walks in already knowing where everything is, which is the only way
// the old behaviour — a straight line to the objective through unexplored rock — happens.
//
// Fighting. When the two sides come within reach they lock in place and the skirmish is
// resolved once, up front, by `resolve` — then its log plays back over the seconds the fight
// actually took and its deaths land at the end of that. This is what lets combat.js, which
// resolves a whole encounter in a single call, drive a map that runs in real time. The default
// resolver is plain attrition so the field runs headless with no characters; pass `resolve` to
// use the real one.
//
// Ending. verdict() walks the mission's lose atoms, then its win atoms as a set. It makes one
// check per atom (eight lose atoms and twelve win atoms) and does not branch on the mission type.
//
// Every win list ends with the same atom: everyone still standing is out. A contract is over
// when the people are home, not when its work is done, and the portal below is how that happens:
// one object with three rules about when it is open (missiontypes.js EXITS). That is why "hold
// the point" and "kill the target" finish the same way although one of them has nowhere to walk
// back to.

(() => {
const R = (typeof Rng !== 'undefined') ? Rng : require('./rng.js');
const MT = (typeof MissionTypes !== 'undefined') ? MissionTypes : require('./missiontypes.js');
const MG = (typeof Mapgen !== 'undefined') ? Mapgen : require('./mapgen.js');
const PR = () => (typeof Prof !== 'undefined') ? Prof : require('./proficiency.js');

const GUARD_LEASH = 2;         // tiles: how far a guard strays from the ward it is walking out
const SCREEN = 7;              // tiles: a known hostile this close to the ward is gone out to meet
const SCOUT_PERFECT = 80;      // party scouting at which the map holds no secrets (ai.js PERFECT)
const SEARCH_PATIENCE = 60;   // in-game seconds before a fruitless search picks somewhere else
const DARK_RADIUS = 4;         // tiles: how much dark behind a frontier tile counts as worth opening
const ENGAGE = 2;              // tiles: close enough to be in the same fight
const KEEP = 2;                // tiles: how far ahead of the rest anybody walks before waiting. ENGAGE, deliberately:
                               // a fight takes in everyone within that of somebody already in it, so a squad that
                               // stays this close is a squad that fights as one
const PACK = 3;                // tiles: hostiles this close to each other are one group
const RALLY_AT = 0.45;         // odds below which a group of hostiles collects the others before closing
const RALLY_WITS = 3.5;        // the mind it takes to collect the others at all (makeActor `wits`): a goblin, not a wolf
const GIVE_UP = 20;            // in-game seconds a hostile keeps hunting where it last saw somebody
const HEADSTART = 8;           // in-game seconds neither side re-opens a fight the squad has run from
// What a hostile that has never been given a mind is assumed to have, by grade. The bestiary
// gives a real one (int and wis, through the namer) and this is only for a bare test party.
const GRADE_WITS = { basic: 3, veteran: 4, elite: 5, ancient: 5, legendary: 6 };
const FRONT_OPEN = 8;          // open ground: everyone can swing at once (combat.js FRONTAGE_OPEN)
const STAND_REACH = 7;         // tiles: how far a squad will walk to be somewhere tighter
const SIGHT = 9;               // tiles: how far anyone sees, before twists
const BASE_SPEED = 0.55;       // tiles per in-game second
const WALK_REF = 4;            // walk speed (stats.js walkSpeed, 3 + dex x 0.1) that walks at BASE_SPEED: dex 10
const PACE_MIN = 0.9;          // slowest and fastest a squad member walks, as a multiple of BASE_SPEED: the slowest
const PACE_MAX = 1.1;          // member walks at 0.9 / 1.1 = 82% of the pace of the fastest
const LOSE_GROUND = 25;
const STRAGGLE = 900;        // in-game seconds a withdrawal is given to actually reach the way home
// Without a deadline a mission needs some other way to end badly. It is not a clock, it is a
// judgement: a squad that is down to a third of its strength or a quarter of its health stops
// working and walks home, and the contract is failed because nobody finished it. ABANDON is the
// backstop underneath that — a mission that somehow grinds on forever is a bug, not a story.
const BROKEN_CREW = 0.35;    // fraction of the party still standing
const BROKEN_HP = 0.25;      // average health across whoever is left
const ABANDON = 2.5;         // multiples of the estimate before they give up regardless        // in-game seconds of enemy-only control before a held zone is lost
const GRADE_POWER = { basic: 1, veteran: 2.2, elite: 4.5, ancient: 9, legendary: 18 };
const GRADE_HP = { basic: 20, veteran: 45, elite: 110, ancient: 260, legendary: 600 };
// What being spawned under the mission's level is worth, in the plain model. missions.js scales a
// monster 35% a level, so a body three levels down is roughly this much of one.
const SWARMED = (g) => (g.levelOffset ? Math.max(0.15, 1 / (1 + 0.35 * -g.levelOffset)) : 1);

let nextId = 1;
const actor = (o) => ({
  id: nextId++, alive: true, extracted: false, subdued: false, spotted: false,
  move: 0, goal: null, engaged: null, hp: 10, maxHp: 10, power: 1, speed: BASE_SPEED,
  px: o.x, py: o.y, ...o,
});

/** Walking pace of a squad member as a multiple of BASE_SPEED: walkSpeed / WALK_REF, held to PACE_MIN..PACE_MAX. */
const pace = (walk) => Math.max(PACE_MIN, Math.min(PACE_MAX, (walk || WALK_REF) / WALK_REF));

const isOurs = (a) => a.side === 'ours';
const isTheirs = (a) => a.side === 'theirs';
const onMap = (s) => s.actors.filter(a => a.alive && !a.extracted);
const squadOn = (s) => s.actors.filter(a => a.role === 'squad' && a.alive && !a.extracted);
const squadAlive = (s) => s.actors.filter(a => a.role === 'squad' && a.alive);
const matches = (a, who) => a.role === who || a.name === who || a.kind === who;
const named = (s, who) => s.actors.filter(a => matches(a, who));
const dist2 = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const label = (a) => a.label || a.name || a.kind || a.role;
const nearest = (a, list) => list.reduce((best, x) => (!best || dist2(a, x) < dist2(a, best) ? x : best), null);
const avg = (xs, k) => xs.reduce((t, a) => t + a[k], 0) / xs.length;

function say(s, text) {
  const line = { t: s.clock, text };
  s.log.push(line);
  s.pending.push(line);
}

// ---------- movement ----------

function fieldTo(s, key, points) {
  if (s.fields[key]) return s.fields[key];
  return (s.fields[key] = MG.distanceField(s.map.tiles, points.map(p => [p.x, p.y])));
}

function goalField(s, a) {
  const g = a.goal;
  if (!g) return null;
  if (g.kind === 'zone') {
    const z = s.map.zones[g.zone];
    return z ? fieldTo(s, 'z:' + g.zone, [z]) : null;
  }
  if (g.kind === 'exit') {
    return fieldTo(s, 'exit', [portalPoint(s)]);
  }
  if (g.kind === 'point') {
    return fieldTo(s, `p:${g.x},${g.y}`, [{ x: g.x, y: g.y }]);
  }
  if (g.kind === 'unseen') {
    const pts = [];
    for (let y = 0; y < s.map.h; y++) for (let x = 0; x < s.map.w; x++) {
      if (!s.seen[y * s.map.w + x] && s.map.passable(x, y)) pts.push({ x, y });
    }
    return pts.length ? fieldTo(s, 'unseen', pts) : null;
  }
  if (g.kind === 'search') {
    const b = s.beacon;
    // Handed back even when it cannot reach this actor: somebody standing in a wall (the squad
    // spawns in a rank around the entry, and the flanks can land in rock) is rescued by the
    // stall shuffle at the bottom of stepTile, and returning null here would freeze them there.
    return b ? fieldTo(s, `b:${b.x},${b.y}`, [b]) : null;
  }
  if (g.kind === 'actor') {
    const t = s.actors.find(x => x.id === g.id);
    if (!t || (!t.alive && !t.done)) return null;
    return fieldTo(s, 'a:' + t.id, [t]);
  }
  return null;
}

// ---------- searching ----------

/** Has anybody laid eyes on this? A party with a real scout never has to ask. */
const found = (s, a) => s.omniscient || !!a.found;
/** Has this piece of ground been revealed? */
const known = (s, z) => !!z && (s.omniscient || !!s.seen[z.y * s.map.w + z.x]);

const SEARCH = { kind: 'search' };

/**
 * The edge of the dark: unseen floor with seen floor next to it. Picking from the FRONTIER
 * rather than from all unexplored ground matters twice — a frontier tile is reachable, because
 * the squad has stood next to it, and heading for one always means walking off the end of what
 * is already known instead of at a wall on the far side of the map.
 */
function frontier(s) {
  const w = s.map.w, h = s.map.h;
  const edge = [], dark = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    // map.dist is the walk from the entry: below zero means no route in, and a squad that
    // picked one of those to look at would stand at the wall until its patience ran out.
    if (s.seen[y * w + x] || !s.map.passable(x, y) || s.map.dist[y * w + x] < 0) continue;
    dark.push({ x, y });
    let touches = false;
    for (let dy = -1; dy <= 1 && !touches; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (s.seen[ny * w + nx] && s.map.passable(nx, ny)) { touches = true; break; }
    }
    if (touches) edge.push({ x, y });
  }
  return edge.length ? edge : dark;
}

/**
 * How much dark a frontier tile opens: unseen passable ground within DARK_RADIUS of it, as a
 * fraction of the neighbourhood. A doorway into an unlit hall scores near 1; a crumb of unseen
 * floor between two explored rooms scores near 0.
 *
 * This is the difference between searching and nibbling. The NEAREST piece of frontier is nearly
 * always the one a step away, so a squad that walks to the nearest one arrives after two paces,
 * re-picks, and never drives into a room — which is why, before this, a party with good scouting
 * re-picked twice as often as a party with none and got barely any more of the map for it.
 */
function darkBehind(s, p) {
  const w = s.map.w, h = s.map.h;
  let dark = 0, total = 0;
  for (let y = Math.max(0, p.y - DARK_RADIUS); y <= Math.min(h - 1, p.y + DARK_RADIUS); y++) {
    for (let x = Math.max(0, p.x - DARK_RADIUS); x <= Math.min(w - 1, p.x + DARK_RADIUS); x++) {
      if (!s.map.passable(x, y)) continue;
      total++;
      if (!s.seen[y * w + x]) dark++;
    }
  }
  return total ? dark / total : 0;
}

/**
 * The direction a good scout would try first. The squad has not seen what it is after (finding
 * it is what searching is for), but reading ground is exactly the skill of knowing the sort of
 * place a keep sits or a nest gets dug, so scouting buys a pull toward it and nothing else
 * does. At no scouting this term is worth exactly nothing (see searchBeacon), and on a mission
 * with nothing specific to find there is no guess to be had at any level.
 */
function objectiveHint(s, c) {
  const seeking = s.searchingFor;
  if (seeking && seeking.atom === 'reveal') return null;
  const pts = (seeking && seeking.points) || (s.map.zones[s.objectiveZone] ? [s.map.zones[s.objectiveZone]] : []);
  if (!pts.length) return null;
  // the nearest of them: the guess is "the next one is probably that way", not a map pin
  const z = pts.reduce((best, p) => (!best || dist2(c, p) < dist2(c, best) ? p : best), null);
  const dx = z.x - c.x, dy = z.y - c.y;
  const len = Math.hypot(dx, dy);
  return len < 1 ? null : { x: dx / len, y: dy / len };
}

/**
 * Walking distance from the squad over ground it has SEEN, to every tile, plus one step onto any
 * unseen tile next to that ground. A straight line is the wrong cost: a piece of frontier on the
 * far side of a wall is two tiles away as the crow flies and forty on foot, and pricing it at two
 * is what sent a squad back the length of the map to look at it. Routing only through seen
 * ground keeps the squad from knowing a short cut it has not found.
 */
function knownWalk(s, from) {
  const w = s.map.w, seen = s.seen;
  const d = MG.distanceField({ w, h: s.map.h, passable: (x, y) => s.map.passable(x, y) && (seen[y * w + x] || (x === from.x && y === from.y)) }, [[from.x, from.y]]);
  return (p) => {
    let best = -1;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = p.x + dx, ny = p.y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= s.map.h) continue;
      const v = d[ny * w + nx];
      if (v >= 0 && (best < 0 || v + 1 < best)) best = v + 1;
    }
    return best;
  };
}

/**
 * The frontier in pieces: each run of edge tiles that touch one another is one doorway, one
 * corridor mouth, one side of a cave. Choosing between PIECES rather than between tiles matters
 * because a wide opening is many tiles and a narrow one is a few, and a choice weighted over tiles
 * is a choice weighted toward whatever has the most edge — almost always the far side of the map.
 */
function frontierPieces(edge, w) {
  const at = new Map(edge.map(p => [p.y * w + p.x, p]));
  const pieces = [];
  for (const [k0, p0] of at) {
    if (!at.has(k0)) continue;
    const piece = [p0]; at.delete(k0);
    for (let i = 0; i < piece.length; i++) {
      const p = piece[i];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const k = (p.y + dy) * w + p.x + dx;
        const q = at.get(k);
        if (q && Math.abs(q.x - p.x) <= 1) { piece.push(q); at.delete(k); }
      }
    }
    pieces.push(piece);
  }
  return pieces;
}

/**
 * Where to go looking. The squad searches TOGETHER — one place at a time, held until it is
 * revealed or until patience runs out — because a party that splits up to explore a map full of
 * things that kill people is a party that gets killed one at a time.
 *
 * The plan is nearest-new-ground-first: of the pieces of frontier they can reach over ground they
 * know, go to the one that opens the most dark per tile walked. Pieces are scored on:
 *
 *   walk     tiles on foot to the nearest tile of the piece (knownWalk), the cost
 *   open     how much dark lies behind it (darkBehind at its darkest tile), the gain. A crumb of
 *            unseen floor close by still beats a hall across the map, which is the point: it is
 *            cheapest to finish the ground they are standing in now, and every piece they leave
 *            behind is a walk back later
 *   with     whether it lies the way they are already going, so two pieces at the same price do
 *            not pull them back and forth
 *   toward   scouting's guess at where the objective is, and nothing at zero scouting
 *
 * Scouting decides how well the squad can read those numbers off the ground, not whether it uses
 * them: every score is multiplied by a misjudgement drawn fresh at each pick, wide at no scouting
 * and narrow near SCOUT_PERFECT, and the best-looking piece is the one they go to. A poor scout
 * misreads which doorway leads further and sometimes takes the lesser one, but it does not cross
 * the map to look at ground that is no better than the ground next to it.
 */
function searchBeacon(s) {
  const b = s.beacon;
  if (b && !s.seen[b.y * s.map.w + b.x] && s.clock - s.beaconAt < SEARCH_PATIENCE) return b;
  // A search that ran out of patience is a direction that did not pay: stop trusting it, or the
  // momentum below would keep shoving them at the same empty corner.
  if (b && s.clock - s.beaconAt >= SEARCH_PATIENCE) s.heading = null;
  const edge = frontier(s);
  if (!edge.length) { s.beacon = null; return null; }
  const ours = squadOn(s);
  const c = ours.length
    ? { x: avg(ours, 'x'), y: avg(ours, 'y') }
    : s.map.entry;
  // walk from whoever is standing nearest the middle of the squad: the centre itself can be rock
  const from = ours.length ? nearest(c, ours) : s.map.entry;
  const walk = knownWalk(s, from);
  const sense = Math.min(1, s.scout / SCOUT_PERFECT);
  const head = s.heading;
  const guess = objectiveHint(s, c);
  const dir = (p, v) => {
    const dx = p.x - c.x, dy = p.y - c.y, len = Math.hypot(dx, dy) || 1;
    return ((dx * v.x + dy * v.y) / len + 1) / 2;
  };

  const scored = [];
  for (const piece of frontierPieces(edge, s.map.w)) {
    let cost = -1, mouth = null, open = 0, deep = null;
    for (const p of piece) {
      const d = walk(p);
      if (d >= 0 && (cost < 0 || d < cost)) { cost = d; mouth = p; }
      const o = darkBehind(s, p);
      if (o > open || !deep) { open = o; deep = p; }
    }
    // nothing they know of leads there: walk at it in a straight line, priced as such
    if (cost < 0) { mouth = piece[0]; cost = 2 * Math.hypot(mouth.x - c.x, mouth.y - c.y); }
    const with_ = head ? 0.5 + 0.5 * dir(mouth, head) : 1;
    const hint = guess ? 0.35 + 0.65 * dir(mouth, guess) : 1;
    const worth = (0.2 + open) / (DARK_RADIUS + cost) * with_ * (1 - sense + sense * hint);
    // aim at the darkest tile of a piece close by, so they walk INTO the room rather than
    // stopping at its door; a far piece is aimed at its mouth, the end they will reach first
    scored.push({ p: cost <= DARK_RADIUS ? deep : mouth, worth });
  }
  const misread = 0.05 + 1.0 * (1 - sense);
  const won = scored.reduce((best, e) => {
    e.looks = e.worth * Math.exp(misread * R.jitter());
    return !best || e.looks > best.looks ? e : best;
  }, null);
  const dx = won.p.x - c.x, dy = won.p.y - c.y, len = Math.hypot(dx, dy) || 1;
  s.beacon = { x: won.p.x, y: won.p.y };
  s.heading = { x: dx / len, y: dy / len };
  s.beaconAt = s.clock;
  return s.beacon;
}

function stepTile(s, a) {
  const f = goalField(s, a);
  if (!f) return;
  const w = s.map.w;
  let bestD = f[a.y * w + a.x];
  if (bestD < 0) bestD = Infinity;
  let best = null;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const nx = a.x + dx, ny = a.y + dy;
    if (nx < 0 || ny < 0 || nx >= s.map.w || ny >= s.map.h || !s.map.passable(nx, ny)) continue;
    const d = f[ny * w + nx];
    if (d < 0) continue;
    if (d < bestD || (d === bestD && R.chance(0.2))) { bestD = d; best = [nx, ny]; }
  }
  if (best) { [a.x, a.y] = best; return; }
  // Standing somewhere the goal's field never reached: there is no downhill step to take and
  // the actor would stand there for the rest of the mission. Shuffle instead — a nudge cannot
  // make things worse, and a stall that lasts the whole clock reads as a broken game.
  if (f[a.y * w + a.x] >= 0) return;
  const open = [];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = a.x + dx, ny = a.y + dy;
    if (s.map.passable(nx, ny)) open.push([nx, ny]);
  }
  if (open.length) [a.x, a.y] = R.pick(open);
}

// ---------- what the squad is trying to do ----------

const liveTargets = (s, pred) => s.actors.filter(a => pred(a));

/**
 * Send them searching, and record what for. A guess is only worth having when there is a
 * specific thing to guess at: `points` are the places that would end this search if the squad
 * knew about them, and searchBeacon leans toward the nearest of them in proportion to scouting.
 * A mission paid to reveal the map passes nothing, because there the sweep IS the job and a
 * pull toward any one spot only drags them off it.
 */
function seek(s, atom, points = null) {
  s.searchingFor = { atom: atom && atom.atom, points: points && points.length ? points.map(p => ({ x: p.x, y: p.y })) : null };
  return SEARCH;
}

/**
 * Does this have to be collected before anyone can leave? A relic cannot walk and a prisoner
 * cannot leave its cell, but an escorted merchant walks itself and is nobody's luggage.
 */
const needsFetching = (a) => !a.extracted && (
  (a.captive && !a.freed) || (!a.speed && !a.carriedBy) || (a.subdued && !a.carriedBy));

/**
 * The first win atom that is not met yet, turned into somewhere to stand.
 *
 * Every target here is filtered through `found`: something that exists but has not been seen
 * sends the squad SEARCHING rather than on to the next atom, because "we have not found the
 * stairs yet" is not the same as "there are no stairs" — skipping would walk them to the exit
 * and end the mission early. A zone works the same way: they can only walk at ground they have
 * revealed. The way OUT is the exception, since they came in through it.
 */
// A contract states a MINIMUM: kill eighty per cent of them, scout half the ground. A squad that
// is still in good shape with clock to spare does not stop on that line — it finishes the job and
// takes the bonus. These are the conditions under which they keep working past the terms.
const PUSH_HP = 0.55;        // average fraction of health across whoever is still standing
const PUSH_CREW = 0.6;       // fraction of the party still standing
const PUSH_UNTIL = 0.8;      // fraction of the clock after which they stop being greedy

// Where the lines come from. Every threshold above and in BROKEN_* is what an average squad
// does, and a real squad differs from it. `start` takes a `will` — the same four numbers,
// decided by the people walking in (temper.js) — and everything below compares against that
// instead. This file still knows nothing about tempers: it is handed a line for when to keep
// working, a line for when to go home, and a name to blame for both.
const WILL = {
  push:   { hp: PUSH_HP, crew: PUSH_CREW, until: PUSH_UNTIL },
  broken: { hp: BROKEN_HP, crew: BROKEN_CREW },
  voice: null,
};
const willOf = (s) => s.will || WILL;

// How far a squad's resolve moves a line. Every line that resolve bends is multiplied by
// 1 - RESOLVE_WEIGHT x resolve, with resolve held to +-RESOLVE_CAP (below): +1 lowers it by 45% and
// -1 raises it by 45%. brokenLines (between fights) and hatchLines (inside one) both read it.
const RESOLVE_WEIGHT = 0.45;
const resolveShift = (resolve) => 1 - RESOLVE_WEIGHT * Math.max(-RESOLVE_CAP, Math.min(RESOLVE_CAP, resolve || 0));

/**
 * The two lines broken() compares against for a squad with this `will` and this `resolve`:
 * { crew, hp }, the fraction of the party still standing and the average health of whoever is left.
 * sortie.js prints the same figures on the party picker and in the launch log.
 */
function brokenLines(will, resolve = 0) {
  const w = (will || WILL).broken, k = resolveShift(resolve);
  return { crew: Math.max(0.05, w.crew * k), hp: Math.max(0.03, w.hp * k) };
}

/** Too few, too hurt: they stop working and make for the way out. */
function broken(s) {
  if (s.escalated || s.withdrew) return false;
  // Once they are walking out, squadOn() is SUPPOSED to drain: every body through the portal is
  // one fewer on the map. Reading that as "too few of them left" turned finished contracts into
  // withdrawals the moment the third person went home.
  if (s.phase === 'leaving') return false;
  const crew = squadOn(s);
  if (!crew.length) return false;
  // What they walked in with, moved by what has happened to them since. A squad that hardened
  // over a friend will stand in a place they would have left, and a shaken one leaves a place
  // they would have held, so a death changes what the squad does for the rest of the mission.
  // They also walked in with a resolve of their own (condition.js resolveSeed, set by sortie.js launch).
  const lines = brokenLines(willOf(s), resolveOf(s));
  if (crew.length < s.partySize * lines.crew) return true;
  const hp = crew.reduce((t, x) => t + (x.maxHp ? x.hp / x.maxHp : 1), 0) / crew.length;
  return hp < lines.hp;
}

function withdraw(s, why, ordered = false) {
  s.withdrew = { why, at: s.clock, ordered };
  s.phase = 'leaving';
  const voice = willOf(s).voice;
  say(s, `🩸 ${why} — they break off and make for the way out`);
  // the voice line says whose temper moved the line; an order from the panel moved nothing
  if (voice && !s.said && !ordered) { s.said = true; say(s, `   ${voice} has been saying so for a while`); }
}

/** Once they have decided to leave, anyone who reaches an OPEN way home is off the map. */
function pullOut(s) {
  if (!s.withdrew || !portalOpen(s)) return;
  for (const a of onMap(s)) {
    if (!isOurs(a) || a.engaged) continue;
    if (inPortal(s, a)) { a.extracted = true; say(s, `${label(a)} is out`); }
  }
}

function pushingOn(s) {
  if (s.escalated || s.phase === 'leaving') return false;
  const w = willOf(s).push;
  if (s.clock > s.mission.duration * w.until) return false;
  const crew = squadOn(s);
  if (!crew.length || crew.length < s.partySize * w.crew) return false;
  const hp = crew.reduce((t, x) => t + (x.maxHp ? x.hp / x.maxHp : 1), 0) / crew.length;
  return hp >= w.hp;
}

// ---------- side jobs ----------
//
// A side job belongs to ONE character, not to the squad. Whoever is best suited takes it at the
// gate and works it while everybody else does the contract, so the marksman is off finding the
// captain instead of standing in the line where the fighting is.

/** How well this character fits the work. A trait job wants a temperament, not a skill. */
function sideScore(a, job) {
  const c = a.char;
  if (job.trait) return (c && c.mind && c.mind.traits || []).includes(job.trait) ? 1 : 0;
  if (!c || !c.profs) return 0.2;                    // no character sheet (tests): anyone, badly
  let best = 0;
  for (const k of job.needs || []) if (c.profs[k]) best = Math.max(best, PR().toAbsolute(c.profs[k]));
  return best / 300;
}

function assignSideJobs(s) {
  s.side = (s.mission.side || []).map(j => ({ ...j, done: false, taker: null }));
  const taken = new Set();
  for (const j of s.side) {
    let best = null, score = 0;
    for (const a of squadOn(s)) {
      if (taken.has(a.id)) continue;
      const sc = sideScore(a, j);
      if (sc > score) { score = sc; best = a; }
    }
    if (!best || score <= 0) { say(s, `${j.icon} ${j.label}: nobody here is the right sort`); continue; }
    j.taker = best.id;
    taken.add(best.id);
    best.sideJob = j.id;
    say(s, `${j.icon} ${label(best)} has taken something on besides: ${j.label.toLowerCase()}`);
  }
}

/** Where the taker goes. The same three atom shapes the contract uses, for one person. */
function sideGoal(s, a, j) {
  if (!j.atom) return null;                          // a gamble is not an errand
  const at = j.atom;
  const pick = (all) => {
    const t = nearest(a, all.filter(x => found(s, x)));
    if (t) return { kind: 'actor', id: t.id };
    return all.length ? SEARCH : null;               // its own search, not the squad's
  };
  switch (at.atom) {
    case 'kill':      return pick(liveTargets(s, x => x.alive && isTheirs(x) && matches(x, at.of)));
    case 'eliminate': return pick(named(s, at.who).filter(x => x.alive));
    case 'gather':    return pick(liveTargets(s, x => x.kind === (at.of || 'cache') && !x.done));
  }
  return null;
}

/** Finished work pays, and some of it changes the mission. */
function sideCheck(s) {
  for (const j of s.side || []) {
    if (j.done || !j.atom || !winMet(s, j.atom)) continue;
    j.done = true;
    const who = s.actors.find(x => x.id === j.taker);
    say(s, `${j.icon} ${j.label} — done${who ? `, ${label(who)}` : ''}`);
    if (j.effect === 'quiet') {
      s.counters.spotted = 0;
      s.alarmUntil = 0;
      say(s, '   nobody carried word');
    }
    if (j.effect === 'win') s.sideWin = j;
  }
}

/** Bonus atoms that are simply MORE of the work already being done. Leaving is not more work. */
const STRETCH = new Set(['kill', 'gather', 'destroy', 'reveal', 'descend']);
const stretchGoals = (s) => (s.mission.bonus || []).filter(b => STRETCH.has(b.atom) && !winMet(s, b));

function notePush(s, more) {
  if (s.pushed) return;
  s.pushed = true;
  say(s, `💪 the terms are met and they are still standing — pushing on: ${more.map(MT.objectiveText).join(', ')}`);
}

function taskGoal(s, a) {
  if (s.withdrew) return { kind: 'exit' };
  if (a.sideJob) {
    const j = (s.side || []).find(x => x.id === a.sideJob && !x.done);
    const g = j && sideGoal(s, a, j);
    if (g) return g;
  }
  // terms met and still fresh: the stretch goals are appended to the list and fall through to
  // exactly the same cases below, so nothing here needs to know what a bonus is
  //
  // ...and the walk home sorts to the BACK of that list, always. Every win list now ends with
  // an extraction, and it is the one atom that must never be answered while there is other work
  // left: reached in written order it beat the stretch goals appended after it, so the moment
  // the terms were met the whole squad walked to the gate and STOOD IN IT — going home, by a
  // list that still had "and kill the rest of them" further down it.
  const work = (pushingOn(s) ? [...s.mission.win, ...stretchGoals(s)] : [...s.mission.win])
    .sort((x, y) => (goingHome(x) ? 1 : 0) - (goingHome(y) ? 1 : 0));
  for (const atom of work) {
    if (winMet(s, atom)) continue;
    switch (atom.atom) {
      case 'destroy': {
        const all = liveTargets(s, x => x.kind === atom.what && x.alive && !isOurs(x));
        const t = nearest(a, all.filter(x => found(s, x)));
        if (t) return { kind: 'actor', id: t.id };
        if (all.length) return seek(s, atom, all);
        break;
      }
      case 'gather': {
        const all = liveTargets(s, x => x.kind === (atom.of || 'node') && !x.done);
        const t = nearest(a, all.filter(x => found(s, x)));
        if (t) return { kind: 'actor', id: t.id };
        if (all.length) return seek(s, atom, all);
        break;
      }
      case 'eliminate': case 'subdue': {
        const all = named(s, atom.who).filter(x => x.alive);
        const t = all.find(x => found(s, x));
        if (t) return { kind: 'actor', id: t.id };
        if (all.length) return seek(s, atom, all);
        break;
      }
      case 'kill': {
        const all = liveTargets(s, x => x.alive && isTheirs(x) && x.role !== 'structure');
        const t = nearest(a, all.filter(x => found(s, x)));
        if (t) return { kind: 'actor', id: t.id };
        if (all.length) return seek(s, atom, all);
        break;
      }
      case 'reach': case 'hold':
        return known(s, s.map.zones[atom.zone]) ? { kind: 'zone', zone: atom.zone } : seek(s, atom, [s.map.zones[atom.zone]].filter(Boolean));
      case 'descend':
        return known(s, s.map.zones.stairs) ? { kind: 'zone', zone: 'stairs' } : seek(s, atom, [s.map.zones.stairs].filter(Boolean));
      case 'reveal':             return seek(s, atom);        // the sweep is the job: no guess
      case 'survive':
        return known(s, s.map.zones[s.holdZone]) ? { kind: 'zone', zone: s.holdZone } : seek(s, atom, [s.map.zones[s.holdZone]].filter(Boolean));
      case 'extract': {
        // extracting something that is not us means fetching it first: a relic still in its
        // vault, a prisoner still in a cell. Once it is carried or loose, it makes its own way.
        if (atom.who && atom.who !== 'squad') {
          const all = named(s, atom.who).filter(x => (x.alive || x.subdued) && needsFetching(x));
          const t = all.find(x => found(s, x));
          if (t) return { kind: 'actor', id: t.id };
          if (all.length) return seek(s, atom, all);
        }
        return { kind: 'exit' };
      }
      case 'protect':            break;                       // orders cover this
    }
  }
  return { kind: 'exit' };
}

// ---------- what a body does to the people who saw it ----------
//
// RESOLVE is what is left of somebody's willingness to be here, -1..+1. It starts at 0, or at the
// negative seed sortie.js launch() writes from morale and stamina (condition.js resolveSeed), and
// afterwards it moves only when a friend goes down. combat.js reads it — a steadied character keeps
// swinging while more hurt and reaches for the attack, a shaken one covers itself. `broken` and
// `escapeHatch` read the average of it (brokenLines, hatchLines), so one death can be what stops a
// squad leaving or what starts them running, and a squad that walked in shaken starts closer to
// both lines.
//
// The field does not decide which way resolve moves. It hands the survivors to `grieve` — the
// town supplies it, and it knows about bonds and tempers — and applies whatever comes back.
// Without one, a death is what it always was: a number in the counters.
// RESOLVE_CAP bounds the sum of the seed and every grief reaction (grieved), and resolveShift
// applies the same bound to whatever a caller passes to brokenLines and hatchLines.
const RESOLVE_CAP = 1;
const PANIC = 45;              // in-game seconds somebody who breaks is no use to anybody

function grieved(s, fallen) {
  if (!s.grieve) return;
  const survivors = squadOn(s).filter(a => a.id !== fallen.id);
  if (!survivors.length) return;
  let reactions = [];
  try { reactions = s.grieve(fallen, survivors, s) || []; } catch (e) { return; }
  for (const r of reactions) {
    const a = r.actor;
    if (!a) continue;
    a.resolve = Math.max(-RESOLVE_CAP, Math.min(RESOLVE_CAP, (a.resolve || 0) + (r.delta || 0)));
    // THE FLOOR. Somebody who hardens over a death does not soften again on this map — the next
    // body cannot take them below where this one put them. It is the difference between grief
    // that is spent and grief that is carried.
    if (r.floor != null) a.floor = Math.max(a.floor == null ? -RESOLVE_CAP : a.floor, r.floor);
    if (a.floor != null) a.resolve = Math.max(a.resolve, a.floor);
    if (r.panic) a.panicUntil = s.clock + PANIC;
    if (r.line) say(s, '   ' + r.line);
  }
  // and any detachment that just lost somebody is over
  dissolve(s, (d) => d.members.includes(fallen.id), 'they are a man short');
}

/** The squad's nerve as one number, for the thresholds that are about the squad. */
const resolveOf = (s) => {
  const crew = squadOn(s);
  if (!crew.length) return 0;
  return crew.reduce((t, a) => t + (a.resolve || 0), 0) / crew.length;
};

const panicking = (s, a) => a.panicUntil && s.clock < a.panicUntil;

// ---------- splitting up ----------
//
// A DETAIL is some of the squad given a different job from the rest of it: one of them slipping
// ahead to a mark while everyone else keeps walking, two of them standing in a doorway so the
// others can get past, or all of them walking to that doorway to have the fight there instead of
// in the open. field.js owns only the mechanism — a member of a detail takes the detail's goal
// instead of the mission's — and `tactics` decides whether there is one, who is in it and whether
// the rest of them believe it will work. See tactics.js: it is a question about odds and trust.
const PLAN_EVERY = 12;         // in-game seconds between asking whether the plan should change
// tactics.js starts a 'retreat' detail when the odds against what is closing are below HOPELESS and
// ends it as soon as nothing is within its NEAR range. closing() used to count a hostile that had
// spotted the squad and stayed at its post: it was out of range while the squad walked away and in
// range again once the squad walked back to its task, so the same step back started again every
// other plan interval (175 times in the longest of 60 dungeon sorties with this bound removed).
// closing() now counts only hunting hostiles (hunting() below) and no run in 240 sorties or 8 loop
// seeds reaches this bound. It stays as the limit on any other cause of a repeating step back, and
// test/rating.harness.js check asserts it. counters.stepsBack counts the step-backs since the last
// fight (openSkirmish resets it); the step-back after STEPS_BACK of them is a withdrawal instead.
const STEPS_BACK = 2;

function detailFor(s, a) { return (s.details || []).find(d => d.members.includes(a.id)) || null; }

function dissolve(s, pred, why) {
  const going = (s.details || []).filter(pred);
  if (!going.length) return;
  s.details = s.details.filter(d => !going.includes(d));
  for (const d of going) {
    for (const id of d.members) { const a = s.actors.find(x => x.id === id); if (a) a.sneak = false; }
    if (why) say(s, `\u{1F501} ${d.label} — ${why}`);
  }
}

/**
 * What one member of a detail is actually walking at. Returning null hands them back to the
 * mission, which is what happens when the thing the detail was formed around is gone.
 */
function detailGoal(s, a, det) {
  if (det.kind === 'strike') {
    const t = s.actors.find(x => x.id === det.targetId);
    if (t && (t.alive || t.done) && found(s, t)) return { kind: 'actor', id: t.id };
    if (det.zone && known(s, s.map.zones[det.zone])) return { kind: 'zone', zone: det.zone };
    return null;
  }
  if (det.kind === 'stand') {
    // everybody goes to the one tile and stays on it: the fight opens on the ground they chose
    return det.point ? { kind: 'point', x: det.point.x, y: det.point.y } : null;
  }
  if (det.kind === 'retreat') {
    // back to the way in, out of sight, until the hunt dies down
    return { kind: 'exit' };
  }
  if (det.kind === 'pounce') {
    // everybody at the one group, before the rest of them arrive
    const t = s.actors.find(x => x.id === det.targetId);
    return t && t.alive && !t.extracted ? { kind: 'actor', id: t.id } : null;
  }

  if (det.kind === 'hold') {
    // The backer stands with the anchor, not near the enemy and not near the objective but beside
    // the one person whose job is to be in the way. Standing there keeps the rearguard together,
    // so the two fight as one position instead of being picked off separately.
    if (a.id !== det.anchorId) {
      const anchor = s.actors.find(x => x.id === det.anchorId);
      if (anchor && anchor.alive && !anchor.extracted) {
        return dist2(a, anchor) > 2 ? { kind: 'actor', id: anchor.id } : null;
      }
      return null;
    }
    // the anchor goes out to meet whatever is nearest and known, and otherwise stands its ground
    const closing = nearest(a, s.actors.filter(x =>
      isTheirs(x) && x.alive && x.role !== 'structure' && found(s, x)));
    // ...unless it was given ground to hold, in which case it waits there until they are nearly on it
    if (det.point && (!closing || dist2(a, closing) > ENGAGE + 1)) return { kind: 'point', x: det.point.x, y: det.point.y };
    if (closing && dist2(a, closing) <= SCREEN * 2) return { kind: 'actor', id: closing.id };
    return det.zone && known(s, s.map.zones[det.zone]) ? { kind: 'zone', zone: det.zone } : null;
  }
  return null;
}

/** Ask for a plan, at most every PLAN_EVERY seconds and never while things are already bad. */
function replan(s) {
  if (!s.tactics || s.withdrew || s.escalated || s.clock < s.nextPlan) return;
  s.nextPlan = s.clock + PLAN_EVERY;
  // anybody in a detail whose members are gone, or whose job is done, is finished with it
  dissolve(s, d => !d.members.some(id => squadOn(s).some(a => a.id === id)), null);
  let out = null;
  try { out = s.tactics(s); } catch (e) { return; }
  if (!out) return;
  for (const d of (out.end || [])) dissolve(s, x => x.id === d, 'that is done');
  let leave = out.leave;
  for (const d of (out.start || [])) {
    if (d.kind === 'retreat') {
      s.counters.stepsBack = (s.counters.stepsBack || 0) + 1;
      if (s.counters.stepsBack > STEPS_BACK) {
        leave = leave || `stepped back ${STEPS_BACK} times with no fight in between, and the threat is in range again`;
        continue;
      }
    }
    s.details.push(d);
    for (const id of d.members) { const a = s.actors.find(x => x.id === id); if (a && d.sneak) a.sneak = true; }
    say(s, d.line || `\u{1F500} ${d.label}`);
  }
  // A PLAN CAN BE "GO HOME". The health lines in `broken` are what an ordinary squad does when
  // it has already been hurt; this is somebody reading what is coming and leaving before that.
  if (leave && !s.withdrew && s.phase !== 'leaving') withdraw(s, leave);
}

/**
 * Is this actor ahead of at least half the people walking with it, by more than KEEP? The people
 * walking with it are the rest of its detail if it is in one, and the rest of the squad if not.
 */
function ahead(s, a, goal, ours) {
  const f = goalField(s, { goal });
  if (!f) return false;
  const w = s.map.w;
  const mine = f[a.y * w + a.x];
  if (mine < 0) return false;
  const mine_ = detailFor(s, a);
  const others = ours.filter(o => o !== a && !o.engaged && !o.sideJob && detailFor(s, o) === mine_ && !panicking(s, o));
  if (!others.length) return false;
  const behind = others.filter(o => { const d = f[o.y * w + o.x]; return d >= 0 && d - mine > KEEP; }).length;
  return behind * 2 >= others.length;
}

function chooseGoals(s) {
  const m = s.mission;
  const ours = squadOn(s);
  replan(s);
  // A detail is a job for the fight in front of the squad. tactics.js stops asking once the squad is
  // leaving (propose returns null), so nothing would end it, and its members would keep the detail's
  // goal and stay off the way out until the portal shut.
  if (s.phase === 'leaving') dissolve(s, () => true, null);
  useKits(s);
  const ward = s.actors.find(x => (x.role === 'ward' || x.role === 'prize') && x.alive && !x.extracted);

  // ESCORTING. The ward walks at its own pace and the people paid to keep it alive walk faster,
  // so a plain "make for the exit" goal has the squad arrive first and stand at the gate while
  // the ward crosses the last of the map on its own. Under guard orders nobody outwalks the
  // ward: the way out is ITS business and everyone else's job is to be in the way. Anything
  // known and closing is gone out to meet, which is what "the ward is never between a guard and
  // a hostile" means on a map where standing next to something is what starts a fight.
  const closing = ward ? nearest(ward, s.actors.filter(x =>
    isTheirs(x) && x.alive && x.role !== 'structure' && found(s, x) && dist2(x, ward) <= SCREEN)) : null;

  for (const a of ours) {
    if (a.engaged) continue;
    // A character who has broken ignores orders. They go to the gate, and whether that saves them
    // or strands them alone on the far side of the map is not part of the decision.
    if (panicking(s, a)) { a.goal = { kind: 'exit' }; continue; }
    const det = detailFor(s, a);
    if (det) {
      const g = detailGoal(s, a, det);
      // a detail of several walks together like the squad does: a pounce that arrives one at a
      // time is the thing it was meant to avoid
      if (g) { a.goal = (det.members.length > 1 && !det.sneak && g.kind === 'actor' && ahead(s, a, g, ours)) ? { kind: 'wait' } : g; continue; }
    }
    let goal = taskGoal(s, a);
    // ...unless this is the one carrying it, who has to walk it out rather than walk at it
    if (m.orders === 'guard' && ward && ward.carriedBy !== a.id) {
      if (closing) goal = { kind: 'actor', id: closing.id };
      else if (goal.kind === 'exit' || dist2(a, ward) > GUARD_LEASH) goal = { kind: 'actor', id: ward.id };
    }
    if (m.orders === 'avoid' && goal.kind === 'actor') {
      const t = s.actors.find(x => x.id === goal.id);
      if (t && isTheirs(t) && t.role !== 'structure') goal = SEARCH;
    }
    // Nobody walks far ahead of the rest. A fight opens at two tiles, so a squad that strings out
    // along a corridor meets the first group one person at a time and the others arrive to a
    // fight that is already lost. Whoever is KEEP tiles ahead of most of the others stands and
    // waits; the rearmost never waits, so nobody can wait on each other.
    if (!a.sideJob && !s.withdrew && s.phase !== 'leaving' && goal.kind !== 'exit' && ahead(s, a, goal, ours)) goal = { kind: 'wait' };
    a.goal = goal;
  }
  // One place to look for the whole squad, refreshed here rather than per actor so that four
  // people searching means four people searching the same room.
  if (ours.some(a => a.goal === SEARCH)) searchBeacon(s);

  // the ward walks itself out once it can; a captive waits to be reached
  for (const w of s.actors.filter(x => x.role === 'ward' && x.alive && !x.extracted)) {
    if (w.captive && !w.freed) {
      if (ours.some(o => dist2(o, w) <= 1)) { w.freed = true; say(s, `🔓 the ${w.name} is loose`); }
      else { w.goal = null; continue; }
    }
    w.goal = { kind: 'exit' };
  }

  const enemies = s.actors.filter(a => isTheirs(a) && a.alive && a.role !== 'structure');
  for (const e of enemies) {
    if (e.engaged) continue;
    // somebody who just watched the last lot get butchered is not closing on anybody (terrify)
    if (e.cowedUntil && e.cowedUntil > s.clock) { e.goal = null; continue; }
    // A detail that is sneaking is only noticed inside a third of sight range (at least 2 tiles),
    // and anybody else in the open is a better target, so sending one person ahead is a plan
    // rather than a way to lose them.
    // A hostile has to have a line of sight to somebody, the same test the squad is held to
    // (look); seeing through walls does not count. Breaking that line is what a squad running
    // from a fight is trying to do.
    const notice = (o) => dist2(e, o) < (o.sneak ? Math.max(2, Math.round(s.sight / 3)) : s.sight) && canSee(s.map, e, o, s.sight);
    const seen_ = ours.filter(notice);
    const sees = seen_.length > 0;
    // ...and it remembers where it last had one, for a while, and goes there
    if (sees) { const t = nearest(e, seen_); e.lastSeen = s.clock; e.lastAt = { x: t.x, y: t.y }; }
    const remembers = recalls(s, e);
    const up = sees || remembers || roused(s, e);
    const hunt = () => {
      const open = ours.filter(o => !o.sneak);
      const pool = open.length ? open : ours;
      if (!pool.length) return null;
      // nobody in sight: go to where somebody was, unless the alarm says where they are now
      if (!sees && remembers && !roused(s, e) && e.lastAt) return { kind: 'point', x: e.lastAt.x, y: e.lastAt.y };
      // Grouping. A group that reads the fight as a losing one collects the others in
      // reach before it closes, instead of arriving one at a time to be killed one at a time.
      // Once everyone within reach is together it goes in whatever the odds: this is grouping,
      // not hanging back, and a squad that stands in a doorway still gets its fight.
      const mate = rally(s, e, pool);
      return { kind: 'actor', id: (mate || nearest(e, pool)).id };
    };
    switch (m.pressure) {
      case 'quarry':
        // it runs while it can see them and rests the moment it cannot: a quarry that simply
        // ran for the exit at a constant speed could never be caught by anything on foot
        e.goal = e.role === 'mark' ? (sees ? { kind: 'zone', zone: e.escapesAt || 'far-exit' } : null) : (up ? hunt() : null); break;
      case 'bodyguard':
        e.goal = (e.role === 'mark' && (e.hp < e.maxHp * 0.4 || alarmed(s)) && e.flees)
          ? { kind: 'zone', zone: e.escapesAt || 'far-exit' } : (up ? hunt() : null); break;
      case 'patrol':
        e.goal = up ? hunt() : { kind: 'unseen' }; break;
      case 'ambush':
        e.goal = sees ? hunt() : null; break;
      case 'nest': case 'garrison': case 'wandering':
        e.goal = up ? hunt() : null; break;
      default:
        e.goal = hunt();
    }
    if (e.goal && e.goal.kind === 'zone' && !s.map.zones[e.goal.zone]) e.goal = hunt();
  }
}

/** The ally this hostile should collect before closing, if its group is not enough on its own. */
function rally(s, e, squad) {
  if (e.role === 'mark' || e.flees || (e.wits || 0) < RALLY_WITS) return null;
  // only the ones that are UP: something standing in a room that has heard nothing is not a
  // group to collect, it is a walk to wake it
  const kin = s.actors.filter(x => x !== e && isTheirs(x) && x.alive && !x.engaged && x.role !== 'structure' &&
    !(x.cowedUntil && x.cowedUntil > s.clock) && (roused(s, x) || squad.some(o => dist2(x, o) < s.sight)));
  const pack = [e, ...kin.filter(x => dist2(x, e) <= PACK)];
  if (odds(pack, squad, FRONT_OPEN) >= RALLY_AT) return null;
  return nearest(e, kin.filter(x => dist2(x, e) > PACK && dist2(x, e) <= ALARM_REACH));
}

// ---------- sight ----------

function canSee(map, a, b, radius) {
  if (dist2(a, b) > radius) return false;
  let x0 = a.x, y0 = a.y;
  const dx = Math.abs(b.x - x0), dy = Math.abs(b.y - y0);
  const sx = x0 < b.x ? 1 : -1, sy = y0 < b.y ? 1 : -1;
  let err = dx - dy;
  for (let guard = 0; guard < 200; guard++) {
    if (x0 === b.x && y0 === b.y) return true;
    if ((x0 !== a.x || y0 !== a.y) && map.opaque(x0, y0)) return false;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
  return false;
}

function look(s) {
  const map = s.map, sight = s.sight;
  for (const a of squadOn(s)) {
    for (let y = Math.max(0, a.y - sight); y <= Math.min(map.h - 1, a.y + sight); y++) {
      for (let x = Math.max(0, a.x - sight); x <= Math.min(map.w - 1, a.x + sight); x++) {
        const i = y * map.w + x;
        if (s.seen[i] || !map.passable(x, y)) continue;
        if (canSee(map, a, { x, y }, sight)) { s.seen[i] = 1; s.counters.revealed++; }
      }
    }
  }
  // Knowing WHERE something is. Being seen is the hostile's problem (below); this is ours —
  // an objective is not somewhere the squad can walk until somebody has laid eyes on it.
  for (const a of s.actors) {
    if (a.found || a.role === 'squad') continue;
    if (!squadOn(s).some(o => canSee(map, o, a, sight))) continue;
    a.found = true;
    // something new on the board is worth a plan NOW, not at the next tick of the clock: a fight
    // opens at two tiles and a hostile seen at nine arrives well inside PLAN_EVERY
    if (isTheirs(a) && a.role !== 'structure') s.nextPlan = 0;
    // Sighting a species counts. The bestiary opens an entry on sight (bestiary.js KNOW.seen),
    // and until now the only way to be seen was to be fought, so a recon, the one mission that is
    // about looking at things, taught the town nothing. It also means the next contract naming
    // this species shows a name instead of a ???.
    if (a.species && s.sighted) { const line = s.sighted(a.species, a); if (line) say(s, line); }
  }
  for (const e of s.actors) {
    if (!e.alive || !isTheirs(e) || e.role === 'structure' || e.spotted) continue;
    if (squadOn(s).some(o => canSee(map, e, o, sight))) {
      e.spotted = true;
      s.counters.spotted++;
      s.counters.sightings = (s.counters.sightings || 0) + 1;     // contact(): never reset, and not lost when descend() drops the hostile
      const first = !alarmed(s);
      raise(s, e);
      if (first) say(s, `👁️ ${label(e)} has seen them — the alarm goes up`);
    }
  }
}

// ---------- what a class can do to the map ----------
//
// A combat feature (classes.js) is a spell with a class's name on it and lives inside a fight.
// A FIELD feature is the other kind: it changes where people are, or what the other side makes
// of them, and it lives here. Each squad actor carries a `kit` — the field features its class
// gives it, with charges and a cooldown — and this section is everything that reads one.
//
// THE WORMHOLE. The party steps to any tile somebody has seen. Three uses, in the order they are
// checked: out (the walk home, or a withdrawal, skipped); onto a target that is standing alone
// (its escort has come out to meet the squad, or was never there); and — from inside a fight —
// away, which is the one that matters under permadeath and the one the rest of the engine had to
// be bent for: see escapeHatch, and `breakOff` in combat.js.
const BLINK_COOL = 15;          // in-game seconds between wormholes: charges are the real limit, this only keeps a strike and its exit from being the same second
const BLINK_GATHER = 8;         // tiles: how far from the caster the party can be and still be taken along
const BLINK_MIN = 6;            // tiles: closer than this and walking is as good
const BLINK_RESERVE = 1;        // charges kept back for getting out; a strike never spends the last one
const LONE = 3;                 // tiles: nothing hostile within this of a target makes it alone
const STRIKE_HP = 0.6;          // average health below which nobody is jumping INTO anything
const ESCAPE_HP = 0.4;          // average health at which a fight is one to leave, if leaving is possible
const ESCAPE_LOW = 0.2;         // one person this hurt, against a side still mostly standing, is enough
const ESCAPE_DOWN = 0.7;        // average health at which a fight with somebody already dead in it is one to leave
const ESCAPE_FOES = 0.4;        // "mostly standing": the foes' average health over which ESCAPE_LOW counts
const ESCAPE_AFTER = 10;        // combat ticks (1 s) before anybody thinks of it: the first big hit is the one to answer
// The three lines above are what an ordinary squad leaves at. hatchLines multiplies them by a lean of
// 1..HATCH_LEAN_MAX for a squad that bears less than an ordinary one (temper.js will: broken.hp over
// BROKEN_HP) or whose resolve is under 0, and never lowers them. HATCH_CAP_DOWN and HATCH_CAP_HP hold
// the two lines that a lean of 2 would otherwise take to 1.4 and 0.8 of the squad's health.
const HATCH_LEAN_MAX = 2;
const HATCH_CAP_DOWN = 0.95;
const HATCH_CAP_HP = 0.75;
const PRIZE_ATOMS = ['eliminate', 'subdue', 'kill', 'wipe', 'destroy'];

const kitOf = (a, kind) => (a.kit || []).find(k => k.kind === kind) || null;
/** The kit entry, if it has a charge left and its cooldown has run. */
function readyKit(s, a, kind) {
  const k = kitOf(a, kind);
  return k && (k.charges === undefined || k.charges > 0) && (k.ready || 0) <= s.clock ? k : null;
}
/** Everyone who steps through with the caster: the squad near them and not in a fight. */
const withCaster = (s, caster) => squadOn(s).filter(o => !o.engaged && dist2(o, caster) <= BLINK_GATHER);
const hpOf = (list) => list.length ? list.reduce((t, a) => t + (a.maxHp ? a.hp / a.maxHp : 1), 0) / list.length : 0;

/** A passable tile next to `t`, the one nearest `from`; `t` itself if there is none. */
function beside(s, t, from) {
  let best = null;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const p = { x: t.x + dx, y: t.y + dy };
    if (!s.map.passable(p.x, p.y)) continue;
    if (!best || dist2(p, from) < dist2(best, from)) best = p;
  }
  return best || { x: t.x, y: t.y };
}

/** Move the caster and whoever is with them onto a tile, this second. Returns who went. */
function blink(s, caster, to, why) {
  const k = kitOf(caster, 'wormhole');
  const who = withCaster(s, caster);
  for (const a of who) { a.x = to.x; a.y = to.y; a.move = 0; a.goal = null; }
  if (k) { if (k.charges !== undefined) k.charges--; k.ready = s.clock + (k.cooldown || BLINK_COOL); }
  s.beacon = null;
  say(s, `${(k && k.icon) || '\u{1F573}\uFE0F'} ${label(caster)} opens a wormhole: ${list(who)} ${why || 'through'}${k && k.charges !== undefined ? ` (${k.charges} left)` : ''}`);
  return who;
}

/**
 * A target worth landing on: the mission wants it dead or taken, somebody has laid eyes on it,
 * it is far enough that walking would give its escort time to come back, and nothing else
 * hostile is standing with it. The escort having gone out to meet the squad is precisely the
 * moment this is looking for.
 */
function loneTarget(s, caster) {
  const m = s.mission;
  if (m.orders === 'avoid' || !m.win.some(w => PRIZE_ATOMS.includes(w.atom))) return null;
  const hostiles = s.actors.filter(x => isTheirs(x) && x.alive && !x.extracted && x.role !== 'structure');
  const prizes = hostiles.filter(x => found(s, x) && !x.engaged && combatant(s, x) && dist2(x, caster) > BLINK_MIN &&
    (x.role === 'mark' || (GRADE_POWER[x.grade] || 1) >= GRADE_POWER.elite));
  const alone = prizes.filter(t => !hostiles.some(o => o !== t && dist2(o, t) <= LONE));
  return nearest(caster, alone);
}

/** A ward walking itself out cannot be left behind by the people paid to walk beside it. */
const wardWalking = (s) => s.actors.some(x => x.role === 'ward' && x.alive && !x.extracted && !x.carriedBy && x.speed > 0);

/** Once a step, before goals: whoever carries a wormhole decides whether this is the second for it. */
function useKits(s) {
  for (const a of squadOn(s)) {
    if (a.engaged || panicking(s, a)) continue;
    const k = readyKit(s, a, 'wormhole');
    if (!k) continue;
    const exit = portalPoint(s);
    // OUT. Leaving is leaving: a charge spent on the walk home is not one wasted, and a
    // withdrawal that takes one second instead of two minutes is the difference under fire.
    if (s.phase === 'leaving' && known(s, exit) && dist2(a, exit) > BLINK_MIN && !wardWalking(s)) {
      blink(s, a, exit, 'to the gate');
      continue;
    }
    // ONTO. Never on the last charge, never with a party too hurt to finish it, and never with
    // less than half the squad along: one caster landing on a boss alone is not a tactic.
    if (k.charges !== undefined && k.charges <= BLINK_RESERVE) continue;
    const along = withCaster(s, a);
    if (along.length < Math.ceil(squadOn(s).length / 2) || hpOf(along) < STRIKE_HP) continue;
    const t = loneTarget(s, a);
    if (t) blink(s, a, beside(s, t, a), `onto ${label(t)}, no escort within ${LONE} tiles`);
  }
}

/**
 * The lines escapeHatch compares against for a squad whose temper gives `will` (temper.js will) and
 * whose resolve is `resolve`: { lean, ratio, shift, down, avg, low }.
 *   ratio  the squad's own break-off health line over the ordinary one, will.broken.hp / BROKEN_HP
 *   shift  1 - RESOLVE_WEIGHT x resolve (resolveShift)
 *   lean   ratio x shift, held to 1..HATCH_LEAN_MAX, so it only ever raises the three lines
 *   down   min(HATCH_CAP_DOWN, ESCAPE_DOWN x lean): average health under which a fight with a body in it is left
 *   avg    min(HATCH_CAP_HP, ESCAPE_HP x lean): average health under which any fight is left
 *   low    ESCAPE_LOW x lean: one person under this, against foes averaging over ESCAPE_FOES, is left
 * A squad with the default will and resolve 0 gets lean 1 and the ESCAPE_* constants. Resolve over 0
 * lowers `shift` and the held lean stays at 1, so hardening over a death never makes the lines lower
 * than the constants. sortie.js prints these figures on the party picker.
 */
function hatchLines(will, resolve = 0) {
  const ratio = (will || WILL).broken.hp / BROKEN_HP, shift = resolveShift(resolve);
  const lean = Math.max(1, Math.min(HATCH_LEAN_MAX, ratio * shift));
  return {
    lean, ratio, shift,
    down: Math.min(HATCH_CAP_DOWN, ESCAPE_DOWN * lean),
    avg: Math.min(HATCH_CAP_HP, ESCAPE_HP * lean),
    low: ESCAPE_LOW * lean,
  };
}

/**
 * hatchLines and brokenLines for a will and a resolve as one sentence with the arithmetic, for the party
 * picker's tooltip. Every figure in it is a field of those two results or one of the constants above.
 */
function explainLines(will, resolve = 0) {
  const w = (will || WILL).broken, h = hatchLines(will, resolve), b = brokenLines(will, resolve);
  const pc = (v) => Math.round(v * 100) + '%', x3 = (v) => v.toFixed(3);
  return `In a fight the squad leaves under ${pc(h.avg)} average HP (${pc(ESCAPE_HP)} x lean ${x3(h.lean)}), ` +
    `under ${pc(h.down)} once somebody is dead in it (${pc(ESCAPE_DOWN)} x lean, held to ${pc(HATCH_CAP_DOWN)}), ` +
    `or when one is under ${pc(h.low)} (${pc(ESCAPE_LOW)} x lean) while the foes average over ${pc(ESCAPE_FOES)}. ` +
    `Lean = ${x3(h.ratio)} x ${x3(h.shift)} = ${x3(h.ratio * h.shift)}, held to 1..${HATCH_LEAN_MAX}: ${x3(h.lean)}. ` +
    `${x3(h.ratio)} is the party's break-off line ${pc(w.hp)} over the ordinary ${pc(BROKEN_HP)} (temper.js will); ` +
    `${x3(h.shift)} is 1 - ${RESOLVE_WEIGHT} x resolve ${(Math.max(-RESOLVE_CAP, Math.min(RESOLVE_CAP, resolve || 0))).toFixed(2)}. ` +
    `Between fights it leaves under ${pc(b.hp)} average HP (${pc(w.hp)} x ${x3(h.shift)}) ` +
    `or with fewer than ${pc(b.crew)} of the party standing (${pc(w.crew)} x ${x3(h.shift)}).`;
}

/**
 * A way out of a fight that has not finished. Handed to the resolver as a predicate over the two
 * sides — anything with hp and maxHp — which the fight asks every tick and stops on the first
 * answer. It answers when the fight has gone wrong AND somebody in it can actually leave: today
 * that is a ready wormhole, and anything else that later puts a way out on a kit (a potion, a
 * Rogue who can vanish) is a second branch here and a second `via` in breakOut, nothing more.
 *
 * "Gone wrong" is read against hatchLines(willOf(s), resolveOf(s)), computed once when the hatch is built
 * (once per fight). The reason that fired, with the figure and the line it was under, ends the log line.
 * At launch these are the lines the party picker printed; a death moves resolve, and the next fight's
 * lines move with it.
 */
function escapeHatch(ours, s) {
  // charges only, never the cooldown: the charge a strike leaves behind (BLINK_RESERVE) is FOR
  // this, and the fight a strike opens is decided the same second the strike lands
  const caster = ours.find(a => a.role === 'squad' && (k => k && (k.charges === undefined || k.charges > 0))(kitOf(a, 'wormhole')));
  // ON FOOT is the other way out, and everybody has it. It buys less: a head start of seconds
  // rather than a map, and whether that is enough is a question about legs (speedOf) and walls
  // (a hostile hunts what it can see, and remembers for GIVE_UP). A squad that runs from a fight
  // it is losing is a squad that has failed the contract and is still alive to be paid for the
  // next one, which under permadeath is most of what a squad is for.
  const legs = ours.filter(a => a.role === 'squad' && a.speed > 0);
  if (!caster && !legs.length) return null;
  const frac = (f) => (f.maxHp ? Math.max(0, f.hp) / f.maxHp : 1);
  const standing = (f) => f.alive !== false && f.hp > 0;
  const lines = hatchLines(willOf(s), resolveOf(s));
  // whole percents; a measured figure is printed under the line it fell below, so 39.6% against a
  // 40% line reads "39% ... 40%" and never "40% ... 40%"
  const pct = (v) => Math.round(v * 100);
  const under = (v, line) => Math.min(pct(v), pct(line) - 1);
  return (tick, party, foes) => {
    if (tick < ESCAPE_AFTER) return null;
    const me = caster ? party.find(f => f === caster || f === caster.fighter) : null;
    const wormhole = !!(me && standing(me));
    const up = party.filter(standing);
    const foeUp = foes.filter(standing);
    if (!foeUp.length) return null;
    const avg = hpOf(up);
    const lowest = Math.min(...up.map(frac));
    const foeAvg = foeUp.reduce((t, f) => t + frac(f), 0) / foeUp.length;
    const down = party.length - up.length;
    let why = null;
    if (down > 0 && avg < lines.down) why = `${down} dead and average HP ${under(avg, lines.down)}%, under their ${pct(lines.down)}% line`;
    else if (avg < lines.avg) why = `average HP ${under(avg, lines.avg)}%, under their ${pct(lines.avg)}% line`;
    else if (lowest < lines.low && foeAvg > ESCAPE_FOES) why = `one at ${under(lowest, lines.low)}%, under their ${pct(lines.low)}% line, with the foes averaging ${pct(foeAvg)}%`;
    if (!why) return null;
    if (wormhole) return { via: 'wormhole', by: caster.id, line: `${label(caster)} breaks off the fight through a wormhole: ${why}` };
    const runner = legs.find(a => up.some(f => f === a || f === a.fighter));
    if (!runner) return null;
    return { via: 'foot', by: runner.id, line: `they break off the fight and run: ${why}` };
  };
}

/** The fight has stopped short: put whoever is left somewhere else. */
function breakOut(s, sk) {
  const b = sk.broke;
  const caster = s.actors.find(a => a.id === b.by);
  if (b.via === 'wormhole' && caster && caster.alive) {
    const exit = portalPoint(s);
    blink(s, caster, exit, 'out of the fight, to the gate');
    // A fight left with somebody dead in it is the end of the day. Whatever the squad's nerve,
    // walking back in two short is how the other two die, and they are already at the gate.
    if (!s.withdrew && s.phase !== 'leaving' && sk.dead.some(isOurs)) withdraw(s, `${sk.dead.filter(isOurs).length} dead in the fight they left`);
    return;
  }
  if (b.via === 'foot') {
    // a head start, and then it is legs and walls: whoever is still up makes for the gate,
    // nobody re-opens this fight for HEADSTART seconds, and the day is over
    for (const a of [...sk.ours, ...sk.theirs]) a.noFightUntil = s.clock + HEADSTART;
    for (const a of sk.ours) if (a.alive) a.goal = { kind: 'exit' };
    if (!s.withdrew && s.phase !== 'leaving') withdraw(s, 'they ran from a fight they were losing');
    return;
  }
  // no way to be elsewhere: they slip off instead, and neither side re-opens it for a while
  for (const a of [...sk.ours, ...sk.theirs]) a.noFightUntil = s.clock + 30;
}

/**
 * Red Work, the Butcher's field kit (`terror`). It applies to a fight with a kill in it and a
 * squad member in it who carries the kit: every basic or veteran hostile within reach that is
 * not already fighting holds back for a while (chooseGoals). It does not send them running —
 * that would be a different class — it takes the next fight's reinforcements out of it.
 */
function terrify(s, sk) {
  const loud = sk.ours.find(a => a.alive && kitOf(a, 'terror'));
  if (!loud || !sk.theirs.some(d => !d.alive)) return;
  const k = kitOf(loud, 'terror');
  const cowed = s.actors.filter(e => isTheirs(e) && e.alive && !e.engaged && e.role !== 'structure' &&
    (GRADE_POWER[e.grade] || 1) <= GRADE_POWER.veteran && dist2(e, loud) <= (k.reach || 6));
  for (const e of cowed) e.cowedUntil = s.clock + (k.seconds || 45);
  if (cowed.length) say(s, `${k.icon || '\u{1FA78}'} ${label(loud)}: Red Work — ${cowed.length} hostile${cowed.length === 1 ? '' : 's'} within ${k.reach || 6} tiles hold position for ${k.seconds || 45} s`);
}

// ---------- how wide the ground is ----------
//
// combat.js caps how many of them can reach you at once, and this is where that number comes
// from: the tiles the squad is actually standing on when the fight opens. A corridor holds two, a
// cave mouth four, an open field everybody. Nobody is told to take the doorway — a squad that
// happens to be in one fights a completely different fight from the same squad caught in the
// open, which is why the width is read off the ground and not off the mission.
//
// Cover counts half a tile of room: a wilds map at 45% cover is meaningfully tighter than an
// arena, which is the first time that number has done anything except block line of sight.

const AROUND = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const GROUND_WORD = [[1, 'in a gap only one of them fits'], [3, 'in a doorway'], [4, 'in close ground'], [6, 'with room to swing'], [99, 'in the open']];

/** How much room one tile has around it. Open ground counts one, cover a half, wall nothing. */
function openness(s, x, y) {
  let n = 0;
  for (const [dx, dy] of AROUND) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= s.map.w || ny >= s.map.h || !s.map.passable(nx, ny)) continue;
    n += s.map.at(nx, ny) === MG.T.COVER ? 0.5 : 1;
  }
  return n;
}

/** The ground a fight is being held on, as a frontage for combat.js. Null when it cannot be read. */
function frontage(s, ours) {
  const on = ours.filter(a => a.x !== undefined && a.y !== undefined);
  if (!on.length || !s.map || !s.map.passable) return null;
  const mean = on.reduce((t, a) => t + openness(s, a.x, a.y), 0) / on.length;
  return Math.max(1, Math.min(8, Math.round(mean)));
}

/** What that frontage reads as, so the log says why a fight went the way it did. */
const groundWord = (width) => (GROUND_WORD.find(([n]) => width <= n) || GROUND_WORD[GROUND_WORD.length - 1])[1];

// ---------- reading a fight before it happens ----------
//
// The odds of a fight, read before anybody is in it. It uses the same two numbers the plain
// resolver spends — power, and the health it has to get through — on the ground the fight would
// be held on: only `width` bodies a side swing at once (combat.js frontage), so twelve of them
// in a doorway are worth their best two. The answer is the fraction of the fight that is ours,
// 0..1, a half being even. tactics.js reads it through a mind (noise by acumen, the way ai.js
// reads a loadout); the hostiles read it straight; neither ever sees a number the resolver would
// not have used.
// Where the numbers come from. A squad actor's power and guard are set from its combat.js fighter
// (sortie.js fighterFor: Combat.rating, power x Combat.RATE_K). A hostile's power, hp and guard
// come from the `rate` option of start() / restore() when it returns a value (sortie.js rateFoe),
// and from the GRADE_POWER / GRADE_HP rows otherwise. `guard` multiplies hp: armour counted as health.
const fightPower = (list, width) => list.filter(a => a.alive !== false && a.hp > 0).map(a => a.power || 0)
  .sort((x, y) => y - x).slice(0, Math.max(1, width)).reduce((t, p) => t + p, 0);
const fightHp = (list) => list.reduce((t, a) => t + Math.max(0, a.hp || 0) * (a.guard || 1), 0);
function odds(ours, theirs, width = FRONT_OPEN) {
  const w = Math.max(1, Math.min(FRONT_OPEN, Math.round(width)));
  const a = fightPower(ours, w) * fightHp(ours), b = fightPower(theirs, w) * fightHp(theirs);
  if (a <= 0) return 0;
  if (b <= 0) return 1;
  return a / (a + b);
}

/**
 * The tightest ground within reach: every passable tile within `reach` steps of `from` that the
 * squad would get to before anything in `threats` does, scored by openness. Tightest wins, nearer
 * breaks ties. Null when nothing there is tighter than `here`, the ground they are on now.
 */
function chokepoint(s, from, threats, here, reach = STAND_REACH) {
  const f = fieldTo(s, `p:${from.x},${from.y}`, [from]);
  const w = s.map.w;
  let best = null;
  for (let y = Math.max(0, from.y - reach); y <= Math.min(s.map.h - 1, from.y + reach); y++) {
    for (let x = Math.max(0, from.x - reach); x <= Math.min(w - 1, from.x + reach); x++) {
      const d = f[y * w + x];
      if (d < 0 || d > reach) continue;
      const p = { x, y };
      if (threats.some(t => dist2(t, p) <= d + 1)) continue;      // they would be there first
      const o = openness(s, x, y);
      if (o > here - 1) continue;
      if (!best || o < best.open || (o === best.open && d < best.d)) best = { x, y, open: o, d };
    }
  }
  return best;
}

// ---------- skirmishes ----------

/** Plain attrition, used when no real combat model is supplied. */
/**
 * An alarm is somewhere and recent. Left as a global flag it turns one sighting into every
 * hostile on the map hunting one squad for the rest of the mission, which is how a four-person
 * assassination loses eleven times out of twelve.
 */
const ALARM_LIFE = 75;         // in-game seconds an alarm stays up with nobody re-sighting them
const ALARM_REACH = 18;        // tiles: how far word of it travels
const alarmed = (s) => s.clock < s.alarmUntil;
const roused = (s, e) => alarmed(s) && s.alarmAt && dist2(e, s.alarmAt) <= ALARM_REACH;
/** The hostile saw a squad member within the last GIVE_UP seconds (chooseGoals sets lastSeen on every second it sees one). */
const recalls = (s, e) => e.lastSeen !== undefined && s.clock - e.lastSeen < GIVE_UP;
function raise(s, at) {
  s.alarm = true;
  s.alarmAt = { x: at.x, y: at.y };
  s.alarmUntil = s.clock + ALARM_LIFE;
}

/**
 * Whether a hostile is after the squad this second: its goal is a body (a squad member, or another
 * hostile it is collecting, rally) or the last place somebody was seen, or it has spotted the squad
 * and either the alarm is still up where it stands or it saw a member within GIVE_UP seconds. The
 * last two cover the second between a sighting and the goal chooseGoals gives it. A hostile that
 * has spotted the squad and stands at its post (goal null, alarm over, nobody seen for GIVE_UP
 * seconds) is not hunting. tactics.js closing() reads this.
 */
const hunting = (s, e) => !!(e.goal && (e.goal.kind === 'actor' || e.goal.kind === 'point')) ||
  (!!e.spotted && (roused(s, e) || recalls(s, e)));

function attrition(ours, theirs, s = null) {
  const log = [], dead = [];
  // the ground counts here as it does in combat.js: only so many of a side swing at once
  const width = (s && frontage(s, ours)) || FRONT_OPEN;
  const power = (list) => fightPower(list, width);
  const hatch = s ? escapeHatch(ours, s) : null;
  let broke = null;
  let a = [...ours], b = [...theirs], ticks = 0;
  while (a.length && b.length && ticks < 600) {
    if (hatch && (broke = hatch(ticks, ours, theirs))) { log.push(broke.line); break; }
    ticks += 10;
    const pa = power(a), pb = power(b);
    const losing = R.rand() < pb / (pa + pb) ? a : b;
    const t = losing[Math.floor(R.rand() * losing.length)];
    t.hp -= Math.max(1, (losing === a ? pb : pa) * 2.2 * (0.6 + R.rand()));
    if (t.hp <= 0) {
      dead.push(t);
      log.push(`${label(t)} goes down`);
      a = a.filter(x => x !== t); b = b.filter(x => x !== t);
    } else if (R.chance(0.3)) log.push(`${label(t)} takes a hit`);
  }
  return { ticks, log, dead, broke };
}

/** A ward only ends up in a fight when it is caught with nobody standing next to it. */
function combatant(s, a) {
  if (a.role === 'structure' || a.role === 'civilian' || a.role === 'prize') return false;
  // a resolver can decide a fight was unfinishable and push the two sides apart for a while;
  // without this they stand in the same tile and reopen the same stalemate every second
  if (a.noFightUntil && a.noFightUntil > s.clock) return false;
  if (a.role === 'ward') {
    if (a.captive && !a.freed) return false;      // locked up: the objective, not a fighter
    return !squadOn(s).some(o => dist2(o, a) <= 1);
  }
  return true;
}

function findSkirmishes(s) {
  const free = onMap(s).filter(a => !a.engaged && combatant(s, a));
  const seen = new Set();
  const out = [];
  for (const a of free) {
    if (seen.has(a.id)) continue;
    const group = [a];
    seen.add(a.id);
    for (let i = 0; i < group.length; i++) {
      for (const b of free) {
        // somebody who is trying not to be here starts a fight only by being walked into
        const reach = (group[i].sneak || b.sneak) ? 1 : ENGAGE;
        if (seen.has(b.id) || dist2(group[i], b) > reach) continue;
        seen.add(b.id); group.push(b);
      }
    }
    const ours = group.filter(isOurs), theirs = group.filter(isTheirs);
    if (ours.length && theirs.length) out.push({ ours, theirs });
  }
  return out;
}

function openSkirmish(s, { ours, theirs }) {
  const res = s.resolve(ours, theirs, s);
  s.counters.fights = (s.counters.fights || 0) + 1;      // read by contact(); a save from before this counter reads 0
  s.counters.stepsBack = 0;                              // replan(): a fight ends the run of step-backs
  const sk = {
    ours, theirs, log: res.log || [], dead: res.dead || [], at: 0, broke: res.broke || null,
    started: s.clock, ends: s.clock + Math.max(2, Math.round((res.ticks || 40) / 10)),
  };
  for (const a of [...ours, ...theirs]) a.engaged = sk;
  s.skirmishes.push(sk);
  raise(s, ours[0]);
  // Where it opened, whenever the ground is doing anything. A fight the squad wins because it was
  // standing in a doorway should say it was standing in a doorway.
  const width = frontage(s, ours);
  const where = width !== null && (width <= 4 || theirs.length > ours.length * 2) ? `, ${groundWord(width)}` : '';
  say(s, `⚔️ ${list(ours)} ${ours.length === 1 ? 'meets' : 'meet'} ${list(theirs)}${where}`);
}

const list = (as) => as.length <= 2 ? as.map(label).join(' and ') : `${label(as[0])} and ${as.length - 1} others`;

function runSkirmishes(s) {
  for (const sk of s.skirmishes) {
    const span = Math.max(1, sk.ends - sk.started);
    const want = Math.min(sk.log.length, Math.ceil(sk.log.length * (s.clock - sk.started) / span));
    while (sk.at < want) say(s, '   ' + sk.log[sk.at++]);
    if (s.clock < sk.ends) continue;
    while (sk.at < sk.log.length) say(s, '   ' + sk.log[sk.at++]);
    for (const d of sk.dead) kill(s, d);
    for (const a of [...sk.ours, ...sk.theirs]) if (a.engaged === sk) a.engaged = null;
    sk.done = true;
    if (sk.broke) breakOut(s, sk);
    else terrify(s, sk);
  }
  s.skirmishes = s.skirmishes.filter(sk => !sk.done);
}

function kill(s, a) {
  if (!a.alive) return;
  // a mark the mission wants breathing is taken instead, if it was worth taking
  if (a.subdueAt && s.mission.win.some(w => w.atom === 'subdue' && matches(a, w.who))) {
    a.alive = false; a.subdued = true; a.engaged = null;
    const carrier = nearest(a, squadOn(s));
    if (carrier) a.carriedBy = carrier.id;
    say(s, `🪢 ${label(a)} is down and bound`);
    return;
  }
  a.alive = false;
  a.engaged = null;
  s.counters.killed[a.role] = (s.counters.killed[a.role] || 0) + 1;
  if (a.kind) s.counters.destroyed[a.kind] = (s.counters.destroyed[a.kind] || 0) + 1;
  if (a.role === 'squad') { say(s, `💀 ${label(a)} falls`); grieved(s, a); }
  else if (a.role === 'mark') say(s, `🎯 ${label(a)} is dead`);
  else if (a.role === 'ward') say(s, `💔 the ${a.name} is dead`);
}

// ---------- the way home ----------
//
// One portal, and the only thing that varies is the rule about when it is open. Everything
// downstream — where the squad walks, when somebody is off the map, what the ring on the
// minimap is filling up with — reads this one object, so nothing here is per mission type.
//
//   gate       closed until the work is done, then FORMS while somebody stands at the point
//   window     open on arrival, shuts when the mission's own clock runs out, and can be forced
//              open again a few minutes later, once, and again, for as long as they last
//   standfast  closed until the work is done, then opens where they are and stays open; the
//              longer they choose not to use it, the more the contract pays
//
// A shut window is what a deadline turned into, and it is deliberately NOT a failure: it is a
// squad standing in the middle of somebody else's fortress with no way out for three minutes
// and every hostile on the map walking toward the noise, which is a better thing to watch —
// and a better thing to survive — than the words "the clock ran out".

const P = MT.PORTAL;
const portalPoint = (s) => (s.portal && s.portal.x != null) ? s.portal : (s.map.zones.extraction || s.map.entry);
const portalOpen = (s) => !!(s.portal && s.portal.state === 'open');
/** An extraction the squad performs on itself, as opposed to a ward or a relic being carried. */
const goingHome = (a) => a.atom === 'extract' && (!a.who || a.who === 'squad');
/**
 * Any tile inside the ring counts as going through it. The ring drawn on the map is the door,
 * and the whole of it is the door. The old rule asked for the centre tile give or take one,
 * which the squad could not reliably reach — anyone whose last step was refused, or who was
 * pulled aside by a detail on the way past, stood two tiles from the way home for the rest of
 * the mission.
 */
const inPortal = (s, a) => dist2(a, portalPoint(s)) <= Math.max(1, (s.portal && s.portal.r) || 1);

function makePortal(s) {
  const z = s.map.zones.extraction || s.map.entry;
  const mode = s.mission.exitMode || 'gate';
  return {
    mode, state: mode === 'window' ? 'open' : 'closed', progress: 0, missed: 0,
    // a window is open from the first second: it is how they got in, and somebody is holding it
    x: mode === 'standfast' ? null : z.x, y: mode === 'standfast' ? null : z.y, r: z.r || 3,
    shutsAt: mode === 'window' ? s.mission.duration : null, opensAt: null, openedAt: null,
  };
}

/**
 * Everything the contract asked for except the walk home — which means EVERY extract atom, not
 * only the squad's. A relic gets out by being carried out, so asking the portal to wait for it
 * to be out is asking it to wait for itself: the vault would open, the squad would pick the
 * thing up, and stand at a door that could never form. What the portal waits for instead is
 * the cargo being IN HAND, which is the same test leave() uses to decide they are ready to go.
 */
function workDone(s) {
  for (const a of s.mission.win) {
    if (a.atom !== 'extract') { if (!winMet(s, a)) return false; continue; }
    if (!a.who || a.who === 'squad') continue;
    const it = named(s, a.who).find(x => x.alive || x.subdued);
    if (it && needsFetching(it)) return false;      // still sealed, still in its cell, still loose
  }
  return true;
}

/** Where the squad is standing, as one point, for a portal that opens on top of them. */
function squadPoint(s) {
  const crew = squadOn(s);
  if (!crew.length) return null;
  return {
    x: Math.round(crew.reduce((n, a) => n + a.x, 0) / crew.length),
    y: Math.round(crew.reduce((n, a) => n + a.y, 0) / crew.length),
  };
}

function openPortal(s, where, why) {
  const pt = s.portal;
  pt.state = 'open';
  pt.openedAt = s.clock;
  if (where) { pt.x = where.x; pt.y = where.y; }
  say(s, why);
}

/**
 * One second of the portal. Called every step, before leave(), and it is the only thing that
 * decides whether anybody can go home.
 */
function portalTick(s) {
  if (!s.portal) s.portal = makePortal(s);
  const pt = s.portal;
  // A withdrawal also leaves through the portal. A squad that broke off has not finished the
  // work, but it still has to be able to go home, or a failed contract leaves the squad on the
  // map indefinitely.
  const done = workDone(s) || !!s.withdrew;
  if (done && !s.doneAt) s.doneAt = s.clock;    // the contract is finished; the walk home is not

  if (pt.mode === 'window') {
    // The clock is no longer a verdict. It is the moment somebody on the other side lets go.
    if (pt.state === 'open' && s.clock >= pt.shutsAt && squadOn(s).length) {
      pt.state = 'shut';
      pt.missed += 1;
      pt.opensAt = s.clock + Math.round(P.cycle[0] + R.rand() * (P.cycle[1] - P.cycle[0]));
      say(s, `🌀 the way home folds shut — ${MT.realClock((pt.opensAt - s.clock) * MT.TIME.scale)} until they can force it again`);
      // and being stranded is not merely waiting: the map now knows exactly where to look
      raise(s, squadPoint(s) || s.map.entry);
      for (const g of s.map.spawns) {
        if (g.role !== 'hostile' && g.role !== 'patrol') continue;
        spawnGroup(s, g, Math.max(1, Math.round((g.count || 0) * 0.3)));
      }
      say(s, '   whatever is still on this map is coming to the noise');
    } else if (pt.state === 'shut' && s.clock >= pt.opensAt) {
      pt.shutsAt = s.clock + P.window;
      openPortal(s, null, `🌀 it tears open again — ${MT.realClock(P.window * MT.TIME.scale)} of it, and no promises after that`);
    }
    return;
  }

  if (!done) { pt.progress = 0; return; }

  if (pt.mode === 'standfast') {
    // Nothing to walk back to: the job WAS standing here, so the door arrives where they are.
    if (pt.state === 'closed') {
      const at = squadPoint(s);
      if (!at) return;
      openPortal(s, at, '🌀 the terms are met — the way home opens where they stand');
      say(s, '   they can step through whenever they like, and every minute they do not is paid for');
    }
    return;
  }

  // gate: the work is done, and now the way home has to be built at the point
  if (pt.state === 'open') return;
  const holding = squadOn(s).filter(a => dist2(a, pt) <= Math.max(1, pt.r)).length;
  if (!holding) {
    if (pt.state === 'opening') { pt.state = 'closed'; say(s, '🌀 the way home slips: nobody is holding the point'); }
    pt.progress = Math.max(0, pt.progress - MT.TIME.step);
    return;
  }
  if (pt.state === 'closed') { pt.state = 'opening'; say(s, '🌀 they are at the point — the way home is opening'); }
  pt.progress += MT.TIME.step;
  if (pt.progress >= P.open) openPortal(s, null, '🌀 the way home is open');
}

/**
 * A defence runs on past its own terms for as long as the squad is willing, and the willingness
 * is the same judgement they use for everything else: fresh enough, enough of them, inside the
 * clock. `leaveNow` is the player overruling that from the panel.
 */
function overtime(s) {
  const pt = s.portal;
  if (!pt || pt.mode !== 'standfast' || pt.state !== 'open') return;
  if (s.overtime === undefined) s.overtime = 0;
  if (!stillHolding(s)) return;
  s.overtime += MT.TIME.step;
  // the portal follows them: they are still fighting over this ground, not standing on a mark
  const at = squadPoint(s);
  if (at) { pt.x = at.x; pt.y = at.y; }
  if (s.overtime % OVERTIME_CALL === 0) say(s, `⏱️ ${MT.realClock(s.overtime * MT.TIME.scale)} held past the terms, and still paying`);
}

const OVERTIME_CALL = 60;   // in-game seconds between "still here" lines while a defence runs on

/**
 * Whether the squad is still choosing to hold rather than step through.
 *
 * NOT pushingOn(). Pushing on is greed — going looking for more work while the clock allows —
 * and it stops at four fifths of the estimate. Holding ground is not that: the estimate WAS how
 * long somebody thought this would take, and being past it is not a reason to step off a bridge
 * you are already standing on. What stops a defence is the same two things that stop everything
 * else — too few of them, too hurt — plus the cap, which is what the payout is measured against.
 */
function holdingOn(s) {
  const w = willOf(s).push;
  const crew = squadOn(s);
  if (!crew.length || crew.length < s.partySize * w.crew) return false;
  const hp = crew.reduce((t, x) => t + (x.maxHp ? x.hp / x.maxHp : 1), 0) / crew.length;
  return hp >= w.hp;
}

/** Why a defence stopped defending. Read, not remembered: the cap can be crossed mid-step. */
function holdOverWhy(s) {
  if (s.leaveNow) return 'called back';
  if (s.withdrew) return 'they are done here';
  if ((s.overtime || 0) >= s.mission.duration * P.overtime) return 'the relief is here';
  if (!holdingOn(s)) return 'they have had enough of this ground';
  return 'that is the job';
}

function stillHolding(s) {
  const pt = s.portal;
  if (!pt || pt.mode !== 'standfast' || pt.state !== 'open') return false;
  if (s.leaveNow || s.withdrew || s.phase === 'leaving') return false;
  return (s.overtime || 0) < s.mission.duration * P.overtime && holdingOn(s);
}

/** The player, from the panel: stop holding and go. */
function callBack(s) {
  if (!s || s.result) return false;
  s.leaveNow = true;
  return true;
}

/**
 * What has touched the squad, as a list of reasons, in this order: 'sighted' (a hostile has spotted
 * it), 'fight' (a skirmish has opened) and 'fall' (a squad member is down). Empty until one is true.
 * All three are read from saved state that nothing resets: counters.sightings and counters.fights
 * are saved with the counters (counters.spotted is reset by the 'quiet' side job and is not read),
 * and descend() keeps the bodies of the fallen on the actor list, so a reload, a quiet job or a
 * walk down the stairs cannot make a touched squad read as untouched. This is the one definition of
 * contact: sortie.js offers a free call-off only while it is empty, states the reasons once it is
 * not, and abandon() refunds a trial fee and skips the debrief only while it is empty.
 */
const contact = (s) => [
  ...((s.counters.sightings || 0) > 0 ? ['sighted'] : []),
  ...((s.counters.fights || 0) > 0 ? ['fight'] : []),
  ...(s.actors.some(a => a.role === 'squad' && !a.alive) ? ['fall'] : []),
];
const contacted = (s) => contact(s).length > 0;

/**
 * The player, from the panel: the squad stops working and makes for the way out, by the same
 * withdrawal it makes on its own (broken(), a lost fight). The way out, the bound on the walk
 * (STRAGGLE in verdict()) and the verdict are those of any withdrawal: the contract ends as a loss
 * unless its terms are met before the squad is out. An open fight is not interrupted. It plays
 * out, its dead fall when the playback ends (kill()), and the squad walks once it is over.
 * Refused only when a withdrawal is already under way, or the run already has its result.
 */
function retreat(s) {
  if (!s || s.result || s.withdrew) return false;
  withdraw(s, 'called back', true);
  return true;
}

// ---------- objectives ----------

const killed = (s, role) => s.counters.killed[role] || 0;
function inZone(s, who, zoneName) {
  const z = s.map.zones[zoneName];
  if (!z) return 0;
  return s.actors.filter(a => a.alive && matches(a, who) && dist2(a, z) <= z.r).length;
}
// 'all' is everyone who set out - miss it and somebody died. 'living' is everyone still
// standing, which is the only honest way to ask a squad that took casualties to come home.
const wanted = (s, n) => n === 'all' ? s.partySize : n === 'living' ? squadAlive(s).length : n;

// `reach` is true only while someone is standing there. Left unlatched, walking away from the
// vault un-completes the objective and the squad turns around and goes back for it, forever.
const LATCHING = new Set(['reach']);
const latchKey = (a) => a.atom + ':' + (a.zone || a.who || a.what || '') + ':' + (a.n || a.count || '');

function winMet(s, a) {
  if (LATCHING.has(a.atom)) {
    if (s.latched[latchKey(a)]) return true;
    if (rawWin(s, a)) { s.latched[latchKey(a)] = true; return true; }
    return false;
  }
  return rawWin(s, a);
}

function rawWin(s, a) {
  switch (a.atom) {
    case 'kill':      return a.count === 'all'
      ? s.spawnsDone && !s.actors.some(x => x.role === a.of && x.alive)
      : killed(s, a.of) >= a.count;
    case 'eliminate': return named(s, a.who).length > 0 && named(s, a.who).every(x => !x.alive);
    case 'subdue':    return named(s, a.who).some(x => x.subdued);
    case 'destroy':   return (s.counters.destroyed[a.what] || 0) >= (a.count || 1);
    case 'gather':    return s.counters.gathered >= a.count;
    case 'reach':     return inZone(s, a.who, a.zone) >= wanted(s, a.n);
    case 'hold':      return s.counters.held >= a.seconds;
    case 'survive':   return s.clock >= a.seconds && squadAlive(s).length >= wanted(s, a.n);
    case 'protect':   return named(s, a.who).length === 0 || named(s, a.who).some(x => x.alive);
    case 'extract':   return s.actors.filter(x => x.extracted && matches(x, a.who)).length >= wanted(s, a.n);
    case 'descend':   return s.counters.floor >= a.floors;
    case 'reveal':    return s.counters.revealed >= s.walkable * a.fraction;
    default:          return false;
  }
}

/**
 * The ground being defended and how far through defending it they are, 0..1, or null if this
 * contract is not about ground. One reading for two atoms: `hold` counts seconds STOOD on the
 * point and `survive` counts seconds survived, and from the outside both are the same ring
 * closing. fieldview.js draws it round the zone itself, which is the only progress bar in the
 * game that is in the same place as the thing it is measuring.
 */
function defenceProgress(s) {
  const held = s.mission.win.find(a => a.atom === 'hold');
  if (held) return { zone: s.holdZone || held.zone, frac: Math.min(1, s.counters.held / held.seconds), done: s.counters.held >= held.seconds };
  const bell = s.mission.win.find(a => a.atom === 'survive');
  if (bell) return { zone: s.holdZone, frac: Math.min(1, s.clock / bell.seconds), done: s.clock >= bell.seconds };
  return null;
}

/**
 * A hardcore contract does not end when it goes wrong: the objective is replaced by a worse one.
 * The terms collapse to getting somebody out alive on a short clock, the pressure turns up and
 * the map comes for them. It happens ONCE — a squad that fails the escape has failed — and never
 * on a wipe, because there is nobody left to run. sortie.js pays a fraction for an escape.
 */
const canEscalate = (s, atom) => s.mission.twists.includes('hardcore') && !s.escalated && atom !== 'wipe';

function escalate(s, why) {
  const m = s.mission;
  const esc = MT.ESCALATION[m.type] || MT.ESCALATION.default;
  s.escalated = { why, at: s.clock, was: m.label };
  m.win = [MT.OBJ.extract('squad', 1)];
  m.lose = [MT.FAIL.wipe(), MT.FAIL.timeout()];
  m.bonus = [MT.OBJ.extract('squad', 'all')];
  m.duration = s.clock + esc.seconds;
  // An escape needs a door. Whatever kind of way home this contract had, it is now a window
  // being held open by somebody who is about to stop: one body through it completes the job.
  m.exitMode = 'window';
  s.portal = { ...makePortal(s), mode: 'window', state: 'open', shutsAt: m.duration, openedAt: s.clock };
  m.orders = 'avoid';
  m.pressure = esc.pressure;
  s.latched = {};
  s.phase = 'in';
  s.pushed = false;
  raise(s, squadOn(s)[0] || s.map.entry);            // everything that can hear them, has
  for (const g of s.map.spawns) {                    // and more of it is coming
    if (g.role !== 'hostile' && g.role !== 'patrol') continue;
    spawnGroup(s, g, Math.max(1, Math.round((g.count || 0) * 0.5)));
  }
  say(s, `‼️ ${esc.line}`);
  say(s, `New terms: ${m.win.map(MT.objectiveText).join(' + ')}, inside ${MT.realClock(esc.seconds * MT.TIME.scale)}`);
}

function failure(s) {
  for (const a of s.mission.lose) {
    const of = a.who || a.what;
    switch (a.atom) {
      case 'wipe':     if (squadAlive(s).length <= a.standing) return { won: false, why: 'the squad is down', atom: 'wipe' }; break;
      case 'died':     if (named(s, of).length && named(s, of).every(x => !x.alive && !x.subdued)) return { won: false, why: `the ${of} is dead`, atom: 'died' }; break;
      case 'killed':   if (named(s, of).some(x => !x.alive && !x.subdued)) return { won: false, why: `the ${of} was killed, not taken`, atom: 'killed' }; break;
      case 'timeout':  if (s.clock >= s.mission.duration) return { won: false, why: 'the clock ran out', atom: 'timeout' }; break;
      case 'breached': if (named(s, of).length && named(s, of).every(x => !x.alive)) return { won: false, why: `the ${of} fell`, atom: 'breached' }; break;
      case 'lost':     if (s.counters.lost >= LOSE_GROUND) return { won: false, why: `the ${a.zone} was taken`, atom: 'lost' }; break;
      case 'fled':     if (named(s, of).some(x => x.extracted && x.alive)) return { won: false, why: `the ${of} got away`, atom: 'fled' }; break;
      case 'spotted':  if (s.counters.spotted > a.budget) return { won: false, why: 'they were seen', atom: 'spotted' }; break;
    }
  }
  return null;
}

function verdict(s) {
  const bad = failure(s);
  if (bad) {
    if (canEscalate(s, bad.atom)) { escalate(s, bad.why); return null; }
    return bad;
  }
  // A hardcore contract is timed even when its type has no timeout atom. Escalation fires off a
  // failure atom, and ten of the sixteen types have no failure but `wipe` — which never escalates,
  // because there is nobody left to run. So on those the twist was a 60% price for a
  // complication that could not happen. Running past the estimate with the work still unfinished
  // is what goes wrong; once it IS finished the walk home has its own rules and a job that is
  // already done does not get taken away.
  if (!s.doneAt && s.clock >= s.mission.duration && canEscalate(s, 'timeout')) {
    escalate(s, 'this has run long, and something has noticed');
    return null;
  }
  // a side job that breaks the other side ends it there and then
  if (s.sideWin) return { won: true, why: `${s.sideWin.label.toLowerCase()} — the rest of them break`, side: s.sideWin.id };
  // Terms are read before the withdrawal flag: a squad that withdrew but met the terms has
  // completed the job. The old order showed two green ticks and then logged a failure, so the
  // panel and the log gave the player two different answers.
  const done = s.mission.win.every(a => winMet(s, a));
  // they decided to go home, and everyone who could has
  if (s.withdrew && !done) {
    // they are leaving; it ends when they are off the map, or when it is clear they cannot get there
    if (!squadOn(s).length) return { won: false, why: s.withdrew.why };
    // ...unless the way home is shut and known to be coming back: that is not a stalled run,
    // it is the worst part of a window contract, and it has its own clock already.
    const stranded = s.portal && s.portal.state === 'shut';
    if (!stranded && s.clock - s.withdrew.at > STRAGGLE) return { won: false, why: `${s.withdrew.why}, and could not get clear` };
  }
  if (done) {
    // A mission with no walk home ends the instant the quota is met, which is exactly when an
    // overachieving squad wants to keep going. Hold the verdict while they are still working.
    const gamble = (s.side || []).find(j => !j.done && j.effect === 'escalate');
    if (gamble && !s.escalated && pushingOn(s)) {
      const who = s.actors.find(x => x.id === gamble.taker);
      if (who && who.alive) {
        gamble.done = true;
        say(s, `🎲 ${label(who)} is not satisfied with that`);
        escalate(s, 'they went looking for more');
        return null;
      }
    }
    const more = stretchGoals(s);
    if (more.length && pushingOn(s)) { notePush(s, more); return null; }
    if (s.pushed && !s.pushedDone) { s.pushedDone = true; say(s, '👍 that will do'); }
    return {
      won: true,
      why: s.escalated ? 'they got out' : s.withdrew ? 'the terms were met, barely' : 'the terms are met',
      escaped: !!s.escalated,
    };
  }
  // There are two separate time limits. Before the work is done, a mission that has stopped
  // making progress is abandoned. After it is done, the squad is not going nowhere — they are
  // waiting on the way home, which may be shut for minutes at a time — so the bound is how long
  // the walk out is allowed to take, and failing it says what actually happened.
  if (!s.withdrew && !s.doneAt && s.clock >= s.mission.duration * ABANDON) {
    withdraw(s, 'this is going nowhere');
  }
  if (s.doneAt && s.clock - s.doneAt > Math.max(STRAGGLE, s.mission.duration)) {
    return { won: false, why: 'the work was done and they never got home' };
  }
  return null;
}

// ---------- arrivals ----------

function spawnGroup(s, g, n = g.count, note = null) {
  const pts = g.points.length ? g.points : [s.map.zones.extraction || s.map.entry];
  for (let i = 0; i < n; i++) {
    const p = pts[i % pts.length];
    s.actors.push(makeActor(g, p, s));
  }
  if (note) say(s, note);
}

// What a hostile is CALLED is a bestiary question, and this file has no bestiary: it knows the
// mission's theme tags and the group's grade, and hands both to whoever does. Without a namer
// the log says "elite", which is honest and dull.
// What a hostile is WORTH is asked the same way: start() and restore() take rate(species, group,
// mission) and expect { power, hp, guard } back, or null for no answer. makeActor is the only
// constructor of hostile actors, so initial spawns, waves and escalation all go through it.
// Without a rate, or when it answers null, GRADE_POWER and GRADE_HP stand in.
const plainName = (g) => ({ label: g.name || g.kind || g.grade || g.role });

function makeActor(g, p, s = null) {
  // Only the other side gets a species: an escorted merchant is not a Goblin. A mark keeps its
  // handle ('guardian') as its NAME, because that is what the objectives point at, and wears the
  // species as its LABEL — so the terms still say "kill the guardian" while the log says what it
  // turned out to be. Skipping named groups here left every mark with no combatant at all.
  const wild = ['hostile', 'patrol', 'mark'].includes(g.role) && g.side !== 'ours';
  const named_ = (s && s.name && wild) ? s.name(g, s.mission) : null;
  // What the species is worth, when whoever runs this field can say (sortie.js rateFoe). It already
  // includes the mission level and the group's levelOffset, so SWARMED does not apply to it.
  const rated = (s && s.rate && named_ && named_.id) ? s.rate(named_.id, g, s.mission) : null;
  // a group that states its own hp (a structure) keeps it
  const hp = g.hp ? Math.round(g.hp * SWARMED(g)) : rated ? rated.hp : Math.round((GRADE_HP[g.grade] || 20) * SWARMED(g));
  const side = g.side === 'ours' ? 'ours'
    : g.side === 'neutral' ? 'neutral'
    : ['ward', 'ally', 'prize'].includes(g.role) ? 'ours' : 'theirs';
  return actor({
    role: g.role, kind: g.kind, grade: g.grade, side,
    name: g.name || g.kind || g.role,
    label: (named_ && named_.label) || g.name || g.kind || `${g.grade || g.role}`,
    icon: named_ && named_.icon, sprite: named_ && named_.sprite, species: named_ && named_.id,
    x: p.x, y: p.y,
    // A horde member is spawned below the mission's own level (missiontypes.js swarm), so it is a
    // smaller body here too — otherwise the plain attrition model and everything that reads
    // `power` to judge a threat would see forty full-grade monsters where there are forty runts.
    horde: g.horde, levelOffset: g.levelOffset,
    hp, maxHp: hp,
    power: g.role === 'structure' ? 0 : rated ? rated.power : (GRADE_POWER[g.grade] || 1) * (g.role === 'mark' ? 1.5 : 1) * SWARMED(g),
    guard: rated ? rated.guard : undefined,
    // A species contributes a mind and a speed. The bestiary's int and wis are how far this thing
    // thinks — whether it collects the others before it closes (rally) — and its dex is how fast
    // it walks, which decides whether a squad can run from it.
    wits: named_ && named_.attrs ? (named_.attrs.int + named_.attrs.wis) / 2 : (GRADE_WITS[g.grade] || 3),
    speed: g.role === 'structure' || g.role === 'prize' ? 0 : BASE_SPEED * (g.speed || speedOf(named_)),
    captive: g.captive, flees: g.flees, subdueAt: g.subdueAt, escapesAt: g.escapesAt,
  });
}

/** How fast a species walks, from its dex: a rat is slower than a person, a hawk is not. */
function speedOf(named_) {
  if (!named_ || !named_.attrs) return 1;
  let v = 0.7 + named_.attrs.dex / 30;
  if ((named_.tags || []).includes('large')) v -= 0.1;
  return Math.max(0.5, Math.min(1.25, v));
}

/** Waves, minutes, bouts and phases. Whatever the clock owes, it pays here. */
function arrivals(s) {
  const m = s.mission, spawns = s.map.spawns;
  const per = (kind) => spawns.filter(g => g.per === kind);
  const cued = (at) => spawns.filter(g => g.at === at);

  if (m.waves) {
    const every = Math.max(20, Math.round(m.duration / (m.waves + 1)));
    const due = Math.min(m.waves, Math.floor(s.clock / every) + 1);
    while (s.wave < due) {
      s.wave++;
      const last = s.wave === m.waves;
      for (const g of per('wave')) if (!g.from || s.wave >= g.from) spawnGroup(s, g);
      if (last) for (const g of cued('last-wave')) spawnGroup(s, g);
      say(s, `🌊 wave ${s.wave}${last ? ' — the last of them' : ''} of ${m.waves}`);
    }
    if (s.wave >= m.waves && !s.skirmishes.length) s.spawnsDone = true;
  }

  if (m.ramp) {                                   // endless: a fresh set every in-game minute
    const due = Math.floor(s.clock / 60) + 1;
    while (s.wave < due) {
      s.wave++;
      const extra = 1 + m.ramp * s.wave;
      for (const g of per('minute')) if (!g.from || s.wave >= g.from) spawnGroup(s, g, Math.round(g.count * extra));
      say(s, `🌊 minute ${s.wave} — ${Math.round((extra - 1) * 100)}% more of them than the first`);
    }
  }

  if (m.bouts) {
    const fighting = s.actors.some(a => isTheirs(a) && a.alive);
    if (!fighting && s.wave < m.bouts) {
      s.wave++;
      const last = s.wave === m.bouts;
      for (const g of per('bout')) spawnGroup(s, g);
      if (last) for (const g of cued('last-bout')) spawnGroup(s, g);
      say(s, `🏟️ bout ${s.wave} of ${m.bouts}${last ? ' — the last card' : ''}`);
      if (last) s.spawnsDone = true;
    }
  }

  if (m.phases) {                                 // a raid: the thing changes as it is worn down
    const boss = s.actors.find(a => a.role === 'mark' && a.alive);
    if (boss) {
      const phase = Math.min(m.phases, 1 + Math.floor((1 - boss.hp / boss.maxHp) * m.phases));
      while (s.wave < phase) {
        s.wave++;
        for (const g of per('phase')) spawnGroup(s, g);
        if (s.wave > 1) say(s, `🐉 ${label(boss)} changes — phase ${s.wave} of ${m.phases}`);
      }
    }
  }

  if (!m.waves && !m.ramp && !m.bouts && !m.phases) s.spawnsDone = true;
}

// ---------- floors ----------

function descend(s) {
  if (s.map.floors <= 1) return;
  const z = s.map.zones.stairs;
  if (!z || s.floorNo >= s.map.floors) return;
  if (!squadOn(s).some(a => dist2(a, z) <= 1)) return;
  if (s.skirmishes.length) return;

  s.floorNo++;
  s.counters.floor = s.floorNo;
  const carried = s.actors.filter(a => a.alive && isOurs(a));
  // A squad member who fell stays on the list. sortie.js release() retires the dead through their
  // actor, and a member with no actor reads as alive: freed, with no memorial entry. Every reader
  // of a squad position filters on `alive`, so the body only needs a tile inside the new map.
  const fallen = s.actors.filter(a => a.role === 'squad' && !a.alive);
  const last = s.floorNo >= s.map.floors;
  s.map = MG.build(s.mission, { floor: s.floorNo });
  s.walkable = MG.floorTiles(s.map.tiles).length;
  s.seen = new Uint8Array(s.map.w * s.map.h);
  s.counters.revealed = 0;
  s.fields = {};
  s.actors = [...carried, ...fallen];
  // by place in the squad, not by id: ids come from a counter that runs across missions, so a
  // rank read off them put the same squad on different tiles depending on what was played before
  carried.forEach((a, i) => { a.x = s.map.entry.x + (i % 3) - 1; a.y = s.map.entry.y; a.px = a.x; a.py = a.y; });
  for (const a of fallen) { a.x = s.map.entry.x; a.y = s.map.entry.y; a.px = a.x; a.py = a.y; }
  for (const g of s.map.spawns) {
    if (g.per === 'floor') spawnGroup(s, g);
    else if (g.at === 'floor-end') spawnGroup(s, g);
    else if (g.at === 'last-floor') { if (last) spawnGroup(s, g); }
    else if (!g.deferred && g.role === 'structure') spawnGroup(s, g);
  }
  s.alarm = false; s.alarmUntil = 0; s.alarmAt = null;
  // The way home is a place on a map, and this is a different map: a portal left pointing at
  // the stairwell of the floor above is one nobody can ever reach. The SCHEDULE survives the
  // walk down — a window that is already counting down does not restart because they descended.
  const was = s.portal;
  s.portal = makePortal(s);
  if (was) { s.portal.state = was.state; s.portal.shutsAt = was.shutsAt; s.portal.opensAt = was.opensAt; s.portal.missed = was.missed; }
  say(s, `🪜 down to floor ${s.floorNo}${last ? ' — the bottom' : ''}`);
}

// ---------- the rest of a second ----------

/** Nodes get worked, gates get broken. Never our own: a garrison does not demolish its keep. */
function work(s) {
  for (const t of s.actors) {
    if (!t.alive || t.role !== 'structure' || t.done || isOurs(t) || t.kind === 'trap') continue;
    const hands = squadOn(s).filter(o => dist2(o, t) <= 1 && !o.engaged).length;
    if (!hands) continue;
    t.work = (t.work || 0) + hands;
    const gatherable = t.kind === 'node' || t.kind === 'cache';
    const needed = gatherable ? 25 : Math.max(12, t.maxHp / 14);
    if (t.work < needed) continue;
    t.done = true;
    if (gatherable) { s.counters.gathered++; say(s, `⛏️ a ${t.kind} is emptied (${s.counters.gathered})`); }
    else { kill(s, t); say(s, `💥 the ${t.kind} comes down`); }
  }
}

/** A trap is not a thing you demolish. It is a thing you walk onto. */
function traps(s) {
  for (const t of s.actors) {
    if (!t.alive || t.kind !== 'trap') continue;
    const victim = squadOn(s).find(o => o.x === t.x && o.y === t.y);
    if (!victim) continue;
    t.alive = false;
    victim.hp -= Math.max(4, t.maxHp * 0.3);
    say(s, `🪤 ${label(victim)} sets one off`);
    if (victim.hp <= 0) kill(s, victim);
  }
}

function holdGround(s) {
  if (!s.mission.win.some(a => a.atom === 'hold')) return;
  const z = s.map.zones[s.holdZone];
  if (!z) return;
  const ours = squadOn(s).filter(a => dist2(a, z) <= z.r).length;
  const theirs = s.actors.filter(a => a.alive && isTheirs(a) && a.role !== 'structure' && dist2(a, z) <= z.r).length;
  // Standing on the point counts as holding it, fight or no fight. The old rule only counted
  // seconds when the ground was uncontested, which is nearly none of them: the enemy arrives, the
  // counter stops, and the clock runs out with a point the squad never left. Ground is lost only
  // by being off it.
  if (ours) { s.counters.held += MT.TIME.step; s.counters.lost = 0; s.reached = true; }
  else if (s.reached && theirs) s.counters.lost += MT.TIME.step;
  else if (s.reached) s.counters.lost = Math.max(0, s.counters.lost - MT.TIME.step);
}

/** Whatever is being carried goes where its carrier goes. */
function carry(s) {
  for (const p of s.actors) {
    if (p.alive === false && !p.subdued) continue;
    if (p.role !== 'prize' && !p.subdued) continue;
    if (!p.carriedBy) {
      const hand = squadOn(s).find(o => dist2(o, p) <= 1 && !o.engaged);
      if (!hand) continue;
      p.carriedBy = hand.id;
      say(s, `🎒 ${label(hand)} takes the ${p.name}`);
    }
    const c = s.actors.find(a => a.id === p.carriedBy);
    if (!c || !c.alive) { p.carriedBy = null; continue; }
    p.x = c.x; p.y = c.y;
    if (c.extracted && !p.extracted) { p.extracted = true; say(s, `📦 the ${p.name} is out`); }
  }
}

function leave(s) {
  const outs = s.mission.win.filter(a => a.atom === 'extract');
  if (!outs.length) return;
  // everything but the walk home, INCLUDING whatever they came to carry being in hand
  if (!workDone(s)) return;
  // Terms met, still healthy, clock to spare: they keep working instead of walking out — but
  // only while they are actually GOING somewhere to work. A stretch goal with nothing left to
  // walk at (the last of them unfindable, the last node unreachable) is not a reason to hold
  // the squad on the map; without this they stand in the open doorway until the push window
  // closes, which is the same bug seen from the other end.
  const more = stretchGoals(s);
  const working = squadOn(s).some(a => a.goal && a.goal.kind !== 'exit');
  if (more.length && working && pushingOn(s)) { notePush(s, more); return; }
  if (s.pushed && !s.pushedDone) { s.pushedDone = true; say(s, '👍 that will do'); }
  // A defence is not finished until they choose to be. While they are still holding the ground
  // the portal is open at their feet and nobody walks through it.
  if (stillHolding(s)) return;
  if (s.phase !== 'leaving') {
    s.phase = 'leaving';
    // an escort is "leaving" from its first second, so do not tell the player the job is done
    const cargo = outs.map(o => o.who).filter(w => w && w !== 'squad');
    // portalTick() runs first, so by now they may already BE at the point — telling them to
    // make for it reads as a bug even though it is only a stale line
    const there = s.portal && s.portal.state !== 'closed';
    say(s, s.portal && s.portal.mode === 'standfast'
      ? `🚪 ${holdOverWhy(s)} — through the portal`
      : cargo.length && s.clock <= 3
        ? `🚪 the ${cargo[0]} is with them — make for the extraction point`
        : there
          ? `🚪 nothing left to do here — and they are standing on the way out`
          : `🚪 nothing left to do here — back to the extraction point`);
  }
  // Leaving requires an open portal. Standing on the point is arriving; going home needs the
  // portal actually open. That is the only difference between the three kinds of contract and the
  // reason a mission no longer ends the second its last box is ticked.
  if (!portalOpen(s)) return;
  // Nobody the squad came to bring out walks through the gate last. Cargo that is CARRIED goes
  // out in somebody's arms, so its carrier still leaves; cargo on its own legs is waited for,
  // or the guards extract off the map and leave the ward to finish the walk alone.
  const walking = outs.some(o => o.who && o.who !== 'squad' &&
    named(s, o.who).some(x => (x.alive || x.subdued) && !x.extracted && !x.carriedBy && x.speed > 0));
  for (const a of onMap(s)) {
    if (!isOurs(a) || a.engaged || a.role === 'prize') continue;
    if (walking && a.role === 'squad') continue;
    if (inPortal(s, a)) { a.extracted = true; say(s, `${label(a)} is out`); }
  }
  // the ward makes its own way to the exit and does not wait to be told
  for (const w of onMap(s).filter(a => a.role === 'ward' && a.speed)) {
    if (inPortal(s, w) && !w.extracted) { w.extracted = true; say(s, `🚪 the ${w.name} is delivered`); }
  }
}

/** A mark that reaches its own bolt-hole is gone for good. */
function escapes(s) {
  for (const a of s.actors) {
    if (!a.alive || a.role !== 'mark' || a.extracted) continue;
    const z = s.map.zones[a.escapesAt || 'far-exit'];
    if (z && dist2(a, z) <= 1) { a.extracted = true; say(s, `🏃 ${label(a)} is gone`); }
  }
}


// ---------- saving a run in progress ----------
//
// A mission is minutes of real time and the browser can be closed in the middle of one. What is
// worth keeping is small: the tiles, who is standing where, and how hurt they are. Everything
// else — distance fields, goals, pathing, the sprites and the pogs — is rebuilt on the way back
// in, because it is all derived and none of it is worth a byte of storage.
//
// The one thing that cannot survive the trip is a fight that is halfway through its playback, so
// saving FLUSHES it: the remaining lines land, the dead fall, and the save is taken at a clean
// moment between fights rather than inside one.

const SAVE_V = 1;
const b64 = (u8) => {
  let out = '';
  for (let i = 0; i < u8.length; i += 0x8000) out += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(out);
};
const unb64 = (str) => {
  const bin = atob(str);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
};

// `low` is the lowest HP fraction a squad member had at the end of any fight (sortie.js resolve).
// A resumed run keeps it, because Missions.debrief turns it into a wound when the run settles.
const ACTOR_KEYS = ['id', 'role', 'kind', 'grade', 'side', 'name', 'label', 'species', 'icon',
  'x', 'y', 'px', 'py', 'hp', 'maxHp', 'power', 'guard', 'speed', 'move',
  'alive', 'extracted', 'subdued', 'spotted', 'found', 'done', 'work', 'freed', 'captive', 'flees',
  'subdueAt', 'escapesAt', 'carriedBy', 'noFightUntil', 'ring', 'sideJob', 'horde', 'levelOffset',
  'resolve', 'floor', 'panicUntil', 'sneak', 'kit', 'cowedUntil', 'wits', 'lastSeen', 'lastAt', 'low'];

/** End every fight that is midway through its playback, right now. */
function flushSkirmishes(s) {
  for (const sk of s.skirmishes) {
    while (sk.at < sk.log.length) say(s, '   ' + sk.log[sk.at++]);
    for (const d of sk.dead) kill(s, d);
    for (const a of [...sk.ours, ...sk.theirs]) if (a.engaged === sk) a.engaged = null;
  }
  s.skirmishes = [];
}

function saveActor(a) {
  const o = {};
  for (const k of ACTOR_KEYS) if (a[k] !== undefined) o[k] = a[k];
  if (a.char) o.charId = a.char.id;
  // a combatant is rebuilt from the character or the bestiary; only its wounds and its cast count
  // are kept. The cast count is what Missions.debrief charges the caster pool for at the end of the run.
  if (a.fighter) {
    o.combat = { hp: a.fighter.hp };
    if (a.fighter.pools) {
      o.combat.pools = {};
      for (const [k, p] of Object.entries(a.fighter.pools)) o.combat.pools[k] = p.cur;
    }
    if (a.fighter.stats && a.fighter.stats.casts) o.combat.casts = a.fighter.stats.casts;
  }
  return o;
}

/** Everything needed to pick this mission up again, as plain JSON. */
function save(s) {
  flushSkirmishes(s);
  return {
    v: SAVE_V,
    clock: s.clock, floorNo: s.floorNo, wave: s.wave, spawnsDone: s.spawnsDone, reached: s.reached,
    phase: s.phase, alarm: s.alarm, alarmAt: s.alarmAt, alarmUntil: s.alarmUntil,
    latched: s.latched, counters: s.counters, partySize: s.partySize, sight: s.sight,
    escalated: s.escalated || null, pushed: !!s.pushed, pushedDone: !!s.pushedDone,
    portal: s.portal || null, overtime: s.overtime || 0, leaveNow: !!s.leaveNow, doneAt: s.doneAt || null,
    withdrew: s.withdrew || null, side: s.side || [], sideWin: s.sideWin || null, will: s.will || null,
    details: (s.details || []).map(d => ({ ...d })),
    scout: s.scout, beacon: s.beacon, beaconAt: s.beaconAt, heading: s.heading,
    walkable: s.walkable, result: s.result,
    objectiveZone: s.objectiveZone, holdZone: s.holdZone,
    mission: s.mission,
    seen: b64(s.seen),
    map: {
      w: s.map.w, h: s.map.h, floor: s.map.floor, floors: s.map.floors,
      archetype: s.map.archetype, gen: s.map.gen, zones: s.map.zones, spawns: s.map.spawns,
      rooms: s.map.rooms, entry: s.map.entry, tiles: b64(s.map.tiles.cells),
    },
    actors: s.actors.map(saveActor),
    log: s.log.slice(-300),
  };
}

/**
 * Put a saved run back on its feet. `characters` maps a saved charId back to the real character,
 * so the squad walks in as itself rather than as a copy.
 */
function restore(o, { resolve = attrition, name = plainName, rate = null, characters = {}, grieve = null, tactics = null, sighted = null } = {}) {
  if (!o || o.v !== SAVE_V) return null;
  const tiles = MG.gridFrom(o.map.w, o.map.h, unb64(o.map.tiles));
  const map = {
    ...o.map, tiles,
    at: tiles.at, passable: tiles.passable, opaque: tiles.opaque,
    dist: MG.distanceField(tiles, [[o.map.entry.x, o.map.entry.y]]),
  };
  const s = {
    mission: o.mission, map, resolve, name, rate, walkable: o.walkable,
    clock: o.clock, floorNo: o.floorNo, wave: o.wave, spawnsDone: o.spawnsDone, reached: o.reached,
    sighted,
    actors: [], log: o.log || [], pending: [], skirmishes: [], fields: {},
    seen: unb64(o.seen), alarm: o.alarm, alarmAt: o.alarmAt, alarmUntil: o.alarmUntil,
    phase: o.phase, result: o.result, latched: o.latched || {}, counters: o.counters,
    partySize: o.partySize, sight: o.sight,
    escalated: o.escalated || null, pushed: !!o.pushed, pushedDone: !!o.pushedDone,
    // a run saved before there were portals rebuilds one on its first step, from its own terms
    portal: o.portal || null, overtime: o.overtime || 0, leaveNow: !!o.leaveNow, doneAt: o.doneAt || null,
    withdrew: o.withdrew || null, side: o.side || [], sideWin: o.sideWin || null, will: o.will || WILL,
    details: o.details || [], nextPlan: 0, grieve, tactics,
    scout: o.scout || 0, omniscient: (o.scout || 0) >= SCOUT_PERFECT, heading: o.heading || null,
    beacon: o.beacon || null, beaconAt: o.beaconAt || 0,
    objectiveZone: o.objectiveZone, holdZone: o.holdZone,
  };
  for (const a of o.actors) {
    const act = actor({ ...a, goal: null, engaged: null });
    act.id = a.id;
    if (a.charId != null && characters[a.charId]) act.char = characters[a.charId];
    if (a.combat) act.combat = a.combat;              // sortie.js pours this back into a fighter
    s.actors.push(act);
  }
  nextId = Math.max(nextId, ...s.actors.map(a => a.id || 0)) + 1;
  // a save from before counters.sightings: the hostiles that had spotted the squad are still on the list
  if (s.counters.sightings === undefined) s.counters.sightings = s.actors.filter(a => a.spotted).length;
  return s;
}

// ---------- start and step ----------

function start(mission, { party = [], resolve = attrition, name = plainName, rate = null, floor = 1, scout = 0, will = null, grieve = null, tactics = null, kit = null, sighted = null } = {}) {
  const map = MG.build(mission, { floor });
  const s = {
    mission, map, resolve, name, rate, walkable: MG.floorTiles(map.tiles).length,
    clock: 0, floorNo: floor, wave: 0, spawnsDone: false, reached: false, sighted,
    actors: [], log: [], pending: [], skirmishes: [], fields: {},
    seen: new Uint8Array(map.w * map.h), phase: 'in', result: null, latched: {},
    alarm: false, alarmAt: null, alarmUntil: 0,
    portal: null, overtime: 0, leaveNow: false, doneAt: null,
    partySize: party.length,
    scout, omniscient: scout >= SCOUT_PERFECT, beacon: null, beaconAt: 0, heading: null,
    will: will || WILL, grieve, tactics, details: [], nextPlan: 0,
    sight: mission.twists.includes('night') ? Math.round(SIGHT / 2) : SIGHT,
    counters: { killed: {}, destroyed: {}, gathered: 0, revealed: 0, spotted: 0, sightings: 0, held: 0, floor: 1, lost: 0, fights: 0, stepsBack: 0 },
  };

  party.forEach((c, i) => s.actors.push(actor({
    role: 'squad', side: 'ours', name: 'squad', label: c.name || `#${i + 1}`, char: c,
    x: map.entry.x + (i % 3) - 1, y: map.entry.y + Math.floor(i / 3),
    hp: c.maxHp || 60, maxHp: c.maxHp || 60,
    power: c.power || 4, guard: c.guard, speed: BASE_SPEED * (c.speed || 1),
    // what the class can do to the MAP (classes.js fieldKit): charges and cooldowns live on the actor
    kit: kit ? (kit(c) || []) : (c.kit || []),
  })));
  for (const g of map.spawns) if (!g.deferred) g.points.forEach(p => s.actors.push(makeActor(g, p, s)));

  s.objectiveZone = ['vault', 'cells', 'keep', 'nest', 'objective', 'point', 'deep', 'stairs']
    .find(z => map.zones[z]) || 'extraction';
  s.holdZone = map.zones.point ? 'point' : map.zones.keep ? 'keep' : s.objectiveZone;

  say(s, `${mission.icon} ${mission.name} — ${mission.label}, ${map.archetype} ${map.w}×${map.h}`);
  say(s, `Terms: ${mission.win.map(MT.objectiveText).join(' + ')}`);
  if (mission.twists.length) say(s, `Complications: ${mission.twists.map(t => MT.TWISTS[t].label).join(', ')}`);
  say(s, `${party.length} through the gate. ${MT.ORDERS[mission.orders]}.`);
  say(s, s.omniscient
    ? '\u{1F9ED} they know this ground: nothing here has to be found first'
    : '\u{1F9ED} nobody here has walked this ground: they will have to look for it');
  s.portal = makePortal(s);
  say(s, '\u{1F300} ' + MT.EXIT_TEXT[s.portal.mode](mission));
  if (!mission.deadline) say(s, '\u{1F553} no clock on this one: it takes as long as it takes');
  assignSideJobs(s);
  return s;
}

/** One in-game second. Returns the lines it produced and whether the mission ended. */
function step(s) {
  s.pending = [];
  if (s.result) return { events: [], done: true };
  s.clock += MT.TIME.step;
  s.fields = {};

  arrivals(s);
  chooseGoals(s);
  // Where everyone was when this second began. The renderer slides px,py -> x,y across the step,
  // so this has to be stamped for EVERY actor every step, not only the ones that move: at 0.55
  // tiles a second most of them stand still on any given tick, and an actor whose px still held
  // the tile it left two ticks ago got re-animated out of it — the tokens visibly bounced.
  for (const a of s.actors) { a.px = a.x; a.py = a.y; }
  for (const a of onMap(s)) {
    if (a.engaged || a.speed <= 0 || !a.goal) continue;
    a.move += a.speed;
    while (a.move >= 1) { stepTile(s, a); a.move -= 1; }
  }
  look(s);
  for (const sk of findSkirmishes(s)) openSkirmish(s, sk);
  runSkirmishes(s);
  work(s);
  traps(s);
  sideCheck(s);
  if (broken(s)) withdraw(s, squadOn(s).length < s.partySize * BROKEN_CREW ? 'too few of them left' : 'they are cut to pieces');
  pullOut(s);
  carry(s);
  holdGround(s);
  descend(s);
  escapes(s);
  portalTick(s);
  overtime(s);
  leave(s);

  const v = verdict(s);
  if (v) {
    s.result = v;
    say(s, v.won ? `✅ ${v.why}` : `❌ ${v.why}`);
    const got = s.mission.bonus.filter(a => !MT.FAIL_ATOMS.includes(a.atom) && winMet(s, a));
    if (v.won && got.length) say(s, `   bonus: ${got.map(MT.objectiveText).join(', ')}`);
  }
  return { events: s.pending, done: !!s.result };
}

/** Run a whole mission with no clock, for tests and balance passes. */
function play(mission, opts = {}) {
  const s = start(mission, opts);
  // the cap is re-read every step: a hardcore mission that goes wrong moves its own deadline,
  // and a loop that measured the finish line once stops before the escape has played out
  // no bound from the clock any more: a mission ends when it ends, and the withdrawal rules
  // guarantee it does. The iteration cap is only a guard against a genuine hang.
  for (let i = 0; i < 40000 && !s.result; i++) step(s);
  return s;
}

const FieldAPI = { start, step, play, save, restore, flushSkirmishes, attrition, plainName, openness, frontage, groundWord, odds, chokepoint, winMet, verdict, failure, pushingOn, stretchGoals, escalate, broken, sideScore, assignSideJobs, escapeHatch, blink, loneTarget,
  portalPoint, portalOpen, inPortal, defenceProgress, stillHolding, holdingOn, callBack, workDone, contact, contacted, retreat, hunting,
  ENGAGE, SIGHT, BASE_SPEED, GRADE_POWER, GRADE_HP, BLINK_COOL, FRONT_OPEN, STRAGGLE, STEPS_BACK, pace,
  hatchLines, brokenLines, explainLines, resolveOf, RESOLVE_CAP, RESOLVE_WEIGHT };
if (typeof module !== 'undefined') module.exports = FieldAPI;
if (typeof window !== 'undefined') window.Field = FieldAPI;
})();
