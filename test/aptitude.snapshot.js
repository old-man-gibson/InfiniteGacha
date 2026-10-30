// Aptitude-fraction snapshot: prints every reader of "aptitude as a fraction of a ladder ceiling" for
// 300 seeded characters, then a SHA-256 of the printed lines. Run it before and after any change to
// proficiency.js (share), ai.js (scouting), classes.js (advise, leanings, fitness), tactics.js
// (fitFor) or prowess.js (of); the digest must not change unless the change is meant to move one of
// those numbers.
//   node test/aptitude.snapshot.js             one line per character, then the digest
//   node test/aptitude.snapshot.js --digest    the digest only
//   EXPECT=<hex> node test/aptitude.snapshot.js --digest    exits 1 when the digest differs
// Numbers are printed with String(), which round-trips a double, so equal digests mean equal bits.
// Characters come from mulberry32 seeds, so nothing here touches Rng or Date.
//
// The share section after the digest checks Prof.share against the expressions it replaced, for
// every stage and level on the ladder. It is skipped when Prof.share does not exist, so the same
// file runs against code from before the change.
const path = require('path');
const crypto = require('crypto');
const root = path.join(__dirname, '..');
const req = (m) => require(path.join(root, m + '.js'));
const Stats = req('stats'), Prof = req('proficiency'), Temper = req('temper'), AI = req('ai'),
  Classes = req('classes'), Tactics = req('tactics'), Prowess = req('prowess'), Crew = req('crew');

function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const RACES = ['human', ...Object.keys(Prof.RACE_BIAS)];
const BASES = Classes.BASES.map(b => b.id);
const WANTED = Classes.LIST.filter(cl => cl.want);          // every class fitness() scores
const N = 300;

function makeChar(i) {
  const rand = mulberry(i * 977 + 13);
  const race = RACES[Math.floor(rand() * RACES.length)];
  const stars = 1 + Math.floor(rand() * 5);
  // mind.social is set here because crew.js rolls it from Rng on first read, which would make teamwork() differ between runs
  const c = { id: i + 1, name: 'C' + (i + 1), race, stats: Stats.rollCharacterStats(race, rand, stars), equipment: {}, mind: { traits: [], social: Crew.rollSocial(rand) }, temper: Temper.roll(rand), gifts: [], xp: {}, potions: [] };
  c.profs = Prof.rollAll(stars, race, rand);
  // rollAll stops at B+. Lift a third of the characters onto the whole ladder (S, S*, S** included)
  // so the readers see values above A+, which is where clamped and unclamped sites differ.
  if (i % 3 === 0) {
    for (const k of Object.keys(c.profs)) if (rand() < 0.5) c.profs[k] = { stage: Math.floor(rand() * Prof.STAGES.length), level: 1 + Math.floor(rand() * Prof.LEVELS_PER_STAGE) };
  }
  // the edges of the ladder and of the data: nothing, a floor, the A+ ceiling, the S** ceiling
  const top = Prof.STAGES.length - 1;
  if (i === 0) c.profs = undefined;
  else if (i === 1) c.profs = {};
  else if (i === 2) for (const k of Object.keys(c.profs)) c.profs[k] = { stage: 0, level: 1 };
  else if (i === 3) for (const k of Object.keys(c.profs)) c.profs[k] = { stage: Prof.MAX_ADVANCE_STAGE, level: Prof.LEVELS_PER_STAGE };
  else if (i === 4) for (const k of Object.keys(c.profs)) c.profs[k] = { stage: top, level: Prof.LEVELS_PER_STAGE };
  else if (i === 5) for (const k of Object.keys(c.profs)) c.profs[k] = { stage: Prof.MAX_ADVANCE_STAGE, level: Prof.LEVELS_PER_STAGE - 1 };
  else if (i === 6) for (const k of Object.keys(c.profs)) c.profs[k] = { stage: Prof.MAX_ADVANCE_STAGE + 1, level: 1 };
  Classes.assign(c, BASES[i % BASES.length], { force: true });
  c.class.xp = (i * 7) % 150;
  return c;
}

const lines = [];
for (let i = 0; i < N; i++) {
  const c = makeChar(i);
  const advise = Classes.advise(c, 3).map(a => `${a.cl.id}:${a.score}`).join(',');
  const lean = Classes.leanings(c, 3).map(l => `${l.def.id}:${l.fit}`).join(',');
  const fit = WANTED.map(cl => `${cl.id}:${Classes.fitness(c, cl)}`).join(',');
  const fitHash = crypto.createHash('sha256').update(fit).digest('hex').slice(0, 12);
  const fitMax = WANTED.reduce((m, cl) => Math.max(m, Classes.fitness(c, cl)), 0);
  const roles = ['strike', 'anchor', 'backer'].map(r => Tactics.fitFor(r, c)).join(',');
  const pw = Prowess.of(c).axes.map(a => a.value).join(',');
  lines.push(`${i} ${c.race} ${c.class.id} advise=[${advise}] lean=[${lean}] fit#${fitHash} fitMax=${fitMax} scout=${AI.scouting(c)} roles=[${roles}] prowess=[${pw}]`);
}
const digest = crypto.createHash('sha256').update(lines.join('\n')).digest('hex');

const digestOnly = process.argv.includes('--digest');
if (!digestOnly) for (const l of lines) console.log(l);
console.log('digest ' + digest);
if (process.env.EXPECT && process.env.EXPECT !== digest) { console.error('digest differs from EXPECT=' + process.env.EXPECT); process.exit(1); }

// ---------- Prof.share against the expressions it replaced ----------
if (typeof Prof.share !== 'function') {
  console.log('Prof.share not present: skipped the equivalence check');
} else {
  const adv = Prof.toAbsolute({ stage: Prof.MAX_ADVANCE_STAGE, level: Prof.LEVELS_PER_STAGE });                 // old ai.js, classes.js, tactics.js
  const ladder = Prof.toAbsolute({ stage: Prof.STAGES.length - 1, level: Prof.LEVELS_PER_STAGE });              // old prowess.js capAbs
  let checked = 0, bad = 0;
  const same = (what, got, want, e) => { checked++; if (!Object.is(got, want)) { bad++; if (bad <= 10) console.error(`share mismatch ${what} at ${JSON.stringify(e)}: ${got} vs ${want}`); } };
  for (let stage = 0; stage < Prof.STAGES.length; stage++) {
    for (let level = 1; level <= Prof.LEVELS_PER_STAGE; level++) {
      const e = { stage, level }, abs = Prof.toAbsolute(e);
      same('default', Prof.share(e), abs / adv, e);
      same('advance', Prof.share(e, { ceiling: 'advance' }), abs / adv, e);
      same('advance clamp', Prof.share(e, { clamp: true }), Math.min(1, abs / adv), e);
      same('ladder', Prof.share(e, { ceiling: 'ladder' }), abs / ladder, e);
      same('ladder clamp', Prof.share(e, { ceiling: 'ladder', clamp: true }), Math.min(1, abs / ladder), e);
    }
  }
  // the two ceilings are the numbers the proposal names
  same('advance top', adv, 539, null); same('ladder top', ladder, 689, null);
  console.log(`share equivalence: ${checked} checks, ${bad} mismatches`);
  if (bad) process.exit(1);
}
