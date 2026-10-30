// Quantity registry for this game: every number a facet may read, freeze, drain, invert or sever.
// Browser: window.FacetQuantitiesIG. Node: module.exports. Not part of the portable core.
//
// Three namespaces, and they do not line up. `stat.eff.*` is the six base attributes with equipment
// counted. `derived.*` is the eighteen numbers stats.js computes from them. `fighter.*` is the
// thirteen-key block combat.js builds for a combatant; it overlaps the derived set but is not equal
// to it. A fourth namespace lives behind a string prefix: resistances are stored as `res:<type>`
// mods, stats() drops them all, and only bearerResistance reads them.
//
// The `from` edges are corrected here, not copied. stats.js stores one governing `stat` per derived
// entry, but building the graph from that field is wrong: minDamage declares DEX, and its formula
// reads DEX and STR both, because it is capped by what maxDamage allows. A graph built off the
// declared field would omit the STR edge, so severing STR would leave minDamage standing when it
// should fall. facet.cases.js audits every edge in this file against a recording proxy over the
// real formulas, and minDamage is the entry that audit was written for.
//
// `gates` is not `feeds`. A quantity feeding another means shrinking the first shrinks the second.
// A quantity gating another means zeroing the first removes the second: crit chance at zero does not
// just reduce crit damage, it means no crit occurs, so nothing downstream of a crit can fire. Only
// gated edges propagate a severance, which bounds how far "everything downstream of it" reaches.

