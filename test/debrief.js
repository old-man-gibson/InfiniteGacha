// Debrief and the death path. `node test/debrief.js`; exit code 1 on any failure.
//
// Part A loads the modules in Node, as test/lifecycle.js does, and checks the arithmetic:
//   Missions.debrief   class XP, stamina, caster pool, morale, bonds and the loot multiplier
//   Roster.fallAll     the death path: snapshot, fall, mourn, crew, in that order, for one death,
//                      for deaths in the same event, repeated, and through Sacrifice.apply
//   Gate run           Missions.launch / tick to the end with a death, which goes through both
// Part B boots game.html through test/game.boot.js and plays real contracts through Sortie:
//   settle             the same debrief for a contract, the loot multiplier on drops, deaths
//   abandon            a call-off before the first fight debriefs nothing, after it debriefs a loss
//   persist / resume   the fight count and each fighter's cast count survive a reload

'use strict';
const path = require('path');
const root = path.join(__dirname, '..');
const { boot, mulberry } = require('./game.boot.js');

global.window = global;
for (const m of ['rng', 'mercy', 'roster', 'stats', 'proficiency', 'economy', 'affinity', 'classes', 'condition', 'temper', 'bonds', 'crew',
  'ai', 'gifts', 'elements', 'spellcraft', 'psionic', 'martial', 'prowess', 'consume', 'combat', 'bestiary', 'missions', 'sacrifice']) require(path.join(root, m + '.js'));

let failed = 0, checks = 0;
const check = (cond, msg) => { checks++; if (!cond) { failed++; console.log('FAIL ' + msg); } };
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
const setBond = (state, a, b, v, runs = 0) => { state.bonds[Bonds.key(a.id, b.id)] = { v, spark: 0, runs, shifts: 0, met: 0 }; };
const hasPair = (state, id) => Object.keys(state.bonds).some(k => k.split(':').map(Number).includes(id));
const morale = (c) => Condition.ensure(c).morale;
/** Morale after Condition.outcome, written out: +8 won / -12 lost, -6 per death, plus the temper's share. */
const afterOutcome = (c, m0, won, lost) => clamp(m0 + (won ? 8 : -12) - lost * 6 + Temper.aftermath(c, { won, lost }), 0, 100);

scenario('debrief arithmetic', () => {
  const [a, b, r] = [makeChar(1, { cls: 'fighter' }), makeChar(2, { cls: 'cleric' }), makeChar(3, { cls: 'rogue' })];
  const state = makeTown([a, b, r]);
  check(Condition.ensure(b).pool === 'spirit', 'setup: the cleric draws on a spirit pool');
  const before = [a, b, r].map(c => ({ xp: c.class.xp, stam: Condition.ensure(c).stamina, pool: Condition.ensure(c)[Condition.ensure(c).pool], m: morale(c) }));
  const maxPool = Stats.effective(b).derived.spirit;

  const out = Missions.debrief(state, { survivors: [{ c: a, hp: 1, casts: 0 }, { c: b, hp: 0.5, casts: 5 }, { c: r, hp: 1, casts: 0 }], fallen: 0, won: true, level: 6, fights: 2 });
  [a, b, r].forEach((c, i) => {
    check(near(c.class.xp - before[i].xp, 1.5 + 0.15 * 2), `won, 2 fights: class XP is 1.5 + 0.15 x 2 (${c.class.xp - before[i].xp})`);
    check(near(Condition.ensure(c).stamina, Math.max(0, before[i].stam - 34)), `stamina falls by 25 + 1.5 x 6 = 34 (${before[i].stam} to ${Condition.ensure(c).stamina})`);
    check(near(morale(c), afterOutcome(c, before[i].m, true, 0)), `won, nobody lost: morale ${morale(c)}`);
  });
  check(near(Condition.ensure(b).spirit, Math.max(0, before[1].pool - 5 * Math.max(4, maxPool * 0.06))), `5 casts cost 5 x max(4, 6% of the pool) (${before[1].pool} to ${Condition.ensure(b).spirit})`);
  check(Bonds.peek(state, a.id, b.id).runs === 1 && Bonds.peek(state, b.id, r.id).runs === 1 && Bonds.peek(state, a.id, r.id).runs === 1, 'every pair of survivors walked out together once');
  check(near(out.lootMult, Classes.CLASSES.rogue.loot) && out.lootBy === Classes.CLASSES.rogue.name, `loot multiplier ${out.lootMult} from ${out.lootBy}`);
  check(Array.isArray(out.lines), 'debrief returns its log lines');

  // lost, with more fights than a Gate run has: class XP for fights stops at Missions.FOUGHT_CAP
  const x1 = a.class.xp, m1 = morale(a);
  Missions.debrief(state, { survivors: [{ c: a, hp: 0.3, casts: 0 }], fallen: 1, won: false, level: 1, fights: 9 });
  check(Missions.FOUGHT_CAP === 3, `the cap is the longest Gate run (${Missions.FOUGHT_CAP})`);
  check(near(a.class.xp - x1, 0.75 + 0.15 * 3), `lost, 9 fights: class XP is 0.75 + 0.15 x 3 (${a.class.xp - x1})`);
  check(near(morale(a), afterOutcome(a, m1, false, 1)), `lost with one dead: morale ${morale(a)}`);
  check(Missions.debrief(state, { survivors: [{ c: a, hp: 1, casts: 0 }], fallen: 0, won: true, level: 1, fights: 0 }).lootMult === 1, 'a party with no looter has multiplier 1');
});

