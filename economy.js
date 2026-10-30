// Economy definitions: resources, jobs, buildings, town tiers, item tables.
// Pure data plus small pure functions. Browser: window.Econ. Node: module.exports.

const RESOURCES = {
  gems:  { label: 'Gems',  icon: '💎' },
  crops: { label: 'Crops', icon: '🌾' },
  ore:   { label: 'Ore',   icon: '⛏️' },
  herbs: { label: 'Herbs', icon: '🌿' },
};

// Jobs. kind 'gather' adds a resource per tick. kind 'process' accumulates progress and,
// at each threshold, consumes inputs and crafts an item. 'town' jobs have no building.
// building = which building supplies slots and multipliers; aptitude = proficiency key.
const JOBS = {
  farming:     { label: 'Farming',     icon: '🌾', kind: 'gather',  stats: ['con', 'wis'], building: 'farm',    produces: 'crops' },
  mining:      { label: 'Mining',      icon: '⛏️', kind: 'gather',  stats: ['str', 'con'], building: 'mine',    produces: 'ore' },
  foraging:    { label: 'Foraging',    icon: '🌿', kind: 'gather',  stats: ['dex', 'wis'], building: 'garden',  produces: 'herbs' },
  smithing:    { label: 'Smithing',    icon: '⚒️', kind: 'process', stats: ['str', 'int'], building: 'smithy',  consumes: { ore: 6 },   threshold: 30, crafts: 'equipment' },
  alchemy:     { label: 'Alchemy',     icon: '⚗️', kind: 'process', stats: ['int', 'wis'], building: 'lab',     consumes: { herbs: 4 }, threshold: 24, crafts: 'potion' },
  cooking:     { label: 'Cooking',     icon: '🍲', kind: 'process', stats: ['dex', 'cha'], building: 'kitchen', consumes: { crops: 5 }, threshold: 20, crafts: 'meal' },
  maintenance: { label: 'Maintenance', icon: '🔧', kind: 'town',    stats: ['con', 'int'], produces: 'gems', rate: 0.5 },
  training:    { label: 'Training',    icon: '🎯', kind: 'train',   stats: ['con', 'wis'], building: 'training' },
};

// LODGINGS. Not a tier ladder — a yard of separate buildings, as many of each as there are
// plots for. They trade three ways against each other: how many sleep there, how well they rest
// (a multiplier on stamina recovery and on training), and what the roof is worth to morale.
// A bunkhouse is the cheapest way to get a roster indoors and nobody is glad to be in it; a
// sanctum sleeps three people extremely well. `plots` is what it costs the plateau, and tents
// are a quarter of one each, so the old "one tent, one plot" squeeze is gone.
const LODGINGS = {
  tent:      { label: 'Tent',       icon: '⛺',  beds: 2,  rest: 0.90, morale: -2, plots: 0.25,
               desc: 'Canvas. Two people, barely, and four of them fit on one plot.',
               cost: { gems: 25, crops: 10 } },
  bunkhouse: { label: 'Bunkhouse',  icon: '🏚️', beds: 10, rest: 0.95, morale: -5, plots: 1,
               desc: 'Ten to a room. The cheapest way to get a roster under a roof, and it shows.',
               cost: { gems: 150, ore: 40, crops: 30 } },
  longhouse: { label: 'Longhouse',  icon: '🏠',  beds: 6,  rest: 1.10, morale: 3,  plots: 1,
               desc: 'One hall, one fire, six beds. The first lodging anyone is happy in.',
               cost: { gems: 260, crops: 60, ore: 50 } },
  barracks:  { label: 'Barracks',   icon: '🏛️', beds: 12, rest: 1.05, morale: 6,  plots: 1.5,
               desc: 'Built for a unit rather than a person. Set a team rule on it and it does what it is for.',
               cost: { gems: 520, ore: 160, crops: 90 } },
  cottages:  { label: 'Cottages',   icon: '🏘️', beds: 4,  rest: 1.30, morale: 11, plots: 1,
               desc: 'A door of your own. Four sleep very well.',
               cost: { gems: 750, crops: 160, ore: 110 } },
  manor:     { label: 'Manor',      icon: '🏰',  beds: 6,  rest: 1.45, morale: 16, plots: 2,
               desc: 'Six beds worth boasting about, on two plots and a great deal of money.',
               cost: { gems: 1800, crops: 400, ore: 400, herbs: 150 } },
  sanctum:   { label: 'Sanctum',    icon: '⛩️', beds: 3,  rest: 1.60, morale: 22, plots: 1,
               desc: 'Three people sleep better here than anywhere. Everyone else queues.',
               cost: { gems: 2600, herbs: 600, ore: 320 } },
};