(() => {
const Q = (id, d) => Object.assign({ id }, d);

const STATS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const TYPES = ['slashing', 'piercing', 'bludgeoning', 'heat', 'cold', 'poison', 'acid', 'arcane', 'lightning', 'earth', 'water', 'wind', 'light', 'dark'];

function build() {
  const out = [];

  // ---- the six attributes -------------------------------------------------
  // These rows are writable: true, nullifiable: false. That pair lets "a non-HP, non-attribute
  // value" be expressed as a query over this registry instead of a hand-written exclusion list. An
  // ability that scales attributes and an ability that may not sever them read the same two flags.
  for (const s of STATS) {
    out.push(Q('stat.eff.' + s, {
      label: s.toUpperCase(), kind: 'attribute', namespace: 'stat',
      from: [], nullifiable: false, writable: true, nul: 0, clamp: [0, null],
    }));
  }

  // ---- the eighteen derived stats ----------------------------------------
  const D = (id, label, from, feeds, gates, kind, nul) => out.push(Q('derived.' + id, {
    label, kind: kind || 'scalar', namespace: 'derived',
    from, feeds: feeds || [], gates: gates || [], nul: nul === undefined ? 0 : nul,
    nullifiable: true, writable: true,
  }));

  D('equipLoad',      'Equip load',         ['stat.eff.str'], [], []);
  D('maxDamage',      'Max damage',         ['stat.eff.str'], ['derived.minDamage'], [], 'flat');
  D('critDamage',     'Crit damage',        ['stat.eff.str'], ['fighter.critDamage'], [], 'mult', 1);
  D('walkSpeed',      'Walk speed',         ['stat.eff.dex'], [], []);
  // Declared by stats.js as governed by DEX; its formula reads STR too, through the maxDamage cap.
  D('minDamage',      'Min damage',         ['stat.eff.dex', 'stat.eff.str'], [], [], 'flat');
  D('critChance',     'Crit chance',        ['stat.eff.dex'], ['fighter.crit'], ['fighter.crit'], 'prob');
  D('stamina',        'Stamina',            ['stat.eff.con'], ['pool.stamina.max'], ['pool.stamina.max'], 'pool');
  D('hp',             'HP',                 ['stat.eff.con'], ['fighter.maxHp'], [], 'pool');
  D('physicalResist', 'Physical resist',    ['stat.eff.con'], [], [], 'prob');
  D('mana',           'Mana',               ['stat.eff.int'], ['pool.mana.max'], ['pool.mana.max'], 'pool');
  D('magicDamage',    'Magic damage',       ['stat.eff.int'], ['fighter.magicDamage'], [], 'flat');
  D('cooldownReduce', 'Cooldown reduction', ['stat.eff.int'], [], [], 'prob');
  D('spirit',         'Spirit',             ['stat.eff.wis'], ['pool.focus.max'], ['pool.focus.max'], 'pool');
  D('senses',         'Senses',             ['stat.eff.wis'], [], []);
  D('magicResist',    'Magic resist',       ['stat.eff.wis'], [], [], 'prob');
  D('teamwork',       'Teamwork',           ['stat.eff.cha'], [], [], 'prob');
  D('rewardMod',      'Reward modifier',    ['stat.eff.cha'], [], [], 'mult', 1);
  D('willpower',      'Willpower',          ['stat.eff.cha'], [], [], 'flat');

  // ---- the combatant block -----------------------------------------------
  // MOD_STATS is the exact set combat.js's stats() will apply a modifier to. Anything outside it is
  // silently dropped, so a quantity not in this list carries modStat:null and the generator will not
  // build a status modifier out of it. The corpus asserts this list against the live stat block
  // rather than trusting it, because the list drifts whenever a key is added to the fighter block.
  const MOD_STATS = ['damage', 'magicDamage', 'speed', 'dodge', 'parry', 'armor', 'crit',
                     'critDamage', 'penetration', 'splash', 'staminaRegen', 'manaRegen', 'maxHp'];
  const FQ = (id, label, opt) => out.push(Q('fighter.' + id, Object.assign({
    label, kind: 'scalar', namespace: 'fighter', from: [], feeds: [], gates: [],
    nul: 0, nullifiable: true, writable: true,
    modStat: MOD_STATS.indexOf(id) >= 0 ? id : null,
  }, opt || {})));

  // Zero-based quantities carry modOps: ['add'] only. combat.js applies a multiplicative modifier as
  // `s[stat] *= 1 + v`, which is a no-op when the base is zero, for any v. Monsters start with
  // parry, penetration and splash at exactly 0, and a character with no armour has armor 0, so a
  // multiplicative modifier on those would be priced and described but change nothing. The
  // resistances below have the same problem and the same fix.
  FQ('damage',      'Weapon damage', { from: ['stat.eff.str'], kind: 'flat' });
  FQ('magicDamage', 'Spell power',   { from: ['stat.eff.int'], kind: 'flat' });
  // Speed gates fighter.bar: at speed 0 the fighter never acts, so anything an action would have
  // triggered is downstream of it.
  FQ('speed',       'Speed',         { from: ['stat.eff.dex'], feeds: ['fighter.bar'], gates: ['fighter.bar'], kind: 'rate' });
  FQ('dodge',       'Dodge',         { from: ['stat.eff.dex'], kind: 'prob', mortalRole: 'evade' });
  FQ('parry',       'Parry',         { from: [], kind: 'prob', mortalRole: 'evade', modOps: ['add'] });
  FQ('armor',       'Armor',         { from: [], kind: 'flat', mortalRole: 'coverage', modOps: ['add'] });
  FQ('crit',        'Crit chance',   { from: ['derived.critChance'], feeds: ['fighter.critDamage'], gates: ['fighter.critDamage'], kind: 'prob' });
  FQ('critDamage',  'Crit damage',   { from: ['derived.critDamage'], kind: 'mult', nul: 1 });
  FQ('penetration', 'Penetration',   { from: [], kind: 'prob', modOps: ['add'] });
  FQ('splash',      'Splash',        { from: [], kind: 'prob', modOps: ['add'] });
  FQ('staminaRegen','Stamina regen', { from: [], kind: 'mult', nul: 1 });
  FQ('manaRegen',   'Mana regen',    { from: [], kind: 'mult', nul: 1 });
  FQ('maxHp',       'Max HP mult',   { from: [], kind: 'mult', nul: 1, feeds: [] });
  FQ('bar',         'Action bar',    { from: ['fighter.speed'], kind: 'rate' });
  FQ('position',    'Position',      { from: [], kind: 'mode', nullifiable: false });
  FQ('rank',        'Rank',          { from: [], kind: 'mode', nullifiable: false });

  // Both vitality rows are nullifiable: false, and fighter.hp is also writable: false, so no facet
  // can sever or write HP. The mortality proof reads these two rows to know what it protects.
  FQ('hp',    'HP',     { from: [], kind: 'pool', nullifiable: false, writable: false, mortalRole: 'vitality' });
  FQ('maxHpAbs', 'Max HP', { from: ['derived.hp'], kind: 'pool', nullifiable: false, mortalRole: 'vitality' });

  // resistCap is the ceiling the game enforces on mitigation. It is writable: false and sealed:
  // true, so nothing may write it and nothing may replace it. ward is a real field that had a reader
  // and no writer before this engine, so it carries clamp [0, null] here instead of relying on
  // callers to stay in range.
  FQ('resistCap', 'Resistance cap', { from: [], kind: 'cap', nullifiable: false, writable: false, sealed: true });
  FQ('ward',      'Ward',           { from: [], kind: 'flat', mortalRole: 'coverage', clamp: [0, null] });

  // ---- the resistances ----------------------------------------------------
  for (const t of TYPES) {
    out.push(Q('res.' + t, {
      label: t + ' resistance', kind: 'prob', namespace: 'res',
      from: [], feeds: [], gates: [], nul: 0, clamp: [-1, 0.9],
      nullifiable: true, writable: true, mortalRole: 'coverage',
      // Resistances live behind a string prefix. stats() drops every mod whose stat begins with
      // `res:`, and only bearerResistance reads them, so they get their own namespace here.
      modStat: 'res:' + t,
      // add only. bearerResistance multiplies as res*(1+v), and base resistance is 0 for most types
      // on most bearers, so a multiplicative modifier changes nothing.
      modOps: ['add'],
    }));
  }

  // ---- pools --------------------------------------------------------------
  for (const p of ['mana', 'stamina', 'focus']) {
    out.push(Q('pool.' + p + '.cur', { label: p + ' (current)', kind: 'pool', namespace: 'pool', from: [], feeds: [], gates: [], nullifiable: true, writable: true }));
    out.push(Q('pool.' + p + '.max', { label: p + ' (max)', kind: 'pool', namespace: 'pool', from: [], feeds: ['pool.' + p + '.cur'], gates: ['pool.' + p + '.cur'], nullifiable: true, writable: true }));
  }

  return out;
}

const API = { build, STATS, TYPES };
if (typeof module !== 'undefined') module.exports = API;
if (typeof window !== 'undefined') window.FacetQuantitiesIG = API;
})();
