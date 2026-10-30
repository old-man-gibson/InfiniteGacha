// Condition: what a character has left in them today. Browser: window.Condition. Node: module.exports.
//
// stats.js already derives the CEILINGS — stamina from CON, mana from INT, spirit from WIS,
// willpower from CHA. This file owns what is actually in those pools right now, so a character
// tires and recovers instead of always holding its ceiling.
//
// Three tracked values: stamina, one caster pool (mana or spirit) and morale.
//
//   STAMINA  Spent by working and by drilling, refilled by resting. It is the reason a town
//            rotates: nobody holds a post all day, output falls off as it drains, and somebody
//            fresh is worth more at the bench than somebody spent. Governed by CON.
//
//   MANA / SPIRIT  Only for the half of the roster that casts. Which pool a character draws on
//            is decided by what they actually do — arcana and the elements pull on MANA, light
//            and psionics pull on SPIRIT — and it is spent on missions rather than in town, so
//            resting before a mission changes how a fight opens. A mage sent out on an empty
//            pool starts the fight with an empty pool (see combat.js fromCharacter).
//
//   MORALE   Slower than the rest and about the mind rather than the body: how well they work
//            and how long they will keep at it. It drifts toward a target set by how they are
//            being treated — housed, rested, not driven into the ground — at a rate set by
//            WILLPOWER, so a high-CHA character both holds a mood longer and recovers it faster.
//
// Where it is read. Town output is multiplied by stamina and morale together (`workMult`), and
// the rotation in crew.js benches anyone who is spent. combat.js reads `staminaFrac` and
// `poolFrac` once, when it builds a fighter's pools (fromCharacter): stamina opens at its fraction
// (floor 0.35), and mana and focus open at the pool fraction (floor 0.2). From then on the fight
// uses its own per-encounter pools and nothing here changes during it. The party picker in
// sortie.js shows readyIn(): the resting ticks until stamina and the pool are back to RESTED, and
// which of them sets that.
//
// Where it is spent. Missions.debrief (missions.js) calls spend() and outcome() for each survivor
// of a Gate run and of a contract alike. It passes a stamina cost of 25 + 1.5 x mission level and
// the run's cast count; spend() takes 6% of the caster pool (at least 4) per cast.
//
// Where it is hurt. Missions.debrief also calls wound() once per survivor, with the lowest HP
// fraction that character had at the end of any fight in the run (sortie.js resolve() for a
// contract, missions.js fight() for a Gate run). End-of-run HP is not used because sortie.js
// regenerates HP between fights. wound() sets c.injured in town ticks, which blocks launching
// (sortie.js, missions.js), benching on a post (game.js rota, crew.js) and Trials (quests.js),
// and lowers the morale target (moraleTarget). Missions.tick lowers c.injured by healRate() each
// town tick, so the bed and the pantry set how long a wound lasts. readyIn() reports the wound and
// the stamina / pool debt as separate limits for the party picker.
//
// Where it sets resolve. sortie.js launch() writes resolveSeed() into each squad actor's `resolve`
// (field.js) before the first step. The seed is never positive: morale under SEED_FROM and a spent
// stamina bar start a character with negative resolve, and a housed, fed, rested one starts at 0, the
// same as a character at morale 60. field.js reads resolve in broken() and in the escapeHatch lines
// (Field.hatchLines), and combat.js reads it in its action weights, so a squad that comes home beaten
// or goes out twice without resting leaves fights earlier on the next map. Tactics.grieve adds to the
// same variable and field.js grieved() holds the sum to +-RESOLVE_CAP.
//
// Where a meal is eaten. Sortie.launch and Missions.launch call feed(): each squad member, in party
// order, takes one meal from state.inventory, best quality first (the town's own resting draw in
// game.js eatMeals takes the worst first and is unchanged), and carries it as c.meal = { key, name,
// quality, amount, points } (economy.js mealInfo). Combat.fromCharacter adds c.meal.points to that
// fighter's stats; Stats.effective does not, so no figure in town changes. clearMeal() deletes c.meal
// when the run ends (sortie.js release, missions.js finish). A launch that fails after feed() calls
// unfeed(), and sortie.js abandon() on a run nobody has fought calls returnMeal(); both put the meals
// back in the pantry. mealPlan() is the same draw without taking anything, for the party picker.
// game.js deletes a c.meal that has no run behind it when it loads a save.
//
// Where a wound is shown. Every screen that prints how long somebody is out (roster tile, character
// sheet, party picker, party box, gate party, team note, the wound line of a debrief) calls wounded()
// or restAt(). They read the two inputs Missions.recover heals by: the bed Lodging.restFor gives that
// character and whether the pantry holds a meal. The figure is the number of town ticks the healing
// takes, and it is the same on every screen at the same moment.

