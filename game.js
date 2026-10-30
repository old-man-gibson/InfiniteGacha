// InfiniteGacha base: summon, roster, town buildings, jobs that gather and craft, inventory.
// Depends on stats.js (Stats), proficiency.js (Prof), economy.js (Econ), affinity.js (Affinity), classes.js (Classes), lpc.js (LPC),
// rng.js (Rng), mercy.js (Mercy), ai.js (AI), elements.js, spellcraft.js, psionic.js, martial.js, combat.js, missions.js,
// savestore.js (SaveStore).
(() => {
const SAVE_KEY = 'infinitegacha.save.v2';
const OLD_SAVE_KEY = 'infinitegacha.save.v1';
const PULL_COST = 100;
const TICK_MS = 10000;
const MAX_OFFLINE_TICKS = 2880;    // 8 hours of ten-second ticks
const OFFLINE_BUDGET_MS = 6000;   // stop simulating after this long and say so
const SHIFT_LOG = 30;        // ticks between rota summaries, so the log is not only the rota

const { RESOURCES, JOBS, BUILDINGS, LODGINGS, TOWN, TENT, QUALITY, SLOTS } = Econ;

const $ = (sel) => document.querySelector(sel);

// ---------- state ----------
let state = null;

function newState() {
  return {
    gems: 1000, crops: 0, ore: 0, herbs: 0,
    town: 0, tents: 0,
    buildings: Object.fromEntries(Object.keys(BUILDINGS).map(k => [k, 0])),
    characters: [], inventory: {}, log: [], orders: {},
    mercy: {}, bonds: {}, missions: { active: [], done: {}, history: [] },
    lastTick: Date.now(), nextId: 1,
  };
}

// Set while an imported or restored save is being written and the page is on its way to reloading.
// Without it the tick, and sortie.js flushing its run on beforeunload, write the OLD state straight
// back over the file that was just imported — the import appears to work and is gone a second later.
let frozen = false;

const errName = (e) => (e && e.name) || 'Error';

// Every SaveStore call below gets its storage object from here. Evaluating `localStorage` can throw
// (blocked site data, sandboxed frame) before SaveStore runs, so a bare `localStorage` argument
// would make opening the save panel and Reset throw. store() turns that into a refusal that
// SaveStore reports as { ok: false, error } or as an empty slot.
const store = () => SaveStore.guard(() => localStorage);

// Name of the error from the last save that failed, or null after one succeeded. The 500 ms
// writer of #tick appends it to the countdown, so a full or blocked store shows in the header.
let saveError = null;

function save() {
  if (frozen) return;
  let r;
  // SaveStore.write frees the undo copy and retries when the first write fails (quota); the catch
  // is for JSON.stringify failing
  try { r = SaveStore.write(store(), SAVE_KEY, JSON.stringify(state)); } catch (e) { r = { ok: false, error: e }; }
  saveError = r.ok ? null : errName(r.error);
}

function load() {
  let st = null;
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) st = JSON.parse(raw);
    else {
      const old = localStorage.getItem(OLD_SAVE_KEY);
      if (old) st = migrateV1(JSON.parse(old));
    }
  } catch (e) { /* ignore */ }
  st = st || newState();
  const fresh = newState();
  for (const k of Object.keys(fresh)) if (st[k] === undefined) st[k] = fresh[k];
  for (const k of Object.keys(BUILDINGS)) if (st.buildings[k] === undefined) st.buildings[k] = 0;
  // The members of the sortie that was saved mid-run: Sortie.resume gives them c.mission back after this function has cleared it.
  const inSortie = new Set((st.field && st.field.run && st.field.run.party) || []);
  for (const c of st.characters) {
    if (!c.profs) c.profs = Prof.rollAll(c.stats.stars, c.race);
    for (const k of Object.keys(Prof.PROFICIENCIES)) if (!c.profs[k]) c.profs[k] = Prof.rollOne(c.stats.stars, (Prof.RACE_BIAS[c.race] || {})[k] || 0);
    for (const k of Object.keys(c.profs)) if (!Prof.PROFICIENCIES[k]) delete c.profs[k];
    if (c.progress === undefined) c.progress = 0;
    if (c.job && !JOBS[c.job]) c.job = null;
    if (!c.affinity) c.affinity = Affinity.roll();
    // characters from before bloodlines existed get their roll now, same odds as at the gate
    if (c.heroic === undefined) {
      if (c.humanFace === undefined) c.humanFace = (c.selections || []).some(s => /heads_human/.test(s.id));
      c.heroic = LPC.rollHeroic(c.race, c.humanFace);
      if (c.heroic) LPC.applyHeroicBonus(c.stats, c.heroic.bonus);
    }
    if (!c.equipment) c.equipment = {};
    if (!c.potions) c.potions = [];
    if (!c.xp) c.xp = {};
    if (c.sacrifices === undefined) c.sacrifices = 0;
    // Characters from before the roll was kept get today's block stamped as their birth block.
    // It is wrong by however much has been poured into them or advanced onto them, and there is
    // no way to work backwards: `absorbed` records who was spent, not what each one carried. So
    // it is a one-off approximation, said plainly on the sheet, and correct from here on.
    if (!c.stats.born) { Stats.freezeBorn(c.stats); c.stats.born.estimated = true; }
    if (!c.mind) c.mind = { traits: AI.rollMindTraits() };
    Temper.ensure(c);                        // seeded by whatever hidden traits they already carry
    if (!c.gifts) { Gifts.ensure(c, c.class ? Classes.def(c) : null); if (Gifts.has(c, 'arcana') && !(c.lexicon || []).length) c.lexicon = Spellcraft.rollLexicon(c.stats.stars); }
    if (!c.lexicon) c.lexicon = [];
    if (!c.psiOrder) c.psiOrder = Psionic.rollAxisOrder();
    if (!c.techniques) c.techniques = {};
    // Innate abilities. Two plain-JSON keys and no version bump: everything the engine persists is
    // a record and a state bag, and the compiled status definitions it builds from them are rebuilt
    // at load rather than saved, so changing the compiler costs no migration.
    if (!c.facets) c.facets = [];
    if (!c.facetState) c.facetState = {};
    if (!c.facetCaps) c.facetCaps = {};
    if (c.class) Classes.ensure(c);          // drops a class that no longer exists, normalises old shapes
    if (c.trade) Classes.ensureTrade(c);
    Condition.ensure(c);
    // Service record (roster.js). Counting starts at this load for a character from before it existed,
    // and the sheet says so ("record starts <date>").
    c.record = Object.assign(Roster.blankRecord(), c.record);
    if (!c.worked) c.worked = {};
    if (c.injured === undefined) c.injured = 0;
    if (c.mission && !st.missions.active.some(r => r.id === c.mission)) c.mission = null;
    // A launch meal (condition.js feed) lasts as long as the run it was eaten for. One with no gate run
    // and no saved sortie behind it is left over from a run that ended some other way: drop it.
    if (c.meal && !c.mission && !inSortie.has(c.id)) Condition.clearMeal(c);
  }
  for (const k of ['active', 'done', 'history']) if (!st.missions[k]) st.missions[k] = k === 'done' ? {} : [];
  // one tiered lodging plus a pile of tents becomes a yard that houses the same people
  if (Lodging.migrate(st)) st.beds = null;
  // equipment crafted before item types existed can't be trained with: drop it
  for (const [id, it] of Object.entries(st.inventory)) if (it.kind === 'equipment' && !it.type) delete st.inventory[id];
  // buildings may have fewer slots than a job had workers (older saves): drop the extras to idle
  for (const [k, j] of Object.entries(JOBS)) {
    if (!j.building) continue;
    const slots = BUILDINGS[j.building].tiers[st.buildings[j.building]].slots;
    st.characters.filter(c => c.job === k).slice(slots).forEach(c => { c.job = null; c.progress = 0; });
  }
  // Names were once drawn without looking at who was already standing there, so an old save can
  // hold three people called Freya. Whoever arrived first keeps the bare name; the rest take the
  // byname they should have been handed at the gate. Idempotent — a clean roster changes nothing.
  const renamed = Names.dedupe(st);
  if (renamed.length) {
    const shown = renamed.slice(0, 6).map(r => `${r.from} → ${r.to}`).join(', ');
    st.log.unshift({ t: Date.now(), text: `\u{1F4DB} ${renamed.length} shared name${renamed.length === 1 ? '' : 's'} settled: ${shown}${renamed.length > 6 ? ` +${renamed.length - 6} more` : ''}` });
    st.log = st.log.slice(0, 40);
  }
  return st;
}

function migrateV1(old) {
  const st = newState();
  st.gems = old.gems || 0;
  st.crops = old.food || 0;
  st.ore = old.metal || 0;
  st.herbs = old.potions || 0;
  st.characters = old.characters || [];
  st.nextId = old.nextId || 1;
  st.lastTick = Date.now();
  return st;
}

// ---------- save files ----------
//
// A save lives in one browser's localStorage, which is a bad place for the only copy of a
// roster full of characters who cannot be summoned again. Export writes it to a file; import
// reads one back. The file is the whole state inside a small envelope — what game it belongs
// to, when it was written, and a summary a human can read without parsing anything — and import
// accepts a bare state too, so a save pulled straight out of localStorage still loads.
const SAVE_FORMAT = 1;

function saveSummary(st) {
  return {
    characters: (st.characters || []).length,
    town: TOWN[st.town || 0] ? TOWN[st.town || 0].name : '?',
    fallen: ((st.roster || {}).fallen || []).length,
    gems: st.gems || 0,
  };
}

function exportText() {
  return JSON.stringify({
    game: 'InfiniteGacha', format: SAVE_FORMAT, key: SAVE_KEY,
    exported: new Date().toISOString(), summary: saveSummary(state), state,
  });
}

function exportName() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `infinitegacha-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.json`;
}

