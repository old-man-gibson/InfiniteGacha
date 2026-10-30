// Cohesion from who goes. `node test/cohesion.js`; exit code 1 on any failure.
//
// VERBOSE=1 prints every passing check as well.
//
// Part A loads the modules in Node and checks the arithmetic:
//   Crew.cohesion      a party read from the pair records of bonds.js: the whole team, one member, a subset,
//                      a stranger added, a team record as the argument, order of the party
//   Crew.seedPairs     a team saved with a run count of its own hands min(team.runs, pair.runs) to its pairs, once
//   Bonds              the run weight of a 'mission' event, and the text for a fractional run count
//   Missions.debrief   a won run adds 1 to the run count of each pair of survivors, a lost run adds 0.5
//   stats.js           DERIVED.teamwork is CHA x 0.7 + WIS x 0.3 and Crew.teamwork multiplies it
//   Gate               a Gate run builds its fighters without cohesion
// Part B loads sortie.js as test/lifecycle.js does, with an accessor for the screen functions, and checks the
// text the party picker and the launch log print: the picker line, the per-card change if a character is
// sent or kept home, and the launch line.
// Part C boots game.html through test/game.boot.js and plays real contracts through Sortie:
//   launch             the bonus of a party that is not a saved team, and of a subset and of a party with a stranger
//   persist / resume   the saved run holds no bonus, the resumed run computes it again from the party and its
//                      fighters hit as hard as before the reload; a run saved by the earlier format is read too
//   settle             each pair of survivors gains 1 run for a win and 0.5 for a loss, pairs with the dead are gone
//   boot               a second page booted on a save that holds a team with a run count converts it (seedPairs)

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

let failed = 0, checks = 0;
const check = (cond, msg) => { checks++; if (!cond) { failed++; console.log('FAIL ' + msg); } else if (process.env.VERBOSE) console.log('ok   ' + msg); };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const scenario = (name, fn) => {
  try { fn(); } catch (e) { failed++; console.log(`FAIL ${name}: threw ${e && e.stack}`); }
};
const ascenario = async (name, fn) => {
  try { await fn(); } catch (e) { failed++; console.log(`FAIL ${name}: threw ${e && e.stack}`); }
};
/** The percentage text of sortie.js cohPct. */
const pct = (v) => `+${(v * 100).toFixed(1)}%`;

// ---------- Part A: modules in Node ----------

const RACES = ['human', 'draconic', 'therian'];
function makeChar(id, { stars = 3, cls = 'fighter', cha = 14, wis = 10 } = {}) {
  const race = RACES[id % RACES.length];
  const c = { id, name: 'C' + id, race, stats: Stats.rollCharacterStats(race, Math.random, stars), equipment: {}, mind: { traits: [] },
    temper: Temper.roll(), xp: {}, potions: [], injured: 0, mission: null, job: null, progress: 0, techniques: {}, lexicon: [], facets: [], facetState: {} };
  c.profs = Prof.rollAll(stars, race);
  c.affinity = Affinity.roll(); c.psiOrder = Psionic.rollAxisOrder();
  c.gifts = Gifts.roll(c.stats, race); Gifts.ensure(c, null);
  if (Gifts.has(c, 'arcana')) c.lexicon = Spellcraft.rollLexicon(stars);
  c.stats.base.cha = cha; c.stats.base.wis = wis;
  c.stats.derived = Stats.deriveStats(c.stats.base);
  c.mind.social = [];                                   // no hidden trait, so the skill term is the sheet's figure times the class factor
  Classes.assign(c, cls, { force: true });
  Condition.ensure(c);
  return c;
}
function makeTown(chars) {
  return { gems: 1000, crops: 0, ore: 100, herbs: 0, characters: chars, inventory: {}, log: [], mercy: {}, bonds: {},
    missions: { active: [], done: {}, history: [] }, nextId: 1, field: { board: [], rolledAt: 0 }, teams: [], trials: {}, roster: { fallen: [] } };
}
const setPair = (state, a, b, runs, v = 0) => { state.bonds[Bonds.key(a.id, b.id)] = { v, spark: 0, runs, shifts: 0, met: 0 }; };
const setAll = (state, chars, runs) => { for (let i = 0; i < chars.length; i++) for (let j = i + 1; j < chars.length; j++) setPair(state, chars[i], chars[j], runs); };
const runsOf = (state, a, b) => { const p = Bonds.peek(state, a.id, b.id); return p ? p.runs : null; };

