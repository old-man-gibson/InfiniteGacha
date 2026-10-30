// Sortie harness: plays contracts through the real Sortie (board -> launch -> skip -> settle) in the
// browser's own script set, booted headless by test/game.boot.js. Combat is combat.js, the map is
// field.js, pay / death / class XP / condition changes are sortie.js settle(). Nothing is
// re-implemented here, so a change to any of those files shows up in the next run.
// test/field.harness.js is the other harness: it uses field.js's plain attrition resolver with
// invented hp / power, so its numbers are relative. This one is the combat-backed measurement.
//
// Command line (run from anywhere)
//   node test/sortie.harness.js                      smoke: boot, build a roster, play three seeded contracts
//                                                    back to back on one roster, print each outcome
//   node test/sortie.harness.js run                  matrix: RUNS contracts per type, levels cycled, one table
//   node test/sortie.harness.js diff a.json b.json   two result files side by side, one cell per metric "a>b"
//   node test/sortie.harness.js resume               persist / resume round trip: launch, run 60 s of virtual time,
//                                                    fire beforeunload, boot a second page on the saved storage, check
//                                                    the run came back with the same clock and party, then finish it
// Exit status: 0 ok; 1 the page threw while booting; 2 a contract threw, a setting could not be met, or resume failed.
// Before / after for a change:   OUT=before.json node test/sortie.harness.js run
//                                (edit the game)  OUT=after.json node test/sortie.harness.js run
//                                node test/sortie.harness.js diff before.json after.json
//
// Environment (all optional)
//   TYPES=a,b      contract types (default: every key of MissionTypes.TYPES)
//   RUNS=10        contracts per type
//   LEVEL=2-6      contract levels, a list or ranges ("3", "2-6", "2,5,9-11"); run i of a type uses LEVEL[i % length]
//   SQUAD=4        squad size, clamped to the contract's party range; or class ids ("fighter,cleric,elemental_mage")
//                  to pick those classes from the pool, re-assigning pool members that are eligible for them
//   STARS=3-5      star range of the pool (characters outside it are summoned and discarded)
//   POOL=24        characters in the pool
//   SEED=1         seeds the roster and, with the type index and run index, every contract
//   MEALS=0        meals put in the pantry before each contract (MEAL_TIER=1 is the kitchen tier they are crafted at)
//   CHAIN=0        1: no state restore between contracts; the roster carries wounds, deaths, XP and condition
//   REST=0         chain only: town ticks (10 s each) advanced after every contract; a squad that is short of
//                  free characters waits in ticks, counted as `waited`
//   OUT=file.json  write the run records and the summary to a file (input of `diff`)
//   HTML=game.html page whose <script> list is booted (read at run time)
//   VERBOSE=1      forward the game's console output
//
// Method. The pool is built through the page's own Summon button (game.js #pull handler) and each
// member gets a random base class from Classes.eligible. Without CHAIN every contract starts from
// the same saved state: the state object is restored in place after each run. A contract is made by
// Sortie.board with MissionTypes.roll pinned to the requested type and level, so nameCast and the
// board id come from sortie.js. The squad is gearless, random-class and of the stated size unless
// SQUAD lists classes. Fights are counted and the party HP sampled by wrapping Combat.encounter.
//   end-HP / nadir   survivors only, as a percent of max HP: HP at settle, and the lowest HP after any fight
//   xp               class XP gained per survivor      stam / pool   change in percentage points of max
//   morale           change in morale points           hurt/run      survivors with injured > 0 per run
//   gems             net gems per run (contract + loot) fights        Combat.encounter calls per run
//   meals            pantry meals consumed per run
// Runs are repeatable: same SEED, TYPES, LEVEL, SQUAD and game files give the same file. Changing RUNS
// or the TYPES subset does not change the seed of a run that is still in the list.

'use strict';
const fs = require('fs');
const { boot } = require('./game.boot.js');

const env = process.env;
const TOWN_TICK_MS = 10000;                    // game.js TICK_MS: one town tick
const WAIT_LIMIT = 600;                        // ticks a chain squad may wait for free characters

// ---------- configuration ----------

const text = (k, d) => (env[k] !== undefined && env[k] !== '' ? env[k] : d);
const num = (k, d) => Number(text(k, d));
function listOf(s) {                           // "2,5,9-11" -> [2, 5, 9, 10, 11]
  const out = [];
  for (const part of String(s).split(',')) {
    const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(part);
    if (m) for (let i = +m[1]; i <= +m[2]; i++) out.push(i);
    else if (part.trim() !== '' && !isNaN(+part)) out.push(+part);
  }
  return out;
}

