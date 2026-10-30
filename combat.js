// Combat simulator: parties against monster formations. Browser: window.Combat. Node: module.exports.
//
// Ten ticks a second, each side on action bars. A combatant fills its bar by speed; when the bar
// is full it acts. Party members act through their prepared loadouts (martial rotation, grimoire,
// psionic workings) with the same first-eligible logic as the source game, except that WHICH kind
// of action to take is a judgement call graded by intelligence. Monsters swing their signature
// damage type and inflict their signature condition.
//
// Everything random goes through Rng (cryptographic). Crits are smoothed through Mercy's proc
// ledger keyed per combatant, so a fighter with a real crit chance does not go cold for a fight.

(() => {
const R = (typeof Rng !== 'undefined') ? Rng : require('./rng.js');
const St = (typeof Stats !== 'undefined') ? Stats : require('./stats.js');
const M = (typeof Mercy !== 'undefined') ? Mercy : require('./mercy.js');
const E = (typeof Elements !== 'undefined') ? Elements : require('./elements.js');
const Ma = (typeof Martial !== 'undefined') ? Martial : require('./martial.js');
const Sp = (typeof Spellcraft !== 'undefined') ? Spellcraft : require('./spellcraft.js');
const Ps = (typeof Psionic !== 'undefined') ? Psionic : require('./psionic.js');
const AIx = (typeof AI !== 'undefined') ? AI : require('./ai.js');
// Grade order, for the per-grade step on tag resistances. Resolved at call time: game.html loads
// missiontypes.js after this file.
const MT = () => (typeof MissionTypes !== 'undefined') ? MissionTypes : require('./missiontypes.js');
// Optional: born hybrids carry a perk (gifts.js).
const GF = () => (typeof Gifts !== 'undefined') ? Gifts : (typeof require !== 'undefined' ? require('./gifts.js') : null);
const perk = (f, id) => { const g = GF(); return !!(f.char && g && g.hasPerk(f.char, id)); };
// Optional: classes lean a fighter toward certain actions and certain throats (classes.js).
const CL = () => (typeof Classes !== 'undefined') ? Classes : (typeof require !== 'undefined' ? require('./classes.js') : null);
// Optional: how rested they were when they walked out of the gate (condition.js).
const CO = () => (typeof Condition !== 'undefined') ? Condition : (typeof require !== 'undefined' ? require('./condition.js') : null);
// Optional: what they want out of this fight, which is not the same as what they were taught to
// do in one (temper.js). A class reaches for the shield; the person decides whether to use it.
const TE = () => (typeof Temper !== 'undefined') ? Temper : (typeof require !== 'undefined' ? require('./temper.js') : null);
// Potions on the belt (consume.js): drinking is an action, hiding hides.
const CS = () => (typeof Consume !== 'undefined') ? Consume : (typeof require !== 'undefined' ? require('./consume.js') : null);
// Optional: innate abilities (facet.host.ig.js). A build that has not loaded it runs exactly as it
// did before. Once it is loaded the engine is required: Facet.install throws instead of warning,
// because a silent failure here disables the damage bound.
const FA = () => (typeof FacetHostIG !== 'undefined') ? FacetHostIG : (typeof require !== 'undefined' ? tryFacet() : null);
function tryFacet() { try { return require('./facet.host.ig.js'); } catch (e) { return null; } }
const facetsOn = (f) => (f.char && f.char.facets) || (f.def && f.def.facets) || null;

const BAR = 1000;
const MAX_TICKS = 900;      // 90 s cap for a normal-sized encounter
const MAX_TICKS_CAP = 3600; // and 6 min for any of them: a stalemate must end, a horde may not
const PARRY_CAP = 0.6;

// ---------- combatant construction ----------
function poolOf(max, regen) { return { cur: max, max, regen }; }

/** Build a party combatant from a character and its loadout plan. */
function fromCharacter(c, plan, mercyLedger) {
  // What the character can do today, gear counted: a fight is what the loadout is FOR, so the
  // stat bonus on every piece is part of the fighter, not a number printed in the inventory.
  // A meal eaten at launch (condition.js feed) adds its points for this sortie. They are added here
  // and not in Stats.effective, so town output, scouting, honing and class fitness do not read them.
  const eff = St.effective(c);
  const { base: b, derived: d } = c.meal ? St.withPoints(eff, c.meal.points) : eff;
  const wpn = c.equipment.weapon;
  const off = c.equipment.offhand;
  const qualityMult = (it) => it ? 1 + 0.2 * it.quality : 1;
  const aptMult = (k) => c.profs[k] ? 0.6 + c.profs[k].stage * 0.1 + (c.profs[k].level - 1) / 30 * 0.1 : 0.6;
  const fam = wpn ? wpn.type : 'unarmed';
  let armor = 0;
  for (const slot of ['head', 'body', 'feet']) { const it = c.equipment[slot]; if (it) armor += ({ light: 1, medium: 2, heavy: 3 })[it.type] * (1 + it.quality) * 0.8; }
  if (off) armor += (off.type === 'tower' ? 3 : off.type === 'kite' ? 2 : 1) * (1 + off.quality) * 0.5;
  const res = {};
  for (const t of E.TYPES) {
    res[t] = E.PHYSICAL.has(t) ? d.physicalResist : d.magicResist * 0.6;
    const apt = E.ELEMENT_APTITUDE[t];
    if (apt && c.profs[apt]) res[t] += c.profs[apt].stage * 0.012;
  }
  const damageType = ({ sword: 'slashing', axe: 'slashing', spear: 'piercing', bow: 'piercing', dagger: 'piercing', staff: 'bludgeoning' })[fam] || 'bludgeoning';
  return {
    id: 'p' + c.id, name: c.name, side: 'party', char: c, alive: true,
    hp: d.hp, maxHp: d.hp,
    // A fight starts with the pools the character has at the gate (condition.js). Somebody who
    // has been at the anvil all day, or who cast through the last mission and was sent straight
    // back out, opens short; that is what makes resting before a mission a decision.
    pools: (() => {
      const co = CO(), cls = CL();
      // The class and the rest apply to different fields. What the class trades for changes the
      // size of the pool, so it goes on the max: applied to `cur` alone, the first regen tick
      // clamps the bonus off again. How rested they are changes how full the pool starts, so it
      // goes on cur.
      const size = cls ? cls.poolMult(c) : 1;
      const spare = co ? Math.max(0.35, co.staminaFrac(c)) : 1;
      const full = co ? Math.max(0.2, co.poolFrac(c)) : 1;
      const mana = poolOf(d.mana * size, d.mana * size * 0.004);
      const stam = poolOf(d.stamina, d.stamina * 0.01);
      const foc = poolOf(Ps.maxFocus(b) * size, Ps.focusRegen(b) * size / 10);
      stam.cur *= spare; mana.cur *= full; foc.cur *= full;
      return { mana, stamina: stam, focus: foc };
    })(),
    base: {
      damage: (d.minDamage + d.maxDamage) / 2 * qualityMult(wpn) * aptMult(fam === 'unarmed' ? 'unarmed' : fam),
      magicDamage: d.magicDamage * (CL() ? CL().magicMult(c) : 1), speed: 40 + b.dex * 1.0, dodge: Math.min(0.5, b.dex * 0.006 + (c.equipment.body && c.equipment.body.type === 'light' ? 0.05 : 0)),
      parry: off ? 0.08 + aptMult('shield') * 0.08 : (fam === 'sword' || fam === 'dagger' ? 0.04 : 0.02),
      armor, crit: d.critChance, critDamage: d.critDamage, penetration: 0, splash: 0, staminaRegen: 1, manaRegen: 1, maxHp: 1,
    },
    res, resistCap: E.RESIST_CAP, statuses: [], bar: 0, position: 'neutral', cooldowns: {}, events: {}, prevented: {}, buffs: [],
    damageType, family: fam, plan, ledger: mercyLedger, aptitude: (k) => aptMult(k),
    potions: c.potions || (c.potions = []),      // the same array the character carries: what is drunk stays drunk
    stats: { attacks: 0, crits: 0, dodges: 0, parries: 0, hitsTaken: 0, damageDealt: 0, damageTaken: 0, healed: 0, casts: 0, techniques: 0, potions: 0 },
  };
}

/**
 * The stat block of a bestiary entry at a level: hp, the base stats and the resistances that
 * fromMonster puts on a combatant. It builds no combatant and draws no random number, so a species
 * can be rated (rating) before anything of it is spawned. `mods` is read for tierMult and rarityMult.
 */
function baseOfMonster(def, level, mods = {}) {
  const scale = (1 + 0.35 * Math.max(0, level - 1)) * (mods.tierMult || 1) * (mods.rarityMult || 1);
  const a = {}; for (const k of Object.keys(def.attrs)) a[k] = def.attrs[k] * scale;
  const armorTag = { inorganic: 3, nature: 2, ice: 4, earth: 5, construct: 6 };
  let armor = def.armor !== undefined ? def.armor : Math.max(0, ...def.tags.map(t => armorTag[t] || 0));
  armor = armor > 0 ? armor * (1 + Math.max(0, level - 1) * 0.05) : 0;
  const res = {};
  for (const t of E.TYPES) res[t] = 0;
  const TAGRES = { slime: { slashing: [0.5, 0], piercing: [0.5, 0], bludgeoning: [-0.25, 0] }, fire: { heat: [0.5, 0.1], cold: [-0.5, -0.1] }, ice: { cold: [0.5, 0.1], heat: [-0.25, -0.15] }, lightning: { lightning: [0.7, 0.1] }, water: { water: [0.4, 0], lightning: [-0.3, 0] }, earth: { earth: [0.5, 0], wind: [-0.2, 0] }, wind: { wind: [0.5, 0], earth: [-0.2, 0] }, undead: { poison: [0.6, 0], dark: [0.5, 0], light: [-0.5, 0] }, light: { light: [0.6, 0], dark: [-0.4, 0] }, dark: { dark: [0.6, 0], light: [-0.4, 0] }, incorporeal: { slashing: [0.4, 0], piercing: [0.4, 0], bludgeoning: [0.4, 0], arcane: [-0.3, 0] }, toxic: { poison: [0.7, 0] } };
  const step = MT().GRADES.indexOf(def.tier);
  for (const tag of def.tags) for (const [t, [base, per]] of Object.entries(TAGRES[tag] || {})) { const v = base + per * Math.max(0, step); if (Math.abs(v) > Math.abs(res[t])) res[t] = v; }
  if (def.resist) for (const [t, v] of Object.entries(def.resist)) res[t] = v;
  const hp = Math.max(1, Math.round((12 + a.con * 7) * 3));
  return {
    hp, res,
    base: { damage: Math.max(0.5, (1.5 + a.str * 1.1) * 2.2), magicDamage: 1.5 + a.int * 1.1, speed: Math.min(BAR / 6, (BAR / 24) * (1 + a.dex * 0.012)), dodge: Math.min(0.35, a.dex * 0.003), parry: 0, armor, crit: 0.05 + a.dex * 0.0015, critDamage: 2, penetration: 0, splash: 0, staminaRegen: 1, manaRegen: 1, maxHp: 1 },
  };
}

/** Build a monster combatant from a bestiary entry at a mission level. */
function fromMonster(def, level, mods, mercyLedger) {
  const { hp, res, base } = baseOfMonster(def, level, mods);
  return {
    id: 'm' + (fromMonster.seq = (fromMonster.seq || 0) + 1), name: (mods.prefix ? mods.prefix + ' ' : '') + def.name, icon: def.icon, side: 'enemy', def, alive: true, level,
    hp, maxHp: hp,
    pools: { mana: poolOf(0, 0), stamina: poolOf(100, 1), focus: poolOf(0, 0) },
    base,
    res, resistCap: E.MONSTER_RESIST_CAP, statuses: [], bar: R.rand() * BAR * 0.5, position: 'neutral', cooldowns: {}, events: {}, prevented: {}, buffs: [],
    damageType: def.damageType, inflicts: def.inflicts || [], mods, ledger: mercyLedger,
    stats: { attacks: 0, crits: 0, dodges: 0, parries: 0, hitsTaken: 0, damageDealt: 0, damageTaken: 0, healed: 0, casts: 0, techniques: 0 },
  };
}

// ---------- strength rating ----------
//
// One reading of how much a fighter is worth in a fight, taken from the same `base` block the fight
// uses, so field.js's odds (power x health) and combat.js's outcomes move together.
//   power  damage per tick: the larger of weapon and spell damage, times the fraction of the action
//          bar filled per tick, times the mean crit multiplier
//   guard  multiplier on hp for armour: 1 + armor / ARMOR_PER_GUARD
// Armour is a flat per-hit subtraction in elements.js slice, so a linear guard is an approximation.
// A squad with 17.4 armor (medium helm, mail and boots and a kite shield, all Fine) absorbs all of a
// level 3 forest rat's mean hit (11.5) and 21% of a level 14 goblin's (83.9). Healing, statuses and
// techniques are not in the formula.
// A squad actor's field power is RATE_K x power. A hostile's is power with no K. The odds are a ratio,
// so RATE_K is the one constant that sets how a squad's reading compares with a pack's.
// Both constants are fitted by `node test/rating.harness.js fit` (432 cells: 4 squad compositions
// x ungeared / Fine-geared x levels 3, 8, 14 x 1, 3, 5 stars x 6 packs, 16 to 32 encounters each):
//   RATE_K           the K at which the median reading of the cells with a win rate of 0.2 to 0.8 is 0.5
//   ARMOR_PER_GUARD  the divisor at which geared and ungeared cells fit the same K: at 10 the geared cells fit
//                    K 0.9 and the ungeared 1.9, at 40 they fit 1.7 and 1.9
const RATE_K = 1.8;
const ARMOR_PER_GUARD = 40;

/** { power, guard } of a combatant or of a baseOfMonster block: both carry `base`. */
function rating(f) {
  const b = f.base;
  return {
    power: Math.max(b.damage, b.magicDamage) * (b.speed / BAR) * (1 + b.crit * (b.critDamage - 1)),
    guard: 1 + b.armor / ARMOR_PER_GUARD,
  };
}

// ---------- derived stats with statuses and buffs ----------
function stats(f) {
  const s = { ...f.base };
  const mods = [...E.statusMods(f), ...f.buffs.flatMap(b => b.mods)];
  for (const mod of mods) {
    if (mod.stat.startsWith('res:')) continue;
    if (s[mod.stat] === undefined) continue;
    if (mod.op === 'add') s[mod.stat] += mod.value; else s[mod.stat] *= 1 + mod.value;
  }
  s.speed = Math.max(0, s.speed); s.dodge = Math.max(0, Math.min(0.75, s.dodge)); s.parry = Math.max(0, Math.min(PARRY_CAP, s.parry));
  s.crit = Math.max(0, Math.min(0.9, s.crit)); s.armor = Math.max(0, s.armor);
  return s;
}

// ---------- damage doors ----------
function damage(ctx, target, amount, type, source, attacker) {
  if (!target.alive || amount <= 0) return 0;
  const dealt = Math.max(1, Math.round(amount));
  target.hp -= dealt;
  target.stats.damageTaken += dealt;
  if (attacker) attacker.stats.damageDealt += dealt;
  const harvest = E.graftHarvest(target, type);
  E.tendOnDamage(target, type);
  E.fireStatusEvent(target, 'damageTaken', { damageType: type, amount: dealt });
  // The same event, to the innate abilities. It carries the frame — what type, how much, from whom —
  // because a facet that fills as it is struck needs the blow and not merely the fact of one, and
  // markEvent's ledger records only a tick.
  if (FA()) FA().event('damageTaken', target, { damageType: type, amount: dealt, attacker, source });
  if (harvest > 0) { const h = E.slice(target, 'heat', harvest * 1.5); if (h.dealt > 0) { target.hp -= Math.round(h.dealt); ctx.log(`🌳 ${target.name} burns from the roots for ${Math.round(h.dealt)}`); } }
  if (target.hp <= 0) { target.hp = 0; target.alive = false; ctx.log(`💀 ${target.name} falls (${source})`); ctx.onDeath(target, attacker, source); }
  return dealt;
}

function heal(ctx, target, amount, kind = 'spell') {
  if (!target.alive || amount <= 0) return 0;
  const allowed = Math.min(amount, E.healAllowance(target), target.maxHp - target.hp);
  const healed = Math.max(0, Math.round(allowed));
  target.hp += healed;
  target.stats.healed += healed;
  if (healed > 0) E.noteHealed(target, healed);
  E.fireStatusEvent(target, 'heal', { healKind: kind });
  return healed;
}

// The event ledger the martial reflexes already read, now also the engine's trigger surface: one
// call, and every hook a facet can listen on for free.
function markEvent(f, ev, tick) { f.events[ev] = tick; if (FA()) FA().event(ev, f, { tick }); }
function triggerOk(f, trigger, tick, target) {
  if (!trigger) return true;
  if (trigger.event) { const at = f.events[trigger.event]; if (at === undefined || tick - at > (trigger.window || Ma.EVENT_WINDOW)) return false; }
  if (trigger.cond && trigger.cond.enemyHpPct !== undefined) { if (!target || target.hp / target.maxHp * 100 > trigger.cond.enemyHpPct) return false; }
  return true;
}

// ---------- to-hit ----------
function rollHit(ctx, attacker, target, type, sure) {
  const ts = stats(target);
  if (!sure && !E.magnetBypassesDodge(target, type) && M.procChance(target.ledger, 'proc:dodge:' + target.id, ts.dodge)) {
    target.stats.dodges++; markEvent(target, 'onDodge', ctx.tick); return 'dodge';
  }
  if (R.chance(E.statusMissChance(attacker) + E.statusIncomingMissChance(target))) return 'miss';
  return 'hit';
}

function critRoll(attacker, target, type, as, bonus = 0) {
  const chance = Math.max(0, Math.min(0.95, as.crit + bonus + E.magnetCritChance(target, type)));
  return M.procChance(attacker.ledger, 'proc:crit:' + attacker.id, chance);
}

// ---------- weapon strike (plain swing or technique) ----------
function weaponStrike(ctx, attacker, target, tech) {
  const as = stats(attacker);
  const move = tech ? Ma.resolvedMove(attacker.char ? attacker.char.techniques : {}, tech) : null;
  const type = (move && move.damageType) || attacker.damageType;
  const outcome = rollHit(ctx, attacker, target, type, false);
  if (outcome !== 'hit') {
    ctx.log(`${attacker.name} ${tech ? tech.name : 'swings'} — ${target.name} ${outcome === 'dodge' ? 'dodges' : 'is missed'}`);
    return false;
  }
  // parry
  const ts = stats(target);
  if (target.side === 'party' && M.procChance(target.ledger, 'proc:parry:' + target.id, ts.parry)) {
    target.stats.parries++; markEvent(target, 'onParry', ctx.tick);
    target.prevented.onParry = as.damage * ((move && move.damageMult) || 1);
    const rip = E.slice(attacker, target.damageType, ts.damage * 0.5, 0);
    damage(ctx, attacker, rip.dealt, target.damageType, 'riposte', target);
    ctx.log(`🛡️ ${target.name} parries ${attacker.name} and cuts back for ${Math.round(rip.dealt)}`);
    return false;
  }
  let dmg = as.damage * ((move && move.damageMult) || 1);
  // Spellblade: the last spell rides this strike.
  const charged = attacker.charged && attacker.charged.until >= ctx.tick ? attacker.charged : null;
  if (charged) { dmg *= 1.25; attacker.charged = null; }
  if (move && move.preventedMult) {
    const key = tech.trigger && tech.trigger.event === 'onParry' ? 'onParry' : 'onHit';
    const stopped = attacker.prevented[key];
    if (stopped) { dmg += stopped * move.preventedMult; attacker.prevented[key] = undefined; }
  }
  if (tech) attacker.cooldowns['technique:' + tech.id] = Math.round(move.cooldown * (perk(attacker, 'mystic') && E.statusesOf(attacker).some(h => h.id.startsWith('psionic_') || h.id === 'kinetic_bulwark') ? 0.85 : 1));
  if (move && move.staminaCost) attacker.pools.stamina.cur = Math.max(0, attacker.pools.stamina.cur - attacker.pools.stamina.max * move.staminaCost);
  const pen = Math.min(0.95, as.penetration + ((move && move.penetration) || 0));
  const hits = (move && move.hits) || 1;
  let total = 0, crit = false;
  const ambush = CS() ? CS().breakCover(ctx, attacker) : false;
  for (let h = 0; h < hits; h++) {
    let hit = dmg;
    const c = ambush || critRoll(attacker, target, type, as);
    if (c) { crit = true; hit *= as.critDamage + E.consumeMagnetCharge(target); }
    hit *= 0.9 + R.rand() * 0.2;
    const landed = E.slice(target, type, hit, pen);
    total += landed.dealt;
  }
  ctx.log(`${attacker.name} ${tech ? tech.icon + ' ' + tech.name : 'hits'} ${target.name} for ${Math.max(1, Math.round(total))}${crit ? ' (crit)' : ''}${hits > 1 ? ' ×' + hits : ''}`);
  damage(ctx, target, total, type, tech ? tech.name : 'swing', attacker);
  attacker.stats.attacks++;
  if (tech) attacker.stats.techniques++;
  if (crit) { attacker.stats.crits++; markEvent(attacker, 'onCrit', ctx.tick); }
  target.stats.hitsTaken++; markEvent(target, 'onHit', ctx.tick);
  if (target.alive) for (const app of ((move && move.inflicts) || attacker.inflicts || [])) { const inst = E.applyStatus(target, app, attacker.name); if (inst) ctx.log(`  ${E.STATUSES[app.id].icon} ${target.name} is ${E.STATUSES[app.id].name.toLowerCase()}`); }
  if (charged && target.alive) { for (const app of charged.inflicts) { const inst = E.applyStatus(target, { ...app, intensity: app.intensity * 0.5 }, charged.name); if (inst) ctx.log(`  ${charged.icon} the blade carries ${charged.name}: ${target.name} is ${E.STATUSES[app.id].name.toLowerCase()}`); } }
  // retaliation from the target's conditions
  for (const r of E.statusRetaliation(target)) { const s = E.slice(attacker, r.type, r.amount, 0); damage(ctx, attacker, s.dealt, r.type, 'retaliation', target); if (r.inflicts) for (const app of r.inflicts) E.applyStatus(attacker, app); }
  // splash
  const splash = as.splash + ((move && move.splash) || 0);
  if (splash > 0) {
    const others = ctx.enemiesOf(attacker).filter(f => f !== target && f.alive);
    if (others.length) { const o = R.pick(others); const s = E.slice(o, type, dmg * splash, pen); damage(ctx, o, s.dealt, type, 'splash', attacker); }
  }
  // position
  if (tech) { attacker.position = E.statusDisplacedExit(attacker) || tech.to; attacker.stats.techniques += 0; if (attacker.char) { attacker.char.techniques = attacker.char.techniques || {}; const led = attacker.char.techniques[tech.id] || (attacker.char.techniques[tech.id] = { executions: 0 }); led.executions++; } }
  else attacker.position = 'neutral';
  return true;
}

// ---------- spells and workings ----------
function castSpell(ctx, caster, spec, targets) {
  const as = stats(caster);
  const isPsi = spec.school === 'psionic';
  const oracle = perk(caster, 'oracle') ? 0.85 : 1;
  if (isPsi) caster.pools.focus.cur -= spec.focusCost * oracle; else caster.pools.mana.cur -= spec.manaCost * oracle;
  if (perk(caster, 'spellblade') && spec.strikes.length && spec.strikes[0].inflicts) caster.charged = { name: spec.name, icon: spec.icon, inflicts: spec.strikes[0].inflicts, until: ctx.tick + 40 };
  caster.cooldowns[spec.key] = spec.cooldown;
  caster.stats.casts++;
  const share = spec.target === 'others' ? Sp.OTHERS_POWER : 1;
  const seenAlt = new Map();
  // A class feature scales with whatever the character is actually good at: a Butcher's Hack
  // Apart is a weapon blow with the class's name on it, not a spell a Butcher cannot cast.
  const base = spec.feature ? Math.max(as.damage, as.magicDamage) : as.magicDamage;
  const power = (type) => { const apt = E.ELEMENT_APTITUDE[type]; return base * (apt && caster.aptitude ? (0.7 + caster.aptitude(apt) * 0.5) : 1); };
  let mainRaw = 0;
  for (const target of targets) {
    let prevLanded = true, total = 0;
    for (const strike of spec.strikes) {
      if (strike.altGroup != null) { if (!seenAlt.has(strike.altGroup)) seenAlt.set(strike.altGroup, R.chance(0.5) ? strike : null); const chosen = seenAlt.get(strike.altGroup); if (chosen !== strike && chosen !== null) continue; if (chosen === null) { seenAlt.set(strike.altGroup, strike); } }
      if (strike.onlyIf && !strike.onlyIf.some(id => E.hasStatus(target, id))) { prevLanded = false; continue; }
      const follow = strike.followUp && prevLanded ? strike.followUp : 1;
      const hits = strike.hits || 1;
      let landedAny = false;
      for (let h = 0; h < hits; h++) {
        if (!spec.sure && rollHit(ctx, caster, target, strike.type, false) !== 'hit') continue;
        const critted = critRoll(caster, target, strike.type, as, strike.critBonus || 0);
        const critMult = critted ? Math.max(1, as.critDamage + (strike.critDamageBonus || 0) + E.consumeMagnetCharge(target)) : 1;
        let type = strike.type;
        if (strike.orType && E.bearerResistance(target, strike.orType) < E.bearerResistance(target, type)) type = strike.orType;
        const raw = power(type) * strike.power * share * follow * critMult * (0.9 + R.rand() * 0.2);
        const landed = strike.untyped ? { dealt: raw } : E.slice(target, type, raw, Math.min(0.95, as.penetration + (strike.penetration || 0)));
        if (targets[0] === target) mainRaw += raw;
        if (landed.dealt > 0) { landedAny = true; total += landed.dealt; for (const app of (strike.inflicts || [])) E.applyStatus(target, app, spec.name); }
        if (critted) caster.stats.crits++;
      }
      prevLanded = landedAny;
    }
    if (total > 0 || (spec.afflicts && spec.afflicts.length)) ctx.log(`${caster.name} ${spec.icon} ${spec.name} → ${target.name}${total > 0 ? ' for ' + Math.round(total) : ''}`);
    if (total > 0) damage(ctx, target, total, spec.strikes[0] ? spec.strikes[0].type : 'arcane', spec.name, caster);
    for (const app of (spec.afflicts || [])) E.applyStatus(target, app, spec.name);
  }
  if (spec.splash > 0 && spec.target !== 'others') {
    const others = ctx.enemiesOf(caster).filter(f => f !== targets[0] && f.alive);
    if (others.length) { const o = R.pick(others); const s = E.slice(o, spec.strikes[0] ? spec.strikes[0].type : 'arcane', mainRaw * spec.splash, 0); damage(ctx, o, s.dealt, 'arcane', spec.name + ' splash', caster); }
  }
  const mystic = perk(caster, 'mystic') ? 1.5 : 1;
  for (const g of (spec.grants || [])) E.applyStatus(caster, mystic > 1 && g.duration ? { ...g, duration: Math.round(g.duration * mystic) } : g, spec.name, false);
  if (spec.buff) caster.buffs.push({ name: spec.buff.name, mods: spec.buff.mods.map(md => md.stat.startsWith('res:') ? md : md), ticksLeft: spec.buff.duration });
  if (spec.heal) {
    const amount = spec.heal * base;
    const who = spec.target === 'self' || !spec.healsEnemy ? (isPsi ? caster : lowestAlly(ctx, caster)) : targets[0];
    const healed = heal(ctx, who, amount);
    if (healed > 0) ctx.log(`${caster.name} ${spec.icon} ${spec.name} heals ${who.name} for ${healed}`);
  }
}
function lowestAlly(ctx, f) { const allies = ctx.alliesOf(f).filter(a => a.alive); return allies.sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0] || f; }

// ---------- action choice ----------
/** Every action a party member could take right now, with a rough value each. */
function options(ctx, f, target) {
  const out = [];
  const as = stats(f);
  const led = f.char ? (f.char.techniques || {}) : {};
  // Behind the line there is nothing within arm's reach to hit, so the blade options are not
  // offered at all — a bow is the exception, which is what a bow is for.
  if (!E.statusBlocks(f, 'attack') && !(f.rank === 'reserve' && f.family !== 'bow')) {
    for (const id of (f.plan.rotation || [])) {
      const def = Ma.TECHNIQUES[id]; if (!def || def.move.counter || def.move.damageMult === undefined) continue;
      if ((f.cooldowns['technique:' + id] || 0) > 0) continue;
      if (!triggerOk(f, def.trigger, ctx.tick, target)) continue;
      if (!Ma.admits(led, def, f.position)) continue;
      const mv = Ma.resolvedMove(led, def);
      out.push({ kind: 'technique', def, value: as.damage * mv.damageMult * (mv.hits || 1) * (1 + (mv.inflicts ? 0.3 : 0)) * (1 + (mv.splash || 0) * 0.5) });
    }
    out.push({ kind: 'swing', value: as.damage });
  }
  if (!E.statusBlocks(f, 'spell')) {
    const profile = ctx.profileOf(f);
    for (const spec of (f.plan.spells || [])) {
      if ((f.cooldowns[spec.key] || 0) > 0 || f.pools.mana.cur < spec.manaCost) continue;
      const v = Sp.castValue(spec, { derived: { magicDamage: as.magicDamage, critChance: as.crit, critDamage: as.critDamage } }, profile);
      const heals = spec.heal && !spec.healsEnemy;
      const need = heals ? 1 - lowestAlly(ctx, f).hp / lowestAlly(ctx, f).maxHp : 0;
      out.push({ kind: 'spell', spec, heal: !!heals, value: heals ? v.heal * need * 2 : v.total });
    }
    for (const spec of (f.plan.workings || [])) {
      if ((f.cooldowns[spec.key] || 0) > 0 || f.pools.focus.cur < spec.focusCost) continue;
      const v = Ps.castValue(spec, { derived: { magicDamage: as.magicDamage, critChance: as.crit, critDamage: as.critDamage } }, profile);
      const selfy = (spec.grants && spec.grants.length) || spec.heal;
      const already = spec.grants && spec.grants.every(g => E.hasStatus(f, g.id));
      out.push({ kind: 'spell', spec, heal: !!spec.heal, value: already ? v.damage : v.total * (selfy ? 1.2 : 1) });
    }
  }
  // ...and the belt: a potion is an action too, weighed like the rest
  const cs = CS();
  if (cs && f.char) out.push(...cs.options(ctx, f, as));
  // Class features: the same shape as a spell and cast by the same code, but paid for from
  // whichever pool their school names, and never blocked by having no lexicon.
  if (!E.statusBlocks(f, 'spell')) {
    const profile = ctx.profileOf(f);
    for (const spec of (f.plan.features || [])) {
      if ((f.cooldowns[spec.key] || 0) > 0) continue;
      if (spec.school === 'psionic' ? f.pools.focus.cur < spec.focusCost : f.pools.mana.cur < spec.manaCost) continue;
      // valued on the same base it will be cast from (castSpell): the better of blade and spell
      const v = Sp.castValue(spec, { derived: { magicDamage: Math.max(as.damage, as.magicDamage), critChance: as.crit, critDamage: as.critDamage } }, profile);
      const heals = spec.heal > 0;
      const need = heals ? 1 - lowestAlly(ctx, f).hp / lowestAlly(ctx, f).maxHp : 0;
      const selfy = (spec.grants && spec.grants.length) || spec.buff;
      const already = spec.buff && f.buffs.some(b => b.name === spec.buff.name);
      // a feature is what the class is for: it is reached for a little ahead of a composed spell
      // its own KIND, so a class that leans away from spells (a Butcher's act.spell is 0.3) is not
      // talked out of the one thing it is for; act() casts anything that is not a swing or a potion
      out.push({ kind: 'feature', spec, heal: heals, value: already ? v.damage * 0.5 : (heals ? v.heal * need * 2 : v.total * (selfy ? 1.3 : 1.15)) });
    }
  }
  // What a class REACHES FOR. A Warden's hand goes to the shield and an Elemental Mage's to a
  // word, before either of them has thought about it. It is a lean on the value of each kind of
  // action, not a rule: a bad option that the class likes is still a bad option.
  const cl = CL();
  if (cl && f.char) for (const o of out) o.value *= cl.actMult(f.char, o.heal ? 'heal' : o.kind);
  // ...and then what the PERSON reaches for, which is a different question. Two Wardens with the
  // same standing orders do not fight the same, because one of them wants the fight over and the
  // other wants everybody to come home, and the shield is worth different things to each.
  const te = TE();
  if (te && f.char) for (const o of out) o.value *= te.actLean(f.char, o.kind, !!o.heal);
  // Events earlier in the mission. `resolve` is set by the field when somebody goes down
  // (field.js, tactics.js): a character who hardened over a friend reaches for the attack and one
  // who is shaken reaches for cover. It is temporary, it belongs to this mission, and it is the
  // only input in this function that was not true when they walked through the gate.
  const res = f.resolve || 0;
  if (res) for (const o of out) o.value *= o.heal ? 1 - 0.22 * res : 1 + 0.28 * res;
  // NERVE, at the moment it is asked for. A class carries a figure for how hurt it keeps swinging
  // (classes.js), and the character bends it: past that line the hands go to whatever keeps them
  // alive, and a fearless one never reaches the line at all. This is where a Berserker and a
  // craven Berserker finally stop being the same fighter.
  if (te && f.char && f.maxHp) {
    // grief moves the line too: they will bleed further for somebody than they would for a job
    const line = Math.max(0.02, (1 - te.holds(f.char, cl ? cl.nerve(f.char) : 0.7)) * (1 - 0.5 * res));
    const hurt = f.hp / f.maxHp;
    if (hurt < line) {
      const fear = 1 + (line - hurt) / Math.max(0.05, line);   // 1 at the line, 2 at nothing left
      for (const o of out) o.value *= o.heal ? fear : 1 / fear;
    }
  }
  return out;
}

function chooseAction(ctx, f, target) {
  const opts = options(ctx, f, target);
  if (!opts.length) return null;
  const t = f.char ? AIx.tier(f.char) : AIx.TIERS[2];
  if (t.id === 'dim') return R.pick(opts);
  if (t.id === 'plain') return R.weightedPick(opts, o => Math.max(0.01, o.value));
  return opts.reduce((a, b) => (b.value * (1 + t.noise * R.jitter()) > a.value ? b : a));
}

/** How badly `f` wants `e` dead, under a class's standing orders. Higher is a better target. */
function targetScore(pref, f, e) {
  switch (pref) {
    case 'wounded':   return -(e.hp / e.maxHp);
    case 'strongest': return e.base.damage + e.base.magicDamage;
    case 'caster':    return (e.base.magicDamage > e.base.damage ? 1e6 : 0) - e.hp;
    case 'spread':    return R.rand();
    default:          return -(e.hp * (1 - E.bearerResistance(e, f.damageType) * 0.5));
  }
}

function pickTarget(ctx, f) {
  let enemies = ctx.enemiesOf(f).filter(e => e.alive);
  if (!enemies.length) return null;
  // Only what is standing on the line can be swung at. The queue behind it is reachable by area
  // damage and by nothing else, which is the whole answer to a horde: kill the queue, not the
  // front rank, or you are cutting at a thing that grows back.
  const online = enemies.filter(e => e.rank !== 'reserve');
  if (online.length) enemies = online;
  const cl = CL();
  const te = TE();
  if (f.side === 'enemy') {
    if (CS()) enemies = CS().visible(enemies, ctx.tick);
    const taunter = enemies.find(e => E.hasStatus(e, 'taunted') && E.findStatus(e, 'taunted').source === f.id);
    if (taunter) return taunter;
    // the front of the party draws most of the attention, and a class is what decides who that
    // is: a Warden standing in front of a Cleric is what keeps either of them alive.
    // Nerve then moves people out of the rank they were put in: a fearless Cleric drifts forward
    // and gets hit for it, and a craven Warden is somehow always behind somebody.
    return R.weightedPick(enemies, (e) => (cl && e.char ? cl.drawWeight(e.char) : 1) * (te && e.char ? te.stand(e.char) : 1));
  }
  const t = f.char ? AIx.tier(f.char) : AIx.TIERS[2];
  let pref = cl && f.char ? cl.targetPriority(f.char) : null;
  // A character who feels strongly enough ignores its orders. That is what an extreme axis IS:
  // the bloodthirsty Cleric goes for the throat and gets told off about it afterwards.
  if (te && f.char) pref = te.targetWant(f.char, pref);
  // no orders and nothing upstairs: swing at whatever is in front of it
  if (t.id === 'dim' && !pref) return R.pick(enemies);
  // otherwise the class's orders, or — unclassed — the weakest, weighed by how well the
  // character's own damage type gets through
  const scored = enemies.map(e => ({ e, s: targetScore(pref, f, e) }));
  return scored.sort((a, b) => b.s - a.s)[0].e;
}

// ---------- frontage ----------
//
// Frontage: how many enemies can reach a fighter at once. Damage taken here is linear in the
// number of enemies that can swing, so without a cap a horde is not a hard fight, it is an
// instant one: forty rats put forty attacks a round into four people and no amount of area
// damage is ever cast in time to matter. `frontage` is how wide the ground is. Everyone who does
// not fit on it waits.
//
// Waiting means the fighter cannot be picked as a single target and does not act, unless what it
// does reaches. That is what makes a chokepoint a decision rather than a free win: it cuts their
// numbers and yours by the same rule, and it pays only when they have forty and you have four.
// The cleric behind the shield still heals; the second swordsman does not attack.
//
// The two sides hold the line differently, by design. A squad relieves its line: whoever is hurt
// drifts back and someone fresher takes the spot, so the same weighting that decides who draws a
// monster's attention (classes.js drawWeight, temper.js stand) decides who is standing where,
// bent by how whole they still are. A horde does not organise: it presses, and a gap in it opens
// only when something in it dies.

const FRONTAGE_OPEN = 8;       // open ground: everyone who wants in gets in
const RELIEF_EVERY = 10;       // ticks between the squad re-forming its line
// Room on the line, by size. Small things pack a little tighter, not twice as tight: at a half
// slot each, a doorway let FOUR goblins at two characters and a chokepoint became a trap against
// exactly the swarm it is supposed to answer.
const BULK = { small: 0.75, large: 2, huge: 3 };

/** How much of the line one body takes up. Six rats stand where three boars do. */
function bulkOf(f) {
  const tags = (f.def && f.def.tags) || [];
  let b = null;
  for (const t of tags) if (BULK[t] !== undefined) b = b === null ? BULK[t] : Math.max(b, BULK[t]);
  return b === null ? 1 : b;
}

/**
 * Can this fighter do anything from the second rank? Anyone whose reach is longer than an arm:
 * a bow, a word, a working, a class feature. A monster reaches when what it hits with is not
 * physical — a fire slime spits over the pack, a wolf waits its turn.
 */
function reaches(f) {
  if (f.def) return !E.PHYSICAL.has(f.damageType);
  if (f.family === 'bow') return true;
  const p = f.plan || {};
  return !!((p.spells || []).length || (p.workings || []).length || (p.features || []).length);
}

/** Who belongs at the front: who draws the attention, and who is still whole enough to hold it. */
function lineScore(f) {
  if (!f.char) return f.base.damage + f.base.magicDamage;
  const cl = CL(), te = TE();
  const draw = cl ? cl.drawWeight(f.char) : 1;
  const nerve = te ? te.stand(f.char) : 1;
  return draw * nerve * (0.15 + 0.85 * Math.max(0, f.hp / f.maxHp));
}

/**
 * Mark who is on the line and who is behind it. `hold` keeps whoever is already there and only
 * fills the gaps; without it the line is re-formed from scratch by who belongs at the front now.
 * Somebody is always on the line, even when one body is wider than the whole gap.
 */
function formRanks(side, frontage) {
  const alive = [];
  for (const f of side) { if (f.alive) alive.push(f); else f.rank = 'down'; }
  if (!alive.length) return;
  const held = (f) => (f.rank === 'front' ? 0 : 1);
  const order = alive.sort((a, b) => (frontage.hold ? held(a) - held(b) : 0) || lineScore(b) - lineScore(a));
  let room = frontage.width;
  for (const f of order) {
    const b = bulkOf(f);
    if (f === order[0] || room >= b) { f.rank = 'front'; room -= b; }
    else f.rank = 'reserve';
  }
}

/**
 * What the ground allows, per side. A caller that knows where the fight is happening says so
 * (sortie.js reads it off the tiles); one that does not gets open ground and the old behaviour.
 */
function frontageOf(opts) {
  const f = opts.frontage;
  const w = (v) => Math.max(1, v === undefined || v === null ? FRONTAGE_OPEN : v);
  if (f && typeof f === 'object') return { party: { width: w(f.party), hold: false }, enemy: { width: w(f.enemy), hold: true } };
  return { party: { width: w(f), hold: false }, enemy: { width: w(f), hold: true } };
}

// ---------- the encounter ----------
function act(ctx, f) {
  if (E.consumeSkippedAction(f)) { E.fireStatusEvent(f, 'barFill'); ctx.log(`${f.name} is dazed and loses the action`); return; }
  E.fireStatusEvent(f, 'barFill');
  for (const bd of E.statusBarDamage(f, 'onFill')) { const s = E.slice(f, bd.type, bd.amount, 0); damage(ctx, f, s.dealt, bd.type, E.STATUSES.jolted.name); }
  if (!f.alive) return;
  const target = pickTarget(ctx, f);
  if (!target) return;
  if (f.side === 'enemy') { weaponStrike(ctx, f, target, null); return; }
  const choice = chooseAction(ctx, f, target);
  if (!choice) return;
  if (choice.kind === 'potion') { CS().drink(ctx, f, choice); return; }
  if (choice.kind === 'swing') weaponStrike(ctx, f, target, null);
  else if (choice.kind === 'technique') weaponStrike(ctx, f, target, choice.def);
  else {
    const spec = choice.spec;
    const targets = spec.target === 'others' ? ctx.enemiesOf(f).filter(e => e.alive) : spec.target === 'self' ? [f] : [target];
    castSpell(ctx, f, spec, spec.target === 'self' ? [] : targets);
  }
}

/** Off-bar reflexes: buff techniques fire the moment they are eligible. */
function reflexes(ctx, f) {
  if (f.side !== 'party') return;
  const led = f.char.techniques || {};
  for (const id of (f.plan.rotation || [])) {
    const def = Ma.TECHNIQUES[id]; if (!def || def.move.damageMult !== undefined || def.move.counter) continue;
    if ((f.cooldowns['technique:' + id] || 0) > 0) continue;
    if (!triggerOk(f, def.trigger, ctx.tick, null) || !Ma.admits(led, def, f.position)) continue;
    const mv = Ma.resolvedMove(led, def);
    if (mv.buff) f.buffs.push({ name: def.name, mods: mv.buff.mods, ticksLeft: mv.buff.duration });
    f.cooldowns['technique:' + id] = mv.cooldown;
    f.position = def.to;
    f.stats.techniques++;
    const l = led[id] || (led[id] = { executions: 0 }); l.executions++;
    ctx.log(`${f.name} ${def.icon} ${def.name}`);
  }
}

function tickFighter(ctx, f) {
  if (!f.alive) return;
  const rep = E.tickStatuses(f, { inCombat: true });
  let dot = 0; for (const d of rep.damage) dot += d.amount;
  if (dot > 0) { const before = f.hp; damage(ctx, f, dot, rep.damage[0].type, 'conditions'); if (!f.alive) return; f.stats.dotTaken = (f.stats.dotTaken || 0) + (before - f.hp); }
  for (const d of rep.drains) if (f.pools[d.resource]) f.pools[d.resource].cur = Math.max(0, f.pools[d.resource].cur - d.amount * f.pools[d.resource].max);
  for (const b of f.buffs) b.ticksLeft--; f.buffs = f.buffs.filter(b => b.ticksLeft > 0);
  for (const k of Object.keys(f.cooldowns)) if (f.cooldowns[k] > 0) f.cooldowns[k]--;
  const s = stats(f);
  for (const [k, p] of Object.entries(f.pools)) p.cur = Math.min(p.max, p.cur + p.regen * (k === 'stamina' ? s.staminaRegen : k === 'mana' ? s.manaRegen : 1));
  if (FA()) FA().tick(f);
  reflexes(ctx, f);
  f.bar += s.speed;
  if (f.bar >= BAR) {
    // waiting for a gap: the bar stays full, so they swing the moment one opens
    if (f.rank === 'reserve' && !reaches(f)) { f.bar = BAR; return; }
    f.bar -= BAR; act(ctx, f);
  }
}

/**
 * Run one encounter to its end. party/enemies are combatant arrays. Returns
 * { won, ticks, log, kills, falls, timedOut, broke }. Party statuses that end at combat end are cleared.
 * `kills` lists the enemies that died; `falls` lists the party members that died, one row each:
 * { id: character id or null, name, by: name of the combatant whose damage dropped them to 0 hp
 * or null when no attacker was named (conditions), byId: that combatant's species id or null,
 * source: the swing, technique, spell or effect that did it }.
 */
function encounter(party, enemies, opts = {}) {
  const log = [];
  const kills = [];
  const falls = [];
  const ctx = {
    tick: 0, log: (s) => { if (log.length < 400) log.push(s); },
    enemiesOf: (f) => (f.side === 'party' ? enemies : party), alliesOf: (f) => (f.side === 'party' ? party : enemies),
    onDeath: (t, killer, source) => {
      reform = true;
      if (t.side === 'enemy') kills.push({ def: t.def, mods: t.mods, killer });
      else falls.push({ id: t.char ? t.char.id : null, name: t.name, by: killer ? killer.name : null, byId: killer && killer.def ? killer.def.id : null, source: source || null });
    },
    profileOf: (f) => profileOf(f.side === 'party' ? enemies : party),
  };
  // Attaching here rather than in fromCharacter/fromMonster is one line instead of two and covers
  // both, and it is also the only place that has the ctx a facet's scope resolution needs. The
  // engine keeps its own per-tier reset table, which is why this line does not have to grow every
  // time something new needs clearing — the way this one already forgot `charged`.
  const fa = FA();
  if (fa) fa.setContext(ctx);
  for (const f of [...party, ...enemies]) { f.position = 'neutral'; f.events = {}; markEvent(f, 'onEncounterStart', 0); f.cooldowns = {}; f.prevented = {}; f.rank = null; if (CS()) CS().resetEncounter(f); if (fa) fa.attach(f, facetsOn(f)); }
  for (const f of party) f.bar = BAR * 0.6;
  // Everyone who does not fit on the line waits behind it; see frontage above. With no frontage
  // given this is open ground and every fighter is on the line, which is what a zone encounter of
  // three wolves has always been.
  const front = frontageOf(opts);
  let reform = true;
  // A WAY OUT. `opts.breakOff(ctx, party, enemies)` is asked after every tick, and the moment it
  // answers the fight stops where it stands: nobody has won, whoever is up is still up, and what
  // happens to them next is the caller's business (field.js puts them somewhere else). It is the
  // one thing a fight resolved in advance could never do before — leave — and with permadeath it
  // is worth more than any spell in here.
  let broke = null;
  // The cap is here so a stalemate cannot run forever, not to say how long a fight is allowed to
  // be. Forty bodies on the field is legitimately a longer fight than four, and cutting it off at
  // ninety seconds would report a squad that was winning as a squad that achieved nothing.
  const cap = Math.min(MAX_TICKS_CAP, Math.max(MAX_TICKS, Math.round(MAX_TICKS * (party.length + enemies.length) / 8)));
  while (ctx.tick < cap) {
    ctx.tick++;
    // the squad re-forms on a beat (relief) and both sides re-form the moment a body drops
    if (reform || ctx.tick % RELIEF_EVERY === 0) { formRanks(party, front.party); formRanks(enemies, front.enemy); reform = false; }
    for (const f of party) tickFighter(ctx, f);
    for (const f of enemies) tickFighter(ctx, f);
    if (!party.some(f => f.alive) || !enemies.some(f => f.alive)) break;
    if (opts.breakOff && (broke = opts.breakOff(ctx, party, enemies) || null)) { log.push(broke.line || 'they break off'); break; }
  }
  const won = !broke && party.some(f => f.alive) && !enemies.some(f => f.alive);
  for (const f of party) { E.fireStatusEvent(f, 'combatEnd'); f.buffs = []; if (FA()) FA().tierEnd('encounter', f); }
  return { won, ticks: ctx.tick, log, kills, falls, timedOut: !broke && ctx.tick >= cap, broke };
}

/** Enemy profile for the loadout builders: resistances averaged, count, hp ratio. */
function profileOf(enemies) {
  const alive = enemies.filter(e => e.alive);
  if (!alive.length) return { resist: {}, count: 0, hp: 0 };
  const resist = {};
  for (const t of E.TYPES) resist[t] = alive.reduce((a, e) => a + E.bearerResistance(e, t), 0) / alive.length;
  return { resist, count: alive.length, hp: alive.reduce((a, e) => a + e.maxHp, 0) / alive.length };
}

const CombatAPI = { BAR, MAX_TICKS, MAX_TICKS_CAP, FRONTAGE_OPEN, BULK, RATE_K, ARMOR_PER_GUARD, fromCharacter, fromMonster, baseOfMonster, rating, stats, encounter, damage, heal, profileOf, weaponStrike, castSpell, options, pickTarget, targetScore, bulkOf, reaches, lineScore, formRanks };
if (typeof module !== 'undefined') module.exports = CombatAPI;
if (typeof window !== 'undefined') window.Combat = CombatAPI;
})();
