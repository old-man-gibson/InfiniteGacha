// Sortie and Missions lifecycle: launch ordering, persist and resume, trial fee, discard, Reset.
// `node test/lifecycle.js`; exit code 1 on any failure.
//
// sortie.js is browser code. It is loaded here as game.html loads it: the modules it reads are
// globals, `window` is the global object, and `document` and `Game` are stubs. Game.save keeps the
// JSON of the state, so a reload is `state = JSON.parse(saved)` with the module's own `run` dropped.
// sortie.js keeps the selected team in a closure variable that only the team cards set, so the
// source is loaded with one accessor appended to window.Sortie (Sortie.__useTeam).

const path = require('path');
const fs = require('fs');
const vm = require('vm');
const root = path.join(__dirname, '..');
const file = (f) => path.join(root, f);

global.window = global;
for (const m of ['rng', 'mercy', 'roster', 'stats', 'proficiency', 'economy', 'affinity', 'classes', 'condition', 'temper', 'bonds', 'crew',
  'ai', 'gifts', 'elements', 'spellcraft', 'psionic', 'martial', 'prowess', 'consume', 'combat', 'bestiary', 'missions',
  'missiontypes', 'quests', 'mapgen', 'field', 'tactics']) require(file(m + '.js'));

// ---------- stubs for the browser parts ----------
let state = null;                       // the town state Game.state returns
let saved = null;                       // JSON of the state at the last Game.save()
let saves = 0;
const lines = [];
global.Game = {
  get state() { return state; },
  save() { saves++; saved = JSON.stringify(state); },
  logLine(t) { lines.push(t); },
  addItem() {}, renderAll() {}, advanceCharacter() { return true; },
};
global.document = { readyState: 'loading', addEventListener() {}, getElementById: () => null, querySelector: () => null };
global.requestAnimationFrame = () => 1;
global.Tokens = { RINGS: { squad: 'squad', hurt: 'hurt', down: 'down' } };
// the same species pick fieldview.js makes, minus the art
global.FieldView = {
  namer(group, mission) {
    const all = Object.values(Missions.BESTIARY);
    const tier = MissionTypes.SPECIES_TIER[group.grade] || 'basic';
    const themed = all.filter(m => m.tier === tier && m.tags.some(t => mission.theme.includes(t)));
    const pool = themed.length ? themed : all.filter(m => m.tier === tier);
    const d = pool.length ? pool[Math.floor(Rng.rand() * pool.length)] : all[0];
    return { id: d.id, label: d.name, icon: d.icon, attrs: d.attrs, tags: d.tags };
  },
  faces() {}, reface() {}, rehydrate() {},
};
// count the intervals Sortie starts and stops, to see that discard() stops the clock
const liveTimers = new Set();
const realSet = global.setInterval, realClear = global.clearInterval;
global.setInterval = (fn, ms) => { const h = realSet(fn, ms); liveTimers.add(h); return h; };
global.clearInterval = (h) => { liveTimers.delete(h); return realClear(h); };

let src = fs.readFileSync(file('sortie.js'), 'utf8');
const exportLine = 'window.Sortie = { render,';
if (!src.includes(exportLine)) throw new Error('sortie.js export line changed; update test/lifecycle.js');
src = src.replace(exportLine, 'window.Sortie = { __useTeam: (id) => { activeTeam = id; }, render,');
vm.runInThisContext(src, { filename: file('sortie.js') });
const Sortie = global.Sortie;

// ---------- harness ----------
let failed = 0, checks = 0;
const check = (cond, msg) => { checks++; if (!cond) { failed++; console.log('FAIL ' + msg); } };
const scenario = (name, fn) => {
  try { fn(); } catch (e) { failed++; console.log(`FAIL ${name}: threw ${e && e.stack}`); }
  Sortie.discard();                                   // nothing carries over to the next scenario
  global.Missions.prepare = realPrepare;
};
const realPrepare = Missions.prepare;
const throwFor = (id) => { Missions.prepare = (c, z) => { if (c.id === id) throw new Error('boom'); return realPrepare(c, z); }; };

