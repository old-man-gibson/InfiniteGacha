// Classes: what a character has been trained to BE. Browser: window.Classes. Node: module.exports.
//
// A class is not a stat block and it is not a job. It is three things, and every class in the
// table below is an arrangement of the same three:
//
//   SKILLS      Techniques, words and psionic axes the class simply hands over. Granted skills
//               ignore the aptitude gate that normally guards them — a Duelist knows Riposte
//               because a Duelist was taught Riposte, not because their sword aptitude reached
//               D. They do NOT ignore the physical gate: a class-taught sword technique still
//               wants a sword in the hand. Grants unlock by RANK, so a class keeps paying out
//               for as long as it is practised.
//
//   TRAINING    A third growth term, stacked on top of the two affinity.js already has. A
//               character trains a type at 1 + preference + compatibility (affinity, capped at
//               2.5); a class adds + training on top of that, so the layers are:
//                   preference    what this body likes          (innate, grows with use)
//                   compatibility what this body is built for   (hidden until discovered)
//                   training      what somebody taught it       (this file)
//               Signature aptitudes carry weight 1 and reach +0.80 at grandmaster; incidental
//               ones carry less. On top of that, MASTERY aptitudes have their training cap
//               lifted: proficiency.js stops normal training at A+ and says outright that only
//               skills push an aptitude into S. Classes are those skills. A master reaches S-,
//               a grandmaster S, and only ever in the one or two things the class is about.
//
//   MIND        A rudimentary AI: a standing doctrine, what kinds of action it reaches for
//               first, who it hits, where it stands, and how hurt it keeps fighting.
//
// Class doctrine sets a lower bound on how a character fights; it is not an upper bound. ai.js
// grades how well a character reasons for itself, and a dim one reasons badly — it takes a random
// legal plan and walks into a fight with it. A class fixes that: the class doctrine is what the
// character does when it has nothing better, so a dim Warden still holds the line and a dim
// Berserker still swings first. Sharper minds treat the class as an opening position and deviate
// when the enemy calls for it (see `doctrine()` — the override needs a mind that can read the
// enemy at all). For the player this means classes make bad characters competent without making
// good characters redundant.
//
// One class at a time. Retraining is allowed and remembered: xp earned in a class is kept, so
// going back to something you used to be picks up where it stopped.

