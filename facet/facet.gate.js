// The action gate. Commit 5 sets G.live and adds the host call site. At commit 1 this file only
// registers its module slot and holds the rule table, and G.apply() is an identity pass, so
// installing it changes no behaviour.
//
// Purpose. The host already has a two-value form of this: it builds a list of candidate actions and
// vetoes them with a hardcoded check against the strings 'attack' and 'spell'. The gate generalises
// both halves. Candidates become descriptors carrying kind, family, school, element, the full set of
// damage types they can deliver, cost and reach. The veto becomes a rule chain that statuses, laws
// and facets all register into. Prohibition is then one predicate over one descriptor. Because the
// descriptor names each property separately, a generated law can take its subject from any one of
// them and still read as a sensible rule.
//
// Ordering. The gate must run before the host's value passes. The lowest AI tier picks uniformly at
// random and the second picks by weight, so a candidate that is scored while forbidden can be
// selected, not just mispriced. Filtering after scoring lets a character attempt an action a law
// forbids roughly once every few hundred ticks, which is hard to notice in play.
//
// Defiance. If every candidate is vetoed and at least one veto came from a facet, apply() returns
// exactly one descriptor: the highest-value forbidden one, tagged with an hp cost charged to the
// actor. Two properties of that branch:
//   - Additive. With no facet veto in force the branch never runs and the host behaves byte-for-byte
//     as it did before the gate was installed.
//   - Terminating. The cost is at least MORTALITY.MIN_DEFIANCE = 0.02 of max hp per action, so an
//     actor in a field where every action is forbidden dies within 50 actions and the fight ends in
//     a death rather than a timeout. A timeout is scored as a stalemate, not a loss.
// Termination needs either that hp drain or a tick cap on the encounter. G.request() therefore
// refuses an arena-scoped clause when host.encounterCap() is Infinity, which leaves the hp drain,
// the mechanism the player can see.

(() => {
const F = (globalThis.Facet || (globalThis.Facet = { _mods: {} }));
F._mods.gate = true;

const G = F.gate = {};
const RULES = [];          // { kind:'veto'|'tax'|'redirect'|'transform', when, scope, owner, penalty }

G.live = false;            // flipped by commit 5

G.rules = () => RULES.slice();
G.clear = (owner) => { for (let i = RULES.length - 1; i >= 0; i--) if (RULES[i].owner === owner) RULES.splice(i, 1); };

G.add = function add(rule) {
  // A veto rule needs a defiance penalty of at least F.data.MORTALITY.MIN_DEFIANCE (0.02 of max hp).
  // compile() already rejects a lower one; this is a second check on the same value so a
  // hand-written rule passed straight to G.add() cannot skip it.
  if (rule.kind === 'veto') {
    const min = F.data.MORTALITY.MIN_DEFIANCE;
    if (!rule.penalty || !(rule.penalty.hpFrac >= min)) rule.penalty = { hpFrac: min };
  }
  RULES.push(rule);
  return () => G.clear(rule.owner);
};

// Identity pass until commit 5: G.live is false, so this returns descriptors unchanged. It already
// takes the final argument list, so commit 5 only has to add the host call site.
G.apply = function apply(ctx, ref, descriptors) {
  if (!G.live || !RULES.length) return descriptors;

  const legal = [];
  const vetoed = [];
  for (const d of descriptors) {
    let killed = null;
    for (const rule of RULES) {
      if (rule.kind !== 'veto') continue;
      if (!G.binds(rule, ctx, ref)) continue;
      if (F.evalGuard(rule.when, { ref, facet: rule.facet, descriptor: d, host: F.host(), bindings: {} }) !== F.G_TRUE) continue;
      killed = rule; break;
    }
    if (killed) vetoed.push({ d, by: killed }); else legal.push(d);
  }

  if (legal.length) return legal;
  if (!vetoed.length) return descriptors;

  // Defiance: return the single highest-value vetoed descriptor, carrying the hp cost charged to the
  // actor before the action resolves.
  const best = vetoed.reduce((a, b) => ((b.d.value || 0) > (a.d.value || 0) ? b : a));
  const host = F.host();
  const cost = Math.max(1, (best.by.penalty.hpFrac || F.data.MORTALITY.MIN_DEFIANCE) * host.maxHp(ref));
  const defiant = Object.assign({}, best.d, { lawExempt: true, defianceCost: cost, defiedRule: best.by.id || null });
  return [defiant];
};

// Whether a rule reaches this actor at all. A missing scope.side, 'arena' and 'world' bind every
// actor, including rule.owner, so a law its author made still applies to its author. That is why the
// launch screen shows the active laws before a mission starts rather than after. 'self' binds only
// rule.owner. Any other side is resolved through host.resolve(rule.owner, rule.scope).
G.binds = function binds(rule, ctx, ref) {
  const host = F.host();
  const side = rule.scope && rule.scope.side;
  if (!side || side === 'arena' || side === 'world') return true;
  if (side === 'self') return ref === rule.owner;
  const targets = host.resolve(rule.owner, rule.scope) || [];
  return targets.indexOf(ref) >= 0;
};

G.request = function request(eff, ctx) {
  if (!G.live) return false;
  const host = F.host();
  if (eff.scope && eff.scope.side === 'arena' && host.encounterCap() === Infinity) return false;
  G.add({
    kind: eff.verb, when: eff.when || null, scope: eff.scope || { side: 'arena' },
    owner: ctx.ref, facet: ctx.facet, id: ctx.facet.id + ':' + ctx.clauseId,
    penalty: eff.penalty || null, ticks: eff.ticks,
  });
  return true;
};

// Tests one descriptor against the veto rules for ref, without building or running an action. The
// mortality proof calls this to find what a live opponent can still deliver through the gate. Do not
// compute the same answer by running the host's candidate builder instead: that builder is one call
// away from a function that removes a status, so a speculative pass through it would consume a
// charge the player had banked.
G.permits = function permits(ref, descriptor) {
  if (!G.live || !RULES.length) return true;
  for (const rule of RULES) {
    if (rule.kind !== 'veto') continue;
    if (!G.binds(rule, null, ref)) continue;
    if (F.evalGuard(rule.when, { ref, facet: rule.facet, descriptor, host: F.host(), bindings: {} }) === F.G_TRUE) return false;
  }
  return true;
};
})();
