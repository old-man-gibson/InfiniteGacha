// A sortie: one mission run live on a map. Browser only: window.Sortie.
// field.js walks the actors, combat.js resolves what happens when they meet, and the town's
// own ledgers (missions.js) hand out the loot, the aptitude gains and the injuries — the same
// ones the tick-driven zone runs use, so a field mission and a zone run pay in one currency.
//
// The join between the two halves is `resolve`: field.js decides WHO is fighting and for how
// long, combat.js decides WHAT HAPPENS, and the fighters are kept alive between skirmishes so
// a squad that has been chewed through three rooms walks into the fourth already hurt.
//
// A run is SAVED as it goes. Missions take minutes of real time and browsers get closed, so the
// field state is written into the town's save every SAVE_EVERY in-game seconds and again the
// moment the page is hidden or unloaded; on the next boot it picks up where it stopped. What is
// stored is small — tiles, positions, wounds — and everything derived is rebuilt (see Field.save).
// The fight blocks of the report so far are stored with it (keptFights). When a run ends, settle()
// or abandon() writes its report to gs.field.history and adds it to the type's counts in
// gs.field.types (keepReport); the board shows the counts and the Reports box shows the reports.
//
// Death here is permanent. A character that falls does not come home injured: roster.js retires
// it, locks its identity out of the summoning pool and writes it on the wall.

