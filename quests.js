// Advancement trials: the quests a character passes to gain a star. Browser: window.Quests.
// Node: module.exports.
//
// A star cannot be bought. Every tier-up is a trial rolled for one named character, and it can be
// taken two ways — ALONE or WITH A PARTY — which are different missions with different terms.
// The solo road asks whether this one person can do a thing by themselves and is the shorter,
// nastier version of it; the group road asks for something nobody does alone and lets the rest
// of the roster carry some of it. Same star at the end of either.
//
// The trials also decide fusion. classes.js opens a class fusion slot on the third tier-up and
// another on the sixth, and the count is per character. A 1-star taken all the way to 7 has passed
// six trials and comes out holding three disciplines; a 5-star pulled straight from the gate has
// two trials left in it and fuses nothing at all. The long road is the only road to a fused
// character, and under permanent death the long road is also the one where they die.
//
// Item costs are placeholders. `items` currently names town resources because those are what
// exist. They are meant to be trial-specific things — a beast's heart, a sealed writ — and the
// shape of the field is already right for that: swap the keys when the items exist.
//
// This file rolls trials and says whether one can be attempted. It does not run them: a trial IS
// a field mission (missiontypes.js), so sortie.js launches and settles it like any other, and
// the only special thing about it is `mission.trial`, which says who it belongs to.