function config(types) {
  const stars = listOf(text('STARS', '3-5'));
  if (!stars.length) throw new Error('STARS is not a list of numbers: ' + text('STARS', ''));
  if (!listOf(text('LEVEL', '2-6')).length) throw new Error('LEVEL is not a list of numbers: ' + text('LEVEL', ''));
  const squad = text('SQUAD', '4');
  const wanted = env.TYPES ? env.TYPES.split(',').map(s => s.trim()).filter(Boolean) : types;
  const unknown = wanted.filter(t => !types.includes(t));
  if (unknown.length) throw new Error('unknown contract type: ' + unknown.join(', ') + ' (known: ' + types.join(', ') + ')');
  return {
    types: wanted, allTypes: types,
    runs: num('RUNS', 10), levels: listOf(text('LEVEL', '2-6')), seed: num('SEED', 1),
    stars: [Math.min(...stars), Math.max(...stars)], pool: num('POOL', 24),
    html: text('HTML', 'game.html'),
    squadSize: /^\d+$/.test(squad) ? +squad : null, squadClasses: /^\d+$/.test(squad) ? [] : squad.split(',').map(s => s.trim()).filter(Boolean),
    meals: num('MEALS', 0), mealTier: num('MEAL_TIER', 1),
    chain: text('CHAIN', '0') === '1', rest: num('REST', 0), out: text('OUT', ''),
  };
}

// ---------- the laboratory: a booted page, a roster, and the instruments ----------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Boot the page and build the pool. Returns { bootFailed } when boot threw, { failed } when the settings cannot be met, else the lab. */
async function setup({ poolSize = null } = {}) {
  const b = await boot({ html: text('HTML', 'game.html'), verbose: text('VERBOSE', '0') === '1' });   // config() needs the booted page for the type list
  if (b.errors.length || !b.Game || !b.Game.state || !b.Sortie || !b.context.MissionTypes) return { b, bootFailed: true };
  let cfg;
  try { cfg = config(Object.keys(b.context.MissionTypes.TYPES)); } catch (e) { return { b, failed: e.message }; }
  if (poolSize) cfg.pool = Math.min(cfg.pool, poolSize);
  poolSize = cfg.pool;
  const ctx = b.context, st = b.Game.state, S = b.Sortie;
  const lab = { b, ctx, st, S, cfg, tap: null, pool: [], bootErrors: b.errors.length };

  // roster: summon through the page's button until the pool is full. A pull outside the star range,
  // or one that no base class accepts, is dropped from the roster again and the next one is taken.
  st.gems = 1e9;
  const Cl = ctx.Classes, rand = b.mulberry(cfg.seed + 7);
  const keeps = (c) => {
    if (c.stats.stars < cfg.stars[0] || c.stats.stars > cfg.stars[1]) return false;
    if (!c.class) {
      const ok = Cl.BASES.filter(cl => Cl.eligible(c, cl.id).ok);
      if (ok.length) Cl.assign(c, ok[Math.floor(rand() * ok.length)].id);
    }
    return !!c.class;
  };
  let pulls = 0;
  b.withSeed(cfg.seed, () => {
    while (st.characters.length < poolSize && pulls < 40 * poolSize) {
      const before = st.characters.length;
      b.click('#pull');
      pulls++;
      if (st.characters.length === before) break;                      // the button did nothing
      if (!keeps(st.characters[st.characters.length - 1])) { st.characters.pop(); if (ctx.Lodging && ctx.Lodging.invalidate) ctx.Lodging.invalidate(st); }
    }
  });
  if (st.characters.length < poolSize) return { b, failed: `summoned ${pulls} times and kept ${st.characters.length} of ${poolSize} characters in ${cfg.stars.join('-')} stars with a class` };
  // a requested class that nobody in the pool has is given to a pool member that is eligible for it
  const have = () => st.characters.filter(c => c.class).map(c => c.class.id);
  const need = {};
  for (const id of cfg.squadClasses) need[id] = (need[id] || 0) + 1;
  for (const [id, n] of Object.entries(need)) {
    if (!Cl.BASES.some(cl => cl.id === id)) return { b, failed: `SQUAD names ${id}, which is not a base class` };
    for (const c of st.characters) {
      if (have().filter(x => x === id).length >= n) break;
      if (!(c.class && c.class.id === id) && Cl.eligible(c, id).ok && !cfg.squadClasses.includes(c.class && c.class.id)) Cl.assign(c, id);
    }
    if (have().filter(x => x === id).length < n) return { b, failed: `no pool member is eligible for ${id}; raise POOL or widen STARS` };
  }
  lab.pool = st.characters.slice();
  lab.pulls = pulls;

  // instruments: every fight is counted and the party HP is read before and after
  const C = ctx.Combat, encounter = C.encounter;
  C.encounter = function (party, foes, opts) {
    const tap = lab.tap;
    if (!tap) return encounter.apply(this, arguments);
    const max = party.reduce((n, f) => n + f.maxHp, 0), hp = party.reduce((n, f) => n + f.hp, 0);
    if (tap.fights > 0) tap.entry.push(hp / max);
    tap.fights++;
    const res = encounter.apply(this, arguments);
    for (const f of party) {
      if (!f.char) continue;
      const frac = Math.max(0, f.hp) / f.maxHp;
      tap.low.set(f.char.id, Math.min(tap.low.has(f.char.id) ? tap.low.get(f.char.id) : 1, frac));
    }
    return res;
  };

  lab.snap = JSON.stringify(st);
  lab.restore = () => {
    const next = JSON.parse(lab.snap);
    for (const k of Object.keys(st)) delete st[k];
    Object.assign(st, next);
  };
  lab.restore();                 // every contract, the first included, starts from state that has been through JSON like a loaded save
  return Object.assign(lab, { play: (spec) => play(lab, spec), wait: (n) => wait(lab, n) });
}