scenario('cohesion of a party from its pair records', () => {
  const team = [1, 2, 3, 4, 5].map(i => makeChar(i));
  const stranger = makeChar(6);
  const state = makeTown([...team, stranger]);
  setAll(state, team, 12);

  const five = Crew.cohesion(state, team);
  check(five.strength === 5 && five.pairs === 10 && near(five.runs, 12), `five at 12 runs: ${five.pairs} pairs, mean ${five.runs}`);
  check(near(five.rapport, 1 - Math.exp(-12 / Crew.RAPPORT_RUNS)), `rapport = 1 - exp(-12 / ${Crew.RAPPORT_RUNS}) (${five.rapport})`);
  check(near(five.bonus, Crew.MAX_BONUS * five.rapport * (0.4 + 0.6 * five.skill) * five.accord) && near(five.skillMult, 0.4 + 0.6 * five.skill),
    `bonus = MAX_BONUS x rapport x (0.4 + 0.6 x skill) x accord (${five.bonus})`);
  check(five.bonus > 0.005, `a team with 12 runs between every pair has a bonus (${five.bonus})`);

  const one = Crew.cohesion(state, [team[0]]);
  check(one.bonus === 0 && one.pairs === 0 && one.runs === 0 && one.strength === 1, `one member sent alone has no pair and no bonus (${one.bonus})`);
  const nobody = Crew.cohesion(state, []);
  check(nobody.bonus === 0 && nobody.strength === 0 && nobody.accord === 1, 'an empty party has no bonus');
  const met = Crew.cohesion(state, [team[0], stranger]);
  check(met.bonus === 0 && met.pairs === 1 && met.runs === 0, `two people who have never gone out together have no bonus (${met.bonus})`);

  const three = Crew.cohesion(state, team.slice(0, 3));
  check(three.pairs === 3 && near(three.runs, 12) && near(three.rapport, five.rapport) && three.bonus > 0.005, `three of the five keep the rapport of their own pairs (${three.rapport}, ${three.bonus})`);

  const six = Crew.cohesion(state, [...team, stranger]);
  check(six.pairs === 15 && near(six.runs, 8), `five plus a stranger: 10 pairs at 12 and 5 at 0 average ${six.runs}`);
  check(near(six.rapport, 1 - Math.exp(-8 / Crew.RAPPORT_RUNS)) && six.rapport < five.rapport && six.rapport > five.rapport / 2, `the stranger lowers rapport without zeroing it (${five.rapport} to ${six.rapport})`);
  check(six.bonus > 0.005, `five plus a stranger still has a bonus (${six.bonus})`);
  const four = Crew.cohesion(state, [...team.slice(0, 4), stranger]);
  check(near(four.runs, 6 * 12 / 10) && four.rapport < five.rapport, `four plus a stranger average ${four.runs}`);

  const reversed = Crew.cohesion(state, [...team].reverse());
  check(near(reversed.bonus, five.bonus) && near(reversed.runs, five.runs), 'the order of the party does not matter');

  // a saved team is read as the people on the roster; its own fields are not
  const rec = Crew.create(state, 'Five', team.map(c => c.id));
  rec.runs = 999; rec.lastRun = 1;                      // fields of a team saved before this change
  const asTeam = Crew.cohesion(state, rec);
  check(['bonus', 'rapport', 'skill', 'accord', 'runs', 'pairs', 'strength'].every(k => near(asTeam[k], five[k])), 'a team record reads the same as its members');
  check(!('runs' in Crew.create(state, 'Fresh', [1, 2])) && Crew.completed === undefined, 'a new team stores no runs and Crew.completed is gone');
  rec.members.push(999);                                // a member who is not on the roster
  check(near(Crew.cohesion(state, rec).bonus, five.bonus), 'a member who is not on the roster is left out of a team reading');
  check(Crew.cohesion(state, null).bonus === 0 && Crew.cohesion(state, { members: [] }).strength === 0, 'null and an empty team read as no party');

  // a death: the pairs with the dead are deleted by Bonds.mourn and nothing in the team record needs changing
  const dead = team[4];
  Bonds.mourn(state, dead.id, state.characters.filter(c => c !== dead));
  state.characters = state.characters.filter(c => c !== dead);
  const hit = Crew.tidy(state);
  const afterDeath = Crew.cohesion(state, rec);
  check(hit.length === 1 && hit[0].team === rec && hit[0].lost === 2 && !rec.members.includes(dead.id) && !rec.members.includes(999), 'tidy drops the dead member and the absent one from the team record and returns { team, lost }');
  check(afterDeath.strength === 4 && afterDeath.pairs === 6 && near(afterDeath.runs, 12), `the four survivors keep their own 12 runs (${afterDeath.runs})`);
  const lines = [];
  Crew.mourn(state, (t) => lines.push(t));
  check(lines.length === 0, 'mourn has nothing to say once the teams are tidy');
  rec.members.push(7);                                  // somebody else who is not on the roster
  Crew.mourn(state, (t) => lines.push(t));
  check(lines.length === 1 && /is down to 4$/.test(lines[0]) && !/runs/.test(lines[0]), `mourn says who is left and no figure of runs (${lines[0]})`);
});

