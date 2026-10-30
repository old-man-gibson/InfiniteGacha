// The forge: generation, the analytic price, fusion, and the reading.
//
// Generation spends a tier budget through a trigger-frequency divisor. An effect is priced at its
// worth; a hook is priced by how often it is live (F.data.CERT_PRIOR); the allowance a facet may
// spend on effects is budget / CERT_PRIOR[hook]. A rare hook therefore buys a large magnitude and a
// constant hook buys a small one for the same price. Without the divisor every generated ability
// converges on a low-magnitude always-on passive.
//
// Generation is bound to the character's outlier. subjectOf() reads the person first, takes the
// most extreme axis, and the draw is biased toward it. A negative outlier is eligible on the same
// terms as a positive one; an ability grown out of cowardice or brittleness is more distinctive
// than another one grown out of high strength.
//
// The name is computed last, in nameOf(), and is stripped before the record is hashed. Two facets
// with the same axes and different names hash to the same id, so no name in this file affects a
// character.

(() => {
const F = (globalThis.Facet || (globalThis.Facet = { _mods: {} }));
F._mods.forge = true;

const FG = F.forge = {};

// ---------- the analytic price ----------
//
// Available without host simulation. It seeds the simulated oracle's search, so the two start from
// the same value. On a host with no simulator this is the only price source; the returned record is
// tagged source: 'analytic' and variance: null.
FG.price = function price(facet) {
  const D = F.data;
  let total = 0;
  const byClause = {};

  for (const cell of (facet.cells || [])) {
    total += D.CELL_COST[cell.hold] + D.CELL_LEVEL_COST[cell.level] +
             (cell.clock ? 1 : 0) + (cell.scorer ? 2 : 0);
    total *= 1;
  }

  for (const cl of (facet.clauses || [])) {
    const hook = typeof cl.on === 'string' ? cl.on : (cl.on && cl.on.at) || 'tick';
    const cert = D.CERT_PRIOR[hook] === undefined ? 0.3 : D.CERT_PRIOR[hook];
    const guardRate = guardCertainty(cl.when);
    let sum = 0;
    for (const e of (cl.do || [])) sum += effectWorth(e, facet);
    const priced = sum * cert * guardRate * (cl.once ? 0.25 : 1);
    byClause[cl.id] = cl.cost ? -priced : priced;
    total += byClause[cl.id];
  }

  return { value: Math.round(total * 100) / 100, byClause, source: 'analytic', variance: null };
};

function effectWorth(e, facet) {
  const D = F.data;
  const scope = (e.scope && e.scope.side) || 'self';
  const scopeMult = D.SCOPE_MULT[scope] === undefined ? 1 : D.SCOPE_MULT[scope];
  const persist = D.PERSIST_MULT[e.tier || 'encounter'] || 1;
  let base = 0;

  switch (e.emit) {
    case 'quantity': {
      const q = F.registry.def(e.q);
      if (e.verb === 'nullify') {
        // Nullify is priced by its downstream closure: the quantities gated by the one being
        // severed. Price is WORTH.nullify * (1 + closure * 0.5), so severing a quantity that gates
        // nothing costs the base and one that gates six costs four times the base.
        const closure = e.q ? F.registry.gatedClosure(e.q).length : (e.query ? 2 : 0);
        base = D.WORTH.nullify * (1 + closure * 0.5);
      } else {
        const key = e.verb === 'clamp' ? 'clampQ' : e.verb === 'add' ? 'addQ' : e.verb;
        base = D.WORTH[key] === undefined ? 2 : D.WORTH[key];
        base *= 1 + magnitudeFactor(e, q);
      }
      break;
    }
    case 'status': {
      const host = F.host();
      const declared = host && host.statusWorth ? host.statusWorth(e.defId || (e.def && e.def.id)) : 1;
      base = D.WORTH.status * Math.max(1, declared) * Math.max(0.25, literal(e.intensity) || 1);
      base += defWorth(e.def);
      break;
    }
    case 'world': {
      const key = e.verb;
      base = D.WORTH[key] === undefined ? 2 : D.WORTH[key];
      base *= 1 + magnitudeFactor(e, null);
      break;
    }
    case 'stage': {
      // Priced by the fraction of the blow the join removes. e.value is the keep-fraction, so the
      // price rises as it falls. Flat pricing here was a bug: fill() steers by price, so a stage
      // join whose price did not move with e.value let the fill loop widen that value without
      // limit and without changing the facet's worth.
      if (e.verb === 'skip') { base = D.WORTH.skip; break; }
      const keep = typeof e.value === 'number' ? Math.max(0, Math.min(1, e.value)) : 0.7;
      base = D.WORTH.stageJoin * (1 + Math.pow(1 - keep, 0.85) * 3);
      break;
    }
    case 'gate':  base = D.WORTH[e.verb] === undefined ? 3 : D.WORTH[e.verb]; break;
    case 'cell':  base = 0.5; break;
    default: base = 1;
  }

  return base * scopeMult * persist;
}

// Effect size, normalised per verb. Monotone and unbounded.
//
// An earlier version multiplied by Math.min(4, 1 + |value|). Above roughly a threefold multiplier
// that cap made the price independent of the magnitude, and fill() (which widens a magnitude until
// the facet is worth its tier) pushed multipliers into the thousands with no price change. One
// corpus rolled that way carried x1343 multipliers priced at 5 points.
//
// The return is sublinear, exponent 0.85, so x2 to x3 adds more than x12 to x13, but it has no
// ceiling and never stops rising.
function magnitudeFactor(e, q) {
  const v = literal(e.value);
  const kind = q ? q.kind : null;
  switch (e.verb) {
    // A multiplier's effect size is its distance from 1. A reduction carries an extra x2 factor: it
    // approaches removing the quantity outright, while an increase has no such limit point.
    case 'scale': return v >= 1 ? Math.pow(v - 1, 0.85) : Math.pow(1 - v, 0.85) * 2;
    case 'add':   return Math.pow(Math.abs(v) * ((kind === 'prob' || kind === 'mult') ? 10 : 1), 0.85);
    case 'freeze': case 'invert': case 'desync': return 1;
    default:      return Math.pow(Math.abs(v), 0.85);
  }
}

// Worth of the host's own StatusDef fields, priced by the field kinds the host declared in
// statusSchema(). A resistance override and a small speed modifier are both statuses but differ by
// 4x here; pricing them the same underprices a status that closes a damage channel.
function defWorth(def) {
  if (!def) return 0;
  const host = F.host();
  const schema = host && host.statusSchema ? host.statusSchema() : { fields: {} };
  let w = 0;
  for (const k of Object.keys(def)) {
    const field = schema.fields[k];
    if (!field) continue;
    switch (field.kind) {
      case 'res':      w += 8; break;      // closes a damage channel; the mortality proof reads it too
      case 'dot':      w += 4 * (1 + Math.abs((def[k] && def[k].flat) || 0)); break;
      case 'reactive': w += 5; break;
      case 'veto':     w += 7; break;
      case 'mod':      w += 2 * (1 + ((def[k] && def[k].length) ? Math.abs(def[k][0].value || 0) * 4 : 0)); break;
      case 'ladder':   w += 3; break;
      default: break;
    }
  }
  return w;
}

// Estimate an Expr magnitude from its shape. An Expr cannot be priced without evaluating it, so
// this returns one crude constant per shape and errs low. An underestimate produces a facet the
// oracle later reprices; an overestimate produces a facet that fails the budget check in draw() and
// never generates, which leaves no trace to inspect.
function literal(v) {
  if (typeof v === 'number') return v;
  if (!v || typeof v !== 'object') return 1;
  if (v.roll) return (v.roll[0] + v.roll[1]) / 2;
  if (v.curve) return 0.5;
  if (v.expr === 'mul') return literal(v.a) * literal(v.b);
  if (v.expr === 'add') return literal(v.a) + literal(v.b);
  return 1;
}

function guardCertainty(g) {
  if (!g) return 1;
  if (g.all) return g.all.reduce((a, x) => a * guardCertainty(x), 1);
  if (g.any) return Math.min(1, g.any.reduce((a, x) => a + guardCertainty(x), 0));
  if (g.not) return 1 - guardCertainty(g.not);
  if (g.chance !== undefined) return literal(g.chance);
  if (g.event !== undefined) return 0.3;
  if (g.cell !== undefined) return 0.5;
  return 0.6;
}

// ---------- the reading ----------
//
// Computed from the axes and cached on the facet for the interface. No code branches on it.
//
// Each row is a trigger and an effect, and the effect leads with its number. An earlier version
// wrote band words instead ("an overwhelming lift to its crit chance", "pins their physical resist
// where it stands"); those are gone, because a figure shown to the player must be traceable to
// something the player can point at, which a band word is not and a figure like "+34%" is.
//
// `rows` is the structured form a UI lays out in two columns. `lines` is the same rows joined with
// '  ->  ' for a terminal or a tooltip.
FG.render = function render(facet) {
  const cells = (facet.cells || []).map(c => Object.assign({}, c, { reading: F.cellReading(c) }));
  const rows = [];
  // Relation rows come first when facet.rel exists, because they state the causal link between the
  // parts. "stores lightning" and "+90% cold resistance" listed separately omit that the first
  // causes the second. A facet with no relation tree falls back to one shape row per cell.
  if (facet.rel) for (const r of relationRows(facet.rel)) rows.push(r);
  else for (const c of cells) rows.push({ when: shapeLabel(c), then: shapeDetail(c), kind: 'shape' });
  for (const cl of (facet.clauses || [])) {
    const r = clauseRow(cl);
    if (r) rows.push(r);
  }
  return {
    name: nameOf(facet, cells),
    icon: iconOf(facet, cells),
    rows,
    lines: rows.map(r => r.when + (r.then ? '  ->  ' + r.then : '')),
    price: facet.price ? facet.price.value : null,
  };
};

// Walk the relation tree outermost first and emit one row per level from node.read. A nested
// relation is prefixed with '  ↳ ' so the nesting is visible instead of flattened into a list.
function relationRows(node, depth) {
  depth = depth || 0;
  const out = [];
  if (!node || !node.rel) return out;
  const r = node.read;
  if (r) out.push({ when: (depth ? '  ↳ ' : '') + r.when, then: r.then, kind: 'relation' });
  for (const a of (node.args || [])) if (a && a.rel) out.push.apply(out, relationRows(a, depth + 1));
  return out;
}

// ---------- numbers ----------
const pctOf = (x) => (x >= 0 ? '+' : '-') + Math.round(Math.abs(x) * 100) + '%';
const num = (x) => {
  const a = Math.abs(x);
  if (a >= 100) return String(Math.round(x));
  if (a >= 10) return x.toFixed(0);
  if (a >= 1) return x.toFixed(1);
  return x.toFixed(2);
};

function amount(e) {
  const q = F.registry.def(e.q);
  const v = e.value;
  if (typeof v !== 'number') return exprLabel(v);
  if (e.verb === 'scale') return pctOf(v - 1);
  if (e.verb === 'add') return (q && (q.kind === 'prob' || q.kind === 'mult')) ? pctOf(v) : (v >= 0 ? '+' : '') + num(v);
  return num(v);
}

// A magnitude that is not a constant is labelled by what it reads rather than by a number: a cell
// reference renders as '= stored', a frame reference as '= the blow'.
function exprLabel(v) {
  if (!v || typeof v !== 'object') return '?';
  if (v.cell) return '= stored';
  if (v.frame) return '= the blow';
  if (v.curve) return 'per stack, falling';
  if (v.roll) return v.roll[0] + '-' + v.roll[1];
  if (v.expr) return 'scaled';
  return '?';
}

function secs(e) {
  if (!e.ticks) return '';
  const tps = F.host() ? F.host().ticksPerSecond : 10;
  return ' for ' + String((e.ticks / tps).toFixed(1)).replace(/\.0$/, '') + 's';
}

function who(e) {
  const side = e.scope && e.scope.side;
  if (!side || side === 'self') return '';
  if (side === 'enemy') return (e.scope.n === null || e.scope.n === undefined) ? ' [all enemies]' : ' [enemy]';
  if (side === 'ally') return ' [ally]';
  if (side === 'party') return ' [party]';
  if (side === 'arena' || side === 'world') return ' [everyone]';
  return '';
}

// ---------- triggers ----------
function clauseRow(cl) {
  const hook = typeof cl.on === 'string' ? cl.on : (cl.on && cl.on.at) || 'tick';
  let when = F.data.HOOK_PHRASE[hook] ||
    (hook.indexOf('cell:') === 0 ? (hook.indexOf(':cap') > 0 ? 'When full' : hook.indexOf(':score') > 0 ? 'When scored' : 'On release')
     : hook.indexOf('stage:') === 0 ? 'On any hit'
     : hook.indexOf('event:') === 0 ? 'On ' + hook.slice(8).replace(/([A-Z])/g, ' $1').trim().toLowerCase()
     : 'Always');
  const g = guardLabel(cl.when);
  if (g) when += ' ' + g;
  const parts = (cl.do || []).map(effectLabel).filter(Boolean);
  if (!parts.length) return null;
  return { when, then: parts.join(' | ') + (cl.cost ? '   (drawback)' : ''), kind: cl.cost ? 'cost' : 'effect' };
}

function guardLabel(g) {
  if (!g) return '';
  if (g.chance !== undefined) return '(' + Math.round((typeof g.chance === 'number' ? g.chance : 0.5) * 100) + '%)';
  if (g.q === 'fighter.hp') return '(when hurt)';
  if (g.frame === 'damageType') return '(' + g.v + ')';
  if (g.cell !== undefined) return '(while charged)';
  if (g.event !== undefined) return '(after ' + String(g.event).replace(/^on/, '').toLowerCase() + ')';
  if (g.all) return g.all.map(guardLabel).filter(Boolean).join(' ');
  return '';
}

// ---------- effects ----------
function effectLabel(e) {
  switch (e.emit) {
    case 'quantity': {
      const label = labelOf(e.q);
      if (e.verb === 'nullify') return 'sever ' + (e.query ? 'a random enemy stat' : label) + ' + downstream' + secs(e) + who(e);
      if (e.verb === 'freeze') return 'freeze ' + label + secs(e) + who(e);
      if (e.verb === 'raise') return pctOf(e.value - 1) + ' to the ' + label + secs(e) + who(e);
      return amount(e) + ' ' + label + secs(e) + who(e);
    }
    case 'status': return statusLabel(e);
    case 'world':
      if (e.verb === 'summon') return 'summon' + secs(e);
      if (e.verb === 'damage') return (typeof e.value === 'number' ? num(e.value) : exprLabel(e.value)) + ' ' + (e.damageType || '') + ' dmg' + who(e);
      if (e.verb === 'heal') return 'heal ' + (typeof e.value === 'number' ? num(e.value) : exprLabel(e.value)) + who(e);
      if (e.verb === 'revive') return 'revive at ' + Math.round((e.hpFrac || 0.25) * 100) + '% hp (' + (e.when === 'missionEnd' ? 'mission end' : 'after the fight') + ')';
      return e.verb + who(e);
    case 'gate': return e.verb === 'veto' ? 'FORBID that action to everyone' + secs(e) : e.verb + who(e);
    case 'stage': {
      // Name the stage the join sits at and the percentage change, for example "-30% incoming
      // damage after resistance". e.value is the keep-fraction, so the shown figure is
      // pctOf(keep - 1). A non-numeric value falls back to "reduce incoming damage".
      const keep = typeof e.value === 'number' ? Math.max(0, Math.min(1, e.value)) : null;
      const where = { armor: 'past armour', resist: 'after resistance', absorb: 'by absorbing', ward: 'through the ward', raw: 'before anything' }[e.at] || ('at ' + e.at);
      return (keep === null ? 'reduce incoming damage ' : pctOf(keep - 1) + ' incoming damage ') + where + secs(e);
    }
    case 'cell': return null;
    default: return null;
  }
}

function statusLabel(e) {
  const d = e.def || {};
  if (d.overrideRes) {
    const t = Object.keys(d.overrideRes)[0];
    const to = (d.overrideRes[t] && d.overrideRes[t].to) || 0;
    return Math.round(to * 100) + '% ' + t + ' resist' + secs(e) + who(e);
  }
  if (d.dot) return num(d.dot.flat) + ' ' + (d.dot.type || '') + ' dmg/tick' + secs(e) + who(e);
  if (d.retaliate) return 'reflect ' + num(d.retaliate.flat) + ' ' + (d.retaliate.type || '') + secs(e) + who(e);
  if (d.mods && d.mods.length) {
    const m = d.mods[0];
    const q = F.registry.all().filter(x => x.modStat === m.stat)[0];
    // Render as a percentage when the modifier op is 'mult' or the quantity's kind is 'prob' or
    // 'mult'. Without this the same resistance reads as "+90%" through one path and "+0.90"
    // through another.
    const asPct = m.op === 'mult' || (q && (q.kind === 'prob' || q.kind === 'mult'));
    const shown = asPct ? pctOf(m.value) : (m.value >= 0 ? '+' : '') + num(m.value);
    return shown + ' ' + (q ? q.label.toLowerCase() : m.stat) + secs(e) + who(e);
  }
  return 'status' + secs(e) + who(e);
}

// ---------- shape ----------
function shapeLabel(c) {
  switch (c.reading) {
    case 'mode':        return 'Stance';
    case 'accumulator': return 'Charges';
    case 'collection':  return 'Collects';
    case 'counter':     return 'Counts';
    case 'latch':       return 'Holds';
    default:            return 'Passive';
  }
}

function shapeDetail(c) {
  const cap = typeof c.cap === 'number' ? c.cap
    : (c.cap && typeof c.cap.b === 'number' ? Math.round(c.cap.b * 100) + '% max hp' : '?');
  switch (c.reading) {
    case 'mode':        return 'one of: ' + (c.tags || []).join(' / ') + '  (never two at once)';
    case 'accumulator': return 'stores ' + (c.element || 'damage') + ' up to ' + cap + ', then discharges';
    case 'collection':  return (c.scorer && c.scorer.id === 'poker')
      ? 'draws ' + cap + ', scored as a poker hand'
      : 'holds ' + cap + ', each worth less than the last';
    case 'counter':     return 'up to ' + cap;
    case 'latch':       return 'up to ' + cap + ', releases on its own';
    default:            return '';
  }
}

function labelOf(qid) { const q = F.registry.def(qid); return q ? q.label.toLowerCase() : 'something'; }

// ---------- the name ----------
//
// Two words: an adjective for what the facet is about, and a noun for the shape of its heaviest
// cell. The adjective comes from host.words(about.kind, about.value), because an adjective for fire
// is a game word the core does not have; NEUTRAL_ADJ is the fallback when the host supplies none,
// which yields a duller name rather than a broken one. The noun comes from the cell reading, which
// the core does own.
//
// Pool sizes govern collisions. An earlier version drew from 12 adjectives and 6 nouns, 72 possible
// names, and produced "Patient Mark" 15 times in 500 rolls. NEUTRAL_ADJ now holds 16 entries and
// each NOUN pool holds 5.
const NEUTRAL_ADJ = ['kindled', 'sunken', 'hollow', 'patient', 'brittle', 'hungry', 'quiet', 'wound',
                     'late', 'stubborn', 'thin', 'certain', 'narrow', 'grey', 'restless', 'unspent'];
const NOUN = {
  mode:        ['Vow', 'Stance', 'Turning', 'Oath', 'Face'],
  accumulator: ['Kiln', 'Cistern', 'Bellows', 'Reservoir', 'Furnace'],
  collection:  ['Hoard', 'Hand', 'Tally', 'Reliquary', 'Ledger'],
  counter:     ['Count', 'Reckoning', 'Toll', 'Score', 'Debt'],
  latch:       ['Clasp', 'Hold', 'Stay', 'Catch', 'Bind'],
  flag:        ['Mark', 'Sign', 'Trace', 'Habit', 'Turn'],
};
// Noun pools for a facet with no cell. It stores nothing, so the noun is keyed off the verb of one
// of its non-cost effects instead of off a cell reading.
const VERB_NOUN = {
  nullify: ['Severance', 'Cut', 'Silence'], freeze: ['Stillness', 'Pin', 'Arrest'],
  scale: ['Lean', 'Tilt', 'Swell'], add: ['Gift', 'Grant', 'Increment'],
  status: ['Mark', 'Brand', 'Touch'], veto: ['Law', 'Edict', 'Prohibition'],
  summon: ['Calling', 'Door', 'Arrival'], damage: ['Answer', 'Return', 'Retort'],
};

function nameOf(facet, cells) {
  const host = F.host();
  const h = F.hash32(F.canon(facet));
  const at = (i, n) => parseInt(h.slice(i, i + 2), 16) % n;

  const about = facet.about;
  const supplied = (host && host.words && about) ? (host.words(about.kind, about.value) || []) : [];
  const adjPool = supplied.length ? supplied : NEUTRAL_ADJ;
  const adj = adjPool[at(0, adjPool.length)];

  const lead = cells.length ? cells.slice().sort((x, y) => weightOf(y) - weightOf(x))[0] : null;
  let nounPool;
  if (lead) nounPool = NOUN[lead.reading] || NOUN.flag;
  else {
    const verbs = [];
    for (const cl of (facet.clauses || [])) for (const e of (cl.do || [])) if (!cl.cost) verbs.push(e.verb || e.emit);
    const v = verbs.length ? verbs[at(4, verbs.length)] : 'status';
    nounPool = VERB_NOUN[v] || NOUN.flag;
  }
  const noun = nounPool[at(2, nounPool.length)];
  return adj.charAt(0).toUpperCase() + adj.slice(1) + ' ' + noun;
}

function weightOf(c) { return (c.hold === 'many' ? 3 : c.hold === 'one' ? 2 : 1) + (c.clock ? 1 : 0) + (c.scorer ? 2 : 0); }

function iconOf(facet, cells) {
  const host = F.host();
  const about = facet.about;
  if (host && host.icon && about) { const i = host.icon(about.kind, about.value); if (i) return i; }
  const icons = ['✦', '🜂', '🜄', '🜃', '🜁', '◈', '❖', '⟡'];
  return icons[parseInt(F.hash32(F.canon(facet)).slice(2, 4), 16) % icons.length];
}

// ---------- fusion ----------
//
// Four structural preconditions, all checkable before the player commits: both facets present,
// neither already fused, not the same facet, both flagged fusable. Each returns { ok: false, why }
// so the interface can show the reason up front. Nothing else refuses: a failed mortality proof is
// recorded in out.witness.problems and the fusion still returns ok.
FG.fuse = function fuse(a, b) {
  if (!a || !b) return { ok: false, why: 'two facets are required' };
  if (a.fused || b.fused) return { ok: false, why: 'a fused facet cannot be fused again' };
  if (a.id === b.id) return { ok: false, why: 'a facet cannot fuse with itself' };
  if (!a.fusable || !b.fusable) return { ok: false, why: 'one of these cannot be fused' };

  const out = {
    v: 1, seed: (a.seed ^ b.seed) >>> 0, tier: Math.max(a.tier, b.tier),
    cells: [], clauses: [], lens: mergeLens(a, b),
    fused: { from: [a.id, b.id], stripped: [], yield: 0.75 },
    fusable: false,
  };

  const seen = {};
  for (const src of [a, b]) {
    for (const c of (src.cells || [])) {
      const key = seen[c.key] ? c.key + '_' + src.id.slice(3, 6) : c.key;
      seen[key] = true;
      out.cells.push(Object.assign(JSON.parse(JSON.stringify(c)), { key }));
    }
  }
  for (const src of [a, b]) {
    for (const cl of (src.clauses || [])) {
      // Cost clauses are dropped and their source ids recorded in out.fused.stripped. The
      // out.fused.yield of 0.75 above is the offsetting discount, without which two facets each
      // priced down by a drawback would fuse into one facet carrying both upsides at full value.
      if (cl.cost) { out.fused.stripped.push(src.id + ':' + cl.id); continue; }
      out.clauses.push(JSON.parse(JSON.stringify(cl)));
    }
  }
  // Mutually exclusive cells are not an error here. Two exclusive mode cells fuse into one facet
  // holding both, each keeping a distinct key via the seen[] suffix above.
  out.id = F.idOf(out);
  out.price = FG.price(out);
  const proof = F.mortal.prove(out);
  out.witness = { static: proof.ok, problems: proof.problems };
  out.reading = FG.render(out);
  return { ok: true, facet: out };
};

function mergeLens(a, b) {
  if (!a.lens && !b.lens) return null;
  const out = { shown: {}, known: {} };
  for (const src of [a, b]) if (src.lens) for (const view of ['shown', 'known']) Object.assign(out[view], src.lens[view] || {});
  return out;
}

// ---------- generation ----------
//
// Every draw below comes from mulberry32 seeded from the facet's own seed, not from the host's
// random stream. Three consequences: regenerate(seed, tier) reproduces a facet exactly, a bad roll
// can be reported by its seed and reproduced by hand, and the corpus can test generation without
// pinning the game's global randomness.
//
// There is no table of ability templates. The generator picks values for the four cell axes and the
// clauses follow from them: a cell with a real level gets a fill and a discharge, a cell holding one
// tag exclusively gets a transition and a per-state effect, a cell holding many gets a draw and a
// score. Adding a motif means adding an axis value, not another branch.
//
// subjectOf() reads the person first and the most extreme axis becomes the subject the draw is
// biased toward. A negative outlier is eligible on the same terms as a positive one.

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

FG.generate = function generate(opts) {
  opts = opts || {};
  const host = F.host();
  if (!host) return null;
  const tier = Math.max(1, Math.min(5, opts.tier || 1));
  const attempts = opts.attempts || 40;
  let seed = opts.seed === undefined ? Math.floor(host.rand() * 0xffffffff) : (opts.seed >>> 0);

  for (let i = 0; i < attempts; i++) {
    const facet = draw((seed + i * 0x9E3779B9) >>> 0, tier, opts, host);
    if (!facet) continue;
    if (opts.exclude && opts.exclude.indexOf(facet.id) >= 0) continue;
    return facet;
  }
  return null;
};

/** Reproduce a facet exactly from its stored seed and tier. */
FG.regenerate = function regenerate(seed, tier, opts) {
  return draw(seed >>> 0, tier, opts || {}, F.host());
};

function draw(seed, tier, opts, host) {
  const rnd = mulberry32(seed);
  const pick = (a) => a.length ? a[Math.floor(rnd() * a.length)] : null;
  const pickW = (a, wf) => {
    const total = a.reduce((s, x) => s + Math.max(0, wf(x)), 0);
    if (total <= 0) return pick(a);
    let r = rnd() * total;
    for (const x of a) { r -= Math.max(0, wf(x)); if (r <= 0) return x; }
    return a[a.length - 1];
  };
  const between = (lo, hi) => lo + rnd() * (hi - lo);

  const budget = F.data.BUDGET[tier];
  const subject = subjectOf(opts.person, host, rnd, pick);

  // The hook is drawn first because it sets the allowance everything else is bought from:
  // allowance = budget / CERT_PRIOR[hook], with the divisor floored at 0.02. A rare hook buys a
  // large magnitude and a constant one buys a small magnitude at the same price.
  const hooks = Object.keys(F.data.CERT_PRIOR).filter(h => hookAvailable(h, host));
  if (!hooks.length) return null;
  const hook = pickW(hooks, h => 1 / Math.max(0.05, F.data.CERT_PRIOR[h]) * 0.15 + 0.4);
  const cert = F.data.CERT_PRIOR[hook];
  const allowance = budget / Math.max(0.02, cert);

  // facet.about records the subject as { kind, value }. It is part of the hashed record, so two
  // facets with the same axes and different subjects get different ids. The reading and the name
  // are computed from it; no control flow branches on it.
  const facet = { v: 1, seed, tier, about: { kind: subject.kind, value: subject.value }, cells: [], clauses: [], lens: null, fused: null, fusable: true };

  const menu = effectMenu(host);
  if (!menu.length) return null;
  const ctxDraw = { subject, tier, allowance, rnd, pick, pickW, between, host, menu, cell: null, hook };

  // Max relation depth by tier: 1 at tier 1, 2 at tiers 2-3, 3 at tiers 4-5. Depth is roughly the
  // number of sentences the reading needs to explain the facet.
  const maxDepth = tier <= 1 ? 1 : tier <= 3 ? 2 : 3;
  const tree = drawRelation(ctxDraw, maxDepth, hook);
  if (!tree) return null;
  facet.rel = tree;

  const built = compileRelation(tree, ctxDraw, facet);
  if (!built) return null;

  // Spend the budget by repricing the facet and topping it up, rather than by predicting what an
  // effect will cost.
  //
  // An earlier version bought one effect per clause at a modest magnitude and stopped. The corpus
  // median price was 4 points against a five-star budget of 78, so the tier carried almost no
  // information: the trigger-frequency divisor computed an allowance that nothing then spent.
  //
  // FG.price() already accounts for scope, persistence tier, hook frequency, guard rates and the
  // closure size of a severed quantity, so a change to any of those changes this loop's behaviour
  // without an edit here.
  fill(facet, ctxDraw, budget);

  // 32% of facets get a cost clause, subject to CLAUSES_MAX. FG.price() negates a clause with
  // cost: true, so a drawback lowers the total and leaves room for more upside. costClause() puts
  // it on the facet's own hook half the time, so it reads as this ability's price.
  if (rnd() < 0.32 && facet.clauses.length < F.data.CLAUSES_MAX) {
    const cost = costClause(ctxDraw, facet.clauses.length);
    if (cost) facet.clauses.push(cost);
  }

  // 12% of facets hide one numeric parameter behind a lens. The lens is a field on the facet
  // record (facet.lens.shown / .known), not a special case in the renderer.
  if (rnd() < 0.12) facet.lens = hideSomething(facet, rnd, pick);

  for (const c of facet.cells) F.cellInit(c);
  facet.id = F.idOf(facet);
  facet.price = FG.price(facet);

  // Three refusals follow: failed mortality proof, price below the inert floor, price outside the
  // budget band. All three return null, so FG.generate() draws again with the next seed rather
  // than reporting that a combination was illegal.
  const proof = F.mortal.prove(facet);
  if (!proof.ok) return null;
  // The inert floor is a fraction of the tier budget (INERT_FRAC), not a constant. A constant small
  // enough to pass a tier 1 facet also passed a half-point facet at tier 5.
  if (facet.price.value < budget * F.data.INERT_FRAC) return null;
  const band = budget * F.data.BUDGET_TOLERANCE;
  if (facet.price.value < 0 || facet.price.value > budget + band) return null;

  facet.witness = { static: true, problems: [] };
  facet.reading = FG.render(facet);
  return facet;
}

// Top a facet up until its price reaches target = budget * (1 - BUDGET_TOLERANCE * 0.5), without
// passing ceiling = budget * (1 + BUDGET_TOLERANCE). Three levers, tried in that order each round:
// widen a magnitude that is already there, add an effect to a clause with room, add a whole clause.
// Widening runs first so the points concentrate in fewer clauses rather than spreading across six
// weak ones.
function fill(facet, d, budget) {
  const target = budget * (1 - F.data.BUDGET_TOLERANCE * 0.5);
  const ceiling = budget * (1 + F.data.BUDGET_TOLERANCE);
  // addClause is the third lever and closed the left tail of the price distribution. widen() stalls
  // once every magnitude sits at its MAG_CEIL entry, and addEffect() stalls once every clause holds
  // 3 effects. Before addClause existed, a facet on a rare hook with a large allowance could not be
  // brought up to its tier and shipped at about a fifth of budget.
  for (let round = 0; round < 40; round++) {
    const now = FG.price(facet).value;
    if (now >= target) break;
    if (widen(facet, d, now, ceiling)) continue;
    if (addEffect(facet, d, now, ceiling)) continue;
    if (addClause(facet, d, now, ceiling)) continue;
    break;
  }
  // If widening overshot the ceiling, shrink a magnitude, up to 12 times, instead of discarding
  // the facet.
  for (let round = 0; round < 12; round++) {
    if (FG.price(facet).value <= ceiling) break;
    if (!shrink(facet, d)) break;
  }
  return facet;
}

// Each site carries a `kind` because clampMagnitude() cannot infer one from the object. A status
// modifier is a bare { stat, op, value } with no verb on it, so an earlier version fell through to
// the generic ceiling of 40 and produced a multiplicative modifier of x20, shown on the character
// sheet as "+1894% speed".
function magnitudeSites(facet) {
  const sites = [];
  facet.clauses.forEach((cl) => (cl.do || []).forEach((e) => {
    if (cl.cost) return;                                  // a cost clause is not a spend target
    if (typeof e.value === 'number') sites.push({ e, key: 'value',
      // A stage join's value is the fraction that survives the stage, so a smaller number is a
      // stronger effect. Widening it upward like every other magnitude made it weaker, and above
      // 1.0 the pipeline clamps it to 1 so it does nothing: budget spent on an effect that was then
      // clamped away and described on the sheet as '+0% incoming damage'. The 'stageKeep' kind
      // makes widen() move it down instead.
      kind: e.emit === 'stage' ? 'stageKeep' : (e.verb === 'raise' ? 'raiseMult' : 'q'), verb: e.verb, q: e.q });
    if (typeof e.intensity === 'number') sites.push({ e, key: 'intensity', kind: 'intensity' });
    if (e.def && e.def.dot && typeof e.def.dot.flat === 'number') sites.push({ e: e.def.dot, key: 'flat', kind: 'dot' });
    if (e.def && e.def.retaliate && typeof e.def.retaliate.flat === 'number') sites.push({ e: e.def.retaliate, key: 'flat', kind: 'dot' });
    if (e.def && e.def.mods) e.def.mods.forEach(m => {
      if (typeof m.value === 'number') sites.push({ e: m, key: 'value', kind: m.op === 'mult' ? 'modMult' : 'modAdd', stat: m.stat });
    });
    if (e.def && e.def.overrideRes) {
      const t = Object.keys(e.def.overrideRes)[0];
      const spec = e.def.overrideRes[t];
      if (spec && typeof spec.to === 'number') sites.push({ e: spec, key: 'to', kind: 'res' });
    }
  }));
  return sites;
}

// Try every magnitude site, in shuffled order, before reporting failure. Trying one site and giving
// up held the corpus median at about a tenth of budget: a single site that overshot the ceiling
// ended the whole fill, leaving most facets at whatever their first draw happened to cost.
function widen(facet, d, now, ceiling) {
  const sites = magnitudeSites(facet);
  if (!sites.length) return false;
  for (let i = sites.length - 1; i > 0; i--) { const j = Math.floor(d.rnd() * (i + 1)); const t = sites[i]; sites[i] = sites[j]; sites[j] = t; }
  for (const s of sites) {
    const before = s.e[s.key];
    // A scale value below 1, and any stageKeep value, is a reduction: it gets stronger by moving
    // down, so it is multiplied by 0.85 rather than by 1.35.
    const isReduction = s.kind === 'stageKeep' || (s.kind === 'q' && s.verb === 'scale' && before > 0 && before < 1);
    const next = isReduction ? Math.max(0.05, before * 0.85) : before * 1.35;
    const capped = clampMagnitude(s, next, isReduction);
    if (capped === before) continue;                       // already at its ceiling: try another site
    s.e[s.key] = +capped.toFixed(3);
    if (FG.price(facet).value <= ceiling) return true;
    s.e[s.key] = before;
  }
  return false;
}

// Ceilings per kind of magnitude. These are a sanity bound on top of the pricer, not a substitute
// for it: the runaway multipliers came from the flat spot in magnitudeFactor() and are fixed there.
// A number that reads as absurd on a character sheet is still a problem when it is priced
// correctly, and this check is cheap.
//
// One shared ceiling does not work, because the kinds are different quantities. A multiplicative
// status modifier of 19 is a twentyfold change; a per-tick damage-over-time of 19 ends a fight in
// about three seconds.
const MAG_CEIL = {
  q_scale: 6,        // multiplier, x6 at most
  q_addProb: 0.9,    // a probability or multiplier slot: +90 points
  q_addFlat: 40,
  intensity: 10,
  raise: 3,          // a cap quantity may be tripled at most
  modMult: 3,        // +300% through a status modifier
  modAdd: 2,
  modAddRes: 0.9,    // a resistance is a fraction: +0.9 is near the cap the host enforces
  dot: 2,            // per tick, and the host multiplies it again by its own DOT scale
  res: 0.95,         // an override-to value, a fraction by definition
  generic: 40,
};

function clampMagnitude(s, next, isReduction) {
  switch (s.kind) {
    // Floored at MORTALITY.MIN_ENGINE_MULT: the pipeline clamps a smaller keep-fraction to that
    // value at resolution time, so spending below it buys nothing.
    case 'stageKeep': return Math.max(F.data.MORTALITY.MIN_ENGINE_MULT, Math.min(1, next));
    // A cap multiplier, floored at 1. Below 1 the verb 'raise' would lower the ceiling instead.
    case 'raiseMult': return Math.max(1, Math.min(MAG_CEIL.raise, next));
    case 'intensity': return Math.min(MAG_CEIL.intensity, next);
    case 'modMult':   return Math.min(MAG_CEIL.modMult, next);
    case 'modAdd':    return Math.min(String(s.stat).indexOf('res:') === 0 ? MAG_CEIL.modAddRes : MAG_CEIL.modAdd, next);
    case 'dot':       return Math.min(MAG_CEIL.dot, next);
    case 'res':       return Math.min(MAG_CEIL.res, next);
    case 'q': {
      if (s.verb === 'scale') return isReduction ? Math.max(0.05, next) : Math.min(MAG_CEIL.q_scale, next);
      if (s.verb === 'add') {
        const q = F.registry.def(s.q);
        return Math.min((q && (q.kind === 'prob' || q.kind === 'mult')) ? MAG_CEIL.q_addProb : MAG_CEIL.q_addFlat, next);
      }
      return Math.min(MAG_CEIL.generic, next);
    }
    default: return Math.min(MAG_CEIL.generic, next);
  }
}

function shrink(facet, d) {
  const sites = magnitudeSites(facet);
  if (!sites.length) return false;
  const s = d.pick(sites);
  const isReduction = s.kind === 'stageKeep' || (s.kind === 'q' && s.verb === 'scale' && s.e[s.key] > 0 && s.e[s.key] < 1);
  s.e[s.key] = +(isReduction ? Math.min(0.95, s.e[s.key] / 0.85) : s.e[s.key] / 1.35).toFixed(3);
  return true;
}

function addEffect(facet, d, now, ceiling) {
  const open = facet.clauses.filter(cl => !cl.cost && cl.do.length < 3);
  if (!open.length) return false;
  // Try each clause with room, not one at random; same reason as in widen().
  for (let attempt = 0; attempt < open.length * 3; attempt++) {
    const cl = d.pick(open);
    const eff = buyEffect(d, Math.max(4, ceiling - now));
    if (!eff) continue;
    // Reject an effect whose shape matches one already in the clause. The fill loop may buy a
    // second effect to reach the tier's budget, but without this check it produced clauses reading
    // "sever a random enemy stat | sever a random enemy stat".
    if (cl.do.some(x => sameShape(x, eff))) continue;
    cl.do.push(eff);
    if (FG.price(facet).value <= ceiling) return true;
    cl.do.pop();
  }
  return false;
}

// Two effects have the same shape when they would render as the same line: same emit, same verb,
// and same quantity (or same set of StatusDef field names). Differing magnitudes still count as a
// repeat.
function sameShape(a, b) {
  if (a.emit !== b.emit) return false;
  if ((a.verb || null) !== (b.verb || null)) return false;
  if (a.emit === 'quantity') return (a.q || null) === (b.q || null) || (!!a.query && !!b.query);
  if (a.emit === 'status') {
    const fa = a.def ? Object.keys(a.def).filter(k => k !== 'id').sort().join(',') : '';
    const fb = b.def ? Object.keys(b.def).filter(k => k !== 'id').sort().join(',') : '';
    return fa === fb;
  }
  return true;
}

// Add a whole clause, on a hook the facet is not already listening to. Distinct hooks let a
// high-tier facet grow by adding behaviour instead of by repeating a line it already has.
function addClause(facet, d, now, ceiling) {
  if (facet.clauses.length >= F.data.CLAUSES_MAX) return false;
  const taken = facet.clauses.map(c => (typeof c.on === 'string' ? c.on : c.on.at));
  const hooks = Object.keys(F.data.CERT_PRIOR).filter(h => hookAvailable(h, d.host) && taken.indexOf(h) < 0);
  if (!hooks.length) return false;
  for (let attempt = 0; attempt < 6; attempt++) {
    const hook = d.pick(hooks);
    const cl = { id: 'c' + (facet.clauses.length + 1), on: hook, when: guardFor(d, 0.35), do: [buyEffect(d, Math.max(6, ceiling - now))] };
    facet.clauses.push(cl);
    if (FG.price(facet).value <= ceiling) return true;
    facet.clauses.pop();
  }
  return false;
}

// ---------- drawing a relation tree ----------
//
// An effect slot is filled with a leaf or with another relation. The choice is a weighted draw that
// falls off with remaining depth. Nesting is what makes the set of reachable structures
// combinatorial rather than one structure per entry in R.TABLE.
function drawRelation(d, depth, hook) {
  const R = F.relations;
  const ids = R.IDS.filter(id => relationAvailable(id, d.host));
  if (!ids.length) return null;
  const rel = d.pickW(ids, id => R.TABLE[id].weight);
  const def = R.TABLE[rel];

  const node = { rel, args: [], slots: {} };
  for (const slot of def.slots) {
    if (slot === R.SLOTS.TRIGGER) {
      node.slots.trigger = node.slots.trigger || hook || d.pick(triggerHooks(d.host));
      continue;
    }
    if (slot === R.SLOTS.RESOURCE) { node.slots.resource = pickResource(d); continue; }
    if (slot === R.SLOTS.TYPE) { node.slots.type = elementFor(d); continue; }
    // An effect slot: either a leaf or a nested relation. Nesting requires depth > 1, and its
    // probability rises with remaining depth as 0.55 - 0.12 * (3 - depth).
    const nest = depth > 1 && d.rnd() < (0.55 - 0.12 * (3 - depth));
    node.args.push(nest ? drawRelation(d, depth - 1, null) : { leaf: true });
  }
  node.slots.type = node.slots.type || elementFor(d);
  return node;
}

function relationAvailable(id, host) {
  // The `ward` relation compiles to a damage-pipeline clause. Without F.pipeline.live that clause
  // never fires, so the facet would be priced and described for an effect that does nothing.
  if (id === 'ward') return F.pipeline.live;
  return true;
}

function triggerHooks(host) {
  return ['event:onHit', 'event:damageTaken', 'event:onCrit', 'event:onParry', 'event:onDodge', 'event:onKill'];
}

function pickResource(d) {
  // A quantity the bearer owns and can run out of. Kinds 'pool', 'prob' and 'rate' are preferred
  // over the rest of the writable set, and vitality quantities are weighted to 0. A resource the
  // player never looks at makes the cost a rounding error.
  const pool = F.registry.query({ writable: true, sealed: false, notKind: ['mode', 'cap', 'attribute'] });
  const spendable = pool.filter(q => q.kind === 'pool' || q.kind === 'prob' || q.kind === 'rate');
  const q = d.pickW(spendable.length ? spendable : pool, x => x.mortalRole === 'vitality' ? 0 : domainFit(d, x));
  return q ? q.id : 'fighter.speed';
}

function elementFor(d) {
  if (d.subject.kind === 'element') return d.subject.value;
  const v = d.host.vocabulary('element') || [];
  return v.length ? d.pickW(v, x => affinityTo(d.subject, x, d.host)) : 'arcane';
}

// Compile the tree into ordinary cells and clauses. Nothing downstream reads facet.rel: the engine,
// the saver, FG.price() and the mortality proof see the same cell and clause records they see for a
// facet built without a relation tree.
function compileRelation(node, d, facet, depth) {
  depth = depth || 0;
  if (!node || node.leaf) return null;
  const def = F.relations.TABLE[node.rel];
  if (!def) return null;

  let n = 0;
  const c = {
    key: (base) => base + (facet.cells.length + 1),
    int: (lo, hi) => Math.round(d.between(lo, hi)),
    num: (lo, hi) => +d.between(lo, hi).toFixed(2),
    capExpr: (lo, hi) => ({ expr: 'mul', a: { q: 'fighter.maxHpAbs' }, b: +d.between(lo, hi).toFixed(2) }),
    cell: (key, spec) => F.cellInit(Object.assign({
      key, hold: 'none', level: 'none', clock: false, exclusive: false, tags: null,
      cap: null, floor: 0, decay: 0, step: 1, tier: 'encounter', scope: { side: 'self' },
      epistemic: 'open', scorer: null, element: node.slots.type,
    }, spec)),
    ordinal: (k) => (k === 3 ? 'rd' : k === 2 ? 'nd' : 'th'),
    plain: (hook) => (F.data.HOOK_PHRASE[hook] || 'it').toLowerCase(),
    label: (qid) => { const q = F.registry.def(qid); return q ? q.label.toLowerCase() : 'something'; },
    // An argument becomes either a sub-relation's clauses, or a leaf effect bought from the menu.
    effects: (arg, hint) => {
      const h = Object.assign({ role: def.role }, hint || {});
      if (arg && arg.rel) {
        const sub = compileRelation(arg, d, facet, depth + 1);
        return sub && sub.inline ? sub.inline : [buyEffect(d, d.allowance * 0.6, h)];
      }
      const e = buyEffect(d, d.allowance * (depth ? 0.6 : 1), h);
      return e ? [e] : [];
    },
  };

  const a = {
    trigger: node.slots.trigger || d.hook,
    triggerGuard: null,
    resource: node.slots.resource,
    type: node.slots.type,
    effect: node.args[0] || { leaf: true },
    effect2: node.args[1] || { leaf: true },
  };

  const out = def.emit(a, c);
  if (!out) return null;
  for (const cell of (out.cells || [])) facet.cells.push(cell);
  for (const cl of (out.clauses || [])) {
    if (!cl.do || !cl.do.length) continue;
    facet.clauses.push(Object.assign({ id: 'c' + (facet.clauses.length + 1) }, cl));
  }
  if (out.veil) facet.lens = { shown: {}, known: {} };
  node.read = out.read;
  return { inline: null };
}

const SHAPE_WEIGHT = {
  plain:       (t) => 5 - t * 0.6,
  accumulator: (t) => 1 + t * 0.5,
  counter:     (t) => 1.5 + t * 0.2,
  mode:        (t) => Math.max(0, t - 1.5),
  collection:  (t) => Math.max(0, t - 2),
  latch:       (t) => Math.max(0, t - 1),
};

// ---------- the subject ----------
//
// What the facet is about. Read from host.outliers(person) when a person and that adapter member
// are both available; otherwise a random element from the host's element vocabulary.
function subjectOf(person, host, rnd, pick) {
  const elements = host.vocabulary('element') || [];
  const fallback = () => ({ kind: 'element', value: pick(elements), z: 0, tag: 'element:' + pick(elements) });
  if (!person || !host.outliers) return fallback();
  const out = host.outliers(person);
  if (!out || !out.length) return fallback();

  // Take the highest |z| candidate per kind, then draw between kinds.
  //
  // A flat draw over the raw outlier list is biased by how many axes each kind contributes. There
  // are five temperament axes, each standardised against a spread that regularly exceeds z = 2,
  // while a path or an innate weapon is a single categorical fact at about z = 1. Temperament wins
  // on both count and magnitude, and a corpus drawn that way was roughly 400 abilities about
  // somebody's nerve and almost none about fire. One candidate per kind removes the count
  // advantage, so the axis a facet is about does not depend on how many axes of each sort the game
  // happens to keep.
  const best = {};
  for (const o of out) {
    const k = o.kind;
    if (!best[k] || Math.abs(o.z) > Math.abs(best[k].z)) best[k] = o;
  }
  const cands = Object.keys(best).map(k => best[k]);
  const total = cands.reduce((s, o) => s + weightOfKind(o), 0) || 1;
  let r = rnd() * total;
  for (const o of cands) { r -= weightOfKind(o); if (r <= 0) return o; }
  return cands[0];
}

// Element (2.6) and path (2.0) weigh heaviest: the reading names them directly, while a facet grown
// out of a dexterity score has to be explained. Temperament sits at 1.0, but weightOfKind() also
// scales by |z| capped at 2.5, so an extreme temperament still competes.
const KIND_WEIGHT = { element: 2.6, path: 2.0, trait: 1.8, weapon: 1.5, class: 1.4, temper: 1.0, stat: 0.8 };
function weightOfKind(o) { return (KIND_WEIGHT[o.kind] || 1) * (0.6 + Math.min(2.5, Math.abs(o.z)) * 0.5); }

// Draw weight for how near a candidate value is to the subject: exact match 6, the SEAM_OPPOSITE
// value 3, same host channel group 2.2, anything else 1. Unrelated values keep a non-zero weight,
// so the draw can still cross groups.
function affinityTo(subject, value, host) {
  if (!subject || value === null || value === undefined) return 1;
  if (subject.value === value) return 6;
  const opp = F.data.SEAM_OPPOSITE[subject.value];
  if (opp === value) return 3;
  const chans = host.channels();
  const a = chans.filter(c => c.id === subject.value)[0];
  const b = chans.filter(c => c.id === value)[0];
  if (a && b && a.group === b.group) return 2.2;
  return 1;
}

// ---------- cells ----------
function makeCell(shape, subject, tier, rnd, pick, between, host) {
  const key = shape.slice(0, 4) + (Math.floor(rnd() * 90) + 10);
  const base = {
    key, hold: 'none', level: 'none', clock: false, exclusive: false,
    tags: null, cap: null, floor: 0, decay: 0, step: 1,
    tier: pickTier(tier, rnd), scope: { side: 'self' }, epistemic: 'open', scorer: null,
    element: subject.kind === 'element' ? subject.value : null,
  };
  const elements = host.vocabulary('element') || [];

  switch (shape) {
    case 'accumulator':
      base.level = 'real';
      // The cap is an Expr relative to fighter.maxHpAbs, 0.2 to 0.6 of it, not an absolute number.
      // An absolute cap would be balanced in one host and wrong in another; psionic.js carries a
      // portScale constant for the same reason.
      base.cap = { expr: 'mul', a: { q: 'fighter.maxHpAbs' }, b: +between(0.2, 0.6).toFixed(2) };
      base.decay = rnd() < 0.4 ? +between(0.002, 0.02).toFixed(3) : 0;
      break;
    case 'counter':
      base.level = 'int';
      base.cap = Math.round(between(4, 20));
      break;
    case 'mode': {
      base.hold = 'one'; base.exclusive = true;
      const n = 2 + (rnd() < 0.3 ? 1 : 0);
      // Weighted draw without replacement, not a sort. Array sort is stable, so when the subject is
      // not an element every candidate scores the same affinity and the sort leaves the host's own
      // order intact: every mode facet then held the first two damage types in the host's list.
      const pool = elements.slice();
      base.tags = [];
      for (let k = 0; k < n && pool.length; k++) {
        const weights = pool.map(v => affinityTo(subject, v, host));
        const total = weights.reduce((a, b) => a + b, 0);
        let r = rnd() * total, idx = pool.length - 1;
        for (let j = 0; j < pool.length; j++) { r -= weights[j]; if (r <= 0) { idx = j; break; } }
        base.tags.push(pool.splice(idx, 1)[0]);
      }
      base.cooldown = Math.round(between(10, 40));
      break;
    }
    case 'collection':
      base.hold = 'many'; base.level = 'int';
      base.cap = Math.round(between(3, 6));
      base.tags = rnd() < 0.5 ? { deck: 'core:ranked' } : { from: 'kill.tags' };
      base.scorer = base.tags.deck ? { id: 'poker' } : { id: 'diminish', a: Math.round(between(3, 8)) };
      break;
    case 'latch':
      base.clock = true; base.hold = 'many'; base.level = 'none';
      base.cap = Math.round(between(1, 3));
      break;
    default: break;
  }
  return base;
}

function pickTier(tier, rnd) {
  const r = rnd();
  if (tier >= 4 && r < 0.12) return 'mission';
  if (r < 0.10) return 'tick';
  return 'encounter';
}

// ---------- clauses ----------
function buildForShape(facet, shape, d) {
  const cell = d.cell;
  const key = cell.key;
  let n = 0;
  const id = () => 'c' + (++n);

  switch (shape) {
    case 'accumulator': {
      // Fills on event:damageTaken, guarded on the incoming damage type, and empties at cap. That
      // hook is used because the added value is { frame: 'amount' }, which only a hook carrying the
      // blow can supply.
      //
      // The accepted element is written back to cell.element, so the reading and the clause guard
      // state the same type. Without that write the reading named the cell's original element while
      // the guard accepted a different one.
      const fill = d.subject.kind === 'element' ? d.subject.value
        : d.pickW(d.host.vocabulary('element'), v => affinityTo(d.subject, v, d.host));
      cell.element = fill;
      facet.clauses.push({
        id: id(), on: 'event:damageTaken',
        when: { frame: 'damageType', op: 'eq', v: fill },
        do: [{ emit: 'cell', cell: key, verb: 'add', value: { frame: 'amount' } }],
      });
      // The discharge clause is authored rather than drawn from the menu. At cap: deal the stored
      // value as damage to all enemies, then reset the cell to 0. The stored value is in the host's
      // damage units, the same units it accumulated in. fill() may still add drawn effects here.
      facet.clauses.push({
        id: id(), on: 'cell:' + key + ':cap', when: null,
        do: [{ emit: 'world', verb: 'damage', damageType: cell.element || d.subject.value,
               value: { cell: key, of: 'v' }, scope: { side: 'enemy', n: null, exclude: ['self'] } },
             { emit: 'cell', cell: key, verb: 'reset' }],
      });
      break;
    }
    case 'counter': {
      facet.clauses.push({
        id: id(), on: d.hook, when: guardFor(d, 0.4),
        do: [{ emit: 'cell', cell: key, verb: 'add', value: 1 }],
      });
      facet.clauses.push({
        id: id(), on: 'tick', when: { cell: key, of: 'n', op: 'gte', v: 1 },
        do: [buyEffect(d, d.allowance, { magnitude: { curve: 'diminish', of: { cell: key, of: 'v' }, a: 4 } })],
      });
      break;
    }
    case 'mode': {
      // One enter clause per tag on the facet's hook, plus a tick clause gated on being in the
      // first tag. "Never two at once" is the cell's `exclusive` axis, enforced by the cell rather
      // than by these clauses.
      for (const tag of cell.tags) {
        facet.clauses.push({
          id: id(), on: d.hook, when: { chance: +d.between(0.2, 0.5).toFixed(2) },
          do: [{ emit: 'cell', cell: key, verb: 'enter', arg: tag }],
        });
      }
      facet.clauses.push({
        id: id(), on: 'tick', when: { cell: key, of: 'at', op: 'eq', v: cell.tags[0] },
        do: [buyEffect(d, d.allowance * 0.6)],
      });
      break;
    }
    case 'collection': {
      facet.clauses.push({
        id: id(), on: d.hook, when: guardFor(d, 0.35),
        do: [{ emit: 'cell', cell: key, verb: 'draw', arg: { n: cell.tags && cell.tags.deck ? cell.cap : 1, from: cell.tags } },
             { emit: 'cell', cell: key, verb: 'score' }],
      });
      facet.clauses.push({
        id: id(), on: 'cell:' + key + ':score', when: null,
        do: [buyEffect(d, d.allowance, { magnitude: { cell: key, of: 'v' } })],
      });
      break;
    }
    case 'latch': {
      facet.clauses.push({
        id: id(), on: d.hook, when: guardFor(d, 0.3),
        do: [{ emit: 'cell', cell: key, verb: 'latch', arg: { ticks: Math.round(d.between(10, 40)) } },
             buyEffect(d, d.allowance, { onTarget: true, timed: true })],
      });
      break;
    }
    default: break;
  }
}

// ---------- domains ----------
//
// A town hook changing a combat quantity is invisible in play, and a combat hook changing a
// temperament quantity is off the moment. Both are valid records that the legality pass cannot
// reject, so the draw is weighted instead: domainFit() scores a quantity in the hook's own domain
// at 4 and one in the other domain at 1. Crossover stays reachable, so "hurt me and my mood sours"
// can still be generated.
const TOWN_NS = ['cond', 'temper', 'prof', 'bond', 'town'];
const TOWN_HOOKS = ['event:townTick', 'tier:calendar', 'tier:mission'];

function domainOf(hook) { return TOWN_HOOKS.indexOf(hook) >= 0 ? 'town' : 'combat'; }
function nsDomain(q) { return TOWN_NS.indexOf(q.namespace) >= 0 ? 'town' : 'combat'; }
function domainFit(d, q) { return domainOf(d.hook) === nsDomain(q) ? 4 : 1; }

// ---------- the effect menu ----------
//
// Only what this host can currently do. A verb whose capability flag is off, or whose module is not
// live, is absent from the menu, so a facet is never generated in a degraded form: an ability that
// needs the calendar is not generated at all on a host without one.
//
// Each entry carries a role, so a relation can ask for the kind of effect its slot needs:
//
//   burst    happens at one moment and is over: damage, a discharge, an application
//   hold     persists while something is true: a modifier, a resistance, a mitigation
//   deny     takes something away from somebody else
//
// Before roles existed, the `until` relation rendered a release and its payload slot accepted any
// effect at all, so a facet could read as a discharge and deliver "+500% max hp mult". A relation
// now names the role each slot needs and buyEffect() filters the draw to it. The role is a property
// of the menu entry, not of the relation, so adding a verb costs one tag and every relation can use
// it.
function effectMenu(host) {
  const menu = [];
  const caps = host.caps || {};

  const severable = F.registry.query({ nullifiable: true, notKind: ['pool', 'attribute'], gating: true });
  if (severable.length) menu.push({ kind: 'sever', w: 2.5, role: 'deny' });

  const writable = F.registry.query({ writable: true, sealed: false, notKind: ['mode'] });
  if (writable.length) menu.push({ kind: 'scale', w: 5, role: 'hold' }, { kind: 'addq', w: 3, role: 'hold' }, { kind: 'freeze', w: 1.5, role: 'deny' });

  // Raising a cap quantity. Weight 1.2, against 5 for scale and 6 for status, so it stays rare:
  // pushing a limit past where the rest of the game expects it should be one ability in a roster.
  const raisable = F.registry.query({ writable: true, sealed: false, kind: 'cap' });
  if (raisable.length) menu.push({ kind: 'raise', w: 1.2, role: 'hold' });

  menu.push({ kind: 'status', w: 6, role: 'hold' });
  // The only always-available entry with role 'burst' (summon is the other one, gated on
  // caps.summon). Without it, a slot asking for a burst fell back to the whole menu in buyEffect()
  // and a relation that rendered a release delivered a modifier.
  menu.push({ kind: 'burst', w: 5, role: 'burst' });

  if (F.pipeline.live) menu.push({ kind: 'stage', w: 4, role: 'hold' });
  if (F.gate.live && caps.laws) menu.push({ kind: 'law', w: 2, role: 'deny' });
  if (caps.summon) menu.push({ kind: 'summon', w: 2, role: 'burst' });
  return menu;
}

function buyEffect(d, allowance, hint) {
  hint = hint || {};
  const host = d.host;
  // hint.role filters the menu to entries carrying that role. If no entry has it, the draw falls
  // back to the whole menu rather than returning null: a relation with a slightly wrong argument
  // still generates, a null here fails the facet.
  const wanted = hint.role ? d.menu.filter(m => m.role === hint.role) : d.menu;
  const choice = d.pickW(wanted.length ? wanted : d.menu, m => m.w);
  const scale = Math.max(0.15, Math.min(3, allowance / 30));

  switch (choice.kind) {
    case 'sever': {
      const pool = F.registry.query({ nullifiable: true, notKind: ['pool', 'attribute', 'cap'], gating: true });
      // The registry query is stored on the effect alongside the resolved q, so a facet rolled
      // today also reaches a matching quantity the host registers later.
      return { emit: 'quantity', verb: 'nullify',
               query: { nullifiable: true, notKind: ['pool', 'attribute'], gating: true, n: 1 },
               scope: { side: 'enemy', rank: d.pick(host.rankers()), n: 1 },
               seconds: +d.between(0.5, 2).toFixed(1),
               q: d.pick(pool).id };
    }
    case 'scale': {
      const pool = F.registry.query({ writable: true, sealed: false, notKind: ['mode', 'cap'] });
      const q = d.pickW(pool, x => x.mortalRole === 'vitality' ? 0 : domainFit(d, x));
      const up = d.rnd() < 0.7;
      // hint.magnitude is deliberately not read here. It is a stored amount in the host's damage
      // units, meaningful as damage and not as a multiplier; routing it into this slot produced
      // "= stored dark resistance", a hit-point count rendered as a percentage.
      return { emit: 'quantity', verb: 'scale', q: q.id,
               value: +(up ? d.between(1.1, 1 + 0.6 * scale) : d.between(0.4, 0.9)).toFixed(2),
               scope: up ? { side: 'self' } : { side: 'enemy', n: 1 },
               seconds: +d.between(1, 6).toFixed(1) };
    }
    case 'addq': {
      const probs = F.registry.query({ writable: true, sealed: false, kind: 'prob' });
      const any = F.registry.query({ writable: true, sealed: false, notKind: ['mode', 'cap'] });
      const pool = probs.length ? probs : any;
      const q = d.pickW(pool, x => domainFit(d, x));
      return { emit: 'quantity', verb: 'add', q: q.id,
               value: +d.between(0.02, 0.12 * scale).toFixed(3),
               scope: { side: 'self' }, seconds: +d.between(1, 5).toFixed(1) };
    }
    case 'freeze': {
      const pool = F.registry.query({ writable: true, sealed: false, notKind: ['mode', 'pool', 'cap'] });
      return { emit: 'quantity', verb: 'freeze', q: d.pickW(pool, x => domainFit(d, x)).id,
               scope: { side: 'enemy', n: 1 }, seconds: +d.between(0.5, 2).toFixed(1) };
    }
    case 'raise': {
      const pool = F.registry.query({ writable: true, sealed: false, kind: 'cap' });
      if (!pool.length) return null;
      const q = d.pickW(pool, x => domainFit(d, x));
      // A multiplier on the existing ceiling, 1.15 to 1.6, never an absolute value. See the note in
      // the registry.
      return { emit: 'quantity', verb: 'raise', q: q.id,
               value: +d.between(1.15, 1.6).toFixed(2),
               scope: { side: 'self' }, seconds: +d.between(20, 90).toFixed(1) };
    }
    case 'law': {
      const field = d.pick(['damageClass', 'element', 'kind', 'school']);
      const vocab = host.vocabulary(field);
      if (!vocab || !vocab.length) return { emit: 'status', def: { id: null } };
      return { emit: 'law', when: { act: field, op: 'eq', v: d.pickW(vocab, v => affinityTo(d.subject, v, host)) },
               seconds: +d.between(3, 12).toFixed(1),
               penalty: { hpFrac: +Math.max(F.data.MORTALITY.MIN_DEFIANCE, d.between(0.02, 0.06)).toFixed(3) } };
    }
    case 'summon': {
      return { emit: 'world', verb: 'summon', tagQuery: { any: [d.subject.value] },
               seconds: +d.between(5, 15).toFixed(1), scale: +d.between(0.5, 1).toFixed(2),
               scope: { side: 'self' } };
    }
    // Damage to all enemies at the moment the clause fires. When hint.magnitude is present it is
    // the stored cell value, so the released amount equals what was accumulated.
    case 'burst': {
      return { emit: 'world', verb: 'damage',
               damageType: d.subject.kind === 'element' ? d.subject.value : d.pickW(host.vocabulary('element') || [], v => affinityTo(d.subject, v, host)),
               value: hint.magnitude ? hint.magnitude : +d.between(2, 8).toFixed(1),
               scope: { side: 'enemy', n: null, exclude: ['self'] } };
    }
    case 'stage': {
      const stages = host.stages().filter(s => s.joinable !== false && !s.sealed);
      const st = d.pick(stages);
      if (!st) return null;
      return { emit: 'stage', at: st.id, verb: d.rnd() < 0.8 ? 'after' : 'before',
               value: +d.between(0.45, 0.88).toFixed(2),
               scope: { side: 'self' }, seconds: +d.between(2, 8).toFixed(1) };
    }
    default: {
      // A status assembled from the fields the host declared in statusSchema(). The set of statuses
      // this branch can produce grows whenever the host declares one more field.
      return statusEffect(d, hint, scale);
    }
  }
}

function statusEffect(d, hint, scale) {
  const host = d.host;
  const schema = host.statusSchema();
  const has = (f) => !!schema.fields[f];
  const el = d.subject.kind === 'element' ? d.subject.value : d.pickW(host.vocabulary('element') || [], v => affinityTo(d.subject, v, host));
  const def = { id: 'fs_' + Math.floor(d.rnd() * 0xffffff).toString(16), name: null, icon: null, element: el, stacking: { mode: 'highest' }, worth: 0 };

  const roll = d.rnd();
  const modPool = F.registry.all().filter(q => q.modStat && q.writable && !q.sealed);
  if (roll < 0.4 && has('mods') && modPool.length) {
    const q = d.pick(modPool);
    def.mods = [{ stat: q.modStat, op: d.pick(q.modOps), value: +d.between(0.05, 0.3 * scale).toFixed(3) }];
  } else if (roll < 0.65 && has('dot')) {
    def.dot = { type: el, flat: +d.between(0.05, 0.4 * scale).toFixed(3) };
  } else if (roll < 0.85 && has('overrideRes')) {
    const target = d.rnd() < 0.6 ? el : d.pick(host.vocabulary('element'));
    def.overrideRes = {}; def.overrideRes[target] = { to: +d.between(0.3, 0.75).toFixed(2) };
  } else if (has('retaliate')) {
    def.retaliate = { type: el, flat: +d.between(0.1, 0.5 * scale).toFixed(3) };
  } else if (has('mods') && modPool.length) {
    const q = d.pick(modPool);
    def.mods = [{ stat: q.modStat, op: d.pick(q.modOps), value: +d.between(0.05, 0.2).toFixed(3) }];
  }

  return { emit: 'status', def, seconds: +d.between(2, 8).toFixed(1),
           intensity: 1,
           scope: hint.onTarget ? { side: 'enemy', n: 1 } : { side: 'self' } };
}

// ---------- guards and costs ----------
function guardFor(d, p) {
  if (d.rnd() > p) return null;
  const r = d.rnd();
  if (r < 0.35) return { chance: +d.between(0.15, 0.6).toFixed(2) };
  if (r < 0.6) return { q: 'fighter.hp', of: 'self', op: 'lte', v: { expr: 'mul', a: { q: 'fighter.maxHpAbs' }, b: +d.between(0.25, 0.6).toFixed(2) } };
  if (r < 0.8 && d.cell) return { cell: d.cell.key, of: 'n', op: 'gte', v: Math.round(d.between(1, 3)) };
  return { event: d.pick(['onCrit', 'onParry', 'onDodge', 'onHit']), within: Math.round(d.between(10, 40)) };
}

// A cost clause: one scale-down of a writable quantity, with vitality quantities weighted to 0. Its
// hook is the facet's own hook half the time and 'tick' otherwise, so it reads as this ability's
// price rather than as an unrelated tax. FG.price() negates a clause with cost: true, so it
// subtracts from the total and lets the upside go further.
function costClause(d, n) {
  const pool = F.registry.query({ writable: true, sealed: false, notKind: ['mode'] });
  const q = d.pickW(pool, x => x.mortalRole === 'vitality' ? 0 : 1);
  if (!q) return null;
  return {
    id: 'c' + (n + 1), on: d.rnd() < 0.5 ? 'tick' : d.hook, when: guardFor(d, 0.3), cost: true,
    do: [{ emit: 'quantity', verb: 'scale', q: q.id, value: +d.between(0.6, 0.92).toFixed(2),
           scope: { side: 'self' }, seconds: +d.between(2, 8).toFixed(1) }],
  };
}

function hideSomething(facet, rnd, pick) {
  const paths = [];
  facet.clauses.forEach((cl, i) => (cl.do || []).forEach((e, j) => {
    if (typeof e.value === 'number') paths.push('clauses.' + i + '.do.' + j + '.value');
  }));
  if (!paths.length) return null;
  const p = pick(paths);
  const shown = {}; shown[p] = null;
  return { shown, known: shown };
}

function hookAvailable(hook, host) {
  if (hook.indexOf('stage:') === 0) return F.pipeline.live && host.stages().some(s => 'stage:' + s.id === hook && s.joinable !== false);
  if (hook.indexOf('gate:') === 0) return F.gate.live;
  if (hook.indexOf('cell:') === 0) return false;      // wired by the shape builder, never drawn
  if (hook === 'tier:calendar') return !!(host.caps && host.caps.calendar);
  if (hook === 'tier:mission') return !!(host.caps && host.caps.mission);
  return true;
}
})();