const condOf = (ctx, c) => {
  const Cond = ctx.Condition;
  const get = (fn, d) => (Cond && typeof Cond[fn] === 'function' ? Cond[fn](c) : d);
  return { stam: get('staminaFrac', 0), pool: get('poolFrac', 0), hasPool: !!(Cond && Cond.ensure && Cond.ensure(c).pool), morale: get('morale', 0) };
};
const mealStock = (st) => Object.values(st.inventory || {}).filter(i => i.kind === 'meal').reduce((n, i) => n + (i.count || 0), 0);
const freeNow = (lab) => lab.st.characters.filter(c => !c.mission && !(c.injured > 0));

/** Town ticks until `n` characters are free (chain). Returns the ticks waited, or -1 when the limit passed first. */
function wait(lab, n) {
  let ticks = 0;
  while (freeNow(lab).length < n) {
    if (ticks >= WAIT_LIMIT) return -1;
    lab.b.advance(TOWN_TICK_MS);
    ticks++;
  }
  return ticks;
}

/** A contract of this type and level, made by Sortie.board (so nameCast and the board id are sortie.js's own). */
function contractOf(lab, type, level) {
  const MT = lab.ctx.MissionTypes, roll = MT.roll;
  if (type) MT.roll = (t, o) => roll.call(MT, type, Object.assign({}, o, { level }));
  try { return lab.S.board(lab.st, true); } finally { MT.roll = roll; }
}

function squadFor(lab, mission, rand) {
  const { cfg } = lab;
  const [lo, hi] = mission.party;
  const free = freeNow(lab);
  const size = clamp(cfg.squadClasses.length || cfg.squadSize || 4, lo, hi);
  if (free.length < lo) return null;
  const left = free.slice();
  const take = (pred) => {
    const ok = left.filter(pred);
    if (!ok.length) return null;
    const c = ok[Math.floor(rand() * ok.length)];
    left.splice(left.indexOf(c), 1);
    return c;
  };
  const out = [];
  for (const id of cfg.squadClasses.slice(0, size)) { const c = take(x => x.class && x.class.id === id); if (c) out.push(c); }
  while (out.length < Math.min(size, free.length)) out.push(take(() => true));
  return out;
}

/**
 * One contract. spec: { seed, type, level } for a pinned contract, or { seed } to take whichever board
 * contract fits the squad. Returns a record; `result` is absent when the contract did not finish.
 */