/** Hand the file to the browser. Returns false if the browser would not take it. */
function downloadSave() {
  try {
    const blob = new Blob([exportText()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportName();
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return true;
  } catch (e) { return false; }
}

/**
 * Read a file back. Accepts the envelope or a bare state, and refuses anything that is not
 * recognisably this game rather than loading half a save over a live one.
 */
function parseSave(text) {
  let o;
  try { o = JSON.parse(text); } catch (e) { return { ok: false, why: 'that is not JSON at all' }; }
  const st = o && typeof o.state === 'object' && o.state ? o.state : o;
  if (!st || typeof st !== 'object') return { ok: false, why: 'there is no save in that file' };
  if (!Array.isArray(st.characters)) return { ok: false, why: 'no roster in that file — is it an InfiniteGacha save?' };
  if (typeof st.nextId !== 'number' || typeof st.gems !== 'number') return { ok: false, why: 'that save is missing pieces and would not load' };
  return { ok: true, state: st, summary: saveSummary(st), exported: o && o.exported };
}

/**
 * Put an imported save in place and start again from it. Writing localStorage and RELOADING —
 * rather than assigning to `state` — means load() does the work it always does: filling in
 * fields the file predates, dropping aptitudes that no longer exist, rebuilding a run in
 * progress. The save being replaced is kept under a rollback key, one undo deep (savestore.js);
 * restoreSave() below is the control for it.
 */
function importSave(st) {
  frozen = true;                                  // nothing writes over this on the way out
  let r;
  try { r = SaveStore.replace(store(), SAVE_KEY, JSON.stringify(st)); } catch (e) { r = { ok: false, error: e }; }
  if (!r.ok) {
    frozen = false;
    return { ok: false, why: `the browser would not store a save that size (${errName(r.error)})` };
  }
  location.reload();
  return { ok: true };
}

/**
 * Swap the current save and the previous one, then reload. The save that was current becomes the
 * previous one, so a restore is undone by another restore. `frozen` is set before the swap for the
 * reason it is set in importSave: the tick and sortie.js would otherwise write the current state
 * back over the restored key on the way out. Nothing is changed when it returns { ok: false }.
 */
function restoreSave() {
  const s = store();
  if (!SaveStore.hasRollback(s, SAVE_KEY)) return { ok: false, why: 'there is no previous save' };
  frozen = true;
  const r = SaveStore.restore(s, SAVE_KEY);
  if (!r.ok) {
    frozen = false;
    return { ok: false, why: `the browser would not store the previous save (${errName(r.error)})` };
  }
  location.reload();
  return { ok: true };
}

// A town with no characters and nothing on the memorial has nothing worth keeping. Reset skips the
// undo copy for it, so a second Reset cannot overwrite the first one's copy with an empty town.
const isHollow = (st) => { const sum = saveSummary(st); return sum.characters === 0 && sum.fallen === 0; };

// ---------- town helpers ----------
const tierOf = (b) => BUILDINGS[b].tiers[state.buildings[b]];
// Rest and housing are per character now: which bed somebody got is a fact about them, not
// about the town (lodging.js). `restMult()` survives as the town's average, for the few places
// that want one number — everything that touches a person asks about that person.
const restFor = (c) => Lodging.restFor(state, c);
const capacity = () => Lodging.capacity(state);
function restMult() {
  const cs = state.characters;
  if (!cs.length) return 1;
  return cs.reduce((a, c) => a + Lodging.restFor(state, c), 0) / cs.length;
}
const plotsTotal = () => TOWN[state.town].plots;
const plotsUsed = () => Object.keys(BUILDINGS).length + Lodging.plotsUsed(state);
function canBuildLodging(type) {
  const def = LODGINGS[type];
  if (!def) return { ok: false, why: 'no such lodging' };
  if (plotsUsed() + def.plots > plotsTotal()) return { ok: false, why: 'no room left on this plateau' };
  if (!Econ.canAfford(state, def.cost)) return { ok: false, why: 'not enough resources' };
  return { ok: true };
}
function addLodging(type) {
  const gate = canBuildLodging(type);
  if (!gate.ok) return gate;
  const res = Lodging.build(state, type);
  if (!res.ok) return res;
  logLine(`${LODGINGS[type].icon} Built a ${LODGINGS[type].label.toLowerCase()} — ${LODGINGS[type].beds} beds`);
  save(); renderAll();
  return res;
}
function removeLodging(id) {
  const inst = Lodging.find(state, id);
  if (!inst) return;
  Lodging.demolish(state, id);
  logLine(`🧹 Pulled down a ${LODGINGS[inst.type].label.toLowerCase()}`);
  save(); renderAll();
}
const housed = (c) => Lodging.housed(state, c);
function slotsFor(job) { const b = JOBS[job].building; return b ? tierOf(b).slots : Infinity; }
function workers(job) { return state.characters.filter(c => c.job === job); }

function canUpgradeBuilding(b) {
  const next = BUILDINGS[b].tiers[state.buildings[b] + 1];
  if (!next) return { ok: false, why: 'max tier' };
  if (state.buildings[b] + 1 > state.town) return { ok: false, why: `needs town tier ${state.town + 2}${TOWN[state.town + 1] ? ' (' + TOWN[state.town + 1].name + ')' : ''}` };
  if (!Econ.canAfford(state, next.cost)) return { ok: false, why: 'not enough resources' };
  return { ok: true };
}
function upgradeBuilding(b) {
  if (!canUpgradeBuilding(b).ok) return;
  Econ.pay(state, BUILDINGS[b].tiers[state.buildings[b] + 1].cost);
  state.buildings[b]++;
  logLine(`${BUILDINGS[b].icon} ${BUILDINGS[b].label} upgraded to ${tierOf(b).name}`);
  save();
}
function canUpgradeTown() {
  const next = TOWN[state.town + 1];
  if (!next) return { ok: false, why: 'max tier' };
  if (!Econ.canAfford(state, next.cost)) return { ok: false, why: 'not enough resources' };
  return { ok: true };
}
function upgradeTown() {
  if (!canUpgradeTown().ok) return;
  Econ.pay(state, TOWN[state.town + 1].cost);
  state.town++;
  logLine(`🏙️ Town grew into a ${TOWN[state.town].name}`);
  save();
}

// ---------- production ----------
function aptitudeMult(p) { return 0.6 + p.stage * 0.1 + (p.level - 1) / Prof.LEVELS_PER_STAGE * 0.1; }

// Per-tick work points for character c on job k. Includes building multiplier and rest.
/**
 * What this character produces at this job right now. `potential` drops the things that are true
 * of the moment rather than of the person — a roof, and how tired they are — so that "who is
 * best at mining" is a question about the miner and not about whether they happen to be spent.
 */
function outputFor(c, k, potential = false) {
  const job = JOBS[k];
  if (!job) return 0;
  const [a, b] = job.stats;
  // Gear counted: a good pick is supposed to make a better miner, and the +CON on it is half
  // of what the smithy is for.
  const eb = Stats.effective(c).base;
  let v = (eb[a] + eb[b]) / 8 * (c.profs[k] ? aptitudeMult(c.profs[k]) : 1);
  if (job.kind === 'gather' || job.kind === 'train') v *= tierOf(job.building).mult;
  if (job.kind === 'town') v *= job.rate;
  v *= potential ? 1.1 : restFor(c);
  if (!potential) {
    if (!housed(c)) v *= 0.5;
    v *= Condition.workMult(c);
    // and the person: a perfectionist is slower at everything and a hungry one pushes, which is
    // the whole trade — the slow one is the reason anything good comes off the bench below
    v *= Temper.work(c);
  }
  return v;
}
function jobOutput(c) { return c.job ? outputFor(c, c.job) : 0; }
const fmtOut = (v) => v >= 10 ? Math.round(v).toString() : v.toFixed(1);
function bestCandidates(k) { return [...state.characters].sort((a, b) => outputFor(b, k, true) - outputFor(a, k, true)); }

function addItem(item) {
  const id = Econ.itemId(item);
  if (!state.inventory[id]) state.inventory[id] = { ...item, count: 0 };
  state.inventory[id].count++;
}

function logLine(text) {
  state.log.unshift({ t: Date.now(), text });
  state.log = state.log.slice(0, 40);
}

// ---------- who spends the day with whom ----------
//
// Two people become something to each other by being in the same place, and the town already
// knows where everybody is: at a post, or under a roof. This reads those two facts once per tick
// and hands them to bonds.js, which decides what an hour of it was worth to that particular pair.
//
// One tick together is worth a fraction of a point, so the player never watches a bond change:
// after an hour of play two of their miners are friends. Bonds accumulate this way everywhere
// else in this game too.
const LODGING_EVERY = 6;        // ticks between counting a night under the same roof
const DRIFT_EVERY = 40;         // ticks between letting people who never meet drift apart

let company = new Map();        // character id -> everyone they are spending this tick with

/** The shift lists and the roof lists, built once and read by everybody on them. */
function readCompany() {
  company = new Map();
  const byJob = {}, byBed = {};
  for (const c of state.characters) {
    if (c.mission) continue;
    if (c.job) (byJob[c.job] = byJob[c.job] || []).push(c);
    const bed = Lodging.bedOf(state, c);
    if (bed) (byBed[bed.id] = byBed[bed.id] || []).push(c);
  }
  const share = (group) => { for (const c of group) company.set(c.id, [...(company.get(c.id) || []), ...group.filter(o => o.id !== c.id)]); };
  for (const g of Object.values(byJob)) if (g.length > 1) share(g);
  // a roof only counts as company for the people actually under it, not the ones out at a post
  for (const g of Object.values(byBed)) {
    const home = g.filter(c => !c.job);
    if (home.length > 1) share(home);
  }
  return { byJob, byBed };
}

const companyFor = (c) => company.get(c.id) || [];

/** Everything a tick of living does to who likes whom. */
function tickBonds(n) {
  const { byJob, byBed } = readCompany();
  for (const [k, g] of Object.entries(byJob)) {
    if (g.length < 2) continue;
    Bonds.together(state, g, k === 'training' ? 'trained' : 'shift');
  }
  if (n % LODGING_EVERY === 0) {
    for (const g of Object.values(byBed)) {
      const home = g.filter(c => !c.job);
      if (home.length > 1) Bonds.together(state, home, 'lodging');
    }
  }
  if (n % DRIFT_EVERY === 0) Bonds.drift(state);
}

// Deaths from the Gate, contracts and the altar all end in Roster.fallAll, which applies the grief
// and writes its lines through this logger.
Roster.setLog(logLine);

function tick(times = 1) {
  for (let n = 0; n < times; n++) {
    state.ticks = (state.ticks || 0) + 1;
    tickBonds(state.ticks);
    // The pantry is opened once for the whole town: everyone resting eats out of the same
    // stock, and if it runs dry partway through the day the rest of them go without.
    const resting = state.characters.filter(c => !c.mission && !c.job).length;
    const fedTown = mealStock() > 0;
    if (fedTown && resting) {
      state.mealBank = (state.mealBank || 0) + resting * MEAL_PER_REST;
      if (state.mealBank >= 1) { const ate = eatMeals(Math.floor(state.mealBank)); state.mealBank -= ate; }
    }
    for (const c of state.characters) {
      const job = JOBS[c.job];
      // Everyone spends a tick, including the people doing nothing — resting IS the other half
      // of the rotation, and somebody on a mission is living it out there instead.
      if (!c.mission) {
        const before = Condition.isSpent(c);
        Condition.tick(c, { job: job ? job.kind : null, housed: housed(c), restMult: restFor(c), lodging: Lodging.moraleFor(state, c), fed: fedTown, social: Bonds.company(state, c, companyFor(c)) });
        // Innate abilities get the town tick too. Without this a facet can only ever fire while
        // somebody is being hit, which makes every generated ability a combat ability no matter what
        // the registry describes — the engine would be able to read a character's morale and never
        // be anywhere it could do something about it.
        if (typeof FacetHostIG !== 'undefined') {
          FacetHostIG.townEvent('townTick', c, { job: job ? job.kind : null, fed: fedTown, housed: housed(c), wasSpent: before });
        }
        // going off shift is reported once for the whole rota below, not once per person
      }
      if (!job || c.mission) continue;
      const out = outputFor(c, c.job);
      if (job.kind === 'gather' || job.kind === 'town') {
        // bank fractional output so slow workers still add up instead of being floored to 1
        c.yieldBank = (c.yieldBank || 0) + out;
        const whole = Math.floor(c.yieldBank);
        if (whole > 0) { state[job.produces] += whole; c.yieldBank -= whole; }
        // a gathering trade is proved on what actually reached the town, not on the bank
        tradeNews(c, Classes.worked(c, c.job, out));
      } else if (job.kind === 'process') {
        tradeNews(c, Classes.worked(c, c.job));
        c.progress = (c.progress || 0) + out;
        let crafted = 0;
        while (c.progress >= job.threshold && Econ.canAfford(state, job.consumes) && crafted < 5) {
          Econ.pay(state, job.consumes);
          c.progress -= job.threshold;
          const want = state.orders[c.job] || (job.crafts === 'equipment' ? Outfit.nextEquipment(state) : job.crafts === 'potion' ? Outfit.nextPotion(state) : null);
          // Rigor reaches the bench as aptitude: an exacting hand rolls quality like somebody two
          // stages better trained, a slapdash one like somebody two stages worse. It is the same
          // roll — this is the only place in the game where a temper touches an item.
          const apt = c.profs[c.job];
          const hand = { ...apt, stage: Math.max(0, apt.stage + Temper.craft(c)) };
          const item = Econ.craftItem(job.crafts, tierOf(job.building).quality, hand, Math.random, want);
          addItem(item);
          crafted++;
          // the craft trade watches every piece that leaves the bench, good or bad
          tradeNews(c, Classes.crafted(c, c.job, item.quality));
          if (item.quality >= 3) logLine(`${job.icon} ${c.name} crafted a ${item.name}`);
        }
        if (c.progress >= job.threshold) c.progress = job.threshold; // waiting on materials
      } else if (job.kind === 'train') {
        trainTick(c);
      }
    }
    {
      // one line for the whole shift change: ninety people clocking off is not ninety log lines
      const ev = rotateWorkers();
      const off = ev.filter(e => e.kind === 'off'), on = ev.filter(e => e.kind !== 'off');
      // A rota on a hundred-character roster moves somebody almost every tick, which would make
      // the log nothing but the rota. Bank the movements and mention them every SHIFT_LOG ticks.
      state.shiftTally = state.shiftTally || { off: 0, on: 0, since: 0 };
      state.shiftTally.off += off.length;
      state.shiftTally.on += on.length;
      state.shiftTally.since++;
      if (state.shiftTally.since >= SHIFT_LOG && (state.shiftTally.off || state.shiftTally.on)) {
        const bits = [];
        if (state.shiftTally.off) bits.push(`${state.shiftTally.off} off shift`);
        if (state.shiftTally.on) bits.push(`${state.shiftTally.on} back to work`);
        logLine(`\u{1F504} Shift changes: ${bits.join(', ')}`);
        state.shiftTally = { off: 0, on: 0, since: 0 };
      }
    }
    for (const run of Missions.tick(state, { fed: fedTown })) settleMission(run);
    const sup = Outfit.supply(state, addItem);
    for (const e of sup.equipped) logLine(`🎽 ${e.c.name} took the ${e.item.name}${e.old ? ` (returned ${e.old.name})` : ''}`);
    for (const p of sup.potions) logLine(`🧪 ${p.c.name} packed a ${p.item.name}`);
  }
}

// A finished run: hand out loot, write the story to the log.
function settleMission(run) {
  const mission = Missions.MISSION[run.mission];
  const names = run.party.map(id => (state.characters.find(c => c.id === id) || {}).name).filter(Boolean).join(', ');
  const q = Math.min(5, Math.floor(mission.level / 4));
  for (const drop of (run.loot || [])) {
    if (drop.kind === 'gems') state.gems += drop.amount;
    else if (drop.kind === 'resource') state[drop.key] += drop.amount;
    else if (drop.kind === 'equipment') { const it = Econ.craftItem('equipment', q, { stage: Math.min(22, mission.level + 2) }, Rng.rand); addItem(it); logLine(`🎁 ${it.name} found in ${mission.name}`); }
    else if (drop.kind === 'potion') { const it = Econ.craftItem('potion', q, { stage: Math.min(22, mission.level + 2) }, Rng.rand); addItem(it); }
  }
  const gems = (run.loot || []).filter(d => d.kind === 'gems').reduce((a, d) => a + d.amount, 0);
  if (run.result === 'completed') logLine(`${mission.icon} ${names} completed ${mission.name} · ${Econ.costText(run.rewards)} + 💎 ${gems} loot`);
  else logLine(`${mission.icon} ${names} were beaten in ${mission.name} · 💎 ${gems} salvaged`);
  if (run.lost && run.lost.length) logLine(`⚱️ ${run.lost.join(', ')} did not come back`);
}

// ---------- the mess ----------
//
// Meals were being crafted and then sat in the inventory forever. Now they are eaten: anyone
// resting eats, a little at a time, and being fed both speeds the rest and takes most of the
// sting out of having no bed. A town with a kitchen going can keep people on their feet that it
// has no room to house — which is the difference between a housing shortage and a slum.
const MEAL_PER_REST = 0.02;        // meals eaten per resting character per tick (one feeds 50)

const mealStock = () => Object.values(state.inventory).filter(i => i.kind === 'meal').reduce((a, i) => a + i.count, 0);
// The wound on a character as the roster tile and the sheet print it: Condition.wounded gives the ticks
// until the town tick has healed them (at their own bed, with the pantry as it is now; Missions.recover
// heals by the same two inputs), the phrase, and the tooltip that derives the figure. '' when not injured.
const woundSpan = (c) => {
  const w = Condition.wounded(state, c);
  return w ? `<span class="warn" title="${w.why.replace(/"/g, '&quot;')}">${w.text}</span>` : '';
};
// The meal a character ate at launch and the points it adds in fights (Condition.mealOf), for the
// Condition section of the sheet. '' for somebody who is not out on a run with a meal.
const mealSpan = (c) => {
  const m = Condition.mealOf(c);
  return m ? `<div class="sub" title="${m.why.replace(/"/g, '&quot;')}">\u{1F372} ${m.text}</div>` : '';
};

// The duty cycle of the rota is one number with two readings. condition.js drains about twice
// as fast as it recovers, so a character works forty ticks and sleeps twenty. Read one way that
// says what share of the roster is in bed and eating; read the other it says what share of a
// posted worker's output the town actually banks over an hour. Everything that has to reason
// about the town over a long stretch — what it eats, what a post is worth — comes through here,
// because a figure computed from this exact second makes the panel flicker.
const REST_SHARE = 1 / 3;
const DUTY = 1 - REST_SHARE;

/**
 * Meals the town eats per tick. Counted off the ROTA rather than off this second's bed count:
 * the share resting swings from nothing to everything as shifts turn, and reading it live made
 * the kitchen's target jump around while the player was watching it, which is the same fault as
 * reading a post's output live. A third of the roster is asleep on average, and on average is
 * the only tense a staffing decision is ever made in.
 */
function mealDrain() {
  return state.characters.filter(c => !c.mission).length * REST_SHARE * MEAL_PER_REST;
}

/**
 * What this character delivers at a post over an HOUR rather than over this second.
 *
 * outputFor() answers "what are they producing right now", which swings between full and nothing
 * as the rota puts them to bed and fetches them back. That is the wrong question to size a
 * workforce with: it made staffing understaff every post by a third, and it made the
 * panel flip between met and short at every shift change, which reads as a fault in the town
 * rather than as somebody having a nap. So keep everything STANDING about them — their roof,
 * their temper, their morale — and replace only the part that moves, their stamina, with the
 * duty cycle the rota settles into anyway.
 */
function sustained(c, k) {
  return outputFor(c, k, true) * DUTY * (housed(c) ? 1 : 0.5) * Condition.moraleMult(c) * Temper.work(c);
}

/** Everyone whose post this is — including the ones the rota has in bed at this exact moment. */
const crewOf = (k) => state.characters.filter(c => !c.mission && (c.job === k || (!c.job && c.shift === k)));

/** What that post banks per tick with the whole of its crew counted, sleepers included. */
const staffedAt = (k) => crewOf(k).reduce((a, c) => a + sustained(c, k), 0);

/** Eat n meals' worth from the pantry, worst first — the banquets keep. Returns what was eaten. */
function eatMeals(n) {
  let want = n, ate = 0;
  const pantry = Object.entries(state.inventory)
    .filter(([, i]) => i.kind === 'meal' && i.count > 0)
    .sort((a, b) => a[1].quality - b[1].quality);
  for (const [id, item] of pantry) {
    if (want <= 0) break;
    const take = Math.min(item.count, Math.ceil(want));
    item.count -= take; ate += take; want -= take;
    if (item.count <= 0) delete state.inventory[id];
  }
  return ate;
}

/**
 * A rank crossing, said out loud — and if the work named them on the way past, that is the part
 * worth reading, so it leads.
 */
function classNews(c, up) {
  if (up.grew) return `\u{1F331} ${c.name} specialised: ${up.grew.from.name} \u2192 ${up.def.name}`;
  return `\u{1F396}\u{FE0F} ${c.name} is now ${Classes.phrase(up.rank, up.def.name)}`;
}

/** A trade earned or a trade ranked up, said out loud. Nothing else announces one. */
function tradeNews(c, news) {
  if (!news) return;
  if (news.earned) logLine(`${news.earned.icon} ${c.name} has done the hours: ${news.earned.name}`);
  else if (news.ranked) logLine(`${news.def.icon} ${c.name} is now a ${news.ranked.label} ${news.def.name}`);
}

// One tick of training: every equipped item raises its aptitude, scaled by affinity growth.
//
// THREE LAYERS, and this is the only place all three meet. Affinity supplies preference (what
// this body likes) and compatibility (what it is built for); a class supplies training (what
// somebody taught it). They add, so a Fighter drilling with their preferred sword trains far
// faster than the same body with no class and no feel for the weapon. The class also decides
// where training STOPS: ordinary training caps at A+, and only a class's mastery aptitudes go
// past that, at master and grandmaster.
const TRAIN_BASE = 0.25; // aptitude levels per tick before modifiers (a stage is 30 levels, so ~10 min per stage at base)
function trainTick(c) {
  const t = tierOf('training');
  const [a, b] = JOBS.training.stats;
  const fb = Stats.effective(c).base;
  const focus = 0.5 + (fb[a] + fb[b]) / 40;   // 0.65 .. 2.0
  const baseCap = Affinity.has(c.affinity, 'omnimaster') ? Prof.STAGE['S+'] : Prof.MAX_ADVANCE_STAGE;
  let worked = false;
  for (const item of Object.values(c.equipment)) {
    if (!item || !item.type) continue;
    const apt = Affinity.aptitudeOf(item.type);
    if (!c.profs[apt]) c.profs[apt] = Prof.rollOne(c.stats.stars, (Prof.RACE_BIAS[c.race] || {})[apt] || 0);
    const growth = Affinity.growthMult(c.affinity, item.type) + Classes.trainBonus(c, apt);
    const capStage = Classes.capStage(c, apt, baseCap);
    const gain = TRAIN_BASE * t.mult * focus * restFor(c) * growth * (1 + 0.1 * item.quality) * (housed(c) ? 1 : 0.5);
    c.xp[apt] = (c.xp[apt] || 0) + gain;
    const levels = Math.floor(c.xp[apt]);
    if (levels > 0) {
      c.xp[apt] -= levels;
      const before = c.profs[apt].stage;
      c.profs[apt] = Prof.gain(c.profs[apt], levels, capStage);
      if (c.profs[apt].stage > before) logLine(`🎯 ${c.name} reached ${Prof.STAGES[c.profs[apt].stage]} ${Prof.PROFICIENCIES[apt].label}`);
    }
    Affinity.use(c.affinity, item.type, t.mult);
    worked = true;
  }
  // Drill is how a class is learned, and the slow way round: a mission is worth fifty of these.
  if (worked) { const up = Classes.trained(c, t.mult); if (up) logLine(classNews(c, up)); }
}

/**
 * ROTATION — the day, in two halves.
 *
 * A spent character GOES OFF SHIFT whether or not anybody can replace them. That has to be
 * unconditional: the first version only swapped somebody out when a rested idle character was
 * standing there to take the post, and since a well-staffed town has nobody idle, nobody was
 * ever relieved. Everyone ground down to nothing and stayed at their bench at nine percent
 * stamina forever. Nobody went to bed because nothing ever sent them.
 *
 * So: the spent go home, and the rested come back — to the post they left if it is still free,
 * because a farmer who wakes up should go back to the farm rather than wherever there is a gap.
 * Their progress waits for them (see setJob's `keep`).
 *
 * Temperament does not exempt anyone from going off shift. It used to be able to veto it, so a
 * dogged character stayed at a post below a fifth of their stamina producing a third of what
 * they used to, forever, and on this roster that is most of the town. Grit now decides how soon
 * they come BACK instead (condition.js returnAt): a shorter rest rather than no rest. That is
 * the effect of doggedness on the town's output.
 */
function rotateWorkers() {
  if (state.autoRotate === false) return [];
  const events = [];

  // 1. everyone at or below SPENT stops, replacement or not, willing or not
  for (const c of state.characters) {
    if (!c.job || c.mission || !Condition.isSpent(c)) continue;
    c.shift = c.job;
    setJob(c.id, null, { keep: true });
    events.push({ kind: 'off', c, job: c.shift });
  }

  // 2. and everyone who has slept it off goes back to work, their own post first
  const back = state.characters
    .filter(c => !c.job && !c.mission && !(c.injured > 0) && c.shift && Condition.readyToReturn(c))
    .sort((a, b) => outputFor(b, b.shift, true) - outputFor(a, a.shift, true));
  for (const c of back) {
    if (workers(c.shift).length >= slotsFor(c.shift)) continue;
    const post = c.shift;
    if (setJob(c.id, post, { keep: true })) { c.shift = null; events.push({ kind: 'on', c, job: post }); }
  }

  // 3. any post still short takes the best rested hand who is doing nothing — and the posts are
  //    walked in the order the town needs them (crew.js demands()), not in the order the job
  //    table happens to be written in. The button is pressed once an hour and the rota runs every
  //    tick, so leaving this on declaration order meant the mine outbid the kitchen for every
  //    spare pair of hands about six seconds after staffing had decided otherwise.
  const spare = () => state.characters.filter(c => !c.job && !c.mission && !(c.injured > 0) && Condition.readyToReturn(c));
  const needed = typeof Crew !== 'undefined' ? Crew.demands(state, jobApi()).map(n => n.job) : [];
  for (const k of [...new Set([...needed, ...Object.keys(JOBS)])]) {
    const j = JOBS[k];
    if (j.kind === 'train') continue;                 // the drill hall is filled on purpose, not by rota
    let room = slotsFor(k) - workers(k).length;
    if (room <= 0) continue;
    // a tradesman is not a spare pair of hands — the rota fills gaps around them, not with them
    const worth = (c) => outputFor(c, k, true) * (typeof Crew !== 'undefined' ? Crew.tradePull(c, k) : 1);
    const pool = spare().sort((a, b) => worth(b) - worth(a));
    for (const c of pool) {
      if (room <= 0) break;
      if (outputFor(c, k, true) <= 0) break;
      if (setJob(c.id, k)) { room--; events.push({ kind: 'fill', c, job: k }); }
    }
  }
  return events;
}

// ---------- equipment ----------
function equip(c, invId) {
  const it = state.inventory[invId];
  if (!it || it.kind !== 'equipment' || it.count <= 0) return false;
  unequip(c, it.slot);
  const { count, ...item } = it;
  c.equipment[it.slot] = item;
  it.count--;
  save();
  return true;
}
function unequip(c, slot) {
  const item = c.equipment[slot];
  if (!item) return;
  addItem(item);
  delete c.equipment[slot];
  save();
}

// Simulate the time away, tick by tick, and account for it. Returns the report or null.
function catchUp() {
  const elapsed = Date.now() - state.lastTick;
  const asked = Math.floor(elapsed / TICK_MS);
  if (asked <= 0) return null;
  const ticks = Math.min(MAX_OFFLINE_TICKS, asked);
  const before = Offline.snapshot(state, Object.keys(RESOURCES));
  const t0 = performance.now();
  let done = 0;
  while (done < ticks) {
    const n = Math.min(60, ticks - done);
    tick(n);
    done += n;
    if (performance.now() - t0 > OFFLINE_BUDGET_MS) break;
  }
  // Time past the cap, or past the budget, is forfeit rather than banked.
  state.lastTick = done < ticks || asked > MAX_OFFLINE_TICKS ? Date.now() : state.lastTick + done * TICK_MS;
  const report = Offline.report(state, before, { elapsedMs: elapsed, ticks: done, asked, cap: MAX_OFFLINE_TICKS, ms: performance.now() - t0 },
    { RESOURCES, PROF: Prof.PROFICIENCIES, STAGES: Prof.STAGES, MISSION: Missions.MISSION, inventoryName: (id) => id.split(':')[1] });
  state.lastAway = report;
  save();
  return report;
}

function showAway(report) {
  if (!report) return;
  $('#away-body').innerHTML = Offline.html(report, TICK_MS);
  $('#away').hidden = false;
}

// The Town tab's projection of what the current rota earns per hour.
function awayEstimateCard() {
  const io = { outputFor, JOBS, RESOURCES, MISSION: Missions.MISSION, TICK_MS, cap: MAX_OFFLINE_TICKS };
  const box = document.createElement('div');
  box.className = 'townhead';
  box.innerHTML = `<div style="flex:1"><h3>⏳ Away estimate <span class="sub">per hour at the current rota</span></h3>${Offline.estimateHtml(Offline.estimate(state, io), io)}</div>`;
  if (state.lastAway) {
    const b = document.createElement('button'); b.className = 'ghost'; b.textContent = 'Last away report';
    b.addEventListener('click', () => showAway(state.lastAway));
    box.append(b);
  }
  return box;
}

// ---------- characters ----------
// Star tier rolls through Mercy: 4★ and 5★ are rare enough to be pity-tracked, so droughts
// escalate the odds until they land and reset. The long-run rate is exactly the authored one.
function rollStarsWithPity() {
  const entries = Object.entries(Stats.STARS).filter(([n, t]) => Number(n) <= Stats.MAX_PULL_STARS && t.weight > 0).map(([n, t]) => ({ n: Number(n), weight: t.weight }));
  return Mercy.mercyPick(state.mercy, entries, (e, rate) => (Mercy.mercyTracked(rate) ? 'pull:' + e.n : null)).n;
}

function summon() {
  if (state.gems < PULL_COST) return null;
  state.gems -= PULL_COST;
  const stars = rollStarsWithPity();
  // The dead do not come back wearing new names: roster.js locks the identity and the face of
  // everyone who has fallen, and drawUnique keeps rolling until the draw is somebody new.
  const draw = () => {
    const ch = LPC.generate(null, stars);
    return {
      race: ch.race, bodyType: ch.bodyType, selections: ch.selections, stats: ch.stats,
      heroic: ch.heroic || null, humanFace: !!ch.humanFace,
      profs: Prof.rollAll(ch.stats.stars, ch.race), affinity: Affinity.roll(),
      mind: { traits: AI.rollMindTraits() }, temper: Temper.roll(), gifts: Gifts.roll(ch.stats, ch.race),
      lexicon: [], psiOrder: Psionic.rollAxisOrder(), techniques: {},
    };
  };
  const drawn = typeof Roster !== 'undefined' ? Roster.drawUnique(state, draw) : draw();
  const c = {
    id: state.nextId++, name: Names.pickFor(state, drawn.race),
    ...drawn,
    equipment: {}, potions: [], xp: {}, job: null, progress: 0, injured: 0, mission: null, obtained: Date.now(),
    record: Roster.blankRecord(),
  };
  // A few classes are never taught. If this one came through the gate with one, it says so here
  // and nowhere else: it cannot be trained into later and it cannot be fused in.
  const born = Classes.rollBirthright(c, Rng.rand);
  // A birthright implies its path; then the lexicon is rolled only for the arcane-born.
  Gifts.ensure(c, born);
  if (Gifts.has(c, 'arcana')) c.lexicon = Spellcraft.rollLexicon(c.stats.stars);
  state.characters.push(c);
  Lodging.invalidate(state);
  logLine(`✨ Summoned ${c.name}, a ${c.stats.stars}★ ${c.race} · ${Gifts.nameOf(c).icon} ${Gifts.nameOf(c).name}`);
  if (born) logLine(`${born.icon} ${c.name} is a ${born.name} — summon-only, cannot be trained`);
  save();
  return c;
}

/**
 * Put somebody on a job, or take them off one. `keep` is for going OFF SHIFT rather than
 * changing trade: a crafter who goes to bed halfway through an anvil should find the piece where
 * they left it in the morning, not start again, so the progress bar and the yield bank survive.
 */
function setJob(id, job, { keep = false } = {}) {
  const c = state.characters.find(x => x.id === id);
  if (!c || c.mission) return false;
  if (job && workers(job).length >= slotsFor(job)) return false;
  const same = keep && (!job || job === c.shift || job === c.job);
  c.job = job || null;
  if (!same) { c.progress = 0; c.yieldBank = 0; }
  save();
  return true;
}

/**
 * One star gained. The tier-up is COUNTED on the character, because that count is what opens a
 * fusion slot (classes.js FUSE_AT) — and a count is personal: a 1-star pushed all the way to 7
 * has been through six of them and earns both slots, while a 5-star pulled straight out of the
 * gate has two left in it and earns neither. Keeping a weak character alive is the only road to
 * a fused one.
 */
function advanceCharacter(c) {
  if (c.stats.stars >= Stats.MAX_STARS) return false;
  c.stats = Stats.advance(c.stats);
  c.profs = Prof.advanceAll(c.profs, c.stats.stars);
  const slot = Classes.tieredUp(c);
  logLine(`⭐ ${c.name} is now ${c.stats.stars}★`);
  if (slot) logLine(`🜂 ${c.name} reached tier-up ${c.tierUps}: a fusion slot is open`);
  save();
  return true;
}

// Releasing is not a death: no memorial, no grief. The released character's bond pairs are dropped
// so the ledger does not keep names that are off the roster.
function release(id) { state.characters = state.characters.filter(x => x.id !== id); Bonds.tidy(state, state.characters); Lodging.invalidate(state); save(); }

// Sacrifice. sacrifice.js owns the arithmetic and the death, and its Roster.fall is the same death
// path a battlefield death takes, so the friends of the sacrificed character lose morale and the
// log says so. This is the town's side of it: write the trade into the log and persist. Releasing
// lets someone go, this spends them.
function sacrificeTo(target, sac) {
  const res = Sacrifice.apply(state, sac, target, altarShare());
  if (!res.ok) { notify(res.why); return res; }
  const levels = res.profs.reduce((a, g) => a + g.levels, 0);
  const parts = [`+${res.statTotal} stats`];
  if (levels) parts.push(`+${levels} aptitude levels`);
  if (res.techTotal) parts.push(`+${res.techTotal} technique reps`);
  logLine(`⚱️ ${sac.name} was sacrificed to ${target.name} · ${parts.join(', ')}`);
  save();
  return res;
}

// ---------- sprites ----------
// A roster screen can hold dozens of sprites, and walking every one of them in place costs a
// full recomposite per canvas per frame. So a sprite stands still on frame 0 and only animates
// while the pointer is on it; the loop itself stops dead when nothing is hovered.
const spriteLayers = new WeakMap();   // canvas -> composited LPC layers
const walking = new Set();            // canvases under the pointer right now
let spriteRaf = 0, frameTick = 0;
function animate() {
  frameTick++;
  const frame = 1 + (Math.floor(frameTick / 8) % (LPC.FRAMES - 1));
  for (const canvas of walking) {
    // a re-render can pull a hovered canvas out of the page without a pointerleave ever firing
    if (!canvas.isConnected) { walking.delete(canvas); continue; }
    const layers = spriteLayers.get(canvas);
    if (layers) LPC.drawFrame(canvas.getContext('2d'), layers, LPC.ROW_DOWN, frame);
  }
  spriteRaf = walking.size ? requestAnimationFrame(animate) : 0;
}
function standStill(canvas) {
  const layers = spriteLayers.get(canvas);
  if (layers) LPC.drawFrame(canvas.getContext('2d'), layers, LPC.ROW_DOWN, 0);
}
function spriteCanvas(c, size = 96) {
  const canvas = document.createElement('canvas');
  canvas.width = LPC.FRAME; canvas.height = LPC.FRAME;
  canvas.style.width = size + 'px'; canvas.style.height = size + 'px';
  LPC.buildLayers(c).then(layers => {
    spriteLayers.set(canvas, layers);
    if (!walking.has(canvas)) standStill(canvas);
  });
  canvas.addEventListener('pointerenter', () => {
    if (!walking.size) frameTick = 0;   // start on the first stride, not mid-step
    walking.add(canvas);
    if (!spriteRaf) spriteRaf = requestAnimationFrame(animate);
  });
  canvas.addEventListener('pointerleave', () => { walking.delete(canvas); standStill(canvas); });
  return canvas;
}

// ---------- rendering ----------

/**
 * Confirming an action that cannot be undone. This does not use confirm(). Embedded browsers —
 * the app's own preview pane among them — suppress native modals: confirm() returns false
 * immediately, no dialog is ever drawn, and every destructive button in the game does nothing
 * and shows no message. The click did not fail; the browser answered it with "no".
 *
 * So the confirmation lives in the page. The first click ARMS the button and says what will
 * happen, the second does it, and it disarms itself after a few seconds if nothing follows.
 */
function arm(btn, prompt, action, ms = 4000) {
  const label = btn.textContent, cls = btn.className, tip = btn.title;
  let timer = null;
  const disarm = () => {
    clearTimeout(timer);
    btn.dataset.armed = '';
    btn.textContent = label; btn.className = cls; btn.title = tip;
  };
  btn.addEventListener('click', () => {
    if (btn.dataset.armed === '1') { disarm(); action(); return; }
    btn.dataset.armed = '1';
    btn.textContent = prompt;
    btn.className = 'danger armed';
    btn.title = 'Click again to confirm';
    timer = setTimeout(disarm, ms);
  });
}

/**
 * And the other half of the same problem: alert() is suppressed in exactly the same places, so
 * every "you cannot do that, because..." was being written to a dialog nobody would ever see.
 * This says it in the page instead, and takes itself away again.
 */
function notify(text) {
  let box = $('#toast');
  if (!box) { box = document.createElement('div'); box.id = 'toast'; document.body.append(box); }
  box.textContent = text;
  box.classList.add('show');
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => box.classList.remove('show'), 3500);
}

function renderResources() {
  $('#resources').innerHTML = Object.entries(RESOURCES)
    .map(([k, r]) => `<span class="res" title="${r.label}">${r.icon} ${state[k]}</span>`).join('') +
    `<span class="res" title="Beds. Anyone without one works at half rate — unless the kitchen is feeding them.">🏠 ${Math.min(state.characters.length, capacity())}/${capacity()}</span>` +
    `<span class="res" title="Meals in the pantry. Resting characters eat the worst first: being fed speeds rest and takes most of the sting out of having no bed. Each squad member eats one, best first, when a sortie or a gate run launches, and gets its stat points for that run.">🍲 ${mealStock()}</span>`;
}

/**
 * The potential block on the sheet. The tile and the cards carry the letter with the figures in a
 * tooltip; the sheet has room to print them, so it prints them: both component values with the
 * expression that produced each, the sample size behind the percentile, and the per-stat
 * deviation the placement term was computed from. Every figure is checkable against the stat line
 * directly below it.
 */
function potentialLine(c) {
  const p = Potential.of(c);
  const dev = Stats.BASE_STATS.map(k => {
    const row = p.spread.find(x => x.key === k);
    const cls = row.delta >= 1 ? 'over' : row.delta <= -1 ? 'under' : '';
    return `<span class="${cls}" title="${Stats.STAT_NAMES[k]} ${row.have} at birth. Mean for this race and tier, scaled to ${p.total} points: ${row.expect.toFixed(1)}. Race tendency ${row.pull.toFixed(2)}."><i>${k.toUpperCase()}</i> ${row.delta > 0 ? '+' : ''}${row.delta.toFixed(1)}</span>`;
  }).join('');
  const cohort = p.cohortBuilt ? `${c.race} rolls advanced to ${p.stars}★` : `${p.stars}★ ${c.race} rolls`;
  const req = p.nearest ? Object.entries(p.nearest.req).map(([k, v]) => `${k.toUpperCase()} ${v}`).join(' + ') : '';
  return `<div><b class="pot" style="color:${p.color};border-color:${p.color}">${p.grade}</b>
      <b style="color:${p.color}"> percentile ${p.percentile}</b>
      <span class="sub">of ${Potential.SAMPLES} simulated ${cohort} · band ${p.label}</span></div>
    <div class="sub">Scored on the birth stat block: ${p.total} points, fixed at summon. Advancement and altar offerings change the stat line below, not this.${p.estimated ? ' <span class="warn">Birth block not recorded for this character; estimated from current stats.</span>' : ''}</div>
    <div class="potrow"><i>placement</i> <b>${p.fit.toFixed(3)}</b> <span class="sub">sum(race tendency × stat) / sum(stat)</span></div>
    <div class="potspread">${dev}<span class="sub">deviation from the mean roll</span></div>
    <div class="potrow"><i>reach</i> <b>${p.reach.toFixed(2)}</b> <span class="sub">best of (stat / class requirement)${p.nearest ? ` · nearest ${p.nearest.name}, needs ${req}${p.reach < 1 ? ' — <span class="warn">not met</span>' : ''}` : ''}</span></div>`;
}

// The stat line shows the person and what the gear adds, side by side. Printing only the total
// would hide where it came from, and printing only the base would hide that the gear works.
const statLine = (c) => {
  const eff = Stats.effective(c);
  return Stats.BASE_STATS.map(k => `<span title="${Stats.STAT_NAMES[k]}${eff.bonus[k] ? ` — ${c.stats.base[k]} their own, +${eff.bonus[k]} from what they carry` : ''}"><b>${k.toUpperCase()}</b> ${c.stats.base[k]}${eff.bonus[k] ? `<u>+${eff.bonus[k]}</u>` : ''}</span>`).join('');
};
function profLine(c, full = false) {
  const entries = full ? Object.entries(c.profs) : Prof.best(c.profs, 3);
  return entries.map(([k, p]) => `<span class="prof ${Prof.tierOf(p) === 'S' ? 'prof-s' : ''}" title="${Prof.format(p, true)}"><i>${Prof.PROFICIENCIES[k].label}</i> ${Prof.format(p)}</span>`).join('');
}

/**
 * The three bars that say what is left in somebody today: stamina, morale, and the pool they
 * cast from if they cast at all. A card without these is a card that cannot tell you why the
 * farm is producing half of what it says on the tin.
 */
function condLine(c) {
  const d = Condition.describe(c);
  const bar = (label, frac, color, text) =>
    `<div class="cbar" title="${label}: ${text}"><span>${label}</span><i><b style="width:${Math.round(frac * 100)}%;background:${color}"></b></i></div>`;
  const parts = [
    bar('STA', d.stamina.frac, d.stamina.band.color, `${Math.round(d.stamina.cur)}/${Math.round(d.stamina.max)} — ${d.stamina.band.label}`),
    bar('MOR', d.morale.frac, '#c9a227', `${Math.round(d.morale.cur)}/100 — ${d.morale.band.label}`),
  ];
  if (d.pool) parts.push(bar(d.pool.kind === 'mana' ? 'MP' : 'SP', d.pool.frac, d.pool.kind === 'mana' ? '#5591e0' : '#8f7ad8',
    `${Math.round(d.pool.cur)}/${Math.round(d.pool.max)} ${d.pool.kind}`));
  return parts.join('');
}

function characterCard(c, opts = {}) {
  const card = document.createElement('div');
  card.className = 'card';
  card.style.borderTop = `3px solid ${Stats.STARS[c.stats.stars].color}`;
  card.append(spriteCanvas(c, opts.size || 96));
  const info = document.createElement('div');
  info.innerHTML = `
    <div class="name">${Filters.rareMark(c)}${c.name}</div>
    <div class="sub">${c.race} · ${c.bodyType} · <span class="tag" title="${Gifts.describe(c).paths}${Gifts.describe(c).perk ? ': ' + Gifts.describe(c).perk : ''}">${Gifts.nameOf(c).icon} ${Gifts.nameOf(c).name}</span>${Classes.def(c) ? ` · <span class="tag" title="${Classes.title(c)}">${Classes.def(c).icon} ${Classes.shortTitle(c)}${Classes.fusionsUsed(c) ? ` +${Classes.fusionsUsed(c)}` : ''}</span>` : ''}${Classes.tradeDef(c) ? ` · <span class="tag" title="${Classes.tradeDef(c).desc}">${Classes.tradeDef(c).icon} ${Classes.tradeTitle(c)}</span>` : ''} · <span style="color:${AI.tier(c).color}" title="Acumen ${AI.acumen(c).toFixed(1)}: how well this character plans its spells, workings and technique loops">${AI.tier(c).label.toLowerCase()} mind</span>${housed(c) ? '' : ' · <span class="warn">unhoused</span>'}${c.mission ? ' · <span class="tag">on a mission</span>' : ''}${c.injured > 0 ? ` · ${woundSpan(c)}` : ''}${Sacrifice.count(c) ? ` · <span class="tag" title="${(c.absorbed || []).map(a => `${a.name} (${a.stars}★ ${a.race})`).join(', ')}">${Sacrifice.count(c)} sacrifice${Sacrifice.count(c) === 1 ? '' : 's'}</span>` : ''}</div>
    <div class="stars" style="color:${Stats.STARS[c.stats.stars].color}">${Stats.starString(c.stats.stars)}${Filters.badge(c)}</div>
    <div class="stats">${statLine(c)}</div>
    <div class="cond">${condLine(c)}</div>
    <div class="profs" data-full="0">${profLine(c)}</div>`;
  card.append(info);
  if (!opts.noFav) card.append(Filters.heart(c, () => { save(); renderAll(); }));
  if (!opts.noProfs) {
    const profs = info.querySelector('.profs');
    profs.title = 'Click to show all proficiencies';
    profs.addEventListener('click', () => {
      const full = profs.dataset.full !== '1';
      profs.dataset.full = full ? '1' : '0';
      profs.innerHTML = profLine(c, full);
    });
  }
  if (opts.controls) {
    const row = document.createElement('div');
    row.className = 'controls';
    const sel = document.createElement('select');
    sel.innerHTML = `<option value="">Idle</option>` + Object.entries(JOBS).map(([k, j]) => {
      const full = k !== c.job && workers(k).length >= slotsFor(k);
      return `<option value="${k}" ${c.job === k ? 'selected' : ''} ${full ? 'disabled' : ''}>${j.icon} ${j.label}${full ? ' (full)' : ''}</option>`;
    }).join('');
    sel.disabled = !!c.mission;
    sel.addEventListener('change', () => { setJob(c.id, sel.value); renderAll(); });
    const rel = document.createElement('button');
    rel.className = 'danger';
    rel.textContent = 'Release';
    arm(rel, 'Release?', () => { release(c.id); renderAll(); });
    row.append(sel, rel);
    card.append(row);
    if (c.job) {
      const out = document.createElement('div');
      out.className = 'sub';
      out.textContent = jobText(c);
      card.append(out);
    }
  }
  return card;
}

function jobText(c) {
  const job = JOBS[c.job];
  if (job.kind === 'train') { const n = Object.values(c.equipment).filter(Boolean).length; return n ? `training with ${n} item${n === 1 ? '' : 's'}` : 'training · nothing equipped!'; }
  if (job.kind === 'process') return `${Math.round(c.progress || 0)}/${job.threshold} progress · +${outputFor(c, c.job).toFixed(1)}/tick`;
  return `+${fmtOut(jobOutput(c))} ${RESOURCES[job.produces].icon} per tick`;
}

function renderSummon() {
  $('#pull').disabled = state.gems < PULL_COST;
  $('#pull').textContent = `Summon (${PULL_COST} 💎)`;
}

// ---------- the character sheet ----------
//
// The roster used to be the whole character: stats, condition, three aptitudes and a job select,
// on every card, eighty times over. That is a page you read, not a roster you use — and it still
// left out most of what a character actually is, because there was no room for the class, the
// affinity, the lexicon or a single thing about how they fight.
//
// So the roster is now a wall of faces, and everything else lives here, on a sheet you open by
// clicking one. The sheet leads with the radar: six spokes for what this character brings to the
// field (prowess.js), the roster's own average drawn faintly behind them so a shape means
// something on the first character as well as the eightieth, and a breakdown of whichever spoke
// you point at — because a chart that will not say WHY a spoke is short is just decoration.

const TIER_COLOR = { F: '#7a7a86', E: '#9a9aa6', D: '#c8c8d0', C: '#6fbf73', B: '#5591e0', A: '#ab47bc', S: '#ffd740' };
const SVGNS = 'http://www.w3.org/2000/svg';
const svgEl = (name, attrs = {}) => {
  const e = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

let sheetId = null;        // whose sheet is open, so the tick can keep its condition bars honest
let sheetAxis = null;      // which spoke they were reading, so giving an order does not lose it

/**
 * The radar. `axes` is what Prowess.of() returned; `avg` is the roster mean or null on a roster of
 * one. Returns the <svg> and a select(key) that lights one spoke — the sheet wires that to the
 * breakdown panel underneath.
 */
function radarChart(axes, avg, onSelect) {
  const W = 300, cx = W / 2, cy = W / 2, R = 86, n = axes.length;
  const at = (i, r) => {
    const a = -Math.PI / 2 + i * (Math.PI * 2 / n);
    return [cx + Math.cos(a) * r * R, cy + Math.sin(a) * r * R];
  };
  // A zero spoke still needs a point to draw to, or the polygon collapses through the middle.
  const poly = (vals) => vals.map((v, i) => at(i, Math.max(0.03, v)).join(',')).join(' ');

  const svg = svgEl('svg', { class: 'radar', viewBox: `0 0 ${W} ${W}` });
  for (const r of [0.25, 0.5, 0.75, 1]) svg.append(svgEl('polygon', { class: 'ring', points: poly(axes.map(() => r)) }));
  for (let i = 0; i < n; i++) {
    const [x, y] = at(i, 1);
    svg.append(svgEl('line', { class: 'spoke', x1: cx, y1: cy, x2: x, y2: y }));
  }
  if (avg) svg.append(svgEl('polygon', { class: 'avg', points: poly(avg.map(a => a.value)) }));

  const shape = svgEl('polygon', { class: 'shape', points: poly(axes.map(a => a.value)) });
  svg.append(shape);

  const labels = [];
  axes.forEach((a, i) => {
    const [vx, vy] = at(i, a.value);
    svg.append(svgEl('circle', { class: 'dot', cx: vx, cy: vy, r: 3.5, fill: a.color }));

    const [lx, ly] = at(i, 1.2);
    const anchor = lx < cx - 2 ? 'end' : lx > cx + 2 ? 'start' : 'middle';
    const g = svgEl('g', { class: 'lbl', tabindex: '0', role: 'button' });
    const name = svgEl('text', { x: lx, y: ly + (i === 0 ? -2 : ly > cy ? 10 : 2), 'text-anchor': anchor });
    name.textContent = `${a.icon} ${a.label}`;
    const val = svgEl('text', { class: 'val', x: lx, y: ly + (i === 0 ? 9 : ly > cy ? 21 : 13), 'text-anchor': anchor });
    val.textContent = `${Math.round(a.value * 100)}`;
    g.append(name, val);
    g.addEventListener('click', () => select(a.key));
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(a.key); } });
    svg.append(g);
    labels.push({ key: a.key, g });
  });

  function select(key) {
    for (const l of labels) l.g.classList.toggle('on', l.key === key);
    const a = axes.find(x => x.key === key);
    shape.setAttribute('stroke', a.color);
    shape.setAttribute('fill', a.color);
    if (onSelect) onSelect(a);
  }
  return { svg, select };
}

