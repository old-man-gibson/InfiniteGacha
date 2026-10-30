// Squad will sets the break-off line. `node test/will.js`; exit code 1 on any failure.
// `node test/will.js measure` prints deaths per sortie by temper tercile and by morale tercile for four
// settings of the change (options in the Measurement paragraph below).
//
// A squad leaves a fight by field.js escapeHatch, and leaves the map by broken(). Both compare against a
// line that is now bent by two inputs: the party's temper (temper.js will, broken.hp over the ordinary
// 0.25) and the squad's mean resolve, which starts at condition.js resolveSeed (morale under 60, spent
// stamina) and moves with grief (tactics.js grieve). VERBOSE=1 prints every passing check as well.
//
// Part A loads the modules in Node:
//   resolveSeed    0 at morale 60 and over with stamina above SPENT; -0.01 per morale point under 60; -0.15 for a
//                  spent character; held to -0.4..0; never positive however good the bed, the food and the rest;
//                  the same character in a bad town for 200 ticks starts negative and in a good one at 0
//   hatchLines     only raises the three ESCAPE_* lines (lean 1..2), holds them at 0.95 and 0.75, reads resolve
//                  held to +-RESOLVE_CAP, equals the constants for the default will and resolve 0
//   brokenLines    the same expressions broken() used before the change; broken() reads them
//   escapeHatch    fires at the line the will and resolve give, not before the tenth tick, computes the lines once
//                  when it is built, and prints the clause that fired with the figure and the line it was under
//   one cap        a seed of -0.4 plus a grief reaction of -1 reads -RESOLVE_CAP in the run, and the lines read it
// Part B loads sortie.js with an accessor for its screen functions (as test/cohesion.js does) and checks the
// text of the party card and the party line.
// Part C boots game.html through test/game.boot.js and plays real contracts through Sortie:
//   launch         every squad actor's resolve is its resolveSeed, the log lists each seed that is not 0 with the
//                  morale and stamina band that gave it, and the squad line prints the lines hatchLines gives
//   save           the seeds survive Field.save, JSON and Field.restore
//   break-off      every break-off line in a sweep of contracts under bad morale names its clause and a figure
//                  under its line
//
// Measurement (`measure`). The pool of test/sortie.harness.js is played through the real Sortie with
// combat.js. Morale is not produced by a town here, so each contract draws it for every pool character from a
// seeded stream: uniform over MORALE (default 38-82), and a share SPENT (default 1/6) of the characters is spent. The same contracts, squads and draws are
// played under four settings, so a difference between two of them is paired:
//   base   no seed, and the old constants in escapeHatch
//   lean   the temper's lean (hatchLines) with no seed
//   seed   the seed with the old constants in escapeHatch (broken() and combat.js still read the seed)
//   both   what the game now does
// Terciles are by Temper.will(squad).broken.hp (bold = lowest line = leaves latest) and by the squad's mean
// morale. Options (environment variables):
//   RUNS=20      contracts per type
//   TYPES=a,b    contract types (default all)      LEVEL=2-6   levels      SEED=1   seed of the pool and the contracts
//   ARMS=base,lean,seed,both    the settings to play
//   MORALE=38-82   range of the morale draw       SPENT=0.1667   share of the pool drawn spent
//   OUT=f.json   write the records of every setting to a file
// `node test/will.js chain` plays consecutive contracts on one roster (ARM=base or both, RUNS, REST) so that morale
// and stamina come from the town and the contracts instead of a draw (the chain() comment below).
// `node test/will.js report a.json b.json ...` prints the same tables from record files, so settings can be
// played in separate processes and combined. The harness variables of test/sortie.harness.js apply (POOL, STARS, SQUAD).

'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const root = path.join(__dirname, '..');
const file = (f) => path.join(root, f);

global.window = global;
for (const m of ['rng', 'mercy', 'roster', 'stats', 'proficiency', 'economy', 'affinity', 'classes', 'condition', 'temper', 'bonds', 'crew',
  'ai', 'gifts', 'elements', 'spellcraft', 'psionic', 'martial', 'prowess', 'consume', 'combat', 'bestiary', 'missions',
  'missiontypes', 'quests', 'mapgen', 'field', 'tactics']) require(file(m + '.js'));
const { mulberry } = require('./game.boot.js');

// rot.js prints this on some generated maps
const print = console.log;
console.log = (...a) => { if (!/Unable to connect room/.test(a.join(' '))) print(...a); };

let failed = 0, checks = 0;
const check = (cond, msg) => { checks++; if (!cond) { failed++; print('FAIL ' + msg); } else if (process.env.VERBOSE) print('ok   ' + msg); };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const scenario = (name, fn) => {
  try { fn(); } catch (e) { failed++; print(`FAIL ${name}: threw ${e && e.stack}`); }
};
const ascenario = async (name, fn) => {
  try { await fn(); } catch (e) { failed++; print(`FAIL ${name}: threw ${e && e.stack}`); }
};

const F = Field, MT = MissionTypes, Cond = Condition;

// ---------- Part A: modules in Node ----------

const RACES = ['human', 'draconic', 'therian'];
function makeChar(id, { stars = 3, cls = 'fighter', morale = 70, fullStamina = true } = {}) {
  const race = RACES[id % RACES.length];
  const c = { id, name: 'C' + id, race, stats: Stats.rollCharacterStats(race, Math.random, stars), equipment: {}, mind: { traits: [] },
    temper: Temper.roll(), xp: {}, potions: [], injured: 0, mission: null, job: null, progress: 0, techniques: {}, lexicon: [], facets: [], facetState: {} };
  c.profs = Prof.rollAll(stars, race);
  c.affinity = Affinity.roll(); c.psiOrder = Psionic.rollAxisOrder();
  c.gifts = Gifts.roll(c.stats, race); Gifts.ensure(c, null);
  if (Gifts.has(c, 'arcana')) c.lexicon = Spellcraft.rollLexicon(stars);
  c.stats.derived = Stats.deriveStats(c.stats.base);
  Classes.assign(c, cls, { force: true });
  Cond.ensure(c);
  c.cond.morale = morale;
  if (!fullStamina) c.cond.stamina = 0;
  return c;
}
/** Set the two inputs of the seed directly: morale, and stamina as a fraction of the ceiling. */
function setCond(c, morale, stamina = 1) {
  Cond.ensure(c);
  c.cond.morale = morale;
  c.cond.stamina = stamina * Stats.effective(c).derived.stamina;
  return c;
}
const seedOf = (morale, stamina) => Cond.resolveSeed(setCond(makeChar(1), morale, stamina));

