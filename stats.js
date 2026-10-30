// Character statistics: six base stats, star tiers, race tendencies, derived stats.
// Works in the browser (globals) and in Node (module.exports) so formulas can be unit-tested.

const BASE_STATS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const STAT_NAMES = { str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' };

const STAT_MIN = 3;
const STAT_MAX = 30;

// Star tiers. Characters are pulled at 1 to 5 stars and can be advanced up to MAX_STARS.
// budget = total base-stat points at that tier. weight = pull odds (0 = not pullable).
const MAX_STARS = 7;          // raise this when higher advancement is added
const MAX_PULL_STARS = 5;
const STARS = {
  1: { budget: 40,  weight: 45, color: '#9a9a9a' },
  2: { budget: 50,  weight: 30, color: '#6fbf73' },
  3: { budget: 62,  weight: 17, color: '#42a5f5' },
  4: { budget: 76,  weight: 6,  color: '#ab47bc' },
  5: { budget: 92,  weight: 2,  color: '#ffa726' },
  6: { budget: 110, weight: 0,  color: '#ff5252' },
  7: { budget: 130, weight: 0,  color: '#ffd740' },
};

// Relative pull of each stat when distributing the budget. 1 = neutral.
const RACE_TENDENCIES = {
  human:     { str: 1,   dex: 1,   con: 1,   int: 1,   wis: 1,   cha: 1 },
  draconic:  { str: 1.4, dex: 0.8, con: 1.3, int: 0.9, wis: 1.1, cha: 0.8 },
  therian:   { str: 1.1, dex: 1.4, con: 1.2, int: 0.7, wis: 1.0, cha: 0.8 },
  demonic:   { str: 1.2, dex: 1.0, con: 0.9, int: 1.2, wis: 0.6, cha: 1.3 },
  celestial: { str: 0.7, dex: 0.9, con: 0.8, int: 1.2, wis: 1.5, cha: 1.3 },
  android:   { str: 1.0, dex: 1.2, con: 1.1, int: 1.4, wis: 0.7, cha: 0.6 },
  robot:     { str: 1.3, dex: 0.8, con: 1.5, int: 1.2, wis: 0.5, cha: 0.4 },
  bug:       { str: 0.9, dex: 1.4, con: 1.3, int: 0.7, wis: 1.0, cha: 0.5 },
  orc:       { str: 1.6, dex: 0.8, con: 1.4, int: 0.6, wis: 0.7, cha: 0.7 },
  goblin:    { str: 0.7, dex: 1.5, con: 0.8, int: 1.1, wis: 0.8, cha: 1.0 },
  elf:       { str: 0.7, dex: 1.4, con: 0.8, int: 1.2, wis: 1.3, cha: 1.1 },
  darkelf:   { str: 0.8, dex: 1.4, con: 0.8, int: 1.3, wis: 0.9, cha: 1.0 },
  dwarf:     { str: 1.3, dex: 0.7, con: 1.5, int: 0.9, wis: 1.0, cha: 0.8 },
  halfgiant: { str: 1.7, dex: 0.6, con: 1.6, int: 0.6, wis: 0.8, cha: 0.8 },
};

// Derived stats. Each entry: label, governing base stat, formula, and how to display it.
// Keeping this as a table means rebalancing is a number change, not a code change.
const DERIVED = {
  equipLoad:      { label: 'Equip load',        stat: 'str', fmt: 'int',  f: s => 20 + s.str * 3 },
  maxDamage:      { label: 'Max damage',        stat: 'str', fmt: 'int',  f: s => 10 + s.str * 2 },
  critDamage:     { label: 'Crit damage',       stat: 'str', fmt: 'mult', f: s => 1.5 + s.str * 0.025 },

  walkSpeed:      { label: 'Walk speed',        stat: 'dex', fmt: 'dec',  f: s => 3 + s.dex * 0.1 },
  minDamage:      { label: 'Min damage',        stat: 'dex', fmt: 'int',  f: s => Math.min(5 + s.dex * 1.2, 10 + s.str * 2) },
  critChance:     { label: 'Crit chance',       stat: 'dex', fmt: 'pct',  f: s => Math.min(0.75, 0.05 + s.dex * 0.0125) },

  stamina:        { label: 'Stamina',           stat: 'con', fmt: 'int',  f: s => 50 + s.con * 5 },
  hp:             { label: 'HP',                stat: 'con', fmt: 'int',  f: s => 100 + s.con * 12 },
  physicalResist: { label: 'Physical resist',   stat: 'con', fmt: 'pct',  f: s => Math.min(0.6, s.con * 0.015) },

  mana:           { label: 'Mana',              stat: 'int', fmt: 'int',  f: s => 30 + s.int * 6 },
  magicDamage:    { label: 'Magic damage',      stat: 'int', fmt: 'int',  f: s => 8 + s.int * 2.2 },
  cooldownReduce: { label: 'Cooldown reduction', stat: 'int', fmt: 'pct', f: s => Math.min(0.5, s.int * 0.012) },

  spirit:         { label: 'Spirit',            stat: 'wis', fmt: 'int',  f: s => 20 + s.wis * 4 },
  senses:         { label: 'Senses',            stat: 'wis', fmt: 'dec',  f: s => 5 + s.wis * 0.5 },
  magicResist:    { label: 'Magic resist',      stat: 'wis', fmt: 'pct',  f: s => Math.min(0.6, s.wis * 0.015) },

  // The base figure crew.js teamwork() starts from, 3-30 before gear. teamwork() multiplies it by the hidden
  // social trait and the class factor; Crew.cohesion averages the result over the party (skill term).
  // `stat` names both inputs because game.js prints it in the sheet tooltip ("from CHA+WIS").
  teamwork:       { label: 'Teamwork',          stat: 'cha+wis', fmt: 'dec', f: s => s.cha * 0.7 + s.wis * 0.3 },
  rewardMod:      { label: 'Reward modifier',   stat: 'cha', fmt: 'mult', f: s => 1 + s.cha * 0.015 },
  willpower:      { label: 'Willpower',         stat: 'cha', fmt: 'int',  f: s => 10 + s.cha * 2 },
};

// ---------- rolling ----------
function rollStars(rand = Math.random) {
  const pullable = Object.entries(STARS).filter(([n, t]) => Number(n) <= MAX_PULL_STARS && t.weight > 0);
  const total = pullable.reduce((a, [, t]) => a + t.weight, 0);
  let x = rand() * total;
  for (const [n, t] of pullable) { x -= t.weight; if (x < 0) return Number(n); }
  return 1;
}

function starString(n) { return '★'.repeat(n) + '☆'.repeat(Math.max(0, MAX_STARS - n)); }

// Distribute the star tier's budget across the six stats, pulled by race tendency with noise.
function rollBaseStats(race, stars, rand = Math.random) {
  const budget = STARS[stars].budget;
  const tend = RACE_TENDENCIES[race] || RACE_TENDENCIES.human;
  const weights = {};
  let sum = 0;
  for (const s of BASE_STATS) { weights[s] = tend[s] * (0.7 + rand() * 0.6); sum += weights[s]; }
  const stats = {};
  let used = 0;
  for (const s of BASE_STATS) {
    stats[s] = Math.max(STAT_MIN, Math.min(STAT_MAX, Math.round(budget * weights[s] / sum)));
    used += stats[s];
  }
  // Fix rounding and clamping drift so the total matches the budget exactly.
  let diff = budget - used;
  const order = [...BASE_STATS].sort((a, b) => weights[b] - weights[a]);
  let guard = 0;
  while (diff !== 0 && guard++ < 100) {
    for (const s of (diff > 0 ? order : [...order].reverse())) {
      if (diff === 0) break;
      const next = stats[s] + Math.sign(diff);
      if (next >= STAT_MIN && next <= STAT_MAX) { stats[s] = next; diff -= Math.sign(diff); }
    }
  }
  return stats;
}

function deriveStats(base) {
  const out = {};
  for (const [k, d] of Object.entries(DERIVED)) out[k] = d.f(base);
  return out;
}

// ---------- what the gear is worth ----------
//
// Every piece of equipment carries a stat bonus, rolled from its quality (economy.js), and until
// now that number was printed in the inventory and read by nothing. A Legendary Starmetal Sword
// said +7 STR and did not give +7 STR, so a full kit was worth exactly its weapon damage and
// armour value, and the whole crafting chain had no second half.
//
// The bonus is NOT written into c.stats.base, and that is the important part. `base` is who the
// character IS: it is what a sacrifice hands over, what advancement grows, and what a class admits
// them on. Gear comes off. Baking it in would mean a character who strips their kit loses stats
// they were never born with, and one who is sacrificed hands over somebody else's boots.
//
// So there are two blocks, and the rule for choosing between them is one line:
//   base        who they are      — sacrifice, advancement, class requirements, training priority
//   effective   what they can do  — combat, work, rest, casting, scouting, planning
//
// A cap is deliberately NOT applied here. STAT_MAX is the ceiling on what a person can be; gear is
// how you go past it, and the derived formulas carry their own caps for anything that needs one.

/** Everything the loadout adds, as a full stat block of (mostly zero) numbers. */
function equipBonus(c) {
  const out = Object.fromEntries(BASE_STATS.map(k => [k, 0]));
  for (const item of Object.values((c && c.equipment) || {})) {
    if (!item || !item.bonus) continue;
    for (const [k, v] of Object.entries(item.bonus)) if (out[k] !== undefined) out[k] += v;
  }
  return out;
}

// Read once per fighter per combat tick and once per card per render, so it is memoised against a
// signature of the stats and the loadout. A WeakMap rather than a field on the character: a field
// would be written into the save, go stale the moment anything changed it from another file, and
// have to be migrated. Nothing here survives a reload, and nothing here can be wrong.
const effCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

/**
 * Base stats with the loadout counted, plus the derived block that follows from them.
 * Returns { base, derived, bonus, geared }. `bonus` is what the gear added, so a UI can show the
 * two apart; `geared` is false for somebody carrying nothing, whose effective stats are their own.
 */
function effective(c) {
  const bonus = equipBonus(c);
  const sig = BASE_STATS.map(k => c.stats.base[k] + '+' + bonus[k]).join(',');
  const hit = effCache && effCache.get(c);
  if (hit && hit.sig === sig) return hit;
  const base = {};
  for (const k of BASE_STATS) base[k] = c.stats.base[k] + bonus[k];
  const eff = { sig, base, derived: deriveStats(base), bonus, geared: BASE_STATS.some(k => bonus[k] !== 0) };
  if (effCache) effCache.set(c, eff);
  return eff;
}

/**
 * An effective() result with extra points added to the base stats, as { base, derived }. Nothing is
 * cached or written back, and effective() does not call it, so town output, scouting, honing, class
 * fitness and Condition keep reading the character without the points. combat.js fromCharacter is
 * the caller: it passes the points of the meal a character ate at launch (c.meal, economy.js mealInfo).
 * `points` is { stat: number }; keys that are not base stats and values that are not positive are ignored.
 */
function withPoints(eff, points) {
  const base = { ...eff.base };
  for (const k of BASE_STATS) {
    const v = points && points[k];
    if (Number.isFinite(v) && v > 0) base[k] += v;
  }
  return { base, derived: deriveStats(base) };
}

function formatDerived(key, value) {
  const fmt = DERIVED[key].fmt;
  if (fmt === 'pct') return Math.round(value * 100) + '%';
  if (fmt === 'mult') return 'x' + value.toFixed(2);
  if (fmt === 'dec') return value.toFixed(1);
  return String(Math.round(value));
}

function rollCharacterStats(race, rand = Math.random, stars = null) {
  stars = stars || rollStars(rand);
  const base = rollBaseStats(race, stars, rand);
  return { stars, base, derived: deriveStats(base) };
}

// ---------- the roll, kept ----------
//
// `base` moves for the rest of a character's life: advancement adds to it, an offering at the
// altar pours somebody else's into it. `born` does not. It is the block they walked out of the
// gate with, stamped once and never written again, and it is the only honest answer to questions
// about the ROLL rather than about the character as they stand today — chiefly potential.js.
//
// This is stored rather than derived, unlike every other cached number in this file, because it
// is not derivable. Nothing about a stat block records where its points came from, so once an
// offering has been poured in there is no way back to what was rolled. A fact that cannot be
// recomputed has to be kept.
//
// Called after every bonus that is part of being born — the heroic bloodline in lpc.js included —
// and before the character is handed to the game.
function freezeBorn(stats) {
  if (!stats.born) stats.born = { stars: stats.stars, base: { ...stats.base } };
  return stats;
}

// Advance a character one star. Adds the budget difference on top of the existing
// spread (proportional to current stats) so the character keeps its identity.
function advance(stats) {
  if (stats.stars >= MAX_STARS) return stats;
  const next = stats.stars + 1;
  let diff = STARS[next].budget - STARS[stats.stars].budget;
  const base = { ...stats.base };
  const total = BASE_STATS.reduce((a, s) => a + base[s], 0);
  // proportional share first
  for (const s of BASE_STATS) {
    const add = Math.min(Math.floor(diff * base[s] / total), STAT_MAX - base[s]);
    base[s] += add;
  }
  diff = STARS[next].budget - BASE_STATS.reduce((a, s) => a + base[s], 0);
  // remainder goes to the highest stats that still have room
  const order = [...BASE_STATS].sort((a, b) => base[b] - base[a]);
  let guard = 0;
  while (diff > 0 && guard++ < 100) {
    for (const s of order) { if (diff > 0 && base[s] < STAT_MAX) { base[s]++; diff--; } }
    if (order.every(s => base[s] >= STAT_MAX)) break;
  }
  // The roll they were born with survives advancement: a 5★ who started as a 1★ is still graded
  // on the 1★ roll that got them there.
  return { stars: next, base, derived: deriveStats(base), born: stats.born };
}

const StatsAPI = { BASE_STATS, STAT_NAMES, STAT_MIN, STAT_MAX, MAX_STARS, MAX_PULL_STARS, STARS, RACE_TENDENCIES, DERIVED, rollStars, starString, rollBaseStats, deriveStats, equipBonus, effective, withPoints, formatDerived, rollCharacterStats, freezeBorn, advance };
if (typeof module !== 'undefined') module.exports = StatsAPI;
if (typeof window !== 'undefined') window.Stats = StatsAPI;
