// Retreat order. `node test/retreat.js`; exit code 1 on any failure.
// `node test/retreat.js measure` prints deaths per sortie with and without an HP-threshold retreat policy
// (the last section of this file lists its options).
//
// Before the first contact the exit button is the free call-off. Sortie.exitState reads 'free' only while
// Field.contacted is false (no hostile has seen the squad, no fight has opened, nobody is down); after that it reads
// 'order', the click sends Field.retreat, and the contract ends through verdict() and settle() as a loss unless its
// terms are met first. Sortie.abandon reads the same definition for the trial fee and the debrief.
//
// Part A uses field.js in Node with its plain attrition resolver (invented stats, so only mechanics are read here):
//   contacted      false at the start, true after a sighting or a fight, kept by the 'quiet' reset and by a reload,
//                  false for a save from before counters.fights existed
//   contact        the reasons (sighted, fight, fall) outlive the hostiles that caused them: a sighting before the
//                  stairs counts on floor 2, a dead squad member stays on the list through descend(), and a save from
//                  before counters.sightings gets the count from the hostiles it still lists
//   retreat        accepted once, refused while a withdrawal is under way and after the result, no voice line for
//                  an order, the squad's own withdrawal still prints it
//   exit modes     a gate, a window and a standfast contract each end through verdict() inside its bound
//   save / restore a withdrawing run keeps withdrew, phase and contacted through JSON and finishes
// Part B boots game.html through test/game.boot.js and plays Sortie with combat.js:
//   free           call-off before contact frees the party and returns a trial fee; the button reads Call it off
//   contact        a sighting without a fight closes the free window; a button drawn before it sends the order; and
//                  abandon() called directly keeps the trial fee and debriefs the squad, as the button's order does
//   floors         a squad member who fell on floor 1 of a dungeon that then descends is on the memorial after
//                  settle(), after a call-off, after a retreat order and after a reload on floor 2
//   deaths         a death in an open fight lands after the order, is retired by settle() and the run ends as a loss
//   trial          a trial that ends in a retreat keeps its fee and is re-rolled
//   every type     every contract type, ordered at its first calm moment after contact, ends through verdict()
//                  inside the bound, and every squad member who fell is off the roster
//   states         Retreating is disabled, the note says when it takes effect, Abandon the run is offered after
//                  Field.STRAGGLE, and all of it survives a reload
// RUNS=n plays n seeds per contract type in the Part B sweep and n+1 seeds for each of the three types in the Part A
// sweep (default 1). The same variable is the harness's contracts per type in `measure`.
// A run is repeatable: Part A pins Rng and Math.random per seed, Part B pins them per play() and rolls its boards
// under a fixed seed.

'use strict';
const path = require('path');
const root = path.join(__dirname, '..');
const req = (m) => require(path.join(root, m + '.js'));
const Rng = req('rng'), MT = req('missiontypes'), F = req('field'), Tactics = req('tactics');
const { boot, mulberry } = require('./game.boot.js');

// rot.js prints this on some generated maps
const print = console.log;
console.log = (...a) => { if (!/Unable to connect room/.test(a.join(' '))) print(...a); };

let failed = 0, checks = 0;
const check = (cond, msg) => { checks++; if (!cond) { failed++; print('FAIL ' + msg); } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const scenario = (name, fn) => {
  try { fn(); } catch (e) { failed++; print(`FAIL ${name}: threw ${e && e.stack}`); }
};
const ascenario = async (name, fn) => {
  try { await fn(); } catch (e) { failed++; print(`FAIL ${name}: threw ${e && e.stack}`); }
};
const RUNS = Math.max(1, +process.env.RUNS || 1);

// ---------- Part A: field.js in Node ----------

const partA = [];
const scenarioA = (name, fn) => partA.push([name, fn]);

const seeded = (seed, fn) => {
  const rand = mulberry(seed), prev = Math.random;
  Math.random = rand;
  try { return Rng.withSource(rand, () => fn(rand)); } finally { Math.random = prev; }
};
const squadOf = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: 'P' + (i + 1), maxHp: 80, power: 5 }));
function begin(type, level) {
  const mission = MT.roll(type, { level });
  const party = squadOf(Math.min(mission.party[1], Math.max(mission.party[0], 4)));
  return { mission, party, s: F.start(mission, { party }) };
}
const charsOf = (party) => Object.fromEntries(party.map(c => [c.id, c]));
const reload = (s, party) => F.restore(JSON.parse(JSON.stringify(F.save(s))), { characters: charsOf(party) });
const stepUntil = (s, done, limit = 6000) => { for (let i = 0; i < limit && !s.result && !done(s); i++) F.step(s); return !s.result && done(s); };
const calm = (s) => F.contacted(s) && !s.skirmishes.length;
const squadAlive = (s) => s.actors.filter(a => a.role === 'squad' && a.alive);
const bound = (s) => Math.max(F.STRAGGLE, s.mission.duration) + 2;

scenarioA('contacted', () => {
  let sightOnly = 0, fought = 0;
  for (const seed of [1, 2, 3, 4]) seeded(seed, () => {
    const { s, party } = begin('extermination', 2);
    check(!F.contacted(s), `seed ${seed}: a run that has not started reads as uncontacted`);
    const old = JSON.parse(JSON.stringify(F.save(s)));
    delete old.counters.fights;
    const fromOld = F.restore(old, { characters: charsOf(party) });
    check(!F.contacted(fromOld), `seed ${seed}: a save without counters.fights reads as uncontacted`);

    check(F.contact(s).length === 0, `seed ${seed}: a run that has not started has no reason for contact`);
    check(stepUntil(s, F.contacted), `seed ${seed}: the squad reaches a contact`);
    const sawOne = s.actors.some(a => a.spotted);
    check((s.counters.fights || 0) > 0 || sawOne, `seed ${seed}: contact is a fight or a hostile that has seen the squad`);
    check(F.contact(s).includes(sawOne ? 'sighted' : 'fight') && F.contacted(s) === (F.contact(s).length > 0), `seed ${seed}: the reasons name it (${F.contact(s)})`);
    if (s.counters.fights > 0) fought++; else sightOnly++;
    s.counters.spotted = 0;                                    // what the 'quiet' side job does (sideCheck)
    check(F.contacted(s), `seed ${seed}: resetting counters.spotted does not make the squad uncontacted`);
    const back = reload(s, party);
    check(F.contacted(back), `seed ${seed}: contact survives save, JSON and restore`);

    // the same run from an old save: the first fight must count from zero, not from undefined
    const o2 = JSON.parse(JSON.stringify(F.save(fromOld)));
    const again = F.restore(o2, { characters: charsOf(party) });
    stepUntil(again, (x) => x.counters.fights !== undefined && x.counters.fights > 0, 1500);
    if (again.counters.fights !== undefined) check(Number.isInteger(again.counters.fights) && again.counters.fights >= 1, `seed ${seed}: fights counts from an old save (${again.counters.fights})`);
  });
  check(sightOnly > 0, `setup: some seed was contacted by a sighting before any fight (${sightOnly} of ${sightOnly + fought})`);
});