(() => {
const MT = MissionTypes, F = Field, C = Combat, M = Missions;

const BOARD_SIZE = 5;
const REROLL_MS = 6 * 60 * 1000;     // the board turns over every six real minutes
const REGEN = 0.005;                 // fraction of max hp regained per in-game second out of a fight
const STALEMATE_COOL = 30;           // in-game seconds two sides stay apart after breaking off
// What a grade is worth in levels when the species pool cannot express it. missions.js scales a
// monster by 35% per level, so an ancient is an elite three levels older and meaner.
const GRADE_BUMP = { basic: 0, veteran: 0, elite: 1, ancient: 3, legendary: 4 };
const SAVE_EVERY = 20;               // in-game seconds between writes of a run in progress
const KEEP_REPORTS = 8;              // finished sorties kept in gs.field.history, newest first
const KEEP_FIGHTS = 12;              // newest fight blocks a report or a saved run keeps, besides every fight with a fall

let run = null;                      // the live run, if any
let timer = null, raf = null, acc = 0, lastReal = 0;
let speed = 1, bulk = false;         // bulk: skipping to the end, so do not touch the DOM per step
const G = () => window.Game;

// ---------- the board ----------

/**
 * What this town can actually handle. Stars are a poor guide — a fresh 4★ with no aptitudes and
 * no equipment dies to level-6 work — so the ladder is the zone list: whatever they have already
 * cleared through the gate, plus one. Rarity only nudges it.
 */
function townLevel(gs) {
  let best = 0;
  for (const [id, n] of Object.entries(gs.missions.done || {})) {
    const z = M.MISSION[id];
    if (z && n > 0) best = Math.max(best, z.level);
  }
  const stars = gs.characters.length ? Math.max(...gs.characters.map(c => c.stats.stars)) : 1;
  return Math.max(1, Math.min(20, best + 1 + Math.floor((stars - 1) / 2)));
}

/**
 * Decide what is actually out there, at the moment the contract goes up on the board rather than
 * at the moment the party walks onto the map. Nothing else changes — fieldview.js's namer honours
 * a species that is already set — but it is what lets a brief exist at all: the player cannot be
 * shown "Cave Spider ×12" before anybody has decided there are cave spiders.
 *
 * Only the other side gets named. What the player is then ALLOWED to read off this is a different
 * question, answered by the contract's `intel` and the town's bestiary (bestiary.js brief).
 */
function nameCast(mission) {
  for (const g of mission.cast) {
    if (!['hostile', 'patrol', 'mark'].includes(g.role) || g.side === 'ours' || g.species) continue;
    const n = FieldView.namer(g, mission);
    if (n) { g.species = n.id; g.speciesName = n.label; g.speciesIcon = n.icon; }
  }
  return mission;
}

function rollBoard(gs) {
  const base = townLevel(gs);
  const types = Object.keys(MT.TYPES);
  const board = [];
  for (let i = 0; i < BOARD_SIZE; i++) {
    const type = Rng.pick(types);
    const level = Math.max(1, base + Rng.randInt(-1, 1));
    board.push({ ...nameCast(MT.roll(type, { level })), boardId: 'b' + Date.now().toString(36) + i });
  }
  return board;
}

/**
 * The trials in front of the roster right now, as missions. They live alongside the contracts
 * because that is what they are — the only difference is `mission.trial`, which says whose star
 * is riding on it, and that the party picker will not let anyone else stand in for them.
 */
function trialBoard(gs) {
  if (typeof Quests === 'undefined') return [];
  Quests.tidy(gs);
  const out = [];
  for (const o of Quests.offers(gs)) for (const road of Quests.ROADS) out.push(nameCast(o.offer[road]));
  return out;
}

function board(gs, force = false) {
  if (!gs.field) gs.field = { board: [], rolledAt: 0 };
  if (force || !gs.field.board.length || Date.now() - gs.field.rolledAt > REROLL_MS) {
    gs.field.board = rollBoard(gs);
    gs.field.rolledAt = Date.now();
    G().save();
  }
  return gs.field.board;
}

// ---------- fighters ----------

/**
 * Loadouts are planned against the enemies actually on this map. missions.js's prepare() wants
 * a zone-shaped mission, so give it one: same level, and one "encounter" holding every species
 * the namer put on the field. A brilliant character then plans against what is really there.
 */
function pseudoZone(mission, species) {
  return {
    id: `field:${mission.type}:${mission.level}:${species.length}`,
    name: mission.name, icon: mission.icon, level: mission.level,
    encounters: [species.length ? species : ['forest_rat']],
  };
}

function fighterFor(a) {
  if (a.fighter) return a.fighter;
  if (a.role === 'squad') {
    if (!a.char) return null;
    a.fighter = C.fromCharacter(a.char, M.prepare(a.char, run.zone), run.gs.mercy);
    // cohesion of the party that went (Crew.cohesion, set at launch and rebuilt by resume): damage and
    // magic damage x (1 + bonus), armour x (1 + bonus / 2)
    const bonus = run.bonus || 0;
    if (bonus) {
      a.fighter.base.damage *= 1 + bonus;
      a.fighter.base.magicDamage *= 1 + bonus;
      a.fighter.base.armor *= 1 + bonus * 0.5;
    }
    // What the squad member is worth to field.js's odds (power x hp), read from the fighter after the
    // team multipliers above, so stats, gear, class, weapon aptitude and the team bonus are all in it.
    // power is scaled by Combat.RATE_K (combat.js), guard multiplies hp (field.js fightHp).
    // The walking pace comes from the walk speed on the character sheet, held to 0.9..1.1 of BASE_SPEED (field.js pace).
    const r = C.rating(a.fighter);
    a.power = C.RATE_K * r.power;
    a.guard = r.guard;
    a.speed = F.BASE_SPEED * F.pace(Stats.effective(a.char).derived.walkSpeed);
  } else {
    if (!a.species) return null;
    // ...at the mission's level, plus what its grade is worth, minus how far under its weight it
    // is turning up (missiontypes.js swarm). Forty rats at level nine, not forty at eighteen.
    const lv = run.mission.level + (GRADE_BUMP[a.grade] || 0) + (a.levelOffset || 0);
    a.fighter = M.spawn(a.species, Math.max(1, lv), run.gs.mercy);
    a.fighter.name = a.label;
  }
  // a resumed run rebuilds its combatants and then pours the saved wounds and cast count back in;
  // statuses and cooldowns do not survive, which is the right trade for a save that is a few kilobytes
  if (a.combat) {
    a.fighter.hp = Math.max(1, Math.min(a.fighter.maxHp, a.combat.hp));
    for (const [k, cur] of Object.entries(a.combat.pools || {})) {
      if (a.fighter.pools[k]) a.fighter.pools[k].cur = Math.min(a.fighter.pools[k].max, cur);
    }
    if (a.combat.casts) a.fighter.stats.casts = a.combat.casts;
    delete a.combat;
  }
  a.maxHp = a.fighter.maxHp;
  a.hp = a.fighter.hp;
  return a.fighter;
}

/**
 * Field.start's and Field.restore's `rate` option: { power, hp, guard } of a hostile of this species
 * at the level its group is fielded at (castLevel), taken from the same stat block combat.js builds
 * its monsters from (Combat.baseOfMonster) with tierMult at the middle of the species' tier range.
 * Rarity and modifier are not included: they are rolled when the hostile is first fought (M.spawn),
 * and fighterFor then replaces the actor's hp with the spawned fighter's. No RATE_K: that constant is
 * on the squad's side only. Answers are cached per species and level.
 */
const foeRates = new Map();
function rateFoe(species, g, mission) {
  const def = M.BESTIARY[species];
  if (!def) return null;
  const level = castLevel(mission, g);
  const key = species + ':' + level;
  let r = foeRates.get(key);
  if (!r) {
    const range = M.TIERS[def.tier];
    const block = C.baseOfMonster(def, level, { tierMult: (range[0] + range[1]) / 2 });
    r = { ...C.rating(block), hp: block.hp };
    foeRates.set(key, r);
  }
  return r;
}

/** field.js asks for a skirmish; combat.js answers with a whole fight. */
function resolve(ours, theirs, s) {
  const party = ours.map(fighterFor).filter(f => f && f.alive);
  const foes = theirs.map(fighterFor).filter(f => f && f.alive);
  // nobody to fight on one side: keep them apart rather than reopening this every second
  if (!party.length || !foes.length) {
    for (const a of [...ours, ...theirs]) a.noFightUntil = s.clock + 120;
    return { ticks: 20, log: [], dead: [] };
  }
  run.contact = true;                    // set at the first resolved fight and saved with the run; nothing in this file reads it (untouched() reads Field.contacted)
  run.fights = (run.fights || 0) + 1;    // skirmishes fought: Missions.debrief pays class XP for them, capped

  // What has happened to them so far on this map goes into the fight: combat.js reads `resolve`
  // off the fighter and it is the difference between a squad that has lost somebody and one that
  // has lost somebody they cared about (field.js, tactics.js).
  for (const a of ours) if (a.fighter) a.fighter.resolve = a.resolve || 0;
  // ...and whether anybody in it has a way OUT (field.js escapeHatch): a fight that has gone wrong
  // stops where it stands and the field puts them somewhere else, instead of playing to the end
  const hatch = F.escapeHatch(ours, s);
  // ...and the ground they are standing on, which is the difference between four rats at a time
  // and forty.
  // Read off the tiles under the squad (field.js frontage), so backing into a corridor is worth
  // something without anyone having had to be told to do it.
  const opts = { frontage: F.frontage(s, ours) };
  if (hatch) opts.breakOff = (ctx, p, e) => hatch(ctx.tick, p, e);
  // Two facts about the fight, read before it runs and stored on its report block: the ground
  // width (opts.frontage, null when field.js cannot read it) and the squad's HP as a percent of
  // its maximum at the start.
  const startHp = Math.round(100 * party.reduce((n, f) => n + Math.max(0, f.hp), 0) / party.reduce((n, f) => n + f.maxHp, 0));
  const res = C.encounter(party, foes, opts);
  // The lowest HP fraction each squad member had at the end of a fight. It is sampled here because
  // REGEN refills HP between fights, so HP at settle() says little about how close a fight came.
  // In-fight healing and potions are already in a.fighter.hp. debriefSquad() passes it to Missions.debrief.
  for (const a of ours) if (a.fighter && a.fighter.alive) a.low = Math.min(a.low === undefined ? 1 : a.low, a.fighter.hp / a.fighter.maxHp);
  if (typeof Bestiary !== 'undefined') Bestiary.record(run.gs, run, foes, party, res, (run.zone && run.zone.level) || 1, { width: opts.frontage, startHp });
  const dead = [...ours, ...theirs].filter(a => a.fighter && !a.fighter.alive);
  for (const a of [...ours, ...theirs]) if (a.fighter) a.hp = a.fighter.hp;

  for (const f of party) M.trainFromFight(f);
  for (const k of res.kills) run.loot.push(...M.rollLoot(run.gs, k, run.zone));
  Roster.noteKills(res.kills);           // service record: credited at the kill, so a member who dies later has them on the memorial

  // a fight neither side can finish: they break off and stay apart for a while, or the two
  // of them stand in the same tile re-opening the same stalemate every second forever
  if (res.timedOut) {
    // the cooldown runs from when the fight ENDS, not when it started, or they walk straight
    // back into each other the moment the playback finishes
    const until = s.clock + Math.round(res.ticks / 10) + STALEMATE_COOL;
    for (const a of [...ours, ...theirs]) a.noFightUntil = until;
    res.log.push('neither side can finish it — they break off');
  }
  return { ticks: res.ticks, log: res.log.slice(-40), dead, broke: res.broke || null };
}

// ---------- launching ----------

function launch(mission, charIds) {
  const gs = G().state;
  const chars = charIds.map(id => gs.characters.find(c => c.id === id)).filter(Boolean);
  if (!chars.length) return 'Pick somebody to send';
  if (chars.length < mission.party[0]) return `${mission.label} needs at least ${mission.party[0]}`;
  if (chars.length > mission.party[1]) return `${mission.label} takes at most ${mission.party[1]}`;
  for (const c of chars) {
    if (c.mission) return `${c.name} is already out`;
    if (c.injured > 0) return `${c.name} is still recovering`;
  }
  // A trial belongs to one person. Others can walk in beside them on the group road, but the
  // star is theirs and they have to be the one standing there for it.
  let owner = null;
  if (mission.trial) {
    owner = gs.characters.find(c => c.id === mission.trial.charId);
    if (!owner) return 'whoever this trial was for is gone';
    if (!charIds.includes(owner.id)) return `${owner.name} has to go on their own trial`;
  }

  // ORDER. The map, the run and every fighter are built first, inside the try. The trial fee, the
  // c.mission flags, the log and the save come after, once all of it exists. A build that throws
  // puts the previous `run` back and returns the reason, with the town unchanged. (Building a
  // fighter writes c.loadout, a cache keyed by signature that the next prepare reuses or replaces.)
  const before = run;
  let building = mission.name;       // what the message names if the build throws
  let fed = null;                    // Condition.feed's result: the meals come out of the pantry inside the build, so a failure after it gives them back
  const id = 'field' + Date.now();
  try {
    // cohesion of the people who go, from their pair records (crew.js); a saved team is not needed
    const co = Crew.cohesion(gs, chars);
    // the real characters go in, not copies: their aptitudes and xp are written to during the run.
    // `scout` is the best scouting in the party (ai.js): below AI.PERFECT_SCOUT they have to find
    // the objective before they can walk at it, and how well they search is this number.
    // ...and `will` is what the people in it are like (temper.js): the same squad with the same
    // numbers keeps working or turns for the gate at completely different moments depending on who
    // is in it, and the field itself never learns why.
    const s = F.start(mission, {
      party: chars, resolve, name: FieldView.namer, rate: rateFoe,
      scout: AI.bestScout(chars), will: Temper.will(chars),
      // and the two things a squad does that are about the people in it rather than the contract:
      // whether they change the plan (who they trust) and what a body does to the rest of them
      tactics: (run2) => Tactics.propose(run2, gs),
      grieve: (fallen, survivors) => Tactics.grieve(gs, fallen.char, survivors),
      // and what their classes let them do to the map itself (classes.js fieldKit)
      kit: (c) => Classes.fieldKit(c),
      // ...and what they come home KNOWING, which is not only what they killed. A recon that never
      // draws a blade used to teach the town nothing; now the entry opens on sight, and the next
      // contract that names this species is a name on the brief instead of a ???.
      sighted: (id, a) => noteSighting(id, a),
    });
    const feel = Temper.readParty(chars);
    if (feel.axis) s.log.push({ t: 0, text: `\u{1F9E0} a ${feel.word} squad — ${feel.note}` });
    // Each squad member starts with the resolve their morale and stamina give (condition.js resolveSeed:
    // 0 or below). field.js reads the squad's mean in broken() and in the escapeHatch lines, and combat.js
    // in its action weights. The log lists every seed that is not 0 with the terms that produced it, then
    // the lines those seeds and the squad's temper give, which are the ones the picker showed.
    for (const a of s.actors) {
      if (a.role !== 'squad' || !a.char) continue;
      const seed = Condition.explainSeed(a.char);
      a.resolve = seed.seed;
      if (seed.seed < 0) s.log.push({ t: 0, text: `${a.label} starts with resolve ${seed.seed.toFixed(2)}: ${seed.text}` });
    }
    s.log.push({ t: 0, text: willLine(willLines(chars, s.will)) });

    // Every body, not every KIND of body: missionProfile reads the count off this list, and a mage
    // who is told there are three species out there composes a different grimoire from one who is
    // told there are forty of them. It is the only warning the loadout builders get about a horde.
    const species = s.actors.filter(a => a.species && a.side === 'theirs').map(a => a.species);
    // fighterFor reads the module-level `run`, so it is set before the fighters are built
    run = {
      id, gs, mission, field: s, loot: [], started: Date.now(),
      zone: pseudoZone(mission, species),
      party: chars.map(c => c.id),
      bonus: co.bonus,                 // read by fighterFor; not saved, resume() computes it again from the party
      cohesion: co,                    // the reading it came from, printed by the run panel
      trialPaid: null,                 // set below once Quests.begin has taken the fee
      contact: false,                  // set by resolve() on the first fight (see abandon)
      fights: 0,                       // counted by resolve(), read by debriefSquad
    };
    if (co.bonus > 0.005) s.log.push({ t: 0, text: cohesionLine(co) });
    // Each member eats one meal, best first (condition.js feed). It is before the fighters because
    // Combat.fromCharacter reads c.meal when it builds them.
    fed = Condition.feed(gs, chars);
    if (fed.line) s.log.push({ t: 0, text: `\u{1F372} ate before setting out: ${fed.line}` });
    for (const a of s.actors.filter(x => x.role === 'squad')) { building = a.char.name; fighterFor(a); }   // plan before the first step
    building = mission.name;
    FieldView.faces(s);
  } catch (e) {
    run = before;
    if (fed) Condition.unfeed(gs, fed);
    return `${building} cannot be prepared: ${e.message}`;
  }

  // The build is complete; from here the town changes.
  if (owner) {
    const started = Quests.begin(gs, owner, mission.trial.road);
    if (started.error) { run = before; Condition.unfeed(gs, fed); return started.error; }
    run.trialPaid = { ...started.paid };
    G().logLine(`⭐ ${owner.name} sets out on ${mission.name}${Object.keys(started.paid).length ? ` · ${Econ.costText(started.paid)} spent` : ''}`);
  }
  for (const c of chars) { c.mission = id; c.job = null; c.progress = 0; }
  G().logLine(`${mission.icon} ${chars.map(c => c.name).join(', ')} set out: ${mission.name}`);
  G().save();
  start();
  return run;
}

/**
 * One monster seen. Cheap enough to call per actor. Returns a line for the field to say the first
 * time this town has ever laid eyes on the species, and nothing on any sighting after that.
 */
function noteSighting(id, a) {
  // guarded on the function, not just the module: a run resumed from a save outlives a reload,
  // and a throw in here takes the whole tick loop down with it
  if (!run || typeof Bestiary === 'undefined' || !Bestiary.sight || !M.BESTIARY[id]) return null;
  const lv = run.mission.level + (GRADE_BUMP[a.grade] || 0) + (a.levelOffset || 0);
  if (!Bestiary.sight(run.gs, M.BESTIARY[id], Math.max(1, lv))) return null;
  return `\u{1F441}\uFE0F ${M.BESTIARY[id].name} \u2014 nobody from the town had ever seen one`;
}

// ---------- keeping the run ----------

/**
 * The town's record of its sorties: gs.field.history (finished sorties, newest first, at most
 * KEEP_REPORTS) and gs.field.types (contract type -> { sent, won, dead }). A save from before
 * either existed gets both empty.
 */
function ledger(gs) {
  if (!gs.field) gs.field = { board: [], rolledAt: 0 };
  if (!Array.isArray(gs.field.history)) gs.field.history = [];
  if (!gs.field.types || typeof gs.field.types !== 'object') gs.field.types = {};
  return gs.field;
}

/**
 * The fight blocks (bestiary.js record) that a report or a saved run keeps: the newest KEEP_FIGHTS
 * and every fight in which somebody fell. The blow-by-blow log stays only on the fights with a
 * fall. The fall fights are kept so a cause and its fight survive a sortie longer than KEEP_FIGHTS
 * and a reload in the middle of it; there are at most as many of them as there are squad members.
 */
function keptFights(blocks) {
  const from = Math.max(0, blocks.length - KEEP_FIGHTS);
  return blocks.filter((e, i) => i >= from || (e.falls && e.falls.length)).map(e => (e.falls && e.falls.length ? e : { ...e, log: [] }));
}

/**
 * Write a finished sortie into the ledger. `got` is the loot as report.js reads it: rows of
 * { kind, key?, amount } already summed per kind and multiplied by the class loot multiplier.
 * The record has the shape of a Gate run (missions.js finish), so Report.renderRun draws it;
 * `party` rows are { id, name, role } instead of ids, `fights` is every fight fought and
 * `encounters` the kept ones (keptFights). A contract adds to its type's counts; a trial does not,
 * because the board offers trials separately from contract types. Returns the record.
 */
function keepReport(r, { won, why, paid, got, lost }) {
  const led = ledger(r.gs), m = r.mission;
  const squad = r.field.actors.filter(a => a.role === 'squad' && a.char);
  const rec = {
    id: r.id, mission: m.name, icon: m.icon, type: m.type, level: m.level, at: Date.now(),
    won: !!won, result: why, lost: lost.map(f => f.name),
    party: squad.map(a => ({ id: a.char.id, name: a.char.name, role: typeof Outfit !== 'undefined' ? Outfit.roleOf(a.char) : null })),
    rewards: paid, loot: got,
    fights: r.fights || 0, encounters: keptFights(r.encounters || []),
  };
  led.history.unshift(rec);
  led.history.length = Math.min(led.history.length, KEEP_REPORTS);
  if (!m.trial) {
    const t = led.types[m.type] || (led.types[m.type] = { sent: 0, won: 0, dead: 0 });
    t.sent++;
    if (won) t.won++;
    t.dead += lost.length;
  }
  return rec;
}

/**
 * Saving flushes any fight that is midway through its playback (Field.save), which would dump
 * its remaining lines and land its deaths early. So a routine save waits for a clean moment
 * between fights; only a page that is actually going away forces one.
 */
function persist(force = false) {
  if (!run || run.field.result) return;
  if (!force && run.field.skirmishes.length) return;
  const gs = run.gs;
  if (!gs.field) gs.field = { board: [], rolledAt: 0 };
  gs.field.run = {
    id: run.id, party: run.party, loot: run.loot, zone: run.zone, started: run.started,
    // read after a resume: abandon() returns `trialPaid` while Field.contacted is false for the saved
    // field state, and debriefSquad pays class XP for `fights`; `encounters` are the fight blocks of
    // the report (keptFights), which settle() turns into the report and release() reads the causes
    // of death from. `contact` is the first-fight flag: saved, and checked by test/lifecycle.js, but not read here.
    // The cohesion bonus is not saved: resume() computes it again from `party` (Crew.cohesion)
    trialPaid: run.trialPaid, contact: run.contact, fights: run.fights,
    encounters: keptFights(run.encounters || []),
    state: F.save(run.field),
  };
  G().save();
}

function forget() {
  const gs = G().state;
  if (gs.field) delete gs.field.run;
}

/**
 * Drop the live run without settling it: no payout, no deaths, no trial result. For a caller that
 * is replacing the town state under the run (Reset), where settling would write into the state
 * being thrown away. The party's c.mission flags are left alone for the same reason.
 */
function discard() {
  stop();
  forget();
  run = null;
}

/** Pick up a run that was in progress when the page went away. */
function resume() {
  const gs = G().state;
  const saved = gs.field && gs.field.run;
  if (!saved || run) return false;
  const characters = Object.fromEntries(gs.characters.map(c => [c.id, c]));
  const s = F.restore(saved.state, {
    resolve, name: FieldView.namer, rate: rateFoe, characters,
    tactics: (run2) => Tactics.propose(run2, gs),
    grieve: (fallen, survivors) => Tactics.grieve(gs, fallen.char, survivors),
    sighted: (id, a) => noteSighting(id, a),
  });
  if (!s) { forget(); return false; }
  // The bonus comes from the party's pair records as they are now, which settle() has not yet changed.
  // A run saved before the bonus stopped being saved carries teamId, teamName and a `bonus`; they are dropped.
  const co = Crew.cohesion(gs, saved.party.map(id => characters[id]).filter(Boolean));
  const { teamId, teamName, ...kept } = saved;
  run = { ...kept, gs, mission: s.mission, field: s, bonus: co.bonus, cohesion: co };
  // fighters first: a throw here (boot discards the run) must not leave the party flagged as out
  for (const a of s.actors) if (a.combat || a.role === 'squad') fighterFor(a);
  FieldView.faces(s);
  // game.js frees anyone whose mission id it cannot find, so claim the party back
  for (const id of run.party) {
    const c = gs.characters.find(x => x.id === id);
    if (c) c.mission = run.id;
  }
  for (const a of s.actors) FieldView.rehydrate(a);
  if (!s.result) start();
  G().logLine(`${s.mission.icon} back to ${s.mission.name}, ${MT.realClock(s.clock * MT.TIME.scale)} in`);
  return true;
}

/**
 * Nothing has happened to the squad yet and the run has no result. Field.contacted is the one definition
 * of contact (a hostile has seen the squad, a fight has opened, or a member is down); abandon() and
 * exitState() both read it through here.
 */
const untouched = (r) => !r.field.result && !F.contacted(r.field);

/**
 * Clear c.mission and the launch meal (c.meal) on every party member that is still on the roster and retire the ones whose
 * actor is dead on the map, through the one death path (Roster.fallAll). settle() and abandon()
 * both end a run through this, so a death that has happened is applied the same way whether the
 * run finishes or is called off. A member already retired is not in gs.characters, so a second
 * call skips them. Returns the memorial records of the dead, and logs them. The memorial cause is
 * '<mission name>: <killer name>' from the fight block that recorded the fall (Bestiary.causeOf),
 * and the mission name alone when no block names a killer (a trap, conditions).
 */
function release(r) {
  const dead = [];
  for (const id of r.party) {
    const c = r.gs.characters.find(x => x.id === id);
    if (!c) continue;
    c.mission = null;
    Condition.clearMeal(c);
    const a = r.field.actors.find(x => x.char && x.char.id === id);
    if (a && !a.alive) dead.push(c);
  }
  const cause = (c) => (typeof Bestiary !== 'undefined' ? Bestiary.causeOf(r.gs, r, c.id, r.mission.name) : r.mission.name);
  const lost = Roster.fallAll(r.gs, dead, { cause, log: G().logLine });
  if (lost.length) G().logLine(`⚱️ ${lost.map(f => f.name).join(', ')} did not come back from ${r.mission.name}`);
  return lost;
}

/**
 * The squad's side of a run that has ended after the first fight: Missions.debrief for everybody
 * still on the roster (release() has retired the dead), with its lines written to the town log.
 * `won` false debriefs it as a lost mission. Each survivor's `low` is the lowest end-of-fight HP
 * fraction resolve() sampled for it, which Missions.debrief turns into a wound. Returns the
 * debrief; settle() applies its loot multiplier.
 */
function debriefSquad(r, won, fallen) {
  const survivors = [];
  for (const id of r.party) {
    const c = r.gs.characters.find(x => x.id === id);
    if (!c) continue;
    const a = r.field.actors.find(x => x.char && x.char.id === id);
    const f = a && a.fighter;
    survivors.push({ c, hp: f ? f.hp / f.maxHp : 1, casts: f && f.stats ? f.stats.casts : 0, low: a ? a.low : undefined });
  }
  const out = M.debrief(r.gs, { survivors, fallen, won, level: r.mission.level, fights: r.fights || 0, where: r.mission.name });
  for (const line of out.lines) G().logLine(line);
  return out;
}

/**
 * Call the run off: free the party, apply the deaths that are already on the map, drop the run.
 * The exit button reaches this through exitOrder() while the run is free of contact, and once a
 * withdrawal has run past Field.STRAGGLE. It is also exported as Sortie.abandon, which is the way
 * out of a run that never produces a result.
 */
function abandon() {
  if (!run) return;
  // combat.js decides a fight when it opens; field.js marks its dead !alive when the playback ends.
  // Ending the playback here means a member that fight killed is retired by release() below.
  F.flushSkirmishes(run.field);
  // A trial fee is returned only while the run is untouched. After the first contact the attempt
  // has happened, and the fee stays spent as it does when a trial is lost.
  const touched = !untouched(run);
  const refund = run.trialPaid && !touched ? run.trialPaid : null;
  if (refund) for (const [k, v] of Object.entries(refund)) run.gs[k] = (run.gs[k] || 0) + v;
  // The launch meals come back on the same terms as the fee: while the run is untouched. release() deletes c.meal.
  let meals = 0;
  if (!touched) for (const id of run.party) { const c = run.gs.characters.find(x => x.id === id); if (c && Condition.returnMeal(run.gs, c)) meals++; }
  const lost = release(run);
  // A call-off after the first fight costs the squad what a lost mission does. Before it nothing
  // has happened to them and there is nothing to debrief. There is no payout and no trial result.
  // A run that already has its result was debriefed by settle(). The call-off is kept as a report
  // and counted as a sortie not won; its kill drops are not paid, so the report lists no loot.
  let kept = null;
  if (touched && !run.field.result) {
    debriefSquad(run, false, lost.length);
    kept = keepReport(run, { won: false, why: 'called off', paid: {}, got: [], lost });
  }
  G().logLine(`↩️ ${run.mission.name} was called off${refund && Object.keys(refund).length ? ` · ${Econ.costText(refund)} returned` : ''}${meals ? ` · ${meals} meal${meals === 1 ? '' : 's'} returned to the pantry` : ''}`);
  stop();
  forget();
  run = null;
  if (kept) { openReport = kept.id; collapsed.reports = false; }
  G().save();
  render();
}

/**
 * What the exit button does for this run.
 *   free        untouched: no hostile has seen the squad, no fight has opened and nobody is down
 *               (Field.contacted is false): abandon() frees the party and returns a trial fee
 *   order       Field.retreat: the squad walks to the way out and the contract ends as a loss,
 *               settled by settle() like any other lost contract
 *   retreating  the squad is already withdrawing, by this order or its own decision
 *   stuck       withdrawing for longer than Field.STRAGGLE, which verdict() ends first except while
 *               a window contract's way home is shut; the button offers abandon()
 *   over        the run has its result, or there is no run
 */
function exitState(r = run) {
  if (!r) return 'over';
  const s = r.field;
  if (s.result) return 'over';
  if (untouched(r)) return 'free';
  if (!s.withdrew) return 'order';
  return s.clock - s.withdrew.at > F.STRAGGLE ? 'stuck' : 'retreating';
}

/**
 * The exit button's click. The state is read at the click, so a button drawn before a fight
 * opened cannot free a squad that is now in contact: it sends the retreat order instead.
 */
function exitOrder() {
  if (!run || run.field.result) return;
  const state = exitState(run);
  if (state === 'free' || state === 'stuck') { abandon(); return; }
  if (state !== 'order') return;
  F.retreat(run.field);
  persist();                              // between fights this stores the order; during one, the next save does
  renderSide();
}

// ---------- the clock ----------

function start() {
  stop();
  timer = setInterval(tick, Math.max(20, MT.TIME.stepMs / speed));
  lastReal = performance.now();
  if (!raf) raf = requestAnimationFrame(frame);
}
function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function tick() {
  if (!run || run.field.result) return;
  const s = run.field;
  const { events } = F.step(s);

  // out of a fight, everyone mends a little — unless the contract said no resupply
  if (!run.mission.twists.includes('dry')) {
    for (const a of s.actors) {
      if (!a.fighter || !a.alive || a.engaged) continue;
      a.fighter.hp = Math.min(a.fighter.maxHp, a.fighter.hp + a.fighter.maxHp * REGEN);
      for (const p of Object.values(a.fighter.pools)) p.cur = Math.min(p.max, p.cur + p.max * REGEN);
      a.hp = a.fighter.hp;
    }
  }
  for (const a of s.actors.filter(x => x.role === 'squad')) refaceIfChanged(a);
  acc = 0;
  lastReal = performance.now();          // the slide starts now, not at the last frame drawn
  if (!bulk && s.clock - (run.savedAt || 0) >= SAVE_EVERY && !s.skirmishes.length) {
    run.savedAt = s.clock;
    persist();
  }
  if (!bulk && events.length) appendLog(events);
  if (s.result) settle();
  if (!bulk) renderSide();
}

/**
 * A defence runs on past its own terms for as long as the squad is willing, and this is the
 * player overruling that: take what has been earned and go. The squad would have made the same
 * call eventually — when they got tired, or when the relief arrived — so this is not a cheat,
 * it is the one decision a contract about standing still actually offers.
 */
function fallBack() {
  if (!run || run.field.result) return;
  F.callBack(run.field);
  renderSide();
}

/** Stop watching and just be told: run the rest of it now. */
function skip() {
  if (!run || run.field.result) return;
  bulk = true;
  // re-read the deadline each step: a hardcore mission extends it when the job goes wrong
  // the clock is no longer the end of a mission, so the only bound here is a hang guard
  for (let i = 0; i < 40000 && !run.field.result; i++) tick();
  bulk = false;
  const box = el('#sortie-log');
  if (box) { box.innerHTML = ''; appendLog(run.field.log); }
  renderSide();
}

/** The rim carries the state: fine, hurt, down. */
function refaceIfChanged(a) {
  const frac = a.fighter ? a.fighter.hp / a.fighter.maxHp : 1;
  const want = !a.alive ? 'down' : frac < 0.4 ? 'hurt' : 'squad';
  if (a.ring === want) return;
  a.ring = want;
  FieldView.reface(a, Tokens.RINGS[want]);
}

// ---------- settling up ----------

// The pay for holding on. A defence opens its way home the moment the terms are met and the
// squad may step through at once; staying is a choice and this is what it buys. Both numbers
// come from MT.PORTAL, which is also what the contract prints on the board — the +60% on the
// card, the +37% on the button and the line in the log are one constant read three times, so
// they cannot drift apart. It is a multiplier on the contract rather than a flat sum: holding a
// level eighteen bridge three more minutes is not worth what a level one one is, and the cap is
// where field.js stops counting, so the top of the curve is reachable.
const overtimePay = (s) => {
  const cap = s.mission.duration * MT.PORTAL.overtime;
  return cap > 0 ? MT.PORTAL.pay * Math.min(1, (s.overtime || 0) / cap) : 0;
};

/** " (drops x1.35, Thief)" when a class in the squad raised the kill drops, else nothing. */
const lootNote = (r) => (r.lootMult > 1 ? ` (drops x${r.lootMult}${r.lootBy ? ', ' + r.lootBy : ''})` : '');

function settle() {
  const s = run.field, gs = run.gs, m = run.mission;
  const won = s.result.won;
  stop();

  const lost = release(run);
  // What the run did to the people who came back: class XP, stamina, caster pool, morale, bonds
  // (missions.js debrief, the same call the Gate makes). The bonds step adds this run to the run
  // count of every pair of survivors (1 for a win, 0.5 for a loss), which is the rapport that
  // Crew.cohesion reads for the next sortie. The dead are not in it: their pair records are deleted
  // by release(). Two people who walked the same map do not come home in the same mood, and the
  // difference is a temper (condition.js).
  const debrief = debriefSquad(run, won, lost.length);
  const lootMult = debrief.lootMult;

  const paid = {};
  if (won) {
    // A hardcore contract that went wrong and was escaped is still a contract nobody completed:
    // it pays for the bodies brought home, not for the job. The hardcore multiplier is already
    // in m.reward, so a blown escape lands near an ordinary mission rather than above one.
    const escaped = !!(s.escalated);
    // side work pays on what was finished, not on what was taken on
    const sideDone = (s.side || []).filter(j => j.done);
    const sideMult = sideDone.reduce((x, j) => x * (j.reward || 1), 1);
    // A defence pays for the ground and then for the time: every extra minute held past the
    // terms is a minute somebody chose to stand there, and it is the only thing a standfast
    // contract lets the player decide. See OVERTIME_PAY.
    const over = overtimePay(s);
    const worth = Math.round((25 + m.level * 30) * m.reward * sideMult * (1 + over) * (escaped ? 0.35 : 1));
    if (sideDone.length) G().logLine(`${sideDone.map(j => j.icon + ' ' + j.label).join(', ')} — paid on top`);
    if (over > 0) G().logLine(`⏱️ ${MT.realClock((s.overtime || 0) * MT.TIME.scale)} held past the terms — +${Math.round(over * 100)}% on the contract`);
    if (m.payout === 'resources') {
      const each = Math.max(1, Math.round(worth / 12));
      for (const k of ['crops', 'ore', 'herbs']) { gs[k] += each; paid[k] = each; }
      gs.gems += Math.round(worth * 0.25); paid.gems = Math.round(worth * 0.25);
    } else {
      gs.gems += worth; paid.gems = worth;
    }
    for (const b of m.bonus) {
      if (MT.FAIL_ATOMS.includes(b.atom) || !F.winMet(s, b)) continue;
      const extra = Math.round(worth * 0.2);
      gs.gems += extra;
      paid.gems = (paid.gems || 0) + extra;
    }
  }

  const q = Math.min(5, Math.floor(m.level / 4));
  // Gems and resources from kills are summed per kind and then multiplied by the class loot
  // multiplier, so a x1.05 is not rounded away drop by drop. The contract fee above is not.
  const drops = {}, items = {};
  for (const drop of run.loot) {
    if (drop.kind === 'gems') drops.gems = (drops.gems || 0) + drop.amount;
    else if (drop.kind === 'resource') drops[drop.key] = (drops[drop.key] || 0) + drop.amount;
    else if (drop.kind === 'equipment') {
      const it = Econ.craftItem('equipment', q, { stage: Math.min(22, m.level + 2) }, Rng.rand);
      G().addItem(it); G().logLine(`🎁 ${it.name} found at ${m.name}`);
      items.equipment = (items.equipment || 0) + 1;
    } else if (drop.kind === 'potion') {
      G().addItem(Econ.craftItem('potion', q, { stage: Math.min(22, m.level + 2) }, Rng.rand));
      items.potion = (items.potion || 0) + 1;
    }
  }
  let gems = 0;
  const got = [];                        // the loot as the report lists it: one row per kind
  for (const [k, v] of Object.entries(drops)) {
    const n = Math.round(v * lootMult);
    gs[k] += n;
    if (k === 'gems') gems = n;
    got.push(k === 'gems' ? { kind: 'gems', amount: n } : { kind: 'resource', key: k, amount: n });
  }
  for (const [kind, n] of Object.entries(items)) got.push({ kind, amount: n });
  // A trial passed is the tier-up: game.js raises the star, lifts the aptitudes and counts it,
  // and classes.js opens a fusion slot off that count. A trial failed is re-rolled as a
  // different pair of missions — the road stays open, it just is not the same road twice.
  if (m.trial) {
    const owner = gs.characters.find(x => x.id === m.trial.charId);
    if (owner && won) {
      const res = Quests.pass(gs, owner, G().advanceCharacter);
      if (res.ok && res.fusion) G().logLine(`🜂 ${owner.name} has a fusion slot open — add a second class at the training grounds`);
    } else if (owner) {
      Quests.fail(gs, owner);
      G().logLine(`⭐ ${owner.name} failed ${m.name}. The trial stays open, re-rolled as different missions.`);
    }
  }
  run.paid = paid; run.salvage = gems; run.lost = lost; run.lootMult = lootMult; run.lootBy = debrief.lootBy;
  keepReport(run, { won, why: s.result.why, paid, got, lost });
  forget();
  G().logLine(won
    ? `${m.icon} ${m.name} — ${s.result.why}${s.escalated ? ' (the job was lost)' : ''}. ${Econ.costText(paid)} + 💎 ${gems} loot${lootNote(run)}`
    : `${m.icon} ${m.name} — ${s.result.why}. 💎 ${gems} salvaged${lootNote(run)}`);
  // the board moves on: this one is spoken for either way
  gs.field.board = gs.field.board.filter(b => b.boardId !== m.boardId);
  G().save();
  G().renderAll();
}

// ---------- the screen ----------

// teamLeftOut: the recovering members loadTeam left out of the party. Their "back in N ticks" is worked out
// each time the teams box is drawn, so it falls with the wound and is gone when the wound is over.
let picked = [], activeTeam = null, pendingOverwrite = null, teamNote = '', teamLeftOut = [];
const setTeamNote = (text, leftOut = []) => { teamNote = text; teamLeftOut = leftOut; };
const el = (sel) => document.querySelector(sel);

function appendLog(lines) {
  const box = el('#sortie-log');
  if (!box) return;
  for (const l of lines) {
    const d = document.createElement('div');
    const mm = String(Math.floor(l.t / 60)).padStart(2, '0'), ss = String(l.t % 60).padStart(2, '0');
    d.innerHTML = `<span class="t">${mm}:${ss}</span> ${l.text.startsWith('  ') ? '<i>' + l.text + '</i>' : l.text}`;
    box.appendChild(d);
  }
  box.scrollTop = box.scrollHeight;
}

// ---------- filters ----------
//
// Every list on this tab grows with the roster, and one of them grows fastest: a trial card per
// character is 88 cards at 88 characters, which is five thousand pixels of scrolling before the
// contracts even start. So each long list gets the same two things — a row of selects that
// narrows it, and a cap on how many cards are drawn, with the rest behind one click. Filter
// state is module-level and survives a re-render; it is not saved, because a filter is a thing
// you are doing right now rather than a setting.
// How many cards a list draws before the rest goes behind a button. Fewer on a phone, where a
// card is the full width of the screen and twelve of them is a thousand pixels of thumb.
const showFirst = () => (typeof window !== 'undefined' && window.innerWidth <= 760) ? 6 : 12;
const FILTERS = {
  trials:    { star: 'all', pot: 'all', fav: 'all', tier: 'all', road: 'all', q: '', sort: 'star' },
  contracts: { type: 'all', level: 'all' },
  // No `party` row here: the party picker moved to the shared bar in filters.js, which keeps its own.
};
const showAll = { trials: false, contracts: false, party: false };
// a search box loses focus when the panel is rebuilt, so remember which one had it and where
let focused = null;
// Which boxes are folded away. The memorial starts folded: it is a wall to read, not a thing to
// act on, and at thirty dead it is the second tallest thing on the tab.
const collapsed = { trials: false, contracts: false, party: false, teams: false, memorial: true, reports: true };
let openReport = null;        // id of the report drawn in the Reports box; the newest when null or no longer kept

/**
 * Fold a box away behind its own heading. Everything under the h3 goes into one body element so
 * a click on the heading can hide the lot; the heading keeps its count, so a folded box still
 * says how much is in it.
 */
function collapsible(box, key) {
  const h = box.querySelector('h3');
  if (!h) return box;
  const body = document.createElement('div');
  while (h.nextSibling) body.appendChild(h.nextSibling);
  box.appendChild(body);
  body.hidden = !!collapsed[key];
  const mark = document.createElement('span');
  mark.className = 'caret';
  mark.textContent = collapsed[key] ? '▸' : '▾';
  h.prepend(mark, ' ');
  h.classList.add('fold');
  h.addEventListener('click', () => { collapsed[key] = !collapsed[key]; render(); });
  return box;
}

const matches = (text, q) => !q || String(text).toLowerCase().includes(q.toLowerCase());

/**
 * A row of controls over one list. `fields` are {key, label, options:[[value,label]...]} selects
 * or {key, kind:'search'}. Any change re-renders the panel, which is cheap (7ms at 88 characters)
 * and keeps every list consistent with the party box below it.
 */
function filterRow(section, fields, shown, total) {
  const row = document.createElement('div');
  row.className = 'filters';
  const state = FILTERS[section];
  for (const f of fields) {
    if (f.kind === 'search') {
      const input = document.createElement('input');
      input.type = 'search';
      input.placeholder = f.label || 'name';
      input.value = state[f.key];
      input.dataset.filter = `${section}.${f.key}`;
      input.addEventListener('input', () => {
        state[f.key] = input.value;
        focused = { id: input.dataset.filter, pos: input.selectionStart };
        render();
      });
      row.appendChild(input);
      continue;
    }
    const sel = document.createElement('select');
    sel.innerHTML = f.options.map(([v, l]) => `<option value="${v}" ${state[f.key] === v ? 'selected' : ''}>${l}</option>`).join('');
    sel.addEventListener('change', () => { state[f.key] = sel.value; showAll[section] = false; render(); });
    row.appendChild(sel);
  }
  const count = document.createElement('span');
  count.className = 'sub';
  count.textContent = shown === total ? `${total}` : `${shown} of ${total}`;
  row.appendChild(count);
  if (Object.entries(state).some(([k, v]) => v !== 'all' && v !== '' && k !== 'sort')) {
    const clear = document.createElement('button');
    clear.className = 'ghost';
    clear.textContent = 'Clear';
    clear.addEventListener('click', () => {
      for (const k of Object.keys(state)) if (k !== 'sort') state[k] = k === 'q' ? '' : 'all';
      showAll[section] = false; render();
    });
    row.appendChild(clear);
  }
  return row;
}

/** Draw at most showFirst() cards, with the rest behind a button. Keeps a selected card visible. */
function capped(section, items, keep) {
  const n = showFirst();
  if (showAll[section] || items.length <= n) return { list: items, hidden: 0 };
  const head = items.slice(0, n);
  // whatever is selected stays on screen even when it sorts below the cut
  for (const it of items.slice(n)) if (keep && keep(it) && !head.includes(it)) head.push(it);
  return { list: head, hidden: items.length - head.length };
}

function moreButton(section, hidden) {
  const b = document.createElement('button');
  b.className = 'ghost';
  b.style.marginTop = '8px';
  b.textContent = `Show ${hidden} more`;
  b.addEventListener('click', () => { showAll[section] = true; render(); });
  return b;
}

/** Put the caret back in the search box the rebuild took it out of. */
function restoreFocus() {
  if (!focused) return;
  const el = document.querySelector(`[data-filter="${focused.id}"]`);
  if (el) { el.focus(); try { el.setSelectionRange(focused.pos, focused.pos); } catch (e) { /* not a text input */ } }
  focused = null;
}

/**
 * The trials box. One entry per character with a star in front of them, each offering the two
 * roads side by side — the choice is meant to be made on what the missions actually ask for, so
 * both are shown in full rather than rolled when you commit.
 */
function trialBox(gs, trials) {
  const box = document.createElement('div');
  box.className = 'jobbox';
  box.innerHTML = `<h3>⭐ Advancement trials</h3><div class="sub">One star per trial, for one named character. Each is offered two ways — alone or with a party — as different missions with different objectives. The 3rd and 6th tier-up each open a class fusion slot, counted per character: a 1★ taken to 7★ passes six trials and ends with three classes, a 5★ pulled from the gate passes two and ends with one.</div>`;
  const byChar = new Map();
  for (const m of trials) {
    if (!byChar.has(m.trial.charId)) byChar.set(m.trial.charId, []);
    byChar.get(m.trial.charId).push(m);
  }

  // one entry per character, then narrowed and capped: at a full roster this list is the whole
  // reason the tab was unreadable
  let entries = [...byChar.entries()]
    .map(([charId, roads]) => ({ charId, roads, c: gs.characters.find(x => x.id === charId) }))
    .filter(e => e.c)
    .map(e => ({ ...e, spec: Quests.describe(e.c), ready: Quests.ready(gs, e.c).ok }));
  const total = entries.length;
  const f = FILTERS.trials;
  if (f.star !== 'all') entries = entries.filter(e => String(e.c.stats.stars) === f.star);
  if (f.tier !== 'all') entries = entries.filter(e => f.tier === 'fusion' ? e.spec.fusion : String(e.spec.tierUps + 1) === f.tier);
  if (f.road === 'ready') entries = entries.filter(e => e.ready);
  // The two questions this box shares with every other list of people, answered by filters.js so
  // they cannot come to mean something else here than they do on the roster.
  entries = entries.filter(e => Filters.test(e.c, { pot: f.pot, fav: f.fav }));
  if (f.q) entries = entries.filter(e => matches(e.c.name, f.q) || matches(e.spec.name, f.q));
  const SORTS = {
    star: (a, b) => b.c.stats.stars - a.c.stats.stars || a.c.name.localeCompare(b.c.name),
    tier: (a, b) => b.spec.tierUps - a.spec.tierUps || a.c.name.localeCompare(b.c.name),
    name: (a, b) => a.c.name.localeCompare(b.c.name),
  };
  entries.sort(SORTS[f.sort] || SORTS.star);

  const stars = [...new Set([...byChar.keys()].map(id => (gs.characters.find(x => x.id === id) || {}).stats).filter(Boolean).map(s2 => s2.stars))].sort();
  // Options come off everybody who has a trial waiting, not off what the filter has already left:
  // building them from the filtered set would delete the option you just used the moment it bit.
  const chars = [...byChar.keys()].map(id => gs.characters.find(x => x.id === id)).filter(Boolean);
  const favOpts = Filters.favOptions(chars);
  box.appendChild(filterRow('trials', [
    { key: 'star', options: [['all', 'any star'], ...stars.map(n => [String(n), `${n}★`])] },
    { key: 'pot', options: Filters.potOptions(chars) },
    ...(favOpts ? [{ key: 'fav', options: favOpts }] : []),
    { key: 'tier', options: [['all', 'any tier-up'], ['fusion', 'opens a fusion slot'], ...[1, 2, 3, 4, 5, 6].map(n => [String(n), `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'} tier-up`])] },
    { key: 'road', options: [['all', 'affordable or not'], ['ready', 'can be attempted now']] },
    { key: 'sort', options: [['star', 'by star'], ['tier', 'by tier-up'], ['name', 'by name']] },
    { key: 'q', kind: 'search', label: 'name' },
  ], entries.length, total));

  const cut = capped('trials', entries, (e) => e.roads.some(m => m.boardId === selected));
  const grid = document.createElement('div');
  grid.className = 'grid';
  for (const { charId, roads, c, spec, ready } of cut.list) {
    const gate = Quests.ready(gs, c);
    const card = document.createElement('div');
    card.className = 'bcard';
    card.innerHTML = `<div><b>⭐ ${spec.name}</b></div>
      <div class="sub">${Filters.rareMark(c)}${c.name} ${Filters.badge(c)} · ${c.stats.stars}★ → ${spec.star}★ · level ${spec.level} · their ${spec.tierUps + 1}${['th','st','nd','rd'][(spec.tierUps + 1) % 10] || 'th'} tier-up${spec.fusion ? ' · <span class="tag">opens a fusion slot</span>' : ''}</div>
      <div class="sub">${spec.blurb}</div>
      <div class="sub">Costs ${Econ.costText(spec.items)}${gate.ok ? '' : ` · <span class="warn">${gate.why}</span>`}</div>`;
    for (const m of roads) {
      const b = document.createElement('button');
      b.className = m.boardId === selected ? '' : 'ghost';
      b.style.marginTop = '6px';
      b.style.marginRight = '6px';
      b.textContent = m.trial.road === 'solo' ? '🗡️ Alone' : '👥 With a party';
      b.title = `${m.icon} ${m.label} — ${m.win.map(MT.objectiveText).join(' + ')}`;
      b.disabled = !gate.ok;
      b.addEventListener('click', () => { selected = m.boardId; picked = picked.includes(charId) ? picked : [charId]; render(); });
      card.appendChild(b);
    }
    const chosen = roads.find(m => m.boardId === selected);
    if (chosen) {
      const d = document.createElement('div');
      d.className = 'sub';
      d.innerHTML = `<b>${chosen.icon} ${chosen.label}</b> · ${chosen.win.map(MT.objectiveText).join(' + ')} · ${chosen.party[0]}–${chosen.party[1]} characters`;
      card.appendChild(d);
    }
    grid.appendChild(card);
  }
  box.appendChild(grid);
  if (!entries.length) grid.innerHTML = '<p class="empty">No trial matches that.</p>';
  if (cut.hidden) box.appendChild(moreButton('trials', cut.hidden));
  return box;
}

function missionCard(m, selectable) {
  const d = MT.describe(m);
  // one line of the brief on the card itself, so the board can be read without opening each one
  const rows = briefRows(G().state, m);
  d.expect = rows.length ? rows.map(r => `${r.icon} ${r.name} ${r.levelText} ${r.countText}`).join(' · ') : 'nothing on the paper';
  const seen = ((G().state.field || {}).types || {})[m.type];
  d.record = seen && seen.sent > 0
    ? `<div class="sub" title="Contracts of this type that went out from the town, how many met their win terms and how many did not. Characters who died on this type: ${seen.dead || 0}.">your record: ${seen.sent} sent, ${seen.won} won, ${seen.sent - seen.won} lost</div>`
    : '';
  const div = document.createElement('div');
  div.className = 'bcard mcard';
  div.innerHTML = `
    <div><b>${m.icon} ${m.name}</b></div>
    <div class="sub">${m.label} · level ${m.level} · ${d.party} · ${m.deadline ? `${d.watch} on the clock` : `about ${d.watch} to watch, no clock`}</div>
    <div class="sub">${m.blurb}</div>
    <div class="sub">${d.expect}</div>
    <div class="sub">${m.win.map(MT.objectiveText).join(' + ')}</div>
    <div class="sub" style="color:#7fd8b0">\u{1F300} ${d.exit}</div>
    <div class="sub">${(m.side || []).map(j => `<span class="tag" title="${j.desc}">${j.icon} ${j.label}</span>`).join(' ')}</div>
    <div class="sub">${m.twists.map(t => `<span class="tag" title="${MT.TWISTS[t].desc}">${MT.TWISTS[t].label}</span>`).join(' ')}
      <span class="tag">×${m.reward} ${m.payout}</span></div>${d.record}`;
  if (selectable) div.addEventListener('click', () => { selected = m.boardId; confirming = null; render(); });
  return div;
}

let selected = null;
let confirming = null;      // the contract whose brief is open, so a redraw keeps it open
let confirmScrolled = null; // ...and which one we have already put on screen, since the board redraws

/** Cohesion as a percentage with one decimal, the figure every cohesion text prints. */
const cohPct = (v) => `+${(v * 100).toFixed(1)}%`;

/**
 * The arithmetic behind a cohesion reading (Crew.cohesion), for a tooltip: the product, then each term
 * and the figures it was computed from. Every number in it is one the reading holds.
 */
function cohesionTitle(co) {
  const pairs = `${co.pairs} pair${co.pairs === 1 ? '' : 's'}`;
  return `Cohesion ${cohPct(co.bonus)} = ${Math.round(Crew.MAX_BONUS * 100)}% x rapport ${co.rapport.toFixed(2)} x (0.4 + 0.6 x skill ${co.skill.toFixed(2)}) x accord ${co.accord.toFixed(2)}. ` +
    `Rapport = 1 - exp(-${co.runs.toFixed(1)} / ${Crew.RAPPORT_RUNS}); ${co.runs.toFixed(1)} is the mean over ${pairs} of the missions each pair has walked out together (a lost mission counts 0.5, a pair that has never gone out counts 0). ` +
    `Skill is the party's mean teamwork / 20 (CHA x 0.7 + WIS x 0.3 from the sheet, times the class factor and a social trait the sheet does not name). ` +
    `Accord is what the pairs are to each other, or temperament for pairs that have not met. The bonus multiplies damage and magic damage, and armour at half the size.`;
}

/** The launch log line: the bonus on each stat, the mean pair runs it comes from, and the accord when it is off 1. */
const cohesionLine = (co) =>
  `\u{1F91D} cohesion ${cohPct(co.bonus)} damage and magic damage, ${cohPct(co.bonus / 2)} armour; pairs average ${co.runs.toFixed(1)} runs together` +
  (Math.abs(co.accord - 1) > 0.03 ? `, accord x${co.accord.toFixed(2)} (${co.accord < 1 ? 'they do not want the same things' : 'they want the same things'})` : '');

/** The party picker's reading of the people picked so far: the bonus and the terms it is the product of. */
function cohesionSummary(party) {
  const co = Crew.cohesion(G().state, party);
  const text = party.length < 2
    ? `\u{1F91D} Cohesion +0.0%: it is computed over pairs, and ${party.length === 1 ? 'one person has none' : 'nobody is picked'}`
    : `\u{1F91D} Cohesion <b>${cohPct(co.bonus)}</b> damage, ${cohPct(co.bonus / 2)} armour: rapport ${co.rapport.toFixed(2)} (${co.runs.toFixed(1)} runs per pair), skill ${co.skill.toFixed(2)}, accord ${co.accord.toFixed(2)}`;
  return `<div class="sub" title="${cohesionTitle(co)}">${text}</div>`;
}

const wholePct = (v) => `${Math.round(v * 100)}%`;

/**
 * Where a party leaves a fight and the map: Field.hatchLines (inside a fight) and Field.brokenLines
 * (on the map) for its temper (Temper.will, or the `will` already built) and the mean of its members'
 * starting resolve (Condition.resolveSeed). launch() prints these lines in the sortie log and the
 * party picker prints them before the squad is sent, so a threshold in the log is one the picker showed.
 */
function willLines(party, will = Temper.will(party)) {
  const seeds = party.map(c => Condition.explainSeed(c));
  const resolve = seeds.length ? seeds.reduce((t, x) => t + x.seed, 0) / seeds.length : 0;
  return { will, resolve, seeds, fight: F.hatchLines(will, resolve), map: F.brokenLines(will, resolve) };
}

/** The launch log's statement of willLines. */
const willLine = (w) => `squad leaves a fight under ${wholePct(w.fight.avg)} average HP (under ${wholePct(w.fight.down)} once somebody is dead in it) and leaves the map under ${wholePct(w.map.hp)} average HP`;

/** The party picker's reading of the people picked so far: how they are read (Temper.readParty) and the lines willLines gives them. */
function willSummary(party) {
  const w = willLines(party), feel = Temper.readParty(party);
  const seeds = party.map((c, i) => `${c.name} ${w.seeds[i].seed.toFixed(2)}`).join(', ');
  const tip = `${F.explainLines(w.will, w.resolve)} Resolve ${w.resolve.toFixed(2)} is the mean of the party's starting resolve from morale and stamina (condition.js): ${seeds}.`;
  return `<div class="sub" title="${tip.replace(/"/g, '&quot;')}">\u{1F9E0} <b>${feel.word}</b> squad: ${feel.note}. Leaves a fight below <b>${wholePct(w.fight.avg)}</b> average HP, between fights below ${wholePct(w.map.hp)}` +
    `${w.resolve < 0 ? ` (starting resolve ${w.resolve.toFixed(2)})` : ''}</div>`;
}

/**
 * The party picker's reading of the pantry: how many meals it holds and what each person picked would
 * eat at launch (Condition.mealPlan, the draw launch() makes). The tooltip has the arithmetic of each meal.
 */
function mealSummary(party) {
  const gs = G().state, plan = Condition.mealPlan(gs, party);
  const stock = Object.values(gs.inventory || {}).filter(i => i.kind === 'meal').reduce((n, i) => n + (i.count || 0), 0);
  const tip = plan.filter(r => r.meal).map(r => `${r.c.name}: ${r.meal.name}, ${Econ.mealWhy(r.meal)}`).join('. ') ||
    'A meal adds its points to the person who eats it for one mission, in fights only.';
  const text = stock
    ? `Pantry: ${stock} meal${stock === 1 ? '' : 's'}. Each eats one at launch, best first: ${Condition.mealLine(plan)}`
    : 'Pantry: no meals. Nobody eats before setting out';
  return `<div class="sub" title="${tip.replace(/"/g, '&quot;')}">\u{1F372} ${text}</div>`;
}

/** Teams: load one into the party, update it, or start a new one. */
function renderTeams(host) {
  const gs = G().state;
  const teams = Crew.ensure(gs);
  const box = document.createElement('div');
  box.className = 'jobbox';
  box.innerHTML = '<h3>\u{1F91D} Teams</h3><div class="sub">A team is a saved list of people and keeps no record of its own. The bonus on a card is cohesion computed for its members who are still on the roster: the mean number of missions each pair of them has walked out together, their teamwork and their accord. A sortie gets the same calculation for whoever is sent, team or not.</div>';

  const row = document.createElement('div');
  row.className = 'grid';
  for (const t of teams) {
    const co = Crew.cohesion(gs, t);
    const card = document.createElement('div');
    card.className = 'bcard mcard' + (activeTeam === t.id ? ' sel' : '');
    card.style.width = '190px';
    const names = Crew.membersOf(gs, t).map(c => c.name).join(', ') || 'nobody left';
    card.innerHTML = `<div><b>${t.name}</b></div><div class="sub">${names}</div>` +
      `<div class="sub" title="${cohesionTitle(co)}"><span class="tag">${cohPct(co.bonus)}</span> \u00b7 ${co.runs.toFixed(1)} runs per pair</div>`;
    card.addEventListener('click', () => loadTeam(t));
    row.appendChild(card);
  }
  if (!teams.length) row.innerHTML = '<p class="empty">No teams yet \u2014 pick a party below and name it.</p>';
  box.appendChild(row);

  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;align-items:center';
  const nameIn = document.createElement('input');
  nameIn.placeholder = 'new team name';
  nameIn.style.cssText = 'padding:5px;background:#1b1b22;color:#ddd;border:1px solid #444;border-radius:6px;font-size:12px';
  const saveNew = document.createElement('button');
  saveNew.className = 'ghost';
  saveNew.textContent = 'Save selection as a team';
  saveNew.disabled = !picked.length;
  saveNew.addEventListener('click', () => {
    const t = Crew.create(gs, nameIn.value.trim(), picked);
    activeTeam = t.id;
    setTeamNote(t.name + ' formed');
    G().save();
    render();
  });
  bar.append(nameIn, saveNew);

  const team = activeTeam ? Crew.find(gs, activeTeam) : null;
  if (team) {
    const changed = team.members.length !== picked.length || team.members.some(id => !picked.includes(id));
    if (changed) {
      const upd = document.createElement('button');
      upd.textContent = pendingOverwrite === team.id ? 'Press again to overwrite ' + team.name : 'Update ' + team.name;
      if (pendingOverwrite === team.id) upd.className = 'danger';
      upd.addEventListener('click', () => {
        const res = Crew.change(gs, team, picked, { confirm: pendingOverwrite === team.id });
        if (res.needsConfirm) {
          pendingOverwrite = team.id;
          setTeamNote('That drops ' + res.removed.length + ' who could still go. Press again to overwrite.');
        } else {
          pendingOverwrite = null;
          setTeamNote(team.name + ' updated');
        }
        G().save();
        render();
      });
      bar.appendChild(upd);
    }
    const dis = document.createElement('button');
    dis.className = 'ghost';
    dis.textContent = 'Disband';
    dis.addEventListener('click', () => { Crew.remove(gs, team.id); activeTeam = null; G().save(); render(); });
    bar.appendChild(dis);
  }
  box.appendChild(bar);
  const leftOut = teamLeftOut.map(id => gs.characters.find(c => c.id === id)).filter(c => c && c.injured > 0);
  const note = [teamNote, leftOut.length
    ? `${leftOut.map(c => c.name).join(', ')} recovering, back in ${Condition.tickText(Math.max(...leftOut.map(c => Condition.wounded(gs, c).ticks)))}, not loaded` : ''].filter(Boolean).join(' · ');
  if (note) {
    const n = document.createElement('div');
    n.className = 'sub';
    n.textContent = note;
    box.appendChild(n);
  }
  host.appendChild(collapsible(box, 'teams'));
}

/**
 * Load a team into the party. Anyone who died is dropped from the team then and there without
 * asking: the player did not choose that, and making them confirm it would be asking them to
 * sign off on a funeral.
 */
function loadTeam(t) {
  const gs = G().state;
  const gone = t.members.filter(id => Crew.isFallen(gs, id));
  if (gone.length) {
    const names = gone.map(id => {
      const f = ((gs.roster && gs.roster.fallen) || []).find(x => x.id === id);
      return f ? f.name : 'someone';
    });
    Crew.change(gs, t, t.members.filter(id => !gone.includes(id)));
    G().logLine('\u{1F91D} ' + t.name + ' reformed without ' + names.join(', '));
    setTeamNote(t.name + ' lost ' + names.join(', ') + ' \u2014 the team was updated for you');
  } else {
    setTeamNote('');
  }
  activeTeam = t.id;
  pendingOverwrite = null;
  const free = new Set(gs.characters.filter(c => !c.mission && !(c.injured > 0)).map(c => c.id));
  picked = t.members.filter(id => free.has(id));
  // a member who is recovering is left out of the party; the teams box says so, with the time until the
  // whole team can go (renderTeams works the ticks out when it draws, from the same reading as every screen)
  teamLeftOut = gs.characters.filter(c => t.members.includes(c.id) && c.injured > 0).map(c => c.id);
  G().save();
  render();
}

// ---------- the brief ----------
//
// The last thing between picking a contract and losing people on it. It is deliberately NOT a
// difficulty rating: it is the paper the client wrote, read against what the town has actually
// learned, and every row points at one or the other. Where a row is vague it says WHY it is
// vague — nobody had been, or nobody has ever killed one of these — so an unreadable brief is a
// thing the player can go and fix rather than a thing the game is withholding.

const INTEL_WORD = ['Nobody has been', 'A count and no names', 'Described, roughly counted', 'Described and counted'];

/** What level a cast group is actually fielded at, so the brief and the map agree. */
const castLevel = (mission, g) => Math.max(1, mission.level + (GRADE_BUMP[g.grade] || 0) + (g.levelOffset || 0));

function briefRows(gs, mission) {
  if (typeof Bestiary === 'undefined' || !Bestiary.brief) return [];
  return Bestiary.brief(gs, mission, { Missions: M, Combat: C, levelOf: (g) => castLevel(mission, g) });
}

/** The panel: what is expected, and the two ways out of it. */
function briefBox(gs, mission, onGo, onCancel) {
  const box = document.createElement('div');
  box.className = 'jobbox';
  box.style.cssText = 'background:#2a2a36;border:1px solid #4a4a5a';
  const rows = briefRows(gs, mission);
  const ground = MT.MAPS[mission.map.archetype];
  box.innerHTML = `<h3>${mission.icon} ${mission.name}</h3>` +
    `<div class="sub">${mission.label} · level ${mission.level} · ${ground ? ground.label.toLowerCase() : mission.map.label} · ` +
    `<span class="tag">${INTEL_WORD[Math.max(0, Math.min(3, mission.intel === undefined ? 1 : mission.intel))]}</span></div>` +
    `<div class="sub" style="margin-top:8px">Expected on the ground</div>`;
  const list = document.createElement('div');
  list.style.cssText = 'margin:6px 0 2px';
  for (const r of rows) {
    const line = document.createElement('div');
    line.style.cssText = 'display:flex;gap:8px;align-items:baseline;padding:3px 0;border-top:1px solid #33333f';
    const swarm = r.horde ? ` <span class="tag">${MT.hordeWord(r.horde)}</span>` : '';
    const per = r.per ? ` <span class="sub" style="display:inline">per ${r.per}</span>` : '';
    line.innerHTML =
      `<span style="min-width:1.4em">${r.icon}</span>` +
      `<b style="min-width:9em">${r.name}</b>` +
      `<span class="sub" style="margin:0;min-width:4.5em">${r.levelText}</span>` +
      `<b style="min-width:4em">${r.countText}</b>${swarm}${per}` +
      `<span class="sub" style="margin:0 0 0 auto;text-align:right" title="${r.hint}">${r.known}${r.hp ? ` · ~${r.hp}hp` : ''}${r.weak.length ? ` · weak to ${r.weak.map(w => w[0]).join(', ')}` : ''}</span>`;
    list.appendChild(line);
  }
  if (!rows.length) list.innerHTML = '<p class="empty">The paper says nothing at all.</p>';
  box.appendChild(list);

  // The one number on here that is not about them. It is what the GROUND allows, and it is the
  // difference between a swarm you fight four at a time and one you fight thirty at a time.
  const tide = rows.reduce((n, r) => Math.max(n, r.horde || 0), 0);
  if (tide) {
    const note = document.createElement('div');
    note.className = 'sub warn';
    note.textContent = `They come in numbers. How many can reach the squad at once is set by where the fight opens — close ground and doorways cut it, open ground does not.`;
    box.appendChild(note);
  }

  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:8px;margin-top:10px;align-items:center';
  const go = document.createElement('button');
  go.textContent = 'Set out';
  go.addEventListener('click', onGo);
  const no = document.createElement('button');
  no.className = 'ghost';
  no.textContent = 'Not yet';
  no.addEventListener('click', onCancel);
  bar.append(go, no);
  box.appendChild(bar);
  return box;
}

/**
 * What a party card says about how fit a character is to go out: the stamina band, the morale band
 * and value, the caster pool, the resolve the character would start a map with when it is under 0
 * (condition.js resolveSeed, with its arithmetic in the tooltip), the wound if there is one
 * (condition.js wounded, the figure every screen prints), and the
 * resting ticks until stamina and the pool are back to the rested line with the one that sets it
 * (condition.js readyAt, at this character's bed and with the pantry as it is). A unit that adds
 * to what the picker shows (wounds, meals, ...) adds its text here.
 * `party` is the characters picked so far, passed when this card's button can act: the card then says
 * what the party's cohesion becomes if this character is sent (not picked) or kept home (picked). It is
 * left out for a card that cannot be sent, and nothing is said when the party is and stays under two.
 */
function partyFacts(c, party = null) {
  const gs = G().state;
  const d = Condition.describe(c);
  const ready = Condition.readyAt(gs, c);
  const wound = Condition.wounded(gs, c);
  const seed = Condition.explainSeed(c);
  const bits = [`stamina ${d.stamina.band.label}`, `morale ${d.morale.band.label} ${Math.round(d.morale.cur)}`];
  if (d.pool) bits.push(`${d.pool.kind} ${Math.round(d.pool.frac * 100)}%`);
  if (seed.seed < 0) bits.push(`resolve ${seed.seed.toFixed(2)}`);
  let cohesion = '';
  if (party) {
    const going = party.some(p => p.id === c.id);
    const after = going ? party.filter(p => p.id !== c.id) : [...party, c];
    if (Math.max(party.length, after.length) >= 2) {
      const now = Crew.cohesion(gs, party), next = Crew.cohesion(gs, after);
      const tip = `${going ? 'Without' : 'With'} this character: ${cohesionTitle(next)}`;
      cohesion = `<div class="sub" title="${tip}">🤝 cohesion ${cohPct(now.bonus)} → ${cohPct(next.bonus)} ${going ? 'if kept home' : 'if sent'}</div>`;
    }
  }
  let title = `Resting ticks (10 s each) until stamina and the caster pool are both at ${Math.round(Condition.RESTED * 100)}% of maximum. Rest rate ${Condition.restText(ready.at)}. ${seed.why}`;
  if (wound) {
    // the two limits side by side: the injury keeps the character off the roster, the stamina and pool debt only changes how the fight opens
    bits.push(wound.text);
    title += ` ${wound.why}`;
  }
  bits.push(Condition.readyText(ready));
  return `<div class="sub" title="${title.replace(/"/g, '&quot;')}">${bits.join(' · ')}</div>${cohesion}`;
}

function renderBoard(host) {
  const gs = G().state;
  const contracts = board(gs);
  const trials = trialBoard(gs);
  const list = [...trials, ...contracts];
  const wrap = document.createElement('div');
  wrap.className = 'jobbox';
  wrap.innerHTML = `<h3>🗺️ Contracts</h3><div class="sub">Missions play out live on a map: pick one, send a party, and watch. A run in progress is saved and resumes after a reload. Call it off is free until a hostile has seen the squad, a fight opens or a squad member falls; after that the squad can be ordered to retreat, which ends the contract as a loss unless its terms are met first.</div>` +
    `<div class="sub">The town is being offered level ${townLevel(gs)} work — clear zones through the gate and better contracts turn up.</div>`;
  const cf = FILTERS.contracts;
  let shown = contracts.slice();
  if (cf.type !== 'all') shown = shown.filter(m => m.type === cf.type);
  if (cf.level !== 'all') {
    const [lo, hi] = cf.level.split('-').map(Number);
    shown = shown.filter(m => m.level >= lo && m.level <= hi);
  }
  const types = [...new Set(contracts.map(m => m.type))].sort();
  wrap.appendChild(filterRow('contracts', [
    { key: 'type', options: [['all', 'any type'], ...types.map(t => [t, `${MT.TYPES[t].icon} ${MT.TYPES[t].label}`])] },
    { key: 'level', options: [['all', 'any level'], ['1-5', 'level 1-5'], ['6-10', 'level 6-10'], ['11-15', 'level 11-15'], ['16-99', 'level 16+']] },
  ], shown.length, contracts.length));
  const grid = document.createElement('div');
  grid.className = 'grid';
  for (const m of shown) {
    const card = missionCard(m, true);
    if (m.boardId === selected) card.classList.add('sel');
    grid.appendChild(card);
  }
  if (!shown.length) grid.innerHTML = '<p class="empty">Nothing on the board matches that.</p>';
  wrap.appendChild(grid);
  const reroll = document.createElement('button');
  reroll.className = 'ghost';
  reroll.textContent = 'Ask around for other work';
  reroll.style.marginTop = '8px';
  reroll.addEventListener('click', () => { board(gs, true); selected = null; render(); });
  wrap.appendChild(reroll);
  if (trials.length) host.appendChild(collapsible(trialBox(gs, trials), 'trials'));
  host.appendChild(collapsible(wrap, 'contracts'));

  const m = list.find(x => x.boardId === selected);
  const pbox = document.createElement('div');
  pbox.className = 'jobbox';
  // `listed` is everyone at home; `avail` is the part of it that can be sent. A recovering character
  // is listed (greyed, after the others) so the picker shows who is back when.
  const listed = gs.characters.filter(c => !c.mission);
  const avail = listed.filter(c => !(c.injured > 0));
  picked = picked.filter(id => avail.some(c => c.id === id));
  const party = picked.map(id => avail.find(c => c.id === id)).filter(Boolean);
  const scout = party.length ? AI.bestScout(party) : 0;
  const st = AI.scoutTier(scout);
  const recovering = listed.length - avail.length;
  const hurtNow = listed.filter(c => c.injured > 0).map(c => ({ c, w: Condition.wounded(gs, c) }));
  const firstBack = recovering ? Math.min(...hurtNow.map(h => h.w.ticks)) : 0;
  pbox.innerHTML = `<h3>👥 Party <span class="sub">${picked.length}${m ? ' / ' + m.party[1] : ''}</span></h3>` +
    (m ? '' : '<div class="sub">Pick a contract first.</div>') +
    (party.length ? `<div class="sub">🧭 Scouting ${scout} — <b>${st.label}</b>, ${st.desc}. Only the best scout in the party counts.</div>` : '') +
    (party.length ? cohesionSummary(party) : '') +
    (party.length ? willSummary(party) : '') +
    (party.length ? mealSummary(party) : '') +
    (recovering ? `<div class="sub" title="${hurtNow.map(h => `${h.c.name}: back in ${Condition.tickText(h.w.ticks)}`).join('; ').replace(/"/g, '&quot;')}. Each is the wound ticks left divided by the healing rate of that character's bed and the pantry (10 s per tick).">${recovering} recovering, first back in ${Condition.tickText(firstBack)}</div>` : '');
  // The party picker uses the shared bar (filters.js), not the local filterRow above it: this is the
  // same crowd the roster, the training grounds and the altar are cutting down, and the gate is the
  // screen where cutting it down wrong costs somebody. Everything the other three learned comes
  // with it, including the two the board could never offer on its own — potential, and the people
  // the player has marked as theirs, which is exactly the list you want in front of you when
  // choosing who walks through.
  //
  // The local filterRow stays where it is, for the trials and the contracts. Those are not people.
  const pool = Filters.apply('party', listed, 'star', (c) => picked.includes(c.id));
  pool.sort((a, b) => (a.injured > 0) - (b.injured > 0));    // stable: the order Filters chose holds within each group
  pbox.appendChild(Filters.bar('party', listed, pool.length, render));

  const row = document.createElement('div');
  row.className = 'workers';
  const pcut = capped('party', pool, (c) => picked.includes(c.id));
  for (const c of pcut.list) {
    const hurt = c.injured > 0;
    const blocked = hurt || !m || (!picked.includes(c.id) && picked.length >= m.party[1]);
    const card = document.createElement('div');
    card.className = 'card' + (picked.includes(c.id) ? ' sel' : '');
    if (hurt) card.style.opacity = '0.55';
    const rd = Roster.describeRecord(c.record);
    card.innerHTML = `<div class="name">${Filters.rareMark(c)}${c.name}</div>` +
      `<div class="sub">${c.stats.stars}★ ${c.race} ${Filters.badge(c)}</div>` +
      `<div class="sub" title="Scouting: how well this one reads ground nobody has walked. ${AI.PERFECT_SCOUT}+ and the party needs to find nothing — they walk in knowing the way.">🧭 ${AI.scouting(c)}</div>` +
      (rd ? `<div class="sub" title="${rd.title.replace(/"/g, '&quot;')}">${rd.brief}</div>` : '') +
      partyFacts(c, blocked ? null : party);
    const b = document.createElement('button');
    b.textContent = hurt ? 'Recovering' : picked.includes(c.id) ? 'Stay' : 'Send';
    b.disabled = blocked;
    b.addEventListener('click', () => {
      picked = picked.includes(c.id) ? picked.filter(x => x !== c.id) : [...picked, c.id];
      render();
    });
    card.appendChild(b);
    card.appendChild(Filters.heart(c, () => { G().save(); render(); }));
    row.appendChild(card);
  }
  if (!listed.length) row.innerHTML = '<p class="empty">Nobody free.</p>';
  else if (!pool.length) row.innerHTML = '<p class="empty">Nobody free matches that.</p>';
  pbox.appendChild(row);
  if (pcut.hidden) pbox.appendChild(moreButton('party', pcut.hidden));

  const go = document.createElement('button');
  go.textContent = m ? `Set out for ${m.name}` : 'Pick a contract';
  go.disabled = !m || picked.length < (m ? m.party[0] : 1);
  go.style.marginTop = '10px';
  const problem = document.createElement('div');
  problem.className = 'sub warn';
  const send = () => {
    const r = launch(m, picked);
    if (typeof r === 'string') { problem.textContent = r; confirming = null; confirmScrolled = null; render(); return; }
    picked = []; selected = null; confirming = null; confirmScrolled = null;
    render();
  };
  // Nobody walks through the gate on one click. The brief is the last look at what the paper says
  // and what the town knows about it, which for a permadeath run is the difference between a
  // decision and an accident.
  if (m && confirming === m.boardId) {
    const brief = briefBox(gs, m, send, () => { confirming = null; confirmScrolled = null; render(); });
    pbox.appendChild(brief);
    // once, after it is attached: the board redraws on a timer, and a frame callback never fires
    // on a hidden tab
    if (confirmScrolled !== m.boardId) { confirmScrolled = m.boardId; setTimeout(() => brief.scrollIntoView({ block: 'nearest' }), 0); }
  } else {
    go.addEventListener('click', () => { confirming = m.boardId; confirmScrolled = null; render(); });
    pbox.appendChild(go);
  }
  pbox.appendChild(problem);
  const note = document.createElement('div');
  note.className = 'sub';
  note.textContent = m ? `${m.party[0]}–${m.party[1]} characters. Each plans its own spells, workings and technique loop when it leaves, against what is actually on this map.` : '';
  pbox.appendChild(note);
  host.appendChild(collapsible(pbox, 'party'));
}

/**
 * The last KEEP_REPORTS sorties, newest first: one button per report, and the chosen one drawn by
 * Report.renderRun, which also lists the falls of a report as recorded facts.
 */
function renderReports(host) {
  const gs = G().state;
  const list = ledger(gs).history;
  if (!list.length) return;
  const box = document.createElement('div');
  box.className = 'jobbox';
  box.innerHTML = `<h3>📜 Sortie reports <span class="sub">${list.length}</span></h3>` +
    `<div class="sub">The last ${KEEP_REPORTS} sorties. Each keeps its last ${KEEP_FIGHTS} fights and every fight in which somebody fell; the blow-by-blow log is kept for the fights with a fall.</div>`;
  const shown = list.find(r => r.id === openReport) || list[0];
  const tabs = document.createElement('div');
  tabs.className = 'controls';
  tabs.style.cssText = 'justify-content:flex-start;flex-wrap:wrap';
  for (const rec of list) {
    const b = document.createElement('button');
    b.className = rec === shown ? '' : 'ghost';
    b.textContent = `${rec.icon || ''} ${rec.mission} · ${rec.won ? 'won' : 'not won'}`;
    b.addEventListener('click', () => { openReport = rec.id; render(); });
    tabs.appendChild(b);
  }
  box.appendChild(tabs);
  Report.renderRun(box, shown, gs, M);
  host.appendChild(collapsible(box, 'reports'));
}

/** The wall: everyone who did not come back, and what they were. */
function renderMemorial(host) {
  const gs = G().state;
  const fallen = Roster.fallen(gs);
  if (!fallen.length) return;
  const box = document.createElement('div');
  box.className = 'jobbox';
  box.innerHTML = `<h3>⚱️ The fallen <span class="sub">${fallen.length}</span></h3>` +
    `<div class="sub">Death is permanent. Each of these identities — race, face, aptitudes and everything they knew — is locked out of the summoning pool and cannot be drawn again.</div>`;
  const row = document.createElement('div');
  row.className = 'workers';
  for (const f of fallen.slice(0, 12)) {
    const card = document.createElement('div');
    card.className = 'card';
    const holder = document.createElement('div');
    card.appendChild(holder);
    // the service record and the two strongest bonds the roster took before the pairs were deleted (roster.js fallAll)
    const rd = Roster.describeRecord(f.record, { fallen: true });
    const kin = (f.bonds || []).slice(0, 2)
      .map(b => `${b.name} (${b.word}${b.runs ? `, ${b.runs} mission${b.runs === 1 ? '' : 's'} together` : ''})`).join(', ');
    card.insertAdjacentHTML('beforeend',
      `<div class="name">${f.name}</div>` +
      `<div class="sub">${f.stars || 1}★ ${f.race}</div>` +
      `<div class="sub">${f.aptitudes && f.aptitudes.length ? f.aptitudes.join(' · ') : 'no aptitude of note'}</div>` +
      (rd ? `<div class="sub" title="${rd.title.replace(/"/g, '&quot;')}">${rd.counts}</div>` : '') +
      (kin ? `<div class="sub">bonds: ${kin}</div>` : '') +
      `<div class="sub warn">${f.cause}</div>`);
    row.appendChild(card);
    // their face, one last time
    if (f.selections && window.LPC) {
      LPC.buildLayers({ race: f.race, bodyType: f.bodyType, selections: f.selections })
        .then(layers => holder.appendChild(Tokens.pog(layers, { name: '', size: 40, tag: false, ring: Tokens.RINGS.down })))
        .catch(() => {});
    }
  }
  box.appendChild(row);
  host.appendChild(collapsible(box, 'memorial'));
}

// ---------- the camera ----------
//
// The map is drawn to fit by default, which is the right view for reading a mission and the
// wrong one for watching it: at eleven pixels a tile a fight is two smudges touching. So the
// canvas has a camera — zoom in, and either FOLLOW the squad (the default, and the only way to
// keep up with people who are walking) or take hold of it and drag somewhere yourself.
// Everything here is view state: it is never saved, and a reload comes back at the fitted view.
const ZOOM_MIN = 1, ZOOM_MAX = 8, ZOOM_STEP = 1.4;
const cam = { zoom: 1, x: null, y: null, follow: true };
let lastView = null;         // the transform the last frame drew with, for pixel -> tile
// The 3D view (world3d.js) or the flat one. A view preference, so it lives in the browser and
// not in the save. A canvas cannot switch between a 2D and a WebGL context, so toggling it
// re-renders the panel, which makes a new canvas.
let view3d = (() => { try { return localStorage.getItem('ig.view3d') !== '0'; } catch (e) { return true; } })();
let world = null;            // the World3D bound to the current map canvas

/** Where the squad is, in tiles, using the smoothed draw positions so the camera does not jitter. */
function squadCentre(s) {
  const ours = s.actors.filter(a => a.role === 'squad' && a.alive && !a.extracted);
  if (!ours.length) return null;
  const at = (a, k, r) => (a[r] == null ? a[k] : a[r]);
  return {
    x: ours.reduce((n, a) => n + at(a, 'x', 'rx'), 0) / ours.length,
    y: ours.reduce((n, a) => n + at(a, 'y', 'ry'), 0) / ours.length,
  };
}

function setZoom(z, at = null) {
  const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
  // zooming with the pointer over a tile keeps that tile under the pointer, which is what makes
  // a wheel feel like a magnifying glass rather than a slider
  if (at && !cam.follow) { cam.x = at.x; cam.y = at.y; }
  cam.zoom = next;
  if (next === ZOOM_MIN) cam.follow = cam.follow || false;
  syncCam();
}

function syncCam() {
  const z = el('#cam-zoom'), f = el('#cam-follow');
  if (z) z.textContent = cam.zoom.toFixed(1) + '×';
  if (f) f.checked = cam.follow;
  const cv = document.getElementById('sortie-map');
  if (cv) cv.style.cursor = cam.follow ? 'default' : 'grab';
}

/** Canvas pixels -> map tiles, through whatever transform the last frame used. */
function tileAt(cv, ev) {
  if (!lastView) return null;
  if (lastView.tileAt) return lastView.tileAt(ev);
  const r = cv.getBoundingClientRect();
  const px = (ev.clientX - r.left) * (cv.width / r.width);
  const py = (ev.clientY - r.top) * (cv.height / r.height);
  return { x: (px - lastView.ox) / lastView.scale - 0.5, y: (py - lastView.oy) / lastView.scale - 0.5 };
}

function wireCamera(cv) {
  el('#cam-in').addEventListener('click', () => setZoom(cam.zoom * ZOOM_STEP));
  el('#cam-out').addEventListener('click', () => setZoom(cam.zoom / ZOOM_STEP));
  el('#cam-whole').addEventListener('click', () => { cam.zoom = 1; cam.follow = true; syncCam(); });
  el('#cam-3d').addEventListener('change', (e) => {
    view3d = e.target.checked;
    try { localStorage.setItem('ig.view3d', view3d ? '1' : '0'); } catch (err) { /* private window */ }
    render();
  });
  el('#cam-follow').addEventListener('change', (e) => {
    cam.follow = e.target.checked;
    if (cam.follow) { const c = squadCentre(run.field); if (c) { cam.x = c.x; cam.y = c.y; } }
    syncCam();
  });
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    setZoom(cam.zoom * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), tileAt(cv, e));
  }, { passive: false });

  // Drag to look somewhere else, and pinch to zoom. Taking hold of the map means taking it off
  // the squad: a camera that snapped back to them on the next frame would fight the hand that
  // moved it. Two fingers down cancels the drag and becomes a pinch — on a phone that is the
  // only zoom there is, since there is no wheel and the buttons are a poor substitute for
  // reaching into a room.
  let drag = null, pinch = null;
  const live = new Map();                    // pointerId -> last position, for the pinch
  const spread = () => {
    const [a, b] = [...live.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  cv.addEventListener('pointerdown', (e) => {
    if (!lastView) return;
    live.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (cam.follow) { const c = squadCentre(run.field); if (c) { cam.x = c.x; cam.y = c.y; } cam.follow = false; syncCam(); }
    if (live.size === 2) { drag = null; pinch = { from: spread(), zoom: cam.zoom }; return; }
    drag = { x: e.clientX, y: e.clientY };
    cv.setPointerCapture(e.pointerId);
    cv.style.cursor = 'grabbing';
  });
  cv.addEventListener('pointermove', (e) => {
    if (!lastView) return;
    if (live.has(e.pointerId)) live.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && live.size === 2) { const now = spread(); if (pinch.from > 0) setZoom(pinch.zoom * (now / pinch.from)); return; }
    if (!drag) return;
    const r = cv.getBoundingClientRect();
    const k = (cv.width / r.width) / lastView.scale;
    cam.x -= (e.clientX - drag.x) * k;
    cam.y -= (e.clientY - drag.y) * k * lastView.scale / (lastView.scaleY || lastView.scale);
    drag = { x: e.clientX, y: e.clientY };
  });
  const release = (e) => {
    live.delete(e.pointerId);
    if (live.size < 2) pinch = null;
    if (!drag) return;
    drag = null;
    try { cv.releasePointerCapture(e.pointerId); } catch (err) { /* gone */ }
    syncCam();
  };
  cv.addEventListener('pointerup', release);
  cv.addEventListener('pointercancel', release);
  syncCam();
}