// Kept only so a save from before the lodging yard can be read and converted (lodging.js migrate).
const TENT = { capacity: 2, max: 10, cost: { gems: 25, crops: 10 } };

// Buildings. Each tier: name, slots (workers), mult (gather output or quality bonus), cost to reach it.
// Tier index 0 is the starting state. A building can't exceed the town tier.
const BUILDINGS = {
  farm: { label: 'Farm', icon: '🌾', kind: 'gather', job: 'farming', tiers: [
    { name: 'Field',       slots: 2, mult: 1.0, cost: null },
    { name: 'Farmstead',   slots: 3, mult: 1.3, cost: { gems: 120, ore: 20 } },
    { name: 'Plantation',  slots: 5, mult: 1.7, cost: { gems: 350, ore: 80, herbs: 20 } },
    { name: 'Granary estate', slots: 7, mult: 2.2, cost: { gems: 800, ore: 200, herbs: 60 } },
    { name: 'Terraces',    slots: 10, mult: 3.0, cost: { gems: 1800, ore: 500, herbs: 150 } },
  ] },
  mine: { label: 'Mine', icon: '⛏️', kind: 'gather', job: 'mining', tiers: [
    { name: 'Quarry',      slots: 2, mult: 1.0, cost: null },
    { name: 'Mine shaft',  slots: 3, mult: 1.3, cost: { gems: 120, crops: 20 } },
    { name: 'Deep mine',   slots: 5, mult: 1.7, cost: { gems: 350, crops: 80, herbs: 20 } },
    { name: 'Mining complex', slots: 7, mult: 2.2, cost: { gems: 800, crops: 200, herbs: 60 } },
    { name: 'Abyssal mine', slots: 10, mult: 3.0, cost: { gems: 1800, crops: 500, herbs: 150 } },
  ] },
  garden: { label: 'Herb garden', icon: '🌿', kind: 'gather', job: 'foraging', tiers: [
    { name: 'Herb patch',  slots: 2, mult: 1.0, cost: null },
    { name: 'Garden',      slots: 3, mult: 1.3, cost: { gems: 120, crops: 20 } },
    { name: 'Greenhouse',  slots: 5, mult: 1.7, cost: { gems: 350, crops: 80, ore: 40 } },
    { name: 'Botanical grove', slots: 7, mult: 2.2, cost: { gems: 800, crops: 200, ore: 120 } },
    { name: 'Worldtree grove', slots: 10, mult: 3.0, cost: { gems: 1800, crops: 500, ore: 300 } },
  ] },
  smithy: { label: 'Smithy', icon: '⚒️', kind: 'process', job: 'smithing', tiers: [
    { name: 'Anvil',       slots: 1, quality: 0, cost: null },
    { name: 'Forge',       slots: 2, quality: 1, cost: { gems: 200, ore: 40 } },
    { name: 'Smithy',      slots: 3, quality: 2, cost: { gems: 500, ore: 150, crops: 50 } },
    { name: 'Grand forge', slots: 5, quality: 3, cost: { gems: 1200, ore: 400, crops: 150 } },
    { name: 'Runeforge',   slots: 7, quality: 4, cost: { gems: 2500, ore: 900, crops: 300, herbs: 200 } },
  ] },
  lab: { label: 'Alchemy lab', icon: '⚗️', kind: 'process', job: 'alchemy', tiers: [
    { name: 'Cauldron',    slots: 1, quality: 0, cost: null },
    { name: 'Still',       slots: 2, quality: 1, cost: { gems: 200, herbs: 30 } },
    { name: 'Laboratory',  slots: 3, quality: 2, cost: { gems: 500, herbs: 120, ore: 50 } },
    { name: 'Athenaeum',   slots: 5, quality: 3, cost: { gems: 1200, herbs: 300, ore: 150 } },
    { name: 'Sanctum',     slots: 7, quality: 4, cost: { gems: 2500, herbs: 700, ore: 300, crops: 200 } },
  ] },
  training: { label: 'Training grounds', icon: '🎯', kind: 'train', job: 'training', tiers: [
    { name: 'Sparring ring', slots: 2, mult: 1.0, cost: null },
    { name: 'Training yard', slots: 3, mult: 1.3, cost: { gems: 200, crops: 40, ore: 40 } },
    { name: 'Drill hall',    slots: 5, mult: 1.7, cost: { gems: 500, crops: 120, ore: 120 } },
    { name: 'Academy',       slots: 7, mult: 2.2, cost: { gems: 1200, crops: 300, ore: 300, herbs: 100 } },
    { name: 'Colosseum',     slots: 10, mult: 3.0, cost: { gems: 2500, crops: 700, ore: 700, herbs: 300 } },
  ] },
  // The altar has no workers and no output: it is the one place a character can be spent on
  // another. Tier 0 is free and standing on day one — the trade is always available, it just has
  // to be walked to. `share` scales everything a sacrifice carries across, so raising the altar
  // makes the same offering worth more. Flatten every share to 1 to make the tiers cosmetic.
  altar: { label: 'Altar', icon: '⚱️', kind: 'altar', tiers: [
    { name: 'Cairn',       share: 1.0,  cost: null },
    { name: 'Stone altar', share: 1.15, cost: { gems: 250, ore: 60, herbs: 20 } },
    { name: 'Ossuary',     share: 1.3,  cost: { gems: 600, ore: 200, herbs: 80 } },
    { name: 'Reliquary',   share: 1.5,  cost: { gems: 1400, ore: 450, herbs: 200, crops: 150 } },
    { name: 'Mausoleum',   share: 1.75, cost: { gems: 3000, ore: 1000, herbs: 450, crops: 400 } },
  ] },
  kitchen: { label: 'Kitchen', icon: '🍲', kind: 'process', job: 'cooking', tiers: [
    { name: 'Campfire',    slots: 1, quality: 0, cost: null },
    { name: 'Kitchen',     slots: 2, quality: 1, cost: { gems: 150, crops: 40 } },
    { name: 'Tavern',      slots: 3, quality: 2, cost: { gems: 400, crops: 150, ore: 40 } },
    { name: 'Banquet hall', slots: 5, quality: 3, cost: { gems: 1000, crops: 400, ore: 120, herbs: 60 } },
    { name: 'Royal kitchens', slots: 7, quality: 4, cost: { gems: 2200, crops: 900, ore: 300, herbs: 150 } },
  ] },
};