(() => {
const P = () => (typeof Prof !== 'undefined') ? Prof : require('./proficiency.js');
// Optional, for the evidence specialise() reads: how well they scout, how they are to work beside.
const AIx = () => (typeof AI !== 'undefined') ? AI : (typeof require !== 'undefined' ? require('./ai.js') : null);
const CR = () => (typeof Crew !== 'undefined') ? Crew : (typeof require !== 'undefined' ? require('./crew.js') : null);

// ---------- ranks ----------
// Rank is derived from class xp, never stored, so it cannot drift out of sync with the xp.
// `train` is the multiplier on the class's training weights; `cap` lifts the training ceiling
// of the class's mastery aptitudes past the A+ that ordinary training stops at.
const RANKS = [
  { id: 'novice',      label: 'Novice',      at: 0,   train: 0.20, cap: null },
  { id: 'adept',       label: 'Adept',       at: 8,   train: 0.35, cap: null },
  { id: 'expert',      label: 'Expert',      at: 24,  train: 0.50, cap: null },
  { id: 'master',      label: 'Master',      at: 60,  train: 0.65, cap: 'S-' },
  { id: 'grandmaster', label: 'Grandmaster', at: 140, train: 0.80, cap: 'S' },
];

// What practice is worth. A mission is worth about fifty training ticks: classes are learned
// by doing the work, and the training grounds are the slow way round.
const XP = { trainTick: 0.03, encounter: 0.15, mission: 1.5 };

const GROUPS = {
  warrior:  { label: 'Warriors',   icon: '\u2694\ufe0f', base: 'fighter',        desc: 'Weapons, armour and the front rank' },
  primal:   { label: 'Primal',     icon: '\ud83e\ude78', base: 'barbarian',      desc: 'Damage and endurance, little defence' },
  faith:    { label: 'Faithful',   icon: '\u271d\ufe0f', base: 'cleric',         desc: 'Healing, wards and light magic' },
  alchemy:  { label: 'Alchemical', icon: '\u2697\ufe0f', base: 'alchemist',      desc: 'Consumables, conditions and devices' },
  marksman: { label: 'Ranged',     icon: '\ud83c\udff9', base: 'ranger',         desc: 'Range, ground and scouting' },
  shadow:   { label: 'Shadow',     icon: '\ud83d\udde1\ufe0f', base: 'rogue',    desc: 'Openings, single targets and loot' },
  gifted:   { label: 'Gifted',     icon: '\ud83d\udd2e', base: 'elemental_mage', desc: 'Arcana and psionics; five branches are born only' },
  psion:    { label: 'Psions',     icon: '\ud83e\udde0', base: 'psion',          desc: 'Psionics. The base is born only; its six branches are grown into' },
};

// How a class fights, read by combat.js and the field.
const TARGETS = {
  weakest:   'the lowest effective HP',
  wounded:   'the lowest HP fraction',
  strongest: 'whatever hits hardest',
  caster:    'whatever has more magic damage than physical',
  spread:    'a different target each time',
};
const POSTURES = { front: 2.2, line: 1.0, back: 0.45 };

const M = (doctrine, act, target, posture, nerve) => ({ doctrine, act, target, posture, nerve });

// ---------- the classes ----------
// There are seven families of seven. Each family has one BASE — the generalist you actually
// train — and six SPECIALISATIONS you grow into. You never pick a specialisation: `specialise()`
// reads what the character has actually been doing (see `want`) and names them for it, which is
// why every entry below carries evidence rather than a requirement. Only the seven bases have
// `req`, because only a base is ever chosen; and the six `summonOnly` classes are chosen by
// nobody at all.
//
// base      this is a family's trunk: trainable, and a legitimate place to stay
// from       which base this grows out of
// want       what USE points at it. profs/stats are weighted 0..1 normalised; `carries` is the
//            weapon or armour they actually hold or prefer; `tech` is muscle memory; `scout` and
//            `social` read the derived numbers. See fitness().
// train      aptitude -> weight; the third growth term, scaled by rank
// mastery    aptitudes whose training cap this lifts into the S tier, or 'carried' for the one
//            weapon they happen to hold (Weaponmaster)
// skills     tech / words / axes -> minimum rank index that hands it over
// mind       standing orders: doctrine, what it reaches for, who it goes for, where it stands, nerve
// role       what the quartermaster treats it as (outfit.js)
// summonOnly cannot be taught, fused or grown into: rolled at the gate or never had
const CLASSES = {
  // ----- warrior -----
  fighter: {
    name: 'Fighter', icon: '⚔️', group: 'warrior',
    base: true,
    purpose: 'Generalist melee',
    strengths: 'Trains sword, axe, spear and medium armour at 80 to 90%; one resource track; Second Wind is a free self-heal',
    weaknesses: 'No multiplier on anything; every specialisation beats it in its own lane',
    req: { oneOf: { sword: 'D-', axe: 'D-', spear: 'D-' }, stats: { str: 10 } },
    train: { sword: 0.9, axe: 0.8, spear: 0.8, shield: 0.6, medium_armor: 0.9, heavy_armor: 0.5, light_armor: 0.5 },
    mastery: ['medium_armor'],
    skills: { tech: { gather: 0, heavy_blow: 0, thrust: 1, riposte: 2, crosscut: 3 } },
    mind: M('efficiency', { technique: 1.2, swing: 1.1, spell: 0.5, heal: 0.8 }, 'wounded', 'front', 0.75),
    role: 'frontline',
    features: [
      { id: 'second_wind', name: 'Second Wind', icon: '\ud83c\udf2c\ufe0f', rank: 0,
        desc: 'Self-heal: 0.5x damage stat. Free, 30 s cooldown',
        spell: { manaCost: 0, cooldown: 300, target: 'self', heal: 0.5 } },
    ],
  },
  warden: {
    name: 'Warden', icon: '🛡️', group: 'warrior',
    from: 'fighter',
    purpose: 'Holds ground and covers allies',
    strengths: 'Masters shield and heavy armour; front rank takes 2.2x the share of hits; never pulls back (nerve 1.0); teamwork x1.15',
    weaknesses: 'Swing x0.9; slow kills; no use when nothing needs covering',
    want: { profs: { shield: 3, heavy_armor: 2 }, stats: { con: 2 }, carries: ['tower', 'kite', 'buckler', 'heavy'] },
    train: { shield: 1, heavy_armor: 1, spear: 0.6, sword: 0.5, maintenance: 0.3 },
    mastery: ['shield', 'heavy_armor'],
    skills: { tech: { flowing_shield: 0, taunt: 0, gather: 1, sidestep: 1, riposte: 3, deflecting_moon: 4 } },
    mind: M('efficiency', { technique: 1.2, swing: 0.9, spell: 0.6, heal: 1.1 }, 'strongest', 'front', 1.0),
    role: 'frontline',
    social: 1.15,
  },
  pugilist: {
    name: 'Pugilist', icon: '🥊', group: 'warrior',
    from: 'fighter',
    purpose: 'Unarmed melee',
    strengths: 'Masters unarmed; seven techniques by Grandmaster; technique x1.4; no gear needed',
    weaknesses: 'No reach; medium armour at 40%; nothing at range',
    want: { profs: { unarmed: 4 }, stats: { str: 1, dex: 1 }, unarmed: 2, tech: ['slip_jab', 'ginga'] },
    train: { unarmed: 1, light_armor: 0.7, medium_armor: 0.4 },
    mastery: ['unarmed'],
    skills: { tech: { slip_jab: 0, ginga: 0, whirl_kick: 1, meia_lua: 2, clinch_knee: 3, german_suplex: 4, electric_cross: 4 } },
    mind: M('burst', { technique: 1.4, swing: 1.0, spell: 0.4, heal: 0.8 }, 'wounded', 'front', 0.85),
    role: 'frontline',
  },
  duelist: {
    name: 'Duelist', icon: '🤺', group: 'warrior',
    from: 'fighter',
    purpose: 'Single-target melee',
    strengths: 'Masters sword; Riposte and Sidestep at Novice; technique x1.35; targets the strongest enemy',
    weaknesses: 'Pulls back below 40% HP (nerve 0.6); light armour only; one target at a time',
    want: { profs: { sword: 3, dagger: 1 }, stats: { dex: 3 }, carries: ['sword'], tech: ['riposte', 'thrust'] },
    train: { sword: 0.9, dagger: 0.9, light_armor: 0.8, shield: 0.3 },
    mastery: ['sword'],
    skills: { tech: { riposte: 0, sidestep: 0, thrust: 1, deflecting_moon: 2, backstab: 3, iai_draw: 4 } },
    mind: M('burst', { technique: 1.35, swing: 1.0, spell: 0.5, heal: 0.7 }, 'strongest', 'line', 0.6),
    role: 'assassin',
  },
  spellsword: {
    name: 'Spellsword', icon: '🗡️', group: 'warrior',
    from: 'fighter',
    purpose: 'Melee plus arcana',
    strengths: 'Trains arcana at 90% and sword at 80%; iron and cut words at Novice; spell x1.15',
    weaknesses: 'Two training tracks; masters only the sword, so arcana stops at A+',
    want: { profs: { sword: 2, arcana: 3 }, stats: { int: 2 }, carries: ['sword'] },
    train: { sword: 0.8, arcana: 0.9, light_armor: 0.6, medium_armor: 0.4 },
    mastery: ['sword'],
    skills: { tech: { thrust: 0, gather: 1, crosscut: 3 }, words: { iron: 0, cut: 0, quickly: 1, then: 3, twice: 4 } },
    mind: M('stacking', { technique: 1.1, swing: 1.0, spell: 1.15, heal: 0.9 }, 'wounded', 'line', 0.7),
    role: 'frontline',
  },
  weaponmaster: {
    name: 'Weaponmaster', icon: '🏅', group: 'warrior',
    from: 'fighter',
    purpose: 'One weapon to the cap',
    strengths: 'Masters whatever weapon is carried; six techniques including two Grandmaster finishers; technique x1.4',
    weaknesses: 'Every weapon trains at 80%, none faster; medium armour at 50%',
    want: { focus: 4, stats: { str: 1, dex: 1 }, tech: ['heavy_blow', 'thrust', 'cleave', 'lunge', 'aimed_shot'] },
    train: { sword: 0.8, axe: 0.8, spear: 0.8, dagger: 0.8, bow: 0.8, staff: 0.8, medium_armor: 0.5 },
    mastery: 'carried',
    skills: { tech: { gather: 0, heavy_blow: 1, thrust: 2, crosscut: 3, iai_draw: 4, finishing_cut: 4 } },
    mind: M('burst', { technique: 1.4, swing: 1.15, spell: 0.4, heal: 0.7 }, 'strongest', 'front', 0.8),
    role: 'frontline',
  },
  commander: {
    name: 'Commander', icon: '🎖️', group: 'warrior',
    from: 'fighter',
    purpose: 'Buffs and directs the party',
    strengths: 'Teamwork x1.4, the highest in the game; heal x1.2; Taunt at Novice',
    weaknesses: 'No mastered weapon; every weapon at 60%; weak alone',
    want: { stats: { cha: 4, wis: 1 }, social: 3 },
    train: { sword: 0.6, spear: 0.6, heavy_armor: 0.6, medium_armor: 0.6, shield: 0.5 },
    mastery: ['medium_armor'],
    skills: { tech: { taunt: 0, gather: 1, sidestep: 2, riposte: 3 } },
    mind: M('efficiency', { technique: 1.0, swing: 0.9, spell: 0.8, heal: 1.2 }, 'strongest', 'line', 0.9),
    role: 'support',
    social: 1.4,
  },
  // ----- primal -----
  barbarian: {
    name: 'Barbarian', icon: '🦴', group: 'primal',
    base: true,
    purpose: 'Durable melee',
    strengths: 'Front rank; fights on to 5% HP (nerve 0.95); Thick Skin: +3 armour for 12 s, free; scouting +6',
    weaknesses: 'Spell x0.3; nothing for anyone else',
    req: { stats: { str: 12, con: 12 } },
    train: { axe: 0.8, spear: 0.7, unarmed: 0.7, medium_armor: 0.8, foraging: 0.5 },
    mastery: ['medium_armor'],
    skills: { tech: { gather: 0, cleave: 0, taunt: 1, heavy_blow: 1, ginga: 2, hook: 3 } },
    mind: M('efficiency', { technique: 1.15, swing: 1.15, spell: 0.3, heal: 0.9 }, 'weakest', 'front', 0.95),
    role: 'frontline',
    scout: 6,
    features: [
      { id: 'thick_skin', name: 'Thick Skin', icon: '\ud83d\udc17', rank: 0,
        desc: '+3 armour on self for 12 s. Free, 25 s cooldown',
        spell: { manaCost: 0, cooldown: 250, target: 'self', buff: { name: 'Thick Skin', mods: [{ stat: 'armor', op: 'add', value: 3 }], duration: 120 } } },
    ],
  },
  berserker: {
    name: 'Berserker', icon: '🪓', group: 'primal',
    from: 'barbarian',
    purpose: 'Axe burst',
    strengths: 'Masters axe; technique x1.3 and swing x1.2; never pulls back (nerve 1.0)',
    weaknesses: 'Light armour at 40%; heal x0.4; teamwork x0.9',
    want: { profs: { axe: 3 }, stats: { str: 3 }, carries: ['axe'], tech: ['cleave', 'heavy_blow'] },
    train: { axe: 1, unarmed: 0.7, light_armor: 0.4 },
    mastery: ['axe'],
    skills: { tech: { cleave: 0, heavy_blow: 0, hook: 1, gather: 2, taunt: 3, german_suplex: 4 } },
    mind: M('burst', { technique: 1.3, swing: 1.2, spell: 0.2, heal: 0.4 }, 'strongest', 'front', 1.0),
    role: 'frontline',
    social: 0.9,
  },
  shaman: {
    name: 'Shaman', icon: '🪶', group: 'primal',
    from: 'barbarian',
    purpose: 'Earth, wind and water magic',
    strengths: 'Masters earth and wind; heal x1.4; eight words by Grandmaster; scouting +8',
    weaknesses: 'Back rank; pulls back below 40% HP (nerve 0.6); staff is the only weapon',
    want: { profs: { earth: 2, wind: 2, water: 2, staff: 1 }, stats: { wis: 3 } },
    train: { staff: 0.7, earth: 0.8, wind: 0.8, water: 0.8, light_armor: 0.5, foraging: 0.6 },
    mastery: ['earth', 'wind'],
    skills: { words: { seed: 0, gust: 0, stone: 1, mend: 1, ward: 2, others: 2, expand: 3, twice: 4 } },
    mind: M('stacking', { technique: 0.7, swing: 0.6, spell: 1.3, heal: 1.4 }, 'caster', 'back', 0.6),
    role: 'support',
    scout: 8,
  },
  totemist: {
    name: 'Totemist', icon: '🗿', group: 'primal',
    from: 'barbarian',
    purpose: 'One animal aspect',
    strengths: 'Masters foraging; vitality and force axes; scouting +7; fights on to 15% HP',
    weaknesses: 'Three techniques; spell x0.9 with no words; no dial above x1.15',
    want: { profs: { foraging: 3, unarmed: 2, earth: 1 }, stats: { wis: 1, con: 1 } },
    train: { unarmed: 0.7, earth: 0.6, foraging: 0.8, medium_armor: 0.5 },
    mastery: ['foraging'],
    skills: { tech: { gather: 0, ginga: 1, hook: 3 }, axes: { vitality: 1, force: 2 } },
    mind: M('efficiency', { technique: 1.15, swing: 1.05, spell: 0.9, heal: 1.0 }, 'wounded', 'line', 0.85),
    role: 'frontline',
    scout: 7,
  },
  skinchanger: {
    name: 'Skinchanger', icon: '🐻', group: 'primal',
    from: 'barbarian',
    purpose: 'Unarmed shapeshift melee',
    strengths: 'Masters unarmed; five techniques; scouting +9; fights on to 10% HP',
    weaknesses: 'Light armour at 30%; no words; carried gear does nothing for the form',
    want: { profs: { unarmed: 3, foraging: 2 }, unarmed: 2, stats: { dex: 1, con: 1 } },
    train: { unarmed: 0.9, foraging: 0.7, light_armor: 0.3 },
    mastery: ['unarmed'],
    skills: { tech: { ginga: 0, whirl_kick: 1, clinch_knee: 2, meia_lua: 3, german_suplex: 4 }, axes: { vitality: 1 } },
    mind: M('burst', { technique: 1.3, swing: 1.1, spell: 0.5, heal: 0.9 }, 'wounded', 'front', 0.9),
    role: 'frontline',
    scout: 9,
  },
  reaver: {
    name: 'Reaver', icon: '💀', group: 'primal',
    from: 'barbarian',
    purpose: 'Fear and finishing',
    strengths: 'Masters dark; Finishing Cut at Grandmaster; targets the wounded; fights on to 5% HP',
    weaknesses: 'Teamwork x0.85; heal x0.5; medium armour at 50%',
    want: { profs: { dark: 2, axe: 2 }, stats: { cha: 1, str: 2 } },
    train: { axe: 0.8, dagger: 0.6, dark: 0.7, medium_armor: 0.5 },
    mastery: ['dark'],
    skills: { tech: { taunt: 0, cleave: 1, backstab: 2, finishing_cut: 4 }, words: { gloom: 2 } },
    mind: M('burst', { technique: 1.3, swing: 1.1, spell: 0.7, heal: 0.5 }, 'wounded', 'front', 0.95),
    role: 'frontline',
    social: 0.85,
  },
  primalist: {
    name: 'Primalist', icon: '🌋', group: 'primal',
    from: 'barbarian',
    purpose: 'Elemental magic without a book',
    strengths: 'Masters earth; six words by Grandmaster; spell x1.25; targets spread',
    weaknesses: 'No weapon past staff at 50%; less burst than a Berserker, fewer words than a Mage',
    want: { profs: { earth: 3, fire: 1, wind: 1, water: 1 }, stats: { wis: 1, int: 1 } },
    train: { earth: 0.9, fire: 0.7, wind: 0.7, water: 0.7, staff: 0.5 },
    mastery: ['earth'],
    skills: { words: { stone: 0, gust: 0, seed: 1, burst: 2, expand: 3, intensely: 4 } },
    mind: M('stacking', { technique: 0.8, swing: 0.7, spell: 1.25, heal: 0.9 }, 'spread', 'line', 0.75),
    role: 'caster',
  },
  // ----- faith -----
  cleric: {
    name: 'Cleric', icon: '⛪', group: 'faith',
    base: true,
    purpose: 'Faith healing',
    strengths: 'Masters light; heal x2.0; teamwork x1.25; Benediction heals the lowest ally for 10 mana',
    weaknesses: 'Back rank; pulls back below 50% HP (nerve 0.5); medium armour at 50%',
    req: { oneOf: { light: 'E+', arcana: 'D-' }, stats: { wis: 13 } },
    train: { light: 1, staff: 0.7, medium_armor: 0.5, alchemy: 0.4 },
    mastery: ['light'],
    skills: { words: { mend: 0, ward: 0, light: 0, others: 1, gently: 2, twice: 3, then: 4 } },
    mind: M('efficiency', { technique: 0.6, swing: 0.5, spell: 1.0, heal: 2.0 }, 'weakest', 'back', 0.5),
    role: 'support',
    social: 1.25,
    features: [
      { id: 'benediction', name: 'Benediction', icon: '\ud83d\udd4a\ufe0f', rank: 0,
        desc: 'Heals the lowest ally for 1.0x damage stat. 10 mana, 10 s cooldown',
        spell: { manaCost: 10, cooldown: 100, target: 'one', heal: 1.0 } },
    ],
  },
  paladin: {
    name: 'Paladin', icon: '✝️', group: 'faith',
    from: 'cleric',
    purpose: 'Armoured melee with light magic',
    strengths: 'Masters heavy armour; heal x1.5; fights on to 5% HP (nerve 0.95); teamwork x1.2',
    weaknesses: 'Four words, light and ward only; slower kills than a Fighter',
    want: { profs: { heavy_armor: 3, light: 2, sword: 1 }, stats: { cha: 2, str: 1 }, carries: ['heavy'] },
    train: { sword: 0.8, heavy_armor: 1, shield: 0.8, light: 0.8 },
    mastery: ['heavy_armor'],
    skills: { tech: { gather: 0, flowing_shield: 1, taunt: 1, riposte: 3 }, words: { light: 0, ward: 0, mend: 2, others: 3 } },
    mind: M('efficiency', { technique: 1.1, swing: 1.0, spell: 1.0, heal: 1.5 }, 'strongest', 'front', 0.95),
    role: 'frontline',
    social: 1.2,
  },
  inquisitor: {
    name: 'Inquisitor', icon: '⚖️', group: 'faith',
    from: 'cleric',
    purpose: 'Hunts a marked target',
    strengths: 'Masters light; scouting +8; targets casters first; burst doctrine',
    weaknesses: 'Medium armour only; training spread across five aptitudes at 60 to 80%',
    want: { profs: { light: 2, dark: 1, dagger: 1 }, stats: { wis: 2, cha: 1 }, scout: 2 },
    train: { light: 0.8, dark: 0.6, sword: 0.6, dagger: 0.6, medium_armor: 0.6 },
    mastery: ['light'],
    skills: { tech: { sidestep: 1, riposte: 2, backstab: 3 }, words: { light: 0, cut: 0, viciously: 2, if: 4 } },
    mind: M('burst', { technique: 1.1, swing: 0.9, spell: 1.2, heal: 0.9 }, 'caster', 'line', 0.7),
    role: 'caster',
    scout: 8,
  },
  liturgist: {
    name: 'Liturgist', icon: '📖', group: 'faith',
    from: 'cleric',
    purpose: 'Combat ritual magic',
    strengths: 'Masters arcana; spell x1.35; then, and, but, or, if by Grandmaster for long sentences',
    weaknesses: 'Back rank; pulls back below 50% HP; technique and swing x0.5; no armour training',
    want: { profs: { arcana: 3, light: 1 }, stats: { int: 2, wis: 2 } },
    train: { arcana: 0.9, light: 0.7, staff: 0.6 },
    mastery: ['arcana'],
    skills: { words: { ward: 0, light: 0, then: 1, and: 2, but: 3, or: 3, if: 4 } },
    mind: M('stacking', { technique: 0.5, swing: 0.5, spell: 1.35, heal: 1.2 }, 'caster', 'back', 0.5),
    role: 'caster',
  },
  warpriest: {
    name: 'Warpriest', icon: '🔨', group: 'faith',
    from: 'cleric',
    purpose: 'Armoured melee caster',
    strengths: 'Masters staff; heavy armour at 80%; heal x1.3; fights on to 10% HP',
    weaknesses: 'Three words only; less healing than a Cleric, less damage than a Fighter',
    want: { profs: { heavy_armor: 2, light: 2, staff: 2 }, stats: { str: 2 }, carries: ['staff', 'heavy'] },
    train: { staff: 0.7, axe: 0.7, heavy_armor: 0.8, light: 0.8, shield: 0.6 },
    mastery: ['staff'],
    skills: { tech: { crown_strike: 0, staff_sweep: 0, gather: 1, taunt: 2 }, words: { ward: 0, mend: 2, intensely: 3 } },
    mind: M('efficiency', { technique: 1.15, swing: 1.0, spell: 1.0, heal: 1.3 }, 'wounded', 'front', 0.9),
    role: 'frontline',
    social: 1.1,
  },
  exorcist: {
    name: 'Exorcist', icon: '⛓️', group: 'faith',
    from: 'cleric',
    purpose: 'Removal magic',
    strengths: 'Masters light; grip axis at Expert; zero and grasp words; spell x1.3',
    weaknesses: 'Line posture with staff at 50% and no armour training; no bonus against ordinary enemies',
    want: { profs: { light: 3, arcana: 1, psionics: 1 }, stats: { wis: 2 } },
    train: { light: 0.9, dark: 0.5, arcana: 0.6, staff: 0.5 },
    mastery: ['light'],
    skills: { words: { light: 0, zero: 1, grasp: 2, but: 4 }, axes: { grip: 2 } },
    mind: M('stacking', { technique: 0.6, swing: 0.6, spell: 1.3, heal: 1.0 }, 'caster', 'line', 0.65),
    role: 'caster',
  },
  oracle: {
    name: 'Oracle', icon: '🔮', group: 'faith',
    from: 'cleric',
    purpose: 'Arcana, psionics and foresight',
    strengths: 'Masters arcana; clairvoyance axis at Adept; scouting +10; targets spread',
    weaknesses: 'Back rank; pulls back below 45% HP; technique and swing x0.5',
    want: { profs: { arcana: 2, psionics: 2, light: 1 }, stats: { wis: 3 } },
    train: { arcana: 0.8, light: 0.6, psionics: 0.6 },
    mastery: ['arcana'],
    skills: { words: { gloom: 1, arcane: 2, if: 3, or: 4 }, axes: { clairvoyance: 1 } },
    mind: M('efficiency', { technique: 0.5, swing: 0.5, spell: 1.3, heal: 1.1 }, 'spread', 'back', 0.55),
    role: 'caster',
    scout: 10,
  },
  // ----- alchemy -----
  alchemist: {
    name: 'Alchemist', icon: '⚗️', group: 'alchemy',
    base: true,
    purpose: 'Consumables and conditions',
    strengths: 'Masters alchemy; loot x1.1; Flashbomb: 0.5x heat and Dazzled to every enemy for 8 mana',
    weaknesses: 'Back rank; pulls back below 50% HP; no weapon training',
    req: { profs: { alchemy: 'D-' }, stats: { int: 12 } },
    train: { alchemy: 1, acid: 0.7, poison: 0.6, cooking: 0.5, foraging: 0.5 },
    mastery: ['alchemy'],
    skills: { words: { acid: 0, venom: 1, burst: 2, expand: 3, intensely: 4 } },
    mind: M('stacking', { technique: 0.6, swing: 0.6, spell: 1.3, heal: 1.1 }, 'spread', 'back', 0.5),
    role: 'caster',
    loot: 1.1,
    features: [
      { id: 'flashbomb', name: 'Flashbomb', icon: '\ud83d\udca5', rank: 0,
        desc: '0.5x heat to every enemy; 90% Dazzled x2. 8 mana, 12 s cooldown',
        spell: { manaCost: 8, cooldown: 120, target: 'others', strikes: [{ type: 'heat', power: 0.5, inflicts: [{ id: 'dazzled', intensity: 2, chance: 0.9 }] }] } },
    ],
  },
  mutagenic: {
    name: 'Mutagenic', icon: '🧬', group: 'alchemy',
    from: 'alchemist',
    purpose: 'Self-buffing melee alchemist',
    strengths: 'Masters poison; front rank; never pulls back (nerve 1.0); vitality axis at Novice',
    weaknesses: 'Teamwork x0.85; no armour training; nothing for anyone else',
    want: { profs: { alchemy: 2, unarmed: 2, poison: 2 }, stats: { con: 2 }, unarmed: 1 },
    train: { alchemy: 0.9, unarmed: 0.8, poison: 0.8, acid: 0.6 },
    mastery: ['poison'],
    skills: { tech: { ginga: 1, clinch_knee: 3, german_suplex: 4 }, words: { venom: 0, grasp: 2 }, axes: { vitality: 0, force: 2 } },
    mind: M('stacking', { technique: 1.2, swing: 1.0, spell: 0.9, heal: 1.0 }, 'wounded', 'front', 1.0),
    role: 'frontline',
    social: 0.85,
  },
  apothecary: {
    name: 'Apothecary', icon: '🧴', group: 'alchemy',
    from: 'alchemist',
    purpose: 'Healing and cures',
    strengths: 'Masters alchemy; heal x1.8; teamwork x1.2; mend at Novice',
    weaknesses: 'Back rank; pulls back below 50% HP; technique and swing x0.5',
    want: { profs: { alchemy: 2, foraging: 2, cooking: 1 }, stats: { wis: 2, int: 1 } },
    train: { alchemy: 0.9, foraging: 0.7, cooking: 0.5, light: 0.4 },
    mastery: ['alchemy'],
    skills: { words: { mend: 0, gently: 1, ward: 2, others: 3, twice: 4 } },
    mind: M('efficiency', { technique: 0.5, swing: 0.5, spell: 1.0, heal: 1.8 }, 'weakest', 'back', 0.5),
    role: 'support',
    social: 1.2,
  },
  grenadier: {
    name: 'Grenadier', icon: '💣', group: 'alchemy',
    from: 'alchemist',
    purpose: 'Area fire damage',
    strengths: 'Masters fire; spell x1.35; burst at Novice, expand at Adept; targets spread',
    weaknesses: 'Back rank; pulls back below 45% HP; bow at 50% is the only weapon',
    want: { profs: { fire: 2, alchemy: 2, acid: 1 }, stats: { dex: 1, int: 1 } },
    train: { alchemy: 0.8, fire: 0.8, acid: 0.6, bow: 0.5 },
    mastery: ['fire'],
    skills: { words: { burst: 0, expand: 1, fire: 2, others: 3, intensely: 4 } },
    mind: M('burst', { technique: 1.0, swing: 0.7, spell: 1.35, heal: 0.8 }, 'spread', 'back', 0.55),
    role: 'caster',
  },
  chirurgeon: {
    name: 'Chirurgeon', icon: '🩺', group: 'alchemy',
    from: 'alchemist',
    purpose: 'Melee healer',
    strengths: 'Masters dagger; heal x1.4; mend at Novice, cut at Adept; teamwork x1.15',
    weaknesses: 'Has to be in reach; light armour at 50%; no area effects',
    want: { profs: { dagger: 2, alchemy: 2 }, stats: { dex: 2, int: 2 }, carries: ['dagger'] },
    train: { alchemy: 0.8, dagger: 0.7, light_armor: 0.5, cooking: 0.3 },
    mastery: ['dagger'],
    skills: { tech: { backstab: 1, flurry_stab: 2 }, words: { mend: 0, cut: 1, gently: 3 } },
    mind: M('stacking', { technique: 1.2, swing: 0.9, spell: 1.0, heal: 1.4 }, 'wounded', 'line', 0.7),
    role: 'support',
    social: 1.15,
  },
  homunculist: {
    name: 'Homunculist', icon: '🧫', group: 'alchemy',
    from: 'alchemist',
    purpose: 'Summoned helpers',
    strengths: 'Masters alchemy; mass axis at Expert; seed and others words; spell x1.25',
    weaknesses: 'Back rank; pulls back below 50% HP; no weapon; arcana at 50%',
    want: { profs: { alchemy: 3, arcana: 1 }, stats: { int: 3 } },
    train: { alchemy: 0.9, arcana: 0.5, maintenance: 0.4 },
    mastery: ['alchemy'],
    skills: { words: { seed: 0, others: 1, twice: 3, and: 4 }, axes: { mass: 2 } },
    mind: M('stacking', { technique: 0.6, swing: 0.5, spell: 1.25, heal: 1.1 }, 'spread', 'back', 0.5),
    role: 'caster',
  },
  artificer: {
    name: 'Artificer', icon: '🔩', group: 'alchemy',
    from: 'alchemist',
    purpose: 'Crafted devices',
    strengths: 'Masters smithing; iron and ward words; mass axis at Adept; trade rank counts toward it',
    weaknesses: 'Line posture with no armour training; spell x1.1 only',
    want: { profs: { smithing: 3, maintenance: 2 }, stats: { int: 2 }, trade: 2 },
    train: { smithing: 0.9, maintenance: 0.8, alchemy: 0.5, arcana: 0.5 },
    mastery: ['smithing'],
    skills: { words: { iron: 0, ward: 1, then: 3 }, axes: { mass: 1 } },
    mind: M('efficiency', { technique: 1.0, swing: 0.8, spell: 1.1, heal: 0.9 }, 'strongest', 'line', 0.7),
    role: 'caster',
  },
  // ----- marksman -----
  ranger: {
    name: 'Ranger', icon: '🏹', group: 'marksman',
    base: true,
    purpose: 'Bow and ground',
    strengths: 'Masters bow; scouting +14; Mark Quarry: 0.8x piercing that cannot miss and applies Read x3',
    weaknesses: 'Back rank; pulls back below 35% HP (nerve 0.65); light armour only',
    req: { profs: { bow: 'D-' }, stats: { dex: 12, wis: 11 } },
    train: { bow: 1, dagger: 0.6, light_armor: 0.7, foraging: 0.9 },
    mastery: ['bow'],
    skills: { tech: { aimed_shot: 0, volley: 1, sidestep: 2, backstab: 3 } },
    mind: M('efficiency', { technique: 1.25, swing: 1.0, spell: 0.6, heal: 0.9 }, 'weakest', 'back', 0.65),
    role: 'ranged',
    scout: 14,
    features: [
      { id: 'mark_quarry', name: 'Mark Quarry', icon: '\ud83c\udfaf', rank: 0,
        desc: '0.8x piercing, cannot miss, 30% penetration; applies Read x3 (-6% dodge and parry) for 20 s. 6 mana, 9 s cooldown',
        spell: { manaCost: 6, cooldown: 90, target: 'one', sure: true, strikes: [{ type: 'piercing', power: 0.8, penetration: 0.3, inflicts: [{ id: 'psionic_read', intensity: 3, chance: 1 }] }] } },
    ],
  },
  skulker: {
    name: 'Skulker', icon: '🌒', group: 'marksman',
    from: 'ranger',
    purpose: 'Stealth archer',
    strengths: 'Masters dagger; Aimed Shot and Backstab at Novice; scouting +10; technique x1.3',
    weaknesses: 'Pulls back below 50% HP; light armour; no words',
    want: { profs: { dagger: 2, bow: 2, foraging: 2, dark: 1 }, stats: { dex: 2 } },
    train: { bow: 0.8, dagger: 0.8, light_armor: 0.8, foraging: 0.6, dark: 0.4 },
    mastery: ['dagger'],
    skills: { tech: { aimed_shot: 0, backstab: 0, sidestep: 1, flurry_stab: 2, volley: 3 } },
    mind: M('burst', { technique: 1.3, swing: 0.95, spell: 0.5, heal: 0.8 }, 'caster', 'back', 0.5),
    role: 'ranged',
    scout: 10,
  },
  magic_archer: {
    name: 'Magic Archer', icon: '🎯', group: 'marksman',
    from: 'ranger',
    purpose: 'Arcana on the arrow',
    strengths: 'Masters bow; arcana at 80%; iron and pierce words at Novice; spell x1.2',
    weaknesses: 'Melee; light armour at 50%; arcana stops at A+',
    want: { profs: { bow: 3, arcana: 2 }, stats: { int: 2, dex: 1 }, carries: ['bow'] },
    train: { bow: 0.9, arcana: 0.8, light_armor: 0.5 },
    mastery: ['bow'],
    skills: { tech: { aimed_shot: 0, volley: 2 }, words: { iron: 0, pierce: 0, fly: 1, then: 3, twice: 4 } },
    mind: M('burst', { technique: 1.15, swing: 0.9, spell: 1.2, heal: 0.8 }, 'weakest', 'back', 0.6),
    role: 'ranged',
  },
  artillerist: {
    name: 'Artillerist', icon: '💥', group: 'marksman',
    from: 'ranger',
    purpose: 'Area fire and earth magic',
    strengths: 'Masters fire; spell x1.35; six words; targets spread',
    weaknesses: 'Back rank; pulls back below 50% HP; nothing for anything that closes',
    want: { profs: { fire: 2, arcana: 2, earth: 1 }, stats: { int: 3 } },
    train: { bow: 0.7, arcana: 0.8, fire: 0.8, earth: 0.6, smithing: 0.5 },
    mastery: ['fire'],
    skills: { tech: { volley: 1 }, words: { burst: 0, expand: 1, stone: 2, slowly: 2, others: 3, intensely: 4 } },
    mind: M('burst', { technique: 1.0, swing: 0.7, spell: 1.35, heal: 0.8 }, 'spread', 'back', 0.5),
    role: 'caster',
  },
  trapper: {
    name: 'Trapper', icon: '🪤', group: 'marksman',
    from: 'ranger',
    purpose: 'Poison and traps',
    strengths: 'Masters foraging; scouting +11; loot x1.1; seed, grasp, venom and slowly words',
    weaknesses: 'Stacking doctrine needs time; targets the strongest; no armour training',
    want: { profs: { foraging: 3, poison: 2, maintenance: 1 }, stats: { wis: 1, dex: 1 } },
    train: { foraging: 1, dagger: 0.7, bow: 0.6, poison: 0.7, maintenance: 0.5 },
    mastery: ['foraging'],
    skills: { tech: { hook: 2, sidestep: 1 }, words: { seed: 0, grasp: 1, venom: 2, slowly: 2, if: 4 } },
    mind: M('stacking', { technique: 1.1, swing: 0.9, spell: 1.15, heal: 0.9 }, 'strongest', 'line', 0.6),
    role: 'ranged',
    scout: 11,
    loot: 1.1,
  },
  beastmaster: {
    name: 'Beastmaster', icon: '🐕', group: 'marksman',
    from: 'ranger',
    purpose: 'Fights beside a companion',
    strengths: 'Masters foraging; teamwork x1.2; scouting +10; grip axis at Expert',
    weaknesses: 'Line posture with light armour at 50%; spell x0.8',
    want: { profs: { foraging: 3, bow: 1 }, stats: { cha: 2, wis: 1 }, social: 2 },
    train: { bow: 0.7, foraging: 0.8, unarmed: 0.5, light_armor: 0.5 },
    mastery: ['foraging'],
    skills: { tech: { aimed_shot: 1, hook: 2, sidestep: 3 }, axes: { grip: 2 } },
    mind: M('efficiency', { technique: 1.15, swing: 1.0, spell: 0.8, heal: 1.1 }, 'wounded', 'line', 0.75),
    role: 'ranged',
    scout: 10,
    social: 1.2,
  },
  scout: {
    name: 'Scout', icon: '🧭', group: 'marksman',
    from: 'ranger',
    purpose: 'Reconnaissance',
    strengths: 'Scouting +18, the highest in the game; masters foraging; loot x1.05',
    weaknesses: 'Pulls back below 50% HP; two techniques; technique x1.0',
    want: { profs: { foraging: 3, bow: 1 }, stats: { wis: 3, dex: 1 }, scout: 4 },
    train: { foraging: 1, bow: 0.7, light_armor: 0.6, dagger: 0.5 },
    mastery: ['foraging'],
    skills: { tech: { sidestep: 0, aimed_shot: 1 } },
    mind: M('efficiency', { technique: 1.0, swing: 0.9, spell: 0.7, heal: 1.0 }, 'weakest', 'back', 0.5),
    role: 'ranged',
    scout: 18,
    loot: 1.05,
  },
  // ----- shadow -----
  rogue: {
    name: 'Rogue', icon: '🗡️', group: 'shadow',
    base: true,
    purpose: 'Openings and loot',
    strengths: 'Masters dagger; loot x1.1; Backstab and Sidestep at Novice; Vanish: +50% dodge for 4 s, free',
    weaknesses: 'Pulls back below 40% HP (nerve 0.6); light armour only; no bonus without an opening',
    req: { profs: { dagger: 'D-' }, stats: { dex: 13 } },
    train: { dagger: 1, light_armor: 0.8, maintenance: 0.5, foraging: 0.4 },
    mastery: ['dagger'],
    skills: { tech: { backstab: 0, sidestep: 0, flurry_stab: 1, slip_jab: 2, riposte: 3, finishing_cut: 4 } },
    mind: M('burst', { technique: 1.3, swing: 1.0, spell: 0.6, heal: 0.9 }, 'wounded', 'line', 0.6),
    role: 'assassin',
    loot: 1.1,
    features: [
      { id: 'vanish', name: 'Vanish', icon: '\ud83c\udf2b\ufe0f', rank: 0,
        desc: '+50% dodge on self for 4 s. Free, 20 s cooldown',
        spell: { manaCost: 0, cooldown: 200, target: 'self', buff: { name: 'Vanished', mods: [{ stat: 'dodge', op: 'add', value: 0.5 }], duration: 40 } } },
    ],
  },
  assassin: {
    name: 'Assassin', icon: '🥷', group: 'shadow',
    from: 'rogue',
    purpose: 'One prepared kill',
    strengths: 'Masters dagger; technique x1.45, the highest; five techniques up to Finishing Cut',
    weaknesses: 'Pulls back below 50% HP; heal x0.6; teamwork x0.9; no area effects',
    want: { profs: { dagger: 4, poison: 1, dark: 1 }, stats: { dex: 3 }, tech: ['backstab', 'flurry_stab'] },
    train: { dagger: 1, dark: 0.6, poison: 0.6, light_armor: 0.7, alchemy: 0.4 },
    mastery: ['dagger'],
    skills: { tech: { backstab: 0, slip_jab: 1, flurry_stab: 2, iai_draw: 3, finishing_cut: 4 }, words: { venom: 2 } },
    mind: M('burst', { technique: 1.45, swing: 0.9, spell: 0.6, heal: 0.6 }, 'caster', 'line', 0.5),
    role: 'assassin',
    social: 0.9,
  },
  butcher: {
    name: 'Butcher', icon: '🔪', group: 'shadow',
    from: 'rogue',
    purpose: 'Loud front-rank melee',
    strengths: 'Masters axe; front rank takes 2.2x the share of hits; fights on to 10% HP (nerve 0.9); Roar cows the room; Red Work holds basic and veteran hostiles back after a kill',
    weaknesses: 'Teamwork x0.6; spell x0.3; medium armour at 70%, below any Primal',
    // the Rogue who is built like a Barbarian: strength and constitution, an axe or a heavy hand,
    // and a habit of the big swing rather than the quiet one
    want: { profs: { axe: 3, medium_armor: 2, unarmed: 1 }, stats: { con: 3, str: 3 }, carries: ['axe'], tech: ['cleave', 'heavy_blow'] },
    train: { axe: 0.9, dagger: 0.7, medium_armor: 0.7, unarmed: 0.6, light_armor: 0.4 },
    mastery: ['axe'],
    skills: { tech: { cleave: 0, backstab: 0, taunt: 1, heavy_blow: 1, clinch_knee: 2, flurry_stab: 3, german_suplex: 4 } },
    mind: M('burst', { technique: 1.3, swing: 1.2, spell: 0.3, heal: 0.5 }, 'wounded', 'front', 0.9),
    role: 'assassin',
    social: 0.6,
    features: [
      { id: 'butchers_roar', name: "Butcher's Roar", icon: '📢', rank: 0,
        desc: 'Every enemy Cowed x1 at 85%: -20% damage, -10% accuracy, -10% speed for 15 s. Cannot miss. Free, 20 s cooldown',
        spell: { manaCost: 0, cooldown: 200, target: 'others', sure: true, afflicts: [{ id: 'cowed', intensity: 1, chance: 0.85 }] } },
      { id: 'red_work', name: 'Red Work', icon: '🩸', rank: 0,
        desc: 'On the map: after a fight with a kill, basic and veteran hostiles within 6 tiles that are not fighting hold position for 45 s',
        field: { kind: 'terror', reach: 6, seconds: 45 } },
      { id: 'hack_apart', name: 'Hack Apart', icon: '🪓', rank: 1,
        desc: '1.5x slashing, 20% penetration; 80% Bleeding x2, 70% Cowed x1. Free, 15 s cooldown',
        spell: { manaCost: 0, cooldown: 150, target: 'one', strikes: [{ type: 'slashing', power: 1.5, penetration: 0.2, inflicts: [{ id: 'bleeding', intensity: 2, chance: 0.8 }, { id: 'cowed', intensity: 1, chance: 0.7 }] }] } },
      { id: 'abattoir', name: 'Abattoir', icon: '🥩', rank: 3,
        desc: 'Every enemy Cowed x2 and 30% Dazed; +2 armour on self for 10 s. Cannot miss. Free, 40 s cooldown',
        spell: { manaCost: 0, cooldown: 400, target: 'others', sure: true, afflicts: [{ id: 'cowed', intensity: 2, chance: 1 }, { id: 'dazed', intensity: 1, chance: 0.3 }], buff: { name: 'Abattoir', mods: [{ stat: 'armor', op: 'add', value: 2 }], duration: 100 } } },
    ],
  },
  thief: {
    name: 'Thief', icon: '💰', group: 'shadow',
    from: 'rogue',
    purpose: 'Loot and getting in',
    strengths: 'Loot x1.35, the highest; masters light armour; scouting +8',
    weaknesses: 'Pulls back below 70% HP (nerve 0.3); back rank; swing x0.9',
    want: { profs: { maintenance: 2, dagger: 1, light_armor: 2 }, stats: { dex: 3 }, loot: 2 },
    train: { dagger: 0.7, light_armor: 0.7, maintenance: 0.5, foraging: 0.5 },
    mastery: ['light_armor'],
    skills: { tech: { sidestep: 0, backstab: 1, slip_jab: 2, flurry_stab: 4 } },
    mind: M('efficiency', { technique: 1.1, swing: 0.9, spell: 0.6, heal: 1.0 }, 'weakest', 'back', 0.3),
    role: 'assassin',
    scout: 8,
    loot: 1.35,
  },
  spy: {
    name: 'Spy', icon: '🕵️', group: 'shadow',
    from: 'rogue',
    purpose: 'Infiltration and information',
    strengths: 'Scouting +13; teamwork x1.1; loot x1.15; gloom and if words',
    weaknesses: 'Pulls back below 55% HP (nerve 0.45); masters maintenance only; swing x0.85',
    want: { stats: { cha: 3, int: 2, dex: 1 }, scout: 2, social: 2 },
    train: { dagger: 0.6, light_armor: 0.6, maintenance: 0.5, dark: 0.4 },
    mastery: ['maintenance'],
    skills: { tech: { sidestep: 0, backstab: 2 }, words: { gloom: 2, if: 4 } },
    mind: M('efficiency', { technique: 1.05, swing: 0.85, spell: 0.8, heal: 1.0 }, 'caster', 'back', 0.45),
    role: 'assassin',
    scout: 13,
    social: 1.1,
    loot: 1.15,
  },
  acrobat: {
    name: 'Acrobat', icon: '🤸', group: 'shadow',
    from: 'rogue',
    purpose: 'Mobility melee',
    strengths: 'Masters light armour; Sidestep at Novice, five techniques; technique x1.25',
    weaknesses: 'Pulls back below 45% HP; no words; loses a race on raw HP',
    want: { profs: { light_armor: 3, unarmed: 2 }, stats: { dex: 4 }, carries: ['light'] },
    train: { unarmed: 0.7, dagger: 0.6, light_armor: 0.9 },
    mastery: ['light_armor'],
    skills: { tech: { sidestep: 0, ginga: 1, slip_jab: 1, whirl_kick: 2, meia_lua: 3 } },
    mind: M('burst', { technique: 1.25, swing: 1.0, spell: 0.5, heal: 0.9 }, 'wounded', 'line', 0.55),
    role: 'assassin',
  },
  saboteur: {
    name: 'Saboteur', icon: '🧰', group: 'shadow',
    from: 'rogue',
    purpose: 'Breaks devices and structures',
    strengths: 'Masters maintenance; burst, acid, iron and expand words; loot x1.1; trade rank counts toward it',
    weaknesses: 'Dagger at 50%; pulls back below 40% HP; no bonus in a plain duel',
    want: { profs: { maintenance: 3, smithing: 2, fire: 1 }, stats: { int: 2 }, trade: 1 },
    train: { maintenance: 0.8, smithing: 0.6, alchemy: 0.6, fire: 0.6, dagger: 0.5 },
    mastery: ['maintenance'],
    skills: { tech: { backstab: 1, hook: 3 }, words: { burst: 0, acid: 1, iron: 2, expand: 3 } },
    mind: M('burst', { technique: 1.15, swing: 0.9, spell: 1.2, heal: 0.8 }, 'strongest', 'line', 0.6),
    role: 'assassin',
    loot: 1.1,
  },
  // ----- psion -----
  // The one family whose TRUNK is the gift. Psion is both a base and summon-only, which the
  // machinery already handles: it never appears in the picker and cannot be fused, because
  // nobody takes up psionics — but once somebody is born to it they branch on evidence like
  // anybody else. Being born a Psion is the start of a road rather than the end of one.
  psion: {
    name: 'Psion', icon: '\ud83e\udde0', group: 'psion',
    base: true, summonOnly: true, rarity: 8,
    purpose: 'Psionics without a school',
    strengths: 'Masters psionics; six axes by Grandmaster; Focus: Foresight x4 and Braced x3 on self, free',
    weaknesses: 'Born only; arcana at 30%; no weapon or armour training',
    train: { psionics: 1, arcana: 0.3 },
    mastery: ['psionics'],
    skills: { axes: { force: 0, reach: 0, grip: 1, speed: 2, vitality: 3, mass: 4 } },
    mind: M('efficiency', { technique: 0.7, swing: 0.7, spell: 1.2, heal: 1.0 }, 'weakest', 'line', 0.6),
    role: 'caster',
    features: [
      { id: 'focus', name: 'Focus', icon: '\ud83e\udde0', rank: 0,
        desc: 'Foresight x4 (-12% incoming hit chance) and Braced x3 (+3 armour) on self for 20 s. Free, 15 s cooldown',
        spell: { school: 'psionic', focusCost: 0, cooldown: 150, target: 'self', grants: [{ id: 'psionic_foresight', intensity: 4, chance: 1 }, { id: 'psionic_bracing', intensity: 3, chance: 1 }] } },
    ],
  },
  mind_knife: {
    name: 'Mind Knife', icon: '\ud83d\udd2a', group: 'psion',
    from: 'psion',
    purpose: 'Psionic close-quarters burst',
    strengths: 'Masters psionics; Backstab at Novice; force, speed and grip axes; scouting +8',
    weaknesses: 'Dagger at 60%; nothing at range; pulls back below 45% HP',
    want: { profs: { dagger: 3, unarmed: 1, psionics: 1 }, stats: { dex: 3 }, tech: ['backstab', 'slip_jab'] },
    train: { psionics: 0.9, dagger: 0.6, unarmed: 0.5, light_armor: 0.5 },
    mastery: ['psionics'],
    skills: { tech: { backstab: 0, slip_jab: 1, sidestep: 2, flurry_stab: 3 }, axes: { force: 0, speed: 1, grip: 3 } },
    mind: M('burst', { technique: 1.3, swing: 1.0, spell: 1.0, heal: 0.8 }, 'wounded', 'line', 0.55),
    role: 'assassin',
    scout: 8,
  },
  telekinetic: {
    name: 'Telekinetic', icon: '\ud83c\udf00', group: 'psion',
    from: 'psion',
    purpose: 'Moving objects by will',
    strengths: 'Masters psionics; pool x1.2; reach, grip, space, mass and speed axes; scouting +10',
    weaknesses: 'Magic damage x0.8; back rank; pulls back below 45% HP',
    want: { profs: { psionics: 2, maintenance: 1 }, stats: { int: 4 } },
    train: { psionics: 1, maintenance: 0.4 },
    mastery: ['psionics'],
    skills: { axes: { reach: 0, grip: 0, space: 1, mass: 2, speed: 3 } },
    mind: M('efficiency', { technique: 0.6, swing: 0.6, spell: 1.1, heal: 1.1 }, 'caster', 'back', 0.55),
    role: 'support',
    scout: 10,
    magicMult: 0.8,
    poolMult: 1.2,
  },
  sword_soul: {
    name: 'Sword Soul', icon: '\u2694\ufe0f', group: 'psion',
    from: 'psion',
    purpose: 'Sword carried by will',
    strengths: 'Masters psionics and sword; force, reach and mass axes; Iai Draw at Grandmaster',
    weaknesses: 'Medium armour at 40%; spear at 50%; one weapon at a time',
    want: { profs: { sword: 4, spear: 1, psionics: 1 }, stats: { int: 1, str: 1 }, carries: ['sword', 'spear'] },
    train: { psionics: 0.9, sword: 0.7, spear: 0.5, medium_armor: 0.4 },
    mastery: ['psionics', 'sword'],
    skills: { tech: { thrust: 0, gather: 1, crosscut: 2, iai_draw: 4 }, axes: { force: 0, reach: 1, mass: 2 } },
    mind: M('burst', { technique: 1.3, swing: 1.05, spell: 1.0, heal: 0.8 }, 'strongest', 'front', 0.8),
    role: 'frontline',
  },
  mindpeeker: {
    name: 'Mindpeeker', icon: '\ud83d\udc41\ufe0f', group: 'psion',
    from: 'psion',
    purpose: 'Mental conditions',
    strengths: 'Masters psionics; grip and clairvoyance at Novice; gloom and dimly words; scouting +12',
    weaknesses: 'Magic damage x0.85; back rank; pulls back below 45% HP; nothing against the mindless',
    want: { profs: { dark: 3, psionics: 1 }, stats: { wis: 4, int: 1 }, scout: 2 },
    train: { psionics: 0.9, dark: 0.5, arcana: 0.3 },
    mastery: ['psionics'],
    skills: { axes: { grip: 0, clairvoyance: 0, reach: 2, speed: 3 }, words: { gloom: 2, dimly: 3 } },
    mind: M('stacking', { technique: 0.7, swing: 0.6, spell: 1.25, heal: 0.9 }, 'caster', 'back', 0.55),
    role: 'caster',
    scout: 12,
    magicMult: 0.85,
  },
  iron_will: {
    name: 'Iron Will', icon: '\ud83e\uddf1', group: 'psion',
    from: 'psion',
    purpose: 'Psionic tank',
    strengths: 'Masters psionics; pool x1.15; front rank; never pulls back (nerve 1.0); teamwork x1.15; Taunt at Novice',
    weaknesses: 'Magic damage x0.85; heavy armour at 60%; slow kills',
    want: { profs: { heavy_armor: 2, medium_armor: 1, psionics: 1 }, stats: { con: 4, cha: 1 } },
    train: { psionics: 0.9, heavy_armor: 0.6, medium_armor: 0.5, shield: 0.4 },
    mastery: ['psionics'],
    skills: { tech: { taunt: 0, gather: 1, flowing_shield: 3 }, axes: { vitality: 0, mass: 1, force: 2 } },
    mind: M('efficiency', { technique: 1.1, swing: 0.9, spell: 1.0, heal: 1.2 }, 'strongest', 'front', 1.0),
    role: 'frontline',
    social: 1.15,
    magicMult: 0.85,
    poolMult: 1.15,
  },
  mending_touch: {
    name: 'Mending Touch', icon: '\ud83e\udec2', group: 'psion',
    from: 'psion',
    purpose: 'Psionic healing',
    strengths: 'Masters psionics; heal x1.9; pool x1.2; teamwork x1.25; no faith or reagents needed',
    weaknesses: 'Magic damage x0.7; back rank; pulls back below 50% HP',
    want: { profs: { psionics: 1, light: 1 }, stats: { cha: 4, wis: 3 }, social: 2 },
    train: { psionics: 1, light: 0.4, alchemy: 0.3 },
    mastery: ['psionics'],
    skills: { axes: { vitality: 0, reach: 1, grip: 2, speed: 3 }, words: { mend: 2, others: 3 } },
    mind: M('efficiency', { technique: 0.5, swing: 0.5, spell: 0.9, heal: 1.9 }, 'weakest', 'back', 0.5),
    role: 'support',
    social: 1.25,
    magicMult: 0.7,
    poolMult: 1.2,
  },
  // ----- gifted -----
  beguiler: {
    name: 'Beguiler', icon: '\ud83c\udf11', group: 'gifted',
    from: 'elemental_mage',
    purpose: 'Conditions and infiltration',
    strengths: 'Masters dark; seven words led by venom and gloom at Novice; scouting +11; loot x1.1',
    weaknesses: 'Magic damage x0.85; no burst; nothing at range',
    want: { profs: { dark: 3, poison: 2, arcana: 2, dagger: 1 }, stats: { dex: 2, int: 2 }, scout: 1 },
    train: { arcana: 0.8, dark: 0.7, poison: 0.6, dagger: 0.5, light_armor: 0.5, psionics: 0.4 },
    mastery: ['dark'],
    skills: { words: { venom: 0, gloom: 0, grasp: 1, dimly: 2, quickly: 2, seed: 3, if: 4 }, axes: { speed: 1, clairvoyance: 3 } },
    mind: M('stacking', { technique: 1.0, swing: 0.8, spell: 1.15, heal: 0.9 }, 'caster', 'line', 0.55),
    role: 'assassin',
    scout: 11,
    loot: 1.1,
    magicMult: 0.85,
  },
  utilitarian_mage: {
    name: 'Utilitarian Mage', icon: '\ud83e\uddf0', group: 'gifted',
    from: 'elemental_mage',
    purpose: 'Support arcana and manipulative psionics',
    strengths: 'Masters arcana; pool x1.25; scouting +12; space, reach, grip and clairvoyance axes; heal x1.2',
    weaknesses: 'Magic damage x0.75, the lowest of any caster; back rank; pulls back below 45% HP',
    want: { profs: { arcana: 4, psionics: 3 }, stats: { int: 2, wis: 1 } },
    train: { arcana: 1, psionics: 0.8, light: 0.4, maintenance: 0.3 },
    mastery: ['arcana'],
    skills: { words: { ward: 0, others: 0, fly: 1, grasp: 2, mend: 2, then: 3, if: 4 }, axes: { space: 0, reach: 1, grip: 2, clairvoyance: 3 } },
    mind: M('efficiency', { technique: 0.5, swing: 0.5, spell: 0.95, heal: 1.2 }, 'caster', 'back', 0.55),
    role: 'support',
    scout: 12,
    magicMult: 0.75,
    poolMult: 1.25,
  },
  arcanist: {
    name: 'Arcanist', icon: '\ud83d\udcda', group: 'gifted',
    from: 'elemental_mage',
    purpose: 'Widest spell list',
    strengths: 'Masters arcana; +2 prepared spells; seven elements trained at 50%; eleven words',
    weaknesses: 'Pool x0.75; back rank; pulls back below 45% HP',
    want: { profs: { arcana: 4, fire: 1, ice: 1, lightning: 1, water: 1, earth: 1, wind: 1 }, stats: { int: 3 } },
    train: { arcana: 1, fire: 0.5, ice: 0.5, lightning: 0.5, water: 0.5, earth: 0.5, wind: 0.5, light: 0.4, dark: 0.4 },
    mastery: ['arcana'],
    skills: { words: { fire: 0, ice: 0, spark: 0, water: 1, stone: 1, gust: 1, quickly: 2, then: 3, or: 3, and: 4, if: 4 } },
    mind: M('efficiency', { technique: 0.5, swing: 0.5, spell: 1.3, heal: 1.0 }, 'weakest', 'back', 0.55),
    role: 'caster',
    prepared: 2,
    poolMult: 0.75,
  },
  runescribe: {
    name: 'Runescribe', icon: '\ud83d\udcdc', group: 'gifted',
    from: 'elemental_mage',
    purpose: 'Group buffs and wards',
    strengths: 'Masters arcana; heal x1.3; teamwork x1.2; ward and others at Novice',
    weaknesses: 'No damage words past iron; back rank; pulls back below 45% HP',
    want: { profs: { arcana: 3, smithing: 2, maintenance: 1, light: 1 }, stats: { int: 2, wis: 2 }, trade: 1 },
    train: { arcana: 0.9, smithing: 0.6, maintenance: 0.5, light: 0.4, staff: 0.4 },
    mastery: ['arcana'],
    skills: { words: { ward: 0, others: 0, slowly: 1, then: 2, iron: 2, and: 3, twice: 4 } },
    mind: M('stacking', { technique: 0.5, swing: 0.5, spell: 1.2, heal: 1.3 }, 'caster', 'back', 0.55),
    role: 'support',
    social: 1.2,
  },
  barrier_mage: {
    name: 'Barrier Mage', icon: '\ud83d\udee1\ufe0f', group: 'gifted',
    from: 'elemental_mage',
    purpose: 'Wards and hindering magic',
    strengths: 'Masters arcana; pool x1.1; line posture; fights on to 5% HP (nerve 0.95); heal x1.25; vitality, mass and grip axes',
    weaknesses: 'Magic damage x0.9; slow kills',
    want: { profs: { arcana: 3, psionics: 2, ice: 1, earth: 1 }, stats: { con: 2, wis: 2 } },
    train: { arcana: 0.9, psionics: 0.7, ice: 0.6, earth: 0.6, light: 0.5, shield: 0.3 },
    mastery: ['arcana'],
    skills: { words: { ward: 0, stone: 0, grasp: 1, slowly: 2, others: 2, ice: 3, and: 4 }, axes: { vitality: 0, mass: 1, grip: 3 } },
    mind: M('efficiency', { technique: 0.6, swing: 0.6, spell: 1.1, heal: 1.25 }, 'strongest', 'line', 0.95),
    role: 'support',
    magicMult: 0.9,
    poolMult: 1.1,
    social: 1.1,
  },
  elemental_mage: {
    name: 'Elemental Mage', icon: '🔥', group: 'gifted',
    base: true,
    purpose: 'Elemental damage',
    strengths: 'Masters arcana; spell x1.4; fire, ice and spark at Novice; Elemental Surge: 0.9x heat or cold to every enemy',
    weaknesses: 'Back rank; pulls back below 50% HP; technique and swing x0.5',
    req: { profs: { arcana: 'D-' }, stats: { int: 13 } },
    train: { arcana: 1, fire: 0.8, ice: 0.8, lightning: 0.8, water: 0.6, earth: 0.6, wind: 0.6 },
    mastery: ['arcana'],
    skills: { words: { fire: 0, ice: 0, spark: 0, burst: 1, expand: 2, intensely: 3, twice: 4 } },
    mind: M('efficiency', { technique: 0.5, swing: 0.5, spell: 1.4, heal: 0.9 }, 'weakest', 'back', 0.5),
    role: 'caster',
    features: [
      { id: 'elemental_surge', name: 'Elemental Surge', icon: '\ud83d\udd2e', rank: 0,
        desc: '0.9x heat or cold, whichever the enemies resist less, to every enemy. 14 mana, 12 s cooldown',
        spell: { manaCost: 14, cooldown: 120, target: 'others', strikes: [{ type: 'heat', orType: 'cold', power: 0.9 }] } },
    ],
  },
  beastblooded: {
    name: 'Beastblooded', icon: '🐺', group: 'gifted',
    from: 'elemental_mage',
    purpose: 'Monster-lineage melee',
    strengths: 'Masters unarmed; front rank; fights on to 5% HP; force axis at Novice; scouting +7',
    weaknesses: 'Born only, and only to therian, draconic, demonic, bug or orc; medium armour at 50%; no words',
    req: { races: ['therian', 'draconic', 'demonic', 'bug', 'orc'] },
    train: { unarmed: 0.9, foraging: 0.7, medium_armor: 0.5, dark: 0.4 },
    mastery: ['unarmed'],
    skills: { tech: { ginga: 0, whirl_kick: 1, clinch_knee: 2, meia_lua: 3, german_suplex: 4 }, axes: { vitality: 1, force: 0 } },
    mind: M('burst', { technique: 1.25, swing: 1.15, spell: 0.5, heal: 0.9 }, 'wounded', 'front', 0.95),
    role: 'frontline',
    summonOnly: true,
    want: { profs: { unarmed: 4, foraging: 1, dark: 1 }, stats: { con: 2, str: 2 }, unarmed: 2 },
    scout: 7,
    rarity: 5,
  },
  sorcerer: {
    name: 'Sorcerer', icon: '✨', group: 'gifted',
    from: 'elemental_mage',
    purpose: 'Untaught arcana',
    strengths: 'Spell x1.45; burst at Novice; no lexicon needed',
    weaknesses: 'Born only; five words in total; line posture with no armour training',
    train: { arcana: 0.8, dark: 0.6, fire: 0.6, lightning: 0.5 },
    mastery: ['arcana'],
    skills: { words: { burst: 0, gloom: 1, arcane: 2, viciously: 3, but: 4 } },
    mind: M('burst', { technique: 0.5, swing: 0.6, spell: 1.45, heal: 0.9 }, 'spread', 'line', 0.7),
    role: 'caster',
    summonOnly: true,
    rarity: 4,
  },
  truespeaker: {
    name: 'Truespeaker', icon: '🗣️', group: 'gifted',
    from: 'elemental_mage',
    purpose: 'Naming magic',
    strengths: 'Spell x1.45; zero at Novice; every conjunction by Grandmaster',
    weaknesses: 'Born only; trains arcana and nothing else; technique and swing x0.4',
    train: { arcana: 1 },
    mastery: ['arcana'],
    skills: { words: { zero: 0, arcane: 1, then: 1, and: 2, but: 3, if: 3, or: 4 } },
    mind: M('stacking', { technique: 0.4, swing: 0.4, spell: 1.45, heal: 1.0 }, 'strongest', 'back', 0.5),
    role: 'caster',
    summonOnly: true,
    rarity: 3,
  },
  kineticist: {
    name: 'Kineticist', icon: '\ud83d\udca5', group: 'gifted',
    from: 'elemental_mage',
    purpose: 'Aggressive elemental and psionic damage',
    strengths: 'Magic damage x1.15, the highest; masters fire and psionics; force, mass and speed axes',
    weaknesses: 'Pool x0.85; arcana at 50%; heal x0.8',
    want: { profs: { fire: 2, lightning: 2, earth: 2, psionics: 3 }, stats: { int: 2, con: 2 } },
    train: { fire: 0.9, lightning: 0.9, earth: 0.7, psionics: 0.9, arcana: 0.5 },
    mastery: ['fire', 'psionics'],
    skills: { words: { fire: 0, burst: 1, spark: 1, stone: 2, crush: 3, intensely: 4 }, axes: { force: 0, mass: 1, speed: 2 } },
    mind: M('burst', { technique: 0.8, swing: 0.7, spell: 1.35, heal: 0.8 }, 'strongest', 'line', 0.7),
    role: 'caster',
    magicMult: 1.15,
    poolMult: 0.85,
  },
  chorokinetic: {
    name: 'Chorokinetic', icon: '\ud83c\udf00', group: 'gifted',
    from: 'elemental_mage',
    purpose: 'Space magic',
    strengths: 'Wormhole moves the party across the map; Gravity Well and Black Hole hit every enemy; masters psionics and arcana; scouting +9',
    weaknesses: 'Born only, 1 in 10,000; features cost 14 to 40 mana on 15 to 40 s cooldowns; no weapon or armour training',
    train: { psionics: 1, arcana: 0.8 },
    mastery: ['psionics', 'arcana'],
    skills: { axes: { space: 0, reach: 0, clairvoyance: 2, mass: 3 }, words: { fly: 0, expand: 2, zero: 4 } },
    mind: M('stacking', { technique: 0.5, swing: 0.5, spell: 1.4, heal: 1.0 }, 'spread', 'back', 0.55),
    role: 'caster',
    summonOnly: true, legendary: true, rarity: 1,
    scout: 9,
    features: [
      { id: 'wormhole', name: 'Wormhole', icon: '\ud83d\udd73\ufe0f', rank: 0,
        desc: 'On the map: moves the party to any tile somebody has seen. Used to land on a target with no escort within 3 tiles, to skip the walk out, or to leave a fight that is going badly. 2 charges per sortie, +1 at Expert, +1 at Grandmaster, 15 s apart; the last charge is reserved for leaving',
        field: { kind: 'wormhole', charges: 2, perRank: 0.5, cooldown: 15 } },
      { id: 'gravity_well', name: 'Gravity Well', icon: '\ud83c\udf0d', rank: 1,
        desc: '0.6x bludgeoning to every enemy; 90% Unfooted x2, Compressed x2. 20 mana, 15 s cooldown',
        spell: { manaCost: 20, cooldown: 150, target: 'others', strikes: [{ type: 'bludgeoning', power: 0.6, inflicts: [{ id: 'unfooted', intensity: 2, chance: 0.9 }, { id: 'psionic_compression', intensity: 2, chance: 1 }] }] } },
      { id: 'black_hole', name: 'Black Hole', icon: '\u26ab', rank: 3,
        desc: '2.2x arcane to every enemy, 40% penetration; 50% Dazed. 40 mana, 40 s cooldown',
        spell: { manaCost: 40, cooldown: 400, target: 'others', strikes: [{ type: 'arcane', power: 2.2, penetration: 0.4, inflicts: [{ id: 'dazed', intensity: 1, chance: 0.5 }] }] } },
    ],
  },
  chronokinetic: {
    name: 'Chronokinetic', icon: '\u23f3', group: 'gifted',
    from: 'elemental_mage',
    purpose: 'Time magic',
    strengths: 'Time Skip: +60% speed; Temporal Eject freezes one target; Temporal Clone: self-heal and +45% dodge; masters psionics and arcana; scouting +12',
    weaknesses: 'Born only, 1 in 10,000; features cost 12 to 35 mana on 12 to 40 s cooldowns; no weapon or armour training',
    train: { psionics: 1, arcana: 0.8 },
    mastery: ['psionics', 'arcana'],
    skills: { axes: { speed: 0, clairvoyance: 0, space: 2, grip: 3 }, words: { quickly: 0, slowly: 1, then: 3, if: 4 } },
    mind: M('efficiency', { technique: 0.7, swing: 0.7, spell: 1.4, heal: 1.1 }, 'caster', 'line', 0.6),
    role: 'caster',
    summonOnly: true, legendary: true, rarity: 1,
    scout: 12,
    features: [
      { id: 'time_skip', name: 'Time Skip', icon: '\u23ed\ufe0f', rank: 0,
        desc: '+60% speed on self for 6 s. 12 mana, 12 s cooldown',
        spell: { manaCost: 12, cooldown: 120, target: 'self', buff: { name: 'Time Skip', mods: [{ stat: 'speed', op: 'mult', value: 0.6 }], duration: 60 } } },
      { id: 'temporal_eject', name: 'Temporal Eject', icon: '\u23cf\ufe0f', rank: 1,
        desc: '0.3x arcane, cannot miss; target Frozen (-95% speed) until it takes damage. 18 mana, 20 s cooldown',
        spell: { manaCost: 18, cooldown: 200, target: 'one', sure: true, strikes: [{ type: 'arcane', power: 0.3, inflicts: [{ id: 'frozen', intensity: 1, chance: 1 }] }] } },
      { id: 'temporal_clone', name: 'Temporal Clone', icon: '\ud83d\udc65', rank: 3,
        desc: 'Self-heal 0.8x damage stat and +45% dodge for 8 s. 35 mana, 40 s cooldown',
        spell: { manaCost: 35, cooldown: 400, target: 'self', heal: 0.8, buff: { name: 'Temporal Clone', mods: [{ stat: 'dodge', op: 'add', value: 0.45 }], duration: 80 } } },
    ],
  },
};

for (const [id, def] of Object.entries(CLASSES)) {
  def.id = id;
  // one line for a tooltip, built out of the table's own columns so there is one source of truth
  def.desc = def.purpose;
}
const LIST = Object.values(CLASSES);
const byGroup = (g) => LIST.filter(c => c.group === g);

/** The seven trunks. These are the only classes anybody ever chooses. */
const BASES = LIST.filter(c => c.base);
const isBase = (cl) => !!(cl && cl.base);
/**
 * The seven-of-seven grid: what a trunk grows into by ordinary use. Excludes the summon-only,
 * which are born to rather than grown into.
 */
const branchesOf = (baseId) => LIST.filter(c => c.from === baseId && !c.summonOnly);



/** The trunk a class belongs to, whether it is the trunk or a branch. */
const trunkOf = (cl) => !cl ? null : cl.base ? cl : CLASSES[cl.from] || null;

// ---------- a character's class ----------
//
// A character holds ONE class to begin with and can FUSE more into it at tier-ups. What is
// stored is the primary plus a list of fused ones, each carrying its own xp: they are one
// person's training, so they all earn together, but a class taken up at the sixth tier-up
// starts behind and has to catch up.
// Classes that were renamed after saves already held them. Read once, on the way in.
const LEGACY_IDS = { spacializer: 'chorokinetic', temporizer: 'chronokinetic', killer: 'butcher' };
function ensure(c) {
  if (!c.class) return null;
  if (typeof c.class === 'string') c.class = { id: c.class, xp: 0, since: Date.now() };
  if (c.class.xp === undefined) c.class.xp = 0;
  if (LEGACY_IDS[c.class.id]) c.class.id = LEGACY_IDS[c.class.id];
  if (!CLASSES[c.class.id]) return (c.class = null);
  for (const f of (c.class.fused || [])) if (f && LEGACY_IDS[f.id]) f.id = LEGACY_IDS[f.id];
  c.class.fused = (c.class.fused || []).filter(f => f && CLASSES[f.id] && f.id !== c.class.id);
  for (const f of c.class.fused) if (f.xp === undefined) f.xp = 0;
  return c.class;
}

function rankIndexAt(xp) {
  let i = 0;
  for (let k = 0; k < RANKS.length; k++) if (xp >= RANKS[k].at) i = k;
  return i;
}
const rankAt = (xp) => RANKS[rankIndexAt(xp)];
/** "an Adept Butcher". Ranks are a short closed list, so the rule is just the first letter. */
const phrase = (rk, name) => `${/^[aeiou]/i.test(rk.label) ? 'an' : 'a'} ${rk.label} ${name}`;

/**
 * Everything this character has been trained as, primary first. One entry per class, each with
 * the rank its own xp has bought. This is what every accessor below reads: a fused character is
 * not a special case anywhere, it just has more than one entry.
 */
function held(c) {
  const r = ensure(c);
  if (!r) return [];
  const one = (id, xp, primary) => ({ def: CLASSES[id], id, xp, rankIndex: rankIndexAt(xp), rank: rankAt(xp), primary });
  return [one(r.id, r.xp, true), ...r.fused.map(f => one(f.id, f.xp, false))];
}

const def = (c) => { const r = ensure(c); return r ? CLASSES[r.id] : null; };
const defs = (c) => held(c).map(h => h.def);
const idOf = (c) => { const r = ensure(c); return r ? r.id : null; };
const has = (c, id) => held(c).some(h => h.id === id);

function rankIndex(c) { const r = ensure(c); return r ? rankIndexAt(r.xp) : -1; }
const rank = (c) => { const i = rankIndex(c); return i < 0 ? null : RANKS[i]; };
/** Progress toward the next rank, 0..1, and what it is. Null at grandmaster. */
function progress(c, id = null) {
  const h = held(c).find(x => (id ? x.id === id : x.primary));
  if (!h || h.rankIndex >= RANKS.length - 1) return null;
  const from = RANKS[h.rankIndex].at, to = RANKS[h.rankIndex + 1].at;
  return { next: RANKS[h.rankIndex + 1], frac: Math.max(0, Math.min(1, (h.xp - from) / (to - from))), need: to - h.xp };
}

// ---------- fusion ----------
//
// A tier-up is a whole character raised a star, and the count is PERSONAL: a 1-star that is kept
// alive and pushed all the way to 7 has been through six of them, while a 5-star pulled straight
// out of the gate has only two left in it and reaches neither slot. The asymmetry is deliberate.
// The reward for the long road is a fused character; the reward for a lucky pull is starting
// further along it.
const FUSE_AT = [3, 6];        // which tier-up opens a slot

const tierUps = (c) => c.tierUps || 0;
/** Slots earned by the tier-ups behind them. */
const fusionSlots = (c) => FUSE_AT.filter(n => tierUps(c) >= n).length;
const fusionsUsed = (c) => { const r = ensure(c); return r ? r.fused.length : 0; };
const fusionOpen = (c) => !!ensure(c) && fusionSlots(c) > fusionsUsed(c);
/** The next tier-up that would open a slot, or null when both are spent. */
const nextFusionAt = (c) => FUSE_AT.find(n => n > tierUps(c)) || null;

/**
 * Count a tier-up. Called once per star gained (game.js advanceCharacter), and it is the ONLY
 * thing that opens a fusion slot. Returns the slot if this one opened one.
 */
function tieredUp(c) {
  c.tierUps = tierUps(c) + 1;
  return FUSE_AT.includes(c.tierUps) && ensure(c) ? { slot: FUSE_AT.indexOf(c.tierUps) + 1, at: c.tierUps } : null;
}

/** What could be fused in right now: eligible, not already held, and not something you are born to. */
// Fusion adds a TRUNK: a second discipline taken up from scratch, which then grows on its own
// evidence like the first one did.
const fusable = (c) => fusionOpen(c) ? BASES.filter(cl => !has(c, cl.id) && eligible(c, cl.id).ok) : [];

/**
 * Fuse a class in. It arrives at Novice with its own xp track — the character is not suddenly a
 * master of something it took up this morning — and everything it knows stacks on top of what
 * they already were.
 */
function fuse(c, id) {
  const r = ensure(c);
  if (!r) return { ok: false, why: 'no class to fuse into' };
  if (!CLASSES[id]) return { ok: false, why: 'no such class' };
  if (!fusionOpen(c)) {
    const at = nextFusionAt(c);
    return { ok: false, why: at ? `no slot until the ${ordinal(at)} tier-up` : 'both fusions are spent' };
  }
  if (has(c, id)) return { ok: false, why: 'already trained in that' };
  if (CLASSES[id].summonOnly) return { ok: false, why: 'born to, never fused' };
  if (!CLASSES[id].base) return { ok: false, why: 'fuse a base discipline; it grows from there' };
  const check = eligible(c, id);
  if (!check.ok) return { ok: false, why: check.why };
  const kept = (c.classHistory || []).find(h => h.id === id);
  r.fused.push({ id, xp: kept ? kept.xp : 0, at: Date.now() });
  return { ok: true, def: CLASSES[id] };
}

/** Drop a fused class, freeing its slot. What it learned is filed away like any other. */
function unfuse(c, id) {
  const r = ensure(c);
  if (!r) return null;
  const i = r.fused.findIndex(f => f.id === id);
  if (i < 0) return null;
  const [gone] = r.fused.splice(i, 1);
  c.classHistory = (c.classHistory || []).filter(h => h.id !== gone.id);
  c.classHistory.push({ id: gone.id, xp: gone.xp, until: Date.now() });
  return gone;
}

const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - n % 10 !== 10) * (n % 10)] || 'th');