const RACES = ['human', 'draconic', 'therian'];
function makeChar(id, { stars = 3, cls = 'fighter', cha = 14 } = {}) {
  const race = RACES[id % RACES.length];
  const c = { id, name: 'C' + id, race, stats: Stats.rollCharacterStats(race, Math.random, stars), equipment: {}, mind: { traits: [] },
    temper: Temper.roll(), xp: {}, potions: [], injured: 0, mission: null, job: null, progress: 0, techniques: {}, lexicon: [], facets: [], facetState: {} };
  c.profs = Prof.rollAll(stars, race);
  c.affinity = Affinity.roll(); c.psiOrder = Psionic.rollAxisOrder();
  c.gifts = Gifts.roll(c.stats, race); Gifts.ensure(c, null);
  if (Gifts.has(c, 'arcana')) c.lexicon = Spellcraft.rollLexicon(stars);
  c.stats.base.cha = cha;
  Classes.assign(c, cls, { force: true });
  Condition.ensure(c);
  return c;
}
function makeTown(chars) {
  return { gems: 1000, crops: 0, ore: 100, herbs: 0, characters: chars, inventory: {}, log: [], mercy: {}, bonds: {},
    missions: { active: [], done: {}, history: [] }, nextId: 1, field: { board: [], rolledAt: 0 }, teams: [], trials: {} };
}
function newTown(n = 3, opts = {}) {
  const chars = Array.from({ length: n }, (_, i) => makeChar(i + 1, { cls: ['fighter', 'cleric', 'ranger', 'rogue'][i % 4], ...opts }));
  state = makeTown(chars);
  saved = null; saves = 0; lines.length = 0;
  return chars;
}
/** A contract the given party size may take, on a map of at most `maxFloors` floors. */
function contract(size, level = 1, maxFloors = Infinity) {
  for (let i = 0; i < 400; i++) {
    const m = MissionTypes.roll(Rng.pick(Object.keys(MissionTypes.TYPES)), { level });
    if (size >= m.party[0] && size <= m.party[1] && m.map.floors <= maxFloors) return m;
  }
  throw new Error('no contract for ' + size);
}
const reload = () => {               // what a page reload does: the module's run is gone, the state comes from the JSON
  Sortie.discard();
  state = JSON.parse(saved);
};
/** Step the field until the first fight opens (resolve() runs), or give up after `limit` seconds. */
function stepToContact(limit = 900) {
  const r = Sortie.run;
  for (let i = 0; i < limit && !r.contact && !r.field.result; i++) Field.step(r.field);
  return r.contact;
}
const fighterDamage = (r) => Object.fromEntries(r.field.actors.filter(a => a.role === 'squad').map(a => [a.char.id, a.fighter.base.damage]));

// ---------- 1. a team's bonus survives persist and resume ----------
scenario('persist keeps team', () => {
  const chars = newTown(3);
  const team = Crew.create(state, 'Test Team', chars.map(c => c.id));
  team.runs = 12;
  const co = Crew.cohesion(state, team);
  check(co.bonus > 0.005, `setup: team bonus ${co.bonus} should be above the 0.005 line launch() prints`);
  Sortie.__useTeam(team.id);
  const r = Sortie.launch(contract(3), chars.map(c => c.id));
  check(typeof r === 'object' && Sortie.run === r, 'launch as a team returns the run');
  check(r.teamId === team.id && r.teamName === 'Test Team' && Math.abs(r.bonus - co.bonus) < 1e-9, 'run carries teamId, teamName and bonus from launch');
  const plain = Object.fromEntries(r.field.actors.filter(a => a.role === 'squad').map(a => [a.char.id, a.fighter.base.damage / (1 + r.bonus)]));
  const before = fighterDamage(r);

  Sortie.persist(true);
  const run = JSON.parse(saved).field.run;
  check(run.teamId === team.id && run.teamName === 'Test Team' && Math.abs(run.bonus - co.bonus) < 1e-9, 'persist() writes teamId, teamName and bonus');
  check(run.trialPaid === null && run.contact === false, 'persist() writes trialPaid and contact');

  reload();
  check(Sortie.resume() === true, 'resume() picks the run up');
  const r2 = Sortie.run;
  check(r2.teamId === team.id && r2.teamName === 'Test Team' && Math.abs(r2.bonus - co.bonus) < 1e-9, 'resumed run keeps teamId, teamName and bonus');
  const after = fighterDamage(r2);
  for (const id of Object.keys(before)) {
    check(Math.abs(after[id] - before[id]) < 1e-9, `fighter ${id} damage after reload ${after[id]} equals before ${before[id]}`);
    check(after[id] > plain[id], `fighter ${id} damage after reload carries the team bonus`);
  }

  // settle() credits the team only when run.teamId is set. The party may die in the fight and
  // Crew.mourn then scales the count down, so the call is recorded rather than the count read.
  const credited = [], completed = Crew.completed;
  Crew.completed = (...a) => { credited.push(a[1]); return completed(...a); };
  try { Sortie.skip(); } finally { Crew.completed = completed; }
  check(!!Sortie.run.field.result, 'the resumed run plays to a result');
  check(credited.length === 1 && credited[0] === team.id, `settle() credits the team once (${credited.length} calls)`);
});

