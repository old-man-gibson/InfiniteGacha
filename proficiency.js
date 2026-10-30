// Proficiencies (aptitudes). Works in the browser (window.Prof) and Node (module.exports).
//
// Scale: tiers F E D C B A S, each with three stages (X-, X, X+), each stage three steps of ten levels.
// S* and S** sit above S+ and are reached only by advancing a character already in the S tier.
// A proficiency is stored as { stage, level } with stage an index into STAGES and level 1..30.

const TIERS = ['F', 'E', 'D', 'C', 'B', 'A', 'S'];
const STAGES = [];
for (const t of TIERS) for (const suffix of ['-', '', '+']) STAGES.push(t + suffix);
STAGES.push('S*', 'S**');

const LEVELS_PER_STEP = 10;
const STEPS_PER_STAGE = 3;
const LEVELS_PER_STAGE = LEVELS_PER_STEP * STEPS_PER_STAGE; // 30

const STAGE = Object.fromEntries(STAGES.map((n, i) => [n, i]));
const MAX_ROLL_STAGE = STAGE['B+'];      // rolling never produces S; skills do that
const MAX_ADVANCE_STAGE = STAGE['A+'];   // advancement can't push a non-S aptitude into S either
const STAGES_PER_STAR = 2;               // each star shifts the rolled range by two stages

// Stage window rolled at each pullable star count: 1 star F- .. D-, 5 star D- .. B+.
function rollWindow(stars) {
  const shift = STAGES_PER_STAR * (stars - 1);
  return [Math.min(shift, MAX_ROLL_STAGE), Math.min(STAGE['D-'] + shift, MAX_ROLL_STAGE)];
}

// Which proficiencies exist. Groups matter only for display.
const PROFICIENCIES = {
  sword: { label: 'Sword', group: 'weapon' },
  axe: { label: 'Axe', group: 'weapon' },
  spear: { label: 'Spear', group: 'weapon' },
  bow: { label: 'Bow', group: 'weapon' },
  dagger: { label: 'Dagger', group: 'weapon' },
  staff: { label: 'Staff', group: 'weapon' },
  shield: { label: 'Shield', group: 'weapon' },
  unarmed: { label: 'Unarmed', group: 'weapon' },
  light_armor: { label: 'Light armor', group: 'armor' },
  medium_armor: { label: 'Medium armor', group: 'armor' },
  heavy_armor: { label: 'Heavy armor', group: 'armor' },
  fire: { label: 'Fire', group: 'element' },
  ice: { label: 'Ice', group: 'element' },
  lightning: { label: 'Lightning', group: 'element' },
  water: { label: 'Water', group: 'element' },
  earth: { label: 'Earth', group: 'element' },
  wind: { label: 'Wind', group: 'element' },
  poison: { label: 'Poison', group: 'element' },
  acid: { label: 'Acid', group: 'element' },
  light: { label: 'Light', group: 'element' },
  dark: { label: 'Dark', group: 'element' },
  arcana: { label: 'Arcana', group: 'mind' },
  psionics: { label: 'Psionics', group: 'mind' },
  farming: { label: 'Farming', group: 'craft' },
  mining: { label: 'Mining', group: 'craft' },
  foraging: { label: 'Foraging', group: 'craft' },
  smithing: { label: 'Smithing', group: 'craft' },
  alchemy: { label: 'Alchemy', group: 'craft' },
  cooking: { label: 'Cooking', group: 'craft' },
  maintenance: { label: 'Maintenance', group: 'craft' },
};

// Optional race flavour: bias a few aptitudes up or down by whole stages when rolling.
const RACE_BIAS = {
  draconic: { fire: 1, unarmed: 1, water: -1, ice: -1 },
  therian: { unarmed: 1, dagger: 1, foraging: 1, staff: -1, psionics: -1 },
  demonic: { dark: 1, fire: 1, acid: 1, light: -2 },
  celestial: { light: 1, staff: 1, arcana: 1, dark: -2 },
  android: { maintenance: 1, smithing: 1, psionics: 1, cooking: -1 },
  orc: { axe: 1, smithing: 1, mining: 1, heavy_armor: 1, bow: -1 },
  goblin: { dagger: 1, alchemy: 1, light_armor: 1, shield: -1, heavy_armor: -1 },
  elf: { bow: 1, wind: 1, light_armor: 1, foraging: 1, heavy_armor: -1 },
  darkelf: { dagger: 1, dark: 1, light_armor: 1, light: -2, heavy_armor: -1 },
  dwarf: { axe: 1, smithing: 1, mining: 1, heavy_armor: 1, earth: 1, bow: -1 },
  halfgiant: { axe: 1, unarmed: 1, heavy_armor: 1, dagger: -1, alchemy: -1 },
};