scenario('a team saved with a run count of its own', () => {
  const [a, b, c, d, e] = [1, 2, 3, 4, 5].map(i => makeChar(i));
  const state = makeTown([a, b, c, d, e]);
  setPair(state, a, b, 12); setPair(state, a, c, 12); setPair(state, b, c, 7); setPair(state, c, d, 20);
  const team = Crew.create(state, 'Old', [a.id, b.id, c.id]);
  team.runs = 9.5; team.lastRun = 123;                  // a team saved by the earlier format
  const second = Crew.create(state, 'Old two', [a.id, b.id]);
  second.runs = 4;
  const modern = Crew.create(state, 'Modern', [d.id, e.id]);       // no runs: untouched
  const lowered = Crew.seedPairs(state);
  check(runsOf(state, a, b) === 4 && runsOf(state, a, c) === 9.5 && runsOf(state, b, c) === 7, `pairs take min(team.runs, pair.runs), and the lowest of two teams (${runsOf(state, a, b)}, ${runsOf(state, a, c)}, ${runsOf(state, b, c)})`);
  check(lowered === 3 && runsOf(state, c, d) === 20, `three reductions were made (a-b twice, a-c once) and a pair outside any team is unchanged (${lowered}, ${runsOf(state, c, d)})`);
  check(!('runs' in team) && !('lastRun' in team) && !('runs' in second) && !('runs' in modern), 'the team fields are deleted');
  check(Crew.seedPairs(state) === 0 && runsOf(state, a, b) === 4, 'a second call changes nothing');
  check(runsOf(state, d, e) === null, 'no pair record is created for a pair that had none');
  const co = Crew.cohesion(state, team);
  check(near(co.runs, (4 + 9.5 + 7) / 3), `the team now reads the mean of its pairs (${co.runs})`);
});

scenario('skill term and stats.js teamwork', () => {
  const D = Stats.DERIVED.teamwork;
  check(D.fmt === 'dec' && D.stat === 'cha+wis', `teamwork is a decimal governed by CHA+WIS (${D.fmt}, ${D.stat})`);
  check(near(D.f({ cha: 14, wis: 10 }), 14 * 0.7 + 10 * 0.3) && near(D.f({ cha: 3, wis: 3 }), 3) && near(D.f({ cha: 30, wis: 30 }), 30), 'CHA x 0.7 + WIS x 0.3');
  check(Stats.formatDerived('teamwork', 12.34) === '12.3', `printed with one decimal (${Stats.formatDerived('teamwork', 12.34)})`);
  const c = makeChar(1, { cls: 'fighter', cha: 20, wis: 10 });
  const sheet = Stats.effective(c).derived.teamwork;
  check(near(sheet, 17) && near(c.stats.derived.teamwork, 17), `the sheet shows ${sheet} for CHA 20 and WIS 10`);
  const classMult = Classes.socialMult(c);
  check(near(Crew.teamwork(c), 17 * classMult), `with no social trait Crew.teamwork is the sheet figure x the class factor ${classMult} (${Crew.teamwork(c)})`);
  c.mind.social = ['loyal'];
  check(near(Crew.teamwork(c), 17 * classMult * Crew.SOCIAL_TRAITS.loyal.mult), 'a social trait multiplies on top');
  c.equipment = { weapon: { bonus: { cha: 4 } } };
  check(near(Crew.teamwork(c), (24 * 0.7 + 10 * 0.3) * classMult * 1.35), 'gear that adds CHA counts');
  // skill = mean teamwork / 20, capped at 1.4
  const hi = [1, 2].map(i => makeChar(i, { cha: 30, wis: 30 }));
  const lo = [3, 4].map(i => makeChar(i, { cha: 3, wis: 3 }));
  const st = makeTown([...hi, ...lo]);
  setAll(st, [...hi, ...lo], 6);
  const cap = Crew.cohesion(st, hi), floor = Crew.cohesion(st, lo);
  check(near(cap.skill, Math.min(1.4, Crew.teamwork(hi[0]) / 20)) && cap.skill <= 1.4, `skill is mean teamwork / 20 and at most 1.4 (${cap.skill})`);
  check(floor.skill < cap.skill && floor.bonus < cap.bonus, `a party with low teamwork gets less (${floor.bonus} against ${cap.bonus})`);
});

