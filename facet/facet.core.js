// Facet core: the namespace, the two evaluators, and the install contract.
// Published at globalThis.Facet. No import, no export, no require, no module.exports.
//
// Why globalThis instead of this repo's house convention. Every other file here ends with
// `module.exports = X; window.X = X`, which works for a file only this game loads. The facet engine
// is loaded by two games: this one by <script src>, and ksgproto28 by a Vite/TS/Svelte build. Each
// alternative was tried and fails in at least one of the four environments:
//
//   module.exports    Rollup sees a CommonJS file and wraps the reachable graph in a lazy shim, so
//                     top-level publication stops being eager and becomes invoked-on-require.
//   window.X          undefined under vitest's environment:'node'.
//   require() sibling under vitest the fallback branch is taken and returns an empty module object
//                     without throwing, so every field silently reads undefined.
//   export / import   a SyntaxError in a classic script. type="module" also fails: module scripts
//                     are deferred and run after every classic script, so combat.js's load-time
//                     `const R = typeof Rng !== 'undefined' ? ...` captures would read undefined.
//
// globalThis-only runs unmodified in all four: classic <script>, `node --test` (no package.json
// here, so .js is CJS and require() executes it for its side effect), `vite dev` and `vite build`
// (as a bare side-effect import, which Vite emits byte-for-byte), and vitest. ksgproto28 typechecks
// it through an ambient .d.ts sidecar, with no allowJs and no tsconfig change.
//
// Load order does not matter. Every core file opens with the same idempotent namespace claim and
// reads its siblings lazily, at call time, never captured at load time. install() then asserts the
// whole set is present and throws naming what is missing. install() throws rather than warning,
// which is the one place this engine departs from the host's optional-thunk style: a missing module
// disables features, and a silent failure there is not detectable at runtime.