function play(lab, spec) {
  const { b, ctx, st, S, cfg } = lab;
  const rec = { type: spec.type || null, level: spec.level || null, seed: spec.seed };
  const rand = b.mulberry(spec.seed + 1);
  let before = null;
  try {
    b.withSeed(spec.seed, () => {
      const board = contractOf(lab, spec.type, spec.level);
      const want = clamp(cfg.squadClasses.length || cfg.squadSize || 4, 1, 99);
      const mission = spec.type ? board[0] : (board.find(m => m.party[0] <= want && m.party[1] >= want) || board[0]);
      Object.assign(rec, { type: mission.type, level: mission.level, name: mission.name });
      const squad = squadFor(lab, mission, rand);
      if (!squad) { rec.refused = `${freeNow(lab).length} free, ${mission.party[0]} needed`; return; }
      if (cfg.meals) {
        const item = ctx.Econ.craftItem('meal', cfg.mealTier, { stage: 4 * cfg.mealTier }, () => 0.5);
        for (let i = 0; i < cfg.meals; i++) b.Game.addItem(Object.assign({}, item));
        rec.pantry = `${cfg.meals} x ${item.name}`;
      }
      before = squad.map(c => ({ id: c.id, name: c.name, cls: c.class ? c.class.id : null, stars: c.stats.stars, xp: c.class ? c.class.xp : 0, cond: condOf(ctx, c), injured: c.injured || 0 }));
      rec.squad = before.map(x => ({ id: x.id, name: x.name, cls: x.cls, stars: x.stars }));
      rec.gems0 = st.gems; rec.meals0 = mealStock(st);
      lab.tap = { fights: 0, entry: [], low: new Map() };
      const r = S.launch(mission, squad.map(c => c.id));
      if (typeof r === 'string') { rec.refused = r; return; }
      S.skip();
    });
  } catch (e) {
    rec.error = (e && e.stack ? String(e.stack).split('\n').slice(0, 3).join(' | ') : String(e));
    try { S.abandon(); } catch (e2) { /* the run is discarded with the state */ }
  }
  const tap = lab.tap;
  lab.tap = null;
  if (rec.refused || rec.error || !before) return rec;

  const run = S.run;
  const fieldState = run && run.field;
  if (!fieldState || !fieldState.result) { rec.unfinished = true; return rec; }
  const actors = fieldState.actors.filter(a => a.role === 'squad' && a.char);
  rec.result = { won: !!fieldState.result.won, why: fieldState.result.why };
  rec.clock = fieldState.clock;
  rec.deaths = actors.filter(a => !a.alive).length;
  rec.lost = run.lost ? run.lost.length : null;
  rec.fights = tap.fights;
  rec.entry = tap.entry.length ? tap.entry.reduce((x, y) => x + y, 0) / tap.entry.length : null;
  rec.paid = (run.paid && run.paid.gems) || 0; rec.loot = run.salvage || 0;
  rec.gems = st.gems - rec.gems0;
  rec.meals = rec.meals0 - mealStock(st);
  rec.survivors = [];
  for (const a of actors) {
    if (!a.alive) continue;
    const c = st.characters.find(x => x.id === a.char.id);
    const was = before.find(x => x.id === a.char.id);
    if (!c || !was) continue;
    const now = condOf(ctx, c);
    rec.survivors.push({
      id: c.id, cls: was.cls,
      endHp: a.fighter ? a.fighter.hp / a.fighter.maxHp : null,
      nadir: tap.low.has(c.id) ? tap.low.get(c.id) : 1,
      xp: (c.class ? c.class.xp : 0) - was.xp,
      stam: now.stam - was.cond.stam,
      pool: now.hasPool ? now.pool - was.cond.pool : null,
      morale: now.morale - was.cond.morale,
      hurt: (c.injured || 0) > 0 ? 1 : 0,
      casts: a.fighter && a.fighter.stats ? a.fighter.stats.casts : null,
    });
  }
  return rec;
}

// ---------- summaries ----------

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
function quantile(a, p) {
  if (!a.length) return NaN;
  const s = a.slice().sort((x, y) => x - y), at = p * (s.length - 1), lo = Math.floor(at), hi = Math.ceil(at);
  return s[lo] + (s[hi] - s[lo]) * (at - lo);
}

function summarise(recs) {
  const done = recs.filter(r => r.result);
  const surv = done.flatMap(r => r.survivors);
  const col = (k) => surv.map(s => s[k]).filter(v => v !== null && v !== undefined);
  const won = done.filter(r => r.result.won).length;
  return {
    runs: recs.length, done: done.length, refused: recs.filter(r => r.refused).length, errors: recs.filter(r => r.error).length, unfinished: recs.filter(r => r.unfinished).length,
    win: done.length ? won / done.length : NaN, se: done.length ? Math.sqrt((won / done.length) * (1 - won / done.length) / done.length) : NaN,
    dead: mean(done.map(r => r.deaths)),
    end: [0.1, 0.5, 0.9].map(p => quantile(col('endHp'), p)), nadir: [0.1, 0.5, 0.9].map(p => quantile(col('nadir'), p)),
    xp: mean(col('xp')), stam: mean(col('stam')), pool: mean(col('pool')), morale: mean(col('morale')),
    hurt: done.length ? col('hurt').reduce((x, y) => x + y, 0) / done.length : NaN,
    gems: mean(done.map(r => r.gems)), fights: mean(done.map(r => r.fights)), meals: mean(done.map(r => r.meals)),
    casts: mean(col('casts')),
  };
}

