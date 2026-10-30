// Mission types: the kinds of work a party can be sent to do, the map each kind wants, who
// else is standing on it, and the terms that end it. Data and pure functions only — no
// simulation, no rendering, and nothing wired into missions.js or the town loop yet.
// Browser: window.MissionTypes. Node: module.exports.
//
// This sits ABOVE missions.js, which owns the bestiary, the zone list and the tick-driven
// encounter runner. A zone answers "where"; a type answers "what are we doing there", and the
// same zone can be exterminated, scouted or besieged. Species are deliberately absent here:
// a type asks for a grade (missions.js TIERS) and a theme (bestiary tags), and the hook-up
// step picks the monsters.
//
// Every mission is three things:
//
//   MAP    an archetype (wilds, road, settlement, dungeon, stronghold, arena) that a generator
//          fills in at launch. See MAPS.
//   CAST   groups of actors, each with a ROLE: the squad, a ward, a garrison, a mark, a gate.
//   TERMS  win and lose conditions, written as lists of small OBJECTIVE atoms. See OBJ, FAIL.
//
// There are twelve win atoms and eight fail atoms, and every type in TYPES is an arrangement
// of them. A mission runner therefore implements twenty checks and never learns what the word
// "escort" means; a new mission type is a data entry rather than new code. When a type wants
// something the atoms cannot express, the atom set is short — that is not licence to branch on
// type inside the runner.
//
// TWISTS cut across every type: night, a storm, reinforcements, a turncoat. They are rolled
// per mission, they multiply the reward, and none of them is a type of its own.
//
// TIME. A mission plays in front of the player as a log while the characters move themselves.
// The clock runs at TIME.scale in-game seconds per real second and advances one in-game second
// per step, so a step lands every TIME.stepMs of wall time and a twenty-minute battle is four
// minutes of watching. Every duration in this file is IN-GAME SECONDS; realClock() converts
// for the player-facing estimate. This is a second clock: the town keeps ticking at its own
// ten seconds while a mission is on the map.
//
// Maps are generated at launch and never seeded — Rng is cryptographic and has no stream to
// replay (rng.js) — so a mission in progress is saved as its tiles, not as a seed. Nothing
// here holds a value JSON cannot: "everyone" is the string 'all', never Infinity, which
// stringifies to null, which would turn "all of them" into "none of them" on reload.

