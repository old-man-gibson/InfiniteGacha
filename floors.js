// Floors: the town as stacked platforms, and who may live how high.
// Browser: window.Floors. Node: module.exports.
//
// Each town tier opens one floor: economy.js TOWN index = index of the highest open floor. Floor 0
// is the ground: the produce buildings (farm, mine, garden), the commons housing (tent,
// bunkhouse), the square, the crystal and the gate. Every floor above it is a raised platform
// (baselayout.js places it, world3d.js draws it) holding the workshops, lodgings and tavern whose
// economy.js `floor` names it.
//   workshops  stand on min(their floor, top floor): they move up when their floor opens
//   lodgings   stand on inst.floor, fixed when ordered; an order needs its floor open
//
// STANDING decides who may LIVE on a floor and drink in its tavern. Work is open to everyone.
//   standing = stars + missions + depth + abilities + grant
//     stars      c.stats.stars, 1..7
//     missions   +1 per MISSIONS_PER sorties gone on (record.out), at most +MISSIONS_CAP
//     depth      +1 per DEPTH_PER floors cleared (record.floorCleared), at most +DEPTH_CAP.
//                Nothing writes record.floorCleared yet; it counts 0 until a system does.
//     abilities  a summon-only class +1 (legendary +2); each gift path past the first +1;
//                a heroic bloodline +1
//     grant      c.standingGrant, set by the player on the character sheet, -GRANT_MAX..+GRANT_MAX
// Floor k admits a character when the floor is open and standing >= FLOORS[k].need.
//
// STATION. Housed below the highest floor their standing reaches costs morale target:
//   -STATION_PER_FLOOR x floors short x (1 + appetite tilt)
// The appetite tilt (temper.js t, -1..+1) is "what they think they are owed": an ascetic (-1)
// loses nothing, an average character 3 a floor, a ravenous one (+1) 6 a floor. Sleeping
// outside counts as floor 0.
//
// TAVERNS (economy.js LODGINGS entries with tavern: true). A finished tavern on floor k serves
// everyone whose standing reaches k. A resting character (no post, not building, not out) uses
// the highest one they may enter: + its `morale` on their morale target (condition.js), and
// company with everyone else drinking there (game.js readCompany, bonds.js 'tavern').

