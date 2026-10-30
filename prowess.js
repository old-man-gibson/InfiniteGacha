// Prowess: the six things a character brings to the field, on one comparable scale.
// Browser: window.Prowess. Node: module.exports.
//
// The roster tile says what a character IS — a face, a name, a star count. What it cannot say is
// what they would actually DO out there, because that answer is spread across six files: the stat
// block, the aptitude ladder, whatever they are carrying, the techniques the weapon admits, the
// words they know, the axes they have opened, and the class that taught them. This gathers all of
// it into six numbers so a shape can be drawn.
//
// There are six axes, one per base stat, by design: the anchor stat makes each axis legible at
// once (Might is the strong one, Sorcery is the clever one), but the axis is not the stat. A
// character with 24 STR, no weapon aptitude and nothing in their hands scores badly on Might, and
// should — the field does not count what they could have been.
//
// Everything is scaled 0..1 against a fixed ceiling, never against the roster. A relative scale
// would redraw every card in the game the moment a good character was summoned, and a 5-star
// would look worse on a strong roster than on a weak one. The ceiling is roughly what a fully
// advanced, fully trained, legendary-equipped character reaches, so early characters read as
// small shapes, which is accurate.
//
// Every axis carries its parts. A radar chart that cannot say why one spoke is short gives the
// player nothing to act on. `of()` returns the weighted components with their own values and a
// line of text, so the sheet can answer "why is my swordsman's Might only halfway out" with
// "nothing in their hands" instead of making the player go and look.

