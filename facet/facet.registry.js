// The quantity registry: a table describing the host's numbers, so a facet can operate on one it was
// never written to know about.
//
// This file sets the reach of the generator. The other registries in this directory list things the
// core owns; this one lists things the host owns, and it grows when the host describes more of
// itself, not when this engine gains more verbs. Register a number from the town half of the game and
// a facet can freeze it; register one from crafting and a facet can drain it. MODES holds ten verbs
// and this host registers 81 quantities (64 combat, 17 town), so the reachable combinations are 810,
// from one table and one switch. The table is the part that grows.
//
// The dependency graph: `from` lists the quantities a value is computed out of, `feeds` lists the
// quantities computed out of it, and `gates` is the subset of `feeds` where a zero removes an option
// rather than shrinking a number. That distinction makes "nullify a value and everything downstream
// of it stops firing" a query against the graph instead of a hand-written list, and it lets the
// generator resolve "a non-HP, non-attribute value" without an enumerated list.
//
// The graph is authored by hand and can go stale. It already is in one place: stats.js:50 declares
// minDamage as governed by DEX, but its formula reads both DEX and STR, so a graph built directly off
// the existing `stat` field is wrong from the start. facet.cases.js carries a recording-proxy audit
// that catches a wrong edge on any quantity the corpus exercises. It does not catch one the corpus
// never touches.

