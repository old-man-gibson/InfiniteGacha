// Sacrifice: one character consumed to strengthen another. Browser: window.Sacrifice. Node: module.exports.
//
// A sacrifice is a DEATH, not a discount. The consumed character goes through roster.js like
// anyone who falls on a mission: onto the memorial with a cause of their own, identity and face
// locked out of the gate forever. Releasing someone lets them walk away; sacrificing them does
// not. That is the price of the shortcut, and it is the reason this is not just "delete a dupe".
//
// THE FORMULA. For everything the sacrifice carries — each base stat, each aptitude's level,
// each technique's repetitions — the target receives
//
//     value × S/(S+T) × dim(n) × altar
//
//   S, T   the two characters' base-stat totals. Feeding a champion to a rookie moves most of it
//          across; feeding a rookie to a champion moves a sliver; two equals split it in half.
//          A sacrifice is worth what it was, RELATIVE to what it is poured into.
//   dim(n) how much the target still has room to absorb, where n is how many sacrifices it has
//          already taken: 1, then a half, then a third. See DIMINISH below.
//   altar  the share of the ALTAR the trade is performed at. The free starting cairn is 1 and
//          every tier above it makes the same offering worth more. This module does not know the
//          town, so the caller passes the number in.
//
// Where it happens: not on a character's own card. The player goes to the altar, chooses who is
// being made stronger, and then chooses who pays.
//
// Not transferred, by design: the lexicon, the psionic axis order, the affinity, the mind
// traits, the face. Those are who somebody is — roster.js hashes them into the identity it
// locks on death — and a character carrying a dead character's vocabulary is what that file
// exists to prevent. Aptitude, muscle memory and raw physical strength are what one body can
// hand to another.

