// Gifts: which of the three combat arts a character was BORN to. Browser: window.Gifts. Node: module.exports.
//
// Three paths: blade (martial techniques), arcana (sentence magic), psionics (workings). Every
// character can swing a weapon; the paths decide who can do more than that without being taught.
//
//   blade     knows techniques from its weapon aptitudes; without it, only what a class teaches
//   arcana    rolls a lexicon and prepares a full grimoire; without it, a class can teach a few
//             words, but only ONE short sentence is ever prepared (a dabbler, not a caster)
//   psionics  opens force and reach at once and one axis per six levels; without it, only the
//             axes a class opens, and nothing else ever unlocks
//
// Most characters walk one path. Two is uncommon and three is rare, and it gets a little less
// rare with stars. A character born to two paths is the only kind that can be a REAL hybrid: a
// spellblade whose weapon carries the last spell, a mystic whose workings feed its loops, an
// oracle whose two pools bleed into each other (perks below, applied in combat.js). A trained
// hybrid, a fighter who took the Spellsword class, gets the class's words and nothing more.
//
// Classes cannot add a path: they teach within one. A summon-only birthright class implies its
// path, so a born Sorcerer is always arcane.

(() => {
const R = () => (typeof Rng !== 'undefined') ? Rng : require('./rng.js');

const PATHS = {
  blade:    { label: 'Martial', icon: '⚔️', desc: 'Weapon techniques come with aptitude' },
  arcana:   { label: 'Arcane',  icon: '🔮', desc: 'A lexicon of its own, a full grimoire' },
  psionics: { label: 'Psionic', icon: '🧠', desc: 'Axes open with practice' },
};
const PATH_LIST = Object.keys(PATHS);

// Names for the combinations. Order-independent.
const NAMES = {
  'blade':                   { name: 'Warrior-born', icon: '⚔️' },
  'arcana':                  { name: 'Mage-born',    icon: '🔮' },
  'psionics':                { name: 'Psion-born',   icon: '🧠' },
  'arcana,blade':            { name: 'Spellblade',   icon: '⚔️🔮', perk: 'spellblade', desc: 'The last spell cast rides the next weapon strike: +25% damage and half its riders' },
  'blade,psionics':          { name: 'Mystic',       icon: '⚔️🧠', perk: 'mystic',     desc: 'Self-workings last half again as long, and techniques recover 15% faster while one is held' },
  'arcana,psionics':         { name: 'Oracle',       icon: '🔮🧠', perk: 'oracle',     desc: 'Mana and focus overlap: every spell and working costs 15% less' },
  'arcana,blade,psionics':   { name: 'Paragon',      icon: '✨',   perk: 'paragon',    desc: 'All three: spellblade, mystic and oracle' },
};

// Chance of a second and a third path by star count.
const DUAL = (stars) => 0.10 + 0.05 * (Math.max(1, stars) - 1);      // 1★ 10% … 5★ 30%
const TRIPLE = (stars) => Math.max(0, 0.012 * (stars - 2));            // 3★ 1.2% … 5★ 3.6%

// What pulls a character toward each path: its stats, and its race.
const RACE_PULL = {
  human:     {},
  draconic:  { blade: 4, arcana: 2 },
  therian:   { blade: 5, arcana: -2 },
  demonic:   { arcana: 4, blade: 1 },
  celestial: { arcana: 5, psionics: 2, blade: -3 },
  android:   { psionics: 6, arcana: 1, blade: -1 },
  robot:     { psionics: 5, blade: 2, arcana: -3 },
  bug:       { blade: 4, psionics: 1, arcana: -3 },
  orc:       { blade: 7, psionics: -3, arcana: -3 },
  goblin:    { arcana: 2, blade: 2 },
};

function weights(base, race) {
  const pull = RACE_PULL[race] || {};
  return {
    blade: Math.max(1, base.str + base.dex + (pull.blade || 0)),
    arcana: Math.max(1, base.int * 1.7 + (pull.arcana || 0)),
    psionics: Math.max(1, base.wis + base.cha * 0.6 + (pull.psionics || 0)),
  };
}

/** Roll the paths for a fresh character. Returns a sorted array of path ids. */
function roll(stats, race, rand = R().rand) {
  const w = weights(stats.base, race);
  const out = [];
  const draw = () => {
    const pool = PATH_LIST.filter(p => !out.includes(p));
    const total = pool.reduce((a, p) => a + w[p], 0);
    let x = rand() * total;
    for (const p of pool) { x -= w[p]; if (x < 0) return p; }
    return pool[pool.length - 1];
  };
  out.push(draw());
  if (rand() < DUAL(stats.stars)) out.push(draw());
  if (out.length === 2 && rand() < TRIPLE(stats.stars)) out.push(draw());
  return out.sort();
}

const has = (c, path) => !!(c.gifts && c.gifts.includes(path));
const key = (c) => (c.gifts || []).slice().sort().join(',');
function nameOf(c) { return NAMES[key(c)] || { name: 'Unremarkable', icon: '·' }; }
function perkOf(c) { const n = NAMES[key(c)]; return n ? n.perk || null : null; }
function hasPerk(c, perk) { const p = perkOf(c); return p === perk || p === 'paragon'; }

/** Paths a class implies: a class that grants words is an arcane class, and so on. Used only for birthrights. */
function impliedBy(def) {
  const out = [];
  const sk = def && def.skills || {};
  if (sk.tech) out.push('blade');
  if (sk.words) out.push('arcana');
  if (sk.axes) out.push('psionics');
  return out;
}

/**
 * Make a character's record consistent: roll paths if missing (old saves), fold in a summon-only
 * birthright's implied paths, and strip what it cannot carry (a lexicon it was not born with).
 * `bornDef` is the birthright class definition when one was just rolled.
 */
function ensure(c, bornDef = null, rand = R().rand) {
  if (!c.gifts) c.gifts = roll(c.stats, c.race, rand);
  if (bornDef) for (const p of impliedBy(bornDef)) if (!c.gifts.includes(p)) c.gifts.push(p);
  c.gifts.sort();
  if (!has(c, 'arcana')) c.lexicon = [];
  return c.gifts;
}

function describe(c) {
  const n = nameOf(c);
  const paths = (c.gifts || []).map(p => PATHS[p].label).join(' + ') || 'none';
  return { name: n.name, icon: n.icon, paths, perk: n.desc || '' };
}

const GiftsAPI = { PATHS, PATH_LIST, NAMES, RACE_PULL, DUAL, TRIPLE, weights, roll, has, key, nameOf, perkOf, hasPerk, impliedBy, ensure, describe };
if (typeof module !== 'undefined') module.exports = GiftsAPI;
if (typeof window !== 'undefined') window.Gifts = GiftsAPI;
})();
