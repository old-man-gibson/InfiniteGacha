// Character intelligence: how well a character builds its own loadouts. Browser: window.AI. Node: module.exports.
//
// Every character carries an ACUMEN score, derived from INT and WIS and nudged by hidden mind
// traits. Acumen sets a tier, and the tier fixes how a character reasons when it prepares
// for a mission:
//
//   dim        one random legal build, no scoring at all
//   plain      a few candidates, scored through heavy noise
//   sharp      many candidates, mild noise, picks a doctrine that fits its stats
//   brilliant  many candidates, little noise, doctrine chosen against the mission's enemies
//   genius     exhaustive-ish search, no noise, and a second refinement pass
//
// All three build systems (spellcraft, psionics, martial) go through `decide()` below, so
// "stupid" and "smart" mean the same thing everywhere: how many options the character
// considers and how clearly it can tell them apart. Builds are only made when a mission is
// launched (see missions.js), never per tick, and are cached against a signature of the
// inputs so an unchanged character keeps its plan.

(() => {
const R = (typeof Rng !== 'undefined') ? Rng : require('./rng.js');
// Resolved on use: a browser reads script tags in order and binding at parse time would make
// this file depend on where it sits in the list.
const P = () => (typeof Prof !== 'undefined') ? Prof : require('./proficiency.js');
const St = () => (typeof Stats !== 'undefined') ? Stats : require('./stats.js');
// Optional: some classes are trained to read ground (classes.js).
const CL = () => (typeof Classes !== 'undefined') ? Classes : (typeof require !== 'undefined' ? require('./classes.js') : null);
// Optional: what the character WANTED before it started thinking (temper.js). Acumen decides how
// well two plans can be told apart; temper decides how many get looked at and which one appeals.
const TE = () => (typeof Temper !== 'undefined') ? Temper : (typeof require !== 'undefined' ? require('./temper.js') : null);

const TIERS = [
  { id: 'dim',       min: 0,  label: 'Dim',       candidates: 1,  noise: 1.0,  refine: 0, color: '#9a9a9a' },
  { id: 'plain',     min: 10, label: 'Plain',     candidates: 4,  noise: 0.6,  refine: 0, color: '#bbb' },
  { id: 'sharp',     min: 16, label: 'Sharp',     candidates: 12, noise: 0.25, refine: 0, color: '#42a5f5' },
  { id: 'brilliant', min: 22, label: 'Brilliant', candidates: 24, noise: 0.08, refine: 1, color: '#ab47bc' },
  { id: 'genius',    min: 27, label: 'Genius',    candidates: 48, noise: 0,    refine: 2, color: '#ffd740' },
];

// Hidden mind traits, rolled once at summon. Never shown as such; visible only through behaviour.
const MIND_TRAITS = {
  savant:       { weight: 4,  desc: 'Reasons one tier above its acumen' },
  scatterbrain: { weight: 6,  desc: 'Reasons one tier below its acumen' },
  gambler:      { weight: 6,  desc: 'Leans toward burst plans' },
  miser:        { weight: 6,  desc: 'Leans toward efficient plans' },
  schemer:      { weight: 6,  desc: 'Leans toward condition stacking' },
  none:         { weight: 72, desc: '' },
};

// Doctrines: what a plan is optimised for. Scorers in each subsystem read these weights.
const DOCTRINES = {
  efficiency: { label: 'Efficiency', desc: 'Most damage per point of resource; long fights',        w: { dpr: 1.0, burst: 0.2, stack: 0.4, sustain: 0.8 } },
  stacking:   { label: 'Stacking',   desc: 'Conditions that feed each other; wins by attrition',     w: { dpr: 0.5, burst: 0.2, stack: 1.2, sustain: 0.5 } },
  burst:      { label: 'Burst',      desc: 'Front-load everything the pool allows; short fights',    w: { dpr: 0.3, burst: 1.2, stack: 0.2, sustain: 0.1 } },
};

function rollMindTraits(rand = R.rand) {
  const total = Object.values(MIND_TRAITS).reduce((a, t) => a + t.weight, 0);
  let x = rand() * total;
  for (const [k, t] of Object.entries(MIND_TRAITS)) { x -= t.weight; if (x < 0) return k === 'none' ? [] : [k]; }
  return [];
}

const hasTrait = (c, t) => !!(c.mind && c.mind.traits && c.mind.traits.includes(t));

function acumen(c) {
  // Gear counts here too. A staff that says +INT has to mean it everywhere INT is read, or the
  // player is left memorising which half of the game the number applies to.
  const b = St().effective(c).base;
  return (b.int + b.wis) / 2;
}

function tierIndex(c) {
  const a = acumen(c);
  let i = 0;
  for (let k = 0; k < TIERS.length; k++) if (a >= TIERS[k].min) i = k;
  if (hasTrait(c, 'savant')) i = Math.min(TIERS.length - 1, i + 1);
  if (hasTrait(c, 'scatterbrain')) i = Math.max(0, i - 1);
  return i;
}
function tier(c) { return TIERS[tierIndex(c)]; }

/**
 * Pick a doctrine. Dim and plain minds pick at random (a trait can still pull them). Sharp
 * minds go by their own stats. Brilliant and better read the enemy profile when given one:
 * enemies with lots of HP reward attrition, fragile ones reward burst.
 */
function doctrine(c, enemy = null) {
  const t = tier(c);
  const b = St().effective(c).base;
  const bias = hasTrait(c, 'gambler') ? 'burst' : hasTrait(c, 'miser') ? 'efficiency' : hasTrait(c, 'schemer') ? 'stacking' : null;
  // Each doctrine is weighted by a temper axis. Somebody who wants everything now (appetite)
  // reaches for burst, somebody who owes the task (rigor) reaches for efficiency, and somebody
  // who works on other minds (guile) reaches for conditions. A dim character has no idea why it
  // prefers what it prefers, but it still prefers it, so this weights the random pick instead of
  // replacing it.
  const te = TE();
  const want = te ? { efficiency: te.lean(c, 'rigor', 0.5), stacking: te.lean(c, 'guile', 0.55), burst: te.lean(c, 'appetite', 0.55) }
                  : { efficiency: 1, stacking: 1, burst: 1 };
  if (t.id === 'dim' || t.id === 'plain') {
    if (bias && R.chance(0.7)) return bias;
    return R.weightedPick(Object.keys(DOCTRINES), (k) => Math.max(0.05, want[k]));
  }
  const scores = { efficiency: b.int + b.wis * 0.5, stacking: b.wis + b.int * 0.5, burst: b.str + b.dex };
  for (const k of Object.keys(scores)) scores[k] *= want[k];
  if (bias) scores[bias] *= 1.5;
  if (enemy && t.refine > 0) {
    // enemy = { hpRatio (enemy hp vs our burst), count, resistant: true when heavily resisting our main types }
    if (enemy.hpRatio > 1.5) { scores.efficiency *= 1.3; scores.stacking *= 1.3; }
    if (enemy.hpRatio < 0.8) scores.burst *= 1.6;
    if (enemy.count > 1) scores.stacking *= 1.2;
  }
  return Object.entries(scores).sort((a, b2) => b2[1] - a[1])[0][0];
}

/**
 * Bounded-rational choice. generate() returns a random legal candidate; score(candidate)
 * returns a number (higher is better); refine(candidate) returns an improved neighbour or
 * the same candidate. The tier decides how many candidates are looked at, how noisy the
 * comparison is, and how many refinement passes the winner gets.
 */
function decide(c, { generate, score, refine = null, candidates = null }) {
  const t = tier(c);
  const te = TE();
  // Acumen sets how well the character judges and temper sets how much work it does. The tier
  // fixes how clearly this character can tell two plans apart; how many it bothers to lay out
  // (`effort`), and whether it goes back over the winner (`fussy`), depend on the person. A dim
  // perfectionist grinds through forty options it cannot rank and a genius slacker glances at
  // two and takes the better one, and both outcomes are intended.
  const n = Math.max(1, Math.round((candidates || t.candidates) * (te ? te.effort(c) : 1)));
  const passes = t.refine + (te && te.fussy(c) ? 1 : 0);
  let best = null, bestScore = -Infinity;
  for (let i = 0; i < n; i++) {
    const cand = generate(i);
    if (cand == null) continue;
    let s = t.id === 'dim' ? R.rand() : score(cand);
    if (t.noise > 0 && t.id !== 'dim') s *= 1 + t.noise * R.jitter();
    if (s > bestScore) { bestScore = s; best = cand; }
  }
  if (best && refine) for (let r = 0; r < passes; r++) {
    const alt = refine(best);
    if (alt && alt !== best && score(alt) > score(best)) best = alt;
  }
  return best;
}

// ---------- scouting ----------
//
// SCOUTING is the other half of a mind: not how well a character plans a fight but how well it
// reads ground it has never walked. 0..100, and unlike acumen it is a PARTY question — everyone
// follows whoever can read the ground, so only the best scout in the party counts.
//
// Three parts, because a scout is three things: an eye (WIS, which is also what the senses stat
// is built from), fieldcraft — the better of foraging and bow, the two aptitudes that are about
// tracks and distance — and a head to hold a map in.
//
// PERFECT is the line at which a party stops guessing. Below it they have to FIND an objective
// before they can walk at it, and until then they are searching a dark map (see field.js).
// At or above it they walk in from the gate already knowing the way. It is deliberately hard:
// 80 wants an exceptional WIS, a genuinely trained aptitude and a sharp mind in ONE character,
// which is somebody built to be a scout rather than any five bodies thrown at a map.
const PERFECT = 80;

const SCOUT_TIERS = [
  { min: 0,  label: 'lost',            desc: 'picks somewhere to look at random' },
  { min: 30, label: 'guessing',        desc: 'commits to a direction, often the wrong one' },
  { min: 55, label: 'reads the ground', desc: 'usually searches toward the objective' },
  { min: PERFECT, label: 'knows the way', desc: 'no searching at all: the map is known from the gate' },
];

function scouting(c) {
  const b = St().effective(c).base;
  const p = P();
  const apt = (k) => (c.profs && c.profs[k]) ? p.share(c.profs[k]) : 0;  // fraction of the top of A+
  const eye = Math.min(1, b.wis / 26);
  const craft = Math.min(1, Math.max(apt('foraging'), apt('bow')));
  const head = Math.min(1, acumen(c) / 26);
  // a class that is about walking unknown ground adds to this outright: a Ranger is a Ranger
  const cl = CL();
  const taught = cl ? cl.scoutBonus(c) : 0;
  return Math.min(100, Math.round(100 * (0.45 * eye + 0.35 * craft + 0.2 * head) + taught));
}

/** The party's scout is its best one. */
const bestScout = (party) => party.reduce((n, c) => Math.max(n, scouting(c)), 0);

const scoutTier = (n) => SCOUT_TIERS.filter(t => n >= t.min).pop();

/** Cheap fingerprint of everything a build depends on. */
function signature(c) {
  const b = c.stats.base;
  const profs = Object.entries(c.profs || {}).map(([k, p]) => k + p.stage).join(',');
  const eq = Object.values(c.equipment || {}).filter(Boolean).map(i => i.key + i.quality).join(',');
  const temper = c.temper ? Object.values(c.temper).join('.') : '';
  return [c.stats.stars, b.str, b.dex, b.con, b.int, b.wis, b.cha, profs, eq, (c.mind && c.mind.traits || []).join(''), temper, (c.gifts || []).join('')].join('|');
}

function describe(c) {
  const t = tier(c);
  return { tier: t, acumen: acumen(c) };
}

const AIAPI = { TIERS, MIND_TRAITS, DOCTRINES, PERFECT_SCOUT: PERFECT, SCOUT_TIERS, rollMindTraits, hasTrait, acumen, tier, tierIndex, doctrine, decide, signature, describe, scouting, bestScout, scoutTier };
if (typeof module !== 'undefined') module.exports = AIAPI;
if (typeof window !== 'undefined') window.AI = AIAPI;
})();
