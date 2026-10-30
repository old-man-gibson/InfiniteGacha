// Potential: how well a character's stat spread fits the race they were born to.
// Browser: window.Potential. Node: module.exports.
//
// Why this is not a stat total. Every character at a given star tier has exactly the same number
// of base points — stats.js hands out STARS[n].budget and nothing else, and the drift fix at the
// end of rollBaseStats guarantees it to the point. So a 3★ is never worth more base points than
// another 3★. What separates two 3★ orcs is entirely where those 62 points landed, and that is
// the only thing there is to grade.
//
// A race is a set of pulls (stats.js RACE_TENDENCIES): an orc pulls 1.6 toward STR and 0.6 toward
// INT. rollBaseStats multiplies each pull by uniform noise in [0.7, 1.3] and normalises. A lucky
// orc is one whose noise happened to favour the stats an orc was already being pulled toward; an
// unlucky one poured its budget into the wisdom it will never use. Both cost the same pull.
//
// Two numbers are needed.
//
//   fit(c)   = SUM( tendency[s] * base[s] ) / SUM( base[s] )
//
// A weighted mean of the race's own pulls, weighted by where the points actually are. It is
// unitless — a ratio of points to points — so it does not grow just because a character did, and
// two characters four tiers apart can be compared on it directly.
//
//   reach(c) = MAX over the base classes of ( MIN over that class's required stats of base[s]/req[s] )
//
// How close they stand to the nearest career. Every base class in classes.js guards itself with a
// hard stat bar — a Fighter wants STR 10, a Rogue DEX 13, an Elemental Mage INT 13 — and a
// character who clears none of them cannot be given a class at all. 1.0 is standing exactly on
// the nearest bar; below it every door is shut.
//
// Fit alone is not enough. More than half of everyone is human, and a human pulls 1.0 in all
// six directions, so fit is the same number for every human alive. A measure that cannot tell one
// human from another cannot be filtered on. Reach can: a 1★ human at 7/7/7/7/6/6 qualifies for
// nothing, and a 1★ human who put 14 into DEX is a Rogue. This is not a judgement about
// all-rounders — prowess.js already ruled that shape is a description and not a grade, and this
// does not contradict it. Reach is a threshold that is either met or not.
//
// Reach alone is not enough. It only knows about bars. Two orcs both holding STR 16 have the
// same classes open, but the one who put the rest into CON is built the way an orc is built and
// the one who put it into CHA is not, and they will diverge over every point of damage taken.
//
// Neither is a stand-in for the other, and there is no third: everything else worth knowing about
// a character — what they have been taught, what they carry, how well they think — is already
// somewhere else and is not a fact about the roll.
//
// Both numbers describe the roll and nothing else. They are read from `stats.born` — the block
// the character walked out of the gate with — and never from `stats.base`, which moves for the
// rest of their life. So a character's potential is fixed at summon and never changes again.
//
// The source matters. `base` is written to by two things, and reading it made the grade wrong:
//   * an offering at the altar pours the DONOR's spread into the vessel, so a grade read off
//     `base` swung on how somebody else's points happened to be arranged. A character's own roll
//     is not better or worse because of who was spent on them.
//   * advance() adds the tier's points proportionally and then dumps the remainder into whatever
//     is already highest, so it drifted the grade by about a band per two tiers.
// Both made a fixed property of a character look like a moving one. Potential is what they were
// born with; what they are worth TODAY is the stat line, the aptitudes and the prowess chart, and
// those are all on the sheet already.

