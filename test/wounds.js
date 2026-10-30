// Wounds. `node test/wounds.js`; exit code 1 on any failure.
// `node test/wounds.js measure` prints the rotation figures instead (usage below). SHOW=1 lists every passing check.
//
// Part A loads the modules in Node, as test/debrief.js does, and checks the arithmetic:
//   Condition.wound        the low-HP rule with WOUND_FROM and WOUND_TICKS; a longer injury is kept
//   Missions.recover       healing per town tick through an optional Lodging, the pantry, fractional
//                          injuries, woundNote deleted at 0, and the tick count equal to Condition.woundTicks
//   Condition.readyIn      the injury and the stamina / pool debt reported as separate limits
//   Condition.wounded      the one wound reading (ticks, phrase, tooltip with the bed and meal factors) at the bed and
//                          pantry the town tick heals by, equal to the ticks Missions.recover takes; readyText wording
//   debrief line           the wound line of a debrief prints that same figure and not the wound's length
//   Missions.debrief       the wound step: once per survivor, one log line, nothing without `low`
//   Gate run               Missions.launch / tick: members[].low is the lowest end-of-fight HP and the wound follows it
// Part B boots game.html through test/game.boot.js and plays real contracts through Sortie:
//   settle                 each survivor's c.injured follows from the actor's `low`; one log line
//   save / resume          `low` survives a reload (field.js ACTOR_KEYS)
//   town tick              Game.tick heals by Lodging.restFor, times FED_REST while the pantry has meals
//   picker                 a recovering character is listed greyed, with its wound ETA and stamina / pool ETA
//   every screen           roster tile, sheet, gate party, picker card, party box and team note print one figure,
//                          with and without a meal in the pantry
//
// measure. Chains contracts on one roster through the real Sortie (test/sortie.harness.js setup) and
// refills dead characters from the summon button, so the roster size stays at POOL. It prints the share of
// survivors and of sorties that are injured, and how many launches found fewer than a squad free.
//   POOL=12 RUNS=60 REST=6 SEED=1 node test/wounds.js measure
//   REST   town ticks between launches (10 s each); a sortie watched at 1x takes about 6, a skipped one about 1
//   POOL, RUNS, SEED, LEVEL, STARS, SQUAD, TYPES, MEALS as in test/sortie.harness.js

'use strict';
const path = require('path');
const root = path.join(__dirname, '..');
const { boot, mulberry } = require('./game.boot.js');

const command = process.argv[2] || 'check';

if (command === 'check') {
  global.window = global;
  for (const m of ['rng', 'mercy', 'roster', 'stats', 'proficiency', 'economy', 'affinity', 'classes', 'condition', 'temper', 'bonds', 'crew',
    'ai', 'gifts', 'elements', 'spellcraft', 'psionic', 'martial', 'prowess', 'consume', 'combat', 'bestiary', 'missions', 'sacrifice']) require(path.join(root, m + '.js'));
}