// ---------- 2. a launch that cannot build a fighter changes nothing ----------
scenario('launch with a throwing fighter', () => {
  const chars = newTown(3);
  const ids = chars.map(c => c.id);
  const mission = contract(3);
  throwFor(3);                                       // the last member: earlier members have already built
  const log0 = lines.length, saves0 = saves, gems0 = state.gems;
  const r = Sortie.launch(mission, ids);
  check(typeof r === 'string' && /C3 cannot be prepared: boom/.test(r), `launch returns the problem string (${r})`);
  check(chars.every(c => c.mission === null), 'nobody is flagged as out');
  check(Sortie.run === null, 'no run is left behind');
  check(liveTimers.size === 0, 'no timer is running');
  check(lines.length === log0 && saves === saves0 && state.gems === gems0, 'no log line, save or payout');
  check(!(state.field && state.field.run), 'nothing is persisted');
  Missions.prepare = realPrepare;
  const ok = Sortie.launch(mission, ids);
  check(typeof ok === 'object' && chars.every(c => c.mission === ok.id), 'the same party launches once the fault is gone');
});

scenario('trial launch with a throwing fighter keeps the fee', () => {
  const [owner] = newTown(1, { stars: 1 });
  state.ore = 100;
  const offer = Quests.offer(state, owner);
  throwFor(owner.id);
  const r = Sortie.launch(offer.solo, [owner.id]);
  check(typeof r === 'string' && /cannot be prepared/.test(r), `trial launch returns the problem string (${r})`);
  check(state.ore === 100, `the fee is not taken (ore ${state.ore})`);
  check(owner.mission === null && Sortie.run === null, 'owner is not flagged and no run exists');
  check(!lines.some(l => /sets out on/.test(l)), 'no "sets out on" line is logged');
});

scenario('launch keeps a run that was live before a failed launch', () => {
  const chars = newTown(2);
  const first = Sortie.launch(contract(1), [1]);
  check(typeof first === 'object', 'first launch');
  throwFor(2);
  const r = Sortie.launch(contract(1), [2]);
  check(typeof r === 'string', 'second launch fails');
  check(Sortie.run === first && chars[0].mission === first.id && chars[1].mission === null, 'the live run is untouched');
});

// ---------- 3. a trial fee comes back when the trial is called off before the first fight ----------
scenario('trial fee refunded before contact', () => {
  const [owner] = newTown(1, { stars: 1 });
  state.ore = 100;
  const offer = Quests.offer(state, owner);
  const r = Sortie.launch(offer.solo, [owner.id]);
  check(typeof r === 'object', `trial launches (${r})`);
  check(state.ore === 80 && r.trialPaid && r.trialPaid.ore === 20, `fee taken once (ore ${state.ore})`);
  check(owner.mission === r.id, 'owner is flagged as out');
  Sortie.abandon();
  check(state.ore === 100, `fee returned on abandon before contact (ore ${state.ore})`);
  check(lines.some(l => /called off.*returned/.test(l)), 'the refund is logged');
  check(owner.mission === null && Sortie.run === null, 'owner is free and the run is gone');
  const again = Sortie.launch(Quests.offer(state, owner).solo, [owner.id]);
  check(typeof again === 'object' && state.ore === 80, `relaunch pays once (ore ${state.ore})`);
});

scenario('trial fee kept after contact', () => {
  const [owner] = newTown(1, { stars: 1 });
  state.ore = 100;
  const r = Sortie.launch(Quests.offer(state, owner).solo, [owner.id]);
  check(typeof r === 'object' && state.ore === 80, 'trial launches');
  check(stepToContact() === true, 'the field reaches a first fight');
  Sortie.abandon();
  check(state.ore === 80, `fee stays spent after contact (ore ${state.ore})`);
  check(!lines.some(l => /returned/.test(l)), 'no refund line');
});

