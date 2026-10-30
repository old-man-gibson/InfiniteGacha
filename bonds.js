// Bonds: who actually likes whom. Browser: window.Bonds. Node: module.exports.
//
// temper.js says what two people are LIKELY to make of each other. This file says what they
// made of each other, which is a different thing and is allowed to disagree.
//
// Three terms; temperament is the smallest.
//
//   FIT     `Temper.friction` — how much two tempers have in common. A perfectionist and a
//           slacker grate; two people with the same nerve stand in the same line. This is the
//           EXPECTATION, and it is deliberately the weakest of the three.
//
//   SPARK   a hidden roll made once, the first time two people spend a day near each other, and
//           never made again. It is worth more than fit. A bloodthirsty rogue and a cleric who
//           does everything by the book are an unpromising pair and can still be inseparable,
//           because two people getting on has never been a function of their personality types.
//           Nothing shows it and nothing can reroll it.
//
//   TIME    shifts worked at the same post, nights under the same roof, and — worth far more
//           than either — missions walked together. Fit and spark set the RATE; time is what is
//           actually spent. A bad pairing with a good spark and forty missions ends up further
//           along than a natural pairing that has never left the town. The pair's `runs` count
//           (missions walked together, a lost mission counting 0.5) is also the rapport that
//           Crew.cohesion averages over the party that goes out.
//
// Bonds can go negative. A pair whose rate is under zero spends time getting worse: they work
// the same post for a season and end up unable to stand each other. This is the same mechanism
// running the other way, not a separate penalty, and it is why who goes on a team is a real
// choice and not a sort.
//
// One thing ignores all three terms: coming home from something that went wrong. `forge`
// events add a flat amount whatever the rate says, because two people who watched the same
// person die do not need to have liked each other first. It is the fastest way to make a friend
// in this game and it costs somebody's life.
//
// Storage is sparse. Only pairs that have actually met are kept, keyed low:high, so storage
// grows with the number of pairs that have met and not with the square of the roster size.

(() => {
const R = () => (typeof Rng !== 'undefined') ? Rng : require('./rng.js');
const TE = () => (typeof Temper !== 'undefined') ? Temper : (typeof require !== 'undefined' ? require('./temper.js') : null);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------- the ledger ----------
const MAX = 100;
const key = (a, b) => (a < b ? a + ':' + b : b + ':' + a);
const ensure = (state) => (state.bonds = state.bonds || {});

/**
 * The spark. Bell-ish, so most pairs are unremarkable — and then one pair in eight is thrown to
 * an extreme regardless of what either of them is like, which is where the friendships nobody
 * would have predicted come from, and the feuds.
 */
const UNLIKELY = 0.12;
function rollSpark(rand = null) {
  rand = rand || R().rand;
  let s = ((rand() + rand() + rand()) - 1.5) / 1.5;
  if (rand() < UNLIKELY) s = clamp(s + (s >= 0 ? 1 : -1) * (0.5 + rand() * 0.6), -1, 1);
  return Math.round(s * 100) / 100;
}

/** The record for one pair, made the first time they are in the same place. */
function pair(state, a, b) {
  if (!a || !b || a.id === b.id) return null;
  const bonds = ensure(state);
  const k = key(a.id, b.id);
  if (!bonds[k]) bonds[k] = { v: 0, spark: rollSpark(), runs: 0, shifts: 0, met: Date.now() };
  return bonds[k];
}

const peek = (state, aId, bId) => ensure(state)[key(aId, bId)] || null;
/** What they are to each other right now, -100..100. Strangers are zero. */
const value = (state, aId, bId) => { const p = peek(state, aId, bId); return p ? p.v : 0; };

// ---------- fit, spark, rate ----------
const FIT_W = 0.55;      // what temperament is worth
const SPARK_W = 0.75;    // what luck is worth, which is more

/** The expected fit of these two, -1..+1. An expectation, not a ceiling and not a gate. */
function affinity(state, a, b) {
  const p = pair(state, a, b);
  if (!p) return 0;
  const te = TE();
  const fit = te ? te.friction(a, b) : 0;
  return clamp(FIT_W * fit + SPARK_W * p.spark, -1, 1);
}

/**
 * What an hour in each other's company is worth. Negative for a pair that grates: time spent
 * together is what makes them worse, exactly as it is what makes anyone else better.
 */
const rate = (state, a, b) => 0.35 + 0.85 * affinity(state, a, b);

// ---------- what moves it ----------
// Weights are per event. A shift is a tick of the town clock, so the small ones are small on
// purpose: a friendship is meant to be something you notice happened, not something you watch
// happen. Missions are worth twenty shifts because they are.
const EVENTS = {
  shift:    { w: 0.06, label: 'worked the same post' },
  lodging:  { w: 0.15, label: 'under the same roof' },
  tavern:   { w: 0.12, label: 'drank at the same table' },
  trained:  { w: 0.10, label: 'drilled together' },
  mission:  { w: 4.0,  label: 'walked out together' },
  won:      { w: 1.5,  label: 'a job well done' },
  // forged: the rate does not apply. Nobody chooses this and nobody is unmoved by it.
  survived: { w: 6.0,  label: 'came back from a bad one', forge: true },
  mourned:  { w: 8.0,  label: 'buried the same person',   forge: true },
};

/**
 * One shared thing, between two people. Returns the new value. `mult` scales the move in `v`.
 * `runs` is what a 'mission' event adds to the pair's run count, independent of `mult`: a mission
 * that was lost passes 0.5 (missions.js debrief), so the count is missions won plus half the
 * missions lost. Crew.cohesion reads this count as the pair's rapport.
 */
function note(state, a, b, event, mult = 1, runs = 1) {
  const def = EVENTS[event];
  const p = pair(state, a, b);
  if (!def || !p) return 0;
  // a forged bond ignores the rate entirely; everything else is scaled by whether they get on
  const move = def.forge ? def.w * mult : def.w * mult * rate(state, a, b);
  p.v = clamp(p.v + move, -MAX, MAX);
  if (event === 'mission') p.runs += runs;
  else if (event === 'shift' || event === 'trained') p.shifts++;
  p.last = Date.now();
  p.touched = true;              // drift() skips anybody who was actually together
  return p.v;
}

/** The same thing, for everybody who was there. */
function together(state, chars, event, mult = 1, runs = 1) {
  const list = (chars || []).filter(Boolean);
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) note(state, list[i], list[j], event, mult, runs);
  return list.length;
}

/**
 * People drift. A pair who have not been near each other in a long while slide back toward
 * strangers — slowly, and never past it, so a friendship left alone fades and an old feud cools
 * rather than either being carried forever by a number nobody remembers earning.
 */
const DRIFT = 0.02;
function drift(state) {
  const bonds = ensure(state);
  for (const [k, p] of Object.entries(bonds)) {
    if (p.touched) { p.touched = false; continue; }
    p.v -= Math.sign(p.v) * Math.min(Math.abs(p.v), DRIFT);
    if (Math.abs(p.v) < 0.05 && !p.runs) delete bonds[k];      // strangers again, and cheap again
  }
}

/** Mark every pair in this group as having been together this tick, so drift skips them. */
function touch(state, chars) {
  const list = (chars || []).filter(Boolean);
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const p = peek(state, list[i].id, list[j].id);
    if (p) p.touched = true;
  }
}