// ---------- admission ----------
const stageOf = (c, k) => (c.profs && c.profs[k]) ? c.profs[k].stage : -1;
const need = (name) => P().STAGE[name];

/** Can this character take this class, and if not, the first reason why not. */
function eligible(c, id, { born = false, grown = false } = {}) {
  const cl = CLASSES[id];
  if (!cl) return { ok: false, why: 'no such class' };
  // The rare ones are not a curriculum. Nobody teaches you to be Beastblooded; you either came
  // through the gate that way or you did not, and no amount of drilling changes it.
  if (cl.summonOnly && !born && !has(c, id)) return { ok: false, why: 'born to it, never taught' };
  // Nor is a specialisation. You take up a trunk and the work names you: see specialise().
  if (!cl.base && !cl.summonOnly && !grown && !has(c, id)) {
    return { ok: false, why: `grown into, not taught — train ${(CLASSES[cl.from] || {}).name || 'the base'}` };
  }
  const req = cl.req || {};
  if (req.races && !req.races.includes(c.race)) return { ok: false, why: `${req.races.join(', ')} only` };
  // A BIRTHRIGHT ignores the rest of the entry requirements, and has to. Those requirements say
  // what a training hall will accept, and a 1-star cannot meet them — its whole stat budget is
  // 40 points and its aptitudes cannot even ROLL as high as D. Gating a birthright behind them
  // would mean only strong pulls were ever born to anything, when a 1-star Sorcerer nobody
  // expected is the single most interesting thing the gate can hand you. Blood (`races`) is the
  // one gate that survives, because that one is not about training at all.
  if (born) return { ok: true, why: '' };
  for (const [k, v] of Object.entries(req.stats || {})) {
    if (c.stats.base[k] < v) return { ok: false, why: `needs ${k.toUpperCase()} ${v}` };
  }
  for (const [k, v] of Object.entries(req.profs || {})) {
    if (stageOf(c, k) < need(v)) return { ok: false, why: `needs ${v} ${label(k)}` };
  }
  if (req.oneOf) {
    const hit = Object.entries(req.oneOf).some(([k, v]) => stageOf(c, k) >= need(v));
    if (!hit) return { ok: false, why: 'needs ' + Object.entries(req.oneOf).map(([k, v]) => `${v} ${label(k)}`).join(' or ') };
  }
  return { ok: true, why: '' };
}
const label = (k) => { const d = P().PROFICIENCIES[k]; return d ? d.label.toLowerCase() : k; };