scenario('contact survives a reload', () => {
  const [owner] = newTown(1, { stars: 1 });
  state.ore = 100;
  const r = Sortie.launch(Quests.offer(state, owner).solo, [owner.id]);
  check(typeof r === 'object', 'trial launches');
  check(stepToContact() === true, 'the field reaches a first fight');
  Sortie.persist(true);
  const orePaid = state.ore;
  reload();
  check(Sortie.resume() === true && Sortie.run.contact === true && Sortie.run.trialPaid.ore === 20, 'resumed run keeps contact and trialPaid');
  Sortie.abandon();
  check(state.ore === orePaid, `no refund after a reload either (ore ${state.ore})`);
});

scenario('trial fee refunded after a reload before contact', () => {
  const [owner] = newTown(1, { stars: 1 });
  state.ore = 100;
  Sortie.launch(Quests.offer(state, owner).solo, [owner.id]);
  Sortie.persist(true);
  reload();
  check(Sortie.resume() === true, 'resume');
  Sortie.abandon();
  check(state.ore === 100, `refund works on a resumed run (ore ${state.ore})`);
});

scenario('contract abandon pays nothing back', () => {
  const chars = newTown(2);
  const gems = state.gems;
  Sortie.launch(contract(2), chars.map(c => c.id));
  Sortie.abandon();
  check(state.gems === gems && !lines.some(l => /returned/.test(l)), 'a contract has no fee to return');
});

// ---------- 3b. calling a run off does not undo a death ----------
// field.js marks a squad actor !alive when a fight's playback ends, and the run goes on. A member
// that is dead there must be retired the way settle() retires them, not freed with the rest.
const fallenList = () => (state.roster && state.roster.fallen) || [];
const squadOf = (r) => r.field.actors.filter(a => a.role === 'squad');
const kill = (a) => { a.alive = false; a.hp = 0; };

scenario('abandon retires a member who is dead on the map', () => {
  const chars = newTown(4);
  const r = Sortie.launch(contract(4), chars.map(c => c.id));
  check(typeof r === 'object', `launch (${r})`);
  const [v1, v2] = squadOf(r);
  kill(v1); kill(v2);
  const gone = [v1.char.id, v2.char.id], kept = chars.filter(c => !gone.includes(c.id));
  // Roster.fallAll applies grief through Condition.adjustMorale. `friend` has a bond of 40 with v1 and
  // `other` has none. They get the same temper, so the call-off debrief moves both morales by the same
  // amount and the difference between them is the grief: Bonds.GRIEF x 40 = 22.
  const [friend, other] = kept;
  other.temper = JSON.parse(JSON.stringify(friend.temper));
  Bonds.pair(state, v1.char, friend).v = 40;
  const hit = Bonds.grief(state, v1.char, [friend])[0].hit;
  check(Math.round(hit) === 22, `setup: a bond of 40 costs ${hit} morale`);
  Sortie.abandon();
  check(gone.every(id => !state.characters.some(c => c.id === id)), 'the dead are off the roster');
  check(fallenList().length === 2 && gone.every(id => fallenList().some(f => f.id === id)), `both are on the memorial (${fallenList().length})`);
  check(fallenList().every(f => f.cause === r.mission.name), 'the cause is the contract');
  check(kept.length === 2 && kept.every(c => state.characters.includes(c) && c.mission === null), 'the other two are home and free');
  check(lines.filter(l => /did not come back from/.test(l)).length === 1, 'one "did not come back" line');
  check(lines.some(l => /called off/.test(l)), 'the call-off is logged');
  check(Math.abs(Condition.morale(other) - Condition.morale(friend) - hit) < 1e-9, `the friend of the dead member lost ${hit} morale more than the other survivor (${Condition.morale(friend)} against ${Condition.morale(other)})`);
  check(lines.some(l => l.endsWith(`${friend.name} lost ${v1.char.name} (friends): morale -22`)), 'the grief is logged');
  check(Sortie.run === null && liveTimers.size === 0, 'the run is gone and the timer stopped');
  check(!(state.field && state.field.run), 'nothing is left persisted');
});

scenario('abandon with nobody dead retires nobody', () => {
  const chars = newTown(3);
  Sortie.launch(contract(3), chars.map(c => c.id));
  Sortie.abandon();
  check(state.characters.length === 3 && chars.every(c => c.mission === null), 'all three are home and free');
  check(fallenList().length === 0 && !lines.some(l => /did not come back|: morale -/.test(l)), 'no memorial entry, no death line, no grief line');
});

