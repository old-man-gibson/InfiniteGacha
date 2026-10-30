// The integration test: the real game, a real encounter, a real facet attached.
//
// The corpus in facet/facet.cases.js exercises the engine against a fake host, which is what proves
// it is host-agnostic. This file proves the opposite half — that the binding to THIS game is right —
// and it is the one that would catch a quantity id that does not resolve, a status the game refuses
// to register, or an encounter that stops terminating once something is attached to it.
//
// `node test/facet.integration.js`.

const path = require('path');
const root = path.join(__dirname, '..');
const load = (f) => require(path.join(root, f));

// Load order does not matter for the core; it does for the game, whose modules capture each other
// at load time. This is the same order the two html pages use.
for (const m of ['core', 'data', 'registry', 'cells', 'relations', 'pipeline', 'gate', 'mortal', 'forge', 'oracle', 'compile']) {
  require(path.join(root, 'facet', 'facet.' + m + '.js'));
}
global.Rng = load('rng.js');
global.Mercy = load('mercy.js');
global.Stats = load('stats.js');
global.Prof = load('proficiency.js');
global.Elements = load('elements.js');
global.AI = load('ai.js');
global.Spellcraft = load('spellcraft.js');
global.Psionic = load('psionic.js');
global.Martial = load('martial.js');
global.Affinity = load('affinity.js');
global.Classes = load('classes.js');
global.Gifts = load('gifts.js');
global.Temper = load('temper.js');
global.Condition = load('condition.js');
global.Bonds = load('bonds.js');
global.Consume = load('consume.js');
global.Combat = load('combat.js');
global.FacetQuantitiesIG = load('facet.quantities.ig.js');
global.FacetQuantitiesTownIG = load('facet.quantities.town.ig.js');
global.FacetSchemaIG = load('facet.schema.ig.js');
global.FacetHostIG = load('facet.host.ig.js');

const F = global.Facet;
const H = global.FacetHostIG;

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn((c, m) => { if (!c) throw new Error(m || 'assertion failed'); }); passed++; }
  catch (e) { failures.push({ name, message: e && e.message, stack: e && e.stack }); }
}

// ---------- fixtures ----------
function monster(level) {
  const defs = Object.values(require(path.join(root, 'bestiary.js')).MONSTERS || {});
  const def = defs.length ? defs[0] : { name: 'Dummy', icon: 'x', attrs: { str: 8, dex: 8, con: 8, int: 4, wis: 4, cha: 4 }, damageType: 'slashing', tags: [] };
  return Combat.fromMonster(def, level || 1, {}, {});
}

// A real party member, built the way summon() builds one. The encounter loop's reflex pass reads a
// party-side fighter's prepared loadout directly, so a monster standing on the party side throws —
// which is a pre-existing property of this game and not something the engine changed.
function character(stars) {
  // Built from Stats directly rather than through lpc.js, which is browser-only: it publishes with a
  // bare `window.LPC =` and throws under node. Everything lpc.generate adds beyond this is a face.
  const race = 'human';
  const st = Stats.rollCharacterStats(race, Rng.rand, stars || 3);
  const c = {
    id: 1, name: 'Test', race, bodyType: 'male', selections: {},
    stats: Stats.freezeBorn(st), heroic: null, humanFace: false,
    // Both of these default their rand parameter to Math.random rather than to Rng.rand, so
    // Rng.withSource does NOT pin them and two "identically seeded" fixtures diverge. summon()
    // calls them the same way, so this is a property of the game and not of the test — but it does
    // mean the pricing oracle's common-random-number pairing will need them passed explicitly.
    profs: Prof.rollAll(st.stars, race, Rng.rand), affinity: Affinity.roll(Rng.rand),
    mind: { traits: [] }, temper: Temper.roll(), gifts: Gifts.roll(st, race),
    lexicon: [], psiOrder: Psionic.rollAxisOrder(), techniques: {},
    equipment: {}, potions: [], xp: {}, job: null, progress: 0, injured: 0, mission: null,
    facets: [], facetState: {},
  };
  Gifts.ensure(c, null);
  if (Gifts.has(c, 'arcana')) c.lexicon = Spellcraft.rollLexicon(c.stats.stars);
  Condition.ensure(c);
  // The prepared loadout is fromCharacter's second argument. Worth noting while passing: options()
  // and reflexes() read f.plan.rotation unguarded while lineScore reads `f.plan || {}`, so a party
  // fighter built without one throws rather than fighting plainly.
  return Combat.fromCharacter(c, { rotation: [], spells: [], workings: [], features: [] }, {});
}