/** What can actually be taken up: the seven trunks, filtered by what this character qualifies for. */
const available = (c) => BASES.filter(cl => eligible(c, cl.id).ok);
/** The rare ones, and whether this character could have been born to each. */
const birthrights = (c) => LIST.filter(cl => cl.summonOnly && eligible(c, cl.id, { born: true }).ok);

// ---------- trades ----------
//
// The other half of a roster is the half that never goes through the gate, and a character who
// has stood at an anvil for an hour should be something for it. A TRADE is a second, parallel
// track to the combat class: it is EARNED rather than chosen — work one job long enough and it
// arrives — it never touches how anyone fights, and holding one costs a fighter nothing.
//
// Rank comes from the work done, not from time served. A trade does not accumulate xp. It is
// proven, and the proof is a standard held across a run rather than one lucky result:
//
//   craft trades   n items at quality q or better within the last w crafts. A smith who turns
//                  out one Masterwork and nine Crude has proved nothing.
//   gather trades  n units delivered within the last w ticks. There is no quality in a sack of
//                  ore, so the standard is rate — and rate scales itself, because a weak farmer
//                  cannot fill the window at all while a strong one clears it without trying.
//
// Passing a proof clears the window, so each rank is earned from scratch rather than off the
// tail of the last one.
const TRADE_EARN_TICKS = 120;      // ticks on one job before it becomes what you are (~20 min)