scenario('readyIn matches resting ticks', () => {
  const cases = [{ restMult: 1, fed: false, housed: true }, { restMult: 1.4, fed: true, housed: true }, { restMult: 0.8, fed: false, housed: false }];
  for (const cls of ['cleric', 'fighter']) for (const opt of cases) {
    const c = makeChar(7, { cls, stars: 4 });
    const cond = Condition.ensure(c), d = Stats.effective(c).derived;
    cond.stamina = d.stamina * 0.3;
    if (cond.pool) cond[cond.pool] = d[cond.pool] * 0.1;
    c.injured = 0;
    const r = Condition.readyIn(c, opt.restMult, opt.fed, opt.housed);
    let n = 0;
    const rested = () => Condition.isRested(c) && Condition.poolFrac(c) >= Condition.RESTED;
    while (!rested() && n < 1000) { Condition.tick(c, { job: null, housed: opt.housed, restMult: opt.restMult, fed: opt.fed }); n++; }
    check(r.ticks === n, `${cls} ${JSON.stringify(opt)}: readyIn says ${r.ticks} ticks, resting takes ${n} (${r.limit})`);
    check(r.limit === (cond.pool ? cond.pool : 'stamina') || r.limit === 'stamina', `limit is a pool or stamina (${r.limit})`);
  }
  const c = makeChar(8, { cls: 'fighter' });
  c.injured = 40;
  check(Condition.readyIn(c).ticks >= 40 && Condition.readyIn(c).limit === 'injury', 'an injury longer than the stamina debt is the limit');
  c.injured = 0;
  const full = Condition.readyIn(c);
  check(full.ticks === 0 && full.limit === null, `a rested character owes nothing (${JSON.stringify(full)})`);
});

scenario('debrief bonds', () => {
  // a pair with a fixed spark, so the expected change is the event weight times the pair's rate
  const mk = () => { const [a, b] = [makeChar(1), makeChar(2)]; const s = makeTown([a, b]); setBond(s, a, b, 0); return { a, b, s }; };
  const run = (opts) => { const t = mk(); Missions.debrief(t.s, { survivors: [{ c: t.a, hp: 1, casts: 0 }, { c: t.b, hp: 1, casts: 0 }], level: 1, fights: 1, ...opts }); return t; };
  const E = Bonds.EVENTS;
  let t = run({ won: true, fallen: 0 });
  let rate = Bonds.rate(t.s, t.a, t.b);
  check(near(Bonds.peek(t.s, t.a.id, t.b.id).v, (E.mission.w + E.won.w) * rate), `won, nobody lost: mission and won events at the pair's rate (${Bonds.peek(t.s, t.a.id, t.b.id).v})`);
  t = run({ won: false, fallen: 0 });
  rate = Bonds.rate(t.s, t.a, t.b);
  check(near(Bonds.peek(t.s, t.a.id, t.b.id).v, E.mission.w * rate + E.survived.w * 0.5), `lost, nobody died: survived at half weight (${Bonds.peek(t.s, t.a.id, t.b.id).v})`);
  t = run({ won: false, fallen: 1 });
  rate = Bonds.rate(t.s, t.a, t.b);
  check(near(Bonds.peek(t.s, t.a.id, t.b.id).v, E.mission.w * rate + E.survived.w), `lost with a death: survived at full weight (${Bonds.peek(t.s, t.a.id, t.b.id).v})`);
  // one survivor has nobody to bond with
  const solo = makeChar(5), s = makeTown([solo]);
  Missions.debrief(s, { survivors: [{ c: solo, hp: 1, casts: 0 }], fallen: 0, won: true, level: 1, fights: 1 });
  check(Object.keys(s.bonds).length === 0, 'a single survivor forms no pair');
});