// The tier still matters. STAT_MAX is 30. A halfgiant at 5★ wants 92*1.7/6.1 = 26 STR and
// is closing on the ceiling; push further and the clamp shoves the overflow into stats it does not
// want, so the best achievable fit falls as the tier rises. The same raw fit is therefore a
// different achievement at 1★ than at 5★, so the grade is not read off fit directly — it is read
// off where fit lands among rolls of THAT race at THAT tier.
//
// The reference distribution is sampled rather than solved: rollBaseStats is the definition of
// what an ordinary roll looks like, clamp and drift fix included, and sampling it cannot drift
// out of agreement with the generator the way a closed form would. It is deliberately not drawn
// from rng.js — that source is real entropy, and a grade that moved every time you opened the
// roster would not be a property of the character. The percentile depends on the character's
// roll and the fixed reference only.
//
// Gear is not counted, on the rule stats.js already sets: `base` is who they are, `effective` is
// what they can do. Potential is a statement about the person, so it reads base and only base.

(() => {
const S = () => (typeof Stats !== 'undefined') ? Stats : require('./stats.js');

const SAMPLES = 2000;         // per race/tier; a few ms to build, built once, cached for the session

// What the percentile is called. Bands, not a formula, so rebalancing is a number change.
// `at` is the floor: the first row from the top whose `at` the percentile clears wins. The label
// is the band's own percentile range, because that is what the letter means and there is no
// shorter true way to say it.
const GRADES = [
  { at: 99, id: 'S+', label: '99th percentile and up' },
  { at: 96, id: 'S',  label: '96th to 99th' },
  { at: 88, id: 'A',  label: '88th to 96th' },
  { at: 72, id: 'B',  label: '72nd to 88th' },
  { at: 45, id: 'C',  label: '45th to 72nd' },
  { at: 20, id: 'D',  label: '20th to 45th' },
  { at: 6,  id: 'E',  label: '6th to 20th' },
  { at: 0,  id: 'F',  label: 'below 6th' },
];
const COLORS = { 'S+': '#ffd740', S: '#ffa726', A: '#ab47bc', B: '#42a5f5', C: '#6fbf73', D: '#a9a06a', E: '#8f8f8f', F: '#a05a5a' };
const GRADE_IDS = GRADES.map(g => g.id);
const gradeAt = (pct) => GRADES.find(g => pct >= g.at) || GRADES[GRADES.length - 1];

/** A tiny LCG. The calibration table must come out identical in every session and on every machine. */
function seeded(seed) {
  let x = seed >>> 0;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}
function seedOf(race, stars) {
  let h = 0x811c9dc5;
  const str = race + '@' + stars;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}

const tendOf = (race) => S().RACE_TENDENCIES[race] || S().RACE_TENDENCIES.human;

/** The weighted mean pull of where a stat block's points actually sit. */
function fitOf(base, race) {
  const st = S(), tend = tendOf(race);
  let num = 0, den = 0;
  for (const k of st.BASE_STATS) { num += tend[k] * base[k]; den += base[k]; }
  return den ? num / den : 0;
}

// The stat bars, read out of classes.js rather than copied: only the seven bases carry a `req`,
// because only a base is ever chosen, and their bars are the doors a fresh character can walk
// through. Read once — the class table does not change at runtime.
let barsCache = null;
function bars() {
  if (barsCache) return barsCache;
  const cl = (typeof Classes !== 'undefined') ? Classes : require('./classes.js');
  return (barsCache = cl.LIST
    .filter(c => c.base && c.req && c.req.stats && Object.keys(c.req.stats).length)
    .map(c => ({ id: c.id, name: c.name, req: c.req.stats })));
}

/**
 * How close this block stands to the nearest career. A class wanting two stats is only as open as
 * its worse one — clearing STR 12 for a Barbarian is worth nothing without the CON 12 beside it —
 * so each class scores on its weakest requirement, and the character scores on its best class.
 */
function reachOf(base) {
  let best = 0, which = null;
  for (const b of bars()) {
    let worst = Infinity;
    for (const [k, need] of Object.entries(b.req)) worst = Math.min(worst, base[k] / need);
    if (worst > best) { best = worst; which = b; }
  }
  return { reach: best, nearest: which };
}

// What a point of reach is worth against a point of fit. Set so that across the pullable tiers the
// two contribute comparable spread for a race that has a shape at all; for a race that has none,
// fit contributes nothing and this weight is the whole score. Tune it here, in one place.
const REACH_W = 0.22;
const scoreOf = (base, race) => fitOf(base, race) + REACH_W * reachOf(base).reach;

// ---------- the reference distribution ----------
// One entry per race/tier actually looked at: the sorted scores of SAMPLES ordinary rolls, and
// what the average one of those rolls put in each stat.
//
// Above the pull ceiling the reference cohort is built, not rolled. 6★ and 7★ carry a pull weight
// of 0 in stats.js: the gate cannot produce one, so everybody standing at those tiers advanced
// into them, and sampling rollBaseStats(race, 7) would measure a character against a population
// that does not exist. It also measures them badly. Those budgets run hard into STAT_MAX — a 7★
// halfgiant wants 36 STR, is allowed 30, and every point of the overflow lands in the dexterity
// and wisdom a halfgiant has no use for. Fresh 7★ rolls therefore all collapse into a band a few
// thousandths wide and sit far below any 5★ roll, so grading a 7★ either way reported a sound
// character as wasted: against its own tier the percentile was noise, and against 5★ it was
// graded down for hitting STAT_MAX.
//
// So the cohort above the ceiling is assembled the way the real one is: rolled at a tier the gate
// actually offers, weighted by that tier's own pull odds, then advanced up with the game's own
// advance(). Everyone in the reference took the same clamping on the way, so what is left to
// compare is the only thing that was ever in question — where the points were placed.
const table = new Map();

function sample(race, stars, rand) {
  const st = S();
  if (stars <= st.MAX_PULL_STARS) return st.rollBaseStats(race, stars, rand);
  let s = st.rollCharacterStats(race, rand, st.rollStars(rand));
  while (s.stars < stars) s = st.advance(s);
  return s.base;
}

function calibrate(race, stars) {
  const key = race + '@' + stars;
  const hit = table.get(key);
  if (hit) return hit;
  const st = S();
  const rand = seeded(seedOf(race, stars));
  const scores = new Array(SAMPLES);
  const mean = Object.fromEntries(st.BASE_STATS.map(k => [k, 0]));
  for (let i = 0; i < SAMPLES; i++) {
    const b = sample(race, stars, rand);
    scores[i] = scoreOf(b, race);
    for (const k of st.BASE_STATS) mean[k] += b[k];
  }
  for (const k of st.BASE_STATS) mean[k] /= SAMPLES;
  scores.sort((a, b) => a - b);
  const entry = { scores, mean, budget: (st.STARS[stars] || st.STARS[1]).budget,
                  built: stars > st.MAX_PULL_STARS };
  table.set(key, entry);
  return entry;
}

/**
 * Where a score sits among SAMPLES ordinary rolls, 0..100, to a tenth.
 *
 * Ties take the midpoint of the tied run rather than its bottom. Stats are integers and so are the
 * class bars, so reach is a ratio of small whole numbers and identical scores are common — counting
 * only what falls strictly below would report a character as worse than the tenth of the population
 * it is exactly level with. Two binary searches for the ends of the run, because at the low tiers
 * that run can be hundreds long.
 */
function percentileIn(entry, score) {
  const a = entry.scores;
  const seek = (over) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (over ? a[m] <= score : a[m] < score) lo = m + 1; else hi = m; } return lo; };
  return Math.round((seek(false) + seek(true)) * 500 / a.length) / 10;
}

