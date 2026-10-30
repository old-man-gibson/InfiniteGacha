// Strength rating harness: what Combat.rating / Combat.RATE_K do to the field's odds, and what the
// odds-gated plays then do in real sorties.
//
//   node test/rating.harness.js fit        grid of squads x packs fought with combat.js; Spearman of the odds
//                                          against win rate per composition, the RATE_K sweep and the fitted K
//   node test/rating.harness.js sorties    real sorties through test/sortie.harness.js's lab (the browser's
//                                          script set, combat.js fights): plays, retreats and threat readings
//                                          per run. OUT=file.json writes the records.
//   node test/rating.harness.js compare a.json b.json
//                                          two sortie result files side by side; a side may be several files,
//                                          comma separated, when a run was split with TYPES
//   node test/rating.harness.js check      assertions: combat.js rating, field.js rate hook / guard / pace, and
//                                          sortie.js's wiring in a booted page including a save and a resume
//   node test/rating.harness.js            fit, then sorties
//
// Environment
//   fit:      CELL_RUNS=16   combat.js encounters per cell      FIT_SEED=0   shifts the seeds of the squads and fights
//             COMPS=a,b      subset of: melee mixed caster heal2   GEAR=0,1  0 ungeared, 1 geared
//             GUARD_DIV=10   guard divisor to try in place of Combat.ARMOR_PER_GUARD   FIT_OUT=file.json  per-cell rows
//   sorties:  the variables of test/sortie.harness.js (TYPES RUNS LEVEL SQUAD STARS POOL SEED); RUNS is contracts per
//             type, 30 by default here; OUT=file.json
//
// fit method. A cell is a squad composition x gear x mission level x star count x pack. Its truth is the
// fraction of CELL_RUNS combat.js encounters (frontage 8) the squad wins. Its reading is
// Field.odds over actors built the way sortie.js builds them: squad power = K x rating(fighter).power,
// hp = fighter hp, guard = rating(fighter).guard; hostile power / hp / guard from Combat.baseOfMonster at the
// pack's level and the mean of the species' tier range (sortie.js rateFoe). The table reading is the same
// cells read with power 4 and the GRADE_POWER / GRADE_HP rows, which is what field.js did before the rating.
// RATE_K is the K at which the median reading of the cells with a win rate in 0.2..0.8 is 0.5.
//
// sorties method. Tactics.propose is wrapped: every plan it returns is counted by kind (stand, pounce,
// retreat, hold, strike) and by 'leave' (a plan that sends the squad home). Before each plan the odds of
// the squad against Tactics.closing(s) are read with Field.odds on the same ground width
// (Field.frontage), which is the number tactics.js compares with GOOD and HOPELESS.
// Two figures are about field.js STEPS_BACK (the step-back cap): the share of runs that ended with its withdrawal
// (withdrawal text "stepped back ..."), and the number of runs with more retreat proposals than the cap allows,
// (STEPS_BACK + 1) per stretch between two skirmishes. The second is 0 when the cap works.

'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const req = (m) => require(path.join(root, m + '.js'));

const env = process.env;
const num = (k, d) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : d);

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
function quantile(a, p) {
  if (!a.length) return NaN;
  const s = a.slice().sort((x, y) => x - y), at = p * (s.length - 1), lo = Math.floor(at), hi = Math.ceil(at);
  return s[lo] + (s[hi] - s[lo]) * (at - lo);
}
const fix = (v, d = 2) => (isNaN(v) ? '-' : v.toFixed(d));
const pct = (v) => (isNaN(v) ? '-' : String(Math.round(v * 100)));

// ---------- sorties ----------

const KINDS = ['stand', 'pounce', 'retreat', 'hold', 'strike'];
const LOOP = 10;           // retreat plays in one run above which the run is counted as a loop
const STEPS_BACK = req('field').STEPS_BACK;   // field.js replan(): step-backs allowed between two fights
// A retreat detail that tactics.js proposes more than STEPS_BACK times between two fights is turned into a
// withdrawal by field.js (the proposal is still counted here, because the count is taken at Tactics.propose), and a
// withdrawing squad is not asked again. So a run has at most STEPS_BACK + 1 retreat proposals per stretch without
// a fight, and at most skirmishes + 1 such stretches.
const retreatBound = (r) => (STEPS_BACK + 1) * ((r.skirmishes !== undefined && r.skirmishes !== null ? r.skirmishes : r.fights || 0) + 1);

/** Wrap Tactics.propose in a booted page so that each call adds to `tally` (null: not counting). */
function instrument(lab) {
  const T = lab.ctx.Tactics, F = lab.ctx.Field, propose = T.propose;
  lab.tally = null;
  T.propose = function (s, state) {
    const t = lab.tally;
    if (t) {
      const crew = s.actors.filter(a => a.role === 'squad' && a.alive && !a.extracted);
      const threat = crew.length ? T.closing(s) : [];
      if (threat.length) t.readings.push(F.odds(crew, threat, F.frontage(s, crew) || 8));
    }
    const out = propose.apply(this, arguments);
    if (t && out) {
      for (const d of (out.start || [])) t.starts[d.kind] = (t.starts[d.kind] || 0) + 1;
      if (out.leave) t.leaves++;
    }
    return out;
  };
}