/** One weighted component of an axis, as a labelled bar with its plain reading underneath. */
function partRow(part, color) {
  const row = document.createElement('div');
  row.className = 'apart';
  row.innerHTML = `
    <div class="ptop"><b>${part.label}</b><i>${Math.round(part.value * 100)}</i></div>
    <div class="pbar"><span style="width:${Math.round(part.value * 100)}%;background:${color}"></span></div>
    <div class="ptext">${part.text}</div>`;
  return row;
}

const sec = (title, html) => `<div class="sec"><h4>${title}</h4>${html}</div>`;

function aptChips(c) {
  const groups = {};
  for (const [k, def] of Object.entries(Prof.PROFICIENCIES)) (groups[def.group] = groups[def.group] || []).push(k);
  return Object.entries(groups).map(([group, keys]) => {
    const chips = keys
      .sort((a, b) => Prof.toAbsolute(c.profs[b]) - Prof.toAbsolute(c.profs[a]))
      .map(k => {
        const p = c.profs[k], tier = Prof.tierOf(p);
        return `<span class="chip${Prof.isS(p) ? ' s' : ''}" title="${Prof.PROFICIENCIES[k].label} ${Prof.format(p, true)}"
          ><i>${Prof.PROFICIENCIES[k].label}</i> <b style="color:${TIER_COLOR[tier]}">${Prof.format(p)}</b></span>`;
      }).join('');
    return `<div class="aptgroup"><div class="gname">${group}</div><div class="chips">${chips}</div></div>`;
  }).join('');
}