(() => {
const F = (globalThis.Facet || (globalThis.Facet = { _mods: {} }));
F._mods.core = true;

F.VERSION = 1;
F.MODULES = ['core', 'data', 'registry', 'cells', 'relations', 'pipeline', 'gate', 'mortal', 'forge', 'oracle', 'compile'];

// ---------- the NULLED sentinel ----------
//
// A nullified quantity is not zero and not undefined. Zero is a legal value that arithmetic
// carries. undefined means "no such quantity" and fails open, so a stale save naming a subject that
// no longer exists does not brick a character. NULLED is a third value and fails closed: a guard
// reading it returns G_NULLED, so everything downstream of a nullified value stops firing.
// Collapsing NULLED into either of the other two inverts nullification: folded into undefined, a
// nullified value enables its dependents instead of disabling them. NULLED is therefore a unique
// object, it is never serialised, and facet.cases.js asserts both directions.
const NULLED = F.NULLED = { nulled: true, toString: () => '(nulled)' };
const isNulled = F.isNulled = (v) => v === NULLED;

// Tri-state guard results. Not booleans, so G_NULLED stays distinct from G_FALSE.
const G_TRUE = F.G_TRUE = 1, G_FALSE = F.G_FALSE = 0, G_NULLED = F.G_NULLED = -1;

// ---------- canon and hash ----------
//
// canon() is a stable stringify: keys sorted, volatile fields dropped. F.idOf() computes an id from
// it, so two facets with the same axes and different names get the same id, which enforces the rule
// that adding a name changes no character. `read` and `reading` are both on VOLATILE because both
// are prose describing the record, so two facets differing only in wording are the same facet.
// canon() filters VOLATILE at every nesting level, so the relation tree can carry its own phrasing
// without that phrasing entering the ability's identity.
const VOLATILE = ['reading', 'read', 'state', 'price', 'witness', 'id', 'hostOnly'];

function canon(v, dropVolatile) {
  if (dropVolatile === undefined) dropVolatile = true;
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  if (typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(x => canon(x, dropVolatile)).join(',') + ']';
  if (typeof v === 'object') {
    const keys = Object.keys(v).filter(k => !(dropVolatile && VOLATILE.indexOf(k) >= 0)).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canon(v[k], dropVolatile)).join(',') + '}';
  }
  return 'null';
}

// FNV-1a, 32 bits, returned as 8 hex digits. Not cryptographic: it only identifies a record inside
// one save, and install() checks for collisions rather than relying on the hash width.
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return ('0000000' + h.toString(16)).slice(-8);
}

F.canon = canon;
F.hash32 = hash32;
F.idOf = (facet) => 'fc_' + hash32(canon(facet)).slice(0, 6);

// ---------- the host ----------
let HOST = null;
F.host = () => HOST;
F.ready = () => !!HOST;

// Every adapter member the core may call. install() checks the whole list up front, so a missing
// member is reported at install time instead of partway through an encounter.
const REQUIRED = [
  'id', 'ticksPerSecond', 'caps', 'encounterCap',
  'rand', 'pick', 'weightedPick', 'proc', 'curveRate',
  'now', 'bearerId', 'isAlive', 'sideOf', 'levelOf', 'hp', 'maxHp', 'personOf', 'resolve', 'rankers',
  'quantities', 'readQ', 'overrideQ', 'clearOverrides', 'touchQ',
  'statusSchema', 'defineStatus', 'applyStatus', 'removeStatus', 'findStatus',
  'setStatusIntensity', 'setStatusStacks', 'setStatusData',
  'stages', 'channels', 'classOf',
  'descriptorSchema', 'vocabulary',
  'bag', 'log',
];
// Members required only when host.caps declares the matching capability. A host with caps.summon
// false is not checked for summon/dismiss/isSummoned. A host that declares a capability without
// supplying its members fails in install().
const CAP_REQUIRED = {
  simulate: ['withSeed', 'buildFixture', 'runEncounter', 'priceScale'],
  summon:   ['summon', 'dismiss', 'isSummoned'],
  revive:   ['revive'],
  calendar: ['writeCalendar', 'readCalendar'],
};

F.install = function install(host) {
  const missingMods = F.MODULES.filter(m => !F._mods[m]);
  if (missingMods.length) {
    throw new Error('Facet.install: core modules not loaded: ' +
      missingMods.map(m => 'facet.' + m + '.js').join(', ') +
      '. Load order does not matter, but every file must be present.');
  }
  const missing = REQUIRED.filter(k => host[k] === undefined);
  for (const cap of Object.keys(CAP_REQUIRED)) {
    if (host.caps && host.caps[cap]) {
      for (const m of CAP_REQUIRED[cap]) if (host[m] === undefined) missing.push(m + ' (required by caps.' + cap + ')');
    }
  }
  if (missing.length) throw new Error('Facet.install: host is missing ' + missing.length + ' member(s): ' + missing.join(', '));

  HOST = host;
  F.registry.build(host.quantities());
  F.attached = new Map();
  if (F.mortal && F.mortal.reset) F.mortal.reset();
  return F;
};

F.uninstall = function uninstall() { HOST = null; F.attached = new Map(); };

// ---------- Expr: a small data language, walked, never eval'd ----------
//
// Every magnitude is expressed relative to a quantity, for portability between the two hosts. A
// bare number is legal only in a dimensionless slot: a probability, a tick count, a multiplier.
// compile() rejects a bare number in a magnitude slot. psionic.js:45 carries `portScale: 0.55`
// because this game's magic damage runs hotter than the source game's spell power; a bare constant
// in a damage slot would need the same rescaling and would not get it in the host it was not tuned
// against.
function evalExpr(node, ctx) {
  if (node === null || node === undefined) return 0;
  if (typeof node === 'number') return node;
  if (typeof node === 'string') return node;
  if (typeof node === 'boolean') return node ? 1 : 0;
  if (Array.isArray(node)) return node.map(n => evalExpr(n, ctx));

  if (node.q !== undefined) {
    // `of` and `on` both select the subject. evalGuard read `of` and evalExpr read `on`, so an
    // Expr could never reach the target and resolved to self without reporting anything. Both
    // are accepted here and in evalGuard. Note that on a cell node `of` means the field to read
    // ('v', 'n', 'count'), not the subject; the two senses never collide because a node carries
    // either `q` or `cell`, never both.
    const on = (node.on === 'target' || node.of === 'target') ? ctx.target : ctx.ref;
    if (!on) return 0;
    const r = F.readQ(on, node.q);
    if (!r.ok) return r.nulled ? NULLED : 0;
    if (node.of === 'frac') { const m = F.readQ(on, node.max || 'fighter.maxHp'); return (m.ok && m.value) ? r.value / m.value : 0; }
    if (node.of === 'max')  { const m = F.readQ(on, node.max || 'fighter.maxHp'); return m.ok ? m.value : 0; }
    return r.value;
  }

  if (node.cell !== undefined) {
    const cell = F.cellOf(ctx.facet, node.cell);
    if (!cell) return 0;
    return F.cellRead(cell, node.of || 'v', ctx);
  }

  if (node.frame !== undefined) {
    const src = ctx.frame || ctx.detail || {};
    const v = src[node.frame];
    return v === undefined ? 0 : v;
  }

  if (node.roll !== undefined) {
    const lo = node.roll[0], hi = node.roll[1];
    return Math.floor(lo + HOST.rand() * (hi - lo + 1));
  }

  if (node.pick !== undefined) {
    const table = F.resolveTable(node.from, ctx);
    if (!table || !table.length) return 0;
    return node.pick === 'weighted' ? HOST.weightedPick(table, t => (t && t.weight) || 1) : HOST.pick(table);
  }

  if (node.curve !== undefined) {
    const x = num(evalExpr(node.of, ctx));
    const c = F.data.CURVES[node.curve];
    return c ? c(x, node.a, node.b) : x;
  }

  if (node.expr !== undefined) {
    const a = evalExpr(node.a, ctx), b = evalExpr(node.b, ctx);
    if (isNulled(a) || isNulled(b)) return NULLED;
    const x = num(a), y = num(b);
    switch (node.expr) {
      case 'add': return x + y;
      case 'sub': return x - y;
      case 'mul': return x * y;
      case 'div': return y === 0 ? 0 : x / y;
      case 'min': return Math.min(x, y);
      case 'max': return Math.max(x, y);
      case 'pow': return Math.pow(x, y);
      case 'floor': return Math.floor(x);
      case 'frac': return x - Math.floor(x);
      case 'clamp': return Math.max(y, Math.min(num(evalExpr(node.c, ctx)), x));
      default: return x;
    }
  }

  if (node.if !== undefined) {
    const b = ctx.bindings || {};
    return b[node.if] ? evalExpr(node.then, ctx) : evalExpr(node.else, ctx);
  }

  // `lens` names a path whose true / known / shown values may differ. Which one is returned depends
  // on ctx.view: 'true' inside resolution, 'known' when the AI is valuing an option, 'shown' when
  // the UI is drawing a number. This is the only node whose result depends on the caller.
  // affinity.js and mercy.js keep the same distinction in prose; here it is a node type.
  if (node.lens !== undefined) return F.lensRead(ctx.facet, node.lens, ctx.view || 'true');

  return 0;
}

const num = (v) => (isNulled(v) || typeof v !== 'number' || !Number.isFinite(v)) ? 0 : v;
F.evalExpr = evalExpr;
F.num = num;

// ---------- Guard: recursive, tri-state ----------
//
// The two failure directions are opposite:
//   an unknown subject fails open, returning G_TRUE, so a stale save does not brick a character
//     (same rule as ksgproto28's triggers.ts:216-218)
//   a NULLED quantity fails closed, returning G_NULLED, so nullification disables its dependents
//     rather than enabling them
function evalGuard(node, ctx) {
  if (node === null || node === undefined) return G_TRUE;

  if (node.all) {
    let r = G_TRUE;
    for (const g of node.all) { const x = evalGuard(g, ctx); if (x === G_NULLED) return G_NULLED; if (x === G_FALSE) r = G_FALSE; }
    return r;
  }
  if (node.any) {
    let sawNull = false;
    for (const g of node.any) { const x = evalGuard(g, ctx); if (x === G_TRUE) return G_TRUE; if (x === G_NULLED) sawNull = true; }
    return sawNull ? G_NULLED : G_FALSE;
  }
  if (node.not) { const x = evalGuard(node.not, ctx); return x === G_NULLED ? G_NULLED : (x === G_TRUE ? G_FALSE : G_TRUE); }

  if (node.q !== undefined) {
    const on = (node.of === 'target' || node.on === 'target') ? ctx.target : ctx.ref;
    if (!on) return G_TRUE;
    const r = F.readQ(on, node.q);
    if (r.nulled) return G_NULLED;              // fail closed
    if (!r.ok) return G_TRUE;                   // unknown subject: fail open
    return cmp(r.value, node.op, evalExpr(node.v, ctx)) ? G_TRUE : G_FALSE;
  }

  if (node.cell !== undefined) {
    const cell = F.cellOf(ctx.facet, node.cell);
    if (!cell) return G_TRUE;
    return cmp(F.cellRead(cell, node.of || 'v', ctx), node.op, evalExpr(node.v, ctx)) ? G_TRUE : G_FALSE;
  }

  if (node.frame !== undefined) {
    const src = ctx.frame || ctx.detail || {};
    if (!(node.frame in src)) return G_TRUE;
    return cmp(src[node.frame], node.op, evalExpr(node.v, ctx)) ? G_TRUE : G_FALSE;
  }

  if (node.act !== undefined) {
    const d = ctx.descriptor;
    if (!d || !(node.act in d)) return G_TRUE;
    return cmp(d[node.act], node.op, evalExpr(node.v, ctx)) ? G_TRUE : G_FALSE;
  }

  // Subsumes the host's own triggerOk. rec.events maps event name to the tick that event last
  // fired; the guard passes when HOST.now() is within node.within ticks of it, default 20 ticks.
  if (node.event !== undefined) {
    const rec = F.attached.get(ctx.ref);
    const at = rec && rec.events ? rec.events[node.event] : undefined;
    if (at === undefined) return G_FALSE;
    return (HOST.now() - at) <= (node.within === undefined ? 20 : node.within) ? G_TRUE : G_FALSE;
  }

  if (node.chance !== undefined) {
    const rate = num(evalExpr(node.chance, ctx));
    const key = 'facet:' + (ctx.facet && ctx.facet.id) + ':' + (ctx.clauseId || '?');
    return HOST.proc(ctx.ref, key, rate, node.mercy !== false) ? G_TRUE : G_FALSE;
  }

  return G_TRUE;
}

function cmp(a, op, b) {
  switch (op) {
    case 'eq':  return a === b;
    case 'ne':  return a !== b;
    case 'lt':  case '<':  return a < b;
    case 'lte': case '<=': return a <= b;
    case 'gt':  case '>':  return a > b;
    case 'gte': case '>=': return a >= b;
    case 'in':  return Array.isArray(b) && b.indexOf(a) >= 0;
    case 'nin': return Array.isArray(b) && b.indexOf(a) < 0;
    case 'has': return Array.isArray(a) && a.indexOf(b) >= 0;
    default:    return a === b;
  }
}
F.evalGuard = evalGuard;
F.cmp = cmp;

// ---------- helpers the sibling modules share ----------
F.cellOf = (facet, key) => ((facet && facet.cells) || []).filter(c => c.key === key)[0] || null;

F.resolveTable = function resolveTable(from, ctx) {
  if (Array.isArray(from)) return from;
  if (!from || typeof from !== 'object') return [];
  if (from.from && String(from.from).indexOf('vocab:') === 0) return HOST.vocabulary(String(from.from).slice(6)) || [];
  if (from.from === 'kill.tags') return (ctx.detail && ctx.detail.victimTags) || [];
  if (from.deck) return F.deck(from, ctx);
  return [];
};

F.lensRead = function lensRead(facet, path, view) {
  if (!facet) return 0;
  const lens = facet.lens;
  if (lens && lens[view] && lens[view][path] !== undefined) return lens[view][path];
  if (lens && view !== 'true' && lens.shown && lens.shown[path] !== undefined) return lens.shown[path];
  return F.pathGet(facet, path);
};

F.pathGet = function pathGet(obj, path) {
  let cur = obj;
  for (const seg of String(path).split('.')) {
    if (cur === null || cur === undefined) return 0;
    cur = Array.isArray(cur) ? cur[Number(seg)] : cur[seg];
  }
  return cur === undefined ? 0 : cur;
};

// ---------- attach / detach / tick / event ----------
F.attached = new Map();

F.attach = function attach(ref, facets) {
  if (!HOST || !ref) return [];
  const list = (facets || []).filter(Boolean);
  const compiled = [];
  for (const f of list) {
    const c = F.compile(f, HOST);
    if (c) compiled.push(c);
  }
  F.attached.set(ref, { facets: list, compiled, events: {}, dirty: true, sustainSpent: 0, revives: 0, once: {} });
  for (const c of compiled) for (const d of c.defs) HOST.defineStatus(d);
  for (const c of compiled) if (c.onAttach) c.onAttach(ref);
  return compiled;
};

F.detach = function detach(ref) { F.attached.delete(ref); };
F.facetsOf = (ref) => { const r = F.attached.get(ref); return r ? r.facets : []; };
F.recordOf = (ref) => F.attached.get(ref) || null;
F.dirty = function dirty(ref) { const r = F.attached.get(ref); if (r) r.dirty = true; };

F.tick = function tick(ref) {
  const rec = F.attached.get(ref);
  if (!rec || !HOST) return;
  for (const c of rec.compiled) F.cellsTick(c.facet, ref);
  F.fire('tick', ref, {});
  if (F.mortal && F.mortal.tick) F.mortal.tick(ref, rec);
};

F.event = function event(evId, ref, detail) {
  const rec = F.attached.get(ref);
  if (!rec || !HOST) return;
  rec.events[evId] = HOST.now();
  F.fire('event:' + evId, ref, detail || {});
};

F.tierEnd = function tierEnd(tier, ref) {
  const rec = F.attached.get(ref);
  if (!rec) return;
  for (const c of rec.compiled) F.cellsReset(c.facet, tier, ref);
  F.fire('tier:' + tier, ref, {});
  if (tier === 'encounter') { rec.sustainSpent = 0; rec.events = {}; rec.once = {}; }
};

// The clause dispatcher. Every hook in the engine arrives here: find the clauses listening on this
// hook, run their guard, run their effects. No branch in this function or in anything it calls
// tests a facet's name.
// ---------- re-entrancy ----------
//
// A facet can cause the event it listens for. Example: an ability that stores incoming damage and
// then releases it into its own bearer. The release damages the bearer, which fills the store,
// which discharges again. The arithmetic is correct but the recursion does not terminate, so the
// game hangs with no error.
//
// Two guards run against this.
//
// FIRING holds the (ref, facet.id, hook) keys currently on the stack. A clause will not re-enter
// itself, while a different facet reacting to the same event still fires. An ability whose
// discharge hurts its bearer stays legal; only the direct self-recursion is cut.
//
// fireDepth is a cap of MAX_FIRE_DEPTH = 24 nested fire() calls, applied without regard to cause.
// It covers loops the FIRING check does not catch, such as two different facets triggering each
// other.
const FIRING = {};
let fireDepth = 0;
const MAX_FIRE_DEPTH = 24;

F.fire = function fire(hook, ref, detail, frame) {
  const rec = F.attached.get(ref);
  if (!rec || !HOST) return frame;
  if (fireDepth >= MAX_FIRE_DEPTH) return frame;
  fireDepth++;
  try {
    return fireInner(hook, ref, detail, frame, rec);
  } finally {
    fireDepth--;
  }
};

function fireInner(hook, ref, detail, frame, rec) {
  for (const c of rec.compiled) {
    const clauses = c.hooks[hook];
    if (!clauses) continue;
    const guardKey = ref + '|' + c.facet.id + '|' + hook;
    if (FIRING[guardKey]) continue;
    FIRING[guardKey] = true;
    try {
      frame = fireClauses(clauses, c, rec, ref, detail, frame);
    } finally {
      delete FIRING[guardKey];
    }
  }
  return frame;
}

function fireClauses(clauses, c, rec, ref, detail, frame) {
  for (const clause of clauses) {
    if (clause.once && F.spent(rec, c.facet.id, clause)) continue;
    const ctx = {
      ref, facet: c.facet, host: HOST, tick: HOST.now(),
      detail: detail || {}, frame, bindings: {}, clauseId: clause.id, view: 'true',
      target: detail && detail.target,
    };
    if (evalGuard(clause.when, ctx) !== G_TRUE) continue;
    if (clause.once) F.spend(rec, c.facet.id, clause);
    for (const eff of clause.do) F.applyEffect(eff, ctx);
  }
  return frame;
}

F.spent = (rec, fid, clause) => !!(rec.once && rec.once[fid + ':' + clause.id]);
F.spend = (rec, fid, clause) => { (rec.once || (rec.once = {}))[fid + ':' + clause.id] = true; };

// ---------- serialize / hydrate ----------
//
// Plain JSON end to end: no Map, no Set, no class, no function, no undefined. Both hosts save by
// JSON.stringify of one blob and both backfill missing keys on load, so a facet attached to a
// character persists in both hosts with no new save code.
F.serialize = function serialize(facet) {
  const out = {};
  for (const k of Object.keys(facet)) { if (k === 'reading') continue; out[k] = facet[k]; }
  return JSON.parse(JSON.stringify(out));
};
F.hydrate = function hydrate(rec) {
  const f = JSON.parse(JSON.stringify(rec));
  f.id = f.id || F.idOf(f);
  return f;
};

// A stable string over every facet id and cell state that could change a derived number.
// ksgproto28's modFingerprint folds this in so its derived-stat cache cannot serve a stale block.
// This host's stats() is uncached, so the value costs nothing here and is used by the AI's plan
// cache.
F.fingerprint = function fingerprint(ref) {
  const rec = F.attached.get(ref);
  if (!rec || !rec.facets.length) return '';
  const parts = [];
  for (const f of rec.facets) {
    const cells = (f.cells || []).map(c => c.key + '=' + c.state.v + '/' + c.state.n + '/' + (c.state.at || ''));
    parts.push(f.id + ':' + cells.join(','));
  }
  return hash32(parts.join('|'));
};
})();