const TRADE_RANKS = [
  { id: 'hand',        label: 'Hand',        train: 0.15, cap: null, craft: null,                                gather: null },
  { id: 'journeyman',  label: 'Journeyman',  train: 0.30, cap: null, craft: { need: 5,  quality: 1, window: 8 },  gather: { need: 20,  window: 30 } },
  { id: 'craftsman',   label: 'Craftsman',   train: 0.45, cap: null, craft: { need: 6,  quality: 2, window: 10 }, gather: { need: 45,  window: 30 } },
  { id: 'master',      label: 'Master',      train: 0.60, cap: 'S-', craft: { need: 8,  quality: 3, window: 12 }, gather: { need: 90,  window: 30 } },
  { id: 'grandmaster', label: 'Grandmaster', train: 0.75, cap: 'S',  craft: { need: 10, quality: 4, window: 14 }, gather: { need: 180, window: 30 } },
];
const TRADE_WINDOW = Math.max(...TRADE_RANKS.map(r => Math.max((r.craft && r.craft.window) || 0, (r.gather && r.gather.window) || 0)));

const TRADES = {
  blacksmith: {
    name: 'Blacksmith', icon: '\u2692\ufe0f', job: 'smithing', kind: 'craft', aptitude: 'smithing',
    desc: 'Smithing. Ranks on N items at or above a quality bar within a window of crafts.',
    train: { smithing: 1, mining: 0.4, maintenance: 0.3 }, mastery: ['smithing'],
  },
  apothecary: {
    name: 'Apothecary', icon: '\u2697\ufe0f', job: 'alchemy', kind: 'craft', aptitude: 'alchemy',
    desc: 'Alchemy. Ranks on N potions at or above a quality bar within a window of crafts.',
    train: { alchemy: 1, foraging: 0.4, cooking: 0.3 }, mastery: ['alchemy'],
  },
  cook: {
    name: 'Cook', icon: '\ud83c\udf72', job: 'cooking', kind: 'craft', aptitude: 'cooking',
    desc: 'Cooking. Ranks on N meals at or above a quality bar within a window of crafts.',
    train: { cooking: 1, farming: 0.4, alchemy: 0.3 }, mastery: ['cooking'],
  },
  cultivator: {
    name: 'Cultivator', icon: '\ud83c\udf3e', job: 'farming', kind: 'gather', aptitude: 'farming',
    desc: 'Farming. Ranks on N crops delivered within a window of shifts.',
    train: { farming: 1, foraging: 0.4, cooking: 0.3 }, mastery: ['farming'],
  },
  prospector: {
    name: 'Prospector', icon: '\u26cf\ufe0f', job: 'mining', kind: 'gather', aptitude: 'mining',
    desc: 'Mining. Ranks on N ore delivered within a window of shifts.',
    train: { mining: 1, smithing: 0.4, maintenance: 0.3 }, mastery: ['mining'],
  },
  herbalist: {
    name: 'Herbalist', icon: '\ud83c\udf3f', job: 'foraging', kind: 'gather', aptitude: 'foraging',
    desc: 'Foraging. Ranks on N herbs delivered within a window of shifts; adds scouting.',
    train: { foraging: 1, alchemy: 0.4, farming: 0.3 }, mastery: ['foraging'], scout: 6,
  },
  steward: {
    name: 'Steward', icon: '\ud83d\udd27', job: 'maintenance', kind: 'gather', aptitude: 'maintenance',
    desc: 'Maintenance. Ranks on N gems returned within a window of shifts.',
    train: { maintenance: 1, smithing: 0.3, cooking: 0.3 }, mastery: ['maintenance'],
  },
};
for (const [id, t] of Object.entries(TRADES)) t.id = id;
const TRADE_LIST = Object.values(TRADES);
const tradeForJob = (job) => TRADE_LIST.find(t => t.job === job) || null;

