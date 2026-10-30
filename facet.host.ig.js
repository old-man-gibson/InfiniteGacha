// The binding between this game and the portable facet engine. Browser: window.FacetHostIG.
// Node: module.exports. Loading this file does nothing; calling install() wires the two together.
//
// Two rules define the boundary. Most of the indirection in this file exists to keep them.
//
//  1. The core never holds a combatant. It is given an opaque ref string and hands the same string
//     back. Every piece of state the core owns is therefore plain JSON, so a facet survives this
//     game's saver and the source game's without either of them learning a new type. The cost is
//     the two-way map below. The inbound side is a WeakMap, so a dead fighter stays collectable.
//
//  2. The core never writes a combatant. It hands over an override, a status application or a
//     modifier line, and this file applies it. In this game the rule has no visible effect, because
//     stats() is recomputed on every read. In the source game it is load-bearing: derived stats
//     there are a frozen block shared by every caller, and state is a reactive proxy, so a lazy
//     initialiser written on the wrong side of an assignment lands on the raw object and is
//     invisible to the interface.
//
// Not wired yet: probeSlice and probeNative are live so the mortality ledger works from the first
// commit. The staged pipeline, the action gate and the world verbs are not: their host members are
// absent, install() treats them as optional, and the generator will not roll a verb whose member is
// missing. That is what lets each commit ship on its own.