scenario('resolveSeed values', () => {
  check(Object.is(seedOf(100, 1), 0) && Object.is(seedOf(70, 1), 0) && Object.is(seedOf(60, 1), 0), 'morale 60 and over with a full stamina bar: 0 (not -0)');
  check(near(seedOf(59, 1), -0.01) && near(seedOf(40, 1), -0.2) && near(seedOf(42, 1), -0.18), 'under 60: -0.01 per point (59: -0.01, 40: -0.2, 42: -0.18)');
  check(near(seedOf(20, 1), -0.4) && near(seedOf(0, 1), -0.4) && near(seedOf(10, 1), -0.4), 'held at -0.4 from morale 20 down');
  check(near(seedOf(80, 0.1), -0.15) && near(seedOf(80, 0), -0.15), 'spent with good morale: -0.15');
  check(near(seedOf(40, 0.1), -0.35) && near(seedOf(30, 0.1), -0.4) && near(seedOf(0, 0), -0.4), 'spent and low: the two terms add (-0.35), then the hold (-0.4)');
  check(near(seedOf(80, 0.19), -0.15) && Object.is(seedOf(80, 0.21), 0), 'spent is stamina at or under 20% of the ceiling (condition.js SPENT)');
  check(near(seedOf(80, 0.5), 0) && near(seedOf(80, 0.25), 0), 'tired is not spent');
  check(Object.is(seedOf(100, 1), seedOf(60, 1)), 'a character at morale 100 starts at the seed of one at 60: nothing above 60 counts');

  // the whole surface: never positive, never under the cap of field.js, non-decreasing in morale
  let ok = true, mono = true;
  for (const st of [1, 0.85, 0.5, 0.21, 0.19, 0]) {
    let prev = -Infinity;
    for (let m = 0; m <= 100; m++) {
      const v = seedOf(m, st);
      if (!(v <= 0 && v >= -0.4 && v >= -F.RESOLVE_CAP)) ok = false;
      if (v < prev - 1e-12) mono = false;
      prev = v;
    }
  }
  check(ok, 'over morale 0..100 and six stamina levels the seed is in -0.4..0, inside RESOLVE_CAP');
  check(mono, 'the seed never falls as morale rises');
  check(Cond.SEED_MIN >= -F.RESOLVE_CAP, `the seed floor ${Cond.SEED_MIN} is inside RESOLVE_CAP ${F.RESOLVE_CAP}`);
});

scenario('explainSeed text', () => {
  const c = setCond(makeChar(1), 42, 1);
  const e = Cond.explainSeed(c);
  check(near(e.seed, -0.18) && e.text === 'morale 42 (low) -0.18', `morale only: "${e.text}"`);
  check(/-0\.01 x \(60 - morale\) = -0\.18/.test(e.why) && /Starting resolve -0\.18/.test(e.why) && /held to -0\.4\.\.0/.test(e.why), 'the tooltip holds the arithmetic');
  const s = Cond.explainSeed(setCond(makeChar(1), 42, 0.1));
  check(near(s.seed, -0.33) && s.text === 'morale 42 (low) -0.18, stamina spent -0.15', `morale and stamina: "${s.text}"`);
  const only = Cond.explainSeed(setCond(makeChar(1), 90, 0));
  check(only.text === 'stamina spent -0.15' && only.moraleBand === 'willing', `stamina only: "${only.text}" (morale band ${only.moraleBand})`);
  check(Cond.explainSeed(setCond(makeChar(1), 75, 1)).text === '' && Cond.explainSeed(setCond(makeChar(1), 75, 1)).seed === 0, 'nothing to say at morale 75, rested');
  check(Cond.resolveSeed(c) === e.seed, 'resolveSeed is explainSeed().seed');
});

scenario('the town reaches the seed', () => {
  // the same character, 200 ticks in two towns: unhoused and unfed at a post, and housed, fed and resting
  const rough = makeChar(2), cosy = makeChar(2);
  for (let i = 0; i < 200; i++) {
    Cond.tick(rough, { job: 'gather', housed: false, fed: false });
    Cond.tick(cosy, { job: null, housed: true, fed: true, restMult: 1.45, lodging: 10 });
  }
  check(Cond.morale(rough) < 60 && Cond.resolveSeed(rough) < 0, `unhoused and unfed at a post: morale ${Cond.morale(rough).toFixed(0)}, seed ${Cond.resolveSeed(rough).toFixed(2)}`);
  check(Cond.morale(cosy) > 60 && Object.is(Cond.resolveSeed(cosy), 0), `housed, fed and resting: morale ${Cond.morale(cosy).toFixed(0)}, seed 0`);
  // being driven to empty is what the 'spent' term reads
  const driven = makeChar(3);
  for (let i = 0; i < 100; i++) Cond.tick(driven, { job: 'train', housed: true, fed: true });
  check(Cond.isSpent(driven) && Cond.resolveSeed(driven) <= -0.15, `worked to empty: spent, seed ${Cond.resolveSeed(driven).toFixed(2)}`);
});

// the default will and the lines an ordinary squad leaves at (field.js ESCAPE_HP, ESCAPE_LOW and the 0.7 beside them)
const DEFAULT = { lean: 1, down: 0.7, avg: 0.4, low: 0.2 };
const willOfHp = (hp, crew = 0.35) => ({ push: { hp: 0.55, crew: 0.6, until: 0.8 }, broken: { hp, crew }, voice: null });

scenario('hatchLines', () => {
  const d = F.hatchLines(null, 0), d2 = F.hatchLines(willOfHp(0.25), 0);
  check(['lean', 'down', 'avg', 'low'].every(k => near(d[k], DEFAULT[k]) && near(d2[k], DEFAULT[k])), `the default will and resolve 0 give the constants (${JSON.stringify(d)})`);
  check(['lean', 'down', 'avg', 'low'].every(k => near(F.hatchLines(willOfHp(0.12), 0)[k], DEFAULT[k])), 'a bold squad (broken.hp 0.12) keeps the constants');
  check(['lean', 'down', 'avg', 'low'].every(k => near(F.hatchLines(willOfHp(0.25), 1)[k], DEFAULT[k])), 'resolve +1 does not lower the lines under the constants');
  const h = F.hatchLines(willOfHp(0.4), -0.4);
  check(near(h.ratio, 1.6) && near(h.shift, 1 + 0.45 * 0.4) && near(h.lean, 1.6 * 1.18) && near(h.down, 0.95) && near(h.avg, 0.75) && near(h.low, 0.2 * 1.6 * 1.18),
    `broken.hp 0.4 at resolve -0.4: lean ${h.lean.toFixed(3)}, lines ${h.down}/${h.avg}/${h.low.toFixed(3)} (avg held at 0.75)`);
  const m = F.hatchLines(willOfHp(0.25), -0.4);
  check(near(m.lean, 1.18) && near(m.avg, 0.472) && near(m.down, 0.826) && near(m.low, 0.236), `an ordinary squad at the worst seed: lean ${m.lean}, avg ${m.avg}, down ${m.down}, low ${m.low}`);

  // raised only, and bounded, over the grid
  let raised = true, bounded = true, monoResolve = true, monoWill = true;
  const hps = [0.06, 0.1, 0.15, 0.25, 0.3, 0.4, 0.5, 0.6], rs = [-1, -0.7, -0.4, -0.1, 0, 0.3, 0.6, 1];
  for (const hp of hps) {
    let prev = null;
    for (const r of rs) {
      const x = F.hatchLines(willOfHp(hp), r);
      if (x.down < DEFAULT.down - 1e-12 || x.avg < DEFAULT.avg - 1e-12 || x.low < DEFAULT.low - 1e-12 || x.lean < 1) raised = false;
      if (x.lean > 2 + 1e-12 || x.down > 0.95 + 1e-12 || x.avg > 0.75 + 1e-12 || x.low > 0.4 + 1e-12) bounded = false;
      if (prev && (x.avg > prev.avg + 1e-12 || x.down > prev.down + 1e-12 || x.low > prev.low + 1e-12)) monoResolve = false;
      prev = x;
    }
  }
  for (const r of rs) {
    let prev = null;
    for (const hp of hps) {
      const x = F.hatchLines(willOfHp(hp), r);
      if (prev && (x.avg < prev.avg - 1e-12 || x.down < prev.down - 1e-12 || x.low < prev.low - 1e-12)) monoWill = false;
      prev = x;
    }
  }
  check(raised, 'no will and no resolve takes a line under its constant');
  check(bounded, 'lean <= 2, down <= 0.95, avg <= 0.75, low <= 0.4');
  check(monoResolve, 'a higher resolve never raises a line');
  check(monoWill, 'a higher broken.hp (a squad that bears less) never lowers a line');

  // resolve is read held to +-RESOLVE_CAP: one cap for the seed, grief and the lines
  const w = willOfHp(0.3);
  check(near(F.hatchLines(w, -5).lean, F.hatchLines(w, -F.RESOLVE_CAP).lean) && near(F.hatchLines(w, 5).lean, F.hatchLines(w, F.RESOLVE_CAP).lean), 'resolve beyond RESOLVE_CAP reads as RESOLVE_CAP');
  check(near(F.brokenLines(w, -5).hp, F.brokenLines(w, -F.RESOLVE_CAP).hp), 'brokenLines holds resolve to the same cap');
  check(F.RESOLVE_WEIGHT === 0.45, 'broken() and the hatch share one weight, 0.45');
});