const f = {
  pct: (v) => (isNaN(v) ? '-' : String(Math.round(v * 100))),
  one: (v, d = 2) => (isNaN(v) ? '-' : v.toFixed(d)),
  signed: (v, k = 1) => (isNaN(v) ? '-' : (v >= 0 ? '+' : '') + (v * k).toFixed(0)),
  trio: (a) => (a.some(isNaN) ? '-' : a.map(v => Math.round(v * 100)).join('/')),
};
const COLUMNS = [
  ['type', 14, (s, k) => k], ['runs', 5, s => s.runs + (s.runs !== s.done ? '*' : '')], ['win%', 5, s => f.pct(s.win)], ['dead/run', 9, s => f.one(s.dead)],
  ['end-HP% 10/50/90', 17, s => f.trio(s.end)], ['nadir% 10/50/90', 16, s => f.trio(s.nadir)], ['xp', 6, s => f.one(s.xp, 2)],
  ['stam', 5, s => f.signed(s.stam, 100)], ['pool', 5, s => f.signed(s.pool, 100)], ['morale', 7, s => f.signed(s.morale)],
  ['hurt/run', 9, s => f.one(s.hurt)], ['gems', 6, s => f.one(s.gems, 0)], ['fights', 7, s => f.one(s.fights, 1)], ['meals', 6, s => f.one(s.meals)],
];

function groupByType(recs, order) {
  const out = new Map();
  for (const t of order) { const rs = recs.filter(r => r.type === t); if (rs.length) out.set(t, rs); }
  return out;
}

function printTable(recs, order) {
  const row = (cells) => cells.map((c, i) => String(c).padEnd(COLUMNS[i][1])).join(' ').trimEnd();
  const line = (rs, name) => { const s = summarise(rs); return row(COLUMNS.map(c => c[2](s, name))); };
  console.log(row(COLUMNS.map(c => c[0])));
  for (const [t, rs] of groupByType(recs, order)) console.log(line(rs, t));
  console.log(line(recs, 'ALL'));
  const all = summarise(recs);
  console.log(`win ${f.pct(all.win)}% +/-${f.pct(all.se)} over ${all.done} contracts; ${all.refused} refused, ${all.unfinished} unfinished, ${all.errors} threw. * = fewer finished than launched`);
  const levels = [...new Set(recs.map(r => r.level))].sort((a, b) => a - b);
  if (levels.length > 1) {
    console.log('by level: ' + levels.map(l => { const s = summarise(recs.filter(r => r.level === l)); return `L${l} win ${f.pct(s.win)}% dead ${f.one(s.dead)} n=${s.done}`; }).join(' | '));
  }
}

// ---------- commands ----------

/** Properties the code read from the stub DOM that the stub does not define: each one returned undefined. */
function gapsLine(lab) {
  const gaps = [...lab.b.unknown].sort((x, y) => y[1] - x[1]);
  if (gaps.length) console.log(`stub gaps: ${gaps.map(([k, n]) => k + ' x' + n).join(', ')} (define them in test/game.boot.js)`);
  const c = lab.b.consoleCount;
  if (c.log + c.info + c.debug + c.warn + c.error + lab.b.noise.n) console.log(`game console output: ${c.log} log, ${c.warn} warn, ${c.error} error; ${lab.b.noise.n} rot.js lines filtered`);
}

function bootLine(lab) {
  const { b } = lab;
  console.log(`boot: ${b.scripts.length} scripts, ${b.errors.length} uncaught exceptions` + (b.errors.length ? ':' : ''));
  for (const e of b.errors) console.log(`  ${e.where}: ${e.name}: ${e.message}`);
  const noisy = b.consoleCount.warn + b.consoleCount.error;
  if (noisy) console.log(`  console during boot and setup: ${b.consoleCount.warn} warn, ${b.consoleCount.error} error; first: ${b.console.filter(l => l.level === 'warn' || l.level === 'error')[0].line.split('\n')[0]}`);
}

