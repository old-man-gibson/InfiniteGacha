// Lodging: where everyone sleeps, and who is allowed to sleep there.
// Browser: window.Lodging. Node: module.exports.
//
// Lodging used to be ONE building with five tiers, which made housing a single number the whole
// town shared: raise the tier, everybody rests better. That is not a decision. This replaces it
// with a yard of separate BUILDINGS you put up as many of as you like, each with its own beds,
// its own quality of rest and its own effect on morale — and, because that is only half a
// decision, its own RULES about who may sleep in it.
//
// A rule is a hard filter and a soft magnet at once. A barracks reserved for one team will not
// take anybody else, and the people it was built for prefer it over a better bed elsewhere,
// which is what "the team stays together" has to mean if it is going to mean anything. Rules
// stack: stars at least four AND one team AND a trade is a legal and quite specific bed.
//
// Effects. Rest multiplies stamina recovery and aptitude training (condition.js, game.js), and
// the morale bonus is added to the target morale drifts toward, so a manor gives both faster rest
// and higher morale. A character with no bed at all works at half rate and steadily loses
// morale, as before.
//
// Assignment is automatic and the rules are the player's. The town does the billeting inside the
// rules, and re-does it whenever the roster or the rules change.

(() => {
const E = () => (typeof Econ !== 'undefined') ? Econ : require('./economy.js');
const CL = () => (typeof Classes !== 'undefined') ? Classes : (typeof require !== 'undefined' ? require('./classes.js') : null);

// ---------- rules ----------
// Every rule is a predicate on one character plus a value the player sets. `ctx` carries the
// things a character does not know about itself, which for now is only which team it is on.
const RULES = {
  minStars: {
    label: 'Stars at least', kind: 'stars', short: (v) => `${v}★ and up`,
    test: (c, v) => c.stats.stars >= v,
  },
  maxStars: {
    label: 'Stars at most', kind: 'stars', short: (v) => `${v}★ and below`,
    test: (c, v) => c.stats.stars <= v,
  },
  team: {
    label: 'One team only', kind: 'team', short: (v, ctx) => `${(ctx.teamName && ctx.teamName(v)) || 'a team'} only`,
    test: (c, v, ctx) => ctx.teamOf(c) === v,
    magnet: true,                         // the people it is for prefer it, not just qualify for it
  },
  group: {
    label: 'Class group', kind: 'group', short: (v) => `${v} classes`,
    test: (c, v) => { const cl = CL(); return !!cl && cl.held(c).some(h => h.def.group === v); },
    magnet: true,
  },
  classed: {
    label: 'Has a class', kind: 'bool', short: () => 'classed only',
    test: (c) => { const cl = CL(); return !!cl && !!cl.def(c); },
  },
  trade: {
    label: 'Has a trade', kind: 'bool', short: () => 'trades only',
    test: (c) => { const cl = CL(); return !!cl && !!cl.tradeDef(c); },
    magnet: true,
  },
  race: {
    label: 'One race only', kind: 'race', short: (v) => `${v} only`,
    test: (c, v) => c.race === v,
  },
};

const ruleList = (inst) => Object.entries(inst.rules || {}).filter(([k, v]) => RULES[k] && v !== null && v !== undefined && v !== '');

/** Does this building take this character? Every rule on it has to say yes. */
function admits(inst, c, ctx) {
  for (const [k, v] of ruleList(inst)) if (!RULES[k].test(c, v, ctx)) return false;
  return true;
}

/** How much this character wants this bed: quality of rest, plus a pull toward beds meant for them. */
function appeal(inst, c, ctx) {
  const type = E().LODGINGS[inst.type];
  let v = type.rest + type.morale / 100;
  for (const [k] of ruleList(inst)) if (RULES[k].magnet) v += 0.35;
  return v;
}

/** What the rules on this building say, in words. */
function ruleText(inst, ctx = {}) {
  const parts = ruleList(inst).map(([k, v]) => RULES[k].short(v, ctx));
  return parts.length ? parts.join(' · ') : 'anyone';
}

// ---------- the yard ----------
const ensure = (state) => (state.lodgings = state.lodgings || []);
const typeOf = (inst) => E().LODGINGS[inst.type];
const bedsOf = (inst) => typeOf(inst).beds;
const capacity = (state) => ensure(state).reduce((a, l) => a + bedsOf(l), 0);
const plotsUsed = (state) => ensure(state).reduce((a, l) => a + typeOf(l).plots, 0);

let seq = 0;
function build(state, type, { free = false } = {}) {
  const def = E().LODGINGS[type];
  if (!def) return { ok: false, why: 'no such lodging' };
  if (!free && !E().canAfford(state, def.cost)) return { ok: false, why: 'not enough resources' };
  if (!free) E().pay(state, def.cost);
  const inst = { id: 'l' + Date.now().toString(36) + (seq++), type, rules: {}, built: Date.now() };
  ensure(state).push(inst);
  state.beds = null;                                   // the billet is stale the moment the yard changes
  return { ok: true, inst };
}

function demolish(state, id) {
  const before = ensure(state).length;
  state.lodgings = ensure(state).filter(l => l.id !== id);
  state.beds = null;
  return state.lodgings.length < before;
}

const find = (state, id) => ensure(state).find(l => l.id === id) || null;

function setRule(state, id, key, value) {
  const inst = find(state, id);
  if (!inst || !RULES[key]) return null;
  inst.rules = inst.rules || {};
  if (value === null || value === '' || value === undefined) delete inst.rules[key];
  else inst.rules[key] = value;
  state.beds = null;
  return inst;
}

// ---------- billeting ----------
/** What the rules need to know that a character does not carry itself. */
function contextOf(state) {
  const teams = state.teams || [];
  const byMember = new Map();
  for (const t of teams) for (const id of t.members) if (!byMember.has(id)) byMember.set(id, t.id);
  return {
    teamOf: (c) => byMember.get(c.id) || null,
    teamName: (id) => (teams.find(t => t.id === id) || {}).name || 'a team',
  };
}

/**
 * Hand out the beds. Characters are served in order of what they are worth to the town — stars,
 * then seniority — and each takes the bed it wants most out of the ones that will have it. A
 * character no building admits sleeps outside, which is a thing the player did on purpose by
 * writing rules that leave somebody out.
 *
 * Cached on `state.beds` and thrown away whenever the yard, the rules or the roster change.
 */
function billet(state) {
  const ctx = contextOf(state);
  const yard = ensure(state);
  const free = {};
  for (const l of yard) free[l.id] = bedsOf(l);

  const order = state.characters.slice().sort((a, b) => b.stats.stars - a.stats.stars || a.id - b.id);
  const beds = {};
  const outside = [];
  for (const c of order) {
    let best = null, bestV = -Infinity;
    for (const l of yard) {
      if (free[l.id] <= 0 || !admits(l, c, ctx)) continue;
      const v = appeal(l, c, ctx);
      if (v > bestV) { bestV = v; best = l; }
    }
    if (!best) { outside.push(c.id); continue; }
    free[best.id]--;
    beds[c.id] = best.id;
  }
  return { beds, outside, free, at: state.characters.length };
}

/** The current billet, rebuilt if anything has moved since it was worked out. */
function plan(state) {
  if (!state.beds || state.beds.at !== state.characters.length) state.beds = billet(state);
  return state.beds;
}
const invalidate = (state) => { state.beds = null; };

// ---------- what the town asks ----------
const bedOf = (state, c) => { const inst = find(state, plan(state).beds[c.id]); return inst || null; };
const housed = (state, c) => !!plan(state).beds[c.id];
/** Rest multiplier for one character. Sleeping outside is worse than the worst roof. */
function restFor(state, c) {
  const inst = bedOf(state, c);
  return inst ? typeOf(inst).rest : 0.75;
}
/** Morale the bed itself is worth, added to the target morale drifts toward (condition.js). */
function moraleFor(state, c) {
  const inst = bedOf(state, c);
  return inst ? typeOf(inst).morale : -18;
}
const occupants = (state, id) => state.characters.filter(c => plan(state).beds[c.id] === id);

/** Everything the town tab needs about one building. */
function describe(state, inst) {
  const t = typeOf(inst);
  const ctx = contextOf(state);
  const living = occupants(state, inst.id);
  return {
    id: inst.id, type: inst.type, label: t.label, icon: t.icon, desc: t.desc,
    beds: t.beds, rest: t.rest, morale: t.morale, plots: t.plots,
    used: living.length, occupants: living, rules: inst.rules || {}, ruleText: ruleText(inst, ctx),
  };
}

/** The whole yard, plus who is sleeping outside it. */
function summary(state) {
  const p = plan(state);
  return {
    buildings: ensure(state).map(l => describe(state, l)),
    capacity: capacity(state), plots: plotsUsed(state),
    housed: Object.keys(p.beds).length, outside: p.outside.map(id => state.characters.find(c => c.id === id)).filter(Boolean),
  };
}

/**
 * Old saves carried a single tiered lodging plus a pile of tents. Turn that into a yard that
 * houses the same people at the same standard, so nobody wakes up homeless because the town
 * changed how it counts beds.
 */
function migrate(state) {
  if (state.lodgings) return false;
  ensure(state);
  const tier = (state.buildings && state.buildings.lodging) || 0;
  const OLD = ['bunkhouse', 'bunkhouse', 'longhouse', 'cottages', 'manor'];
  build(state, OLD[Math.min(tier, OLD.length - 1)], { free: true });
  for (let i = 0; i < (tier > 1 ? tier : 0); i++) build(state, 'longhouse', { free: true });
  for (let i = 0; i < (state.tents || 0); i++) build(state, 'tent', { free: true });
  state.beds = null;
  return true;
}

const LodgingAPI = {
  RULES, ensure, typeOf, bedsOf, capacity, plotsUsed, build, demolish, find, setRule,
  admits, appeal, ruleText, ruleList, contextOf, billet, plan, invalidate,
  bedOf, housed, restFor, moraleFor, occupants, describe, summary, migrate,
};
if (typeof module !== 'undefined') module.exports = LodgingAPI;
if (typeof window !== 'undefined') window.Lodging = LodgingAPI;
})();