/** Everything a character carries, by slot, with the empty slots said out loud. */
function gearLines(c) {
  return SLOTS.map(slot => {
    const it = c.equipment[slot];
    if (!it) return `<div class="gear"><i>${slot}</i> <span class="dim">empty</span></div>`;
    const q = QUALITY[it.quality];
    return `<div class="gear"><i>${slot}</i> <b style="color:${q.color}">${it.name}</b></div>`;
  }).join('') + (c.potions && c.potions.length ? `<div class="gear"><i>potions</i> ${c.potions.map(p => p.name).join(', ')}</div>` : '');
}

/** What this character has actually learned, as opposed to what they are capable of learning. */
function knowledgeLines(c) {
  const out = [];
  const techs = Martial.known(c);
  out.push(`<div class="gear"><i>techniques</i> ${techs.length ? techs.map(t => `${t.icon} ${t.name}`).join(', ') : '<span class="dim">none — no technique this loadout allows</span>'}</div>`);
  const words = Spellcraft.lexiconOf(c);
  out.push(`<div class="gear"><i>lexicon</i> ${words.length} words · ${words.map(w => (Spellcraft.WORDS[w] || {}).word || w).join(', ')}</div>`);
  const psiLevel = Math.floor(Prof.toAbsolute(c.profs.psionics || { stage: 0, level: 1 }) / 15);
  const axes = Psionic.openAxes(c, psiLevel);
  out.push(`<div class="gear"><i>psionic axes</i> ${axes.map(a => `${Psionic.AXES[a].icon} ${Psionic.AXES[a].name}`).join(', ')}</div>`);
  return out.join('');
}

/** The flags that change what you can do with somebody today. Rebuilt on every tick. */
function sheetFlags(c) {
  const bits = [];
  if (c.mission) bits.push('<span class="tag">on a mission</span>');
  if (c.injured > 0) bits.push(woundSpan(c));
  if (!housed(c)) bits.push('<span class="warn">unhoused · works at half rate</span>');
  if (c.job) bits.push(`<span class="tag">${JOBS[c.job].icon} ${JOBS[c.job].label}</span>`);
  if (Sacrifice.count(c)) bits.push(`<span class="tag" title="${(c.absorbed || []).map(a => `${a.name} (${a.stars}★ ${a.race})`).join(', ')}">absorbed ${Sacrifice.count(c)}</span>`);
  return bits.join(' · ') || '<span class="dim">no job, no injury, housed</span>';
}

/**
 * The five words, and what each of them costs or buys. Numbers stay out of it on purpose: the
 * player is meant to learn a character by watching them work, and a tooltip that read "appetite
 * 84" would let them skip that and sort the roster by it instead.
 */
/**
 * Who this character is to the rest of the roster. Only the readings worth mentioning, strongest
 * first, and never a number: the tier word and how many missions they have walked together is
 * everything the player needs and all they are ever told.
 */
function relationLines(c) {
  const rel = Bonds.relations(state, c, state.characters).slice(0, 8);
  if (!rel.length) return '<div class="sub">No relationships recorded yet.</div>';
  return rel.map(r => {
    const d = Bonds.describe(state, c, r.c);
    return `<div class="relrow"><span class="who">${r.c.name}</span>` +
      `<span class="tag" style="color:${r.tier.color}">${r.tier.icon} ${d.text}</span></div>`;
  }).join('');
}

/**
 * The service record (roster.js describeRecord): the counts, the closest call and the last sortie,
 * then what is counted and where the label thresholds are. No game rule reads these.
 */
function recordLines(c) {
  const rd = Roster.describeRecord(c.record);
  if (!rd) return '<div class="sub">No record is kept for this character.</div>';
  return `<div class="gear">${rd.label ? `<span class="tag">${rd.label}</span> ` : ''}${rd.counts}</div>` +
    `<div class="gear"><i>closest call</i> ${rd.closest || '<span class="dim">none: no fight has left them below full HP</span>'}</div>` +
    `<div class="gear"><i>last sortie</i> ${rd.last || '<span class="dim">none yet</span>'}</div>` +
    `<div class="sub">${rd.since}. ${rd.legend}</div>`;
}

function temperTip(c) {
  const r = Temper.read(c);
  return Temper.KEYS.map(k => `${Temper.AXES[k].label}: ${r.bands[k].word} — ${r.bands[k].note}`).join('\n');
}

function openSheet(c) {
  const same = sheetId === c.id;
  sheetId = c.id;
  const box = $('#sheet');
  const star = Stats.STARS[c.stats.stars];
  box.hidden = false;
  box.innerHTML = '';

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.style.setProperty('--star', star.color);

  // ----- hero -----
  const hero = document.createElement('div');
  hero.className = 'sheet-hero';
  const portrait = document.createElement('div');
  portrait.className = 'sheet-portrait';
  portrait.append(spriteCanvas(c, 128));
  const id = document.createElement('div');
  id.className = 'sheet-id';
  const cls = Classes.def(c), trade = Classes.tradeDef(c), role = Outfit.ROLES[Outfit.roleOf(c)];
  id.innerHTML = `
    <h3>${c.name}</h3>
    <div class="stars" style="color:${star.color}">${Stats.starString(c.stats.stars)} <span class="sub">${c.stats.stars} of ${Stats.MAX_STARS}</span></div>
    <div class="sheet-tags">
      <span>${c.race} · ${c.bodyType}</span>
      <span>${role.icon} ${role.label}</span>
      ${cls ? `<span class="tag" title="${Classes.title(c)}">${cls.icon} ${Classes.shortTitle(c)}${Classes.fusionsUsed(c) ? ` +${Classes.fusionsUsed(c)}` : ''}</span>` : '<span class="dim">unclassed</span>'}
      ${trade ? `<span class="tag" title="${trade.desc}">${trade.icon} ${Classes.tradeTitle(c)}</span>` : ''}
      <span style="color:${AI.tier(c).color}" title="Acumen ${AI.acumen(c).toFixed(1)}: how well this character plans its spells, workings and technique loops">${AI.tier(c).label.toLowerCase()} mind</span>
      <span class="tag" title="${temperTip(c)}">${Temper.title(c)}</span>
    </div>
    <div class="sub">${Temper.read(c).line}</div>
    <div class="sheet-flags">${sheetFlags(c)}</div>`;
  const close = document.createElement('button');
  close.className = 'ghost sheet-close';
  close.textContent = 'Close';
  close.addEventListener('click', closeSheet);
  const fav = Filters.heart(c, () => { save(); renderAll(); openSheet(c); });
  fav.classList.add('sheet-fav');
  hero.append(portrait, id, fav, close);
  sheet.append(hero);

  // ----- body -----
  const body = document.createElement('div');
  body.className = 'sheet-body';

  // left: the radar and whichever spoke is being read
  const left = document.createElement('div');
  const p = Prowess.of(c);
  const others = state.characters.filter(x => x.id !== c.id);
  const avg = others.length ? Prowess.average(others) : null;

  const detail = document.createElement('div');
  detail.className = 'axis-detail';
  const { svg, select } = radarChart(p.axes, avg, (axis) => {
    sheetAxis = axis.key;
    detail.innerHTML = `<h4 style="color:${axis.color}">${axis.icon} ${axis.label} · ${Math.round(axis.value * 100)}</h4>
      <div class="blurb">${axis.blurb}</div>`;
    for (const part of axis.parts) detail.append(partRow(part, axis.color));
  });
  left.append(svg);

  const legend = document.createElement('div');
  legend.className = 'radar-legend';
  legend.innerHTML = `<span><i class="sw-solid"></i> ${c.name}</span>` +
    (avg ? `<span><i class="sw-dash"></i> roster average (${others.length})</span>` : '<span class="dim">nobody else to compare with yet</span>');
  left.append(legend);

  const note = document.createElement('div');
  note.className = 'radar-note';
  const limits = Prowess.limits(c);
  note.innerHTML = `<div>${Prowess.summary(c, p)}</div>` +
    (limits.length ? `<div class="warn">Fixable now: ${limits.join('; ')}.</div>` : '') +
    `<div class="sub">Each axis is 0–100, normalised against a fully advanced, fully trained character in legendary gear. Click an axis for its inputs.</div>`;
  left.append(note, detail);
  // Reopening the same sheet — after a job change, say — keeps the spoke they were reading;
  // a different character starts on whatever they are best at.
  select(same && sheetAxis && p.byKey[sheetAxis] ? sheetAxis : p.top.key);

  // right: everything the tile no longer says
  const right = document.createElement('div');
  // The derived block the character actually fights and works on, so it agrees with the radar and
  // with the numbers combat.js reads. The innate one is still on the stat line beside it.
  const eff = Stats.effective(c), d = eff.derived, innate = c.stats.derived;
  right.innerHTML =
    sec('Condition', `<div class="cond big">${condLine(c)}</div><div class="meal">${mealSpan(c)}</div>`) +
    sec('Stats', `<div class="potline">${potentialLine(c)}</div>
      <div class="stats">${statLine(c)}</div>
      <div class="derived">${Object.entries(Stats.DERIVED).map(([k, def]) => {
        const lifted = eff.geared && Math.abs(d[k] - innate[k]) > 1e-9;
        return `<span title="${def.label}, from ${def.stat.toUpperCase()}${lifted ? ` — ${Stats.formatDerived(k, innate[k])} of their own, lifted by what they carry` : ''}"><i>${def.label}</i> <b class="${lifted ? 'lifted' : ''}">${Stats.formatDerived(k, d[k])}</b></span>`;
      }).join('')}</div>`) +
    sec('Aptitudes', aptChips(c)) +
    sec('Affinity', Object.keys(Affinity.TYPES).map(cat => {
      const a = c.affinity, chosen = Affinity.choose(a, cat);
      const found = Affinity.TYPES[cat].filter(t => a.compatible[cat] === t && Affinity.isDiscovered(a, t));
      return `<div class="gear"><i>${TYPE_LABEL(cat)}</i> prefers ${TYPE_LABEL(a.innate[cat])}${found.length ? `, found a fit with ${TYPE_LABEL(found[0])}` : ''}${chosen !== a.innate[cat] ? ` → goes for ${TYPE_LABEL(chosen)}` : ''}</div>`;
    }).join('')) +
    sec('Carrying', gearLines(c)) +
    sec('Knows', knowledgeLines(c)) +
    sec('Company', relationLines(c)) +
    sec('Record', recordLines(c));

  // the controls that used to sit on the roster card
  const controls = document.createElement('div');
  controls.className = 'sec';
  controls.innerHTML = '<h4>Orders</h4>';
  const row = document.createElement('div');
  row.className = 'controls';
  const selJob = document.createElement('select');
  selJob.innerHTML = `<option value="">Idle</option>` + Object.entries(JOBS).map(([k, j]) => {
    const full = k !== c.job && workers(k).length >= slotsFor(k);
    return `<option value="${k}" ${c.job === k ? 'selected' : ''} ${full ? 'disabled' : ''}>${j.icon} ${j.label}${full ? ' (full)' : ''}</option>`;
  }).join('');
  selJob.disabled = !!c.mission;
  selJob.addEventListener('change', () => { setJob(c.id, selJob.value); renderAll(); openSheet(c); });
  const rel = document.createElement('button');
  rel.className = 'danger';
  rel.textContent = 'Release';
  rel.disabled = !!c.mission;
  arm(rel, 'Release?', () => { release(c.id); closeSheet(); renderAll(); });
  row.append(selJob, rel);
  controls.append(row);
  if (c.job) {
    const out = document.createElement('div');
    out.className = 'sub';
    out.textContent = jobText(c);
    controls.append(out);
  }
  right.append(controls);

  body.append(left, right);
  sheet.append(body);
  box.append(sheet);
}

function closeSheet() {
  sheetId = null;
  const box = $('#sheet');
  box.hidden = true;
  box.innerHTML = '';
}

/**
 * Keep an open sheet current across a tick without rebuilding it: a full redraw would restart the
 * sprite, throw away the spoke the player is reading and scroll them back to the top.
 */
function refreshSheet() {
  if (sheetId == null) return;
  const c = state.characters.find(x => x.id === sheetId);
  if (!c) { closeSheet(); return; }               // released, sacrificed, or fallen while open
  const flags = $('#sheet .sheet-flags');
  if (flags) flags.innerHTML = sheetFlags(c);
  const cond = $('#sheet .cond');
  if (cond) cond.innerHTML = condLine(c);
  const meal = $('#sheet .meal');
  if (meal) meal.innerHTML = mealSpan(c);
}

// ---------- roster ----------

/**
 * A roster tile: a face, a name, a star count and a level. Nothing else — everything that used to
 * be here is one click away on the sheet, and a roster is for finding somebody, not reading them.
 * The corner marks are the exception: they say whether you can give this character an order right
 * now, which is the one thing you would otherwise have to open every sheet to find out.
 */
function rosterTile(c) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.style.borderTopColor = Stats.STARS[c.stats.stars].color;
  tile.tabIndex = 0;
  tile.title = `${c.name} — open the sheet`;
  tile.append(spriteCanvas(c, 64));

  const marks = [];
  if (c.mission) marks.push('<span title="on a mission">🌀</span>');
  const wound = Condition.wounded(state, c);
  if (wound) marks.push(`<span title="${wound.text}. ${wound.why.replace(/"/g, '&quot;')}">🩹</span>`);
  if (!housed(c)) marks.push('<span title="unhoused: works at half rate" class="warn">⛺</span>');
  if (c.job) marks.push(`<span title="${JOBS[c.job].label}">${JOBS[c.job].icon}</span>`);

  const info = document.createElement('div');
  // TODO: characters have no level. XP is per-aptitude (c.xp) and rank belongs to the class, not
  // the person, so there is nothing honest to print here yet. When a character level lands, this
  // is the line it goes on.
  //
  // The grade sits next to the stars because it is the other half of the same question. Stars say
  // how many points the pull was worth; the grade says whether they landed anywhere useful, and a
  // roster sorted by stars alone hides every well-built 2★ behind a wasted 4★.
  info.innerHTML = `
    <div class="tname">${Filters.rareMark(c)}${c.name}</div>
    <div class="tstars" style="color:${Stats.STARS[c.stats.stars].color}">${Stats.starString(c.stats.stars)}</div>
    <div class="tlevel" title="Characters do not have a level yet">Lv — ${Filters.badge(c)}</div>
    ${marks.length ? `<div class="tflags">${marks.join('')}</div>` : ''}`;
  tile.append(info);

  tile.append(Filters.heart(c, () => { save(); renderAll(); }));

  const open = () => openSheet(c);
  tile.addEventListener('click', open);
  tile.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  return tile;
}

/**
 * The roster, with the bar that cuts it down. Everything above the grid is one row of controls,
 * and the grid below is whatever survived them — including nothing, which is said in words
 * rather than left as an empty screen the player reads as a bug.
 *
 * The bar is skipped under a handful of characters: a filter over six people is furniture.
 */
const FILTER_FROM = 6;

function renderRoster() {
  const el = $('#roster-panel');
  el.innerHTML = '';
  if (!state.characters.length) { el.innerHTML = '<p class="empty">No characters yet. Summon one.</p>'; return; }
  const all = state.characters;
  const shown = all.length >= FILTER_FROM ? Filters.apply('roster', all) : [...all].sort(Filters.SORTS.star.f);
  if (all.length >= FILTER_FROM) el.append(Filters.bar('roster', all, shown.length, renderRoster));
  const grid = document.createElement('div');
  grid.id = 'roster';
  for (const c of shown) grid.append(rosterTile(c));
  if (!shown.length) grid.innerHTML = '<p class="empty">Nobody matches that.</p>';
  el.append(grid);
  Filters.restoreFocus();
}

// Which lodging cards are open. A standing card is 360px of rule editor and there are as many
// of them as you have built, so they are folded by default and remember what you opened across
// the re-render the town tick causes.
const lodgeOpen = new Set();
let lodgeShopOpen = false;

/**
 * The lodging yard. Two halves: what can be put up, and what is standing — each standing
 * building carrying its own rules about who sleeps in it. Rules are hard filters (nobody else
 * gets in) and soft magnets (the people they are for prefer that bed over a better one), which
 * together is what "the team stays together" has to mean to actually do anything.
 */