scenario('abandon while a fight is still playing back', () => {
  // A fight is decided when it opens (combat.js) and its dead are listed in `sk.dead`; field.js
  // marks them !alive when the playback ends. Calling the run off in between has to count them.
  let r = null, sk = null, victim = null, friend = null;
  for (let tries = 0; tries < 30 && !victim; tries++) {
    Sortie.discard();
    const chars = newTown(3);
    r = Sortie.launch(contract(3), chars.map(c => c.id));
    if (typeof r !== 'object' || !stepToContact()) continue;
    sk = r.field.skirmishes.find(x => x.ours.some(a => a.role === 'squad' && a.alive && !x.dead.includes(a)));
    victim = sk && sk.ours.find(a => a.role === 'squad' && a.alive && !sk.dead.includes(a));
    // a survivor for the victim to be mourned by: alive, and in no fight's list of dead
    friend = victim && squadOf(r).find(a => a !== victim && a.alive && !r.field.skirmishes.some(x => x.dead.includes(a)));
    if (!friend) victim = null;
  }
  check(!!victim, 'setup: a run with a fight in progress');
  sk.dead.push(victim);                               // what combat.js reports for a member it killed
  check(victim.alive === true, 'setup: the death has not landed yet');
  Bonds.pair(state, victim.char, friend.char).v = 40;
  const id = victim.char.id;
  Sortie.abandon();
  check(!state.characters.some(c => c.id === id) && fallenList().some(f => f.id === id), 'the member the fight killed is retired');
  check(lines.some(l => l.endsWith(`${friend.char.name} lost ${victim.char.name} (friends): morale -22`)), 'and mourned');
});

scenario('abandon after a reload retires a member who was dead when it saved', () => {
  const chars = newTown(3);
  const r = Sortie.launch(contract(3), chars.map(c => c.id));
  const victim = squadOf(r)[0];
  kill(victim);
  Sortie.persist(true);
  reload();
  check(Sortie.resume() === true, 'resume');
  const back = Sortie.run.field.actors.find(a => a.char && a.char.id === victim.char.id);
  check(back && back.alive === false, 'the resumed actor is still dead');
  Sortie.abandon();
  check(!state.characters.some(c => c.id === victim.char.id) && fallenList().some(f => f.id === victim.char.id), 'the member is retired');
  check(state.characters.length === 2 && state.characters.every(c => c.mission === null), 'the other two are home and free');
});

scenario('abandon retires a dead trial owner and keeps the fee', () => {
  const [owner] = newTown(1, { stars: 1 });
  state.ore = 100;
  const r = Sortie.launch(Quests.offer(state, owner).solo, [owner.id]);
  check(typeof r === 'object' && state.ore === 80, 'trial launches');
  kill(squadOf(r)[0]);
  Sortie.abandon();
  check(state.ore === 80 && !lines.some(l => /returned/.test(l)), `no refund for a trial that has cost a life (ore ${state.ore})`);
  check(state.characters.length === 0 && fallenList().length === 1, 'the owner is retired');
});

scenario('abandon scales a team down when one of its members is dead', () => {
  const chars = newTown(3);
  const team = Crew.create(state, 'Test Team', chars.map(c => c.id));
  team.runs = 12;
  Sortie.__useTeam(team.id);
  const r = Sortie.launch(contract(3), chars.map(c => c.id));
  check(typeof r === 'object' && r.teamId === team.id, 'launched as the team');
  const victim = squadOf(r)[0];
  kill(victim);
  Sortie.abandon();
  check(team.members.length === 2 && !team.members.includes(victim.char.id), 'the team no longer lists the dead member');
  check(team.runs < 12, `its run count is scaled down (${team.runs})`);
  check(lines.some(l => /is down to 2/.test(l)), 'the loss is logged');
  Sortie.__useTeam(null);
});

scenario('settle retires the dead once', () => {
  const chars = newTown(3);
  // One floor: field.js descend() carries only the living actors to the next floor, so a member
  // marked dead at launch and then walked down the stairs has no actor for release() to find.
  const r = Sortie.launch(contract(3, 1, 1), chars.map(c => c.id));
  const victim = squadOf(r)[0];
  kill(victim);
  Sortie.skip();                                     // plays the rest of the run and settles it
  check(!!r.field.result, 'the run reaches a result');
  check(!state.characters.some(c => c.id === victim.char.id), 'the member who was dead at settle is off the roster');
  check(fallenList().filter(f => f.id === victim.char.id).length === 1, 'and appears on the memorial once');
  check(lines.filter(l => /did not come back from/.test(l)).length === 1, 'one "did not come back" line');
  check(state.characters.every(c => c.mission === null), 'everyone left is free');
});

