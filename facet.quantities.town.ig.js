// The town half of this game's quantity registry. Browser: window.FacetQuantitiesTownIG.
// Node: module.exports. Merged into the combat registry at install.
//
// Scope. The generator pairs each of the 11 verbs with each registered quantity, so the number of
// generatable abilities scales with the size of the registry: 11 verbs over 40 quantities is about
// 400 abilities, over 64 quantities about 600. Before this file, all 64 registered quantities were
// combat quantities, so every generated ability was a combat ability.
//
// The quantities registered here are the per-character town numbers: condition, temperament,
// proficiency, and bonds. Each registration is one entry and is picked up by every verb, so a facet
// can freeze cond.morale, drain cond.stamina into damage, invert a prof aptitude for a week, or read
// bond.closest as a magnitude.
//
// Three differences from the combat quantities:
//
//  1. They resolve against a person ref, not a combatant ref. A combatant exists for the length of
//     an encounter; a character exists for the length of a save. The adapter dispatches on which
//     kind of ref it was handed.
//
//  2. Some values have a cap that is itself a registered quantity. cond.morale runs 0..100, and the
//     100 is a constant in condition.js. Pushing morale past its normal ceiling means writing the
//     cap quantity, not applying a larger `scale`, so `cap` quantities are registered alongside the
//     values they bound.
//
//  3. None of them is a status modifier. Town has no status system, so every entry here carries
//     modStat:null and the generator will not build a mod effect from them. They are reached through
//     the override table, the same route the combat quantities use for everything that is not a mod.

(() => {
const Q = (id, d) => Object.assign({ id, modStat: null }, d);

function build() {
  const out = [];

  // ---- condition: reserves left, and mood ---------------------------------------------------
  //
  // `moraleMax` is registered as its own quantity rather than folded into morale's clamp. It is
  // writable and not sealed, which is the mechanism an ability uses to lift morale past its normal
  // limit. `stamina.max` is derived from CON and is sealed: writing it would change what a
  // character's constitution means.
  out.push(Q('cond.morale', {
    label: 'Morale', kind: 'scalar', namespace: 'cond',
    from: [], feeds: ['cond.moraleMult'], gates: [], nul: 0, clamp: [0, null],
    nullifiable: true, writable: true,
  }));
  out.push(Q('cond.moraleMax', {
    label: 'Morale ceiling', kind: 'cap', namespace: 'cond',
    from: [], feeds: ['cond.morale'], gates: [], nul: 0, clamp: [0, null],
    nullifiable: false, writable: true, sealed: false,
  }));
  out.push(Q('cond.moraleMult', {
    label: 'Morale effect', kind: 'mult', namespace: 'cond',
    from: ['cond.morale'], feeds: [], gates: [], nul: 1,
    nullifiable: true, writable: true,
  }));
  out.push(Q('cond.stamina', {
    label: 'Stamina left', kind: 'pool', namespace: 'cond',
    from: [], feeds: ['cond.workMult'], gates: ['cond.workMult'], nul: 0, clamp: [0, null],
    nullifiable: true, writable: true,
  }));
  out.push(Q('cond.staminaMax', {
    label: 'Stamina ceiling', kind: 'cap', namespace: 'cond',
    from: ['derived.stamina'], feeds: ['cond.stamina'], gates: [],
    nullifiable: false, writable: false, sealed: true,
  }));
  out.push(Q('cond.workMult', {
    label: 'Work rate', kind: 'mult', namespace: 'cond',
    from: ['cond.stamina'], feeds: [], gates: [], nul: 1,
    nullifiable: true, writable: true,
  }));
  out.push(Q('cond.pool', {
    label: 'Reserve left', kind: 'pool', namespace: 'cond',
    from: [], feeds: [], gates: [], nul: 0, clamp: [0, null],
    nullifiable: true, writable: true,
  }));

  // ---- temperament: standing preferences, before any order is given ------------------------
  //
  // Writable but never nullifiable. temper.js states that every system reads these axes as a tilt,
  // across eleven call sites. A nulled axis would leave those eleven sites with an undefined value
  // rather than shifting the character's behaviour.
  for (const [k, label] of [['nerve', 'Nerve'], ['appetite', 'Appetite'], ['rigor', 'Rigor'], ['grit', 'Grit'], ['guile', 'Guile']]) {
    out.push(Q('temper.' + k, {
      label, kind: 'scalar', namespace: 'temper',
      from: [], feeds: [], gates: [], nul: 50, clamp: [0, 100],
      nullifiable: false, writable: true,
    }));
  }

  // ---- proficiency: what they are good at -----------------------------------------------------
  out.push(Q('prof.best', {
    label: 'Best aptitude', kind: 'scalar', namespace: 'prof',
    from: [], feeds: [], gates: [], nul: 0, nullifiable: true, writable: true,
  }));
  out.push(Q('prof.breadth', {
    label: 'Aptitude breadth', kind: 'scalar', namespace: 'prof',
    from: [], feeds: [], gates: [], nul: 0, nullifiable: true, writable: true,
  }));

  // ---- bonds: who they get on with ----------------------------------------------------------
  // Read-only for now. Bonds are pairwise, and writing one from a facet would need a second ref that
  // the effect schema has no slot for. Registered anyway so verbs can read a bond as a magnitude.
  out.push(Q('bond.closest', {
    label: 'Closest bond', kind: 'scalar', namespace: 'bond',
    from: [], feeds: [], gates: [], nul: 0, clamp: [0, 100],
    nullifiable: false, writable: false,
  }));
  out.push(Q('bond.friends', {
    label: 'Friends', kind: 'scalar', namespace: 'bond',
    from: [], feeds: [], gates: [], nul: 0,
    nullifiable: false, writable: false,
  }));

  // ---- the town's own funds ------------------------------------------------------------------
  // World-scoped: one value, shared by every character. An ability that spends wealth to survive
  // therefore draws down a shared pool, so the cost falls on characters other than the one taking
  // the hit.
  out.push(Q('town.gems', {
    label: 'Gems', kind: 'pool', namespace: 'town',
    from: [], feeds: [], gates: [], nul: 0, clamp: [0, null],
    nullifiable: false, writable: true,
  }));

  return out;
}

const API = { build };
if (typeof module !== 'undefined') module.exports = API;
if (typeof window !== 'undefined') window.FacetQuantitiesTownIG = API;
})();