(() => {
const S = () => (typeof Stats !== 'undefined') ? Stats : require('./stats.js');
const P = () => (typeof Prof !== 'undefined') ? Prof : require('./proficiency.js');
const A = () => (typeof AI !== 'undefined') ? AI : require('./ai.js');
const EC = () => (typeof Econ !== 'undefined') ? Econ : require('./economy.js');
// Optional: each of these is a system a character may simply not have reached yet.
const opt = (name, path) => (typeof globalThis !== 'undefined' && globalThis[name]) ? globalThis[name]
  : (typeof require !== 'undefined' ? require(path) : null);
const CL = () => opt('Classes', './classes.js');
const CR = () => opt('Crew', './crew.js');
const MA = () => opt('Martial', './martial.js');
const SP = () => opt('Spellcraft', './spellcraft.js');
const PS = () => opt('Psionic', './psionic.js');

const clamp01 = (v) => Math.max(0, Math.min(1, v || 0));

// Aptitudes are read against the whole ladder here: S** at level 30 is 1 (Prof.CEILINGS.ladder).
// ai.js, classes.js and tactics.js read them against the top of A+ (Prof.CEILINGS.advance).

// Knowledge ceilings. The starter lexicon and the two axes everyone begins with are free, so they
// read as zero: what is being measured is what this character went and learned.
const TECH_CEIL = 12;        // the most any one loadout admits, of the 28 authored
const WORD_FREE = 11;        // STARTER_LEXICON
const WORD_CEIL = 38;
const AXIS_FREE = 2;         // STARTING_AXES
const AXIS_CEIL = 8;

const AXES = [
  { key: 'might', label: 'Might', icon: '⚔️', stat: 'str', color: '#e0705a',
    blurb: 'Damage dealt with a weapon. Inputs: STR, weapon damage and quality, aptitude with the weapon carried, techniques the loadout allows.' },
  { key: 'finesse', label: 'Finesse', icon: '🏹', stat: 'dex', color: '#6fbf73',
    blurb: 'Action rate and avoidance. Inputs: DEX, turn speed, crit chance and multiplier, evasion, light-armour aptitude.' },
  { key: 'guard', label: 'Guard', icon: '🛡️', stat: 'con', color: '#5591e0',
    blurb: 'Damage absorbed before death. Inputs: CON, HP, physical and magic resist, armour worn, aptitude to wear it.' },
  { key: 'sorcery', label: 'Sorcery', icon: '🔮', stat: 'int', color: '#ab47bc',
    blurb: 'Damage dealt by casting. Inputs: INT, magic damage, mana pool, elemental aptitudes, lexicon size.' },
  { key: 'insight', label: 'Insight', icon: '🧭', stat: 'wis', color: '#e0c05a',
    blurb: 'Information gathered before and during a mission. Inputs: WIS, scouting score, senses, psionic axes opened.' },
  { key: 'presence', label: 'Presence', icon: '🤝', stat: 'cha', color: '#4fc3c3',
    blurb: 'Effects applied to the whole party. Inputs: CHA, teamwork, nerve, planning, party loot multiplier.' },
];

const AXIS = Object.fromEntries(AXES.map(a => [a.key, a]));

/**
 * The six axes for one character, each with the parts that made it.
 * Every part is { label, value (0..1), weight, text } — `text` is the plain reading, so the sheet
 * never has to re-derive a number it is already being handed.
 */
function of(c) {
  const st = S(), pr = P(), ai = A(), ec = EC();
  const cl = CL(), crew = CR(), ma = MA(), sp = SP(), ps = PS();
  // Gear counted: the radar is what this character brings to the field today, and half of that
  // is what they are carrying. `bonus` is kept so the stat lines can show the two apart.
  const eff = st.effective(c);
  const b = eff.base, d = eff.derived, gearBonus = eff.bonus;
  const eq = c.equipment || {};

  // ---------- normalised primitives ----------
  const stat = (k) => clamp01((b[k] - st.STAT_MIN) / (st.STAT_MAX - st.STAT_MIN));
  const apt = (k) => (c.profs && c.profs[k]) ? pr.share(c.profs[k], { ceiling: 'ladder' }) : 0;
  const aptBest = (...ks) => ks.reduce((n, k) => Math.max(n, apt(k)), 0);
  const aptName = (...ks) => ks.reduce((best, k) => apt(k) > apt(best) ? k : best, ks[0]);
  const qual = (slot) => eq[slot] ? (eq[slot].quality + 1) / ec.QUALITY.length : 0;
  const fmtApt = (k) => (c.profs && c.profs[k]) ? `${pr.PROFICIENCIES[k].label} ${pr.format(c.profs[k])}` : 'untrained';
  // "STR 17 (10+7)" when gear is doing some of the lifting, plain "STR 10" when it is not.
  const statText = (k) => `${k.toUpperCase()} ${b[k]}` + (gearBonus[k] ? ` (${c.stats.base[k]}+${gearBonus[k]})` : '');
  // Casting level, the same divisor missions.js prepares a loadout with — arcana and psionics both
  // read their level off the aptitude as absolute/15, and getting this wrong opens axes early.
  const aptLevel = (k) => (c.profs && c.profs[k]) ? Math.floor(pr.toAbsolute(c.profs[k]) / 15) : 0;

  // Reachable ceilings, which are NOT the formula caps in stats.js. Physical resist is written as
  // min(0.6, con * 0.015), but base stats stop at 30, so 0.45 is as far as anyone ever gets:
  // normalising against 0.6 would leave a quarter of that spoke unreachable by anybody, forever.
  // Same story for crit, evasion and party loot.
  const RESIST_CEIL = st.STAT_MAX * 0.015;                             // 0.45, not the written 0.6
  const CRIT_CEIL = Math.min(0.75, 0.05 + st.STAT_MAX * 0.0125);       // 0.425
  const DODGE_CEIL = st.STAT_MAX * 0.006 + 0.05;                       // 0.23, in light body armour
  const MANA_CEIL = 30 + st.STAT_MAX * 6;
  const LOOT_CEIL = 1.35;                                              // the most generous class

  const ELEMENTS = Object.keys(pr.PROFICIENCIES).filter(k => pr.PROFICIENCIES[k].group === 'element');
  const ARMORS = ['light_armor', 'medium_armor', 'heavy_armor'];

  const weapon = eq.weapon;
  const family = weapon ? weapon.type : 'unarmed';
  const wornCount = ['head', 'body', 'feet'].filter(s => eq[s]).length + (eq.offhand ? 1 : 0);

  // ---------- might ----------
  const techs = ma ? ma.known(c).length : 0;
  const might = [
    { label: 'Strength', value: stat('str'), weight: 0.28, text: `${statText('str')} · ${Math.round(d.maxDamage)} max damage` },
    { label: 'Weapon aptitude', value: apt(family), weight: 0.30,
      text: weapon ? fmtApt(family) : `no weapon · falls back to ${fmtApt('unarmed')}` },
    { label: 'What they carry', value: qual('weapon'), weight: 0.22,
      text: weapon ? weapon.name : 'weapon slot empty' },
    { label: 'Techniques', value: clamp01(techs / TECH_CEIL), weight: 0.20,
      text: techs ? `${techs} of ${TECH_CEIL} techniques available to this loadout` : 'no techniques available' },
  ];

  // ---------- finesse ----------
  const dodge = Math.min(0.5, b.dex * 0.006 + (eq.body && eq.body.type === 'light' ? 0.05 : 0));
  const quick = aptName('bow', 'dagger', 'spear', 'unarmed');
  const finesse = [
    { label: 'Dexterity', value: stat('dex'), weight: 0.34, text: `${statText('dex')} · turn speed ${Math.round(40 + b.dex)}` },
    { label: 'Crit chance', value: clamp01(d.critChance / CRIT_CEIL), weight: 0.20,
      text: `${Math.round(d.critChance * 100)}% to crit, for ×${d.critDamage.toFixed(2)}` },
    { label: 'Evasion', value: clamp01(dodge / DODGE_CEIL), weight: 0.18, text: `${Math.round(dodge * 100)}% chance to evade` },
    { label: 'Quick weapons', value: aptBest('bow', 'dagger', 'spear', 'unarmed'), weight: 0.15, text: fmtApt(quick) },
    { label: 'Light armour', value: apt('light_armor'), weight: 0.13, text: fmtApt('light_armor') },
  ];

  // ---------- guard ----------
  // The same armour sum combat.js builds a fighter from, so the bar and the fight agree.
  let armor = 0;
  for (const slot of ['head', 'body', 'feet']) {
    const it = eq[slot];
    if (it) armor += ({ light: 1, medium: 2, heavy: 3 })[it.type] * (1 + it.quality) * 0.8;
  }
  if (eq.offhand) armor += (eq.offhand.type === 'tower' ? 3 : eq.offhand.type === 'kite' ? 2 : 1) * (1 + eq.offhand.quality) * 0.5;
  const ARMOR_CEIL = 3 * 6 * 0.8 * 3 + 3 * 6 * 0.5;   // three legendary heavy pieces and a tower shield
  const guard = [
    { label: 'Constitution', value: stat('con'), weight: 0.26, text: `${statText('con')} · ${Math.round(d.hp)} HP` },
    { label: 'Resistances', value: clamp01((d.physicalResist + d.magicResist) / (2 * RESIST_CEIL)), weight: 0.20,
      text: `${Math.round(d.physicalResist * 100)}% physical · ${Math.round(d.magicResist * 100)}% magic` },
    { label: 'Armour worn', value: clamp01(armor / ARMOR_CEIL), weight: 0.24,
      text: wornCount ? `${armor.toFixed(1)} armour from ${wornCount} piece${wornCount === 1 ? '' : 's'}` : 'unarmoured' },
    { label: 'Armour aptitude', value: aptBest(...ARMORS), weight: 0.18, text: fmtApt(aptName(...ARMORS)) },
    { label: 'Shield', value: apt('shield') * (eq.offhand ? 1 : 0.4), weight: 0.12,
      text: eq.offhand ? `${eq.offhand.name} · ${fmtApt('shield')}` : `no offhand · ${fmtApt('shield')}` },
  ];

  // ---------- sorcery ----------
  const words = sp ? sp.lexiconOf(c).length : 0;
  const arcanaLevel = aptLevel('arcana');
  const elem = aptName(...ELEMENTS);
  const sorcery = [
    { label: 'Intelligence', value: stat('int'), weight: 0.24, text: `${statText('int')} · ${Math.round(d.magicDamage)} magic damage` },
    { label: 'Arcana', value: apt('arcana'), weight: 0.26, text: fmtApt('arcana') },
    { label: 'Best element', value: aptBest(...ELEMENTS), weight: 0.20, text: fmtApt(elem) },
    { label: 'Lexicon', value: clamp01((words - WORD_FREE) / (WORD_CEIL - WORD_FREE)), weight: 0.18,
      text: sp ? `${words} words · sentences up to ${sp.maxSentenceWords(arcanaLevel)} long` : `${words} words` },
    { label: 'Mana', value: clamp01(d.mana / MANA_CEIL), weight: 0.12, text: `${Math.round(d.mana)} mana` },
  ];

  // ---------- insight ----------
  const scout = ai.scouting(c);
  const psiLevel = aptLevel('psionics');
  const axesOpen = ps ? ps.openAxes(c, psiLevel).length : AXIS_FREE;
  const insight = [
    { label: 'Scouting', value: clamp01(scout / 100), weight: 0.34, text: `${scout}/100 · ${ai.scoutTier(scout).label}` },
    { label: 'Wisdom', value: stat('wis'), weight: 0.22, text: `${statText('wis')} · senses ${d.senses.toFixed(1)}` },
    { label: 'Psionics', value: apt('psionics'), weight: 0.22, text: fmtApt('psionics') },
    { label: 'Open axes', value: clamp01((axesOpen - AXIS_FREE) / (AXIS_CEIL - AXIS_FREE)), weight: 0.12,
      text: `${axesOpen} of ${AXIS_CEIL} psionic axes open` },
    { label: 'Magic resist', value: clamp01(d.magicResist / RESIST_CEIL), weight: 0.10, text: `${Math.round(d.magicResist * 100)}% magic resist` },
  ];

  // ---------- presence ----------
  const team = crew ? crew.teamwork(c) : b.cha * 0.7 + b.wis * 0.3;
  const acumen = ai.acumen(c);
  const loot = cl ? cl.lootMult(c) : 1;
  const nerve = cl ? cl.nerve(c) : 0.7;
  const social = crew ? crew.ensureSocial(c) : [];
  const socialLabel = social.map(k => ((crew.SOCIAL_TRAITS[k] || {}).label || '')).filter(Boolean).join(', ');
  const presence = [
    { label: 'Charisma', value: stat('cha'), weight: 0.26, text: `${statText('cha')} · willpower ${Math.round(d.willpower)}` },
    { label: 'Teamwork', value: clamp01(team / 25), weight: 0.24,
      text: socialLabel ? `${team.toFixed(1)}/25 · ${socialLabel.toLowerCase()}` : `${team.toFixed(1)}/25 to the people beside them` },
    { label: 'Acumen', value: clamp01(acumen / 30), weight: 0.24, text: `${acumen.toFixed(1)} · ${ai.tier(c).label.toLowerCase()} mind` },
    { label: 'Nerve', value: clamp01(nerve), weight: 0.14, text: `holds at ${Math.round(nerve * 100)}% pressure` },
    { label: 'Spoils', value: clamp01((loot - 1) / (LOOT_CEIL - 1)), weight: 0.12,
      text: loot > 1 ? `party loot ×${loot.toFixed(2)}` : 'no bonus to what comes home' },
  ];

  const parts = { might, finesse, guard, sorcery, insight, presence };
  const axes = AXES.map(a => {
    const list = parts[a.key];
    const wsum = list.reduce((n, p) => n + p.weight, 0);
    return { ...a, value: clamp01(list.reduce((n, p) => n + p.value * p.weight, 0) / wsum), parts: list };
  });

  const ranked = [...axes].sort((x, y) => y.value - x.value);
  return {
    axes, ranked,
    byKey: Object.fromEntries(axes.map(a => [a.key, a])),
    top: ranked[0], low: ranked[ranked.length - 1],
    overall: axes.reduce((n, a) => n + a.value, 0) / axes.length,
  };
}

/** The mean shape of a roster, so one character can be read against the rest. */
function average(chars) {
  if (!chars || !chars.length) return null;
  const sums = Object.fromEntries(AXES.map(a => [a.key, 0]));
  for (const c of chars) for (const a of of(c).axes) sums[a.key] += a.value;
  return AXES.map(a => ({ ...a, value: sums[a.key] / chars.length }));
}

// How pointed a shape is: 0 is a perfect hexagon, 1 is a single spike. A specialist and an
// all-rounder with the same overall score are different characters and should read differently.
function focus(p) {
  const vs = p.axes.map(a => a.value);
  const mean = vs.reduce((a, v) => a + v, 0) / vs.length;
  if (mean <= 0) return 0;
  const sd = Math.sqrt(vs.reduce((a, v) => a + (v - mean) ** 2, 0) / vs.length);
  return clamp01(sd / mean);
}

// 0 is a perfect hexagon, 1 is a single spike. The label is the band, not a judgement: a
// specialist is not better or worse than an all-rounder, only shaped differently.
const SHAPES = [
  { min: 0,    id: 'round',      label: 'even across all six' },
  { min: 0.30, id: 'leaning',    label: 'leaning' },
  { min: 0.55, id: 'specialist', label: 'specialised' },
  { min: 0.85, id: 'onetrick',   label: 'single-axis' },
];

const shapeOf = (p) => SHAPES.filter(s => focus(p) >= s.min).pop();

/** One line instead of reading the whole chart: the spread, and the two axes that define it. */
function summary(c, p = null) {
  p = p || of(c);
  return `Spread ${focus(p).toFixed(2)} — ${shapeOf(p).label}. ` +
    `Highest ${p.top.label} ${Math.round(p.top.value * 100)}, lowest ${p.low.label} ${Math.round(p.low.value * 100)}.`;
}

/**
 * What is holding a character back that the player can actually fix today. Gear and training are
 * answerable; a low base stat is not, so it is never listed here.
 */
function limits(c) {
  const eq = c.equipment || {};
  const out = [];
  if (!eq.weapon) out.push('no weapon equipped');
  else if (eq.weapon.quality <= 1) out.push(`weapon quality is ${EC().QUALITY[eq.weapon.quality].name.toLowerCase()}`);
  const bare = ['head', 'body', 'feet'].filter(s => !eq[s]);
  if (bare.length === 3) out.push('no armour equipped');
  else if (bare.length) out.push(`no armour in ${bare.join(', ')}`);
  const fam = eq.weapon ? eq.weapon.type : null;
  if (fam && (!c.profs[fam] || c.profs[fam].stage < 3)) out.push(`${fam} aptitude below D for the ${fam} carried`);
  return out;
}

const ProwessAPI = { AXES, AXIS, SHAPES, of, average, focus, shapeOf, summary, limits };
if (typeof module !== 'undefined') module.exports = ProwessAPI;
if (typeof window !== 'undefined') window.Prowess = ProwessAPI;
})();