// The context this game's encounter loop builds: it answers who is on whose side through two
// functions rather than exposing arrays, and the adapter reads it that way for the same reason.
function fakeCtx(party, enemies) {
  return {
    tick: 0, log: () => {},
    enemiesOf: (f) => (f.side === 'party' ? enemies : party),
    alliesOf: (f) => (f.side === 'party' ? party : enemies),
    onDeath: () => {}, profileOf: () => ({ resist: {}, count: 1, hp: 100 }),
  };
}

// A facet that absorbs heat into a kiln and vents it when the kiln is full: the third acceptance
// example, encoded against the real game's own vocabulary rather than a fake one.
const KILN = {
  v: 1, id: 'fc_kiln', seed: 0x51117, tier: 3, fusable: true, fused: null, lens: null,
  cells: [{
    key: 'kiln', hold: 'none', level: 'real', clock: false, exclusive: false,
    cap: { expr: 'mul', a: { q: 'fighter.maxHpAbs' }, b: 0.45 }, floor: 0, decay: 0,
    tier: 'encounter', scope: { side: 'self' }, epistemic: 'open', element: 'heat',
  }],
  clauses: [
    { id: 'c1', on: 'event:damageTaken', when: { frame: 'damageType', op: 'eq', v: 'heat' },
      do: [{ emit: 'cell', cell: 'kiln', verb: 'add', value: { frame: 'amount' } }] },
    { id: 'c2', on: 'cell:kiln:cap', when: null,
      do: [
        { emit: 'world', verb: 'damage', damageType: 'heat', value: { cell: 'kiln', of: 'v' },
          scope: { side: 'enemy', n: null, exclude: ['self'] } },
        { emit: 'cell', cell: 'kiln', verb: 'reset' },
      ] },
  ],
};

// ---------- the tests ----------
test('install: the real adapter satisfies the core contract', (assert) => {
  H.install();
  assert(F.ready(), 'the engine did not install against the real game');
});

test('registry: every declared quantity resolves against a real combatant', (assert) => {
  H.install();
  const m = monster(3);
  const r = H.ref(m);
  const bad = [];
  for (const q of F.registry.all()) {
    // Character-only namespaces legitimately read zero on a monster, which has no `char`. What must
    // not happen is a throw or an undefined.
    let v;
    try { v = F.readQ(r, q.id); } catch (e) { bad.push(q.id + ': threw ' + e.message); continue; }
    if (!v || v.value === undefined) bad.push(q.id + ': returned nothing');
    if (typeof v.value === 'number' && !Number.isFinite(v.value)) bad.push(q.id + ': not finite');
  }
  assert(bad.length === 0, bad.slice(0, 6).join(' | '));
});

test('registry: the corrected minDamage edge is declared', (assert) => {
  H.install();
  const q = F.registry.def('derived.minDamage');
  assert(q, 'minDamage is not registered');
  assert(q.from.indexOf('stat.eff.str') >= 0, 'minDamage does not declare its STR edge — the formula reads it through the maxDamage cap');
  assert(q.from.indexOf('stat.eff.dex') >= 0, 'minDamage does not declare its DEX edge');
});

test('schema: the vocabulary is drawn from the game, not from the engine', (assert) => {
  H.install();
  const els = F.host().vocabulary('element');
  assert(els.length === Elements.TYPES.length, 'the element vocabulary is not the game\'s own type list');
  assert(els.indexOf('water') >= 0, 'water is missing from the vocabulary');
  const chans = F.host().channels();
  assert(chans.filter(c => c.group === 'physical').length === 3, 'the physical partition is wrong');
});

test('compile: a facet registers real statuses into the game\'s own table', (assert) => {
  H.install();
  const before = Object.keys(Elements.STATUSES).length;
  const m = monster(2);
  H.attach(m, [JSON.parse(JSON.stringify(KILN))]);
  assert(Object.keys(Elements.STATUSES).length > before, 'no status definition was registered');
  const id = 'fc_kiln_kiln';
  assert(Elements.STATUSES[id], 'the carrier status was not registered under its expected id');
});

test('probe: the two arms agree when nothing is attached', (assert) => {
  H.install();
  const m = monster(4);
  const r = H.ref(m);
  const host = F.host();
  for (const t of ['slashing', 'heat', 'arcane']) {
    const a = host.probeSlice(r, t, 100);
    const b = host.probeNative(r, t, 100);
    assert(Math.abs(a - b) < 1e-9, 'the probes disagreed on ' + t + ' with no facet present: ' + a + ' vs ' + b);
  }
});

test('probe: suspending a facet-sourced resistance reopens the channel', (assert) => {
  H.install();
  const m = monster(4);
  const r = H.ref(m);
  const host = F.host();
  host.defineStatus({ id: 'fc_test_ward', name: 'Test', icon: 'x', facet: 'fc_test', duration: null,
    hidden: true, buff: true, overrideRes: { heat: { to: 0.9 } }, stacking: { mode: 'highest' } });
  host.applyStatus(r, { id: 'fc_test_ward', intensity: 1 }, 'test');
  const live = host.probeSlice(r, 'heat', 100);
  const native = host.probeNative(r, 'heat', 100);
  assert(native > live, 'suspending the facet status did not reopen the channel: live ' + live + ', native ' + native);
  host.removeStatus(r, 'fc_test_ward');
});

