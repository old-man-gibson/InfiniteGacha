// Mercy: drought prevention for rare rolls. Browser: window.Mercy. Node: module.exports.
//
// A plain chance(p) is memoryless, so waits between hits are geometric and the tail is fat:
// at 1% the 99th-percentile wait is 459 rolls against a mean of 100. Instead the chance
// escalates with every miss on record, P(n) = base + n * slope, and resets on a hit. Base
// and slope are SOLVED so the long-run rate is exactly the authored one; a 2% summon is
// still a 2% summon, it just stops arriving in clumps.
//
// Two domains with opposite thresholds:
//   DROPS / PULLS (rare, < 15%): tracked and uncapped. The counter and the reward come from
//     the same act, so there is nothing to farm.
//   PROCS (common, >= 15%, e.g. crit): tracked and capped at min(rate*3, 75%). Under ~2/rate
//     rolls mercy is backwards (cold first rolls dominate), so rare procs roll plain.
//
// The ledger lives at `ledger[key] = misses`. Keys are created lazily and deleted on a hit,
// so the map stays sparse. The RNG underneath is Rng.rand (cryptographic); mercy adds memory
// to the odds, not to the dice.

(() => {
const MERCY = 0.85;           // how far below nominal the first roll after a hit starts (0 = plain)
const MERCY_MAX_RATE = 0.15;  // drops at or above this roll plain
const PROC_MIN_RATE = 0.15;   // procs below this roll plain
const PROC_CAP_MULT = 3;
const PROC_CAP_MAX = 0.75;

const R = (typeof Rng !== 'undefined') ? Rng : require('./rng.js');

function mercyTracked(rate) { return rate > 0 && rate < MERCY_MAX_RATE; }
function procTracked(rate) { return rate >= PROC_MIN_RATE && rate < 1; }

// Expected rolls per hit for a curve: sum of survival odds after n rolls.
function meanRolls(base, slope, cap) {
  let sum = 0, survival = 1;
  for (let n = 0; n < 500000 && survival > 1e-13; n++) {
    sum += survival;
    const p = Math.min(cap, base + n * slope);
    if (p >= 1) break;
    survival *= 1 - p;
  }
  return sum;
}

const CURVES = new Map();

// Solve the curve whose long-run rate is exactly `rate`. Bisection on the slope; memoized.
function mercyCurve(rate, mercy = MERCY, cap = 1) {
  if (mercy <= 0 || rate <= 0 || rate >= 1) return { base: rate, slope: 0, cap: 1 };
  const key = Math.round(rate * 1e5) * 1e6 + Math.round(mercy * 1e3) * 1e3 + Math.round(cap * 1e3);
  const cached = CURVES.get(key);
  if (cached) return cached;
  const baseFor = (slope) => rate * (1 - mercy) + slope * mercy;
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i++) {
    const slope = (lo + hi) / 2;
    if (1 / meanRolls(baseFor(slope), slope, cap) > rate) hi = slope; else lo = slope;
  }
  const slope = (lo + hi) / 2;
  const curve = { base: baseFor(slope), slope, cap };
  CURVES.set(key, curve);
  return curve;
}

function misses(ledger, key) { return (ledger && ledger[key]) || 0; }
function curveRate(ledger, key, curve) { return Math.min(curve.cap, curve.base + misses(ledger, key) * curve.slope); }

/** Instantaneous chance of a tracked DROP right now (show the authored rate to players, not this). */
function mercyRate(ledger, key, rate, mercy = MERCY) {
  if (!mercyTracked(rate)) return rate;
  return curveRate(ledger, key, mercyCurve(rate, mercy));
}
/** Same for a combat PROC: different threshold, capped. */
function procRate(ledger, key, rate) {
  if (!procTracked(rate)) return rate;
  return curveRate(ledger, key, mercyCurve(rate, MERCY, Math.min(PROC_CAP_MAX, rate * PROC_CAP_MULT)));
}

function miss(ledger, key) { ledger[key] = (ledger[key] || 0) + 1; }
function hit(ledger, key) { delete ledger[key]; }

function roll(ledger, key, p, tracked) {
  const ok = R.rand() < p;
  // A hit clears the key even on an untracked roll so a counter can never pay out twice.
  if (ok) hit(ledger, key); else if (tracked) miss(ledger, key);
  return ok;
}

/** Drop-in for chance() at any roll that is a DROP: something the player waits for and counts. */
function mercyChance(ledger, key, rate, mercy = MERCY) {
  return roll(ledger, key, mercyRate(ledger, key, rate, mercy), mercyTracked(rate));
}
/** A combat PROC (crit, dodge, parry). Key per roller: 'proc:crit:<charId>' or per monster species. */
function procChance(ledger, key, rate) {
  return roll(ledger, key, procRate(ledger, key, rate), procTracked(rate));
}

/**
 * Weighted pick with mercy on whichever entries keyOf names. Each tracked entry's share of
 * the table (weight/total) is read as its rate and replaced by its mercy rate; untracked
 * entries share whatever mass is left in their own proportions. keyOf returning null opts
 * an entry out. Exactly one rand() is consumed.
 */
function mercyPick(ledger, entries, keyOf, weightOf = (e) => e.weight, mercy = MERCY) {
  const total = entries.reduce((s, e) => s + weightOf(e), 0);
  if (total <= 0) return entries[entries.length - 1];
  const keys = [], weights = [];
  let tracked = 0, loose = 0;
  for (const e of entries) {
    const rate = weightOf(e) / total;
    const key = keyOf(e, rate);
    keys.push(key);
    if (key === null || key === undefined) { weights.push(rate); loose += rate; }
    else { const p = mercyRate(ledger, key, rate, mercy); weights.push(p); tracked += p; }
  }
  const spare = Math.max(0, 1 - tracked);
  if (loose > 0) for (let i = 0; i < entries.length; i++) if (keys[i] == null) weights[i] = (weights[i] / loose) * spare;
  let x = R.rand() * weights.reduce((s, w) => s + w, 0);
  let picked = entries.length - 1;
  for (let i = 0; i < entries.length; i++) { x -= weights[i]; if (x <= 0) { picked = i; break; } }
  for (let i = 0; i < entries.length; i++) {
    if (keys[i] == null) continue;
    if (i === picked) hit(ledger, keys[i]); else miss(ledger, keys[i]);
  }
  return entries[picked];
}

const MercyAPI = { MERCY, MERCY_MAX_RATE, PROC_MIN_RATE, PROC_CAP_MULT, PROC_CAP_MAX, mercyTracked, procTracked, mercyCurve, mercyRate, procRate, misses, miss, hit, mercyChance, procChance, mercyPick };
if (typeof module !== 'undefined') module.exports = MercyAPI;
if (typeof window !== 'undefined') window.Mercy = MercyAPI;
})();
