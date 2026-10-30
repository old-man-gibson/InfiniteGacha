// Test corpus, runner-agnostic. Published at globalThis.FacetCases as a map of name -> fn.
// Each function takes (assert, H); H is a fresh fake host. This file imports no runner: the two
// games run these cases under different runners and must share this file unchanged.

(() => {
const F = (globalThis.Facet || (globalThis.Facet = { _mods: {} }));

// ---------- fake host ----------
// Minimal host that is neither real game host, so the core can be exercised with neither game
// loaded. Fields in `over` are merged over the defaults by Object.assign, so a case can replace
// any member without restating the rest.
function fakeHost(over) {
  const bearers = {};
  let tick = 0;
  const statuses = {};
  const applied = {};
  const h = {
    id: 'test', ticksPerSecond: 10,
    caps: { party: true, ally: true, arena: true, mission: true, calendar: false, summon: false, revive: false, simulate: false, laws: true },
    encounterCap: () => 900,
    rand: () => 0.5, pick: (a) => a[0], weightedPick: (a) => a[0],
    proc: (r, k, rate) => rate >= 0.5, curveRate: (r, k, rate) => rate,
    now: () => tick, _advance: (n) => { tick += (n || 1); },
    bearerId: (r) => r, isAlive: () => true, sideOf: (r) => bearers[r] ? bearers[r].side : 'party',
    levelOf: () => 1, hp: (r) => bearers[r] ? bearers[r].hp : 100, maxHp: () => 100,
    personOf: () => ({}), opponentsOf: () => ['e1'],
    resolve: (from, scope) => scope.side === 'enemy' ? ['e1'] : [from],
    rankers: () => ['front', 'random'],
    quantities: () => [
      { id: 'fighter.hp', label: 'HP', kind: 'pool', nullifiable: false, writable: false, mortalRole: 'vitality' },
      { id: 'fighter.crit', label: 'Crit chance', kind: 'prob', from: [], feeds: ['fighter.critDamage'], gates: ['fighter.critDamage'] },
      { id: 'fighter.critDamage', label: 'Crit damage', kind: 'mult', nul: 1, from: ['fighter.crit'] },
      { id: 'fighter.speed', label: 'Speed', kind: 'rate', feeds: ['fighter.bar'], gates: ['fighter.bar'] },
      { id: 'fighter.bar', label: 'Action bar', kind: 'rate', from: ['fighter.speed'] },
      { id: 'fighter.resistCap', label: 'Cap', kind: 'cap', nullifiable: false, writable: false, sealed: true },
      { id: 'stat.eff.str', label: 'STR', kind: 'attribute', namespace: 'stat', nullifiable: false, writable: true },
    ],
    readQ: (r, q) => (bearers[r] && bearers[r].q[q] !== undefined) ? bearers[r].q[q] : 1,
    overrideQ: () => {}, clearOverrides: () => {}, touchQ: () => {},
    statusSchema: () => ({ fields: { mods: { kind: 'mod' }, duration: { kind: 'meta' }, buff: { kind: 'meta' }, hidden: { kind: 'meta' }, stacking: { kind: 'meta' }, worth: { kind: 'meta' }, overrideRes: { kind: 'res', mortality: 'coverage' } } }),
    statusWorth: () => 1,
    defineStatus: (d) => { statuses[d.id] = d; },
    applyStatus: (r, app) => { (applied[r] || (applied[r] = [])).push(app); return app; },
    removeStatus: (r, id) => { if (applied[r]) applied[r] = applied[r].filter(a => a.id !== id); },
    findStatus: (r, id) => (applied[r] || []).filter(a => a.id === id)[0] || null,
    setStatusIntensity: () => {}, setStatusStacks: () => {}, setStatusData: () => {},
    stages: () => [{ id: 'resist', order: 3, joinable: true }, { id: 'floor', order: 7, joinable: true, sealed: true }],
    channels: () => [{ id: 'slashing', group: 'physical' }, { id: 'heat', group: 'magical' }, { id: 'water', group: 'magical' }],
    classOf: (t) => t === 'slashing' ? 'physical' : 'magical',
    descriptorSchema: () => ({ lethalField: 'damageType', costField: 'cost', fields: { kind: { kind: 'enum' }, element: { kind: 'enum' }, damageType: { kind: 'enum', lethal: true } } }),
    vocabulary: (f) => f === 'element' ? ['heat', 'water'] : ['swing', 'spell'],
    bag: () => ({}), log: () => {}, trace: () => {},
    _statuses: statuses, _applied: applied,
    _add: (r, q, side) => { bearers[r] = { hp: 100, side: side || 'party', q: q || {} }; return r; },
  };
  return Object.assign(h, over || {});
}

const CASES = globalThis.FacetCases = {};

// ---------- install ----------
CASES['install: every core module is present'] = (assert) => {
  for (const m of F.MODULES) assert(F._mods[m] === true, 'module ' + m + ' did not register');
};

CASES['install: a host missing members is refused by name'] = (assert) => {
  let threw = null;
  try { F.install({ id: 'x' }); } catch (e) { threw = e; }
  assert(threw !== null, 'install accepted a host with no members');
  assert(/missing/.test(threw.message), 'the error did not say what was missing');
  assert(/rand/.test(threw.message), 'the error did not name the missing members');
};

CASES['install: a declared capability requires its members'] = (assert) => {
  const h = fakeHost({ caps: { simulate: true } });
  let threw = null;
  try { F.install(h); } catch (e) { threw = e; }
  assert(threw !== null && /caps.simulate/.test(threw.message), 'a host claiming simulate was not asked to prove it');
};

// ---------- canon and identity ----------
CASES['canon: a name is not part of what a facet IS'] = (assert) => {
  const a = { v: 1, seed: 1, tier: 1, cells: [], clauses: [{ id: 'c1', on: 'tick', do: [] }], reading: { name: 'Alpha' } };
  const b = { v: 1, seed: 1, tier: 1, cells: [], clauses: [{ id: 'c1', on: 'tick', do: [] }], reading: { name: 'Omega' } };
  assert(F.idOf(a) === F.idOf(b), 'two facets with the same axes and different names hashed differently');
};

CASES['canon: key order does not change identity'] = (assert) => {
  const a = { v: 1, tier: 2, seed: 3, cells: [] };
  const b = { seed: 3, cells: [], v: 1, tier: 2 };
  assert(F.canon(a) === F.canon(b), 'canon is not order-stable');
};

// ---------- nulled quantities ----------
// Two directions, asserted separately. evalGuard on an unknown quantity id returns G_TRUE (fails
// open), so a save referencing a quantity that no longer exists does not disable a character's
// facets. evalGuard on a nullified quantity returns G_NULLED (fails closed), so severing a value
// disables its dependents instead of enabling them.
CASES['nulled: an unknown quantity fails OPEN'] = (assert, H) => {
  F.install(H); H._add('a');
  const g = { q: 'fighter.doesNotExist', op: 'gte', v: 999 };
  assert(F.evalGuard(g, { ref: 'a', facet: null, bindings: {} }) === F.G_TRUE, 'an unknown subject did not fail open');
};

CASES['nulled: a severed quantity fails CLOSED'] = (assert, H) => {
  F.install(H); H._add('a', { 'fighter.crit': 0.5 });
  const g = { q: 'fighter.crit', op: 'gte', v: 0 };
  assert(F.evalGuard(g, { ref: 'a', facet: null, bindings: {} }) === F.G_TRUE, 'the guard was not true before severing');
  F.registry.apply('a', 'fighter.crit', { mode: 'nullify', sourceId: 's' });
  assert(F.evalGuard(g, { ref: 'a', facet: null, bindings: {} }) === F.G_NULLED, 'a severed quantity did not fail closed');
  F.registry.clear('a', 's');
};

CASES['nulled: severance propagates down GATED edges only'] = (assert, H) => {
  F.install(H); H._add('a', { 'fighter.crit': 0.5, 'fighter.critDamage': 2, 'fighter.bar': 5 });
  F.registry.apply('a', 'fighter.crit', { mode: 'nullify', sourceId: 's' });
  assert(F.readQ('a', 'fighter.critDamage').nulled === true, 'a gated dependent survived its gate being severed');
  assert(F.readQ('a', 'fighter.bar').nulled === false, 'severance leaked to an unrelated quantity');
  F.registry.clear('a', 's');
};

CASES['registry: hp and attributes are not severable'] = (assert, H) => {
  F.install(H); H._add('a');
  assert(F.registry.apply('a', 'fighter.hp', { mode: 'nullify', sourceId: 's' }) === false, 'hp was severable');
  assert(F.registry.apply('a', 'stat.eff.str', { mode: 'nullify', sourceId: 's' }) === false, 'an attribute was severable');
  assert(F.registry.apply('a', 'stat.eff.str', { mode: 'scale', value: 2, sourceId: 's' }) === true, 'an attribute was not writable');
  F.registry.clear('a', 's');
};

CASES['registry: a sealed quantity admits no set'] = (assert, H) => {
  F.install(H); H._add('a');
  assert(F.registry.apply('a', 'fighter.resistCap', { mode: 'set', value: 1, sourceId: 's' }) === false, 'a sealed quantity was written');
};

// registry.query({ nullifiable: true, notKind: ['pool', 'attribute'], gating: true }) selects
// "a non-HP, non-attribute quantity whose loss stops something from firing" from the declared
// properties alone. Generators use this query instead of a hand-maintained list of targets.
CASES['registry: the E6 query is expressible and excludes the right things'] = (assert, H) => {
  F.install(H);
  const pool = F.registry.query({ nullifiable: true, notKind: ['pool', 'attribute'], gating: true });
  const ids = pool.map(q => q.id);
  assert(ids.indexOf('fighter.hp') < 0, 'the query returned hp');
  assert(ids.indexOf('stat.eff.str') < 0, 'the query returned an attribute');
  assert(ids.indexOf('fighter.crit') >= 0, 'the query missed a gating quantity');
  assert(ids.indexOf('fighter.critDamage') < 0, 'the query returned a non-gating quantity');
};

CASES['registry: a dependency cycle is refused at install'] = (assert) => {
  const h = fakeHost({ quantities: () => [
    { id: 'a', from: ['b'], gates: ['b'] },
    { id: 'b', from: ['a'], gates: ['a'] },
  ] });
  let threw = null;
  try { F.install(h); } catch (e) { threw = e; }
  assert(threw !== null && /cycle/.test(threw.message), 'a cyclic registry was accepted');
};

// ---------- Expr ----------
CASES['expr: arithmetic, curves and nulled propagation'] = (assert, H) => {
  F.install(H); H._add('a', { 'fighter.crit': 0.4 });
  const ctx = { ref: 'a', facet: null, bindings: {} };
  assert(F.evalExpr({ expr: 'add', a: 2, b: 3 }, ctx) === 5, 'add');
  assert(F.evalExpr({ expr: 'mul', a: 4, b: 0.5 }, ctx) === 2, 'mul');
  assert(F.evalExpr({ expr: 'div', a: 1, b: 0 }, ctx) === 0, 'division by zero did not yield zero');
  assert(Math.abs(F.evalExpr({ curve: 'diminish', of: 4, a: 4 }, ctx) - 0.5) < 1e-9, 'diminish curve');
  assert(F.evalExpr({ q: 'fighter.crit' }, ctx) === 0.4, 'quantity read');
  F.registry.apply('a', 'fighter.crit', { mode: 'nullify', sourceId: 's' });
  assert(F.isNulled(F.evalExpr({ q: 'fighter.crit' }, ctx)), 'a severed read did not return NULLED');
  assert(F.isNulled(F.evalExpr({ expr: 'add', a: { q: 'fighter.crit' }, b: 1 }, ctx)), 'NULLED did not propagate through arithmetic');
  F.registry.clear('a', 's');
};

// ---------- cells ----------
CASES['cell: an exclusive mode switches rather than locking'] = (assert, H) => {
  F.install(H); H._add('a');
  const facet = { id: 'fc_test', cells: [{ key: 'stance', hold: 'one', level: 'none', clock: false, exclusive: true, tags: ['phys', 'magic'] }] };
  const cell = facet.cells[0];
  const ctx = { ref: 'a', facet, host: F.host(), bindings: {} };
  let r = F.cellStep(cell, 'enter', 'phys', ctx);
  assert(r.changed && cell.state.at === 'phys', 'the first mode did not take');
  r = F.cellStep(cell, 'enter', 'magic', ctx);
  // A blockedBy-based implementation fails this case: the host refuses a second status while a
  // blocker is held, so two mutually blocking statuses lock on whichever landed first and never
  // switch. cellStep on an exclusive cell removes the held mode first, then applies the new one.
  assert(r.changed && cell.state.at === 'magic', 'an exclusive mode locked instead of switching');
  assert(r.bindings.$from === 'phys' && r.bindings.$to === 'magic', 'the transition did not bind from/to');
};

CASES['cell: an accumulator fills to its cap and fires once there'] = (assert, H) => {
  F.install(H); H._add('a');
  const facet = { id: 'fc_test', cells: [{ key: 'kiln', hold: 'none', level: 'real', clock: false, cap: 10, floor: 0 }] };
  const cell = facet.cells[0];
  const ctx = { ref: 'a', facet, host: F.host(), bindings: {} };
  let r = F.cellStep(cell, 'add', 4, ctx);
  assert(cell.state.v === 4 && r.bindings.$took === 4, 'the fill did not take');
  r = F.cellStep(cell, 'add', 9, ctx);
  assert(cell.state.v === 10, 'the fill passed its cap');
  assert(r.bindings.$spill === 3, 'the spill was not reported');
  assert(r.fired.indexOf('cap') >= 0, 'reaching the cap did not fire');
};

CASES['cell: a collection draws, holds and scores'] = (assert, H) => {
  F.install(H); H._add('a');
  const facet = { id: 'fc_test', cells: [{ key: 'hand', hold: 'many', level: 'int', clock: false, cap: 5, tags: { deck: 'core:ranked' }, scorer: { id: 'poker' } }] };
  const cell = facet.cells[0];
  const ctx = { ref: 'a', facet, host: F.host(), bindings: {} };
  F.cellStep(cell, 'draw', { n: 5 }, ctx);
  assert(cell.state.items.length === 5, 'the draw did not fill the hand');
  const r = F.cellStep(cell, 'score', null, ctx);
  assert(typeof r.bindings.$rank === 'number', 'scoring returned no rank');
  assert(cell.state.v > 0, 'scoring wrote no weight');
};

CASES['cell: the poker scorer reads ranks and never parses a name'] = (assert, H) => {
  F.install(H);
  const S = F.SCORERS.poker;
  const quads = S([{ rank: 9, suit: 'heat' }, { rank: 9, suit: 'water' }, { rank: 9, suit: 'heat' }, { rank: 9, suit: 'water' }, { rank: 2, suit: 'heat' }]);
  const pair = S([{ rank: 9, suit: 'heat' }, { rank: 9, suit: 'water' }, { rank: 4, suit: 'heat' }, { rank: 7, suit: 'water' }, { rank: 2, suit: 'heat' }]);
  const run = S([{ rank: 5, suit: 'heat' }, { rank: 6, suit: 'water' }, { rank: 7, suit: 'heat' }, { rank: 8, suit: 'water' }, { rank: 9, suit: 'heat' }]);
  assert(quads.weight > run.weight && run.weight > pair.weight, 'the poker ladder is not ordered');
  assert(quads.tags[0] === 'quads' && run.tags[0] === 'straight', 'the ladder mislabelled a hand');
};

CASES['cell: the mulligan heuristic names a bounded number of cards'] = (assert, H) => {
  F.install(H);
  const hand = [{ rank: 9, suit: 'heat' }, { rank: 9, suit: 'water' }, { rank: 3, suit: 'heat' }, { rank: 7, suit: 'water' }, { rank: 12, suit: 'heat' }];
  const r = F.SCORERS.worstFor(hand, { of: 'poker', swap: 2 });
  assert(Array.isArray(r.aim) && r.aim.length === 2, 'the mulligan did not name exactly its budget');
  assert(r.aim.every(i => i >= 0 && i < hand.length), 'the mulligan named an index that is not in the hand');
};

CASES['cell: reset is per-tier, so an encounter does not clear a mission'] = (assert, H) => {
  F.install(H); H._add('a');
  const facet = { id: 'fc_test', cells: [
    { key: 'short', hold: 'none', level: 'real', cap: 10, tier: 'encounter' },
    { key: 'long',  hold: 'none', level: 'real', cap: 10, tier: 'mission' },
  ] };
  const ctx = { ref: 'a', facet, host: F.host(), bindings: {} };
  F.cellStep(facet.cells[0], 'add', 5, ctx);
  F.cellStep(facet.cells[1], 'add', 5, ctx);
  F.cellsReset(facet, 'encounter', 'a');
  assert(facet.cells[0].state.v === 0, 'the encounter cell was not reset');
  assert(facet.cells[1].state.v === 5, 'the mission cell was reset by an encounter ending');
};

// ---------- compile ----------
CASES['compile: an undescribed status field is never emitted'] = (assert, H) => {
  F.install(H);
  const facet = { id: 'fc_test', v: 1, seed: 1, tier: 1, cells: [], clauses: [
    { id: 'c1', on: 'tick', do: [{ emit: 'status', def: { id: 'x', mods: [], magnetism: { nullifyDodge: true }, overrideRes: { heat: 1 } } }] },
  ] };
  const c = F.compile(facet, F.host());
  const def = c.defs.filter(d => d.id === 'x')[0];
  assert(def, 'the status definition was not emitted');
  assert(def.overrideRes !== undefined, 'a described field was dropped');
  assert(def.magnetism === undefined, 'an undescribed field was emitted');
};

CASES['compile: seconds become the host ticks'] = (assert, H) => {
  F.install(H);
  const facet = { id: 'fc_test', v: 1, seed: 1, tier: 1, cells: [], clauses: [
    { id: 'c1', on: 'tick', do: [{ emit: 'status', seconds: 3, def: { id: 'y', mods: [] } }] },
  ] };
  const c = F.compile(facet, F.host());
  assert(c.hooks.tick[0].do[0].ticks === 30, 'three seconds did not become thirty ticks at 10tps');
};

CASES['compile: sugar expands to a primitive'] = (assert, H) => {
  F.install(H);
  const facet = { id: 'fc_test', v: 1, seed: 1, tier: 1, cells: [], clauses: [
    { id: 'c1', on: 'tick', do: [{ emit: 'law', when: { act: 'damageClass', op: 'eq', v: 'physical' }, seconds: 5 }] },
  ] };
  const c = F.compile(facet, F.host());
  const eff = c.hooks.tick[0].do[0];
  assert(eff.emit === 'gate' && eff.verb === 'veto', 'law did not expand to a gate veto');
  assert(eff.scope && eff.scope.side === 'arena', 'law did not force arena scope');
};

// ---------- the clause dispatcher ----------
CASES['dispatch: a guard that is false does not fire its effects'] = (assert, H) => {
  F.install(H); H._add('a', { 'fighter.crit': 0.1 });
  const facet = { id: 'fc_test', v: 1, seed: 1, tier: 1, cells: [{ key: 'n', hold: 'none', level: 'int', cap: 10 }], clauses: [
    { id: 'c1', on: 'tick', when: { q: 'fighter.crit', op: 'gte', v: 0.9 }, do: [{ emit: 'cell', cell: 'n', verb: 'add', value: 1 }] },
  ] };
  F.attach('a', [facet]);
  F.fire('tick', 'a', {});
  assert(facet.cells[0].state.v === 0, 'a false guard let its effect through');
  facet.cells[0].state.v = 0;
  const facet2 = { id: 'fc_t2', v: 1, seed: 1, tier: 1, cells: [{ key: 'n', hold: 'none', level: 'int', cap: 10 }], clauses: [
    { id: 'c1', on: 'tick', when: { q: 'fighter.crit', op: 'gte', v: 0.05 }, do: [{ emit: 'cell', cell: 'n', verb: 'add', value: 1 }] },
  ] };
  F.attach('a', [facet2]);
  F.fire('tick', 'a', {});
  assert(facet2.cells[0].state.v === 1, 'a true guard did not fire');
  F.detach('a');
};

CASES['dispatch: once means once'] = (assert, H) => {
  F.install(H); H._add('a');
  const facet = { id: 'fc_once', v: 1, seed: 1, tier: 1, cells: [{ key: 'n', hold: 'none', level: 'int', cap: 10 }], clauses: [
    { id: 'c1', on: 'tick', once: 'encounter', do: [{ emit: 'cell', cell: 'n', verb: 'add', value: 1 }] },
  ] };
  F.attach('a', [facet]);
  F.fire('tick', 'a', {}); F.fire('tick', 'a', {}); F.fire('tick', 'a', {});
  assert(facet.cells[0].state.v === 1, 'a once-per-encounter clause fired ' + facet.cells[0].state.v + ' times');
  F.detach('a');
};

// ---------- mortality ----------
CASES['mortal: a revive that resolves in-encounter is refused statically'] = (assert, H) => {
  F.install(H);
  const bad = { id: 'x', cells: [], clauses: [{ id: 'c1', on: 'tick', do: [{ emit: 'world', verb: 'revive', when: 'now' }] }] };
  assert(F.mortal.prove(bad).ok === false, 'an in-encounter revive proved sound');
  const good = { id: 'x', cells: [], clauses: [{ id: 'c1', on: 'tick', do: [{ emit: 'world', verb: 'revive', when: 'missionEnd' }] }] };
  assert(F.mortal.prove(good).ok === true, 'a mission-end revive was refused');
};

CASES['mortal: an uncapped magnitude is refused'] = (assert, H) => {
  F.install(H);
  const bad = { id: 'x', cells: [{ key: 'k', hold: 'none', level: 'real' }], clauses: [] };
  assert(F.mortal.prove(bad).ok === false, 'a cell with a magnitude and no cap proved sound');
};

CASES['mortal: the sealed stages admit nothing'] = (assert, H) => {
  F.install(H);
  const a = { id: 'x', cells: [], clauses: [{ id: 'c1', on: 'tick', do: [{ emit: 'stage', at: 'engine', verb: 'join' }] }] };
  const b = { id: 'x', cells: [], clauses: [{ id: 'c1', on: 'tick', do: [{ emit: 'stage', at: 'floor', verb: 'replace' }] }] };
  assert(F.mortal.prove(a).ok === false, 'the engine stage admitted a join');
  assert(F.mortal.prove(b).ok === false, 'the floor stage admitted a replace');
};

CASES['mortal: a law that costs nothing to break is not a law'] = (assert, H) => {
  F.install(H);
  const bad = { id: 'x', cells: [], clauses: [{ id: 'c1', on: 'tick', do: [{ emit: 'gate', verb: 'veto', seconds: 5, penalty: { hpFrac: 0 } }] }] };
  assert(F.mortal.prove(bad).ok === false, 'a free law proved sound');
};

CASES['mortal: sustain is metered at the recipient and runs out'] = (assert, H) => {
  const h = fakeHost({ refBlow: () => 20, opponentsOf: () => ['e1', 'e2'] });
  F.install(h); h._add('a');
  const budget = F.mortal.sustainBudget('a');
  assert(budget > 0 && Number.isFinite(budget), 'the sustain budget is not a finite number');
  const first = F.mortal.spendSustain('a', budget * 0.8);
  const second = F.mortal.spendSustain('a', budget * 0.8);
  assert(Math.abs(first - budget * 0.8) < 1e-6, 'the first spend was throttled');
  assert(second < first, 'the meter did not run out');
  assert(first + second <= budget + 1e-6, 'total sustain exceeded the budget');
};

CASES['mortal: a revive does not reset the sustain meter'] = (assert, H) => {
  const h = fakeHost({ refBlow: () => 20 });
  F.install(h); h._add('a');
  const budget = F.mortal.sustainBudget('a');
  F.mortal.spendSustain('a', budget);
  F.mortal.noteRevive('a');
  assert(F.mortal.spendSustain('a', budget) < 1e-6, 'reviving refilled the sustain budget');
};

CASES['mortal: the revive cap holds'] = (assert, H) => {
  F.install(H); H._add('a');
  assert(F.mortal.mayRevive('a') === true, 'the first revive was refused');
  F.mortal.noteRevive('a');
  assert(F.mortal.mayRevive('a') === false, 'the cap did not hold');
};

// A facet that closes physical or magical but never both leaves some channel open at every instant,
// so a check that merely looks for one open channel at one instant accepts it. The hardness bound
// is therefore time-averaged, and averaged only over the channels in host.reachableTypes() rather
// than over every channel host.channels() declares.
CASES['mortal: a seam nobody can reach is not a seam'] = (assert) => {
  const closed = { slashing: 0.02, piercing: 0.02, bludgeoning: 0.02, heat: 1, water: 1 };
  const h = fakeHost({
    refBlow: () => 10,
    channels: () => Object.keys(closed).map(id => ({ id, group: id === 'heat' || id === 'water' ? 'magical' : 'physical' })),
    probeSlice: (r, t, raw) => raw * closed[t],
    probeNative: (r, t, raw) => raw,
    // slashing is the only reachable channel. heat and water pass at multiplier 1.0 but no opponent
    // can deliver them, so those open channels do not count toward the hardness average.
    reachableTypes: () => new Set(['slashing']),
  });
  F.install(h); h._add('a');
  F.attach('a', [{ id: 'fc_m', v: 1, seed: 7, tier: 3, cells: [], clauses: [] }]);
  const l = F.mortal.ledgerOf('a');
  for (let i = 0; i < 200; i++) { l.dirty = true; F.mortal.tick('a', F.recordOf('a')); h._advance(1); }
  assert(l.bestSeam !== undefined, 'the ledger never graded');
  assert(l.h <= F.data.MORTALITY.H_MAX + 1e-6, 'hardness ' + l.h.toFixed(2) + ' exceeded the bound');
  const punctured = l.punctures.filter(p => p.kind === 'seam');
  assert(punctured.length > 0, 'no seam was opened against an enemy that can only strike a closed channel');
  assert(punctured[0].type === 'slashing', 'the seam was opened on a channel nobody can reach');
  F.detach('a');
};

CASES['mortal: an open reachable channel is left alone'] = (assert) => {
  const open = { slashing: 0.02, heat: 1.0 };
  const h = fakeHost({
    refBlow: () => 10,
    channels: () => [{ id: 'slashing', group: 'physical' }, { id: 'heat', group: 'magical' }],
    probeSlice: (r, t, raw) => raw * open[t],
    probeNative: (r, t, raw) => raw,
    reachableTypes: () => new Set(['slashing', 'heat']),
  });
  F.install(h); h._add('a');
  F.attach('a', [{ id: 'fc_m', v: 1, seed: 7, tier: 3, cells: [], clauses: [] }]);
  const l = F.mortal.ledgerOf('a');
  for (let i = 0; i < 200; i++) { l.dirty = true; F.mortal.tick('a', F.recordOf('a')); h._advance(1); }
  assert(l.punctures.length === 0, 'a seam was opened although a reachable channel was already open');
  assert(l.h <= F.data.MORTALITY.H_MAX, 'hardness exceeded the bound with a channel wide open');
  F.detach('a');
};

// ---------- pricing ----------
CASES['price: a narrow hook buys more than a constant one'] = (assert, H) => {
  F.install(H);
  const mk = (hook) => ({ id: 'x', v: 1, seed: 1, tier: 3, cells: [], clauses: [
    { id: 'c1', on: hook, do: [{ emit: 'quantity', q: 'fighter.speed', verb: 'scale', value: 0.5 }] },
  ] });
  const always = F.forge.price(mk('tick')).value;
  const onParry = F.forge.price(mk('event:onParry')).value;
  assert(onParry < always, 'a rare hook was not cheaper than a constant one for the same effect');
};

CASES['price: severing a gating value costs more than severing a leaf'] = (assert, H) => {
  F.install(H);
  const mk = (q) => ({ id: 'x', v: 1, seed: 1, tier: 3, cells: [], clauses: [
    { id: 'c1', on: 'tick', do: [{ emit: 'quantity', q, verb: 'nullify' }] },
  ] });
  assert(F.forge.price(mk('fighter.crit')).value > F.forge.price(mk('fighter.critDamage')).value,
    'severing a gate was not priced above severing a leaf');
};

CASES['price: a drawback subtracts'] = (assert, H) => {
  F.install(H);
  const base = { id: 'x', v: 1, seed: 1, tier: 3, cells: [], clauses: [
    { id: 'c1', on: 'tick', do: [{ emit: 'quantity', q: 'fighter.speed', verb: 'scale', value: 2 }] },
  ] };
  const withCost = JSON.parse(JSON.stringify(base));
  withCost.clauses.push({ id: 'c2', on: 'tick', cost: true, do: [{ emit: 'quantity', q: 'fighter.crit', verb: 'scale', value: 0.5 }] });
  assert(F.forge.price(withCost).value < F.forge.price(base).value, 'a drawback did not reduce the price');
};

// ---------- fusion ----------
CASES['fusion: depth and arity are structural'] = (assert, H) => {
  F.install(H);
  const a = { id: 'fc_a', v: 1, seed: 1, tier: 3, cells: [], clauses: [{ id: 'c1', on: 'tick', do: [] }], fusable: true, fused: null };
  const b = { id: 'fc_b', v: 1, seed: 2, tier: 3, cells: [], clauses: [{ id: 'c1', on: 'tick', do: [] }], fusable: true, fused: null };
  const r = F.forge.fuse(a, b);
  assert(r.ok === true, 'a legal fusion was refused: ' + r.why);
  assert(r.facet.fusable === false, 'a fused facet remained fusable');
  assert(F.forge.fuse(r.facet, a).ok === false, 'a fused facet was fused again');
  assert(F.forge.fuse(a, a).ok === false, 'a facet fused with itself');
};

CASES['fusion: drawbacks are stripped and recorded'] = (assert, H) => {
  F.install(H);
  const a = { id: 'fc_a', v: 1, seed: 1, tier: 3, cells: [], fusable: true, fused: null, clauses: [
    { id: 'c1', on: 'tick', do: [{ emit: 'quantity', q: 'fighter.speed', verb: 'scale', value: 2 }] },
    { id: 'c2', on: 'tick', cost: true, do: [{ emit: 'quantity', q: 'fighter.crit', verb: 'scale', value: 0.5 }] },
  ] };
  const b = { id: 'fc_b', v: 1, seed: 2, tier: 3, cells: [], fusable: true, fused: null, clauses: [
    { id: 'c1', on: 'tick', do: [{ emit: 'quantity', q: 'fighter.critDamage', verb: 'scale', value: 1.5 }] },
  ] };
  const r = F.forge.fuse(a, b);
  assert(r.ok, 'the fusion failed');
  assert(r.facet.clauses.every(c => !c.cost), 'a drawback survived the fusion');
  assert(r.facet.fused.stripped.length === 1, 'the stripped drawback was not recorded');
};

CASES['fusion: colliding cell keys are kept apart'] = (assert, H) => {
  F.install(H);
  const mk = (id, seed) => ({ id, v: 1, seed, tier: 3, fusable: true, fused: null,
    cells: [{ key: 'kiln', hold: 'none', level: 'real', cap: 10 }], clauses: [] });
  const r = F.forge.fuse(mk('fc_a', 1), mk('fc_b', 2));
  assert(r.ok, 'the fusion failed');
  assert(r.facet.cells.length === 2, 'two cells collapsed into one');
  assert(r.facet.cells[0].key !== r.facet.cells[1].key, 'two cells kept the same key');
};

// ---------- serialisation ----------
CASES['serialise: a facet is plain JSON and survives a round trip'] = (assert, H) => {
  F.install(H);
  const facet = { id: 'fc_x', v: 1, seed: 5, tier: 2, lens: { shown: { 'a.b': 1 } }, fused: null, fusable: true,
    cells: [{ key: 'k', hold: 'none', level: 'real', cap: 10, state: { v: 3, n: 0, items: [], at: null, until: null, cd: 0 } }],
    clauses: [{ id: 'c1', on: 'tick', do: [{ emit: 'cell', cell: 'k', verb: 'add', value: 1 }] }],
    reading: { name: 'Should Not Survive' } };
  const wire = JSON.stringify(F.serialize(facet));
  assert(wire.indexOf('Should Not Survive') < 0, 'the reading was serialised');
  const back = F.hydrate(JSON.parse(wire));
  assert(back.cells[0].state.v === 3, 'cell state did not survive the round trip');
  assert(back.id === facet.id, 'the identity changed across a round trip');
};

CASES['serialise: no Map, Set, function or undefined reaches the wire'] = (assert, H) => {
  F.install(H);
  const facet = { id: 'fc_x', v: 1, seed: 5, tier: 2, cells: [{ key: 'k', hold: 'many', level: 'int', cap: 5, state: { items: [{ rank: 3, suit: 'heat' }], n: 1, v: 0, at: null, until: null, cd: 0 } }], clauses: [] };
  const wire = F.serialize(facet);
  const walk = (v, path) => {
    if (v === undefined) throw new Error('undefined at ' + path);
    if (typeof v === 'function') throw new Error('function at ' + path);
    if (v instanceof Map || v instanceof Set) throw new Error('Map/Set at ' + path);
    if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], path + '.' + k);
  };
  let err = null;
  try { walk(wire, '$'); } catch (e) { err = e; }
  assert(err === null, err ? err.message : '');
};

globalThis.FacetFakeHost = fakeHost;
})();
