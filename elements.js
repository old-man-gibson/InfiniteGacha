// Elements and conditions, lifted from Frontier Idle. Browser: window.Elements. Node: module.exports.
//
// Fourteen damage types. Physical ones (slashing, piercing, bludgeoning) are answered by flat
// armor; every type is answered by a resistance in [-1, cap], a fraction removed (negative =
// vulnerable, up to double). Penetration erodes positive resistance only.
//
// Conditions come in ladders: a base and the worse thing it becomes when pushed to its cap.
// Intensity is the dial. Some conditions act on other conditions (soaked carries a chill three
// times as deep, converts poison to rot, and dictates resistances); that is what makes an
// element feel like an element rather than a damage type.
//
// A bearer is any object with { hp, maxHp, statuses: [], res: {type: fraction}, armor }.
// `tickStatuses` reports damage and does not apply it; the combat loop does.

(() => {
const R = (typeof Rng !== 'undefined') ? Rng : require('./rng.js');

const TYPES = ['slashing', 'piercing', 'bludgeoning', 'heat', 'cold', 'poison', 'acid', 'arcane', 'lightning', 'earth', 'water', 'wind', 'light', 'dark'];
const TYPE_ICON = { slashing: '🔪', piercing: '🗡️', bludgeoning: '🔨', heat: '🔥', cold: '❄️', poison: '☠️', acid: '🧪', arcane: '🔮', lightning: '⚡', earth: '🪨', water: '💧', wind: '🌬️', light: '☀️', dark: '🌑' };
const PHYSICAL = new Set(['slashing', 'piercing', 'bludgeoning']);
const RESIST_CAP = 0.75, MONSTER_RESIST_CAP = 0.9, APPLICATION_FLOOR = 0.25;
// Element proficiencies: which aptitude a damage type trains and is boosted by.
const ELEMENT_APTITUDE = { heat: 'fire', cold: 'ice', lightning: 'lightning', water: 'water', earth: 'earth', wind: 'wind', poison: 'poison', acid: 'acid', light: 'light', dark: 'dark', arcane: 'arcana' };

function afterPenetration(res, pen = 0) { return res > 0 ? Math.max(0, res - pen) : res; }
function resistOf(profile, type) { return profile && profile.resist ? (profile.resist[type] || 0) : 0; }

// ---------- the damage pipeline ----------
//
// A blow used to be resolved by one expression: armor off the top, then resistance, then ward. It is
// now the same arithmetic in the same order, written as a named, ordered list of stages over a
// frame, so that something outside this file can join a stage without editing this function.
// Behaviour is unchanged: `test/facet.pipeline.js` holds a frozen copy of the original and
// compares twenty thousand random blows field by field, since a small error in the damage path
// does not show up in any single fight.
//
// The frame is created per call because slice() is re-entrant: combat.js's damage()
// calls it again from inside a call that is already on the stack (the graft harvest at :157 runs
// during a damage() that was itself invoked from the slice at :238). A frame stored on the bearer,
// or in a module-level variable, would be clobbered by the inner call and the outer one would finish
// with the inner one's numbers.
//
// TWO NEW STAGES, both of which exist for the mortality bound rather than for expressiveness:
//   absorb   where a facet intercepts a blow it means to store rather than take. Joinable.
//   engine   the terminal application of the frame's accumulated multiplier, clamped from below.
//            NOT joinable, ever: it is the floor under how much any composition of abilities may
//            reduce a blow, and a stage that can be joined is a stage that can be neutralised.
//
// `crit` and `floor` appear in the declared stage table but are still applied by their existing
// owners — crit by the callers in combat.js, the floor of 1 by damage(). They are named here so the
// table is the true order; moving them is a separate change with its own risks.
const STAGE_ORDER = ['raw', 'armor', 'resist', 'absorb', 'engine', 'ward'];
const MIN_ENGINE_MULT = 0.05;

const FA = () => (typeof globalThis !== 'undefined' && globalThis.Facet && globalThis.Facet.pipeline && globalThis.Facet.pipeline.live) ? globalThis.Facet.pipeline : null;

/**
 * Damage through armor and resistance. Returns { dealt, resisted, armor, resistance, raw, type }.
 * `hit` is optional context for anything joined to a stage — { attacker, source, descriptor,
 * skipStages, facetId } — and is ignored entirely when nothing has joined, which is why all eight
 * existing callers pass four arguments and are unaffected.
 */
function slice(bearer, type, raw, penetration = 0, hit = null) {
  const cap = bearer.resistCap == null ? MONSTER_RESIST_CAP : bearer.resistCap;
  const before = Math.min(cap, Math.max(-1, bearerResistance(bearer, type)));
  const resistance = afterPenetration(before, penetration);

  const frame = {
    bearer, type, raw, penetration, resistance, hit,
    value: raw, armor: 0, resisted: 0, warded: 0,
    engineMult: 1,
    skip: (hit && hit.skipStages) || null,
  };

  const pipe = FA();
  for (const id of STAGE_ORDER) {
    if (frame.skip && frame.skip.indexOf(id) >= 0 && id !== 'engine') continue;
    if (pipe) frame.value = runJoins(pipe, id, 'before', frame);
    applyStage(id, frame);
    if (pipe) frame.value = runJoins(pipe, id, 'after', frame);
  }

  return { type, raw, armor: frame.armor, resisted: frame.resisted, resistance, dealt: Math.max(0, frame.value) };
}

function applyStage(id, frame) {
  switch (id) {
    case 'raw':
      frame.value = frame.raw;
      return;
    case 'armor': {
      frame.armor = PHYSICAL.has(frame.type) ? Math.min(frame.value, bearerArmor(frame.bearer)) : 0;
      frame.value = frame.value - frame.armor;
      return;
    }
    case 'resist': {
      const afterArmor = frame.value;
      frame.value = Math.max(0, afterArmor * (1 - frame.resistance));
      // Snapshotted here rather than derived at the end, so that anything joined to a later stage
      // does not change what this blow reports as "resisted".
      frame.resisted = afterArmor - frame.value;
      return;
    }
    case 'absorb':
      return;                                   // identity until something joins it
    case 'engine':
      frame.value = frame.value * Math.max(MIN_ENGINE_MULT, frame.engineMult);
      return;
    case 'ward': {
      frame.warded = Math.max(0, Math.min(frame.value, frame.bearer.ward || 0));
      frame.value = Math.max(0, frame.value - frame.warded);
      return;
    }
    default:
      return;
  }
}

function runJoins(pipe, id, phase, frame) {
  const joins = pipe.joinsFor(id, phase);
  if (!joins.length) return frame.value;
  // The engine stage takes no joins at all. Checked here as well as at compile time, because this is
  // the one guarantee that has to hold even if something registered a join by another route.
  if (id === 'engine') return frame.value;
  let v = frame.value;
  for (const j of joins) {
    const next = j.fn(frame);
    if (typeof next === 'number' && Number.isFinite(next)) v = next;
    frame.value = v;
  }
  return v;
}

// ---------- status definitions ----------
const S = 10; // ticks per second
const m = (stat, op, value) => ({ stat, op, value });
const STATUSES = {};
const def = (id, name, icon, d) => { STATUSES[id] = { id, name, icon, stacking: { mode: 'highest' }, ...d }; };

// acid
def('corroded', 'Corroded', '🧪', { element: 'acid', escalatesTo: 'melting', duration: 250, stacking: { mode: 'sum', cap: 6, onCap: 'escalate' }, mods: [m('armor', 'mult', -0.12)], worth: 6 });
def('melting', 'Melting', '🫗', { element: 'acid', baseForm: 'corroded', duration: 150, stacking: { mode: 'highest', cap: 4 }, mods: [m('armor', 'mult', -1), m('res:bludgeoning', 'add', -0.12), m('res:heat', 'add', -0.12), m('res:cold', 'add', -0.12)], worth: 20 });
// poison
def('poison', 'Poisoned', '🤢', { element: 'poison', escalatesTo: 'rotting', duration: 300, stacking: { mode: 'highest', cap: 4, onCap: 'escalate' }, dot: { type: 'poison', flat: 0.05 }, mods: [m('staminaRegen', 'mult', -0.2)], worth: 2 });
def('rotting', 'Rotting', '🦠', { element: 'poison', baseForm: 'poison', duration: 450, dot: { type: 'poison', flat: 0.12 }, mods: [m('staminaRegen', 'mult', -0.35)], worth: 8 });
// heat
def('on_fire', 'On Fire', '🔥', { element: 'heat', escalatesTo: 'blazing', duration: 80, stacking: { mode: 'absorb', absorb: 0.5, cap: 5, onCap: 'escalate' }, dot: { type: 'heat', flat: 0.4 }, worth: 2 });
def('blazing', 'Blazing', '🔥', { element: 'heat', baseForm: 'on_fire', duration: 40, stacking: { mode: 'absorb', absorb: 0.25 }, dot: { type: 'heat', flat: 0.9 }, healCap: 0.5, expiresTo: 'blaze_burn', worth: 10 });
def('blaze_burn', 'Seared', '🩸', { element: 'heat', duration: null, healCap: 0.5, removal: [{ on: 'heal', healKinds: ['rest', 'salve', 'spell'] }, { on: 'combatEnd' }], worth: 4 });
// cold
def('chilled', 'Chilled', '🥶', { element: 'cold', escalatesTo: 'frozen', duration: 200, stacking: { mode: 'sum', cap: 1, onCap: 'escalate' }, mods: [m('speed', 'mult', -0.4), m('damage', 'mult', -0.25)], blockedBy: ['frozen'], worth: 15 });
def('frozen', 'Frozen', '🧊', { element: 'cold', baseForm: 'chilled', duration: 30, mods: [m('speed', 'mult', -0.95), m('res:bludgeoning', 'add', -0.5)], removal: [{ on: 'damageTaken' }], worth: 40 });
// slashing
def('bleeding', 'Bleeding', '🩸', { element: 'slashing', escalatesTo: 'lacerated', duration: null, stacking: { mode: 'count', cap: 5, onCap: 'escalate' }, dot: { type: 'slashing', flat: 0.08, currentHp: 0.0015, fromPeak: ['currentHp'] }, removal: [{ on: 'heal', healKinds: ['rest', 'salve', 'spell'] }, { on: 'combatEnd' }], worth: 3 });
def('lacerated', 'Lacerated', '🔪', { element: 'slashing', baseForm: 'bleeding', duration: null, stacking: { mode: 'count', cap: 5 }, dot: { type: 'slashing', maxHp: 0.002 }, removal: [{ on: 'heal', healKinds: ['rest', 'salve', 'spell'], effect: 'deescalate' }, { on: 'combatEnd' }], worth: 12 });
// bludgeoning
def('concussed', 'Concussed', '💫', { element: 'bludgeoning', escalatesTo: 'dazed', duration: 250, stacking: { mode: 'highest', cap: 3, onCap: 'escalate' }, blocks: ['spell'], missChance: 0.12, removal: [{ on: 'heal', healKinds: ['rest', 'salve', 'spell'], effect: 'reduce', amount: 0.4 }], worth: 12 });
def('dazed', 'Dazed', '😵', { element: 'bludgeoning', baseForm: 'concussed', duration: null, stacking: { mode: 'count', cap: 4 }, blocks: ['spell', 'attack'], bar: { skip: 1 }, removal: [{ on: 'barFill', effect: 'unstack' }, { on: 'combatEnd' }], worth: 25 });
// piercing
def('punctured', 'Punctured', '🕳️', { element: 'piercing', escalatesTo: 'perforated', duration: 400, stacking: { mode: 'sum', cap: 3, onCap: 'escalate' }, mods: [m('staminaRegen', 'mult', -0.25)], worth: 5 });
def('perforated', 'Perforated', '🫗', { element: 'piercing', baseForm: 'punctured', duration: 600, stacking: { mode: 'count', cap: 5 }, mods: [m('staminaRegen', 'mult', -1), m('damage', 'mult', -0.1)], worth: 15 });
// lightning
def('jolted', 'Jolted', '⚡', { element: 'lightning', escalatesTo: 'shocked', duration: 200, stacking: { mode: 'absorb', absorb: 1, cap: 6, onCap: 'escalate', escalateFrom: 2 }, bar: { onFill: { type: 'lightning', flat: 1.2 } }, removal: [{ on: 'damageTaken', effect: 'reduce', amount: 0.5 }], worth: 8 });
def('shocked', 'Shocked', '🌩️', { element: 'lightning', baseForm: 'jolted', duration: null, stacking: { mode: 'absorb', absorb: 1 }, bar: { skip: 2, onDeplete: { type: 'lightning', flat: 2.5 } }, removal: [{ on: 'barFill', after: 2 }, { on: 'combatEnd' }], worth: 30 });
// earth
def('shardbound', 'Shardbound', '🪨', { element: 'earth', escalatesTo: 'shardbloom', duration: 300, stacking: { mode: 'sum', cap: 4, onCap: 'escalate' }, retaliate: { type: 'piercing', flat: 0.8 }, worth: 8 });
def('shardbloom', 'Shardbloom', '💎', { element: 'earth', baseForm: 'shardbound', duration: 250, stacking: { mode: 'sum', cap: 6 }, retaliate: { type: 'piercing', flat: 0.4, inflicts: [{ id: 'shard_bleed', intensity: 2 }] }, worth: 20 });
def('shard_bleed', 'Shard Cut', '🩸', { element: 'slashing', duration: 40, stacking: { mode: 'count', cap: 8 }, dot: { type: 'slashing', flat: 0.3, currentHp: 0.001, fromPeak: ['currentHp'] }, worth: 4 });
// water
def('wet', 'Wet', '💧', { element: 'water', escalatesTo: 'soaked', duration: 300, stacking: { mode: 'sum', cap: 5, onCap: 'escalate' }, mods: [m('res:heat', 'add', 0.08), m('res:lightning', 'add', -0.06), m('res:cold', 'add', -0.06), m('res:poison', 'add', -0.04)], removal: [{ on: 'damageTaken', damageTypes: ['heat'], effect: 'unstack' }], worth: 5 });
def('soaked', 'Soaked', '🌊', { element: 'water', baseForm: 'wet', duration: 600, overrideRes: { heat: { to: 0.8, bonusIfMet: 0.1 }, lightning: { to: -0.5 }, cold: { to: -0.5 }, poison: { to: -0.5 } }, converts: [{ from: 'poison', to: 'rotting', ratio: 2 / 3 }], amplifies: [{ id: 'chilled', mult: 3 }], capOverrides: [{ id: 'jolted', cap: 3 }], removal: [{ on: 'damageTaken', damageTypes: ['heat', 'poison', 'lightning', 'cold'], after: 3 }], worth: 25 });
// wind
def('buffeted', 'Buffeted', '🍃', { element: 'wind', escalatesTo: 'unfooted', duration: 120, stacking: { mode: 'sum', cap: 5, onCap: 'escalate' }, displaces: { to: 'off_balance', chancePer: 0.12 }, decayWithDuration: true, worth: 5 });
def('unfooted', 'Unfooted', '💨', { element: 'wind', baseForm: 'buffeted', duration: 200, stacking: { mode: 'sum', cap: 4 }, displaces: { to: 'off_balance', always: true }, mods: [m('dodge', 'add', -0.1)], worth: 15 });
// wood (poison element)
def('seeded', 'Seeded', '🌱', { element: 'poison', escalatesTo: 'rootbound', duration: 600, stacking: { mode: 'sum', cap: 6, onCap: 'escalate' }, tends: { growPerSecond: 0.15, prunePerHit: 0.5, prunedBy: ['piercing'], fedBy: ['water'], feedPerHit: 1 }, grafts: { except: ['seeded', 'rootbound'], cap: 6, harvest: { on: ['heat'], type: 'heat', perIntensity: 4 } }, removal: [{ on: 'damageTaken', damageTypes: ['heat'] }], worth: 8 });
def('rootbound', 'Rootbound', '🌳', { element: 'poison', baseForm: 'seeded', duration: 450, stacking: { mode: 'sum', cap: 5 }, mods: [m('speed', 'mult', -0.2), m('dodge', 'add', -0.08)], tends: { growPerSecond: 0.08, prunePerHit: 0.25, prunedBy: ['piercing'], fedBy: ['water'], feedPerHit: 0.5 }, grafts: { except: ['seeded', 'rootbound'], cap: 6, harvest: { on: ['heat'], type: 'heat', perIntensity: 7 } }, removal: [{ on: 'damageTaken', damageTypes: ['heat'] }], worth: 22 });
// magnetism (piercing)
def('magnetized', 'Magnetized', '🧲', { element: 'piercing', escalatesTo: 'magnet_lock', duration: 100, stacking: { mode: 'sum', cap: 6, onCap: 'escalate' }, magnetism: { dodgeIgnore: 0.1, alwaysHit: ['lightning'], critChancePer: 0.05, critTypes: ['piercing'] }, mods: [m('dodge', 'add', -0.03)], worth: 8 });
def('magnet_lock', 'Magnet-Locked', '🧲', { element: 'piercing', baseForm: 'magnetized', duration: 150, stacking: { mode: 'sum', cap: 5 }, magnetism: { nullifyDodge: true, alwaysHit: ['lightning'], critChancePer: 0.05, critTypes: ['piercing'], critDamagePerStack: 0.35 }, worth: 25 });
// light
def('dazzled', 'Dazzled', '😑', { element: 'light', escalatesTo: 'blinded', duration: 60, stacking: { mode: 'extend', cap: 4, onCap: 'escalate' }, missChance: 0.08, mods: [m('dodge', 'add', -0.05)], blockedBy: ['eyeless'], worth: 8 });
def('blinded', 'Blinded', '🙈', { element: 'light', baseForm: 'dazzled', duration: 250, missChance: 0.35, mods: [m('dodge', 'add', -0.25)], blockedBy: ['eyeless'], worth: 25 });
// dark
def('tainted', 'Tainted', '🌑', { element: 'dark', escalatesTo: 'corrupted', duration: 450, stacking: { mode: 'sum', cap: 5, onCap: 'escalate' }, decayWithDuration: true,
  mods: [...['slashing', 'piercing', 'bludgeoning', 'heat', 'cold', 'poison', 'arcane', 'lightning', 'earth', 'wind', 'water', 'acid'].map(t => m('res:' + t, 'add', -0.05)), m('res:light', 'add', -0.1), m('res:dark', 'add', -0.1)], resFloor: { base: -0.25, perStack: 0.05 }, worth: 12 });
def('corrupted', 'Corrupted', '👁️', { element: 'dark', baseForm: 'tainted', duration: null, stacking: { mode: 'sum', cap: 10 }, mods: [m('maxHp', 'mult', -0.05), m('damage', 'mult', -0.05)], removal: [{ on: 'combatEnd' }], worth: 35 });
// arcane
def('unravelling', 'Unravelling', '🧵', { element: 'arcane', escalatesTo: 'manaburn', duration: 200, stacking: { mode: 'sum', cap: 3, onCap: 'escalate', escalateMult: 8 }, mods: [m('res:arcane', 'add', -0.08), m('magicDamage', 'mult', -0.05), m('manaRegen', 'mult', -0.15)], worth: 10 });
def('manaburn', 'Manaburn', '🔯', { element: 'arcane', baseForm: 'unravelling', duration: null, stacking: { mode: 'absorb', absorb: 1, cap: 8 }, drains: { resource: 'mana', ofMax: 0.01 }, dot: { type: 'arcane', flat: 0.15 }, removal: [{ on: 'combatEnd' }], worth: 20 });
// psionic
def('psionic_haste', 'Kinetic Haste', '💨', { duration: 200, mods: [m('speed', 'mult', 0.03)], worth: 6, buff: true });
def('psionic_bracing', 'Braced', '💢', { duration: 200, mods: [m('armor', 'add', 1)], worth: 3, buff: true });
def('psionic_root', 'Rooted', '🪨', { duration: 200, mods: [m('res:bludgeoning', 'add', 0.02)], amplifies: [{ id: 'dazed', mult: 0.5 }, { id: 'concussed', mult: 0.5 }], worth: 4, buff: true });
def('psionic_foresight', 'Foresight', '📍', { duration: 200, incomingMissChance: 0.03, worth: 6, buff: true });
def('psionic_compression', 'Compressed', '🌀', { duration: 200, mods: [m('speed', 'mult', -0.02)], worth: 4 });
def('psionic_read', 'Read', '🔍', { duration: 200, mods: [m('dodge', 'add', -0.02), m('parry', 'add', -0.02)], worth: 4 });
def('psionic_wide_sight', 'Wide Sight', '👁️', { duration: 200, mods: [m('res:slashing', 'add', 0.012), m('res:piercing', 'add', 0.012), m('res:bludgeoning', 'add', 0.012)], worth: 3, buff: true });
def('kinetic_bulwark', 'Kinetic Bulwark', '🛡️', { duration: 250, blocksRanged: { except: ['light'] }, worth: 15, buff: true });
// martial and misc
def('taunted', 'Taunted', '🗯️', { duration: 60, mods: [m('dodge', 'add', -0.05)], worth: 5 });
// fear: a Butcher's roar, or anything else that takes the fight out of a room. A fifth off what
// they deal and a tenth off how often it lands, per intensity; they do not stop swinging
def('cowed', 'Cowed', '😨', { duration: 150, stacking: { mode: 'highest', cap: 2 }, mods: [m('damage', 'mult', -0.2), m('magicDamage', 'mult', -0.2), m('speed', 'mult', -0.1)], missChance: 0.1, worth: 12 });
def('eyeless', 'Eyeless', '🕳️', { duration: null, hidden: true, removal: [{ on: 'combatEnd' }], worth: 0 });
def('ward', 'Warded', '🛡️', { duration: 300, mods: [], worth: 0, buff: true });

// ---------- readers ----------
const statusesOf = (b) => b.statuses || (b.statuses = []);
const findStatus = (b, id) => statusesOf(b).find(s => s.id === id);
const hasStatus = (b, id) => !!findStatus(b, id);
function removeStatus(b, id) { const a = statusesOf(b); const i = a.findIndex(s => s.id === id); if (i >= 0) a.splice(i, 1); }

function effectiveIntensity(held) {
  const d = STATUSES[held.id];
  if (!d || !d.decayWithDuration || held.ticksLeft == null) return held.intensity;
  const full = d.duration || held.ticksLeft;
  return full ? held.intensity * Math.max(0, Math.min(1, held.ticksLeft / full)) : held.intensity;
}

/** Modifiers from every held condition (plus ward buffs carrying their own mods), scaled by intensity. */
function statusMods(b) {
  const out = [];
  for (const held of statusesOf(b)) {
    const d = STATUSES[held.id]; if (!d) continue;
    const power = effectiveIntensity(held);
    for (const mod of (held.mods || d.mods || [])) out.push({ ...mod, value: mod.value * (held.mods ? 1 : power) });
  }
  return out;
}

/** Resistance of a bearer to a type, with status mods, overrides and floor applied. */
function bearerResistance(b, type) {
  let res = (b.res && b.res[type]) || 0;
  let floor;
  for (const held of statusesOf(b)) {
    const d = STATUSES[held.id]; if (!d) continue;
    for (const mod of (d.mods || [])) {
      if (mod.stat !== 'res:' + type) continue;
      const v = mod.value * held.intensity;
      res = mod.op === 'add' ? res + v : res * (1 + v);
    }
    if (d.resFloor) { const own = d.resFloor.base - d.resFloor.perStack * Math.max(0, held.stacks - 1); floor = floor === undefined ? own : Math.min(floor, own); }
  }
  for (const held of statusesOf(b)) {
    const d = STATUSES[held.id]; if (!d || !d.overrideRes || !d.overrideRes[type]) continue;
    const spec = d.overrideRes[type];
    res = spec.bonusIfMet !== undefined && res >= spec.to ? res + spec.bonusIfMet : spec.to;
  }
  if (floor !== undefined) res = Math.max(floor, res);
  return Math.max(-1, Math.min(b.resistCap == null ? MONSTER_RESIST_CAP : b.resistCap, res));
}
function bearerArmor(b) {
  let armor = b.armor || 0, mult = 1;
  for (const held of statusesOf(b)) for (const mod of (STATUSES[held.id] && STATUSES[held.id].mods || [])) {
    if (mod.stat !== 'armor') continue;
    if (mod.op === 'add') armor += mod.value * effectiveIntensity(held); else mult += mod.value * effectiveIntensity(held);
  }
  return Math.max(0, armor * Math.max(0, mult));
}

// ---------- application ----------
function amplifierFor(b, id) { let mult = 1; for (const o of statusesOf(b)) for (const a of (STATUSES[o.id] && STATUSES[o.id].amplifies || [])) if (a.id === id) mult *= a.mult; return mult; }
function capOverrideFor(b, id) { for (const o of statusesOf(b)) for (const c of (STATUSES[o.id] && STATUSES[o.id].capOverrides || [])) if (c.id === id) return c.cap; return undefined; }
function durationOf(d, app) { return app.duration === 'permanent' ? null : (app.duration !== undefined ? app.duration : d.duration); }
function recordGraft(b, id, intensity) {
  for (const held of statusesOf(b)) {
    const cfg = STATUSES[held.id] && STATUSES[held.id].grafts; if (!cfg || held.id === id || cfg.except.includes(id)) continue;
    held.data = held.data || {};
    const next = (held.data['graft:' + id] || 0) + intensity;
    held.data['graft:' + id] = cfg.cap !== undefined ? Math.min(cfg.cap, next) : next;
  }
}

function applicationMult(b, d) {
  if (!d.element) return 1;
  return Math.max(APPLICATION_FLOOR, 1 - Math.max(-1, Math.min(0.9, bearerResistance(b, d.element))));
}

/** Apply a status application {id, intensity, chance, duration} to a bearer. Returns the instance or null. */
function applyStatus(b, app, source, resisted = true) {
  const d = STATUSES[app.id]; if (!d) return null;
  return inflict(b, app, source, resisted ? applicationMult(b, d) : 1);
}
const reform = (b, app, source) => inflict(b, app, source, 1);

function inflict(b, app, source, resisted) {
  const d = STATUSES[app.id];
  if (app.chance !== undefined && !R.chance(app.chance)) return null;
  for (const blocker of (d.blockedBy || [])) if (hasStatus(b, blocker)) return null;
  const intensity = (app.intensity === undefined ? 1 : app.intensity) * amplifierFor(b, app.id) * resisted;
  recordGraft(b, d.id, intensity);
  const held = findStatus(b, app.id);
  const st = d.stacking;
  if (!held) {
    const inst = { id: d.id, intensity, peak: intensity, stacks: 1, ticksLeft: durationOf(d, app), source, data: {} };
    if (app.mods) inst.mods = app.mods;
    statusesOf(b).push(inst);
    for (const rule of (d.converts || [])) {
      const from = findStatus(b, rule.from); if (!from) continue;
      removeStatus(b, rule.from);
      reform(b, { id: rule.to, intensity: from.intensity * rule.ratio }, from.source);
    }
    return inst;
  }
  held.peak = Math.max(held.peak || held.intensity, intensity);
  switch (st.mode) {
    case 'highest': if (intensity > held.intensity) { held.intensity = intensity; held.ticksLeft = durationOf(d, app); } break;
    case 'absorb': held.intensity += intensity * (st.absorb === undefined ? 1 : st.absorb); held.stacks += 1; break;
    case 'sum': held.intensity += intensity; held.stacks += 1; held.ticksLeft = durationOf(d, app); break;
    case 'count': held.stacks += 1; held.intensity += intensity; held.ticksLeft = durationOf(d, app); break;
    case 'extend': { const added = durationOf(d, app); if (added !== null) held.ticksLeft = (held.ticksLeft || 0) + added; held.stacks += 1; break; }
  }
  const cap = capOverrideFor(b, d.id) !== undefined ? capOverrideFor(b, d.id) : st.cap;
  if (cap !== undefined) {
    const byStacks = st.mode === 'count' || st.mode === 'extend';
    const measure = byStacks ? held.stacks : held.intensity;
    const turns = st.onCap === 'escalate' && !!d.escalatesTo;
    const clamp = () => { if (measure < cap) return; if (byStacks) held.stacks = cap; else held.intensity = cap; };
    if (turns && st.escalateFrom !== undefined && measure > st.escalateFrom) {
      const span = Math.max(cap - st.escalateFrom, 1e-9);
      if (R.chance(Math.min(1, (measure - st.escalateFrom) / span))) return escalate(b, held, source);
      clamp(); return held;
    }
    if (measure >= cap) { if (turns) return escalate(b, held, source); clamp(); }
  }
  return held;
}

function escalate(b, held, source) {
  const d = STATUSES[held.id]; if (!d || !d.escalatesTo) return held;
  removeStatus(b, held.id);
  const next = reform(b, { id: d.escalatesTo, intensity: held.intensity * (d.stacking.escalateMult || 1) }, source);
  if (next) { next.peak = Math.max(next.peak, held.peak || held.intensity); next.data = { ...held.data, ...next.data }; }
  return next;
}
function escalationPrimed(b, held) {
  const d = STATUSES[held.id];
  if (!d || !d.escalatesTo || d.stacking.onCap !== 'escalate') return false;
  const cap = capOverrideFor(b, d.id) !== undefined ? capOverrideFor(b, d.id) : d.stacking.cap;
  if (cap === undefined) return false;
  const byStacks = d.stacking.mode === 'count' || d.stacking.mode === 'extend';
  return (byStacks ? held.stacks : held.intensity) >= cap;
}

// ---------- events ----------
/** Fire a removal event. detail: { healKind, damageType, amount }. Returns ids changed. */
function fireStatusEvent(b, event, detail = {}) {
  const changed = [];
  for (const held of [...statusesOf(b)]) {
    const d = STATUSES[held.id]; if (!d) continue;
    for (const rule of (d.removal || [])) {
      if (rule.on !== event) continue;
      if (rule.healKinds && !rule.healKinds.includes(detail.healKind || '')) continue;
      if (rule.damageTypes && !rule.damageTypes.includes(detail.damageType)) continue;
      if (rule.after && rule.after > 1) {
        held.data = held.data || {};
        const key = 'charge:' + rule.on;
        const seen = (held.data[key] || 0) + 1; held.data[key] = seen;
        if (seen < rule.after) break;
        held.data[key] = 0;
      }
      switch (rule.effect || 'remove') {
        case 'remove': removeStatus(b, held.id); if (rule.becomes) reform(b, { id: rule.becomes, intensity: held.intensity }, held.source); break;
        case 'deescalate': removeStatus(b, held.id); if (d.baseForm) reform(b, { id: d.baseForm, intensity: held.intensity }, held.source); break;
        case 'reduce': held.intensity *= 1 - (rule.amount === undefined ? 0.5 : rule.amount); if (held.intensity <= 0.01) removeStatus(b, held.id); break;
        case 'unstack': { const per = held.stacks > 0 ? held.intensity / held.stacks : held.intensity; held.stacks -= 1; held.intensity = Math.max(0, held.intensity - per); if (held.stacks <= 0) removeStatus(b, held.id); break; }
      }
      changed.push(held.id);
      break;
    }
  }
  return changed;
}

/** Wood: feed or prune on damage of a type. */
function tendOnDamage(b, type) {
  for (const held of [...statusesOf(b)]) {
    const cfg = STATUSES[held.id] && STATUSES[held.id].tends; if (!cfg) continue;
    if (cfg.fedBy && cfg.fedBy.includes(type)) { held.intensity += cfg.feedPerHit || 0; continue; }
    const cut = (cfg.prunePerHit || 0) * (cfg.prunedBy && cfg.prunedBy.includes(type) ? 2 : 1);
    if (cut <= 0) continue;
    held.intensity -= cut;
    if (held.intensity <= 0.01) removeStatus(b, held.id);
  }
}
/** Wood: the whole graft ledger paid back as damage when a harvesting type lands. Read BEFORE damageTaken fires. */
function graftHarvest(b, type) {
  let total = 0;
  for (const held of statusesOf(b)) {
    const cfg = STATUSES[held.id] && STATUSES[held.id].grafts; if (!cfg || !cfg.harvest.on.includes(type)) continue;
    const ledger = Object.entries(held.data || {}).filter(([k, v]) => k.startsWith('graft:') && v > 0).reduce((a, [, v]) => a + v, 0);
    total += ledger * cfg.harvest.perIntensity;
  }
  return total;
}

// ---------- tick ----------
/**
 * Advance every condition on a bearer one tick. Returns { damage: [{type, amount}], expired: [],
 * expireDamage: [], drains: [{resource, amount}] }. Does not touch hp.
 */
function tickStatuses(b, ctx = {}) {
  const inCombat = ctx.inCombat !== false;
  const out = { damage: [], expired: [], drains: [] };
  for (const held of [...statusesOf(b)]) {
    const d = STATUSES[held.id]; if (!d) { removeStatus(b, held.id); continue; }
    if (d.dot) {
      const peak = held.peak || held.intensity;
      const scale = (part) => (d.dot.fromPeak && d.dot.fromPeak.includes(part) ? peak : held.intensity);
      let raw = (d.dot.flat || 0) * scale('flat') + (d.dot.currentHp || 0) * scale('currentHp') * b.hp + (d.dot.maxHp || 0) * scale('maxHp') * b.maxHp;
      raw *= DOT_SCALE;
      const res = bearerResistance(b, d.dot.type);
      const pierce = Math.min(1, Math.max(0, d.dot.pierce || 0));
      const dealt = raw * (pierce + (1 - pierce) * Math.max(0, 1 - res));
      if (dealt > 0) { out.damage.push({ type: d.dot.type, amount: dealt, id: held.id }); held.data.dealt = (held.data.dealt || 0) + dealt; }
    }
    if (d.drains && b.pools && b.pools[d.drains.resource]) {
      const pool = b.pools[d.drains.resource];
      const wanted = (d.drains.flat || 0) * held.intensity + (d.drains.ofMax || 0) * pool.max;
      const amount = Math.min(wanted, held.intensity);
      held.intensity -= amount;
      out.drains.push({ resource: d.drains.resource, amount });
      if (held.intensity <= 0) { removeStatus(b, held.id); out.expired.push(held.id); continue; }
    }
    if (d.tends && inCombat) {
      held.intensity += d.tends.growPerSecond / S;
      if (escalationPrimed(b, held)) { escalate(b, held, held.source); continue; }
    }
    if (held.ticksLeft != null) {
      held.ticksLeft -= 1;
      if (held.ticksLeft <= 0) {
        removeStatus(b, held.id); out.expired.push(held.id);
        if (d.expiresTo) { const next = reform(b, { id: d.expiresTo, intensity: held.intensity }, d.name); if (next) next.data = { ...held.data }; }
      }
    }
  }
  return out;
}
const DOT_SCALE = 1.5;

// ---------- gate readers ----------
function statusBlocks(b, action) { return statusesOf(b).some(h => STATUSES[h.id] && (STATUSES[h.id].blocks || []).includes(action)); }
function statusMissChance(b) { let hit = 1; for (const h of statusesOf(b)) { const d = STATUSES[h.id]; if (d && d.missChance) hit *= 1 - Math.min(0.95, d.missChance * effectiveIntensity(h)); } return 1 - hit; }
function statusIncomingMissChance(b) { let hit = 1; for (const h of statusesOf(b)) { const d = STATUSES[h.id]; if (d && d.incomingMissChance) hit *= 1 - Math.min(0.9, d.incomingMissChance * effectiveIntensity(h)); } return 1 - hit; }
function consumeSkippedAction(b) { return statusesOf(b).some(h => STATUSES[h.id] && STATUSES[h.id].bar && STATUSES[h.id].bar.skip); }
function statusBarDamage(b, when) { const out = []; for (const h of statusesOf(b)) { const spec = STATUSES[h.id] && STATUSES[h.id].bar && STATUSES[h.id].bar[when]; if (spec) { const amount = spec.flat * h.intensity * DOT_SCALE; h.data.dealt = (h.data.dealt || 0) + amount; out.push({ type: spec.type, amount }); } } return out; }
function statusRetaliation(b) { const out = []; for (const h of statusesOf(b)) { const spec = STATUSES[h.id] && STATUSES[h.id].retaliate; if (spec) out.push({ type: spec.type, amount: spec.flat * h.intensity * DOT_SCALE, inflicts: spec.inflicts }); } return out; }
function magnetBypassesDodge(b, type) { for (const h of statusesOf(b)) { const mg = STATUSES[h.id] && STATUSES[h.id].magnetism; if (!mg) continue; if (mg.nullifyDodge || mg.alwaysHit.includes(type)) return true; if (R.chance(Math.min(0.95, (mg.dodgeIgnore || 0) * effectiveIntensity(h)))) return true; } return false; }
function magnetCritChance(b, type) { let bonus = 0; for (const h of statusesOf(b)) { const mg = STATUSES[h.id] && STATUSES[h.id].magnetism; if (mg && mg.critTypes.includes(type)) bonus += mg.critChancePer * effectiveIntensity(h); } return bonus; }
function consumeMagnetCharge(b) { for (const h of statusesOf(b)) { const mg = STATUSES[h.id] && STATUSES[h.id].magnetism; if (mg && mg.critDamagePerStack) { const bonus = mg.critDamagePerStack * Math.max(1, h.stacks); removeStatus(b, h.id); return bonus; } } return 0; }
function statusDisplacedExit(b) { for (const h of statusesOf(b)) { const cfg = STATUSES[h.id] && STATUSES[h.id].displaces; if (!cfg) continue; if (cfg.always || R.chance(Math.min(1, cfg.chancePer * effectiveIntensity(h)))) return cfg.to; } return null; }
function statusBlocksRangedType(b, type) { return statusesOf(b).some(h => { const w = STATUSES[h.id] && STATUSES[h.id].blocksRanged; return w && !(w.except || []).includes(type); }); }
function healAllowance(b) { let allowance = Infinity; for (const h of statusesOf(b)) { const cap = STATUSES[h.id] && STATUSES[h.id].healCap; if (cap === undefined) continue; allowance = Math.min(allowance, Math.max(0, (h.data.dealt || 0) * cap - (h.data.healed || 0))); } return allowance; }
function noteHealed(b, amount) { for (const h of statusesOf(b)) if (STATUSES[h.id] && STATUSES[h.id].healCap !== undefined) h.data.healed = (h.data.healed || 0) + amount; }
function clearStatuses(b) { b.statuses = []; }
function visibleStatuses(b) { return statusesOf(b).filter(h => STATUSES[h.id] && !STATUSES[h.id].hidden).sort((a, c) => c.intensity - a.intensity); }

// ---------- valuation (for the loadout builders) ----------
/** Damage-equivalent worth of landing a status at an intensity for its duration. */
function statusValue(id, intensity = 1, duration) {
  const d = STATUSES[id]; if (!d) return 0;
  let v = d.worth || 0;
  if (d.dot) {
    const dur = duration !== undefined && duration !== null ? duration : (d.duration == null ? 150 : d.duration);
    v += ((d.dot.flat || 0) + (d.dot.currentHp || 0) * 60 + (d.dot.maxHp || 0) * 120) * DOT_SCALE * Math.min(dur, 400);
  }
  // escalation potential
  if (d.escalatesTo && d.stacking && d.stacking.cap) v += (STATUSES[d.escalatesTo].worth || 0) * Math.min(1, intensity / d.stacking.cap) * 0.5;
  return v * Math.max(0.2, intensity);
}
const SYNERGY = [
  [['wet', 'soaked'], ['chilled'], 0.6], [['wet', 'soaked'], ['jolted'], 0.35], [['wet', 'soaked'], ['poison'], 0.35],
  [['seeded', 'rootbound'], ['on_fire'], 0.5], [['seeded', 'rootbound'], ['wet'], 0.25],
  [['magnetized', 'magnet_lock'], ['jolted'], 0.3], [['tainted'], ['on_fire', 'chilled', 'jolted', 'poison', 'corroded'], 0.25],
  [['corroded'], ['bleeding', 'concussed', 'punctured'], 0.2], [['concussed', 'dazed'], ['bleeding', 'poison', 'on_fire'], 0.15],
  [['frozen', 'chilled'], ['concussed'], 0.3],
];
/** Bonus multiplier fraction for a set of status ids that feed each other. */
function synergyBonus(ids) {
  let bonus = 0;
  for (const [a, b, w] of SYNERGY) if (a.some(x => ids.includes(x)) && b.some(x => ids.includes(x))) bonus += w;
  return bonus;
}

const ElementsAPI = { TYPES, TYPE_ICON, PHYSICAL, RESIST_CAP, MONSTER_RESIST_CAP, APPLICATION_FLOOR, ELEMENT_APTITUDE, DOT_SCALE, STAGE_ORDER, MIN_ENGINE_MULT, STATUSES, afterPenetration, resistOf, slice, statusesOf, findStatus, hasStatus, removeStatus, effectiveIntensity, statusMods, bearerResistance, bearerArmor, applyStatus, reform, escalate, fireStatusEvent, tendOnDamage, graftHarvest, tickStatuses, statusBlocks, statusMissChance, statusIncomingMissChance, consumeSkippedAction, statusBarDamage, statusRetaliation, magnetBypassesDodge, magnetCritChance, consumeMagnetCharge, statusDisplacedExit, statusBlocksRangedType, healAllowance, noteHealed, clearStatuses, visibleStatuses, statusValue, synergyBonus };
if (typeof module !== 'undefined') module.exports = ElementsAPI;
if (typeof window !== 'undefined') window.Elements = ElementsAPI;
})();
