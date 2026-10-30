// Crew: who does what, and who works well with whom. Browser: window.Crew. Node: module.exports.
//
// TWO HALVES, both about putting the right people in the right place.
//
// STAFFING. `plan()` fills the town's jobs by need first and talent second. It asks the town what
// it is short of — meals, then gems, then room in the drill hall — and answers each of those in
// turn with the best hand still free, before anybody is matched to work by output at all. Only
// what is left over is filled greedily, best pairing first, which puts the scarce building slots
// in the hands of their best candidates before the unlimited town jobs are filled.
//
// The old rule was the other way round: anyone who could swing at something was skimmed off for
// the training grounds first, so fighters were not available for the fields. That fails when
// food runs short: a town that drills through a famine has an army for about a week. Fighting
// is still staffed, third in the order, and only once the roster is fed.
//
// TEAMS. A team is a saved list of characters: the Teams box in sortie.js loads it into the party
// picker, lodging.js has a one-team-only rule and outfit.js supplies its members. It stores no
// history; a team saved before this had a `runs` count, which seedPairs() hands to its pairs once.
// Cohesion is computed for the party that actually goes, from the people in it:
//
//   rapport  1 - exp(-mean pair runs / RAPPORT_RUNS). The mean is over every pair in the party of
//            the `runs` count in the bonds.js record (missions walked out together, a lost mission
//            counting 0.5); a pair with no record counts 0.
//   skill    mean teamwork() of the party / 20, at most 1.4. teamwork() is stats.js DERIVED.teamwork
//            (CHA x 0.7 + WIS x 0.3) times a hidden social trait (loyal, loner...) and the class factor.
//   accord   bonds.js accord of the party: what the pairs are to each other, or temper.js's guess for
//            pairs that have not met.
//   bonus    MAX_BONUS x rapport x (0.4 + 0.6 x skill) x accord, applied by sortie.js as a multiplier on
//            damage and magic damage and, at half the size, on armour.
//
// Reading the pairs makes the party the unit. Four members of a team of five have the rapport of their
// six pairs. One member sent alone has no pair and gets 0. A stranger added to a veteran party adds
// pairs with 0 runs, which lowers the mean in proportion to their share of the pairs. A death needs no
// bookkeeping here: bonds.js mourn deletes the dead character's pair records.