async function sorties() {
  const SH = require('./sortie.harness.js');
  const lab = await SH.setup();
  if (lab.bootFailed || lab.failed) { console.log(lab.failed || 'boot failed'); lab.b.dispose(); return 2; }
  instrument(lab);
  const cfg = lab.cfg;
  const runsPer = num('RUNS', 30);
  const recs = [];
  const started = Date.now();
  const jobs = [];
  for (let i = 0; i < runsPer; i++) for (const t of cfg.types) jobs.push({ type: t, i });
  jobs.sort((x, y) => cfg.types.indexOf(x.type) - cfg.types.indexOf(y.type) || x.i - y.i);
  for (const job of jobs) {
    const level = cfg.levels[job.i % cfg.levels.length];
    const seed = ((cfg.seed * 1000003 + cfg.allTypes.indexOf(job.type) * 7919 + job.i * 104729 + 17) >>> 0);
    lab.tally = { starts: {}, leaves: 0, readings: [] };
    const r = lab.play({ seed, type: job.type, level });
    const t = lab.tally;
    lab.tally = null;
    const field = lab.S.run && lab.S.run.field;
    r.starts = t.starts; r.leaves = t.leaves; r.readings = t.readings.map(v => Math.round(v * 1000) / 1000);
    r.withdrew = field && field.withdrew ? (field.withdrew.why || true) : null;
    r.skirmishes = field && field.counters ? field.counters.fights || 0 : null;   // openSkirmish calls, which is what ends a run of step-backs
    recs.push(r);
    lab.restore();
  }
  const done = recs.filter(r => r.result);
  console.log(`${recs.length} contracts (${cfg.types.length} types x ${runsPer}), levels ${cfg.levels.join(',')}, squad ${cfg.squadClasses.length ? cfg.squadClasses.join(',') : cfg.squadSize || 4}, stars ${cfg.stars.join('-')}, seed ${cfg.seed}; ${((Date.now() - started) / 1000).toFixed(0)} s`);
  report(recs);
  const late = lab.b.errors.length - lab.bootErrors;
  const thrown = recs.filter(r => r.error);
  for (const r of thrown.slice(0, 5)) console.log(`threw: ${r.type} L${r.level} seed ${r.seed}: ${r.error}`);
  if (late) console.log(`uncaught exceptions after boot: ${late}`);
  if (env.OUT) {
    const meta = { seed: cfg.seed, runs: runsPer, types: cfg.types, levels: cfg.levels, squad: cfg.squadClasses.length ? cfg.squadClasses : cfg.squadSize || 4, stars: cfg.stars, pool: cfg.pool };
    fs.writeFileSync(env.OUT, JSON.stringify({ meta, runs: recs }));
    console.log('wrote ' + env.OUT);
  }
  lab.b.dispose();
  return lab.bootErrors || thrown.length || late || !done.length ? 2 : 0;
}

/** The figures of a set of records, as numbers. */
function figures(recs) {
  const SH = require('./sortie.harness.js');
  const done = recs.filter(r => r.result);
  const per = (f) => (done.length ? done.reduce((t, r) => t + f(r), 0) / done.length : NaN);
  const sum = (r, ks) => ks.reduce((t, k) => t + ((r.starts && r.starts[k]) || 0), 0);
  const readings = done.flatMap(r => r.readings || []);
  const s = SH.summarise(recs);
  return {
    n: done.length, win: s.win, se: s.se, dead: s.dead, fights: s.fights,
    plays: per(r => sum(r, KINDS)), byKind: Object.fromEntries(KINDS.map(k => [k, per(r => sum(r, [k]))])),
    leaves: per(r => r.leaves || 0),
    retreatRuns: done.length ? done.filter(r => sum(r, ['retreat']) + (r.leaves || 0) > 0).length / done.length : NaN,
    // a retreat play that ends and restarts every plan interval (tactics.js: a hostile that stays at its post is out of NEAR range
    // while the squad walks away and in range once it walks back to its task) shows as a run with dozens of them; field.js
    // STEPS_BACK turns the proposal after the second such step-back into a withdrawal, so a count above LOOP means the cap is not working
    loops: done.filter(r => sum(r, ['retreat']) > LOOP).length,
    capped: done.length ? done.filter(r => typeof r.withdrew === 'string' && /^stepped back/.test(r.withdrew)).length / done.length : NaN,
    overBound: done.filter(r => sum(r, ['retreat']) > retreatBound(r)).length,
    retreatTrimmed: done.length ? done.filter(r => sum(r, ['retreat']) <= LOOP).reduce((t, r) => t + sum(r, ['retreat']), 0) / done.filter(r => sum(r, ['retreat']) <= LOOP).length : NaN,
    playRuns: done.length ? done.filter(r => sum(r, KINDS) > 0).length / done.length : NaN,
    ranFoot: done.length ? done.filter(r => /ran from a fight/.test(r.result.why || '')).length / done.length : NaN,
    withdrew: done.length ? done.filter(r => r.withdrew).length / done.length : NaN,
    readings: readings.length, median: quantile(readings, 0.5), p10: quantile(readings, 0.1),
    belowGood: readings.length ? readings.filter(v => v < 0.6).length / readings.length : NaN,
    belowHopeless: readings.length ? readings.filter(v => v < 0.35).length / readings.length : NaN,
  };
}

function report(recs) {
  const g = figures(recs);
  console.log(`win ${pct(g.win)}% +/-${pct(g.se)} over ${g.n} finished; dead/run ${fix(g.dead)}; fights/run ${fix(g.fights, 1)}`);
  console.log(`plays/run ${fix(g.plays)} (${KINDS.map(k => k + ' ' + fix(g.byKind[k])).join(', ')}); runs with a play ${pct(g.playRuns)}%`);
  console.log(`retreat: plays/run ${fix(g.byKind.retreat)} (${fix(g.retreatTrimmed, 3)} without the ${g.loops} runs of more than ${LOOP}), gate leaves/run ${fix(g.leaves)}, runs with either ${pct(g.retreatRuns)}%; withdrawn ${pct(g.withdrew)}% of runs, ran from a fight ${pct(g.ranFoot)}%`);
  console.log(`step-back cap (field.js STEPS_BACK ${STEPS_BACK}): ended ${fix(g.capped * 100, 1)}% of runs with a withdrawal; ${g.overBound} runs above the bound of ${STEPS_BACK + 1} retreat proposals per stretch between fights`);
  console.log(`threat readings ${g.readings}: median ${fix(g.median)}, p10 ${fix(g.p10)}, below GOOD (0.6) ${pct(g.belowGood)}%, below HOPELESS (0.35) ${pct(g.belowHopeless)}%`);
}

