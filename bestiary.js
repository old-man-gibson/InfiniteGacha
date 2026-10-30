// Bestiary: what the town has learned about the things beyond the gate. Browser: window.Bestiary.
//
// Nothing here is given. An entry opens the first time a party SEES a monster and fills in as
// they kill it: the name and its kind at a glance, what it hits with after the first kill, how
// tough it is after three, what it shrugs off and what hurts it after five. Everything a report
// or a card shows about an enemy comes through `knowledge()`, so the player only ever reads what
// somebody came home knowing.
//
// Also records every fight into the run as a structured encounter (report.js reads those), and
// holds the table that names one portrait file in assets/enemies for each monster.

(() => {
const KNOW = { seen: 1, kill1: 1, kill3: 3, kill5: 5 };

// One picture per monster: species id -> file name in assets/enemies/index.json. The Bestiary
// tab, the fight reports and the field map (fieldview.js spriteFor) all read this table through
// portrait(), so a species looks the same in all three. A species with no row has no portrait
// and its icon stands in. test/portraits.js fails when a species has no row, a row names a file
// that is not in the index or not on disk, or two species of different tiers share a file.
const PORTRAITS = {
  forest_rat: 'Basics Stitch Rat.png',
  young_wolf: 'Elemental Wolf Earth.png',
  wolf: 'Corrupted Fire Wolf.png',
  boar: 'Wild Boar.png',
  cliff_hawk: 'Assorted Monsters Storm Hawk.png',
  cave_spider: 'Cave Monsters Earth Spider.png',
  goblin: 'Forest Goblin Dagger.png',
  goblin_boss: 'Boss Champion Goblin.png',
  slime: 'Slimei.png',
  slime_ice: 'Eldritch Ice Slimei.png',
  slime_fire: 'Slime Variation Fire Slime.png',
  slime_water: 'Slime Wateri.png',
  slime_wind: 'Slime Windi.png',
  slime_thunder: 'Slime Thunderi.png',
  slime_earth: 'Slime Earthi.png',
  slime_nature: 'Slime Nature Slime.png',
  slime_zombie: 'Slime Zombie Slime.png',
  slime_soldier: 'Slime Soldier Spear.png',
  slime_arcane: 'Slime Arcane Slime.png',
  slime_dark: 'Darkness Slime GhastMallow.png',
  slime_holy: 'Light Slime.png',
  stone_golem: 'Rock golem.png',
  slime_king: 'Slime RPG King.png',
  death_knight: 'Bone Knight Muller.png',
  spider_queen: 'Boss Insect Queen.png',
};

// File names from assets/enemies/index.json, keyed by their lower-case form so a row matches
// whatever case the index uses. Built once when the index loads; null until then.
let index = null;
let loading = null;
/** Fetch the file list once. Concurrent and repeat callers share one request; a failed fetch leaves an empty list. */
function loadIndex() {
  return loading || (loading = (async () => {
    let list = [];
    try { list = await (await fetch('assets/enemies/index.json')).json(); } catch (e) { list = []; }
    index = new Map(list.map(f => [f.toLowerCase(), f]));
    return list;
  })());
}
/** True once loadIndex() has finished, whether or not the fetch worked. */
const ready = () => index !== null;
/** URL of the species' portrait, or null before the index loads, for a species with no row, or when the row's file is not in the index. */
function portrait(id) {
  const file = PORTRAITS[id] && index && index.get(PORTRAITS[id].toLowerCase());
  return file ? 'assets/enemies/' + encodeURIComponent(file) : null;
}

// ---------- the ledger ----------
const ensure = (state) => (state.bestiary = state.bestiary || {});
function entry(state, id) {
  const b = ensure(state);
  return b[id] || (b[id] = { seen: 0, killed: 0, lostTo: 0, first: 0, last: 0, maxLevel: 0, hits: 0, dealt: 0, taken: 0, inflicted: {} });
}

/**
 * Record one encounter. Call right after Combat.encounter(). `enemies` and `party` are the
 * combatants that fought (their stats are still on them); `res` is what encounter() returned.
 * Writes the ledger AND pushes a structured encounter onto run.encounters for the report.
 * `n` is the run's fight count when it keeps one (run.fights, which survives the trimming of
 * run.encounters), else the position in the list. `extra` is merged into the block: the caller's
 * own facts about the fight (sortie.js passes the ground width and the squad's HP at its start).
 * `falls` copies res.falls: who of the party died, to whom and by what (combat.js encounter).
 */
function record(state, run, enemies, party, res, level = 1, extra = null) {
  const now = Date.now();
  const killedIds = new Set(res.kills.map(k => k.def.id));
  for (const e of enemies) {
    const en = entry(state, e.def.id);
    en.seen++;
    if (!en.first) en.first = now;
    en.last = now;
    en.maxLevel = Math.max(en.maxLevel, e.level || level);
    en.dealt += Math.round(e.stats.damageDealt || 0);
    en.taken += Math.round(e.stats.damageTaken || 0);
    en.hits += e.stats.attacks || 0;
    if (!e.alive) en.killed++;
    else if (!res.won) en.lostTo++;
  }
  // what they did to us, by condition name, read off the party's own statuses at fight end
  for (const f of party) for (const s of (f.statuses || [])) {
    const src = enemies.find(e => e.name === s.source);
    if (src) { const en = entry(state, src.def.id); en.inflicted[s.id] = (en.inflicted[s.id] || 0) + 1; }
  }
  if (run) {
    run.encounters = run.encounters || [];
    run.encounters.push({
      n: run.fights || run.encounters.length + 1, won: res.won, timedOut: !!res.timedOut, ticks: res.ticks,
      enemies: enemies.map(e => ({ id: e.def.id, name: e.name, icon: e.icon, level: e.level, alive: e.alive, maxHp: e.maxHp, hp: Math.max(0, Math.round(e.hp)), dealt: Math.round(e.stats.damageDealt || 0), attacks: e.stats.attacks || 0 })),
      party: party.map(f => ({ id: f.char ? f.char.id : null, name: f.name, alive: f.alive, hp: Math.max(0, Math.round(f.hp)), maxHp: f.maxHp,
        dealt: Math.round(f.stats.damageDealt || 0), taken: Math.round(f.stats.damageTaken || 0), healed: Math.round(f.stats.healed || 0),
        attacks: f.stats.attacks || 0, crits: f.stats.crits || 0, dodges: f.stats.dodges || 0, parries: f.stats.parries || 0, casts: f.stats.casts || 0, techniques: f.stats.techniques || 0, potions: f.stats.potions || 0,
        conditions: (f.statuses || []).map(s => s.id) })),
      kills: res.kills.map(k => ({ id: k.def.id, name: k.def.name, by: k.killer ? k.killer.name : null })),
      falls: (res.falls || []).map(f => ({ ...f })),
      log: res.log.slice(-40),
      ...extra,
    });
  }
  return killedIds;
}

/**
 * Somebody laid eyes on one. Opens the entry at the lowest tier — a name and a kind, and nothing
 * about what it does — which is all that looking at a thing across a room is worth; killing it is
 * what fills the rest in (see record). Called from the field the moment a hostile is spotted, so
 * a recon that never draws a blade still comes home having taught the town something, and the
 * next contract naming that species reads as a name on the brief instead of a ???.
 * Returns true the first time this species has ever been seen.
 */
function sight(state, def, level = 1) {
  const en = entry(state, def.id);
  const first = !en.seen;
  en.seen++;
  if (!en.first) en.first = Date.now();
  en.last = Date.now();
  en.maxLevel = Math.max(en.maxLevel, level);
  return first;
}

// ---------- what is known ----------

/** Knowledge tiers for an entry: 0 unseen, 1 seen, 2 one kill, 3 three kills, 4 five kills. */
function tier(en) {
  if (!en || !en.seen) return 0;
  if (en.killed >= KNOW.kill5) return 4;
  if (en.killed >= KNOW.kill3) return 3;
  if (en.killed >= KNOW.kill1) return 2;
  return 1;
}

/**
 * Everything the player is allowed to see about a monster, given what the town has done to it.
 * `def` is the bestiary definition; `sample` is a freshly built combatant (Combat.fromMonster)
 * used only to read resistances and armor, never shown until earned.
 */
function knowledge(state, def, sample) {
  const en = ensure(state)[def.id];
  const t = tier(en);
  const k = { id: def.id, name: def.name, icon: def.icon, tier: t, seen: en ? en.seen : 0, killed: en ? en.killed : 0, lostTo: en ? en.lostTo : 0, maxLevel: en ? en.maxLevel : 0 };
  if (t >= 1) { k.tags = def.tags; k.grade = def.tier; }
  if (t >= 2) { k.damageType = def.damageType; k.inflicts = (def.inflicts || []).map(i => i.id); k.inflicted = en.inflicted; }
  if (t >= 3) { k.attrs = def.attrs; k.armor = sample ? Math.round(sample.base.armor) : undefined; k.hp = sample ? sample.maxHp : undefined; k.damage = sample ? Math.round(sample.base.damage) : undefined; }
  if (t >= 4 && sample) {
    k.resists = Object.entries(sample.res).filter(([, v]) => v > 0.05).sort((a, b) => b[1] - a[1]);
    k.weak = Object.entries(sample.res).filter(([, v]) => v < -0.05).sort((a, b) => a[1] - b[1]);
  }
  return k;
}

/**
 * A species' name as the town may read it: the name once the town has seen one (tier 1 and up in
 * knowledge()), '???' before that. `id` is the species id, `name` the name the fight carried.
 */
function nameOf(state, id, name) {
  return knowledge(state, { id, name }, null).tier > 0 ? name : '???';
}

/**
 * The memorial text for character `id`, who fell in `run`: '<where>: <killer name>' from the fight
 * block that recorded the fall (res.falls, combat.js encounter), else '<where>' alone. No killer is
 * named when the fall has no attacker (conditions), when no block holds the fall (a trap, field.js),
 * or when the killer's species is unseen. The latest block wins; a character falls once.
 */
function causeOf(state, run, id, where) {
  const blocks = run.encounters || [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const f = (blocks[i].falls || []).find(x => x.id === id);
    if (!f) continue;
    const by = f.by ? (f.byId ? nameOf(state, f.byId, f.by) : f.by) : null;
    return by && by !== '???' ? `${where}: ${by}` : where;
  }
  return where;
}

const TIER_LABEL = ['Unknown', 'Sighted', 'Studied', 'Understood', 'Mastered'];
const TIER_HINT = ['Never met', 'Seen once: name and kind', 'One kill: how it fights', 'Three kills: how tough it is', 'Five kills: what it resists and what hurts it'];

// ---------- the brief ----------
//
// What a party can expect to walk into, written down before they walk into it. TWO independent
// things decide how much of a row is legible, and neither of them is difficulty:
//
//   THE CONTRACT (mission.intel, missiontypes.js) — whether the paper names what is out there at
//     all. A siege can be counted from outside the wall. A recon names nothing, because finding
//     out is the entire job.
//   THE TOWN (this file) — what a name MEANS. "Cave Spider" is a word until somebody has killed
//     enough of them to know what it shrugs off, and the row says which of those you have.
//
// So one monster reads four different ways depending on what the client wrote down and who has
// met it, and every one of those readings points at something somebody did. Nothing here invents
// a number: the count is the cast's own count, the level is the level it will be spawned at, and
// anything about the monster itself comes through knowledge() and is therefore earned.

const roundTo = (n, step) => Math.max(step, Math.round(n / step) * step);

/** The count, at the precision the contract was written to. */
function countText(n, intel) {
  if (intel >= 3) return '×' + n;
  if (intel <= 0) return '×?';
  if (n < 10) return intel >= 2 ? '×' + n : '×' + roundTo(n, 2);
  return '×~' + roundTo(n, intel >= 2 ? 5 : 10);
}

const GRADE_WORD = { basic: 'something', veteran: 'something bigger', elite: 'something dangerous', ancient: 'something old', legendary: 'something out of a story' };

/**
 * Rows for a launch brief. `cast` is the mission's own cast list (missiontypes.js), `level` its
 * level, `intel` how much the contract gave away. `levelOf` says what level a group is actually
 * fielded at — grade bumps and horde offsets live with whoever spawns them, not here.
 */
function brief(state, { cast, level, intel = 1 }, { Missions, Combat, levelOf } = {}) {
  const at = levelOf || ((g) => Math.max(1, level + (g.levelOffset || 0)));
  const rows = new Map();
  for (const g of cast || []) {
    if (!['hostile', 'patrol', 'mark'].includes(g.role) || g.side === 'ours' || !(g.count > 0)) continue;
    const named = intel >= 2 && g.species && Missions && Missions.BESTIARY[g.species];
    const lv = at(g);
    // A named target is its own row even when it turns out to be the same species as the rank and
    // file, because the terms point at IT: 'kill the guardian' is not 'kill an Arcane Slime'.
    const handle = g.role === 'mark' ? (g.name || 'the target') : null;
    const key = `${named ? g.species : g.grade || g.role}|${lv}|${g.per || ''}|${handle || g.role}`;
    const row = rows.get(key) || { count: 0, level: lv, per: g.per || null, role: g.role, grade: g.grade, handle, horde: g.horde || 0, pack: g.pack || 0 };
    row.count += g.count;
    row.horde = Math.max(row.horde, g.horde || 0);
    if (named) row.def = Missions.BESTIARY[g.species];
    rows.set(key, row);
  }
  const out = [];
  for (const row of rows.values()) {
    const def = row.def;
    // What the town knows about it, which is a separate question from whether the paper named it.
    // Unnamed rows get no knowledge at all — you cannot look something up that has not been said.
    const k = def && Missions ? knowledge(state, def, Combat ? Combat.fromMonster(def, row.level, {}, {}) : null) : null;
    out.push({
      ...row,
      icon: def ? def.icon : '❔',
      name: (def ? def.name : '???') + (row.handle ? ` — the ${row.handle}` : ''),
      levelText: intel >= 1 ? 'lvl ' + row.level : 'lvl ?',
      countText: countText(row.count, intel),
      // a row nobody has met is a name and nothing else, and says so rather than looking complete
      tier: k ? k.tier : 0,
      known: k && k.tier ? TIER_LABEL[k.tier] : (def ? 'Never met' : (GRADE_WORD[row.grade] || 'Something')),
      hint: def ? (k && k.tier ? TIER_HINT[k.tier] : 'the town has never seen one') : 'the contract does not say what',
      hp: k && k.hp, armor: k && k.armor, damageType: k && k.damageType,
      resists: (k && k.resists) || [], weak: (k && k.weak) || [],
      inflicts: (k && k.inflicts) || [],
    });
  }
  // the worst news first: the named target, then the biggest thing, then the most of it
  out.sort((a, b) => (b.role === 'mark' ? 1 : 0) - (a.role === 'mark' ? 1 : 0) || b.level - a.level || b.count - a.count);
  // With nothing on the paper at all, four rows of "??? lvl ? ×?" is worse than one: it says
  // nothing four times, and the number of rows leaks how many kinds are out there.
  if (intel <= 0 && out.length > 1) {
    return [{ ...out[0], count: out.reduce((n, r) => n + r.count, 0), icon: '❔', name: '???',
              levelText: 'lvl ?', countText: '×?', per: null, horde: 0,
              known: 'Nothing on the paper', hint: 'whoever wrote this had not been' }];
  }
  return out;
}

/** One line summarising a brief, for a card that has no room for rows. */
function briefLine(rows) {
  if (!rows.length) return 'nothing on the paper';
  return rows.map(r => `${r.icon} ${r.name} ${r.levelText} ${r.countText}${r.per ? ' per ' + r.per : ''}`).join(' · ');
}


const BestiaryAPI = { KNOW, PORTRAITS, TIER_LABEL, TIER_HINT, loadIndex, ready, portrait, ensure, entry, record, sight, tier, knowledge, nameOf, causeOf, brief, briefLine, countText };
if (typeof module !== 'undefined') module.exports = BestiaryAPI;
if (typeof window !== 'undefined') window.Bestiary = BestiaryAPI;
})();