(() => {
const E = () => (typeof Econ !== 'undefined') ? Econ : require('./economy.js');
const LO = () => (typeof Lodging !== 'undefined') ? Lodging : (typeof require !== 'undefined' ? require('./lodging.js') : null);
const TE = () => (typeof Temper !== 'undefined') ? Temper : (typeof require !== 'undefined' ? require('./temper.js') : null);
const CL = () => (typeof Classes !== 'undefined') ? Classes : null;

const FLOORS = [
  { name: 'Fields',        need: 0, colour: '#8fb35a' },
  { name: 'Lower terrace', need: 3, colour: '#c9963f' },
  { name: 'Upper terrace', need: 5, colour: '#5f8fc9' },
  { name: 'High quarter',  need: 7, colour: '#a45fc9' },
  { name: 'Crown',         need: 9, colour: '#e0b84a' },
];
const MISSIONS_PER = 10, MISSIONS_CAP = 4;
const DEPTH_PER = 5, DEPTH_CAP = 3;
const GRANT_MAX = 5;
const STATION_PER_FLOOR = 3;

/** Index of the highest open floor. */
const top = (state) => Math.max(0, Math.min(FLOORS.length - 1, state.town || 0));
const isOpen = (state, k) => k >= 0 && k <= top(state);
/** Where a workshop stands now: its own floor once that is open, the highest open floor before. */
const buildingFloor = (state, key) => Math.min(top(state), (E().BUILDINGS[key] || {}).floor || 0);
/** The floor a lodging type is built on. */
const typeFloor = (type) => (E().LODGINGS[type] || {}).floor || 0;
/** The floor a standing lodging is on (older saves carry none: they were built on the ground). */
const instFloor = (inst) => (inst && inst.floor) || 0;

/** Standing and the terms it is made of, each with the inputs that produced it. */
function standing(c) {
  const r = c.record || {};
  const parts = [];
  const add = (key, label, v, why) => parts.push({ key, label, v, why });
  add('stars', 'Stars', c.stats.stars, `${c.stats.stars}★`);
  const out = r.out || 0;
  add('missions', 'Missions', Math.min(MISSIONS_CAP, Math.floor(out / MISSIONS_PER)),
    `${out} gone on; +1 per ${MISSIONS_PER}, at most +${MISSIONS_CAP}`);
  const deep = r.floorCleared || 0;
  add('depth', 'Deepest floor', Math.min(DEPTH_CAP, Math.floor(deep / DEPTH_PER)),
    deep ? `floor ${deep} cleared; +1 per ${DEPTH_PER}, at most +${DEPTH_CAP}` : 'no floors cleared yet');
  const cl = CL() && CL().def(c);
  const born = cl && cl.summonOnly ? (cl.legendary ? 2 : 1) : 0;
  const gifts = Math.max(0, (c.gifts || []).length - 1);
  const heroic = c.heroic ? 1 : 0;
  const bits = [];
  if (born) bits.push(`${cl.name} (${cl.legendary ? 'legendary, +2' : 'summon-only, +1'})`);
  if (gifts) bits.push(`${c.gifts.length} gift paths (+${gifts})`);
  if (heroic) bits.push(`${c.heroic.title || 'heroic'} (+1)`);
  add('abilities', 'Abilities', born + gifts + heroic, bits.length ? bits.join(', ') : 'none');
  const grant = Math.max(-GRANT_MAX, Math.min(GRANT_MAX, c.standingGrant || 0));
  add('grant', 'Granted', grant, grant ? 'set by you' : 'none');
  return { total: parts.reduce((a, p) => a + p.v, 0), parts };
}

/** The highest open floor this character may live on. */
function reach(state, c) {
  const s = standing(c).total;
  let k = 0;
  for (let j = 1; j <= top(state); j++) if (s >= FLOORS[j].need) k = j;
  return k;
}

/** The floor their bed is on; 0 for sleeping outside. */
function livesOn(state, c) {
  const lo = LO();
  return lo ? instFloor(lo.bedOf(state, c)) : 0;
}

/** Morale target from being housed below their standing. Returns { v, short, tilt }. */
function station(state, c) {
  const short = Math.max(0, reach(state, c) - livesOn(state, c));
  const te = TE();
  const tilt = te ? te.t(c, 'appetite') : 0;
  return { v: short ? -STATION_PER_FLOOR * short * (1 + tilt) : 0, short, tilt };
}

/** The finished tavern this character drinks in: the highest one their standing lets them into. */
function tavernFor(state, c, limit = null) {
  const lo = LO();
  if (!lo) return null;
  const k = limit == null ? reach(state, c) : Math.min(limit, reach(state, c));
  let best = null;
  for (const inst of lo.ensure(state)) {
    const def = E().LODGINGS[inst.type];
    if (!def || !def.tavern || inst.site || instFloor(inst) > k) continue;
    if (!best || instFloor(inst) > instFloor(best)) best = inst;
  }
  return best;
}
/** Morale target from that tavern; 0 for nobody to drink with. */
const tavernMorale = (state, c) => { const t = tavernFor(state, c); return t ? E().LODGINGS[t.type].morale : 0; };

/** Who may live on floor k, out of everybody in town. */
const admitted = (state, k) => state.characters.filter(c => reach(state, c) >= k);

const FloorsAPI = {
  FLOORS, MISSIONS_PER, MISSIONS_CAP, DEPTH_PER, DEPTH_CAP, GRANT_MAX, STATION_PER_FLOOR,
  top, isOpen, buildingFloor, typeFloor, instFloor, standing, reach, livesOn, station, tavernFor, tavernMorale, admitted,
};
if (typeof module !== 'undefined') module.exports = FloorsAPI;
if (typeof window !== 'undefined') window.Floors = FloorsAPI;
})();