function lodgingYard() {
  const box = document.createElement('div');
  box.className = 'jobbox';
  const sum = Lodging.summary(state);
  box.innerHTML = `<h3>🛏️ Lodging <span class="sub">${sum.housed}/${state.characters.length} in a bed · ${sum.capacity} beds · ${sum.plots.toFixed(2).replace(/\.00$/, '')} plots</span></h3>
    <div class="sub">Every bed is a building with its own rest, its own effect on morale, and its own rules. Sleeping outside is a rest of ×0.75, half output and a steady loss of heart.</div>`;

  // what can be built
  const shopHead = document.createElement('h3');
  shopHead.className = 'fold';
  shopHead.style.fontSize = '13px';
  shopHead.style.margin = '10px 0 0';
  shopHead.innerHTML = `<span class="caret">${lodgeShopOpen ? '▾' : '▸'}</span> Build a lodging <span class="sub">${Object.keys(LODGINGS).length} kinds</span>`;
  shopHead.addEventListener('click', () => { lodgeShopOpen = !lodgeShopOpen; renderTown(); });
  box.append(shopHead);
  const shop = document.createElement('div');
  shop.className = 'grid';
  shop.hidden = !lodgeShopOpen;
  for (const [type, d] of Object.entries(LODGINGS)) {
    const gate = canBuildLodging(type);
    const have = Lodging.ensure(state).filter(l => l.type === type).length;
    const card = document.createElement('div');
    card.className = 'bcard';
    card.innerHTML = `<h3>${d.icon} ${d.label}${have ? ` <span class="sub">×${have}</span>` : ''}</h3>
      <div class="sub">${d.desc}</div>
      <div class="sub">${d.beds} beds · rest ×${d.rest.toFixed(2)} · morale ${d.morale >= 0 ? '+' : ''}${d.morale} · ${d.plots} plot${d.plots === 1 ? '' : 's'}</div>
      <div class="upgrade"><button ${gate.ok ? '' : 'disabled'} title="${gate.why || ''}">Build</button><div class="sub">${Econ.costText(d.cost)}</div>${gate.ok ? '' : `<div class="sub warn">${gate.why}</div>`}</div>`;
    card.querySelector('button').addEventListener('click', () => addLodging(type));
    shop.append(card);
  }
  box.append(shop);

  if (!sum.buildings.length) return box;

  const head = document.createElement('div');
  head.className = 'filters';
  head.style.marginTop = '12px';
  const label = document.createElement('span');
  label.className = 'sub';
  label.innerHTML = `<b>Standing</b> — ${sum.buildings.length} building${sum.buildings.length === 1 ? '' : 's'}. Set the rules and the town billets everyone inside them.`;
  head.append(label);
  const allBtn = document.createElement('button');
  allBtn.className = 'ghost';
  const anyOpen = sum.buildings.some(b => lodgeOpen.has(b.id));
  allBtn.textContent = anyOpen ? 'Collapse all' : 'Expand all';
  allBtn.addEventListener('click', () => {
    if (anyOpen) lodgeOpen.clear(); else for (const b of sum.buildings) lodgeOpen.add(b.id);
    renderTown();
  });
  head.append(allBtn);
  box.append(head);

  const yardGrid = document.createElement('div');
  yardGrid.className = 'grid';
  for (const b of sum.buildings) yardGrid.append(lodgingCard(b));
  box.append(yardGrid);

  if (sum.outside.length) {
    const out = document.createElement('div');
    out.className = 'sub warn';
    out.style.marginTop = '8px';
    out.textContent = `Sleeping outside: ${sum.outside.map(c => `${c.stats.stars}★ ${c.name}`).join(', ')}`;
    box.append(out);
  }
  return box;
}

/**
 * One standing building. Folded it is four lines that still answer the only questions worth
 * asking at a glance — how full, how good, and who it is for; opened it is the rule editor and
 * the list of who is actually in there.
 */
function lodgingCard(b) {
  const open = lodgeOpen.has(b.id);
  const card = document.createElement('div');
  card.className = 'bcard';
  const head = document.createElement('h3');
  head.className = 'fold';
  head.innerHTML = `<span class="caret">${open ? '▾' : '▸'}</span> ${b.icon} ${b.label} <span class="sub">${b.used}/${b.beds}</span>`;
  head.addEventListener('click', () => { if (open) lodgeOpen.delete(b.id); else lodgeOpen.add(b.id); renderTown(); });
  card.append(head);
  const meta = document.createElement('div');
  meta.innerHTML = `<div class="sub">rest ×${b.rest.toFixed(2)} · morale ${b.morale >= 0 ? '+' : ''}${b.morale}</div>
    <div class="sub"><b>Rules</b> ${b.ruleText}</div>`;
  card.append(meta);

  const body = document.createElement('div');
  body.hidden = !open;
  card.append(body);
  body.innerHTML = `<div class="sub">${b.occupants.length ? b.occupants.map(c => `${c.stats.stars}★ ${c.name}`).join(', ') : '<span class="empty">empty</span>'}</div>`;

  const rules = document.createElement('div');
  rules.className = 'filters';
  const teams = (state.teams || []);
  const groups = [...new Set(Classes.LIST.map(c => c.group))];
  const races = [...new Set(state.characters.map(c => c.race))].sort();
  const OPTIONS = {
    stars: [['', 'any']].concat([1, 2, 3, 4, 5, 6, 7].map(n => [String(n), `${n}★`])),
    team: [['', 'any team']].concat(teams.map(t => [t.id, t.name])),
    group: [['', 'any group']].concat(groups.map(g => [g, Classes.GROUPS[g].label])),
    race: [['', 'any race']].concat(races.map(r => [r, r])),
    bool: [['', 'any'], ['1', 'required']],     // an unset rule is 'any', not 'must not'
  };
  for (const [key, def] of Object.entries(Lodging.RULES)) {
    const wrap = document.createElement('label');
    wrap.className = 'sub';
    wrap.style.display = 'flex';
    wrap.style.alignItems = 'center';
    wrap.style.gap = '4px';
    const sel = document.createElement('select');
    const cur = b.rules[key];
    sel.innerHTML = OPTIONS[def.kind].map(([v, l]) => `<option value="${v}" ${String(cur === undefined ? '' : cur) === v ? 'selected' : ''}>${l}</option>`).join('');
    sel.addEventListener('change', () => {
      const raw = sel.value;
      const val = raw === '' ? null : def.kind === 'stars' ? Number(raw) : def.kind === 'bool' ? true : raw;
      Lodging.setRule(state, b.id, key, val);
      save(); renderAll();
    });
    wrap.append(def.label, sel);
    rules.append(wrap);
  }
  body.append(rules);

  const pull = document.createElement('button');
  pull.className = 'ghost';
  pull.textContent = 'Pull it down';
  pull.style.marginTop = '6px';
  pull.addEventListener('click', () => removeLodging(b.id));
  body.append(pull);
  return card;
}

/**
 * The town map lives above the ledgers and outlives them: renderTown() rewrites #town every tick,
 * so the canvas is mounted into a box of its own and kept across renders. TownView owns the loop
 * and stops drawing on its own when the panel is hidden.
 */
function mountTownMap() {
  const host = $('#townmap-host');
  if (!host || typeof TownView === 'undefined') return;
  TownView.mount(host, () => state, { pickCharacter: (c) => openSheet(c) });
  const box3d = $('#townmap-3d');
  if (box3d && !box3d.dataset.wired) {
    box3d.dataset.wired = '1';
    box3d.checked = TownView.is3d;
    box3d.addEventListener('change', (e) => TownView.set3d(e.target.checked));
  }
  const line = $('#townmap-census');
  if (!line) return;
  TownLife.sync(state);            // so the first render says who is where, not "nobody about"
  const out = TownLife.census(state).slice(0, 5)
    .map(x => `${x.plot.icon} ${x.plot.label} ${x.n}`).join('  ·  ');
  const away = state.characters.filter(c => c.mission).length;
  line.textContent = (out || 'nobody about') + (away ? `  ·  🌀 ${away} out through the gate` : '');
}

function renderTown() {
  mountTownMap();
  const el = $('#town');
  const next = TOWN[state.town + 1];
  const tu = canUpgradeTown();
  el.innerHTML = `<div class="townhead">
    <div><h3>🏙️ ${TOWN[state.town].name} <span class="sub">town tier ${state.town + 1} / ${TOWN.length}</span></h3>
    <div class="sub">Buildings can be raised up to the town tier. Plots ${plotsUsed().toFixed(2).replace(/\.00$/, '')}/${plotsTotal()} used. ${capacity()} beds for ${state.characters.length} · average rest ×${restMult().toFixed(2)}.</div></div>
    <div>${next ? `<button id="town-up" ${tu.ok ? '' : 'disabled'} title="${tu.why || ''}">Upgrade to ${next.name}</button><div class="sub">${Econ.costText(next.cost)}</div>` : '<span class="sub">Max tier</span>'}</div>
  </div>`;
  if (next) $('#town-up').addEventListener('click', () => { upgradeTown(); renderAll(); });
  el.append(awayEstimateCard());
  el.append(lodgingYard());
  const grid = document.createElement('div');
  grid.className = 'grid';
  for (const [k, b] of Object.entries(BUILDINGS)) {
    const t = tierOf(k);
    const nxt = b.tiers[state.buildings[k] + 1];
    const cu = canUpgradeBuilding(k);
    const box = document.createElement('div');
    box.className = 'bcard';
    let effect = '';
    if (b.kind === 'gather') effect = `${t.slots} ${JOBS[b.job].label.toLowerCase()} slots · output ×${t.mult.toFixed(1)}`;
    else if (b.kind === 'train') effect = `${t.slots} training slots · growth ×${t.mult.toFixed(1)}`;
    else if (b.kind === 'altar') effect = `Sacrifices keep ×${t.share.toFixed(2)}`;
    else effect = `${t.slots} ${JOBS[b.job].label.toLowerCase()} slots · quality +${t.quality}`;
    const used = b.job ? workers(b.job).length : 0;
    // The altar has no workers and houses nobody; it points at its own screen instead.
    const second = b.kind === 'altar' ? `${Roster.fallen(state).filter(f => f.cause.startsWith('sacrificed to')).length} spent here` : b.job ? `${used}/${t.slots} working` : `${used}/${t.capacity} housed`;
    box.innerHTML = `<h3>${b.icon} ${b.label}</h3>
      <div class="tiername">${t.name} <span class="sub">tier ${state.buildings[k] + 1}/${b.tiers.length}</span></div>
      <div class="sub">${effect}</div>
      <div class="sub">${second}</div>
      ${nxt ? `<div class="upgrade"><button ${cu.ok ? '' : 'disabled'} title="${cu.why || ''}">Upgrade → ${nxt.name}</button><div class="sub">${Econ.costText(nxt.cost)}</div>${cu.ok ? '' : `<div class="sub warn">${cu.why}</div>`}</div>` : '<div class="sub">Max tier</div>'}`;
    if (nxt) box.querySelector('button').addEventListener('click', () => { upgradeBuilding(k); renderAll(); });
    grid.append(box);
  }
  el.append(grid);
}

/**
 * The gem income target: what the town is saving for, and how fast it would like to get there.
 *
 * Nothing drains gems. They leave through the gate and through a builder's hand and nowhere else
 * — there is no tick that bills the town — so the gem line is a SAVINGS RATE and never an upkeep.
 * The first version of this blended roster size, building tiers and roof count into a number
 * that was consistent but unreadable: it looked like a bill, and a player watching it idle had
 * no way to find out what it was for. So it is derived from something they can point at
 * instead, and the returned `why` names that thing.
 *
 * Two candidate rates, and the larger one is used:
 *   THE NEXT STEP  the cheapest upgrade the town cannot afford yet, closed inside SAVING_UP
 *   THE GATE       enough to keep summoning at PULL_EVERY, the sink that never fills
 *
 * The target follows the stock: bank enough and the goal shrinks and the hands leave maintenance
 * for the mine and the drill hall. Buy the upgrade and the next one sets a higher goal.
 */
const SAVING_UP = 180;      // ticks to close the gap on the next building — 30 minutes at TICK_MS
const PULL_EVERY = 60;      // ticks between summons the town wants to afford — 10 minutes, and
                            // the floor under the whole gem line: even with nothing to build, a
                            // few hands stay on maintenance so summoning stays funded

const inMinutes = (ticks) => Math.round(ticks * TICK_MS / 60000);

function gemGoal() {
  const steps = [];
  for (const [k, b] of Object.entries(BUILDINGS)) {
    const next = b.tiers[state.buildings[k] + 1];
    if (!next || !next.cost || state.buildings[k] + 1 > state.town) continue;
    steps.push({ name: next.name, gems: next.cost.gems || 0 });
  }
  const town = TOWN[state.town + 1];
  if (town && town.cost) steps.push({ name: town.name, gems: town.cost.gems || 0 });
  const next = steps.map(x => ({ ...x, gap: x.gems - state.gems })).filter(x => x.gap > 0).sort((a, b) => a.gap - b.gap)[0];

  const gate = PULL_COST / PULL_EVERY;
  const saving = next ? next.gap / SAVING_UP : 0;
  if (saving > gate) return { rate: saving, why: `banking the ${Math.ceil(next.gap)} 💎 still missing for the ${next.name}, inside ${inMinutes(SAVING_UP)} min` };
  const spare = next ? '' : ' — every upgrade in reach is already paid for';
  return { rate: gate, why: `keeping a summon every ${inMinutes(PULL_EVERY)} min within reach${spare}` };
}

/** What crew.js needs to know about this town's numbers, without re-deriving any of them. */
const jobApi = () => ({
  jobs: JOBS, slots: slotsFor, outputFor: (c, k) => outputFor(c, k),
  // sizing a workforce is a question about hours, not about this second — see sustained()
  sustained,
  // the larder and the savings goal: staffing sizes the kitchen, the fields and maintenance off these
  stock: (r) => (r === 'meal' ? mealStock() : state[r] || 0),
  eats: mealDrain,
  gemGoal,
});

let honeFilter = 'all';

/**
 * Put the honing list on the training grounds. Unlike staffing this touches nobody else: it
 * fills the drill hall and leaves the rest of the town where it is.
 */
function applyHone() {
  const res = Crew.hone(state, jobApi(), { only: honeFilter });
  if (!res.picked.length) return;
  for (const c of res.benched) setJob(c.id, null);
  const sent = [];
  for (const x of res.picked) if (x.c.job !== 'training') { if (setJob(x.c.id, 'training')) sent.push(x); }
  logLine(`🎯 ${sent.length ? sent.map(x => x.c.name).join(', ') + ' sent to drill' : 'the drill hall was already right'}`);
  save();
  renderAll();
}

function applyOptimalJobs() {
  const res = Crew.plan(state, jobApi());
  // clear first: otherwise a seat someone is about to leave still counts as full
  for (const p of res.plan) setJob(p.id, null);
  for (const p of res.plan) if (p.job) setJob(p.id, p.job);
  // said plainly, and said differently for each way of coming up short: not enough hands is a
  // staffing answer, a full building is a gems answer, and an empty drill hall is neither —
  // it means the roster had nobody in it worth the room.
  const short = (res.needs || []).filter(n => !n.met);
  const walls = short.filter(n => n.full && JOBS[n.job].building).map(n => tierOf(JOBS[n.job].building).name);
  const hands = short.filter(n => !n.full && n.key !== 'drill').map(n => JOBS[n.job].label.toLowerCase());
  const bench = short.some(n => n.key === 'drill');
  logLine(`⚙️ ${res.moved.length} reassigned, ${res.trained.length} sent to the training grounds` +
          (hands.length ? ` — still short of ${hands.join(' and ')}` : '') +
          (walls.length ? ` — no room left in the ${walls.join(' or the ')}` : '') +
          (bench ? ' — the drill hall has room for anyone worth it' : ''));
  save();
  renderAll();
}

function renderJobs() {
  const el = $('#jobs');
  el.innerHTML = '';
  if (typeof Crew !== 'undefined') {
    const bar = document.createElement('div');
    bar.className = 'jobbox';
    bar.innerHTML = '<h3>⚙️ Staffing</h3><div class="sub">Fills the posts in the order the town needs them: the kitchen and the fields behind it, then the gems that pay for everything else, then the drill hall for whoever is worth the investment. Everyone left over goes to the work they are best at.</div>' +
      '<div class="sub">Rates are per tick and count a post\'s whole crew, sleepers included, so a shift change does not move them. <b>Nothing drains gems</b> — they only leave through the gate or a builder\'s hand, and the gem line is what the town wants coming <i>in</i>.</div>';

    // What the town is actually asking for and whether it is getting it. Without this the button
    // is a black box that moves the whole roster for reasons of its own.
    const needs = Crew.demands(state, jobApi());
    if (needs.length) {
      const nl = document.createElement('div');
      nl.className = 'sub';
      nl.innerHTML = needs.map(n => {
        const j = JOBS[n.job];
        const open = !isFinite(n.work);                    // the drill hall wants everyone it fits
        const have = staffedAt(n.job);
        // the crew, not the half of it that happens to be awake — a post with every seat spoken
        // for is full even when the rota has one of them in bed
        const full = crewOf(n.job).length >= slotsFor(n.job);
        const met = open ? full : have >= n.work;
        const level = open ? `${crewOf(n.job).length}/${slotsFor(n.job)} drilling`
                   : `${n.key === 'gems' ? 'earning' : 'making'} ${fmtOut(have)} of ${fmtOut(n.work)}`;
        // a shortage nobody can staff their way out of points at the building instead
        const wall = !met && full && j.building ? ` · the ${tierOf(j.building).name} is full` : '';
        return `<div>${met ? '✅' : full ? '🏗️' : '⚠️'} ${j.icon} <b>${j.label}</b> — ${level} · ${n.why}${wall}</div>`;
      }).join('');
      bar.appendChild(nl);
    }

    const btn = document.createElement('button');
    btn.textContent = 'Optimal jobs';
    btn.addEventListener('click', applyOptimalJobs);
    bar.appendChild(btn);

    // Rotation: the town does not need to be told twice that somebody is exhausted.
    const rot = document.createElement('label');
    rot.style.marginLeft = '10px';
    rot.className = 'sub';
    const rotBox = document.createElement('input');
    rotBox.type = 'checkbox';
    rotBox.checked = state.autoRotate !== false;
    rotBox.addEventListener('change', () => { state.autoRotate = rotBox.checked; save(); renderJobs(); });
    rot.append(rotBox, ' rotate spent workers out automatically');
    bar.appendChild(rot);
    el.appendChild(bar);

    // ---- honing ----
    const hb = document.createElement('div');
    hb.className = 'jobbox';
    const res = Crew.hone(state, jobApi(), { only: honeFilter });
    hb.innerHTML = `<h3>🎯 Hone their skills</h3>
      <div class="sub">Staffing answers who should be working. This answers who is worth the drill time: rare and fused characters, stats above the roster's average, and anyone with an advancement trial actually in front of them. Nobody drills bare-handed — the drill trains what you are holding. ${res.slots} training slot${res.slots === 1 ? '' : 's'}.</div>`;
    const row = document.createElement('div');
    row.className = 'filters';
    const sel = document.createElement('select');
    sel.innerHTML = Object.entries(Crew.HONE_FILTERS).map(([k, f]) => `<option value="${k}" ${honeFilter === k ? 'selected' : ''}>${f.label}</option>`).join('');
    sel.addEventListener('change', () => { honeFilter = sel.value; renderJobs(); });
    const go = document.createElement('button');
    go.textContent = res.picked.length ? `Send ${res.picked.length} to drill` : 'Nobody to send';
    go.disabled = !res.picked.length;
    go.addEventListener('click', () => applyHone());
    row.append(sel, go);
    if (res.tired) { const t = document.createElement('span'); t.className = 'sub'; t.textContent = `${res.tired} skipped: too spent to drill`; row.append(t); }
    if (res.bare) { const b = document.createElement('span'); b.className = 'sub'; b.textContent = `${res.bare} skipped: nothing in hand to drill with`; row.append(b); }
    hb.appendChild(row);

    const list = document.createElement('div');
    list.className = 'sub';
    list.innerHTML = res.picked.length
      ? res.picked.map(x => `<div>${x.c.stats.stars}★ <b>${x.c.name}</b> — ${Crew.honeReason(x)}</div>`).join('')
      : '<div class="empty">Nobody matches that, or everyone who does is spent.</div>';
    hb.appendChild(list);
    if (res.benched.length) {
      const b = document.createElement('div');
      b.className = 'sub warn';
      b.textContent = `${res.benched.map(c => c.name).join(', ')} would come off the posts.`;
      hb.appendChild(b);
    }
    el.appendChild(hb);
  }
  for (const [k, j] of Object.entries(JOBS)) {
    if (j.kind === 'train') continue; // lives in the Training grounds tab
    const ws = workers(k);
    const slots = slotsFor(k);
    const box = document.createElement('div');
    box.className = 'jobbox';
    let desc = `Uses ${j.stats.map(s => s.toUpperCase()).join(' + ')} and ${j.label} aptitude`;
    if (j.kind === 'gather') desc += ` · produces ${RESOURCES[j.produces].icon} ${j.produces} · ${BUILDINGS[j.building].icon} ${tierOf(j.building).name} ×${tierOf(j.building).mult.toFixed(1)}`;
    if (j.kind === 'process') desc += ` · consumes ${Econ.costText(j.consumes)} per craft · ${BUILDINGS[j.building].icon} ${tierOf(j.building).name} quality +${tierOf(j.building).quality}`;
    if (j.kind === 'town') desc += ` · produces ${RESOURCES[j.produces].icon} ${j.produces}`;
    const total = ws.reduce((a, c) => a + (j.kind === 'process' ? outputFor(c, k) : jobOutput(c)), 0);
    box.innerHTML = `<h3>${j.icon} ${j.label} <span class="sub">${ws.length}/${slots === Infinity ? '∞' : slots} slots</span></h3>
      <div class="sub">${desc}</div>
      <div class="sub">${j.kind === 'process' ? `${total.toFixed(1)} work/tick → about ${(total / j.threshold).toFixed(2)} crafts per tick` : `+${fmtOut(total)} per tick`}</div>`;
    const assign = document.createElement('button');
    assign.textContent = '+ Assign';
    assign.disabled = ws.length >= slots;
    assign.addEventListener('click', () => openPicker(k));
    box.append(assign);
    if (j.kind === 'process' && (j.crafts === 'equipment' || j.crafts === 'potion')) box.append(requestControl(k, j));
    const list = document.createElement('div');
    list.className = 'workers';
    for (const c of ws) {
      const card = characterCard(c, { size: 64, noProfs: true });
      const meta = document.createElement('div');
      meta.className = 'sub';
      meta.textContent = `${Prof.format(c.profs[k])} · ${jobText(c)}`;
      const un = document.createElement('button');
      un.className = 'ghost';
      un.textContent = 'Unassign';
      un.addEventListener('click', () => { setJob(c.id, null); renderAll(); });
      card.append(meta, un);
      list.append(card);
    }
    box.append(list);
    el.append(box);
  }
}

