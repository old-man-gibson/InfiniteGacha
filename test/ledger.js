// Sortie ledger. `node test/ledger.js`; exit code 1 on any failure.
//
// Part A loads the modules in Node:
//   Combat           damage() passes the source of a killing blow to onDeath; encounter() returns `falls`
//   Bestiary         record() copies the falls, merges the caller's facts and numbers the fight by run.fights;
//                    nameOf() and causeOf() read the town's knowledge of a species
//   Roster.fallAll   `cause` may be a function of the character
//   Gate death cause Missions.finish gives '<mission>: <killer>' for a fall in a fight and the mission name alone for a death no fight block holds
// Part B boots game.html through test/game.boot.js and plays real contracts through Sortie:
//   death cause      a fall in combat gives '<mission>: <killer>'; a death with no fall row gives the mission name
//   the cap          history keeps the last 8 reports, newest first, and the per-type counts keep every sortie
//   save round trip  history and counts come back from a saved game, and the board card prints the counts
//   old save         a save without either key loads, renders and records
//   resume           the fight blocks survive a reload and the numbering carries on
//   call-off         after contact it is a report and a sortie not won; before contact it is neither
//   size             the stored size of each report and of a 60-character save, measured

'use strict';
const path = require('path');
const root = path.join(__dirname, '..');
const { boot, mulberry } = require('./game.boot.js');

global.window = global;
for (const m of ['rng', 'mercy', 'roster', 'stats', 'proficiency', 'economy', 'affinity', 'classes', 'condition', 'temper', 'bonds', 'crew',
  'ai', 'gifts', 'elements', 'spellcraft', 'psionic', 'martial', 'prowess', 'consume', 'combat', 'bestiary', 'missions', 'sacrifice']) require(path.join(root, m + '.js'));