/** A finger, not a mouse: there is no wheel to tell them about and no hover to lean on. */
const coarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

function renderRun(host) {
  const s = run.field, m = run.mission;
  try { view3d = localStorage.getItem('ig.view3d') !== '0'; } catch (e) { /* keep what we had */ }
  host.innerHTML = `
    <div class="jobbox">
      <div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">
        <div>
          <canvas id="sortie-map" width="640" height="440" style="background:#15151b;border-radius:8px;display:block;touch-action:none"></canvas>
          <div class="sub" id="sortie-clock"></div>
          <div class="camrow">
            <button class="ghost" id="cam-out" title="Zoom out">−</button>
            <b id="cam-zoom">1.0×</b>
            <button class="ghost" id="cam-in" title="Zoom in">+</button>
            <label title="Keep the view on the squad as they walk"><input type="checkbox" id="cam-follow" checked> follow</label>
            <button class="ghost" id="cam-whole" title="Back to the whole map">whole map</button>
            <label title="Draw the field in 3D instead of flat tiles"><input type="checkbox" id="cam-3d"${view3d ? ' checked' : ''}> 3D</label>
            <span class="sub">${coarse() ? 'pinch to zoom · drag to look around' : 'wheel to zoom · drag to look around'}</span>
          </div>
        </div>
        <div style="flex:1;min-width:260px">
          <h3>${m.icon} ${m.name}</h3>
          <div class="sub">${m.blurb}</div>
          ${run.cohesion && run.bonus > 0.005 ? `<div class="sub" title="${cohesionTitle(run.cohesion)}"><span class="tag">\u{1F91D} cohesion</span> ${cohPct(run.bonus)} damage, ${cohPct(run.bonus / 2)} armour</div>` : ''}
          <div id="sortie-obj" style="margin:8px 0"></div>
          <div class="sub" id="sortie-portal"></div>
          <div class="sub" id="sortie-tally"></div>
          <div id="sortie-log" style="height:220px;overflow:auto;font-size:12px;line-height:1.45;margin-top:8px"></div>
          <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;align-items:center">
            <select id="sortie-speed" title="how fast the mission clock runs">
              <option value="1">1×</option><option value="2">2×</option><option value="4">4×</option>
            </select>
            <button class="ghost" id="sortie-skip">Skip to the end</button>
            <button id="sortie-fallback" hidden>Fall back through the portal</button>
            <button class="danger" id="sortie-abandon">Call it off</button>
            <button id="sortie-back" hidden>Back to the board</button>
          </div>
          <div class="sub" id="sortie-exit-note"></div>
        </div>
      </div>
    </div>`;
  el('#sortie-abandon').addEventListener('click', exitOrder);
  el('#sortie-skip').addEventListener('click', skip);
  el('#sortie-fallback').addEventListener('click', fallBack);
  const sp = el('#sortie-speed');
  sp.value = String(speed);
  sp.addEventListener('change', (e) => { speed = +e.target.value; if (!run.field.result) start(); });
  el('#sortie-back').addEventListener('click', () => {
    const newest = ledger(run.gs).history[0];
    run = null;
    if (newest) { openReport = newest.id; collapsed.reports = false; }
    render();
  });
  wireCamera(document.getElementById('sortie-map'));
  appendLog(s.log);
  renderSide();
}