scenario('the run weight of a mission event', () => {
  const [a, b, c, d] = [1, 2, 3, 4].map(i => makeChar(i));
  const state = makeTown([a, b, c, d]);
  setPair(state, a, b, 0); setPair(state, c, d, 0);
  const rateAB = Bonds.rate(state, a, b), rateCD = Bonds.rate(state, c, d);
  Bonds.together(state, [a, b], 'mission', 1, 0.5);
  Bonds.together(state, [c, d], 'mission');
  check(runsOf(state, a, b) === 0.5 && runsOf(state, c, d) === 1, `a weight of 0.5 adds 0.5 to the run count and the default adds 1 (${runsOf(state, a, b)}, ${runsOf(state, c, d)})`);
  check(near(Bonds.peek(state, a.id, b.id).v, Bonds.EVENTS.mission.w * rateAB) && near(Bonds.peek(state, c.id, d.id).v, Bonds.EVENTS.mission.w * rateCD), 'the weight does not change the move in the bond value');
  Bonds.note(state, a, b, 'mission', 1, 0.5);
  Bonds.note(state, a, b, 'won', 1, 0.5);              // the weight is only for the 'mission' event
  check(runsOf(state, a, b) === 1, `note() takes the weight too, and other events do not add runs (${runsOf(state, a, b)})`);
  Bonds.note(state, a, b, 'mission', 1, 0.5); Bonds.note(state, a, b, 'mission');
  check(runsOf(state, a, b) === 2.5 && /2\.5 missions together, lost ones counting half/.test(Bonds.describe(state, a, b).text), `a fractional count says why (${Bonds.describe(state, a, b).text})`);
  check(/ 1 mission together$/.test(Bonds.describe(state, c, d).text) && !/half/.test(Bonds.describe(state, c, d).text), `a whole count has no suffix (${Bonds.describe(state, c, d).text})`);
});

scenario('debrief credits 1 run for a win and 0.5 for a loss', () => {
  const chars = [1, 2, 3].map(i => makeChar(i));
  const state = makeTown(chars);
  const survivors = chars.map(c => ({ c, hp: 1, casts: 0 }));
  const pairs = [[0, 1], [0, 2], [1, 2]];
  Missions.debrief(state, { survivors, fallen: 0, won: true, level: 1, fights: 1 });
  check(pairs.every(([i, j]) => runsOf(state, chars[i], chars[j]) === 1), 'a won run: every pair of survivors at 1');
  Missions.debrief(state, { survivors, fallen: 0, won: false, level: 1, fights: 1 });
  check(pairs.every(([i, j]) => runsOf(state, chars[i], chars[j]) === 1.5), 'a lost run adds 0.5');
  Missions.debrief(state, { survivors: survivors.slice(0, 2), fallen: 1, won: false, level: 1, fights: 1 });
  check(runsOf(state, chars[0], chars[1]) === 2 && runsOf(state, chars[0], chars[2]) === 1.5, 'a lost run with a death: the survivors gain 0.5 and the pair with the absent one gains nothing');
  const co = Crew.cohesion(state, chars);
  check(near(co.runs, (2 + 1.5 + 1.5) / 3), `the mean over the three pairs (${co.runs})`);
});

scenario('a Gate run builds its fighters without cohesion', () => {
  const chars = [1, 2, 3].map(i => makeChar(i, { stars: 5, cls: 'fighter' }));
  const state = makeTown(chars);
  setAll(state, chars, 24);
  check(Crew.cohesion(state, chars).bonus > 0.05, 'setup: this party has a bonus');
  const damage = (c) => Combat.fromCharacter(c, c.loadout, state.mercy).base.damage;
  const seen = [];
  const encounter = Combat.encounter;
  Combat.encounter = function (party) { seen.push(party.map(f => [f.char.id, f.base.damage])); return encounter.apply(this, arguments); };
  try {
    const run = Missions.launch(state, 'forest_edge', chars.map(c => c.id));
    check(typeof run === 'object', `Gate launch (${run})`);
    for (let i = 0; i < 60 && !seen.length; i++) Missions.tick(state);
    check(seen.length > 0, 'setup: a Gate fight happened');
    if (seen.length) for (const [id, dmg] of seen[0]) {
      const c = chars.find(x => x.id === id);
      check(near(dmg, damage(c), 1e-6), `${c.name}: Gate fighter damage ${dmg} is the character's own ${damage(c)}`);
    }
  } finally { Combat.encounter = encounter; }
  const code = fs.readFileSync(file('missions.js'), 'utf8').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  check(!/cohesion|Crew/.test(code), 'missions.js code does not read Crew');
});

// ---------- Part B: the screen functions of sortie.js ----------

