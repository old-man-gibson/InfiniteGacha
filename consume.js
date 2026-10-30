// Consume: potions that get drunk. Browser: window.Consume. Node: module.exports.
//
// A party member carries up to three potions (outfit.js packs them by role). In a fight, drinking
// one is an ACTION like any other — it costs the bar, and it competes on value with swinging and
// casting, so a healer at full health does not waste a turn on a healing potion and a berserker at
// a sliver of hp does not swing when there is a potion in the belt. What is drunk is gone from the
// character for good; the town packs a fresh one after the mission.
//
// Effects, scaled by the potion's power (Standard 20, Legendary 70):
//   healing       restores power × 1.5 % of max hp
//   mana          restores power × 1.5 % of max mana
//   stamina       restores power × 1.5 % of max stamina
//   antidote      clears every harmful condition
//   invisibility  hidden for 20 + power ticks: enemies cannot target you, and the first strike
//                 out of hiding is an ambush that always crits

(() => {
const E = () => (typeof Elements !== 'undefined') ? Elements : require('./elements.js');

const RESTORE = 0.015;           // fraction per point of power
const HEAL_LINE = 0.6;           // start weighing a healing potion below this hp fraction
const POOL_LINE = 0.3;           // start weighing mana / stamina below this fraction

const held = (f) => (f.potions || []);
const hpFrac = (f) => f.maxHp ? f.hp / f.maxHp : 1;
const poolFrac = (f, k) => (f.pools && f.pools[k] && f.pools[k].max) ? f.pools[k].cur / f.pools[k].max : 1;
const harmful = (f) => (f.statuses || []).filter(s => { const d = E().STATUSES[s.id]; return d && !d.buff; });
const isHidden = (f, tick) => !!(f.hiddenUntil && f.hiddenUntil > tick);

/**
 * Potion options for `f` right now, valued against `as` (its current stats block).
 * One option per distinct potion effect; the best quality of each is what gets offered.
 */
function options(ctx, f, as) {
  const out = [];
  const best = {};
  for (const p of held(f)) if (!best[p.effect] || p.power > best[p.effect].power) best[p.effect] = p;
  for (const p of Object.values(best)) {
    let value = 0;
    if (p.effect === 'hp') {
      const frac = hpFrac(f);
      if (frac < HEAL_LINE) {
        const amount = Math.min(f.maxHp - f.hp, f.maxHp * p.power * RESTORE);
        value = amount * (1 - frac) * 3;                       // dying is expensive
      }
    } else if (p.effect === 'mana') {
      const spells = (f.plan && f.plan.spells) || [];
      if (spells.length && poolFrac(f, 'mana') < POOL_LINE) value = as.magicDamage * 2;
    } else if (p.effect === 'stamina') {
      const rot = (f.plan && f.plan.rotation) || [];
      if (rot.length && poolFrac(f, 'stamina') < POOL_LINE) value = as.damage * 1.2;
    } else if (p.effect === 'cure') {
      const bad = harmful(f);
      if (bad.length) value = bad.reduce((a, s) => a + ((E().STATUSES[s.id].worth || 2) * 3), 0);
    } else if (p.effect === 'stealth') {
      if (!isHidden(f, ctx.tick) && !f.usedStealth) {
        const role = f.char && typeof Outfit !== 'undefined' ? Outfit.roleOf(f.char) : null;
        value = as.damage * (role === 'assassin' ? 1.8 : hpFrac(f) < 0.5 ? 1.2 : 0.4);
      }
    }
    if (value > 0) out.push({ kind: 'potion', item: p, value });
  }
  return out;
}

/** Drink it. Removes the potion from the character's belt for good. */
function drink(ctx, f, choice) {
  const p = choice.item;
  const belt = held(f);
  const i = belt.indexOf(p);
  if (i >= 0) belt.splice(i, 1);
  f.stats.potions = (f.stats.potions || 0) + 1;
  if (p.effect === 'hp') {
    const amount = Math.min(f.maxHp - f.hp, Math.round(f.maxHp * p.power * RESTORE));
    f.hp += amount; f.stats.healed += amount;
    ctx.log(`🧪 ${f.name} drinks a ${p.name} and recovers ${amount} hp`);
  } else if (p.effect === 'mana' || p.effect === 'stamina') {
    const pool = f.pools[p.effect];
    const amount = Math.min(pool.max - pool.cur, Math.round(pool.max * p.power * RESTORE));
    pool.cur += amount;
    ctx.log(`🧪 ${f.name} drinks a ${p.name} and recovers ${amount} ${p.effect}`);
  } else if (p.effect === 'cure') {
    const bad = harmful(f);
    for (const s of bad) E().removeStatus(f, s.id);
    ctx.log(`🧪 ${f.name} drinks a ${p.name}${bad.length ? ' and shakes off ' + bad.map(s => E().STATUSES[s.id].name.toLowerCase()).join(', ') : ''}`);
  } else if (p.effect === 'stealth') {
    f.hiddenUntil = ctx.tick + 20 + p.power;
    f.usedStealth = true;
    ctx.log(`🧪 ${f.name} drinks a ${p.name} and vanishes`);
  }
}

/** Enemies pick targets from those they can see; a party that is entirely hidden is still hit. */
function visible(fighters, tick) {
  const seen = fighters.filter(f => !isHidden(f, tick));
  return seen.length ? seen : fighters;
}

/** Called at the top of a strike: an attacker striking from hiding is revealed and ambushes. Returns true on ambush. */
function breakCover(ctx, f) {
  if (!isHidden(f, ctx.tick)) return false;
  f.hiddenUntil = 0;
  ctx.log(`🗡️ ${f.name} strikes from hiding`);
  return true;
}

/** Wipe encounter-scoped state so a new encounter starts clean (potions stay drunk). */
function resetEncounter(f) { f.hiddenUntil = 0; f.usedStealth = false; }

const ConsumeAPI = { RESTORE, HEAL_LINE, POOL_LINE, options, drink, isHidden, visible, breakCover, resetEncounter };
if (typeof module !== 'undefined') module.exports = ConsumeAPI;
if (typeof window !== 'undefined') window.Consume = ConsumeAPI;
})();