function ensureTrade(c) {
  if (!c.trade) return null;
  if (typeof c.trade === 'string') c.trade = { id: c.trade, rank: 0, recent: [] };
  if (!TRADES[c.trade.id]) return (c.trade = null);
  if (c.trade.rank === undefined) c.trade.rank = 0;
  if (!Array.isArray(c.trade.recent)) c.trade.recent = [];
  return c.trade;
}
const tradeDef = (c) => { const t = ensureTrade(c); return t ? TRADES[t.id] : null; };
const tradeRank = (c) => { const t = ensureTrade(c); return t ? TRADE_RANKS[Math.min(t.rank, TRADE_RANKS.length - 1)] : null; };
const tradeTitle = (c) => { const d = tradeDef(c); return d ? `${tradeRank(c).label} ${d.name}` : null; };

/** The proof standing between this character and the next rank of its trade, or null at the top. */
function tradeProof(c) {
  const t = ensureTrade(c), d = tradeDef(c);
  if (!t || !d || t.rank >= TRADE_RANKS.length - 1) return null;
  return TRADE_RANKS[t.rank + 1][d.kind] || null;
}

/** How far along that proof they are, on the work behind them right now. */
function tradeProgress(c) {
  const t = ensureTrade(c), d = tradeDef(c), proof = tradeProof(c);
  if (!proof) return null;
  const win = t.recent.slice(-proof.window);
  const have = d.kind === 'craft'
    ? win.filter(q => q >= proof.quality).length
    : win.reduce((a, v) => a + v, 0);
  return { kind: d.kind, have, need: proof.need, window: proof.window, seen: win.length, quality: proof.quality, next: TRADE_RANKS[t.rank + 1] };
}

