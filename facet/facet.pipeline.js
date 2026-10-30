// The staged damage pipeline. Commit 3 makes this live. At commit 1 it registers its module slot,
// holds the stage table, and accepts join requests with no host pipeline to attach them to.
//
// The file exists before it does anything because install() asserts the full module set and throws
// naming whatever is missing, so a half-loaded engine cannot start. If this file were absent until
// commit 3, that assert would have to be conditional on the commit.
//
// What commit 3 changes: mitigation is currently resolved inside one function that runs armor, then
// resistance, then ward, inline. That becomes a named ordered list over a per-call frame. The frame
// is per call and not per bearer because the function is re-entrant: damage() calls it again from
// inside a call already on the stack, and a frame held on the bearer would be overwritten by the
// inner call. The stage order is
//
//     raw -> crit -> armor -> resist -> absorb -> engine -> ward -> floor
//
// `absorb` is new in both hosts and is where accumulators intercept. `engine` is not joinable: it
// applies the frame's accumulated multiplier and holds the per-blow mortality clamp. `floor` is
// sealed. Any join after `floor` must be monotone non-decreasing in the frame's value, checked by
// walking the Expr tree (see P.isMonotone below) rather than by running the join.

(() => {
const F = (globalThis.Facet || (globalThis.Facet = { _mods: {} }));
F._mods.pipeline = true;

const P = F.pipeline = {};
const JOINS = [];          // { stageId, phase, fn, owner }

// Live as of commit 3. Elements.slice is a named stage list and joinsFor() is consulted at every
// joinable stage boundary. With no joins registered the pass is an identity, so enabling it changes
// no behaviour by itself. test/facet.pipeline.js checks that by comparing 40000 blows against a
// frozen copy of the original arithmetic.
P.live = true;

P.stages = function stages() {
  const h = F.host();
  return h && h.stages ? h.stages() : [];
};

P.join = function join(stageId, phase, fn, owner) {
  const rec = { stageId, phase, fn, owner };
  JOINS.push(rec);
  return () => { const i = JOINS.indexOf(rec); if (i >= 0) JOINS.splice(i, 1); };
};

P.joinsFor = (stageId, phase) => JOINS.filter(j => j.stageId === stageId && j.phase === phase);

P.unjoinAll = function unjoinAll(owner) {
  for (let i = JOINS.length - 1; i >= 0; i--) if (JOINS[i].owner === owner) JOINS.splice(i, 1);
};

// The entry point the host's slice() calls once per stage. Nothing calls it before commit 3. With
// JOINS empty it returns the frame unchanged, so enabling it changes no behaviour by itself. Within
// one stage the phases run before, then replace, then after; only the last registered 'replace' join
// runs. A join returning a falsy value leaves the frame as it was.
P.stage = function stage(stageId, frame) {
  if (!JOINS.length) return frame;
  for (const j of P.joinsFor(stageId, 'before')) frame = j.fn(frame) || frame;
  const rep = P.joinsFor(stageId, 'replace');
  if (rep.length) frame = rep[rep.length - 1].fn(frame) || frame;
  for (const j of P.joinsFor(stageId, 'after')) frame = j.fn(frame) || frame;
  return frame;
};

// Arm a join from a fired clause. The join is a closure over the facet and the effect, registered
// under an owner key built from the bearer ref, facet id and clause id. It stays registered until
// something unarms it or the encounter ends.
//
// A stage effect fired on a host where the pipeline is not live returns false instead of throwing:
// the effect is recorded and not applied. A facet generated against a later commit must not crash
// an earlier one. The generator is separately forbidden from rolling a verb the host has not
// declared.
P.request = function request(eff, ctx) {
  if (!P.live) return false;
  const host = F.host();
  const stage = (host.stages() || []).filter(s => s.id === eff.at)[0];
  if (!stage || stage.joinable === false || (stage.sealed && eff.verb === 'replace')) return false;

  const owner = ctx.ref + ':' + ctx.facet.id + ':' + ctx.clauseId;
  P.unjoinAll(owner);                                     // re-firing replaces rather than stacks

  const mult = () => {
    const v = F.num(F.evalExpr(eff.value, ctx));
    // Clamp the multiplier to [MORTALITY.MIN_ENGINE_MULT, 1]. A join at a mitigating stage may only
    // reduce damage, and not below the floor the engine stage enforces afterwards. A multiplier
    // above 1 would increase damage at a stage the player reads as mitigation.
    return Math.max(F.data.MORTALITY.MIN_ENGINE_MULT, Math.min(1, v));
  };

  P.join(eff.at, eff.verb === 'before' ? 'before' : 'after', (frame) => {
    if (stage.mitigating) {
      const before = frame.value;
      const after = before * mult();
      // Damage removed by the join is metered as sustain. frame.value is the amount the blow was
      // about to deal, so saved is an exact figure rather than an estimate.
      const saved = before - after;
      if (saved > 0 && F.mortal && F.mortal.spendSustain) {
        const allowed = F.mortal.spendSustain(ctx.ref, saved);
        return before - allowed;
      }
      return after;
    }
    return frame.value;
  }, owner);

  if (eff.ticks) {
    const until = host.now() + eff.ticks;
    P.join(eff.at, 'after', (frame) => (host.now() > until ? (P.unjoinAll(owner), frame.value) : frame.value), owner + ':clock');
  }
  return true;
};

// Structural monotonicity check over the Expr tree, used for joins after the sealed floor stage. A
// join that could return less than it was given is rejected there. The check inspects node types
// instead of evaluating the expression: sub, div and invert fail, mul fails on a literal b < 1, and
// the children a, b, c, of, then and else are checked recursively.
P.isMonotone = function isMonotone(node) {
  if (node === null || node === undefined) return true;
  if (typeof node !== 'object') return true;
  if (node.expr === 'sub' || node.expr === 'div') return false;
  if (node.expr === 'mul') {
    const b = node.b;
    if (typeof b === 'number' && b < 1) return false;
  }
  if (node.expr === 'invert') return false;
  for (const k of ['a', 'b', 'c', 'of', 'then', 'else']) if (node[k] !== undefined && !P.isMonotone(node[k])) return false;
  return true;
};
})();