let failed = 0, checks = 0;
const check = (cond, msg) => { checks++; if (!cond) { failed++; console.log('FAIL ' + msg); } else if (process.env.SHOW) console.log('ok   ' + msg); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const scenario = (name, fn) => {
  try { fn(); } catch (e) { failed++; console.log(`FAIL ${name}: threw ${e && e.stack}`); }
};
const ascenario = async (name, fn) => {
  try { await fn(); } catch (e) { failed++; console.log(`FAIL ${name}: threw ${e && e.stack}`); }
};

// ---------- Part A: modules in Node ----------

const RACES = ['human', 'draconic', 'therian'];
function makeChar(id, { stars = 3, cls = 'fighter' } = {}) {
  const race = RACES[id % RACES.length];
  const c = { id, name: 'C' + id, race, stats: Stats.rollCharacterStats(race, Math.random, stars), equipment: {}, mind: { traits: [] },
    temper: Temper.roll(), xp: {}, potions: [], injured: 0, mission: null, job: null, progress: 0, techniques: {}, lexicon: [], facets: [], facetState: {} };
  c.profs = Prof.rollAll(stars, race);
  c.affinity = Affinity.roll(); c.psiOrder = Psionic.rollAxisOrder();
  c.gifts = Gifts.roll(c.stats, race); Gifts.ensure(c, null);
  if (Gifts.has(c, 'arcana')) c.lexicon = Spellcraft.rollLexicon(stars);
  Classes.assign(c, cls, { force: true });
  Condition.ensure(c);
  return c;
}
function makeTown(chars) {
  return { gems: 1000, crops: 0, ore: 100, herbs: 0, characters: chars, inventory: {}, log: [], mercy: {}, bonds: {},
    missions: { active: [], done: {}, history: [] }, nextId: 1, field: { board: [], rolledAt: 0 }, teams: [], trials: {} };
}
/** What Condition.wound should give for a lowest HP fraction, written out from the two constants. */
const expectedTicks = (low) => Math.round(Condition.WOUND_TICKS * clamp((Condition.WOUND_FROM - low) / Condition.WOUND_FROM, 0, 1));

function partA() {
  scenario('constants', () => {
    check(Condition.WOUND_TICKS === Missions.INJURY_TICKS, `Condition.WOUND_TICKS (${Condition.WOUND_TICKS}) equals Missions.INJURY_TICKS (${Missions.INJURY_TICKS}), the Node-only injury for a death`);
    check(Condition.WOUND_FROM > 0 && Condition.WOUND_FROM < 1, `WOUND_FROM is a fraction of max HP (${Condition.WOUND_FROM})`);
  });

  scenario('wound arithmetic', () => {
    const F = Condition.WOUND_FROM, T = Condition.WOUND_TICKS;
    const c = makeChar(1);
    check(Condition.wound(c, 1) === null && c.injured === 0, 'a full-HP low injures nobody');
    check(Condition.wound(c, F) === null && c.injured === 0, `a low of exactly WOUND_FROM (${F}) injures nobody`);
    check(Condition.wound(c, F - 0.001) === null && c.injured === 0, 'a low just under WOUND_FROM rounds to 0 ticks and injures nobody');
    check(Condition.wound(c, NaN) === null && Condition.wound(c, undefined) === null && c.injured === 0, 'a low that is not a number injures nobody');
    const half = Condition.wound(c, F / 2, 'Test Cave');
    check(half && half.ticks === Math.round(T / 2) && c.injured === Math.round(T / 2), `half of WOUND_FROM costs half of WOUND_TICKS (${c.injured})`);
    check(c.woundNote && c.woundNote.low === F / 2 && c.woundNote.where === 'Test Cave', `the cause is recorded (${JSON.stringify(c.woundNote)})`);
    const zero = makeChar(2);
    check(Condition.wound(zero, 0).ticks === T && zero.injured === T, `0 HP costs WOUND_TICKS (${zero.injured})`);
    const below = makeChar(3);
    Condition.wound(below, -0.3);
    check(below.injured === T, 'a low under 0 is capped at WOUND_TICKS');
    // a longer injury already owed is kept, a shorter one is replaced
    const longer = makeChar(4); longer.injured = T * 3;
    Condition.wound(longer, 0, 'Elsewhere');
    check(longer.injured === T * 3 && !longer.woundNote, 'a longer injury is kept and its note is not overwritten');
    const shorter = makeChar(5); shorter.injured = 2;
    Condition.wound(shorter, 0, 'Test Cave');
    check(shorter.injured === T && shorter.woundNote.where === 'Test Cave', 'a shorter injury is replaced');
    // monotone: a lower low never costs less
    let prev = -1, ok = true;
    for (let low = 1; low >= 0; low -= 0.01) {
      const x = makeChar(6); Condition.wound(x, low);
      if (x.injured < prev) ok = false;
      check(x.injured === expectedTicks(low), `low ${low.toFixed(2)}: ${x.injured} ticks, expected ${expectedTicks(low)}`);
      prev = x.injured;
    }
    check(ok, 'ticks never fall as the low falls');
  });

  scenario('recovery per town tick', () => {
    const [a, b] = [makeChar(1), makeChar(2)];
    const state = makeTown([a, b]);
    const FED = Condition.FED_REST;
    a.injured = 10; a.woundNote = { low: 0.1, where: 'X' };
    Missions.recover(state);
    check(near(a.injured, 9) && a.woundNote, `without lodging.js a tick heals 1 (${a.injured})`);
    Missions.recover(state, true);
    check(near(a.injured, 9 - FED), `a fed tick heals FED_REST (${a.injured})`);
    check(b.injured === 0, 'somebody who is not injured is untouched');
    a.injured = 0.5;
    Missions.recover(state);
    check(a.injured === 0 && !('woundNote' in a), 'an injury shorter than the rate ends at exactly 0 and the note is deleted');
    check(Condition.healRate(1.6, true) === 1.6 * FED && Condition.healRate(0.75) === 0.75, 'healRate is the rest multiplier times FED_REST while fed');

    // with lodging.js loaded the bed sets the rate
    global.Lodging = { restFor: (s, c) => (c.id === 1 ? 1.6 : 0.75) };
    try {
      a.injured = 10; b.injured = 10;
      Missions.recover(state);
      check(near(a.injured, 10 - 1.6) && near(b.injured, 10 - 0.75), `the bed sets the rate (${a.injured}, ${b.injured})`);
      a.injured = 10; b.injured = 10;
      Missions.tick(state, { fed: true });
      check(near(a.injured, 10 - 1.6 * FED) && near(b.injured, 10 - 0.75 * FED), `Missions.tick passes fed (${a.injured}, ${b.injured})`);
      a.injured = 10;
      Missions.tick(state);
      check(near(a.injured, 10 - 1.6), `Missions.tick without options is not fed (${a.injured})`);

      // the ticks it takes are the ticks the picker and the sheet show
      for (const rest of [0.75, 0.9, 1.0, 1.25, 1.6]) for (const fed of [false, true]) for (const start of [1, 7, 30, 31]) {
        global.Lodging = { restFor: () => rest };
        const x = makeChar(9), town = makeTown([x]);
        x.injured = start; x.woundNote = { low: 0, where: 'X' };
        const eta = Condition.woundTicks(x, rest, fed);
        let n = 0;
        while (x.injured > 0 && n < 500) { Missions.recover(town, fed); n++; }
        check(n === eta, `rest ${rest}${fed ? ' fed' : ''}, ${start} wound ticks: woundTicks says ${eta}, healing takes ${n}`);
      }
    } finally { delete global.Lodging; }
    check(Condition.woundTicks({ injured: 0 }) === 0 && Condition.woundTicks({}) === 0, 'woundTicks is 0 for somebody who is not injured');
  });

  scenario('readyIn splits the injury from the stamina and pool debt', () => {
    const c = makeChar(7, { cls: 'cleric', stars: 4 });
    const cond = Condition.ensure(c), d = Stats.effective(c).derived;
    cond.stamina = d.stamina * 0.3;
    cond[cond.pool] = d[cond.pool] * 0.1;
    c.injured = 0;
    const rested = Condition.readyIn(c, 1.4, true, true);
    check(rested.injury === 0 && rested.rest === rested.ticks && rested.restLimit === rested.limit, `no injury: the rest limit is the whole limit (${JSON.stringify(rested)})`);
    c.injured = 200;
    const slow = Condition.readyIn(c, 1.4, true, true);
    check(slow.limit === 'injury' && slow.injury === Condition.woundTicks(c, 1.4, true) && slow.ticks === slow.injury, `a long injury sets the limit (${JSON.stringify(slow)})`);
    check(slow.rest === rested.rest && slow.restLimit === rested.restLimit, 'and the rest figures do not depend on the injury');
    c.injured = 1;
    const quick = Condition.readyIn(c, 1.4, true, true);
    check(quick.injury === 1 && quick.limit === rested.limit && quick.ticks === rested.ticks, `a short injury leaves the rest limit in charge (${JSON.stringify(quick)})`);
    const fresh = makeChar(8);
    fresh.injured = 5;
    const only = Condition.readyIn(fresh, 1, false, true);
    check(only.injury === 5 && only.rest === 0 && only.restLimit === null && only.limit === 'injury' && only.ticks === 5, `injury only (${JSON.stringify(only)})`);
    // the rest figure is the number of resting ticks, as in test/debrief.js
    const r = makeChar(10, { cls: 'fighter', stars: 4 });
    Condition.ensure(r).stamina = Stats.effective(r).derived.stamina * 0.25;
    const want = Condition.readyIn(r, 1.2, false, true).rest;
    let n = 0;
    while (!Condition.isRested(r) && n < 1000) { Condition.tick(r, { job: null, housed: true, restMult: 1.2, fed: false }); n++; }
    check(n === want, `rest is ${want} ticks and resting takes ${n}`);
  });

  scenario('one wound figure: Condition.wounded', () => {
    const c = makeChar(21), town = makeTown([c]);
    check(Condition.wounded(town, c) === null, 'somebody who is not injured has no wound reading');
    c.injured = 18.5; c.woundNote = { low: 0.1, where: 'Goblin Camp' };
    // the bed as Lodging gives it: a building with a label and a rest multiplier
    global.Lodging = { restFor: () => 1.45, bedOf: () => ({ type: 'cottages' }), typeOf: () => ({ label: 'Cottages' }), housed: () => true };
    try {
      const unfed = Condition.wounded(town, c);
      town.inventory = { m1: { kind: 'meal', count: 0 } };
      check(Condition.wounded(town, c).ticks === unfed.ticks, 'a meal stack with count 0 does not feed the town');
      town.inventory = { m1: { kind: 'meal', count: 3 } };
      const fed = Condition.wounded(town, c);
      check(Condition.pantryFed(town) === true && Condition.pantryFed(makeTown([c])) === false, 'pantryFed is whether a meal stack has a meal in it');
      check(unfed.ticks === 13 && fed.ticks === 11, `18.5 wound ticks at bed 1.45: 13 ticks unfed, 11 fed (${unfed.ticks}, ${fed.ticks})`);
      check(fed.ticks === Condition.woundTicks(c, 1.45, true) && fed.ticks === Condition.readyAt(town, c).injury && fed.ticks === Condition.readyIn(c, 1.45, true, true).injury, 'the reading is woundTicks and readyIn().injury at the same rest');
      check(fed.text === 'recovering, back in 11 ticks', `the phrase (${fed.text})`);
      check(Condition.wounded(town, Object.assign(makeChar(22), { injured: 1 })).text === 'recovering, back in 1 tick', 'one tick is singular');
      // the tooltip names every factor and the division, so the figure can be checked by hand
      check(fed.why.includes('Healing per tick: 1.8125 = bed 1.45 (Cottages) x meals 1.25 (the pantry has meals)'), `fed tooltip: bed and meals as the factors of 1.8125 (${fed.why})`);
      check(fed.why.includes('18.5 / 1.8125 = 10.21, rounded up to 11 ticks') && fed.why.includes('Cause: lowest HP 10% at Goblin Camp.'), 'fed tooltip: the division and the cause');
      check(unfed.why.includes('Healing per tick: 1.45 = bed 1.45 (Cottages); the pantry has no meals, which would multiply it by 1.25') && unfed.why.includes('18.5 / 1.45 = 12.76, rounded up to 13 ticks'), `unfed tooltip: one factor, and what a meal would add (${unfed.why})`);
      check(near(1.45 * Condition.FED_REST, 1.8125) && (18.5 / 1.8125).toFixed(2) === '10.21', 'the printed product and quotient are the ones the numbers give');
      // it is the number of town ticks the healing takes, in both pantry states
      for (const [state, w] of [[makeTown([c]), unfed], [town, fed]]) {
        const x = Object.assign(makeChar(23), { injured: 18.5, woundNote: { low: 0.1, where: 'X' } });
        state.characters = [x];
        let n = 0;
        while (x.injured > 0 && n < 100) { Missions.recover(state, Condition.pantryFed(state)); n++; }
        check(n === w.ticks, `${Condition.pantryFed(state) ? 'fed' : 'unfed'}: Missions.recover took ${n} ticks, the reading said ${w.ticks}`);
      }
      // outside: the bed is named as none
      global.Lodging = { restFor: () => 0.75, bedOf: () => null, housed: () => false };
      check(Condition.wounded(makeTown([c]), c).why.includes('bed 0.75 (no bed)'), 'with no bed the tooltip says so');
    } finally { delete global.Lodging; }
    const plain = Condition.wounded(makeTown([c]), c);
    check(plain.ticks === 19 && plain.why.includes('Healing per tick: 1.00 = rest 1.00;'), `without lodging.js the rest is 1.00 and not a bed (${plain.ticks})`);
  });

  scenario('readyText', () => {
    const r = (o) => ({ injury: 0, ticks: 0, limit: null, rest: 0, restLimit: null, ...o });
    check(Condition.readyText(r({})) === 'ready', 'nothing owed: ready');
    check(Condition.readyText(r({ ticks: 2, limit: 'stamina', rest: 2, restLimit: 'stamina' })) === 'ready in 2 ticks: stamina', 'a debt: ready in 2 ticks: stamina');
    check(Condition.readyText(r({ ticks: 1, limit: 'mana', rest: 1, restLimit: 'mana' })) === 'ready in 1 tick: mana', 'one tick is singular');
    check(Condition.readyText(r({ injury: 11, ticks: 11, limit: 'injury', rest: 2, restLimit: 'stamina' })) === 'rested in 2 ticks: stamina', 'injured: only the pool and stamina are described, as rested');
    check(Condition.readyText(r({ injury: 11, ticks: 11, limit: 'injury' })) === 'rested', 'injured with nothing owed in stamina: rested');
    check(!/\(|stamina and pool/.test(Condition.readyText(r({ ticks: 3, limit: 'spirit', rest: 3, restLimit: 'spirit' }))), 'no parenthesis and no "stamina and pool"');
  });

  scenario('debrief wounds the survivors once', () => {
    const chars = [1, 2, 3, 4, 5].map(i => makeChar(i));
    const state = makeTown(chars);
    const F = Condition.WOUND_FROM;
    const lows = [1, F + 0.05, F / 2, 0, undefined];
    const survivors = chars.map((c, i) => ({ c, hp: 1, casts: 0, low: lows[i] }));
    const out = Missions.debrief(state, { survivors, fallen: 0, won: true, level: 3, fights: 2, where: 'Test Cave' });
    chars.forEach((c, i) => {
      const want = lows[i] === undefined ? 0 : expectedTicks(lows[i]);
      check(c.injured === want, `${c.name}: low ${lows[i]} gives ${c.injured} ticks, expected ${want}`);
    });
    check(out.hurt.length === 2 && out.hurt[0].c === chars[2] && out.hurt[1].c === chars[3], `hurt lists the two injured survivors in order (${out.hurt.map(h => h.c.name)})`);
    const wl = out.lines.filter(l => /Injured at/.test(l));
    check(wl.length === 1, `one wound line for the run, not one per person (${wl.length})`);
    check(wl[0] && wl[0].includes('Test Cave') && wl[0].includes(chars[2].name) && wl[0].includes(chars[3].name) && wl[0].includes(chars[3].injured + ' ticks') && wl[0].includes('lowest HP'), `the line names the mission, who, the ticks and the low (${wl[0]})`);
    check(!wl[0].includes(chars[0].name) && !wl[0].includes(chars[4].name), 'and not the others');
    // a second debrief with the same low keeps the injury, it does not add to it
    const t0 = chars[3].injured;
    Missions.debrief(state, { survivors: [survivors[3]], fallen: 0, won: true, level: 3, fights: 2, where: 'Test Cave' });
    check(chars[3].injured === t0, `a second debrief does not stack (${chars[3].injured})`);
    // no mission name: the line still reads
    const solo = makeChar(11), s2 = makeTown([solo]);
    const o2 = Missions.debrief(s2, { survivors: [{ c: solo, hp: 0.1, casts: 0, low: 0.1 }], fallen: 0, won: false, level: 1, fights: 1 });
    check(o2.lines.some(l => /^.{1,4}Injured: /.test(l)) && solo.injured === expectedTicks(0.1), `without a mission name (${o2.lines.find(l => /Injured/.test(l))})`);
    // second-order: the injury pulls the morale target down by at least the 15 in moraleTarget
    const healthy = makeChar(12), hurt = makeChar(13);
    hurt.injured = 10;
    healthy.temper = hurt.temper = chars[0].temper;
    const tgt = (x) => Condition.moraleTarget(x, { housed: true, working: false, restMult: 1, lodging: 0, fed: true, social: 0 });
    const shift = (injured) => Temper.moraleShift(healthy, { housed: true, working: false, spent: false, injured, fed: true });
    check(near(tgt(healthy) - tgt(hurt), 15 + shift(false) - shift(true)), `an injured character's morale target is 15 lower, plus what its temper makes of the hardship (${tgt(healthy)} vs ${tgt(hurt)})`);
    check(tgt(healthy) > tgt(hurt), 'and lower overall');
  });

  scenario('the debrief line prints the figure every screen prints', () => {
    // bed x1.6 and meals: a 30-tick wound heals in 15 ticks, and the line has to say 15 and not 30
    const chars = [31, 32].map(i => makeChar(i));
    const state = makeTown(chars);
    state.inventory = { m1: { kind: 'meal', count: 5 } };
    global.Lodging = { restFor: () => 1.6, bedOf: () => ({ type: 'manor' }), typeOf: () => ({ label: 'Manor' }), housed: () => true };
    try {
      const out = Missions.debrief(state, { survivors: [{ c: chars[0], hp: 0.2, casts: 0, low: 0 }, { c: chars[1], hp: 1, casts: 0, low: Condition.WOUND_FROM / 2 }], fallen: 0, won: true, level: 3, fights: 1, where: 'Test Cave' });
      const line = out.lines.find(l => /Injured at/.test(l));
      check(chars[0].injured === Condition.WOUND_TICKS && chars[1].injured === Math.round(Condition.WOUND_TICKS / 2), `setup: wounds of ${chars[0].injured} and ${chars[1].injured} ticks`);
      for (const c of chars) {
        const w = Condition.wounded(state, c);
        check(w.ticks === Math.ceil(c.injured / (1.6 * Condition.FED_REST) - 1e-9) && w.ticks < c.injured, `${c.name}: ${c.injured} wound ticks at bed 1.6 with meals take ${w.ticks}`);
        check(line && line.includes(`${c.name} back in ${w.ticks} ticks`), `the line gives ${c.name}'s ${w.ticks} ticks (${line})`);
      }
      check(line && !line.includes(`${chars[0].injured} ticks`), 'and not the length of the wound before healing');
    } finally { delete global.Lodging; }
  });

  scenario('Gate run', () => {
    // one-star fighters at the first zone: some runs leave a survivor under WOUND_FROM
    let found = 0, checked = 0;
    for (let seed = 1; seed <= 60 && found < 3; seed++) {
      const chars = [1, 2, 3, 4].map(i => makeChar(i, { stars: 1, cls: 'fighter' }));
      const state = makeTown(chars);
      Rng.withSource(mulberry(seed), () => {
        const run = Missions.launch(state, 'wolf_trail', chars.map(c => c.id));
        if (typeof run !== 'object') { check(false, `launch (${run})`); return; }
        let finished = null;
        for (let i = 0; i < 100 && !finished; i++) finished = Missions.tick(state).find(r => r === run) || null;
        check(!!finished, 'the run finishes');
        for (const id of run.party) {
          const mem = run.members[id];
          check(mem.low >= 0 && mem.low <= 1 && mem.low <= mem.hp + 1e-9, `member low ${mem.low} is a fraction at or under the final HP ${mem.hp}`);
          const c = chars.find(x => x.id === id);
          if (!mem.alive) continue;
          checked++;
          check(c.injured === expectedTicks(mem.low), `${c.name}: low ${mem.low.toFixed(2)} gives ${c.injured} ticks, expected ${expectedTicks(mem.low)} (full length: the tick that ended the run did not heal it)`);
          if (c.injured > 0) { found++; check(c.woundNote && c.woundNote.low === mem.low && c.woundNote.where === 'Wolf Trail', `the cause is recorded (${JSON.stringify(c.woundNote)})`); }
        }
        if (chars.some(c => c.injured > 0)) check(run.log.filter(l => /Injured at Wolf Trail/.test(l)).length === 1, 'the run log has one wound line');
      });
    }
    check(found > 0 && checked > 0, `setup: a Gate run that wounds somebody was found (${found} wounded among ${checked} survivors)`);
  });
}

// ---------- Part B: the booted page ----------

/** All the text and the elements under `el` in the stub DOM. */
function walk(el, out = []) {
  out.push(el);
  for (const k of el._kids || []) walk(k, out);
  return out;
}
const textOf = (el) => walk(el).map(e => (e._html || '') + ' ' + (e._text || '')).join('\n');

async function partB() {
  const { setup } = require('./sortie.harness.js');
  const lab = await setup({ poolSize: 12 });
  if (lab.bootFailed || lab.failed) { failed++; console.log('FAIL part B: ' + (lab.failed || 'the page did not boot')); if (lab.b) lab.b.dispose(); return; }
  const { b, ctx, st, S } = lab;
  const Cond = ctx.Condition, Lo = ctx.Lodging;
  const F = Cond.WOUND_FROM;
  const types = Object.keys(ctx.MissionTypes.TYPES);
  const pantry = (n) => {
    const item = ctx.Econ.craftItem('meal', 1, { stage: 4 }, () => 0.5);
    for (let i = 0; i < n; i++) b.Game.addItem(Object.assign({}, item));
  };
  // the town's kitchen crafts meals while the test runs; an unfed case empties the pantry after every tick
  const dropMeals = () => { for (const [id, it] of Object.entries(st.inventory)) if (it.kind === 'meal') delete st.inventory[id]; };
  const tickOnce = (fed) => { b.advance(10000); if (!fed) dropMeals(); };

  await ascenario('settle', async () => {
    let rec = null;
    for (let seed = 1; seed <= 60 && !rec; seed++) {
      lab.restore();
      const r = lab.play({ seed, type: types[seed % types.length], level: 4 });
      if (r.result && r.survivors.some(s => s.hurt)) rec = r;
    }
    check(!!rec, 'setup: a contract that wounds a survivor was found');
    if (!rec) return;
    const run = S.run;
    const squad = run.field.actors.filter(a => a.role === 'squad' && a.char);
    let injured = 0;
    for (const a of squad) {
      const c = st.characters.find(x => x.id === a.char.id);
      if (!c) continue;                                    // died
      const end = a.fighter ? a.fighter.hp / a.fighter.maxHp : 1;
      if (a.low !== undefined) check(a.low >= 0 && a.low <= end + 1e-9, `${c.name}: low ${a.low.toFixed(3)} is at or under the HP at settle ${end.toFixed(3)}`);
      const want = a.low === undefined ? 0 : Math.round(Cond.WOUND_TICKS * clamp((F - a.low) / F, 0, 1));
      check(c.injured === want, `${c.name}: low ${a.low} gives ${c.injured} ticks, expected ${want}`);
      if (c.injured > 0) {
        injured++;
        check(c.woundNote && c.woundNote.low === a.low && c.woundNote.where === run.mission.name, `${c.name}: woundNote ${JSON.stringify(c.woundNote)}`);
      }
    }
    check(injured > 0, 'at least one survivor is injured');
    const lines = st.log.filter(l => /Injured at /.test(l.text));
    check(lines.length === 1 && lines[0].text.includes(run.mission.name), `one town log line for the run (${lines.map(l => l.text).join(' | ')})`);
  });

  await ascenario('save and resume', async () => {
    lab.restore();
    const ids = st.characters.slice(0, 4).map(c => c.id);
    const board = b.withSeed(lab.cfg.seed, () => S.board(st, true));
    let run = null;
    for (const mission of board.filter(m => m.party[0] <= ids.length && m.party[1] >= ids.length)) {
      lab.restore();
      const r = b.withSeed(lab.cfg.seed, () => S.launch(mission, ids));
      if (typeof r === 'string') { check(false, 'launch refused: ' + r); return; }
      b.advance(20000);
      if (!S.run.field.result) { run = S.run; break; }
    }
    check(!!run, 'setup: a contract still running after 20 s of virtual time');
    if (!run) return;
    const squad = run.field.actors.filter(a => a.role === 'squad' && a.char);
    squad.forEach((a, i) => { a.low = [0.11, 0.37, 0.64, 1][i % 4]; });
    b.fire('window', 'beforeunload');
    const b2 = await boot({ html: 'game.html', storage: new Map(b.localStorage.map) });
    try {
      const run2 = b2.Sortie && b2.Sortie.run;
      check(!!run2, 'the second page resumed a run');
      if (run2) {
        const back = run2.field.actors.filter(a => a.role === 'squad' && a.char);
        check(back.length === squad.length, `the squad came back (${back.length})`);
        for (const a of back) {
          const was = squad.find(x => x.char.id === a.char.id);
          check(a.low === was.low, `${a.char.name}: low ${a.low} after the reload, ${was.low} before`);
        }
        check(run2.field.actors.filter(a => a.role !== 'squad').every(a => a.low === undefined), 'hostile actors carry no low');
      }
    } finally { b2.dispose(); }
  });

  await ascenario('town tick heals by bed and pantry', async () => {
    for (const fed of [false, true]) {
      lab.restore();
      if (fed) pantry(400);
      const c = st.characters[0];
      tickOnce(fed);                                       // state.lastTick is stale after restore(); this tick resets it, so each tickOnce below is one tick
      c.injured = 25; c.woundNote = { low: 0.05, where: 'Test Cave' };
      const rest = Lo.restFor(st, c);
      const t0 = st.ticks;
      tickOnce(fed); tickOnce(fed);
      const n = st.ticks - t0;
      const rate = rest * (fed ? Cond.FED_REST : 1);
      check(n >= 1, `${fed ? 'fed' : 'unfed'}: the town ticked (${n})`);
      check(near(c.injured, 25 - n * rate), `${fed ? 'fed' : 'unfed'}: ${n} tick(s) at rest x${rest.toFixed(2)} heal ${n * rate}, injured is ${c.injured}`);
    }
    // the ETA shown for somebody is the number of town ticks it takes
    for (const fed of [false, true]) {
      lab.restore();
      if (fed) pantry(400);
      const c = st.characters[1];
      tickOnce(fed);
      c.injured = 17; c.woundNote = { low: 0.1, where: 'Test Cave' };
      const eta = Cond.woundTicks(c, Lo.restFor(st, c), fed);
      const t0 = st.ticks;
      for (let i = 0; i < 100 && c.injured > 0; i++) tickOnce(fed);
      const n = st.ticks - t0;
      check(c.injured === 0 && !c.woundNote, `${fed ? 'fed' : 'unfed'}: healed and the note is gone`);
      check(n === eta, `${fed ? 'fed' : 'unfed'}: Condition.woundTicks said ${eta}, the town took ${n} ticks`);
    }
  });

  await ascenario('picker lists a recovering character greyed', async () => {
    lab.restore();
    S.discard();                                           // render() draws the live run, if there is one, instead of the board
    const hurt = st.characters[0];
    hurt.injured = 14; hurt.woundNote = { low: 0.1, where: 'Goblin Camp' };
    const cond = Cond.ensure(hurt), d = ctx.Stats.effective(hurt).derived;
    cond.stamina = d.stamina * 0.5;
    // the party picker only draws once a contract is picked; the party box is drawn either way
    S.render();
    const host = ctx.document.getElementById('sortie');
    check(!!host, 'the Field panel host exists');
    if (!host) return;
    const text = textOf(host);
    const eta = Cond.readyIn(hurt, Lo.restFor(st, hurt), false, Lo.housed(st, hurt));
    check(eta.injury === Cond.woundTicks(hurt, Lo.restFor(st, hurt), false), `readyIn.injury is the wound ETA (${eta.injury})`);
    check(text.includes(`recovering, back in ${eta.injury} ticks`), `the card says when the wound is over (${eta.injury} ticks)`);
    const tk = (n) => n + (n === 1 ? ' tick' : ' ticks');
    check(text.includes(eta.rest > 0 ? `rested in ${tk(eta.rest)}: ${eta.restLimit}` : 'rested'), `and when stamina and pool are back (${eta.rest} ticks, ${eta.restLimit}) on the same card, in plain words`);
    check(!text.includes('stamina and pool ready'), 'the old wording is gone');
    check(text.includes('1 recovering, first back in ' + eta.injury + ' ticks'), 'the party box counts who is recovering and when the first is back');
    check(text.includes('lowest HP 10% at Goblin Camp'), 'the tooltip names the low and the mission');
    const nodes = walk(host);
    const grey = nodes.filter(e => e.style && e.style.opacity === '0.55');
    check(grey.length === 1, `exactly one card is greyed (${grey.length})`);
    const btn = nodes.filter(e => e.tagName === 'BUTTON' && /^Recovering$/.test(e._text || ''));
    check(btn.length === 1 && btn[0].disabled === true, 'its button reads Recovering and is disabled');
    const sends = nodes.filter(e => e.tagName === 'BUTTON' && /^(Send|Stay)$/.test(e._text || ''));
    check(sends.length >= 1, `the other cards keep their Send buttons (${sends.length})`);
    // the recovering card comes after every card that can be sent
    const order = nodes.filter(e => e.tagName === 'BUTTON' && /^(Send|Stay|Recovering)$/.test(e._text || '')).map(e => e._text);
    check(order.lastIndexOf('Send') < order.indexOf('Recovering') || order.indexOf('Send') < 0, `recovering cards are listed last (${order.join(',')})`);

    // loading a team that has a recovering member leaves that member out and says why and for how long
    const mate = st.characters[1];
    ctx.Crew.create(st, 'Wound Team', [hurt.id, mate.id]);
    S.render();
    const card = walk(ctx.document.getElementById('sortie')).find(e => (e._html || '').includes('Wound Team') && (e._l || {}).click);
    check(!!card, 'the team card is drawn and clickable');
    if (card) {
      card.click();
      const note = textOf(ctx.document.getElementById('sortie'));
      check(note.includes(`${hurt.name} recovering, back in ${eta.injury} ticks, not loaded`), 'loading the team says who is recovering and for how long');
      const party = walk(ctx.document.getElementById('sortie')).filter(e => e.tagName === 'BUTTON' && e._text === 'Stay');
      check(party.length === 1, `only the free member is in the party (${party.length})`);
    }
  });

  await ascenario('every screen prints one wound figure', async () => {
    // 18.5 wound ticks at the bed the roster's first character has: with and without a meal in the pantry
    // the figure differs (11 and 13 at bed x1.45), and each screen has to print the one for the pantry as it is now
    for (const fed of [false, true]) {
      lab.restore();
      S.discard();
      dropMeals();
      if (fed) pantry(400);
      const tag = fed ? 'fed' : 'unfed';
      const hurt = st.characters[0], mate = st.characters[1];
      hurt.injured = 18.5; hurt.woundNote = { low: 0.1, where: 'Goblin Camp' };
      const rate = Lo.restFor(st, hurt) * (fed ? Cond.FED_REST : 1);
      const eta = Math.ceil(18.5 / rate - 1e-9);
      const w = Cond.wounded(st, hurt);
      check(w && w.ticks === eta && eta > 1, `${tag}: the reading is 18.5 over the bed's rate ${rate.toFixed(4)}, rounded up (${w && w.ticks}, expected ${eta})`);
      const phrase = `recovering, back in ${eta} ticks`;
      const seen = new Map();
      const read = (screen, text, want) => {
        const nums = [...text.matchAll(/back in (\d+) ticks?/g)].map(m => +m[1]);
        seen.set(screen, nums);
        check(nums.length > 0 && nums.every(n => n === eta), `${tag}: ${screen} prints ${eta} everywhere it prints a figure (${nums.join(',') || 'none'})`);
        if (want) check(text.includes(want), `${tag}: ${screen} says ${want}`);
      };
      ctx.Game.renderRoster();
      const roster = ctx.document.getElementById('roster-panel');
      read('the roster tile', textOf(roster), phrase);
      const tile = walk(roster).find(e => e.title === `${hurt.name} — open the sheet`);
      check(!!tile, `${tag}: the roster has the character's tile`);
      if (tile) { tile.click(); read('the sheet', textOf(ctx.document.getElementById('sheet')), phrase); }
      ctx.Game.renderAll();
      read('the gate party', textOf(ctx.document.getElementById('gate')), `Recovering, back in ${eta} ticks`);
      S.render();
      read('the picker card and the party box', textOf(ctx.document.getElementById('sortie')), `1 recovering, first back in ${eta} ticks`);
      check(textOf(ctx.document.getElementById('sortie')).includes(phrase), `${tag}: the picker card says ${phrase}`);
      ctx.Crew.create(st, 'Wound Team ' + tag, [hurt.id, mate.id]);
      S.render();
      const card = walk(ctx.document.getElementById('sortie')).find(e => (e._html || '').includes('Wound Team ' + tag) && (e._l || {}).click);
      if (card) { card.click(); read('the team note', textOf(ctx.document.getElementById('sortie')), `${hurt.name} recovering, back in ${eta} ticks, not loaded`); }
      else check(false, `${tag}: the team card is drawn`);
      // the Field board is redrawn by the town tick while its tab is open, so its figure keeps up with the roster's
      if (fed) {
        S.discard();
        ctx.document.querySelector('.tab[data-tab="field"]').click();
        S.render();
        tickOnce(true);
        const after = Cond.wounded(st, hurt);
        const printed = [...textOf(ctx.document.getElementById('sortie')).matchAll(/first back in (\d+) ticks?/g)].map(m => +m[1]);
        check(after.ticks < eta && printed.length === 1 && printed[0] === after.ticks, `${tag}: one tick later the board prints ${after.ticks}, down from ${eta} (${printed})`);
      }
      // the tooltip carries the factors of the rate: the bed building and, when fed, the meals
      const tip = textOf(ctx.document.getElementById('sortie'));
      const bed = Lo.bedOf(st, hurt);
      check(new RegExp(`bed [0-9.]+ \\(${Lo.typeOf(bed).label}\\)`).test(tip) && (fed ? tip.includes('meals 1.25 (the pantry has meals)') : tip.includes('the pantry has no meals')), `${tag}: the tooltip names the bed and the pantry`);
    }
  });

  const late = lab.b.errors.length - lab.bootErrors;
  check(late === 0, `no uncaught exception after boot (${late})`);
  if (late) for (const e of lab.b.errors.slice(lab.bootErrors, lab.bootErrors + 5)) console.log(`  ${e.where}: ${e.name}: ${e.message}`);
  lab.b.dispose();
}

// ---------- measure ----------

/** Summon from the page's own button until the roster is back at POOL; a pull outside the star range or without a class is dropped. */
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

async function measure() {
  process.env.CHAIN = '1';
  const { setup } = require('./sortie.harness.js');
  const lab = await setup();
  if (lab.bootFailed || lab.failed) { console.log('setup failed: ' + (lab.failed || 'the page did not boot')); if (lab.b) lab.b.dispose(); return 2; }
  const { cfg, st } = lab;
  const need = cfg.squadSize || 4;
  const jobs = [];
  for (let i = 0; i < cfg.runs; i++) jobs.push({ type: cfg.types[i % cfg.types.length], i });
  const recs = [], waits = [], unavailable = [], ticks = [], longest = [];
  let blocked = 0, stopped = false;
  for (const job of jobs) {
    const level = cfg.levels[job.i % cfg.levels.length];
    const seed = ((cfg.seed * 1000003 + cfg.allTypes.indexOf(job.type) * 7919 + job.i * 104729 + 17) >>> 0);
    const w = lab.wait(need);
    if (w < 0) { stopped = true; break; }
    if (w > 0) { blocked++; waits.push(w); }
    unavailable.push(st.characters.filter(c => c.injured > 0).length / st.characters.length);
    const rec = lab.play({ seed, type: job.type, level });
    recs.push(rec);
    // wound ticks owed by each squad member right after the contract, before any town tick
    const owed = (rec.squad || []).map(m => (st.characters.find(c => c.id === m.id) || {}).injured || 0).filter(n => n > 0);
    ticks.push(...owed);
    if (owed.length) longest.push(Math.max(...owed));
    lab.b.advance(1000 + cfg.rest * 10000);
    refill(lab);
  }
  const done = recs.filter(r => r.result);
  const surv = done.flatMap(r => r.survivors);
  const hurt = surv.filter(s => s.hurt).length;
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const pct = (n, d) => (d ? (100 * n / d).toFixed(0) : '-');
  console.log(`POOL=${cfg.pool} REST=${cfg.rest} squad=${need} seed=${cfg.seed} contracts ${done.length}/${recs.length}${stopped ? ' (stopped: no squad could be freed)' : ''}`);
  console.log(`  win ${pct(done.filter(r => r.result.won).length, done.length)}%  dead/run ${mean(done.map(r => r.deaths)).toFixed(2)}`);
  console.log(`  survivors injured ${pct(hurt, surv.length)}%  sorties with at least one injured ${pct(done.filter(r => r.survivors.some(s => s.hurt)).length, done.length)}%  injured/run ${(hurt / Math.max(1, done.length)).toFixed(2)}`);
  console.log(`  wound length: mean ${mean(ticks).toFixed(1)} ticks over ${ticks.length} injured survivors, mean longest in a sortie that has one ${mean(longest).toFixed(1)} ticks (before the bed and the pantry speed it up)`);
  console.log(`  launches blocked ${blocked}/${recs.length} (${pct(blocked, recs.length)}%)  mean wait when blocked ${mean(waits).toFixed(1)} ticks  mean share of the roster injured at launch ${pct(mean(unavailable) * 100, 100)}%`);
  lab.b.dispose();
  return 0;
}

// ---------- main ----------

(async () => {
  if (command === 'measure') { process.exitCode = await measure(); return; }
  if (command !== 'check') { console.log('usage: node test/wounds.js [check | measure]'); process.exitCode = 2; return; }
  partA();
  const a = checks;
  await partB();
  console.log(`part A ${a} checks, part B ${checks - a} checks`);
  console.log(`${checks} checks, ${failed ? failed + ' failed' : 'all passed'}`);
  process.exit(failed ? 1 : 0);
})();