let gameState = null;
const gameLines = [];
global.Game = { get state() { return gameState; }, save() {}, logLine(t) { gameLines.push(t); }, addItem() {}, renderAll() {}, advanceCharacter() { return true; } };
global.document = { readyState: 'loading', addEventListener() {}, getElementById: () => null, querySelector: () => null };
global.requestAnimationFrame = () => 1;
global.Tokens = { RINGS: { squad: 'squad', hurt: 'hurt', down: 'down' } };
global.FieldView = { namer: () => null, faces() {}, reface() {}, rehydrate() {} };
let ui = null;
try {
  let src = fs.readFileSync(file('sortie.js'), 'utf8');
  const exportLine = 'window.Sortie = { render,';
  if (!src.includes(exportLine)) throw new Error('sortie.js export line changed; update test/cohesion.js');
  src = src.replace(exportLine, 'window.Sortie = { __ui: { cohesionSummary, partyFacts, cohesionLine, cohesionTitle, cohPct }, render,');
  vm.runInThisContext(src, { filename: file('sortie.js') });
  ui = global.Sortie.__ui;
} catch (e) { failed++; console.log('FAIL part B: sortie.js did not load: ' + (e && e.stack)); }

scenario('party picker text', () => {
  if (!ui) return;
  const team = [1, 2, 3, 4].map(i => makeChar(i));
  const stranger = makeChar(5);
  const hurt = makeChar(6);
  hurt.injured = 20;
  gameState = makeTown([...team, stranger, hurt]);
  setAll(gameState, team, 12);

  check(ui.cohPct(0.1094) === pct(0.1094) && ui.cohPct(0.1094) === '+10.9%', `percentages have one decimal (${ui.cohPct(0.1094)})`);
  const co = Crew.cohesion(gameState, team);
  const sum = ui.cohesionSummary(team);
  check(sum.includes(`<b>${pct(co.bonus)}</b> damage, ${pct(co.bonus / 2)} armour`) && sum.includes('12.0 runs per pair') && sum.includes(`rapport ${co.rapport.toFixed(2)}`) && sum.includes(`accord ${co.accord.toFixed(2)}`),
    `the picker line prints the bonus on both stats and the terms (${sum})`);
  check(sum.includes('title="') && sum.includes('= 18% x rapport') && sum.includes(`exp(-${co.runs.toFixed(1)} / ${Crew.RAPPORT_RUNS})`) && sum.includes('6 pairs'), 'its tooltip holds the arithmetic');
  check(/one person has none/.test(ui.cohesionSummary([team[0]])) && /nobody is picked/.test(ui.cohesionSummary([])), 'one person or nobody: no pairs, +0.0%');

  const facts = (c, party) => ui.partyFacts(c, party);
  // adding the stranger to the four: the bonus falls and the card says from what to what
  const withStranger = Crew.cohesion(gameState, [...team, stranger]);
  const add = facts(stranger, team);
  check(add.includes(`cohesion ${pct(co.bonus)} → ${pct(withStranger.bonus)} if sent`) && withStranger.rapport < co.rapport, `an unpicked card shows the bonus if sent (${add.match(/cohesion[^<]*/)})`);
  check(add.includes('With this character: Cohesion'), 'its tooltip is the arithmetic of the party with this character');
  // a picked card shows what leaving that person at home does
  const without = Crew.cohesion(gameState, team.slice(1));
  const rem = facts(team[0], team);
  check(rem.includes(`cohesion ${pct(co.bonus)} → ${pct(without.bonus)} if kept home`), `a picked card shows the bonus if kept home (${rem.match(/cohesion[^<]*/)})`);
  const picked5 = [...team, stranger];
  const back = facts(stranger, picked5);
  check(back.includes(`${pct(withStranger.bonus)} → ${pct(co.bonus)} if kept home`) && co.bonus > withStranger.bonus, 'removing the stranger raises the bonus back');
  // one picked, adding a second; nobody picked
  const second = facts(team[1], [team[0]]);
  check(second.includes(`cohesion ${pct(0)} → ${pct(Crew.cohesion(gameState, [team[0], team[1]]).bonus)} if sent`), `a second person takes the bonus from +0.0% (${second.match(/cohesion[^<]*/)})`);
  check(!facts(team[0], []).includes('cohesion'), 'nobody picked and one added: still no pair, nothing is said');
  check(!facts(team[0], [team[0]]).includes('cohesion'), 'one picked and removed: nothing is said');
  check(!facts(team[0]).includes('cohesion') && !facts(hurt, null).includes('cohesion'), 'no party passed (a card that cannot be sent): no cohesion text');
  check(facts(team[0], team).includes('stamina') && facts(team[0], null).includes('stamina'), 'the stamina and readiness facts are still there');

  const line = ui.cohesionLine(co);
  check(line.includes(`cohesion ${pct(co.bonus)} damage and magic damage, ${pct(co.bonus / 2)} armour; pairs average 12.0 runs together`), `the launch line (${line})`);
  const off = ui.cohesionLine({ ...co, accord: 0.9 }), on = ui.cohesionLine({ ...co, accord: 1.1 }), flat = ui.cohesionLine({ ...co, accord: 1.01 });
  check(off.includes('accord x0.90 (they do not want the same things)') && on.includes('accord x1.10 (they want the same things)') && !flat.includes('accord'), 'the accord is named only when it is off 1 by more than 0.03');
  check(!/—/.test(line + sum), 'no em dashes in the new text');
});

