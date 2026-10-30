// Service record and altar grief. `node test/record.js`; exit code 1 on any failure.
//
// Part A loads the modules in Node, as test/debrief.js does, and checks:
//   Bonds.grief          the rows the altar lists are the rows Bonds.mourn applies, and it changes nothing
//   Roster.noteSortie    the counters, closeCall as a running minimum, last
//   Roster.noteKills     credit goes to the party member who landed the blow, nobody else
//   Roster.describeRecord  labels at their thresholds, the counts text, the brief and confirm lines
//   Missions.debrief     the service step writes the record once per survivor
//   Roster.fallAll       the memorial entry holds a copy of c.record and the bonds as they were before mourn
//   Sacrifice.apply      the friend loses min(35, 0.55 x bond) morale, the log says so, and the altar's
//                        preview (Bonds.grief) names the same number
//   Gate run             kills credited in Missions.fight sum to the kills the combats reported
// Part B boots game.html through test/game.boot.js:
//   summon / load        a new character has a record that starts now; a save without one gets one at load
//   contract             Sortie credits kills at resolve() and out / won / last at settle()
//   death at settle      the memorial entry keeps the record the character had, kills included
//   screens              the contract party picker, the Gate party picker, the character sheet and the memorial
//                        wall print the record; the altar rows print it too and list the friends who would
//                        grieve, and spending a bonded character takes what the row said

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
const morale = (c) => Condition.ensure(c).morale;
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const rec = (o = {}) => ({ ...Roster.blankRecord(T0), ...o });

scenario('Bonds.grief', () => {
  const [A, B, C, D, E, F] = [1, 2, 3, 4, 5, 6].map(i => makeChar(i));
  const state = makeTown([A, B, C, D, E, F]);
  setBond(state, A, B, 40); setBond(state, A, C, 12); setBond(state, A, D, 13); setBond(state, A, E, 90); setBond(state, A, F, -50);
  setBond(state, B, C, 70);
  const before = JSON.stringify(state.bonds);
  const rows = Bonds.grief(state, A, state.characters);
  check(JSON.stringify(state.bonds) === before, 'grief changes no bond');
  check(rows.map(r => r.c.id).join() === '5,2,4', `rows are the bonds above 12, strongest first (${rows.map(r => r.c.id)}); 12 and -50 are left out`);
  check(rows.every(r => near(r.hit, Math.min(35, r.v * 0.55))), 'each hit is min(35, 0.55 x bond)');
  check(rows[0].hit === 35 && rows[0].v === 90 && Bonds.GRIEF_CAP === 35 && Bonds.GRIEF === 0.55, 'a bond of 90 is capped at 35');
  check(rows[1].tier.word === 'friends' && rows[2].tier.word === 'familiar', `tier words are the ones relations() shows (${rows.map(r => r.tier.word)})`);
  check(Bonds.grief(state, A, [A]).length === 0 && Bonds.grief({}, A, state.characters).length === 0, 'the character itself and a state with no bonds give no rows');

  // mourn applies exactly these rows and then removes every pair that names A
  const applied = [];
  const felt = Bonds.mourn(state, A.id, state.characters.filter(c => c !== A), { morale: (o, d) => applied.push([o.id, d]) });
  check(felt.length === rows.length && felt.every((f, i) => f.c === rows[i].c && f.hit === rows[i].hit && f.v === rows[i].v), 'mourn returns the rows grief listed');
  check(applied.length === 3 && applied.every(([id, d]) => near(d, -rows.find(r => r.c.id === id).hit)), 'mourn lowers each friend by the listed hit');
  check(!Object.keys(state.bonds).some(k => k.split(':').includes('1')) && Bonds.peek(state, B.id, C.id), 'every pair naming A is gone and the others stay');
});