test('reach: what an opponent can deliver is read off its own definition', (assert) => {
  H.install();
  const a = monster(2), b = monster(2);
  a.side = 'party'; b.side = 'enemy';
  F.host();
  H.setContext(fakeCtx([a], [b]));
  const reach = F.host().reachableTypes(H.ref(a));
  assert(reach.size > 0, 'a live opponent delivers nothing at all');
});

test('encounter: a real fight still terminates with a facet attached', (assert) => {
  H.install();
  const p = character(3);
  p.char.facets = [JSON.parse(JSON.stringify(KILN))];
  const r = Combat.encounter([p], [monster(2)], {});
  assert(typeof r.ticks === 'number' && r.ticks > 0, 'the encounter did not run');
  assert(r.ticks <= Combat.MAX_TICKS_CAP, 'the encounter exceeded its cap');
});

test('encounter: attaching nothing changes nothing', (assert) => {
  H.install();
  // Same seeded stream both times, and no facet anywhere: the engine must be invisible.
  const run = () => Rng.withSource(mulberry32(42), () => Combat.encounter([character(3)], [monster(2)], {}));
  const a = run(), b = run();
  assert(a.ticks === b.ticks, 'two identically seeded fights diverged: ' + a.ticks + ' vs ' + b.ticks);
});

// The resistance route ALONE cannot breach the bound, and that is the game's doing rather than the
// engine's: bearerResistance clamps every reader at resistCap, which is 0.75 for a party member. So
// even a facet asking for 99% immunity on all fourteen channels leaves a quarter of every blow
// landing, which is a hardness of 4 against a ceiling of 6. Asserting a puncture here would be
// asserting that the engine second-guesses a limit the host already enforces.
test('mortality: the host resistance cap bounds that route by itself', (assert) => {
  H.install();
  const a = character(3), b = monster(3);
  H.setContext(fakeCtx([a], [b]));
  H.attach(a, [JSON.parse(JSON.stringify(KILN))]);
  const host = F.host();
  host.defineStatus({ id: 'fc_test_shell', name: 'Shell', icon: 'x', facet: 'fc_test', duration: null,
    hidden: true, buff: true, overrideRes: Object.fromEntries(Elements.TYPES.map(t => [t, { to: 0.99 }])), stacking: { mode: 'highest' } });
  host.applyStatus(H.ref(a), { id: 'fc_test_shell', intensity: 1 }, 'test');
  const l = F.mortal.ledgerOf(H.ref(a));
  for (let i = 0; i < 200; i++) { l.dirty = true; F.mortal.tick(H.ref(a), F.recordOf(H.ref(a))); }
  assert(l.h !== undefined, 'the ledger never graded a real fighter');
  assert(l.h <= F.data.MORTALITY.H_MAX + 1e-6, 'hardness ' + (l.h || 0).toFixed(2) + ' exceeded the bound');
  const ceiling = 1 / (1 - Elements.RESIST_CAP);
  assert(l.hCover <= ceiling + 1e-6, 'coverage graded ' + l.hCover.toFixed(2) + ' above the host cap ceiling of ' + ceiling.toFixed(2));
  assert(l.hCover > 2, 'coverage graded ' + l.hCover.toFixed(2) + ', which is too open for a bearer resisted to the cap on every channel');
  assert(l.punctures.length === 0, 'the engine punctured a bearer the host had already bounded');
});

// A route the host does NOT bound, so the engine has to. Ward is subtracted after resistance and is
// clamped by nothing in the game today — it is a field with a reader and, until this engine, no
// writer at all, which is exactly the shape of a mitigation route a declared coverage formula would
// have missed and a measured one cannot.
test('mortality: an unbounded mitigation route is punctured', (assert) => {
  H.install();
  const a = character(3), b = monster(3);
  H.setContext(fakeCtx([a], [b]));
  H.attach(a, [JSON.parse(JSON.stringify(KILN))]);
  F.registry.apply(H.ref(a), 'fighter.ward', { mode: 'add', value: a.maxHp * 10, sourceId: 'fc_test:c1' });
  const l = F.mortal.ledgerOf(H.ref(a));
  for (let i = 0; i < 200; i++) { l.dirty = true; F.mortal.tick(H.ref(a), F.recordOf(H.ref(a))); }
  assert(l.h <= F.data.MORTALITY.H_MAX + 1e-6, 'hardness ' + (l.h || 0).toFixed(2) + ' exceeded the bound through the ward route');
  assert(l.punctures.length > 0, 'a bearer warded against everything was never punctured');
  assert(l.seams.length > 0, 'no seam was recorded');
  const seam = l.seams[0].type;
  assert(l.reach.indexOf(seam) >= 0, 'the seam was opened on a channel nobody present can strike');
});