// The way home as text. The ring on the map shows how far along it is; this says what kind of
// exit it is and what it will cost, which is the part a player has to decide on.
const PORTAL_LINE = {
  closed: () => '\u{1F300} the way home is not open yet',
  opening: (s) => `\u{1F300} the way home is opening — ${Math.round(100 * (s.portal.progress || 0) / MT.PORTAL.open)}%`,
  open: (s) => s.portal.shutsAt != null
    ? `\u{1F300} the way home is open for ${MT.realClock(Math.max(0, s.portal.shutsAt - s.clock) * MT.TIME.scale)}`
    : '\u{1F300} the way home is open where they stand',
  shut: (s) => `\u{1F300} shut — ${MT.realClock(Math.max(0, (s.portal.opensAt || 0) - s.clock) * MT.TIME.scale)} until they can force it again`,
};

function renderPortal(s) {
  const box = el('#sortie-portal'), btn = el('#sortie-fallback');
  if (!box) return;
  const pt = s.portal;
  if (!pt || s.result) { box.textContent = ''; if (btn) btn.hidden = true; return; }
  const holding = F.stillHolding(s);
  const over = s.overtime || 0;
  box.innerHTML = `<span style="color:${pt.state === 'open' ? '#7fd8b0' : pt.state === 'shut' ? '#c96a6a' : '#9a9aa8'}">`
    + (PORTAL_LINE[pt.state] || PORTAL_LINE.closed)(s) + '</span>'
    + (over ? ` <span class="tag">\u{23F1} ${MT.realClock(over * MT.TIME.scale)} held over · +${Math.round(100 * overtimePay(s))}%</span>` : '');
  if (btn) {
    btn.hidden = !holding;
    btn.textContent = over ? `Fall back now (+${Math.round(100 * overtimePay(s))}%)` : 'Fall back through the portal';
  }
}

