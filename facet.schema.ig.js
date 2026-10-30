// What this game declares about itself to the facet engine: the fields an action carries, the fields
// a status may have, the values each field admits, the damage channels, the pipeline stages and the
// ways a target may be chosen. Browser: window.FacetSchemaIG. Node: module.exports.
//
// The generator's content comes only from this file. The core contains no damage type, no school, no
// weapon family and no element name. It picks a field from descriptorSchema() and a value from
// vocabulary(), then builds the predicate from that pair. A law forbidding water spells is assembled
// from the field `element` and the value `water`, neither of which appears in the engine. Add a
// fifteenth damage type to elements.js and register it here, and the generator produces immunities,
// absorbers and prohibitions over it with no core edit.
//
// statusSchema() sets how much mechanism a generated status can express. The hand-written statuses in
// this game use resistance overrides, element conversion, cross-status amplification, cap overrides,
// grafts, retaliation, heal caps and escalation ladders. Listing those fields here makes each of them
// generable, because the compiler emits a real status definition into the game's own status table
// rather than a private effect object. A field not listed here is never emitted, so the schema can
// start small and be widened later without breaking existing output.

(() => {
const E = () => (typeof Elements !== 'undefined') ? Elements : require('./elements.js');
const M = () => (typeof Martial !== 'undefined') ? Martial : require('./martial.js');
const A = () => (typeof Affinity !== 'undefined') ? Affinity : require('./affinity.js');

// ---------- damage channels ----------
// Partitions this game's damage types into two groups. The core reads `group` and never the type ids,
// so "immune to magic" and "immune to physical" are one generated ability with one parameter changed.
function channels() {
  const El = E();
  return El.TYPES.map(t => ({ id: t, group: El.PHYSICAL.has(t) ? 'physical' : 'magical', icon: El.TYPE_ICON[t] }));
}

const classOf = (type) => E().PHYSICAL.has(type) ? 'physical' : 'magical';

// ---------- pipeline stages ----------
// The order the game resolves mitigation in. `armor` is declared present but inert: bearerArmor reads
// a field combatants do not have, so it contributes nothing to either arm of the coverage measurement.
// The measurement is correct either way, so fixing that bug is not a prerequisite for this engine.
// `joinable` means slice() actually runs joins at that stage, not that the stage exists conceptually.
// crit and floor are listed so the table states the true order, but neither runs inside slice(): crit
// is applied by the callers in combat.js and the floor of 1 by damage(). Marking them joinable would
// let the generator hook clauses onto stages that never fire, so those clauses would be priced and
// described but dead, the same failure as a status modifier naming a stat the game does not read.
// Set them joinable in the commit that moves them into the pipeline.
function stages() {
  return [
    { id: 'raw',    order: 0, mitigating: false, joinable: true,  sealed: false },
    { id: 'crit',   order: 1, mitigating: false, joinable: false, sealed: false, note: 'applied by the callers, not by slice' },
    { id: 'armor',  order: 2, mitigating: true,  joinable: true,  sealed: false, inert: true },
    { id: 'resist', order: 3, mitigating: true,  joinable: true,  sealed: false },
    { id: 'absorb', order: 4, mitigating: true,  joinable: true,  sealed: false },
    { id: 'engine', order: 5, mitigating: true,  joinable: false, sealed: true },
    { id: 'ward',   order: 6, mitigating: true,  joinable: true,  sealed: false },
    { id: 'floor',  order: 7, mitigating: false, joinable: false, sealed: true, floor: 1, note: 'applied by damage(), not by slice' },
  ];
}

// ---------- action descriptors ----------
function descriptorSchema() {
  return {
    lethalField: 'damageType',
    costField: 'cost',
    fields: {
      kind:        { kind: 'enum', lethal: false },
      family:      { kind: 'enum' },
      school:      { kind: 'enum' },
      element:     { kind: 'enum', nullable: true },
      // Every damage type the action can deliver, not just the first. An action with three damage
      // clauses must match a prohibition on any one of them. Reading only strikes[0] would let a ban
      // on water pass an action that is two thirds water.
      elements:    { kind: 'set' },
      damageType:  { kind: 'enum', lethal: true },
      damageClass: { kind: 'enum', lethal: true, derived: 'classOf(damageType)' },
      scope:       { kind: 'scope' },
      cost:        { kind: 'cost' },
      reach:       { kind: 'bool' },
      heals:       { kind: 'bool' },
      cooldownKey: { kind: 'key' },
      value:       { kind: 'lens' },
      exec:        { kind: 'exec' },
    },
  };
}

// ---------- status fields ----------
// `mortality` is the field the prover reads. 'coverage' means the field can close a damage channel,
// so the seam may have to reopen it. 'sustain' means the field answers incoming damage and is metered.
// 'evade' marks a field the proof does not cover: dodge and parry never reach the damage pipeline, so
// they can only be bounded by declaration.
function statusSchema() {
  return {
    fields: {
      element:      { kind: 'meta' },
      duration:     { kind: 'meta' },
      hidden:       { kind: 'meta' },
      buff:         { kind: 'meta' },
      stacking:     { kind: 'meta' },
      worth:        { kind: 'meta' },
      baseForm:     { kind: 'ladder' },
      escalatesTo:  { kind: 'ladder' },
      expiresTo:    { kind: 'ladder' },
      mods:         { kind: 'mod' },
      dot:          { kind: 'dot' },
      overrideRes:  { kind: 'res',      mortality: 'coverage' },
      capOverrides: { kind: 'res',      mortality: 'coverage' },
      converts:     { kind: 'res',      mortality: 'coverage' },
      amplifies:    { kind: 'reactive' },
      grafts:       { kind: 'reactive' },
      tends:        { kind: 'reactive' },
      retaliate:    { kind: 'reactive' },
      magnetism:    { kind: 'reactive', mortality: 'evade' },
      bar:          { kind: 'reactive' },
      blocks:       { kind: 'veto' },
      blocksRanged: { kind: 'veto' },
      blockedBy:    { kind: 'veto' },
      missChance:   { kind: 'mod',      mortality: 'evade' },
      incomingMissChance: { kind: 'mod', mortality: 'evade' },
      healCap:      { kind: 'mod',      mortality: 'sustain' },
      removal:      { kind: 'meta' },
      displaces:    { kind: 'reactive' },
    },
  };
}

// ---------- vocabulary ----------
// Values, per descriptor field. Read live from the source files rather than copied, so a new weapon
// family or a new psionic axis is in the generator's reach as soon as it is added to its own file.
function vocabulary(field) {
  const El = E();
  switch (field) {
    case 'element':
    case 'damageType': return El.TYPES.slice();
    case 'damageClass': return ['physical', 'magical'];
    case 'kind':       return ['swing', 'technique', 'spell', 'potion', 'feature'];
    case 'family':     return (A().TYPES ? A().TYPES.weapon.slice() : []).concat(['unarmed', 'shield']);
    case 'school':     return ['martial', 'arcane', 'psionic'];
    case 'position':   return Object.keys(M().POSITIONS || {});
    case 'status':     return Object.keys(El.STATUSES);
    default:           return [];
  }
}

// ---------- rankers ----------
// How a scope picks which member of a side to hit. The game already implements most of these in
// targetScore, so this list declares what exists rather than defining a parallel system.
function rankers() {
  return ['wounded', 'strongest', 'caster', 'spread', 'weakest', 'lowestAlly', 'taunter', 'front', 'random'];
}

const API = { channels, classOf, stages, descriptorSchema, statusSchema, vocabulary, rankers };
if (typeof module !== 'undefined') module.exports = API;
if (typeof window !== 'undefined') window.FacetSchemaIG = API;
})();