scenarioA('retreat order', () => seeded(3, () => {
  const fresh = begin('extermination', 2).s;
  check(F.retreat(fresh) === true && fresh.withdrew && fresh.withdrew.why === 'called back', 'Field accepts the order at any time; the free window is sortie.js exitState');
  check(F.retreat(null) === false, 'no run, no order');

  const { s } = begin('extermination', 2);
  check(stepUntil(s, calm), 'setup: a calm moment after contact');
  s.will = Object.assign({}, s.will, { voice: 'Ana' });
  const alive0 = squadAlive(s).length;
  check(F.retreat(s) === true, 'the order is accepted');
  check(s.withdrew.why === 'called back' && s.withdrew.ordered === true && s.withdrew.at === s.clock && s.phase === 'leaving', `withdrawal recorded (${JSON.stringify(s.withdrew)}, phase ${s.phase})`);
  check(s.log.some(l => /called back/.test(l.text)), 'the log says the squad was called back');
  check(!s.log.some(l => /saying so/.test(l.text)), 'an order from the panel does not credit a squad member with the decision');
  const at = s.withdrew.at;
  F.step(s); F.step(s);
  check(F.retreat(s) === false && s.withdrew.at === at, 'a second order is refused and changes nothing');
  stepUntil(s, () => false, 20000);
  check(!!s.result, 'the run ends');
  check(F.retreat(s) === false, 'no order after the result');
  check(squadAlive(s).length <= alive0, 'nobody is added back');

  // the squad's own withdrawal still names the voice
  const own = begin('extermination', 2).s;
  stepUntil(own, calm);
  own.will = Object.assign({}, own.will, { voice: 'Ana' });
  for (const a of squadAlive(own)) a.hp = 1;
  F.step(own);
  check(!!own.withdrew && own.withdrew.why !== 'called back' && own.withdrew.ordered === false, `a squad hurt past its line withdraws by itself (${own.withdrew && own.withdrew.why})`);
  check(own.log.some(l => /Ana has been saying so/.test(l.text)), 'and that withdrawal still prints the voice line');
}));

scenarioA('exit modes', () => {
  const modes = new Map();
  for (const type of ['extermination', 'siege', 'rescue']) for (let seed = 1; seed <= RUNS + 1; seed++) seeded(seed * 31 + type.length, () => {
    const { s } = begin(type, 1 + (seed % 4));
    const mode = s.portal.mode;
    if (!stepUntil(s, calm)) { return; }
    check(F.retreat(s) === true, `${type} seed ${seed}: order accepted`);
    if (mode === 'standfast') {
      F.step(s);
      check(!!s.result || s.portal.state === 'open', `${type} (standfast) seed ${seed}: the door opens where the squad stands on the step after the order (${s.portal.state})`);
    }
    stepUntil(s, () => false, 20000);
    check(!!s.result, `${type} (${mode}) seed ${seed}: the run ends`);
    if (!s.result) return;
    const wait = s.clock - s.withdrew.at;
    check(wait <= bound(s), `${type} (${mode}) seed ${seed}: out after ${wait} s, bound ${bound(s)}`);
    check(!s.result.won || s.mission.win.every(a => F.winMet(s, a)), `${type} (${mode}) seed ${seed}: a win only if the terms are met (${s.result.why})`);
    modes.set(mode, (modes.get(mode) || 0) + 1);
  });
  for (const m of ['gate', 'window', 'standfast']) check(modes.get(m) > 0, `setup: a ${m} contract was ordered to retreat (${[...modes].join(', ')})`);
});

scenarioA('save and restore while withdrawing', () => seeded(4, () => {
  const { s, party } = begin('extermination', 2);
  check(stepUntil(s, calm), 'setup: a calm moment after contact');
  F.retreat(s);
  for (let i = 0; i < 3 && !s.result; i++) F.step(s);
  const back = reload(s, party);
  check(F.contacted(back), 'contacted after the round trip');
  check(JSON.stringify(back.withdrew) === JSON.stringify(s.withdrew) && back.phase === 'leaving', `withdrew and phase survive (${JSON.stringify(back.withdrew)}, ${back.phase})`);
  check(F.retreat(back) === false, 'the restored run refuses a second order');
  stepUntil(back, () => false, 20000);
  check(!!back.result, `the restored run ends (${back.result && back.result.why})`);
}));

scenarioA('closing counts the hostiles that are hunting and not a guard at its post', () => seeded(7, () => {
  // tactics.js closing(): found, not fighting, hunting (Field.hunting) and within NEAR of the squad
  const { s } = begin('extermination', 2);
  const crew = squadAlive(s);
  const cx = Math.round(crew.reduce((n, a) => n + a.x, 0) / crew.length), cy = Math.round(crew.reduce((n, a) => n + a.y, 0) / crew.length);
  const foe = s.actors.find(a => a.side === 'theirs' && a.role === 'hostile');
  for (const a of s.actors) if (a.side === 'theirs' && a !== foe) a.alive = false;      // one hostile, placed by hand
  Object.assign(foe, { x: cx + 6, y: cy, found: true, spotted: true, goal: null, engaged: null, lastSeen: undefined, cowedUntil: 0 });
  s.alarm = false; s.alarmUntil = 0; s.alarmAt = null; s.clock = 500;
  const counts = () => Tactics.closing(s).includes(foe);
  check(F.hunting(s, foe) === false && !counts(), 'a hostile that spotted the squad, stands at its post, has no alarm and has seen nobody for a while is not closing');
  foe.goal = { kind: 'actor', id: crew[0].id };
  check(F.hunting(s, foe) && counts(), 'with a goal at a squad member it is');
  foe.goal = { kind: 'point', x: cx, y: cy };
  check(F.hunting(s, foe) && counts(), 'with a goal at the last place somebody was seen it is');
  foe.goal = null; s.alarmUntil = s.clock + 75; s.alarmAt = { x: foe.x, y: foe.y };
  check(F.hunting(s, foe) && counts(), 'with the alarm up where it stands it is (the second between a sighting and its goal)');
  s.alarmUntil = 0; foe.lastSeen = s.clock - 5;
  check(F.hunting(s, foe) && counts(), 'having seen a squad member 5 s ago it is');
  foe.lastSeen = s.clock - 60;
  check(!F.hunting(s, foe) && !counts(), 'having seen nobody for 60 s it is not');
  foe.spotted = false; s.alarmUntil = s.clock + 75;
  check(!F.hunting(s, foe) && !counts(), 'a hostile that never spotted the squad and has no goal is not hunting, whatever the alarm says');
  foe.spotted = true; foe.goal = { kind: 'actor', id: crew[0].id }; foe.cowedUntil = s.clock + 30;
  check(!counts(), 'a cowed hostile is not closing');
  foe.cowedUntil = 0; foe.x = cx + 20;
  check(!counts(), 'a hunting hostile beyond NEAR is not closing yet');
  foe.x = cx + 6; foe.engaged = {};
  check(!counts(), 'and one already fighting is not');
}));