scenario('noteSortie and noteKills', () => {
  const c = makeChar(1);
  check(c.record === undefined, 'setup: a character built outside game.js has no record');
  const r = Roster.noteSortie(c, { won: true, fallen: 0, low: 1, where: 'Forest Edge', at: T0 });
  check(c.record === r && r.since === T0 && r.out === 1 && r.won === 1 && r.witnessed === 0, 'the first run makes the record, starting at that time');
  check(r.closeCall === null, 'a run that never left them below full HP is no close call');
  check(r.last.mission === 'Forest Edge' && r.last.won === true && r.last.at === T0, 'last names the mission, the result and the time');

  Roster.noteSortie(c, { won: false, fallen: 2, low: 0.2349, where: 'Goblin Camp', at: T0 + 1000 });
  check(r.out === 2 && r.won === 1 && r.witnessed === 2, 'a lost run adds to out and to witnessed, not to won');
  check(r.closeCall && r.closeCall.low === 0.235 && r.closeCall.mission === 'Goblin Camp' && r.closeCall.at === T0 + 1000, `closeCall holds the lowest HP fraction to 3 places (${JSON.stringify(r.closeCall)})`);
  Roster.noteSortie(c, { won: true, fallen: 0, low: 0.6, where: 'Wolf Trail', at: T0 + 2000 });
  check(r.closeCall.low === 0.235 && r.closeCall.mission === 'Goblin Camp', 'a higher low does not replace the closest call');
  Roster.noteSortie(c, { won: true, low: 0.1, where: 'Hawk Cliffs', at: T0 + 3000 });
  check(r.closeCall.low === 0.1 && r.closeCall.mission === 'Hawk Cliffs' && r.last.mission === 'Hawk Cliffs' && r.witnessed === 2, 'a lower low replaces it, and fallen defaults to 0');
  Roster.noteSortie(c, { won: true, low: undefined, where: 'Boar Hollow', at: T0 + 4000 });
  check(r.closeCall.low === 0.1 && r.out === 5, 'no fight (low undefined) leaves the closest call alone');

  const a = makeChar(2), b = makeChar(3);
  const party = { char: a, side: 'party' }, enemy = { def: {}, side: 'enemy' };
  const n = Roster.noteKills([{ killer: party }, { killer: party }, { killer: { char: b } }, { killer: enemy }, { killer: null }, {}]);
  check(n === 3 && a.record.kills === 2 && b.record.kills === 1, `credit goes to the fighter's character only (${n}, ${a.record.kills}, ${b.record.kills})`);
  check(Roster.noteKills(undefined) === 0 && Roster.noteKills([]) === 0, 'no kills credits nobody');
});

scenario('describeRecord', () => {
  check(Roster.describeRecord(null) === null && Roster.describeRecord(undefined) === null, 'no record gives null');
  const at = (out) => Roster.describeRecord(rec({ out }), { now: T0 }).label;
  check([0, 2].every(n => at(n) === 'new') && [3, 7].every(n => at(n) === '') && [8, 19].every(n => at(n) === 'seasoned') && [20, 99].every(n => at(n) === 'veteran'),
    `label thresholds: new under 3, none 3 to 7, seasoned from 8, veteran from 20 (${[0, 2, 3, 7, 8, 19, 20].map(at).join('|')})`);

  const r = rec({ out: 14, won: 9, kills: 31, witnessed: 2, closeCall: { low: 0.12, mission: 'Goblin Camp', at: T0 - 3 * 3600000 }, last: { mission: 'Wolf Trail', won: true, at: T0 - 90 * 1000 } });
  const d = Roster.describeRecord(r, { now: T0 });
  check(d.counts === '14 sorties · 9 won · 31 kills · 2 squad deaths seen', `counts (${d.counts})`);
  check(d.brief === 'seasoned, 14 sorties, last: won' && d.confirm === '14 sorties, 31 kills', `brief and confirm (${d.brief} / ${d.confirm})`);
  check(d.closest === 'lowest HP 12% on Goblin Camp, 3 h ago' && d.last === 'won on Wolf Trail, 1 min ago', `closest and last (${d.closest} / ${d.last})`);
  check(/^record starts 2026-10-0[12]$/.test(d.since), `since is a date (${d.since})`);
  check(d.title.includes(d.counts) && d.title.includes(d.closest) && d.title.includes(d.since) && d.title.includes('veteran: 20 or more') && !d.title.includes('No game rule') && d.legend.includes('No game rule reads these counts') && d.legend.includes('squad deaths seen: squad members who died'), 'the tooltip carries the counts, the closest call, the start date and the thresholds');
  const dead = Roster.describeRecord(r, { now: T0, fallen: true });
  check(dead.counts.startsWith('survived 14 sorties') && dead.brief === d.brief, 'a dead character\'s count says "survived"');

  const fresh = Roster.describeRecord(rec(), { now: T0 });
  check(fresh.brief === 'no sorties yet' && fresh.closest === null && fresh.last === null && fresh.counts === '0 sorties · 0 won · 0 kills · 0 squad deaths seen', `a blank record (${fresh.brief})`);
  const one = Roster.describeRecord(rec({ out: 1, kills: 1, witnessed: 1, last: { mission: null, won: false, at: T0 } }), { now: T0 + 3 * 86400000 });
  check(one.counts === '1 sortie · 0 won · 1 kill · 1 squad death seen' && one.brief === 'new, 1 sortie, last: not won' && one.last === 'not won, 3 days ago', `singular forms (${one.counts} / ${one.brief} / ${one.last})`);
});