// Player request: what the smithy or lab should make next. Empty = whatever comes.
function requestControl(k, j) {
  const wrap = document.createElement('span');
  wrap.className = 'request';
  const sel = document.createElement('select');
  let opts = `<option value="">Request: anything</option>`;
  if (j.crafts === 'equipment') {
    const bySlot = {};
    for (const t of Econ.EQUIPMENT) (bySlot[t.slot] = bySlot[t.slot] || []).push(t);
    for (const [slot, list] of Object.entries(bySlot)) {
      opts += `<optgroup label="${slot}">` + list.map(t => `<option value="${t.key}">${t.label}</option>`).join('') + '</optgroup>';
    }
  } else {
    opts += Econ.POTIONS.map(t => `<option value="${t.key}">${t.label}</option>`).join('');
  }
  sel.innerHTML = opts;
  sel.value = state.orders[k] || '';
  sel.addEventListener('change', () => {
    state.orders[k] = sel.value || null;
    const label = sel.options[sel.selectedIndex].textContent;
    logLine(`📜 ${j.icon} ${j.label} order: ${sel.value ? label : 'anything'}`);
    save();
    renderJobs();
  });
  wrap.append(sel);
  return wrap;
}

function renderInventory() {
  const el = $('#inventory');
  el.innerHTML = '';
  const items = Object.values(state.inventory).filter(i => i.count > 0);
  if (!items.length) { el.innerHTML = '<p class="empty">Nothing crafted yet. Put smiths, alchemists and cooks to work.</p>'; return; }
  for (const kind of ['equipment', 'potion', 'meal']) {
    const group = items.filter(i => i.kind === kind).sort((a, b) => b.quality - a.quality || a.name.localeCompare(b.name));
    if (!group.length) continue;
    const box = document.createElement('div');
    box.className = 'jobbox';
    box.innerHTML = `<h3>${{ equipment: '⚔️ Equipment', potion: '🧪 Potions', meal: '🍲 Meals' }[kind]}</h3>`;
    const list = document.createElement('div');
    list.className = 'items';
    for (const it of group) {
      const q = QUALITY[it.quality];
      let detail = '', tip = '';
      if (it.kind === 'equipment') detail = `${it.slot} · ` + Object.entries(it.bonus).map(([s, v]) => `+${v} ${s.toUpperCase()}`).join(' ');
      if (it.kind === 'potion') detail = `${it.effect} · power ${it.power}`;
      if (it.kind === 'meal') {
        // the points a character gets (economy.js mealInfo), not the authored amount they come from
        const info = Econ.mealInfo(it);
        detail = `${Econ.mealText(info.points)} for one mission`;
        tip = ` title="Eaten at launch, one per squad member, best quality first. ${Econ.mealWhy(info)}. Added in fights only."`;
      }
      list.innerHTML += `<div class="item" style="border-left:3px solid ${q.color}"><div class="name" style="color:${q.color}">${it.name} <span class="count">×${it.count}</span></div><div class="sub"${tip}>${detail}</div></div>`;
    }
    box.append(list);
    el.append(box);
  }
}

const TYPE_LABEL = (t) => t.charAt(0).toUpperCase() + t.slice(1);

function affinityLine(c, type) {
  const d = Affinity.describeKnown(c.affinity, type);
  const tags = d.tags.length ? ` <span class="tag">${d.tags.join(', ')}</span>` : '';
  return `${TYPE_LABEL(type)}${tags} · pref +${Math.round(d.pref * 100)}% · compat +${Math.round(d.compat * 100)}% · growth ×${d.mult.toFixed(2)}`;
}

function renderTraining() {
  const el = $('#training');
  el.innerHTML = '';
  const t = tierOf('training');
  const ws = workers('training');
  const head = document.createElement('div');
  head.className = 'townhead';
  head.innerHTML = `<div><h3>🎯 ${t.name} <span class="sub">${ws.length}/${t.slots} training · growth ×${t.mult.toFixed(1)}</span></h3>
    <div class="sub">Equip gear from the armory, then send characters to train. Each equipped item raises its aptitude every tick. Growth is 1 + preference + compatibility + class training. Aptitudes stop at A+, except a class's own mastery, which reaches S- at Master and S at Grandmaster.</div></div>`;
  el.append(head);
  if (!state.characters.length) { el.innerHTML += '<p class="empty">No characters yet.</p>'; return; }
  const grid = document.createElement('div');
  grid.className = 'grid';
  // A training card is the tallest card in the game, so this is the list that needs cutting down
  // most: choosing who to train is choosing who is worth the slot, which is the same question the
  // grade answers. Whoever is already in a slot stays pinned to the top regardless.
  const all = state.characters;
  const inSlot = (c) => c.job === 'training';
  const shown = all.length >= FILTER_FROM
    ? Filters.apply('training', all, 'star', inSlot)
    : [...all].sort((a, b) => inSlot(b) - inSlot(a) || b.stats.stars - a.stats.stars || a.id - b.id);
  if (all.length >= FILTER_FROM) el.append(Filters.bar('training', all, shown.length, renderTraining));
  for (const c of shown) grid.append(trainingCard(c));
  if (!shown.length) grid.innerHTML = '<p class="empty">Nobody matches that.</p>';
  el.append(grid);
  Filters.restoreFocus();
}

// ---------- classes ----------
// The class panel lives in the training grounds because that is where a class is paid for: it
// changes what training does, what it caps out at, and what the character walks into a fight
// believing. Classes it does not qualify for are listed anyway, greyed, with what it is short
// of — that list is the thing that makes a player train an aptitude on purpose.
function classPicker(c) {
  const sel = document.createElement('select');
  const cur = Classes.idOf(c);
  const cl = Classes.def(c);
  // Only the seven trunks are ever chosen. Everything else is grown into, so listing it here
  // would be offering something that is not on offer.
  const groups = Classes.BASES.map(cl => {
    const gd = Classes.GROUPS[cl.group];
    const e = Classes.eligible(c, cl.id);
    const held = (c.classHistory || []).find(h => h.id === cl.id);
    const tail = e.ok ? (held && cl.id !== cur ? ` — comes back ${Classes.rankAt(held.xp).label}` : '') : ` — ${e.why}`;
    const grown = Classes.branchesOf(cl.id).map(b => b.name).join(', ');
    // the family's birthrights are part of the seven, but nobody grows into them: they are summoned
    const born = Classes.LIST.filter(b => b.from === cl.id && b.summonOnly).map(b => b.name).join(', ');
    return `<option value="${cl.id}" ${cur === cl.id ? 'selected' : ''} ${e.ok || cur === cl.id ? '' : 'disabled'} title="${gd.label} · grows into: ${grown}${born ? ` · born only: ${born}` : ''}">${cl.icon} ${cl.name}${tail}</option>`;
  }).join('');
  const grownNow = cl && !cl.base && !cl.summonOnly ? `<option value="${cl.id}" selected>${cl.icon} ${cl.name} — grown into</option>` : '';
  sel.innerHTML = `<option value="">— unclassed —</option>` + grownNow + groups;
  // Being born to something is not a choice you get to unmake at the training post.
  sel.disabled = !!c.mission || !!(cl && cl.summonOnly);
  if (cl && cl.summonOnly) sel.title = `${cl.name} is summon-only: it cannot be swapped out`;
  else if (cl && !cl.base) sel.title = `${cl.name} was grown into. Picking a trunk again starts that over.`;
  sel.addEventListener('change', () => {
    if (!sel.value) { const was = Classes.unassign(c); if (was) logLine(`📕 ${c.name} puts down the ${Classes.CLASSES[was.id].name} training (${was.xp.toFixed(0)} kept for later)`); }
    else {
      const r = Classes.assign(c, sel.value);
      if (!r.ok) { notify(r.why); renderTraining(); return; }
      logLine(`📗 ${c.name} takes up ${Classes.CLASSES[sel.value].icon} ${Classes.CLASSES[sel.value].name}${r.from ? ` (was ${Classes.CLASSES[r.from.id].name})` : ''}`);
    }
    save(); renderAll();
  });
  return sel;
}

/** Fuse a second (or third) discipline in, when a tier-up has opened a slot for it. */
function fusePicker(c) {
  const sel = document.createElement('select');
  const pool = Classes.fusable(c);
  const blocked = Classes.LIST.filter(cl => !cl.summonOnly && !Classes.has(c, cl.id) && !pool.includes(cl));
  sel.innerHTML = `<option value="">— fuse a second discipline —</option>` +
    pool.map(cl => `<option value="${cl.id}">${cl.icon} ${cl.name}</option>`).join('') +
    blocked.map(cl => `<option disabled>${cl.icon} ${cl.name} — ${Classes.eligible(c, cl.id).why}</option>`).join('');
  sel.disabled = !!c.mission;
  sel.addEventListener('change', () => {
    const r = Classes.fuse(c, sel.value);
    if (!r.ok) { notify(r.why); renderTraining(); return; }
    logLine(`🜂 ${c.name} fuses ${r.def.icon} ${r.def.name} into ${Classes.def(c).name}`);
    save(); renderAll();
  });
  return sel;
}

/**
 * The trade panel. A trade is never chosen, so there is no picker here — only what the work has
 * proved so far and what the next rank asks for. The one control is giving it up, which is the
 * only way to be free to earn a different one.
 */
function tradeBlock(c) {
  const d = Classes.describeTrade(c);
  const box = document.createElement('div');
  box.className = 'aff klass';
  if (!d) {
    box.innerHTML = '<div><b>No trade</b></div><div>Working one job long enough earns one. It stacks on top of the class and changes nothing about how they fight.</div>';
    return box;
  }
  if (d.pending) {
    const pct = Math.round(100 * d.ticks / d.need);
    box.innerHTML = `<div><b>${d.pending.icon} Learning the ${d.pending.name.toLowerCase()}'s work</b></div>
      <div class="bar"><i style="width:${Math.min(100, pct)}%"></i></div>
      <div>${d.ticks} of ${d.need} ticks at ${JOBS[d.pending.job].label.toLowerCase()}.</div>`;
    return box;
  }
  const p = d.progress;
  const proofText = !p ? 'Nothing left to prove.'
    : p.kind === 'craft'
      ? `<b>${p.next.label}</b> wants ${p.need} items of ${Econ.QUALITY[p.quality].name} or better inside ${p.window} crafts — ${p.have} of ${p.need}, over ${p.seen} of ${p.window} crafts.`
      : `<b>${p.next.label}</b> wants ${p.need} delivered inside ${p.window} ticks — ${Math.floor(p.have)} of ${p.need}, over ${p.seen} of ${p.window} ticks.`;
  box.innerHTML = `<div><b>${d.icon} ${d.rank.label} ${d.name}</b> · <span>${JOBS[d.job].label.toLowerCase()}</span></div>
    <div>${d.desc}</div>
    ${p ? `<div class="bar" title="${Math.floor(p.have)} of ${p.need}"><i style="width:${Math.min(100, Math.round(100 * p.have / p.need))}%"></i></div>` : ''}
    <div>${proofText}</div>
    <div><b>Trains</b> ${d.training.filter(t => t.bonus >= 0.05).map(t => `${t.label} +${Math.round(t.bonus * 100)}%`).join(', ')}</div>
    ${d.mastery.length ? `<div><b>Mastery</b> ${d.mastery.map(k => Prof.PROFICIENCIES[k].label).join(', ')} · ${d.capStage ? `trains as far as ${d.capStage}` : 'past A+ from Master'}</div>` : ''}`;
  const drop = document.createElement('button');
  drop.className = 'ghost';
  drop.style.marginTop = '6px';
  drop.textContent = 'Give up the trade';
  drop.title = 'Frees them to earn a different one. The rank is lost.';
  drop.disabled = !!c.mission;
  drop.addEventListener('click', () => {
    const was = Classes.dropTrade(c);
    if (was) logLine(`📚 ${c.name} gives up the ${Classes.TRADES[was.id].name.toLowerCase()}'s trade`);
    save(); renderAll();
  });
  box.append(drop);
  return box;
}

function classBlock(c) {
  const box = document.createElement('div');
  box.className = 'aff klass';
  const d = Classes.describe(c);
  if (d) {
    const tech = d.techniques.map(id => Martial.TECHNIQUES[id]).filter(Boolean);
    // every discipline they hold, each on the rank its own practice has bought
    const lines = d.held.map(h => {
      const p = h.progress;
      return `<div><b>${h.icon} ${h.rank.label} ${h.name}</b>${h.primary ? '' : ' <span class="tag">fused</span>'}</div>` +
        (p ? `<div class="bar" title="${p.need.toFixed(1)} more"><i style="width:${Math.round(p.frac * 100)}%"></i></div>` : '');
    }).join('');
    const slotLine = d.slotOpen
      ? `<div class="warn">${d.slots - d.slotsUsed} fusion slot open — a second class can be added, stacking its training, mastery and skills on top.</div>`
      : d.nextSlotAt
        ? `<div>${d.tierUps} tier-up${d.tierUps === 1 ? '' : 's'} so far · next fusion slot at ${d.nextSlotAt}.</div>`
        : '<div>Both fusion slots used.</div>';
    // what the work is pointing at, for anybody still standing on a trunk
    const lean = (d.leanings || []).filter(l => l.fit > 0.12);
    const leanLine = !d.base ? '' : lean.length
      ? `<div><b>Specialisation fit</b> ${lean.map(l => `${l.def.icon} ${l.def.name} <i>${Math.round(l.fit * 100)}%</i>`).join(' · ')}${d.rankIndex < 1 ? ` — decided at ${d.specialiseAt.label}, needs ${Math.round(Classes.BASE_FIT * 100)}%` : ''}</div>`
      : `<div>Specialisation fit: nothing above 12% yet.</div>`;
    box.innerHTML = lines +
      `<div>${d.purpose}.</div>` +
      `<div><b>Strong</b> ${d.strengths}</div><div><b>Weak</b> ${d.weaknesses}</div>` +
      (d.grewFrom ? `<div>Grew out of ${d.grewFrom.icon} ${d.grewFrom.name}.</div>` : '') +
      leanLine +
      `${d.summonOnly ? '<div class="tag">summon-only: cannot be taught, fused or put down</div>' : ''}` +
      slotLine +
      `<div><b>Trains</b> ${d.training.filter(t => t.bonus >= 0.05).map(t => `${t.label} +${Math.round(t.bonus * 100)}%`).join(', ')}</div>` +
      (d.mastery.length ? `<div><b>Mastery</b> ${d.mastery.map(k => Prof.PROFICIENCIES[k].label).join(', ')} · ${d.capStage ? `trains as far as ${d.capStage}` : 'past A+ from Master'}</div>` : '') +
      (d.features.length ? `<div><b>Features</b> ${d.features.map(f => `<span title="${f.desc}">${f.icon} ${f.name}${f.field ? ' <span class="sub">(on the map)</span>' : ''}</span>`).join(' · ')}</div>` : '') +
      (tech.length ? `<div><b>Taught</b> ${tech.map(t => t.icon + ' ' + t.name).join(' · ')}</div>` : '') +
      (d.words.length ? `<div><b>Words</b> ${d.words.join(', ')}</div>` : '') +
      (d.axes.length ? `<div><b>Axes</b> ${d.axes.map(a => Psionic.AXES[a].name.toLowerCase()).join(', ')}</div>` : '') +
      `<div><b>Orders</b> ${AI.DOCTRINES[d.mind.doctrine].label.toLowerCase()}, ${d.mind.posture === 'front' ? 'stands in front' : d.mind.posture === 'back' ? 'stays back' : 'holds the line'}, goes for ${d.target}</div>`;
  } else {
    const best = Classes.advise(c, 2);
    box.innerHTML = `<div><b>Unclassed</b></div><div>No training bonus, no mastery past A+, no taught skills, no doctrine: loadouts are built from the character alone.</div>` +
      (best.length ? `<div><b>Best fit for its aptitudes</b> ${best.map(b => b.cl.icon + ' ' + b.cl.name).join(' or ')}</div>` : '<div>Meets no class requirements yet.</div>');
  }
  box.append(classPicker(c));
  if (d && d.slotOpen) box.append(fusePicker(c));
  return box;
}