// ---------- reading a character ----------

// Read once per card per render and once per row in every filter pass, so it is memoised against
// the stats it was computed from. A WeakMap rather than a field on the character, for the reason
// stats.js gives for the same choice: a field would be saved, go stale the moment training or an
// offering moved a stat, and have to be migrated. Nothing here survives a reload; nothing here
// can be wrong.
const cache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

/**
 * Everything there is to say about one character's roll.
 *
 * `spread` compares them stat by stat against the average roll of their race and tier, scaled to
 * the points they actually have. The scaling matters on a used roster: a vessel that has absorbed
 * three offerings carries far more than its tier's budget, and comparing it raw would report it
 * above average in all six at once, which says nothing. Scaled, the deltas still sum to about
 * zero and still answer the only question — is this budget in the right places.
 */
function of(c) {
  const st = S();
  const born = c.stats.born || st.freezeBorn(c.stats).born;
  const base = born.base, race = c.race, stars = born.stars;
  const sig = race + '@' + stars + ':' + st.BASE_STATS.map(k => base[k]).join(',');
  const hit = cache && cache.get(c);
  if (hit && hit.sig === sig) return hit;

  const entry = calibrate(race, stars);
  const fit = fitOf(base, race);
  const { reach, nearest } = reachOf(base);
  const pct = percentileIn(entry, fit + REACH_W * reach);
  const g = gradeAt(pct);
  const total = st.BASE_STATS.reduce((a, k) => a + base[k], 0);
  const scale = entry.budget ? total / entry.budget : 1;
  const tend = tendOf(race);
  const spread = st.BASE_STATS.map(k => ({
    key: k, have: base[k], expect: entry.mean[k] * scale, delta: base[k] - entry.mean[k] * scale, pull: tend[k],
  })).sort((a, b) => b.delta - a.delta);

  const out = { sig, fit, reach, nearest, percentile: pct, grade: g.id, label: g.label,
                color: COLORS[g.id], rank: rankOfGrade(g.id), spread, total, race, stars, tend,
                cohortBuilt: !!entry.built, estimated: !!born.estimated };
  if (cache) cache.set(c, out);
  return out;
}

