// Roll a lot of facets and report what came out. Not a pass/fail test — a look at the corpus, which
// is the only way to answer whether generated abilities are coherent, distinct and varied enough.
// `node test/facet.sample.js [count] [tier]`

const path = require('path');
const root = path.join(__dirname, '..');
const load = (f) => require(path.join(root, f));
for (const m of ['core', 'data', 'registry', 'relations', 'cells', 'pipeline', 'gate', 'mortal', 'forge', 'oracle', 'compile']) {
  require(path.join(root, 'facet', 'facet.' + m + '.js'));
}
global.Rng = load('rng.js');
global.Mercy = load('mercy.js');
global.Stats = load('stats.js');
global.Prof = load('proficiency.js');
global.Elements = load('elements.js');
global.AI = load('ai.js');
global.Spellcraft = load('spellcraft.js');
global.Psionic = load('psionic.js');
global.Martial = load('martial.js');
global.Affinity = load('affinity.js');
global.Classes = load('classes.js');
global.Gifts = load('gifts.js');
global.Temper = load('temper.js');
global.Condition = load('condition.js');
global.Consume = load('consume.js');
global.Combat = load('combat.js');
global.FacetQuantitiesIG = load('facet.quantities.ig.js');
global.FacetSchemaIG = load('facet.schema.ig.js');
global.FacetHostIG = load('facet.host.ig.js');

const F = global.Facet;
FacetHostIG.install();

function mkChar(stars) {
  const races = Object.keys(Stats.RACE_TENDENCIES);
  const race = races[Math.floor(Rng.rand() * races.length)];
  const st = Stats.rollCharacterStats(race, Rng.rand, stars);
  const c = { id: 1, name: 'X', race, stats: Stats.freezeBorn(st),
    profs: Prof.rollAll(st.stars, race, Rng.rand), affinity: Affinity.roll(Rng.rand),
    mind: { traits: [] }, temper: Temper.roll(), gifts: Gifts.roll(st, race),
    lexicon: [], techniques: {}, equipment: {}, facets: [], facetState: {} };
  Gifts.ensure(c, null);
  return c;
}

const N = Number(process.argv[2] || 400);
const TIER = process.argv[3] ? Number(process.argv[3]) : null;

const rolled = [];
let refused = 0;
for (let i = 0; i < N; i++) {
  const tier = TIER || (1 + Math.floor(Rng.rand() * 5));
  const person = mkChar(Math.min(5, tier));
  const f = F.forge.generate({ tier, person });
  if (!f) { refused++; continue; }
  rolled.push({ f, person, tier });
}

// ---------- what came out ----------
const shapes = {}, hooks = {}, verbs = {}, names = {}, ids = {}, subjects = {};
const byTier = {};
let costed = 0, lensed = 0, cells = 0;
const prices = [];
const HB = FacetHostIG.build();
for (const r of rolled) {
  const f = r.f;
  const sub = HB.outliers(r.person)[0];
  ids[f.id] = (ids[f.id] || 0) + 1;
  (byTier[r.tier] || (byTier[r.tier] = [])).push(f.price.value);
  names[f.reading.name] = (names[f.reading.name] || 0) + 1;
  prices.push(f.price.value);
  cells += f.cells.length;
  for (const c of f.cells) shapes[F.cellReading(c)] = (shapes[F.cellReading(c)] || 0) + 1;
  if (!f.cells.length) shapes.plain = (shapes.plain || 0) + 1;
  if (f.lens) lensed++;
  for (const cl of f.clauses) {
    const h = typeof cl.on === 'string' ? cl.on : cl.on.at;
    hooks[h] = (hooks[h] || 0) + 1;
    if (cl.cost) costed++;
    for (const e of cl.do) {
      const k = e.emit + (e.verb ? '.' + e.verb : '');
      verbs[k] = (verbs[k] || 0) + 1;
    }
  }
}

const pct = (n) => (100 * n / Math.max(1, rolled.length)).toFixed(0) + '%';
const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
const dupIds = Object.values(ids).filter(v => v > 1).length;
const dupNames = Object.entries(names).filter(([, v]) => v > 1);

console.log('rolled ' + rolled.length + '/' + N + '  (refused and rerolled ' + refused + ')');
console.log('distinct ids   ' + Object.keys(ids).length + '   collisions ' + dupIds);
console.log('distinct names ' + Object.keys(names).length + '   most repeated: ' +
  (dupNames.length ? top(names, 3).map(([k, v]) => k + ' x' + v).join(', ') : 'none'));
console.log('cells/facet    ' + (cells / Math.max(1, rolled.length)).toFixed(2) +
  '   with a drawback ' + pct(costed) + '   with a hidden number ' + pct(lensed));
prices.sort((a, b) => a - b);
console.log('price          min ' + prices[0].toFixed(1) + '  median ' + prices[Math.floor(prices.length / 2)].toFixed(1) +
  '  max ' + prices[prices.length - 1].toFixed(1));
console.log('\nshapes  ' + top(shapes, 8).map(([k, v]) => k + ' ' + pct(v)).join('  '));
console.log('hooks   ' + top(hooks, 8).map(([k, v]) => k.replace('event:', '') + ' ' + v).join('  '));
console.log('about   ' + top(subjects, 8).map(([k, v]) => k + ' ' + pct(v)).join('  '));
console.log('verbs   ' + top(verbs, 10).map(([k, v]) => k + ' ' + v).join('  '));

console.log('\n--- a dozen, as the player would read them ---');
for (const r of rolled.slice(0, 12)) {
  const f = r.f;

  console.log('\n' + f.reading.icon + ' ' + f.reading.name + '   ' + r.tier + '*  ' + f.price.value.toFixed(1) + 'pts' +
    '   [' + r.person.race + ', about ' + (f.about ? f.about.kind + ':' + f.about.value : '?') + ']');
  for (const l of f.reading.lines) console.log('   ' + l);
}
