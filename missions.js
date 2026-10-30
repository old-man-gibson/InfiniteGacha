// Missions: parties through the gate against the bestiary. Browser: window.Missions. Node: module.exports.
//
// A mission is a run of encounters spread over game ticks (one tick every ten seconds). When
// a party is launched every member prepares its loadouts ONCE (grimoire, workings, martial
// rotation) through the intelligence model, cached against a signature of the character and
// the mission, and never recomputed during ticks. Encounters resolve in the combat simulator
// the moment they come due. Loot rolls through Mercy so rare drops stop clumping.

(() => {
const R = (typeof Rng !== 'undefined') ? Rng : require('./rng.js');
const M = (typeof Mercy !== 'undefined') ? Mercy : require('./mercy.js');
const E = (typeof Elements !== 'undefined') ? Elements : require('./elements.js');
const C = (typeof Combat !== 'undefined') ? Combat : require('./combat.js');
const AIx = (typeof AI !== 'undefined') ? AI : require('./ai.js');
const Sp = (typeof Spellcraft !== 'undefined') ? Spellcraft : require('./spellcraft.js');
const Ps = (typeof Psionic !== 'undefined') ? Psionic : require('./psionic.js');
const Ma = (typeof Martial !== 'undefined') ? Martial : require('./martial.js');
const ProfX = (typeof Prof !== 'undefined') ? Prof : require('./proficiency.js');
const St = (typeof Stats !== 'undefined') ? Stats : require('./stats.js');
// Optional: a class gives a character standing orders and is learned by going out (classes.js).
const CL = () => (typeof Classes !== 'undefined') ? Classes : (typeof require !== 'undefined' ? require('./classes.js') : null);
const CO = () => (typeof Condition !== 'undefined') ? Condition : (typeof require !== 'undefined' ? require('./condition.js') : null);
const BO = () => (typeof Bonds !== 'undefined') ? Bonds : (typeof require !== 'undefined' ? require('./bonds.js') : null);
const RO = () => (typeof Roster !== 'undefined') ? Roster : (typeof require !== 'undefined' ? require('./roster.js') : null);
// Optional: the bed sets how fast a wound heals. field.html and the Node tests do not load lodging.js, so there is no require fallback.
const LO = () => (typeof Lodging !== 'undefined') ? Lodging : null;

const PARTY_MAX = 4;
const INJURY_TICKS = 30;         // the injury a death leaves when roster.js is not loaded (finish()); equals Condition.WOUND_TICKS

// ---------- bestiary (lifted) ----------
const inf = (id, intensity, chance) => ({ id, intensity, chance });
const MON = (id, name, icon, tier, damageType, attrs, tags, extra = {}) => ({ id, name, icon, tier, damageType, attrs, tags, ...extra });
const BESTIARY = {};
for (const mn of [
  MON('forest_rat', 'Forest Rat', '🐀', 'basic', 'piercing', { str: 2, dex: 4, con: 2, int: 1, wis: 1, cha: 0 }, ['living', 'beast', 'small']),
  MON('young_wolf', 'Young Wolf', '🐕', 'basic', 'piercing', { str: 4, dex: 5, con: 4, int: 1, wis: 2, cha: 0 }, ['living', 'beast'], { inflicts: [inf('punctured', 0.5, 0.2)] }),
  MON('wolf', 'Wolf', '🐺', 'veteran', 'piercing', { str: 7, dex: 7, con: 6, int: 2, wis: 3, cha: 0 }, ['living', 'beast'], { inflicts: [inf('bleeding', 1, 0.2)] }),
  MON('boar', 'Boar', '🐗', 'veteran', 'bludgeoning', { str: 9, dex: 4, con: 9, int: 1, wis: 3, cha: 0 }, ['living', 'beast', 'large'], { inflicts: [inf('concussed', 1, 0.15)] }),
  MON('cliff_hawk', 'Cliff Hawk', '🦅', 'veteran', 'slashing', { str: 6, dex: 12, con: 5, int: 2, wis: 4, cha: 0 }, ['living', 'beast', 'flying', 'wind'], { inflicts: [inf('bleeding', 1, 0.25)] }),
  MON('cave_spider', 'Cave Spider', '🕷️', 'veteran', 'poison', { str: 8, dex: 11, con: 7, int: 3, wis: 4, cha: 0 }, ['living', 'vermin', 'toxic'], { inflicts: [inf('poison', 1, 0.35)] }),
  MON('goblin', 'Goblin', '👺', 'basic', 'piercing', { str: 6, dex: 8, con: 5, int: 4, wis: 3, cha: 3 }, ['living', 'goblin', 'humanoid', 'small'], { inflicts: [inf('bleeding', 1, 0.15)] }),
  MON('goblin_boss', 'Goblin Boss', '👹', 'legendary', 'slashing', { str: 12, dex: 9, con: 12, int: 5, wis: 4, cha: 5 }, ['living', 'goblin', 'humanoid'], { inflicts: [inf('bleeding', 1.5, 0.3)] }),
  MON('slime', 'Slime', '🟢', 'basic', 'bludgeoning', { str: 4, dex: 4, con: 6, int: 1, wis: 1, cha: 1 }, ['inorganic', 'slime', 'small']),
  MON('slime_ice', 'Ice Slime', '🧊', 'basic', 'cold', { str: 4, dex: 4, con: 6, int: 1, wis: 1, cha: 1 }, ['inorganic', 'slime', 'ice'], { inflicts: [inf('chilled', 0.2, 0.4)] }),
  MON('slime_fire', 'Fire Slime', '🔥', 'basic', 'heat', { str: 5, dex: 5, con: 7, int: 2, wis: 1, cha: 1 }, ['inorganic', 'slime', 'fire'], { inflicts: [inf('on_fire', 1, 0.3)] }),
  MON('slime_water', 'Water Slime', '💧', 'basic', 'bludgeoning', { str: 4, dex: 5, con: 6, int: 1, wis: 1, cha: 1 }, ['inorganic', 'slime', 'water'], { inflicts: [inf('wet', 1, 0.4)] }),
  MON('slime_wind', 'Wind Slime', '🌬️', 'basic', 'wind', { str: 3, dex: 9, con: 4, int: 2, wis: 2, cha: 1 }, ['inorganic', 'slime', 'wind', 'small'], { inflicts: [inf('dazzled', 1, 0.25)] }),
  MON('slime_thunder', 'Thunder Slime', '⚡', 'basic', 'lightning', { str: 4, dex: 7, con: 5, int: 3, wis: 1, cha: 1 }, ['inorganic', 'slime', 'lightning', 'small'], { inflicts: [inf('jolted', 1, 0.35)] }),
  MON('slime_earth', 'Earth Slime', '🪨', 'basic', 'bludgeoning', { str: 6, dex: 2, con: 8, int: 1, wis: 1, cha: 1 }, ['inorganic', 'slime', 'earth'], { inflicts: [inf('shardbound', 1, 0.3)] }),
  MON('slime_nature', 'Nature Slime', '🌿', 'basic', 'poison', { str: 4, dex: 3, con: 7, int: 1, wis: 2, cha: 1 }, ['inorganic', 'slime', 'nature'], { inflicts: [inf('poison', 1.2, 0.3)] }),
  MON('slime_zombie', 'Zombie Slime', '🧟', 'veteran', 'poison', { str: 7, dex: 4, con: 11, int: 1, wis: 1, cha: 1 }, ['inorganic', 'slime', 'undead', 'toxic']),
  MON('slime_soldier', 'Slime Soldier', '🛡️', 'veteran', 'piercing', { str: 8, dex: 7, con: 10, int: 2, wis: 2, cha: 2 }, ['inorganic', 'slime', 'humanoid']),
  MON('slime_arcane', 'Arcane Slime', '🔮', 'elite', 'arcane', { str: 6, dex: 8, con: 11, int: 10, wis: 6, cha: 2 }, ['inorganic', 'slime', 'arcane'], { inflicts: [inf('unravelling', 1, 0.3)] }),
  MON('slime_dark', 'Dark Slime', '🌑', 'elite', 'dark', { str: 8, dex: 11, con: 10, int: 7, wis: 7, cha: 3 }, ['incorporeal', 'slime', 'dark'], { inflicts: [inf('tainted', 1, 0.3)] }),
  MON('slime_holy', 'Holy Slime', '✨', 'elite', 'light', { str: 9, dex: 7, con: 13, int: 6, wis: 9, cha: 4 }, ['inorganic', 'slime', 'light'], { inflicts: [inf('dazzled', 1, 0.35)] }),
  MON('stone_golem', 'Stone Golem', '🗿', 'elite', 'bludgeoning', { str: 14, dex: 3, con: 16, int: 1, wis: 8, cha: 0 }, ['inorganic', 'construct', 'earth', 'large'], { inflicts: [inf('concussed', 1, 0.25)] }),
  MON('slime_king', 'Slime King', '👑', 'legendary', 'bludgeoning', { str: 15, dex: 10, con: 18, int: 8, wis: 7, cha: 8 }, ['inorganic', 'slime', 'unique', 'large'], { inflicts: [inf('wet', 2, 0.5)] }),
  MON('death_knight', 'Death Knight', '💀', 'elite', 'slashing', { str: 18, dex: 10, con: 15, int: 17, wis: 7, cha: 12 }, ['humanoid', 'inorganic', 'dark', 'undead'], { inflicts: [inf('tainted', 1, 0.4)] }),
  MON('spider_queen', 'Giant Spider Queen', '🕸️', 'legendary', 'poison', { str: 20, dex: 18, con: 26, int: 3, wis: 4, cha: 3 }, ['living', 'vermin', 'toxic', 'huge'], { inflicts: [inf('poison', 2, 0.5)] }),
]) BESTIARY[mn.id] = mn;

const TIERS = { basic: [0.8, 1.1, 1], veteran: [1.0, 1.25, 1.3], elite: [1.25, 1.5, 1.8], ancient: [1.45, 1.7, 3], legendary: [1.75, 2.5, 4] };
const MODIFIERS = [{ id: 'normal', weight: 90, range: [1, 1], reward: 1 }, { id: 'demiboss', weight: 7, range: [1.2, 1.4], reward: 2, prefix: 'Demiboss' }, { id: 'boss', weight: 2, range: [1.5, 1.8], reward: 3.5, prefix: 'Boss' }, { id: 'aberrant', weight: 1, range: [0.2, 2.0], reward: 2, prefix: 'Aberrant' }];
const RARITIES = [{ id: 'common', weight: 77, mult: 1, loot: 1 }, { id: 'uncommon', weight: 15, mult: 1.15, loot: 1.5, prefix: 'Uncommon' }, { id: 'rare', weight: 6, mult: 1.35, loot: 2.5, prefix: 'Rare' }, { id: 'epic', weight: 2, mult: 1.6, loot: 4, prefix: 'Epic' }];

function spawn(id, level, ledger) {
  const def = BESTIARY[id];
  const t = TIERS[def.tier];
  const mod = M.mercyPick(ledger, MODIFIERS, (e, r) => (e.id === 'normal' ? null : 'spawn:mod:' + e.id));
  const rar = M.mercyPick(ledger, RARITIES, (e, r) => (e.id === 'common' ? null : 'spawn:rar:' + e.id));
  const tierMult = t[0] + R.rand() * (t[1] - t[0]);
  const modMult = mod.range[0] + R.rand() * (mod.range[1] - mod.range[0]);
  const prefix = [rar.prefix, mod.prefix].filter(Boolean).join(' ');
  return C.fromMonster(def, level, { tierMult: tierMult * modMult, rarityMult: rar.mult, reward: t[2] * mod.reward, loot: rar.loot, prefix, rarity: rar.id, modifier: mod.id }, ledger);
}

// ---------- missions ----------
const MISSIONS = [
  { id: 'forest_edge', name: 'Forest Edge', icon: '🌲', level: 1, ticks: 6, encounters: [['forest_rat', 'forest_rat'], ['young_wolf', 'forest_rat']], reward: { gems: 40, crops: 15 } },
  { id: 'wolf_trail', name: 'Wolf Trail', icon: '🐾', level: 2, ticks: 9, encounters: [['young_wolf', 'young_wolf'], ['wolf'], ['wolf', 'young_wolf']], reward: { gems: 70, crops: 20, herbs: 10 } },
  { id: 'boar_hollow', name: 'Boar Hollow', icon: '🐗', level: 3, ticks: 9, encounters: [['boar'], ['boar', 'wolf'], ['boar', 'boar']], reward: { gems: 100, crops: 40, ore: 15 } },
  { id: 'goblin_camp', name: 'Goblin Camp', icon: '⛺', level: 4, ticks: 12, encounters: [['goblin', 'goblin'], ['goblin', 'goblin', 'goblin'], ['goblin_boss', 'goblin']], reward: { gems: 160, ore: 40, herbs: 20 } },
  { id: 'cliffs', name: 'Hawk Cliffs', icon: '🏔️', level: 5, ticks: 12, encounters: [['cliff_hawk'], ['cliff_hawk', 'cliff_hawk'], ['cliff_hawk', 'boar']], reward: { gems: 200, ore: 50, herbs: 30 } },
  { id: 'spider_cave', name: 'Spider Cave', icon: '🕸️', level: 6, ticks: 12, encounters: [['cave_spider'], ['cave_spider', 'cave_spider'], ['cave_spider', 'cave_spider', 'cave_spider']], reward: { gems: 240, herbs: 60, ore: 30 } },
  { id: 'slime_pools', name: 'Slime Pools', icon: '🟢', level: 6, ticks: 12, encounters: [['slime', 'slime', 'slime_water'], ['slime_ice', 'slime_water', 'slime'], ['slime_fire', 'slime_fire', 'slime_water']], reward: { gems: 240, crops: 60, herbs: 40 } },
  { id: 'storm_caverns', name: 'Storm Caverns', icon: '⚡', level: 8, ticks: 15, encounters: [['slime_thunder', 'slime_wind'], ['slime_thunder', 'slime_water', 'slime_wind'], ['slime_earth', 'slime_thunder', 'slime_thunder']], reward: { gems: 340, ore: 90, herbs: 50 } },
  { id: 'rotting_depths', name: 'Rotting Depths', icon: '🧟', level: 9, ticks: 15, encounters: [['slime_zombie', 'slime_nature'], ['slime_zombie', 'slime_zombie', 'slime_soldier'], ['slime_soldier', 'slime_soldier', 'slime_nature']], reward: { gems: 400, crops: 100, ore: 80 } },
  { id: 'golem_quarry', name: 'Golem Quarry', icon: '🗿', level: 11, ticks: 18, encounters: [['stone_golem'], ['stone_golem', 'slime_earth', 'slime_earth'], ['stone_golem', 'stone_golem']], reward: { gems: 550, ore: 200, crops: 80 } },
  { id: 'twilight_shrine', name: 'Twilight Shrine', icon: '🌗', level: 12, ticks: 18, encounters: [['slime_holy', 'slime_dark'], ['slime_arcane', 'slime_arcane'], ['slime_dark', 'slime_holy', 'slime_arcane']], reward: { gems: 650, herbs: 200, ore: 120 } },
  { id: 'slime_throne', name: 'The Slime Throne', icon: '👑', level: 14, ticks: 21, encounters: [['slime_soldier', 'slime_soldier', 'slime_arcane'], ['slime_ice', 'slime_fire', 'slime_thunder', 'slime_earth'], ['slime_king', 'slime_soldier']], reward: { gems: 1000, crops: 250, ore: 250, herbs: 250 } },
  { id: 'black_keep', name: 'The Black Keep', icon: '🏰', level: 16, ticks: 24, encounters: [['death_knight'], ['slime_dark', 'slime_dark', 'death_knight'], ['death_knight', 'death_knight']], reward: { gems: 1400, ore: 400, herbs: 300 } },
  { id: 'brood_mother', name: 'Brood Mother', icon: '🕷️', level: 18, ticks: 24, encounters: [['cave_spider', 'cave_spider', 'cave_spider', 'cave_spider'], ['cave_spider', 'cave_spider', 'spider_queen']], reward: { gems: 2000, crops: 400, herbs: 500 } },
];
const MISSION = Object.fromEntries(MISSIONS.map(m => [m.id, m]));

// ---------- levels from aptitudes ----------
const aptLevel = (c, key) => (c.profs[key] ? Math.floor(ProfX.toAbsolute(c.profs[key]) / 15) : 0);

/** Enemy profile for a mission before it starts: average resistances and hp of the listed monsters. */
function missionProfile(mission) {
  const ids = mission.encounters.flat();
  const sample = ids.map(id => C.fromMonster(BESTIARY[id], mission.level, {}, {}));
  return C.profileOf(sample);
}

/** Prepare (or reuse) a character's loadouts for a mission. Never called from a tick. */
function prepare(c, mission) {
  const sig = AIx.signature(c) + '|' + mission.id;
  if (c.loadout && c.loadout.sig === sig) return c.loadout;
  const profile = missionProfile(mission);
  const eff = St.effective(c);
  const burst = eff.derived.maxDamage * 3;
  const own = AIx.doctrine(c, { hpRatio: profile.hp / Math.max(1, burst), count: profile.count });
  // A class is a floor under a bad mind: its standing orders hold unless the character is sharp
  // enough to have actually read the enemy (see Classes.doctrine).
  const cl = CL();
  const doctrine = cl ? cl.doctrine(c, own, AIx.tier(c)) : own;
  const arcana = aptLevel(c, 'arcana');
  const psionics = aptLevel(c, 'psionics');
  // What gets built is what the character can use: a lexicon (born arcane, or class-taught
  // words) and open axes (born psionic, or class-opened). Everyone gets a martial plan, which
  // is just a plain swing for anyone with neither the blade path nor a teacher. A lexicon whose
  // words are all above the arcana level gives an empty grimoire (Spellcraft.randomSentence
  // returns [] and no sentence passes checkSentence), and the martial plan is used alone.
  const grimoire = Sp.lexiconOf(c).length ? Sp.buildGrimoire(c, arcana, profile, doctrine) : { spells: [] };
  const workings = Ps.openAxes(c, psionics).length ? Ps.buildWorkings(c, psionics, profile, doctrine) : { workings: [] };
  const loadout = Ma.buildLoadout(c, profile, doctrine);
  // and whatever the class is FOR, which needs no mind to build and no lexicon to hold
  const features = cl ? cl.featuresOf(c) : [];
  c.loadout = { sig, mission: mission.id, doctrine, tier: AIx.tier(c).id, klass: cl ? cl.title(c) : null, spells: grimoire.spells, workings: workings.workings, features, rotation: loadout.rotation, builtAt: Date.now() };
  return c.loadout;
}

/** Start a mission. Returns the run record or an error string. */
function launch(state, missionId, charIds) {
  const mission = MISSION[missionId];
  if (!mission) return 'No such mission';
  const chars = charIds.map(id => state.characters.find(c => c.id === id)).filter(Boolean);
  if (!chars.length || chars.length > PARTY_MAX) return `A party is 1 to ${PARTY_MAX} characters`;
  for (const c of chars) {
    if (c.mission) return `${c.name} is already on a mission`;
    if (c.injured && c.injured > 0) return `${c.name} is still recovering`;
  }
  // Every step that can throw comes before every step that changes the town: when one member's
  // loadout cannot be built nobody is flagged as out and nextId is not spent. prepare() writes
  // c.loadout, a cache keyed by signature, which the next launch reuses or rebuilds.
  const loadouts = [];
  for (const c of chars) {
    try { loadouts.push(prepare(c, mission)); }
    catch (e) { return `${c.name} cannot be prepared: ${e.message}`; }
  }
  const run = { id: state.nextId++, mission: missionId, party: chars.map(c => c.id), progress: 0, encounter: 0, log: [], members: {}, result: null, startedAt: Date.now() };
  for (const [i, c] of chars.entries()) {
    const l = loadouts[i];
    c.mission = run.id; c.job = null; c.progress = 0;
    run.members[c.id] = { hp: 1, mana: 1, stamina: 1, focus: 1, alive: true, dealt: 0, taken: 0, casts: 0, low: 1 };
    run.log.push(`${c.name} (${l.tier}, ${l.doctrine}): ${l.rotation.length} techniques, ${l.spells.length} spells, ${l.workings.length} workings${(l.features || []).length ? `, ${l.features.length} class feature${l.features.length === 1 ? '' : 's'}` : ''}`);
  }
  // Each member eats one meal, best first (condition.js feed); fight() builds the fighters from c.meal.
  // It is here, after every step that can throw, so a failed launch takes nothing from the pantry.
  const co = CO(), fed = co ? co.feed(state, chars) : null;
  if (fed && fed.line) run.log.push(`\u{1F372} ate before setting out: ${fed.line}`);
  state.missions.active.push(run);
  return run;
}

function encounterDue(mission, run) {
  const n = mission.encounters.length;
  return run.encounter < n && run.progress >= Math.floor(mission.ticks * (run.encounter + 1) / (n + 1));
}

/**
 * One town tick of healing for everyone who is injured. c.injured falls by Condition.healRate for
 * the character's bed (Lodging.restFor) and for the pantry (`fed`: meals in stock), and c.woundNote
 * is deleted when it reaches 0. Without lodging.js the bed's rest multiplier is 1, which is the
 * rate before wounds depended on the bed, so a Node caller of tick() sees one tick per tick.
 */
function recover(state, fed = false) {
  const lo = LO(), co = CO();
  for (const c of state.characters) {
    if (!(c.injured > 0)) continue;
    const rest = lo ? lo.restFor(state, c) : 1;
    c.injured -= co ? co.healRate(rest, fed) : rest;
    if (c.injured < 1e-9) { c.injured = 0; delete c.woundNote; }
  }
}

/** One game tick for every active run. Returns finished runs. `fed` is whether the town's pantry has meals, for healing. */
function tick(state, { fed = false } = {}) {
  const finished = [];
  recover(state, fed);        // before the runs, so a wound from a run that ends this tick lasts its full length
  for (const run of state.missions.active) {
    if (run.result) continue;
    run.progress++;
    const mission = MISSION[run.mission];
    while (encounterDue(mission, run) && !run.result) fight(state, run, mission);
    if (!run.result && run.progress >= mission.ticks) finish(state, run, mission, true);
    if (run.result) finished.push(run);
  }
  state.missions.active = state.missions.active.filter(r => !r.result);
  return finished;
}

function fight(state, run, mission) {
  const ledger = state.mercy;
  const party = [];
  for (const id of run.party) {
    const c = state.characters.find(x => x.id === id);
    const mem = run.members[id];
    if (!c || !mem.alive) continue;
    const f = C.fromCharacter(c, c.loadout, ledger);
    f.hp = Math.max(1, Math.round(f.maxHp * mem.hp));
    for (const k of ['mana', 'stamina', 'focus']) f.pools[k].cur = f.pools[k].max * mem[k];
    party.push(f);
  }
  const enemies = mission.encounters[run.encounter].map(id => spawn(id, mission.level, ledger));
  const res = C.encounter(party, enemies);
  if (typeof Bestiary !== 'undefined') Bestiary.record(state, run, enemies, party, res, mission.level);
  run.encounter++;
  const title = `Encounter ${run.encounter}: ${enemies.map(e => e.icon + ' ' + e.name).join(', ')} — ${res.won ? 'won' : res.timedOut ? 'stalemate' : 'lost'} in ${(res.ticks / 10).toFixed(1)}s`;
  run.log.push(title);
  run.log.push(...res.log.slice(-60));
  for (const f of party) {
    const mem = run.members[f.char.id];
    mem.dealt += f.stats.damageDealt; mem.taken += f.stats.damageTaken;
    mem.casts = (mem.casts || 0) + f.stats.casts;    // what the caster pool pays for on the way home
    // the lowest HP fraction at the end of a fight, sampled before the rest below; debrief() turns it into a wound
    mem.low = Math.min(mem.low === undefined ? 1 : mem.low, f.alive ? f.hp / f.maxHp : 0);
    mem.alive = f.alive;
    // rest between encounters: a quarter of everything back
    mem.hp = f.alive ? Math.min(1, f.hp / f.maxHp + 0.25) : 0;
    for (const k of ['mana', 'stamina', 'focus']) mem[k] = Math.min(1, f.pools[k].cur / f.pools[k].max + 0.25);
    mem.stats = f.stats;
    trainFromFight(f);
  }
  run.loot = run.loot || [];
  for (const k of res.kills) run.loot.push(...rollLoot(state, k, mission));
  const ro = RO();
  if (ro) ro.noteKills(res.kills);        // service record: credited at the kill, so a character who dies later has them on the memorial
  if (!res.won) finish(state, run, mission, false);
}

/** Aptitudes grow from use: the weapon family, elements cast, arcana, psionics, shields. */
function trainFromFight(f) {
  const c = f.char;
  const gain = (key, amount) => {
    if (!ProfX.PROFICIENCIES[key]) return;
    if (!c.profs[key]) c.profs[key] = ProfX.rollOne(c.stats.stars, 0);
    c.xp[key] = (c.xp[key] || 0) + amount;
    const levels = Math.floor(c.xp[key]);
    if (levels > 0) { c.xp[key] -= levels; c.profs[key] = ProfX.gain(c.profs[key], levels, ProfX.MAX_ADVANCE_STAGE); }
  };
  gain(f.family === 'unarmed' ? 'unarmed' : f.family, f.stats.attacks * 0.15);
  if (c.equipment.offhand) gain('shield', f.stats.parries * 0.5 + f.stats.hitsTaken * 0.05);
  for (const slot of ['head', 'body', 'feet']) { const it = c.equipment[slot]; if (it) gain(it.type + '_armor', f.stats.hitsTaken * 0.05); }
  if (f.stats.casts) {
    gain('arcana', f.stats.casts * 0.3);
    gain('psionics', f.stats.casts * 0.2);
    for (const s of (f.plan.spells || [])) for (const st of s.strikes) { const apt = E.ELEMENT_APTITUDE[st.type]; if (apt) gain(apt, 0.08); }
  }
  // a new word or axis now and then
  if (f.stats.casts >= 3 && R.chance(0.15) && c.lexicon) { const w = Sp.learnWord(c.lexicon); if (w) f.learned = (f.learned || []).concat('word:' + w); }
}

function rollLoot(state, kill, mission) {
  const out = [];
  const lootMult = kill.mods.loot || 1;
  const rewardMult = kill.mods.reward || 1;
  const gems = Math.round((2 + mission.level * 1.5) * rewardMult * (0.8 + R.rand() * 0.4));
  out.push({ kind: 'gems', amount: gems });
  const table = [
    { kind: 'nothing', weight: 70 },
    { kind: 'resource', key: ['crops', 'ore', 'herbs'][R.randInt(0, 2)], amount: Math.round((3 + mission.level) * lootMult), weight: 22 },
    { kind: 'equipment', weight: 6 * lootMult },
    { kind: 'potion', weight: 2 * lootMult },
  ];
  const pick = M.mercyPick(state.mercy, table, (e, r) => (e.kind === 'equipment' || e.kind === 'potion' ? `drop:${kill.def.id}:${e.kind}` : null));
  if (pick.kind !== 'nothing') out.push(pick);
  return out;
}

// ---------- debrief ----------
//
// What a run does to the people who walked out of it, for both formats. finish() calls debrief()
// with the Gate party and Sortie.settle() with the squad of a contract, so a Gate run and a
// contract teach and cost the same.
//
// SURVIVOR_STEPS is the place for an effect on one survivor. debrief() runs every step in the list
// for each survivor, in order, and a step is a function of { state, c, hp, casts, low, won, fallen,
// level, fights, where, hurt } that returns log lines or nothing. An effect on the party as a whole
// goes after the survivor loop in debrief().

// Class XP for encounters stops at the longest Gate run, so a contract with more skirmishes than a
// zone has encounters pays no more than a zone run does.
const FOUGHT_CAP = Math.max(...MISSIONS.map(m => m.encounters.length));
// Stamina a mission costs each survivor, for the Gate and for contracts.
const missionStamina = (level) => 25 + level * 1.5;

/** A class is learned by doing the work: coming back teaches something, and coming back with the job done teaches twice as much. */
function classXp({ c, won, fights }) {
  const cl = CL();
  if (!cl) return [];
  const lines = [];
  for (const up of [cl.returned(c, { won }), cl.fought(c, Math.min(fights, FOUGHT_CAP))]) {
    if (up) lines.push(up.grew ? `${c.name} specialised: ${up.def.name}` : `${c.name} is now ${cl.phrase(up.rank, up.def.name)}`);
  }
  return lines;
}

/** It costs a day of stamina and whatever they spent casting, and morale answers to how it went and who did not come back. */
function condition({ c, casts, won, fallen, level }) {
  const co = CO();
  if (!co) return [];
  co.spend(c, { staminaCost: missionStamina(level), casts });
  co.outcome(c, { won, lost: fallen });
  return [];
}

/**
 * The lowest HP fraction the survivor had at the end of a fight sets how long it is out
 * (Condition.wound). A survivor with no `low` is not injured. Injured survivors are added to
 * `hurt`, and debrief() writes one log line for all of them.
 */
function wounds({ c, low, where, hurt }) {
  const co = CO();
  const w = co && co.wound(c, low, where);
  if (w) hurt.push({ c, ...w });
  return [];
}

/** Service record (roster.js): one more run behind the survivor, with how it went. Writes no log line. */
function service({ c, won, fallen, low, where }) {
  const ro = RO();
  if (ro) ro.noteSortie(c, { won, fallen, low, where });
  return [];
}

const SURVIVOR_STEPS = [classXp, condition, wounds, service];

/**
 * One log line for the survivors a run injured: "Injured at Goblin Camp: Bram back in 8 ticks (lowest HP 18%),
 * Cara back in 3 ticks (31%)". The ticks are the figure every screen prints (Condition.wounded): the wound
 * divided by the healing rate of that character's bed and the pantry, not the wound's length before healing.
 * `hurt` is empty without condition.js (wounds() fills it), so `co` is set here.
 */
function woundLine(state, hurt, where) {
  const co = CO();
  const pct = (h) => Math.round(h.low * 100) + '%';
  return `🩹 Injured${where ? ' at ' + where : ''}: ` +
    hurt.map((h, i) => `${h.c.name} back in ${co.tickText(co.wounded(state, h.c).ticks)} (${i === 0 ? 'lowest HP ' : ''}${pct(h)})`).join(', ');
}

/**
 * End of a run. Arguments:
 *   survivors  [{ c, hp, casts, low }] for the characters back on the roster; hp is the fraction of
 *              max HP they ended with, casts the number of spells they cast in the run, and low the
 *              lowest HP fraction they had at the end of any fight in it (undefined: no wound)
 *   fallen     how many died in the run
 *   won        the objective was met; a run that ended after contact without it is a loss
 *   level      mission level
 *   fights     encounters fought
 *   where      mission name, for the wound line
 * Returns { lootMult, lootBy, lines, hurt }. lootMult is the best class loot multiplier among the
 * survivors (a thief who died is not carrying anything), lootBy names the class that sets it, or
 * is null at 1, lines are for the caller to write to the run or town log, and hurt lists
 * { c, ticks, low } for each survivor the run injured.
 */
function debrief(state, { survivors, fallen = 0, won, level, fights = 0, where = null }) {
  const lines = [];
  const hurt = [];
  for (const s of survivors) {
    for (const step of SURVIVOR_STEPS) lines.push(...(step({ state, ...s, won, fallen, level, fights, where, hurt }) || []));
  }
  if (hurt.length) lines.push(woundLine(state, hurt, where));
  const chars = survivors.map(s => s.c);
  // Bonds. Walking out together moves every pair (bonds.js EVENTS). Coming back from a run that
  // went wrong moves them more and does not depend on whether they liked each other. The pair's
  // run count, which Crew.cohesion reads as rapport, goes up by 1 for a won run and by 0.5 for a
  // lost one; the 'mission' move in the bond value is the same for both.
  const bo = BO();
  if (bo && chars.length > 1) {
    bo.together(state, chars, 'mission', 1, won ? 1 : 0.5);
    if (won) bo.together(state, chars, 'won');
    if (fallen) bo.together(state, chars, 'survived');
    else if (!won) bo.together(state, chars, 'survived', 0.5);
  }
  const cl = CL();
  const lootMult = cl ? cl.partyLoot(chars) : 1;
  let lootBy = null;
  if (lootMult > 1) {
    const holder = chars.find(c => cl.lootMult(c) === lootMult);
    const held = holder && cl.held(holder).find(h => h.def.loot === lootMult);
    lootBy = held ? held.def.name : null;
  }
  return { lootMult, lootBy, lines, hurt };
}

function finish(state, run, mission, completed) {
  run.result = completed ? 'completed' : 'failed';
  run.finishedAt = Date.now();
  run.lost = [];
  const back = [], dead = [];
  const co = CO();
  for (const id of run.party) {
    const c = state.characters.find(x => x.id === id);
    if (!c) continue;
    c.mission = null;
    if (co) co.clearMeal(c);
    (run.members[id].alive ? back : dead).push(c);
  }
  // death is permanent wherever it happens; roster.js retires the characters, locks their
  // identities and applies what it costs the living. Without it loaded (node tests) fall back to
  // the old long recovery. The memorial cause is '<mission>: <killer>' from the fight block that
  // recorded the fall (Bestiary.causeOf), as for a contract death (sortie.js release), and the
  // mission name alone when no block names a killer or Bestiary is not loaded.
  const cause = (c) => (typeof Bestiary !== 'undefined' ? Bestiary.causeOf(state, run, c.id, mission.name) : mission.name);
  if (typeof Roster !== 'undefined') { Roster.fallAll(state, dead, { cause }); run.lost = dead.map(c => c.name); }
  else for (const c of dead) c.injured = INJURY_TICKS;
  const out = debrief(state, {
    survivors: back.map(c => ({ c, hp: run.members[c.id].hp, casts: run.members[c.id].casts || 0, low: run.members[c.id].low })),
    fallen: dead.length, won: completed, level: mission.level, fights: run.encounter, where: mission.name,
  });
  run.log.push(...out.lines);
  const loot = out.lootMult;
  const rewards = {};
  if (completed) {
    for (const [k, v] of Object.entries(mission.reward)) rewards[k] = Math.round(v * loot);
    for (const [k, v] of Object.entries(rewards)) state[k] = (state[k] || 0) + v;
    state.missions.done[mission.id] = (state.missions.done[mission.id] || 0) + 1;
  }
  run.rewards = rewards;
  run.lootMult = loot;
  state.missions.history.unshift({ id: run.id, mission: run.mission, result: run.result, party: run.party, log: run.log, loot: run.loot || [], rewards: run.rewards, members: run.members, finishedAt: run.finishedAt, encounters: run.encounters || [], lost: run.lost || [] });
  state.missions.history = state.missions.history.slice(0, 20);
}

function unlocked(state, mission) {
  const i = MISSIONS.indexOf(mission);
  if (i <= 0) return true;
  return (state.missions.done[MISSIONS[i - 1].id] || 0) > 0;
}

const MissionsAPI = { PARTY_MAX, INJURY_TICKS, FOUGHT_CAP, BESTIARY, MISSIONS, MISSION, TIERS, MODIFIERS, RARITIES, spawn, aptLevel, missionProfile, prepare, launch, tick, recover, unlocked,
  // the end-of-run hook for both formats; missionStamina is the stamina it charges per survivor
  debrief, missionStamina,
  // used by sortie.js, which runs a mission live on a map and needs the same ledgers
  rollLoot, trainFromFight };
if (typeof module !== 'undefined') module.exports = MissionsAPI;
if (typeof window !== 'undefined') window.Missions = MissionsAPI;
})();