/**
 * Test the proof and rank up if it is met. Passing clears the window: the next rank starts clean.
 *
 * The WHOLE window has to have been observed, not just enough of it. "20 delivered inside 30
 * ticks" means across thirty ticks of work — without that, a strong farmer producing thirteen a
 * tick clears every rank in eight ticks and the ladder is over before anyone sees it. With it,
 * each rank costs at least a window of real work whoever is standing there.
 */
function checkTrade(c) {
  const t = ensureTrade(c);
  const p = tradeProgress(c);
  if (!t || !p || p.seen < p.window || p.have < p.need) return null;
  t.rank++;
  t.recent = [];
  return TRADE_RANKS[t.rank];
}

/**
 * One tick of work. `value` is what the tick produced (a gather trade counts it; a craft trade
 * ignores it and waits for the craft itself). Grants the trade once the hours are in, and this
 * is the only place a trade is ever handed out.
 */
function worked(c, job, value = 0) {
  if (!job || !tradeForJob(job)) return null;
  c.worked = c.worked || {};
  c.worked[job] = (c.worked[job] || 0) + 1;
  const t = ensureTrade(c);
  if (!t) {
    if (c.worked[job] < TRADE_EARN_TICKS) return null;
    const d = tradeForJob(job);
    c.trade = { id: d.id, rank: 0, recent: [], since: Date.now() };
    return { earned: d };
  }
  const d = TRADES[t.id];
  if (d.job !== job || d.kind !== 'gather') return null;
  t.recent.push(value);
  if (t.recent.length > TRADE_WINDOW) t.recent = t.recent.slice(-TRADE_WINDOW);
  const up = checkTrade(c);
  return up ? { ranked: up, def: d } : null;
}

/** One finished item, at the quality it came out at. Only a craft trade is watching. */
function crafted(c, job, quality) {
  const t = ensureTrade(c);
  if (!t) return null;
  const d = TRADES[t.id];
  if (d.job !== job || d.kind !== 'craft') return null;
  t.recent.push(quality);
  if (t.recent.length > TRADE_WINDOW) t.recent = t.recent.slice(-TRADE_WINDOW);
  const up = checkTrade(c);
  return up ? { ranked: up, def: d } : null;
}

/** Put the trade down, freeing the character to earn a different one. */
function dropTrade(c) {
  const t = ensureTrade(c);
  if (!t) return null;
  c.trade = null;
  c.worked = c.worked || {};
  c.worked[TRADES[t.id].job] = 0;
  return t;
}

function describeTrade(c) {
  const d = tradeDef(c);
  if (!d) {
    // what they are closest to earning, so the panel can say why nothing is here yet
    const worked_ = c.worked || {};
    const best = Object.entries(worked_).filter(([j]) => tradeForJob(j)).sort((a, b) => b[1] - a[1])[0];
    return best ? { pending: tradeForJob(best[0]), ticks: best[1], need: TRADE_EARN_TICKS } : null;
  }
  const r = tradeRank(c);
  return {
    id: d.id, name: d.name, icon: d.icon, desc: d.desc, kind: d.kind, job: d.job,
    rank: r, rankIndex: ensureTrade(c).rank, top: ensureTrade(c).rank >= TRADE_RANKS.length - 1,
    mastery: d.mastery || [], capStage: r.cap,
    training: Object.entries(d.train).map(([k, w]) => ({ key: k, label: label(k), bonus: w * r.train })).sort((a, b) => b.bonus - a.bonus),
    progress: tradeProgress(c),
  };
}

// ---------- birthrights ----------
//
// A few classes are not a curriculum, and the only way to have one is to come through the gate
// with it. The chance is small and barely moves with stars, which is deliberate: a 1-star born a
// Sorcerer is the pull worth keeping, and under permanent death keeping it is the whole game.
const BIRTHRIGHT_BASE = 0.06;
const BIRTHRIGHT_PER_STAR = 0.015;
// The legendary two roll on their own, first, at odds that most players never see land. They
// are not gamebreaking — the features are strong and dear — but they are a thing you tell people
// about, and a thing you tell people about cannot turn up every hundred pulls.
const LEGENDARY_CHANCE = 1 / 10000;

/** The odds this character was born to something, before anything is rolled. */
const birthrightChance = (stars) => BIRTHRIGHT_BASE + BIRTHRIGHT_PER_STAR * (Math.max(1, stars) - 1);

/**
 * Roll a character's birthright at summon. Assigns it and returns the class, or null for the
 * ordinary majority. `rand` is passed in so the caller decides whether this goes through the
 * cryptographic source (game.js) or a seeded one (tests).
 */
function rollBirthright(c, rand = Math.random) {
  if (ensure(c)) return null;                                   // already something
  const all = birthrights(c);
  const legends = all.filter(cl => cl.legendary);
  if (legends.length && rand() < LEGENDARY_CHANCE) {
    const cl = legends[Math.floor(rand() * legends.length)];
    assign(c, cl.id, { born: true });
    return cl;
  }
  const pool = all.filter(cl => !cl.legendary);
  if (!pool.length) return null;
  if (rand() >= birthrightChance(c.stats.stars)) return null;
  const total = pool.reduce((a, cl) => a + (cl.rarity || 1), 0);
  let x = rand() * total;
  for (const cl of pool) {
    x -= (cl.rarity || 1);
    if (x < 0) { assign(c, cl.id, { born: true }); return cl; }
  }
  return null;
}

/**
 * How often the gate hands somebody this class, and what to call that.
 *
 * `rarity` on a class is its DRAW WEIGHT inside the birthright pool, not a tier — psion at 8 is
 * the one you see, truespeaker at 3 is the one you do not — so the label is computed from the
 * weight rather than stored beside it, and stays true when a weight is edited. Only two names
 * exist because only two facts do: a class is either born to (`summonOnly`) or it is not, and a
 * born class is either `legendary` or it is not. Everything finer is the odds themselves, which
 * are quoted rather than bucketed.
 *
 * Returns null for the classes anybody can be taught — there is nothing rare about those.
 */
function rarity(id, stars = 1) {
  const cl = CLASSES[id];
  if (!cl || !cl.summonOnly) return null;
  const pool = LIST.filter(c => c.summonOnly && !c.legendary);
  const legends = LIST.filter(c => c.summonOnly && c.legendary);
  const total = pool.reduce((a, c) => a + (c.rarity || 1), 0);
  // The legendary two roll first and on their own, so they do not pay the birthright gate.
  const odds = cl.legendary
    ? LEGENDARY_CHANCE / Math.max(1, legends.length)
    : (1 - LEGENDARY_CHANCE) * birthrightChance(stars) * (cl.rarity || 1) / total;
  return {
    id, legendary: !!cl.legendary, weight: cl.rarity || 1, odds,
    tier: cl.legendary ? 'legendary' : 'birthright',
    label: cl.legendary ? 'legendary' : 'birthright',
    // A race gate narrows the pool for anyone who clears it, so the quoted figure is the pool
    // rate: what a pull is worth before knowing who turned up.
    gated: !!(cl.req && cl.req.races),
    text: `about 1 in ${Math.round(1 / odds).toLocaleString()} summons`,
  };
}
/** The rarest thing this character holds, or null if everything about them was taught. */
function rarestOf(c) {
  const rs = held(c).map(h => rarity(h.id, c.stats ? c.stats.stars : 1)).filter(Boolean);
  return rs.length ? rs.reduce((a, r) => r.odds < a.odds ? r : a) : null;
}

/**
 * What this character should be, on what it already has. Scores every class it qualifies for by
 * how much of its training weight lands on aptitudes the character is already good at, plus the
 * stats the class asks for. Advice, not a decision: the player picks.
 */