(() => {
const R = (typeof Rng !== 'undefined') ? Rng : require('./rng.js');

const TIME = {
  scale: 5,      // in-game seconds per real second
  step: 1,       // in-game seconds advanced per simulation step
  stepMs: 200,   // = 1000 * step / scale, wall time between steps
};
const MIN = 60;  // in-game seconds, for readable durations below
const realSeconds = (gameSeconds) => gameSeconds / TIME.scale;
const realClock = (gameSeconds) => {
  const s = Math.round(realSeconds(gameSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// ---------- maps ----------
//
// `gen` names the generator that fills an archetype in. Five of the seven come free from
// rot.js (ROT.Map.Cellular / Uniform / Digger / Rogue / Arena), which also carries the field of
// view, the A* and the Dijkstra pathing the actors need to walk themselves around. `route` and
// `settlement` are ours: neither a road with flanking ground nor a walled town with gates falls
// out of a dungeon generator. rot.js draws layouts, not art — the tiles on top are ours (the
// LPC set the character generator already uses has matching terrain).
//
// size is [w, h] in tiles at level 1 and grows slowly with level. cover is the fraction of
// floor carrying something that breaks line of sight. exits are edges an actor can leave by;
// the extraction point is always one of them.

const MAPS = {
  wilds:      { label: 'Wilds',      gen: 'cellular',   size: [64, 44], floors: 1, cover: 0.45, exits: 3, features: ['cover', 'extraction'] },
  ruins:      { label: 'Ruins',      gen: 'uniform',    size: [56, 40], floors: 1, cover: 0.35, exits: 2, features: ['cover', 'doors', 'chokepoints', 'extraction'] },
  road:       { label: 'Road',       gen: 'route',      size: [96, 32], floors: 1, cover: 0.20, exits: 2, features: ['route', 'ambush', 'extraction'] },
  settlement: { label: 'Settlement', gen: 'settlement', size: [64, 48], floors: 1, cover: 0.25, exits: 4, features: ['walls', 'gates', 'keep', 'structures'] },
  outpost:    { label: 'Outpost',    gen: 'settlement', size: [40, 32], floors: 1, cover: 0.20, exits: 2, features: ['walls', 'gates', 'keep', 'spawners'] },
  warren:     { label: 'Warren',     gen: 'cellular',   size: [52, 38], floors: 2, cover: 0.15, exits: 1, features: ['stairs', 'spawners', 'nest'] },
  dungeon:    { label: 'Dungeon',    gen: 'digger',     size: [48, 36], floors: 4, cover: 0.10, exits: 1, features: ['doors', 'traps', 'stairs', 'spawners', 'treasure'] },
  stronghold: { label: 'Stronghold', gen: 'rogue',      size: [52, 40], floors: 2, cover: 0.15, exits: 2, features: ['doors', 'patrols', 'chokepoints', 'keep'] },
  arena:      { label: 'Arena',      gen: 'arena',      size: [28, 22], floors: 1, cover: 0.05, exits: 0, features: [] },
};

// ---------- cast ----------
//
// A role says what an actor is FOR, which is all the runner and the objectives need. Grades are
// the bestiary tiers from missions.js; themes are bestiary tags, so a nest reads as beasts and
// a garrison as humanoids without this file naming a single monster. A cast entry may carry
// `side` ('ours' | 'theirs' | 'neutral'), `at` (where it starts), and `per` ('floor' | 'wave' |
// 'minute' | 'phase' | 'bout') when the count is per repetition rather than for the map.

const ROLES = {
  squad:     { label: 'Squad',     side: 'ours',   note: 'The characters the player sent' },
  ward:      { label: 'Ward',      side: 'ours',   note: 'Escorted: walks itself, slower, fights poorly or not at all' },
  ally:      { label: 'Ally',      side: 'ours',   note: 'Fights alongside, but not the player’s to lose' },
  prize:     { label: 'Prize',     side: 'either', note: 'An object that must be carried out; whoever holds it fights worse' },
  hostile:   { label: 'Hostile',   side: 'theirs', note: 'Rank and file' },
  patrol:    { label: 'Patrol',    side: 'theirs', note: 'Walks a circuit and raises the alarm before it fights' },
  mark:      { label: 'Mark',      side: 'theirs', note: 'A named target; screened by others, and runs when hurt' },
  structure: { label: 'Structure', side: 'either', note: 'Gate, wall, trap, works, node: has hp or a timer, does not move' },
  civilian:  { label: 'Civilian',  side: 'either', note: 'Scatters, and counts against the town if killed' },
};

const GRADES = ['basic', 'veteran', 'elite', 'ancient', 'legendary'];  // missions.js TIERS

// The bestiary tier a grade draws its species from. The bestiary has no 'ancient' tier, so an
// ancient group uses the elite species pool and is spawned at a higher level (sortie.js
// GRADE_BUMP). Mapping it to 'legendary' made a level-1 dungeon guardian a Giant Spider Queen.
// Read by fieldview.js namer and test/field.harness.js.
const SPECIES_TIER = { basic: 'basic', veteran: 'veteran', elite: 'elite', ancient: 'elite', legendary: 'legendary' };

// ---------- objective atoms ----------
//
// Win atoms: predicates the runner evaluates against live mission state. A mission is won when
// every atom in its `win` list reads true at the same moment. A count of 'all' means everyone
// or everything of that kind.

const OBJ = {
  kill:      (count, of = 'hostile')      => ({ atom: 'kill', count, of }),          // n of a role are dead
  eliminate: (who = 'mark')               => ({ atom: 'eliminate', who }),           // one named actor is dead
  subdue:    (who = 'mark')               => ({ atom: 'subdue', who }),              // ...and taken alive instead
  destroy:   (what, count = 1)            => ({ atom: 'destroy', what, count }),     // n of their structures are down
  gather:    (count, of = 'node')         => ({ atom: 'gather', count, of }),        // n nodes worked to the end
  reach:     (zone, who = 'squad', n = 1) => ({ atom: 'reach', zone, who, n }),      // n of who stand in a zone
  hold:      (zone, seconds)              => ({ atom: 'hold', zone, seconds }),      // that zone, uncontested, that long
  survive:   (seconds, n = 1)             => ({ atom: 'survive', seconds, n }),      // n still standing at the bell
  protect:   (who)                        => ({ atom: 'protect', who }),             // who is alive when it ends
  extract:   (who = 'squad', n = 1)       => ({ atom: 'extract', who, n }),          // n of who left by an exit alive
  // n is a number, 'all' (everyone who set out, so nobody died) or 'living' (everyone
  // still standing, which is the walk home every contract now ends with — see EXITS)
  descend:   (floors)                     => ({ atom: 'descend', floors }),          // the squad reached that floor
  reveal:    (fraction, of = 'map')       => ({ atom: 'reveal', fraction, of }),     // that much of it has been seen
};

// Fail atoms: the first one that reads true ends the mission, whatever the win list says.

const FAIL = {
  wipe:     (standing = 0) => ({ atom: 'wipe', standing }),   // squad down to this many or fewer
  died:     (who)          => ({ atom: 'died', who }),        // someone we were keeping alive fell
  killed:   (who)          => ({ atom: 'killed', who }),      // someone we needed alive was killed by us
  timeout:  ()             => ({ atom: 'timeout' }),          // the clock ran out
  breached: (what)         => ({ atom: 'breached', what }),   // one of ours fell: gate, keep, ward-stone
  lost:     (zone)         => ({ atom: 'lost', zone }),       // ground we were holding was taken
  fled:     (who)          => ({ atom: 'fled', who }),        // a target left the map alive
  spotted:  (budget = 0)   => ({ atom: 'spotted', budget }),  // detection went past its budget
};

const WIN_ATOMS = Object.keys(OBJ);
const FAIL_ATOMS = Object.keys(FAIL);

// ---------- the way home ----------
//
// Every contract ends with a walk out. It used to end the instant its last box was ticked, which
// is why an assassination finished with the killer standing over the body and three people still
// somewhere in the fortress, and why holding a point ended mid-siege with nobody going anywhere.
// A mission is not over when the work is done; it is over when the people who did it are home.
//
// So `roll` appends `extract('squad', 'living')` — everyone still standing is out — to every win
// list, and the only thing a type chooses is where and when there is a door. That is one axis
// with three settings, and it is read off what the contract already is rather than named per
// type: a job with a clock is tense, a job about ground is a siege, everything else is a job.
//
//   gate       The way home has to be opened. Walk to the extraction point once the work is
//              done and stand there while it forms. The ordinary contract.
//   window     It is already open — that is how they got in — but it is being held open by
//              somebody else and it does not last. Miss it and it SHUTS, and the map now knows
//              exactly where they are; the next one is minutes away and they have to live that
//              long. This is what a deadline means now: not a mission lost to a clock, but a
//              much worse way home.
//   standfast  There is nothing to walk back to, because the job was standing still. The moment
//              the terms are met the way home opens WHERE THEY ARE, and they may step through
//              at any second — or hold the ground longer, which is worth more and costs more.
//
// The three are not three behaviours; they are one portal with a different rule about when it
// is open, and field.js has one function for it.

const EXITS = { gate: 'gate', window: 'window', standfast: 'standfast' };

// How the portal behaves, in in-game seconds.
const PORTAL = {
  open: 20,             // standing at the point before a `gate` forms: long enough to be a beat
  window: 75,           // how long an open `window` stays open, once it starts closing
  cycle: [180, 300],    // 3-5 in-game minutes before whoever holds it can force it open again
  // Multiples of a defence's own clock it may run on past its terms. Set so that a squad that
  // is still in one piece reaches it: the payout curve tops out at the cap, and a cap nobody can
  // reach would make the number printed on the button wrong.
  overtime: 0.35,
  pay: 0.6,             // ...and what holding all the way to that cap adds to the contract
};

/**
 * Which of the three a contract uses. A type may name its own; otherwise the shape of the work
 * decides. Ground-holding orders mean there is nowhere to walk back to, and a clock means the
 * way home is somebody else's schedule, not the squad's.
 */
function exitFor(spec) {
  if (spec.exitMode) return spec.exitMode;
  if (spec.orders === 'hold') return EXITS.standfast;
  if (spec.deadline) return EXITS.window;
  return EXITS.gate;
}

// ---------- behaviour ----------
//
// `orders` is the squad's default stance and is what ai.js plans against; a character with poor
// acumen follows it loosely, which is where most of the drama in the log will come from.
// `pressure` is how the other side behaves, and is what makes two missions on one map differ.

const ORDERS = {
  hunt:   'Seek contact, clear the map',
  push:   'Advance on the objective and fight through whatever is standing on it',
  guard:  'Stay within reach of the ward, never chase',
  hold:   'Own a piece of ground and give none of it',
  avoid:  'Break contact, keep moving, come home',
  strike: 'Reach the mark; ignore anything that is not in the way',
  delve:  'Downward, carefully: doors, then traps, then the room',
  work:   'Hold a loose ring around whoever is working, and rotate',
};

const PRESSURE = {
  nest:      'Holds ground, drifts toward noise',
  garrison:  'Waits behind the walls, sallies when a wall is threatened',
  patrol:    'Walks circuits, and calls the rest the moment it sees you',
  ambush:    'Springs on the route, then commits',
  waves:     'Arrives in sets, with a lull between them',
  endless:   'Arrives without a lull, and keeps getting worse',
  wandering: 'Room by room, plus whatever the noise wakes',
  bodyguard: 'Screens the mark while the mark runs',
  quarry:    'Runs for its own exit and spends the rearguard to buy time',
};

// ---------- scaling ----------
// Levels match missions.js zones (1 at the meadow, 18 at the brood mother). Everything below
// interpolates between its level-1 and its level-18 value and keeps going past that.

const at = (level, lo, hi) => lo + (hi - lo) * (level - 1) / 17;
const ati = (level, lo, hi) => Math.max(0, Math.round(at(level, lo, hi)));
const total = (cast, role) => cast.filter(g => g.role === role).reduce((s, g) => s + (g.count || 0), 0);

// ---------- what the paper says ----------
//
// A contract is written by somebody, and what they knew varies. A nest the villagers have been
// watching for a week is described down to the species; a stronghold nobody has been inside is a
// wall and a rumour. INTEL is that, per type, and it is the only thing deciding whether a brief
// reads "Cave Spider lvl 6 ×12" or "??? lvl 6 ×~10".
//
// It is deliberately NOT a measure of how dangerous the work is. A recon pays well and tells you
// nothing, because not knowing is the job. And it is not the whole answer either: knowing that a
// thing is called a Cave Spider tells you nothing about Cave Spiders — that comes from the town's
// own bestiary, which fills the row in only as far as somebody has earned it (bestiary.js).
//
//   3  named and counted        Cave Spider lvl 6 ×12
//   2  named, counted loosely   Cave Spider lvl 6 ×~10
//   1  a count and nothing else ??? lvl 6 ×~10
//   0  that something is there  ??? ×?

const INTEL = {
  extermination: 2,   // people have been losing animals to it and they have watched it happen
  siege: 3,           // you can stand outside a wall and count what is on it
  escort: 1,          // nobody knows what is on the road until it is on the road
  dungeon: 1,         // a hole in the ground with a door on it
  survival: 2,        // they have held this ground before and know what comes
  recon: 0,           // finding out IS the contract
  assassination: 2,   // one name is the whole paper; the household around it is a guess
  hold: 2, retrieval: 1, rescue: 1, pursuit: 2, sabotage: 1,
  expedition: 0,      // nobody has been
  raid: 2, capture: 2,
  duel: 3,            // an arena bill is printed in advance
};
const INTEL_MAX = 3;

// ---------- hordes ----------
//
// A basic-grade group fielded at level eighteen is currently twenty-six Forest Rats each seven
// times the size of a Forest Rat, which is not a thing anybody can picture. A weak species does
// not get frightening as the work gets harder — there is just more of it. So a group whose grade
// sits below what its level would normally field turns up as a HORDE instead: the same weight of
// enemy delivered in more and smaller bodies, and arriving in packs rather than spread evenly
// over a map (mapgen.js `packs`), because a horde you meet a few at a time is not a horde.
//
// The grade gap is the only input. One grade under its level is a pack, three grades under is a
// tide. Nothing here names a species or decides anything is a rat: swarming depends only on how
// far a group sits below its level, which is why one rule turns the level-fourteen goblin camp
// into an army and leaves the level-two one exactly as it was.
//
// This is only survivable because of frontage (combat.js): how many of them can reach you at once
// is set by the ground, so a horde in a corridor is a long fight and a horde in the open is a
// short one. Without frontage, the larger counts would make the fight unwinnable.

const NATIVE = (lv) => (lv >= 17 ? 3 : lv >= 12 ? 2 : lv >= 6 ? 1 : 0);   // the grade a level expects
const HORDE_SWELL = 2.2;   // bodies per body, per grade of gap
// How far under the mission each body is spawned, per grade of gap. CALIBRATED, not guessed:
// damage taken in a fight goes as (how many can reach you) x (how many there are), not as the
// square of the weight, so a horde that merely conserved the group's old threat wiped a squad of
// five every time. At 4.5 a level a grade, a pack of nine costs about what the three full-grade
// monsters it replaced cost — and it costs it the other way round, worse in the open and better
// in a doorway, which is the entire reason the ground now matters.
const HORDE_STEP = 4.5;
const HORDE_CAP = 40;      // and a ceiling, because a map has to hold them and a player has to watch
// A `per` group is the repetition mechanic already — a wave, a floor, a minute — so swelling it
// multiplies a thing that was going to happen twelve times. It gets a tighter ceiling: a wave of
// twenty reads as a wave, and twelve of them is still a mission somebody can sit through.
const HORDE_CAP_PER = 20;
const HORDE_PACK = [0, 5, 9, 14];   // how many arrive together, by gap
const HORDE_ROLES = new Set(['hostile', 'patrol']);   // a mark is one named thing; it never swarms
const HORDE_WORD = ['', 'a pack', 'a swarm', 'a tide'];

/**
 * What a cast group actually turns up as. At or above the grade its level expects it comes as
 * written; below it, it swells. A swarmed group carries `horde` (the gap, so anything downstream
 * can say so), `levelOffset` (how far under the mission each body is spawned) and `pack` (how
 * many of them the map should stand together).
 */
function swarm(group, lv) {
  if (!HORDE_ROLES.has(group.role) || !group.grade || group.noSwarm) return group;
  const gap = Math.min(HORDE_PACK.length - 1, NATIVE(lv) - GRADES.indexOf(group.grade));
  if (gap < 1) return group;
  const count = Math.min(group.per ? HORDE_CAP_PER : HORDE_CAP, Math.round(group.count * Math.pow(HORDE_SWELL, gap)));
  if (count <= group.count) return group;
  return { ...group, count, horde: gap, levelOffset: -Math.round(HORDE_STEP * gap), pack: HORDE_PACK[gap] };
}

/** What a horde reads as, for a brief or a log line: 'a swarm of veterans'. */
const hordeWord = (gap) => HORDE_WORD[Math.max(0, Math.min(HORDE_WORD.length - 1, gap || 0))];

// ---------- types ----------
//
// A DEADLINE is a story, not a default. Most work takes as long as it takes: a nest does not
// stop being a nest at six o'clock, and a dungeon does not close. Only a mission where something
// else is moving — a caravan expected somewhere, a prisoner due to be moved, a quarry with a
// head start, an alarm that brings relief — carries `deadline: true` and can be lost to the
// clock. Everything else keeps `duration` purely as the ESTIMATE shown to the player, and ends
// when the job is done, the squad is broken, or they decide they have had enough.
//
// Each entry: what it is, which maps it can be rolled on, party size, how the cast and the
// clock scale with level, and the terms. `bonus` atoms are optional — met they pay extra, missed
// nothing happens. `variants` are the same type under different terms, chosen at roll time and
// never mixed. `theme` lists the bestiary tags the cast should be drawn from. terms() is handed
// (level, cast, spec) so a type can read back its own scaling.

const TYPES = {
  extermination: {
    label: 'Extermination', icon: '⚔️',
    blurb: 'A nest has grown too close. Nothing to carry and nobody to keep alive: make the count and walk out.',
    maps: ['wilds', 'ruins', 'warren'],
    theme: ['beast', 'vermin', 'slime', 'goblin'],
    party: [2, 5], reward: 1,
    orders: 'hunt', pressure: 'nest',
    duration: (lv) => ati(lv, 15, 30) * MIN,
    cast: (lv) => [
      { role: 'hostile', grade: 'basic',   count: ati(lv, 8, 26) },
      { role: 'hostile', grade: 'veteran', count: ati(lv, 0, 10) },
      { role: 'hostile', grade: 'elite',   count: lv >= 8 ? ati(lv, 0, 3) : 0 },
    ],
    terms: (lv, cast) => ({
      win:   [OBJ.kill(Math.ceil(total(cast, 'hostile') * 0.8))],
      lose:  [FAIL.wipe(), FAIL.timeout()],
      bonus: [OBJ.kill(total(cast, 'hostile')), OBJ.extract('squad', 'all')],
    }),
    track: 'kill',
  },

  siege: {
    label: 'Siege', icon: '🏰',
    blurb: 'Walls, gates and a keep — and one side of them is yours.',
    maps: ['settlement', 'outpost'],
    theme: ['humanoid', 'goblin', 'undead', 'construct'],
    party: [4, 8], reward: 2,
    duration: (lv) => ati(lv, 20, 35) * MIN,
    variants: {
      assault: {
        label: 'Assault', orders: 'push', pressure: 'garrison',
        blurb: 'Break the gate, take the keep, put down whoever is holding it.',
        cast: (lv) => [
          { role: 'structure', kind: 'gate', count: 1, hp: ati(lv, 400, 3000), side: 'theirs' },
          { role: 'hostile', grade: 'basic',   count: ati(lv, 10, 30), at: 'walls' },
          { role: 'hostile', grade: 'veteran', count: ati(lv, 2, 12), at: 'keep' },
          { role: 'mark', grade: 'elite', count: 1, at: 'keep', name: 'commander' },
          { role: 'civilian', count: ati(lv, 0, 8) },
        ],
        terms: () => ({
          win:   [OBJ.destroy('gate'), OBJ.reach('keep'), OBJ.eliminate('commander')],
          lose:  [FAIL.wipe(), FAIL.timeout()],
          bonus: [OBJ.protect('civilian')],
        }),
      },
      defense: {
        label: 'Defense', orders: 'hold', pressure: 'waves',
        blurb: 'They came to us. Keep the gate shut and the keep standing until they have had enough.',
        cast: (lv) => [
          { role: 'structure', kind: 'gate', count: 1, hp: ati(lv, 600, 2500), side: 'ours' },
          { role: 'structure', kind: 'keep', count: 1, hp: ati(lv, 900, 4000), side: 'ours' },
          { role: 'hostile', grade: 'basic',   count: ati(lv, 14, 46) },
          { role: 'hostile', grade: 'veteran', count: ati(lv, 2, 14) },
          { role: 'hostile', grade: 'elite',   count: lv >= 10 ? 1 : 0, at: 'last-wave' },
        ],
        terms: (lv) => ({
          win:   [OBJ.survive(ati(lv, 12, 25) * MIN, 1), OBJ.protect('keep')],
          lose:  [FAIL.breached('keep'), FAIL.wipe()],
          bonus: [OBJ.protect('gate')],
        }),
      },
    },
    track: 'objective',
  },

  escort: {
    label: 'Escort', icon: '🛡️',
    blurb: 'Someone who cannot fight has to be somewhere else, and the road knows it.',
    maps: ['road', 'wilds'],
    theme: ['humanoid', 'beast', 'goblin'],
    party: [3, 6], reward: 1.5,
    deadline: true,
    exit: 'far',            // a delivery: the extraction point is the far end, not the way in
    orders: 'guard', pressure: 'ambush',
    duration: (lv) => ati(lv, 12, 22) * MIN,
    cast: (lv) => [
      { role: 'ward', count: 1, speed: 0.7, frail: true },
      { role: 'hostile', grade: 'basic',   count: ati(lv, 6, 22), at: 'route' },
      { role: 'hostile', grade: 'veteran', count: ati(lv, 1, 9), at: 'route' },
      { role: 'mark', grade: 'elite', count: lv >= 7 ? 1 : 0, at: 'route', name: 'ambusher' },
    ],
    terms: () => ({
      win:   [OBJ.extract('ward'), OBJ.protect('ward')],
      lose:  [FAIL.died('ward'), FAIL.wipe(), FAIL.timeout()],
      bonus: [OBJ.extract('squad', 'all')],
    }),
    track: 'route',
  },

  dungeon: {
    label: 'Dungeon clear', icon: '🕳️',
    blurb: 'Down one stairway at a time. Doors, traps, and something at the bottom that was left there on purpose.',
    maps: ['dungeon'],
    theme: ['undead', 'construct', 'vermin', 'slime', 'arcane'],
    party: [3, 6], reward: 2,
    orders: 'delve', pressure: 'wandering',
    // Sized against how long a floor actually takes now that the squad has to FIND the stairs
    // rather than walk at them: a digger floor costs eight to ten in-game minutes to search, so
    // eight floors was a mission nobody could finish inside any clock worth watching.
    duration: (lv) => ati(lv, 30, 55) * MIN,
    floors: (lv) => ati(lv, 2, 5),
    cast: (lv) => [
      { role: 'hostile', grade: 'basic',   count: ati(lv, 5, 12), per: 'floor' },
      { role: 'hostile', grade: 'veteran', count: ati(lv, 1, 6), per: 'floor' },
      { role: 'hostile', grade: 'elite',   count: 1, at: 'floor-end' },
      { role: 'mark', grade: lv >= 12 ? 'legendary' : lv >= 6 ? 'ancient' : 'elite', count: 1, at: 'last-floor', name: 'guardian' },
      { role: 'structure', kind: 'trap', count: ati(lv, 4, 14), per: 'floor', side: 'theirs' },
    ],
    terms: (lv) => ({
      win:   [OBJ.descend(ati(lv, 2, 5)), OBJ.eliminate('guardian'), OBJ.extract('squad')],
      lose:  [FAIL.wipe(), FAIL.timeout()],
      bonus: [OBJ.reveal(0.9, 'floors'), OBJ.extract('squad', 'all')],
    }),
    track: 'floor',
  },

  survival: {
    label: 'Survival', icon: '⏳',
    blurb: 'Ground that will not be given up. Stand on it while the count runs.',
    maps: ['outpost', 'ruins', 'arena'],
    theme: ['beast', 'goblin', 'undead', 'slime'],
    party: [3, 8], reward: 1.5,
    duration: (lv) => ati(lv, 12, 25) * MIN,
    variants: {
      waves: {
        label: 'Waves', orders: 'hold', pressure: 'waves',
        blurb: 'They come in sets. The lull between sets is short, and it is all the rest there is.',
        waves: (lv) => ati(lv, 4, 12),
        lull: (lv) => ati(lv, 45, 20),   // in-game seconds of recovery between waves; shrinks with level
        cast: (lv) => [
          { role: 'hostile', grade: 'basic',   count: ati(lv, 5, 15), per: 'wave' },
          { role: 'hostile', grade: 'veteran', count: ati(lv, 0, 6), per: 'wave', from: 3 },
          { role: 'hostile', grade: 'elite',   count: 1, at: 'last-wave' },
        ],
        terms: (lv) => ({
          win:   [OBJ.survive(ati(lv, 10, 22) * MIN, ati(lv, 1, 3))],
          lose:  [FAIL.wipe()],
          bonus: [OBJ.survive(ati(lv, 10, 22) * MIN, 'all')],
        }),
      },
      endless: {
        label: 'Hardcore', orders: 'hold', pressure: 'endless',
        blurb: 'No lull and no ceiling. It ends when the last of them is down, and they are not the last of them.',
        scored: true,                    // the reward reads the clock, not a win flag
        ramp: (lv) => 0.04 + lv * 0.01,  // extra hostile budget per in-game minute
        cast: (lv) => [
          { role: 'hostile', grade: 'basic',   count: ati(lv, 4, 10), per: 'minute' },
          { role: 'hostile', grade: 'veteran', count: ati(lv, 1, 5), per: 'minute', from: 4 },
        ],
        terms: (lv) => ({
          win:   [OBJ.survive(ati(lv, 8, 15) * MIN, 1)],   // the threshold that pays; past it is score
          lose:  [FAIL.wipe()],
          bonus: [],
        }),
      },
    },
    track: 'clock',
  },

  recon: {
    label: 'Recon', icon: '🔭',
    blurb: 'Look at it, remember it, come home. A fight here is a failure that has not been declared yet.',
    maps: ['stronghold', 'wilds', 'ruins'],
    theme: ['humanoid', 'goblin', 'beast'],
    party: [1, 3], reward: 1,
    orders: 'avoid', pressure: 'patrol',
    duration: (lv) => ati(lv, 10, 20) * MIN,
    cast: (lv) => [
      { role: 'patrol',  grade: 'veteran', count: ati(lv, 3, 10) },
      { role: 'hostile', grade: 'basic',   count: ati(lv, 6, 20), at: 'garrison' },
      { role: 'hostile', grade: 'elite',   count: lv >= 8 ? ati(lv, 0, 3) : 0, at: 'garrison' },
    ],
    terms: (lv) => ({
      win:   [OBJ.reveal(at(lv, 0.5, 0.8), 'objective'), OBJ.extract('squad', 'all')],
      lose:  [FAIL.wipe(), FAIL.timeout()],
      bonus: [OBJ.reveal(1, 'objective'), FAIL.spotted(0)],   // never seen: paid for, not required
    }),
    track: 'reveal',
  },

  assassination: {
    label: 'Assassination', icon: '🎯',
    blurb: 'One name on the paper. Everything else on the map is between you and it.',
    maps: ['stronghold', 'settlement', 'ruins'],
    theme: ['humanoid', 'unique', 'undead'],
    party: [2, 4], reward: 2.5,
    deadline: true,
    orders: 'strike', pressure: 'bodyguard',
    duration: (lv) => ati(lv, 12, 20) * MIN,
    cast: (lv) => [
      { role: 'mark', grade: lv >= 12 ? 'legendary' : lv >= 6 ? 'ancient' : 'elite', count: 1, name: 'target', at: 'deep', flees: true },
      { role: 'hostile', grade: 'elite',   count: ati(lv, 2, 6), at: 'bodyguard' },
      { role: 'patrol',  grade: 'veteran', count: ati(lv, 2, 8) },
      { role: 'hostile', grade: 'basic',   count: ati(lv, 6, 18) },
    ],
    terms: () => ({
      win:   [OBJ.eliminate('target'), OBJ.extract('squad', 1)],
      lose:  [FAIL.wipe(), FAIL.timeout(), FAIL.fled('target')],
      bonus: [FAIL.spotted(2), OBJ.extract('squad', 'all')],
    }),
    track: 'objective',
  },

  // ---- the second batch: ground, objects, people, and one very large animal ----

  hold: {
    label: 'Hold the point', icon: '🚩',
    blurb: 'A bridge, a well, a crossroads. Stand on it until the relief comes, and do not step off it.',
    maps: ['ruins', 'outpost', 'road'],
    theme: ['humanoid', 'goblin', 'beast'],
    party: [3, 6], reward: 1.5,
    orders: 'hold', pressure: 'waves',
    duration: (lv) => ati(lv, 14, 26) * MIN,
    cast: (lv) => [
      { role: 'hostile', grade: 'basic',   count: ati(lv, 10, 34) },
      { role: 'hostile', grade: 'veteran', count: ati(lv, 2, 12) },
      { role: 'hostile', grade: 'elite',   count: lv >= 9 ? ati(lv, 0, 3) : 0 },
    ],
    // A fraction of the mission's own clock rather than a separate ladder: they have to walk
    // there before anything counts, and they get knocked off it, so a requirement set in
    // absolute minutes drifts out of reach as the duration curve moves under it.
    terms: (lv, cast, spec) => ({
      win:   [OBJ.hold('point', Math.round(spec.duration(lv) * 0.55))],
      lose:  [FAIL.lost('point'), FAIL.wipe()],
      bonus: [OBJ.protect('squad')],
    }),
    track: 'hold',
  },

  retrieval: {
    label: 'Retrieval', icon: '📦',
    blurb: 'It is behind something, it is heavier than it looks, and whoever carries it fights one-handed.',
    maps: ['stronghold', 'ruins', 'dungeon'],
    theme: ['undead', 'construct', 'humanoid', 'arcane'],
    party: [3, 5], reward: 2,
    orders: 'strike', pressure: 'garrison',
    duration: (lv) => ati(lv, 14, 24) * MIN,
    cast: (lv) => [
      { role: 'prize', kind: 'relic', count: 1, at: 'vault', sealed: ati(lv, 20, 90), carry: 0.75 },  // seconds to open, carrier speed
      { role: 'hostile', grade: 'basic',   count: ati(lv, 6, 20), at: 'vault' },
      { role: 'hostile', grade: 'veteran', count: ati(lv, 2, 9) },
      { role: 'hostile', grade: 'elite',   count: lv >= 10 ? 1 : 0, at: 'vault' },
    ],
    terms: () => ({
      win:   [OBJ.reach('vault'), OBJ.extract('prize')],
      lose:  [FAIL.wipe(), FAIL.timeout()],
      bonus: [OBJ.extract('squad', 'all')],
    }),
    track: 'objective',
  },

  rescue: {
    label: 'Rescue', icon: '⛓️',
    blurb: 'Escort played backwards: quiet all the way in, and the whole way out with the alarm already up.',
    maps: ['stronghold', 'settlement', 'dungeon'],
    theme: ['humanoid', 'goblin', 'undead'],
    party: [3, 5], reward: 2,
    deadline: true,
    orders: 'avoid', pressure: 'patrol',
    duration: (lv) => ati(lv, 14, 26) * MIN,
    cast: (lv) => [
      { role: 'ward', count: 1, at: 'cells', speed: 0.7, frail: true, captive: true },
      { role: 'patrol',  grade: 'veteran', count: ati(lv, 2, 8) },
      { role: 'hostile', grade: 'basic',   count: ati(lv, 8, 24) },
      { role: 'hostile', grade: 'elite',   count: lv >= 9 ? ati(lv, 1, 3) : 0, at: 'cells' },
    ],
    terms: () => ({
      win:   [OBJ.reach('cells'), OBJ.extract('ward'), OBJ.protect('ward')],
      lose:  [FAIL.died('ward'), FAIL.wipe(), FAIL.timeout()],
      bonus: [FAIL.spotted(0), OBJ.extract('squad', 'all')],
    }),
    track: 'objective',
  },

  pursuit: {
    label: 'Pursuit', icon: '🏇',
    blurb: 'It has a head start and men to spend buying more of it. Run it down before the map does.',
    maps: ['road', 'wilds', 'ruins'],
    theme: ['humanoid', 'beast', 'goblin'],
    party: [2, 5], reward: 2,
    deadline: true,
    orders: 'hunt', pressure: 'quarry',
    duration: (lv) => ati(lv, 8, 16) * MIN,
    cast: (lv) => [
      { role: 'mark', grade: lv >= 12 ? 'ancient' : lv >= 5 ? 'elite' : 'veteran', count: 1, name: 'quarry', at: 'mid', flees: true, speed: 0.7, escapesAt: 'far-exit' },
      { role: 'hostile', grade: 'veteran', count: ati(lv, 2, 8), at: 'rearguard' },
      { role: 'hostile', grade: 'basic',   count: ati(lv, 4, 14), at: 'route' },
    ],
    terms: () => ({
      win:   [OBJ.eliminate('quarry')],
      lose:  [FAIL.fled('quarry'), FAIL.wipe(), FAIL.timeout()],
      bonus: [OBJ.extract('squad', 'all')],
    }),
    track: 'chase',
  },

  sabotage: {
    label: 'Sabotage', icon: '💣',
    blurb: 'A few things have to stop working, and the alarm going up is the clock you are working against.',
    maps: ['settlement', 'stronghold', 'outpost'],
    theme: ['humanoid', 'construct', 'goblin'],
    party: [2, 5], reward: 2,
    deadline: true,
    orders: 'strike', pressure: 'patrol',
    // the works are scattered and have to be FOUND before they can be broken; the old clock was
    // written when the squad walked straight at them
    duration: (lv) => ati(lv, 16, 26) * MIN,
    cast: (lv) => [
      { role: 'structure', kind: 'works', count: ati(lv, 2, 5), hp: ati(lv, 150, 900), side: 'theirs' },
      { role: 'patrol',  grade: 'veteran', count: ati(lv, 3, 10) },
      { role: 'hostile', grade: 'basic',   count: ati(lv, 8, 26) },
    ],
    terms: (lv) => ({
      win:   [OBJ.destroy('works', ati(lv, 2, 5)), OBJ.extract('squad', 1)],
      lose:  [FAIL.wipe(), FAIL.timeout()],
      bonus: [FAIL.spotted(1), OBJ.extract('squad', 'all')],
    }),
    track: 'objective',
  },

  expedition: {
    label: 'Expedition', icon: '⛏️',
    blurb: 'The good ground is the dangerous ground. Work it, fill the packs, and be gone before dark.',
    maps: ['wilds', 'warren', 'ruins'],
    theme: ['beast', 'vermin', 'slime'],
    party: [3, 6], reward: 1.25,
    payout: 'resources',              // pays crops, ore and herbs rather than gems
    orders: 'work', pressure: 'nest',
    duration: (lv) => ati(lv, 16, 28) * MIN,
    cast: (lv) => [
      { role: 'structure', kind: 'node', count: ati(lv, 5, 12), side: 'neutral', harvest: ati(lv, 20, 45) },
      { role: 'hostile', grade: 'basic',   count: ati(lv, 6, 20) },
      { role: 'hostile', grade: 'veteran', count: ati(lv, 1, 7) },
    ],
    terms: (lv) => ({
      win:   [OBJ.gather(ati(lv, 4, 9)), OBJ.extract('squad', 1)],
      lose:  [FAIL.wipe(), FAIL.timeout()],
      bonus: [OBJ.gather(ati(lv, 5, 12)), OBJ.extract('squad', 'all')],
    }),
    track: 'gather',
  },

  raid: {
    label: 'Raid', icon: '🐉',
    blurb: 'One enormous thing that changes how it fights twice before it dies, and it never fights alone.',
    maps: ['warren', 'dungeon', 'arena', 'ruins'],
    theme: ['unique', 'huge', 'large', 'construct'],
    party: [4, 8], reward: 3,
    orders: 'push', pressure: 'nest',
    duration: (lv) => ati(lv, 12, 22) * MIN,
    phases: (lv) => ati(lv, 2, 4),
    cast: (lv) => [
      { role: 'mark', grade: lv >= 10 ? 'legendary' : 'ancient', count: 1, name: 'colossus', at: 'nest', flees: false, phases: ati(lv, 2, 4) },
      { role: 'hostile', grade: 'veteran', count: ati(lv, 2, 8), per: 'phase' },
      { role: 'hostile', grade: 'basic',   count: ati(lv, 4, 12), per: 'phase' },
    ],
    terms: () => ({
      win:   [OBJ.eliminate('colossus')],
      lose:  [FAIL.wipe(), FAIL.timeout()],
      bonus: [OBJ.protect('squad')],
    }),
    track: 'boss',
  },

  capture: {
    label: 'Capture', icon: '🪢',
    blurb: 'They want it breathing, which is the opposite of everything the squad is good at.',
    maps: ['settlement', 'stronghold', 'wilds'],
    theme: ['humanoid', 'goblin', 'beast'],
    party: [3, 5], reward: 2.5,
    deadline: true,
    orders: 'strike', pressure: 'bodyguard',
    duration: (lv) => ati(lv, 12, 20) * MIN,
    cast: (lv) => [
      { role: 'mark', grade: lv >= 12 ? 'ancient' : lv >= 5 ? 'elite' : 'veteran', count: 1, name: 'quarry', at: 'deep', flees: true, subdueAt: 0.15 },
      { role: 'hostile', grade: 'veteran', count: ati(lv, 2, 7), at: 'bodyguard' },
      { role: 'hostile', grade: 'basic',   count: ati(lv, 5, 16) },
    ],
    terms: () => ({
      win:   [OBJ.subdue('quarry'), OBJ.extract('quarry')],
      lose:  [FAIL.killed('quarry'), FAIL.fled('quarry'), FAIL.wipe(), FAIL.timeout()],
      bonus: [OBJ.extract('squad', 'all')],
    }),
    track: 'objective',
  },

  duel: {
    label: 'Arena', icon: '🏟️',
    blurb: 'No ground to take and nothing to carry. A card, a crowd, and the other side of the sand.',
    maps: ['arena'],
    theme: ['humanoid', 'beast', 'unique'],
    party: [1, 4], reward: 1.5,
    orders: 'hunt', pressure: 'nest',
    duration: (lv) => ati(lv, 6, 12) * MIN,
    bouts: (lv) => ati(lv, 1, 5),
    cast: (lv) => [
      { role: 'hostile', grade: 'veteran', count: ati(lv, 1, 3), per: 'bout' },
      { role: 'hostile', grade: 'elite',   count: lv >= 8 ? 1 : 0, at: 'last-bout' },
    ],
    terms: () => ({
      win:   [OBJ.kill('all')],
      lose:  [FAIL.wipe()],
      bonus: [OBJ.protect('squad')],
    }),
    track: 'bout',
  },
};

// ---------- side jobs ----------
//
// Optional work that a MEMBER takes, not the squad. Every side job names the aptitudes it wants;
// at launch the best-qualified character in the party peels off to do it while everyone else
// carries on with the contract, which is where the drama is: the marksman is not where the line
// is, and whether that was worth it is decided afterwards.
//
// `effect` is what finishing it does, and it is the reason these are not just extra rewards:
//   quiet     the alarm never spreads — the detection budget is wiped
//   win       the mission ends there and then, in success
//   reward    it pays, and nothing else changes
//   escalate  the taker decides the contract was not ambitious enough and makes it worse
//
// `spawn` lets a side job bring its own cast: a captain to shoot exists because somebody was
// paid to shoot a captain.

const SIDE_JOBS = {
  silence: {
    id: 'silence', label: 'Leave no witnesses', icon: '🔪',
    desc: 'Every patrol that could carry word, before it carries any',
    on: ['recon', 'rescue', 'retrieval', 'sabotage', 'assassination', 'capture'],
    needs: ['dagger', 'bow', 'unarmed', 'psionics'],
    atom: (lv, cast) => OBJ.kill(Math.max(2, total(cast, 'patrol')), 'patrol'),
    effect: 'quiet', reward: 1.3,
  },
  decapitate: {
    id: 'decapitate', label: 'Take the captain', icon: '🎯',
    desc: 'Their line holds because one person is holding it',
    on: ['siege', 'hold', 'survival', 'extermination', 'expedition'],
    needs: ['bow', 'dagger', 'spear', 'arcana'],
    spawn: (lv) => ({ role: 'mark', grade: lv >= 10 ? 'ancient' : 'elite', count: 1, name: 'captain', at: 'deep' }),
    atom: () => OBJ.eliminate('captain'),
    effect: 'win', reward: 1.45,
  },
  plunder: {
    id: 'plunder', label: 'Strip the place', icon: '💰',
    desc: 'There is more down here than the contract mentions',
    on: ['dungeon', 'retrieval', 'ruins', 'raid', 'siege', 'sabotage'],
    needs: ['smithing', 'alchemy', 'foraging', 'maintenance'],
    spawn: (lv) => ({ role: 'structure', kind: 'cache', count: ati(lv, 2, 5), side: 'neutral' }),
    atom: (lv) => OBJ.gather(ati(lv, 2, 5), 'cache'),
    effect: 'reward', reward: 1.6,
  },
  overreach: {
    id: 'overreach', label: 'Press their luck', icon: '🎲',
    desc: 'Somebody decides the terms were not ambitious enough, and makes the job worse on purpose',
    on: ['extermination', 'siege', 'dungeon', 'recon', 'retrieval', 'raid', 'sabotage', 'expedition', 'hold'],
    trait: 'gambler',            // taken by a temperament, not by a skill
    effect: 'escalate', reward: 2.4,
  },
};

/** Nothing, usually. One when the work is worth somebody's ambition; two almost never. */
function rollSideJobs(typeId, level = 1, max = 2) {
  const legal = Object.values(SIDE_JOBS).filter(j => j.on.includes(typeId));
  const out = [];
  let odds = at(level, 0.25, 0.6);
  while (out.length < max && legal.length) {
    const pool = legal.filter(j => !out.includes(j.id));
    if (!pool.length || !R.chance(odds)) break;
    out.push(R.pick(pool).id);
    odds *= 0.3;
  }
  return out;
}

// ---------- twists ----------
//
// Complications, not types: they apply on top of whatever the mission already is, they change
// how it is played rather than how it is won, and they multiply the reward. `only` and `not`
// keep the nonsense out — there is no night in a dungeon, and nothing to betray in an arena.

const TWISTS = {
  night:          { label: 'Night',          weight: 14, reward: 1.15, not: ['dungeon', 'duel'],
                    desc: 'Sight is halved both ways, and patrols walk shorter circuits' },
  storm:          { label: 'Storm',          weight: 10, reward: 1.15, not: ['dungeon', 'duel'],
                    desc: 'Slow ground, smothered fire, and nothing with a bowstring works' },
  reinforcements: { label: 'Reinforcements', weight: 12, reward: 1.3,  not: ['duel'],
                    desc: 'A second garrison arrives partway through, from the wrong direction' },
  dry:            { label: 'No resupply',    weight: 10, reward: 1.25,
                    desc: 'Pools do not recover between beats: what they arrive with is what they get' },
  infested:       { label: 'Infested',       weight: 10, reward: 1.35,
                    desc: 'A third of the cast comes one grade up' },
  hunted:         { label: 'Hunted',         weight: 8,  reward: 1.4,  not: ['duel', 'arena'],
                    desc: 'Something follows the squad and joins whichever fight is going worst' },
  hardcore:       { label: 'Hardcore',       weight: 9,  reward: 1.6,  not: ['duel'],
                    desc: 'Going wrong does not end it. The job changes into getting out alive' },
  turncoat:       { label: 'Turncoat',       weight: 5,  reward: 1.5,  only: ['escort', 'rescue', 'retrieval', 'siege'],
                    desc: 'Someone on the map is not what the contract said they were' },
  trap:           { label: 'A trap',         weight: 6,  reward: 1.5,  only: ['recon', 'escort', 'expedition', 'retrieval', 'pursuit'],
                    desc: 'The contract was wrong about what this is, and says so partway in' },
};

// What a hardcore contract becomes when it goes wrong. Every one of them collapses to the same
// terms — get somebody out alive, on a short clock, with the map turning hostile behind them —
// because that is what actually happens when a job fails: the objective stops mattering and the
// walk home becomes the whole mission. Only the words and the pressure differ.
const ESCALATION = {
  extermination: { line: 'The nest is awake. All of it.', pressure: 'endless', seconds: 4 * MIN },
  siege:         { line: 'The gate opens behind them and the garrison comes out.', pressure: 'endless', seconds: 4 * MIN },
  escort:        { line: 'The ward is dead. There is no contract any more, only the road back.', pressure: 'ambush', seconds: 4 * MIN },
  dungeon:       { line: 'Whatever is down here knows they are here.', pressure: 'wandering', seconds: 5 * MIN },
  survival:      { line: 'The line breaks. Fall back.', pressure: 'endless', seconds: 3 * MIN },
  recon:         { line: 'Something in there heard them. The map is not the problem now.', pressure: 'patrol', seconds: 4 * MIN },
  assassination: { line: 'The mark got word out. Every blade in the place is coming.', pressure: 'endless', seconds: 3 * MIN },
  hold:          { line: 'The ground is lost. Getting off it is the job now.', pressure: 'endless', seconds: 3 * MIN },
  retrieval:     { line: 'The vault is sealed and the alarm is everywhere at once.', pressure: 'garrison', seconds: 4 * MIN },
  rescue:        { line: 'The cells are empty and the halls are not.', pressure: 'garrison', seconds: 4 * MIN },
  pursuit:       { line: 'It got away, and it did not go alone.', pressure: 'ambush', seconds: 3 * MIN },
  sabotage:      { line: 'The works are burning, and so is the way out.', pressure: 'endless', seconds: 3 * MIN },
  expedition:    { line: 'They dug into something that was already down there.', pressure: 'nest', seconds: 4 * MIN },
  raid:          { line: 'It is not dying, and it is not finished.', pressure: 'endless', seconds: 3 * MIN },
  capture:       { line: 'Taking it alive is off the table. So is staying.', pressure: 'endless', seconds: 3 * MIN },
  default:       { line: 'It has gone wrong. Get them out.', pressure: 'endless', seconds: 4 * MIN },
};

/** Complications for one mission. Higher level means more of them, more often; three is rare. */
function rollTwists(typeId, level = 1, max = 2) {
  const legal = Object.entries(TWISTS)
    .filter(([, t]) => (!t.only || t.only.includes(typeId)) && !(t.not || []).includes(typeId))
    .map(([id, t]) => ({ id, weight: t.weight }));
  const out = [];
  let odds = at(level, 0.2, 0.6);
  while (out.length < max) {
    const pool = legal.filter(t => !out.includes(t.id));
    if (!pool.length || !R.chance(odds)) break;
    out.push(R.weightedPick(pool).id);
    odds *= 0.35;
  }
  return out;
}

// ---------- rolling a concrete mission ----------

const PLACES = ['Ashfen', 'Corrow', 'the Drowned Steps', 'Grey Harrow', 'Kell', 'the Mourning Wood', 'Old Vantage', 'Rethis', 'Saltmarch', 'the Sunken Mile', 'Thornwake', 'Var Adun'];
const TITLES = {
  extermination: ['Culling at %', 'The nest at %', 'Nothing left at %'],
  siege:         ['The walls of %', 'Siege of %', '% will not hold'],
  escort:        ['The road to %', 'Passage to %', 'Safe to %'],
  dungeon:       ['Beneath %', 'The deep of %', 'Down through %'],
  survival:      ['The line at %', 'Hold at %', 'Last watch at %'],
  recon:         ['Eyes on %', 'The measure of %', 'A look at %'],
  assassination: ['A name at %', 'One death at %', 'Quiet work at %'],
  hold:          ['The stand at %', 'Ground at %', 'Not one step at %'],
  retrieval:     ['The vaults of %', 'What is kept at %', 'Lifted from %'],
  rescue:        ['The cells of %', 'Out of %', 'Nobody left at %'],
  pursuit:       ['Run down from %', 'The road out of %', 'Before it reaches %'],
  sabotage:      ['The works at %', 'Nothing runs at %', 'Break %'],
  expedition:    ['The dig at %', 'A season at %', 'Taken from %'],
  raid:          ['The thing under %', 'What sleeps at %', 'The great beast of %'],
  capture:       ['Alive from %', 'A prisoner from %', 'Hands on %'],
  duel:          ['The sand at %', 'The card at %', 'Bouts at %'],
};

const variantsOf = (typeId) => (TYPES[typeId] && TYPES[typeId].variants) ? Object.keys(TYPES[typeId].variants) : [];

/** Merge a type with one of its variants; the variant wins wherever the two overlap. */
function resolve(typeId, variant = null) {
  const t = TYPES[typeId];
  if (!t) throw new Error('unknown mission type: ' + typeId);
  if (!t.variants) return { ...t, id: typeId, variant: null };
  const key = (variant && t.variants[variant]) ? variant : R.pick(Object.keys(t.variants));
  return { ...t, ...t.variants[key], id: typeId, variant: key, variants: t.variants };
}

function mapFor(spec, level) {
  const key = R.pick(spec.maps);
  const base = MAPS[key];
  const grow = 1 + (level - 1) * 0.02;
  return {
    archetype: key, label: base.label, gen: base.gen,
    w: Math.round(base.size[0] * grow), h: Math.round(base.size[1] * grow),
    floors: spec.floors ? spec.floors(level) : base.floors,
    cover: base.cover, exits: base.exits, features: base.features.slice(),
  };
}

/**
 * Build a concrete mission from a type and a level. The result is plain data — numbers, strings
 * and atoms — so it saves and reloads as-is, and the map is a spec rather than tiles.
 */
/**
 * The walk home, appended to a win list. An existing squad extraction is UPGRADED rather than
 * duplicated: several types asked for one body through the door, which is the bug this fixes.
 * Cargo extractions (a ward, a relic, a prisoner) are left exactly as written.
 */
function withWalkHome(win) {
  const out = win.filter(a => !(a.atom === 'extract' && (!a.who || a.who === 'squad')));
  out.push(OBJ.extract('squad', 'living'));
  return out;
}

function roll(typeId, { level = 1, variant = null, name = null, twists = null, sideJobs = null } = {}) {
  const spec = resolve(typeId, variant);
  const lv = Math.max(1, Math.round(level));
  const map = mapFor(spec, lv);
  // ...and then whoever is out of their depth turns up in numbers instead (see hordes above).
  // The terms are read off the swarmed cast, so an extermination that swelled asks for the count
  // it actually has to make rather than the one it was written with.
  const cast = spec.cast(lv).filter(g => (g.count || 0) > 0).map(g => swarm(g, lv));
  // side jobs can bring their own cast, so they are settled before the terms are read
  const side = (sideJobs || rollSideJobs(spec.id, lv)).filter(id => SIDE_JOBS[id]);
  for (const id of side) {
    const j = SIDE_JOBS[id];
    if (j.spawn) cast.push({ ...j.spawn(lv), forSide: id });
  }
  const terms = spec.terms(lv, cast, spec);
  const exitMode = exitFor(spec);
  const tw = twists || rollTwists(spec.id, lv);
  const place = R.pick(PLACES);
  return {
    type: spec.id, variant: spec.variant, level: lv,
    label: TYPES[spec.id].label + (spec.variant ? ` — ${spec.variants[spec.variant].label}` : ''),
    name: name || R.pick(TITLES[spec.id]).replace('%', place),
    icon: TYPES[spec.id].icon,
    blurb: spec.blurb,
    map, cast, theme: spec.theme.slice(),
    exit: spec.exit || 'entry',
    party: spec.party,
    reward: +(spec.reward * tw.reduce((m, id) => m * TWISTS[id].reward, 1)).toFixed(2),
    payout: spec.payout || 'gems',
    twists: tw,
    deadline: !!spec.deadline,
    // how much of the cast below the player is allowed to read before pressing go (see INTEL).
    // Rolled per contract: two nests on the same board are not described equally well.
    intel: Math.max(0, Math.min(INTEL_MAX, (INTEL[spec.id] === undefined ? 1 : INTEL[spec.id]) + R.randInt(-1, 1))),
    // the functions are resolved here and dropped: a mission has to survive JSON
    side: side.map(id => {
      const { spawn, atom, ...j } = SIDE_JOBS[id];
      return { ...j, atom: atom ? atom(lv, cast) : null, done: false, taker: null };
    }),
    orders: spec.orders, pressure: spec.pressure,
    exitMode,
    duration: spec.duration(lv),
    waves: spec.waves ? spec.waves(lv) : null,
    lull: spec.lull ? spec.lull(lv) : null,
    ramp: spec.ramp ? spec.ramp(lv) : null,
    phases: spec.phases ? spec.phases(lv) : null,
    bouts: spec.bouts ? spec.bouts(lv) : null,
    scored: !!spec.scored,
    track: spec.track,
    // Nothing is finished until the people who did it are home, so the walk out is appended
    // here rather than written eighteen times — and it is written as "everyone still standing",
    // not as `1`, which is what let an assassination end with one runner through the door.
    win: withWalkHome(terms.win),
    // The clock no longer fails a mission. On a `window` contract running it out shuts the way
    // home instead, which is harder on the squad and more eventful to watch; on everything else
    // it was only ever an estimate. A mission fails when the squad cannot go on.
    lose: terms.lose.filter(a => a.atom !== 'timeout'),
    bonus: terms.bonus || [],
  };
}

// ---------- reading one back ----------

const PLURAL = { civilian: 'civilians', ally: 'allies' };
const some = (n) => n === 'all' ? 'Everyone' : n === 1 ? 'Someone' : `At least ${n}`;
const ATOM_TEXT = {
  kill:      (a) => a.count === 'all' ? `Kill every ${a.of}` : `Kill ${a.count} ${a.of}${a.count === 1 ? '' : 's'}`,
  eliminate: (a) => `Kill the ${a.who}`,
  subdue:    (a) => `Take the ${a.who} alive`,
  destroy:   (a) => a.count > 1 ? `Bring down ${a.count} ${a.what}` : `Bring down the ${a.what}`,
  gather:    (a) => `Work ${a.count} ${a.of}s to the end`,
  reach:     (a) => `Reach the ${a.zone}`,
  hold:      (a) => `Hold the ${a.zone} for ${realClock(a.seconds)}`,
  survive:   (a) => `${some(a.n)} still standing after ${realClock(a.seconds)}`,
  protect:   (a) => `Keep the ${PLURAL[a.who] || a.who} alive`,
  extract:   (a) => a.who !== 'squad' ? `The ${a.who} gets out alive`
    : a.n === 'living' ? 'Everyone still standing gets out' : `${some(a.n)} leaves alive`,
  descend:   (a) => `Reach floor ${a.floors}`,
  reveal:    (a) => `Scout ${Math.round(a.fraction * 100)}% of the ${a.of}`,
  wipe:      (a) => a.standing ? `Down to ${a.standing} standing` : 'The squad falls',
  died:      (a) => `The ${a.who} dies`,
  killed:    (a) => `The ${a.who} is killed instead of taken`,
  timeout:   () => 'The clock runs out',
  breached:  (a) => `The ${a.what} falls`,
  lost:      (a) => `The ${a.zone} is taken`,
  fled:      (a) => `The ${a.who} gets away`,
  spotted:   (a) => a.budget ? `Seen no more than ${a.budget} time${a.budget === 1 ? '' : 's'}` : 'Never seen',
};

const objectiveText = (atom) => (ATOM_TEXT[atom.atom] || (() => atom.atom))(atom);

// What the way home reads as on the paper. The window one is the only warning the player gets
// that the clock is not a deadline any more, so it says what missing it actually costs.
const EXIT_TEXT = {
  gate: () => 'Walk out through the extraction point, and hold it while the way home opens',
  window: (m) => `The way home is open ${realClock(m.duration)} — miss it and it shuts for minutes, with the map awake`,
  standfast: () => `The way home opens where they stand — leaving is theirs to call, and holding `
    + `it to the end is worth +${Math.round(PORTAL.pay * 100)}%`,
};

/** Player-facing summary: what it is, how long it takes to watch, and what ends it. */
function describe(m) {
  return {
    title: m.name,
    kind: `${m.icon} ${m.label}`,
    level: m.level,
    party: `${m.party[0]}–${m.party[1]} characters`,
    watch: realClock(m.duration),
    map: m.map.label,
    hostiles: total(m.cast, 'hostile') + total(m.cast, 'patrol') + total(m.cast, 'mark'),
    horde: Math.max(0, ...m.cast.map(g => g.horde || 0)),
    twists: m.twists.map(id => TWISTS[id].label),
    reward: m.reward,
    win: m.win.map(objectiveText),
    lose: m.lose.map(objectiveText),
    bonus: m.bonus.map(objectiveText),
    orders: ORDERS[m.orders],
    pressure: PRESSURE[m.pressure],
    exit: EXIT_TEXT[m.exitMode || 'gate'](m),
  };
}

const MissionTypesAPI = {
  TIME, MIN, realSeconds, realClock,
  MAPS, ROLES, GRADES, SPECIES_TIER, OBJ, FAIL, WIN_ATOMS, FAIL_ATOMS, ORDERS, PRESSURE, TYPES, TWISTS, ESCALATION, SIDE_JOBS, rollSideJobs,
  EXITS, PORTAL, exitFor, EXIT_TEXT,
  variantsOf, resolve, roll, rollTwists, describe, objectiveText, total,
  NATIVE, HORDE_SWELL, HORDE_STEP, HORDE_CAP, HORDE_CAP_PER, HORDE_PACK, swarm, hordeWord, INTEL, INTEL_MAX,
};
if (typeof module !== 'undefined') module.exports = MissionTypesAPI;
if (typeof window !== 'undefined') window.MissionTypes = MissionTypesAPI;
})();
