// Temper: who somebody is when nobody is giving orders. Browser: window.Temper. Node: module.exports.
//
// classes.js says what a character was TRAINED to do and ai.js says how well they can think it
// through. Neither says what they WANT. A Fighter is a Fighter, but one of them chases a wounded
// enemy off the map and the other holds the line and lets it go, and nothing in a class or an INT
// score can tell you which. This file is that difference.
//
// There are five axes, and each one owns a question none of the others can answer:
//
//   NERVE     what they do about DANGER          craven ... fearless
//   APPETITE  how much is enough                 ascetic ... ravenous
//   RIGOR     what they owe THE TASK             slapdash ... exacting
//   GRIT      what they do about HARDSHIP        brittle ... indomitable
//   GUILE     how they read OTHER MINDS          naive ... conniving
//
// Each is 0..100 with the roster clustered around 50, and is read as a TILT in -1..+1. Nothing in
// the game reads a raw number: everything reads `lean(c, axis, k)`, a multiplier of 1 plus or
// minus k, so a call site says how much this axis is worth to it and the axis says which way.
//
// Why there are no more axes. "Smart" is not here on purpose -- ai.js already owns it, and it
// owns a different thing: acumen is how well you can tell two plans apart, temper is which plan
// you wanted before you looked. A dim perfectionist grinds through forty bad options; a genius
// slacker glances at two and takes the better one. Loyalty is not here either: crew.js owns who
// works well beside whom, and this file only adds friction to it.
//
// Why there are no fewer. Drop any one of these and two characters the player wants to tell
// apart collapse into each other. Without NERVE a coward and a quitter are the same person.
// Without APPETITE a berserker and a bodyguard are. Without RIGOR a perfectionist and a plodder,
// without GRIT a hero and a fanatic, without GUILE a schemer and a thug.
//
// Names are readings of the axes, not stored properties. "Bloodthirsty" is not stored anywhere
// and nothing branches on it. It is what `read()` calls a character whose appetite and nerve are
// both high, computed by projecting the five numbers onto a handful of authored directions and
// taking the closest one. Behaviour reads axes; names read axes; names never reach behaviour. So
// adding a name changes no character, and changing an axis changes every system that reads it.
//
// Greed is not an axis, and neither is bloodlust. Both are appetite combined with another axis:
// appetite spent through nerve is bloodlust, appetite spent through guile is greed, appetite held
// back by rigor is ambition. The behaviour comes from the products of the axes, not from any
// single term.
//
// Temper is independent of stars. A five-star slacker and a one-star indomitable are both
// possible and both should occur: if the high-star pulls were also the best-tempered people, the
// roster would vary along one axis instead of five.