function trainingCard(c) {
  const card = characterCard(c, { size: 80, noProfs: true });
  card.classList.add('tcard');
  const inv = Object.values(state.inventory).filter(i => i.kind === 'equipment' && i.count > 0);

  // affinity summary per category
  const aff = document.createElement('div');
  aff.className = 'aff';
  const onTeam = Outfit.teamMembers(state).includes(c);
  const role = Outfit.ROLES[Outfit.roleOf(c)];
  aff.innerHTML = `<div><b>${role.icon} ${role.label}</b>${onTeam ? ' · on a team: kept supplied by the town' : ''}</div>` +
    Object.keys(Affinity.TYPES).map(cat => {
      const a = c.affinity;
      const chosen = Affinity.choose(a, cat);
      const found = Affinity.TYPES[cat].filter(t => a.compatible[cat] === t && Affinity.isDiscovered(a, t));
      return `<div><b>${TYPE_LABEL(cat)}</b> prefers ${TYPE_LABEL(a.innate[cat])}${found.length ? `, found a fit with ${TYPE_LABEL(found[0])}` : ''}${chosen !== a.innate[cat] ? ` → goes for ${TYPE_LABEL(chosen)}` : ''}</div>`;
    }).join('') +
    (c.potions && c.potions.length ? `<div><b>Potions</b> ${c.potions.map(p => p.name).join(', ')}</div>` : '');
  card.append(aff);
  card.append(classBlock(c));
  card.append(tradeBlock(c));

  // equipment slots
  const slots = document.createElement('div');
  slots.className = 'slots';
  for (const slot of SLOTS) {
    const row = document.createElement('div');
    row.className = 'slot';
    const cur = c.equipment[slot];
    const sel = document.createElement('select');
    const options = inv.filter(i => i.slot === slot);
    sel.innerHTML = `<option value="">— ${slot} —</option>` +
      (cur ? `<option value="__cur" selected>${cur.name}</option>` : '') +
      options.map(i => `<option value="${Econ.itemId(i)}">${i.name} ×${i.count}</option>`).join('');
    sel.addEventListener('change', () => {
      if (sel.value === '') unequip(c, slot);
      else if (sel.value !== '__cur') equip(c, sel.value);
      renderAll();
    });
    row.append(sel);
    if (cur) {
      const info = document.createElement('div');
      info.className = 'sub';
      const apt = Affinity.aptitudeOf(cur.type);
      info.innerHTML = `${affinityLine(c, cur.type)}<br>${Prof.PROFICIENCIES[apt].label} ${Prof.format(c.profs[apt])}`;
      row.append(info);
    }
    slots.append(row);
  }
  card.append(slots);

  // train / stop
  const row = document.createElement('div');
  row.className = 'controls';
  const btn = document.createElement('button');
  const full = workers('training').length >= slotsFor('training');
  if (c.job === 'training') { btn.textContent = 'Stop training'; btn.className = 'ghost'; btn.addEventListener('click', () => { setJob(c.id, null); renderAll(); }); }
  else {
    btn.textContent = 'Train';
    btn.disabled = full || !Object.values(c.equipment).some(Boolean);
    btn.title = full ? 'No free training slots' : (!Object.values(c.equipment).some(Boolean) ? 'Equip something first' : (c.job ? `Leaves ${JOBS[c.job].label}` : ''));
    btn.addEventListener('click', () => { setJob(c.id, 'training'); renderAll(); });
  }
  row.append(btn);
  if (c.job && c.job !== 'training') { const s2 = document.createElement('span'); s2.className = 'sub'; s2.textContent = `on ${JOBS[c.job].label}`; row.append(s2); }
  card.append(row);
  return card;
}

function renderLog() {
  $('#log').innerHTML = state.log.slice(0, 12).map(l => `<div>${l.text}</div>`).join('');
}

function renderAll() {
  renderResources();
  renderSummon();
  renderRoster();
  renderTown();
  renderJobs();
  renderInventory();
  renderTraining();
  renderAltar();
  renderGate();
  renderBestiary();
  renderLog();
}

function renderBestiary() {
  const el = $('#bestiary');
  if (el) Report.renderBestiary(el, state, Missions, Combat);
}

// ---------- gate ----------
let gateParty = [];
let gateMission = null;
let openRun = null;

function loadoutText(c) {
  const l = c.loadout;
  if (!l) return '<span class="empty">No plan yet: loadouts are built when a mission launches.</span>';
  const m = Missions.MISSION[l.mission];
  const doc = AI.DOCTRINES[l.doctrine];
  const parts = [`<div><b>Plan</b> for ${m ? m.name : l.mission} · ${l.tier} mind · <span class="tag">${doc.label}</span> <i>(${doc.desc})</i></div>`];
  if (l.rotation.length) parts.push(`<div><b>Rotation</b> ${Martial.describeRotation(l.rotation)}</div>`);
  if (l.spells.length) parts.push(`<div><b>Grimoire</b> ${l.spells.map(s => `${s.icon} ${s.name} <i>${s.manaCost}mp</i>`).join(' · ')}</div>`);
  if (l.workings.length) parts.push(`<div><b>Workings</b> ${l.workings.map(s => `${s.icon} ${s.name} <i>${Object.entries(s.shape).map(([k, v]) => k.slice(0, 3) + v).join(' ')} · ${s.focusCost.toFixed(1)} focus</i>`).join(' · ')}</div>`);
  if ((l.features || []).length) parts.push(`<div><b>Class features</b> ${l.features.map(s => `${s.icon} ${s.name} <i>${s.school === 'psionic' ? s.focusCost + ' focus' : s.manaCost + 'mp'}</i>`).join(' · ')}</div>`);
  return parts.join('');
}

// The gate's own brief. A zone is the town's ladder: its encounter list is written down and the
// same every time, so the contract half of a brief is a formality — intel 3, everything named and
// counted. What is not a formality is the right-hand column, which still only says what somebody
// came home knowing (bestiary.js). It exists so that a player walking into the Slime Throne
// reads "Slime King ×1 — never met".
let gateConfirm = null;
let gateScrolled = null;    // the brief we have already put on screen; the gate redraws every tick

/** A zone's fixed encounter list, in the shape Bestiary.brief reads. */
function zoneCast(m) {
  const n = {};
  for (const e of m.encounters) for (const id of e) n[id] = (n[id] || 0) + 1;
  return Object.entries(n).map(([species, count]) => ({ role: 'hostile', species, count, grade: Missions.BESTIARY[species].tier }));
}

function gateBrief(m, onGo, onCancel) {
  const box = document.createElement('div');
  box.className = 'jobbox';
  box.style.cssText = 'background:#2a2a36;border:1px solid #4a4a5a';
  const rows = Bestiary.brief(state, { cast: zoneCast(m), level: m.level, intel: 3 }, { Missions, Combat });
  box.innerHTML = `<h3>${m.icon} ${m.name}</h3>` +
    `<div class="sub">level ${m.level} · ${m.encounters.length} encounters · ${m.ticks} ticks · <span class="tag">the way is known</span></div>` +
    `<div class="sub" style="margin-top:8px">Expected on the ground</div>`;
  const list = document.createElement('div');
  list.style.cssText = 'margin:6px 0 2px';
  for (const r of rows) {
    const line = document.createElement('div');
    line.style.cssText = 'display:flex;gap:8px;align-items:baseline;padding:3px 0;border-top:1px solid #33333f';
    line.innerHTML = `<span style="min-width:1.4em">${r.icon}</span><b style="min-width:9em">${r.name}</b>` +
      `<span class="sub" style="margin:0;min-width:4.5em">${r.levelText}</span><b style="min-width:3.5em">${r.countText}</b>` +
      `<span class="sub" style="margin:0 0 0 auto;text-align:right" title="${r.hint}">${r.known}${r.hp ? ` · ~${r.hp}hp` : ''}${r.weak.length ? ` · weak to ${r.weak.map(w => w[0]).join(', ')}` : ''}</span>`;
    list.appendChild(line);
  }
  if (!rows.length) list.innerHTML = '<p class="empty">Nothing is listed for this one.</p>';
  box.appendChild(list);
  const party = gateParty.map(id => state.characters.find(c => c.id === id)).filter(Boolean);
  const who = document.createElement('div');
  who.className = 'sub';
  who.textContent = `Going: ${party.map(c => c.name).join(', ')}. Death out there is permanent.`;
  box.appendChild(who);
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:8px;margin-top:10px';
  const go = document.createElement('button'); go.textContent = 'Set out'; go.addEventListener('click', onGo);
  const no = document.createElement('button'); no.className = 'ghost'; no.textContent = 'Not yet'; no.addEventListener('click', onCancel);
  bar.append(go, no);
  box.appendChild(bar);
  return box;
}

function renderGate() {
  const el = $('#gate');
  el.innerHTML = '';
  const M = Missions;
  if (state.missions.active.length) {
    const box = document.createElement('div');
    box.className = 'jobbox';
    box.innerHTML = '<h3>🌀 Through the gate</h3>';
    for (const run of state.missions.active) {
      const m = M.MISSION[run.mission];
      const names = run.party.map(id => state.characters.find(c => c.id === id)).filter(Boolean);
      const row = document.createElement('div');
      row.className = 'runrow';
      row.innerHTML = `<div><b>${m.icon} ${m.name}</b> <span class="sub">level ${m.level} · encounter ${run.encounter}/${m.encounters.length} · tick ${run.progress}/${m.ticks}</span></div>
        <div class="bar"><i style="width:${Math.round(run.progress / m.ticks * 100)}%"></i></div>
        <div class="sub">${names.map(c => `${c.name} ${Math.round((run.members[c.id].hp) * 100)}% hp${run.members[c.id].alive ? '' : ' (down)'}`).join(' · ')}</div>`;
      const btn = document.createElement('button'); btn.className = 'ghost'; btn.textContent = 'Log';
      btn.addEventListener('click', () => { openRun = run; renderGate(); });
      row.append(btn);
      box.append(row);
    }
    el.append(box);
  }
  const box = document.createElement('div');
  box.className = 'jobbox';
  box.innerHTML = `<h3>🗺️ Missions</h3><div class="sub">Pick a mission and up to ${M.PARTY_MAX} free characters. When the party leaves, each member prepares its own spells, psionic workings and technique loop, as well as its mind allows, and holds to that plan for the whole run.</div>`;
  const list = document.createElement('div'); list.className = 'grid';
  for (const m of M.MISSIONS) {
    const ok = M.unlocked(state, m);
    const card = document.createElement('div');
    card.className = 'bcard mcard' + (gateMission === m.id ? ' sel' : '') + (ok ? '' : ' locked');
    const done = state.missions.done[m.id] || 0;
    card.innerHTML = `<h3>${m.icon} ${m.name}</h3><div class="sub">level ${m.level} · ${m.encounters.length} encounters · ${m.ticks} ticks${done ? ` · cleared ×${done}` : ''}</div>
      <div class="sub">${m.encounters.map(e => e.map(id => M.BESTIARY[id].icon).join('')).join(' → ')}</div>
      <div class="sub">${Econ.costText(m.reward)}</div>${ok ? '' : '<div class="sub warn">clear the previous mission first</div>'}`;
    if (ok) card.addEventListener('click', () => { gateMission = m.id; gateConfirm = null; renderGate(); });
    list.append(card);
  }
  box.append(list);
  el.append(box);

  const pbox = document.createElement('div');
  pbox.className = 'jobbox';
  const avail = state.characters.filter(c => !c.mission);
  gateParty = gateParty.filter(id => avail.some(c => c.id === id));
  pbox.innerHTML = `<h3>👥 Party <span class="sub">${gateParty.length}/${M.PARTY_MAX}</span></h3>`;
  const plist = document.createElement('div'); plist.className = 'workers';
  for (const c of avail.sort((a, b) => b.stats.stars - a.stats.stars || a.id - b.id)) {
    const card = characterCard(c, { size: 64, noProfs: true });
    card.classList.add('pcard');
    const inParty = gateParty.includes(c.id);
    card.classList.toggle('sel', inParty);
    const w = c.equipment.weapon;
    const meta = document.createElement('div'); meta.className = 'sub';
    meta.textContent = `${w ? w.name : 'unarmed'}${c.job ? ' · ' + JOBS[c.job].label : ''}`;
    const rd = Roster.describeRecord(c.record);
    if (rd) { meta.append(document.createElement('br'), rd.brief); meta.title = rd.title; }
    const b = document.createElement('button');
    b.className = inParty ? 'ghost' : '';
    const wound = Condition.wounded(state, c);
    b.textContent = inParty ? 'Remove' : (wound ? `Recovering, back in ${Condition.tickText(wound.ticks)}` : 'Add');
    if (wound) b.title = wound.why;
    b.disabled = !inParty && (c.injured > 0 || gateParty.length >= M.PARTY_MAX);
    b.addEventListener('click', () => { if (inParty) gateParty = gateParty.filter(x => x !== c.id); else if (!gateParty.includes(c.id) && gateParty.length < M.PARTY_MAX) gateParty.push(c.id); renderGate(); });
    const plan = document.createElement('div'); plan.className = 'plan'; plan.innerHTML = loadoutText(c);
    card.append(meta, b, plan);
    plist.append(card);
  }
  if (!avail.length) plist.innerHTML = '<p class="empty">Nobody is free.</p>';
  pbox.append(plist);
  const go = document.createElement('button');
  const m = gateMission && M.MISSION[gateMission];
  go.textContent = m ? `Launch ${m.name}` : 'Pick a mission';
  go.disabled = !m || !gateParty.length;
  go.style.marginTop = '10px';
  const send = () => {
    const r = Missions.launch(state, gateMission, gateParty);
    if (typeof r === 'string') { notify(r); gateConfirm = null; gateScrolled = null; renderGate(); return; }
    logLine(`🌀 ${r.party.map(id => state.characters.find(c => c.id === id).name).join(', ')} set out for ${M.MISSION[r.mission].name}`);
    gateParty = []; gateConfirm = null; openRun = r; save(); renderAll();
  };
  // ...through the brief, same as a contract: the last look at what is down there and at how much
  // of it anybody actually knows.
  if (m && gateConfirm === m.id && gateParty.length) {
    const brief = gateBrief(m, send, () => { gateConfirm = null; gateScrolled = null; renderGate(); });
    pbox.append(brief);
    // The party list above this is most of two screens, so a confirmation can open below the fold
    // and read as a button that did nothing. Scrolled once, after it is in the document (a frame
    // callback never fires on a hidden tab) and only for a brief we have not shown yet, because
    // the gate redraws every tick and dragging the page back each time would be worse.
    if (gateScrolled !== m.id) { gateScrolled = m.id; setTimeout(() => brief.scrollIntoView({ block: 'nearest' }), 0); }
  } else {
    go.addEventListener('click', () => { gateConfirm = m.id; gateScrolled = null; renderGate(); });
    pbox.append(go);
  }
  el.append(pbox);

  const hist = document.createElement('div');
  hist.className = 'jobbox';
  hist.innerHTML = '<h3>📜 Reports</h3>';
  const runs = [...state.missions.active, ...state.missions.history];
  if (openRun && !runs.includes(openRun)) openRun = runs.find(r => r.id === openRun.id) || null;
  const shown = openRun || runs[0];
  if (!runs.length) hist.innerHTML += '<p class="empty">No missions yet.</p>';
  else {
    const tabs = document.createElement('div'); tabs.className = 'controls'; tabs.style.justifyContent = 'flex-start'; tabs.style.flexWrap = 'wrap';
    for (const h of runs.slice(0, 8)) {
      const mm = M.MISSION[h.mission];
      const t = document.createElement('button'); t.className = h === shown ? '' : 'ghost';
      t.textContent = `${mm.icon} ${mm.name} · ${h.result || 'running'}`;
      t.addEventListener('click', () => { openRun = h; renderGate(); });
      tabs.append(t);
    }
    hist.append(tabs);
    if (shown) Report.renderRun(hist, shown, state, M);
  }
  el.append(hist);
}


// ---------- picker ----------
function openPicker(k) {
  const job = JOBS[k];
  const modal = $('#picker');
  modal.hidden = false;
  const slots = slotsFor(k);
  $('#picker-title').textContent = `${job.icon} ${job.label} · ${job.stats.map(s => s.toUpperCase()).join(' + ')} · ${job.label} aptitude · ${workers(k).length}/${slots === Infinity ? '∞' : slots} slots`;
  const list = $('#picker-list');
  list.innerHTML = '';
  if (workers(k).length >= slots) { list.innerHTML = `<p class="empty">All slots are taken. Upgrade the ${BUILDINGS[job.building].label.toLowerCase()} for more.</p>`; return; }
  const candidates = bestCandidates(k).filter(c => c.job !== k);
  if (!candidates.length) { list.innerHTML = '<p class="empty">Nobody available.</p>'; return; }
  const top = outputFor(candidates[0], k, true) || 1;
  for (const c of candidates) {
    const row = document.createElement('div');
    row.className = 'pick-row';
    const out = outputFor(c, k, true);
    const [a, b] = job.stats;
    row.innerHTML = `
      <div class="pick-sprite"></div>
      <div class="pick-info">
        <div class="name">${c.name} <span class="stars" style="color:${Stats.STARS[c.stats.stars].color}">${Stats.starString(c.stats.stars)}</span></div>
        <div class="sub">${c.race} · ${a.toUpperCase()} ${Stats.effective(c).base[a]} + ${b.toUpperCase()} ${Stats.effective(c).base[b]} · aptitude ${Prof.format(c.profs[k])} (×${aptitudeMult(c.profs[k]).toFixed(2)})</div>
        <div class="sub">${c.job ? `currently ${JOBS[c.job].icon} ${JOBS[c.job].label}` : 'idle'}${housed(c) ? '' : ' · <span class="warn">unhoused, works at half rate</span>'}</div>
      </div>
      <div class="pick-out"><div class="bar"><i style="width:${Math.round(out / top * 100)}%"></i></div><b>${out.toFixed(1)}</b> work/tick</div>`;
    row.querySelector('.pick-sprite').append(spriteCanvas(c, 48));
    const btn = document.createElement('button');
    btn.textContent = c.job ? 'Move here' : 'Assign';
    btn.addEventListener('click', () => { setJob(c.id, k); renderAll(); if (workers(k).length >= slotsFor(k)) $('#picker').hidden = true; else openPicker(k); });
    row.append(btn);
    list.append(row);
  }
}

// ---------- altar ----------
// The sacrifice screen. It is a PLACE, not a button on a card: nobody is spent in passing while
// reassigning jobs. Pick who is being made stronger, then pick who pays for it, with the exact
// gain on every row so the trade is made on numbers.
let altarTarget = null;
let altarConfirm = null;      // the offering with its confirmation open, so a tick redraw keeps it

const altarTier = () => tierOf('altar');
const altarShare = () => altarTier().share;

/**
 * Who would grieve `c` if they were spent, and the morale each loses. The rows are Bonds.grief, the
 * expression Bonds.mourn applies, so the figure shown is the figure taken. A row names the first
 * Roster.GRIEF_LINES friends, the ones Roster.fallAll writes log lines for; the rest are counted.
 * Each entry's tooltip gives the friend's MOR bar before and after (the bar on their sheet and
 * cards), the bond range of the tier word shown, and the formula.
 */
function griefLine(c) {
  const rows = Bonds.grief(state, c, state.characters);
  if (!rows.length) return `<div class="sub dim" title="No other character has a bond above 12 with ${c.name}, and grief starts above 12.">nobody would grieve</div>`;
  const named = rows.slice(0, Roster.GRIEF_LINES).map(r => {
    const now = Condition.morale(r.c);
    const next = Bonds.TIERS[Bonds.TIERS.indexOf(r.tier) + 1];
    const tip = `${r.c.name}: MOR ${Math.round(now)}/100 now, ${Math.round(Math.max(0, now - r.hit))} after. Tier ${r.tier.word} covers bonds ${r.tier.min} to ${next ? next.min - 1 : Bonds.MAX}. Grief applies above 12: morale hit = ${Bonds.GRIEF} x bond, at most ${Bonds.GRIEF_CAP}.`;
    return `<span title="${tip}">${r.c.name}, ${r.tier.word}: -${Math.round(r.hit)} morale</span>`;
  });
  const more = rows.length - named.length;
  return `<div class="sub warn">would grieve: ${named.join('; ')}${more > 0 ? `; +${more} more` : ''}</div>`;
}