/** 0 is F and 7 is S+, so a filter can ask for "B or better" with one comparison. */
const rankOfGrade = (id) => GRADE_IDS.length - 1 - GRADE_IDS.indexOf(id);
const gradeOf = (c) => of(c).grade;
const rankOf = (c) => of(c).rank;

const reqText = (b) => Object.entries(b.req).map(([k, v]) => `${k.toUpperCase()} ${v}`).join(' + ');
const an = (word) => (/^[aeiou]/i.test(word) ? 'an ' : 'a ') + word;

/**
 * One line for a tooltip. Same figures as the sheet block, on one line: grade, percentile, sample
 * size, the two component values, and the largest deviations from the mean roll.
 */
function explain(c) {
  const p = of(c);
  const dev = p.spread.filter(s => Math.abs(s.delta) >= 0.5)
    .map(s => `${s.key.toUpperCase()} ${s.delta > 0 ? '+' : ''}${s.delta.toFixed(1)}`).join(' ');
  const cohort = p.cohortBuilt ? `${c.race} rolls advanced to ${p.stars}★` : `${p.stars}★ ${c.race} rolls`;
  return `Potential ${p.grade} (${p.label}). Birth stat block scores at percentile ${p.percentile} of ${SAMPLES} simulated ${cohort}. ` +
    `Placement ${p.fit.toFixed(3)} = sum(race tendency x stat) / sum(stat). ` +
    `Reach ${p.reach.toFixed(2)} = best of (stat / class requirement)` +
    (p.nearest ? `, nearest ${p.nearest.name} (${reqText(p.nearest)})` : '') + '. ' +
    (dev ? `Deviation from the mean roll of ${p.total} points: ${dev}. ` : '') +
    (p.estimated ? 'Birth block was not recorded for this character and is estimated from current stats.' : '');
}

const PotentialAPI = { GRADES, GRADE_IDS, COLORS, SAMPLES, REACH_W, fitOf, reachOf, scoreOf, bars, calibrate, of, gradeOf, rankOf, rankOfGrade, explain, gradeAt };
if (typeof module !== 'undefined') module.exports = PotentialAPI;
if (typeof window !== 'undefined') window.Potential = PotentialAPI;
})();