scenario('death path: one death', () => {
  const [A, B, C, D] = [1, 2, 3, 4].map(i => makeChar(i));
  const state = makeTown([A, B, C, D]);
  setBond(state, A, B, 40, 3); setBond(state, A, C, 20); setBond(state, B, D, 10);
  const team = Crew.create(state, 'Test Team', [A, B, C, D].map(c => c.id));
  team.runs = 10;
  const lines = [];
  const rec = Roster.fall(state, A, { cause: 'Test Cave', log: (t) => lines.push(t) });

  check(!state.characters.includes(A) && state.characters.length === 3, 'step 2: off the roster');
  check(Roster.fallen(state)[0] === rec && rec.cause === 'Test Cave' && rec.id === A.id, 'step 2: on the memorial with the cause');
  check(Roster.taken(state, A), 'step 2: identity locked');
  check(rec.bonds && rec.bonds.length === 2 && rec.bonds[0].id === B.id && rec.bonds[0].v === 40 && rec.bonds[0].word === 'friends' && rec.bonds[0].runs === 3
    && rec.bonds[1].id === C.id && rec.bonds[1].v === 20 && rec.bonds[1].word === 'familiar', `step 1: the record carries the bonds as they were before mourn (${JSON.stringify(rec.bonds)})`);
  check(near(morale(B), 70 - 40 * 0.55) && near(morale(C), 70 - 20 * 0.55) && morale(D) === 70, `step 3: morale falls by 0.55 x bond (${morale(B)}, ${morale(C)}, ${morale(D)})`);
  check(!hasPair(state, A.id) && Bonds.peek(state, B.id, D.id), 'step 3: the dead character\'s pairs are gone and others stay');
  check(team.members.length === 3 && !team.members.includes(A.id) && near(team.runs, 7.5), `step 4: the team lost a member and 1/4 of its runs (${team.members.length}, ${team.runs})`);
  check(lines.length === 3, `three lines were written (${lines.length})`);
  check(lines.some(l => l.includes(B.name) && l.includes(A.name) && l.includes('friends') && l.includes('morale -22')), `a line names the friend, the dead, the tier and the morale lost (${lines[0]})`);
  check(lines.some(l => /is down to 3/.test(l)), 'a line reports the team');

  // falling again changes nothing
  const rec2 = Roster.fall(state, A, { cause: 'Elsewhere', log: (t) => lines.push(t) });
  check(rec2 === rec && Roster.fallen(state).length === 1 && lines.length === 3 && near(morale(B), 70 - 22), 'a second fall returns the record and grieves nothing');
});

scenario('death path: deaths in one event', () => {
  const [A, B, C, D] = [1, 2, 3, 4].map(i => makeChar(i));
  const state = makeTown([A, B, C, D]);
  setBond(state, A, B, 50); setBond(state, A, C, 30); setBond(state, B, C, 30);
  const lines = [];
  const recs = Roster.fallAll(state, [A, B], { cause: 'Pit', log: (t) => lines.push(t) });
  check(recs.length === 2 && recs[0].id === A.id && recs[1].id === B.id && state.characters.length === 2, 'both fall, records in the order given');
  check(recs[0].bonds.some(x => x.id === B.id && x.v === 50) && recs[1].bonds.some(x => x.id === A.id && x.v === 50), 'each is in the other\'s snapshot');
  check(near(morale(C), 70 - 2 * 30 * 0.55) && morale(D) === 70, `the survivor grieves both (${morale(C)})`);
  check(lines.length === 2 && lines.every(l => l.includes(C.name)), `no line has one of the dead grieving the other (${lines.join(' | ')})`);
  check(!hasPair(state, A.id) && !hasPair(state, B.id), 'every pair of either is gone');
});