function compare(fileA, fileB) {
  // a side is one file or several, comma separated (sorties split by TYPES into separate processes): their runs are pooled
  const read = (list) => {
    const parts = list.split(',').map(p => JSON.parse(fs.readFileSync(p, 'utf8')));
    return { meta: { ...parts[0].meta, types: parts.flatMap(x => x.meta.types) }, runs: parts.flatMap(x => x.runs) };
  };
  const A = read(fileA), B = read(fileB);
  const differs = ['seed', 'runs', 'levels', 'squad', 'stars', 'pool', 'types'].filter(k => JSON.stringify(A.meta[k]) !== JSON.stringify(B.meta[k]));
  console.log(`A ${fileA} (${A.runs.length} contracts)   B ${fileB} (${B.runs.length} contracts)`);
  console.log(differs.length ? `settings differ: ${differs.join(', ')}` : 'same settings');
  const a = figures(A.runs), b = figures(B.runs);
  const rows = [
    ['win%', (g) => pct(g.win)], ['dead/run', (g) => fix(g.dead)], ['fights/run', (g) => fix(g.fights, 1)],
    ['plays/run', (g) => fix(g.plays)], ['  stand', (g) => fix(g.byKind.stand)], ['  pounce', (g) => fix(g.byKind.pounce)],
    ['  retreat', (g) => fix(g.byKind.retreat)], ['  retreat, no loops', (g) => fix(g.retreatTrimmed, 3)], ['runs > ' + LOOP + ' retreats', (g) => String(g.loops)], ['  over cap bound', (g) => String(g.overBound)], ['  cap withdrawals %', (g) => fix(g.capped * 100, 1)], ['  hold', (g) => fix(g.byKind.hold)], ['  strike', (g) => fix(g.byKind.strike)],
    ['gate leaves/run', (g) => fix(g.leaves)], ['runs with a play %', (g) => pct(g.playRuns)], ['runs with a retreat %', (g) => pct(g.retreatRuns)],
    ['withdrawn %', (g) => pct(g.withdrew)], ['ran from a fight %', (g) => pct(g.ranFoot)],
    ['readings', (g) => String(g.readings)], ['reading median', (g) => fix(g.median)], ['reading p10', (g) => fix(g.p10)],
    ['below GOOD %', (g) => pct(g.belowGood)], ['below HOPELESS %', (g) => pct(g.belowHopeless)],
  ];
  console.log('metric'.padEnd(24) + 'A'.padEnd(10) + 'B');
  for (const [name, f] of rows) console.log(name.padEnd(24) + f(a).padEnd(10) + f(b));
  const noise = Math.sqrt(a.se * a.se + b.se * b.se);
  console.log(`win difference ${((b.win - a.win) * 100).toFixed(1)} points, one standard error of the difference ${(noise * 100).toFixed(1)} points`);
}

// ---------- fit ----------

function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const COMPS = {
  melee:  ['fighter', 'ranger', 'barbarian', 'rogue'],
  mixed:  ['fighter', 'cleric', 'elemental_mage', 'ranger'],
  caster: ['elemental_mage', 'cleric', 'alchemist', 'elemental_mage'],
  heal2:  ['fighter', 'barbarian', 'cleric', 'cleric'],
};
const GEARS = [{ id: 'ungeared', quality: -1 }, { id: 'geared', quality: 2 }];   // quality 2 is Fine (economy.js QUALITY)
const LEVELS = [3, 8, 14], STARS = [1, 3, 5];
const PACKS = [['forest_rat', 6], ['goblin', 6], ['wolf', 6], ['stone_golem', 2], ['death_knight', 2], ['goblin_boss', 1]];
const RACES = ['human', 'draconic', 'therian'];

/** A character of this star count and class, built the way test/sortie.harness.js's pool is. Null when no roll is eligible for the class. */
function mkChar(mods, id, rand, stars, wantClass) {
  const { Stats, Prof, AI, Temper, Gifts, Spellcraft, Affinity, Psionic, Classes } = mods;
  for (let tries = 0; tries < 600; tries++) {
    const race = RACES[Math.floor(rand() * RACES.length)];
    const c = { id, name: 'C' + id, race, stats: Stats.rollCharacterStats(race, rand, stars), equipment: {}, mind: { traits: AI.rollMindTraits() }, temper: Temper.roll(rand), xp: {}, potions: [], lexicon: [], techniques: {}, injured: 0, mission: null };
    c.profs = Prof.rollAll(stars, race, rand); c.affinity = Affinity.roll(); c.psiOrder = Psionic.rollAxisOrder();
    c.gifts = Gifts.roll(c.stats, race); Gifts.ensure(c, null);
    if (Gifts.has(c, 'arcana')) c.lexicon = Spellcraft.rollLexicon(stars);
    const pick = Classes.BASES.find(cl => cl.id === wantClass && Classes.eligible(c, cl.id).ok);
    if (!pick) continue;
    Classes.assign(c, pick.id); c.class.xp = 30;
    return c;
  }
  return null;
}

/** Weapon, offhand, head, body and feet of one quality: Econ.craftItem pieces with the quality pinned. */
function gearUp(Econ, c, quality, rand) {
  const caster = c.class && /mage|alchemist|psion|cleric/.test(c.class.id);
  const want = { weapon: caster ? 'staff' : 'sword', offhand: 'kite', head: 'medium_helm', body: 'medium_mail', feet: 'medium_boots' };
  for (const [slot, key] of Object.entries(want)) {
    const it = Econ.craftItem('equipment', 0, { stage: 0 }, rand, key);
    it.quality = quality;
    it.bonus = Object.fromEntries(Object.keys(it.bonus).map(k => [k, Math.max(1, Math.round(2 * Econ.QUALITY[quality].mult))]));
    c.equipment[slot] = it;
  }
}