scenarioA('contact outlives the hostiles that caused it', () => {
  // counters.sightings is never reset and descend() drops the hostiles, so a sighting before the stairs still counts on floor 2
  let found = 0;
  for (let seed = 1; seed <= 30 && found < 2; seed++) seeded(seed, () => {
    const { s, party } = begin('dungeon', 3);
    if (s.map.floors < 2) return;
    stepUntil(s, (x) => x.counters.sightings > 0);
    // the sighting has to be on floor 1: a squad that finds the stairs before anything sees it is a different case
    if (s.result || s.skirmishes.length || s.counters.fights > 0 || s.floorNo !== 1) return;
    const z = s.map.zones.stairs;
    for (const a of squadAlive(s)) { a.x = z.x; a.y = z.y; a.px = z.x; a.py = z.y; }
    for (let i = 0; i < 5 && s.floorNo === 1 && !s.result; i++) F.step(s);
    if (s.floorNo !== 2 || s.counters.fights > 0) return;
    found++;
    check(!s.actors.some(a => a.spotted), `seed ${seed}: the hostiles that spotted the squad are left on floor 1`);
    check(F.contact(s).join() === 'sighted', `seed ${seed}: the sighting is still a reason on floor 2 (${F.contact(s)})`);
    s.counters.spotted = 0;                                     // the 'quiet' side job
    check(F.contacted(s) && F.contacted(reload(s, party)), `seed ${seed}: and survives the quiet reset and a reload`);
  });
  check(found >= 1, `setup: a squad was sighted and then descended without a fight (${found})`);

  // a squad member who is down is a reason, and the body stays on the list through the stairs
  seeded(5, () => {
    const { s } = begin('dungeon', 3);
    check(F.contact(s).length === 0, 'a squad of the full party has no reason');
    const down = squadAlive(s)[0];
    down.alive = false;
    check(F.contact(s).join() === 'fall' && F.contacted(s), `a squad member who is down is a reason (${F.contact(s)})`);
    const z = s.map.zones.stairs;
    for (const a of squadAlive(s)) { a.x = z.x; a.y = z.y; a.px = z.x; a.py = z.y; }
    for (let i = 0; i < 5 && s.floorNo === 1 && !s.result; i++) F.step(s);
    check(s.floorNo === 2 && s.actors.includes(down) && !down.alive, `descend() keeps the body on the list (floor ${s.floorNo})`);
    check(down.x === s.map.entry.x && down.y === s.map.entry.y && s.map.passable(down.x, down.y), 'and puts it on the entry tile of the new floor, inside the map');
    check(squadAlive(s).every(a => a !== down) && F.contact(s).includes('fall'), 'it is not among the living and is still a reason on floor 2');
  });
});

scenarioA('a save from before counters.sightings', () => {
  let tested = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) seeded(seed, () => {
    const { s, party } = begin('extermination', 2);
    stepUntil(s, (x) => x.actors.some(a => a.spotted));
    if (!s.actors.some(a => a.spotted)) return;
    tested++;
    const old = JSON.parse(JSON.stringify(F.save(s)));
    delete old.counters.sightings;
    const back = F.restore(old, { characters: charsOf(party) });
    check(back.counters.sightings === s.actors.filter(a => a.spotted).length && F.contact(back).includes('sighted'), `seed ${seed}: the hostiles on the list that had spotted the squad count as sightings (${back.counters.sightings})`);
    const fresh = begin('extermination', 2);
    const none = JSON.parse(JSON.stringify(F.save(fresh.s)));
    delete none.counters.sightings;
    check(F.contact(F.restore(none, { characters: charsOf(fresh.party) })).length === 0, `seed ${seed}: an old save with nobody spotted is untouched`);
  });
  check(tested > 0, `setup: a hostile spotted the squad in some seed (${tested})`);
});

// ---------- Part B: the booted page ----------