// The reasons Field.contact() gives, as the note under the exit button states them.
const CONTACT_WORDS = { sighted: 'a hostile has seen the squad', fight: 'a fight has opened', fall: 'a squad member has fallen' };
// The exit button per exitState(): its label, whether it can be pressed, and the line under it.
const EXIT = {
  free: { label: 'Call it off', note: () => 'Free until a hostile has seen the squad, a fight opens or a squad member falls.' },
  order: {
    label: 'Order a retreat',
    note: (s) => `The call-off is no longer free: ${F.contact(s).map(k => CONTACT_WORDS[k]).join(', ')}. The squad heads for the way home. The contract ends as a loss unless its terms are met first.`,
  },
  retreating: {
    label: 'Retreating', off: true,
    note: (s) => !s.skirmishes.length ? 'The squad is heading for the way home.'
      : s.withdrew.ordered ? 'Retreat ordered; takes effect when the current fight ends.' : 'The squad has withdrawn on its own; it leaves when the current fight ends.',
  },
  stuck: {
    label: 'Abandon the run',
    note: () => `Not out after ${MT.realClock(F.STRAGGLE * MT.TIME.scale)} in-game. Abandoning ends the run now and applies the deaths so far.`,
  },
};

function renderSide() {
  if (!run || !el('#sortie-obj')) return;
  const s = run.field, m = run.mission;
  el('#sortie-obj').innerHTML =
    m.win.map(a => `<div class="sub" style="color:${F.winMet(s, a) ? '#5fbf7f' : '#bbb'}">${F.winMet(s, a) ? '✔' : '○'} ${MT.objectiveText(a)}</div>`).join('') +
    m.lose.map(a => `<div class="sub" style="color:#c96a6a">✖ ${MT.objectiveText(a)}</div>`).join('');
  const sideBox = el('#sortie-side');
  if (sideBox) {
    sideBox.innerHTML = (s.side || []).map(j => {
      const who = s.actors.find(x => x.id === j.taker);
      return `<div style="color:${j.done ? '#5fbf7f' : '#9a9aa8'}">${j.done ? '✔' : '○'} ${j.icon} ${j.label}` +
        `${who ? ' — ' + (who.label || who.name) : ' — nobody suitable'} <span class="tag">×${j.reward}</span></div>`;
    }).join('');
  }
  const alive = s.actors.filter(a => a.role === 'squad' && a.alive).length;
  const foes = s.actors.filter(a => a.side === 'theirs' && a.alive && a.role !== 'structure').length;
  el('#sortie-tally').textContent =
    `${alive}/${s.partySize} standing · ${foes} of them left · ${Math.round(100 * s.counters.revealed / s.walkable)}% scouted` +
    (s.map.floors > 1 ? ` · floor ${s.floorNo}/${s.map.floors}` : '') +
    ` · 🧭 ${s.scout || 0} ${AI.scoutTier(s.scout || 0).label}`;
  renderPortal(s);
  const abandonBtn = el('#sortie-abandon'), backBtn = el('#sortie-back'), skipBtn = el('#sortie-skip'), exitNote = el('#sortie-exit-note');
  const exit = EXIT[exitState(run)];
  // renderSide runs every step; the text is written only when it changes, so a click is not racing a redraw
  const put = (node, text) => { if (node && node.textContent !== text) node.textContent = text; };
  if (exit && abandonBtn) {
    put(abandonBtn, exit.label);
    abandonBtn.disabled = !!exit.off;
    put(exitNote, exit.note(s));
  } else put(exitNote, '');
  if (s.result && abandonBtn) {
    abandonBtn.hidden = true; skipBtn.hidden = true; backBtn.hidden = false;
    if (!el('#sortie-result')) {
      const d = document.createElement('div');
      d.id = 'sortie-result';
      d.className = 'sub';
      d.style.color = s.result.won ? '#5fbf7f' : '#c96a6a';
      d.textContent = (s.result.won ? '✅ ' : '❌ ') + s.result.why +
        (run.paid && Object.keys(run.paid).length ? ` · ${Econ.costText(run.paid)}` : '') +
        (run.salvage ? ` + 💎 ${run.salvage} loot${lootNote(run)}` : '');
      el('#sortie-tally').after(d);
    }
  }
}