scenario('death path: sacrifice', () => {
  const [sac, target, friend] = [1, 2, 3].map(i => makeChar(i));
  const state = makeTown([sac, target, friend]);
  setBond(state, sac, friend, 30);
  const lines = [];
  Roster.setLog((t) => lines.push(t));
  let res;
  try { res = Sacrifice.apply(state, sac, target, 1); } finally { Roster.setLog(null); }
  check(res && res.ok, 'the sacrifice is accepted');
  check(!state.characters.includes(sac) && Roster.fallen(state)[0].cause === `sacrificed to ${target.name}`, 'the sacrificed character is on the memorial');
  check(near(morale(friend), 70 - 30 * 0.55), `the friend loses morale as after a battlefield death (${morale(friend)})`);
  check(lines.length === 1 && lines[0].includes(friend.name) && lines[0].includes(sac.name), `through the default logger: ${lines[0]}`);
  check(!hasPair(state, sac.id), 'the pair is gone');
});

scenario('Gate run', () => {
  // five-star fighters at level 1: the run is almost always won. One member is dead before it starts,
  // which finish() retires with the others' debrief applied.
  const chars = [1, 2, 3].map(i => makeChar(i, { stars: 5, cls: 'fighter' }));
  const [dead, friend] = chars;
  const state = makeTown(chars);
  setBond(state, dead, friend, 40);
  const team = Crew.create(state, 'Gate Team', chars.map(c => c.id));
  team.runs = 8;
  Rng.withSource(mulberry(7), () => {
    const run = Missions.launch(state, 'forest_edge', chars.map(c => c.id));
    check(typeof run === 'object', `launch (${run})`);
    const x0 = chars.map(c => c.class.xp), st0 = chars.map(c => Condition.ensure(c).stamina), m0 = morale(friend);
    run.members[dead.id].alive = false; run.members[dead.id].hp = 0;
    let finished = null;
    for (let i = 0; i < 100 && !finished; i++) finished = Missions.tick(state).find(r => r === run) || null;
    check(finished, 'the run finishes');
    const won = run.result === 'completed';
    const survivors = chars.filter(c => run.members[c.id].alive);
    const lost = chars.length - survivors.length;
    check(lost >= 1 && !state.characters.includes(dead) && Roster.fallen(state).some(f => f.id === dead.id && f.cause === 'Forest Edge'), 'the dead member is retired with the mission as the cause');
    check(run.lost.includes(dead.name), 'the run lists who was lost');
    check(Roster.fallen(state).find(f => f.id === dead.id).bonds.some(b => b.id === friend.id), 'the friend is in the record');
    for (const c of survivors) {
      const i = chars.indexOf(c);
      check(near(c.class.xp - x0[i], (won ? 1.5 : 0.75) + 0.15 * Math.min(run.encounter, 3)), `${c.name}: class XP for the Gate (${c.class.xp - x0[i]}, ${run.encounter} encounters)`);
      check(near(Condition.ensure(c).stamina, Math.max(0, st0[i] - 26.5)), `${c.name}: stamina falls by 25 + 1.5 x 1`);
      check(c.mission === null, `${c.name} is free`);
    }
    if (survivors.includes(friend)) {
      const hit = 40 * 0.55;
      check(near(morale(friend), afterOutcome(friend, m0 - hit, won, lost)), `the friend grieves the dead member and then takes the outcome (${morale(friend)})`);
    }
    if (survivors.length > 1) check(Bonds.peek(state, survivors[0].id, survivors[1].id).runs === 1, 'survivors formed a pair on the Gate run');
    check(team.members.length === 2 && !team.members.includes(dead.id), 'the team lost the dead member');
    check(state.missions.history[0].lost.includes(dead.name), 'the history entry lists the dead');
  });
});

// ---------- Part B: the booted page ----------