async function partB() {
  const { setup } = require('./sortie.harness.js');
  const lab = await setup({ poolSize: 12 });
  if (lab.bootFailed || lab.failed) { failed++; print('FAIL part B: ' + (lab.failed || 'the page did not boot')); if (lab.b) lab.b.dispose(); return; }
  const { b, ctx, st, S } = lab;
  const Fd = ctx.Field, Cond = ctx.Condition;

  // the board is rolled under a seed of its own, so a type and level always give the same contract
  const contract = (type, level) => b.withSeed(7000 + level * 31 + type.length, () => {
    const MTc = ctx.MissionTypes, roll = MTc.roll;
    MTc.roll = (t, o) => roll.call(MTc, type, Object.assign({}, o, { level }));
    try { return S.board(st, true)[0]; } finally { MTc.roll = roll; }
  });
  const free = () => st.characters.filter(c => !c.mission && !(c.injured > 0));
  const partyFor = (mission, n = 4) => free().slice(0, Math.max(mission.party[0], Math.min(n, mission.party[1])));
  const play = (seed, fn) => b.withSeed(seed, fn);
  const fresh = () => { S.discard(); lab.restore(); };
  const fallen = () => (st.roster && st.roster.fallen) || [];
  const button = () => b.el('#sortie-abandon'), note = () => b.el('#sortie-exit-note');
  const draw = () => { button()._l = {}; S.render(); };
  const label = () => button().textContent + (button().disabled ? ' (disabled)' : '');
  const toContact = (f, limit = 6000) => { for (let i = 0; i < limit && !f.result && !Fd.contacted(f); i++) Fd.step(f); return !f.result && Fd.contacted(f); };
  const toFight = (f, limit = 6000) => { for (let i = 0; i < limit && !f.result && !f.skirmishes.length; i++) Fd.step(f); return !f.result && f.skirmishes.length > 0; };
  const toCalm = (f, limit = 6000) => { for (let i = 0; i < limit && !f.result && !(Fd.contacted(f) && !f.skirmishes.length); i++) Fd.step(f); return !f.result && Fd.contacted(f) && !f.skirmishes.length; };
  const squadDead = (f) => f.actors.filter(a => a.role === 'squad' && !a.alive);

  await ascenario('call-off before contact', async () => {
    fresh();
    const mission = contract('extermination', 3);
    const chars = partyFor(mission);
    const was = chars.map(c => ({ c, xp: c.class.xp, stam: Cond.ensure(c).stamina, morale: Cond.ensure(c).morale }));
    const buried = fallen().length;
    play(5, () => {
      const r = S.launch(mission, chars.map(c => c.id));
      check(typeof r === 'object', `launch (${r})`);
      draw();
      check(S.exitState() === 'free', `the state is free at launch (${S.exitState()})`);
      check(label() === 'Call it off', `the button reads Call it off (${label()})`);
      check(/^Free until/.test(note().textContent), `the note states the rule (${note().textContent})`);
      b.click('#sortie-abandon');
    });
    check(S.run === null, 'the run is gone');
    for (const w of was) {
      check(w.c.mission === null, `${w.c.name} is free`);
      check(w.c.class.xp === w.xp && near(Cond.ensure(w.c).stamina, w.stam) && near(Cond.ensure(w.c).morale, w.morale), `${w.c.name}: nothing spent or earned`);
    }
    check(fallen().length === buried, 'nobody was retired');
  });

  await ascenario('trial fee: returned before contact, kept after', async () => {
    fresh();
    const owner = free()[0], others = free().slice(1, 3);
    owner.stats.stars = 1;
    for (const k of ['gems', 'ore', 'herbs', 'crops']) st[k] = 1e6;
    const cost = ctx.Quests.cost(owner);
    const stock = () => Object.fromEntries(Object.keys(cost).map(k => [k, st[k]]));
    const before = stock();
    const ids = [owner.id, ...others.map(c => c.id)];
    play(8, () => {
      const r = S.launch(ctx.Quests.offer(st, owner).group, ids);
      check(typeof r === 'object', `trial launch (${r})`);
      check(Object.keys(cost).every(k => st[k] === before[k] - cost[k]), 'the fee is taken at launch');
      draw();
      check(S.exitState() === 'free', 'a trial before contact is free');
      b.click('#sortie-abandon');
    });
    check(S.run === null && owner.mission === null, 'the run is gone and the owner is free');
    check(Object.keys(cost).every(k => st[k] === before[k]), `the fee came back (${JSON.stringify(stock())} vs ${JSON.stringify(before)})`);

    const held = st.trials[owner.id];
    let r = null;
    play(9, () => {
      r = S.launch(ctx.Quests.offer(st, owner).group, ids);
      check(typeof r === 'object', `second trial launch (${r})`);
      draw();
      check(toCalm(r.field), 'setup: the squad reaches a calm moment after contact');
      check(S.exitState() === 'order', 'the state is order after contact');
      b.click('#sortie-abandon');
      S.skip();
    });
    const res = r.field.result;
    check(!!res && res.won === false, `the trial ended as a loss (${res && res.why})`);
    const stillThere = st.characters.some(c => c.id === owner.id);
    check(st.log.filter(l => /returned/.test(l.text)).length === 1, 'one refund line, from the call-off before contact and not from the retreat');
    if (stillThere) {
      check(st.log.some(l => l.text.includes(owner.name) && /failed/.test(l.text)), 'the trial is logged as failed');
      check(st.trials[owner.id] !== held && !!st.trials[owner.id], 'and re-rolled as a different offer');
    }
  });

  await ascenario('a sighting closes the free window and a stale button sends the order', async () => {
    let done = false;
    for (let seed = 1; seed < 12 && !done; seed++) {
      fresh();
      const mission = contract('extermination', 3);
      const chars = partyFor(mission);
      let r = null, sightOnly = false, stale = '', atContact = '';
      play(seed, () => {
        r = S.launch(mission, chars.map(c => c.id));
        draw();
        toContact(r.field);
        sightOnly = !r.field.result && r.field.counters.fights === 0 && r.contact === false;
        stale = label();
        atContact = S.exitState();
        if (sightOnly) b.click('#sortie-abandon');
      });
      if (!sightOnly) continue;
      done = true;
      check(stale === 'Call it off', 'the button drawn before the sighting still reads Call it off');
      check(atContact === 'order', `the state is order once a hostile has seen the squad (${atContact})`);
      check(S.run === r && r.field.withdrew && r.field.withdrew.why === 'called back', 'the click sent the retreat order and did not call the run off');
      check(chars.every(c => c.mission === r.id), 'the party is still out');
      check(S.exitState() === 'retreating' && label() === 'Retreating (disabled)', `the button now reads ${label()}`);
    }
    check(done, 'setup: a seed was found where a hostile sees the squad before any fight');
  });

  await ascenario('an order during a fight: the dead still fall and the run ends as a loss', async () => {
    let done = false;
    for (let seed = 1; seed < 12 && !done; seed++) {
      fresh();
      const mission = contract('extermination', 3);
      const chars = partyFor(mission);
      const ids = chars.map(c => c.id);
      let r = null, victim = null, xp0 = null, stateOpen = '', openNote = '', afterNote = '', quiet = false;
      play(seed, () => {
        r = S.launch(mission, ids);
        draw();
        if (!toFight(r.field)) return;
        const sk = r.field.skirmishes[0];
        victim = sk.ours.find(a => a.alive && a.role === 'squad');
        if (!victim) return;
        sk.dead.push(victim);                         // the fight combat.js resolved at open took this one
        xp0 = chars.map(c => c.class.xp);
        stateOpen = S.exitState();
        b.click('#sortie-abandon');
        openNote = note().textContent;
        for (let i = 0; i < 400 && r.field.skirmishes.length && !r.field.result; i++) Fd.step(r.field);
        quiet = !r.field.skirmishes.length && !r.field.result;
        S.render();
        afterNote = note().textContent;
        S.skip();
      });
      if (!victim || !r.field.result) continue;
      done = true;
      const res = r.field.result;
      check(stateOpen === 'order', `the state is order with a fight open (${stateOpen})`);
      check(/takes effect when the current fight ends/.test(openNote), `the note says when it takes effect (${openNote})`);
      check(quiet, 'setup: the fight ended and the run was still going');
      check(!quiet || /heading for the way home/.test(afterNote), `and changes once the fight is over (${afterNote})`);
      check(res.won === false && /^called back/.test(res.why), `the contract ended as a loss (${res.why})`);
      check(!st.characters.some(c => c.id === victim.char.id), 'the member who fell in the open fight is off the roster');
      const rec = fallen().find(f => f.id === victim.char.id);
      check(rec && rec.cause === mission.name, `with a memorial record naming the contract (${rec && rec.cause})`);
      check(Object.keys(r.paid || {}).length === 0, 'nothing was paid');
      check(st.log.some(l => /called back/.test(l.text) && l.text.includes(mission.name)), 'settle() wrote the result line');
      const back = chars.filter(c => st.characters.some(x => x.id === c.id));
      check(back.length > 0 && back.every(c => c.mission === null), 'the survivors are free');
      for (const c of back) {
        const i = chars.indexOf(c);
        check(near(c.class.xp - xp0[i], 0.75 + 0.15 * Math.min(r.fights, 3)), `${c.name}: class XP as a lost mission (${c.class.xp - xp0[i]}, ${r.fights} fights)`);
      }
      check(S.exitState() === 'over' && button().hidden === true, 'the button is hidden once the result is in');
    }
    check(done, 'setup: a seed was found with a fight open and a member in it');
  });

  await ascenario('a sighting without a fight ends the free call-off for abandon() as well as for the button', async () => {
    let done = false;
    for (let seed = 1; seed < 15 && !done; seed++) {
      fresh();
      const owner = free()[0], others = free().slice(1, 3);
      owner.stats.stars = 1;
      for (const k of ['gems', 'ore', 'herbs', 'crops']) st[k] = 1e6;
      const cost = ctx.Quests.cost(owner);
      const stock = () => Object.fromEntries(Object.keys(cost).map(k => [k, st[k]]));
      const before = stock();
      const ids = [owner.id, ...others.map(c => c.id)];
      let r = null, sightOnly = false, atLaunch = '', atSight = '', xp0 = null;
      play(seed, () => {
        r = S.launch(ctx.Quests.offer(st, owner).group, ids);
        draw();
        atLaunch = note().textContent;
        toContact(r.field);
        sightOnly = !r.field.result && r.field.counters.fights === 0 && Fd.contact(r.field).join() === 'sighted';
        if (!sightOnly) return;
        draw();
        atSight = S.exitState() + '|' + note().textContent;
        xp0 = ids.map(id => st.characters.find(c => c.id === id).class.xp);
        S.abandon();                                      // the direct call, as the Abandon the run button makes it
      });
      if (!sightOnly) continue;
      done = true;
      check(/^Free until a hostile has seen the squad, a fight opens or a squad member falls\.$/.test(atLaunch), `the free note names all three events (${atLaunch})`);
      check(/^order\|The call-off is no longer free: a hostile has seen the squad\. /.test(atSight), `after a sighting the state is order and the note names the event (${atSight})`);
      check(S.run === null && ids.every(id => st.characters.find(c => c.id === id).mission === null), 'abandon() ends the run and frees the party');
      check(Object.keys(cost).every(k => stock()[k] === before[k] - cost[k]), `the trial fee stays spent: a sighting is contact (${JSON.stringify(stock())} vs ${JSON.stringify(before)})`);
      const rec = st.field.history[0];
      check(rec && rec.result === 'called off' && rec.won === false && rec.fights === 0, `and the call-off is a report (${rec && rec.result}, ${rec && rec.fights} fights)`);
      check(!st.log.some(l => /returned/.test(l.text)), 'no refund line');
      ids.forEach((id, i) => { const c = st.characters.find(x => x.id === id); check(near(c.class.xp - xp0[i], 0.75), `${c.name}: the debrief of a lost mission ran (class XP +${c.class.xp - xp0[i]})`); });
    }
    check(done, 'setup: a seed was found where a hostile sees the squad before any fight');
  });

  await ascenario('a member who fell on an earlier floor is retired when the squad is on the next one', async () => {
    // A death on floor 1 of a dungeon that then descends. field.js descend() used to carry only the living, so
    // release() found no actor for the dead member and freed them with the rest.
    const fell = (seed) => {
      fresh();
      const mission = contract('dungeon', 3);
      const chars = partyFor(mission);
      let out = null;
      play(seed, () => {
        const r = S.launch(mission, chars.map(c => c.id));
        if (typeof r === 'string') return;
        const f = r.field;
        if (f.map.floors < 2 || !toFight(f)) return;
        const sk = f.skirmishes[0];
        const victim = sk.ours.find(a => a.alive && a.role === 'squad');
        if (!victim || sk.ours.filter(a => a.role === 'squad').length < 2) return;
        sk.dead.push(victim);                           // the fight combat.js resolved at open took this one
        for (let i = 0; i < 400 && f.skirmishes.length && !f.result; i++) Fd.step(f);
        if (f.result || victim.alive || squadAlive(f).length < 2) return;
        const z = f.map.zones.stairs;
        for (const a of squadAlive(f)) { a.x = z.x; a.y = z.y; a.px = z.x; a.py = z.y; a.engaged = null; }
        for (let i = 0; i < 200 && f.floorNo === 1 && !f.result; i++) Fd.step(f);
        if (f.floorNo !== 2 || f.result) return;
        out = { r, f, mission, chars, victim };
      });
      return out;
    };
    const find = (how, check2) => {
      for (let seed = 1; seed < 15; seed++) {
        const o = fell(seed);
        if (o) { check2(o, seed); return true; }
      }
      check(false, `${how}: setup: a seed was found where a member falls on floor 1 and the squad reaches floor 2`);
      return false;
    };
    const retired = (o, label) => {
      const id = o.victim.char.id;
      check(!st.characters.some(c => c.id === id), `${label}: the member who fell on floor 1 is off the roster`);
      const rec = fallen().find(x => x.id === id);
      check(rec && rec.cause === o.mission.name, `${label}: and on the memorial with the contract as the cause (${rec && rec.cause})`);
      const rest = o.chars.filter(c => c.id !== id);
      check(rest.every(c => c.mission === null && (st.characters.some(x => x.id === c.id) !== fallen().some(x => x.id === c.id))), `${label}: each of the others is either home and free or on the memorial, never both and never neither`);
    };
    const onFloor2 = (o, label) => {
      check(o.f.actors.includes(o.victim) && !o.victim.alive, `${label}: the fallen member is still on the actor list on floor 2`);
      check(Fd.contact(o.f).includes('fall') && S.exitState() === 'order', `${label}: the call-off is not free (${Fd.contact(o.f)}, ${S.exitState()})`);
      draw();
      check(/a squad member has fallen/.test(note().textContent), `${label}: the note says why (${note().textContent})`);
    };

    find('settle', (o, seed) => {
      onFloor2(o, 'settle');
      play(seed, () => S.skip());
      check(!!o.f.result, 'settle: the run ends');
      retired(o, 'settle');
    });
    find('call-off', (o, seed) => {
      onFloor2(o, 'call-off');
      const buried = fallen().length;
      play(seed, () => S.abandon());
      check(S.run === null, 'call-off: the run is gone');
      retired(o, 'call-off');
      check(fallen().length === buried + 1, `call-off: one memorial entry (${fallen().length - buried})`);
      const rec = st.field.history[0];
      check(rec && rec.result === 'called off' && rec.lost.includes(o.victim.char.name), `call-off: the report is kept and lists the dead (${rec && rec.result}, ${rec && rec.lost})`);
    });
    find('retreat', (o, seed) => {
      onFloor2(o, 'retreat');
      play(seed, () => { S.exitOrder(); S.skip(); });
      check(!!o.f.result && o.f.result.won === false && /^called back/.test(o.f.result.why), `retreat: the contract ends as a loss (${o.f.result && o.f.result.why})`);
      retired(o, 'retreat');
    });
    await (async () => {
      // the same after a reload on floor 2: the dead member comes back as an actor with alive false
      let o2 = null, seed2 = 0;
      for (seed2 = 1; seed2 < 15 && !o2; seed2++) o2 = fell(seed2);
      check(!!o2, 'reload: setup: a seed was found');
      if (!o2) return;
      b.fire('window', 'beforeunload');
      const b2 = await boot({ html: 'game.html', storage: new Map(b.localStorage.map) });
      try {
        const run2 = b2.Sortie && b2.Sortie.run;
        check(!!run2 && run2.field.floorNo === 2, `reload: the second page resumed the run on floor 2 (${run2 && run2.field.floorNo})`);
        if (!run2) return;
        const back = run2.field.actors.find(a => a.char && a.char.id === o2.victim.char.id);
        check(back && !back.alive, 'reload: the fallen member comes back as a dead actor');
        check(b2.Sortie.exitState() === 'order', `reload: the call-off is still not free (${b2.Sortie.exitState()})`);
        b2.withSeed(3, () => b2.Sortie.skip());
        const gs2 = b2.Game.state;
        check(!gs2.characters.some(c => c.id === o2.victim.char.id) && (gs2.roster.fallen || []).some(x => x.id === o2.victim.char.id), 'reload: the member is retired when the resumed run settles');
      } finally { b2.dispose(); }
    })();
  });

  await ascenario('every contract type: ordered at the first calm moment after contact', async () => {
    const types = Object.keys(ctx.MissionTypes.TYPES);
    const modes = new Map();
    let ordered = 0, early = 0, deaths = 0, longest = 0, called = 0, won = 0, own = 0;
    const otherWhy = new Map();
    for (const type of types) for (let k = 0; k < RUNS; k++) {
      fresh();
      const mission = contract(type, 3);
      const chars = partyFor(mission);
      const ids = chars.map(c => c.id);
      let r = null, state = '', didOrder = false;
      play(40 + types.indexOf(type) * 7 + k, () => {
        r = S.launch(mission, ids);
        if (typeof r === 'string') return;
        didOrder = toCalm(r.field);
        if (!didOrder) return;                    // the contract ended before a calm contact, outside the clock that settles it
        state = S.exitState();
        S.exitOrder();
        S.skip();
      });
      if (typeof r === 'string') { check(false, `${type}: launch (${r})`); continue; }
      const f = r.field;
      if (!didOrder) { early++; continue; }
      check(!!f.result && !!f.withdrew, `${type}: the run ends after the order`);
      if (!f.result || !f.withdrew) continue;
      ordered++;
      // a squad that broke off by itself before the first calm moment has nothing left to order
      check(state === 'order' || (state === 'retreating' && f.withdrew.ordered === false), `${type}: the state at the order was ${state}`);
      if (state === 'retreating') own++;
      const wait = f.clock - f.withdrew.at;
      longest = Math.max(longest, wait);
      check(wait <= bound(f), `${type} (${f.portal.mode}): out after ${wait} s, bound ${bound(f)}`);
      check(!f.result.won || f.mission.win.every(a => Fd.winMet(f, a)), `${type}: a win only if the terms are met (${f.result.why})`);
      if (f.result.won) won++; else if (/^called back/.test(f.result.why)) called++; else otherWhy.set(f.result.why, (otherWhy.get(f.result.why) || 0) + 1);
      const down = squadDead(f).map(a => a.char.id);
      deaths += down.length;
      check(down.every(id => !st.characters.some(c => c.id === id) && fallen().some(x => x.id === id)), `${type}: every member who fell is retired`);
      check(chars.every(c => down.includes(c.id) || (st.characters.some(x => x.id === c.id) && c.mission === null)), `${type}: every survivor is free`);
      modes.set(f.portal.mode, (modes.get(f.portal.mode) || 0) + 1);
    }
    for (const m of ['gate', 'window', 'standfast']) check(modes.get(m) > 0, `setup: a ${m} contract was ordered to retreat (${[...modes].join(', ')})`);
    check(ordered >= types.length * RUNS / 2, `setup: most runs reached a calm contact (${ordered} of ${types.length * RUNS}, ${early} ended first)`);
    print(`  every type: ${ordered} of ${types.length * RUNS} runs ordered, ${called} lost as called back, ${won} won because the terms were met first, ${[...otherWhy].map(([k, n]) => n + ' lost: ' + k).join(', ') || '0 lost by another rule'}, ${own} had already withdrawn on their own, ${deaths} members fell, longest walk ${longest} in-game s`);
  });

  await ascenario('Retreating cannot be pressed; Abandon the run is offered past the bound', async () => {
    fresh();
    const mission = contract('extermination', 3);
    const chars = partyFor(mission);
    let r = null, dyingName = '';
    play(5, () => {
      r = S.launch(mission, chars.map(c => c.id));
      draw();
      check(toCalm(r.field), 'setup: a calm moment after contact');
      draw();
      check(label() === 'Order a retreat', `the button reads ${label()}`);
      check(/loss unless its terms are met/.test(note().textContent), `the note states the cost (${note().textContent})`);
      b.click('#sortie-abandon');
      check(label() === 'Retreating (disabled)', `after the order the button reads ${label()}`);
      check(/heading for the way home/.test(note().textContent), `and the note says where the squad is (${note().textContent})`);
      const at = r.field.withdrew.at;
      S.exitOrder();
      b.click('#sortie-abandon');
      check(r.field.withdrew.at === at && S.run === r, 'pressing it again changes nothing');

      // the note names who withdrew while a fight is open; a placeholder skirmish stands in for one, and nothing steps
      r.field.skirmishes.push({});
      draw();
      check(/Retreat ordered; takes effect when the current fight ends/.test(note().textContent), `ordered, fight open: ${note().textContent}`);
      r.field.withdrew.ordered = false;
      draw();
      check(/withdrawn on its own; it leaves when the current fight ends/.test(note().textContent), `its own decision, fight open: ${note().textContent}`);
      r.field.withdrew.ordered = true;
      r.field.skirmishes.pop();

      // a withdrawal that has run past the bound: the verdict normally ends it first
      const dying = r.field.actors.find(a => a.role === 'squad' && a.alive);
      dying.alive = false; dying.hp = 0; dyingName = dying.char.name;
      r.field.withdrew.at = r.field.clock - Fd.STRAGGLE - 1;
      check(S.exitState() === 'stuck', `past STRAGGLE the state is stuck (${S.exitState()})`);
      draw();
      check(label() === 'Abandon the run', `and the button reads ${label()}`);
      check(/15:00 in-game/.test(note().textContent), `with the bound in the note (${note().textContent})`);
      check(typeof S.abandon === 'function', 'Sortie.abandon is exported');
      b.click('#sortie-abandon');
    });
    check(S.run === null, 'the run is gone');
    check(chars.every(c => c.mission === null), 'nobody is left flagged as out');
    check(fallen().some(x => x.name === dyingName), `the member who fell (${dyingName}) is retired`);
  });

  await ascenario('the three states survive a reload', async () => {
    fresh();
    const mission = contract('extermination', 3);
    const chars = partyFor(mission);
    let r = null;
    const reopen = async () => {
      b.fire('window', 'beforeunload');
      const b2 = await boot({ html: 'game.html', storage: new Map(b.localStorage.map) });
      const S2 = b2.Sortie, run2 = S2 && S2.run;
      return { b2, S2, run2 };
    };
    const read = async (want, labelWant, step) => {
      const { b2, S2, run2 } = await reopen();
      try {
        check(!!run2, `${step}: the second page resumed the run`);
        if (!run2) return;
        check(S2.exitState() === want, `${step}: the state is ${want} after a reload (${S2.exitState()})`);
        b2.el('#sortie-abandon')._l = {};
        S2.render();
        const btn = b2.el('#sortie-abandon');
        check(btn.textContent + (btn.disabled ? ' (disabled)' : '') === labelWant, `${step}: the button reads ${btn.textContent}${btn.disabled ? ' (disabled)' : ''}`);
        if (want === 'retreating') {
          check(JSON.stringify(run2.field.withdrew) === JSON.stringify(r.field.withdrew), `${step}: withdrew survives (${JSON.stringify(run2.field.withdrew)})`);
          b2.withSeed(3, () => S2.skip());
          check(!!run2.field.result && run2.field.result.won === false, `${step}: the resumed run ends as a loss (${run2.field.result && run2.field.result.why})`);
        }
      } finally { b2.dispose(); }
    };
    play(5, () => { r = S.launch(mission, chars.map(c => c.id)); });
    await read('free', 'Call it off', 'before contact');
    play(5, () => { check(toCalm(r.field), 'setup: a calm moment after contact'); });
    await read('order', 'Order a retreat', 'after contact');
    play(5, () => { S.exitOrder(); });
    await read('retreating', 'Retreating (disabled)', 'after the order');
  });

  lab.b.dispose();

  // The dungeon contracts of SEED=1 on a pool of 24 that restarted the same retreat 4 to 175 times before the cap in
  // field.js replan (the sortie harness's default roster; test/rating.harness.js plays the same list). A hostile that had
  // spotted the squad and stayed at its post counted as closing, so the retreat ended when the squad was out of range and
  // began again when it was back. Now none of them repeats it, and none is ended by the cap.
  await ascenario('the dungeon seeds that looped play their retreat at most three times and are not ended by the cap', async () => {
    const big = await setup();
    if (big.bootFailed || big.failed) { check(false, 'setup: second page (' + (big.failed || 'boot errors') + ')'); if (big.b) big.b.dispose(); return; }
    try {
      const seeds = [[6155498, 6], [9716284, 5], [1337964, 5], [6679143, 6], [2280525, 4], [1861609, 5], [4060918, 6], [1966338, 6]];
      const plays = [];
      let capped = 0;
      for (const [seed, level] of seeds) {
        const rec = big.play({ seed, type: 'dungeon', level });
        const field = big.S.run && big.S.run.field;
        if (!rec.result || !field) { check(false, `seed ${seed}: the contract finished`); big.restore(); continue; }
        const n = field.log.filter(l => /fall back to the way in/.test(l.text)).length;
        plays.push(n);
        if (field.withdrew && /^stepped back/.test(field.withdrew.why || '')) capped++;
        big.restore();
      }
      check(plays.length === seeds.length && plays.every(n => n <= 3), `retreat plays per run: ${plays.join(', ')} (none above 3; before the fix 4 to 175 with the cap removed)`);
      check(capped === 0, `${capped} of ${seeds.length} runs ended by the step-back cap`);
    } finally { big.b.dispose(); }
  });
}

