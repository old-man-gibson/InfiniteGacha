// The compiler: a facet record becomes hooks, status definitions and effect thunks.
//
// Two jobs.
//
// 1. Index the clauses by hook so the dispatcher is a map lookup rather than a scan, expand sugar,
//    and convert authored seconds into the host's ticks.
//
// 2. Compile `emit:'status'` into a status definition registered in the host's own status table,
//    validated against a field schema the host declares. Without this the engine could only emit
//    statuses the host had already hand-written. This game's hand-written statuses use about twenty
//    mechanism fields a generator would otherwise never touch: overrideRes, converts, amplifies,
//    capOverrides, grafts, tends, magnetism, bar.onFill, retaliate, healCap, expiresTo. Each of
//    those becomes generable once the host describes it in statusSchema(), with no edit to core.
//    Same mechanism as the quantity registry, applied to status fields instead of to numbers.
//
// Generated status definitions are never serialised. They are rebuilt from the facet record at load,
// so changing this compiler needs no save migration in either game.

(() => {
const F = (globalThis.Facet || (globalThis.Facet = { _mods: {} }));
F._mods.compile = true;

F.compile = function compile(facet, host) {
  if (!facet || !facet.clauses) return null;
  const tps = host.ticksPerSecond || 10;
  const out = { facet, hooks: {}, defs: [], joins: [], rules: [], offers: [], overrides: [] };

  for (const cell of (facet.cells || [])) {
    F.cellInit(cell);
    if (cell.reading === undefined) cell.reading = F.cellReading(cell);
    // A cell with a magnitude (level !== 'none') or a set (hold === 'many') gets a carrier status.
    // The cell's number has to live on a status for the source game's stat cache to see it change.
    if (cell.level !== 'none' || cell.hold === 'many') {
      out.defs.push(carrierDef(facet, cell, host));
    }
  }

  for (const raw of facet.clauses) {
    const clause = expandSugar(raw, facet, host);
    const hook = hookId(clause.on);
    const compiled = {
      id: clause.id,
      when: clause.when || null,
      once: clause.once || null,
      cost: !!clause.cost,
      do: clause.do.map(e => normaliseEffect(e, facet, host, tps, out)),
    };
    (out.hooks[hook] || (out.hooks[hook] = [])).push(compiled);
  }

  return out;
};

function hookId(on) {
  if (!on) return 'tick';
  if (typeof on === 'string') return on;
  if (on.at) return on.at;
  return 'tick';
}

// Sugar entries are data in F.data.SUGAR, expanded here; the corpus asserts every expansion. A verb
// stays primitive only if it is the sole route to a host adapter member: `summon` is the only caller
// of host.summon and stays primitive; `law` reaches nothing that `veto` does not, so it expands.
function expandSugar(clause, facet, host) {
  const c = JSON.parse(JSON.stringify(clause));
  c.do = (c.do || []).map(eff => {
    const sugar = F.data.SUGAR[eff.emit];
    if (!sugar) return eff;
    const parts = sugar.expands.split('.');
    const next = Object.assign({}, eff, { emit: parts[0], verb: parts[1] });
    if (sugar.forces) Object.assign(next, sugar.forces);
    if (sugar.marks) next.def = Object.assign({}, next.def || {}, sugar.marks);
    if (sugar.at) next.at = next.at || sugar.at;
    return next;
  });
  return c;
}

// Durations arrive in seconds and leave in ticks. Ticks are ambiguous as an authoring unit here:
// the combat tick is 100ms and the outer game tick is 10 seconds, so "300" ticks means 30 seconds
// or 50 minutes depending on which loop the author meant.
function normaliseEffect(eff, facet, host, tps, out) {
  const e = Object.assign({}, eff);
  if (e.seconds !== undefined) e.ticks = F.data.seconds(e.seconds, tps);
  if (e.def && e.def.seconds !== undefined) { e.def = Object.assign({}, e.def); e.def.duration = F.data.seconds(e.def.seconds, tps); delete e.def.seconds; }
  if (e.emit === 'status' && e.def) {
    const def = buildStatusDef(e, facet, host);
    if (def) { out.defs.push(def); e.defId = def.id; }
  }
  return e;
}

function carrierDef(facet, cell, host) {
  const schema = host.statusSchema();
  const def = {
    id: F.carrierId(facet, cell),
    name: cell.label || (facet.reading && facet.reading.name) || 'Facet',
    icon: cell.icon || (facet.reading && facet.reading.icon) || '✦',
    duration: cell.tier === 'tick' ? 10 : null,
    hidden: cell.epistemic === 'hidden',
    buff: true,
    facet: facet.id,
    stacking: { mode: cell.hold === 'many' ? 'count' : 'highest' },
    mods: [],
    worth: 0,
  };
  return filterToSchema(def, schema);
}

// host.statusSchema() declares which StatusDef fields exist, what kind each is, and what role it
// plays in the mortality proof. The compiler copies only fields present in that table, so a field
// the host has not described cannot be emitted. A host can adopt this engine by describing three
// fields and widen the generator later by describing three more.
function buildStatusDef(eff, facet, host) {
  const schema = host.statusSchema();
  const src = eff.def || {};
  const def = {
    id: src.id || (F.carrierId(facet, { key: eff.key || ('e' + (eff.n || 0)) })),
    name: src.name || (facet.reading && facet.reading.name) || 'Facet',
    icon: src.icon || (facet.reading && facet.reading.icon) || '✦',
    facet: facet.id,
  };
  for (const k of Object.keys(src)) {
    if (k === 'id' || k === 'name' || k === 'icon') continue;
    const field = schema.fields[k];
    if (!field) continue;                                  // undescribed: silently not emitted
    def[k] = src[k];
  }
  return filterToSchema(def, schema);
}

function filterToSchema(def, schema) {
  const out = {};
  for (const k of Object.keys(def)) {
    if (k === 'id' || k === 'name' || k === 'icon' || k === 'facet') { out[k] = def[k]; continue; }
    if (schema.fields[k]) out[k] = def[k];
  }
  return out;
}

// ---------- effect application ----------
//
// One dispatcher over six emission targets: cell, quantity, status, world, stage, gate. Every branch
// either changes core-owned state or calls a host adapter method; no branch writes a host object
// directly. That leaves the source game's frozen shared derived-stat block and its reactive proxy
// untouched.
F.applyEffect = function applyEffect(eff, ctx) {
  const host = F.host();
  if (!host) return;

  switch (eff.emit) {

    case 'cell': {
      const cell = F.cellOf(ctx.facet, eff.cell);
      if (!cell) return;
      const arg = eff.arg === undefined ? F.evalExpr(eff.value, ctx) : resolveArg(eff.arg, ctx);
      const r = F.cellStep(cell, eff.verb, arg, ctx);
      Object.assign(ctx.bindings, r.bindings);
      for (const f of r.fired) F.fire('cell:' + cell.key + ':' + f, ctx.ref, { key: cell.key, bindings: r.bindings });
      return;
    }

    case 'quantity': {
      const targets = resolveScope(eff.scope, ctx);
      const spec = {
        mode: eff.verb, value: F.num(F.evalExpr(eff.value, ctx)),
        min: eff.min === undefined ? undefined : F.num(F.evalExpr(eff.min, ctx)),
        max: eff.max === undefined ? undefined : F.num(F.evalExpr(eff.max, ctx)),
        ticks: eff.ticks, sourceId: ctx.facet.id + ':' + ctx.clauseId,
      };
      // `q` is either a literal quantity id or a query over the registry. The query form lets a
      // facet target, for example, any non-HP non-attribute value without anything enumerating one.
      const ids = eff.query ? pickQueried(eff.query, ctx) : [eff.q];
      for (const t of targets) for (const qid of ids) F.registry.apply(t, qid, spec);
      return;
    }

    case 'status': {
      const targets = resolveScope(eff.scope, ctx);
      const app = {
        id: eff.defId || (eff.def && eff.def.id),
        intensity: eff.intensity === undefined ? 1 : F.num(F.evalExpr(eff.intensity, ctx)),
        duration: eff.ticks,
      };
      if (!app.id) return;
      for (const t of targets) host.applyStatus(t, app, ctx.facet.id);
      return;
    }

    case 'world': {
      applyWorld(eff, ctx, host);
      return;
    }

    case 'stage': {
      // The pipeline module registers stages at attach time. Here a stage effect is only a
      // request to arm or disarm a join, not to perform one.
      if (F.pipeline && F.pipeline.request) F.pipeline.request(eff, ctx);
      return;
    }

    case 'gate': {
      if (F.gate && F.gate.request) F.gate.request(eff, ctx);
      return;
    }

    default: return;
  }
};

function applyWorld(eff, ctx, host) {
  const targets = resolveScope(eff.scope, ctx);
  switch (eff.verb) {
    case 'damage': {
      const amount = F.num(F.evalExpr(eff.value, ctx));
      const type = eff.damageType || (ctx.frame && ctx.frame.type) || 'arcane';
      for (const t of targets) if (host.applyDamage) host.applyDamage(t, amount, type, ctx.facet.id, ctx.ref);
      return;
    }
    case 'heal': {
      const want = F.num(F.evalExpr(eff.value, ctx));
      for (const t of targets) {
        // F.mortal.spendSustain meters every engine-sourced point of sustain at the recipient t,
        // not at the source. That bounds party stacking: five allies each granting one bearer 20%
        // absorption is one measurement on that bearer, not five independent ones.
        const allowed = F.mortal && F.mortal.spendSustain ? F.mortal.spendSustain(t, want) : want;
        if (allowed > 0 && host.applyHeal) host.applyHeal(t, allowed, 'facet', ctx.facet.id);
      }
      return;
    }
    case 'summon': {
      if (!host.caps.summon || !host.summon) return;
      host.summon({
        tagQuery: eff.tagQuery, level: F.num(F.evalExpr(eff.level, ctx)) || host.levelOf(ctx.ref),
        ttl: eff.ticks, side: host.sideOf(ctx.ref), scale: eff.scale === undefined ? 1 : eff.scale,
        owner: ctx.ref, facetId: ctx.facet.id,
      });
      return;
    }
    case 'dismiss': { for (const t of targets) if (host.dismiss) host.dismiss(t); return; }
    case 'revive': {
      // Revive can never run in-encounter: the schema defines no `now` value for eff.when, so the
      // only accepted values are 'encounterEnd' and 'missionEnd'. The restriction is in the schema,
      // not in a runtime counter.
      if (eff.when !== 'encounterEnd' && eff.when !== 'missionEnd') return;
      if (F.mortal && !F.mortal.mayRevive(ctx.ref)) { if (F.mortal.scar) F.mortal.scar(ctx, targets); return; }
      for (const t of targets) if (host.revive && !host.isSummoned(t)) host.revive(t, eff.hpFrac || 0.25, { facetId: ctx.facet.id });
      return;
    }
    case 'mark': { for (const t of targets) host.log(''); return; }
    case 'status': return;
    default: return;
  }
}

function resolveArg(arg, ctx) {
  if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
    const out = {};
    for (const k of Object.keys(arg)) out[k] = (k === 'from' || k === 'what') ? arg[k] : F.evalExpr(arg[k], ctx);
    return out;
  }
  return F.evalExpr(arg, ctx);
}

function resolveScope(scope, ctx) {
  const host = F.host();
  if (!scope) return [ctx.ref];
  return host.resolve(ctx.ref, scope) || [];
}

// A registry query, resolved at fire time. The facet stores the query, not its result, so a facet
// rolled before a quantity existed starts targeting that quantity once the host registers it.
function pickQueried(query, ctx) {
  const host = F.host();
  const pool = F.registry.query(query);
  if (!pool.length) return [];
  const n = Math.max(1, query.n || 1);
  const out = [];
  for (let i = 0; i < n && pool.length; i++) {
    const q = host.pick(pool);
    if (out.indexOf(q.id) < 0) out.push(q.id);
  }
  return out;
}
})();