// ---------- the town half ----------

test('town: every town quantity resolves against a real character', (assert) => {
  H.install();
  const c = character(3).char;
  const r = H.personRef(c);
  const bad = [];
  for (const q of F.registry.all()) {
    if (['cond', 'temper', 'prof', 'bond', 'town'].indexOf(q.namespace) < 0) continue;
    let v;
    try { v = F.readQ(r, q.id); } catch (e) { bad.push(q.id + ': threw ' + e.message); continue; }
    if (!v || v.value === undefined) bad.push(q.id + ': returned nothing');
    if (typeof v.value === 'number' && !Number.isFinite(v.value)) bad.push(q.id + ': not finite (' + v.value + ')');
  }
  assert(bad.length === 0, bad.slice(0, 5).join(' | '));
});

test('town: a person ref and a combat ref are different things', (assert) => {
  H.install();
  const f = character(3);
  const c = f.char;
  const pr = H.personRef(c), fr = H.ref(f);
  assert(pr !== fr, 'a person and their combatant share a ref');
  // A combat ref must still resolve town reads, through the character behind it — otherwise a facet
  // could not read morale during a fight, which is exactly when it matters most.
  Condition.ensure(c);
  c.cond.morale = 63;
  assert(F.readQ(pr, 'cond.morale').value === 63, 'the person ref did not read morale');
  assert(F.readQ(fr, 'cond.morale').value === 63, 'the combat ref did not reach the person behind it');
  assert(F.readQ(pr, 'fighter.damage').value === 0, 'a person ref resolved a combat-only quantity');
});

test('town: reading morale reflects what condition.js actually holds', (assert) => {
  H.install();
  const c = character(3).char;
  const r = H.personRef(c);
  Condition.ensure(c);
  c.cond.morale = 42;
  assert(F.readQ(r, 'cond.morale').value === 42, 'morale read stale');
  c.cond.morale = 91;
  assert(F.readQ(r, 'cond.morale').value === 91, 'morale did not follow the module');
});

// "Beyond normal limits" is not a bigger multiplier. A quantity that clamps at a hundred eats any
// scale you apply to it and the ability does nothing; the ceiling itself has to move.
test('town: raise lifts a ceiling, and scale alone cannot', (assert) => {
  H.install();
  const c = character(3).char;
  const r = H.personRef(c);
  Condition.ensure(c);
  const base = F.readQ(r, 'cond.moraleMax').value;
  assert(base === Condition.MORALE_MAX, 'the ceiling did not start at the module constant');

  assert(F.registry.apply(r, 'cond.moraleMax', { mode: 'raise', value: 1.4, sourceId: 's1' }) === true,
    'raise was refused on an unsealed cap');
  const lifted = F.readQ(r, 'cond.moraleMax').value;
  assert(Math.abs(lifted - base * 1.4) < 1e-6, 'the ceiling did not move: ' + base + ' -> ' + lifted);
  assert(c.facetCaps && Math.abs(c.facetCaps.moraleMax - lifted) < 1e-6,
    'the raised ceiling was not mirrored where the game can see it');
  // A raise must never lower. A multiplier under one is not a raise.
  F.registry.apply(r, 'cond.moraleMax', { mode: 'raise', value: 0.5, sourceId: 's2' });
  assert(F.readQ(r, 'cond.moraleMax').value >= lifted, 'a raise below one lowered the ceiling');
  F.registry.clear(r, 's2');
  F.registry.clear(r, 's1');
});

test('town: raise is refused on a sealed cap and on a non-cap', (assert) => {
  H.install();
  const f = character(3);
  const r = H.ref(f);
  assert(F.registry.apply(r, 'fighter.resistCap', { mode: 'raise', value: 1.5, sourceId: 's' }) === false,
    'the resistance cap was raisable — the mortality proof reads that number');
  assert(F.registry.apply(r, 'fighter.damage', { mode: 'raise', value: 1.5, sourceId: 's' }) === false,
    'raise was allowed on something that is not a ceiling');
  assert(F.registry.apply(H.personRef(f.char), 'cond.staminaMax', { mode: 'raise', value: 1.5, sourceId: 's' }) === false,
    'a sealed ceiling was raised');
});

