// Cells: one state machine over four axes.
//
// Why one reducer instead of five machine types. A mode and a latch differ only in whether the held
// tag carries a clock. An accumulator and a counter differ only in whether the magnitude is real or
// integral. Separate types would mean four reducers that have to be kept in step; when a feature is
// added to one and not the others, two cells the player is meant to tell apart start behaving the
// same way. Switching on the axes instead needs one reducer. The five familiar names survive as
// readings: computed by render(), shown to the player, branched on by no engine code.
//
//   hold       none | one | many     what tags it holds
//   level      none | int  | real    what magnitude it carries
//   clock      bool                  whether entries expire on their own
//   exclusive  bool                  (hold:'one') whether entering evicts
//
// Cache discipline. This is a constraint verified against the source game, not a preference. The
// source game's derived-stat cache folds each held status's id, effective intensity and stack count
// into its fingerprint, but not its `data`. Any magnitude a status modifier reads must therefore
// ride on intensity or on stacks, never on data. So: an accumulator's fill is the carrier status's
// intensity; a collection's size is its stacks; a collection's contents live in data and are read
// only at score time, which then writes intensity. Violating this makes the source game serve a
// stale stat block intermittently, which unit tests do not catch.

(() => {
const F = (globalThis.Facet || (globalThis.Facet = { _mods: {} }));
F._mods.cells = true;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

F.cellInit = function cellInit(cell) {
  cell.state = cell.state || {};
  const s = cell.state;
  if (s.at === undefined) s.at = null;
  if (s.v === undefined) s.v = cell.floor || 0;
  if (s.n === undefined) s.n = 0;
  if (s.items === undefined) s.items = [];
  if (s.until === undefined) s.until = null;
  if (s.cd === undefined) s.cd = 0;
  if (s.since === undefined) s.since = null;
  return cell;
};

F.cellRead = function cellRead(cell, of, ctx) {
  const s = cell.state || {};
  switch (of) {
    case 'v': return s.v || 0;
    case 'n': return s.n || 0;
    case 'count': return (s.items || []).length;
    case 'at': return s.at;
    case 'cap': return F.num(F.evalExpr(cell.cap, ctx));
    case 'frac': { const c = F.num(F.evalExpr(cell.cap, ctx)); return c > 0 ? (s.v || 0) / c : 0; }
    case 'until': return s.until === null ? 0 : s.until;
    case 'since': return s.since === null ? 0 : s.since;
    case 'items': return (s.items || []).slice();
    default: return s.v || 0;
  }
};

// ---------- the reducer ----------
//
// cellStep(cell, verb, arg, ctx) -> { changed, bindings, fired }
// Switches on cell.hold / cell.level / cell.clock only. It never switches on a cell or reading name.
F.cellStep = function cellStep(cell, verb, arg, ctx) {
  F.cellInit(cell);
  const s = cell.state;
  const host = F.host();
  const out = { changed: false, bindings: {}, fired: [] };

  switch (verb) {

    // ---- enter(tag): hold:'one' -------------------------------------------
    //
    // The compiled form does not rely on the host's blockedBy field for exclusivity. Verified
    // against live source: inflict() refuses to apply a status while a blocker is held, so two
    // mutually-blocking statuses lock on whichever landed first and never switch again. Exclusivity
    // is therefore explicit here: removeStatus() on the old carrier, then apply the new one. The
    // compiler still emits blockedBy as a guard against a third writer.
    case 'enter': {
      if (cell.hold !== 'one') break;
      if (s.cd > 0) break;
      if (s.at === arg) break;
      out.bindings.$from = s.at;
      out.bindings.$to = arg;
      if (cell.exclusive && s.at !== null && host) host.removeStatus(ctx.ref, F.carrierId(ctx.facet, cell, s.at));
      s.at = arg;
      s.since = host ? host.now() : 0;
      s.cd = cell.cooldown || 0;
      if (cell.clock && cell.hold === 'one') s.until = (host ? host.now() : 0) + (cell.holdTicks || 0);
      out.changed = true;
      out.fired.push('enter');
      break;
    }

    case 'exit': {
      if (cell.hold !== 'one' || s.at === null) break;
      out.bindings.$from = s.at;
      if (host) host.removeStatus(ctx.ref, F.carrierId(ctx.facet, cell, s.at));
      s.at = null; s.until = null;
      out.changed = true;
      out.fired.push('exit');
      break;
    }

    // ---- add(x): a magnitude ----------------------------------------------
    case 'add': {
      if (cell.level === 'none' || cell.hold === 'many') break;
      const cap = F.num(F.evalExpr(cell.cap, ctx));
      const want = cell.level === 'int' ? Math.round(F.num(arg)) * (cell.step || 1) : F.num(arg);
      const before = s.v;
      s.v = clamp(before + want, cell.floor || 0, cap);
      const took = s.v - before;
      out.bindings.$took = took;
      out.bindings.$spill = want - took;
      out.changed = took !== 0;
      // The fill rides on intensity. See the cache-discipline note at the top of this file.
      if (host && out.changed) host.setStatusIntensity(ctx.ref, F.carrierId(ctx.facet, cell), s.v);
      if (cap > 0 && s.v >= cap) out.fired.push('cap');
      break;
    }

    case 'set': {
      if (cell.level === 'none') break;
      const cap = F.num(F.evalExpr(cell.cap, ctx));
      const before = s.v;
      s.v = clamp(F.num(arg), cell.floor || 0, cap);
      out.changed = s.v !== before;
      if (host && out.changed) host.setStatusIntensity(ctx.ref, F.carrierId(ctx.facet, cell), s.v);
      if (cap > 0 && s.v >= cap) out.fired.push('cap');
      break;
    }

    // ---- draw(n, from): hold:'many' ---------------------------------------
    case 'draw': {
      if (cell.hold !== 'many') break;
      const cap = Math.max(1, Math.round(F.num(F.evalExpr(cell.cap, ctx))));
      const n = Math.max(1, Math.round(F.num(arg && arg.n !== undefined ? arg.n : arg) || 1));
      const from = (arg && arg.from) || cell.tags;
      const drawn = [];
      for (let i = 0; i < n; i++) {
        const tok = F.drawToken(from, ctx);
        if (tok === null || tok === undefined) continue;
        if (s.items.length >= cap) s.items.shift();       // at cap, drop the oldest; discard() can remove any index
        s.items.push(tok);
        drawn.push(tok);
      }
      s.n = s.items.length;
      out.bindings.$drawn = drawn;
      out.changed = drawn.length > 0;
      if (host && out.changed) {
        host.setStatusStacks(ctx.ref, F.carrierId(ctx.facet, cell), s.n);
        host.setStatusData(ctx.ref, F.carrierId(ctx.facet, cell), F.tokenCounts(cell));
      }
      break;
    }

    case 'discard': {
      if (cell.hold !== 'many') break;
      const idx = Array.isArray(arg) ? arg.slice().sort((a, b) => b - a) : [F.num(arg)];
      for (const i of idx) if (i >= 0 && i < s.items.length) s.items.splice(i, 1);
      s.n = s.items.length;
      out.changed = idx.length > 0;
      if (host && out.changed) {
        host.setStatusStacks(ctx.ref, F.carrierId(ctx.facet, cell), s.n);
        host.setStatusData(ctx.ref, F.carrierId(ctx.facet, cell), F.tokenCounts(cell));
      }
      break;
    }

    // ---- score(): pure over the held items --------------------------------
    case 'score': {
      const scorer = F.SCORERS[(arg && arg.id) || (cell.scorer && cell.scorer.id) || 'count'];
      if (!scorer) break;
      const r = scorer(s.items || [], cell.scorer || {}, ctx);
      s.v = F.num(r.weight);
      out.bindings.$rank = r.rank === undefined ? 0 : r.rank;
      out.bindings.$weight = s.v;
      out.bindings.$aim = r.aim === undefined ? null : r.aim;
      out.bindings.$tags = r.tags || [];
      out.changed = true;
      out.fired.push('score');
      if (host) host.setStatusIntensity(ctx.ref, F.carrierId(ctx.facet, cell), s.v);
      break;
    }

    // ---- latch / release: clock:true --------------------------------------
    case 'latch': {
      if (!cell.clock) break;
      const cap = Math.max(1, Math.round(F.num(F.evalExpr(cell.cap, ctx))));
      const ticks = Math.max(1, Math.round(F.num(arg && arg.ticks)));
      const entry = { t: (arg && arg.what) !== undefined ? arg.what : null, v: F.num(arg && arg.v), until: (host ? host.now() : 0) + ticks };
      if (s.items.length >= cap) s.items.shift();
      s.items.push(entry);
      s.n = s.items.length;
      out.bindings.$latched = entry.t;
      out.changed = true;
      break;
    }

    case 'release': {
      if (!cell.clock) break;
      const released = s.items.slice();
      s.items = []; s.n = 0;
      out.bindings.$released = released;
      out.changed = released.length > 0;
      out.fired.push('release');
      break;
    }

    case 'reset': {
      const had = s.v || s.n || s.at !== null || s.items.length;
      s.at = null; s.v = cell.floor || 0; s.n = 0; s.items = []; s.until = null; s.cd = 0; s.since = null;
      out.changed = !!had;
      break;
    }

    case 'decay': {
      if (cell.level !== 'none' && cell.decay) {
        const cap = F.num(F.evalExpr(cell.cap, ctx));
        const before = s.v;
        s.v = clamp(s.v - cell.decay * cap, cell.floor || 0, cap);
        out.changed = s.v !== before;
        if (host && out.changed) host.setStatusIntensity(ctx.ref, F.carrierId(ctx.facet, cell), s.v);
      }
      break;
    }

    default: break;
  }

  return out;
};

// ---------- per-tick maintenance ----------
F.cellsTick = function cellsTick(facet, ref) {
  const host = F.host();
  const now = host ? host.now() : 0;
  for (const cell of (facet.cells || [])) {
    F.cellInit(cell);
    const s = cell.state;
    if (s.cd > 0) s.cd--;
    if (cell.decay) F.cellStep(cell, 'decay', null, { ref, facet, host });
    if (cell.clock) {
      if (s.until !== null && s.until <= now) {
        s.until = null;
        if (cell.hold === 'one' && s.at !== null) F.cellStep(cell, 'exit', null, { ref, facet, host });
        F.fire('cell:' + cell.key + ':release', ref, { key: cell.key });
      }
      if (s.items && s.items.length) {
        const before = s.items.length;
        s.items = s.items.filter(e => !(e && e.until !== undefined && e.until <= now));
        if (s.items.length !== before) { s.n = s.items.length; F.fire('cell:' + cell.key + ':release', ref, { key: cell.key }); }
      }
    }
  }
  if (F.registry && F.registry.expire) F.registry.expire(ref);
};

// Tier-scoped reset: resets every cell whose cell.tier (default 'encounter') matches the given
// tier. The source game has no equivalent table; it resets in a single line that clears position,
// events, cooldowns, prevented and rank, and misses `charged`. Iterating over facet.cells means a
// newly added engine-owned cell cannot be left out of that list.
F.cellsReset = function cellsReset(facet, tier, ref) {
  const host = F.host();
  for (const cell of (facet.cells || [])) {
    if ((cell.tier || 'encounter') !== tier) continue;
    F.cellStep(cell, 'reset', null, { ref, facet, host });
  }
};

F.carrierId = function carrierId(facet, cell, tag) {
  return 'fc_' + (facet ? facet.id.replace('fc_', '') : 'x') + '_' + cell.key + (tag ? '_' + tag : '');
};

F.tokenCounts = function tokenCounts(cell) {
  const out = {};
  for (const t of (cell.state.items || [])) {
    const k = tokenKey(t);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
};

const tokenKey = (t) => (t === null || t === undefined) ? 'null'
  : (typeof t === 'object' ? (String(t.rank === undefined ? '' : t.rank) + ':' + String(t.suit === undefined ? '' : t.suit)) : String(t));

// ---------- decks ----------
//
// A token is { rank, suit }. The core owns the ordered dimension and nothing else: ranks are
// integers from d.ranks, and suits are opaque tokens, taken either from spec.suits or from the host
// vocabulary named by d.suitsFrom (slice(6) strips its 6-character prefix). The alternative, tokens
// named 'hearts' and 'rank9', would make the scorer parse names, which the rule against branching
// on names forbids.
F.deck = function deck(spec, ctx) {
  const d = F.data.DECKS[spec.deck];
  if (!d) return [];
  const suits = d.suitsFrom ? (F.host().vocabulary(d.suitsFrom.slice(6)) || []) : [null];
  const out = [];
  for (const r of d.ranks) for (const s of (spec.suits ? F.resolveTable(spec.suits, ctx) : suits)) out.push({ rank: r, suit: s });
  return out;
};

F.drawToken = function drawToken(from, ctx) {
  const host = F.host();
  if (!from) return null;
  if (from.deck) { const pool = F.deck(from, ctx); return pool.length ? host.pick(pool) : null; }
  const table = F.resolveTable(from, ctx);
  return table.length ? host.pick(table) : null;
};

// ---------- scorers ----------
//
// Each scorer is a pure function of the held-item multiset and names nothing game-specific. `poker`
// reads integer ranks and compares suit tokens only for equality. They are game-agnostic, so they
// live in the core rather than in a game module.
F.SCORERS = {
  count: (items) => ({ weight: items.length, rank: items.length }),

  sum: (items) => ({ weight: items.reduce((a, t) => a + ((t && t.worth) || 1), 0) }),

  diminish: (items, cfg) => {
    const a = (cfg && cfg.a) || 4;
    const n = items.length;
    // Token at index i is worth a/(a+i), with a from cfg.a (default 4), so marginal value falls as
    // items accumulate and the total grows sublinearly in n. The loop sums the exact terms rather
    // than using a closed-form approximation.
    let total = 0;
    for (let i = 0; i < n; i++) total += a / (a + i);
    return { weight: total, rank: n };
  },

  poker: (items) => {
    if (!items.length) return { weight: 0, rank: 0, tags: [] };
    const ranks = items.map(t => (t && t.rank) || 0).sort((a, b) => a - b);
    const suits = items.map(t => (t && t.suit) === undefined ? null : t.suit);
    const counts = {};
    for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
    const mult = Object.keys(counts).map(k => counts[k]).sort((a, b) => b - a);
    const suitCounts = {};
    for (const s of suits) suitCounts[String(s)] = (suitCounts[String(s)] || 0) + 1;
    const flushLen = Math.max.apply(null, Object.keys(suitCounts).map(k => suitCounts[k]));
    let runLen = 1, best = 1;
    for (let i = 1; i < ranks.length; i++) {
      if (ranks[i] === ranks[i - 1]) continue;
      if (ranks[i] === ranks[i - 1] + 1) { runLen++; best = Math.max(best, runLen); } else runLen = 1;
    }
    // Ordered low to high. The returned rank is the index of the highest entry whose hit is true,
    // so a payload table can key off an integer instead of the hand name.
    const ladder = [
      { name: 'high',     hit: true,                                    weight: 1 },
      { name: 'pair',     hit: mult[0] >= 2,                            weight: 2 },
      { name: 'twopair',  hit: mult[0] >= 2 && mult[1] >= 2,            weight: 3 },
      { name: 'trips',    hit: mult[0] >= 3,                            weight: 5 },
      { name: 'straight', hit: best >= 5,                               weight: 8 },
      { name: 'flush',    hit: flushLen >= 5,                           weight: 11 },
      { name: 'full',     hit: mult[0] >= 3 && mult[1] >= 2,            weight: 14 },
      { name: 'quads',    hit: mult[0] >= 4,                            weight: 20 },
      { name: 'straightflush', hit: best >= 5 && flushLen >= 5,         weight: 30 },
    ];
    let rank = 0;
    for (let i = 0; i < ladder.length; i++) if (ladder[i].hit) rank = i;
    return { weight: ladder[rank].weight, rank, tags: [ladder[rank].name] };
  },

  // Returns in `aim` the item indices to discard to most improve another scorer (cfg.of, default
  // 'poker'). Greedy single-token removal: each candidate is scored once, gain is the removed set's
  // weight per remaining item minus the current weight per item, and the top cfg.swap indices are
  // returned (default 2, clamped to items.length). This is a heuristic, not a search: against a
  // deck with strong pair structure it will sometimes keep the wrong card.
  worstFor: (items, cfg, ctx) => {
    const of = F.SCORERS[(cfg && cfg.of) || 'poker'];
    if (!of || !items.length) return { weight: 0, aim: [] };
    const budget = Math.max(1, Math.min(items.length, (cfg && cfg.swap) || 2));
    const base = of(items, cfg, ctx).weight;
    const scored = items.map((it, i) => {
      const without = items.slice(0, i).concat(items.slice(i + 1));
      return { i, gain: of(without, cfg, ctx).weight / Math.max(1, without.length) - base / Math.max(1, items.length) };
    });
    scored.sort((a, b) => b.gain - a.gain);
    return { weight: base, aim: scored.slice(0, budget).map(x => x.i) };
  },
};

// ---------- readings ----------
//
// cellReading() returns the display name for a cell: the first entry in F.data.READINGS whose
// `when` keys all match the cell's axis values, else 'flag'. The name is for the UI only. No engine
// code reads it; every behavioural branch is on the axis fields instead.
F.cellReading = function cellReading(cell) {
  for (const r of F.data.READINGS) {
    let ok = true;
    for (const k of Object.keys(r.when)) if (cell[k] !== r.when[k]) { ok = false; break; }
    if (ok) return r.name;
  }
  return 'flag';
};
})();