function advise(c, n = 3) {
  const p = P();
  const apt = (k) => (c.profs && c.profs[k]) ? p.share(c.profs[k]) : 0;
  const scored = available(c).map(cl => {
    let weighted = 0, total = 0;
    for (const [k, w] of Object.entries(cl.train)) { weighted += apt(k) * w; total += w; }
    const fit = total ? weighted / total : 0;
    const stats = Object.entries((cl.req || {}).stats || {});
    const head = stats.length ? stats.reduce((a, [k, v]) => a + Math.min(1.5, c.stats.base[k] / v), 0) / stats.length : 1;
    return { cl, score: fit * 0.7 + (head - 1) * 0.3 };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, n);
}

/**
 * Take a class. Xp from a class held before is remembered and restored, so retraining back into
 * something is not starting over — the body remembers the drill even if it spent a year elsewhere.
 */
function assign(c, id, { force = false, born = false, grown = false } = {}) {
  const check = eligible(c, id, { born, grown });
  if (!check.ok && !force) return { ok: false, why: check.why };
  const prior = unassign(c, { keepFused: true });
  const kept = (c.classHistory || []).find(h => h.id === id);
  c.class = { id, xp: kept ? kept.xp : 0, since: Date.now(), fused: (prior && prior.fused) || [] };
  ensure(c);
  return { ok: true, from: prior, rank: rank(c) };
}

/**
 * Put the primary class down. What it learned is filed away against the day it is picked back
 * up. Fused classes are a tier-up's worth of work and are not thrown away with it — retraining
 * changes what somebody mainly is, not everything they have ever been.
 */
function unassign(c, { keepFused = false } = {}) {
  const r = ensure(c);
  if (!r) return null;
  c.classHistory = (c.classHistory || []).filter(h => h.id !== r.id);
  c.classHistory.push({ id: r.id, xp: r.xp, until: Date.now() });
  const was = { ...r };
  if (!keepFused) for (const f of r.fused.slice()) unfuse(c, f.id);
  c.class = null;
  return was;
}

/**
 * Practice. Everything they are trained as advances together — it is one body doing the work —
 * so a class fused in late gains at the same rate but from further back. Returns the ranks
 * crossed, if any, so somebody can say them out loud.
 */
function earn(c, amount) {
  const r = ensure(c);
  if (!r || !(amount > 0)) return null;
  const crossed = [];
  const bump = (holder, id) => {
    const before = rankIndexAt(holder.xp);
    holder.xp += amount;
    const after = rankIndexAt(holder.xp);
    if (after > before) crossed.push({ rank: RANKS[after], def: CLASSES[id] });
  };
  bump(r, r.id);
  for (const f of r.fused) bump(f, f.id);
  // A rank is also when the work gets to say what they are. Only the primary grows for now —
  // a fused trunk is a second discipline and keeps its own counsel until it has been ranked too.
  const grew = crossed.length ? specialise(c) : null;
  if (grew) return { rank: rankAt(r.xp), def: grew.def, grew };
  return crossed.length ? crossed[0] : null;      // the primary's crossing leads
}
const trained = (c, ticks = 1) => earn(c, XP.trainTick * ticks);
const fought = (c, encounters = 1) => earn(c, XP.encounter * encounters);
const returned = (c, { won = true } = {}) => earn(c, XP.mission * (won ? 1 : 0.5));

// ---------- growing into a specialisation ----------
//
// Nobody picks a specialisation. You take up a trunk, you go and do things, and at some point the
// work has said what you are. `fitness` reads that work — aptitudes trained, the weapon actually
// in the hand, muscle memory in the technique ledger, the stats the body ended up with, how well
// they read ground, how they are to stand beside — and scores every branch of their trunk against
// it. The best one, if it clears BASE_FIT, is who they become.
//
// BASE_FIT is the floor, and it exists so that staying a Fighter is a real outcome rather than a
// failure to specialise. An unremarkable generalist is a generalist; a branch has to actually be
// evidenced to take them. Until one is, the check runs again at every rank, so a character can
// drift toward a specialisation for an hour and then arrive at it.
const SPECIALISE_AT = 1;      // rank index (Adept) — the first rank a trunk can name you at
const BASE_FIT = 0.38;        // what a branch has to beat to be more true than the trunk

/** 0..1, how much this character's history looks like this class's `want`. */
function fitness(c, def) {
  const w = def.want;
  if (!w) return 0;
  const p = P();
  const apt = (k) => (c.profs && c.profs[k]) ? p.share(c.profs[k], { clamp: true }) : 0;
  let score = 0, total = 0;
  const add = (weight, value) => { score += weight * Math.max(0, Math.min(1, value)); total += weight; };

  // Signals are measured from ORDINARY, not from zero. A stat of 10 is what everybody has and is
  // evidence of nothing; without this an average character scores half marks on every stat-based
  // branch and gets named Commander for having turned up.
  const above = (v, floor, ceil) => (v - floor) / (ceil - floor);
  for (const [k, v] of Object.entries(w.profs || {})) add(v, apt(k));
  for (const [k, v] of Object.entries(w.stats || {})) add(v, above(c.stats.base[k] || 0, 10, 24));

  // what is actually in their hands, or what they would reach for if nothing is (affinity.js)
  if (w.carries) {
    const eq = c.equipment || {};
    const held_ = [eq.weapon && eq.weapon.type, eq.offhand && eq.offhand.type, eq.body && eq.body.type].filter(Boolean);
    const liked = c.affinity ? Object.values(c.affinity.innate || {}) : [];
    const hit = w.carries.some(t => held_.includes(t)) ? 1 : w.carries.some(t => liked.includes(t)) ? 0.5 : 0;
    add(2, hit);
  }
  // carrying nothing is itself evidence, for the classes that are defined by fighting unarmed
  if (w.unarmed) add(w.unarmed, (c.equipment && c.equipment.weapon) ? 0 : 1);

  // muscle memory: the ledger of what they have actually thrown, not what they could
  if (w.tech) {
    const led = c.techniques || {};
    const reps = w.tech.reduce((a, id) => a + ((led[id] && led[id].executions) || 0), 0);
    add(2, Math.min(1, reps / 120));
  }
  // ONE weapon rather than several: how far their best weapon aptitude is clear of the next
  if (w.focus) {
    const WEAPONS = ['sword', 'axe', 'spear', 'bow', 'dagger', 'staff', 'unarmed'];
    const lv = WEAPONS.map(apt).sort((a, b) => b - a);
    add(w.focus, lv[0] <= 0 ? 0 : (lv[0] - lv[1]) / Math.max(0.2, lv[0]));
  }
  if (w.scout) { const ai = AIx(); add(w.scout, ai ? above(ai.scouting(c), 25, 75) : 0); }
  if (w.social) { const cr = CR(); add(w.social, cr ? above(cr.teamwork(c), 8, 24) : 0); }
  if (w.trade) add(w.trade, tradeDef(c) ? 1 : 0);

  return total ? score / total : 0;
}

/** Every branch of their trunk, best fit first. What the panel shows so the player sees it coming. */
function leanings(c, n = 3) {
  const cl = def(c);
  const trunk = trunkOf(cl);
  if (!trunk) return [];
  return branchesOf(trunk.id)
    .map(b => ({ def: b, fit: fitness(c, b) }))
    .sort((a, b) => b.fit - a.fit)
    .slice(0, n);
}

/**
 * Let the work name them. Called after every rank crossing while they are still a trunk; returns
 * what they became, or null if they are still most honestly a generalist.
 */
function specialise(c) {
  const cl = def(c);
  if (!cl || !cl.base) return null;
  if (rankIndex(c) < SPECIALISE_AT) return null;
  const best = leanings(c, 1)[0];
  if (!best || best.fit < BASE_FIT) return null;
  const r = ensure(c);
  r.grewFrom = r.id;
  r.id = best.def.id;
  r.grewAt = Date.now();
  return { def: best.def, from: cl, fit: best.fit };
}


// ---------- explicit class features ----------
//
// Words and axes are SYSTEMS: a character composes from them and the composition is graded by
// its mind. A feature is not composed. It is the class's own — the thing the class is FOR,
// written out in full — and it arrives at a rank whether or not the character has the wit to
// have built it. Mechanically it is a finished spell spec, which is why the fight needs no new
// code to run one: it goes into the loadout beside the grimoire and combat.js values and casts it
// exactly as it would a sentence, deducting mana or focus by its school.
const FEATURE_KEY = 'feature:';

/** What this character can do right now by virtue of what it is: every held class, rank-gated. */
function featureList(c) {
  const out = [];
  for (const h of held(c)) {
    for (const f of (h.def.features || [])) {
      if ((f.rank || 0) > h.rankIndex) continue;
      if (out.some(x => x.id === f.id)) continue;
      out.push({ ...f, from: h.def });
    }
  }
  return out;
}

/** The same, as specs the fight can cast. Field features (below) are not the fight's business. */
function featuresOf(c) {
  return featureList(c).filter(f => f.spell).map(f => ({
    key: FEATURE_KEY + f.id, name: f.name, icon: f.icon, feature: true, desc: f.desc, from: f.from.name,
    school: f.spell.school, manaCost: f.spell.manaCost || 0, focusCost: f.spell.focusCost || 0,
    cooldown: f.spell.cooldown, target: f.spell.target || 'one', sure: !!f.spell.sure,
    strikes: f.spell.strikes || [], heal: f.spell.heal || 0, healsEnemy: false, splash: f.spell.splash || 0,
    grants: f.spell.grants, buff: f.spell.buff, afflicts: f.spell.afflicts,
  }));
}

/**
 * The other kind of feature. A combat feature is a spell with the class's name on it; a FIELD
 * feature changes the map — where the party stands, what the other side thinks of them — and
 * field.js runs it. This hands the field what to carry: every rank-gated field feature, with
 * the charges its rank has earned and no more, because a Novice with a Grandmaster's wormholes
 * is a Novice who never needs to become one. `ready` is the in-game second it can next be used.
 */
function fieldKit(c) {
  const out = [];
  for (const h of held(c)) {
    for (const f of (h.def.features || [])) {
      if (!f.field || (f.rank || 0) > h.rankIndex || out.some(x => x.id === f.id)) continue;
      const fd = f.field;
      const extra = fd.perRank ? Math.floor(h.rankIndex * fd.perRank) : 0;
      out.push({ ...fd, id: f.id, name: f.name, icon: f.icon, charges: fd.charges === undefined ? undefined : fd.charges + extra, ready: 0 });
    }
  }
  return out;
}

// ---------- the training layer ----------
/**
 * The class's contribution to how fast an aptitude trains: the third term on top of affinity.
 *
 * A fused character counts its best class in full and half of every other. Two classes that both
 * drill the sword therefore beat either alone without doubling it, and fusing something that
 * covers different ground is worth more than fusing a near-copy — which is the choice worth
 * having at a tier-up.
 */
const FUSED_SHARE = 0.5;
function trainBonus(c, aptitude) {
  const bonuses = held(c).map(h => (h.def.train[aptitude] || 0) * h.rank.train);
  // a trade is a third source and stacks the same way: best in full, the rest at half
  const td = tradeDef(c);
  if (td) bonuses.push((td.train[aptitude] || 0) * tradeRank(c).train);
  const live = bonuses.filter(v => v > 0).sort((a, b) => b - a);
  if (!live.length) return 0;
  return live[0] + FUSED_SHARE * live.slice(1).reduce((a, v) => a + v, 0);
}

/** Growth multiplier including the class. affinity.js supplies `base` (1 + preference + compat). */
const trainMult = (c, aptitude, base = 1) => base + trainBonus(c, aptitude);

/**
 * Where training stops for this aptitude. Ordinary training tops out at A+ (proficiency.js);
 * a class lifts its own mastery aptitudes into the S tier, and nothing else does.
 */
/**
 * Which aptitudes a class lifts into the S tier. Usually a fixed list; a Weaponmaster's is
 * 'carried', meaning whichever weapon is actually in their hand — which is exactly why being
 * disarmed is on their weakness list.
 */
function masteryList(c, def) {
  if (def.mastery !== 'carried') return def.mastery || [];
  const w = c.equipment && c.equipment.weapon;
  return [w ? w.type : 'unarmed'];
}

function capStage(c, aptitude, base = null) {
  const p = P();
  let cap = base === null ? p.MAX_ADVANCE_STAGE : base;
  for (const h of held(c)) {
    if (!masteryList(c, h.def).includes(aptitude) || !h.rank.cap) continue;
    cap = Math.max(cap, p.STAGE[h.rank.cap]);
  }
  // a Master Blacksmith takes smithing into the S tier the same way a Master Fighter takes sword
  const td = tradeDef(c), tr = tradeRank(c);
  if (td && tr && tr.cap && (td.mastery || []).includes(aptitude)) cap = Math.max(cap, p.STAGE[tr.cap]);
  return cap;
}
/**
 * Extra prepared-spell slots on top of what arcana level buys (spellcraft.js preparedCap). The
 * Arcanist's whole identity: more spells known and ready than anybody.
 */
const preparedBonus = (c) => held(c).reduce((n, h) => n + (h.def.prepared || 0), 0);
/**
 * A multiplier on the caster pool they walk into a fight with (combat.js). The other half of the
 * Arcanist: all that breadth is paid for in how many times any of it can be cast. The Utilitarian
 * Mage runs it the other way — a bigger pool, because most of what it casts is not an attack.
 */
const poolMult = (c) => held(c).reduce((n, h) => n * (h.def.poolMult === undefined ? 1 : h.def.poolMult), 1);
/**
 * A multiplier on magic damage (combat.js). This is what "less damage than other magicians" has
 * to mean if it is going to mean anything: not a smaller appetite for casting, an actually
 * smaller number when the spell lands.
 */
const magicMult = (c) => held(c).reduce((n, h) => n * (h.def.magicMult === undefined ? 1 : h.def.magicMult), 1);

const masters = (c, aptitude) => held(c).some(h => masteryList(c, h.def).includes(aptitude))
  || !!(tradeDef(c) && (tradeDef(c).mastery || []).includes(aptitude));
/** Every aptitude any of their classes can push into the S tier. */
const masteries = (c) => [...new Set([...held(c).flatMap(h => masteryList(c, h.def)), ...((tradeDef(c) || {}).mastery || [])])];

// ---------- inherent skills ----------
// Granted at or below the character's current rank. Skills the class hands over ignore the
// aptitude gate that normally guards them; they do not ignore the weapon in the hand.
function grantsOf(c, kind) {
  const out = [];
  for (const h of held(c)) {
    const table = h.def.skills && h.def.skills[kind];
    if (!table) continue;
    for (const [id, at] of Object.entries(table)) if (at <= h.rankIndex && !out.includes(id)) out.push(id);
  }
  return out;
}
const techniquesOf = (c) => grantsOf(c, 'tech');
const wordsOf = (c) => grantsOf(c, 'words');
const axesOf = (c) => grantsOf(c, 'axes');
const teaches = (c, id) => techniquesOf(c).includes(id);

/** Everything the character can say: what it was born knowing plus what the class taught it. */
function lexiconOf(c) {
  const own = c.lexicon || [];
  const add = wordsOf(c).filter(w => !own.includes(w));
  return add.length ? [...own, ...add] : own;
}

/** Psionic axes open earliest: class axes are pulled to the front of the order it rolled. */
function psiOrderOf(c) {
  const own = c.psiOrder || [];
  const add = axesOf(c);
  if (!add.length) return own;
  return [...add.filter(a => own.includes(a)), ...own.filter(a => !add.includes(a))];
}
/** Axes the class opens outright, whatever the psionics level. */
const axesOpenedBy = (c) => axesOf(c);

// ---------- the mind ----------
const mindOf = (c) => { const cl = def(c); return cl ? cl.mind : null; };

/**
 * The doctrine a character walks in with. `own` is what ai.js worked out for itself.
 *
 * A mind that cannot read a fight keeps the class's standing orders — that is what the class is
 * FOR. A mind that can (brilliant and up, the tiers with a refinement pass) overrides them when
 * it has actually looked at the enemy. In between, the class wins ties: the character's own idea
 * has to be about something the class is not already good at before it is worth the change.
 */
function doctrine(c, own, aiTier = null) {
  const m = mindOf(c);
  if (!m || !m.doctrine) return own;
  if (!own) return m.doctrine;
  if (aiTier && aiTier.refine > 0) return own;      // it looked; let it decide
  return m.doctrine;
}

/**
 * Multiplier on how much a character wants to take this kind of action. combat.js reads this.
 *
 * Fusion takes the BEST of what each class leans toward rather than the average: a Fighter fused
 * with an Elemental Mage reaches for the technique like a Fighter and for the word like a mage,
 * which is the whole fantasy of the thing. Doctrine, stance, quarry and nerve stay the primary's
 * — those are who somebody is, and averaging them would only produce a character with no plan.
 */
function actMult(c, kind) {
  const all = held(c).map(h => (h.def.mind.act || {})[kind]).filter(v => v !== undefined);
  return all.length ? Math.max(...all) : 1;
}

const targetPriority = (c) => { const m = mindOf(c); return m ? m.target : null; };
const posture = (c) => { const m = mindOf(c); return m ? m.posture : 'line'; };
/** How much attention this character draws from the other side. Front ranks get hit. */
const drawWeight = (c) => POSTURES[posture(c)] || 1;
/** How hurt the character keeps fighting, 0..1. The field reads this to decide who pulls back. */
const nerve = (c) => { const m = mindOf(c); return m ? m.nerve : 0.7; };

// ---------- what the rest of the town reads off a class ----------
/** What the quartermaster should treat this character as. Null when it has no class to go on. */
const roleOf = (c) => { const cl = def(c); return (cl && cl.role) || null; };
const bestOf = (c, key, base) => held(c).reduce((n, h) => Math.max(n, h.def[key] === undefined ? base : h.def[key]), base);
const scoutBonus = (c) => Math.max(bestOf(c, 'scout', 0), (tradeDef(c) || {}).scout || 0);
/** Fusion cannot make somebody easier to stand next to than their worst training left them. */
const socialMult = (c) => held(c).reduce((n, h) => Math.min(n, h.def.social === undefined ? 1 : h.def.social), 1);
const lootMult = (c) => bestOf(c, 'loot', 1);
/** A party's loot multiplier: the best thief in it, not the sum of everybody's greed. */
const partyLoot = (party) => party.reduce((n, c) => Math.max(n, lootMult(c)), 1);

// ---------- display ----------
function describe(c) {
  const cl = def(c);
  if (!cl) return null;
  const r = rank(c), i = rankIndex(c), all = held(c);
  const trained = [...new Set(all.flatMap(h => Object.keys(h.def.train)))];
  return {
    id: cl.id, name: cl.name, icon: cl.icon, desc: cl.desc, summonOnly: !!cl.summonOnly,
    purpose: cl.purpose, strengths: cl.strengths, weaknesses: cl.weaknesses,
    base: !!cl.base, trunk: trunkOf(cl), grewFrom: ensure(c).grewFrom ? CLASSES[ensure(c).grewFrom] : null,
    leanings: cl.base ? leanings(c) : [], specialiseAt: RANKS[SPECIALISE_AT],
    group: GROUPS[cl.group], rank: r, rankIndex: i, xp: ensure(c).xp, progress: progress(c),
    held: all.map(h => ({ id: h.id, name: h.def.name, icon: h.def.icon, desc: h.def.desc, rank: h.rank, primary: h.primary, progress: progress(c, h.id) })),
    fused: all.filter(h => !h.primary).map(h => ({ id: h.id, name: h.def.name, icon: h.def.icon, rank: h.rank })),
    slots: fusionSlots(c), slotsUsed: fusionsUsed(c), slotOpen: fusionOpen(c), nextSlotAt: nextFusionAt(c), tierUps: tierUps(c),
    mastery: masteries(c), capStage: r.cap,
    techniques: techniquesOf(c), words: wordsOf(c), axes: axesOf(c),
    features: featureList(c),
    training: trained.map(k => ({ key: k, label: label(k), bonus: trainBonus(c, k) })).sort((a, b) => b.bonus - a.bonus),
    mind: cl.mind, target: TARGETS[cl.mind.target],
  };
}
/** "Master Fighter", and everything fused into them after it. */
function title(c) {
  const all = held(c);
  if (!all.length) return 'Unclassed';
  return all.map(h => `${h.rank.label} ${h.def.name}`).join(' · ');
}
const shortTitle = (c) => { const cl = def(c); return cl ? `${rank(c).label} ${cl.name}` : 'Unclassed'; };

const ClassesAPI = {
  RANKS, XP, GROUPS, CLASSES, LIST, BASES, TARGETS, POSTURES, BIRTHRIGHT_BASE, LEGENDARY_CHANCE, birthrightChance,
  FEATURE_KEY, featureList, featuresOf, fieldKit, LEGACY_IDS,
  SPECIALISE_AT, BASE_FIT, isBase, branchesOf, trunkOf, fitness, leanings, specialise, masteryList,
  preparedBonus, poolMult, magicMult,
  TRADES, TRADE_LIST, TRADE_RANKS, TRADE_EARN_TICKS, tradeForJob, ensureTrade, tradeDef, tradeRank,
  tradeTitle, tradeProof, tradeProgress, worked, crafted, dropTrade, describeTrade,
  ensure, def, defs, held, has, idOf, rank, rankIndex, rankAt, rankIndexAt, phrase, progress,
  title, shortTitle, describe, byGroup,
  FUSE_AT, FUSED_SHARE, tierUps, tieredUp, fusionSlots, fusionsUsed, fusionOpen, nextFusionAt, fusable, fuse, unfuse,
  eligible, available, birthrights, rollBirthright, rarity, rarestOf, advise, assign, unassign,
  earn, trained, fought, returned,
  trainBonus, trainMult, capStage, masters, masteries,
  techniquesOf, wordsOf, axesOf, teaches, lexiconOf, psiOrderOf, axesOpenedBy,
  doctrine, actMult, targetPriority, posture, drawWeight, nerve,
  roleOf, scoutBonus, socialMult, lootMult, partyLoot,
};
if (typeof module !== 'undefined') module.exports = ClassesAPI;
if (typeof window !== 'undefined') window.Classes = ClassesAPI;
})();