/** Print the boot report and return an exit code when setup did not produce a lab, else null. */
function refusal(lab) {
  if (lab.bootFailed) {
    console.log(`boot: ${lab.b.scripts.length} scripts, ${lab.b.errors.length} uncaught exceptions`);
    for (const e of lab.b.errors) console.log(`  ${e.where}: ${e.name}: ${e.message}`);
    if (!lab.b.errors.length) console.log('  Game.state, Sortie or MissionTypes missing after boot');
    lab.b.dispose();
    return 1;
  }
  if (lab.failed) { console.log('setup failed: ' + lab.failed); lab.b.dispose(); return 2; }
  return null;
}

async function smoke() {
  const lab = await setup({ poolSize: 12 });
  const stop = refusal(lab);
  if (stop !== null) return stop;
  const cfg = lab.cfg;
  bootLine(lab);
  console.log(`roster: ${lab.pool.length} characters (${cfg.stars.join('-')} stars, ${lab.pulls} summons), classes ${lab.pool.map(c => c.class ? c.class.id : '-').join(',')}`);
  const recs = [];
  for (let i = 0; i < 3; i++) {
    const r = lab.play({ seed: cfg.seed * 1000 + i });
    recs.push(r);
    const who = (r.squad || []).map(s => `${s.name}(${s.cls})`).join(' ');
    if (r.error) console.log(`contract ${i + 1}: threw: ${r.error}`);
    else if (r.refused) console.log(`contract ${i + 1}: ${r.type} L${r.level} refused: ${r.refused}`);
    else if (r.unfinished) console.log(`contract ${i + 1}: ${r.type} L${r.level} did not finish`);
    else {
      const s = summarise([r]);
      console.log(`contract ${i + 1}: ${r.type} L${r.level} "${r.name}" squad ${who}\n  ${r.result.won ? 'won' : 'lost'} (${r.result.why}); ${r.deaths} dead; ${r.fights} fights; ${Math.round(r.clock)} in-game s; end-HP ${f.trio(s.end)}% nadir ${f.trio(s.nadir)}%; gems ${f.signed(r.gems)} (paid ${r.paid}, loot ${r.loot}); hurt ${s.hurt}; morale ${f.signed(s.morale)}`);
    }
    lab.b.advance(1000);
  }
  const done = recs.filter(r => r.result), thrown = recs.filter(r => r.error).length;
  console.log(`seeded run (SEED=${cfg.seed}): ${recs.length} contracts, ${done.filter(r => r.result.won).length} won, ${done.reduce((n, r) => n + r.deaths, 0)} dead, ${thrown} threw`);
  const late = lab.b.errors.length - lab.bootErrors;
  if (late) { console.log(`uncaught exceptions after boot: ${late}`); for (const e of lab.b.errors.slice(lab.bootErrors)) console.log(`  ${e.where}: ${e.name}: ${e.message}`); }
  gapsLine(lab);
  lab.b.dispose();
  return lab.bootErrors || thrown || late ? 2 : 0;
}