(() => {
const MT = () => (typeof MissionTypes !== 'undefined') ? MissionTypes : require('./missiontypes.js');
const ST = () => (typeof Stats !== 'undefined') ? Stats : require('./stats.js');
const CL = () => (typeof Classes !== 'undefined') ? Classes : (typeof require !== 'undefined' ? require('./classes.js') : null);

/**
 * Would passing this one open a class fusion slot? Read off the character's TIER-UP COUNT, never
 * off which star they are going to. The two coincide only for somebody who came through the gate
 * at 1★ — for a 3★ pull, the step to 4★ is their FIRST tier-up and opens nothing, and a card that
 * promised otherwise would be lying about the one thing the long road is for.
 */
function opensFusion(c) {
  const cl = CL();
  if (!cl) return false;
  return cl.FUSE_AT.includes(cl.tierUps(c) + 1);
}

const ROADS = ['solo', 'group'];

/**
 * One trial per star step, indexed by the star being LEFT: TRIALS[1] takes a 1-star to 2.
 * `level` is the field level the mission is rolled at, and it climbs steeply — the last trial is
 * harder than anything on the contract board.
 */
const TRIALS = {
  1: {
    star: 2, name: 'The First Proving', level: 4,
    blurb: 'The first rung, and the only one a fresh 1★ can realistically pass.',
    solo:  { type: 'duel', desc: 'One arena fight, alone.' },
    group: { type: 'extermination', desc: 'Clear a nest, 3–6 characters.' },
    items: { ore: 20 },
  },
  2: {
    star: 3, name: 'The Long Walk', level: 7,
    blurb: 'Unexplored ground. Party scouting decides how long this takes.',
    solo:  { type: 'recon', desc: 'Reveal the map alone.' },
    group: { type: 'escort', desc: 'Escort someone who cannot fight.' },
    items: { herbs: 60, crops: 40 },
  },
  3: {
    star: 4, name: 'The Weight of It', level: 10,
    blurb: 'Level 10 and the first real cost. The third tier-up for anyone summoned at 1★, so it opens a fusion slot.',
    solo:  { type: 'assassination', desc: 'Kill one named mark, alone.' },
    group: { type: 'dungeon', desc: 'Clear a multi-floor dungeon.' },
    items: { ore: 200, gems: 400 },
  },
  4: {
    star: 5, name: 'The Hard Road', level: 13,
    blurb: 'Level 13. Where solo attempts start costing characters.',
    solo:  { type: 'sabotage', desc: 'Destroy a target and get out.' },
    group: { type: 'hold', desc: 'Hold ground against waves.' },
    items: { ore: 400, herbs: 300 },
  },
  5: {
    star: 6, name: 'The Reckoning', level: 16,
    blurb: 'Level 16, and the cost is most of a stocked town.',
    solo:  { type: 'retrieval', desc: 'Retrieve an object and carry it out.' },
    group: { type: 'raid', desc: 'Raid a stronghold.' },
    items: { gems: 1500, ore: 600, herbs: 500 },
  },
  6: {
    star: 7, name: 'The Last Trial', level: 20,
    blurb: 'Level 20, harder than anything on the contract board. Sixth tier-up, so it opens the second fusion slot.',
    solo:  { type: 'assassination', desc: 'Kill an elite mark, alone.' },
    group: { type: 'siege', desc: 'Break a siege line, 3–6 characters.' },
    items: { gems: 4000, ore: 1200, crops: 1000, herbs: 1000 },
  },
};

/** The party size each road asks for. Solo is one body, and the mission is bent to accept that. */
const PARTY = { solo: [1, 1], group: [3, 6] };

const MAX_STAR = () => ST().MAX_STARS;
/** The trial standing between this character and its next star, or null when there is none left. */
const trialFor = (c) => (c.stats.stars >= MAX_STAR() ? null : TRIALS[c.stats.stars] || null);

// ---------- offering ----------
const ensure = (state) => (state.trials = state.trials || {});

/**
 * Roll (or reuse) this character's trial. Both roads are rolled at once so the choice is a real
 * one made on what the two missions actually ask for, not a coin flip on a hidden roll. Kept on
 * the town rather than the character so it saves as plain data next to the rest of the field.
 */
function offer(state, c, { force = false } = {}) {
  const spec = trialFor(c);
  if (!spec) return null;
  const held = ensure(state)[c.id];
  if (!force && held && held.star === spec.star) return held;

  const mt = MT();
  const roll = (road) => {
    const m = mt.roll(spec[road].type, { level: spec.level, name: spec.name });
    m.boardId = `trial:${c.id}:${spec.star}:${road}`;
    m.party = PARTY[road].slice();
    m.trial = { charId: c.id, charName: c.name, star: spec.star, road, fusion: opensFusion(c) };
    m.blurb = `${spec.blurb} — ${spec[road].desc}`;
    m.label = `${spec.name} · ${road === 'solo' ? 'alone' : 'with a party'}`;
    return m;
  };
  const made = { star: spec.star, from: c.stats.stars, rolledAt: Date.now(), solo: roll('solo'), group: roll('group') };
  ensure(state)[c.id] = made;
  return made;
}

/** Throw the current offer away so the next one is a fresh pair of missions. */
function reroll(state, c) { delete ensure(state)[c.id]; return offer(state, c); }

/** Everybody with a trial in front of them right now, with both roads rolled. */
function offers(state) {
  return state.characters
    .filter(c => trialFor(c) && !c.mission && !(c.injured > 0))
    .map(c => ({ c, spec: trialFor(c), offer: offer(state, c) }))
    .filter(o => o.offer);
}

// ---------- attempting ----------
/** What the trial costs to attempt, and whether the town can pay it. */
function cost(c) { const spec = trialFor(c); return spec ? spec.items : null; }
function affordable(state, c) {
  const items = cost(c);
  if (!items) return true;
  return Object.entries(items).every(([k, v]) => (state[k] || 0) >= v);
}

/** Can this character go for it, and if not, why not. */
function ready(state, c) {
  const spec = trialFor(c);
  if (!spec) return { ok: false, why: `${c.name} is already ${c.stats.stars}★` };
  if (c.mission) return { ok: false, why: `${c.name} is already out` };
  if (c.injured > 0) return { ok: false, why: `${c.name} is still recovering` };
  if (!affordable(state, c)) return { ok: false, why: 'the town cannot cover what it costs' };
  return { ok: true, why: '' };
}

/**
 * The mission for one road, once. Pays the cost — a trial attempted is a trial paid for, won or
 * lost, because a road you walked and failed still cost the town what it took to open it.
 * Returns the mission to hand to the field runner, or { error }.
 */
function begin(state, c, road) {
  if (!ROADS.includes(road)) return { error: 'no such road' };
  const gate = ready(state, c);
  if (!gate.ok) return { error: gate.why };
  const made = offer(state, c);
  if (!made) return { error: 'no trial to take' };
  const items = cost(c) || {};
  for (const [k, v] of Object.entries(items)) state[k] = (state[k] || 0) - v;
  return { mission: made[road], paid: items };
}

/**
 * The trial was passed. `advance` is the town's own tier-up (game.js advanceCharacter), which
 * raises the star, lifts the aptitudes and counts the tier-up that opens a fusion slot — this
 * file does not reach into any of that, it only decides that the trial is over.
 * Returns what happened, so somebody can say it out loud.
 */
function pass(state, c, advance) {
  const cl = CL();
  const slotsBefore = cl ? cl.fusionSlots(c) : 0;
  delete ensure(state)[c.id];
  const ok = advance(c);
  return { ok, star: c.stats.stars, fusion: ok && cl ? cl.fusionSlots(c) > slotsBefore : false };
}

/** The trial was failed. It stays offered, but as a different pair of missions. */
function fail(state, c) { return reroll(state, c); }

/** Drop the offers of characters who no longer exist. */
function tidy(state) {
  const live = new Set(state.characters.map(c => c.id));
  for (const id of Object.keys(ensure(state))) if (!live.has(Number(id)) && !live.has(id)) delete state.trials[id];
}

function describe(c) {
  const spec = trialFor(c);
  if (!spec) return null;
  return {
    name: spec.name, blurb: spec.blurb, star: spec.star, level: spec.level, fusion: opensFusion(c),
    tierUps: CL() ? CL().tierUps(c) : 0,
    items: spec.items,
    roads: ROADS.map(r => ({ road: r, desc: spec[r].desc, type: spec[r].type, party: PARTY[r] })),
  };
}

const QuestsAPI = {
  TRIALS, ROADS, PARTY,
  trialFor, offer, offers, reroll, cost, affordable, ready, begin, pass, fail, tidy, describe, opensFusion,
};
if (typeof module !== 'undefined') module.exports = QuestsAPI;
if (typeof window !== 'undefined') window.Quests = QuestsAPI;
})();