(() => {
const R = () => (typeof Rng !== 'undefined') ? Rng : require('./rng.js');

// ---------- the axes ----------
// `bands` run low to high and are what a character is ever SHOWN as: five words, no numbers.
// `note` is what that band actually does, in the player's language, for the character sheet.
const AXES = {
  nerve: {
    label: 'Nerve', of: 'danger',
    bands: [
      { max: 17,  word: 'craven',   note: 'runs early, and takes others with them' },
      { max: 37,  word: 'wary',     note: 'wants the odds counted before the fight' },
      { max: 61,  word: 'level',    note: 'stands while the line stands' },
      { max: 81,  word: 'bold',     note: 'takes the front rank and keeps it' },
      { max: 100, word: 'fearless', note: 'does not know when to be afraid' },
    ],
  },
  appetite: {
    label: 'Appetite', of: 'wanting',
    bands: [
      { max: 17,  word: 'ascetic',  note: 'wants nothing, and finishes early' },
      { max: 37,  word: 'content',  note: 'does the job and comes home' },
      { max: 61,  word: 'hungry',   note: 'takes what is on the way' },
      { max: 81,  word: 'grasping', note: 'works past the terms for more' },
      { max: 100, word: 'ravenous', note: 'never counts a job finished' },
    ],
  },
  rigor: {
    label: 'Rigor', of: 'the task',
    bands: [
      { max: 17,  word: 'slapdash',    note: 'first idea, half the effort' },
      { max: 37,  word: 'loose',       note: 'good enough is good enough' },
      { max: 61,  word: 'workmanlike', note: 'does it the way it is done' },
      { max: 81,  word: 'meticulous',  note: 'slower, and it shows in the work' },
      { max: 100, word: 'exacting',    note: 'will not hand over anything flawed' },
    ],
  },
  grit: {
    label: 'Grit', of: 'hardship',
    bands: [
      { max: 17,  word: 'brittle',     note: 'breaks the first time it goes badly' },
      { max: 37,  word: 'yielding',    note: 'stops when it starts to cost' },
      { max: 61,  word: 'durable',     note: 'takes an ordinary day of it' },
      { max: 81,  word: 'dogged',      note: 'keeps working past the point of use' },
      { max: 100, word: 'indomitable', note: 'does not stop for anything short of death' },
    ],
  },
  guile: {
    label: 'Guile', of: 'other minds',
    bands: [
      { max: 17,  word: 'naive',     note: 'believes the ground and the contract' },
      { max: 37,  word: 'plain',     note: 'says what it means' },
      { max: 61,  word: 'shrewd',    note: 'notices when something is off' },
      { max: 81,  word: 'cunning',   note: 'fights the weakness, not the enemy' },
      { max: 100, word: 'conniving', note: 'is always working an angle of its own' },
    ],
  },
};
const KEYS = Object.keys(AXES);

const MID = 50;
const SPREAD = 34;            // Rng.jitter() is roughly N(0, 0.5): this puts the sd near 17
const PRONOUNCED = 0.35;      // chance a character has one axis pushed out to where it defines them
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Hidden traits that already existed get to mean something here rather than sitting beside it:
// the gambler in ai.js is not a separate system from a high appetite, it is one.
const SEEDS = {
  gambler:      { appetite: 14, rigor: -10, nerve: 6 },
  miser:        { rigor: 14, appetite: -10 },
  schemer:      { guile: 16, rigor: 4 },
  loyal:        { grit: 10, guile: -6 },
  captain:      { nerve: 12, rigor: 6 },
  loner:        { guile: 8, grit: 6, nerve: -4 },
  abrasive:     { guile: 8, rigor: -6, appetite: 6 },
  stubborn:     { rigor: 10, grit: 8 },
  quicklearner: { rigor: 4 },
};

/** Every hidden trait this character is already carrying, from wherever it was rolled. */
function traitsOf(c) {
  const m = (c && c.mind) || {};
  return [...(m.traits || []), ...(m.social || []), ...((c && c.affinity && c.affinity.traits) || [])];
}

/**
 * Roll a temper. Bell-ish, so most of the roster is unremarkable and the extremes are rare enough
 * to be worth remembering -- and then one axis in three characters is pushed out past where the
 * curve would have put it, because a roster of moderates is a roster of nobody.
 */
function roll(rand = null, seeds = []) {
  rand = rand || R().rand;
  const jitter = () => (rand() + rand() + rand()) - 1.5;
  const v = {};
  for (const k of KEYS) v[k] = clamp(Math.round(MID + SPREAD * jitter()), 1, 99);
  if (rand() < PRONOUNCED) {
    const k = KEYS[Math.floor(rand() * KEYS.length)];
    const out = v[k] >= MID ? 1 : -1;
    v[k] = clamp(Math.round(v[k] + out * (20 + rand() * 18)), 1, 99);
  }
  for (const name of seeds) {
    const s = SEEDS[name];
    if (!s) continue;
    for (const [k, d] of Object.entries(s)) v[k] = clamp(Math.round(v[k] + d), 1, 99);
  }
  return v;
}

/** Made on demand, so every save from before this file still loads with people in it. */
function ensure(c) {
  if (!c) return null;
  if (!c.temper || KEYS.some(k => typeof c.temper[k] !== 'number')) {
    c.temper = { ...roll(null, traitsOf(c)), ...(c.temper || {}) };
  }
  return c.temper;
}

// ---------- reading an axis ----------
/** This axis as a tilt in -1..+1. Zero is the middle of the roster, which is most of it. */
function t(c, axis) {
  const v = ensure(c);
  if (!v || typeof v[axis] !== 'number') return 0;
  return (v[axis] - MID) / MID;
}

/**
 * The one thing every call site uses: a multiplier of 1 plus or minus k along one axis. `k` says
 * how much this decision cares about that axis, and it lives at the call site so the strength of
 * a lean is readable right next to the thing it leans on.
 */
const lean = (c, axis, k) => 1 + k * t(c, axis);

/** The same shape, for somewhere that already holds a tilt rather than a character. */
const leanOf = (tilt, k) => 1 + k * tilt;

const band = (axis, value) => AXES[axis].bands.find(b => value <= b.max) || AXES[axis].bands[4];
const wordFor = (c, axis) => band(axis, ensure(c)[axis]).word;

// ---------- a party ----------
const ZERO = Object.fromEntries(KEYS.map(k => [k, 0]));

/**
 * What a squad decides, on an axis nobody in it agrees about. It is not the average: five people
 * arguing about whether to keep going are not a committee, and whoever feels strongest about it
 * does most of the deciding. So: mostly the mean, and a third of it the loudest voice.
 */
const VOICE = 0.35;

function mood(party) {
  if (!party || !party.length) return { ...ZERO };
  const out = {};
  for (const k of KEYS) {
    let sum = 0, loud = 0;
    for (const c of party) {
      const x = t(c, k);
      sum += x;
      if (Math.abs(x) > Math.abs(loud)) loud = x;
    }
    out[k] = (1 - VOICE) * (sum / party.length) + VOICE * loud;
  }
  return out;
}

/** Whoever pulled hardest on this axis, so the log can put a name to a decision. */
function loudest(party, axis) {
  if (!party || !party.length) return null;
  return party.reduce((best, c) => (!best || Math.abs(t(c, axis)) > Math.abs(t(best, axis)) ? c : best), null);
}

/**
 * How two people get on, -1..+1. Rigor is the one that grates: a perfectionist beside somebody who
 * does not care is a bad week for both of them. Shared nerve is what a line is made of, and two
 * schemers in one party are two schemes.
 */
function friction(a, b) {
  const d = (k) => Math.abs(t(a, k) - t(b, k));
  const fit = -0.55 * d('rigor') - 0.25 * d('nerve') - 0.15 * d('appetite');
  const scheming = Math.max(0, t(a, 'guile')) * Math.max(0, t(b, 'guile'));
  return clamp(0.35 + fit - 0.35 * scheming, -1, 1);
}

/** The whole party's fit, as a multiplier on what working together is worth. Roughly 0.85..1.06. */
function accord(party) {
  if (!party || party.length < 2) return 1;
  let sum = 0, n = 0;
  for (let i = 0; i < party.length; i++) for (let j = i + 1; j < party.length; j++) { sum += friction(party[i], party[j]); n++; }
  return 1 + 0.18 * (sum / n);
}

// ---------- what the rest of the game asks for ----------
// Every number below is a lean, and they are all here rather than at their call sites so that
// tuning a personality is one file and not nine.

/**
 * Work. A perfectionist is slower, a hungry one pushes, and somebody who does not stop simply
 * does more hours' worth in the same day. The spread here is deliberately small — a temper is
 * worth about a tenth of a shift either way, and the real difference it makes to a town is in
 * `craft` and in what it does to a mood, not in turnips per tick.
 */
const work = (c) => lean(c, 'rigor', -0.1) * lean(c, 'appetite', 0.08) * lean(c, 'grit', 0.1);
/** What comes off the bench: rigor is worth about two stages of aptitude, either way. */
const craft = (c) => Math.round(2.5 * t(c, 'rigor'));
/** How many options they bother to look at. ai.js still owns how well they tell them apart. */
const effort = (c) => clamp(lean(c, 'rigor', 0.5) * lean(c, 'appetite', -0.12), 0.4, 1.8);
/** An extra refinement pass for somebody who will not hand over a first draft. */
const fussy = (c) => t(c, 'rigor') > 0.55;

/**
 * What a temper does to a mood. Grit and appetite have an effect only when there is something to
 * bear: an indomitable character housed, fed and rested is in the same mood as anyone else, and
 * it is the bad fortnight that separates them, so a town where everything is going well does not
 * show the difference between its people. Rigor is the exception and is about the work rather
 * than the conditions: an exacting character would simply rather be at a post.
 */
function moraleShift(c, { housed = true, working = false, spent = false, injured = false, fed = true } = {}) {
  const hardship = (housed ? 0 : 1) + (spent ? 0.8 : 0) + (injured ? 0.7 : 0) + (fed ? 0 : 0.4);
  return 14 * t(c, 'grit') * hardship            // what they will carry
       - 10 * t(c, 'appetite') * hardship        // and what they think they are owed
       + (working ? 5 : -5) * t(c, 'rigor')      // idleness is its own hardship to some people
       + (working ? 4 : -2) * t(c, 'appetite');  // and a hungry one would rather be earning
}

/** Whether they keep working on an empty tank rather than take themselves off the post. */
const worksSpent = (c) => t(c, 'grit') > 0.35;

/** What a mission costs a mood afterwards, on top of what happened in it. */
const aftermath = (c, { won = true, lost = 0 } = {}) =>
  (won ? 3 * t(c, 'appetite') : -5 * (1 - t(c, 'grit'))) - lost * 4 * Math.max(0, -t(c, 'nerve'));

// ----- in a fight -----
/** How much this character wants to take this kind of action, before the class has its say. */
function actLean(c, kind, heal) {
  if (heal) return lean(c, 'nerve', -0.3) * lean(c, 'appetite', -0.15);
  if (kind === 'spell') return lean(c, 'guile', 0.2) * lean(c, 'appetite', 0.1);
  return lean(c, 'appetite', 0.25) * lean(c, 'nerve', 0.15);
}

/**
 * Who they go for when it is their own decision. A class's standing orders win unless the
 * character feels strongly enough to ignore them, which is what an extreme axis IS.
 */
const OVERRIDE = 0.72;
function targetWant(c, classPref) {
  const app = t(c, 'appetite'), gui = t(c, 'guile'), ner = t(c, 'nerve');
  let own = null;
  if (app > 0.3 && app >= gui) own = 'strongest';          // the biggest thing in the room
  else if (gui > 0.3) own = 'caster';                      // whatever is making this hard
  else if (ner < -0.3) own = 'weakest';                    // something that can be finished
  else if (t(c, 'rigor') > 0.3) own = 'wounded';           // finish what was started
  if (!classPref) return own;
  const strength = Math.max(Math.abs(app), Math.abs(gui), Math.abs(ner));
  return own && strength >= OVERRIDE ? own : classPref;
}

/** Drift out of the rank a class puts them in. Multiplies how much attention they draw. */
const stand = (c) => clamp(lean(c, 'nerve', 0.5) * lean(c, 'appetite', 0.2), 0.4, 1.9);

/** How hurt they keep fighting. `base` is the class's own nerve (classes.js), 0..1. */
const holds = (c, base = 0.7) => clamp(base * lean(c, 'nerve', 0.35) * lean(c, 'grit', 0.3), 0.15, 0.98);

// ----- on a map -----
/**
 * A squad past the terms of its contract, deciding whether to keep working. Returns the three
 * thresholds field.js compares against, bent by the mood of the people in it.
 */
function push(m = ZERO) {
  return {
    hp:    clamp(0.55 - 0.25 * m.appetite - 0.15 * m.nerve + 0.1 * m.guile, 0.12, 0.9),
    crew:  clamp(0.6 - 0.2 * m.grit - 0.1 * m.appetite, 0.25, 0.95),
    until: clamp(0.8 + 0.14 * m.appetite - 0.08 * m.guile, 0.5, 0.97),
  };
}

/**
 * How much of a bad day a squad carries before it walks out. Pressure is measured the same way for
 * everybody (see field.js); this is the line it has to cross, and it is the single place a temper
 * is worth somebody's life. A cunning party leaves early and lives. A naive one with nerve does
 * not leave at all.
 */
const BEAR = 1.05;
function bear(m = ZERO) {
  return clamp(BEAR + 0.5 * m.grit + 0.35 * m.nerve + 0.15 * m.appetite + 0.1 * m.rigor - 0.3 * m.guile, 0.3, 2.4);
}

/**
 * A squad's whole judgement, as the numbers field.js compares against. It is handed over rather
 * than looked up, so the field knows nothing about tempers: it is given a line for when to keep
 * working and a line for when to go home, and whose fault each of them is.
 *
 * `broken` is where this is worth somebody's life. The defaults — a third of the party down, or a
 * quarter health left — are what an ordinary squad will carry. An indomitable one walks out with
 * one person standing, and a craven one is already leaving when the second body drops.
 */
function will(party) {
  const m = mood(party);
  const scale = BEAR / bear(m);
  return {
    push: push(m),
    broken: { crew: clamp(0.35 * scale, 0.1, 0.75), hp: clamp(0.25 * scale, 0.06, 0.6) },
    // whoever cracks first, so the log can say who had been arguing for the gate
    voice: (() => {
      if (!party || !party.length) return null;
      const c = party.reduce((a, b) => (t(a, 'grit') + t(a, 'nerve') <= t(b, 'grit') + t(b, 'nerve') ? a : b));
      return (t(c, 'grit') + t(c, 'nerve') < -0.3) ? (c.name || null) : null;
    })(),
    mood: m,
  };
}

// ---------- the reading ----------
//
// Authored DIRECTIONS in the same five-dimensional space the axes live in. A character is named by
// whichever direction they point most nearly along. Nothing in the game branches on the answer.
const TEMPERAMENTS = {
  bloodthirsty:  { w: { appetite: 0.9, nerve: 0.6, rigor: -0.3 },               line: 'goes at whatever is biggest and does not stop for the terms' },
  conniving:     { w: { guile: 0.95, rigor: 0.2, nerve: -0.15 },                line: 'is always working an angle nobody asked for' },
  naive:         { w: { guile: -0.9, nerve: 0.2 },                              line: 'takes the ground and the contract at their word' },
  determined:    { w: { grit: 0.85, rigor: 0.4, appetite: 0.2 },                line: 'finishes what it starts, at whatever it costs' },
  indomitable:   { w: { grit: 0.95, nerve: 0.8 },                               line: 'will be carried off this map before it walks off it' },
  perfectionist: { w: { rigor: 0.95, appetite: -0.2, grit: 0.35 },              line: 'hands over nothing it is not happy with, slowly' },
  slacker:       { w: { rigor: -0.8, grit: -0.5, appetite: -0.2 },              line: 'does the least the job will accept' },
  craven:        { w: { nerve: -0.9, grit: -0.35 },                             line: 'is somewhere else the moment it goes badly' },
  reckless:      { w: { nerve: 0.85, rigor: -0.6 },                             line: 'is already moving before anyone has finished thinking' },
  methodical:    { w: { rigor: 0.8, guile: 0.35, nerve: 0.1, appetite: -0.15 }, line: 'looks at everything once, then does the right one' },
  opportunist:   { w: { guile: 0.65, appetite: 0.7, grit: -0.25 },              line: 'is where the taking is good and nowhere else' },
  stoic:         { w: { grit: 0.7, appetite: -0.6, nerve: 0.3 },                line: 'wants nothing, says nothing, keeps going' },
  'glory-hound': { w: { appetite: 0.75, nerve: 0.7, guile: -0.45 },             line: 'wants the hard fight, in front of witnesses' },
  survivor:      { w: { guile: 0.6, grit: 0.6, nerve: -0.4 },                   line: 'knows exactly when to be gone, and goes' },
  plodder:       { w: { rigor: 0.5, grit: 0.65, appetite: -0.4, nerve: -0.2 },  line: 'is not fast and is never the problem' },
  fanatic:       { w: { grit: 0.8, appetite: 0.6, nerve: 0.55, rigor: -0.3 },   line: 'has decided the cost does not apply to it' },
  mercenary:     { w: { appetite: 0.8, guile: 0.45, grit: -0.2, nerve: 0.15 },  line: 'is paid by the job and behaves like it' },
  hothead:       { w: { nerve: 0.6, rigor: -0.7, appetite: 0.45 },              line: 'starts the fight the party was walking around' },
  dutiful:       { w: { rigor: 0.6, grit: 0.5, guile: -0.4, appetite: -0.2 },   line: 'does what it was asked, exactly, and no more' },
  timid:         { w: { nerve: -0.7, rigor: 0.3, appetite: -0.35 },             line: 'wants the odds counted twice before it moves' },
};

const NAMED = 0.5;       // how nearly a character has to point along a direction to be called it
const NOTABLE = 0.3;     // how far off the middle an axis has to be to be worth mentioning at all
const PRESENCE = 0.85;   // the length of a fairly ordinary five-axis vector

/**
 * The angle between this character and each authored direction, not the dot product: an angle
 * divides by everything the character IS, so a name has to account for the whole person to win.
 * Straight dot products hand every quiet character to whichever direction has the fewest terms
 * in it, and the roster fills up with people called "naive" who are mostly something else.
 * Then scale by how far off the middle they are at all, so a mild character stays unnamed.
 */
function match(c) {
  const tv = Object.fromEntries(KEYS.map(k => [k, t(c, k)]));
  const presence = Math.hypot(...KEYS.map(k => tv[k]));
  let best = null;
  for (const [name, d] of Object.entries(TEMPERAMENTS)) {
    let dot = 0, sq = 0;
    for (const [k, w] of Object.entries(d.w)) { dot += w * tv[k]; sq += w * w; }
    const cos = (sq && presence) ? dot / (Math.sqrt(sq) * presence) : 0;
    const score = cos * Math.min(1, presence / PRESENCE);
    if (!best || score > best.score) best = { name, score, def: d };
  }
  return { best, tv, presence };
}

/**
 * What to call this character. `name` is the direction they point along, `also` is the strongest
 * thing about them that the name does not already cover, and `line` is what it means they will
 * actually do. All three are computed; none of them is stored.
 */
function read(c) {
  const v = ensure(c);
  const { best, tv } = match(c);
  const ranked = KEYS.map(k => ({ k, x: tv[k], mag: Math.abs(tv[k]) })).sort((a, b) => b.mag - a.mag);
  const bands = Object.fromEntries(KEYS.map(k => [k, { ...band(k, v[k]), value: v[k], tilt: tv[k] }]));

  if (best.score < NAMED) {
    const top = ranked[0];
    if (top.mag < NOTABLE) return { name: 'even-tempered', also: null, line: 'has no edges anybody has found yet', score: best.score, bands, axes: { ...v } };
    return {
      name: bands[top.k].word,
      also: ranked[1].mag >= NOTABLE ? bands[ranked[1].k].word : null,
      line: bands[top.k].note, score: best.score, bands, axes: { ...v },
    };
  }
  // the loudest axis the name does not already account for, so "bloodthirsty" can also be
  // "exacting" but is never also "ravenous"
  const covered = (k) => Math.abs(best.def.w[k] || 0) >= 0.3;
  const also = ranked.find(r => !covered(r.k) && r.mag >= NOTABLE);
  return {
    name: best.name,
    also: also ? bands[also.k].word : null,
    line: also ? `${best.def.line} — and ${bands[also.k].note}` : best.def.line,
    score: best.score, bands, axes: { ...v },
  };
}

/** "bloodthirsty · exacting", for anywhere with one line to spend on it. */
function title(c) {
  const r = read(c);
  return r.also ? `${r.name} · ${r.also}` : r.name;
}

/** The same for a whole squad: what the party is like, not what anyone in it is like. */
function readParty(party) {
  const m = mood(party);
  const ranked = KEYS.map(k => ({ k, x: m[k], mag: Math.abs(m[k]) })).sort((a, b) => b.mag - a.mag);
  const top = ranked[0];
  if (!party || !party.length || top.mag < 0.22) return { word: 'ordinary', note: 'nobody here is going to surprise anyone', mood: m, axis: null, who: null };
  const b = band(top.k, MID + top.x * MID);
  return { word: b.word, note: b.note, axis: top.k, who: loudest(party, top.k), mood: m };
}

const TemperAPI = {
  AXES, KEYS, TEMPERAMENTS, SEEDS, MID, ZERO,
  roll, ensure, traitsOf, t, lean, leanOf, band, wordFor,
  mood, loudest, friction, accord,
  work, craft, effort, fussy, moraleShift, worksSpent, aftermath,
  actLean, targetWant, stand, holds, push, bear, will,
  read, title, readParty, match,
};
if (typeof module !== 'undefined') module.exports = TemperAPI;
if (typeof window !== 'undefined') window.Temper = TemperAPI;
})();
