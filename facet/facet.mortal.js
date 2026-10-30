// The mortality invariant. Every bearer must remain killable. This file makes that a measured
// property of the system rather than a consequence of tuning.
//
// The claim. For a live bearer B, let TTK_native(B) be its time-to-kill with every facet-sourced
// effect suspended, and TTK_now(B) the same with them live. Then
//
//     hardness   H(B) = TTK_now(B) / TTK_native(B)  =  H_cover x H_sustain x H_revive
//     invariant  H(B) <= 6, at every tick, for every live bearer.
//
// H is a ratio, so it is dimensionless and independent of every balance number in either game. Its
// value does not shift when this game's magic damage runs hotter than the source game's spell
// power, when the parry cap is 0.6 here and 0.5 there, or when monster resistance caps at 0.9 while
// the party's caps at 0.75. A bound stated in damage arithmetic translates to a different number of
// blows under each of those; a bound stated as a ratio does not. The host is lethal by
// construction: its damage door floors every landed blow at 1 for both sides, and hp is finite, so
// H <= 6 implies TTK_now is finite. The engine does not have to make the game lethal, only bound
// how much less lethal facets may make it.
//
// M1 - coverage.
//
//     open[t]    = probeSlice(B,t,REF) / probeNative(B,t,REF)
//     openBar[t] = an exponential moving average of open[t] over five seconds
//     M1:  max over t in reach(B) of openBar[t]  >=  SEAM_MIN
//
// Three properties of that formulation, each load-bearing:
//
//  (a) Measured, not declared. open[t] is the ratio of two real slices through the host's own
//      mitigation path, so it captures armor, resistance, ward, conversion, resistance overrides,
//      and any mitigation route added later, including routes this file does not know about. A
//      declared coverage formula only sees the routes its author enumerated: add a flat
//      post-resistance shield and the formula reports a value that is no longer true.
//
//  (b) Time-averaged. An instantaneous check passes a mode that grants immunity to physical or to
//      magic but never both. Such a mode is never closed to everything at any single instant, so an
//      existence check on open[t] succeeds while the bearer is untouchable by an enemy that flips
//      its damage type along with the mode.
//
//  (c) Taken over reach(B). A rolling average alone is not enough either. The same mode against an
//      all-physical enemy passes a plain time-average, because ten elemental channels sit wide open
//      and no opponent present can strike them. Taking the maximum only over types live opponents
//      can actually deliver makes the bound bind on that case. It also covers the fourth
//      invincibility route: a law that forbids physical attacks shrinks reach(B), which raises
//      hCover and makes M1 bind harder. Immunity that closes every lethal channel and a law that
//      closes every lethal channel produce the same measurement.
//
// Puncture, not refusal. When the bound is exceeded the engine opens a seam instead of rejecting
// the ability. Three reasons. First, a refusal branches on what a combination is, which is the
// hard-coded behaviour this codebase's design rules forbid, while a puncture is a consequence along
// an axis. Second, a refusal is non-local: whether facets A and B may fuse would depend on what
// else the bearer carries, so the same two inputs would sometimes work and sometimes not, with no
// explanation the player can act on. Third, a puncture leaves the ability intact and adds play: the
// bearer is nearly untouchable, there is one way in, and its location is not shown.