async function partB() {
  const { setup } = require('./sortie.harness.js');
  const lab = await setup({ poolSize: 12 });
  if (lab.bootFailed || lab.failed) { failed++; console.log('FAIL part B: ' + (lab.failed || 'the page did not boot')); if (lab.b) lab.b.dispose(); return; }
  const { b, ctx, st, S } = lab;
  const C = ctx.Classes, Cond = ctx.Condition, Bo = ctx.Bonds;

  const contract = (type, level) => {
    const MT = ctx.MissionTypes, roll = MT.roll;
    MT.roll = (t, o) => roll.call(MT, type, Object.assign({}, o, { level }));
    try { return S.board(st, true)[0]; } finally { MT.roll = roll; }
  };
  /** n free characters from the pool; classes given are assigned to the first ones. */
  const squad = (n, classes = []) => {
    const out = st.characters.filter(c => !c.mission && !(c.injured > 0)).slice(0, n);
    classes.forEach((id, i) => { if (!(out[i].class && out[i].class.id === id)) C.assign(out[i], id, { force: true }); });
    return out;
  };
  const snap = (chars) => chars.map(c => ({ c, xp: c.class ? c.class.xp : 0, stam: Cond.ensure(c).stamina, pool: Cond.ensure(c).pool, poolCur: Cond.ensure(c).pool ? Cond.ensure(c)[Cond.ensure(c).pool] : 0, m: Cond.ensure(c).morale }));
  const play = (seed, fn) => b.withSeed(seed, fn);
  const fresh = () => { lab.restore(); };

  await ascenario('contract settle', async () => {
    fresh();
    const mission = contract('extermination', 3);
    const chars = squad(Math.min(4, mission.party[1]), ['cleric', 'fighter']);
    const ids = chars.map(c => c.id);
    const before = snap(chars);
    let calls = 0;
    const encounter = ctx.Combat.encounter;
    ctx.Combat.encounter = function () { calls++; return encounter.apply(this, arguments); };
    try { play(11, () => { const r = S.launch(mission, ids); check(typeof r === 'object', `launch (${r})`); S.skip(); }); } finally { ctx.Combat.encounter = encounter; }
    const run = S.run, won = run.field.result.won;
    const back = st.characters.filter(c => ids.includes(c.id));
    check(run.fights > 0 && run.fights === calls, `resolve() counted the fights (${run.fights}, Combat.encounter was called ${calls} times)`);
    for (const c of back) {
      const was = before.find(x => x.c.id === c.id);
      const a = run.field.actors.find(x => x.char && x.char.id === c.id);
      const casts = a.fighter.stats.casts;
      check(near(c.class.xp - was.xp, (won ? 1.5 : 0.75) + 0.15 * Math.min(run.fights, 3)), `${c.name}: class XP ${c.class.xp - was.xp} for ${won ? 'a win' : 'a loss'} and ${run.fights} fights`);
      check(near(Cond.ensure(c).stamina, Math.max(0, was.stam - (25 + 1.5 * mission.level))), `${c.name}: stamina falls by the Gate formula for level ${mission.level}`);
      if (was.pool) {
        const max = ctx.Stats.effective(c).derived[was.pool];
        check(near(Cond.ensure(c)[was.pool], Math.max(0, was.poolCur - casts * Math.max(4, max * 0.06))), `${c.name}: ${casts} casts cost the ${was.pool} pool`);
      }
    }
    check(back.length >= 1, 'setup: somebody came back');
    if (back.length > 1) check(Bo.peek(st, back[0].id, back[1].id).runs === 1, 'survivors formed a pair');
    check(back.every(c => c.mission === null), 'everyone who came back is free');
  });

  await ascenario('loot multiplier', async () => {
    fresh();
    const mission = contract('extermination', 3);
    const chars = squad(Math.min(4, mission.party[1]), ['rogue', 'fighter']);
    const ids = chars.map(c => c.id);
    play(12, () => { S.launch(mission, ids); S.skip(); });
    const run = S.run;
    const home = st.characters.filter(c => ids.includes(c.id));
    const mult = C.partyLoot(home);
    const gemsRaw = run.loot.filter(d => d.kind === 'gems').reduce((n, d) => n + d.amount, 0);
    check(run.lootMult === mult, `the run records the multiplier (${run.lootMult}, expected ${mult})`);
    check(run.salvage === Math.round(gemsRaw * mult), `kill gems ${gemsRaw} x ${mult} = ${run.salvage}`);
    const line = st.log.map(l => l.text).find(l => l.includes('loot') || l.includes('salvaged'));
    if (mult > 1) check(line && line.includes(`drops x${mult}`) && line.includes(run.lootBy), `the settle line names the multiplier and the class (${line})`);
    else check(line && !line.includes('drops x'), 'a squad with no looter prints no multiplier');
    check(!home.some(c => c.class.id === 'rogue') || mult >= C.CLASSES.rogue.loot, 'a surviving rogue sets at least its multiplier');
  });

  await ascenario('deaths at settle', async () => {
    fresh();
    const mission = contract('extermination', 3);
    const chars = squad(Math.min(4, mission.party[1]), ['fighter', 'fighter', 'fighter']);
    const [victim, friend] = chars;
    const ids = chars.map(c => c.id);
    Bo.ensure(st)[Bo.key(victim.id, friend.id)] = { v: 40, spark: 0, runs: 2, shifts: 0, met: 0 };
    const m0 = Cond.ensure(friend).morale;
    play(13, () => {
      const run = S.launch(mission, ids);
      const a = run.field.actors.find(x => x.char && x.char.id === victim.id);
      a.alive = false; a.hp = 0;
      S.skip();
    });
    const run = S.run, won = run.field.result.won;
    check(!st.characters.some(c => c.id === victim.id), 'the dead member is off the roster');
    const rec = st.roster.fallen.find(f => f.id === victim.id);
    check(rec && rec.cause === mission.name && rec.bonds && rec.bonds.some(x => x.id === friend.id && x.v === 40), `memorial record with the cause and the friend (${rec && JSON.stringify(rec.bonds)})`);
    const lost = run.lost.length;
    if (st.characters.some(c => c.id === friend.id)) {
      const hit = 40 * 0.55;
      check(near(Cond.ensure(friend).morale, afterOutcome2(friend, m0 - hit, won, lost)), `the friend grieves, then takes the outcome (${Cond.ensure(friend).morale})`);
      check(st.log.some(l => l.text.includes('lost') && l.text.includes(victim.name) && l.text.includes('morale -22')), 'the grief line is in the town log');
    }
    check(Bo.peek(st, victim.id, friend.id) === null, 'the pair with the dead member is gone');
  });
  // the same expression as afterOutcome above, for the page's own Temper
  function afterOutcome2(c, m0, won, lost) { return clamp(m0 + (won ? 8 : -12) - lost * 6 + ctx.Temper.aftermath(c, { won, lost }), 0, 100); }

  await ascenario('team credit and a death', async () => {
    fresh();
    const mission = contract('extermination', 3);
    const chars = squad(4, ['fighter', 'fighter', 'fighter', 'fighter']);
    if (mission.party[1] < 4 || mission.party[0] > 4) { check(false, `setup: a four-person contract (${mission.party})`); return; }
    const team = ctx.Crew.create(st, 'Test Team', chars.map(c => c.id));
    team.runs = 10;
    play(16, () => {
      const run = S.launch(mission, chars.map(c => c.id));
      run.teamId = team.id;                 // what launching as a selected team sets
      const a = run.field.actors.find(x => x.char && x.char.id === chars[0].id);
      a.alive = false; a.hp = 0;
      S.skip();
    });
    const won = S.run.field.result.won;
    const kept = team.members.length;
    check(kept === chars.filter(c => st.characters.some(x => x.id === c.id)).length && kept <= 3, `the team lost its dead (${kept} left)`);
    check(near(team.runs, (10 + (won ? 1 : 0.5)) * kept / 4), `the run is credited before the deaths scale the team: (10 + ${won ? 1 : 0.5}) x ${kept}/4 = ${(10 + (won ? 1 : 0.5)) * kept / 4}, got ${team.runs}`);
  });

  await ascenario('Gate run in the page', async () => {
    // two members are dead before the run starts; the two of them were close, and each was a friend of the third
    fresh();
    const chars = squad(3, ['fighter', 'fighter', 'fighter']);
    const [victim, victim2, friend] = chars;
    const pair = (a, b, v) => { Bo.ensure(st)[Bo.key(a.id, b.id)] = { v, spark: 0, runs: 0, shifts: 0, met: 0 }; };
    pair(victim, victim2, 50); pair(victim, friend, 40); pair(victim2, friend, 20);
    const m0 = Cond.ensure(friend).morale, x0 = friend.class.xp;
    play(17, () => {
      const run = ctx.Missions.launch(st, 'forest_edge', chars.map(c => c.id));
      check(typeof run === 'object', `Gate launch (${run})`);
      for (const c of [victim, victim2]) { run.members[c.id].alive = false; run.members[c.id].hp = 0; }
      for (let i = 0; i < 40 && st.missions.active.length; i++) b.advance(10000);
    });
    check(st.missions.active.length === 0 && st.missions.history.length === 1, 'the Gate run finished and was settled');
    const won = st.missions.history[0].result === 'completed';
    check([victim, victim2].every(c => !st.characters.some(x => x.id === c.id) && st.roster.fallen.some(f => f.id === c.id)), 'both dead members are retired');
    const texts = st.log.map(l => l.text);
    check(texts.filter(t => t.includes('lost') && t.includes('morale -')).every(t => t.includes(friend.name)), `only the friend grieves; the two who died together do not grieve each other (${texts.filter(t => t.includes('morale -')).join(' | ')})`);
    check(texts.some(t => t.includes(friend.name) && t.includes(victim.name) && t.includes('morale -22')) && texts.some(t => t.includes(friend.name) && t.includes(victim2.name) && t.includes('morale -11')), 'the friend grieves each of them by 0.55 x the bond');
    check(texts.some(t => t.includes('did not come back') && t.includes(victim.name) && t.includes(victim2.name)), 'the Gate settle line is still written');
    if (st.characters.includes(friend)) {
      check(near(Cond.ensure(friend).morale, afterOutcome2(friend, m0 - 33, won, 2)), `the friend grieves both, then takes the outcome with two lost (${Cond.ensure(friend).morale})`);
      check(friend.class.xp > x0, 'the survivor earned class XP on a Gate run');
    }
    check(!hasPair(st, victim.id) && !hasPair(st, victim2.id), 'no pair names either dead member');
  });

  await ascenario('sacrifice in the page', async () => {
    fresh();
    const [sac, target, friend] = squad(3);
    Bo.ensure(st)[Bo.key(sac.id, friend.id)] = { v: 30, spark: 0, runs: 0, shifts: 0, met: 0 };
    const m0 = Cond.ensure(friend).morale;
    const res = ctx.Sacrifice.apply(st, sac, target, 1);
    check(res.ok, 'the sacrifice is accepted');
    check(near(Cond.ensure(friend).morale, m0 - 30 * 0.55), `the friend loses morale (${m0} to ${Cond.ensure(friend).morale})`);
    check(st.log.some(l => l.text.includes(friend.name) && l.text.includes(sac.name) && /morale -1[67]/.test(l.text)), 'game.js gave Roster its town logger: the grief line is in the log');
    check(!hasPair(st, sac.id), 'the pair is gone');
  });

  await ascenario('party card facts', async () => {
    fresh();
    const [tired] = squad(1, ['cleric']);
    const cond = Cond.ensure(tired), d = ctx.Stats.effective(tired).derived;
    cond.stamina = d.stamina * 0.3;
    cond[cond.pool] = d[cond.pool] * 0.2;
    const fed = Object.values(st.inventory || {}).some(i => i.kind === 'meal' && i.count > 0);
    const ready = Cond.readyIn(tired, ctx.Lodging.restFor(st, tired), fed, ctx.Lodging.housed(st, tired));
    S.discard();                           // an earlier scenario's finished run would be drawn instead of the board
    play(31, () => { S.render(); });
    const html = [];
    const walk = (el) => { if (el && el._html) html.push(el._html); if (el && el._kids) el._kids.forEach(walk); };
    walk(b.el('#sortie'));
    const card = html.find(h => h.includes(tired.name) && h.includes('ready in'));
    check(!!card, 'the party card for a tired caster says when it is ready');
    if (card) {
      check(card.includes(`stamina ${Cond.describe(tired).stamina.band.label}`) && card.includes(`${cond.pool} 20%`), 'it names the stamina band and the pool percentage');
      check(card.includes(`ready in ${ready.ticks} ${ready.ticks === 1 ? 'tick' : 'ticks'}: ${ready.limit}`), `and the resting ticks with the limit, in plain words (${ready.ticks}, ${ready.limit})`);
      check(!/ticks? \((stamina|mana|spirit|injury)\)/.test(card), 'with the limit after a colon and not in a parenthesis');
    }
  });

  await ascenario('call-off before the first fight', async () => {
    fresh();
    const mission = contract('extermination', 3);
    const chars = squad(Math.min(4, mission.party[1]));
    const before = snap(chars);
    const pairs0 = Object.keys(st.bonds).length;
    play(14, () => { const r = S.launch(mission, chars.map(c => c.id)); check(typeof r === 'object', `launch (${r})`); S.abandon(); });
    check(S.run === null, 'the run is gone');
    for (const was of before) {
      const c = was.c;
      check(c.class.xp === was.xp && near(Cond.ensure(c).stamina, was.stam) && near(Cond.ensure(c).morale, was.m), `${c.name}: nothing was spent or earned`);
      check(c.mission === null, `${c.name} is free`);
    }
    check(Object.keys(st.bonds).length === pairs0, 'no pair was formed');
  });

  await ascenario('call-off after the first fight', async () => {
    fresh();
    const mission = contract('extermination', 3);
    const chars = squad(Math.min(4, mission.party[1]), ['cleric', 'fighter']);
    const before = snap(chars);
    const gems0 = st.gems;
    let run = null, fights = 0;
    play(15, () => {
      run = S.launch(mission, chars.map(c => c.id));
      for (let i = 0; i < 6000 && !run.contact && !run.field.result; i++) ctx.Field.step(run.field);
      fights = run.fights;
      S.abandon();
    });
    check(run.contact === true && fights > 0, `setup: the squad reached a fight (${fights})`);
    check(S.run === null, 'the run is gone');
    const back = st.characters.filter(c => chars.some(x => x.id === c.id));
    for (const c of back) {
      const was = before.find(x => x.c.id === c.id);
      check(near(c.class.xp - was.xp, 0.75 + 0.15 * Math.min(fights, 3)), `${c.name}: class XP as a lost mission (${c.class.xp - was.xp}, ${fights} fights)`);
      check(near(Cond.ensure(c).stamina, Math.max(0, was.stam - (25 + 1.5 * mission.level))), `${c.name}: stamina spent`);
      check(c.mission === null, `${c.name} is free`);
    }
    check(st.gems === gems0, 'a call-off pays nothing');
  });

  await ascenario('persist and resume', async () => {
    let done = false;
    for (let seed = 21; seed < 29 && !done; seed++) {
      fresh();
      const mission = contract('extermination', 3);
      const chars = squad(Math.min(4, mission.party[1]), ['elemental_mage', 'cleric', 'psion']);
      let run = null;
      play(seed, () => {
        run = S.launch(mission, chars.map(c => c.id));
        for (let i = 0; i < 6000 && !run.contact && !run.field.result; i++) ctx.Field.step(run.field);
      });
      if (!run.contact || run.field.result) continue;
      const casts = Object.fromEntries(run.field.actors.filter(a => a.role === 'squad').map(a => [a.char.id, a.fighter.stats.casts]));
      if (!Object.values(casts).some(n => n > 0)) continue;
      done = true;
      b.fire('window', 'beforeunload');
      const saved = st.field.run;
      check(saved && saved.fights === run.fights && run.fights > 0, `persist() stores the fight count (${saved && saved.fights})`);
      const b2 = await boot({ html: 'game.html', storage: new Map(b.localStorage.map) });
      try {
        const run2 = b2.Sortie && b2.Sortie.run;
        check(!!run2 && run2.fights === run.fights, `the resumed run has the fight count (${run2 && run2.fights})`);
        if (run2) {
          for (const a of run2.field.actors.filter(x => x.role === 'squad')) {
            check(a.fighter.stats.casts === casts[a.char.id], `${a.char.name}: ${a.fighter.stats.casts} casts after the reload, ${casts[a.char.id]} before`);
          }
        }
      } finally { b2.dispose(); }
    }
    check(done, 'setup: a run with casts and a first fight was found to save');
  });

  lab.b.dispose();
}

(async () => {
  const a = checks;
  await partB();
  console.log(`part A ${a} checks, part B ${checks - a} checks`);
  console.log(`${checks} checks, ${failed ? failed + ' failed' : 'all passed'}`);
  process.exit(failed ? 1 : 0);
})();