scenario('Missions.debrief writes the record', () => {
  const [a, b, c] = [1, 2, 3].map(i => makeChar(i));
  const state = makeTown([a, b, c]);
  const out1 = Missions.debrief(state, { survivors: [{ c: a, hp: 1, casts: 0, low: 0.3 }, { c: b, hp: 1, casts: 0, low: 1 }, { c: c, hp: 1, casts: 0 }], fallen: 2, won: true, level: 2, fights: 1, where: 'Wolf Trail' });
  check(out1.lines.every(l => !/record|sortie/i.test(l)), 'the service step writes no log line');
  for (const x of [a, b, c]) check(x.record && x.record.out === 1 && x.record.won === 1 && x.record.witnessed === 2 && x.record.last.mission === 'Wolf Trail' && x.record.last.won === true, `${x.name}: out, won, witnessed and last after one run`);
  check(a.record.closeCall && a.record.closeCall.low === 0.3 && a.record.closeCall.mission === 'Wolf Trail', 'low 0.3 is a close call');
  check(b.record.closeCall === null && c.record.closeCall === null, 'low 1 and no low are not');
  Missions.debrief(state, { survivors: [{ c: a, hp: 1, casts: 0, low: 0.5 }], fallen: 0, won: false, level: 2, fights: 1, where: 'Boar Hollow' });
  check(a.record.out === 2 && a.record.won === 1 && a.record.witnessed === 2 && a.record.last.won === false && a.record.closeCall.low === 0.3, 'a second, lost run: out 2, won 1, the closer call stays');
  check(b.record.out === 1, 'a character not in the second debrief is unchanged');
});

scenario('death path keeps the record', () => {
  const [A, B, C, D] = [1, 2, 3, 4].map(i => makeChar(i));
  const state = makeTown([A, B, C, D]);
  A.record = rec({ out: 6, won: 4, kills: 11, witnessed: 1, closeCall: { low: 0.08, mission: 'Pit', at: T0 }, last: { mission: 'Pit', won: false, at: T0 } });
  setBond(state, A, B, 60, 5); setBond(state, A, C, 30, 2); setBond(state, A, D, 20, 1);
  const entry = Roster.fall(state, A, { cause: 'Pit: Goblin Boss', log: () => {} });
  check(entry.record && JSON.stringify(entry.record) === JSON.stringify(A.record), 'the memorial entry holds the record as it stood at death');
  check(entry.record !== A.record && entry.record.closeCall !== A.record.closeCall && entry.record.last !== A.record.last, 'it is a copy, not the same objects');
  A.record.kills = 99; A.record.closeCall.low = 0.5;
  check(entry.record.kills === 11 && entry.record.closeCall.low === 0.08, 'changing the dead character\'s object does not change the entry');
  check(entry.bonds.length === 3 && entry.bonds[0].name === B.name && entry.bonds[0].word === 'close' && entry.bonds[0].runs === 5 && entry.bonds[1].name === C.name, `the bonds were taken before mourn deleted the pairs (${JSON.stringify(entry.bonds)})`);
  check(!Object.keys(state.bonds).some(k => k.split(':').includes('1')), 'and the pairs are gone afterwards');

  // someone with no record gets none invented on the entry; two deaths in one event each keep their own
  const [E, F] = [5, 6].map(i => makeChar(i));
  const s2 = makeTown([E, F, makeChar(7)]);
  F.record = rec({ out: 2, kills: 4 });
  const [eE, eF] = Roster.fallAll(s2, [E, F], { cause: 'Trap', log: () => {} });
  check(eE.record === undefined && eF.record.kills === 4 && eF.record.out === 2, 'no record on the character, none on the entry; the other keeps its own');
  check(Roster.fallAll(s2, [F], { cause: 'again' })[0] === eF && eF.record.kills === 4, 'falling again returns the same entry');
});