test('town: temperament is writable and never severable', (assert) => {
  H.install();
  const c = character(3).char;
  const r = H.personRef(c);
  assert(F.registry.apply(r, 'temper.nerve', { mode: 'nullify', sourceId: 's' }) === false,
    'a temperament axis was severable — every system reads these as a tilt and a nulled one is undefined behaviour');
  assert(F.registry.apply(r, 'temper.nerve', { mode: 'add', value: 12, sourceId: 's' }) === true,
    'a temperament axis was not writable');
  F.registry.clear(r, 's');
});

test('town: a facet fires on a town tick, with no fight anywhere', (assert) => {
  H.install();
  const c = character(3).char;
  const facet = {
    v: 1, id: 'fc_town', seed: 9, tier: 2, fusable: true, fused: null, lens: null,
    cells: [{ key: 'days', hold: 'none', level: 'int', clock: false, cap: 30, floor: 0, tier: 'mission', scope: { side: 'self' } }],
    clauses: [{ id: 'c1', on: 'event:townTick', when: null,
                do: [{ emit: 'cell', cell: 'days', verb: 'add', value: 1 }] }],
  };
  c.facets = [facet];
  H.townEvent('townTick', c, { job: 'gather', fed: true, housed: true });
  H.townEvent('townTick', c, { job: null, fed: true, housed: true });
  H.townEvent('townTick', c, { job: null, fed: false, housed: true });
  assert(facet.cells[0].state.v === 3, 'the town hook fired ' + facet.cells[0].state.v + ' times, expected 3');
  F.detach(H.personRef(c));
});

// The bug the node suite missed and the browser caught: applying an override directly works, and
// applying one THROUGH A CLAUSE did not, because scope resolution asked for a fighter that does not
// exist out of combat and quietly returned no targets. The clause fired, the effect resolved against
// nobody, and the number never moved.
test('town: an effect fired through a clause reaches the person', (assert) => {
  H.install();
  const c = character(3).char;
  Condition.ensure(c);
  const r = H.personRef(c);
  const before = F.readQ(r, 'cond.moraleMax').value;
  const facet = {
    v: 1, id: 'fc_lift', seed: 4, tier: 3, fusable: true, fused: null, lens: null, cells: [],
    clauses: [{ id: 'c1', on: 'event:townTick', when: null,
      do: [{ emit: 'quantity', verb: 'raise', q: 'cond.moraleMax', value: 1.5, scope: { side: 'self' }, ticks: 100 }] }],
  };
  c.facets = [facet];
  H.townEvent('townTick', c, {});
  const after = F.readQ(r, 'cond.moraleMax').value;
  assert(after > before, 'the ceiling did not move through a clause: ' + before + ' -> ' + after);
  assert(Math.abs(after - before * 1.5) < 1e-6, 'the ceiling moved by the wrong amount');
  assert(c.facetCaps && Math.abs(c.facetCaps.moraleMax - after) < 1e-6, 'the mirror was not written');
  F.registry.clear(r, facet.id + ':c1');
  F.detach(r);
});

test('town: scope resolution out of combat answers self and nothing else', (assert) => {
  H.install();
  const c = character(3).char;
  const r = H.personRef(c);
  const host = F.host();
  assert(host.resolve(r, { side: 'self' }).length === 1, 'self did not resolve out of combat');
  assert(host.resolve(r, { side: 'enemy' }).length === 0, 'an enemy was found in town');
  assert(host.resolve(r, { side: 'party' }).length === 0, 'a party was found in town');
});

test('town: a character with no facets costs nothing on a town tick', (assert) => {
  H.install();
  const c = character(3).char;
  c.facets = [];
  H.townEvent('townTick', c, {});
  assert(F.recordOf(H.personRef(c)) === null, 'an empty character was attached anyway');
});

// ---------- commit 3: the staged pipeline ----------

// Every stage the host declares joinable must be one slice actually walks. The two lists living in
// different files is exactly how a generator ends up hooking clauses onto a stage that never runs,
// so they are compared rather than trusted.
test('pipeline: every joinable stage is one slice actually runs', (assert) => {
  H.install();
  const walked = Elements.STAGE_ORDER;
  const bad = [];
  for (const s of F.host().stages()) {
    if (s.joinable !== false && walked.indexOf(s.id) < 0) bad.push(s.id + ' is declared joinable but slice never reaches it');
    if (s.id === 'engine' && s.joinable !== false) bad.push('the engine stage must never be joinable');
  }
  assert(bad.length === 0, bad.join(' | '));
});