function spearman(xs, ys) {
  const rank = (a) => {
    const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]), r = new Array(a.length);
    for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2; i = j + 1; }
    return r;
  };
  const x = rank(xs), y = rank(ys), n = x.length, mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
}

function fit() {
  const files = { Rng: 'rng', Stats: 'stats', Prof: 'proficiency', AI: 'ai', Temper: 'temper', Gifts: 'gifts', Spellcraft: 'spellcraft', Affinity: 'affinity', Psionic: 'psionic', Classes: 'classes', Econ: 'economy', Field: 'field', Combat: 'combat', Missions: 'missions' };
  const mods = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, req(f)]));
  const { Rng, Econ, Field, Combat, Missions } = mods;
  const cellRuns = num('CELL_RUNS', 16);
  const comps = env.COMPS ? env.COMPS.split(',') : Object.keys(COMPS);
  const gears = env.GEAR ? env.GEAR.split(',').map(g => GEARS[+g]) : GEARS;
  const unknown = comps.filter(c => !COMPS[c]);
  if (unknown.length) { console.log('unknown composition: ' + unknown.join(', ') + ' (known: ' + Object.keys(COMPS).join(', ') + ')'); return 2; }

  // GUARD_DIV replaces Combat.ARMOR_PER_GUARD for a sensitivity run
  const guardOf = (base) => (env.GUARD_DIV ? 1 + base.armor / num('GUARD_DIV', 0) : Combat.rating({ base }).guard);
  const zoneOf = (level, id) => ({ id: `fit:${level}:${id}`, name: 'fit', level, encounters: [[id]] });
  const squadOf = (comp, stars, quality, rand, level, id) => {
    // a 1-star roll is eligible for fighter (18 of 300 rolls) and rarely rogue and nothing else, so the 1-star cells are four fighters
    const chars = COMPS[comp].map((cls, i) => mkChar(mods, i + 1, rand, stars, stars === 1 ? 'fighter' : cls));
    if (chars.some(c => !c)) return null;
    if (quality >= 0) for (const c of chars) gearUp(Econ, c, quality, rand);
    const zone = zoneOf(level, id);
    return chars.map(c => Combat.fromCharacter(c, Missions.prepare(c, zone), {}));
  };
  // hostile side as sortie.js rateFoe gives it: stat block at the pack's level, tierMult at the middle of the species' range
  const foeActors = (id, n, level) => {
    const def = Missions.BESTIARY[id], range = Missions.TIERS[def.tier];
    const block = Combat.baseOfMonster(def, level, { tierMult: (range[0] + range[1]) / 2 }), r = Combat.rating(block);
    return Array.from({ length: n }, () => ({ alive: true, hp: block.hp, power: r.power, guard: guardOf(block.base) }));
  };
  const tableFoes = (id, n) => { const t = Missions.BESTIARY[id].tier; return Array.from({ length: n }, () => ({ alive: true, hp: Field.GRADE_HP[t], power: Field.GRADE_POWER[t] })); };

  const started = Date.now();
  const rows = [];
  for (const comp of comps) for (const gear of gears) for (const level of LEVELS) for (const stars of STARS) for (const [id, n] of PACKS) {
    const row = { comp, gear: gear.id, level, stars, pack: id + 'x' + n, runs: [], table: [] };
    let won = 0, made = 0;
    for (let r = 0; r < cellRuns; r++) {
      const rr = mulberry(1000 + r + 7919 * num('FIT_SEED', 0));
      Rng.withSource(rr, () => {
        const P = squadOf(comp, stars, gear.quality, rr, level, id);
        if (!P) return;
        made++;
        const rates = P.map(f => Combat.rating(f));
        row.runs.push({ pow: rates.map(x => x.power), hpg: P.map((f, i) => ({ hp: f.maxHp, guard: guardOf(f.base) })) });
        row.table.push(Field.odds(P.map(f => ({ alive: true, hp: f.maxHp, power: 4 })), tableFoes(id, n), 8));
        const H = Array.from({ length: n }, () => Missions.spawn(id, level, {}));
        if (Combat.encounter(P, H, { frontage: 8 }).won) won++;
      });
    }
    if (!made) continue;
    row.win = won / made;
    row.foes = foeActors(id, n, level);
    rows.push(row);
  }
  const readingAt = (row, K) => mean(row.runs.map(run => Field.odds(
    run.pow.map((p, i) => ({ alive: true, hp: run.hpg[i].hp, power: K * p, guard: run.hpg[i].guard })), row.foes, 8)));
  const tableOf = (row) => mean(row.table);

  const K0 = Combat.RATE_K;
  console.log(`fit: ${rows.length} cells (${comps.join(', ')} x ${gears.map(g => g.id).join(', ')} x levels ${LEVELS.join('/')} x stars ${STARS.join('/')} x ${PACKS.length} packs), ${cellRuns} combat.js encounters per cell, ${((Date.now() - started) / 1000).toFixed(0)} s`);

  const line = (label, rs) => console.log(label.padEnd(16) + ('n ' + rs.length).padEnd(8) + 'table reading ' + fix(spearman(rs.map(tableOf), rs.map(r => r.win))) + '   rating (K=' + K0 + ') ' + fix(spearman(rs.map(r => readingAt(r, K0)), rs.map(r => r.win))));
  console.log('Spearman of the odds reading against the combat.js win rate:');
  line('all', rows);
  for (const c of comps) line('comp ' + c, rows.filter(r => r.comp === c));
  for (const g of gears) line(g.id, rows.filter(r => r.gear === g.id));
  for (const l of LEVELS) line('level ' + l, rows.filter(r => r.level === l));
  for (const st of STARS) line('stars ' + st, rows.filter(r => r.stars === st));

  // K sweep: classification of win > 0.5 by odds > 0.5, and where the cells that are close to a coin flip read
  const grid = [];
  for (let K = 0.5; K <= 6.001; K += 0.05) grid.push(Math.round(K * 100) / 100);
  const sweepOf = (rs) => {
    const mid = rs.filter(r => r.win > 0.2 && r.win < 0.8);
    return grid.map(K => {
      const rd = rs.map(r => readingAt(r, K));
      return { K, acc: rs.filter((r, i) => (rd[i] > 0.5) === (r.win > 0.5)).length / rs.length, median: quantile(mid.map(r => readingAt(r, K)), 0.5), mid: mid.length };
    });
  };
  // the K at which the median reading of the coin-flip cells is 0.5: linear interpolation between the two grid points that bracket it
  const fittedOf = (sw) => {
    for (let i = 1; i < sw.length; i++) {
      const a = sw[i - 1], b = sw[i];
      if (a.median <= 0.5 && b.median >= 0.5) return a.K + (0.5 - a.median) / ((b.median - a.median) || 1) * (b.K - a.K);
    }
    return NaN;
  };
  const sweep = sweepOf(rows);
  console.log(`\nK sweep (${sweep[0].mid} cells have a win rate in 0.2..0.8):`);
  console.log('K'.padEnd(6) + 'accuracy'.padEnd(10) + 'median reading of those cells');
  for (const w of sweep) if ([0.5, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 6].some(k => Math.abs(k - w.K) < 1e-6)) console.log(String(w.K).padEnd(6) + (pct(w.acc) + '%').padEnd(10) + fix(w.median));
  const fitted = fittedOf(sweep);
  const best = sweep.reduce((p, w) => (w.acc > p.acc + 1e-9 ? w : p), sweep[0]);
  const plateau = sweep.filter(w => w.acc >= best.acc - 0.01).map(w => w.K);
  console.log(`\nfitted RATE_K (median reading of the coin-flip cells = 0.5): ${fix(fitted)}; best classification accuracy ${pct(best.acc)}% at K ${best.K}, within one point of it for K ${Math.min(...plateau)}..${Math.max(...plateau)}; Combat.RATE_K is ${K0}`);
  const groups = [...comps.map(c => [c, rows.filter(r => r.comp === c)]), ...gears.map(g => [g.id, rows.filter(r => r.gear === g.id)])];
  console.log('fitted K by group: ' + groups.map(([label, rs]) => `${label} ${fix(fittedOf(sweepOf(rs)))}`).join(', '));
  if (!isNaN(fitted) && Math.abs(fitted - K0) > 0.25) console.log(`Combat.RATE_K differs from the fit by more than 0.25: set it to ${fitted.toFixed(1)}`);

  console.log(`\nat K = ${K0}, by composition and gear: accuracy of odds > 0.5 against win > 0.5, mean reading, mean win rate`);
  const breakdown = (label, rs) => {
    const rd = rs.map(r => readingAt(r, K0));
    const acc = rs.filter((r, i) => (rd[i] > 0.5) === (r.win > 0.5)).length / rs.length;
    console.log(('  ' + label).padEnd(12) + (pct(acc) + '%').padEnd(6) + fix(mean(rd)).padEnd(7) + fix(mean(rs.map(r => r.win))));
  };
  for (const c of comps) breakdown(c, rows.filter(r => r.comp === c));
  for (const g of gears) breakdown(g.id, rows.filter(r => r.gear === g.id));
  if (env.FIT_OUT) {
    fs.writeFileSync(env.FIT_OUT, JSON.stringify(rows.map(r => ({ comp: r.comp, gear: r.gear, level: r.level, stars: r.stars, pack: r.pack, win: r.win, table: tableOf(r), rating: readingAt(r, K0) }))));
    console.log('wrote ' + env.FIT_OUT);
  }
  return 0;
}