scenario('sacrifice grief matches the altar preview', () => {
  for (const v of [30, 90]) {
    const [sac, target, friend, other] = [1, 2, 3, 4].map(i => makeChar(i));
    const state = makeTown([sac, target, friend, other]);
    setBond(state, sac, friend, v, 3); setBond(state, sac, other, 12);
    const shown = Bonds.grief(state, sac, state.characters);            // what the altar row lists before the click
    const m0 = morale(friend), mo0 = morale(other);
    const lines = [];
    Roster.setLog((t) => lines.push(t));
    let res;
    try { res = Sacrifice.apply(state, sac, target, 1); } finally { Roster.setLog(null); }
    check(res && res.ok, `bond ${v}: the sacrifice is accepted`);
    const hit = Math.min(35, 0.55 * v);
    check(shown.length === 1 && shown[0].c === friend && near(shown[0].hit, hit) && shown[0].tier.word === Bonds.tierOf(v).word, `bond ${v}: the preview names ${friend.name}, ${shown[0] && shown[0].tier.word}, -${hit}`);
    check(near(morale(friend), m0 - hit) && morale(other) === mo0, `bond ${v}: the friend lost ${hit} morale (${m0} to ${morale(friend)}); a bond of 12 lost none`);
    check(lines.length === 1 && lines[0].includes(friend.name) && lines[0].includes(sac.name) && lines[0].includes(`(${shown[0].tier.word}): morale -${Math.round(hit)}`), `bond ${v}: the log says so (${lines[0]})`);
    check(Roster.fallen(state)[0].bonds[0].name === friend.name && Roster.fallen(state)[0].bonds[0].v === v, `bond ${v}: the memorial kept the bond`);
  }
});

scenario('Gate run credits kills', () => {
  // One member is dead before the first fight. Seeds are tried until a run has a survivor and a kill.
  let played = 0;
  for (let seed = 7; seed < 27 && !played; seed++) {
    const chars = [1, 2, 3].map(i => makeChar(i, { stars: 5, cls: 'fighter' }));
    for (const c of chars) c.record = Roster.blankRecord(T0);       // summon() and load() give every character one
    const state = makeTown(chars);
    const seen = new Map();
    const encounter = Combat.encounter;
    Combat.encounter = function () {
      const res = encounter.apply(this, arguments);
      for (const k of res.kills) if (k.killer && k.killer.char) seen.set(k.killer.char.id, (seen.get(k.killer.char.id) || 0) + 1);
      return res;
    };
    try {
      Rng.withSource(mulberry(seed), () => {
        const run = Missions.launch(state, 'wolf_trail', chars.map(c => c.id));
        check(typeof run === 'object', `launch (${run})`);
        run.members[chars[0].id].alive = false; run.members[chars[0].id].hp = 0;
        let finished = null;
        for (let i = 0; i < 100 && !finished; i++) finished = Missions.tick(state).find(r => r === run) || null;
        check(finished, `seed ${seed}: the run finishes`);
        const total = [...seen.values()].reduce((n, v) => n + v, 0);
        const back = chars.filter(c => run.members[c.id].alive);
        for (const c of chars) {
          const dead = Roster.fallen(state).find(f => f.id === c.id);
          const r = dead ? dead.record : c.record;
          check(r && r.kills === (seen.get(c.id) || 0), `seed ${seed}: ${c.name}: ${r && r.kills} kills on the record, ${seen.get(c.id) || 0} landed`);
        }
        const entry = Roster.fallen(state).find(f => f.id === chars[0].id);
        check(entry && entry.record.out === 0 && !state.characters.includes(chars[0]), `seed ${seed}: the dead member is not debriefed, so the run that killed them is not counted`);
        if (!back.length || !total) return;
        played++;
        const won = run.result === 'completed', lost = chars.length - back.length;
        for (const c of back) check(c.record.out === 1 && c.record.won === (won ? 1 : 0) && c.record.witnessed === lost && c.record.last.mission === 'Wolf Trail', `seed ${seed}: ${c.name}: one run, ${won ? 'won' : 'lost'}, ${lost} comrades lost`);
      });
    } finally { Combat.encounter = encounter; }
  }
  check(played === 1, 'setup: a Gate run with a survivor and a kill was played');
});