(() => {
// Resolved on use rather than on load: a browser reads script tags in order, and binding these
// at parse time breaks this file if it is placed above what it needs.
const P = () => (typeof Prof !== 'undefined') ? Prof : require('./proficiency.js');
const ST = () => (typeof Stats !== 'undefined') ? Stats : require('./stats.js');
const R = () => (typeof Rng !== 'undefined') ? Rng : require('./rng.js');
// Optional: a class changes how easy somebody is to work beside (classes.js).
const CL = () => (typeof Classes !== 'undefined') ? Classes : (typeof require !== 'undefined' ? require('./classes.js') : null);
const CO = () => (typeof Condition !== 'undefined') ? Condition : (typeof require !== 'undefined' ? require('./condition.js') : null);
const QU = () => (typeof Quests !== 'undefined') ? Quests : (typeof require !== 'undefined' ? require('./quests.js') : null);
// Optional: whether these particular people can stand each other (temper.js). Teamwork is how
// much use somebody is to anyone; accord is how much use these five are to EACH OTHER.
const TE = () => (typeof Temper !== 'undefined') ? Temper : (typeof require !== 'undefined' ? require('./temper.js') : null);
// Optional: and what they have actually made of each other since (bonds.js).
const BO = () => (typeof Bonds !== 'undefined') ? Bonds : (typeof require !== 'undefined' ? require('./bonds.js') : null);

// ---------- teamwork ----------

// Hidden, rolled once, never shown as such: you find out by watching the team work.
const SOCIAL_TRAITS = {
  loyal:    { weight: 6,  mult: 1.35, label: 'Loyal',    desc: 'Fits into any line' },
  captain:  { weight: 4,  mult: 1.5,  label: 'Captain',  desc: 'The others move around them' },
  loner:    { weight: 7,  mult: 0.6,  label: 'Loner',    desc: 'Better on their own' },
  abrasive: { weight: 6,  mult: 0.7,  label: 'Abrasive', desc: 'Gets on with almost nobody' },
  none:     { weight: 77, mult: 1,    label: '',         desc: '' },
};

function rollSocial(rand = null) {
  rand = rand || R().rand;
  const total = Object.values(SOCIAL_TRAITS).reduce((a, t) => a + t.weight, 0);
  let x = rand() * total;
  for (const [k, t] of Object.entries(SOCIAL_TRAITS)) { x -= t.weight; if (x < 0) return k === 'none' ? [] : [k]; }
  return [];
}

/** Characters summoned before teams existed get their social trait the first time it is asked for. */
function ensureSocial(c) {
  if (!c.mind) c.mind = { traits: [] };
  if (!c.mind.social) c.mind.social = rollSocial();
  return c.mind.social;
}

const socialMult = (c) => ensureSocial(c).reduce((m, k) => m * (SOCIAL_TRAITS[k] ? SOCIAL_TRAITS[k].mult : 1), 1);

/**
 * How much use this character is to the people beside them, 3-30 before gear and social factors:
 * stats.js DERIVED.teamwork (CHA x 0.7 + WIS x 0.3) times the hidden social trait and the class factor.
 */
function teamwork(c) {
  const cl = CL();
  return ST().effective(c).derived.teamwork * socialMult(c) * (cl ? cl.socialMult(c) : 1);
}

// ---------- teams ----------

const MAX_BONUS = 0.18;      // what a long-standing party of naturals is worth in a fight
const RAPPORT_RUNS = 6;      // mean pair runs for ~63% of the rapport curve

const ensure = (state) => (state.teams = state.teams || []);
const find = (state, id) => ensure(state).find(t => t.id === id) || null;
const membersOf = (state, team) => team.members.map(id => state.characters.find(c => c.id === id)).filter(Boolean);

/** The characters a cohesion reading is about: an array of characters, or a team record's members who are on the roster. */
const partyOf = (state, who) => Array.isArray(who) ? who.filter(Boolean) : (who && who.members ? membersOf(state, who) : []);

/**
 * Cohesion of the people who go. `who` is an array of characters (the party at launch, the picks in the
 * party picker) or a team record, which is read as its members who are still on the roster (the Teams
 * box). Returns { bonus, rapport, skill, skillMult, accord, runs, pairs, strength }:
 *   runs      mean over the party's pairs of the bonds.js `runs` count, 0 for a pair with no record
 *   pairs     the number of pairs, n(n-1)/2 for n people
 *   rapport   1 - exp(-runs / RAPPORT_RUNS)
 *   skill     mean teamwork() / 20, at most 1.4; skillMult = 0.4 + 0.6 x skill
 *   accord    bonds.js accord of the party
 *   bonus     MAX_BONUS x rapport x skillMult x accord; 0 for a party of fewer than two
 *   strength  the number of people
 */
function cohesion(state, who) {
  const party = partyOf(state, who);
  const n = party.length;
  const bo = BO(), te = TE();
  let total = 0, pairs = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const p = bo ? bo.peek(state, party[i].id, party[j].id) : null;
    total += p ? p.runs || 0 : 0;
    pairs++;
  }
  const runs = pairs ? total / pairs : 0;
  const rapport = 1 - Math.exp(-runs / RAPPORT_RUNS);
  const skill = n ? Math.min(1.4, party.reduce((s, c) => s + teamwork(c), 0) / n / 20) : 0;
  const skillMult = 0.4 + 0.6 * skill;
  // accord is the term that is about the pairings rather than the people: five good soldiers who want
  // different things out of a mission are worth less than five ordinary ones who want the same thing.
  // bonds.js scores pairs that have met on what they are to each other and pairs that have not on
  // temper.js's guess, so a fresh party is judged on the guess and a veteran one on the record.
  const accord = n ? (bo ? bo.accord(state, party) : (te ? te.accord(party) : 1)) : 1;
  const bonus = MAX_BONUS * rapport * skillMult * accord;
  return { bonus, rapport, skill, skillMult, accord, runs, pairs, strength: n };
}

function create(state, name, memberIds) {
  const teams = ensure(state);
  const team = {
    id: 't' + Date.now().toString(36) + teams.length,
    name: name || `Team ${teams.length + 1}`,
    members: [...memberIds], founded: Date.now(),
  };
  teams.push(team);
  return team;
}

const remove = (state, id) => { state.teams = ensure(state).filter(t => t.id !== id); };

/** Somebody on this team is dead and gone: not in the roster, and on the memorial. */
function isFallen(state, id) {
  if (state.characters.some(c => c.id === id)) return false;
  const fallen = (state.roster && state.roster.fallen) || [];
  return fallen.some(f => f.id === id);
}

/**
 * Change who is on a team. Removing members who died (isFallen) is applied without confirmation.
 * Removing anyone else needs a second call with `confirm: true`. Only the member list changes.
 *
 * Returns { ok, forced, removed, dead } when applied, or { needsConfirm, removed, dead, ok: false }
 * when it wants the second call.
 */
function change(state, team, members, { confirm = false } = {}) {
  const removed = team.members.filter(id => !members.includes(id));
  const dead = removed.filter(id => isFallen(state, id));
  const forced = removed.length > 0 && removed.length === dead.length;
  if (removed.length && !forced && !confirm) return { needsConfirm: true, removed, dead, ok: false };

  team.members = [...members];
  return { ok: true, forced, removed, dead };
}

/**
 * One-time conversion of teams saved before cohesion was computed from pairs. Such a team holds its own
 * run count (`runs`, a lost run counting 0.5, scaled down when members left) and bonds.js holds one per
 * pair (a lost run then counted 1). For each pair of members that has a record, the pair's count becomes
 * min(team.runs, pair.runs): it never rises, so no pair is credited with more runs than its team showed.
 * A pair that is in several teams takes the lowest. `runs` and `lastRun` are then deleted from the team,
 * which is also what stops this from running twice. Returns the number of pairs that were lowered.
 */
function seedPairs(state) {
  const bo = BO();
  let lowered = 0;
  for (const t of ensure(state)) {
    if (typeof t.runs !== 'number') continue;
    const members = membersOf(state, t);
    for (let i = 0; bo && i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
      const p = bo.peek(state, members[i].id, members[j].id);
      if (p && p.runs > t.runs) { p.runs = t.runs; lowered++; }
    }
    delete t.runs;
    delete t.lastRun;
  }
  return lowered;
}

/**
 * Prune members who no longer exist from every team. This is the only place a team loses people to
 * death, whichever way they died (a field contract, a Gate run, a team they were not sent out with).
 * Nothing else is adjusted: the dead character's pair records are deleted by bonds.js mourn, so the
 * rapport of any party without them already excludes them. Returns { team, lost } for each team
 * that changed.
 */
function tidy(state) {
  const hit = [];
  for (const t of ensure(state)) {
    const before = t.members.length;
    const kept = t.members.filter(id => state.characters.some(c => c.id === id));
    if (kept.length === before) continue;
    t.members = kept;
    hit.push({ team: t, lost: before - kept.length });
  }
  return hit;
}

/** tidy(), said out loud. `log` is the town's own logger. */
function mourn(state, log) {
  for (const h of tidy(state)) {
    log(`🤝 ${h.team.name} is down to ${h.team.members.length}`);
  }
}


// ---------- honing ----------
//
// `plan()` staffs the town: it answers "who should be doing what" for everybody, and it answers
// it as a TOWN — the kitchen gets its cook because the roster eats, not because that person was
// born to cook. That is the right answer for a roster and only half of one for a PERSON.
// Advancement is per character — a trial is rolled for one name (quests.js) and passing it is
// what opens a class fusion slot — so at some point you stop asking who should farm and start
// asking who is worth the training grounds.
//
// `hone()` is that question, asked on purpose instead of as the third item on a list. It ranks
// the roster by what makes somebody worth investing the drill time in and fills the training
// slots with the top of it — the same ranking staffing uses, so the two never disagree:
//
//   RARITY     a summon-only class cannot be replaced by summoning again, and a fused character
//              is several tier-ups of work already spent. Both are worth protecting.
//   PROMISE    stats above what the rest of the roster is carrying, and stars on top.
//   PURPOSE    somebody with a trial actually in front of them, who can convert the drilling
//              into a star rather than into a slightly better aptitude.
//
// It will not send anyone who is spent — drilling on an empty tank is how morale ends up at five —
// and it will not send anyone empty-handed, because the drill trains what you are holding.
const HONE_FILTERS = {
  all:   { label: 'Anyone promising', keep: () => true },
  rare:  { label: 'Rare and fused only', keep: (c, x) => x.rare },
  trial: { label: 'Facing a trial', keep: (c, x) => x.trial },
};

/**
 * Drill trains the aptitude of whatever somebody is holding (game.js trainTick walks their
 * equipment), so an empty-handed character at the training grounds produces exactly nothing —
 * no aptitude, no class progress, a slot used for nothing. Nobody drills bare-handed, so the
 * smithy's output decides how many people the training grounds can use.
 */
const armed = (c) => Object.values(c.equipment || {}).some(Boolean);

/** What is interesting about this character, and how much of it there is. */
function honeTraits(state, c, avgStats) {
  const cl = CL(), qu = QU(), co = CO();
  const total = S_TOTAL(c);
  const held = cl ? cl.held(c) : [];
  const rareClass = held.some(h => h.def.summonOnly);
  const fused = held.length > 1;
  const trial = !!(qu && qu.trialFor(c));
  const ready = !co || !co.isSpent(c);
  return {
    rare: rareClass || fused, rareClass, fused, trial, ready, armed: armed(c),
    above: avgStats > 0 ? (total - avgStats) / avgStats : 0,
    stars: c.stats.stars, total,
    score: (rareClass ? 0.9 : 0) + (fused ? 0.5 : 0) + (trial ? 0.6 : 0)
      + Math.max(-0.5, (avgStats > 0 ? (total - avgStats) / avgStats : 0)) * 1.5
      + c.stats.stars * 0.12
      + combatScore(c) / 300,
  };
}

const S_TOTAL = (c) => Object.values(c.stats.base).reduce((a, v) => a + v, 0);

/**
 * Who to put on the training grounds. `api` is the town's own numbers (the same object plan()
 * takes). Returns the ranked candidates and the ones that fit in the slots, without applying
 * anything — the town does the assigning.
 */
function hone(state, api, { only = 'all', includeWorking = true } = {}) {
  const filter = HONE_FILTERS[only] || HONE_FILTERS.all;
  const pool = state.characters.filter(c => !c.mission && !(c.injured > 0));
  if (!pool.length) return { ranked: [], picked: [], slots: 0, benched: [] };
  const all = promise(state, pool);

  const ranked = all.ranked
    .filter(x => filter.keep(x.c, x))
    .filter(x => includeWorking || !x.c.job);

  const slots = api.slots('training');
  // anyone already drilling holds their place; the rest of the room goes to the best of the list
  const staying = ranked.filter(x => x.c.job === 'training' && drillable(x));
  const rest = ranked.filter(x => x.c.job !== 'training' && drillable(x));
  const picked = [...staying, ...rest].slice(0, slots);
  const benched = state.characters.filter(c => c.job === 'training' && !picked.some(p => p.c.id === c.id));
  return { ranked, picked, slots, benched, avg: all.avg,
           tired: ranked.filter(x => !x.ready).length,
           bare: ranked.filter(x => x.ready && !x.armed).length };
}

/** Rested enough to get something out of the drill, and holding something to drill with. */
const drillable = (x) => x.ready && x.armed;

/**
 * The roster ranked by what makes somebody worth the drill time. Both halves of this file lean on
 * it — the honing panel and staffing — so the two buttons cannot disagree about who belongs in the
 * drill hall. "Above the roster" is measured against whatever pool it is handed, so rank the WHOLE
 * roster once and filter afterwards rather than ranking each shortlist against itself.
 */
function promise(state, pool) {
  const avg = pool.length ? pool.reduce((a, c) => a + S_TOTAL(c), 0) / pool.length : 0;
  return { avg, ranked: pool.map(c => ({ c, ...honeTraits(state, c, avg) })).sort((a, b) => b.score - a.score) };
}

/** One line saying why somebody was picked, for the button that does the picking. */
function honeReason(x) {
  const bits = [];
  if (x.rareClass) bits.push('rare class');
  if (x.fused) bits.push('fused');
  if (x.trial) bits.push('trial waiting');
  if (x.above > 0.08) bits.push(`+${Math.round(x.above * 100)}% stats`);
  if (!bits.length) bits.push(`${x.stars}\u2605`);
  return bits.join(', ');
}

// ---------- staffing ----------

const COMBAT_GROUPS = new Set(['weapon', 'armor', 'element', 'mind']);

/** The best combat aptitude a character has, in absolute levels. */
function combatScore(c) {
  let best = 0;
  for (const [k, p] of Object.entries(c.profs || {})) {
    const def = P().PROFICIENCIES[k];
    if (!def || !COMBAT_GROUPS.has(def.group)) continue;
    best = Math.max(best, P().toAbsolute(p));
  }
  const b = ST().effective(c).base;
  return best + (b.str + b.dex + b.int) / 12;         // raw talent counts for something
}

// ---------- what the town needs before it needs anything else ----------
//
// Need first, talent second.
//
// Staffing used to be one greedy sweep over output with the fighters skimmed off the top for the
// drill hall. That answers "who is the best miner" and never asks "should anybody be mining".
// A town filled that way starves beside a full ore pile, because ore scores higher per body than
// turnips do and nothing in the sweep was counting meals.
//
// So the posts are filled in the order the town needs them, and only what is left over is filled
// by output:
//
//   1. FOOD   the kitchen, and the fields behind it, sized to what the roster actually eats
//   2. GEMS   income target (a savings rate; nothing drains gems)
//   3. DRILL  the training grounds, filled by PROMISE — rare classes, fused characters, stats
//             above the roster's average, a trial waiting — rather than by raw combat score
//   4. THE REST greedily, best pairing first, exactly as before
//
// Every need is a quantity of work per tick and never a headcount, so the town's staffing follows
// its stocks instead of a fixed table. Two good cooks satisfy the same demand as four poor
// ones. Upgrading the farm takes hands off the fields. A full pantry asks for one cook to keep it
// full and releases the rest to the mine and the drill hall; an empty one pulls them back. A town
// that feeds itself badly staffs mostly farms and one that feeds itself well staffs more drill,
// with no extra rule, because the demand is read off the larder every time the button is pressed.

// The pantry should hold this many ticks of eating, and a shortfall is made up over CATCHUP ticks
// rather than in one — a bare larder should lean the town towards the kitchen, not strip it bare.
const FOOD_BUFFER = 90;
const CATCHUP = 150;

/**
 * Which job makes the food, and which jobs make what the food is made of. Read off the job table
 * rather than named here, so changing what a meal costs re-staffs the town by itself.
 */
function foodChain(jobs) {
  const entries = Object.entries(jobs);
  const kitchen = entries.find(([, j]) => j.crafts === 'meal');
  if (!kitchen) return null;
  const fields = Object.entries(kitchen[1].consumes || {}).map(([res, per]) => {
    const field = entries.find(([, j]) => j.kind === 'gather' && j.produces === res);
    return field ? { job: field[0], res, per } : null;
  }).filter(Boolean);
  return { job: kitchen[0], def: kitchen[1], fields };
}

/**
 * What the town wants at each post before it wants anything else, in the order it wants it.
 * `work` is in whatever units api.outputFor() returns for that job, so it can be compared to the
 * people directly. `by` says how the seats get filled: 'output' takes whoever produces the most,
 * 'promise' takes whoever is worth the investment.
 *
 * The optional halves of `api` — stock(), eats(), gemGoal() — are things only the town knows.
 * Left out, that need simply does not exist and staffing falls back to what it always did.
 */
function demands(state, api) {
  const out = [];
  const stock = api.stock || (() => 0);
  // keep pace with the drain, plus whatever it takes to rebuild the buffer, spread over CATCHUP
  const rate = (want, have) => want + Math.max(0, want * FOOD_BUFFER - have) / CATCHUP;

  // 1. FOOD, and the fields are sized off the kitchen rather than guessed at separately
  const chain = foodChain(api.jobs);
  const eat = api.eats ? api.eats() : 0;
  if (chain && eat > 0) {
    const meals = rate(eat, stock('meal'));
    out.push({ key: 'food', job: chain.job, by: 'output', work: meals * (chain.def.threshold || 1),
               why: `${meals.toFixed(2)} meals a tick — the roster eats ${eat.toFixed(2)}` });
    for (const f of chain.fields) {
      const want = meals * f.per;
      out.push({ key: 'food', job: f.job, by: 'output', work: rate(want, stock(f.res)),
                 why: `${want.toFixed(1)} ${f.res} a tick to keep the kitchen lit` });
    }
  }

  // 2. GEMS, and this one is INCOME rather than a bill. Nothing drains gems on a tick; they are
  //    simply what everything else is bought with. The town names both the rate and the reason
  //    (game.js gemGoal) because the reason is the name of a building the player can go and look
  //    at — a staffing rule that says "0.7 a tick" and cannot say what for is a rule nobody can
  //    plan around, and an idle game is mostly planning.
  const goal = api.gemGoal ? api.gemGoal() : null;
  const gemJobs = Object.entries(api.jobs).filter(([, j]) => j.produces === 'gems');
  if (goal && goal.rate > 0) for (const [k] of gemJobs) {
    out.push({ key: 'gems', job: k, by: 'output', work: goal.rate / gemJobs.length, why: goal.why });
  }

  // 3. DRILL. No work target: the drill hall is worth filling to the roof, and the building is
  //    the one that says how high the roof is.
  const slots = api.slots('training');
  if (slots > 0) out.push({ key: 'drill', job: 'training', by: 'promise', work: Infinity,
                            why: `${slots} slot${slots === 1 ? '' : 's'} for the most promising` });
  return out;
}

// ---------- staying put ----------
//
// A trade is proved by staying at one job. classes.js hands one out after 120 ticks at a single
// job, and every rank above that is a standard held across a window of work at that same bench,
// so a roster reshuffled on every press of the button never earns a trade. The old staffing
// pass would move a Master Blacksmith to the turnips because the turnips scored higher that
// afternoon, and neither the smith nor the town was shown what was lost.
//
// So staffing reads a tradesman's own bench as worth more than it is and every other bench as
// worth less. The adjustment applies to the ranking only, never to the production: a Blacksmith
// still smiths at exactly the rate they smith at, and a post that genuinely needs bodies still
// gets them. It changes who is picked; it does not add output. The needs are still counted in
// real work, which is why plan() keeps `pick` and `rate` apart.
//
// The pull scales with rank: a Hand can be moved when the town is short, a Grandmaster
// effectively cannot. Read the other way, the same number is what it costs the town to take
// somebody away from the job they have become good at.
const TRADE_PULL = 0.15;      // per rank above nothing, both towards the bench and away from it

/** How much staffing over-values this character at this job, and under-values them anywhere else. */
function tradePull(c, job) {
  const cl = CL();
  if (!cl || !cl.tradeDef) return 1;
  const d = cl.tradeDef(c);
  if (!d) return 1;
  const grip = 1 + TRADE_PULL * (cl.ensureTrade(c).rank + 1);
  return d.job === job ? grip : 1 / grip;
}

/**
 * The same reluctance, in the units the drill hall ranks in. Promise is a sum of additive terms
 * (rare class 0.9, a trial 0.6) so this is subtracted rather than multiplied — a score can be
 * negative, and multiplying a negative by a penalty flatters it. A Grandmaster outweighs a rare
 * class and stays at the bench; a Hand with a trial waiting still goes and drills.
 */
function tradeDrag(c) {
  const cl = CL();
  if (!cl || !cl.tradeDef) return 0;
  const d = cl.tradeDef(c);
  return d ? 0.3 * (cl.ensureTrade(c).rank + 1) : 0;
}

/**
 * Assign everyone to the work the town needs doing, best hand first, needs before wants. `api`
 * supplies the town's own numbers so this file never re-derives them: outputFor(c, job),
 * slots(job), the job list, and optionally stock/eats/gemGoal (see demands()).
 * Returns the plan as [{ id, job }] plus what it did, without applying anything.
 */
function plan(state, api) {
  const jobs = Object.entries(api.jobs);
  const free = state.characters.filter(c => !c.mission);
  // Size the workforce by what a post banks over an HOUR, not by what its occupant happens to be
  // producing this second — otherwise a quota is filled by whoever is awake right now and comes
  // up a third short the moment the rota turns. api.sustained is the town's own hourly figure.
  //
  // RATE is what the town actually gets and is the only thing a quota is ever counted in. PICK is
  // that same number with the trade thumb on it, and is used for nothing but deciding who goes
  // where. Keeping them apart is what stops a Grandmaster's loyalty bonus from "filling" the
  // kitchen with meals nobody can eat.
  const rate = api.sustained ? (c, k) => api.sustained(c, k) : (c, k) => api.outputFor(c, k);
  const pick = (c, k) => rate(c, k) * tradePull(c, k);
  const taken = {}, secured = {};
  const assigned = new Map();
  // absolute aptitude levels, where a stage is 30: a floor of two stages in something that kills.
  // It is a floor and not a filter — most characters clear it — but a town of pure crafters
  // leaves the drill hall empty and goes to work instead. Anyone actually rare walks past it.
  const cutoff = api.trainingCutoff == null ? 60 : api.trainingCutoff;
  // ranked once, against the whole roster, so the shortlist for the drill hall is measured
  // against everybody rather than against itself
  const rank = promise(state, free);
  const worth = new Map(rank.ranked.map(x => [x.c.id, x]));
  const promising = (c) => {
    const x = worth.get(c.id);
    return !!x && drillable(x) && !(c.injured > 0) && (x.rare || x.trial || combatScore(c) >= cutoff);
  };

  const needs = demands(state, api);
  for (const need of needs) {
    const slots = api.slots(need.job);
    const pool = free.filter(c => !assigned.has(c.id) && rate(c, need.job) > 0);
    const drill = (c) => worth.get(c.id).score - tradeDrag(c);
    const queue = need.by === 'promise'
      ? pool.filter(promising).sort((a, b) => drill(b) - drill(a))
      : pool.sort((a, b) => pick(b, need.job) - pick(a, need.job));
    for (const c of queue) {
      if ((taken[need.job] || 0) >= slots) break;
      if ((secured[need.job] || 0) >= need.work) break;
      assigned.set(c.id, need.job);
      taken[need.job] = (taken[need.job] || 0) + 1;
      secured[need.job] = (secured[need.job] || 0) + rate(c, need.job);
    }
    need.hands = taken[need.job] || 0;
    need.got = secured[need.job] || 0;
    // MET and FULL are different answers and the town wants both. A one-slot campfire staffed by
    // the best cook alive is full and still not feeding anybody — reporting that as met is how a
    // player ends up staring at an empty larder wondering what the button did. Short because
    // nobody was spare is a staffing problem; short because the building has one seat is a
    // building problem, and only one of them is fixed by pressing the button again.
    need.full = need.hands >= slots;
    need.met = isFinite(need.work) ? need.got >= need.work : need.full;
  }

  // Everyone left takes the best-paying SEAT still open, best pairing first. Surplus is worth
  // having — crops build farms as well as feeding people — so a need is a floor, not a cap.
  //
  // A job with no building has no seats. It cannot fill up, so left in this pass it would absorb
  // people while a scarce bench stood empty behind it. It is held back for the sink below
  // instead, so maintenance is both the third priority and the last: a floor early, because the
  // gems have to come from somewhere, and then whatever is left once every real seat in town is
  // taken.
  const seated = jobs.filter(([k]) => k !== 'training' && isFinite(api.slots(k)));
  const sinks = jobs.filter(([k]) => k !== 'training' && !isFinite(api.slots(k)));
  const pairs = [];
  for (const c of free) {
    if (assigned.has(c.id)) continue;
    for (const [k] of seated) pairs.push({ id: c.id, job: k, value: pick(c, k) });
  }
  pairs.sort((a, b) => b.value - a.value);
  for (const p of pairs) {
    if (assigned.has(p.id)) continue;
    const slots = api.slots(p.job);
    if ((taken[p.job] || 0) >= slots) continue;
    if (p.value <= 0) continue;
    assigned.set(p.id, p.job);
    taken[p.job] = (taken[p.job] || 0) + 1;
  }

  // THE SINK. Nobody idles at the end of a staffing pass: an unplaced character is a character
  // resting, and resting eats without earning. Whoever is left goes to whichever unbounded job
  // suits them best, which today means everybody spare turns the town's maintenance.
  if (sinks.length) for (const c of free) {
    if (assigned.has(c.id)) continue;
    const best = sinks.map(([k]) => ({ k, v: pick(c, k) })).sort((a, b) => b.v - a.v)[0];
    if (!best || best.v <= 0) continue;
    assigned.set(c.id, best.k);
    taken[best.k] = (taken[best.k] || 0) + 1;
  }

  const out = [];
  for (const c of free) out.push({ id: c.id, name: c.name, from: c.job || null, job: assigned.get(c.id) || null });
  return { plan: out, needs, moved: out.filter(x => x.from !== x.job), trained: out.filter(x => x.job === 'training') };
}

const CrewAPI = {
  SOCIAL_TRAITS, MAX_BONUS, RAPPORT_RUNS, COMBAT_GROUPS,
  rollSocial, ensureSocial, teamwork, combatScore,
  ensure, find, create, remove, change, cohesion, seedPairs, membersOf, isFallen, tidy, mourn,
  FOOD_BUFFER, CATCHUP, foodChain, demands, plan,
  HONE_FILTERS, hone, honeTraits, honeReason, promise, armed, drillable,
  TRADE_PULL, tradePull, tradeDrag,
};
if (typeof module !== 'undefined') module.exports = CrewAPI;
if (typeof window !== 'undefined') window.Crew = CrewAPI;
})();