scenario('brokenLines are the old broken() lines', () => {
  let same = true;
  for (const [hp, crew] of [[0.06, 0.1], [0.25, 0.35], [0.4, 0.5], [0.6, 0.75]]) for (const r of [-1, -0.4, 0, 0.5, 1]) {
    const old = { crew: Math.max(0.05, crew * (1 - 0.45 * r)), hp: Math.max(0.03, hp * (1 - 0.45 * r)) };
    const now = F.brokenLines(willOfHp(hp, crew), r);
    if (!near(old.crew, now.crew) || !near(old.hp, now.hp)) same = false;
  }
  check(same, 'crew and hp lines equal max(floor, line x (1 - 0.45 x resolve)) over a grid');
  const d = F.brokenLines(null, 0);
  check(near(d.crew, 0.35) && near(d.hp, 0.25), `the default will: ${d.crew} of the party, ${d.hp} average HP`);
});

// a squad of four stubs on a generated map, as test/retreat.js builds them
const squadOf = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: 'P' + (i + 1), maxHp: 80, power: 5 }));
const seeded = (seed, fn) => {
  const rand = mulberry(seed), prev = Math.random;
  Math.random = rand;
  try { return Rng.withSource(rand, () => fn(rand)); } finally { Math.random = prev; }
};
function begin(will = null, extra = {}) {
  const mission = MT.roll('extermination', { level: 2 });
  const party = squadOf(4);
  const s = F.start(mission, { party, will, ...extra });
  return { s, squad: s.actors.filter(a => a.role === 'squad') };
}
const setHp = (squad, fracs) => squad.forEach((a, i) => { a.hp = fracs[i] * a.maxHp; a.alive = fracs[i] > 0; });
const foesAt = (avg) => [{ hp: avg * 100, maxHp: 100, alive: true }, { hp: avg * 100, maxHp: 100, alive: true }];

scenario('broken() reads the seed', () => {
  const { s, squad } = begin();
  setHp(squad, [0.28, 0.28, 0.28, 0.28]);
  check(F.broken(s) === false, 'ordinary squad, resolve 0, average HP 28%: still working (line 25%)');
  for (const a of squad) a.resolve = -0.4;
  check(near(F.brokenLines(s.will, F.resolveOf(s)).hp, 0.25 * 1.18) && F.broken(s) === true, 'the same squad at resolve -0.4: the line is 29.5% and they withdraw');
  for (const a of squad) a.resolve = 0.5;
  setHp(squad, [0.22, 0.22, 0.22, 0.22]);
  check(F.broken(s) === false, 'resolve +0.5 lowers the map line (to 19%): 22% is still worked');
});