(() => {
const F = (globalThis.Facet || (globalThis.Facet = { _mods: {} }));
F._mods.mortal = true;

const M = F.mortal = {};
const LEDGER = new Map();     // ref -> { openBar:{}, reach:[], sustainSpent, revives, h, seams:[] }

M.reset = function reset() { LEDGER.clear(); };

function ledgerOf(ref) {
  let l = LEDGER.get(ref);
  if (!l) { l = { openBar: {}, reach: [], sustainSpent: 0, revives: 0, h: 1, hCover: 1, hSustain: 1, hRevive: 1, seams: [], punctures: [], dirty: true }; LEDGER.set(ref, l); }
  return l;
}
M.ledgerOf = ledgerOf;

// ---------- M2: sustain, metered at the recipient ----------
//
// The budget is keyed on the bearer who is healed, not on the source of the healing. That closes
// party stacking: five allies each granting one bearer twenty percent absorption is one measurement
// on that bearer instead of five separate ones that each pass on their own.
//
// Only engine-sourced sustain is metered. Because H is a ratio, native healing appears in both
// TTK_native and TTK_now and cancels, so the host's potions, its cleric spells and its field
// regeneration are unaffected and no existing balance number changes.
M.sustainBudget = function sustainBudget(ref) {
  const host = F.host();
  if (!host) return Infinity;
  const threat = M.threatOf(ref);
  return Math.max(0, F.data.MORTALITY.SUSTAIN_MAX_SHARE * threat);
};

M.threatOf = function threatOf(ref) {
  const host = F.host();
  if (!host || !host.refBlow) return Infinity;
  const blow = host.refBlow(ref);
  const opponents = host.opponentsOf ? host.opponentsOf(ref).length : 1;
  return blow * Math.max(1, opponents) / 2;      // per second, at the reference blow
};

M.spendSustain = function spendSustain(ref, want) {
  const l = ledgerOf(ref);
  const budget = M.sustainBudget(ref);
  if (!Number.isFinite(budget)) return want;
  const allowed = Math.max(0, budget - l.sustainSpent);
  const got = Math.min(want, allowed);
  l.sustainSpent += got;
  // Once l.sustainSpent reaches the budget, allowed is 0 and every sustain verb returns 0 for the
  // rest of the encounter. The effect is visible in play: absorption stops and incoming damage
  // lands in full.
  return got;
};

// ---------- M3: revives ----------
//
// The `when` schema has no value meaning "now", so a revive can never resolve inside an encounter;
// prove() rejects any revive not timed at encounterEnd or missionEnd. This is enforced by the
// schema rather than by a runtime counter. On top of that: REVIVE_CAP revives per mission per
// bearer, a scar seam per revive, and one rule that closes the gap the cap alone leaves open - a
// revived bearer's sustain meter is not reset.
M.mayRevive = function mayRevive(ref) {
  return ledgerOf(ref).revives < F.data.MORTALITY.REVIVE_CAP;
};

M.noteRevive = function noteRevive(ref) {
  const l = ledgerOf(ref);
  l.revives++;
  // l.sustainSpent is deliberately not reset here. Resetting it would let a revive buy another full
  // budget of absorption.
  M.scarSeam(ref);
};

// Each revive spent raises the seam floor on the widest-open reachable type for the rest of the
// mission. The floor is min(1, SEAM_MIN * (1 + revives * 0.5)), so every revive leaves the bearer
// measurably easier to kill afterwards.
M.scarSeam = function scarSeam(ref) {
  const l = ledgerOf(ref);
  const t = M.widestReachable(ref);
  if (t) l.seams.push({ type: t, floor: Math.min(1, F.data.MORTALITY.SEAM_MIN * (1 + l.revives * 0.5)), reason: 'scar' });
};

M.scar = function scar(ctx, targets) {
  // A revive past the cap is converted rather than refused. The target returns at 0.01 of max hp
  // with the deathbed flag set, and dies at the end of the next encounter unless healed by
  // something that is not a facet.
  const host = F.host();
  for (const t of targets) if (host.revive) host.revive(t, 0.01, { deathbed: true, facetId: ctx.facet.id });
};

// ---------- M1: the coverage ledger ----------
M.tick = function tick(ref, rec) {
  const host = F.host();
  if (!host || !host.probeSlice || !host.probeNative) return;   // commit 2 supplies these
  const l = ledgerOf(ref);

  if (l.dirty || rec.dirty) { M.recompute(ref, l); l.dirty = false; rec.dirty = false; }

  const w = F.data.MORTALITY.EMA_WINDOW;
  const a = 2 / (w + 1);
  for (const t of Object.keys(l.open || {})) {
    const prev = l.openBar[t] === undefined ? l.open[t] : l.openBar[t];
    l.openBar[t] = prev + a * (l.open[t] - prev);
  }

  M.grade(ref, l);
  if (l.h > F.data.MORTALITY.H_MAX) M.enforce(ref, l);
};

M.recompute = function recompute(ref, l) {
  const host = F.host();
  const raw = host.refBlow(ref);
  l.open = {};
  for (const ch of host.channels()) {
    const now = host.probeSlice(ref, ch.id, raw);
    const nat = host.probeNative(ref, ch.id, raw);
    l.open[ch.id] = nat > 0 ? Math.max(0, now / nat) : 1;
  }
  l.reach = Array.from(host.reachableTypes ? host.reachableTypes(ref) : Object.keys(l.open));
};

M.grade = function grade(ref, l) {
  const D = F.data.MORTALITY;
  const reach = l.reach && l.reach.length ? l.reach : Object.keys(l.openBar);
  let best = 0;
  for (const t of reach) { const v = l.openBar[t]; if (v !== undefined && v > best) best = v; }
  l.bestSeam = best;
  // Not clamped at 1/SEAM_MIN. That is the value the bound guarantees after enforcement; clamping
  // the measurement to it would make a breach unreportable, and a fully closed bearer would grade
  // as a safe one.
  l.hCover = Math.min(1e6, 1 / Math.max(best, 1e-6));

  const budget = M.sustainBudget(ref);
  const share = Number.isFinite(budget) && budget > 0 ? Math.min(D.SUSTAIN_MAX_SHARE, l.sustainSpent / (budget / D.SUSTAIN_MAX_SHARE)) : 0;
  l.hSustain = 1 / Math.max(1e-6, 1 - Math.min(share, D.SUSTAIN_MAX_SHARE));

  // Counts the revives this bearer can still spend, not the revives the cap would allow anyone. A
  // bearer carrying no revive grant is not one revive harder to kill. An earlier version counted
  // the cap here, which graded every character in the game as twice as durable as it was.
  l.hRevive = 1 + Math.max(0, revivesGranted(ref) - l.revives);

  l.h = l.hCover * l.hSustain * l.hRevive;
  return l;
};

// ---------- enforcement ----------
//
// The loop terminates because each pass removes at least PUNCTURE_MIN_BITE (0.2) of one route's
// excess and every route is individually bounded: cover at 1/SEAM_MIN, sustain at 2, revive at 2.
// The product therefore falls monotonically. PUNCTURE_MAX_ROUNDS bounds cost only. If it is
// reached, the per-blow clamp at the sealed engine stage (MIN_ENGINE_MULT) holds the remainder
// unconditionally, which is why that stage admits no joins.
M.enforce = function enforce(ref, l) {
  const D = F.data.MORTALITY;
  l = l || ledgerOf(ref);
  for (let round = 0; round < D.PUNCTURE_MAX_ROUNDS; round++) {
    if (l.h <= D.H_MAX) return l;
    const need = l.h / D.H_MAX;
    const routes = ['cover', 'sustain', 'revive'].sort((a, b) =>
      ((l['h' + cap(b)] - 1) / D.PUNCTURE_COST[b]) - ((l['h' + cap(a)] - 1) / D.PUNCTURE_COST[a]));
    for (const r of routes) {
      if (l['h' + cap(r)] <= 1.0001) continue;
      const bite = Math.max(D.PUNCTURE_MIN_BITE, 1 - 1 / need);
      M.puncture(ref, l, r, bite);
      M.grade(ref, l);
      if (l.h <= D.H_MAX) return l;
    }
  }
  return l;
};

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// How many revives this bearer's facets could still fire, bounded by REVIVE_CAP. Counted from the
// facet records on each call rather than tracked in the ledger, so a facet gained mid-mission
// counts from the moment it is attached.
function revivesGranted(ref) {
  let n = 0;
  for (const f of F.facetsOf(ref)) {
    for (const cl of (f.clauses || [])) {
      for (const e of (cl.do || [])) if (e.emit === 'world' && e.verb === 'revive') n++;
    }
  }
  return Math.min(n, F.data.MORTALITY.REVIVE_CAP);
}
M.revivesGranted = revivesGranted;

M.puncture = function puncture(ref, l, route, bite) {
  const D = F.data.MORTALITY;
  if (route === 'cover') {
    const t = M.pickSeam(ref, l);
    if (!t) return;
    l.seams.push({ type: t, floor: D.SEAM_MIN, reason: 'puncture' });
    l.openBar[t] = Math.max(l.openBar[t] || 0, D.SEAM_MIN);
    l.punctures.push({ kind: 'seam', type: t });
    // The seam is recorded in the ledger for the lens to read, not printed. The player is told the
    // armour is not perfect; which damage type is open is not shown.
  } else if (route === 'sustain') {
    l.sustainScale = (l.sustainScale === undefined ? 1 : l.sustainScale) * (1 - bite);
    l.punctures.push({ kind: 'bleed', scale: l.sustainScale });
    // sustainScale is shown to the player as a number, unlike the seam, because the heal rate is a
    // figure the player watches tick by tick.
  } else {
    l.revives = F.data.MORTALITY.REVIVE_CAP;
    l.punctures.push({ kind: 'scar' });
  }
};

// Picks the damage type to open. Deterministic from the first facet's seed, so the same ability
// always leaks on the same type and a player can learn it. Weights: +3 for the type SEAM_OPPOSITE
// names as the answer to the facet's element, +0.1 per cell tag matching the type, candidates
// restricted to reach(B) so an opponent present can actually strike with it, and weight cut to 0.05
// for a type the bearer is already natively vulnerable to.
M.pickSeam = function pickSeam(ref, l) {
  const host = F.host();
  const reach = (l.reach && l.reach.length) ? l.reach : host.channels().map(c => c.id);
  if (!reach.length) return null;
  const facets = F.facetsOf(ref);
  const seed = facets.length ? parseInt(String(facets[0].seed || 0), 10) || 0 : 0;

  const scored = reach.map((t, i) => {
    let w = 1;
    for (const f of facets) {
      for (const c of (f.cells || [])) if (c.tags && c.tags.indexOf && c.tags.indexOf(t) >= 0) w += 0.1;
      const answer = F.data.SEAM_OPPOSITE[elementOf(f)];
      if (answer === t) w += 3;
    }
    if (host.probeNative && host.probeSlice) {
      const raw = host.refBlow(ref);
      const nat = host.probeNative(ref, t, raw);
      if (nat > raw) w = 0.05;       // native slice exceeds the raw blow: already open, seam adds nothing
    }
    return { t, w: w * (1 + ((seed >> (i % 24)) & 1) * 0.01) };
  }).filter(x => x.w > 0);

  if (!scored.length) return reach[0];
  scored.sort((a, b) => b.w - a.w);
  return scored[0].t;
};

function elementOf(facet) {
  for (const c of (facet.cells || [])) if (typeof c.element === 'string') return c.element;
  for (const cl of (facet.clauses || [])) for (const e of (cl.do || [])) if (e.damageType) return e.damageType;
  return null;
}

M.widestReachable = function widestReachable(ref) {
  const l = ledgerOf(ref);
  const reach = (l.reach && l.reach.length) ? l.reach : Object.keys(l.openBar);
  let best = null, bv = -1;
  for (const t of reach) { const v = l.openBar[t] === undefined ? 1 : l.openBar[t]; if (v > bv) { bv = v; best = t; } }
  return best;
};

M.seamFloorFor = function seamFloorFor(ref, type) {
  const l = LEDGER.get(ref);
  if (!l) return 0;
  let floor = 0;
  for (const s of l.seams) if (s.type === type) floor = Math.max(floor, s.floor);
  return floor;
};

// ---------- the static audit ----------
//
// Roughly nine violations in ten are visible without running the facet, and catching them here
// costs nothing at runtime. The remainder, composition across facets and the exclusive-mode case
// described in M1(b), is what the tick-time ledger handles.
M.prove = function prove(facet) {
  const problems = [];
  const D = F.data.MORTALITY;

  for (const cell of (facet.cells || [])) {
    if (cell.level !== 'none' && (cell.cap === undefined || cell.cap === null)) problems.push('cell ' + cell.key + ' carries a magnitude with no cap');
    if (cell.tier === 'calendar' && cell.decay === 0) problems.push('cell ' + cell.key + ' is calendar-tier and never decays');
  }

  // Self-feeding loops. A facet that causes the event it listens for does not terminate: an ability
  // that stores incoming blows and releases them into its own bearer takes damage, fills,
  // discharges into itself, which is damage, which fills it again. The arithmetic stays finite but
  // the tick loop does not return. Five facets in twenty-five did this the first time the relation
  // grammar was allowed to nest; the fixed-template generator could not produce the shape at all,
  // so it needed no such check.
  //
  // The runtime also has a re-entrancy guard. This check is the generation-time policy: a facet
  // whose own output can wake its own trigger is rerolled rather than shipped and caught at
  // runtime.
  const FEEDS = {
    damage: ['event:damageTaken', 'event:onHit'],
    heal:   ['event:heal'],
  };
  const hooks = {};
  for (const cl of (facet.clauses || [])) {
    const h = typeof cl.on === 'string' ? cl.on : (cl.on && cl.on.at);
    if (h) hooks[h] = true;
  }
  for (const cl of (facet.clauses || [])) {
    for (const e of (cl.do || [])) {
      if (e.emit !== 'world') continue;
      const wakes = FEEDS[e.verb];
      if (!wakes) continue;
      // Only a self-, party-, ally- or arena-scoped effect can wake the bearer's own listener. An
      // enemy-scoped one is a legitimate loop: you hit the enemy, its cell fills, it hits back.
      const side = (e.scope && e.scope.side) || 'self';
      if (side !== 'self' && side !== 'party' && side !== 'ally' && side !== 'arena') continue;
      for (const w of wakes) if (hooks[w]) problems.push('clause ' + cl.id + ' wakes its own trigger (' + e.verb + ' -> ' + w + ')');
    }
  }

  let revives = 0;
  for (const cl of (facet.clauses || [])) {
    for (const e of (cl.do || [])) {
      if (e.emit === 'world' && e.verb === 'revive') {
        revives++;
        if (e.when !== 'encounterEnd' && e.when !== 'missionEnd') problems.push('revive must resolve at encounterEnd or missionEnd');
      }
      if (e.emit === 'stage' && e.at === 'floor' && e.verb === 'replace') problems.push('the floor stage is sealed and admits no replace');
      if (e.emit === 'stage' && e.at === 'engine') problems.push('the engine stage is not joinable');
      if (e.emit === 'quantity') {
        const q = F.registry.def(e.q);
        if (e.q && !q) problems.push('unknown quantity ' + e.q);
        if (q && e.verb === 'nullify' && !q.nullifiable) problems.push(q.id + ' is not nullifiable');
        if (q && q.sealed && (e.verb === 'set' || e.verb === 'nullify')) problems.push(q.id + ' is sealed');
      }
      if (e.emit === 'gate' && e.verb === 'veto') {
        const secs = e.seconds === undefined ? Infinity : e.seconds;
        if (secs > D.LAW_MAX_SECONDS) problems.push('a law may not last longer than ' + D.LAW_MAX_SECONDS + 's');
        if (e.penalty && e.penalty.hpFrac < D.MIN_DEFIANCE) problems.push('a law that costs nothing to break is not a law');
      }
    }
  }
  if (revives > D.REVIVE_CAP + 1) problems.push('more revive clauses than the cap admits');

  return { ok: problems.length === 0, problems };
};
})();