function renderAltar() {
  const el = $('#altar');
  const t = altarTier();
  const target = state.characters.find(c => c.id === altarTarget) || null;
  if (altarTarget && !target) altarTarget = null;
  el.innerHTML = `<div class="jobbox">
    <h3>${BUILDINGS.altar.icon} ${t.name} <span class="sub">altar tier ${state.buildings.altar + 1}/${BUILDINGS.altar.tiers.length} · share ×${t.share.toFixed(2)}</span></h3>
    <div class="sub">A character can be spent to make another stronger. The one who is spent DIES: they leave the roster, their identity and face are locked out of the gate forever, and they go on the memorial with the name they were spent on. What crosses over is a share of their base stats, every aptitude and their technique repetitions — not their words, their psionic axes, their affinity or their face, which are who they were.</div>
    <div class="sub">The share is how big the offering is next to the vessel (their stat totals), divided by how many the vessel has already taken, times what this altar is worth. It falls away fast: the second offering into the same character carries half of what the first did and the fourth a quarter, and the ratio is shrinking at the same time because every offering makes the vessel bigger. A roster goes further spread across several people than poured into one. Aptitudes still stop where training stops. Raise the altar in the town to keep more of every offering.</div>
  </div>`;

  const pick = document.createElement('div');
  pick.className = 'jobbox';
  pick.innerHTML = `<h3>Who is being strengthened?</h3><div class="sub">${target ? `${target.name} keeps what is poured in. Everyone else can be spent on them.` : 'Choose the vessel first. Anyone at home can be one.'}</div>`;
  const grid = document.createElement('div');
  grid.className = 'grid';
  const home = state.characters.filter(c => !c.mission);
  if (!home.length) grid.innerHTML = '<p class="empty">Nobody is home.</p>';
  // Vessels sort by star and then by potential: an offering poured into a badly placed spread is
  // spent making a bad character bigger, and that is the choice this grid exists to inform.
  let vessels = home.length >= FILTER_FROM ? Filters.apply('vessel', home) : [...home].sort(Filters.SORTS.star.f);
  if (home.length >= FILTER_FROM) pick.append(Filters.bar('vessel', home, vessels.length, renderAltar));
  // Whoever is already chosen stays on screen whatever the filter says. Losing the vessel to a
  // dropdown while the offerings below are still pouring into them is how a mistake gets made.
  if (target && !vessels.includes(target)) vessels = [target, ...vessels];
  if (home.length && !vessels.length) grid.innerHTML = '<p class="empty">Nobody at home matches that.</p>';
  for (const c of vessels) {
    const card = characterCard(c, { size: 72, noProfs: true, noFav: true });
    card.classList.toggle('sel', c.id === altarTarget);
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => {
      altarTarget = altarTarget === c.id ? null : c.id;
      altarConfirm = null;                       // a new vessel, a fresh question
      renderAltar();
      // The offerings are below a screenful of vessels: bring them into view on the choice, but
      // only from a click — renderAltar also runs on the tick, and a screen that scrolls itself
      // every few seconds is worse than one that never does.
      const list = $('#altar .sac-list');
      if (list) list.scrollIntoView({ block: 'nearest' });
    });
    grid.append(card);
  }
  pick.append(grid);
  el.append(pick);
  if (!target) return;

  // Weakest first: that is the order a roster actually gets spent in.
  const box = document.createElement('div');
  box.className = 'jobbox';
  box.innerHTML = `<h3>Who pays for it?</h3><div class="sub">${target.name} has absorbed ${Sacrifice.count(target)} so far, so the next offering carries ×${Sacrifice.diminish(Sacrifice.count(target)).toFixed(2)} of what it would have, and the one after that ×${Sacrifice.diminish(Sacrifice.count(target) + 1).toFixed(2)}. Aptitudes stop at ${Prof.STAGES[Sacrifice.capStageFor(target)]}.</div>`;
  const list = document.createElement('div');
  list.className = 'sac-list';
  // Weakest first, still: that is the order a roster actually gets spent in. The filter is here so
  // the one thing you must never do by accident — spend a birthright, or the best-placed spread on
  // the roster, because it happened to be low on stars — can be looked for and looked at instead.
  const pool = home.filter(c => c.id !== target.id);
  const candidates = pool.length >= FILTER_FROM ? Filters.apply('offering', pool, 'weakest') : [...pool].sort(Filters.SORTS.weakest.f);
  if (!pool.length) list.innerHTML = '<p class="empty">Nobody else is home to be spent.</p>';
  else if (!candidates.length) list.innerHTML = '<p class="empty">Nobody else at home matches that.</p>';
  if (pool.length >= FILTER_FROM) box.append(Filters.bar('offering', pool, candidates.length, renderAltar, 'weakest'));
  for (const c of candidates) {
    const p = Sacrifice.preview(c, target, altarShare());
    const levels = p.profs.reduce((a, g) => a + g.levels, 0);
    const top = p.profs.filter(g => g.levels > 0).slice(0, 2)
      .map(g => `<i>${Prof.PROFICIENCIES[g.key].label}</i> +${g.levels}${g.staged ? ` → ${Prof.STAGES[g.after.stage]}` : ''}`).join(' · ');
    // With the share falling away as the vessel fills, an offering can be worth nothing at all.
    // A character spent for nothing is the worst outcome this screen allows, so such a row is
    // marked below (`spent-for-nothing`).
    const empty = !p.statTotal && !levels && !p.techTotal;
    const rd = Roster.describeRecord(c.record);
    const row = document.createElement('div');
    // A favourite is never hidden from this list — sometimes the one you like is the only offering
    // that would save somebody — and it is always marked. The mark is the player's own note to
    // themselves, and this is the one screen where forgetting it cannot be undone.
    row.className = 'pick-row' + (empty ? ' spent-for-nothing' : '') + (c.fav ? ' fav-row' : '');
    row.innerHTML = `
      <div class="pick-sprite"></div>
      <div class="pick-info">
        <div class="name">${Filters.rareMark(c)}${c.name} <span class="stars" style="color:${Stats.STARS[c.stats.stars].color}">${Stats.starString(c.stats.stars)}</span>${Filters.badge(c)}</div>
        <div class="sub">${c.race} · ${Sacrifice.totalStats(c)} stat points · ${c.job ? `${JOBS[c.job].icon} ${JOBS[c.job].label}` : 'idle'}${Sacrifice.count(c) ? ` · absorbed ${Sacrifice.count(c)}` : ''}</div>
        <div class="sub">${c.stats.stars >= target.stats.stars ? `<span class="warn">as strong as ${target.name} or stronger</span> · ` : ''}×${p.factor.toFixed(2)} of everything they are</div>
        ${rd ? `<div class="sub" title="${rd.title.replace(/"/g, '&quot;')}">${rd.brief}</div>` : ''}
        ${griefLine(c)}
      </div>
      <div class="sac-gain">
        ${c.fav ? `<div class="warn">♥ you marked ${c.name} a favourite</div>` : ''}
        ${empty ? `<div class="warn">${target.name} is full: this would be a death for nothing</div>` : ''}
        <div><b>+${p.statTotal}</b> stats${Stats.BASE_STATS.filter(k => p.stats[k]).map(k => ` ${k.toUpperCase()}+${p.stats[k]}`).join('')}</div>
        <div title="+${levels} levels across every aptitude"><b>${p.profs.filter(g => g.levels > 0).length}</b> aptitudes raised</div>
        ${top ? `<div class="sub">${top}</div>` : ''}
        ${p.techTotal ? `<div class="sub">+${p.techTotal} technique reps</div>` : ''}
      </div>`;
    row.querySelector('.pick-sprite').append(spriteCanvas(c, 48));
    // The one irreversible button in the game gets a question in words rather than an armed
    // label: a mis-click here costs a character forever, and "Sacrifice" twice is too easy.
    const ask = document.createElement('div');
    ask.className = 'sac-ask';
    if (altarConfirm === c.id) {
      row.classList.add('arming');
      ask.innerHTML = `<div class="warn">${c.name} dies here and can never be summoned again.${rd ? ` Record: ${rd.confirm}.` : ''}${c.fav ? ` You marked them a favourite — ${Potential.of(c).grade} potential, ${Classes.title(c).toLowerCase()}.` : ''}</div>`;
      const yes = document.createElement('button');
      yes.className = 'danger';
      yes.textContent = `Spend ${c.name}`;
      yes.addEventListener('click', () => { sacrificeTo(target, c); altarConfirm = null; renderAll(); });
      const no = document.createElement('button');
      no.className = 'ghost';
      no.textContent = 'Keep them';
      no.addEventListener('click', () => { altarConfirm = null; renderAltar(); });
      ask.append(yes, no);
    } else {
      const btn = document.createElement('button');
      btn.className = 'danger';
      btn.textContent = 'Sacrifice';
      btn.addEventListener('click', () => { altarConfirm = c.id; renderAltar(); });
      ask.append(btn);
    }
    row.append(ask);
    list.append(row);
  }
  box.append(list);
  el.append(box);
  Filters.restoreFocus();
}

// ---------- the save panel ----------
// Both halves live in the picker modal rather than in a tab: this is housekeeping, done rarely,
// and it should not take a place in the nav beside the parts of the game you actually play.

/**
 * The panel's undo row: what the previous save holds and an armed button that swaps it with the
 * current one (restoreSave). Returns null when there is no previous save. A previous save that
 * does not parse is reported and not offered, since restoring it would load an empty town.
 */
function previousSaveRow() {
  const text = SaveStore.rollback(store(), SAVE_KEY);
  if (text === null) return null;
  const box = document.createElement('div');
  box.className = 'savepane';
  const r = parseSave(text);
  if (!r.ok) {
    box.innerHTML = `<div class="sub"><span class="warn">Previous save: stored, but not readable (${r.why}), so it cannot be restored.</span></div>`;
    return box;
  }
  const lastTick = r.state.lastTick;
  const line = document.createElement('div');
  line.className = 'sub';
  line.textContent = `Previous save: ${r.summary.characters} characters, ${r.summary.fallen} on the memorial, ${r.summary.town}, ${r.summary.gems} gems` +
    (typeof lastTick === 'number' ? ` · last tick ${new Date(lastTick).toLocaleString()}` : '');
  const note = document.createElement('div');
  note.className = 'sub';
  note.textContent = 'Restoring swaps it with the current save: the current save becomes the previous one, so a second restore undoes the first.';
  const btn = document.createElement('button');
  btn.className = 'danger';
  btn.textContent = 'Restore previous save';
  arm(btn, 'Replace current save?', () => {
    const res = restoreSave();
    if (!res.ok) note.innerHTML = `<span class="warn">${res.why}</span>`;
  }, 6000);
  const row = document.createElement('div');
  row.className = 'saverow';
  row.append(btn);
  box.append(line, note, row);
  return box;
}

function openSavePanel(mode = 'export') {
  $('#picker').hidden = false;
  const list = $('#picker-list');
  list.innerHTML = '';
  const sum = saveSummary(state);
  const size = Math.round(exportText().length / 1024);
  $('#picker-title').textContent = mode === 'export' ? '\u{1F4BE} Export the save' : '\u{1F4C2} Import a save';

  const head = document.createElement('div');
  head.className = 'savepane';
  head.innerHTML = mode === 'export'
    ? `<div class="sub">Everything this town is: ${sum.characters} characters, ${sum.fallen} on the memorial, ${TOWN[state.town].name}, ${sum.gems} gems. About ${size} KB of JSON.</div>
       <div class="sub">A save lives in one browser and nowhere else. This is the copy that survives a cleared cache, a new machine, or a bad idea.</div>`
    : `<div class="sub">Loading a save REPLACES the one in this browser: ${sum.characters} characters and ${sum.fallen} names on the memorial are what you would be writing over. Export it first if you want it back.</div>`;
  list.append(head);
  const previous = previousSaveRow();
  if (previous) list.append(previous);

  const row = document.createElement('div');
  row.className = 'saverow';

  if (mode === 'export') {
    const dl = document.createElement('button');
    dl.textContent = 'Download the file';
    const copy = document.createElement('button');
    copy.className = 'ghost';
    copy.textContent = 'Copy as text';
    const note = document.createElement('div');
    note.className = 'sub';
    dl.addEventListener('click', () => {
      note.textContent = downloadSave()
        ? `Saved as ${exportName()}. If no file appeared, this browser blocks downloads — use Copy as text instead.`
        : 'This browser refused the download. Use Copy as text instead.';
    });
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(exportText()); note.textContent = `${size} KB copied. Paste it somewhere that keeps text.`; }
      catch (e) { note.textContent = 'The clipboard is not available here — use Download the file.'; }
    });
    const swap = document.createElement('button');
    swap.className = 'ghost';
    swap.textContent = 'Import instead';
    swap.addEventListener('click', () => openSavePanel('import'));
    row.append(dl, copy, swap);
    list.append(row, note);
    return;
  }

  // ----- import -----
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = 'application/json,.json,text/plain';
  const paste = document.createElement('textarea');
  paste.className = 'savepaste';
  paste.placeholder = '…or paste an exported save here';
  const note = document.createElement('div');
  note.className = 'sub';
  const load = document.createElement('button');
  load.className = 'danger';
  load.textContent = 'Load this save';
  load.disabled = true;
  let pending = null;

  const offer = (text) => {
    const r = parseSave(text);
    if (!r.ok) { pending = null; load.disabled = true; note.innerHTML = `<span class="warn">${r.why}</span>`; return; }
    pending = r.state;
    load.disabled = false;
    note.innerHTML = `Ready: <b>${r.summary.characters}</b> characters, ${r.summary.fallen} on the memorial, ${r.summary.town}, ${r.summary.gems} gems` +
      (r.exported ? ` · written ${new Date(r.exported).toLocaleString()}` : '') +
      `<br>The save this replaces is kept as the previous save, one undo deep, until the next import or reset.`;
  };

  file.addEventListener('change', async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    try { offer(await f.text()); } catch (e) { note.innerHTML = '<span class="warn">that file could not be read</span>'; }
  });
  paste.addEventListener('input', () => { if (paste.value.trim()) offer(paste.value.trim()); });

  // Armed, like everything else here that cannot be taken back — and it reloads the page, so
  // there is no second chance to notice it was the wrong file.
  arm(load, 'Replace my save?', () => {
    if (!pending) return;
    const r = importSave(pending);
    if (!r.ok) note.innerHTML = `<span class="warn">${r.why}</span>`;
  }, 6000);

  // not named `save`: that is the module's own function, and shadowing it here would put the
  // whole panel in its temporal dead zone
  const mine = document.createElement('button');
  mine.className = 'ghost';
  mine.textContent = 'Export mine first';
  mine.addEventListener('click', () => openSavePanel('export'));
  row.append(load, mine);
  list.append(file, paste, row, note);
}

// ---------- tabs ----------
function showTab(name) {
  let active = null;
  document.querySelectorAll('.tab').forEach(t => {
    const on = t.dataset.tab === name;
    t.classList.toggle('active', on);
    if (on) active = t;
  });
  document.querySelectorAll('.panel').forEach(p => p.hidden = p.id !== 'panel-' + name);
  // On a narrow screen the sidebar is a strip that scrolls sideways, and the tab you are on can
  // easily be off the end of it — on boot, most of all, when the saved tab is the last one.
  if (active && window.innerWidth <= 760) active.scrollIntoView({ inline: 'center', block: 'nearest' });
  try { localStorage.setItem(SAVE_KEY + '.tab', name); } catch (e) { /* ignore */ }
  const content = document.getElementById('content');
  if (content) content.scrollTop = 0;
}

// ---------- boot ----------
/**
 * catalog.json is the one load init() cannot go on without: every character is drawn from it.
 * (Bestiary.loadIndex catches its own fetch failure and carries on with no portraits.) Opened
 * from disk, the browser refuses the fetch; served over http, a missing file answers 404. Either
 * way init() used to reject before any handler was attached, and the page was empty and silent.
 */
function showBootError(e) {
  console.error(e);
  const p = document.createElement('p');
  p.className = 'warn';
  p.style.margin = '20px 0';
  p.textContent = `catalog.json could not be loaded: ${(e && e.message) || e}. ` +
    'Serve this folder over http (for example: python -m http.server) and open game.html from that address; ' +
    'a page opened from disk cannot fetch it. If it is already served over http, catalog.json must be in the same folder as game.html.';
  $('#content').replaceChildren(p);
}

async function init() {
  try { await LPC.loadCatalog(); } catch (e) { showBootError(e); return; }
  if (typeof Bestiary !== 'undefined') await Bestiary.loadIndex();
  state = load();
  const away = catchUp();

  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));
  let tab = 'summon';
  try { tab = localStorage.getItem(SAVE_KEY + '.tab') || 'summon'; } catch (e) { /* ignore */ }
  showTab(tab);

  $('#pull').addEventListener('click', () => {
    const c = summon();
    if (!c) return;
    const result = $('#pull-result');
    result.innerHTML = '';
    result.append(characterCard(c, { size: 160 }));
    renderAll();
  });
  $('#picker-close').addEventListener('click', () => { $('#picker').hidden = true; });
  $('#picker').addEventListener('click', (e) => { if (e.target.id === 'picker') $('#picker').hidden = true; });
  $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
  // Escape closes whichever overlay is on top. The sheet is opened from the roster and the picker
  // from a job box, so they are never both up, but the sheet is checked first regardless.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (sheetId != null) closeSheet();
    else if (!$('#picker').hidden) $('#picker').hidden = true;
  });
  $('#export').addEventListener('click', () => openSavePanel('export'));
  $('#import').addEventListener('click', () => openSavePanel('import'));
  arm($('#reset'), 'Wipe everything?', () => {
    // a live sortie holds the state object being replaced and would keep ticking against it
    if (typeof Sortie !== 'undefined') Sortie.discard();
    // the save being wiped becomes the previous save, restorable from the save panel
    if (!isHollow(state)) SaveStore.wipe(store(), SAVE_KEY);
    state = newState(); save(); $('#pull-result').innerHTML = ''; renderAll();
    if (typeof Sortie !== 'undefined') Sortie.render();      // the Field panel is not part of renderAll
  }, 6000);

  setInterval(() => {
    const now = Date.now();
    if (now - state.lastTick >= TICK_MS) {
      tick(); state.lastTick = now; save();
      // the summon button reads gems too: without this it stayed locked after a pull took the
      // town under the cost, however far the gems grew back afterwards
      renderResources(); renderSummon(); renderLog();
      const activeTab = document.querySelector('.tab.active');
      const active = activeTab ? activeTab.dataset.tab : '';
      if (active === 'jobs') renderJobs();
      if (active === 'inventory') renderInventory();
      if (active === 'town') renderTown();
      if (active === 'training') renderTraining();
      if (active === 'altar') renderAltar();
      if (active === 'gate') renderGate();
      if (active === 'bestiary') renderBestiary();
      if (active === 'roster') renderRoster();
      // the Field board is drawn from the same wound readings as the roster (Condition.wounded), so it is
      // redrawn each tick too or its "back in N ticks" would fall behind the roster's; a live run is not redrawn
      if (active === 'field' && typeof Sortie !== 'undefined' && !Sortie.run) Sortie.render();
      refreshSheet();
    }
    const remaining = Math.max(0, TICK_MS - (now - state.lastTick));
    $('#tick').textContent = `next tick in ${Math.ceil(remaining / 1000)}s` + (saveError ? ` - save failed: ${saveError}` : '');
  }, 500);

  $('#away-close').addEventListener('click', () => { $('#away').hidden = true; });
  $('#away').addEventListener('click', (e) => { if (e.target.id === 'away') $('#away').hidden = true; });
  if (away && away.ticks > 0) showAway(away);
  renderAll();
}

// Bridge for sortie.js, the live mission screen. It needs the town's ledgers — characters,
// resources, the log, the inventory — but has no business being in this file.
window.Game = {
  get state() { return state; },
  save, logLine, addItem, renderAll, renderResources, renderRoster,
  setJob, outputFor, slotsFor, jobApi, applyOptimalJobs,
  advanceCharacter,          // the field calls this when an advancement trial is passed
};

// init() awaits two fetches and then renders every panel. A cached fetch can resolve before the
// parser has run the scripts listed after this one (missiontypes.js, sortie.js, ...), so it
// starts only once every script tag has executed.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
})();
