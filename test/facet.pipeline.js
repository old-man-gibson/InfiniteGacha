// The arithmetic-identity gate for commit 3.
//
// Turning `Elements.slice` into a named stage list must not change a single number. This file holds
// a verbatim copy of the ORIGINAL implementation and compares it against the live one over tens of
// thousands of random blows against random bearers. If a stage boundary moved an operation by one
// position, or a rounding changed, or the ward subtraction ended up on the wrong side of the
// resistance multiply, this is what says so.
//
// The reference below is frozen on purpose. It is not maintained alongside the real one and it must
// never be "fixed" to match a change — if they diverge, either the refactor is wrong or the change
// is deliberate and this file's expectations need a deliberate, separate edit with a reason.
//
// `node test/facet.pipeline.js`

const path = require('path');
const root = path.join(__dirname, '..');
const load = (f) => require(path.join(root, f));

for (const m of ['core', 'data', 'registry', 'cells', 'relations', 'pipeline', 'gate', 'mortal', 'forge', 'oracle', 'compile']) {
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

const E = global.Elements;

// ---------- the frozen reference ----------
const MONSTER_RESIST_CAP = 0.9;
const PHYSICAL = new Set(['slashing', 'piercing', 'bludgeoning']);
const afterPenetration = (res, pen) => res > 0 ? Math.max(0, res - (pen || 0)) : res;

function sliceReference(bearer, type, raw, penetration) {
  penetration = penetration || 0;
  const cap = bearer.resistCap == null ? MONSTER_RESIST_CAP : bearer.resistCap;
  const before = Math.min(cap, Math.max(-1, E.bearerResistance(bearer, type)));
  const resistance = afterPenetration(before, penetration);
  const worn = PHYSICAL.has(type) ? Math.min(raw, E.bearerArmor(bearer)) : 0;
  const afterArmor = raw - worn;
  const afterRes = Math.max(0, afterArmor * (1 - resistance));
  const warded = Math.max(0, Math.min(afterRes, bearer.ward || 0));
  return { type, raw, armor: worn, resisted: afterArmor - afterRes, resistance, dealt: Math.max(0, afterRes - warded) };
}

// ---------- bearers worth testing ----------
// Deliberately hostile: negative resistance, resistance past the cap, zero and huge raw, wards
// larger than the blow, statuses that override resistance, and the two different caps.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeBearer(rnd) {
  const res = {};
  for (const t of E.TYPES) {
    const r = rnd();
    res[t] = r < 0.15 ? -(rnd() * 1.0) : r < 0.3 ? 0 : rnd() * 1.2;   // vulnerable, neutral, resistant past the cap
  }
  const b = {
    hp: 500, maxHp: 500, res, statuses: [], buffs: [],
    armor: rnd() < 0.5 ? rnd() * 40 : 0,
    ward: rnd() < 0.3 ? rnd() * 60 : 0,
    resistCap: rnd() < 0.5 ? E.RESIST_CAP : (rnd() < 0.5 ? E.MONSTER_RESIST_CAP : undefined),
  };
  if (b.resistCap === undefined) delete b.resistCap;
  // Real statuses, so the resistance walk actually has work to do.
  const pool = Object.keys(E.STATUSES);
  const n = Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const id = pool[Math.floor(rnd() * pool.length)];
    b.statuses.push({ id, intensity: 1 + rnd() * 3, stacks: 1 + Math.floor(rnd() * 3), data: {}, until: null });
  }
  return b;
}

// ---------- the sweep ----------
const N = Number(process.argv[2] || 20000);
const rnd = mulberry32(0xC0FFEE);
const mismatches = [];
let compared = 0;

for (let i = 0; i < N; i++) {
  const b = makeBearer(rnd);
  const type = E.TYPES[Math.floor(rnd() * E.TYPES.length)];
  const raw = rnd() < 0.05 ? 0 : rnd() * 400;
  const pen = rnd() < 0.4 ? rnd() * 0.95 : 0;

  // Both arms must see the same bearer in the same state, so the reference runs first on a
  // structural copy and the live one on the original. bearerResistance and bearerArmor are pure.
  const copy = JSON.parse(JSON.stringify(b));
  const want = sliceReference(copy, type, raw, pen);
  const got = E.slice(b, type, raw, pen);
  compared++;

  for (const k of ['dealt', 'resisted', 'armor', 'resistance', 'raw', 'type']) {
    const a = want[k], c = got[k];
    const same = (typeof a === 'number' && typeof c === 'number') ? Math.abs(a - c) < 1e-9 : a === c;
    if (!same) {
      mismatches.push({ i, k, want: a, got: c, type, raw, pen, armor: b.armor, ward: b.ward, cap: b.resistCap });
      break;
    }
  }
  if (mismatches.length > 8) break;
}

console.log(compared + ' blows compared against the frozen reference');
if (mismatches.length) {
  console.log('\n' + mismatches.length + ' MISMATCH(ES):');
  for (const m of mismatches) {
    console.log('  #' + m.i + '  ' + m.k + ': reference ' + m.want + ' vs live ' + m.got +
      '   [' + m.type + ' raw=' + m.raw.toFixed(2) + ' pen=' + m.pen.toFixed(2) +
      ' armor=' + Number(m.armor).toFixed(1) + ' ward=' + Number(m.ward).toFixed(1) + ' cap=' + m.cap + ']');
  }
} else {
  console.log('identical on every field');
}

// ---------- the stages must also be declared coherently ----------
const problems = [];
FacetHostIG.install();
const stages = global.Facet.host().stages();
let lastOrder = -1;
for (const s of stages) {
  if (s.order <= lastOrder) problems.push('stage ' + s.id + ' is declared out of order');
  lastOrder = s.order;
  if (s.sealed && s.joinable === true && s.id !== 'floor') problems.push('stage ' + s.id + ' is both sealed and freely joinable');
}
if (!stages.some(s => s.id === 'absorb')) problems.push('no absorb stage declared');
if (!stages.some(s => s.id === 'engine' && s.joinable === false)) problems.push('the engine stage must exist and must not be joinable');
if (problems.length) { console.log('\nSTAGE TABLE:\n  ' + problems.join('\n  ')); }
else console.log('stage table coherent (' + stages.map(s => s.id).join(' -> ') + ')');

process.exitCode = (mismatches.length || problems.length) ? 1 : 0;