scenario('escapeHatch fires at the line, and says which', () => {
  seeded(11, () => {
    const hatchOf = (will, resolve, kit) => {
      const { s, squad } = begin(will);
      for (const a of squad) a.resolve = resolve;
      if (kit) squad[0].kit = kit;
      return { s, squad, hatch: F.escapeHatch(squad, s) };
    };
    const ordinary = willOfHp(0.25);

    // the ordinary squad, resolve 0: the old constants
    let { squad, hatch } = hatchOf(ordinary, 0);
    setHp(squad, [0.41, 0.41, 0.41, 0.41]);
    check(hatch(10, squad, foesAt(0.9)) === null, 'average 41% against a 40% line: stays');
    setHp(squad, [0.39, 0.39, 0.39, 0.39]);
    let r = hatch(10, squad, foesAt(0.9));
    check(r && r.via === 'foot' && /^they break off the fight and run: average HP 39%, under their 40% line$/.test(r.line), `average 39%: leaves on foot (${r && r.line})`);
    check(hatch(9, squad, foesAt(0.9)) === null, 'nothing before the tenth combat tick');
    setHp(squad, [0.399, 0.399, 0.399, 0.399]);
    r = hatch(10, squad, foesAt(0.9));
    check(r && /average HP 39%, under their 40% line/.test(r.line), `39.9% is printed under its line, never "40% under 40%" (${r && r.line})`);

    // a body down: the 70% line
    ({ squad, hatch } = hatchOf(ordinary, 0));
    setHp(squad, [0, 0.69, 0.69, 0.69]);
    r = hatch(10, squad, foesAt(0.9));
    check(r && /^they break off the fight and run: 1 dead and average HP 69%, under their 70% line$/.test(r.line), `one dead, the other three at 69%: ${r && r.line}`);
    setHp(squad, [0, 0.71, 0.71, 0.71]);
    check(hatch(10, squad, foesAt(0.9)) === null, 'one dead, the other three at 71%: stays');

    // one person nearly down against foes still mostly up
    ({ squad, hatch } = hatchOf(ordinary, 0));
    setHp(squad, [0.15, 0.9, 0.9, 0.9]);
    r = hatch(10, squad, foesAt(0.5));
    check(r && /^they break off the fight and run: one at 15%, under their 20% line, with the foes averaging 50%$/.test(r.line), `one at 15%, foes at 50%: ${r && r.line}`);
    check(hatch(10, squad, foesAt(0.3)) === null, 'the same, with the foes at 30%: stays (they are nearly beaten)');

    // a squad that bears less leaves at a higher average: broken.hp 0.5 is lean 2
    ({ squad, hatch } = hatchOf(willOfHp(0.5), 0));
    setHp(squad, [0.7, 0.7, 0.7, 0.7]);
    r = hatch(10, squad, foesAt(0.9));
    check(r && /average HP 70%, under their 75% line/.test(r.line), `timid squad at 70%: ${r && r.line}`);
    ({ squad, hatch } = hatchOf(ordinary, 0));
    setHp(squad, [0.7, 0.7, 0.7, 0.7]);
    check(hatch(10, squad, foesAt(0.9)) === null, 'the ordinary squad at the same 70%: stays');

    // a shaken ordinary squad: resolve -0.4 is lean 1.18, avg line 47%
    ({ squad, hatch } = hatchOf(ordinary, -0.4));
    setHp(squad, [0.46, 0.46, 0.46, 0.46]);
    r = hatch(10, squad, foesAt(0.9));
    check(r && /average HP 46%, under their 47% line/.test(r.line), `resolve -0.4 at 46%: ${r && r.line}`);
    setHp(squad, [0.48, 0.48, 0.48, 0.48]);
    check(hatch(10, squad, foesAt(0.9)) === null, 'resolve -0.4 at 48%: stays');

    // hardened: no lower than the constants
    ({ squad, hatch } = hatchOf(ordinary, 1));
    setHp(squad, [0.39, 0.39, 0.39, 0.39]);
    check(hatch(10, squad, foesAt(0.9)) !== null, 'resolve +1 at 39%: still leaves (the constant is the floor of the line)');
    setHp(squad, [0.41, 0.41, 0.41, 0.41]);
    check(hatch(10, squad, foesAt(0.9)) === null, 'resolve +1 at 41%: stays');

    // the lines are read when the hatch is built
    ({ squad, hatch } = hatchOf(ordinary, 0));
    for (const a of squad) a.resolve = -1;
    setHp(squad, [0.45, 0.45, 0.45, 0.45]);
    check(hatch(10, squad, foesAt(0.9)) === null, 'resolve changed after the hatch was built: the built lines hold');

    // the threshold printed is the figure the picker prints (hatchLines)
    const w = willOfHp(0.33);
    ({ squad, hatch } = hatchOf(w, -0.2));
    const lines = F.hatchLines(w, -0.2);
    setHp(squad, [lines.avg - 0.02, lines.avg - 0.02, lines.avg - 0.02, lines.avg - 0.02]);
    r = hatch(10, squad, foesAt(0.9));
    const m = r && /under their (\d+)% line/.exec(r.line);
    check(m && +m[1] === Math.round(lines.avg * 100), `the log prints ${Math.round(lines.avg * 100)}%, hatchLines().avg (${r && r.line})`);

    // through a wormhole
    ({ squad, hatch } = hatchOf(ordinary, 0, [{ kind: 'wormhole', charges: 1, icon: 'W' }]));
    setHp(squad, [0.3, 0.3, 0.3, 0.3]);
    r = hatch(10, squad, foesAt(0.9));
    check(r && r.via === 'wormhole' && /breaks off the fight through a wormhole: average HP 30%, under their 40% line$/.test(r.line), `the wormhole line names the threshold (${r && r.line})`);
  });
});

scenario('one cap for the seed, grief and the lines', () => {
  seeded(5, () => {
    const squad4 = squadOf(4);
    squad4[0].maxHp = 5;                                       // the first hit that lands on him kills him
    for (const c of squad4.slice(1)) c.maxHp = 1e6;            // and the others outlast the fight
    const mission = MT.roll('extermination', { level: 2 });
    const s = F.start(mission, {
      party: squad4, will: willOfHp(0.25),
      grieve: (fallen, survivors) => survivors.map(a => ({ actor: a, delta: -1 })),
    });
    const squad = s.actors.filter(a => a.role === 'squad');
    for (const a of squad) { a.resolve = -0.4; a.power = 1; }
    const foe = s.actors.find(a => a.side === 'theirs' && a.role === 'hostile');
    foe.power = 1000; foe.hp = foe.maxHp = 5000; foe.x = squad[0].x; foe.y = squad[0].y;
    for (let i = 0; i < 400 && !squad.some(a => !a.alive); i++) F.step(s);
    const alive = squad.filter(a => a.alive);
    check(squad.some(a => !a.alive), 'setup: somebody fell');
    check(alive.length > 0 && alive.every(a => a.resolve === -F.RESOLVE_CAP), `seed -0.4 plus a grief reaction of -1: every survivor reads ${alive.map(a => a.resolve).join(',')} (cap ${-F.RESOLVE_CAP})`);
    const mean = alive.reduce((x, a) => x + a.resolve, 0) / alive.length;     // they have walked out by now, so resolveOf(s) has nobody to read
    check(near(mean, -F.RESOLVE_CAP), 'the squad mean is the cap');
    const at = F.hatchLines(s.will, mean), past = F.hatchLines(s.will, -3);
    check(['lean', 'down', 'avg', 'low'].every(k => near(at[k], past[k])), 'the lines at the cap are the lines beyond it');
  });
});

// ---------- Part B: the screen functions of sortie.js ----------

let gameState = null;
global.Game = { get state() { return gameState; }, save() {}, logLine() {}, addItem() {}, renderAll() {}, advanceCharacter() { return true; } };
global.document = { readyState: 'loading', addEventListener() {}, getElementById: () => null, querySelector: () => null };
global.requestAnimationFrame = () => 1;
global.Tokens = { RINGS: { squad: 'squad', hurt: 'hurt', down: 'down' } };
global.FieldView = { namer: () => null, faces() {}, reface() {}, rehydrate() {} };
let ui = null;
try {
  let src = fs.readFileSync(file('sortie.js'), 'utf8');
  const exportLine = 'window.Sortie = { render,';
  if (!src.includes(exportLine)) throw new Error('sortie.js export line changed; update test/will.js');
  src = src.replace(exportLine, 'window.Sortie = { __ui: { partyFacts, willLines, willLine, willSummary, wholePct }, render,');
  vm.runInThisContext(src, { filename: file('sortie.js') });
  ui = global.Sortie.__ui;
} catch (e) { failed++; print('FAIL part B: sortie.js did not load: ' + (e && e.stack)); }