// Town tiers (plateaus). Buildings cannot be upgraded beyond the town tier index.
// plots = building sites on the plateau; every building uses one, every extra tent uses one.
// Every plateau gained a plot when the altar was added; without it, a building that is free and
// always present would leave every existing town one tent slot short.
const TOWN = [
  { name: 'Camp',        plots: 12, cost: null },
  { name: 'Outpost',     plots: 16, cost: { gems: 300, crops: 50, ore: 50, herbs: 20 } },
  { name: 'Village',     plots: 21, cost: { gems: 900, crops: 200, ore: 200, herbs: 100 } },
  { name: 'Town',        plots: 27, cost: { gems: 2500, crops: 600, ore: 600, herbs: 300 } },
  { name: 'City',        plots: 35, cost: { gems: 6000, crops: 1500, ore: 1500, herbs: 800 } },
];

// Item quality tiers, shared by everything crafted.
const QUALITY = [
  { name: 'Crude',      color: '#9a9a9a', mult: 0.6 },
  { name: 'Standard',   color: '#ddd',    mult: 1.0 },
  { name: 'Fine',       color: '#4caf50', mult: 1.4 },
  { name: 'Superior',   color: '#2196f3', mult: 1.9 },
  { name: 'Masterwork', color: '#ab47bc', mult: 2.6 },
  { name: 'Legendary',  color: '#ffa726', mult: 3.5 },
];

// Roll a quality index. buildingQuality 0..4 and aptitude stage 0..22 both push the roll up.
function rollQuality(buildingQuality, aptitudeStage, rand = Math.random) {
  const skill = buildingQuality + aptitudeStage / 4;        // ~0 .. 9.5
  const weights = QUALITY.map((q, i) => Math.max(0.05, Math.exp(-Math.pow(i - skill * 0.55, 2) / 1.6)));
  // Legendary needs a proper building and a real aptitude
  if (buildingQuality < 3 || aptitudeStage < 12) weights[5] = 0;
  if (buildingQuality < 2 && aptitudeStage < 9) weights[4] = 0;
  const total = weights.reduce((a, b) => a + b, 0);
  let x = rand() * total;
  for (let i = 0; i < weights.length; i++) { x -= weights[i]; if (x < 0) return i; }
  return 1;
}