let failed = 0, checks = 0;
const check = (cond, msg) => { checks++; if (!cond) { failed++; console.log('FAIL ' + msg); } };
const scenario = (name, fn) => {
  try { fn(); } catch (e) { failed++; console.log(`FAIL ${name}: threw ${e && e.stack}`); }
};
const ascenario = async (name, fn) => {
  try { await fn(); } catch (e) { failed++; console.log(`FAIL ${name}: threw ${e && e.stack}`); }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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
const zone = (level, species) => ({ id: 'ledger-test', name: 'Ledger Test', icon: '', level, encounters: [[species]] });
const fighterOf = (c, level, species) => Combat.fromCharacter(c, Missions.prepare(c, zone(level, species)), {});

scenario('combat reports the source of a fall', () => {
  const calls = [];
  const cctx = { log() {}, onDeath: (t, killer, source) => calls.push({ name: t.name, killer: killer && killer.name, source }) };
  const hero = fighterOf(makeChar(1), 12, 'death_knight'), hero2 = fighterOf(makeChar(2), 12, 'death_knight');
  const foe = Missions.spawn('death_knight', 12, {});
  Combat.damage(cctx, hero, 1e6, 'slashing', 'swing', foe);
  Combat.damage(cctx, hero2, 1e6, 'poison', 'conditions');
  check(calls.length === 2 && calls[0].killer === foe.name && calls[0].source === 'swing', `a blow passes its attacker and its source (${JSON.stringify(calls[0])})`);
  check(calls[1].killer === undefined && calls[1].source === 'conditions', `a condition passes no attacker and its source (${JSON.stringify(calls[1])})`);
});

scenario('encounter returns the falls', () => {
  const c = makeChar(3);
  const hero = fighterOf(c, 12, 'death_knight'), foe = Missions.spawn('death_knight', 12, {});
  const res = Rng.withSource(mulberry(5), () => Combat.encounter([hero], [foe]));
  check(!res.won && res.kills.length === 0 && res.falls.length === 1, `one fall, no kill (${JSON.stringify(res.falls)})`);
  const f = res.falls[0];
  check(f.id === c.id && f.name === hero.name && f.by === foe.name && f.byId === 'death_knight' && typeof f.source === 'string' && f.source.length > 0, `the row names the character, the killer, its species and the source (${JSON.stringify(f)})`);
  const strong = fighterOf(makeChar(4, { stars: 5 }), 1, 'forest_rat');
  strong.hp = strong.maxHp = 1e6;
  const won = Rng.withSource(mulberry(6), () => Combat.encounter([strong], [Missions.spawn('forest_rat', 1, {})]));
  check(won.won && Array.isArray(won.falls) && won.falls.length === 0, 'a fight nobody of ours dies in has an empty list');
});

scenario('Bestiary.record keeps the falls and the caller\'s facts', () => {
  const c = makeChar(5);
  const hero = fighterOf(c, 12, 'death_knight'), foe = Missions.spawn('death_knight', 12, {});
  const res = Rng.withSource(mulberry(5), () => Combat.encounter([hero], [foe]));
  const state = {};
  const run = { fights: 7, encounters: [] };
  Bestiary.record(state, run, [foe], [hero], res, 12, { width: 3, startHp: 88 });
  const blk = run.encounters[0];
  check(blk.n === 7, `the block is numbered by run.fights (${blk.n})`);
  check(blk.width === 3 && blk.startHp === 88, 'the caller\'s facts are on the block');
  check(same(blk.falls, res.falls) && blk.falls[0] !== res.falls[0], 'the falls are a copy of the result\'s');
  const plain = { encounters: [{ n: 1 }] };
  Bestiary.record(state, plain, [foe], [hero], res, 12);
  check(plain.encounters[1].n === 2 && plain.encounters[1].width === undefined, 'with no run.fights the block is numbered by position, with no extra facts');
});

scenario('Bestiary.nameOf and causeOf', () => {
  const state = {};
  const run = { encounters: [{ falls: [{ id: 1, name: 'Ann', by: 'Goblin', byId: 'goblin', source: 'swing' }] }, { falls: [{ id: 2, name: 'Bo', by: null, byId: null, source: 'conditions' }] }] };
  check(Bestiary.nameOf(state, 'goblin', 'Goblin') === '???', 'a species nobody has seen is masked');
  check(Bestiary.causeOf(state, run, 1, 'Cave') === 'Cave', 'an unseen killer is not named in the cause');
  Bestiary.sight(state, { id: 'goblin' }, 1);
  check(Bestiary.nameOf(state, 'goblin', 'Goblin') === 'Goblin', 'once seen, the name shows');
  check(Bestiary.causeOf(state, run, 1, 'Cave') === 'Cave: Goblin', `the killer is named after one sighting (${Bestiary.causeOf(state, run, 1, 'Cave')})`);
  check(Bestiary.causeOf(state, run, 2, 'Cave') === 'Cave', 'a fall with no attacker gives the mission name alone');
  check(Bestiary.causeOf(state, run, 9, 'Cave') === 'Cave' && Bestiary.causeOf(state, {}, 1, 'Cave') === 'Cave', 'no block holds the fall: the mission name alone');
  const twice = { encounters: [{ falls: [{ id: 1, by: 'Wolf', byId: 'wolf' }] }, { falls: [{ id: 1, by: 'Goblin', byId: 'goblin' }] }] };
  Bestiary.sight(state, { id: 'wolf' }, 1);
  check(Bestiary.causeOf(state, twice, 1, 'Cave') === 'Cave: Goblin', 'the latest block that holds the fall wins');
  check(Bestiary.causeOf(state, { encounters: [{ falls: [{ id: 1, by: 'Ann', byId: null }] }] }, 1, 'Cave') === 'Cave: Ann', 'a killer with no species is named as carried');
});

scenario('Roster.fallAll takes a cause per character', () => {
  const [a, b, c] = [11, 12, 13].map(i => makeChar(i));
  const state = makeTown([a, b, c]);
  const recs = Roster.fallAll(state, [a, b], { cause: (x) => (x.id === a.id ? 'Pit: Troll' : ''), log: () => {} });
  check(recs[0].cause === 'Pit: Troll' && recs[1].cause === 'a mission', `a function gives each its own text, '' falls back (${recs.map(r => r.cause)})`);
  const rec = Roster.fall(state, c, { cause: 'Pit', log: () => {} });
  check(rec.cause === 'Pit', 'a plain string still works');
});

scenario('Gate death cause', () => {
  // 3-star fighters against the level-16 keep: a fall in a fight is certain within the first encounters.
  // A third member is flagged dead before the run starts, so no fight block holds that fall.
  const chars = [51, 52, 53].map(i => makeChar(i, { stars: 3 }));
  const state = makeTown(chars);
  const mission = Missions.MISSION.black_keep;
  Rng.withSource(mulberry(9), () => {
    const run = Missions.launch(state, 'black_keep', chars.map(c => c.id));
    check(typeof run === 'object', `Gate launch (${run})`);
    const quiet = chars[2];
    run.members[quiet.id].alive = false; run.members[quiet.id].hp = 0;
    let finished = null;
    for (let i = 0; i < 100 && !finished; i++) finished = Missions.tick(state).find(r => r === run) || null;
    check(!!finished, 'the Gate run finishes');
    const falls = run.encounters.flatMap(e => e.falls || []);
    check(falls.length >= 1 && falls.every(f => f.by && f.byId), `setup: a fall in a fight names its killer (${JSON.stringify(falls.map(f => f.by))})`);
    for (const f of falls) {
      const rec = Roster.fallen(state).find(x => x.id === f.id);
      check(rec && rec.cause === `${mission.name}: ${f.by}`, `${f.name}: the memorial cause is '<mission>: <killer>' (${rec && rec.cause})`);
    }
    const rec = Roster.fallen(state).find(x => x.id === quiet.id);
    check(rec && rec.cause === mission.name, `a member no fight block holds gets the mission name alone (${rec && rec.cause})`);
  });
});

// ---------- Part B: the booted page ----------

/** Helpers over one booted page: contracts, squads, one sortie, and the text of the page. */
function drive(b, st, S, ctx) {
  const MT = ctx.MissionTypes;
  // The board is rolled from the cryptographic generator, so a contract is made under the seed to repeat.
  const contract = (type, level, seed = 1) => {
    const roll = MT.roll;
    MT.roll = (t, o) => roll.call(MT, type, Object.assign({}, o, { level }));
    try { return b.withSeed(seed, () => S.board(st, true)[0]); } finally { MT.roll = roll; }
  };
  const free = (n) => st.characters.filter(c => !c.mission && !(c.injured > 0)).slice(0, n);
  const sortie = (seed, type, level, n) => {
    b.advance(1000);                          // the virtual clock does not move on its own, and a run's id is its start time
    const mission = contract(type, level, seed);
    const chars = free(Math.min(n, mission.party[1]));
    let run = null;
    b.withSeed(seed, () => { run = S.launch(mission, chars.map(c => c.id)); if (typeof run === 'string') throw new Error(run); S.skip(); });
    return { mission, chars, run };
  };
  const html = (el) => { const out = []; const walk = (e) => { if (e && e._html) out.push(e._html); if (e && e._text) out.push(e._text); if (e && e._kids) e._kids.forEach(walk); }; walk(el); return out; };
  return { contract, free, sortie, html };
}

async function partB() {
  const { setup } = require('./sortie.harness.js');
  const lab = await setup({ poolSize: 12 });
  if (lab.bootFailed || lab.failed) { failed++; console.log('FAIL part B: ' + (lab.failed || 'the page did not boot')); if (lab.b) lab.b.dispose(); return; }
  const { b, ctx, st, S } = lab;
  const d = drive(b, st, S, ctx);
  const fresh = () => { S.discard(); lab.restore(); };
  /** lab.restore() replaces the town; this puts the ledger back so a chain of sorties accumulates. */
  const restoreKeeping = () => {
    const keep = JSON.parse(JSON.stringify({ history: st.field.history || [], types: st.field.types || {} }));
    fresh();
    st.field.history = keep.history; st.field.types = keep.types;
  };
  const fallsOf = (rec) => rec.encounters.flatMap(e => e.falls || []);

  await ascenario('death cause from combat', async () => {
    let found = null;
    for (let seed = 1; seed <= 10 && !found; seed++) {
      fresh();
      const r = d.sortie(seed, 'assassination', 5, 4);
      const rec = st.field.history[0];
      if (rec && fallsOf(rec).length) found = { ...r, rec, seed };
    }
    check(!!found, 'setup: a sortie with a fall in combat was found');
    if (!found) return;
    const { mission, rec } = found;
    const falls = fallsOf(rec);
    const f = falls[0];
    const mem = st.roster.fallen.find(x => x.id === f.id);
    check(!!f.by && f.byId && f.source, `the fall row has a killer, a species and a source (${JSON.stringify(f)})`);
    check(mem && mem.cause === `${mission.name}: ${f.by}`, `the memorial cause is '<mission>: <killer>' (${mem && mem.cause})`);
    check(falls.every(x => { const m = st.roster.fallen.find(y => y.id === x.id); return m && m.cause.startsWith(mission.name) && (!x.by || m.cause === `${mission.name}: ${x.by}`); }), 'every fall in the report has the cause its own row gives');
    check(rec.lost.length >= falls.length && falls.every(x => rec.lost.includes(x.name)), `the report lists who was lost (${rec.lost.length} lost, ${falls.length} falls)`);
    const withFall = rec.encounters.filter(e => e.falls && e.falls.length);
    check(withFall.every(e => e.log.length > 0) && rec.encounters.filter(e => !(e.falls && e.falls.length)).every(e => e.log.length === 0), 'the blow-by-blow log is kept for the fights with a fall and for no other');
    check(rec.encounters.every(e => typeof e.startHp === 'number' && e.startHp >= 0 && e.startHp <= 100 && (e.width === null || typeof e.width === 'number')), 'each block has the squad HP at its start and the ground width');
    check(rec.won === found.run.field.result.won && rec.result === found.run.field.result.why && rec.type === 'assassination' && rec.level === 5 && rec.icon === mission.icon && rec.mission === mission.name, 'the record names the mission, its type and level, and the result');
    check(rec.party.length === found.chars.length && rec.party.every(p => p.id && p.name), 'the record lists the squad with ids and names, the dead included');
    S.discard();                               // a finished run is drawn instead of the board until it is closed
    S.render();
    check(d.html(b.el('#sortie')).some(h => h.includes(`${mission.name}: ${f.by}`)), 'the memorial card shows the cause');
  });

  await ascenario('a death with no fall row', async () => {
    fresh();
    const mission = d.contract('extermination', 3, 13);
    const chars = d.free(Math.min(4, mission.party[1]));
    const victim = chars[0];
    b.withSeed(13, () => {
      const run = S.launch(mission, chars.map(c => c.id));
      const a = run.field.actors.find(x => x.char && x.char.id === victim.id);
      a.alive = false; a.hp = 0;               // dead on the map without any fight having recorded it
      S.skip();
    });
    const rec = st.field.history[0];
    const mem = st.roster.fallen.find(x => x.id === victim.id);
    check(!fallsOf(rec).some(f => f.id === victim.id), 'setup: no fight block holds this fall');
    check(mem && mem.cause === mission.name, `the cause is the mission name alone (${mem && mem.cause})`);
  });

  await ascenario('the cap and the counts', async () => {
    fresh();
    const sizes = [];
    for (let i = 0; i < 11; i++) {
      d.sortie(40 + i, 'extermination', 2, 3);
      sizes.push(JSON.stringify(st.field.history[0]).length);
      restoreKeeping();
    }
    const h = st.field.history, t = st.field.types.extermination;
    check(h.length === 8, `history keeps 8 of 11 reports (${h.length})`);
    check(new Set(h.map(r => r.id)).size === 8, 'no report is kept twice');
    check(h.every((r, i) => i === 0 || r.at < h[i - 1].at), 'newest first');
    check(t && t.sent === 11, `the type counts every sortie, not only the kept ones (${JSON.stringify(t)})`);
    check(t.won <= t.sent && t.dead >= 0 && Number.isInteger(t.won) && Number.isInteger(t.dead), `counts are whole numbers (${JSON.stringify(t)})`);
    check(Object.keys(st.field.types).length === 1, 'only the type that was sent has a row');
    const mean = Math.round(sizes.reduce((a, n) => a + n, 0) / sizes.length), max = Math.max(...sizes);
    console.log(`  report size over ${sizes.length} level-2 sorties: mean ${mean} bytes, max ${max} bytes`);
    check(max < 60000, `a report stays under 60000 bytes (${max})`);
  });

  await ascenario('wins and losses are counted by the result', async () => {
    fresh();
    let won = 0, lostN = 0;
    for (let i = 0; i < 6; i++) {
      d.sortie(60 + i, i % 2 ? 'escort' : 'assassination', 4, 3);
      if (st.field.history[0].won) won++; else lostN++;
      restoreKeeping();
    }
    const sum = Object.values(st.field.types).reduce((a, t) => ({ sent: a.sent + t.sent, won: a.won + t.won }), { sent: 0, won: 0 });
    check(sum.sent === 6 && sum.won === won, `sent ${sum.sent} and won ${sum.won} agree with the reports (${won} won, ${lostN} not)`);
    check(st.field.history.every(r => typeof r.won === 'boolean'), 'each report has a boolean result');
  });

  await ascenario('save round trip and the board line', async () => {
    fresh();
    for (let i = 0; i < 3; i++) { d.sortie(80 + i, 'extermination', 2, 3); restoreKeeping(); }
    d.contract('extermination', 2, 83);        // the board now offers the type that has a record
    ctx.Game.save();
    const b2 = await boot({ html: 'game.html', storage: new Map(b.localStorage.map) });
    try {
      const s2 = b2.Game.state;
      check(b2.errors.length === 0, `the second page booted cleanly (${b2.errors.length} errors)`);
      check(same(s2.field.history, st.field.history) && s2.field.history.length === 3, `history comes back as saved (${s2.field.history.length} reports)`);
      check(same(s2.field.types, st.field.types), `counts come back as saved (${JSON.stringify(s2.field.types)})`);
      b2.Sortie.render();
      const text = drive(b2, s2, b2.Sortie, b2.context).html(b2.el('#sortie')).join('\n');
      const t = s2.field.types.extermination;
      check(text.includes(`your record: ${t.sent} sent, ${t.won} won, ${t.sent - t.won} lost`), 'the board card prints the saved counts');
      check(text.includes('Sortie reports'), 'the reports box is drawn');
      check(!/your record: 0 sent/.test(text), 'a type that was never sent prints no line');
    } finally { b2.dispose(); }
  });

  await ascenario('a save from before the ledger', async () => {
    fresh();
    ctx.Game.save();
    const key = 'infinitegacha.save.v2';       // game.js SAVE_KEY
    const saved = JSON.parse(b.localStorage.map.get(key));
    delete saved.field.history; delete saved.field.types;
    const b2 = await boot({ html: 'game.html', storage: new Map([[key, JSON.stringify(saved)]]) });
    try {
      const s2 = b2.Game.state;
      check(saved.field.history === undefined && saved.field.types === undefined, 'setup: the stored save has neither key');
      check(b2.errors.length === 0, `the page loaded it (${b2.errors.length} errors)`);
      b2.Sortie.render();
      check(b2.errors.length === 0 && same(s2.field.history, []) && same(s2.field.types, {}), `the board renders and both default to empty (${JSON.stringify(s2.field.history)}, ${JSON.stringify(s2.field.types)})`);
      const d2 = drive(b2, s2, b2.Sortie, b2.context);
      const r = d2.sortie(90, 'extermination', 2, 3);
      check(r.run && s2.field.history.length === 1 && s2.field.types.extermination.sent === 1, 'the first sortie after the load makes the first report and count');
    } finally { b2.dispose(); }
  });

  await ascenario('Back to the board shows the newest report', async () => {
    fresh();
    let rec = null;
    for (let seed = 100; seed < 110 && !(rec && fallsOf(rec).length); seed++) { fresh(); d.sortie(seed, 'assassination', 5, 4); rec = st.field.history[0]; }
    S.render();                                // a finished run is drawn with its Back button
    b.click('#sortie-back');
    check(S.run === null, 'the run view is closed');
    const text = d.html(b.el('#sortie')).join('\n');
    check(text.includes('Sortie reports') && text.includes(rec.mission), 'the reports box is drawn with the newest report');
    if (fallsOf(rec).length) {
      const f = fallsOf(rec)[0];
      check(text.includes(`${f.name} fell in encounter`), 'the report lists the fall');
      check(!/because|caused|due to|the reason/.test(text.split('Falls')[1] || ''), 'the falls text states no cause');
    }
  });

  await ascenario('resume keeps the fight blocks', async () => {
    let done = false;
    for (let seed = 120; seed < 130 && !done; seed++) {
      fresh();
      const mission = d.contract('extermination', 3, seed);
      const chars = d.free(Math.min(4, mission.party[1]));
      let run = null;
      b.withSeed(seed, () => {
        run = S.launch(mission, chars.map(c => c.id));
        for (let i = 0; i < 12000 && !(run.fights >= 2) && !run.field.result; i++) ctx.Field.step(run.field);
      });
      if (!(run.fights >= 2) || run.field.result) continue;
      done = true;
      b.fire('window', 'beforeunload');
      const blocks = run.encounters.length;
      check(st.field.run && st.field.run.encounters.length === blocks, `persist() stores the fight blocks (${st.field.run && st.field.run.encounters.length} of ${blocks})`);
      const b2 = await boot({ html: 'game.html', storage: new Map(b.localStorage.map) });
      try {
        const run2 = b2.Sortie && b2.Sortie.run;
        check(!!run2 && run2.encounters.length === blocks && run2.fights === run.fights, `the resumed run has the blocks and the count (${run2 && run2.encounters.length}, ${run2 && run2.fights})`);
        if (run2) {
          b2.withSeed(seed + 1, () => b2.Sortie.skip());
          const rec = b2.Game.state.field.history[0];
          check(rec && rec.fights >= run.fights, `the report counts the fights from before and after the reload (${rec && rec.fights})`);
          const ns = rec.encounters.map(e => e.n);
          check(ns.every((n, i) => i === 0 || n > ns[i - 1]) && ns[ns.length - 1] === rec.fights, `the blocks are numbered in order up to the fight count (${ns.join(',')})`);
        }
      } finally { b2.dispose(); }
    }
    check(done, 'setup: a run with two fights was found to save');
  });

  await ascenario('call-off', async () => {
    fresh();
    const mission = d.contract('extermination', 3, 14);
    const chars = d.free(Math.min(4, mission.party[1]));
    b.withSeed(14, () => { S.launch(mission, chars.map(c => c.id)); S.abandon(); });
    check(st.field.history.length === 0 && !st.field.types.extermination, 'a call-off before the first fight leaves no report and no count');
    fresh();
    const m2 = d.contract('extermination', 3, 15);
    const c2 = d.free(Math.min(4, m2.party[1]));
    let fights = 0;
    b.withSeed(15, () => {
      const run = S.launch(m2, c2.map(c => c.id));
      for (let i = 0; i < 6000 && !run.contact && !run.field.result; i++) ctx.Field.step(run.field);
      fights = run.fights;
      S.abandon();
    });
    const rec = st.field.history[0];
    check(fights > 0 && rec && rec.result === 'called off' && rec.won === false && rec.fights === fights, `a call-off after contact is a report (${rec && rec.result}, ${fights} fights)`);
    check(rec && rec.loot.length === 0, 'it lists no loot, because nothing is paid');
    check(st.field.types.extermination.sent === 1 && st.field.types.extermination.won === 0, `and one sortie not won (${JSON.stringify(st.field.types)})`);
  });

  lab.b.dispose();

  // ---------- size: a 60-character save before and after eight reports ----------
  await ascenario('save size with 60 characters', async () => {
    const big = await setup({ poolSize: 60 });
    if (big.bootFailed || big.failed) { check(false, 'setup: 60 characters (' + (big.failed || 'boot') + ')'); if (big.b) big.b.dispose(); return; }
    try {
      const bd = drive(big.b, big.st, big.S, big.ctx);
      const stored = () => { big.ctx.Game.save(); return [...big.b.localStorage.map.values()].reduce((n, v) => n + v.length, 0); };
      big.S.discard(); big.restore();
      const before = { state: JSON.stringify(big.st).length, stored: stored() };
      const types = ['assassination', 'extermination', 'siege', 'dungeon', 'raid'];
      for (let i = 0; i < 10; i++) {
        bd.sortie(200 + i, types[i % 5], 3 + (i % 4), 4);
        const keep = JSON.parse(JSON.stringify({ history: big.st.field.history, types: big.st.field.types }));
        big.S.discard(); big.restore(); big.st.field.history = keep.history; big.st.field.types = keep.types;
      }
      const after = { state: JSON.stringify(big.st).length, stored: stored() };
      const sizes = big.st.field.history.map(r => JSON.stringify(r).length);
      const total = sizes.reduce((a, n) => a + n, 0);
      console.log(`  60 characters, ${big.st.field.history.length} reports kept of 10 sorties: report sizes ${sizes.join(' ')} bytes, mean ${Math.round(total / sizes.length)}, max ${Math.max(...sizes)}`);
      console.log(`  state JSON ${before.state} -> ${after.state} bytes (+${after.state - before.state}); localStorage, current save and undo copy together, ${before.stored} -> ${after.stored} bytes (+${after.stored - before.stored})`);
      check(big.st.field.history.length === 8, 'the history holds 8 reports');
      check(after.state - before.state >= total && after.state - before.state < total + 2000, `the state grows by the kept reports and the counts (+${after.state - before.state}, reports ${total})`);
      check(Math.max(...sizes) < 60000, `a report stays under 60000 bytes (${Math.max(...sizes)})`);
    } finally { big.b.dispose(); }
  });
}

(async () => {
  const a = checks;
  await partB();
  console.log(`part A ${a} checks, part B ${checks - a} checks`);
  console.log(`${checks} checks, ${failed ? failed + ' failed' : 'all passed'}`);
  process.exit(failed ? 1 : 0);
})();