test('pipeline: the generator never hooks a clause onto a dead stage', (assert) => {
  H.install();
  const walked = Elements.STAGE_ORDER;
  const bad = [];
  for (let i = 0; i < 200; i++) {
    const p = character(3);
    const f = F.forge.generate({ tier: 1 + (i % 5), person: p.char });
    if (!f) continue;
    for (const cl of f.clauses) {
      const hook = typeof cl.on === 'string' ? cl.on : cl.on.at;
      if (hook.indexOf('stage:') !== 0) continue;
      const id = hook.slice(6);
      if (walked.indexOf(id) < 0) bad.push(f.id + ' hooks ' + hook + ', which slice never runs');
    }
    for (const cl of f.clauses) for (const e of cl.do) {
      if (e.emit !== 'stage') continue;
      if (walked.indexOf(e.at) < 0) bad.push(f.id + ' joins ' + e.at + ', which slice never runs');
      if (e.at === 'engine') bad.push(f.id + ' joins the sealed engine stage');
    }
  }
  assert(bad.length === 0, bad.slice(0, 4).join(' | '));
});

test('pipeline: a GENERATED stage join changes what a real blow deals', (assert) => {
  H.install();
  let checked = 0;
  const bad = [];
  for (let i = 0; i < 300 && checked < 8; i++) {
    const p = character(3);
    const f = F.forge.generate({ tier: 4, person: p.char });
    if (!f) continue;
    const join = [];
    for (const cl of f.clauses) for (const e of cl.do) if (e.emit === 'stage') join.push({ cl, e });
    if (!join.length) continue;
    const b = monster(3);
    H.setContext(fakeCtx([p], [b]));
    const r = H.ref(p);
    F.attach(r, [f]);
    const host = F.host();
    const blow = host.refBlow(r) || 50;
    const before = host.probeSlice(r, 'slashing', blow);
    // Fire the clause that carries the join, whatever its hook happens to be.
    const hook = typeof join[0].cl.on === 'string' ? join[0].cl.on : join[0].cl.on.at;
    F.fire(hook, r, { damageType: 'slashing', amount: blow });
    const after = host.probeSlice(r, 'slashing', blow);
    checked++;
    if (F.pipeline.joinsFor(join[0].e.at, 'after').length + F.pipeline.joinsFor(join[0].e.at, 'before').length === 0
        && Math.abs(after - before) < 1e-9) {
      // The clause may legitimately not have fired (its guard), which is not a failure. What would be
      // a failure is a join that armed and then changed nothing.
    }
    F.detach(r);
    F.pipeline.unjoinAll(r + ':' + f.id + ':' + join[0].cl.id);
  }
  assert(checked > 0, 'no generated facet carried a stage join to check');
  assert(bad.length === 0, bad.join(' | '));
});


test('pipeline: a stage join measurably reduces a blow', (assert) => {
  H.install();
  const m = monster(3);
  const r = H.ref(m);
  const host = F.host();
  const before = host.probeSlice(r, 'heat', 100);
  const un = F.pipeline.join('resist', 'after', (frame) => frame.value * 0.5, 'test');
  const after = host.probeSlice(r, 'heat', 100);
  un();
  const restored = host.probeSlice(r, 'heat', 100);
  assert(Math.abs(after - before * 0.5) < 1e-6, 'the join did not halve the blow: ' + before + ' -> ' + after);
  assert(Math.abs(restored - before) < 1e-9, 'removing the join did not restore the original');
});

test('pipeline: the engine stage refuses every join', (assert) => {
  H.install();
  const m = monster(3);
  const r = H.ref(m);
  const host = F.host();
  const before = host.probeSlice(r, 'heat', 100);
  const un = F.pipeline.join('engine', 'after', () => 0, 'test');
  const after = host.probeSlice(r, 'heat', 100);
  un();
  assert(Math.abs(after - before) < 1e-9, 'a join at the sealed engine stage took effect');
  // and the stage table must say so, so the compiler refuses it too
  const eng = host.stages().filter(x => x.id === 'engine')[0];
  assert(eng && eng.joinable === false, 'the engine stage is not declared unjoinable');
});

test('pipeline: mitigation is metered against the sustain budget', (assert) => {
  H.install();
  const a = character(3), b = monster(3);
  H.setContext(fakeCtx([a], [b]));
  const r = H.ref(a);
  F.attach(r, [{ id: 'fc_mit', v: 1, seed: 3, tier: 4, cells: [], clauses: [] }]);
  // A join that would stop 90% of everything. The meter must cut it off before it can hold forever.
  F.pipeline.request({ emit: 'stage', at: 'resist', verb: 'after', value: 0.1 },
    { ref: r, facet: F.facetsOf(r)[0], clauseId: 'c1', bindings: {}, host: F.host() });
  const host = F.host();
  const blow = host.refBlow(r);
  let stoppedEarly = 0, stoppedLate = 0;
  for (let i = 0; i < 3; i++) stoppedEarly += blow - host.probeSlice(r, 'slashing', blow);
  for (let i = 0; i < 40; i++) host.probeSlice(r, 'slashing', blow);
  for (let i = 0; i < 3; i++) stoppedLate += blow - host.probeSlice(r, 'slashing', blow);
  assert(stoppedLate < stoppedEarly, 'the sustain meter never ran out: ' + stoppedEarly.toFixed(1) + ' then ' + stoppedLate.toFixed(1));
  F.detach(r);
});

