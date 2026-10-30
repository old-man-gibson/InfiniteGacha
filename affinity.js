// Equipment affinity: preferred and compatible gear types, hidden traits, training growth.
// Browser: window.Affinity. Node: module.exports.
//
// Every character has, per category (weapon, shield, armor):
//   innate preferred type   -> preference starts at 0.25 and grows with use to +50%
//   true compatible type    -> compatibility is +100% from the start
// Other types start at 0. With use, preference for any type can grow to the full +50%,
// and compatibility with any type can grow to 70% of true compatibility (+70%).
// Growth multiplier for training with a type = 1 + preference + compatibility (max 2.5).
// Picking up new types gets slower the more types a character has already mastered,
// unless a hidden trait says otherwise.

const TYPES = {
  weapon: ['sword', 'axe', 'spear', 'bow', 'dagger', 'staff'],
  shield: ['buckler', 'kite', 'tower'],
  armor:  ['light', 'medium', 'heavy'],
};
const CATEGORY = {};
for (const [cat, list] of Object.entries(TYPES)) for (const t of list) CATEGORY[t] = cat;

// Aptitude (proficiency key) trained by each type.
const APTITUDE = { buckler: 'shield', kite: 'shield', tower: 'shield', light: 'light_armor', medium: 'medium_armor', heavy: 'heavy_armor' };
const aptitudeOf = (type) => APTITUDE[type] || type;

const PREF_MAX = 0.5;
const COMPAT_TRUE = 1.0;
const COMPAT_LEARNED = 0.7;
const PREF_START = 0.25;
const PREF_GROWTH = 0.004;     // per training tick, before modifiers
const COMPAT_GROWTH = 0.003;
const MASTERY_THRESHOLD = 0.45; // a type counts as mastered once preference passes this
const DISCOVER_TICKS = 25;      // training ticks with the true compatible type before the character notices

// Hidden traits. Rolled once at summon and never shown directly.
const TRAITS = {
  omnimaster:   { weight: 2,  desc: 'Compatibility with every type can reach 100%, no mastery slowdown' },
  quicklearner: { weight: 8,  desc: 'Preference and compatibility grow 50% faster' },
  stubborn:     { weight: 8,  desc: 'Grows slower with anything but the innate preferred type' },
  none:         { weight: 82, desc: '' },
};

const pickOne = (a, rand) => a[Math.floor(rand() * a.length)];

function rollTraits(rand = Math.random) {
  const total = Object.values(TRAITS).reduce((a, t) => a + t.weight, 0);
  let x = rand() * total;
  for (const [k, t] of Object.entries(TRAITS)) { x -= t.weight; if (x < 0) return k === 'none' ? [] : [k]; }
  return [];
}

function roll(rand = Math.random) {
  const innate = {}, compatible = {}, pref = {}, compat = {};
  for (const [cat, list] of Object.entries(TYPES)) {
    innate[cat] = pickOne(list, rand);
    compatible[cat] = rand() < 0.4 ? innate[cat] : pickOne(list, rand);
  }
  for (const t of Object.keys(CATEGORY)) { pref[t] = 0; compat[t] = 0; }
  for (const cat of Object.keys(TYPES)) { pref[innate[cat]] = PREF_START; compat[compatible[cat]] = COMPAT_TRUE; }
  return { innate, compatible, pref, compat, traits: rollTraits(rand) };
}

const has = (a, trait) => (a.traits || []).includes(trait);

function growthMult(a, type) { return 1 + (a.pref[type] || 0) + (a.compat[type] || 0); }

function masteredCount(a, cat) { return TYPES[cat].filter(t => (a.pref[t] || 0) >= MASTERY_THRESHOLD).length; }

// Advance preference and compatibility for a type after one tick of training with it.
function use(a, type, rate = 1) {
  const cat = CATEGORY[type];
  const isInnate = a.innate[cat] === type;
  const isTrue = a.compatible[cat] === type;
  let speed = rate;
  if (has(a, 'quicklearner')) speed *= 1.5;
  if (has(a, 'stubborn') && !isInnate) speed *= 0.4;
  // slower the more types in this category are already mastered (omnimaster ignores this)
  if (!isInnate && !has(a, 'omnimaster')) speed /= 1 + masteredCount(a, cat);

  a.pref[type] = Math.min(PREF_MAX, (a.pref[type] || 0) + PREF_GROWTH * speed);
  const compatCap = isTrue || has(a, 'omnimaster') ? COMPAT_TRUE : COMPAT_LEARNED;
  if (!isTrue) a.compat[type] = Math.min(compatCap, (a.compat[type] || 0) + COMPAT_GROWTH * speed);
  // nobody is told what they are compatible with; they find out by feel
  a.used = a.used || {};
  a.used[type] = (a.used[type] || 0) + rate;
  if (isTrue && a.used[type] >= DISCOVER_TICKS) { a.discovered = a.discovered || {}; a.discovered[type] = true; }
  return a;
}

// ---------- what the character (and the player) actually knows ----------
const isDiscovered = (a, type) => !!(a.discovered && a.discovered[type]);

/** Compatibility as far as the character can tell. Learned compatibility shows because it was earned;
 *  true compatibility is invisible until discovered. */
function knownCompat(a, type) {
  const cat = CATEGORY[type];
  if (a.compatible[cat] === type) return isDiscovered(a, type) ? (a.compat[type] || 0) : 0;
  return a.compat[type] || 0;
}
function knownGrowth(a, type) { return 1 + (a.pref[type] || 0) + knownCompat(a, type); }

/** The type a character would pick for a category on what it knows: best known growth, preference breaks ties. */
function choose(a, cat) {
  let best = a.innate[cat], bestV = -1;
  for (const t of TYPES[cat]) {
    const v = knownGrowth(a, t) + (t === a.innate[cat] ? 0.001 : 0);
    if (v > bestV) { best = t; bestV = v; }
  }
  return best;
}

function describeKnown(a, type) {
  const cat = CATEGORY[type];
  const tags = [];
  if (a.innate[cat] === type) tags.push('preferred');
  if (a.compatible[cat] === type && isDiscovered(a, type)) tags.push('discovered fit');
  if (choose(a, cat) === type) tags.push('chosen');
  return { pref: a.pref[type] || 0, compat: knownCompat(a, type), mult: knownGrowth(a, type), tags };
}

function describe(a, type) {
  const cat = CATEGORY[type];
  const tags = [];
  if (a.innate[cat] === type) tags.push('preferred');
  if (a.compatible[cat] === type) tags.push('compatible');
  return { pref: a.pref[type] || 0, compat: a.compat[type] || 0, mult: growthMult(a, type), tags };
}

const AffinityAPI = { TYPES, CATEGORY, TRAITS, PREF_MAX, COMPAT_TRUE, COMPAT_LEARNED, DISCOVER_TICKS, aptitudeOf, roll, rollTraits, use, growthMult, describe, has, isDiscovered, knownCompat, knownGrowth, choose, describeKnown };
if (typeof module !== 'undefined') module.exports = AffinityAPI;
if (typeof window !== 'undefined') window.Affinity = AffinityAPI;
