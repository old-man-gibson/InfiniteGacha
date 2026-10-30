// Outfit: what established teams carry, and how the town keeps them supplied.
// Browser: window.Outfit. Node: module.exports.
//
// Three jobs, all for characters who are on a saved team (see crew.js):
//   DEMAND.   With no player request at the smithy or lab, crafts go to what team members are
//             missing or could upgrade, in the gear types they have CHOSEN. A character chooses
//             from what it knows: its preference is obvious, its true compatibility is not, but
//             training with a type reveals what it feels like, so a discovered fit wins when it
//             grows faster than the old favourite.
//   EQUIP.    When better gear for the chosen type is in stock, team members take it and hand the
//             old piece back.
//   POTIONS.  Three potion slots per member, filled by role: healing for everyone but frontliners
//             first, mana for casters, invisibility for assassins, spread round-robin so one
//             member never hoards what the whole team needs.

(() => {
const A = () => (typeof Affinity !== 'undefined') ? Affinity : require('./affinity.js');
const E = () => (typeof Econ !== 'undefined') ? Econ : require('./economy.js');
const ST = () => (typeof Stats !== 'undefined') ? Stats : require('./stats.js');
// Optional: a class says outright what a character is for (classes.js).
const CL = () => (typeof Classes !== 'undefined') ? Classes : (typeof require !== 'undefined' ? require('./classes.js') : null);

const POTION_SLOTS = 3;
const UPGRADE_BELOW = 2;    // team members ask the smithy for a replacement while their piece is below Fine

// ---------- roles ----------
const ROLES = {
  frontline: { label: 'Frontline', icon: '🛡️', needs: ['healing', 'healing', 'stamina'] },
  caster:    { label: 'Caster',    icon: '🔮', needs: ['mana', 'mana', 'healing'] },
  assassin:  { label: 'Assassin',  icon: '🗡️', needs: ['invisibility', 'invisibility', 'healing'] },
  ranged:    { label: 'Ranged',    icon: '🏹', needs: ['healing', 'stamina', 'healing'] },
  support:   { label: 'Support',   icon: '✨', needs: ['healing', 'mana', 'antidote'] },
};

/** The class if it has one, then the weapon, then the biggest stat. */
function roleOf(c) {
  const cl = CL();
  const taught = cl && cl.roleOf(c);
  if (taught) return taught;
  const w = c.equipment && c.equipment.weapon;
  const fam = w ? w.type : null;
  if (fam === 'staff') return 'caster';
  if (fam === 'dagger') return 'assassin';
  if (fam === 'bow') return 'ranged';
  const b = ST().effective(c).base;
  const top = ['str', 'dex', 'con', 'int', 'wis', 'cha'].reduce((a, k) => (b[k] > b[a] ? k : a), 'str');
  if (fam === 'sword' || fam === 'axe' || fam === 'spear') return top === 'int' ? 'caster' : 'frontline';
  if (top === 'int') return 'caster';
  if (top === 'dex') return 'assassin';
  if (top === 'wis' || top === 'cha') return 'support';
  return 'frontline';
}

// ---------- teams ----------
function teamMembers(state) {
  const ids = new Set();
  for (const t of state.teams || []) for (const id of t.members) ids.add(id);
  return state.characters.filter(c => ids.has(c.id));
}

// ---------- gear ----------
const PIECE = { head: 'helm', body: 'mail', feet: 'boots' };

/** The item key a character wants in a slot, given the types it has chosen. */
function wantedKey(c, slot) {
  const a = A();
  if (slot === 'weapon') return a.choose(c.affinity, 'weapon');
  if (slot === 'offhand') return a.choose(c.affinity, 'shield');
  return `${a.choose(c.affinity, 'armor')}_${PIECE[slot]}`;
}

function stock(state) { return Object.values(state.inventory).filter(i => i.kind === 'equipment' && i.count > 0); }

/** Item keys team members are missing or would replace, most urgent (empty slots) first. */
function equipmentDemand(state) {
  const missing = [], upgrades = [];
  for (const c of teamMembers(state)) {
    for (const slot of E().SLOTS) {
      const key = wantedKey(c, slot);
      const cur = c.equipment[slot];
      if (!cur) missing.push(key);
      else if (cur.key !== key || cur.quality < UPGRADE_BELOW) upgrades.push(key);
    }
  }
  return [...missing, ...upgrades];
}

/** What the smithy should make next when nobody has placed an order. Null = anything. */
function nextEquipment(state, rand = Math.random) {
  const d = equipmentDemand(state);
  if (!d.length) return null;
  // urgent half first, but rotate within it so five members' empty slots all get served
  const urgent = d.slice(0, Math.max(1, Math.ceil(d.length / 2)));
  return urgent[Math.floor(rand() * urgent.length)];
}

/** Better than what is worn: chosen type beats a different type, then quality. */
function betterThan(cur, cand, wantKey) {
  const score = (it) => (it ? (it.key === wantKey ? 10 : 0) + it.quality : -1);
  return score(cand) > score(cur);
}

/** Team members take the best stocked gear for their chosen types. Returns [{c, slot, item, old}]. */
function autoEquip(state, addItem) {
  const done = [];
  for (const c of teamMembers(state)) {
    if (c.mission) continue;
    for (const slot of E().SLOTS) {
      const want = wantedKey(c, slot);
      const cands = stock(state).filter(i => i.slot === slot);
      if (!cands.length) continue;
      const best = cands.sort((x, y) => ((y.key === want) - (x.key === want)) || (y.quality - x.quality))[0];
      if (!betterThan(c.equipment[slot], best, want)) continue;
      const old = c.equipment[slot] || null;
      const { count, ...item } = best;
      c.equipment[slot] = item;
      best.count--;
      if (old) addItem(old);
      done.push({ c, slot, item, old });
    }
  }
  return done;
}

// ---------- potions ----------
function potionsHeld(c) { return c.potions || (c.potions = []); }
function potionStock(state) { return Object.values(state.inventory).filter(i => i.kind === 'potion' && i.count > 0); }

/** Potion keys team members still want, in the order they should be served. */
function potionDemand(state) {
  const out = [];
  const members = teamMembers(state);
  for (let level = 0; level < POTION_SLOTS; level++) {
    for (const c of members) {
      const needs = ROLES[roleOf(c)].needs;
      const held = potionsHeld(c);
      if (held.length > level) continue;
      out.push(needs[level]);
    }
  }
  return out;
}

function nextPotion(state, rand = Math.random) {
  const d = potionDemand(state);
  return d.length ? d[Math.floor(rand() * Math.min(d.length, 3))] : null;
}

/** Hand out stocked potions by role, one slot per member per pass so nobody hoards. */
function distributePotions(state) {
  const done = [];
  const members = teamMembers(state).filter(c => !c.mission);
  for (let level = 0; level < POTION_SLOTS; level++) {
    for (const c of members) {
      const held = potionsHeld(c);
      if (held.length > level) continue;
      const key = ROLES[roleOf(c)].needs[level];
      const cands = potionStock(state).filter(i => i.key === key).sort((x, y) => y.quality - x.quality);
      if (!cands.length) continue;
      const { count, ...item } = cands[0];
      cands[0].count--;
      held.push(item);
      done.push({ c, item });
    }
  }
  return done;
}

/** Everything the town does for its teams after a tick. */
function supply(state, addItem) {
  return { equipped: autoEquip(state, addItem), potions: distributePotions(state) };
}

const OutfitAPI = { POTION_SLOTS, ROLES, roleOf, teamMembers, wantedKey, equipmentDemand, nextEquipment, autoEquip, potionDemand, nextPotion, distributePotions, supply };
if (typeof module !== 'undefined') module.exports = OutfitAPI;
if (typeof window !== 'undefined') window.Outfit = OutfitAPI;
})();