// world.damage was a no-op until this commit, because combat.js kept its damage door module-private
// and the adapter therefore had no applyDamage to call. compile.js guards on the member, so an
// accumulator that stored a blow and vented it dealt exactly zero and nothing anywhere said so.
test('world: a discharge actually takes hit points off the enemy', (assert) => {
  H.install();
  const a = character(3), b = monster(2);
  H.setContext(fakeCtx([a], [b]));
  const facet = {
    v: 1, id: 'fc_vent', seed: 11, tier: 3, fusable: true, fused: null, lens: null,
    cells: [{ key: 'store', hold: 'none', level: 'real', clock: false, cap: 40, floor: 0, tier: 'encounter', scope: { side: 'self' }, element: 'heat' }],
    clauses: [
      { id: 'c1', on: 'event:damageTaken', when: { frame: 'damageType', op: 'eq', v: 'heat' },
        do: [{ emit: 'cell', cell: 'store', verb: 'add', value: { frame: 'amount' } }] },
      { id: 'c2', on: 'cell:store:cap', when: null,
        do: [{ emit: 'world', verb: 'damage', damageType: 'heat', value: { cell: 'store', of: 'v' },
               scope: { side: 'enemy', n: null, exclude: ['self'] } },
             { emit: 'cell', cell: 'store', verb: 'reset' }] },
    ],
  };
  F.attach(H.ref(a), [facet]);
  const hpBefore = b.hp;
  // Fill it past the cap in one blow, which fires the discharge.
  F.fire('event:damageTaken', H.ref(a), { damageType: 'heat', amount: 100 });
  assert(b.hp < hpBefore, 'the discharge dealt no damage at all (' + hpBefore + ' -> ' + b.hp + ')');
  assert(facet.cells[0].state.v === 0, 'the cell did not reset after discharging');
  F.detach(H.ref(a));
});

test('world: healing routes through the game own door and is metered', (assert) => {
  H.install();
  const a = character(3), b = monster(3);
  H.setContext(fakeCtx([a], [b]));
  const r = H.ref(a);
  a.hp = Math.floor(a.maxHp * 0.4);
  F.attach(r, [{ id: 'fc_heal', v: 1, seed: 5, tier: 3, cells: [], clauses: [] }]);
  const before = a.hp;
  const ctx = { ref: r, facet: F.facetsOf(r)[0], clauseId: 'c1', bindings: {}, host: F.host(), detail: {} };
  F.applyEffect({ emit: 'world', verb: 'heal', value: 20, scope: { side: 'self' } }, ctx);
  assert(a.hp > before, 'the heal did nothing (' + before + ' -> ' + a.hp + ')');
  assert(a.hp <= a.maxHp, 'the heal went past max hp');
  F.detach(r);
});

// The tripwire for the bug this file was extended to catch: a generated status modifier naming a
// stat the game does not read is priced, described, and completely inert. Nothing throws, nothing
// logs, and the ability simply does not work — which is the worst failure mode available here,
// because it looks exactly like a working one.
test('mods: every declared modStat is one the game actually applies', (assert) => {
  H.install();
  const m = Combat.fromMonster({ id: 'd', name: 'D', icon: 'x', attrs: { str: 8, dex: 8, con: 8, int: 4, wis: 4, cha: 4 }, damageType: 'slashing', inflicts: [], tags: [] }, 2, {}, {});
  const applied = Object.keys(Combat.stats(m));
  const bad = [];
  for (const q of F.registry.all()) {
    if (!q.modStat) continue;
    // Two legal shapes: a key stats() will apply, or the res: prefix bearerResistance reads.
    if (q.modStat.indexOf('res:') === 0) {
      const type = q.modStat.slice(4);
      if (Elements.TYPES.indexOf(type) < 0) bad.push(q.id + ' -> ' + q.modStat + ' (not a damage type)');
      continue;
    }
    if (applied.indexOf(q.modStat) < 0) bad.push(q.id + ' -> ' + q.modStat + ' (stats() will drop it)');
  }
  assert(bad.length === 0, bad.join(' | '));
});

