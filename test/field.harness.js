// Field balance harness: seeded missions with real characters, tactics on/off. Run from anywhere:
//   node test/field.harness.js [runsPerType] [variant...]     variants: off on dim cold
// This is the plain-resolver harness. Field.play's loop runs with field.js's default attrition resolver, so its
// win and death rates are relative: use it to compare field.js / tactics.js variants with each other.
// test/sortie.harness.js is the combat-backed measurement (the browser's script set, Sortie.board / launch /
// skip, combat.js fights); use that one for any figure quoted as how the game plays.
// Inputs. RATE=on (default) gives the actors the numbers the game gives them: a squad member's maxHp, power and
// guard are those of its combat.js fighter (Combat.fromCharacter, Combat.rating, power x Combat.RATE_K), its speed
// is Field.pace(walkSpeed), and hostile power / hp / guard come from a `rate` hook that does what sortie.js
// rateFoe does (Combat.baseOfMonster at the group's level, tierMult at the middle of the tier range).
// RATE=off is the earlier input: invented maxHp / power / speed for the squad and the GRADE_POWER / GRADE_HP
// rows for hostiles. Both are the same code otherwise, so RATE=off against RATE=on shows what the rating changed.
// The plain resolver spends power as damage per 10-tick step at 2.2 per point, while a rating is damage per
// tick, so with RATE=on both sides' power is multiplied by ATTR (the same factor on both sides, so odds are unchanged).
// Env: POW=0.45 scales party power/hp (RATE=off: 0.45 puts a plain squad near 75% wins; RATE=on: see the printed win rate);
//      TYPES=a,b limits types; RATE=on|off; LOG=on LOG_RE='fall back' prints the first log of that variant matching the pattern.
// Columns: details = tactics.js plays and their log lines; stands = 'fall back and stand'; retreats = 'fall back to the way
// in', the plans that send the squad home and the withdrawal field.js makes after STEPS_BACK step-backs with no fight in
// between; loops = runs with more than 10 retreat lines; rally = hostile-seconds spent walking at another hostile rather
// than at the squad (field.js rally), per run.
const path = require('path');
const root = path.join(__dirname, '..');
const req = (m) => require(path.join(root, m + '.js'));
const Rng = req('rng'), MT = req('missiontypes'), Stats = req('stats'), Prof = req('proficiency'),
  Temper = req('temper'), AI = req('ai'), Bonds = req('bonds'), Classes = req('classes'), Tactics = req('tactics'), Field = req('field'),
  Missions = req('missions'), Combat = req('combat');
const RATE = (process.env.RATE || 'on') !== 'off';
const POW = +process.env.POW || 1;
// the same species pick fieldview.js makes, minus the art: hostiles get a bestiary mind and legs
function namer(group, mission) {
  const all = Object.values(Missions.BESTIARY);
  const tier = MT.SPECIES_TIER[group.grade] || 'basic';
  const themed = all.filter(m => m.tier === tier && m.tags.some(t => mission.theme.includes(t)));
  const pool = themed.length ? themed : all.filter(m => m.tier === tier);
  const d = pool.length ? pool[Math.floor(Rng.rand() * pool.length)] : all[0];
  return { id: d.id, label: d.name, icon: d.icon, attrs: d.attrs, tags: d.tags };
}

// 10 ticks a step, and attrition deals power x 2.2 x (0.6 + rand), which averages 1.1 x 2.2 per point
const ATTR = 10 / (2.2 * 1.1);
const GRADE_BUMP = { basic: 0, veteran: 0, elite: 1, ancient: 3, legendary: 4 };   // sortie.js GRADE_BUMP
// sortie.js rateFoe, in attrition's units
function rate(species, group, mission) {
  const def = Missions.BESTIARY[species];
  if (!def) return null;
  const level = Math.max(1, mission.level + (GRADE_BUMP[group.grade] || 0) + (group.levelOffset || 0));
  const range = Missions.TIERS[def.tier];
  const block = Combat.baseOfMonster(def, level, { tierMult: (range[0] + range[1]) / 2 });
  const r = Combat.rating(block);
  return { power: r.power * ATTR, hp: block.hp, guard: r.guard };
}