(() => {
const R  = () => (typeof Rng !== 'undefined') ? Rng : require('./rng.js');
const Mc = () => (typeof Mercy !== 'undefined') ? Mercy : require('./mercy.js');
const El = () => (typeof Elements !== 'undefined') ? Elements : require('./elements.js');
const C  = () => (typeof Combat !== 'undefined') ? Combat : require('./combat.js');
const St = () => (typeof Stats !== 'undefined') ? Stats : require('./stats.js');
const Sch = () => (typeof FacetSchemaIG !== 'undefined') ? FacetSchemaIG : require('./facet.schema.ig.js');
const Qs = () => (typeof FacetQuantitiesIG !== 'undefined') ? FacetQuantitiesIG : require('./facet.quantities.ig.js');
const Tw = () => { try { return (typeof FacetQuantitiesTownIG !== 'undefined') ? FacetQuantitiesTownIG : require('./facet.quantities.town.ig.js'); } catch (e) { return null; } };

// ---------- refs ----------
//
// A ref names one of two kinds of object, and the caller says which kind. A fighter exists for the
// length of one encounter and owns the combat numbers. A person exists for the length of a save and
// owns the town half: condition, temper, proficiencies, bonds. Both are opaque strings to the core,
// which never learns either type.
//
// The kind is stored rather than inferred from the object's shape. A fighter holds a reference to
// its own character in `.char`, so code that guessed by looking for `.stats` would resolve a combat
// ref to the person behind it and read town numbers where combat ones were asked for.
const byRef = new Map();          // ref string -> { obj, kind }
const toRef = new WeakMap();      // object -> ref string
let seq = 0;

function refOf(obj, kind) {
  if (!obj) return null;
  let r = toRef.get(obj);
  if (!r) { r = (kind === 'person' ? 'c' : 'r') + (++seq); toRef.set(obj, r); byRef.set(r, { obj, kind }); }
  return r;
}
const ref = (f) => refOf(f, 'fighter');
const personRef = (c) => refOf(c, 'person');

function entry(r) { return byRef.get(r) || null; }
function fighter(r) { const e = byRef.get(r); return (e && e.kind === 'fighter') ? e.obj : null; }
// The person behind a ref of either kind. A fighter ref resolves through the fighter's `.char`.
function personOfRef(r) {
  const e = byRef.get(r);
  if (!e) return null;
  return e.kind === 'person' ? e.obj : (e.obj.char || null);
}
function forget(r) { byRef.delete(r); }

// The encounter context, set by combat.js at encounter start so scope resolution and reachability
// have something to read. Held in one module-level slot rather than threaded through every call,
// because the engine is only ever driven from inside one encounter at a time.
//
// Sides come from the context's own alliesOf/enemiesOf rather than from a party array and an enemy
// array. Those two functions are where this game decides who is on whose side, and they already
// handle a combatant on either side symmetrically. Answering the same question again here would
// give two implementations that can drift apart.
let CTX = null;
function setContext(ctx) { CTX = ctx; }

function sideMates(f) {
  if (!CTX || !CTX.alliesOf) return [f];
  return CTX.alliesOf(f).filter(x => x.alive);
}
function opponents(f) {
  if (!CTX || !CTX.enemiesOf) return [];
  return CTX.enemiesOf(f).filter(x => x.alive);
}
function everyone(f) { return sideMates(f).concat(opponents(f)); }

// ---------- quantity reads ----------
//
// Native reads only: readQ returns what the game would report with no facet present. The engine
// layers its own overrides on top of this, so a nullified value is not re-derived out from under the
// thing that nullified it.
function readQ(r, qid) {
  const dot = qid.indexOf('.');
  const ns = qid.slice(0, dot);
  const rest = qid.slice(dot + 1);

  // The town namespaces resolve against the person and work whether or not a fight is running, so
  // a facet can fire at a rest tick, a job completion or a week boundary rather than only when the
  // bearer is being hit.
  if (ns === 'cond' || ns === 'temper' || ns === 'prof' || ns === 'bond' || ns === 'town') {
    return readTownQ(r, ns, rest);
  }

  const f = fighter(r);
  if (!f) return 0;

  if (ns === 'fighter') {
    if (rest === 'hp') return f.hp;
    if (rest === 'maxHpAbs') return f.maxHp;
    if (rest === 'bar') return f.bar;
    if (rest === 'position') return f.position;
    if (rest === 'rank') return f.rank;
    if (rest === 'resistCap') return f.resistCap === undefined ? El().RESIST_CAP : f.resistCap;
    if (rest === 'ward') return f.ward || 0;
    const s = C().stats(f);
    return s[rest] === undefined ? 0 : s[rest];
  }
  if (ns === 'res') return El().bearerResistance(f, rest);
  if (ns === 'stat') {
    const key = rest.replace('eff.', '');
    if (!f.char) return 0;
    return St().effective(f.char).base[key] || 0;
  }
  if (ns === 'derived') {
    if (!f.char) return 0;
    return St().effective(f.char).derived[rest] || 0;
  }
  if (ns === 'pool') {
    const parts = rest.split('.');
    const p = f.pools[parts[0]];
    return p ? (p[parts[1]] || 0) : 0;
  }
  return 0;
}

// ---------- the town half ----------
//
// These read live from the modules that own the numbers rather than copying them, so retuning
// condition.js or temper.js changes what a facet sees with no edit here.
let TOWN_STATE = null;
function setTownState(st) { TOWN_STATE = st; }

function readTownQ(r, ns, rest) {
  const c = personOfRef(r);
  if (ns === 'town') {
    if (!TOWN_STATE) return 0;
    return rest === 'gems' ? (TOWN_STATE.gems || 0) : 0;
  }
  if (!c) return 0;

  if (ns === 'cond') {
    const CO = (typeof Condition !== 'undefined') ? Condition : null;
    if (!CO) return 0;
    const cond = CO.ensure(c);
    switch (rest) {
      case 'morale':     return cond.morale || 0;
      // Always the native ceiling. The engine layers its raise on top through the override table,
      // and `c.facetCaps` is a mirror of the result kept for the game's own code. Reading the
      // mirror here would compound each raise on the previous raise's output.
      case 'moraleMax':  return CO.MORALE_MAX;
      case 'moraleMult': return CO.moraleMult(c);
      case 'stamina':    return cond.stamina || 0;
      case 'staminaMax': return St().effective(c).derived.stamina;
      case 'workMult':   return CO.workMult(c);
      case 'pool':       return cond.pool ? (cond[cond.pool] || 0) : 0;
      default:           return 0;
    }
  }

  if (ns === 'temper') {
    const TE = (typeof Temper !== 'undefined') ? Temper : null;
    if (!TE || !c.temper) return 50;
    const v = c.temper[rest];
    return typeof v === 'number' ? v : 50;
  }

  if (ns === 'prof') {
    if (!c.profs) return 0;
    const stages = Object.keys(c.profs).map(k => (c.profs[k] && c.profs[k].stage) || 0);
    if (!stages.length) return 0;
    if (rest === 'best') return Math.max.apply(null, stages);
    if (rest === 'breadth') return stages.filter(x => x > 0).length;
    return 0;
  }

  if (ns === 'bond') {
    const BO = (typeof Bonds !== 'undefined') ? Bonds : null;
    if (!BO || !TOWN_STATE) return 0;
    if (rest === 'closest') { const b = BO.closestTo(TOWN_STATE, c); return b ? Math.abs(BO.value(TOWN_STATE, c, b) || 0) : 0; }
    if (rest === 'friends') { const fr = BO.friendsOf(TOWN_STATE, c); return fr ? fr.length : 0; }
    return 0;
  }

  return 0;
}

// ---------- the two probes the mortality proof rests on ----------
//
// probeSlice asks the game what a reference blow of this type would deal to this bearer right now.
// probeNative asks the same question with every facet-sourced effect suspended. The ratio of the two
// is how open the bearer is on that channel. Both arms run through the game's own mitigation path,
// so the measurement includes armor, resistance, conversion, caps, wards and any mitigation step
// added later without an edit here. A declared coverage formula would cover only the steps its
// author listed, and would be wrong from the first time a step it does not mention is added.
//
// Neither probe may be called from inside a slice. Elements.slice is re-entrant: its damage door
// calls slice again while an outer call is still on the stack. The ledger therefore runs at tick
// boundaries only.
function probeSlice(r, type, raw) {
  const f = fighter(r);
  if (!f) return raw;
  return El().slice(f, type, raw, 0).dealt;
}

function probeNative(r, type, raw) {
  const f = fighter(r);
  if (!f) return raw;
  const held = El().statusesOf(f);
  const mine = held.filter(h => { const d = El().STATUSES[h.id]; return d && d.facet; });
  // The fast path must test every route the engine can mitigate through, not just the common ones.
  // If one is missed, probeNative returns the live number, both arms agree, and an untouchable
  // bearer grades as perfectly open.
  if (!mine.length && !f.facetWard && !hasOverrides(r)) return El().slice(f, type, raw, 0).dealt;

  const savedStatuses = held.slice();
  const savedWard = f.ward;
  try {
    f.statuses = held.filter(h => mine.indexOf(h) < 0);
    // Subtract only the ward the engine added, tracked in f.facetWard. A ward the character earned
    // survives the suspension; removing it would credit the facet with mitigation it did not add.
    f.ward = Math.max(0, (f.ward || 0) - (f.facetWard || 0));
    return El().slice(f, type, raw, 0).dealt;
  } finally {
    f.statuses = savedStatuses;
    f.ward = savedWard;
  }
}

function hasOverrides(r) {
  const F = globalThis.Facet;
  return !!(F && F.registry.overridesOf(r));
}

// A reference blow, in this game's own damage units. It cancels out of every ratio the proof takes,
// so its absolute size does not matter, only that it is the same on both arms and is not zero.
function refBlow(r) {
  const f = fighter(r);
  if (!f) return 1;
  const foes = opponents(f);
  if (!foes.length) return Math.max(1, f.maxHp * 0.05);
  let total = 0;
  for (const e of foes) { const s = C().stats(e); total += Math.max(s.damage, s.magicDamage); }
  return Math.max(1, total / foes.length);
}

// The damage types a live opponent can currently deliver. Read off plans and monster definitions
// directly, never by running the game's own candidate builder: that builder sits one call away from
// a function that removes a status, so a speculative pass through it would consume a charge the
// player had banked.
function reachableTypes(r) {
  const f = fighter(r);
  const out = new Set();
  if (!f) return out;
  for (const e of opponents(f)) {
    if (e.damageType) out.add(e.damageType);
    for (const app of (e.inflicts || [])) { const d = El().STATUSES[app.id]; if (d && d.element) out.add(d.element); }
    const plan = e.plan || {};
    for (const spec of (plan.spells || []).concat(plan.workings || [], plan.features || [])) {
      for (const s of (spec.strikes || [])) if (s.type) out.add(s.type);
      if (spec.damageType) out.add(spec.damageType);
    }
    for (const id of (plan.rotation || [])) {
      const t = (typeof Martial !== 'undefined' ? Martial.TECHNIQUES[id] : null);
      if (t && t.move && t.move.damageType) out.add(t.move.damageType);
    }
    // An enemy with no damageType still makes a basic attack, which counts as bludgeoning.
    if (!e.damageType) out.add('bludgeoning');
  }
  return out;
}

// ---------- outliers ----------
//
// One list, sorted by absolute deviation. `z` is signed and roughly standardised so five kinds of
// axis can be compared on one scale: stats against the race's own tendency, temperament against its
// midpoint and spread, and the categorical facts (a path, an innate weapon, a hidden trait) at fixed
// nominal weights. A categorical fact such as "is a Spellblade" has no variance to divide by, so a
// computed z for it would carry no information.
//
// Element subjects are appended last and are derived, not stored. No character record carries an
// element, so one is read from race first and path second: a therian maps to slashing, a celestial
// to light. That makes element subjects available for every character without adding a field to the
// character record.
const RACE_ELEMENT = {
  draconic: 'heat', therian: 'slashing', demonic: 'dark', celestial: 'light', android: 'lightning',
  robot: 'lightning', bug: 'poison', orc: 'bludgeoning', goblin: 'acid', elf: 'wind',
  darkelf: 'dark', dwarf: 'earth', halfgiant: 'earth', human: null,
};
const PATH_ELEMENT = { blade: 'slashing', arcana: 'arcane', psionics: 'arcane' };

function outliers(c) {
  if (!c) return [];
  const out = [];
  const St_ = St(), Tp = (typeof Temper !== 'undefined') ? Temper : null;

  // Stats, measured against the race's own tendency multiplier from St.RACE_TENDENCIES. A halfgiant
  // with high INT scores as an outlier; a halfgiant with high STR does not, because the tendency
  // already expects it. Divisor is 28% of the character's mean base stat.
  const born = (c.stats && c.stats.born) || c.stats;
  if (born && born.base) {
    const tend = St_.RACE_TENDENCIES[c.race] || St_.RACE_TENDENCIES.human;
    const total = St_.BASE_STATS.reduce((a, k) => a + born.base[k], 0) || 1;
    const mean = total / St_.BASE_STATS.length;
    for (const k of St_.BASE_STATS) {
      const expected = mean * (tend[k] || 1);
      const z = (born.base[k] - expected) / Math.max(1, mean * 0.28);
      out.push({ kind: 'stat', value: k, z, tag: 'stat:' + k });
    }
  }

  // Temperament, measured against the midpoint, divisor 17 points. Temper.KEYS and Temper.MID are
  // read from temper.js rather than copied, so retuning that file retunes this.
  if (Tp && c.temper) {
    for (const k of Tp.KEYS) {
      const v = c.temper[k];
      if (typeof v !== 'number') continue;
      out.push({ kind: 'temper', value: k, z: (v - Tp.MID) / 17, tag: 'temper:' + k });
    }
  }

  // The categorical facts, at nominal weights. Two paths is uncommon and three is rare, so the
  // combination gets its own entry at z = 1.2 + 0.4 per path, above the 0.9 each single path scores.
  const gifts = c.gifts || [];
  if (gifts.length > 1) out.push({ kind: 'path', value: gifts.join('+'), z: 1.2 + gifts.length * 0.4, tag: 'path:' + gifts.join('+') });
  for (const g of gifts) out.push({ kind: 'path', value: g, z: 0.9, tag: 'path:' + g });
  if (c.affinity && c.affinity.innate) {
    out.push({ kind: 'weapon', value: c.affinity.innate.weapon, z: 0.8, tag: 'weapon:' + c.affinity.innate.weapon });
    for (const t of (c.affinity.traits || [])) out.push({ kind: 'trait', value: t, z: 1.5, tag: 'trait:' + t });
  }
  if (c.class) out.push({ kind: 'class', value: c.class.id || c.class, z: 1.0, tag: 'class:' + (c.class.id || c.class) });

  // The element, derived from race first and the first path second.
  const el = RACE_ELEMENT[c.race] || PATH_ELEMENT[gifts[0]] || null;
  if (el) out.push({ kind: 'element', value: el, z: 1.1, tag: 'element:' + el });

  out.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  return out;
}

// ---------- flavour ----------
//
// Adjectives per subject, so a facet grown out of heat is named from heat's own word list. Six to
// eight adjectives per subject against six nouns per shape gives a few hundred names per axis,
// against the seventy-two a single shared pool produced. The name also states the subject of the
// ability before the player reads the description.
const WORDS = {
  element: {
    heat:        ['kindled', 'ashen', 'scorched', 'ember', 'smouldering', 'banked', 'guttering'],
    cold:        ['rimed', 'still', 'glacial', 'brittle', 'hoared', 'quiet', 'deepening'],
    water:       ['sunken', 'drowned', 'tidal', 'brackish', 'welling', 'undertow', 'weeping'],
    lightning:   ['struck', 'arcing', 'sudden', 'charged', 'restless', 'forked', 'quick'],
    earth:       ['bedded', 'patient', 'unmoved', 'buried', 'stonebound', 'slow', 'deep'],
    wind:        ['scattered', 'thin', 'carrying', 'unhoused', 'wandering', 'hollow', 'whistling'],
    poison:      ['souring', 'creeping', 'green', 'patient', 'wasting', 'unclean', 'slow'],
    acid:        ['eaten', 'thinning', 'bitter', 'hollowing', 'unmade', 'pitted'],
    light:       ['clear', 'unshaded', 'noon', 'plain', 'seen', 'candid', 'washed'],
    dark:        ['unlit', 'covered', 'moonless', 'shuttered', 'private', 'starless', 'kept'],
    arcane:      ['written', 'spoken', 'lettered', 'recited', 'certain', 'named'],
    slashing:    ['keen', 'parting', 'thin', 'drawn', 'opening', 'clean'],
    piercing:    ['narrow', 'threaded', 'single', 'straight', 'sure', 'through'],
    bludgeoning: ['heavy', 'blunt', 'landing', 'settled', 'plain', 'falling'],
  },
  temper: {
    nerve:    ['unflinching', 'bolted', 'braced', 'flighty', 'held'],
    appetite: ['hungry', 'unfed', 'wanting', 'sated', 'grasping'],
    rigor:    ['exacting', 'unfinished', 'squared', 'slapdash', 'measured'],
    grit:     ['stubborn', 'worn', 'unspent', 'brittle', 'lasting'],
    guile:    ['sidelong', 'plain', 'doubled', 'quiet', 'reading'],
  },
  path: { blade: ['drawn', 'practised', 'edged'], arcana: ['spoken', 'lettered', 'recited'], psionics: ['inward', 'wordless', 'attended'] },
  weapon: { sword: ['drawn'], axe: ['falling'], spear: ['levelled'], bow: ['nocked'], dagger: ['close'], staff: ['planted'] },
  trait: { omnimaster: ['manifold'], quicklearner: ['quick'], stubborn: ['set'] },
};

function words(kind, value) {
  const byKind = WORDS[kind];
  if (!byKind) return null;
  if (byKind[value]) return byKind[value];
  // A compound path like 'arcana+blade' takes the words of both.
  if (kind === 'path' && String(value).indexOf('+') >= 0) {
    let out = [];
    for (const p of String(value).split('+')) if (byKind[p]) out = out.concat(byKind[p]);
    return out.length ? out : null;
  }
  return null;
}

function iconFor(kind, value) {
  if (kind === 'element') return El().TYPE_ICON[value] || null;
  if (kind === 'path') { const g = (typeof Gifts !== 'undefined') ? Gifts : null; return g && g.PATHS[value] ? g.PATHS[value].icon : null; }
  return null;
}

// ---------- the adapter ----------
function build() {
  const El_ = El();
  return {
    id: 'ig',
    ticksPerSecond: 10,
    // Capabilities are declared, never silently degraded. A capability turned on here without its
    // adapter members is refused by name at install() rather than surfacing at tick four hundred of
    // a mission the player cannot replay. The generator will not roll a verb whose capability is
    // off, so an ability that needs the calendar is not rolled at all rather than rolled and inert.
    // These flip on one per commit: pipeline at commit 3, laws at 5, world verbs at 6, pricing at 7.
    caps: { party: true, ally: true, arena: true, mission: true,
            calendar: false, summon: false, revive: false, simulate: false, laws: false,
            // Commit 3: the damage path is staged, so a facet can intercept a blow instead of only
            // changing a number that feeds one.
            pipeline: true },

    encounterCap: () => C().MAX_TICKS_CAP || C().MAX_TICKS || 900,

    // ---- randomness ----
    rand: () => R().rand(),
    pick: (a) => R().pick(a),
    weightedPick: (a, wf) => R().weightedPick(a, wf),
    // Drought-smoothed through this game's own Mercy ledger, so facet procs use the same
    // distribution as crits. Pass mercy === false, or have no ledger, to fall back to a flat roll.
    proc: (r, key, rate, mercy) => {
      const f = fighter(r);
      if (mercy === false || !f || !f.ledger) return R().rand() < rate;
      return Mc().procChance(f.ledger, key, rate);
    },
    // The biased rate. Raising the mercy dial changes the variance of a roll, not its long-run rate:
    // mercyCurve solves the slope so the achieved rate equals the authored rate exactly. An ability
    // that means to improve the outcome has to move the rate itself, which mercy will then even out
    // as well. A facet that only turns the mercy dial changes no long-run result.
    curveRate: (r, key, rate, mercy, cap) => Mc().mercyCurve(rate, mercy, cap).base,

    // ---- bearers ----
    now: () => (CTX ? CTX.tick : 0),
    bearerId: (r) => { const f = fighter(r); return f ? f.id : null; },
    isAlive: (r) => { const f = fighter(r); return !!(f && f.alive); },
    sideOf: (r) => { const f = fighter(r); return f ? f.side : null; },
    levelOf: (r) => { const f = fighter(r); return f ? (f.level || (f.char && f.char.stats.stars) || 1) : 1; },
    hp: (r) => { const f = fighter(r); return f ? f.hp : 0; },
    maxHp: (r) => { const f = fighter(r); return f ? f.maxHp : 1; },
    personOf: (r) => { const f = fighter(r); return f ? (f.char || null) : null; },
    opponentsOf: (r) => opponents(fighter(r)).map(ref),

    // The most extreme facts about this character, ranked by magnitude with the sign kept. The
    // generator seeds a facet from the top of this list, so an ability grows out of something that
    // already made the character unusual. The sign is used as well as the size: a facet seeded from
    // low nerve or low grit reads differently from another one seeded from high strength, which is
    // what gives a low-value roll a distinct result rather than a generic one.
    //
    // Every axis read here already exists in the game and none is invented for this: the born stat
    // spread against the race tendency, the five temperament axes against their midpoint, the paths,
    // the innate weapon and the hidden affinity trait. Adding an axis to any of those files widens
    // what a facet can be about, with no edit here and none in the core.
    outliers,

    // Flavour comes from the host, not the core. Adjectives are game words, tied to this game's
    // damage types: if the core held the list, a fifteenth damage type added to elements.js would be
    // named out of a vocabulary that does not contain it. A host that supplies nothing here falls
    // back to the core's neutral pool, which gives duller names rather than broken ones.
    words, icon: iconFor,

    rankers: () => Sch().rankers(),
    resolve: (from, scope) => {
      const f = fighter(from);
      // Out of combat there is no fighter and no sides, but there is still a person, and the `self`
      // and `world` scopes resolve to it. An earlier version returned an empty list here, which made
      // every town-side effect a silent no-op: the clause fired, the effect resolved to no targets,
      // and nothing was applied.
      //
      // The other sides have no meaning in town. The generator's domain weighting does not roll them
      // on a town hook, and one that arrives here anyway gets an empty list rather than a guess.
      if (!f) {
        const e = entry(from);
        if (e && e.kind === 'person') return (!scope.side || scope.side === 'self' || scope.side === 'world') ? [from] : [];
        return [];
      }
      let pool;
      switch (scope.side) {
        case 'self':  pool = [f]; break;
        case 'ally':  pool = sideMates(f).filter(x => x !== f); break;
        case 'party': pool = sideMates(f); break;
        case 'enemy': pool = opponents(f); break;
        case 'arena': case 'world': pool = everyone(f); break;
        default: pool = [f];
      }
      for (const ex of (scope.exclude || [])) {
        if (ex === 'self') pool = pool.filter(x => x !== f);
        if (ex === 'summon') pool = pool.filter(x => !x.summoned);
      }
      if (scope.rank) pool = rank(pool, scope.rank, f);
      if (scope.n !== null && scope.n !== undefined) pool = pool.slice(0, scope.n);
      return pool.map(ref);
    },

    // ---- quantities ----
    // The union of both halves. A host may describe itself across as many files as it likes; the
    // core sees one list, and neither half needs to know the other exists.
    quantities: () => Qs().build().concat(Tw() ? Tw().build() : []),
    readQ,
    // The core holds the override table; this member is only told that something changed. For most
    // quantities nothing needs doing, because stats() is recomputed on every read and there is no
    // cache to invalidate. The member exists mainly so the source game, whose derived block is
    // cached behind a fingerprint, has one place to add its invalidation.
    //
    // fighter.ward is the exception. Elements.slice reads `bearer.ward` as a raw field rather than
    // through the modifier path, so an override to it has to be written where that reader looks.
    // The engine's own contribution is tracked separately in f.facetWard, so probeNative can suspend
    // exactly that amount and leave the character's own ward alone.
    overrideQ: (r, qid, spec) => {
      // A raised ceiling is written where the game's own reader looks, because a cap only the engine
      // knows about is enforced nowhere. It is kept in c.facetCaps rather than written over
      // condition.js's constant, so removing the facet restores the original limit.
      if (spec && spec.mode === 'raise') {
        const c = personOfRef(r);
        if (!c) return;
        if (!c.facetCaps) c.facetCaps = {};
        // The override table owns the arithmetic; this only mirrors the result somewhere the game's
        // own code can read it without knowing the engine exists. The value is read back through
        // Facet.readQ rather than recomputed, so the multiplication happens in exactly one place.
        const key = qid.split('.').pop();
        const now = globalThis.Facet.readQ(r, qid);
        if (now.ok) c.facetCaps[key] = now.value;
        return;
      }
      if (qid !== 'fighter.ward') return;
      const f = fighter(r);
      if (!f) return;
      const q = globalThis.Facet.registry.def(qid);
      const want = globalThis.Facet.readQ(r, qid);
      const native = Math.max(0, (f.ward || 0) - (f.facetWard || 0));
      const added = Math.max(0, (want.ok ? want.value : native) - native);
      f.facetWard = added;
      f.ward = native + added;
    },
    clearOverrides: (r) => {
      const f = fighter(r);
      if (!f) return;
      f.ward = Math.max(0, (f.ward || 0) - (f.facetWard || 0));
      f.facetWard = 0;
    },
    touchQ: () => {},

    // ---- statuses ----
    statusSchema: () => Sch().statusSchema(),
    statusWorth: (id) => { const d = El_.STATUSES[id]; return d ? (d.worth || 1) : 1; },
    // Idempotent registration into the game's own STATUSES table. A generated definition is never
    // serialised; it is rebuilt from the facet record at load, so changing the compiler needs no
    // save migration.
    defineStatus: (def) => {
      if (!def || !def.id) return;
      El_.STATUSES[def.id] = Object.assign({ stacking: { mode: 'highest' }, worth: 0 }, El_.STATUSES[def.id] || {}, def);
    },
    applyStatus: (r, app, source) => { const f = fighter(r); return f ? El_.applyStatus(f, app, source) : null; },
    removeStatus: (r, id) => { const f = fighter(r); if (f) El_.removeStatus(f, id); },
    findStatus: (r, id) => { const f = fighter(r); return f ? El_.findStatus(f, id) : null; },
    setStatusIntensity: (r, id, v) => { const h = holdOf(r, id); if (h) h.intensity = v; },
    setStatusStacks: (r, id, n) => { const h = holdOf(r, id); if (h) h.stacks = n; },
    setStatusData: (r, id, o) => { const h = holdOf(r, id); if (h) h.data = Object.assign(h.data || {}, o); },

    // ---- pipeline ----
    stages: () => Sch().stages(),
    channels: () => Sch().channels(),
    classOf: (t) => Sch().classOf(t),
    slice: (r, type, raw, pen, hit) => { const f = fighter(r); return f ? El_.slice(f, type, raw, pen || 0, hit || null) : { dealt: raw }; },
    joinStage: (stageId, phase, fn, owner) => globalThis.Facet.pipeline.join(stageId, phase, fn, owner),

    // The two damage doors. C().damage and C().heal were module-private in combat.js until this
    // commit. compile.js guards on `host.applyDamage`, so with the member absent every world.damage
    // and world.heal a facet emitted dealt zero with no error reported: an accumulator that stored a
    // blow and then vented it did nothing.
    applyDamage: (r, amount, type, source, attackerRef) => {
      const f = fighter(r);
      if (!f || !CTX) return 0;
      return C().damage(CTX, f, amount, type, source || 'facet', attackerRef ? fighter(attackerRef) : null);
    },
    applyHeal: (r, amount, kind, source) => {
      const f = fighter(r);
      if (!f || !CTX) return 0;
      return C().heal(CTX, f, amount, kind || 'facet');
    },

    // ---- measurement ----
    probeSlice, probeNative, refBlow, reachableTypes,

    // ---- gate ----
    descriptorSchema: () => Sch().descriptorSchema(),
    vocabulary: (field) => Sch().vocabulary(field),

    // ---- persistence ----
    // The lazy initialiser is a separate statement rather than folded into the return expression.
    // Folded, the assignment lands on the raw object instead of going through the reactive proxy.
    // That has no visible effect in this game and is a real bug in the source game.
    bag: (tier, r) => {
      const f = fighter(r);
      if (!f) return {};
      if (tier === 'tick' || tier === 'encounter') {
        if (!f.facetBag) f.facetBag = {};
        return f.facetBag;
      }
      const c = f.char;
      if (!c) return {};
      if (!c.facetState) c.facetState = {};
      return c.facetState;
    },

    log: (line) => { if (CTX && CTX.log && line) CTX.log(line); },
    trace: () => {},
  };
}

function holdOf(r, id) {
  const f = fighter(r);
  if (!f) return null;
  return El().findStatus(f, id);
}

function rank(pool, how, self) {
  const C_ = C();
  const arr = pool.slice();
  switch (how) {
    case 'wounded':  return arr.sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp));
    case 'weakest':  return arr.sort((a, b) => a.maxHp - b.maxHp);
    case 'strongest':return arr.sort((a, b) => (C_.stats(b).damage + C_.stats(b).magicDamage) - (C_.stats(a).damage + C_.stats(a).magicDamage));
    case 'caster':   return arr.sort((a, b) => (C_.stats(b).magicDamage - C_.stats(b).damage) - (C_.stats(a).magicDamage - C_.stats(a).damage));
    case 'front':    return arr.sort((a, b) => (a.rank === 'reserve' ? 1 : 0) - (b.rank === 'reserve' ? 1 : 0));
    case 'lowestAlly': return arr.filter(x => x !== self).sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp));
    case 'spread': case 'random': return R().shuffle(arr);
    default: return arr;
  }
}