scenario('party card and party line text', () => {
  if (!ui) return;
  const fresh = setCond(makeChar(21), 80, 1), low = setCond(makeChar(22), 42, 1), tired = setCond(makeChar(23), 30, 0.1);
  gameState = { gems: 0, characters: [fresh, low, tired], inventory: {}, log: [], mercy: {}, bonds: {}, missions: { active: [], done: {}, history: [] }, field: { board: [] }, teams: [], roster: { fallen: [] } };

  const f1 = ui.partyFacts(fresh, null), f2 = ui.partyFacts(low, null), f3 = ui.partyFacts(tired, null);
  check(/morale willing 80/.test(f1) && /stamina fresh/.test(f1) && !/resolve/.test(f1.replace(/title="[^"]*"/, '')), `rested, morale 80: both bands, no resolve (${f1.match(/<div class="sub"[^>]*>([^<]*)/)[1]})`);
  check(/morale low 42/.test(f2) && /resolve -0\.18/.test(f2), `morale 42: band, value and the seed (${f2.match(/<div class="sub"[^>]*>([^<]*)/)[1]})`);
  check(/stamina spent/.test(f3) && /morale low 30/.test(f3) && /resolve -0\.40/.test(f3.replace(/title="[^"]*"/, '')), `spent at morale 30: -0.30 and -0.15 sum to -0.45, held to -0.40 (${f3.match(/<div class="sub"[^>]*>([^<]*)/)[1]})`);
  check(/title="[^"]*Starting resolve -0\.18\. Morale 42 \(low\)/.test(f2), 'the card tooltip carries the arithmetic of the seed');

  const party = [fresh, low, tired];
  const w = ui.willLines(party);
  const seeds = party.map(Cond.resolveSeed);
  const mean = seeds.reduce((t, x) => t + x, 0) / 3;
  check(near(w.resolve, mean), `the party resolve is the mean of the seeds (${w.resolve})`);
  const want = F.hatchLines(Temper.will(party), mean), wantMap = F.brokenLines(Temper.will(party), mean);
  check(['lean', 'down', 'avg', 'low'].every(k => near(w.fight[k], want[k])) && near(w.map.hp, wantMap.hp) && near(w.map.crew, wantMap.crew), 'the picker lines are hatchLines and brokenLines of the party\'s temper and mean seed');
  const line = ui.willLine(w);
  check(line === `squad leaves a fight under ${Math.round(want.avg * 100)}% average HP (under ${Math.round(want.down * 100)}% once somebody is dead in it) and leaves the map under ${Math.round(wantMap.hp * 100)}% average HP`, `the launch line: ${line}`);
  const sum = ui.willSummary(party);
  check(sum.includes(`Leaves a fight below <b>${Math.round(want.avg * 100)}%</b> average HP, between fights below ${Math.round(wantMap.hp * 100)}%`) && sum.includes(`starting resolve ${mean.toFixed(2)}`), `the party line (${sum.replace(/title="[^"]*"/, '').replace(/<[^>]+>/g, '')})`);
  check(sum.includes('Lean = ') && sum.includes('(temper.js will)') && sum.includes(fresh.name + ' 0.00') && sum.includes(low.name + ' -0.18'), 'its tooltip holds the lean arithmetic and each member\'s seed');
  const calm = ui.willSummary([fresh]);
  check(!/starting resolve/.test(calm.replace(/title="[^"]*"/, '')) && /Leaves a fight below/.test(calm), 'a party whose members all start at 0 says nothing about resolve');
  check(!/—/.test(sum + line + f2), 'no em dashes in the new text');
});

// ---------- Part C: the booted page ----------

async function partC() {
  const { setup } = require('./sortie.harness.js');
  const lab = await setup({ poolSize: 12 });
  if (lab.bootFailed || lab.failed) { failed++; print('FAIL part C: ' + (lab.failed || 'the page did not boot')); if (lab.b) lab.b.dispose(); return; }
  const { b, ctx, st, S } = lab;
  const Cn = ctx.Condition, Te = ctx.Temper, Fi = ctx.Field;
  const contract = (type, level, seed) => {
    const roll = ctx.MissionTypes.roll;
    ctx.MissionTypes.roll = (t, o) => roll.call(ctx.MissionTypes, type, Object.assign({}, o, { level }));
    try { return b.withSeed(seed, () => S.board(st, true)[0]); } finally { ctx.MissionTypes.roll = roll; }
  };
  const mission = contract('extermination', 3, 41);
  const set = (c, morale, stamina) => { Cn.ensure(c); c.cond.morale = morale; c.cond.stamina = stamina * ctx.Stats.effective(c).derived.stamina; };

  await ascenario('launch writes the seeds and the lines', async () => {
    lab.restore();
    const chars = st.characters.slice(0, 4);
    set(chars[0], 85, 1); set(chars[1], 55, 1); set(chars[2], 45, 0.1); set(chars[3], 10, 1);
    const want = chars.map(c => Cn.resolveSeed(c));
    check(near(want[0], 0) && near(want[1], -0.05) && near(want[2], -0.30) && near(want[3], -0.4), `setup: seeds ${want.map(x => x.toFixed(2))}`);
    let r = null;
    b.withSeed(7, () => { r = S.launch(mission, chars.map(c => c.id)); });
    check(typeof r === 'object', `launch (${r})`);
    const field = S.run.field;
    const squad = chars.map(c => field.actors.find(a => a.role === 'squad' && a.char.id === c.id));
    check(squad.every((a, i) => near(a.resolve, want[i])), `each squad actor starts at its seed (${squad.map(a => a.resolve.toFixed(2))})`);
    const log = field.log.map(l => l.text);
    const mine = log.filter(t => /starts with resolve/.test(t));
    check(mine.length === 3 && !mine.some(t => t.startsWith(chars[0].name + ' ')), `a log line for each seed that is not 0, none for the one at 0 (${mine.length})`);
    const line2 = mine.find(t => t.startsWith(chars[2].name + ' '));
    check(line2 === `${chars[2].name} starts with resolve -0.30: morale 45 (low) -0.15, stamina spent -0.15`, `the spent one's line names both terms: ${line2}`);
    const line3 = mine.find(t => t.startsWith(chars[3].name + ' '));
    check(line3 === `${chars[3].name} starts with resolve -0.40: morale 10 (broken) -0.50`, `the held one prints its term and the held sum: ${line3}`);
    const mean = want.reduce((t, x) => t + x, 0) / 4;
    const lines = Fi.hatchLines(Te.will(chars), mean), map = Fi.brokenLines(Te.will(chars), mean);
    const squadLine = log.find(t => /^squad leaves a fight under/.test(t));
    check(squadLine === `squad leaves a fight under ${Math.round(lines.avg * 100)}% average HP (under ${Math.round(lines.down * 100)}% once somebody is dead in it) and leaves the map under ${Math.round(map.hp * 100)}% average HP`, `the squad line prints the lines of the temper and the mean seed: ${squadLine}`);
    check(log.indexOf(mine[0]) < log.indexOf(squadLine), 'the seeds are listed before the lines they produce');

    // the fighters carry it into combat.js at the first fight
    check(squad.every(a => a.fighter), 'setup: fighters built');

    // save, JSON, restore
    const saved = JSON.parse(JSON.stringify(Fi.save(field)));
    const chMap = Object.fromEntries(chars.map(c => [c.id, c]));
    const back = Fi.restore(saved, { characters: chMap });
    const squad2 = chars.map(c => back.actors.find(a => a.role === 'squad' && a.char.id === c.id));
    check(squad2.every((a, i) => near(a.resolve, want[i])), `the seeds survive Field.save, JSON and Field.restore (${squad2.map(a => a.resolve.toFixed(2))})`);
    check(near(Fi.resolveOf(back), mean), 'and resolveOf reads their mean');
    S.abandon();

    // a rested squad: no seed lines at all
    lab.restore();
    const calm = st.characters.slice(0, 4);
    for (const c of calm) set(c, 75, 1);
    b.withSeed(7, () => { r = S.launch(mission, calm.map(c => c.id)); });
    const log2 = S.run.field.log.map(l => l.text);
    check(!log2.some(t => /starts with resolve/.test(t)), 'morale 75 and rested: no seed line');
    check(S.run.field.actors.filter(a => a.role === 'squad').every(a => a.resolve === 0), 'and every resolve is 0');
    check(log2.some(t => /^squad leaves a fight under/.test(t)), 'the squad line is printed for every launch');
    S.abandon();
  });

  await ascenario('good morale changes nothing in a fight', async () => {
    // the same contract and squad at morale 60 and at morale 100, everyone rested: the seed is 0 in both and
    // nothing else in the fight reads morale, so the outcomes are identical
    const outcome = (morale, seed, type, level) => {
      lab.restore();
      for (const c of st.characters) set(c, morale, 1);
      const r = lab.play({ seed, type, level });
      return JSON.stringify([r.result, r.deaths, r.fights, r.clock, (r.survivors || []).map(s => [s.endHp, s.nadir])]);
    };
    let same = 0, n = 0;
    for (const [seed, type, level] of [[11, 'extermination', 3], [12, 'raid', 4], [13, 'dungeon', 3], [14, 'hold', 4]]) {
      n++;
      if (outcome(60, seed, type, level) === outcome(100, seed, type, level)) same++;
    }
    check(same === n, `morale 100 plays ${n} contracts exactly as morale 60 does (${same} identical)`);
    lab.restore();
    const c = st.characters[0];
    set(c, 100, 1);
    const high = Cn.resolveSeed(c);
    set(c, 60, 1);
    check(Object.is(high, 0) && Object.is(Cn.resolveSeed(c), 0), 'and both seeds are 0');
  });

  await ascenario('break-off lines in a sweep', async () => {
    // bad morale and a spent squad, so the lines are raised and fights are left
    const found = [];
    const types = ['extermination', 'raid', 'siege', 'hold', 'survival', 'dungeon'];
    for (let i = 0; i < 18; i++) {
      lab.restore();
      const m = contract(types[i % types.length], 2 + (i % 5), 100 + i);
      const squad = st.characters.filter(c => !c.mission && !(c.injured > 0)).slice(0, Math.min(4, m.party[1]));
      if (squad.length < m.party[0]) continue;
      for (const c of squad) set(c, 25 + (i % 3) * 8, i % 2 ? 0.1 : 1);
      let r = null;
      b.withSeed(300 + i, () => { r = S.launch(m, squad.map(c => c.id)); if (typeof r === 'object') S.skip(); });
      if (typeof r !== 'object' || !S.run || !S.run.field) continue;
      for (const l of S.run.field.log) if (/break(s)? off the fight/.test(l.text)) found.push(l.text.trim());
    }
    check(found.length > 0, `setup: ${found.length} break-off lines in 18 contracts`);
    const forms = [
      /^(?:.+ breaks off the fight through a wormhole|they break off the fight and run): (\d+) dead and average HP (\d+)%, under their (\d+)% line$/,
      /^(?:.+ breaks off the fight through a wormhole|they break off the fight and run): average HP (\d+)%, under their (\d+)% line$/,
      /^(?:.+ breaks off the fight through a wormhole|they break off the fight and run): one at (\d+)%, under their (\d+)% line, with the foes averaging (\d+)%$/,
    ];
    let bad = 0, under = 0;
    for (const t of found) {
      const hit = forms.map(re => re.exec(t.replace(/^\s*/, ''))).find(Boolean);
      if (!hit) { bad++; print('  not a break-off form: ' + t); continue; }
      const nums = hit.slice(1).map(Number);
      const [fig, line] = hit.length === 4 && /dead/.test(t) ? [nums[1], nums[2]] : [nums[0], nums[1]];
      if (fig < line) under++;
    }
    check(bad === 0, `every break-off line names its clause with a figure and a line (${found.length} lines, ${bad} not in a known form)`);
    check(under === found.length - bad, `the printed figure is under the printed line in each (${under} of ${found.length - bad})`);
  });

  const late = lab.b.errors.length - lab.bootErrors;
  check(lab.bootErrors === 0 && late === 0, `no uncaught exception in the page (${lab.bootErrors} at boot, ${late} after)`);
  lab.b.dispose();
}

// ---------- measurement ----------

const ARMS = {
  base: { seed: false, lean: false },
  lean: { seed: false, lean: true },
  seed: { seed: true, lean: false },
  both: { seed: true, lean: true },
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((t, x) => t + (x - m) ** 2, 0) / (a.length - 1)) : NaN; };

/** Cut a list of values into thirds by rank: returns a function giving 0 (lowest third), 1 or 2 for a value. */
function terciles(values) {
  const sorted = values.slice().sort((x, y) => x - y);
  const lo = sorted[Math.floor(sorted.length / 3)], hi = sorted[Math.floor(2 * sorted.length / 3)];
  return (v) => (v < lo ? 0 : v < hi ? 1 : 2);
}

async function measure() {
  const { setup, config } = require('./sortie.harness.js');
  const env = process.env;
  const lab = await setup();
  if (lab.bootFailed || lab.failed) { print('measure: ' + (lab.failed || 'the page did not boot')); if (lab.b) lab.b.dispose(); return 2; }
  const { b, ctx, st, S, cfg } = lab;
  const runs = +(env.RUNS || 20);
  const arms = (env.ARMS ? env.ARMS.split(',') : Object.keys(ARMS)).map(s => s.trim()).filter(Boolean);
  const bad = arms.filter(a => !ARMS[a]);
  if (bad.length) { print('unknown setting: ' + bad.join(', ') + ' (known: ' + Object.keys(ARMS).join(', ') + ')'); lab.b.dispose(); return 2; }
  const types = env.TYPES ? env.TYPES.split(',').map(s => s.trim()).filter(Boolean) : cfg.allTypes;
  const Cn = ctx.Condition, Te = ctx.Temper, Fi = ctx.Field;

  // the two things a setting switches off are replaced on the booted page's own objects
  const origSeed = Cn.explainSeed, origHatch = Fi.escapeHatch;
  const noSeed = (c) => Object.assign(origSeed(c), { seed: 0, text: '' });
  // a state with the default will and nobody on the map: hatchLines reads lean 1, the old constants
  const oldHatch = (ours, s) => origHatch(ours, Object.assign(Object.create(s), { will: { broken: { hp: 0.25, crew: 0.35 }, push: s.will.push, voice: null }, actors: [] }));

  const moraleRange = (env.MORALE || '38-82').split('-').map(Number), spentShare = env.SPENT === undefined ? 1 / 6 : +env.SPENT;
  // the synthetic condition of the pool for one contract: the same draw whatever the setting
  const draw = (seed) => {
    const out = new Map();
    for (const c of st.characters) {
      const rand = mulberry((seed ^ Math.imul(c.id, 2654435761)) >>> 0);
      out.set(c.id, { morale: Math.round(moraleRange[0] + (moraleRange[1] - moraleRange[0]) * rand()), spent: rand() < spentShare });
    }
    return out;
  };
  const apply = (conds) => {
    for (const c of st.characters) {
      const d = conds.get(c.id);
      Cn.ensure(c);
      c.cond.morale = d.morale;
      c.cond.stamina = (d.spent ? 0.1 : 1) * ctx.Stats.effective(c).derived.stamina;
    }
  };

  const records = [];
  const started = Date.now();
  for (const arm of arms) {
    Cn.explainSeed = ARMS[arm].seed ? origSeed : noSeed;
    Fi.escapeHatch = ARMS[arm].lean ? origHatch : oldHatch;
    // sortie.js reads Condition.explainSeed and Field.escapeHatch at launch and resolve time, through the same objects
    for (let i = 0; i < runs; i++) for (const type of types) {
      const level = cfg.levels[i % cfg.levels.length];
      const seed = ((cfg.seed * 1000003 + cfg.allTypes.indexOf(type) * 7919 + i * 104729 + 17) >>> 0);
      lab.restore();
      const conds = draw(seed);
      apply(conds);
      // the squad's temper and morale, read at launch before the contract changes anything
      let features = null;
      const launch = S.launch;
      S.launch = function (mission, ids) {
        const chars = st.characters.filter(c => ids.includes(c.id));
        features = { line: Te.will(chars).broken.hp, morale: mean(chars.map(c => conds.get(c.id).morale)), spent: chars.filter(c => conds.get(c.id).spent).length, size: chars.length };
        return launch.apply(this, arguments);
      };
      let rec;
      try { rec = lab.play({ seed, type, level }); } finally { S.launch = launch; }
      const log = S.run && S.run.field ? S.run.field.log.map(l => l.text) : [];
      records.push({
        arm, type, level, seed, features,
        done: !!rec.result, won: rec.result ? rec.result.won : null, deaths: rec.deaths === undefined ? null : rec.deaths,
        left: log.filter(t => /break(s)? off the fight/.test(t)).length, withdrew: log.some(t => /break off and make for the way out/.test(t)) ? 1 : 0,
        error: rec.error || null,
      });
    }
    print(`${arm}: ${records.filter(r => r.arm === arm).length} contracts, ${((Date.now() - started) / 1000).toFixed(0)} s`);
  }
  Cn.explainSeed = origSeed; Fi.escapeHatch = origHatch;
  const meta = { runs, types, levels: cfg.levels, seed: cfg.seed, squad: cfg.squadClasses.length ? cfg.squadClasses : cfg.squadSize || 4, pool: cfg.pool, stars: cfg.stars, morale: moraleRange, spent: spentShare };
  const late = lab.b.errors.length - lab.bootErrors;
  lab.b.dispose();
  if (env.OUT) { fs.writeFileSync(env.OUT, JSON.stringify({ meta, records })); print('wrote ' + env.OUT); }
  report(records, meta);
  const threw = records.filter(r => r.error).length;
  print(`${threw} contracts threw, ${late} uncaught exceptions after boot`);
  return threw || late ? 2 : 0;
}

function report(records, meta) {
  const arms = [...new Set(records.map(r => r.arm))];
  const key = (r) => `${r.type}|${r.level}|${r.seed}`;
  const by = new Map(arms.map(a => [a, new Map(records.filter(r => r.arm === a && r.done && r.features).map(r => [key(r), r]))]));
  // terciles are cut on the squads of the first setting; the squads are the same in every setting
  const first = [...by.get(arms[0]).values()];
  const cutLine = terciles(first.map(r => r.features.line)), cutMorale = terciles(first.map(r => r.features.morale));
  const bucket = (r, how) => (how === 'line' ? cutLine(r.features.line) : cutMorale(r.features.morale));
  const pct = (v) => (isNaN(v) ? '-' : (100 * v).toFixed(1));
  const f3 = (v) => (isNaN(v) ? '-' : v.toFixed(3));
  const signed = (v) => (isNaN(v) ? '-' : (v >= 0 ? '+' : '') + v.toFixed(3));
  const se = (a) => sd(a) / Math.sqrt(a.length);
  const groups = [['line', 0], ['line', 1], ['line', 2], ['morale', 0], ['morale', 1], ['morale', 2]];
  print(`\n${first.length} contracts per setting (${meta.types.length} types, ${meta.runs} per type, levels ${meta.levels.join(',')}, seed ${meta.seed}); squad ${Array.isArray(meta.squad) ? meta.squad.join(',') : meta.squad}; pool ${meta.pool}; morale drawn ${meta.morale ? meta.morale.join('-') : '38-82'}, ${pct(meta.spent === undefined ? 1 / 6 : meta.spent)}% spent`);
  print('Deaths per run with one standard error. Temper terciles: Temper.will broken.hp lowest third (bold, leaves latest), middle, highest third (timid).');
  print('Morale terciles: the squad\'s mean morale, lowest third first.');
  const cols = ['setting', 'all', 'win%', 'bold', 'mid', 'timid', 'low morale', 'mid', 'high', 'left/run', 'withdrawn%'];
  const w = [8, 14, 11, 14, 14, 14, 14, 14, 14, 9, 10];
  const row = (cells) => cells.map((c, i) => String(c).padEnd(w[i])).join(' ').trimEnd();
  print(row(cols));
  for (const a of arms) {
    const rs = [...by.get(a).values()];
    const cell = (xs) => `${f3(mean(xs.map(r => r.deaths)))}+-${f3(se(xs.map(r => r.deaths)))}`;
    print(row([a, cell(rs), pct(mean(rs.map(r => +r.won))), ...groups.map(([how, t]) => cell(rs.filter(r => bucket(r, how) === t))), f3(mean(rs.map(r => r.left))), pct(mean(rs.map(r => r.withdrew)))]));
  }
  if (arms.length > 1) {
    print(`\nPaired difference in deaths per run, setting minus ${arms[0]}, with one standard error of the difference. Squads are placed in the terciles of ${arms[0]}.`);
    print(row(['setting', 'all', 'win pts', 'bold', 'mid', 'timid', 'low morale', 'mid', 'high']));
    const base = by.get(arms[0]);
    for (const a of arms.slice(1)) {
      const pairs = [...by.get(a).entries()].filter(([k]) => base.has(k)).map(([k, r]) => ({ r, o: base.get(k) }));
      const cell = (ps) => { const d = ps.map(p => p.r.deaths - p.o.deaths); return `${signed(mean(d))}+-${f3(se(d))}`; };
      const win = pairs.map(p => (+p.r.won) - (+p.o.won));
      print(row([a, cell(pairs), `${mean(win) >= 0 ? '+' : ''}${(100 * mean(win)).toFixed(1)}+-${(100 * se(win)).toFixed(1)}`, ...groups.map(([how, t]) => cell(pairs.filter(p => bucket(p.o, how) === t)))]));
    }
    const worst = arms.map(a => {
      const rs = [...by.get(a).values()];
      return `${a} ${f3(Math.max(...groups.map(([how, t]) => mean(rs.filter(r => bucket(r, how) === t).map(r => r.deaths)))))}`;
    });
    print('Highest of the six tercile means: ' + worst.join(', '));
  }
}


function reportFiles(paths) {
  const all = [];
  let meta = null;
  for (const p of paths) {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    meta = meta || j.meta;
    all.push(...j.records);
  }
  report(all, meta);
}

/** Summon from the page's own button until the roster is back at POOL (as test/wounds.js refill does). */
function refill(lab) {
  const { b, ctx, st, cfg } = lab;
  const Cl = ctx.Classes, rand = b.mulberry(cfg.seed + 99 + st.nextId);
  let guard = 0;
  st.gems = Math.max(st.gems, 1e9);
  while (st.characters.length < cfg.pool && guard++ < 400) {
    const before = st.characters.length;
    b.withSeed(cfg.seed + guard + st.nextId, () => b.click('#pull'));
    if (st.characters.length === before) break;
    const c = st.characters[st.characters.length - 1];
    if (c.stats.stars >= cfg.stars[0] && c.stats.stars <= cfg.stars[1] && !c.class) {
      const ok = Cl.BASES.filter(cl => Cl.eligible(c, cl.id).ok);
      if (ok.length) Cl.assign(c, ok[Math.floor(rand() * ok.length)].id);
    }
    if (c.stats.stars < cfg.stars[0] || c.stats.stars > cfg.stars[1] || !c.class) {
      st.characters.pop();
      if (ctx.Lodging && ctx.Lodging.invalidate) ctx.Lodging.invalidate(st);
    }
  }
}

/**
 * `chain`: consecutive contracts on one roster with the morale and stamina the town and the contracts
 * produce (Condition.outcome after each contract, Condition.tick through the rest ticks), dead characters
 * refilled from the summon button. This is the loop the single-contract measurement cannot show: a lost
 * contract lowers morale, which lowers the next seed. ARM=base or ARM=both; REST=3 town ticks between
 * contracts; RUNS contracts in all (cycling through the types).
 */
async function chain() {
  process.env.CHAIN = '1';
  const { setup } = require('./sortie.harness.js');
  const lab = await setup();
  if (lab.bootFailed || lab.failed) { print('chain: ' + (lab.failed || 'the page did not boot')); if (lab.b) lab.b.dispose(); return 2; }
  const { b, ctx, st, S, cfg } = lab;
  const armName = process.env.ARM || 'both';
  if (!ARMS[armName]) { print('unknown setting: ' + armName); lab.b.dispose(); return 2; }
  const Cn = ctx.Condition, Te = ctx.Temper, Fi = ctx.Field;
  const origSeed = Cn.explainSeed, origHatch = Fi.escapeHatch;
  Cn.explainSeed = ARMS[armName].seed ? origSeed : (c) => Object.assign(origSeed(c), { seed: 0, text: '' });
  Fi.escapeHatch = ARMS[armName].lean ? origHatch : (ours, s) => origHatch(ours, Object.assign(Object.create(s), { will: { broken: { hp: 0.25, crew: 0.35 }, push: s.will.push, voice: null }, actors: [] }));
  const need = cfg.squadSize || 4;
  const total = +(process.env.RUNS || 200);
  const rest = cfg.rest || 3;
  const types = cfg.types;
  const recs = [];
  let stopped = false;
  for (let i = 0; i < total; i++) {
    const type = types[i % types.length], level = cfg.levels[i % cfg.levels.length];
    const seed = ((cfg.seed * 1000003 + cfg.allTypes.indexOf(type) * 7919 + i * 104729 + 17) >>> 0);
    if (lab.wait(need) < 0) { stopped = true; break; }
    let features = null;
    const launch = S.launch;
    S.launch = function (mission, ids) {
      const chars = st.characters.filter(c => ids.includes(c.id));
      features = { line: Te.will(chars).broken.hp, morale: mean(chars.map(c => Cn.morale(c))), seed: mean(chars.map(c => origSeed(c).seed)), spent: chars.filter(c => Cn.isSpent(c)).length };
      return launch.apply(this, arguments);
    };
    let rec;
    try { rec = lab.play({ seed, type, level }); } finally { S.launch = launch; }
    const log = S.run && S.run.field ? S.run.field.log.map(l => l.text) : [];
    recs.push({ i, type, level, features, done: !!rec.result, won: rec.result ? rec.result.won : null, deaths: rec.deaths === undefined ? null : rec.deaths,
      left: log.filter(t => /break(s)? off the fight/.test(t)).length, error: rec.error || null });
    b.advance(1000 + rest * 10000);
    refill(lab);
  }
  Cn.explainSeed = origSeed; Fi.escapeHatch = origHatch;
  const late = lab.b.errors.length - lab.bootErrors;
  lab.b.dispose();
  const done = recs.filter(r => r.done && r.features);
  const pct = (v) => (isNaN(v) ? '-' : (100 * v).toFixed(1));
  const f3 = (v) => (isNaN(v) ? '-' : v.toFixed(3));
  const se = (a) => sd(a) / Math.sqrt(a.length);
  print(`chain ${armName}: ${done.length} of ${recs.length} contracts${stopped ? ' (stopped: no squad could be freed)' : ''}, rest ${rest} ticks, pool ${cfg.pool}, seed ${cfg.seed}`);
  const line = (name, rs) => print(`  ${name.padEnd(14)} n ${String(rs.length).padEnd(4)} win ${pct(mean(rs.map(r => +r.won))).padStart(5)}%  deaths/run ${f3(mean(rs.map(r => r.deaths)))}+-${f3(se(rs.map(r => r.deaths)))}  morale at launch ${mean(rs.map(r => r.features.morale)).toFixed(1)}  mean seed ${mean(rs.map(r => r.features.seed)).toFixed(3)}  seed under -0.1 in ${pct(mean(rs.map(r => +(r.features.seed < -0.1))))}% of launches  fights left/run ${f3(mean(rs.map(r => r.left)))}`);
  line('all', done);
  const third = Math.ceil(done.length / 3);
  [0, 1, 2].forEach(t => line(['first third', 'second third', 'last third'][t], done.slice(t * third, (t + 1) * third)));
  const cut = terciles(done.map(r => r.features.line));
  [['bold', 0], ['mid', 1], ['timid', 2]].forEach(([n, t]) => line(n, done.filter(r => cut(r.features.line) === t)));
  const cutM = terciles(done.map(r => r.features.morale));
  [['low morale', 0], ['mid morale', 1], ['high morale', 2]].forEach(([n, t]) => line(n, done.filter(r => cutM(r.features.morale) === t)));
  const threw = recs.filter(r => r.error).length;
  print(`${threw} contracts threw, ${late} uncaught exceptions after boot`);
  return threw || late ? 2 : 0;
}

// ---------- run ----------

async function main() {
  const cmd = process.argv[2] || 'check';
  if (cmd === 'measure') return measure();
  if (cmd === 'chain') return chain();
  if (cmd === 'report') { if (process.argv.length < 4) { print('usage: node test/will.js report a.json [b.json ...]'); return 2; } reportFiles(process.argv.slice(3)); return 0; }
  if (cmd !== 'check') { print('usage: node test/will.js [check | measure | chain | report a.json ...]'); return 2; }
  await partC();
  print(`${checks} checks, ${failed ? failed + ' failed' : 'all passed'}`);
  return failed ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }, (e) => { console.error(e); process.exitCode = 2; });