// ---------- check ----------

/** Assertions on the pieces: combat.js rating, field.js's rate hook / guard / pace, and sortie.js's wiring in a booted page. */
async function check() {
  const Rng = req('rng'), MT = req('missiontypes'), Field = req('field'), Combat = req('combat'), Missions = req('missions');
  let failed = 0;
  const ok = (cond, what) => { console.log((cond ? 'ok   ' : 'FAIL ') + what); if (!cond) failed++; };
  const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
  const draws = (body) => { let n = 0; Rng.withSource(() => { n++; return 0.5; }, body); return n; };

  // ----- combat.js -----
  let same = true, rng = 0, n = 0;
  for (const def of Object.values(Missions.BESTIARY)) for (const level of [1, 3, 8, 14]) for (const mods of [{}, { tierMult: 1.2, rarityMult: 1.35 }]) {
    let block, mon;
    rng += draws(() => { block = Combat.baseOfMonster(def, level, mods); });
    Rng.withSource(() => 0.5, () => { mon = Combat.fromMonster(def, level, mods, {}); });
    n++;
    if (JSON.stringify(block.base) !== JSON.stringify(mon.base) || JSON.stringify(block.res) !== JSON.stringify(mon.res) || block.hp !== mon.maxHp || mon.hp !== mon.maxHp) same = false;
  }
  ok(same, `baseOfMonster gives the hp, base block and resistances fromMonster puts on a combatant (${n} species x level x mods)`);
  ok(rng === 0, `baseOfMonster draws no random number (${rng} draws)`);
  ok(draws(() => Combat.fromMonster(Missions.BESTIARY.goblin, 3, {}, {})) >= 1, 'fromMonster still draws (control for the count above)');
  const golem = Combat.baseOfMonster(Missions.BESTIARY.stone_golem, 8, {}), gr = Combat.rating(golem), gb = golem.base;
  ok(near(gr.power, Math.max(gb.damage, gb.magicDamage) * gb.speed / Combat.BAR * (1 + gb.crit * (gb.critDamage - 1))), 'rating power = max(damage, magicDamage) x speed / BAR x (1 + crit x (critDamage - 1))');
  ok(near(gr.guard, 1 + gb.armor / Combat.ARMOR_PER_GUARD) && gr.guard > 1, `rating guard = 1 + armor / ${Combat.ARMOR_PER_GUARD} (stone golem at level 8: armor ${gb.armor.toFixed(1)}, guard ${gr.guard.toFixed(2)})`);
  const rat = Combat.rating(Combat.baseOfMonster(Missions.BESTIARY.forest_rat, 3, {}));
  ok(rat.guard === 1 && rat.power > 0 && rat.power < gr.power, 'an unarmoured rat has guard 1 and less power than a golem');
  ok(Combat.rating(Combat.fromMonster(Missions.BESTIARY.stone_golem, 8, {}, {})).power > 0, 'rating accepts a combatant as well as a block');

  // ----- field.js -----
  ok(near(Field.odds([{ hp: 100, power: 1 }], [{ hp: 100, power: 1 }]), 0.5), 'odds of equal sides is 0.5');
  ok(near(Field.odds([{ hp: 100, power: 1, guard: 2 }], [{ hp: 100, power: 1 }]), 2 / 3), 'guard 2 doubles the hp the odds count (2 / 3)');
  ok([[3, 0.9], [3.6, 0.9], [4, 1], [4.2, 1.05], [4.4, 1.1], [9, 1.1], [undefined, 1]].every(([w, p]) => near(Field.pace(w), p)), 'pace = walkSpeed / 4 held to 0.9..1.1');

  const namer = (g, mission) => {
    const all = Object.values(Missions.BESTIARY).filter(m => m.tier === (MT.SPECIES_TIER[g.grade] || 'basic'));
    const d = all[0];
    return { id: d.id, label: d.name, icon: d.icon, attrs: d.attrs, tags: d.tags };
  };
  const calls = [];
  const stub = { power: 7, hp: 123, guard: 1.5 };
  const rate = (species, g, mission) => { calls.push({ species, grade: g.grade, level: mission.level }); return stub; };
  // a squad that cannot die and barely hurts anything, so the mission is still running when the second wave arrives
  const party = () => Array.from({ length: 4 }, (_, i) => ({ name: 'P' + i, maxHp: 1e9, power: 0.001 }));
  const wild = (s) => s.actors.filter(a => a.side === 'theirs' && ['hostile', 'patrol', 'mark'].includes(a.role));
  const carries = (a) => a.power === stub.power && a.maxHp === stub.hp && a.guard === stub.guard;
  let s;
  Rng.withSource(mulberry(5), () => {
    s = Field.start(MT.roll('survival', { level: 3 }), { party: party(), name: namer, rate });
    const first = wild(s);
    ok(first.length > 0 && first.every(a => carries(a) && a.hp === stub.hp), `start: all ${first.length} hostiles at the start take power / hp / maxHp / guard from rate`);
    ok(calls.length >= first.length && calls.every(c => typeof c.species === 'string' && c.level === 3), 'rate is called with the species id, the group and the mission');
    const structures = s.actors.filter(a => a.role === 'structure');
    ok(structures.every(a => a.power === 0 && a.guard === undefined), 'structures are not rated and keep power 0');
    const before = s.actors.length;
    for (let i = 0; i < 600 && s.wave < 2 && !s.result; i++) Field.step(s);
    const later = wild(s).filter(a => a.id > Math.max(...first.map(x => x.id)));
    ok(s.wave >= 2 && s.actors.length > before && later.length > 0 && later.every(carries), `wave spawn (spawnGroup): ${later.length} hostiles of wave ${s.wave} take their numbers from rate`);
    const count = wild(s).length;
    Field.escalate(s, 'check');
    const escalated = wild(s).slice(count);
    ok(escalated.length > 0 && escalated.every(carries), `escalation: ${escalated.length} reinforcements take their numbers from rate`);
  });
  const saved = JSON.parse(JSON.stringify(Field.save(s)));
  const back = Field.restore(saved, { name: namer, rate });
  ok(back && back.rate === rate, 'restore keeps the rate hook it is given');
  ok(wild(back).length === wild(s).length && wild(back).every(a => { const o = s.actors.find(x => x.id === a.id); return o && a.power === o.power && a.guard === o.guard && a.hp === o.hp && a.maxHp === o.maxHp; }),
    'a saved and restored run keeps power, hp, maxHp and guard on every hostile (ACTOR_KEYS)');
  Rng.withSource(mulberry(6), () => {
    const known = new Set(back.actors.map(a => a.id));
    for (let i = 0; i < 800 && back.wave < s.wave + 1 && !back.result; i++) Field.step(back);
    const fresh = wild(back).filter(a => !known.has(a.id));
    ok(fresh.length > 0 && fresh.every(carries), `after restore, a new wave (${fresh.length} hostiles) is rated by the hook`);
  });
  Rng.withSource(mulberry(7), () => {
    const plain = Field.start(MT.roll('extermination', { level: 3 }), { party: party(), name: namer });
    const grades = wild(plain).filter(a => !a.levelOffset && a.role === 'hostile');
    ok(grades.length > 0 && grades.every(a => a.power === Field.GRADE_POWER[a.grade] && a.hp === Field.GRADE_HP[a.grade] && a.guard === undefined), 'without a rate hook the GRADE_POWER / GRADE_HP rows apply and there is no guard');
    const answerless = Field.start(MT.roll('extermination', { level: 3 }), { party: party(), name: namer, rate: () => null });
    ok(wild(answerless).filter(a => !a.levelOffset && a.role === 'hostile').every(a => a.power === Field.GRADE_POWER[a.grade] && a.guard === undefined), 'a rate hook that answers null falls back to the grade rows');
  });

  // a detail that is still running when the squad starts leaving is dissolved, so its members walk out
  Rng.withSource(mulberry(8), () => {
    const t = Field.start(MT.roll('extermination', { level: 3 }), { party: party(), name: namer });
    const crew = t.actors.filter(a => a.role === 'squad');
    t.details.push({ id: 'dT', kind: 'stand', label: 'a stand', since: 0, members: crew.map(a => a.id), point: { x: t.map.entry.x, y: t.map.entry.y }, sneak: true });
    for (const a of crew) a.sneak = true;
    Field.step(t);
    ok(t.details.length === 1 && crew.every(a => a.goal && a.goal.kind === 'point'), 'a stand in progress sends its members to the stand point');
    t.withdrew = { why: 'check', at: t.clock, ordered: false }; t.phase = 'leaving';   // what withdraw() sets
    Field.step(t);
    ok(t.details.length === 0 && crew.every(a => a.goal && a.goal.kind === 'exit' && !a.sneak), 'once the squad is leaving the detail is dissolved: every member heads for the exit and none is left sneaking');
  });

  // ----- step-back cap (field.js replan) -----
  // tactics stub that proposes a retreat every time it is asked and ends the previous one: what tactics.js does while a
  // spotted hostile stays at its post (nothing is closing while the squad walks away, so the detail ends; it is closing
  // again once the squad is back at its task, so a new one starts)
  const stepBackStub = (log) => (s) => {
    const crew = s.actors.filter(a => a.role === 'squad' && a.alive && !a.extracted);
    log.asked++;
    return { start: [{ id: 'dR' + log.asked, kind: 'retreat', label: 'a step back', since: s.clock, members: crew.map(a => a.id), sneak: false, line: 'step back #' + log.asked }], end: (s.details || []).map(d => d.id), leave: null };
  };
  const startedSteps = (s) => s.log.filter(l => /^step back #/.test(l.text)).length;
  Rng.withSource(mulberry(9), () => {
    const log = { asked: 0 };
    const t = Field.start(MT.roll('extermination', { level: 3 }), { party: party(), name: namer, tactics: stepBackStub(log) });
    for (let i = 0; i < 400 && !t.withdrew; i++) Field.step(t);
    ok(t.withdrew && startedSteps(t) === Field.STEPS_BACK && log.asked === Field.STEPS_BACK + 1, `step-back cap: ${startedSteps(t)} step-backs start (STEPS_BACK ${Field.STEPS_BACK}), the proposal after them (number ${log.asked}) becomes a withdrawal at clock ${t.clock}`);
    ok(t.withdrew && new RegExp('^stepped back ' + Field.STEPS_BACK + ' times').test(t.withdrew.why) && t.phase === 'leaving' && !t.withdrew.ordered, 'the withdrawal says why: "' + (t.withdrew && t.withdrew.why) + '"');
    Field.step(t);
    ok(t.details.length === 0 && t.actors.filter(a => a.role === 'squad').every(a => a.goal && a.goal.kind === 'exit'), 'after the cap the squad is leaving: no detail left, every member heads for the exit');
    const asked = log.asked;
    for (let i = 0; i < 100; i++) Field.step(t);
    ok(log.asked === asked, 'a withdrawing squad is not asked for a plan again');
  });
  Rng.withSource(mulberry(10), () => {
    const log = { asked: 0 };
    const t = Field.start(MT.roll('extermination', { level: 3 }), { party: party(), name: namer, tactics: stepBackStub(log) });
    ok(t.counters.stepsBack === 0, 'a new run has counters.stepsBack 0');
    t.counters.stepsBack = Field.STEPS_BACK;
    const sq = t.actors.find(a => a.role === 'squad'), foe = t.actors.find(a => a.side === 'theirs' && a.role === 'hostile');
    foe.x = sq.x + 1; foe.y = sq.y;
    for (let i = 0; i < 5 && !t.counters.fights; i++) Field.step(t);
    ok(t.counters.fights > 0 && t.counters.stepsBack === 0, `a fight resets counters.stepsBack (fights ${t.counters.fights}, stepsBack ${t.counters.stepsBack})`);
    const u = Field.start(MT.roll('extermination', { level: 3 }), { party: party(), name: namer, tactics: stepBackStub(log) });
    u.counters.stepsBack = Field.STEPS_BACK;
    const back = Field.restore(JSON.parse(JSON.stringify(Field.save(u))), { name: namer, tactics: stepBackStub(log) });
    ok(back.counters.stepsBack === Field.STEPS_BACK, 'a saved and restored run keeps counters.stepsBack');
    const old = JSON.parse(JSON.stringify(Field.save(u)));
    delete old.counters.stepsBack;
    const legacy = Field.restore(old, { name: namer, tactics: stepBackStub(log) });
    for (let i = 0; i < 20 && !legacy.details.length && !legacy.withdrew; i++) Field.step(legacy);
    ok(legacy.details.length === 1 && !legacy.withdrew, 'a save from before the counter reads 0: its first step-back starts a detail');
  });

  // ----- sortie.js in a booted page -----
  const SH = require('./sortie.harness.js');
  const { boot } = require('./game.boot.js');
  const lab = await SH.setup({ poolSize: 8 });
  if (lab.bootFailed || lab.failed) { console.log('FAIL page did not boot: ' + (lab.failed || 'boot errors')); lab.b.dispose(); return 2; }
  const { b, ctx, st, S } = lab;
  const C = ctx.Combat, F = ctx.Field, Bump = { basic: 0, veteran: 0, elite: 1, ancient: 3, legendary: 4 };
  const mission = b.withSeed(11, () => S.board(st, true).find(m => m.party[0] <= 4 && m.party[1] >= 4));
  const ids = st.characters.slice(0, 4).map(c => c.id);
  const run = b.withSeed(11, () => S.launch(mission, ids));
  if (typeof run === 'string') { console.log('FAIL launch refused: ' + run); lab.b.dispose(); return 2; }
  const field = S.run.field;
  const squad = field.actors.filter(a => a.role === 'squad');
  ok(squad.length === 4 && squad.every(a => near(a.power, C.RATE_K * C.rating(a.fighter).power) && near(a.guard, C.rating(a.fighter).guard)), 'launch: each squad actor has power = RATE_K x rating(fighter).power and guard = rating(fighter).guard');
  ok(squad.every(a => near(a.speed, F.BASE_SPEED * F.pace(ctx.Stats.effective(a.char).derived.walkSpeed)) && a.speed >= 0.9 * F.BASE_SPEED - 1e-9 && a.speed <= 1.1 * F.BASE_SPEED + 1e-9), `launch: squad speed is BASE_SPEED x pace(walkSpeed), held to 0.9..1.1 (${squad.map(a => (a.speed / F.BASE_SPEED).toFixed(2)).join(' ')})`);
  const foes = field.actors.filter(a => a.side === 'theirs' && a.species && a.role !== 'structure');
  const expectFoe = (a) => {
    const def = ctx.Missions.BESTIARY[a.species], range = ctx.Missions.TIERS[def.tier];
    const level = Math.max(1, S.run.mission.level + (Bump[a.grade] || 0) + (a.levelOffset || 0));
    const block = C.baseOfMonster(def, level, { tierMult: (range[0] + range[1]) / 2 }), r = C.rating(block);
    return { power: r.power, hp: block.hp, guard: r.guard };
  };
  ok(foes.length > 0 && foes.every(a => { const e = expectFoe(a); return near(a.power, e.power) && a.hp === e.hp && near(a.guard, e.guard); }), `launch: all ${foes.length} hostiles carry rating(baseOfMonster at mission level + grade bump + levelOffset, mean tier), no RATE_K`);
  ok(foes.every(a => !a.fighter), 'launch: no hostile has a combat.js fighter yet, so its numbers did not come through fighterFor');
  // a save and a second boot
  b.advance(20000);
  b.fire('window', 'beforeunload');
  const key = (a) => [a.id, a.power, a.guard, a.speed, a.maxHp].join('|');
  const before = field.actors.filter(a => a.alive && (a.role === 'squad' || a.species)).map(a => (a.role === 'squad' ? key(a) : [a.id, a.power, a.guard, a.speed].join('|'))).sort();
  const b2 = await boot({ html: lab.cfg.html, storage: new Map(b.localStorage.map) });
  const run2 = b2.Sortie && b2.Sortie.run;
  if (!run2) { ok(false, 'second boot resumed the run'); }
  else {
    const after = run2.field.actors.filter(a => a.alive && (a.role === 'squad' || a.species)).map(a => (a.role === 'squad' ? key(a) : [a.id, a.power, a.guard, a.speed].join('|'))).sort();
    ok(JSON.stringify(before) === JSON.stringify(after), `resume: ${after.length} actors come back with the same power, guard and speed`);
    b2.dispose();
  }
  // the dungeon contracts of SEED=1 that looped before the cap (4 to 175 retreat proposals, 400 to 4584 s): whatever they do
  // now, a run stays within retreatBound, and a run that reaches the cap ends with its withdrawal
  const loopSeeds = [[6155498, 6], [9716284, 5], [1337964, 5], [6679143, 6], [2280525, 4], [1861609, 5], [4060918, 6], [1966338, 6]];
  const big = await SH.setup();
  if (big.bootFailed || big.failed) { ok(false, 'second page for the loop seeds booted: ' + (big.failed || 'boot errors')); }
  else {
    instrument(big);
    let worst = 0, capped = 0, longest = 0;
    for (const [seed, level] of loopSeeds) {
      big.tally = { starts: {}, leaves: 0, readings: [] };
      const r = big.play({ seed, type: 'dungeon', level });
      const field = big.S.run && big.S.run.field;
      r.starts = big.tally.starts; r.skirmishes = field && field.counters ? field.counters.fights || 0 : null;
      big.tally = null;
      worst = Math.max(worst, (r.starts.retreat || 0) - retreatBound(r));
      if (field && field.withdrew && /^stepped back/.test(field.withdrew.why || '')) capped++;
      longest = Math.max(longest, r.clock || 0);
      big.restore();
    }
    ok(worst <= 0, `loop seeds: retreat proposals stay within ${STEPS_BACK + 1} per stretch between fights in all ${loopSeeds.length} runs (${capped} of them ended by the cap, longest run ${Math.round(longest)} s)`);
    ok(big.b.errors.length - big.bootErrors === 0, 'no uncaught exception while playing the loop seeds');
    big.b.dispose();
  }
  const late = b.errors.length - lab.bootErrors;
  ok(late === 0, `no uncaught exception in the page after boot (${late})`);
  b.dispose();
  console.log(failed ? `${failed} FAILED` : 'all passed');
  return failed ? 1 : 0;
}

// ---------- main ----------

async function main() {
  const cmd = process.argv[2] || 'all';
  if (cmd === 'compare') {
    if (process.argv.length < 5) { console.log('usage: node test/rating.harness.js compare a.json b.json'); return 2; }
    compare(process.argv[3], process.argv[4]);
    return 0;
  }
  if (cmd === 'sorties') return sorties();
  if (cmd === 'fit') return fit();
  if (cmd === 'check') return check();
  if (cmd === 'all') { const code = fit(); return code || sorties(); }
  console.log('usage: node test/rating.harness.js [fit | sorties | check | compare a.json b.json]');
  return 2;
}

if (require.main === module) main().then((code) => { process.exitCode = code; }, (e) => { console.error(e); process.exitCode = 2; });
module.exports = { figures };