// ---------- helpers ----------
const clampStage = (s) => Math.max(0, Math.min(STAGES.length - 1, s));

function fromAbsolute(abs) {           // abs = 0-based total level
  const stage = clampStage(Math.floor(abs / LEVELS_PER_STAGE));
  return { stage, level: (abs % LEVELS_PER_STAGE) + 1 };
}
function toAbsolute(p) { return p.stage * LEVELS_PER_STAGE + (p.level - 1); }

// Ceilings an aptitude is read against, as absolute levels: 'advance' is the top of A+ (539),
// where ordinary training stops; 'ladder' is the top of S** (689).
const CEILINGS = {
  advance: toAbsolute({ stage: MAX_ADVANCE_STAGE, level: LEVELS_PER_STAGE }),
  ladder: toAbsolute({ stage: STAGES.length - 1, level: LEVELS_PER_STAGE }),
};

/**
 * An aptitude as a fraction of a ceiling: toAbsolute(entry) / CEILINGS[ceiling]. Above 'advance'
 * (S-tier) the fraction passes 1 unless `clamp` is set. An unknown ceiling throws, because the
 * divisor would be undefined and every caller would get NaN.
 */
function share(entry, { clamp = false, ceiling = 'advance' } = {}) {
  const top = CEILINGS[ceiling];
  if (top === undefined) throw new Error(`Prof.share: unknown ceiling '${ceiling}'`);
  const f = toAbsolute(entry) / top;
  return clamp ? Math.min(1, f) : f;
}

function step(p) { return Math.ceil(p.level / LEVELS_PER_STEP); }
function levelInStep(p) { return ((p.level - 1) % LEVELS_PER_STEP) + 1; }

function format(p, long = false) {
  const name = STAGES[p.stage];
  return long ? `${name} step ${step(p)} lv ${levelInStep(p)}` : `${name} ${step(p)}.${levelInStep(p)}`;
}

function tierOf(p) { return STAGES[p.stage].replace(/[-+*]/g, ''); }
function isS(p) { return tierOf(p) === 'S'; }

// ---------- rolling ----------
function rollOne(stars, bias = 0, rand = Math.random) {
  const [lo, hi] = rollWindow(stars);
  let stage = lo + Math.floor(rand() * (hi - lo + 1)) + bias;
  stage = Math.max(0, Math.min(MAX_ROLL_STAGE, stage));
  return { stage, level: 1 + Math.floor(rand() * LEVELS_PER_STAGE) };
}

function rollAll(stars, race, rand = Math.random) {
  const bias = RACE_BIAS[race] || {};
  const out = {};
  for (const key of Object.keys(PROFICIENCIES)) out[key] = rollOne(stars, bias[key] || 0, rand);
  return out;
}

// ---------- advancement ----------
// Every star gained lifts each aptitude by STAGES_PER_STAR stages, keeping the level within the stage.
// S-tier aptitudes instead become S* at 6 stars and S** at 7. Non-S aptitudes cap at A+.
function advanceAll(profs, newStars) {
  const out = {};
  for (const [key, p] of Object.entries(profs)) {
    if (isS(p)) {
      const target = newStars >= 7 ? STAGE['S**'] : newStars >= 6 ? STAGE['S*'] : p.stage;
      out[key] = { stage: Math.max(p.stage, target), level: p.level };
    } else {
      out[key] = { stage: Math.min(MAX_ADVANCE_STAGE, p.stage + STAGES_PER_STAR), level: p.level };
    }
  }
  return out;
}

// Level up by n levels (from training or use). Rolls over into the next stage.
function gain(p, n = 1, capStage = STAGES.length - 1) {
  const abs = Math.min(toAbsolute(p) + n, capStage * LEVELS_PER_STAGE + LEVELS_PER_STAGE - 1);
  return fromAbsolute(abs);
}

// Skills like "Sword Expertise" call this to push an aptitude straight into a stage (e.g. 'S-').
function setStage(p, stageName) { return { stage: STAGE[stageName], level: p.level }; }

function best(profs, n = 3) {
  return Object.entries(profs).sort((a, b) => toAbsolute(b[1]) - toAbsolute(a[1])).slice(0, n);
}

const ProfAPI = { TIERS, STAGES, STAGE, PROFICIENCIES, RACE_BIAS, LEVELS_PER_STAGE, LEVELS_PER_STEP, STEPS_PER_STAGE, MAX_ROLL_STAGE, MAX_ADVANCE_STAGE, rollWindow, rollOne, rollAll, advanceAll, gain, setStage, format, step, levelInStep, tierOf, isS, toAbsolute, fromAbsolute, CEILINGS, share, best };
if (typeof module !== 'undefined') module.exports = ProfAPI;
if (typeof window !== 'undefined') window.Prof = ProfAPI;