// ---------- reading it ----------
const TIERS = [
  { min: -MAX, word: 'hatred',       icon: '🗡️', color: '#c94b4b', close: false },
  { min: -60,  word: 'a feud',       icon: '⚡', color: '#c96a6a', close: false },
  { min: -32,  word: 'bad blood',    icon: '💢', color: '#b08080', close: false },
  { min: -12,  word: 'cool',         icon: '',   color: '#8a8a9a', close: false },
  { min: 12,   word: 'familiar',     icon: '',   color: '#9aa0b0', close: false },
  { min: 26,   word: 'friends',      icon: '🤝', color: '#6ea8ff', close: true },
  { min: 52,   word: 'close',        icon: '💠', color: '#5fbf7f', close: true },
  { min: 78,   word: 'inseparable',  icon: '💛', color: '#ffd740', close: true },
];
// 'cool' spans -12..12, which is everybody who has met and not much else. Strangers get nothing.
const tierOf = (v) => TIERS.filter(t => v >= t.min).pop() || TIERS[0];
const isClose = (state, aId, bId) => tierOf(value(state, aId, bId)).close;

/** Everyone this character has a reading on, strongest first. `chars` is the live roster. */
function relations(state, c, chars, { min = 12 } = {}) {
  const out = [];
  for (const o of chars) {
    if (o.id === c.id) continue;
    const p = peek(state, c.id, o.id);
    if (!p || Math.abs(p.v) < min) continue;
    out.push({ c: o, v: p.v, runs: p.runs, tier: tierOf(p.v) });
  }
  return out.sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
}

const friendsOf = (state, c, chars) => relations(state, c, chars).filter(r => r.v > 0);
const enemiesOf = (state, c, chars) => relations(state, c, chars).filter(r => r.v < 0);
/** The one person this character would look for on a day off, if there is one. */
const closestTo = (state, c, chars) => friendsOf(state, c, chars).filter(r => r.tier.close)[0] || null;

// ---------- what it is worth ----------
/**
 * How well a party actually works together, as a multiplier. temper.js's `accord` is the guess
 * you make before they have met; this is what happened, and it takes over in proportion to how
 * much of a bond there is to take over with. A party of strangers is still judged on temperament,
 * a party of veterans on what they are to each other, and nothing in between jumps.
 */