function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const RACES = ['human', 'draconic', 'therian'];
const CLASS_SETS = [
  ['warden', 'skulker', 'ranger', 'cleric', 'fighter'],
  ['fighter', 'fighter', 'ranger', 'alchemist', 'skulker'],
  ['paladin', 'duelist', 'ranger', 'cleric'],
];
function makeChar(id, rand, cls, mindTier) {
  const race = RACES[Math.floor(rand() * RACES.length)];
  const stars = 3 + Math.floor(rand() * 2);
  const c = { id, name: 'C' + id, race, stats: Stats.rollCharacterStats(race, rand, stars), equipment: {}, mind: { traits: [] }, temper: Temper.roll(rand), gifts: [], xp: {}, potions: [] };
  c.profs = Prof.rollAll(stars, race, rand);
  if (mindTier !== undefined) { const v = AI.TIERS[mindTier].min + 1; c.stats.base.int = v; c.stats.base.wis = v; }
  Classes.assign(c, cls, { force: true }); c.class.xp = 30;
  const b = c.stats.base;
  if (RATE) {
    // rating reads only the fighter's base block, so the loadout plan and the mercy ledger are empty here
    const f = Combat.fromCharacter(c, {}, {}), r = Combat.rating(f);
    c.maxHp = Math.round(f.maxHp * POW); c.power = Combat.RATE_K * r.power * ATTR * POW; c.guard = r.guard;
    c.speed = Field.pace(Stats.effective(c).derived.walkSpeed);
  } else {
    c.maxHp = Math.round((50 + b.con * 2) * POW); c.power = (3 + stars * 0.7 + (b.str + b.dex) / 20) * POW; c.speed = 0.9 + b.dex / 100;
  }
  return c;
}
function makeParty(rand, n, mindTier, trust) {
  const set = CLASS_SETS[Math.floor(rand() * CLASS_SETS.length)];
  const chars = Array.from({ length: n }, (_, i) => makeChar(i + 1, rand, set[i % set.length], i === 0 ? mindTier : undefined));
  const gs = { bonds: {}, characters: chars };
  for (const a of chars) for (const b of chars) if (a.id < b.id) gs.bonds[a.id + ':' + b.id] = { v: Math.round(trust * 100), spark: 0, runs: trust > 0 ? 15 : 0, shifts: 0, met: 0 };
  return { chars, gs };
}

const TYPES = (process.env.TYPES ? process.env.TYPES.split(',') : null) || ['extermination', 'siege', 'escort', 'dungeon', 'survival', 'recon', 'assassination', 'hold', 'retrieval', 'rescue', 'pursuit', 'sabotage', 'expedition', 'raid', 'capture'];
const VARIANTS = {
  off:   { tactics: false, mindTier: 3, trust: 0.5 },
  on:    { tactics: true,  mindTier: 3, trust: 0.5 },
  dim:   { tactics: true,  mindTier: 0, trust: 0.5 },
  cold:  { tactics: true,  mindTier: 3, trust: -0.1 },
};
const runs = +process.argv[2] || 30;
const want = process.argv.slice(3).length ? process.argv.slice(3) : ['off', 'on'];

const PLAY_RE = /goes on ahead|holds them|stays to hold|they go at those|fall back to the way in|they read it|still coming|stepped back d+ times/;
const STAND_RE = /fall back and stand/;
const RETREAT_RE = /fall back to the way in|they read it and go|still coming, and they are at the gate|stepped back d+ times/;

/** Field.play, with one count taken per step: hostiles whose goal is another hostile (rally). */
function playCounting(mission, opts) {
  const s = Field.start(mission, opts);
  let rally = 0;
  for (let i = 0; i < 40000 && !s.result; i++) {
    Field.step(s);
    for (const a of s.actors) {
      if (a.side !== 'theirs' || !a.alive || !a.goal || a.goal.kind !== 'actor') continue;
      const t = s.actors.find(x => x.id === a.goal.id);
      if (t && t.side === 'theirs') rally++;
    }
  }
  s.rallySteps = rally;
  return s;
}