(() => {
// Resolved on use, not on load: script tags are read in order and binding at parse time would
// break this file if it were ever placed above what it needs.
const S = () => (typeof Stats !== 'undefined') ? Stats : require('./stats.js');
const P = () => (typeof Prof !== 'undefined') ? Prof : require('./proficiency.js');
const A = () => (typeof Affinity !== 'undefined') ? Affinity : require('./affinity.js');
const RO = () => (typeof Roster !== 'undefined') ? Roster : (typeof require !== 'undefined' ? require('./roster.js') : null);

/**
 * DIMINISH. 1/(n + 1): the first sacrifice lands whole, the second at half, the third at a
 * third, and so on down. Each offering uses up part of what the target can still absorb.
 * Together with the ratio — which is also shrinking, because every offering makes the target
 * bigger — the fourth or fifth offering into the same character rounds away to nothing, and the
 * roster is better spent across several people than poured into one champion. The limit is
 * intended; it is not a rounding accident.
 */
function diminish(n) { return 1 / (n + 1); }

/**
 * How much of each channel crosses, on top of the formula. 1 is the formula as authored and the
 * intended default; these exist because the three channels are not the same size. A share of a
 * stat total is a handful of points, but a share of an aptitude's ABSOLUTE level is whole stages
 * — one junk 1-star lifts every aptitude a target has by roughly a stage — so aptitude is the dial
 * to turn first if sacrifice outruns the training grounds.
 */
const SHARE = { stats: 1, aptitude: 1, technique: 1 };

const count = (c) => c.sacrifices || 0;
const totalStats = (c) => S().BASE_STATS.reduce((a, k) => a + c.stats.base[k], 0);

/** S/(S+T): how much of the sacrifice survives the pour, before diminishing. */
function ratio(sac, target) {
  const s = totalStats(sac), t = totalStats(target);
  return s + t > 0 ? s / (s + t) : 0;
}

/**
 * The whole multiplier applied to every transferred value. `alt` is the altar's share for its
 * tier (economy.js) — the building the trade happens at, 1 at the free starting cairn.
 */
function factor(sac, target, alt = 1, n = count(target)) { return ratio(sac, target) * diminish(n) * alt; }

/** Trained aptitudes stop at A+, or S+ for an omnimaster. Sacrifice obeys the same ceiling. */
function capStageFor(c) {
  const p = P();
  return A().has(c.affinity, 'omnimaster') ? p.STAGE['S+'] : p.MAX_ADVANCE_STAGE;
}

/**
 * Why this pairing is or is not allowed. Both must be home and they must be two people — and,
 * when the roster is to hand, both must still be ON it. Without that last check a corpse can be
 * spent twice: `apply` reads the two objects it was handed, and a second click that lands before
 * the screen has been rebuilt hands it the same dead character again, which Roster.fall accepts
 * without error (falling twice is idempotent) while the target gains a second time. Two
 * clicks, two payouts, one death.
 */
function check(sac, target, state = null) {
  if (!sac || !target) return { ok: false, why: 'character not found' };
  if (sac.id === target.id) return { ok: false, why: 'a character cannot be sacrificed to itself' };
  if (sac.mission) return { ok: false, why: `${sac.name} is away on a mission` };
  if (target.mission) return { ok: false, why: `${target.name} is away on a mission` };
  if (state && Array.isArray(state.characters)) {
    const on = (c) => state.characters.some(x => x.id === c.id);
    if (!on(sac)) return { ok: false, why: `${sac.name} has already been spent` };
    if (!on(target)) return { ok: false, why: `${target.name} is no longer on the roster` };
  }
  return { ok: true };
}

/**
 * What this sacrifice would do, without doing it. `apply` is this plus the writes, so the number
 * on the button is the number that lands.
 * Returns { ok, n, ratio, diminish, factor, stats, statTotal, profs, techniques, techTotal }.
 * `profs` entries carry the already-computed after-state so nothing is recalculated on apply.
 */
function preview(sac, target, alt = 1) {
  const gate = check(sac, target);
  if (!gate.ok) return { ...gate, stats: {}, profs: [], techniques: {} };
  const st = S(), p = P();
  const n = count(target), r = ratio(sac, target), d = diminish(n), f = r * d * alt;

  // Base stats. Rounded per stat and held to the same ceiling rolling and advancement obey, so a
  // sacrifice can fill a character out but never push it off the scale the derived stats assume.
  const stats = {};
  let statTotal = 0;
  for (const k of st.BASE_STATS) {
    const after = Math.min(st.STAT_MAX, target.stats.base[k] + Math.round(sac.stats.base[k] * f * SHARE.stats));
    stats[k] = after - target.stats.base[k];
    statTotal += stats[k];
  }

  // Aptitudes. The sacrifice's absolute level plus whatever partial level it had banked, scaled,
  // then spent through the same xp bank training uses so fractions are never thrown away.
  const cap = capStageFor(target);
  const profs = [];
  for (const [k, sp] of Object.entries(sac.profs || {})) {
    if (!target.profs || !target.profs[k]) continue;
    const raw = (p.toAbsolute(sp) + ((sac.xp || {})[k] || 0)) * f * SHARE.aptitude;
    if (raw <= 0) continue;
    const banked = ((target.xp || {})[k] || 0) + raw;
    const levels = Math.floor(banked);
    const before = target.profs[k];
    const after = levels > 0 ? p.gain(before, levels, cap) : before;
    profs.push({
      key: k, before, after, carry: banked - levels,
      levels: p.toAbsolute(after) - p.toAbsolute(before),
      staged: after.stage > before.stage,
    });
  }
  profs.sort((a, b) => b.levels - a.levels);

  // Muscle memory: a share of every technique's repetitions, mastery ladder and all. The target
  // keeps reps for techniques it cannot use yet — they wait for the right weapon.
  const techniques = {};
  let techTotal = 0;
  for (const [id, led] of Object.entries(sac.techniques || {})) {
    const reps = Math.round((led.executions || 0) * f * SHARE.technique);
    if (reps > 0) { techniques[id] = reps; techTotal += reps; }
  }

  return { ok: true, n, ratio: r, diminish: d, altar: alt, factor: f, stats, statTotal, profs, techniques, techTotal };
}

/**
 * Do it. The target absorbs the preview and the sacrifice dies: removed from the roster, locked
 * out of the pool, written onto the wall with the name it was spent on.
 * Returns the preview it applied, or { ok: false, why } if the pairing was never legal.
 */
function apply(state, sac, target, alt = 1) {
  const gate = check(sac, target, state);
  if (!gate.ok) return { ...gate, stats: {}, profs: [], techniques: {} };
  const p = preview(sac, target, alt);
  if (!p.ok) return p;
  const st = S();

  for (const k of st.BASE_STATS) target.stats.base[k] += p.stats[k];
  target.stats.derived = st.deriveStats(target.stats.base);

  if (!target.xp) target.xp = {};
  for (const g of p.profs) { target.profs[g.key] = g.after; target.xp[g.key] = g.carry; }

  if (!target.techniques) target.techniques = {};
  for (const [id, reps] of Object.entries(p.techniques)) {
    const led = target.techniques[id] || (target.techniques[id] = { executions: 0 });
    led.executions = (led.executions || 0) + reps;
  }

  target.sacrifices = p.n + 1;
  (target.absorbed || (target.absorbed = [])).push({ name: sac.name, race: sac.race, stars: sac.stats.stars, at: Date.now() });

  const roster = RO();
  if (roster) roster.fall(state, sac, { cause: `sacrificed to ${target.name}` });
  else state.characters = state.characters.filter(x => x.id !== sac.id);

  return p;
}

const SacrificeAPI = { SHARE, diminish, ratio, factor, count, totalStats, capStageFor, check, preview, apply };
if (typeof module !== 'undefined') module.exports = SacrificeAPI;
if (typeof window !== 'undefined') window.Sacrifice = SacrificeAPI;
})();