(() => {
const F = (globalThis.Facet || (globalThis.Facet = { _mods: {} }));
F._mods.registry = true;

const R = F.registry = {};

let BY_ID = {};
let ORDER = [];

// Overrides live per-bearer and are transient: never serialised, cleared with the encounter. The
// core holds them rather than the host so the host needs no concept of a facet. The host is asked
// for a native read and told what to do with the answer.
const OVERRIDES = new Map();   // ref -> { qid -> [{mode, value, min, max, until, sourceId}] }

R.build = function build(defs) {
  BY_ID = {}; ORDER = [];
  for (const d of defs || []) {
    if (BY_ID[d.id]) throw new Error('Facet.registry: duplicate quantity id ' + d.id);
    BY_ID[d.id] = normalise(d);
    ORDER.push(d.id);
  }
  // Build the inverse index. A host that declares `from` need not also declare `feeds`; a host that
  // declares both is checked against itself.
  for (const id of ORDER) {
    for (const src of BY_ID[id].from) {
      const parent = BY_ID[src];
      if (!parent) continue;                    // an edge to an unregistered id is allowed:
      if (parent.feeds.indexOf(id) < 0) parent.feeds.push(id);   // hosts describe themselves gradually
    }
  }
  // A cycle would make the closure walks in gatedClosure and feedClosure non-terminating. The
  // registry is hand-written data, so a cycle throws at install rather than being guarded against on
  // every read.
  const cyc = findCycle();
  if (cyc) throw new Error('Facet.registry: dependency cycle ' + cyc.join(' -> '));
  return R;
};

function normalise(d) {
  return {
    id: d.id,
    label: d.label || d.id,
    kind: d.kind || 'scalar',
    dimensioned: d.dimensioned !== false,
    from: (d.from || []).slice(),
    feeds: (d.feeds || []).slice(),
    gates: (d.gates || []).slice(),
    nul: d.nul === undefined ? 0 : d.nul,
    clamp: d.clamp || [null, null],
    nullifiable: d.nullifiable !== false,
    writable: d.writable !== false,
    sealed: !!d.sealed,
    mortalRole: d.mortalRole || null,
    namespace: d.namespace || 'fighter',
    // How this quantity is named inside a status modifier, or null when it cannot appear in one.
    // Not derivable from the id, and must not be guessed: this host reads a resistance mod as
    // `res:heat` and a speed mod as `speed`, and silently ignores a modifier naming anything else.
    // A generator that guessed the last path segment emitted stat names the game never read for two
    // thirds of the registry; those abilities were priced and described but had no effect.
    modStat: d.modStat === undefined ? null : d.modStat,
    // Which modifier operations actually move this quantity. Not every op is meaningful on every
    // number: this host computes a resistance modifier as `res * (1 + v)`, and a character's
    // resistance to most damage types starts at exactly 0, so a multiplicative one is an arithmetic
    // no-op at any magnitude. Declaring the usable ops is the only way the generator can know;
    // guessing produced abilities that priced and described correctly and had no effect.
    modOps: d.modOps || ['add', 'mult'],
    read: d.read || null,
  };
}

function findCycle() {
  const state = {};
  const stack = [];
  let found = null;
  function visit(id) {
    if (found) return;
    if (state[id] === 1) { found = stack.slice(stack.indexOf(id)).concat(id); return; }
    if (state[id] === 2) return;
    state[id] = 1; stack.push(id);
    for (const n of (BY_ID[id] ? BY_ID[id].feeds : [])) if (BY_ID[n]) visit(n);
    stack.pop(); state[id] = 2;
  }
  for (const id of ORDER) visit(id);
  return found;
}

R.def = (qid) => BY_ID[qid] || null;
R.ids = () => ORDER.slice();
R.all = () => ORDER.map(id => BY_ID[id]);

// Predicate query over the registry, not a fixed list. "A non-HP, non-attribute value whose loss
// would stop something from firing" is expressible because every clause of it is a registered
// property.
R.query = function query(pred) {
  return ORDER.map(id => BY_ID[id]).filter(q => {
    if (pred.nullifiable !== undefined && q.nullifiable !== pred.nullifiable) return false;
    if (pred.writable !== undefined && q.writable !== pred.writable) return false;
    if (pred.sealed !== undefined && q.sealed !== pred.sealed) return false;
    if (pred.kind && q.kind !== pred.kind) return false;
    if (pred.notKind && pred.notKind.indexOf(q.kind) >= 0) return false;
    if (pred.namespace && q.namespace !== pred.namespace) return false;
    if (pred.notNamespace && pred.notNamespace.indexOf(q.namespace) >= 0) return false;
    if (pred.mortalRole !== undefined && q.mortalRole !== pred.mortalRole) return false;
    if (pred.gating && q.gates.length === 0) return false;
    if (pred.notId && pred.notId.indexOf(q.id) >= 0) return false;
    return true;
  });
};

// Everything a nullified quantity takes with it. Walks `gates`, not `feeds`: shrinking a number that
// feeds another number is not suppression, and counting `feeds` edges here would make nullify
// suppress far more quantities than intended.
R.gatedClosure = function gatedClosure(qid) {
  const seen = {};
  const out = [];
  const walk = (id) => {
    for (const n of (BY_ID[id] ? BY_ID[id].gates : [])) {
      if (seen[n]) continue;
      seen[n] = true; out.push(n); walk(n);
    }
  };
  walk(qid);
  return out;
};

R.feedClosure = function feedClosure(qid) {
  const seen = {};
  const out = [];
  const walk = (id) => {
    for (const n of (BY_ID[id] ? BY_ID[id].feeds : [])) {
      if (seen[n]) continue;
      seen[n] = true; out.push(n); walk(n);
    }
  };
  walk(qid);
  return out;
};

// ---------- the ten verbs in MODES ----------
//
// Each verb writes an override record; none writes a host object. The host is handed a spec and
// applies it in its own stat path, which leaves the source game's frozen shared derived-stat block
// and its Svelte proxy untouched.
const MODES = ['nullify', 'freeze', 'clamp', 'scale', 'add', 'set', 'invert', 'redirect', 'desync', 'raise'];

// `raise` writes a quantity's ceiling rather than its value. It is the only verb here that does.
//
// A larger multiplier cannot push a value past its limit. On a quantity that clamps at 100, any
// `scale` above the clamp is discarded and the ability has no effect, the same silent no-op as a
// status modifier naming a stat the host does not read. The limit itself has to move.
//
// Only quantities the host declared as `kind:'cap'` and left unsealed accept it. That separates a
// ceiling that may be lifted (morale, a number in a tuning file) from one that may not (the
// resistance cap, which bounds how much mitigation can exist and which the mortality proof reads).
R.apply = function apply(ref, qid, spec) {
  const q = BY_ID[qid];
  if (!q) return false;
  if (spec.mode === 'nullify' && !q.nullifiable) return false;
  if (spec.mode !== 'nullify' && !q.writable) return false;
  if (q.sealed && (spec.mode === 'set' || spec.mode === 'nullify' || spec.mode === 'raise')) return false;
  if (spec.mode === 'raise' && q.kind !== 'cap') return false;
  if (MODES.indexOf(spec.mode) < 0) return false;

  let table = OVERRIDES.get(ref);
  if (!table) { table = {}; OVERRIDES.set(ref, table); }
  const list = table[qid] || (table[qid] = []);
  const rec = {
    mode: spec.mode, value: spec.value, min: spec.min, max: spec.max,
    until: spec.ticks ? F.host().now() + spec.ticks : null,
    sourceId: spec.sourceId || null,
    from: spec.from || null,
  };
  // One entry per sourceId, refreshed in place. A clause hooked on `tick` fires about 900 times in
  // an encounter; appending on each fire left 900 override records on one quantity, all of them
  // walked by every read, which is quadratic in fight length for what the player sees as a single
  // steady modifier. Re-applying refreshes the existing override instead of stacking a new one.
  const at = list.findIndex(o => o.sourceId === rec.sourceId && o.mode === rec.mode);
  // `moved` is true only when a field a reader can see (value, min, max) differs from the previous
  // record. A clause on `tick` re-asserts the same override every tick; treating each re-assertion
  // as a change woke the mortality ledger, which recomputes 28 real slices through the damage
  // pipeline, on nearly every tick of every fight. A refreshed `until` is not a state change and
  // does not invalidate anything.
  const prev = at >= 0 ? list[at] : null;
  const moved = !prev || prev.value !== rec.value || prev.min !== rec.min || prev.max !== rec.max;
  if (at >= 0 && rec.sourceId !== null) list[at] = rec; else list.push(rec);

  // Tell the host to invalidate whatever it caches. In this game stats() is uncached and the call is
  // a no-op; in the source game it is the line that stops a stale derived block being served.
  const h = F.host();
  if (h && h.overrideQ) h.overrideQ(ref, qid, spec);
  if (moved) {
    if (h && h.touchQ) h.touchQ(ref);
    F.dirty(ref);
  }
  return true;
};

R.clear = function clear(ref, sourceId) {
  const table = OVERRIDES.get(ref);
  if (!table) return;
  for (const qid of Object.keys(table)) {
    table[qid] = table[qid].filter(o => sourceId ? o.sourceId !== sourceId : false);
    if (!table[qid].length) delete table[qid];
  }
  const h = F.host();
  if (h && h.clearOverrides) h.clearOverrides(ref, sourceId);
  if (h && h.touchQ) h.touchQ(ref);
  F.dirty(ref);
};

R.expire = function expire(ref) {
  const table = OVERRIDES.get(ref);
  if (!table) return;
  const now = F.host().now();
  let changed = false;
  for (const qid of Object.keys(table)) {
    const before = table[qid].length;
    table[qid] = table[qid].filter(o => o.until === null || o.until > now);
    if (table[qid].length !== before) changed = true;
    if (!table[qid].length) delete table[qid];
  }
  if (changed) { const h = F.host(); if (h && h.touchQ) h.touchQ(ref); F.dirty(ref); }
};

R.overridesOf = (ref) => OVERRIDES.get(ref) || null;
R.resetAll = () => OVERRIDES.clear();

// ---------- the tri-state read ----------
//
// Returns { ok, value, nulled, by }. There are three outcomes: a normal read, a failed read, and a
// read suppressed by a nullify. The third is why callers go through this function instead of reading
// the host directly.
F.readQ = function readQ(ref, qid) {
  const h = F.host();
  const q = BY_ID[qid];
  if (!h) return { ok: false, value: 0, nulled: false, by: null };
  if (!q) return { ok: false, value: 0, nulled: false, by: null };   // unknown qid: fails open upstream

  // Suppressed because a quantity that gates this one was nullified. This branch is what makes
  // "effects downstream of a nullified value cannot trigger" hold at read time.
  const table = OVERRIDES.get(ref);
  if (table) {
    for (const otherId of Object.keys(table)) {
      if (otherId === qid) continue;
      const list = table[otherId];
      if (!list.some(o => o.mode === 'nullify')) continue;
      if (R.gatedClosure(otherId).indexOf(qid) >= 0) return { ok: false, value: 0, nulled: true, by: otherId };
    }
  }

  let value = h.readQ(ref, qid);
  if (value === undefined || value === null) value = 0;

  const list = table && table[qid];
  if (!list || !list.length) return { ok: true, value, nulled: false, by: null };

  let by = null;
  for (const o of list) {
    switch (o.mode) {
      case 'nullify': return { ok: false, value: q.nul, nulled: true, by: o.sourceId };
      case 'freeze':  value = o.value === undefined ? value : o.value; by = o.sourceId; break;
      case 'set':     value = o.value; by = o.sourceId; break;
      case 'scale':   value = value * o.value; by = o.sourceId; break;
      case 'add':     value = value + o.value; by = o.sourceId; break;
      // Relative, like every other magnitude in this engine. An absolute ceiling is balanced against
      // whatever the limit was when it was written: raising morale "to 150" is a buff where the cap
      // is 100 and a nerf where it is 200. The generator emitted "raise the ceiling to 40" once a
      // clamp meant for another quantity was applied to the number. A multiplier of at least 1
      // cannot lower the ceiling.
      case 'raise':   value = value * Math.max(1, o.value); by = o.sourceId; break;
      case 'invert':  value = -value; by = o.sourceId; break;
      case 'clamp':   value = Math.max(o.min === undefined ? -Infinity : o.min, Math.min(o.max === undefined ? Infinity : o.max, value)); by = o.sourceId; break;
      case 'redirect': case 'desync': by = o.sourceId; break;
      default: break;
    }
  }
  if (q.clamp[0] !== null && q.clamp[0] !== undefined) value = Math.max(q.clamp[0], value);
  if (q.clamp[1] !== null && q.clamp[1] !== undefined) value = Math.min(q.clamp[1], value);
  return { ok: true, value, nulled: false, by };
};

// The audit named in the file header. `probe(id)` returns the quantity ids a read of `id` touched,
// or a falsy value when the host cannot report them. This compares that set against the declared
// `from` and returns every disagreement as { id, declared, actual }. Run by the corpus, not at
// install: a wrong edge is a bug in authored data, and a test is where it should fail.
// NOT CURRENTLY CALLED. It needs a `probe(qid)` that reports which ids a read touched, which the
// host does not yet supply. Until one exists, a wrong `from` edge is caught only by a test that
// happens to exercise that quantity. Comments elsewhere in this file that describe the corpus
// running this audit describe the intended state, not the current one.
R.auditGraph = function auditGraph(probe) {
  const bad = [];
  for (const id of ORDER) {
    const q = BY_ID[id];
    const touched = probe(id);
    if (!touched) continue;
    const declared = q.from.slice().sort().join(',');
    const actual = touched.slice().sort().join(',');
    if (declared !== actual) bad.push({ id, declared: q.from.slice(), actual: touched.slice() });
  }
  return bad;
};
})();