const totals = {};
const LOOP = 10;   // retreat lines in one run above which the run counts as a loop: tactics.js ends and restarts the retreat every plan interval
for (const v of want) totals[v] = { n: 0, won: 0, dead: 0, withdrew: 0, details: 0, stands: 0, retreats: 0, loops: 0, rally: 0, clock: 0, byType: {} };
for (const type of TYPES) {
  for (let i = 0; i < runs; i++) {
    const seed = 1000 * i + TYPES.indexOf(type) * 7 + 1;
    for (const v of want) {
      const cfg = VARIANTS[v];
      const rand = mulberry(seed);
      const M = Math.random; Math.random = rand;
      let s;
      try {
        Rng.withSource(rand, () => {
          const level = 1 + Math.floor(rand() * 4);
          const mission = MT.roll(type, { level });
          const n = Math.min(mission.party[1], 5);
          const { chars, gs } = makeParty(rand, n, cfg.mindTier, cfg.trust);
          const play = mulberry(seed * 31 + 7);
          Rng.withSource(play, () => {
            Math.random = play;
            s = playCounting(mission, {
              party: chars, name: namer, rate: RATE ? rate : null, scout: AI.bestScout(chars), will: Temper.will(chars), kit: (c) => Classes.fieldKit(c),
              tactics: cfg.tactics ? (run) => { try { return Tactics.propose(run, gs); } catch (e) { console.error(e); process.exit(1); } } : null,
              grieve: (fallen, survivors) => Tactics.grieve(gs, fallen.char, survivors),
            });
          });
        });
      } finally { Math.random = M; }
      if (process.env.LOG && v === process.env.LOG && s.log.some(l => new RegExp(process.env.LOG_RE || 'goes on ahead|fall back|holds them|stays to hold').test(l.text)) && !totals.__logged) {
        totals.__logged = true;
        console.log('---- ' + type + ' seed ' + seed + ' won=' + (s.result && s.result.won));
        for (const l of s.log) console.log(String(l.t).padStart(5), l.text);
      }
      const t = totals[v];
      const bt = t.byType[type] = t.byType[type] || { n: 0, won: 0, dead: 0 };
      t.n++; bt.n++;
      const won = s.result && s.result.won ? 1 : 0;
      t.won += won; bt.won += won;
      const dead = s.actors.filter(a => a.role === 'squad' && !a.alive).length;
      t.dead += dead; bt.dead += dead;
      if (s.withdrew) t.withdrew++;
      t.details += s.log.filter(l => PLAY_RE.test(l.text)).length;
      t.stands += s.log.filter(l => STAND_RE.test(l.text)).length;
      const back = s.log.filter(l => RETREAT_RE.test(l.text)).length;
      t.retreats += back;
      if (back > LOOP) t.loops++;
      t.rally += s.rallySteps;
      t.clock += s.clock;
    }
  }
}
const pct = (a, b) => (100 * a / b).toFixed(0) + '%';
console.log(`inputs: RATE=${RATE ? 'on' : 'off'} POW=${POW}, ${runs} runs per type over ${TYPES.length} types`);
console.log(`variant  win   dead/run  withdrew  details  stands  retreats  loops(>${LOOP})  rally   clock`);
for (const v of want) { const t = totals[v]; console.log(v.padEnd(8), pct(t.won, t.n).padEnd(5), (t.dead / t.n).toFixed(2).padEnd(9), pct(t.withdrew, t.n).padEnd(9), (t.details / t.n).toFixed(2).padEnd(8), (t.stands / t.n).toFixed(2).padEnd(7), (t.retreats / t.n).toFixed(2).padEnd(9), String(t.loops).padEnd(11), (t.rally / t.n).toFixed(0).padEnd(7), Math.round(t.clock / t.n)); }
console.log('\ntype'.padEnd(15) + want.map(v => v.padEnd(16)).join(''));
for (const type of TYPES) console.log(type.padEnd(14) + want.map(v => { const b = totals[v].byType[type]; return (pct(b.won, b.n) + ' ' + (b.dead / b.n).toFixed(2)).padEnd(16); }).join(''));