async function matrix() {
  const lab = await setup();
  const stop = refusal(lab);
  if (stop !== null) return stop;
  const cfg = lab.cfg;
  bootLine(lab);
  console.log(`roster: ${lab.pool.length} characters (${cfg.stars.join('-')} stars, ${lab.pulls} summons); squad ${cfg.squadClasses.length ? cfg.squadClasses.join(',') : cfg.squadSize || 4}; levels ${cfg.levels.join(',')}; seed ${cfg.seed}; ${cfg.chain ? 'chain' : 'each contract from the same saved state'}${cfg.meals ? '; pantry ' + cfg.meals + ' meals at tier ' + cfg.mealTier : ''}`);
  const recs = [], started = Date.now();
  let waited = 0, exhausted = false;
  // chain order is run-major so a depleted roster cuts off every type evenly; the independent order is type-major
  const jobs = [];
  for (let i = 0; i < cfg.runs; i++) for (const t of cfg.types) jobs.push({ type: t, i });
  if (!cfg.chain) jobs.sort((x, y) => cfg.types.indexOf(x.type) - cfg.types.indexOf(y.type) || x.i - y.i);
  for (const job of jobs) {
    const level = cfg.levels[job.i % cfg.levels.length];
    const seed = ((cfg.seed * 1000003 + lab.cfg.allTypes.indexOf(job.type) * 7919 + job.i * 104729 + 17) >>> 0);
    if (cfg.chain) {
      const need = cfg.squadClasses.length || cfg.squadSize || 4;
      const w = lab.st.characters.length < need ? -1 : lab.wait(need);
      if (w < 0) { exhausted = true; break; }
      waited += w;
    }
    const r = lab.play({ seed, type: job.type, level });
    recs.push(r);
    if (cfg.chain) lab.b.advance(1000 + cfg.rest * TOWN_TICK_MS); else lab.restore();
  }
  printTable(recs, cfg.types);
  if (cfg.chain) console.log(`chain: ${recs.length} contracts played${exhausted ? ' (stopped: not enough free characters)' : ''}; waited ${waited} town ticks; ${lab.st.characters.length} of ${lab.pool.length} pool characters alive`);
  const thrown = recs.filter(r => r.error);
  for (const r of thrown.slice(0, 5)) console.log(`threw: ${r.type} L${r.level} seed ${r.seed}: ${r.error}`);
  const late = lab.b.errors.length - lab.bootErrors;
  console.log(`uncaught exceptions: ${lab.bootErrors} during boot, ${late} after (${thrown.length} contracts threw); ${((Date.now() - started) / 1000).toFixed(1)} s`);
  if (late && late > thrown.length) for (const e of lab.b.errors.slice(lab.bootErrors, lab.bootErrors + 5)) console.log(`  ${e.where}: ${e.name}: ${e.message}`);
  gapsLine(lab);
  if (cfg.out) {
    const meta = { seed: cfg.seed, runs: cfg.runs, types: cfg.types, levels: cfg.levels, squad: cfg.squadClasses.length ? cfg.squadClasses : cfg.squadSize || 4, stars: cfg.stars, pool: cfg.pool, meals: cfg.meals, mealTier: cfg.mealTier, chain: cfg.chain, rest: cfg.rest, scripts: lab.b.scripts.length };
    fs.writeFileSync(cfg.out, JSON.stringify({ meta, runs: recs }));
    console.log('wrote ' + cfg.out);
  }
  lab.b.dispose();
  return lab.bootErrors || thrown.length || late ? 2 : 0;
}

function diff(fileA, fileB) {
  const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
  const A = read(fileA), B = read(fileB);
  const keys = ['seed', 'runs', 'levels', 'squad', 'stars', 'pool', 'meals', 'chain', 'rest'];
  const differs = keys.filter(k => JSON.stringify(A.meta[k]) !== JSON.stringify(B.meta[k]));
  console.log(`A: ${fileA} (${A.runs.length} contracts, ${A.meta.scripts} scripts)\nB: ${fileB} (${B.runs.length} contracts, ${B.meta.scripts} scripts)`);
  console.log(differs.length ? `settings differ (${differs.map(k => `${k} ${JSON.stringify(A.meta[k])} vs ${JSON.stringify(B.meta[k])}`).join('; ')}); the change below is not only the code` : 'same settings: with the same seeds, per-contract differences come from the code');
  const cells = [
    ['win%', s => f.pct(s.win)], ['dead/run', s => f.one(s.dead)], ['end-HP% p50', s => f.pct(s.end[1])], ['nadir% p50', s => f.pct(s.nadir[1])], ['xp', s => f.one(s.xp, 2)],
    ['stam', s => f.signed(s.stam, 100)], ['pool', s => f.signed(s.pool, 100)], ['morale', s => f.signed(s.morale)], ['hurt/run', s => f.one(s.hurt)],
    ['gems', s => f.one(s.gems, 0)], ['fights', s => f.one(s.fights, 1)], ['meals', s => f.one(s.meals)],
  ];
  const order = [...new Set([...A.meta.types, ...B.meta.types])];
  const width = [14, ...cells.map(c => Math.max(c[0].length, 9))];
  const row = (cs) => cs.map((c, i) => String(c).padEnd(width[i])).join(' ').trimEnd();
  console.log(row(['type', ...cells.map(c => c[0])]) + '    (cell = A>B)');
  const line = (name, ra, rb) => {
    if (!ra.length && !rb.length) return;
    const sa = summarise(ra), sb = summarise(rb);
    console.log(row([name, ...cells.map(c => (ra.length ? c[1](sa) : '-') + '>' + (rb.length ? c[1](sb) : '-'))]));
  };
  for (const t of order) line(t, A.runs.filter(r => r.type === t), B.runs.filter(r => r.type === t));
  line('ALL', A.runs, B.runs);
  const sa = summarise(A.runs), sb = summarise(B.runs);
  if (!differs.length) {
    const keyOf = (r) => r.type + '|' + r.level + '|' + r.seed;
    const other = new Map(B.runs.map(r => [keyOf(r), r]));
    const shape = (r) => JSON.stringify([r.result, r.deaths, r.fights, r.gems, r.clock, r.survivors && r.survivors.map(x => [x.endHp, x.nadir, x.xp, x.morale])]);
    let paired = 0, same = 0, toWin = 0, toLoss = 0;
    for (const r of A.runs) {
      const o = other.get(keyOf(r));
      if (!o) continue;
      paired++;
      if (shape(r) === shape(o)) same++;
      else if (r.result && o.result && r.result.won !== o.result.won) { if (o.result.won) toWin++; else toLoss++; }
    }
    console.log(`paired by (type, level, seed): ${paired}; identical ${same}; lost>won ${toWin}; won>lost ${toLoss}. A change that alters how many random numbers a contract draws shifts every later draw, so a pair that differs is not necessarily a pair the change decided.`);
  }
  const noise = Math.sqrt(sa.se * sa.se + sb.se * sb.se);
  console.log(`ALL win: ${f.pct(sa.win)}% >${f.pct(sb.win)}% (difference ${f.signed(sb.win - sa.win, 100)} points, one standard error of the difference ${f.pct(noise)} points); dead/run ${f.one(sa.dead)} > ${f.one(sb.dead)}`);
}