// ----- item templates -----
// type = affinity type (see affinity.js), slot = equipment slot on the character.
const EQUIPMENT = [
  { key: 'sword',   label: 'Sword',        slot: 'weapon',  type: 'sword',   stat: 'str' },
  { key: 'axe',     label: 'Axe',          slot: 'weapon',  type: 'axe',     stat: 'str' },
  { key: 'spear',   label: 'Spear',        slot: 'weapon',  type: 'spear',   stat: 'dex' },
  { key: 'bow',     label: 'Bow',          slot: 'weapon',  type: 'bow',     stat: 'dex' },
  { key: 'dagger',  label: 'Dagger',       slot: 'weapon',  type: 'dagger',  stat: 'dex' },
  { key: 'staff',   label: 'Staff',        slot: 'weapon',  type: 'staff',   stat: 'int' },
  { key: 'buckler', label: 'Buckler',      slot: 'offhand', type: 'buckler', stat: 'dex' },
  { key: 'kite',    label: 'Kite shield',  slot: 'offhand', type: 'kite',    stat: 'con' },
  { key: 'tower',   label: 'Tower shield', slot: 'offhand', type: 'tower',   stat: 'str' },
  { key: 'light_helm',   label: 'Light helm',   slot: 'head', type: 'light',  stat: 'dex' },
  { key: 'medium_helm',  label: 'Medium helm',  slot: 'head', type: 'medium', stat: 'con' },
  { key: 'heavy_helm',   label: 'Heavy helm',   slot: 'head', type: 'heavy',  stat: 'con' },
  { key: 'light_mail',   label: 'Light mail',   slot: 'body', type: 'light',  stat: 'dex' },
  { key: 'medium_mail',  label: 'Medium mail',  slot: 'body', type: 'medium', stat: 'con' },
  { key: 'heavy_mail',   label: 'Heavy mail',   slot: 'body', type: 'heavy',  stat: 'con' },
  { key: 'light_boots',  label: 'Light boots',  slot: 'feet', type: 'light',  stat: 'dex' },
  { key: 'medium_boots', label: 'Medium boots', slot: 'feet', type: 'medium', stat: 'con' },
  { key: 'heavy_boots',  label: 'Heavy boots',  slot: 'feet', type: 'heavy',  stat: 'str' },
];
const SLOTS = ['weapon', 'offhand', 'head', 'body', 'feet'];
const METALS = ['Copper', 'Iron', 'Steel', 'Mithril', 'Adamant', 'Starmetal']; // indexed by quality

const POTIONS = [
  { key: 'healing', label: 'Healing potion', effect: 'hp' },
  { key: 'mana',    label: 'Mana potion',    effect: 'mana' },
  { key: 'stamina', label: 'Stamina tonic',  effect: 'stamina' },
  { key: 'antidote', label: 'Antidote',      effect: 'cure' },
  { key: 'invisibility', label: 'Invisibility draught', effect: 'stealth' },
];

// Meals: unlocked by kitchen tier. Higher recipes list more stats.
const MEALS = [
  { key: 'porridge', label: 'Porridge', minKitchen: 0, buffs: ['con'] },
  { key: 'stew',     label: 'Stew',     minKitchen: 1, buffs: ['con', 'str'] },
  { key: 'roast',    label: 'Roast',    minKitchen: 2, buffs: ['str', 'dex', 'con'] },
  { key: 'banquet',  label: 'Banquet',  minKitchen: 3, buffs: ['str', 'dex', 'con', 'int', 'wis', 'cha'] },
];

// What a meal is worth in a fight. craftItem stores `amount` on every stat a recipe lists (Fine 2,
// Masterwork 4, Legendary 5). A character takes one meal at launch (condition.js feed) and
// combat.js fromCharacter adds mealInfo().points to their stats for that sortie only; nothing
// else reads them. points = MEAL_K x amount, shared equally over the listed stats, and no stat
// gets more than MEAL_CAP. A porridge puts the whole total on CON and a banquet spreads it over
// six stats, so one quality gives every recipe the same total.
// MEAL_K comes from test/sortie.harness.js with MEALS set (win rate against no meals); the totals are
// 0.35 (Crude) to 1.75 (Legendary), under the Masterwork weapon's +5 on its one stat.
// MEAL_CAP is 40% of that +5. Every meal craftItem can make is under it, so it only binds if
// MEAL_K or the amounts are raised; test/meals.js fails when it stops being under the weapon bonus.
const equipBonusAt = (q) => Math.max(1, Math.round(2 * QUALITY[q].mult));
const MEAL_K = 0.35;
const MEAL_CAP = 0.4 * equipBonusAt(QUALITY.findIndex(q => q.name === 'Masterwork'));