function frame(now) {
  raf = requestAnimationFrame(frame);
  const cv = document.getElementById('sortie-map');
  if (!run || !cv || !cv.isConnected) {
    if (world) { world.dispose(); world = null; }      // the panel is gone: hand back its WebGL context
    return;
  }
  const dt = Math.min(400, now - lastReal);
  acc += dt;
  lastReal = now;
  if (cam.follow) { const c = squadCentre(run.field); if (c) { cam.x = c.x; cam.y = c.y; } }
  if (world && world.canvas !== cv) { world.dispose(); world = null; }
  if (view3d && World3D.pending()) return;      // three.js still loading: taking a 2D context now would rule WebGL out
  if (view3d && World3D.ready()) {
    if (!world) world = World3D.create(cv);
    lastView = world.render(run.field, { zoom: cam.zoom, cx: cam.x, cy: cam.y }, dt);
  } else {
    const view = FieldView.layout(cv, run.field.map, { zoom: cam.zoom, cx: cam.x, cy: cam.y });
    lastView = view;
    // Faces are re-baked, not stretched, and only when the number changes — a pog is about three
    // tiles across at any zoom, which keeps a party readable whether the view holds the whole map
    // or one room of it.
    FieldView.rescale(run.field, Math.min(96, Math.max(24, view.scale * 2.6)));
    const fx = cv.getContext('2d');
    FieldView.drawMap(fx, run.field, view);
    FieldView.drawActors(fx, run.field, view, dt);
  }
  const clock = el('#sortie-clock');
  if (clock) clock.textContent =
    `in-game ${MT.realClock(run.field.clock * MT.TIME.scale)} of ${MT.realClock(run.mission.duration * MT.TIME.scale)}` +
    ` · watched ${MT.realClock(run.field.clock)}` +
    (run.field.result ? (run.field.result.won ? ' · won' : ' · lost') : '');
}