// ---------- the thirteen entry points ----------
// Each is one line at the host's call site. They are wrapped here rather than called directly so a
// commit that has not loaded the engine is a no-op rather than a crash.
const F = () => globalThis.Facet && globalThis.Facet.ready() ? globalThis.Facet : null;

// Installed on first use rather than at load, because of load order. This file is a classic script
// among forty-six others and cannot know whether elements.js has run yet, and build() reads the
// game's own tables. First use is inside an encounter, by which point every table exists. ensure()
// is idempotent, and a failed install throws rather than warning; see the note at the top of
// combat.js on why this one call does not follow the optional-thunk convention.
let installed = false;
function ensure() {
  if (installed || !globalThis.Facet) return installed;
  globalThis.Facet.install(build());
  installed = true;
  // World-scoped quantities read from the save. Picked up here rather than passed in, because this
  // is the one point at which both the engine and the game are certainly loaded.
  if (typeof state !== 'undefined') setTownState(state);
  return true;
}

const API = {
  build, ref, personRef, fighter, personOfRef, forget, ensure, setTownState,
  setContext(ctx) { ensure(); setContext(ctx); },
  install() {
    if (!globalThis.Facet) return null;
    installed = false;
    ensure();
    return globalThis.Facet;
  },
  attach(f, facets) { const F_ = F(); if (F_ && facets && facets.length) F_.attach(ref(f), facets); },
  detach(f) { const F_ = F(); if (F_) { const r = ref(f); F_.detach(r); forget(r); } },
  tick(f) { const F_ = F(); if (F_) F_.tick(ref(f)); },
  event(ev, f, detail) { const F_ = F(); if (F_) F_.event(ev, ref(f), detail); },
  tierEnd(tier, f) { const F_ = F(); if (F_) F_.tierEnd(tier, ref(f)); },
  dirty(f) { const F_ = F(); if (F_) F_.dirty(ref(f)); },

  // The town-side entry point. A character out of a fight has no combatant, so this attaches against
  // a person ref and fires there; that is why refs carry a kind.
  //
  // Attachment is lazy rather than at load. The roster is every character the player owns, and most
  // of them are idle most of the time, so compiling records for all of them on every tick would be
  // wasted work. A character with no facets costs one array length check.
  townEvent(evId, c, detail) {
    const F_ = F();
    if (!F_ || !c || !c.facets || !c.facets.length) return;
    const r = personRef(c);
    if (!F_.recordOf(r)) F_.attach(r, c.facets);
    F_.event(evId, r, detail || {});
  },

  // Town-tier boundaries, for cells that reset on something longer than a fight.
  townTierEnd(tier, c) {
    const F_ = F();
    if (!F_ || !c || !c.facets || !c.facets.length) return;
    F_.tierEnd(tier, personRef(c));
  },
  fingerprint(f) { const F_ = F(); return F_ ? F_.fingerprint(ref(f)) : ''; },
  ledger(f) { const F_ = F(); return F_ ? F_.mortal.ledgerOf(ref(f)) : null; },
};

if (typeof module !== 'undefined') module.exports = API;
if (typeof window !== 'undefined') window.FacetHostIG = API;
})();