async function resume() {
  const lab = await setup({ poolSize: 8 });
  const stop = refusal(lab);
  if (stop !== null) return stop;
  bootLine(lab);
  const { b, S, st } = lab;
  const fail = (why) => { console.log('resume: FAILED, ' + why); b.dispose(); return 2; };
  const ids = st.characters.slice(0, 4).map(c => c.id);
  const board = b.withSeed(lab.cfg.seed, () => S.board(st, true));
  // the first board contract that is still running after 20 s of virtual time (100 in-game seconds)
  let run = null;
  for (const mission of board.filter(m => m.party[0] <= ids.length && m.party[1] >= ids.length)) {
    lab.restore();
    const r = b.withSeed(lab.cfg.seed, () => S.launch(mission, ids));
    if (typeof r === 'string') return fail('launch refused: ' + r);
    b.advance(20000);
    if (!S.run.field.result) { run = S.run; break; }
  }
  if (!run) return fail('every board contract ended inside 20 s of virtual time; nothing to resume');
  b.fire('window', 'beforeunload');
  const saved = { clock: run.field.clock, party: run.party.join(',') };
  if (!(st.field && st.field.run)) return fail('beforeunload did not store the run (gs.field.run is missing)');
  const b2 = await boot({ html: lab.cfg.html, storage: new Map(b.localStorage.map) });
  const S2 = b2.Sortie, run2 = S2 && S2.run;
  console.log(`second boot: ${b2.scripts.length} scripts, ${b2.errors.length} uncaught exceptions`);
  if (!run2) { b2.dispose(); return fail('the second page did not resume a run'); }
  const back = { clock: run2.field.clock, party: run2.party.join(',') };
  const held = b2.Game.state.characters.filter(c => run2.party.includes(c.id)).every(c => c.mission === run2.id);
  b2.withSeed(lab.cfg.seed + 1, () => S2.skip());
  const end = run2.field.result;
  const ok = back.clock === saved.clock && back.party === saved.party && held && !!end && !b2.errors.length;
  console.log(`resume: ${ok ? 'ok' : 'FAILED'}; saved at ${saved.clock} s with party ${saved.party}; back at ${back.clock} s with party ${back.party}; party marked out ${held}; finished: ${end ? (end.won ? 'won' : 'lost') + ' (' + end.why + ')' : 'no result'}; uncaught exceptions after resume: ${b2.errors.length}`);
  gapsLine(lab);
  b.dispose(); b2.dispose();
  return ok ? 0 : 2;
}

async function main() {
  const cmd = process.argv[2] || 'smoke';
  if (cmd === 'diff') {
    if (process.argv.length < 5) { console.log('usage: node test/sortie.harness.js diff a.json b.json'); return 2; }
    diff(process.argv[3], process.argv[4]);
    return 0;
  }
  if (!['smoke', 'run', 'resume'].includes(cmd)) { console.log('usage: node test/sortie.harness.js [smoke | run | resume | diff a.json b.json]   (options are environment variables; see the top of this file)'); return 2; }
  return cmd === 'smoke' ? smoke() : cmd === 'resume' ? resume() : matrix();
}

if (require.main === module) main().then((code) => { process.exitCode = code; }, (e) => { console.error(e); process.exitCode = 2; });
module.exports = { setup, summarise, config };
