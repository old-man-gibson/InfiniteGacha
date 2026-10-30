// Exploration harness: how well a squad searches a map it does not know. Run from anywhere:
//   node test/explore.harness.js [runs] [scout...]        scout values default to 0 30 60
// Each run rolls a recon (or TYPES=a,b), strips every hostile so nothing interrupts the walk, sets the reveal term
// to 95% of the ground and steps until that is met or CAP seconds pass. Plain party of 3, no characters.
// TRACE=type:seed:scout prints that one run's map instead: digits are how many times the first squad member
// stepped onto the tile (9 = nine or more), . unwalked seen floor, , unseen floor, # rock, E the entry.
// Columns, averaged over runs:
//   t50 / t80 / t95  seconds until that fraction of walkable ground was revealed (CAP when never reached)
//   seen@600         fraction revealed after 600 s
//   reseen           squad-centroid steps onto a tile the centroid had already stood on, per 100 steps walked
//   lead             the same for the first squad member alone: steps onto a tile they already stood on, per 100
//   walked           tiles walked by the first squad member before 95% (or the cap)
//   flips            re-picks whose new heading points more than 120 degrees away from the last one
//   picks            beacon re-picks per run
const path = require('path');
const root = path.join(__dirname, '..');
const req = (m) => require(path.join(root, m + '.js'));
const Rng = req('rng'), MT = req('missiontypes'), Field = req('field');

const CAP = +process.env.CAP || 2400;
const runs = +process.argv[2] || 40;
const scouts = process.argv.slice(3).length ? process.argv.slice(3).map(Number) : [0, 30, 60];
const TYPES = process.env.TYPES ? process.env.TYPES.split(',') : ['recon', 'retrieval', 'extermination', 'dungeon'];

function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function one(type, seed, scout, trace = false) {
  const rand = mulberry(seed);
  const M = Math.random; Math.random = rand;
  try {
    return Rng.withSource(rand, () => {
      const mission = MT.roll(type, { level: 1 + Math.floor(rand() * 4) });
      mission.win = [{ atom: 'reveal', fraction: 0.95, zone: 'objective' }, { atom: 'extract', who: 'squad', count: 'all' }];
      mission.lose = []; mission.bonus = []; mission.deadline = 0; mission.twists = mission.twists.filter(t => t !== 'night');
      const party = [0, 1, 2].map(i => ({ name: 'S' + i, maxHp: 999, power: 5 }));
      const s = Field.start(mission, { party, scout });
      s.actors = s.actors.filter(a => a.side !== 'theirs');
      for (const g of s.map.spawns) g.deferred = false, g.points = [];
      const marks = { t50: CAP, t80: CAP, t95: CAP };
      let at600 = null, walked = 0, reseen = 0, flips = 0, picks = 0, lastHead = null, lastBeacon = null;
      const stood = new Set(), trod = new Map();
      let lead = 0, leadBack = 0, lastLead = null;
      let prev = null;
      for (let t = 0; t < CAP && !s.result; t++) {
        Field.step(s);
        const sq = s.actors.filter(a => a.role === 'squad' && a.alive && !a.extracted);
        if (!sq.length) break;
        const c = { x: Math.round(sq.reduce((n, a) => n + a.x, 0) / sq.length), y: Math.round(sq.reduce((n, a) => n + a.y, 0) / sq.length) };
        const k = c.y * s.map.w + c.x;
        if (prev !== k) { walked++; if (stood.has(k)) reseen++; stood.add(k); prev = k; }
        const L = s.actors.find(a => a.role === 'squad');
        const lk = L.y * s.map.w + L.x;
        if (lk !== lastLead) { lead++; if (trod.has(lk)) leadBack++; trod.set(lk, (trod.get(lk) || 0) + 1); lastLead = lk; }
        if (s.beacon && s.beacon !== lastBeacon) {
          picks++;
          if (lastHead && s.heading && lastHead.x * s.heading.x + lastHead.y * s.heading.y < -0.5) flips++;
          lastHead = s.heading; lastBeacon = s.beacon;
        }
        const f = s.counters.revealed / s.walkable;
        if (f >= 0.5 && marks.t50 === CAP) marks.t50 = s.clock;
        if (f >= 0.8 && marks.t80 === CAP) marks.t80 = s.clock;
        if (f >= 0.95 && marks.t95 === CAP) marks.t95 = s.clock;
        if (s.clock >= 600 && at600 === null) at600 = f;
        if (s.phase === 'leaving' || f >= 0.95) break;
      }
      if (at600 === null) at600 = s.counters.revealed / s.walkable;
      if (trace) {
        const rows = [];
        for (let y = 0; y < s.map.h; y++) {
          let r = '';
          for (let x = 0; x < s.map.w; x++) {
            const i = y * s.map.w + x;
            r += (x === s.map.entry.x && y === s.map.entry.y) ? 'E' : trod.has(i) ? String(Math.min(9, trod.get(i))) : !s.map.passable(x, y) ? '#' : s.seen[i] ? '.' : ',';
          }
          rows.push(r);
        }
        console.log(rows.join('\n'));
      }
      return { ...marks, at600, reseen: walked ? 100 * reseen / walked : 0, lead: lead ? 100 * leadBack / lead : 0, walked: lead, flips, picks, map: s.map.archetype };
    });
  } finally { Math.random = M; }
}

if (process.env.TRACE) {
  const [type, seed, scout] = process.env.TRACE.split(':');
  const r = one(type, +seed, +scout, true);
  console.log(JSON.stringify(r));
  process.exit(0);
}
console.log(`${runs} runs per type over ${TYPES.join(', ')}, hostiles removed, cap ${CAP}s`);
console.log('scout  t50    t80    t95    seen@600  reseen  lead   walked  flips  picks');
for (const scout of scouts) {
  const acc = { t50: 0, t80: 0, t95: 0, at600: 0, reseen: 0, lead: 0, walked: 0, flips: 0, picks: 0 }; let n = 0;
  for (const type of TYPES) for (let i = 0; i < runs; i++) {
    const r = one(type, 7919 * i + TYPES.indexOf(type) * 13 + 3, scout);
    for (const key in acc) acc[key] += r[key];
    n++;
  }
  const a = (key, d = 0) => (acc[key] / n).toFixed(d);
  console.log(String(scout).padEnd(7) + a('t50').padEnd(7) + a('t80').padEnd(7) + a('t95').padEnd(7) + (a('at600', 2)).padEnd(10) + a('reseen', 1).padEnd(8) + a('lead', 1).padEnd(7) + a('walked').padEnd(8) + a('flips', 1).padEnd(7) + a('picks', 1));
}