function render() {
  const host = document.getElementById('sortie');
  if (!host) return;
  host.innerHTML = '';
  if (run) { renderRun(host); return; }
  renderBoard(host);
  renderReports(host);
  renderTeams(host);
  renderMemorial(host);
  restoreFocus();
  Filters.restoreFocus();   // the party box's search box is the shared bar's, which tracks its own
}

window.Sortie = { render, launch, abandon, exitState, exitOrder, discard, skip, fallBack, board, townLevel, persist, resume, forget, get run() { return run; } };

// The panel is rendered when its tab is opened, and once at boot in case it is the saved tab.
async function boot() {
  // game.js loads its sprite catalog before it has a state, and this file is booted by the same
  // DOMContentLoaded: reaching for the town a moment too early threw here, which skipped the
  // resume below, so any run that was in progress across a reload was lost.
  if (!G().state) { setTimeout(boot, 50); return; }
  const tab = document.querySelector('.tab[data-tab="field"]');
  if (tab) tab.addEventListener('click', render);
  Crew.tidy(G().state);                  // teams do not list ghosts
  Crew.seedPairs(G().state);             // a team saved with a run count of its own hands it to its pairs, once
  if (typeof Bestiary !== 'undefined') await Bestiary.loadIndex();   // before resuming, or the art comes back empty
  // a run in progress survives a reload, a crash or a closed laptop
  try { resume(); } catch (e) { discard(); console.warn('could not resume the run', e); }
  addEventListener('beforeunload', () => persist(true));
  addEventListener('visibilitychange', () => { if (document.hidden) persist(true); });
  render();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
})();