// want: optional item key (a player request at the smithy or lab). Unknown keys fall back to random.
function craftItem(kind, buildingTier, aptitude, rand = Math.random, want = null) {
  const q = rollQuality(buildingTier, aptitude.stage, rand);
  const Q = QUALITY[q];
  const pickFrom = (a) => a[Math.floor(rand() * a.length)];
  const wanted = (list) => (want && list.find(t => t.key === want)) || pickFrom(list);
  if (kind === 'equipment') {
    const t = wanted(EQUIPMENT);
    const bonus = equipBonusAt(q);
    return { kind, key: t.key, slot: t.slot, type: t.type, quality: q, name: `${Q.name} ${METALS[q]} ${t.label}`, bonus: { [t.stat]: bonus } };
  }
  if (kind === 'potion') {
    const t = wanted(POTIONS);
    return { kind, key: t.key, quality: q, name: `${Q.name} ${t.label}`, effect: t.effect, power: Math.round(20 * Q.mult) };
  }
  if (kind === 'meal') {
    const available = MEALS.filter(m => m.minKitchen <= buildingTier);
    const t = pickFrom(available);
    const amount = Math.max(1, Math.round(1.5 * Q.mult));
    return { kind, key: t.key, quality: q, name: `${Q.name} ${t.label}`, buffs: Object.fromEntries(t.buffs.map(b => [b, amount])) };
  }
  return null;
}

const itemId = (it) => `${it.kind}:${it.key}:${it.quality}`;

/**
 * What a character carries while a meal is active (c.meal): the meal's key, name and quality, the
 * authored `amount`, and `points` as { stat: points } from the rule above. `item` is an inventory entry.
 */
function mealInfo(item) {
  const buffs = (item && item.buffs) || {};
  const keys = Object.keys(buffs);
  const amount = Math.max(0, ...keys.map(k => Number(buffs[k]) || 0));
  const each = keys.length ? Math.min(MEAL_CAP, MEAL_K * amount / keys.length) : 0;
  return { key: item.key, name: item.name, quality: item.quality, amount, points: Object.fromEntries(keys.map(k => [k, each])) };
}

/** Points as the log, the inventory and the sheet print them: "+0.35 CON +0.35 STR". */
const mealText = (points) => Object.entries(points).map(([s, v]) => `+${+v.toFixed(2)} ${s.toUpperCase()}`).join(' ');

/** The arithmetic behind a mealInfo, for tooltips: "Fine quality: 2 x 0.35 = 0.7, shared over 2 stats". */
function mealWhy(info) {
  const n = Object.keys(info.points).length;
  const total = MEAL_K * info.amount;
  const f = (v) => +v.toFixed(2);
  const capped = n > 0 && Math.min(...Object.values(info.points)) < total / n - 1e-9;
  return `${QUALITY[info.quality].name} quality: ${info.amount} x ${MEAL_K} = ${f(total)}${n > 1 ? `, shared over ${n} stats` : ''}${capped ? `, held to ${MEAL_CAP} on one stat` : ''}`;
}

/** Sort order for eating the best meal first: higher quality, then the later recipe (it lists more stats). */
const betterMeal = (a, b) => b.quality - a.quality || MEALS.findIndex(m => m.key === b.key) - MEALS.findIndex(m => m.key === a.key);

function canAfford(res, cost) { return !cost || Object.entries(cost).every(([k, v]) => (res[k] || 0) >= v); }
function pay(res, cost) { for (const [k, v] of Object.entries(cost)) res[k] -= v; }
function costText(cost) { return Object.entries(cost).map(([k, v]) => `${RESOURCES[k].icon} ${v}`).join('  '); }

const EconAPI = { RESOURCES, JOBS, BUILDINGS, LODGINGS, TOWN, TENT, QUALITY, EQUIPMENT, SLOTS, POTIONS, MEALS, MEAL_K, MEAL_CAP, equipBonusAt, rollQuality, craftItem, itemId, mealInfo, mealText, mealWhy, betterMeal, canAfford, pay, costText };
if (typeof module !== 'undefined') module.exports = EconAPI;
if (typeof window !== 'undefined') window.Econ = EconAPI;