const ACCORD = 0.22;      // what a party of inseparables is worth over one of strangers
function accord(state, party) {
  const te = TE();
  const guess = te ? te.accord(party) : 1;
  if (!party || party.length < 2) return guess;
  let sum = 0, weight = 0, n = 0;
  for (let i = 0; i < party.length; i++) for (let j = i + 1; j < party.length; j++) {
    const v = value(state, party[i].id, party[j].id) / MAX;
    sum += v; weight += Math.abs(v); n++;
  }
  if (!n) return guess;
  const known = clamp(weight / n / 0.5, 0, 1);          // half a bond across the party is "known"
  return guess * (1 - known) + (1 + ACCORD * (sum / n)) * known;
}

/**
 * What the company is worth to one person's mood right now. `near` is whoever they are sharing
 * a post or a roof with. A friend on the same shift is most of what makes a bad post bearable,
 * and somebody they cannot stand is most of what makes a good one unbearable.
 */
const MOOD_CAP = 14;
function company(state, c, near) {
  let m = 0;
  for (const o of near) {
    if (!o || o.id === c.id) continue;
    m += value(state, c.id, o.id) * 0.12;
  }
  return clamp(m, -MOOD_CAP, MOOD_CAP);
}

/**
 * Who `c` was close to, as plain data: up to `max` positive bonds at or above the relations()
 * threshold, strongest first. roster.js takes this before mourn() deletes the pairs and keeps it
 * on the memorial record.
 */
function snapshot(state, c, chars, { max = 4 } = {}) {
  return friendsOf(state, c, chars).slice(0, max)
    .map(r => ({ id: r.c.id, name: r.c.name, v: Math.round(r.v), word: r.tier.word, runs: r.runs || 0 }));
}

/**
 * Who would grieve `c`, and by how much: one row { c, v, hit, tier } for each character in `chars`
 * whose bond with `c` is above 12, strongest first. `hit` is min(35, GRIEF x v) morale points.
 * Changes nothing. mourn() applies these rows, and the altar lists them before a sacrifice, so
 * the figure shown and the figure applied come from this one expression.
 */
const GRIEF = 0.55;       // morale points per point of bond
const GRIEF_CAP = 35;     // most morale one death can cost one friend
function grief(state, c, chars) {
  const bonds = state.bonds || {};
  const rows = [];
  for (const o of chars) {
    if (o.id === c.id) continue;
    const p = bonds[key(c.id, o.id)];
    if (p && p.v > 12) rows.push({ c: o, v: p.v, hit: Math.min(GRIEF_CAP, p.v * GRIEF), tier: tierOf(p.v) });
  }
  return rows.sort((a, b) => b.v - a.v);
}

/**
 * Somebody is dead. Everyone who had a reading on them feels it in proportion to what they were
 * to each other — and the pair records go, because the alternative is a ledger that grows for
 * the rest of the save with the names of people who are not in it. Returns what to say out loud.
 */
function mourn(state, fallenId, chars, { morale = null } = {}) {
  const bonds = ensure(state);
  const felt = grief(state, { id: fallenId }, chars);
  if (morale) for (const f of felt) morale(f.c, -f.hit);
  // every pair that names the dead character, whether or not it was strong enough to grieve
  for (const k of Object.keys(bonds)) {
    const [x, y] = k.split(':').map(Number);
    if (x === fallenId || y === fallenId) delete bonds[k];
  }
  return felt;
}

/** Drop pairs naming anyone who is no longer on the roster. */
function tidy(state, chars) {
  const live = new Set(chars.map(c => c.id));
  const bonds = ensure(state);
  for (const k of Object.keys(bonds)) {
    const [x, y] = k.split(':').map(Number);
    if (!live.has(x) || !live.has(y)) delete bonds[k];
  }
}

/**
 * One line about a pair, for a sheet: the tier word and the run count. The count is missions won
 * plus half of each mission lost, so a fractional count says "lost ones counting half".
 */
function describe(state, a, b) {
  const p = peek(state, a.id, b.id);
  if (!p) return null;
  const t = tierOf(p.v);
  const whole = p.runs % 1 === 0;
  return {
    tier: t, v: p.v, runs: p.runs, shifts: p.shifts,
    text: p.runs ? `${t.word} — ${whole ? p.runs : p.runs.toFixed(1)} mission${p.runs === 1 ? '' : 's'} together${whole ? '' : ', lost ones counting half'}` : t.word,
  };
}

const BondsAPI = {
  MAX, EVENTS, TIERS, FIT_W, SPARK_W, GRIEF, GRIEF_CAP,
  key, ensure, pair, peek, value, rollSpark, affinity, rate,
  note, together, touch, drift, tierOf, isClose,
  relations, friendsOf, enemiesOf, closestTo,
  accord, company, snapshot, grief, mourn, tidy, describe,
};
if (typeof module !== 'undefined') module.exports = BondsAPI;
if (typeof window !== 'undefined') window.Bonds = BondsAPI;
})();