(() => {
const S = () => (typeof Stats !== 'undefined') ? Stats : require('./stats.js');
const CL = () => (typeof Classes !== 'undefined') ? Classes : (typeof require !== 'undefined' ? require('./classes.js') : null);
// Optional: two people in the same bed on the same rations do not end the week in the same mood
// (temper.js). Grit holds a floor under a bad one; appetite is what resents the bed.
const TE = () => (typeof Temper !== 'undefined') ? Temper : (typeof require !== 'undefined' ? require('./temper.js') : null);
// Optional: the bed sets the rest rate. field.html and the Node tests do not load lodging.js, so there is no require fallback.
const LO = () => (typeof Lodging !== 'undefined') ? Lodging : null;
// Meal quality, points and wording (economy.js). Plain data with no dependencies, so it is always found.
const EC = () => (typeof Econ !== 'undefined') ? Econ : require('./economy.js');

// ---------- rates ----------
// Per tick, before any multiplier. A tick is ten seconds, so a mid character (120 stamina)
// works about forty ticks and rests about twenty: a two-to-one duty cycle, which is the shape
// of the rotation the town settles into on its own.
const DRAIN = { gather: 3, process: 2.5, town: 2, train: 4, build: 3, idle: 0 };   // build: a construction site (lodging.js)
const REST_BASE = 4;               // stamina a tick of rest returns, before CON and lodging
const REST_PER_CON = 0.2;
const SPENT = 0.2;                 // at or below this fraction of stamina they are done for now
const RESTED = 0.85;               // at or above this they are ready to take a post again
const POOL_REGEN = 0.02;           // fraction of a caster pool returned per resting tick
// A meal from the kitchen. It speeds everyone's rest a little (FED_REST), and it matters most with
// no bed: with no roof a fed character recovers at 0.8 x 1.25 = 1.0 times the housed, unfed rate
// and an unfed one at 0.5 times it, so a meal is the difference between sleeping rough and
// sleeping rough on an empty stomach. A character with no bed still recovers; the rate is lower.
const FED_REST = 1.25;             // multiplier on what a resting tick returns
const FED_ROUGH = 0.8;             // what a fed character recovers with no roof (0.5 unfed)
const ROUGH = 0.5;
const MORALE_MAX = 100;
const MORALE_START = 70;
// Wounds. A survivor whose lowest end-of-fight HP fraction `low` is under WOUND_FROM is injured for
// WOUND_TICKS x (WOUND_FROM - low) / WOUND_FROM ticks: reaching 0 HP costs WOUND_TICKS, reaching
// half of WOUND_FROM costs half of it. WOUND_TICKS equals Missions.INJURY_TICKS, the Node-only
// injury for a death (test/wounds.js checks they are equal).
// WOUND_FROM 0.3 comes from chained contracts through the real Sortie with dead characters replaced
// (`node test/wounds.js measure`, 3 seeds x 60 contracts per setting). At 0.3: 18-19% of survivors
// injured, 47-53% of sorties with at least one injured, mean wound 14 ticks. A roster of 12 that
// launches every 20 s never found fewer than four free characters; every 10 s it did in 4.4% of
// launches. A roster of 8 found fewer than four in 12.5% of 20 s launches and none at 40 s.
// At 0.4 the same runs injure 24% of survivors, 56-58% of sorties, and block a roster of 12 in 20%
// of 10 s launches. Contracts in these runs are lost about half the time, so a lost squad coming
// home near 0 HP is a large share of the injuries.
const WOUND_FROM = 0.3;
const WOUND_TICKS = 30;
// Starting resolve (resolveSeed): -SEED_PER_MORALE for each morale point under SEED_FROM, and -SEED_SPENT
// more for a character at or under SPENT stamina, held to SEED_MIN..0. SEED_MIN is reached at morale 20
// (-0.4), which is 40% of field.js RESOLVE_CAP (1).
const SEED_FROM = 60;
const SEED_PER_MORALE = 0.01;
const SEED_SPENT = 0.15;
const SEED_MIN = -0.4;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Which pool this character draws on when they cast, or null for somebody who does not. */
function poolKind(c) {
  const cl = CL();
  if (cl) {
    // WEIGH them rather than taking the first hit. A short-circuit made any class that trained a
    // little light or psionics a spirit caster, so a Barrier Mage whose main line is arcana was
    // drawing on the wrong pool entirely.
    let spirit = 0, mana = 0;
    for (const h of cl.held(c)) {
      const t = h.def.train || {};
      spirit += (t.psionics || 0) + (t.light || 0) + (h.def.group === 'faith' ? 0.5 : 0);
      mana += (t.arcana || 0) + (t.fire || 0) + (t.ice || 0) + (t.lightning || 0) + (t.dark || 0);
    }
    if (spirit > 0 || mana > 0) return spirit > mana ? 'spirit' : 'mana';
  }
  const p = c.profs || {};
  const stage = (k) => (p[k] ? p[k].stage : -1);
  const spirit = Math.max(stage('psionics'), stage('light'));
  const mana = Math.max(stage('arcana'), stage('fire'), stage('ice'), stage('lightning'), stage('dark'));
  if (spirit < 0 && mana < 0) return null;
  return spirit > mana ? 'spirit' : 'mana';
}

const maxOf = (c, key) => {
  const d = S().effective(c).derived;
  return Math.max(1, d[key]);
};

/** The condition record, made on demand so every save from before this file still loads. */
function ensure(c) {
  if (!c.cond) c.cond = {};
  const k = poolKind(c);
  const d = S().effective(c).derived;
  if (c.cond.stamina === undefined) c.cond.stamina = d.stamina;
  if (c.cond.morale === undefined) c.cond.morale = MORALE_START;
  if (k && c.cond[k] === undefined) c.cond[k] = d[k];
  c.cond.pool = k;
  // Taking gear off lowers the roof. Somebody who was full on a +5 CON breastplate is not full
  // without it, and leaving the old number in place would read as a full bar over a smaller max.
  c.cond.stamina = Math.min(c.cond.stamina, d.stamina);
  if (k) c.cond[k] = Math.min(c.cond[k], d[k]);
  return c.cond;
}

const stamina = (c) => ensure(c).stamina;
const staminaFrac = (c) => clamp01(ensure(c).stamina / maxOf(c, 'stamina'));
const morale = (c) => ensure(c).morale;
const moraleFrac = (c) => clamp01(ensure(c).morale / MORALE_MAX);
/** The caster pool as a fraction, or 1 for somebody who never casts (nothing to be short of). */
function poolFrac(c) {
  const k = ensure(c).pool;
  if (!k) return 1;
  return clamp01(c.cond[k] / maxOf(c, k));
}

const isSpent = (c) => staminaFrac(c) <= SPENT;
const isRested = (c) => staminaFrac(c) >= RESTED;

// ---------- what it is worth ----------
/**
 * Stamina's share of output: full above half a tank, falling to a third when empty. It never
 * reaches zero, because a town where an exhausted farmer produces literally nothing turns one
 * missed rotation into a famine.
 */
const staminaMult = (c) => 0.35 + 0.65 * clamp01(staminaFrac(c) / 0.5);
/** Morale's share: a demoralised worker is worth two thirds of a settled one, a proud one 1.25×. */
const moraleMult = (c) => 0.65 + 0.6 * moraleFrac(c);
/** Everything the condition layer does to a tick of work. */
const workMult = (c) => staminaMult(c) * moraleMult(c);

// ---------- the tick ----------
/**
 * Where morale is being pulled toward, on how this character is being treated right now.
 * Rest and a roof raise it; being driven to empty, being hurt, or sleeping outside lower it.
 */
function moraleTarget(c, { housed = true, working = false, restMult = 1, lodging = 0, fed = false, social = 0, station = 0, tavern = 0 } = {}) {
  let t = 55;
  if (housed) t += 12; else t -= fed ? 6 : 18;      // a meal is most of what a roof was worth
  if (fed) t += 6;
  t += lodging;                                   // what the building itself is worth (lodging.js)
  t += social;                                    // and who else is in it (bonds.js): the biggest
                                                  // single thing in this function once a roster
                                                  // has been together long enough to have friends
  t += (restMult - 1) * 30;                       // and how well they sleep in it
  t += station;                                   // housed below their standing (floors.js station)
  t += tavern;                                    // a tavern they may drink in, while resting (floors.js)
  const f = staminaFrac(c);
  if (f >= RESTED) t += 12;
  if (f <= SPENT) t -= 22;
  if (working && f <= SPENT) t -= 10;             // kept at the post past the point of use
  if (c.injured > 0) t -= 15;
  if (!working && f >= RESTED) t += 5;            // a day off, properly taken
  // And then who they are. The same tent is a roof to one of them and an insult to the next, and
  // the same fortnight of being run into the ground is a fortnight the dogged barely notice.
  const te = TE();
  if (te) t += te.moraleShift(c, { housed, working, fed, spent: f <= SPENT, injured: c.injured > 0 });
  return clamp(t, 0, MORALE_MAX);
}

/**
 * One tick of living. `job` is the kind of work being done ('gather', 'process', 'town',
 * 'train') or null for rest. Returns what changed, so the town can say when somebody drops.
 */
function tick(c, { job = null, housed = true, restMult = 1, mult = 1, lodging = 0, fed = false, social = 0, station = 0, tavern = 0 } = {}) {
  const cond = ensure(c);
  const d = S().effective(c).derived;
  const before = { stamina: cond.stamina, morale: cond.morale, spent: isSpent(c) };

  if (job) {
    cond.stamina = Math.max(0, cond.stamina - (DRAIN[job] || 0) * mult);
  } else {
    const roof = housed ? 1 : (fed ? FED_ROUGH : ROUGH);
    const back = (REST_BASE + S().effective(c).base.con * REST_PER_CON) * restMult * roof * (fed ? FED_REST : 1);
    cond.stamina = Math.min(d.stamina, cond.stamina + back);
    if (cond.pool) cond[cond.pool] = Math.min(d[cond.pool], (cond[cond.pool] || 0) + d[cond.pool] * POOL_REGEN * restMult);
  }

  // morale moves slowly and by willpower: 10 CHA drifts about a point a tick, 25 CHA nearly two
  const target = moraleTarget(c, { housed, working: !!job, restMult, lodging, fed, social, station, tavern });
  const rate = 0.35 + d.willpower * 0.02;
  cond.morale += clamp(target - cond.morale, -rate, rate);
  cond.morale = clamp(cond.morale, 0, MORALE_MAX);

  return { dropped: !before.spent && isSpent(c), recovered: before.spent && isRested(c), before };
}

/**
 * Resting ticks until `c` is rested: stamina and the caster pool both at RESTED of their maximum
 * and any injury over, at the rates tick() and healRate() use while resting. Returns
 * { ticks, limit, injury, rest, restLimit }. `limit` names the slowest of 'injury', 'stamina' and
 * the pool kind ('mana' or 'spirit'), or is null when nothing is owed. `injury` is the ticks of the
 * injury alone, `rest` the ticks of the slower of stamina and the pool alone, and `restLimit` which
 * of them that is. The two are independent: an injury blocks launching, a stamina or pool debt
 * only lowers how the fight opens.
 */
function readyIn(c, restMult = 1, fed = false, housed = true) {
  const cond = ensure(c);
  const { base, derived: d } = S().effective(c);
  const roof = housed ? 1 : (fed ? FED_ROUGH : ROUGH);
  const perTick = (REST_BASE + base.con * REST_PER_CON) * restMult * roof * (fed ? FED_REST : 1);
  const owed = [
    { limit: 'stamina', ticks: Math.max(0, (RESTED * d.stamina - cond.stamina) / perTick) },
  ];
  if (cond.pool) owed.push({ limit: cond.pool, ticks: Math.max(0, (RESTED - poolFrac(c)) / (POOL_REGEN * restMult)) });
  const slowestOf = (list) => list.reduce((a, t) => (t.ticks > a.ticks ? t : a), { limit: null, ticks: 0 });
  const injury = { limit: 'injury', ticks: c.injured > 0 ? c.injured / healRate(restMult, fed) : 0 };
  const rest = slowestOf(owed);
  const slowest = slowestOf([injury, ...owed]);
  const whole = (t) => Math.ceil(t - 1e-9);
  return {
    ticks: whole(slowest.ticks), limit: slowest.ticks > 0 ? slowest.limit : null,
    injury: whole(injury.ticks), rest: whole(rest.ticks), restLimit: rest.ticks > 0 ? rest.limit : null,
  };
}

// ---------- wounds ----------
/** Injury ticks cleared by one town tick: the bed's rest multiplier (lodging.js restFor), times FED_REST while the pantry has meals. */
const healRate = (restMult = 1, fed = false) => restMult * (fed ? FED_REST : 1);

/** Town ticks until c.injured is over at this bed and pantry, rounded up; 0 for somebody who is not injured. */
const woundTicks = (c, restMult = 1, fed = false) => (c.injured > 0 ? Math.ceil(c.injured / healRate(restMult, fed) - 1e-9) : 0);

/** "1 tick", "11 ticks". */
const tickText = (n) => `${n} tick${n === 1 ? '' : 's'}`;

/** Whether the pantry holds a meal: the `fed` that game.js tick passes to Missions.tick, so healing and every figure about it read one fact. */
const pantryFed = (state) => Object.values((state && state.inventory) || {}).some(i => i.kind === 'meal' && i.count > 0);

/**
 * The rest `c` gets in town, which is what Missions.recover heals by: { restMult, fed, housed, bed }.
 * restMult is the multiplier of the bed (lodging.js restFor: the building's `rest`, 0.75 with no bed;
 * 1 when lodging.js is not loaded), `fed` is pantryFed(), `housed` is whether any building has a bed
 * for them and `bed` names that building ('no bed' outside, null without lodging.js).
 */
function restAt(state, c) {
  const lo = LO();
  const inst = lo && lo.bedOf ? lo.bedOf(state, c) : null;
  return {
    restMult: lo ? lo.restFor(state, c) : 1,
    fed: pantryFed(state),
    housed: lo && lo.housed ? lo.housed(state, c) : true,
    bed: inst ? lo.typeOf(inst).label : (lo ? 'no bed' : null),
  };
}

/** readyIn() at the rest c gets in town (restAt), with that rest as `at`. */
function readyAt(state, c) {
  const at = restAt(state, c);
  return { ...readyIn(c, at.restMult, at.fed, at.housed), at };
}

/** A number for a tooltip: two decimals, or up to four when the value needs them, so a printed product is the product of the printed factors (1.45 x 1.25 = 1.8125). */
const fx = (v) => { const s = +v.toFixed(4); return Number.isInteger(s * 100) ? s.toFixed(2) : String(s); };

/** The factors of a rest rate with their sources, for tooltips: "bed 1.45 (Cottages) x meals 1.25 (the pantry has meals)". `at` is restAt(). */
function restText(at = {}) {
  const { restMult = 1, fed = false, bed = null } = at;
  const bedPart = `${bed ? 'bed' : 'rest'} ${fx(restMult)}${bed ? ` (${bed})` : ''}`;
  return fed
    ? `${bedPart} x meals ${fx(FED_REST)} (the pantry has meals)`
    : `${bedPart}; the pantry has no meals, which would multiply it by ${fx(FED_REST)}`;
}

/**
 * How an injury is derived, for tooltips: the wound ticks left, the healing rate per town tick as the
 * product of its sources (restText: the bed, then the meals) and the division that gives the ticks.
 * `at` is restAt(). The lowest HP and the mission that caused it follow.
 */
function explainWound(c, at = {}) {
  const { restMult = 1, fed = false } = at;
  const rate = healRate(restMult, fed), ticks = woundTicks(c, restMult, fed);
  const n = (v) => +v.toFixed(2);
  const note = c.woundNote;
  return `Injury: ${n(c.injured)} wound ticks left. Healing per tick: ${fx(rate)} = ${restText(at)}. ` +
    `Back in: ${n(c.injured)} / ${fx(rate)} = ${n(c.injured / rate)}, rounded up to ${tickText(ticks)}.` +
    (note && Number.isFinite(note.low) ? ` Cause: lowest HP ${Math.round(note.low * 100)}%${note.where ? ' at ' + note.where : ''}.` : '');
}

/**
 * The one reading of a wound that every screen prints (roster tile, character sheet, party picker,
 * party box, gate party, team note): null for somebody who is not injured, else { ticks, text, why }.
 * `ticks` is readyIn().injury at the rest c gets in town, so it is the number of town ticks until
 * Missions.recover has healed them; `text` is the phrase to print and `why` the tooltip with the
 * factors of the healing rate.
 */
function wounded(state, c) {
  if (!(c.injured > 0)) return null;
  const r = readyAt(state, c);
  return { ticks: r.injury, text: `recovering, back in ${tickText(r.injury)}`, why: explainWound(c, r.at) };
}

/**
 * The line a party card prints for stamina and the caster pool, from a readyIn() result. Somebody not
 * injured is "ready" or "ready in 2 ticks: stamina" (the slower of stamina and the pool). Somebody
 * injured is not ready until the injury is over, so their card says when the pool and stamina alone
 * are back: "rested" or "rested in 2 ticks: stamina".
 */
function readyText(r) {
  const injured = r.injury > 0;
  const word = injured ? 'rested' : 'ready', ticks = injured ? r.rest : r.ticks, limit = injured ? r.restLimit : r.limit;
  return ticks > 0 ? `${word} in ${tickText(ticks)}: ${limit}` : word;
}

/**
 * Injure `c` for the lowest HP fraction it had at the end of a fight in a run (see WOUND_FROM).
 * Returns { ticks, low } when that injures it, else null. An injury already owed is kept when it is
 * at least as long. c.woundNote records the cause for the sheet and the party picker, and
 * Missions.tick deletes it when c.injured reaches 0. `where` is the mission name.
 */
function wound(c, low, where = null) {
  if (!Number.isFinite(low)) return null;
  const ticks = Math.round(WOUND_TICKS * clamp01((WOUND_FROM - low) / WOUND_FROM));
  if (ticks <= 0) return null;
  if (!(c.injured >= ticks)) { c.injured = ticks; c.woundNote = { low, where }; }
  return { ticks, low };
}

// ---------- missions ----------
/** A mission is a hard day: it costs stamina outright and drains whatever they cast with. */
function spend(c, { staminaCost = 25, casts = 0 } = {}) {
  const cond = ensure(c);
  const d = S().effective(c).derived;
  cond.stamina = Math.max(0, cond.stamina - staminaCost);
  if (cond.pool) cond[cond.pool] = Math.max(0, (cond[cond.pool] || 0) - casts * Math.max(4, d[cond.pool] * 0.06));
  return cond;
}

/** Morale answers to how it went, and a death in the party is felt by everyone who saw it. */
function outcome(c, { won = true, lost = 0 } = {}) {
  const cond = ensure(c);
  const te = TE();
  cond.morale = clamp(cond.morale + (won ? 8 : -12) - lost * 6 + (te ? te.aftermath(c, { won, lost }) : 0), 0, MORALE_MAX);
  return cond.morale;
}

/** Morale moved by `delta` outside the tick and outside a mission: grief for somebody who died (roster.js). */
function adjustMorale(c, delta) {
  const cond = ensure(c);
  cond.morale = clamp(cond.morale + delta, 0, MORALE_MAX);
  return cond.morale;
}

/**
 * Whether this character would take THEMSELVES off a post they are spent at. Most people would;
 * the dogged would not. This is now a fact about the person rather than a veto on the rota: the
 * town's standing order is that nobody works below SPENT, and a standing order does not ask.
 * It still matters wherever there is no rota to save them — see `returnAt` for where doggedness
 * shows up instead.
 */
function stopsWhenSpent(c) {
  const te = TE();
  return !(te && te.worksSpent(c));
}

/**
 * The line at which somebody will take a post again.
 *
 * Everybody now leaves at SPENT, so grit had to move somewhere it still means something, and
 * this is the honest place for it: a dogged character is not somebody who ruins themselves, it
 * is somebody who is back on their feet at two thirds of a tank and would rather be earning.
 * A yielding one waits until they are properly rested. Doggedness buys SHORTER RESTS rather
 * than longer ruin, which is worth more to the town and costs the character nothing.
 */
function returnAt(c) {
  const te = TE();
  const grit = te ? te.t(c, 'grit') : 0;
  return Math.max(0.55, Math.min(0.95, RESTED - 0.3 * grit));
}
const readyToReturn = (c) => staminaFrac(c) >= returnAt(c);

// ---------- meals ----------
/**
 * The meal each of `chars` would eat if they launched now: one each, in the order given, from the
 * pantry's best quality down (economy.js betterMeal; entries that tie are taken by inventory key).
 * Takes nothing. Returns one row per character, { c, id, meal }: the inventory key and the mealInfo
 * the character would carry, both null for somebody the pantry cannot feed.
 */
function mealPlan(state, chars) {
  const E = EC();
  const stock = Object.entries((state && state.inventory) || {})
    .filter(([, i]) => i && i.kind === 'meal' && i.count > 0)
    .sort((a, b) => E.betterMeal(a[1], b[1]) || (a[0] < b[0] ? -1 : 1))
    .map(([id, item]) => ({ id, item, left: item.count }));
  return chars.map(c => {
    const row = stock.find(r => r.left > 0);
    if (!row) return { c, id: null, meal: null };
    row.left--;
    return { c, id: row.id, meal: E.mealInfo(row.item) };
  });
}

/** Who eats what in a mealPlan, for a log line or the picker: "Ana Fine stew +0.35 CON +0.35 STR; Bram Masterwork porridge +1.4 CON; no meal left for Cara". '' when nobody eats. */
function mealLine(plan) {
  const E = EC();
  const ate = plan.filter(r => r.meal), without = plan.filter(r => !r.meal);
  if (!ate.length) return '';
  return ate.map(r => `${r.c.name} ${r.meal.name} ${E.mealText(r.meal.points)}`).join('; ') +
    (without.length ? `; no meal left for ${without.map(r => r.c.name).join(', ')}` : '');
}

/**
 * Launch-time eating: each of `chars` takes the meal mealPlan gives them. c.meal is set, the pantry
 * entry loses one (and is deleted at 0, as game.js eatMeals does), and c.meal is deleted for anyone
 * the pantry could not feed, so a meal left over from an earlier run never carries into this one.
 * Returns { plan, line } where `line` is mealLine(plan); unfeed() takes the plan back.
 */
function feed(state, chars) {
  const plan = mealPlan(state, chars);
  for (const r of plan) {
    if (!r.meal) { delete r.c.meal; continue; }
    r.c.meal = r.meal;
    if (--state.inventory[r.id].count <= 0) delete state.inventory[r.id];
  }
  return { plan, line: mealLine(plan) };
}

/**
 * Put c's meal back in the pantry and delete c.meal. The entry is rebuilt from the record, with
 * `amount` on every stat the meal lists, which is what economy.js craftItem stores. Returns whether
 * there was a meal. sortie.js abandon() calls it for a run nobody has fought.
 */
function returnMeal(state, c) {
  const m = c.meal;
  if (!m) return false;
  const item = { kind: 'meal', key: m.key, quality: m.quality, name: m.name, buffs: Object.fromEntries(Object.keys(m.points).map(k => [k, m.amount])) };
  const inv = state.inventory || (state.inventory = {});
  const id = EC().itemId(item);
  if (inv[id]) inv[id].count++;
  else inv[id] = { ...item, count: 1 };
  delete c.meal;
  return true;
}

/** Undo feed() for a launch that failed after it: every meal goes back to the pantry and c.meal is deleted. */
function unfeed(state, fed) {
  for (const r of fed.plan) returnMeal(state, r.c);
}

/** Delete c.meal when the run ends: sortie.js release() and missions.js finish() call it for every party member. */
function clearMeal(c) { delete c.meal; }

/** The sheet's reading of c.meal, { text, why }, or null for somebody who has not eaten for a run. */
function mealOf(c) {
  const m = c && c.meal;
  if (!m || !m.points) return null;
  const E = EC();
  return {
    text: `fed: ${m.name}, ${E.mealText(m.points)} until the mission ends`,
    why: `Meal points: ${E.mealWhy(m)}. They are added to this character's stats when combat.js builds the fighter, ` +
      `so town output, scouting, honing and class fitness do not change.`,
  };
}

// ---------- display ----------
const BANDS = [
  { min: 0,    label: 'spent',    color: '#c96a6a' },
  { min: 0.25, label: 'tired',    color: '#e0a040' },
  { min: 0.6,  label: 'working',  color: '#8a8a9a' },
  { min: 0.9,  label: 'fresh',    color: '#5fbf7f' },
];
const MOOD = [
  { min: 0,    label: 'broken' },
  { min: 0.25, label: 'low' },
  { min: 0.5,  label: 'steady' },
  { min: 0.75, label: 'willing' },
  { min: 0.92, label: 'eager' },
];
const bandOf = (frac, table) => table.filter(b => frac >= b.min).pop();

function describe(c) {
  const cond = ensure(c);
  const d = S().effective(c).derived;
  return {
    stamina: { cur: cond.stamina, max: d.stamina, frac: staminaFrac(c), band: bandOf(staminaFrac(c), BANDS) },
    morale: { cur: cond.morale, max: MORALE_MAX, frac: moraleFrac(c), band: bandOf(moraleFrac(c), MOOD) },
    pool: cond.pool ? { kind: cond.pool, cur: cond[cond.pool], max: d[cond.pool], frac: poolFrac(c) } : null,
    workMult: workMult(c), spent: isSpent(c), rested: isRested(c),
  };
}

// ---------- resolve at the start of a map ----------
/**
 * The resolve `c` starts a map with, SEED_MIN to 0: -SEED_PER_MORALE x (SEED_FROM - morale) when morale
 * is under SEED_FROM, plus -SEED_SPENT when stamina is at or under SPENT, held to SEED_MIN..0. Morale at
 * or over SEED_FROM adds nothing and neither does stamina above SPENT, so the seed has no positive side.
 * Returns { seed, morale, moraleBand, fromMorale, staminaBand, fromStamina, text, why }. `seed` is the
 * resolve, `fromMorale` and `fromStamina` are its two terms before the hold, `text` lists the terms that
 * are not 0 for the launch log ("morale 42 (low) -0.18, stamina spent -0.15") and `why` is the
 * arithmetic for a tooltip.
 */
function explainSeed(c) {
  const m = morale(c), mb = bandOf(moraleFrac(c), MOOD).label;
  const sf = staminaFrac(c), sb = bandOf(sf, BANDS).label;
  const fromMorale = -SEED_PER_MORALE * Math.max(0, SEED_FROM - m);
  const fromStamina = isSpent(c) ? -SEED_SPENT : 0;
  const seed = clamp(fromMorale + fromStamina, SEED_MIN, 0) + 0;     // + 0: a sum of zeros is never -0
  const n = (v) => v.toFixed(2);
  const parts = [];
  if (fromMorale < 0) parts.push(`morale ${Math.round(m)} (${mb}) ${n(fromMorale)}`);
  if (fromStamina < 0) parts.push(`stamina ${sb} ${n(fromStamina)}`);
  const why = `Starting resolve ${n(seed)}. Morale ${Math.round(m)} (${mb}): -${SEED_PER_MORALE} x (${SEED_FROM} - morale) = ${n(fromMorale)}, ` +
    `0 at ${SEED_FROM} and over. Stamina ${Math.round(sf * 100)}% of its ceiling (${sb}): ${n(fromStamina)}, ` +
    `-${SEED_SPENT} at ${Math.round(SPENT * 100)}% and under, otherwise 0. The sum is held to ${SEED_MIN}..0.`;
  return { seed, morale: m, moraleBand: mb, fromMorale, staminaBand: sb, fromStamina, text: parts.join(', '), why };
}

const resolveSeed = (c) => explainSeed(c).seed;

const ConditionAPI = {
  DRAIN, SPENT, RESTED, MORALE_MAX, MORALE_START, BANDS, MOOD, FED_REST, FED_ROUGH, WOUND_FROM, WOUND_TICKS,
  SEED_FROM, SEED_PER_MORALE, SEED_SPENT, SEED_MIN,
  ensure, poolKind, stamina, staminaFrac, morale, moraleFrac, poolFrac,
  isSpent, isRested, staminaMult, moraleMult, workMult, moraleTarget, stopsWhenSpent, returnAt, readyToReturn,
  tick, readyIn, healRate, woundTicks, explainWound, wound, spend, outcome, adjustMorale, describe, bandOf,
  tickText, pantryFed, restAt, restText, readyAt, wounded, readyText, resolveSeed, explainSeed,
  mealPlan, mealLine, feed, unfeed, returnMeal, clearMeal, mealOf,
};
if (typeof module !== 'undefined') module.exports = ConditionAPI;
if (typeof window !== 'undefined') window.Condition = ConditionAPI;
})();