// ---------- measure: deaths per sortie with and without an HP-threshold retreat policy ----------
//
// node test/retreat.js measure
// The contracts, squads and seeds are the sortie harness's, on its roster (gearless, random classes, STARS 3-5).
// Arms:
//   none          no order: the squad plays the contract to its own end
//   retreat<T     at the first moment after contact with no fight open, no withdrawal under way and an average HP
//                 of the squad on the map below T, press the exit button (Sortie.exitOrder)
//   calloff<T     the same trigger, ending the run as the free call-off did: the result is a loss at that moment
//                 and the deaths so far are the deaths
// A sortie shares its history with 'none' up to the trigger (the policy draws no random numbers), so 'none' is
// played once per contract and records whether each threshold would have fired. Only the contracts where one
// would are replayed under that arm; the others take the 'none' result, which is what the arm would produce.
// Columns: win% and deaths per sortie over every contract; sorties with a death; orders issued; deaths after
// the order. 'paired' is arm minus none over the sorties where the policy fired, as mean difference and its
// standard error. Environment: the sortie harness's (RUNS per type, LEVEL, SEED, STARS, POOL, TYPES, SQUAD);
// THRESHOLDS=0.7,0.5.

async function measure() {
  const { setup } = require('./sortie.harness.js');
  const lab = await setup();
  if (lab.bootFailed || lab.failed) { print('setup failed: ' + (lab.failed || 'the page did not boot')); return 2; }
  const { ctx, S, cfg } = lab;
  const thresholds = (process.env.THRESHOLDS || '0.7,0.5').split(',').map(Number).filter(x => x > 0 && x <= 1);
  const arms = [];
  for (const t of thresholds) arms.push({ name: 'retreat<' + t, kind: 'retreat', t });
  for (const t of thresholds) arms.push({ name: 'calloff<' + t, kind: 'calloff', t });

  const Fd = ctx.Field;
  const realStep = Fd.step;
  const squadHp = (s) => {
    const crew = s.actors.filter(a => a.role === 'squad' && a.alive && !a.extracted);
    return crew.length ? crew.reduce((n, a) => n + (a.maxHp ? a.hp / a.maxHp : 1), 0) / crew.length : 1;
  };
  /** Wraps Field.step. With an arm it acts at its trigger; without one it records which thresholds would have fired. */
  function watch(arm, mark) {
    Fd.step = function (s) {
      const out = realStep.apply(this, arguments);
      if (s.result || s.withdrew || !Fd.contacted(s) || s.skirmishes.length) return out;
      const hp = squadHp(s);
      if (!arm) { for (const t of thresholds) if (hp < t) mark.would[t] = true; return out; }
      if (mark.fired || hp >= arm.t) return out;
      mark.fired = true;
      mark.deadAtOrder = s.actors.filter(a => a.role === 'squad' && !a.alive).length;
      if (arm.kind === 'retreat') S.exitOrder();
      else s.result = { won: false, why: 'called off' };
      return out;
    };
  }
  const play = (spec, arm) => {
    lab.restore();
    const mark = { fired: false, deadAtOrder: 0, would: {} };
    watch(arm, mark);
    try { return { rec: lab.play(spec), mark }; } finally { Fd.step = realStep; }
  };

  const rows = new Map([['none', []], ...arms.map(a => [a.name, []])]);
  const started = Date.now();
  let replays = 0;
  for (let i = 0; i < cfg.runs; i++) for (const type of cfg.types) {
    const level = cfg.levels[i % cfg.levels.length];
    const seed = ((cfg.seed * 1000003 + cfg.allTypes.indexOf(type) * 7919 + i * 104729 + 17) >>> 0);
    const spec = { seed, type, level };
    const key = type + '|' + level + '|' + seed;
    const base = play(spec, null);
    if ((rows.get('none').length + 1) % 100 === 0) console.error(`  ${rows.get('none').length + 1} contracts, ${replays} replays, ${((Date.now() - started) / 1000).toFixed(0)} s`);
    if (!base.rec.result) continue;
    const row = { key, won: base.rec.result.won, deaths: base.rec.deaths, fired: false, after: 0 };
    rows.get('none').push(row);
    for (const arm of arms) {
      if (!base.mark.would[arm.t]) { rows.get(arm.name).push(row); continue; }
      const { rec, mark } = play(spec, arm);
      replays++;
      if (!rec.result) continue;
      rows.get(arm.name).push({ key, won: rec.result.won, deaths: rec.deaths, fired: mark.fired, after: mark.fired ? rec.deaths - mark.deadAtOrder : 0 });
    }
  }
  const none = new Map(rows.get('none').map(r => [r.key, r]));
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  const se = (a) => (a.length > 1 ? Math.sqrt(a.reduce((n, x) => n + (x - mean(a)) ** 2, 0) / (a.length - 1) / a.length) : NaN);
  const f2 = (v) => (isNaN(v) ? '-' : v.toFixed(2));
  const sgn = (v) => (isNaN(v) ? '-' : (v >= 0 ? '+' : '') + v.toFixed(2));
  const pct = (v) => (isNaN(v) ? '-' : String(Math.round(v * 100)));
  print(`roster ${lab.pool.length} (${cfg.stars.join('-')} stars), levels ${cfg.levels.join(',')}, ${cfg.runs} per type over ${cfg.types.length} types, seed ${cfg.seed}; ${rows.get('none').length} contracts, ${replays} replays, ${((Date.now() - started) / 1000).toFixed(0)} s`);
  print(['arm'.padEnd(13), 'sorties'.padEnd(8), 'win%'.padEnd(5), 'deaths'.padEnd(7), 'w/death%'.padEnd(9), 'orders'.padEnd(7), 'after'.padEnd(6), 'paired (arm - none) over the sorties where it fired'].join(' '));
  for (const name of rows.keys()) {
    const rs = rows.get(name), fired = rs.filter(r => r.fired);
    const dd = fired.map(r => r.deaths - none.get(r.key).deaths), dw = fired.map(r => +r.won - +none.get(r.key).won);
    const paired = fired.length ? `n=${fired.length}: deaths ${sgn(mean(dd))} +/-${f2(se(dd))}, wins ${sgn(mean(dw))} +/-${f2(se(dw))}` : '';
    print([name.padEnd(13), String(rs.length).padEnd(8), pct(mean(rs.map(r => +r.won))).padEnd(5), f2(mean(rs.map(r => r.deaths))).padEnd(7),
      pct(mean(rs.map(r => +(r.deaths > 0)))).padEnd(9), String(fired.length).padEnd(7), String(fired.reduce((n, r) => n + r.after, 0)).padEnd(6), paired].join(' '));
  }
  lab.b.dispose();
  return 0;
}

// ---------- run ----------

(async () => {
  if (process.argv[2] === 'measure') { process.exitCode = await measure(); return; }
  for (const [name, fn] of partA) scenario(name, fn);
  const a = checks;
  await partB();
  print(`part A ${a} checks, part B ${checks - a} checks`);
  print(`${checks} checks, ${failed ? failed + ' failed' : 'all passed'}`);
  process.exit(failed ? 1 : 0);
})();