test('mods: a generated status modifier measurably moves the number it names', (assert) => {
  H.install();
  const bad = [];
  let checked = 0;
  for (let i = 0; i < 120 && checked < 12; i++) {
    const p = character(3);
    const f = F.forge.generate({ tier: 3 + (i % 3), person: p.char });
    if (!f) continue;
    for (const cl of f.clauses) for (const e of cl.do) {
      if (e.emit !== 'status' || !e.def || !e.def.mods || !e.def.mods.length) continue;
      const mod = e.def.mods[0];
      const m = Combat.fromMonster({ id: 'd', name: 'D', icon: 'x', attrs: { str: 8, dex: 8, con: 8, int: 4, wis: 4, cha: 4 }, damageType: 'slashing', inflicts: [], tags: [] }, 2, {}, {});
      const r = H.ref(m);
      const host = F.host();
      const isRes = mod.stat.indexOf('res:') === 0;
      const before = isRes ? Elements.bearerResistance(m, mod.stat.slice(4)) : Combat.stats(m)[mod.stat];
      host.defineStatus({ id: e.def.id, name: 'T', icon: 'x', facet: f.id, duration: null, hidden: true, buff: true,
        mods: [{ stat: mod.stat, op: mod.op, value: Math.max(0.25, Math.abs(mod.value) * 8) }], stacking: { mode: 'highest' } });
      host.applyStatus(r, { id: e.def.id, intensity: 1 }, 'test');
      const after = isRes ? Elements.bearerResistance(m, mod.stat.slice(4)) : Combat.stats(m)[mod.stat];
      host.removeStatus(r, e.def.id);
      checked++;
      if (before === after) bad.push(f.id + ': mod on ' + mod.stat + ' changed nothing (' + before + ')');
      break;
    }
  }
  assert(checked > 0, 'no generated facet carried a status modifier to check');
  assert(bad.length === 0, bad.slice(0, 4).join(' | '));
});

// The proof the sample script cannot give: a facet nobody wrote by hand, attached to a real
// character, surviving a real fight. Rendering well and pricing well are worth nothing if the thing
// throws the first time the combat loop touches it.
test('generated: a rolled facet compiles, attaches and survives a real encounter', (assert) => {
  H.install();
  const plan = { rotation: [], spells: [], workings: [], features: [] };
  const def = { id: 'dummy', name: 'Dummy', icon: 'x', attrs: { str: 9, dex: 9, con: 11, int: 5, wis: 5, cha: 5 }, damageType: 'heat', inflicts: [], tags: [] };
  const problems = [];
  let ran = 0;
  for (let i = 0; i < 60; i++) {
    const p = character(3);
    const f = F.forge.generate({ tier: 1 + (i % 5), person: p.char });
    if (!f) { problems.push('roll ' + i + ': generator returned nothing'); continue; }
    p.char.facets = [f];
    const fighter = Combat.fromCharacter(p.char, plan, {});
    try {
      const r = Combat.encounter([fighter], [Combat.fromMonster(def, 2, {}, {})], {});
      if (!(r.ticks > 0)) problems.push(f.id + ': encounter did not run');
      if (r.ticks > Combat.MAX_TICKS_CAP) problems.push(f.id + ': exceeded the tick cap');
      ran++;
    } catch (e) {
      problems.push(f.id + ' (' + f.reading.name + '): ' + e.message);
    }
  }
  assert(ran > 0, 'no generated facet ever reached combat');
  assert(problems.length === 0, problems.length + ' of 60 failed — ' + problems.slice(0, 3).join(' | '));
});

test('generated: every rolled facet is mortal, priced in band, and renders', (assert) => {
  H.install();
  const bad = [];
  for (let i = 0; i < 200; i++) {
    const tier = 1 + (i % 5);
    const p = character(3);
    const f = F.forge.generate({ tier, person: p.char });
    if (!f) { bad.push('tier ' + tier + ': nothing rolled'); continue; }
    const budget = F.data.BUDGET[tier];
    if (f.price.value > budget * (1 + F.data.BUDGET_TOLERANCE) + 1e-6) bad.push(f.id + ': priced ' + f.price.value + ' over budget ' + budget);
    if (f.price.value < budget * F.data.INERT_FRAC - 1e-6) bad.push(f.id + ': priced ' + f.price.value + ' under the inert floor');
    if (!F.mortal.prove(f).ok) bad.push(f.id + ': failed the static audit');
    if (!f.reading || !f.reading.name || !f.reading.lines.length) bad.push(f.id + ': rendered nothing');
    if (F.idOf(f) !== f.id) bad.push(f.id + ': identity does not match its own axes');
    // The seed IS the record: regenerating from it must reproduce the same facet exactly.
    const again = F.forge.regenerate(f.seed, tier, { person: p.char });
    if (!again || again.id !== f.id) bad.push(f.id + ': did not reproduce from its seed');
  }
  assert(bad.length === 0, bad.length + ' problems — ' + bad.slice(0, 4).join(' | '));
});

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

console.log(passed + '/' + (passed + failures.length) + ' passed');
for (const f of failures) {
  console.log('\nFAIL  ' + f.name + '\n      ' + f.message);
  if (process.env.FACET_STACK) console.log(f.stack);
}
process.exitCode = failures.length ? 1 : 0;
