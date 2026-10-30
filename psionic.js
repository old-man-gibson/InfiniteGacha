// Psionics: eight-axis workings lifted from Frontier Idle. Browser: window.Psionic. Node: module.exports.
//
// A working is a shape: 0..cap points on each of eight axes. Points are not spent, they are
// read: the eight axes become eight derived quantities and every field of the working is a
// pure function of those. The only cost is focus, paid per cast: 1 + 0.25 per point.
// Within an axis output is superlinear (n^1.25) so concentration beats spread, but every
// axis sits in some other quantity's denominator, so spreading is never free either.
//
// Characters shape their workings at mission launch through AI.decide (buildWorkings): a
// dim mind scatters points, a genius lands exactly on the thresholds it wants.

(() => {
const R = (typeof Rng !== 'undefined') ? Rng : require('./rng.js');
const AIx = (typeof AI !== 'undefined') ? AI : require('./ai.js');
const St = (typeof Stats !== 'undefined') ? Stats : require('./stats.js');
const El = () => (typeof Elements !== 'undefined') ? Elements : require('./elements.js');
// Optional: a class opens axes early and reorders the rest (classes.js).
const CL = () => (typeof Classes !== 'undefined') ? Classes : (typeof require !== 'undefined' ? require('./classes.js') : null);

const AXES = {
  force:        { name: 'Force',        icon: '👊', color: '#e05555', desc: 'How hard the will lands' },
  reach:        { name: 'Reach',        icon: '🌊', color: '#5cbb6a', desc: 'How widely it lands' },
  grip:         { name: 'Grip',         icon: '🫳', color: '#c98a3c', desc: 'How firmly it holds a mind' },
  speed:        { name: 'Speed',        icon: '💨', color: '#f2d024', desc: 'How quickly the visualisation completes' },
  clairvoyance: { name: 'Clairvoyance', icon: '👁️', color: '#8f7ad8', desc: 'Seeing where things will be' },
  space:        { name: 'Space',        icon: '🌀', color: '#5591e0', desc: 'Where the working exists' },
  mass:         { name: 'Mass',         icon: '🪨', color: '#9aa4b0', desc: 'How much the working weighs' },
  vitality:     { name: 'Vitality',     icon: '💚', color: '#4caf7d', desc: 'The will turned inward' },
};
const AXIS_LIST = Object.keys(AXES);
const STARTING_AXES = ['force', 'reach'];

const P = {
  axisCap: (level) => Math.min(10, 3 + Math.floor(level / 8)),
  curve: (n) => Math.pow(n, 1.25),
  forcePower: 0.7, momentumPower: 0.85, gripPower: 0.25, holdCost: 0.4,
  needleAcuity: 2, sureAcuity: 2, penPerAcuity: 0.09,
  reachSplash: 0.2, reachAll: 4, awarenessSpread: 0.5,
  gripChance: 0.18, concussChance: 0.09, speedCooldown: 0.93, vitalityHeal: 0.35,
  bulwarkInertia: 3, readGate: 0.2, compressionGate: 1, hasteMomentum: 0.5, braceGate: 1, rootInertia: 2, foresightGate: 0.5, wideSightGate: 2,
  inwardDuration: (coherence) => 200 * (1 + coherence),
  adhesion: (purchase) => 100 + 40 * purchase,
  recognitionBonus: 1.12, focusBase: 1, focusPerPoint: 0.25, cooldown: 110,
  portScale: 0.55,   // this game's magic damage runs hotter than the source's spell power; keep workings in line with sentences
};

const shapeTotal = (s) => AXIS_LIST.reduce((a, k) => a + (s[k] || 0), 0);
const shapeKey = (s) => AXIS_LIST.filter(k => s[k]).sort().map(k => k + s[k]).join(',');

function deriveShape(shape) {
  const p = (k) => shape[k] || 0;
  const pressure = p('force') + p('grip');
  const momentum = p('mass') * p('speed');
  return {
    pressure, momentum,
    inertia: Math.max(0, p('mass') - p('speed')),
    acuity: p('clairvoyance') / Math.max(1, p('reach') + Math.sqrt(momentum)),
    awareness: p('clairvoyance') * p('reach'),
    coherence: p('space') / Math.max(1, p('force') + p('mass')),
    purchase: p('grip') / (1 + p('speed')),
    inward: p('vitality') / Math.max(1, p('vitality') + pressure),
  };
}

const RECOGNITIONS = [
  { id: 'unerring_needle', name: 'Unerring Needle', icon: '📍', tier: 4, region: { acuity: { min: 2 }, pressure: { min: 4 }, coherence: { min: 0.4 }, momentum: { max: 0 }, inward: { max: 0.5 } } },
  { id: 'kinetic_bulwark', name: 'Kinetic Bulwark', icon: '🛡️', tier: 4, region: { inertia: { min: 3 }, coherence: { min: 0.4 }, inward: { max: 0.4 } } },
  { id: 'still_mind', name: 'Still Mind', icon: '🧘', tier: 0, region: { inward: { min: 0.9 }, vitality: { min: 3 }, momentum: { max: 0 }, inertia: { max: 0 }, acuity: { max: 0 }, awareness: { max: 0 }, coherence: { max: 0.5 } } },
  { id: 'kinetic_rush', name: 'Kinetic Rush', icon: '💨', tier: 4, region: { momentum: { min: 36 }, inward: { min: 0.8 } } },
  { id: 'immovable', name: 'Immovable', icon: '🌱', tier: 4, region: { inertia: { min: 5 }, inward: { min: 0.8 } } },
  { id: 'second_sight', name: 'Second Sight', icon: '🔮', tier: 8, region: { acuity: { min: 3 }, inward: { min: 0.8 } } },
  { id: 'psionic_obliteration', name: 'Obliteration', icon: '💥', tier: 8, region: { pressure: { min: 10 }, momentum: { min: 48 }, inward: { max: 0.25 } } },
];

function inRegion(r, shape, d) {
  for (const [k, band] of Object.entries(r.region)) {
    const v = k in d ? d[k] : (shape[k] || 0);
    if (band.min !== undefined && v < band.min) return false;
    if (band.max !== undefined && v > band.max) return false;
  }
  return true;
}
function subsumes(a, b) {
  for (const [k, band] of Object.entries(b.region)) {
    const own = a.region[k];
    if (!own) return false;
    if (band.min !== undefined && (own.min === undefined ? -Infinity : own.min) < band.min) return false;
    if (band.max !== undefined && (own.max === undefined ? Infinity : own.max) > band.max) return false;
  }
  return true;
}
function recogniseShape(shape, tier) {
  const d = deriveShape(shape);
  let best = null;
  for (const r of RECOGNITIONS) {
    if ((r.tier || 0) > tier || !inRegion(r, shape, d)) continue;
    if (!best) { best = r; continue; }
    const nested = subsumes(r, best);
    if (nested !== subsumes(best, r)) { if (nested) best = r; continue; }
    if (Object.keys(r.region).length > Object.keys(best.region).length) best = r;
  }
  return best;
}

const CHARACTERS = [
  { noun: 'Mending', icon: '💚', face: 'in',  of: (d, s) => (s.vitality || 0) * 0.8 },
  { noun: 'Rush',    icon: '💨', face: 'in',  of: (d) => Math.sqrt(d.momentum) },
  { noun: 'Hammer',  icon: '🔨', face: 'out', of: (d) => Math.sqrt(d.momentum) },
  { noun: 'Needle',  icon: '📍', face: 'out', of: (d) => d.acuity },
  { noun: 'Foresight', icon: '🔮', face: 'in', of: (d) => d.acuity },
  { noun: 'Anchor',  icon: '🪨', face: 'out', of: (d) => d.inertia },
  { noun: 'Root',    icon: '🌱', face: 'in',  of: (d) => d.inertia },
  { noun: 'Wave',    icon: '🌊', face: 'out', of: (d) => Math.sqrt(d.awareness) },
  { noun: 'Vigil',   icon: '👁️', face: 'in',  of: (d) => Math.sqrt(d.awareness) },
  { noun: 'Fold',    icon: '🌀', face: null,  of: (d) => d.coherence * 2 },
  { noun: 'Vise',    icon: '🫳', face: 'out', of: (d) => d.purchase * 0.6 },
  { noun: 'Ward',    icon: '💢', face: 'in',  of: (d) => d.pressure * 0.5 },
  { noun: 'Spike',   icon: '👊', face: 'out', of: (d, s) => (s.force || 0) * 0.5 },
];
function characterOf(shape, d) {
  let best = null, bw = 0;
  for (const ch of CHARACTERS) {
    const share = ch.face === 'in' ? d.inward : ch.face === 'out' ? 1 - d.inward : 1;
    const w = ch.of(d, shape) * share;
    if (w > bw) { bw = w; best = ch; }
  }
  return best;
}
function shapeName(shape) {
  if (shapeTotal(shape) === 0) return 'Empty Mind';
  const ch = characterOf(shape, deriveShape(shape));
  return ch ? `Mind ${ch.noun}` : 'Empty Gesture';
}

/** Resolve a shape into a castable spec. tier gates recognitions. */
function shapeSpec(shape, tier = 12) {
  const p = (k) => shape[k] || 0;
  const curve = P.curve;
  const d = deriveShape(shape);
  const drive = Math.sqrt(d.momentum);
  const spread = p('reach') + Math.sqrt(d.awareness) * P.awarenessSpread;
  const hold = d.coherence / (d.coherence + 1);
  const outward = 1 - d.inward;
  const worn = Math.round(P.inwardDuration(d.coherence));
  const held = Math.round(P.adhesion(d.purchase));
  const raw = curve(p('force')) * P.forcePower + curve(drive) * P.momentumPower + curve(p('grip')) * P.gripPower;
  const power = raw * outward * (1 - hold * P.holdCost) * P.portScale;
  const strikes = [];
  if (power > 0) {
    const strike = { type: d.acuity >= P.needleAcuity ? 'piercing' : 'bludgeoning', power };
    const pen = Math.min(0.95, d.acuity * (1 + d.coherence) * P.penPerAcuity);
    if (pen > 0) strike.penetration = pen;
    const inflicts = [];
    if (p('grip') > 0) inflicts.push({ id: 'dazed', intensity: 1, chance: Math.min(0.95, p('grip') * P.gripChance) });
    if (drive > 0) inflicts.push({ id: 'concussed', intensity: 1, chance: Math.min(0.9, drive * P.concussChance), duration: held });
    if (inflicts.length) strike.inflicts = inflicts;
    strikes.push(strike);
  }
  const recognition = recogniseShape(shape, tier);
  const ch = characterOf(shape, d);
  const spec = {
    key: 'psionic:' + shapeKey(shape), shape: { ...shape }, school: 'psionic',
    name: recognition ? recognition.name : shapeName(shape),
    icon: recognition ? recognition.icon : (ch ? ch.icon : '🧠'),
    target: spread >= P.reachAll ? 'others' : 'one', strikes, manaCost: 0,
    focusCost: P.focusBase + shapeTotal(shape) * P.focusPerPoint,
    cooldown: Math.max(40, Math.round(P.cooldown * Math.pow(P.speedCooldown, p('speed')))),
    derived: d,
  };
  if (d.acuity >= P.sureAcuity) spec.sure = true;
  if (spread > 0 && spread < P.reachAll) spec.splash = Math.min(0.75, spread * P.reachSplash);
  if (p('vitality') > 0) spec.heal = curve(p('vitality')) * P.vitalityHeal * (0.5 + d.inward);
  const grants = [];
  const inwardFace = (id, aimed, gate) => { if (aimed >= gate) grants.push({ id, intensity: aimed, duration: worn }); };
  inwardFace('psionic_haste', drive * d.inward, P.hasteMomentum);
  inwardFace('psionic_bracing', d.pressure * d.inward, P.braceGate);
  inwardFace('psionic_root', d.inertia * d.inward, P.rootInertia);
  inwardFace('psionic_foresight', d.acuity * d.inward, P.foresightGate);
  inwardFace('psionic_wide_sight', Math.sqrt(d.awareness) * d.inward, P.wideSightGate);
  if (d.inertia * outward >= P.bulwarkInertia) grants.push({ id: 'kinetic_bulwark', intensity: 1, duration: worn });
  if (grants.length) spec.grants = grants;
  const afflicts = [];
  const outwardFace = (id, aimed, gate) => { if (aimed >= gate) afflicts.push({ id, intensity: aimed, duration: held }); };
  outwardFace('psionic_read', d.acuity * outward, P.readGate);
  outwardFace('psionic_compression', d.coherence * outward, P.compressionGate);
  if (afflicts.length) spec.afflicts = afflicts;
  if (recognition) { for (const s of spec.strikes) s.power *= P.recognitionBonus; if (spec.heal) spec.heal *= P.recognitionBonus; }
  return spec;
}

function checkShape(shape, axes, cap) {
  for (const [k, v] of Object.entries(shape)) {
    if (!Number.isInteger(v) || v < 0) return { ok: false, reason: 'A shape is whole points, none negative' };
    if (!AXES[k]) return { ok: false, reason: `No such axis: ${k}` };
    if (v > 0 && !axes.includes(k)) return { ok: false, reason: `${AXES[k].name} awaits a teacher` };
    if (v > cap) return { ok: false, reason: `${AXES[k].name} can hold ${cap} points` };
  }
  if (shapeTotal(shape) === 0) return { ok: false, reason: 'An empty shape imposes nothing' };
  return { ok: true };
}

// ---------- per-character ----------
// Psionics level = psionics aptitude absolute level / 15. Axes open one per 6 levels, in an
// order rolled once at summon (c.psiOrder); tier for recognitions = level / 6.
function rollAxisOrder(rand = R.rand) {
  const rest = AXIS_LIST.filter(a => !STARTING_AXES.includes(a));
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  return rest;
}
/**
 * Which axes are open. Everyone starts with force and reach and unlocks one more every six
 * levels, in the order they rolled. A class opens its own axes outright — a Chronokinetic has
 * speed and clairvoyance from the day it takes the class — and pulls the rest of its list to
 * the front of the queue.
 */
const GF = () => (typeof Gifts !== 'undefined') ? Gifts : (typeof require !== 'undefined' ? require('./gifts.js') : null);
function openAxes(c, level) {
  const cl = CL();
  const g = GF();
  const born = !g || g.has(c, 'psionics');
  const order = cl ? cl.psiOrderOf(c) : (c.psiOrder || []);
  // Not born to it: nothing opens on its own, only what a class opens outright.
  const open = new Set(born ? [...STARTING_AXES, ...order.slice(0, Math.floor(level / 6))] : []);
  if (cl) for (const a of cl.axesOpenedBy(c)) open.add(a);
  return AXIS_LIST.filter(a => open.has(a));
}
const psiTier = (level) => Math.floor(level / 6);
const maxFocus = (base) => Math.floor(Math.max(0, 6 + 0.3 * base.cha + 0.1 * base.wis));
const focusRegen = (base) => maxFocus(base) * 0.02 + 0.01 * base.cha;

/** Expected value of one working for the builders. */
function castValue(spec, caster, profile) {
  const E = El();
  const dv = caster.derived || St.effective(caster).derived;
  const sp = dv.magicDamage;
  let dmg = 0, riders = 0;
  const targets = spec.target === 'others' ? Math.max(1, (profile && profile.count) || 1) : 1;
  const share = spec.target === 'others' ? 0.5 : 1;
  for (const s of spec.strikes) {
    const res = E.resistOf(profile, s.type);
    const pen = s.penetration || 0;
    const crit = dv.critChance;
    dmg += sp * s.power * share * (1 + crit * (dv.critDamage - 1)) * (1 - Math.max(0, res) * (1 - pen)) * (spec.sure ? 1.1 : 1);
    for (const a of (s.inflicts || [])) riders += E.statusValue(a.id, a.intensity, a.duration) * (a.chance == null ? 1 : a.chance);
  }
  for (const a of (spec.afflicts || [])) riders += E.statusValue(a.id, a.intensity, a.duration);
  let self = 0;
  for (const g of (spec.grants || [])) self += E.statusValue(g.id, g.intensity, g.duration);
  const splashV = spec.splash && profile && profile.count > 1 ? dmg * spec.splash : 0;
  const heal = spec.heal ? spec.heal * sp * 0.8 : 0;
  return { damage: (dmg + splashV) * targets, riders: riders * targets, self, heal, total: (dmg + splashV) * targets + riders * targets + self + heal };
}

function randomShape(axes, cap, concentrated) {
  const shape = {};
  if (!concentrated) {
    for (const a of axes) shape[a] = R.randInt(0, cap);
  } else {
    // pick one to three axes and load them; a light touch elsewhere at most
    const n = R.randInt(1, Math.min(3, axes.length));
    const chosen = R.shuffle(axes.slice()).slice(0, n);
    for (const a of chosen) shape[a] = R.randInt(Math.ceil(cap / 2), cap);
    if (R.chance(0.4)) { const extra = R.pick(axes); if (!shape[extra]) shape[extra] = R.randInt(1, Math.max(1, Math.floor(cap / 2))); }
  }
  for (const k of Object.keys(shape)) if (!shape[k]) delete shape[k];
  return shape;
}

/** Build up to two workings (one outward, one inward if useful) for a mission. */
function buildWorkings(c, level, profile, doctrine) {
  const axes = openAxes(c, level);
  const cap = P.axisCap(level);
  const tier = psiTier(level);
  const w = AIx.DOCTRINES[doctrine].w;
  const pool = maxFocus(St.effective(c).base);
  const conc = 0.1 + 0.22 * AIx.tierIndex(c);
  const seen = new Set();
  const generate = () => {
    for (let t = 0; t < 6; t++) {
      const shape = randomShape(axes, cap, R.chance(conc));
      if (!checkShape(shape, axes, cap).ok) continue;
      const spec = shapeSpec(shape, tier);
      if (seen.has(spec.key)) continue;
      return spec;
    }
    return null;
  };
  const score = (spec) => {
    if (spec.focusCost > pool) return 0.01;
    const v = castValue(spec, c, AIx.tier(c).refine > 0 ? profile : null);
    const perFocus = v.total / spec.focusCost;
    const casts = Math.floor(pool / spec.focusCost);
    const burst = v.damage * Math.min(3, casts) / (spec.cooldown / 110);
    const sustain = perFocus * (110 / spec.cooldown) * Math.min(1, casts / 4);
    return w.dpr * perFocus * 10 + w.burst * burst * 0.2 + w.stack * (v.riders / spec.focusCost * 8) + w.sustain * (sustain * 6 + v.self + v.heal);
  };
  const refine = (spec) => {
    const shape = { ...spec.shape };
    const a = R.pick(axes);
    shape[a] = Math.max(0, Math.min(cap, (shape[a] || 0) + (R.chance(0.5) ? 1 : -1)));
    if (!shape[a]) delete shape[a];
    return checkShape(shape, axes, cap).ok ? shapeSpec(shape, tier) : spec;
  };
  const workings = [];
  const first = AIx.decide(c, { generate, score, refine });
  if (first) { workings.push(first); seen.add(first.key); }
  if (axes.includes('vitality') || axes.includes('mass') || axes.includes('clairvoyance')) {
    const second = AIx.decide(c, { generate, score, refine });
    if (second) workings.push(second);
  }
  return { workings, doctrine };
}

const PsionicAPI = { AXES, AXIS_LIST, STARTING_AXES, P, RECOGNITIONS, shapeTotal, shapeKey, deriveShape, recogniseShape, shapeName, shapeSpec, checkShape, rollAxisOrder, openAxes, psiTier, maxFocus, focusRegen, castValue, randomShape, buildWorkings };
if (typeof module !== 'undefined') module.exports = PsionicAPI;
if (typeof window !== 'undefined') window.Psionic = PsionicAPI;
})();
