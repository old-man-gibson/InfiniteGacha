// Identity and permanent death. Browser: window.Roster. Node: module.exports.
//
// A character is not a stat block that can be rolled again. It is a race, a face, a set of
// aptitudes and whatever it managed to learn, and when it dies that whole combination is retired:
// fingerprinted, written into the memorial, and locked out of the summoning pool forever. Nothing
// that walks back through the gate can be the same person.
//
// There are two locks.
//   uuid  the whole identity — race, body, every appearance layer and its colours, every
//         aptitude stage, the lexicon and the psionic axis order. Locking it means that exact
//         character cannot be summoned again.
//   face  appearance alone. A new character with a dead friend's face would read as the same
//         person, so faces are retired too.
//
// Aptitudes and skills are not locked on their own, by design: there are only so many aptitude
// spreads, and barring each one as its own dimension would make the pool run dry after a few
// dozen deaths, and the game could no longer summon. They are locked as part of the uuid, which
// is what "this character cannot be repeated" means.
//
// Every death in the game ends in fallAll() below (fall() is its one-character form): a Gate run,
// a contract, a call-off that applies deaths already on the map, an altar sacrifice. It retires the
// identity and also applies what the death costs the living: friends lose morale and teams lose
// rapport.

(() => {
const MAX_FALLEN = 500;      // the memorial is a list, not a leak
const REROLL_TRIES = 24;     // how hard summon() works to avoid a locked identity
const GRIEF_LINES = 4;       // grief lines written per death; every friend is still affected

// Optional collaborators, resolved on use. The browser loads this file before them, and a Node
// test that only needs identities does not load them at all.
const BO = () => (typeof Bonds !== 'undefined') ? Bonds : (typeof require !== 'undefined' ? require('./bonds.js') : null);
const CR = () => (typeof Crew !== 'undefined') ? Crew : (typeof require !== 'undefined' ? require('./crew.js') : null);
const CO = () => (typeof Condition !== 'undefined') ? Condition : (typeof require !== 'undefined' ? require('./condition.js') : null);

// Where grief and team lines go when the caller of fall() passes no `log`. Sacrifice.apply and
// Missions.finish have no logger of their own; game.js sets this to the town log.
let logger = null;
const setLog = (fn) => { logger = typeof fn === 'function' ? fn : null; };

/** FNV-1a, hex. Short, stable, and good enough to tell two characters apart. */
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const layerKey = (s) => [s.id, s.variant || '', ...(s.colors ? Object.entries(s.colors).map(([k, v]) => k + '=' + (v && v.name || v)) : [])].join('~');

/** What someone looks like: race, body and every appearance layer, in a stable order. */
function faceString(c) {
  const layers = (c.selections || []).map(layerKey).sort();
  return [c.race, c.bodyType, ...layers].join('|');
}

/** What someone IS: their face, plus every aptitude stage and everything they know. */
function identityString(c) {
  const profs = Object.entries(c.profs || {}).sort(([a], [b]) => a < b ? -1 : 1)
    .map(([k, p]) => `${k}:${p.stage}.${p.level}`);
  const words = (c.lexicon && (c.lexicon.words || c.lexicon)) || [];
  const skills = [
    ...(Array.isArray(words) ? words.slice().sort() : Object.keys(words).sort()),
    ...(c.psiOrder || []),
    ...Object.keys(c.techniques || {}).sort(),
  ];
  const mind = (c.mind && c.mind.traits || []).slice().sort();
  return [faceString(c), ...profs, ...skills, ...mind, (c.affinity && (c.affinity.id || c.affinity)) || ''].join('|');
}

const faceOf = (c) => hash(faceString(c));
const uuidOf = (c) => hash(identityString(c));

function ensure(state) {
  if (!state.roster) state.roster = { locked: {}, fallen: [] };
  if (!state.roster.locked) state.roster.locked = {};
  if (!state.roster.fallen) state.roster.fallen = [];
  return state.roster;
}

/** Is this candidate wearing a dead character's identity, or their face? */
function taken(state, c) {
  const r = ensure(state);
  return !!(r.locked[uuidOf(c)] || r.locked[faceOf(c)]);
}

/**
 * Roll until the candidate is nobody who has already died. `make()` returns a fresh candidate.
 * If the pool is somehow exhausted the last draw is used anyway: refusing to summon at all
 * would be a worse failure than a near-repeat nobody can see.
 */
function drawUnique(state, make, tries = REROLL_TRIES) {
  let c = make();
  for (let i = 1; i < tries && taken(state, c); i++) c = make();
  return c;
}

/**
 * The death path. `list` is every character dying in one event; `cause` is the memorial text
 * ('Spider Cave', 'Spider Cave: Goblin Warrior', 'sacrificed to Kess'), or a function of the
 * character that returns it, for an event in which each one died to something different
 * (sortie.js release). The steps run in this order:
 *   1. snapshot  Bonds.snapshot: who each of them was close to, before any pair is deleted
 *   2. fall      they leave the roster, their identity and face are locked, and a memorial record
 *                is written with the snapshot as `bonds` and a copy of c.record as `record`
 *   3. mourn     Bonds.mourn: each friend loses morale in proportion to the bond, and the dead
 *                character's pairs are deleted
 *   4. crew      Crew.mourn: every team that lost a member is scaled down
 * The characters in one call are snapshotted together and removed together, so two friends who die
 * in the same fight are in each other's snapshot and neither is told to grieve the other.
 * Idempotent per character: one already on the memorial is skipped and causes no second grief.
 * `log(text)` receives the grief and team lines; it defaults to the logger set by setLog().
 * Returns the memorial records in the order of `list`.
 */
function fallAll(state, list, { cause = 'a mission', at = Date.now(), log = logger } = {}) {
  const r = ensure(state);
  const bo = BO(), co = CO(), cr = CR();
  const fresh = [], seen = new Set();
  for (const c of list) {
    const uuid = uuidOf(c);
    if (seen.has(uuid) || r.fallen.some(f => f.uuid === uuid)) continue;
    seen.add(uuid);
    fresh.push(c);
  }

  // 1. snapshot
  const kin = new Map(fresh.map(c => [c, bo ? bo.snapshot(state, c, state.characters) : []]));

  // 2. fall
  const ids = new Set(list.map(c => c.id));
  state.characters = state.characters.filter(x => !ids.has(x.id));
  const made = new Map();
  for (const c of fresh) {
    const uuid = uuidOf(c), face = faceOf(c);
    r.locked[uuid] = 'identity';
    r.locked[face] = 'face';
    const entry = {
      uuid, face, id: c.id, name: c.name, race: c.race, bodyType: c.bodyType,
      stars: c.stats && c.stats.stars, cause: typeof cause === 'function' ? cause(c) || 'a mission' : cause, at,
      served: c.obtained ? at - c.obtained : 0,
      selections: c.selections,                              // enough to draw them on the wall
      aptitudes: Object.entries(c.profs || {})
        .filter(([, p]) => p.stage > 0)
        .sort((a, b) => b[1].stage - a[1].stage)
        .slice(0, 4)
        .map(([k, p]) => `${k} ${p.stage}`),
    };
    if (kin.get(c).length) entry.bonds = kin.get(c);
    if (c.record) entry.record = copyRecord(c.record);
    r.fallen.unshift(entry);
    made.set(c, entry);
  }
  r.fallen = r.fallen.slice(0, MAX_FALLEN);

  // 3. mourn
  const morale = co ? (o, d) => co.adjustMorale(o, d) : null;
  for (const c of fresh) {
    const entry = made.get(c);
    const felt = bo ? bo.mourn(state, c.id, state.characters, { morale }) : [];
    if (log) for (const f of felt.slice(0, GRIEF_LINES)) log(`${f.tier.icon || '\u{1F5A4}'} ${f.c.name} lost ${entry.name} (${f.tier.word}): morale -${Math.round(f.hit)}`);
  }

  // 4. crew
  if (cr && fresh.length) cr.mourn(state, log || (() => {}));

  return list.map(c => made.get(c) || r.fallen.find(f => f.uuid === uuidOf(c)));
}

/** One character dying: fallAll() for a list of one. Returns the memorial record. */
function fall(state, c, opts) {
  return fallAll(state, [c], opts)[0];
}

const fallen = (state) => ensure(state).fallen;
const lockedCount = (state) => Object.keys(ensure(state).locked).length;

// ---------- service record ----------
//
// c.record counts what a character has been through, for the party picker, the character sheet,
// the altar and the memorial. No code reads these numbers to decide an outcome; describeRecord()
// is the one place that turns them into words. Fields:
//   since      Date.now() when counting began: the summon for a new character, the first load after
//              this field existed for an older one
//   out        sorties and Gate runs the character came back from (Missions.debrief, once per
//              survivor). A character who dies is not debriefed, so the run that killed them is
//              not counted
//   won        of those, the runs whose objective was met
//   kills      enemies dropped by this character's own blow (combat.js kills[].killer.char)
//   witnessed  squad members who died on a run this character came back from
//   closeCall  the lowest end-of-fight HP fraction over all runs, with the mission and the time;
//              null until a fight left the character below full HP
//   last       the most recent run: mission, whether it was won, time; null before the first
// fallAll() copies the record onto the memorial entry.

// A label is a reading of `out` alone. It is computed when text is built and stored nowhere.
const RECORD_LABELS = [{ min: 20, word: 'veteran' }, { min: 8, word: 'seasoned' }, { min: 3, word: '' }, { min: 0, word: 'new' }];

const blankRecord = (at = Date.now()) => ({ since: at, out: 0, won: 0, kills: 0, witnessed: 0, closeCall: null, last: null });

/** c.record, made now when the character has none (a character built outside summon() and load() in game.js). */
const recordOf = (c, at = Date.now()) => c.record || (c.record = blankRecord(at));

const copyRecord = (r) => r && { ...r, closeCall: r.closeCall && { ...r.closeCall }, last: r.last && { ...r.last } };

/**
 * One run ended with `c` back home (Missions.debrief calls this once per survivor). `won` is
 * whether the objective was met, `fallen` how many of the squad died on it, `low` the lowest
 * end-of-fight HP fraction `c` had (undefined: no fight), `where` the mission name.
 */
function noteSortie(c, { won = false, fallen = 0, low, where = null, at = Date.now() } = {}) {
  const r = recordOf(c, at);
  r.out++;
  if (won) r.won++;
  r.witnessed += fallen;
  if (typeof low === 'number' && low < 1 && (!r.closeCall || low < r.closeCall.low)) r.closeCall = { low: Math.round(low * 1000) / 1000, mission: where, at };
  r.last = { mission: where, won: !!won, at };
  return r;
}

/** Credit each enemy in a combat.js `kills` list to the party member whose blow dropped it. Returns how many were credited. */
function noteKills(kills) {
  let n = 0;
  for (const k of kills || []) {
    const c = k.killer && k.killer.char;
    if (c) { recordOf(c).kills++; n++; }
  }
  return n;
}

const pluralOf = (v, one, many = one + 's') => `${v} ${v === 1 ? one : many}`;
const dateText = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function agoText(ms) {
  const min = Math.floor(Math.max(0, ms) / 60000);
  if (min < 1) return 'just now';
  if (min < 120) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/**
 * The record as text, for every screen that shows one. `rec` is c.record or the copy on a memorial
 * entry; null gives null. `fallen` words the count for someone who is dead. Returns:
 *   label    'new' (under 3 sorties), '' (3 to 7), 'seasoned' (8 or more), 'veteran' (20 or more)
 *   counts   '14 sorties · 9 won · 31 kills · 2 squad deaths seen'
 *   brief    'seasoned, 14 sorties, last: won' (party card); 'no sorties yet' before the first
 *   confirm  '14 sorties, 31 kills' (altar confirmation)
 *   closest  'lowest HP 12% on Goblin Camp, 3 h ago', or null
 *   last     'won on Goblin Camp, 3 h ago', or null
 *   since    'record starts 2026-10-24'
 *   legend   what each count counts and where the label thresholds are (character sheet)
 *   title    counts, closest call, last sortie, start date and label thresholds, one per line (tooltips)
 */
function describeRecord(rec, { now = Date.now(), fallen = false } = {}) {
  if (!rec) return null;
  const label = RECORD_LABELS.find(l => rec.out >= l.min).word;
  const sorties = pluralOf(rec.out, 'sortie');
  const counts = [fallen ? `survived ${sorties}` : sorties, `${rec.won} won`, pluralOf(rec.kills, 'kill'), `${pluralOf(rec.witnessed, 'squad death')} seen`].join(' · ');
  const at = (x) => `${x.mission ? ` on ${x.mission}` : ''}, ${agoText(now - x.at)}`;
  const closest = rec.closeCall ? `lowest HP ${Math.round(rec.closeCall.low * 100)}%${at(rec.closeCall)}` : null;
  const last = rec.last ? `${rec.last.won ? 'won' : 'not won'}${at(rec.last)}` : null;
  const brief = rec.out ? [label, sorties, rec.last ? `last: ${rec.last.won ? 'won' : 'not won'}` : null].filter(Boolean).join(', ') : 'no sorties yet';
  const since = `record starts ${dateText(rec.since)}`;
  const scale = 'new: under 3 sorties; seasoned: 8 or more; veteran: 20 or more';
  const legend = `sorties: contracts and Gate runs the character came back from. won: those whose objective was met. kills: enemies dropped by their own blow. squad deaths seen: squad members who died on those runs. ${scale}. No game rule reads these counts or the label.`;
  const title = [counts, closest && `closest call: ${closest}`, last && `last sortie: ${last}`, since, scale].filter(Boolean).join('\n');
  return { label, counts, brief, confirm: `${sorties}, ${pluralOf(rec.kills, 'kill')}`, closest, last, since, legend, title };
}

const RosterAPI = {
  hash, faceOf, uuidOf, faceString, identityString, ensure, taken, drawUnique, fall, fallAll, setLog, fallen, lockedCount, MAX_FALLEN, GRIEF_LINES,
  RECORD_LABELS, blankRecord, recordOf, copyRecord, noteSortie, noteKills, describeRecord,
};
if (typeof module !== 'undefined') module.exports = RosterAPI;
if (typeof window !== 'undefined') window.Roster = RosterAPI;
})();