// ---------- 4. a save from before these fields existed still resumes ----------
scenario('resume of an old save', () => {
  const chars = newTown(2);
  Sortie.launch(contract(2), chars.map(c => c.id));
  Sortie.persist(true);
  const old = JSON.parse(saved);
  for (const k of ['teamId', 'teamName', 'bonus', 'trialPaid', 'contact']) delete old.field.run[k];
  saved = JSON.stringify(old);
  reload();
  check(Sortie.resume() === true, 'old-format run resumes');
  Sortie.abandon();
  check(state.characters.every(c => c.mission === null), 'and can be called off');
});

// ---------- 5. a resume that throws leaves nobody flagged ----------
scenario('resume that throws', () => {
  const chars = newTown(2);
  Sortie.launch(contract(2), chars.map(c => c.id));
  Sortie.persist(true);
  reload();
  state.characters.forEach(c => { c.mission = null; });    // load() clears flags for runs it cannot find
  throwFor(2);
  let threw = false;
  try { Sortie.resume(); } catch (e) { threw = true; }
  check(threw, 'resume() throws when a fighter cannot be rebuilt');
  check(state.characters.every(c => c.mission === null), 'nobody is flagged as out after the failed resume');
  Sortie.discard();                                        // what boot() does in its catch
  check(Sortie.run === null && !(state.field && state.field.run) && liveTimers.size === 0, 'discard() leaves no run, no saved run and no timer');
});

// ---------- 6. discard stops the run without settling it ----------
scenario('discard', () => {
  const chars = newTown(2);
  const gems = state.gems, fallen = (state.roster && state.roster.fallen || []).length;
  const r = Sortie.launch(contract(2), chars.map(c => c.id));
  check(typeof r === 'object' && liveTimers.size === 1, 'launch starts one timer');
  Sortie.persist(true);
  check(!!state.field.run, 'the run is saved');
  const log0 = lines.length;
  Sortie.discard();
  check(Sortie.run === null, 'run is null');
  check(liveTimers.size === 0, 'timer is stopped');
  check(!state.field.run, 'saved run is forgotten');
  check(state.gems === gems && state.characters.length === 2 && ((state.roster && state.roster.fallen) || []).length === fallen, 'no payout, no deaths');
  check(lines.length === log0, 'nothing is logged: the run is not settled');
  Sortie.discard();
  check(Sortie.run === null, 'discard() with no run is a no-op');
});

// ---------- 7. Reset ----------
scenario('reset handler', () => {
  const chars = newTown(2);
  Sortie.launch(contract(2), chars.map(c => c.id));
  // the handler body, in the order game.js has it: discard first, then replace the state
  const old = state;
  Sortie.discard();
  state = makeTown([]);
  check(Sortie.run === null && liveTimers.size === 0, 'after Reset no run is live and no timer is running');
  check(!old.field.run, 'the old state holds no saved run');
  const game = fs.readFileSync(file('game.js'), 'utf8');
  const at = game.indexOf("arm($('#reset')");
  const block = game.slice(at, game.indexOf('}, 6000);', at));
  check(at > 0 && block.includes('Sortie.discard()'), 'game.js Reset handler calls Sortie.discard()');
  check(block.indexOf('Sortie.discard()') < block.indexOf('state = newState()'), 'Sortie.discard() comes before state is replaced');
});

// ---------- 8. Missions.launch (the gate) ----------
scenario('Missions.launch with a member that cannot be prepared', () => {
  const chars = newTown(3);
  chars[2].profs = null;                                   // prepare reads the aptitudes: it throws for this member
  const nextId = state.nextId, ids = chars.map(c => c.id);
  const r = Missions.launch(state, 'forest_edge', ids);
  check(typeof r === 'string' && /C3 cannot be prepared/.test(r), `returns the problem string (${r})`);
  check(chars.every(c => c.mission === null), 'nobody is flagged as out');
  check(state.nextId === nextId && state.missions.active.length === 0, 'nextId is not spent and no run is queued');
  chars[2].profs = Prof.rollAll(3, chars[2].race);
  const ok = Missions.launch(state, 'forest_edge', ids);
  check(typeof ok === 'object' && chars.every(c => c.mission === ok.id) && state.missions.active.length === 1, 'the same party launches once the fault is gone');
  check(ok.log.length === 3 && ok.members[1] && ok.members[3], 'the run record is as before: one log line and one member entry each');
});

console.log(`${checks} checks, ${failed ? failed + ' failed' : 'all passed'}`);
process.exit(failed ? 1 : 0);