// ---------- Part C: the booted page ----------

async function partC() {
  const { boot } = require('./game.boot.js');
  const { setup } = require('./sortie.harness.js');
  const lab = await setup({ poolSize: 12 });
  if (lab.bootFailed || lab.failed) { failed++; console.log('FAIL part C: ' + (lab.failed || 'the page did not boot')); if (lab.b) lab.b.dispose(); return; }
  const { b, ctx, st, S } = lab;
  const Bo = ctx.Bonds, Cr = ctx.Crew;
  const play = (seed, fn) => b.withSeed(seed, fn);
  const fresh = () => lab.restore();

  // the contract is rolled under a seed, so a run of this file plays the same contracts every time
  const contract = (type, level, seed) => {
    const MT = ctx.MissionTypes, roll = MT.roll;
    MT.roll = (t, o) => roll.call(MT, type, Object.assign({}, o, { level }));
    try { return b.withSeed(seed, () => S.board(st, true)[0]); } finally { MT.roll = roll; }
  };
  const squad = (n) => st.characters.filter(c => !c.mission && !(c.injured > 0)).slice(0, n);
  const setRuns = (chars, runs) => {
    for (let i = 0; i < chars.length; i++) for (let j = i + 1; j < chars.length; j++) Bo.ensure(st)[Bo.key(chars[i].id, chars[j].id)] = { v: 0, spark: 0, runs, shifts: 0, met: 0 };
  };
  const damages = (r) => Object.fromEntries(r.field.actors.filter(a => a.role === 'squad').map(a => [a.char.id, a.fighter.base.damage]));
  const armours = (r) => Object.fromEntries(r.field.actors.filter(a => a.role === 'squad').map(a => [a.char.id, a.fighter.base.armor]));
  /** A contract of this type that takes a party of n and one more, or null. */
  const sized = (type, level, n) => {
    for (let i = 0; i < 12; i++) { const m = contract(type, level, 500 + i); if (m.party[0] <= n && m.party[1] >= n + 1) return m; }
    return null;
  };

  await ascenario('a party that is not a saved team gets the bonus', async () => {
    const mission = sized('extermination', 3, 3);
    if (!mission) { check(false, 'setup: a contract for three and four'); return; }
    check((st.teams || []).length === 0, 'setup: no team is saved');
    fresh();
    let chars = squad(3);
    play(31, () => { S.launch(mission, chars.map(c => c.id)); });
    const plain = damages(S.run), plainArmour = armours(S.run);
    check(S.run.bonus === 0, `a party with no history gets no bonus (${S.run.bonus})`);
    S.abandon();

    fresh();
    chars = squad(3);
    setRuns(chars, 12);
    const co = Cr.cohesion(st, chars);
    let r = null;
    play(31, () => { r = S.launch(mission, chars.map(c => c.id)); });
    check(typeof r === 'object', `launch (${r})`);
    check(near(r.bonus, co.bonus) && r.bonus > 0.005 && r.cohesion.pairs === 3, `the run carries the bonus ${r.bonus} computed from the party's pairs`);
    const dmg = damages(r), arm = armours(r);
    for (const c of chars) {
      check(near(dmg[c.id], plain[c.id] * (1 + co.bonus), 1e-6), `${c.name}: damage x (1 + ${co.bonus.toFixed(4)}) (${plain[c.id]} to ${dmg[c.id]})`);
      check(near(arm[c.id], plainArmour[c.id] * (1 + co.bonus / 2), 1e-6), `${c.name}: armour x (1 + bonus / 2)`);
    }
    check(st.field.run === undefined || st.field.run.bonus === undefined, 'nothing about a bonus is stored in the saved state');
    check(S.run.field.log.some(l => l.text.includes('cohesion ' + pct(co.bonus))), 'the launch writes the cohesion line to the run log');
    S.abandon();

    // a stranger added to the three: the bonus falls and is not zero; two of the three keep their pair
    fresh();
    chars = squad(4);
    setRuns(chars.slice(0, 3), 12);
    const with4 = Cr.cohesion(st, chars), with3 = Cr.cohesion(st, chars.slice(0, 3)), with2 = Cr.cohesion(st, chars.slice(0, 2));
    play(31, () => { r = S.launch(mission, chars.map(c => c.id)); });
    check(typeof r === 'object' && near(r.bonus, with4.bonus) && r.bonus > 0 && with4.rapport < with3.rapport && near(with4.runs, 6), `three veterans and a stranger launch at ${r.bonus} (rapport ${with4.rapport.toFixed(3)} against ${with3.rapport.toFixed(3)})`);
    S.abandon();
    fresh();
    chars = squad(3);
    setRuns(chars.slice(0, 2), 12);
    play(31, () => { r = S.launch(mission, chars.map(c => c.id)); });
    check(typeof r === 'object' && near(r.bonus, Cr.cohesion(st, chars).bonus) && r.cohesion.pairs === 3 && near(r.cohesion.runs, 4), `two veterans and a stranger: one pair at 12 of three pairs, mean ${r.cohesion.runs}`);
    check(with2.runs === 12, 'setup: the two veterans read 12');
    S.abandon();
  });

  await ascenario('persist, drop the run, resume', async () => {
    const mission = sized('extermination', 3, 3);
    if (!mission) { check(false, 'setup: a contract for three'); return; }
    fresh();
    const chars = squad(3);
    const ids = chars.map(c => c.id);
    setRuns(chars, 12);
    const co = Cr.cohesion(st, chars);
    let r = null;
    play(32, () => { r = S.launch(mission, ids); });
    check(typeof r === 'object' && r.bonus > 0.005, `setup: the launched run has a bonus (${r && r.bonus})`);
    const before = damages(r), armBefore = armours(r), bonusBefore = r.bonus;
    S.persist(true);
    const saved = JSON.parse(JSON.stringify(st.field.run));
    check(saved && !('bonus' in saved) && !('teamId' in saved) && !('teamName' in saved) && Array.isArray(saved.party), `the saved run holds the party and no bonus (${Object.keys(saved).join(',')})`);

    S.discard();                                          // what a reload does to the module's run
    check(S.run === null, 'setup: the module has no run');
    st.field.run = JSON.parse(JSON.stringify(saved));
    check(S.resume() === true, 'resume() picks the run up');
    const r2 = S.run;
    check(near(r2.bonus, bonusBefore) && near(r2.bonus, co.bonus) && r2.cohesion && near(r2.cohesion.runs, 12), `the resumed run computes the same bonus again (${r2.bonus})`);
    const after = damages(r2), armAfter = armours(r2);
    for (const id of ids) {
      check(near(after[id], before[id], 1e-6) && near(armAfter[id], armBefore[id], 1e-6), `fighter ${id}: damage ${after[id]} and armour after the reload equal those before`);
    }
    S.persist(true);
    check(!('bonus' in st.field.run) && !('teamId' in st.field.run), 'a second save of the resumed run still holds no bonus');

    // a run saved by the earlier format: team fields and a bonus that no longer applies
    S.discard();
    st.field.run = { ...JSON.parse(JSON.stringify(saved)), teamId: 'tOld', teamName: 'Old Team', bonus: 0.77 };
    check(S.resume() === true, 'a run saved with team fields resumes');
    const r3 = S.run;
    check(near(r3.bonus, co.bonus) && r3.teamId === undefined && r3.teamName === undefined, `its old bonus 0.77 is replaced by the computed ${r3.bonus} and the team fields are dropped`);
    play(33, () => S.skip());
    check(!!S.run.field.result, 'the resumed run plays to a result');
  });

  await ascenario('settle credits the pairs of the survivors', async () => {
    // a contract that is usually lost, and a seed list, until both a win and a loss have been played
    const seen = { won: 0, lost: 0 };
    const plan = [['extermination', 2], ['hold', 6], ['siege', 6], ['dungeon', 6], ['duel', 2], ['escort', 2]];
    for (let i = 0; i < 40 && (!seen.won || !seen.lost); i++) {
      const [type, level] = plan[i % plan.length];
      const mission = contract(type, level, 200 + i);
      fresh();
      const n = Math.max(mission.party[0], Math.min(4, mission.party[1]));
      const chars = squad(n);
      const ids = chars.map(c => c.id);
      setRuns(chars, 5);
      let r = null;
      play(100 + i, () => { r = S.launch(mission, ids); if (typeof r === 'object') S.skip(); });
      if (typeof r !== 'object' || !S.run.field.result) continue;
      const won = !!S.run.field.result.won;
      const home = st.characters.filter(c => ids.includes(c.id));
      const goneIds = ids.filter(id => !home.some(c => c.id === id));
      let ok = true;
      for (let x = 0; x < home.length; x++) for (let y = x + 1; y < home.length; y++) {
        const p = Bo.peek(st, home[x].id, home[y].id);
        if (!p || !near(p.runs, 5 + (won ? 1 : 0.5))) ok = false;
      }
      check(ok, `${type} L${level} seed ${100 + i}: ${won ? 'won' : 'lost'}, ${home.length} back: each pair of survivors went from 5 to ${5 + (won ? 1 : 0.5)}`);
      check(goneIds.every(id => home.every(c => !Bo.peek(st, id, c.id))), `${goneIds.length} dead: no pair record names them`);
      seen[won ? 'won' : 'lost'] += home.length > 1 ? 1 : 0;
    }
    check(seen.won > 0 && seen.lost > 0, `setup: a win and a loss with two or more survivors were played (${seen.won} won, ${seen.lost} lost)`);
  });

  await ascenario('the screen draws with a team saved and with a run in progress', async () => {
    const mission = sized('extermination', 3, 3);
    if (!mission) { check(false, 'setup: a contract for three and four'); return; }
    fresh();
    const chars = squad(3);
    setRuns(chars, 9);
    Cr.create(st, 'Drawn', chars.map(c => c.id));
    const errors = b.errors.length;
    S.render();                                           // board, reports and the Teams box with the cohesion card
    let r = null;
    play(34, () => { r = S.launch(mission, chars.map(c => c.id)); });
    check(typeof r === 'object' && r.bonus > 0.005, `setup: a run with a bonus (${r && r.bonus})`);
    S.render();                                           // the run panel with the cohesion line
    check(b.errors.length === errors, `render() threw nothing (${b.errors.slice(errors).map(e => e.message).join('; ')})`);
    S.abandon();
  });

  await ascenario('boot converts a team saved with a run count', async () => {
    fresh();
    const chars = squad(3);
    setRuns(chars, 12);
    const team = Cr.create(st, 'Old', chars.map(c => c.id));
    team.runs = 7.5; team.lastRun = 5;                    // the earlier format
    b.Game.save();
    const b2 = await boot({ html: lab.cfg.html, storage: new Map(b.localStorage.map) });
    try {
      check(b2.errors.length === 0, `the second page boots (${b2.errors.length} uncaught exceptions)`);
      const st2 = b2.Game.state, t2 = (st2.teams || []).find(t => t.name === 'Old');
      check(!!t2 && !('runs' in t2) && !('lastRun' in t2), 'the team record has no run count after boot');
      const ids = chars.map(c => c.id);
      const runs = [[0, 1], [0, 2], [1, 2]].map(([i, j]) => st2.bonds[b2.context.Bonds.key(ids[i], ids[j])].runs);
      check(runs.every(r => r === 7.5), `each pair went from 12 to min(7.5, 12) (${runs.join(', ')})`);
      const co = b2.context.Crew.cohesion(st2, t2);
      check(near(co.runs, 7.5), `the team card reads ${co.runs} runs per pair`);
    } finally { b2.dispose(); }
  });

  await ascenario('a death at settle', async () => {
    const mission = sized('extermination', 3, 3);
    if (!mission) { check(false, 'setup: a contract for three and four'); return; }
    fresh();
    const chars = squad(4);
    const ids = chars.map(c => c.id);
    const victim = chars[0];
    setRuns(chars, 8);
    const before = Cr.cohesion(st, chars);
    let r = null;
    play(41, () => {
      r = S.launch(mission, ids);
      const a = r.field.actors.find(x => x.char && x.char.id === victim.id);
      a.alive = false; a.hp = 0;                          // dead on the map before the first step, retired by release() at settle
      S.skip();
    });
    check(typeof r === 'object' && near(r.bonus, before.bonus), `the bonus of the party that went (${r.bonus}) is not changed by a death during the run`);
    const won = !!S.run.field.result.won;
    const home = st.characters.filter(c => ids.includes(c.id));
    check(!home.some(c => c.id === victim.id) && home.length === 3, `the victim is retired and the other three are back (${home.length} back)`);
    check(!Object.keys(st.bonds).some(k => k.split(':').map(Number).includes(victim.id)), 'no pair record names the dead character');
    let ok = home.length > 1;
    for (let x = 0; x < home.length; x++) for (let y = x + 1; y < home.length; y++) {
      const p = Bo.peek(st, home[x].id, home[y].id);
      if (!p || !near(p.runs, 8 + (won ? 1 : 0.5))) ok = false;
    }
    check(ok, `${won ? 'won' : 'lost'}: each pair of survivors went from 8 to ${8 + (won ? 1 : 0.5)}`);
    const after = Cr.cohesion(st, home);
    check(home.length < 2 || near(after.runs, 8 + (won ? 1 : 0.5)), `the survivors' next party reads a mean of ${after.runs} runs`);
  });

  b.dispose();
}

const checksAB = checks;
partC().then(() => {
  console.log(`part A and B ${checksAB} checks, part C ${checks - checksAB} checks`);
  console.log(`${checks} checks, ${failed ? failed + ' failed' : 'all passed'}`);
  process.exitCode = failed ? 1 : 0;
}, (e) => { console.error(e); process.exitCode = 2; });