// ---------- Part B: the booted page ----------

async function partB() {
  const { setup } = require('./sortie.harness.js');
  const lab = await setup({ poolSize: 12 });
  if (lab.bootFailed || lab.failed) { failed++; console.log('FAIL part B: ' + (lab.failed || 'the page did not boot')); if (lab.b) lab.b.dispose(); return; }
  const { b, ctx, st, S } = lab;
  const Bo = ctx.Bonds, Cond = ctx.Condition;

  const contract = (type, level) => {
    const MT = ctx.MissionTypes, roll = MT.roll;
    MT.roll = (t, o) => roll.call(MT, type, Object.assign({}, o, { level }));
    try { return S.board(st, true)[0]; } finally { MT.roll = roll; }
  };
  const squad = (n) => st.characters.filter(c => !c.mission && !(c.injured > 0)).slice(0, n);
  const play = (seed, fn) => b.withSeed(seed, fn);
  const fresh = () => { lab.restore(); };
  /** every html string under an element, as the stub DOM kept them */
  const htmlOf = (sel) => { const out = []; const walk = (el) => { if (el && el._html) out.push(el._html); if (el && el._kids) el._kids.forEach(walk); }; walk(b.el(sel)); return out; };

  await ascenario('summon and load', async () => {
    fresh();
    const c = st.characters[0];
    check(c.record && c.record.out === 0 && c.record.won === 0 && c.record.kills === 0 && c.record.witnessed === 0 && c.record.closeCall === null && c.record.last === null, `a summoned character has a blank record (${JSON.stringify(c.record)})`);
    check(Math.abs(c.record.since - c.obtained) < 1000, 'and it starts when they were summoned');

    // a save from before the record existed: strip it, write the state, boot a second page on it
    const copy = JSON.parse(JSON.stringify(st));
    for (const x of copy.characters) delete x.record;
    copy.characters[0].record = { since: 12345, out: 3, won: 2, kills: 5, witnessed: 0, closeCall: null, last: null };
    const key = 'infinitegacha.save.v2';
    const storage = new Map(b.localStorage.map);
    storage.set(key, JSON.stringify(copy));
    const b2 = await boot({ html: 'game.html', storage });
    try {
      const chars = b2.Game.state.characters;
      check(chars.length === copy.characters.length, `setup: the second page loaded the roster (${chars.length})`);
      check(chars.slice(1).every(x => x.record && x.record.out === 0 && x.record.closeCall === null && x.record.last === null && x.record.since >= b2.context.Date.now() - 5000),
        'a character from before gets a blank record that starts at the load');
      check(chars[0].record.since === 12345 && chars[0].record.out === 3, 'a record that exists is left alone');
    } finally { b2.dispose(); }
  });

  await ascenario('contract records', async () => {
    // Seeds are tried until three runs have somebody who came back; the outcome of a seed depends on combat.js and field.js as they are today.
    let played = 0;
    for (let seed = 11; seed < 31 && played < 3; seed++) {
      fresh();
      const mission = contract('extermination', 3);
      const chars = squad(Math.min(4, mission.party[1]));
      const ids = chars.map(c => c.id);
      const landed = new Map();
      const encounter = ctx.Combat.encounter;
      ctx.Combat.encounter = function () {
        const res = encounter.apply(this, arguments);
        for (const k of res.kills) if (k.killer && k.killer.char) landed.set(k.killer.char.id, (landed.get(k.killer.char.id) || 0) + 1);
        return res;
      };
      try { play(seed, () => { const r = S.launch(mission, ids); check(typeof r === 'object', `launch (${r})`); S.skip(); }); } finally { ctx.Combat.encounter = encounter; }
      const run = S.run, won = run.field.result.won;
      const lostIds = run.lost.map(f => f.id);
      check(run.fights > 0, `seed ${seed}: fights were fought (${run.fights})`);
      for (const c of chars.filter(x => lostIds.includes(x.id))) {
        const f = st.roster.fallen.find(x => x.id === c.id);
        check(f && f.record && f.record.out === 0 && f.record.kills === (landed.get(c.id) || 0), `seed ${seed}: ${c.name} fell with ${landed.get(c.id) || 0} kills credited and no run counted`);
      }
      const back = chars.filter(c => !lostIds.includes(c.id));
      if (!back.length) continue;
      played++;
      for (const c of back) {
        const r = c.record, a = run.field.actors.find(x => x.char && x.char.id === c.id);
        check(r.out === 1 && r.won === (won ? 1 : 0) && r.witnessed === lostIds.length, `seed ${seed}: ${c.name}: one run, ${won ? 'won' : 'lost'}, ${lostIds.length} comrades lost (${r.out}, ${r.won}, ${r.witnessed})`);
        check(r.kills === (landed.get(c.id) || 0), `seed ${seed}: ${c.name}: ${r.kills} kills on the record, ${landed.get(c.id) || 0} landed in Combat.encounter`);
        check(r.last && r.last.mission === mission.name && r.last.won === won, `seed ${seed}: ${c.name}: last names the contract`);
        const low = a && a.low;
        if (low !== undefined && low < 1) check(r.closeCall && near(r.closeCall.low, Math.round(low * 1000) / 1000) && r.closeCall.mission === mission.name, `seed ${seed}: ${c.name}: closeCall is the lowest HP seen (${low})`);
        else check(r.closeCall === null, `seed ${seed}: ${c.name}: no close call when HP never dropped`);
      }
    }
    check(played === 3, `setup: three runs with a survivor were played (${played})`);
  });

  await ascenario('death at settle keeps the record', async () => {
    fresh();
    const mission = contract('extermination', 3);
    const chars = squad(Math.min(4, mission.party[1]));
    const [victim, friend] = chars;
    const ids = chars.map(c => c.id);
    victim.record = { since: 1000, out: 5, won: 3, kills: 7, witnessed: 1, closeCall: { low: 0.11, mission: 'Wolf Trail', at: 2000 }, last: { mission: 'Wolf Trail', won: true, at: 2000 } };
    Bo.ensure(st)[Bo.key(victim.id, friend.id)] = { v: 40, spark: 0, runs: 2, shifts: 0, met: 0 };
    play(13, () => {
      const run = S.launch(mission, ids);
      const a = run.field.actors.find(x => x.char && x.char.id === victim.id);
      a.alive = false; a.hp = 0;
      S.skip();
    });
    const entry = st.roster.fallen.find(f => f.id === victim.id);
    check(entry && entry.record && entry.record.out === 5 && entry.record.kills >= 7 && entry.record.closeCall.low === 0.11 && entry.record.since === 1000, `the memorial entry has the record (${entry && JSON.stringify(entry.record)})`);
    check(entry.bonds && entry.bonds.some(x => x.id === friend.id && x.v === 40), 'and the bonds, taken before the pair was deleted');
    check(!victim.record || entry.record !== victim.record, 'as a copy');

    // the memorial wall prints it
    S.discard();
    st.roster.fallen = [entry];
    play(32, () => { S.render(); });
    const wall = htmlOf('#sortie').find(h => h.includes(entry.name) && h.includes('survived'));
    check(!!wall, 'the memorial card shows the count');
    if (wall) {
      const d = ctx.Roster.describeRecord(entry.record, { now: b.context.Date.now(), fallen: true });
      check(wall.includes(d.counts) && wall.includes('bonds: ') && wall.includes(friend.name) && wall.includes('friends') && wall.includes('2 missions together') && wall.includes(entry.cause), `the card has the counts, the closest bonds and the cause (${wall.replace(/\s+/g, ' ').slice(0, 300)})`);
    }
  });

  await ascenario('party picker', async () => {
    fresh();
    const [vet, newbie] = squad(2);
    vet.record = { since: T0, out: 24, won: 20, kills: 90, witnessed: 3, closeCall: null, last: { mission: 'Goblin Camp', won: true, at: b.context.Date.now() - 7200000 } };
    S.discard();
    play(31, () => { S.render(); });
    const html = htmlOf('#sortie');
    const cardOf = (c) => html.find(h => h.includes(`>${c.name}</div>`) && h.includes('🧭'));
    check(cardOf(vet) && cardOf(vet).includes('veteran, 24 sorties, last: won'), `the picker card for a veteran (${cardOf(vet) && cardOf(vet).replace(/\s+/g, ' ').slice(0, 200)})`);
    check(cardOf(newbie) && cardOf(newbie).includes('no sorties yet'), 'and for a character who has not been out');
    check(cardOf(vet).includes('title="24 sorties') && cardOf(vet).includes(ctx.Roster.describeRecord(vet.record).since), 'the tooltip carries the counts and the start date');
  });

  await ascenario('character sheet and Gate picker', async () => {
    fresh();
    const [c, other] = squad(2);
    c.record = { since: T0, out: 9, won: 6, kills: 14, witnessed: 2, closeCall: { low: 0.07, mission: 'Slime Pools', at: b.context.Date.now() - 2 * 3600000 }, last: { mission: 'Wolf Trail', won: false, at: b.context.Date.now() - 60000 } };
    b.Game.renderAll();
    const textsOf = (sel) => { const out = []; const walk = (el) => { if (!el) return; for (const v of [el._html, el._text, el.title]) if (v) out.push(v); (el._kids || []).forEach(walk); }; walk(b.el(sel)); return out; };
    const d = ctx.Roster.describeRecord(c.record, { now: b.context.Date.now() });
    const gate = textsOf('#gate');
    check(gate.some(t => t === d.brief) && gate.some(t => t === d.title), `the Gate party card shows the brief line and the tooltip (${d.brief})`);
    check(gate.some(t => t === 'no sorties yet'), 'and "no sorties yet" for a character who has not been out');

    let tile = null;
    const find = (el) => { if (!tile && el) { if (el.className === 'tile' && el.title && el.title.startsWith(c.name + ' ')) tile = el; else (el._kids || []).forEach(find); } };
    find(b.el('#roster-panel'));
    check(!!tile, 'setup: the roster has a tile for the character');
    if (!tile) return;
    tile.click();
    const sheet = textsOf('#sheet').find(t => t.includes('<h4>Record</h4>'));
    check(!!sheet, 'the sheet has a Record section');
    if (sheet) {
      check(sheet.includes(d.counts) && sheet.includes('seasoned') && sheet.includes(`<i>closest call</i> ${d.closest}`) && sheet.includes(`<i>last sortie</i> ${d.last}`) && sheet.includes(d.since) && sheet.includes(d.legend),
        `the section has the label, counts, closest call, last sortie, start date and what is counted (${sheet.replace(/s+/g, ' ').slice(0, 240)})`);
      check(d.closest === 'lowest HP 7% on Slime Pools, 2 h ago' && d.last === 'not won on Wolf Trail, 1 min ago', `the times are relative to the page clock (${d.closest} / ${d.last})`);
    }
    other.record = undefined;
    b.Game.renderAll();
    tile = null; find(b.el('#roster-panel'));
    check(!!tile, 'a character with no record still draws');
  });

  await ascenario('altar', async () => {
    fresh();
    const [target, sac, friend, loner, crowd] = squad(5);
    const admirers = st.characters.filter(c => ![target, sac, friend, loner, crowd].includes(c)).slice(0, 5);
    admirers.forEach((c, i) => { Bo.ensure(st)[Bo.key(crowd.id, c.id)] = { v: 30 + 10 * i, spark: 0, runs: 0, shifts: 0, met: 0 }; });
    Bo.ensure(st)[Bo.key(sac.id, friend.id)] = { v: 40, spark: 0, runs: 2, shifts: 0, met: 0 };
    sac.record = { since: 1, out: 14, won: 10, kills: 31, witnessed: 0, closeCall: null, last: null };
    for (const c of st.characters) if (c !== target) c.fav = false;
    st.buildings.altar = Math.max(1, st.buildings.altar || 0);
    // open the altar, pick the vessel by clicking its card
    b.Game.renderAll();
    const findCard = (name) => { let hit = null; const walk = (el) => { if (!hit && el && el._kids) { if (el.className === 'card' && el._kids.some(k => k._html && k._html.includes(`>${name}</div>`))) hit = el; else el._kids.forEach(walk); } }; walk(b.el('#altar')); return hit; };
    const vessel = findCard(target.name);
    check(!!vessel, 'setup: the altar lists the vessel');
    if (!vessel) return;
    vessel.click();
    const rows = () => htmlOf('#altar').filter(h => h.includes('pick-info'));
    const rowOf = (c) => rows().find(h => h.includes(`${c.name} <span class="stars"`));
    const row = rowOf(sac);
    check(!!row, 'the offering row for the bonded character is drawn');
    if (!row) return;
    check(row.includes('seasoned, 14 sorties, last') === false && row.includes('14 sorties'), `the row names the record (${row.replace(/\s+/g, ' ').slice(0, 260)})`);
    const hit = Math.round(Math.min(35, 40 * 0.55));
    check(row.includes('would grieve:') && row.includes(`${friend.name}, friends: -${hit} morale`), `the row lists the friend with the tier word and -${hit} morale`);
    check(row.includes(`MOR ${Math.round(Cond.morale(friend))}/100 now, ${Math.round(Math.max(0, Cond.morale(friend) - 40 * 0.55))} after`), 'the tooltip gives the friend\'s MOR bar before and after');
    check(!row.includes('more</div>') && !row.includes('; +'), 'with one friend nothing is collapsed');
    const crowdRow = rowOf(crowd);
    const strongest = admirers.slice().reverse().slice(0, ctx.Roster.GRIEF_LINES);
    check(crowdRow && crowdRow.includes(`; +${admirers.length - strongest.length} more</div>`) && strongest.every((c, i) => crowdRow.includes(`>${c.name}, `)) && !crowdRow.includes(`>${admirers[0].name}, `), `five friends: the four strongest are named and the fifth is counted (${crowdRow && crowdRow.match(/would grieve.*?<\/div>/)})`);
    const loneRow = rowOf(loner);
    check(loneRow && loneRow.includes('nobody would grieve'), 'a character with no bond above 12 says nobody would grieve');

    // spend them through the buttons: first click opens the question, which names the record
    const buttons = [];
    const walk = (el) => { if (el && el._kids) { for (const k of el._kids) { if (k.tagName === 'BUTTON') buttons.push(k); walk(k); } } };
    walk(b.el('#altar'));
    const rowEl = (() => { let hit = null; const find = (el) => { if (!hit && el && el._kids) { if (el._html && el._html.includes(`${sac.name} <span class="stars"`)) hit = el; else el._kids.forEach(find); } }; find(b.el('#altar')); return hit; })();
    const ask = (el) => { let btn = null; const find = (e) => { if (!btn && e && e._kids) e._kids.forEach(k => { if (!btn && k.tagName === 'BUTTON' && k.textContent === 'Sacrifice') btn = k; else find(k); }); }; find(el); return btn; };
    const open = rowEl && ask(rowEl.parentNode ? rowEl : rowEl);
    check(!!open, 'the Sacrifice button is there');
    if (!open) return;
    const m0 = Cond.morale(friend);
    open.click();
    const confirm = htmlOf('#altar').find(h => h.includes('dies here and can never be summoned again'));
    check(confirm && confirm.includes('Record: 14 sorties, 31 kills.'), `the confirmation names the record (${confirm})`);
    let yes = null;
    const findYes = (e) => { if (e && e._kids) e._kids.forEach(k => { if (!yes && k.tagName === 'BUTTON' && k.textContent === `Spend ${sac.name}`) yes = k; else findYes(k); }); };
    findYes(b.el('#altar'));
    check(!!yes, 'the confirm button is there');
    if (!yes) return;
    yes.click();
    check(!st.characters.some(c => c.id === sac.id) && st.roster.fallen[0].id === sac.id, 'the sacrificed character is on the memorial');
    check(Math.abs(Cond.morale(friend) - (m0 - 40 * 0.55)) < 1e-6, `the friend lost what the row said: ${m0} to ${Cond.morale(friend)}`);
    check(st.log.some(l => l.text.includes(friend.name) && l.text.includes(sac.name) && l.text.includes(`morale -${hit}`)), 'and the town log says so');
    check(st.roster.fallen[0].record && st.roster.fallen[0].record.kills === 31, 'the memorial kept the record');
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
