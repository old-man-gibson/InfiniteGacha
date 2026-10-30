// Facet tuning constants. Every number the engine uses lives in this file, so rebalancing is a
// number change and not a code change. Nothing here is game-specific: a constant naming a damage
// type, a stat or a monster belongs in the host binding. The corpus test asserts that this file
// mentions none of the three.
//
// Durations are authored in seconds, not ticks. Both hosts run their combat loop at 10 ticks per
// second, but this game's outer loop tick is 10 seconds and the source game's is 100 ms, so a bare
// tick count such as 300 means a different duration in each of the four loops. D.seconds() converts
// seconds to ticks using the host's ticksPerSecond at compile time.

(() => {
const F = (globalThis.Facet || (globalThis.Facet = { _mods: {} }));
F._mods.data = true;

const D = F.data = {};

// ---------- mortality ----------
//
// The invariant is the ratio H = TTK_now / TTK_native, which is dimensionless and therefore ports
// between hosts. A bound stated in damage arithmetic instead would depend on every balance constant
// in the host: this game's magic damage runs higher than the source's spell power, its parry cap is
// 0.6 against 0.5, and its monster resist cap is 0.9 against the party's 0.75.
D.MORTALITY = {
  H_MAX: 6,                  // TTK may be inflated at most six-fold. Other bounds follow from it.
  SEAM_MIN: 0.35,            // Least openness one reachable damage type must retain.
  SUSTAIN_MAX_SHARE: 0.5,    // Engine-sourced sustain may answer at most half the incoming threat.
  REVIVE_CAP: 1,             // Per mission per bearer. H_revive = 1 + remaining, bounded at 2.
  MIN_ENGINE_MULT: 0.05,     // Per-blow damage multiplier clamp at the sealed `engine` stage.
  MIN_DEFIANCE: 0.02,        // Minimum cost to break a law; cheaper laws do not constrain play.
  EMA_WINDOW: 50,            // Ticks the openness average runs over (50 ticks = 5 s at 10 tps).
  PUNCTURE_MAX_ROUNDS: 3,
  PUNCTURE_MIN_BITE: 0.2,
  PUNCTURE_COST: { cover: 1.0, sustain: 0.7, revive: 1.6 },
  LAW_MAX_SECONDS: 30,
};

// Preferred seam element for a facet built out of a given element: the opposing element, so heat is
// answered by water and dark by light. This is the only elemental flavour in the core, and it is a
// soft preference over ids the host supplies. A host that names none of these keys still gets the
// seam guarantee, without the thematic pairing.
D.SEAM_OPPOSITE = {
  heat: 'water', water: 'lightning', lightning: 'earth', earth: 'wind', wind: 'heat',
  cold: 'heat', light: 'dark', dark: 'light', poison: 'light', acid: 'earth', arcane: 'arcane',
  slashing: 'bludgeoning', piercing: 'slashing', bludgeoning: 'piercing',
};

// ---------- worth ----------
//
// Worth is denominated in the same unit as the host's own hand-tuned status `worth` fields. The
// shared unit is an anchor rather than a calibration: a generated effect priced at 12 is meant to
// feel like the hand-written statuses of worth 12. The analytic estimator and the simulated oracle
// both report in this unit, so their outputs can be compared directly.
D.WORTH = {
  // Per unit of effect, before the trigger-frequency divisor.
  damage: 1.0, heal: 1.2, absorb: 1.1,
  status: 1.0,               // Multiplied by the host's declared worth for that status.
  nullify: 6.0,              // Scaled by the size of the quantity's gated closure.
  freeze: 3.0, invert: 5.0, drain: 4.0, copy: 3.5, swap: 4.5, desync: 3.0,
  scale: 2.0, clampQ: 2.0, addQ: 1.5, redirect: 4.0,
  veto: 9.0,                 // Scaled by measured law reach.
  tax: 3.0, transform: 3.5, offer: 2.5,
  summon: 7.0, dismiss: 2.0, revive: 14.0, mark: 1.0,
  stageJoin: 3.0, skip: 4.0,
};

// Expected share of ticks on which a hook is live, normalised so `tick` is 1.0. Worth is divided by
// this value, so a narrower trigger buys a larger magnitude. Without the divisor every generated
// facet converges on the same low-magnitude always-on passive.
D.CERT_PRIOR = {
  'tick': 1.0,
  'event:onHit': 0.55, 'event:onCrit': 0.12, 'event:onDodge': 0.10, 'event:onParry': 0.08,
  'event:onKill': 0.07, 'event:onEncounterStart': 0.04, 'event:onDeath': 0.03,
  'event:damageTaken': 0.60, 'event:heal': 0.15,
  'stage:raw': 0.55, 'stage:crit': 0.12, 'stage:armor': 0.40, 'stage:resist': 0.55,
  'stage:absorb': 0.55, 'stage:ward': 0.20, 'stage:floor': 0.55,
  'gate:offer': 0.30, 'gate:veto': 0.30,
  'tier:encounter': 0.02, 'tier:mission': 0.005, 'tier:calendar': 0.001,
  'cell:cap': 0.06, 'cell:release': 0.06, 'cell:score': 0.10,
  // Town hooks. game.js TICK_MS is 10000, so a town tick is 10 s; a combat tick is 0.1 s. A facet on
  // event:townTick therefore fires 100x less often than one on 'tick', and 0.01 is that ratio. The
  // divisor is why a town ability is allowed to be much larger per firing than a combat one.
  'event:townTick': 0.01,
};

// Scope and persistence both widen what an effect touches. Both are priced as multipliers on worth,
// so a party-wide encounter-long effect does not cost the same as a self-only tick-long one.
D.SCOPE_MULT   = { self: 1.0, ally: 1.4, party: 2.2, enemy: 1.6, arena: 3.0, world: 3.4 };
D.PERSIST_MULT = { tick: 1.0, encounter: 1.6, mission: 2.6, calendar: 4.0 };

// Cells hold per-facet state. They are priced on their own so a generator cannot gain reach for
// free by adding cells it barely reads. CELL_COST is keyed by the hold axis (none/one/many),
// CELL_LEVEL_COST by the level axis (none/int/real).
D.CELL_COST = { none: 0, one: 2, many: 4 };
D.CELL_LEVEL_COST = { none: 0, int: 1, real: 2 };

// Star tier sets the magnitude band, and BUDGET is the worth the generator has to spend at that
// tier. The gaps between tiers are wide on purpose; narrow bands produce facets of similar size.
D.BUDGET = { 1: 14, 2: 22, 3: 34, 4: 52, 5: 78 };
D.BUDGET_TOLERANCE = 0.15;
D.CELLS_MAX = 4;
D.CLAUSES_MAX = 8;
// A facet must reach this fraction of its tier's budget or it is rejected as inert. The threshold is
// relative, not absolute: 0.5 worth is negligible against the 5-star budget of 78 and is most of the
// 1-star budget of 14, so a single absolute number cannot serve both.
D.INERT_FRAC = 0.45;

// ---------- curves ----------
// Pure functions, dimensionless in and out. `diminish` is the curve E11 requires: each additional
// unit adds less than the one before it, and the total approaches its bound without crossing it.
D.CURVES = {
  diminish:  (n, a) => (a || 4) / ((a || 4) + n),
  ramp:      (n, a) => Math.min(1, n / (a || 10)),
  harmonic:  (n) => n <= 0 ? 0 : 1 / n,
  geometric: (n, a, b) => Math.pow(b === undefined ? 0.85 : b, n) * (a === undefined ? 1 : a),
  sqrt:      (n) => Math.sqrt(Math.max(0, n)),
  step:      (n, a) => Math.floor(n / (a || 1)),
  linear:    (n) => n,
  inverse:   (n, a) => (a || 1) / Math.max(1e-6, n),
};

// ---------- decks ----------
//
// core:ranked supplies the ordered dimension a poker scorer needs, and nothing else. Ranks are
// integers; suits come from the host vocabulary named by suitsFrom, so the core can hold a poker
// scorer without containing a game-specific word. Encoding the same information as tags such as
// 'hearts' or 'rank9' would make the scorer parse names, which this codebase's rules forbid.
D.DECKS = {
  'core:ranked': { ranks: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], suitsFrom: 'vocab:element' },
  'core:coin':   { ranks: [0, 1], suitsFrom: null },
  'core:d6':     { ranks: [1, 2, 3, 4, 5, 6], suitsFrom: null },
};

// ---------- readings ----------
//
// These names are readings of points in the four-axis cell space (hold, level, clock, exclusive).
// They are labels for authoring and display; no code dispatches on them. mode and latch differ only
// in whether the held tag has a clock; accumulator and counter differ only in whether the level is
// real or int. flag has an empty `when` and matches whatever the earlier entries do not. Making each
// name its own cell type would mean four reducers to keep in step; the axes need one.
D.READINGS = [
  { name: 'mode',        when: { hold: 'one',  exclusive: true } },
  { name: 'latch',       when: { clock: true } },
  { name: 'collection',  when: { hold: 'many' } },
  { name: 'accumulator', when: { hold: 'none', level: 'real' } },
  { name: 'counter',     when: { hold: 'none', level: 'int' } },
  { name: 'flag',        when: {} },
];

// Bands for rendering a magnitude as a word instead of a number, in the same shape temper.js uses
// for its axes. `max` is the upper bound of the band. The player is shown one of these five words;
// the number remains available but is not displayed as the primary value.
D.BANDS = [
  { max: 0.12, word: 'faint' },
  { max: 0.30, word: 'slight' },
  { max: 0.55, word: 'marked' },
  { max: 0.80, word: 'strong' },
  { max: 1.01, word: 'overwhelming' },
];

// Sentence fragment for each hook. Rendering only; nothing dispatches on these. A hook with no entry
// here falls back to a phrase built from its id, so adding a hook to CERT_PRIOR does not also
// require an entry here before it works.
D.HOOK_PHRASE = {
  'tick': 'Always',
  'event:onHit': 'When hit',
  'event:onCrit': 'On crit',
  'event:onDodge': 'On dodge',
  'event:onParry': 'On parry',
  'event:onKill': 'On kill',
  'event:onDeath': 'On death',
  'event:onEncounterStart': 'Fight start',
  'event:damageTaken': 'When struck',
  'event:heal': 'When healed',
  'tier:encounter': 'Fight end',
  'tier:mission': 'Mission end',
  'tier:calendar': 'Each week',
  'event:townTick': 'In town',
  'stage:resist': 'On any hit',
  'stage:absorb': 'On any hit',
  'stage:armor': 'On any hit',
  'gate:veto': 'While active',
};

// ---------- sugar ----------
//
// A verb is a primitive if and only if it is the sole route to a host adapter member. `summon` is
// the only way to reach host.summon, so it is primitive. `law` reaches nothing that `veto` does not,
// so it is sugar and expands at compile time. That test is mechanical, and it keeps the primitive
// verb list from growing past the small set of adapter members.
D.SUGAR = {
  law:    { expands: 'gate.veto', forces: { scope: { side: 'arena' } }, addsCell: { hold: 'none', level: 'none', clock: true } },
  absorb: { expands: 'stage.join', at: 'absorb', then: 'cell.add' },
  buff:   { expands: 'world.status', on: { side: 'self' }, marks: { buff: true } },
  mode:   { expands: 'cell.enter', addsCell: { hold: 'one', level: 'none', exclusive: true } },
};

D.seconds = (s, tps) => Math.max(1, Math.round(s * (tps || 10)));
})();
