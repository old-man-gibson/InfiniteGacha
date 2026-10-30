// Spellcraft: sentence magic lifted from Frontier Idle's arcane system. Browser: window.Spellcraft. Node: module.exports.
//
// A spell is a sentence of words. Words are nouns (an element), verbs (a shape), adverbs
// (a modifier), targets and conjunctions. Order is free: the parser reads left to right and
// forms clauses of one noun plus one verb; a second noun or verb opens a new clause. Adjacent
// repeats of a word deepen it (fire, flame, blaze). Only five things make a sentence illegal:
// an unknown word, a tier beyond mastery, four of a kind in a row, a dangling conjunction, and
// a sentence with neither noun nor verb.
//
// Characters do not write spells; they build a grimoire when a mission launches (buildGrimoire),
// through AI.decide, so a dim mind mutters random legal sentences and a genius optimises for
// its doctrine against the enemies it expects.

(() => {
const R = (typeof Rng !== 'undefined') ? Rng : require('./rng.js');
const AIx = (typeof AI !== 'undefined') ? AI : require('./ai.js');
const St = (typeof Stats !== 'undefined') ? Stats : require('./stats.js');
const El = () => (typeof Elements !== 'undefined') ? Elements : require('./elements.js');
// Optional: a class hands over words the character was never born with (classes.js).
const CL = () => (typeof Classes !== 'undefined') ? Classes : (typeof require !== 'undefined' ? require('./classes.js') : null);
const GF = () => (typeof Gifts !== 'undefined') ? Gifts : (typeof require !== 'undefined' ? require('./gifts.js') : null);
// Born arcane: own words plus the class's. Not born to it: only what a class taught (gifts.js).
const lexiconOf = (c) => { const cl = CL(); const g = GF(); if (g && !g.has(c, 'arcana')) return cl ? cl.wordsOf(c) : []; return cl ? cl.lexiconOf(c) : (c.lexicon || []); };
const DABBLER_WORDS = 3;   // a trained caster's sentence never grows past this
const DABBLER_PREPARED = 1;

// ---------- constants (verbatim from the source game) ----------
const VERB_LED = { power: 0.85, mechanics: 1.3 };
const NOUN_LED = { power: 1.15, mechanics: 0.8 };
const UNSHAPED_POWER = 0.8;
const clauseShare = (i) => 1 / (1 + i * 0.5);
const OTHERS_MANA_MULT = 1.5;
const OTHERS_POWER = 0.5;
const BASE_COOLDOWN = 90;          // ticks at 10/s
const COOLDOWN_RANGE = [30, 500];
const MAX_STACK = 3;
const INTENSITY_FLOOR = 0.15;
const STACK_POWER = [1, 2.3, 3.9];
const STACK_MANA = [1, 3, 6];
const EVERYTHING_SPLASH = 1.5;
const BASE_PREPARED = 3;
const PREPARED_PER_LEVELS = 20;

// ---------- words ----------
const N = (id, stacked, minLevel, mana, element, power, inflict, icon, extra = {}) =>
  ({ id, kind: 'noun', word: id, stacked, minLevel, mana, element, power, inflicts: inflict ? [inflict] : undefined, icon, ...extra });
const inf = (id, intensity, chance) => ({ id, intensity, chance });

const WORDS = {};
for (const w of [
  N('fire',   ['flame', 'blaze'],          0,  2, 'heat',      1.0,  inf('on_fire', 1, 0.35), '🔥'),
  N('ice',    ['frost', 'glacier'],        0,  2, 'cold',      0.9,  inf('chilled', 1, 0.40), '❄️'),
  N('spark',  ['arc', 'bolt'],             3,  2, 'lightning', 0.85, inf('jolted', 1, 0.30), '⚡'),
  N('water',  ['torrent', 'deluge'],       4,  2, 'water',     0.8,  inf('wet', 1, 0.50), '💧'),
  N('stone',  ['boulder', 'mountain'],     5,  3, 'earth',     1.15, inf('shardbound', 1, 0.30), '🪨'),
  N('gust',   ['wind', 'storm'],           4,  2, 'wind',      0.85, inf('buffeted', 1, 0.25), '🌬️'),
  N('seed',   ['bramble', 'wildwood'],     5,  2, 'poison',    0.7,  inf('seeded', 1, 0.50), '🌱'),
  N('iron',   ['steel', 'adamant'],        11, 2, 'piercing',  0.9,  inf('magnetized', 1, 0.35), '🧲'),
  N('venom',  ['toxin', 'plague'],         6,  2, 'poison',    0.7,  inf('poison', 1, 0.60), '☠️'),
  N('acid',   ['corrosion', 'liquefaction'], 6, 2, 'acid',     0.7,  inf('corroded', 1, 1.0), '🧪'),
  N('light',  ['radiance', 'sun'],         8,  3, 'light',     0.9,  inf('dazzled', 1, 0.30), '☀️'),
  N('gloom',  ['dusk', 'abyss'],           8,  3, 'dark',      1.0,  inf('tainted', 1, 0.15), '🌑'),
  N('zero',   ['naught', 'null'],          10, 2, 'arcane',    1.0,  null, '⭕', { untyped: true }),
  N('arcane', ['eldritch', 'anathema'],    13, 3, 'arcane',    0.9,  inf('unravelling', 1, 0.50), '🔮'),
]) WORDS[w.id] = w;

const V = (id, stacked, minLevel, mana, spec, icon) => ({ id, kind: 'verb', word: id, stacked, minLevel, mana, icon, ...spec });
for (const w of [
  V('cut',    ['gash', 'sunder'],      9, 2, { powerMult: 0.8,  barePower: 0.55, statusRate: 2.2,  bareType: 'slashing',    bareInflicts: [inf('bleeding', 1, 0.4)] }, '🔪'),
  V('crush',  ['crumple', 'implode'],  9, 2, { powerMult: 1.3,  barePower: 0.7,  statusRate: 0.45, bareType: 'bludgeoning', bareInflicts: [inf('concussed', 1, 0.4)] }, '🔨'),
  V('pierce', ['impale', 'skewer'],    0, 1, { powerMult: 0.95, barePower: 0.5,  penetration: 0.35, statusRate: 0.6, bareType: 'piercing', bareInflicts: [inf('punctured', 1, 0.4)] }, '🗡️'),
  V('fly',    ['dart', 'blink'],       0, 1, { powerMult: 0.9,  barePower: 0.4,  cooldownMult: 0.75 }, '🕊️'),
  V('expand', ['engulf', 'everything'], 4, 2, { powerMult: 0.85, barePower: 0.4, splash: 0.5 }, '💥'),
  V('burst',  ['erupt', 'detonate'],   6, 2, { powerMult: 1.35, barePower: 0.6,  cooldownMult: 1.3 }, '🎇'),
  V('grasp',  ['clutch', 'strangle'],  8, 2, { powerMult: 0.6,  barePower: 0.3,  gripMult: 2.0 }, '✊'),
  V('ward',   ['bulwark', 'sanctum'],  5, 2, { ward: { amount: 0.15, duration: 300 } }, '🛡️'),
  V('mend',   ['knit', 'renew'],       7, 3, { restore: 1.0 }, '💚'),
]) WORDS[w.id] = w;

const A = (id, stacked, minLevel, mana, spec) => ({ id, kind: 'adverb', word: id, stacked, minLevel, mana, ...spec });
for (const w of [
  A('slowly',    ['dragging', 'glacial'],      0,  1, { powerMult: 1.4, cooldownMult: 1.5, manaMult: 1.2, clock: { lead: { dur: 2, rate: 1 }, trail: { dur: 3, rate: 1 / 3 } } }),
  A('quickly',   ['flashing', 'instant'],      0,  1, { powerMult: 0.75, cooldownMult: 0.65, clock: { lead: { dur: 0.25, rate: 3 }, trail: { dur: 0.5, rate: 2 } } }),
  A('gently',    ['faintly', 'barely'],        7,  1, { powerMult: 0.5, manaMult: 0.85, crit: { lead: { chance: -0.05 }, trail: { damage: -0.2 } } }),
  A('viciously', ['savagely', 'murderously'],  13, 2, { manaMult: 1.4, crit: { lead: { chance: 0.07 }, trail: { damage: 0.25 } } }),
  A('intensely', ['fiercely', 'overwhelmingly'], 10, 2, { intensity: 1.6, manaMult: 1.3, clock: { lead: { dur: 1, rate: 1 }, trail: { dur: 0.6, rate: 1 } } }),
  A('dimly',     ['thinly', 'scarcely'],       8,  1, { intensity: 0.6, manaMult: 0.9, clock: { lead: { dur: 1, rate: 1 }, trail: { dur: 1.6, rate: 1 } } }),
  A('twice',     ['thrice', 'fourfold'],       6,  2, { hits: 2, manaMult: 1.8 }),
]) WORDS[w.id] = w;

for (const [id, minLevel, mana, spec] of [
  ['then', 12, 1, { inheritPenetration: true, followThrough: 1.3 }],
  ['and',  14, 2, { fuse: 0.85 }],
  ['but',  16, 2, { transmute: true }],
  ['or',   15, 1, { alternate: 0.5 }],
  ['if',   18, 1, { condition: true }],
]) WORDS[id] = { id, kind: 'conjunction', word: id, minLevel, mana, ...spec };

for (const [id, minLevel, mana, target] of [['one', 0, 0, 'one'], ['others', 5, 2, 'others'], ['me', 2, 0, 'self']])
  WORDS[id] = { id, kind: 'target', word: id, minLevel, mana, target };

const STARTER_LEXICON = ['fire', 'ice', 'spark', 'pierce', 'ward', 'mend', 'quickly', 'slowly', 'one', 'me', 'others'];

// ---------- levels ----------
// Arcana level is read off the character's arcana aptitude (absolute level / 15, so S** is 46).
function maxSentenceWords(level) { return Math.min(8, 3 + Math.floor(level / 8)); }
function preparedCap(level) { return BASE_PREPARED + Math.floor(level / PREPARED_PER_LEVELS); }
// Mastery: tier 2 from arcana level 8, tier 3 from level 20.
function masteredTier(level, word) { return !word.stacked ? 1 : level >= 20 ? 3 : level >= 8 ? 2 : 1; }

function splitWordId(token) { const [id, t] = token.split(':'); return { id, tier: t ? Number(t) : 1 }; }
function displayWord(t) { return t.count === 1 ? t.def.word : t.def.stacked[t.count - 2]; }
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- parsing ----------
function parseSentence(tokens) {
  const words = [];
  for (const tok of tokens) {
    const { id, tier } = splitWordId(tok);
    const def = WORDS[id];
    if (!def) return { error: `No such word: ${id}` };
    if (!Number.isInteger(tier) || tier < 1 || tier > 3 || (tier > 1 && !def.stacked)) return { error: `No such word: ${tok}` };
    const last = words[words.length - 1];
    if (last && last.def.id === id && def.kind !== 'target' && def.kind !== 'conjunction') {
      if (last.count + tier > MAX_STACK) return { error: `No mouth can hold a fourth "${id}"` };
      last.count += tier;
    } else words.push({ def, count: tier, kind: def.kind });
  }
  const clauses = [];
  let clause = null, target = 'one', pendingLink = null, prevWasConj = false;
  const open = () => { clause = { noun: null, verb: null, adverbs: [], led: null, linked: pendingLink }; pendingLink = null; clauses.push(clause); };
  for (const w of words) {
    if (w.kind === 'target') { target = w.def.target; prevWasConj = false; continue; }
    if (w.kind === 'conjunction') {
      if (!clause || prevWasConj) return { error: `"${w.def.id}" follows nothing` };
      pendingLink = { conjunction: w.def };
      clause = null; prevWasConj = true;
      continue;
    }
    prevWasConj = false;
    if (!clause) open();
    if (w.kind === 'noun') {
      if (clause.noun) open();
      clause.noun = w; if (!clause.led) clause.led = 'noun';
    } else if (w.kind === 'verb') {
      if (clause.verb) open();
      clause.verb = w; if (!clause.led) clause.led = 'verb';
    } else {
      clause.adverbs.push({ ...w, preCore: !clause.noun && !clause.verb });
    }
  }
  if (pendingLink) return { error: `"${pendingLink.conjunction.id}" leads nowhere` };
  if (!words.some(w => w.kind === 'noun' || w.kind === 'verb')) return { error: 'The words fizzle: a spell needs a noun or a verb' };
  return { words, clauses, target, tokens: words };
}

// ---------- composition ----------
const scaleInflicts = (apps, mult) => (!apps || mult <= 0) ? undefined : apps.map(a => ({ ...a, intensity: a.intensity * mult }));
const scaleChance = (apps, mult) => apps && apps.map(a => ({ ...a, chance: Math.min(0.95, (a.chance == null ? 1 : a.chance) * mult) }));
function shapeConditions(apps, durMult, intMult) {
  if (!apps) return apps;
  const ST = El().STATUSES;
  return apps.map(a => {
    const out = { ...a, intensity: a.intensity * intMult };
    const d = ST[a.id] && ST[a.id].duration;
    if (d) out.duration = Math.max(1, Math.round(d * durMult));
    return out;
  });
}
function signatureStatuses(apps) {
  if (!apps) return [];
  const ST = El().STATUSES;
  const out = [];
  for (const a of apps) { let id = a.id; while (id && !out.includes(id)) { out.push(id); id = ST[id] && ST[id].escalatesTo; } }
  return out;
}

function composeArcane(tokens) {
  const parse = parseSentence(tokens);
  if (parse.error) return { error: parse.error };
  const strikes = [];
  let manaCost = 0, cooldownMult = 1, heal = 0, splash = 0, splashRaw = 0, wardMods = [], wardDuration = 0;
  let target = parse.target, prevStrike = null, shareIndex = -1, altGroups = 0;

  for (const clause of parse.clauses) {
    if (!clause.linked) shareIndex++;
    const share = clauseShare(Math.max(0, shareIndex));
    const noun = clause.noun ? clause.noun.def : null;
    const verb = clause.verb ? clause.verb.def : null;
    const nounCount = clause.noun ? clause.noun.count : 1;
    const verbCount = clause.verb ? clause.verb.count : 1;
    const nounStack = STACK_POWER[nounCount - 1], verbStack = STACK_POWER[verbCount - 1];
    const led = clause.led === 'verb' ? VERB_LED : NOUN_LED;
    let powerMult = 1, manaMult = 1, condIntensity = 1, condDur = 1, condRate = 1, critAdd = 0, critDamageAdd = 0, hitsPre = 1, hitsPost = 1;
    for (const adv of clause.adverbs) {
      const a = adv.def;
      powerMult *= Math.pow(a.powerMult || 1, adv.count);
      manaMult *= a.manaMult || 1;
      cooldownMult *= Math.pow(a.cooldownMult || 1, adv.count);
      condIntensity *= Math.pow(a.intensity || 1, adv.count);
      if (a.crit) { const side = adv.preCore ? a.crit.lead : a.crit.trail; critAdd += ((side && side.chance) || 0) * adv.count; critDamageAdd += ((side && side.damage) || 0) * adv.count; }
      if (a.clock) { const side = adv.preCore ? a.clock.lead : a.clock.trail; condDur *= Math.pow(side.dur, adv.count); condRate *= Math.pow(side.rate, adv.count); }
      if (a.hits) { const landings = a.hits + (adv.count - 1); if (adv.preCore) hitsPre = Math.max(hitsPre, landings); else hitsPost = Math.max(hitsPost, landings); }
    }
    const hits = hitsPre, depth = hitsPost;
    const spoken = [clause.noun, clause.verb, ...clause.adverbs];
    const conj = clause.linked ? clause.linked.conjunction : null;
    manaCost += spoken.reduce((s, t) => s + (t ? t.def.mana * STACK_MANA[t.count - 1] : 0), 0) * manaMult * ((conj && conj.alternate) || 1);
    if (verb && verb.cooldownMult) cooldownMult *= Math.pow(verb.cooldownMult, verbCount);

    if (verb && verb.restore) {
      const base = noun ? noun.power * nounStack * (verb.powerMult || 1) : 0.5;
      heal += base * verb.restore * verbStack * led.power * powerMult * share * hits * depth;
      prevStrike = null; continue;
    }
    if (verb && verb.ward) {
      const amount = verb.ward.amount * verbStack * nounStack * led.mechanics * powerMult * Math.max(INTENSITY_FLOOR, condIntensity) * depth * condRate * share;
      wardMods.push(noun && noun.element ? { stat: 'res:' + noun.element, op: 'add', value: amount } : { stat: 'armor', op: 'add', value: amount * 20 });
      wardDuration = Math.max(wardDuration, Math.max(1, Math.round(verb.ward.duration * condDur * hits)));
      prevStrike = null; continue;
    }
    let power;
    if (noun && verb) power = noun.power * nounStack * (verb.powerMult || 1) * led.power;
    else if (noun) power = noun.power * nounStack * UNSHAPED_POWER;
    else power = ((verb && verb.barePower) || 0) * verbStack;
    power *= powerMult * share * depth;
    if (power <= 0) { prevStrike = null; continue; }
    const mechanics = clause.verb ? led.mechanics : 1;
    const strike = { power, type: noun ? noun.element : (verb.bareType || 'arcane') };
    if (noun && noun.untyped) strike.untyped = true;
    if (critAdd) strike.critBonus = critAdd;
    if (critDamageAdd) strike.critDamageBonus = critDamageAdd;
    if (verb && verb.penetration) strike.penetration = Math.min(0.95, verb.penetration * mechanics * verbStack);
    if (hits > 1) strike.hits = hits;
    const grip = verb && verb.gripMult ? verb.gripMult * mechanics * verbStack : 1;
    const carried = noun ? noun.inflicts : (verb ? verb.bareInflicts : undefined);
    strike.inflicts = shapeConditions(scaleChance(scaleInflicts(carried, nounStack * grip * depth * Math.max(INTENSITY_FLOOR, condIntensity)), verb && verb.statusRate ? Math.pow(verb.statusRate, verbCount) * mechanics : 1), condDur, condRate);
    if (verb && verb.splash) { const raw = verb.splash * mechanics * verbStack; splashRaw += raw; splash = Math.min(0.75, splash + raw); }

    if (conj && prevStrike) {
      if (conj.fuse) {
        if (prevStrike.untyped && !strike.untyped) { delete prevStrike.untyped; prevStrike.type = strike.type; }
        else if (!prevStrike.orType && prevStrike.type !== strike.type) prevStrike.orType = strike.type;
        prevStrike.power += strike.power * (strike.hits || 1) * conj.fuse;
        prevStrike.penetration = Math.max(prevStrike.penetration || 0, strike.penetration || 0) || undefined;
        if (strike.inflicts) prevStrike.inflicts = [...(prevStrike.inflicts || []), ...strike.inflicts];
        continue;
      }
      if (conj.transmute) {
        const donated = scaleInflicts(strike.inflicts, powerMult);
        prevStrike.inflicts = donated && hitsPre > 1 ? Array.from({ length: hitsPre }, () => donated.map(a => ({ ...a }))).flat() : donated;
        continue;
      }
      if (conj.condition) { prevStrike.onlyIf = signatureStatuses(noun ? noun.inflicts : undefined); }
      if (conj.alternate) { const g = prevStrike.altGroup != null ? prevStrike.altGroup : altGroups++; prevStrike.altGroup = g; strike.altGroup = g; }
      if (conj.followThrough) { strike.penetration = Math.max(strike.penetration || 0, prevStrike.penetration || 0) || undefined; strike.followUp = conj.followThrough; }
    }
    strikes.push(strike);
    prevStrike = strike;
  }

  manaCost += parse.words.filter(w => w.kind === 'target' || w.kind === 'conjunction').reduce((s, w) => s + (w.def.mana || 0), 0);
  if (parse.target === 'others') manaCost *= OTHERS_MANA_MULT;
  if (splashRaw >= EVERYTHING_SPLASH && target === 'one') { target = 'others'; splash = 0; }
  const spokeAddress = parse.words.some(w => w.kind === 'target');
  const healsEnemy = heal > 0 && spokeAddress && target !== 'self';
  const cooldown = Math.round(Math.min(COOLDOWN_RANGE[1], Math.max(COOLDOWN_RANGE[0], BASE_COOLDOWN * cooldownMult)));
  const firstNoun = parse.clauses.find(c => c.noun);
  const icon = firstNoun ? firstNoun.noun.def.icon : (parse.clauses[0] && parse.clauses[0].verb ? parse.clauses[0].verb.def.icon : '✨');
  const spec = {
    key: 'arcane:' + parse.tokens.map(t => t.count > 1 ? t.def.id + t.count : t.def.id).join(','),
    words: tokens.slice(), name: parse.tokens.map(t => cap(displayWord(t))).join(' '), icon,
    manaCost: Math.max(1, Math.round(manaCost)), cooldown, target, strikes, heal, healsEnemy, splash,
  };
  if (wardMods.length) spec.buff = { name: 'Ward', mods: wardMods, duration: wardDuration };
  return spec;
}

/** Legality for a given caster: lexicon, arcana level, mastery and length. */
function checkSentence(lexicon, level, tokens, maxWords = null) {
  if (!tokens.length) return { ok: false, reason: 'Nothing spoken' };
  const max = maxWords || maxSentenceWords(level);
  if (tokens.length > max) return { ok: false, reason: `Can hold ${max} words in mind at once` };
  for (const tok of tokens) {
    const { id, tier } = splitWordId(tok);
    const w = WORDS[id];
    if (!w) return { ok: false, reason: `No such word: ${id}` };
    if (!lexicon.includes(id)) return { ok: false, reason: `Does not know "${id}"` };
    if (w.minLevel > level) return { ok: false, reason: `"${id}" needs Arcana ${w.minLevel}` };
    if (tier > masteredTier(level, w)) return { ok: false, reason: `"${id}" must be earned` };
  }
  const spec = composeArcane(tokens);
  if (spec.error) return { ok: false, reason: spec.error };
  return { ok: true, spec };
}

// ---------- lexicon ----------
function rollLexicon(stars, rand = R.rand) {
  const known = new Set(STARTER_LEXICON);
  const p = 0.15 + 0.1 * stars;
  for (const w of Object.values(WORDS)) if (!known.has(w.id) && rand() < p) known.add(w.id);
  return [...known];
}
function learnWord(lexicon, rand = R.rand) {
  const unknown = Object.keys(WORDS).filter(id => !lexicon.includes(id));
  if (!unknown.length) return null;
  const id = unknown[Math.floor(rand() * unknown.length)];
  lexicon.push(id);
  return id;
}

// ---------- evaluation (for the builders, not the players) ----------
/**
 * Expected value of one cast against an enemy profile: damage-equivalent per cast, riders
 * priced by Elements.statusValue, resistances applied when the profile carries them.
 * profile = { resist: {type: fraction}, count, hp } or null.
 */
function castValue(spec, caster, profile) {
  const E = El();
  const dv = caster.derived || St.effective(caster).derived;
  const sp = dv.magicDamage;
  let dmg = 0, riders = 0, stackTags = new Set();
  const targets = spec.target === 'others' ? Math.max(1, (profile && profile.count) || 1) : 1;
  const share = spec.target === 'others' ? OTHERS_POWER : 1;
  const seenAlt = new Set();
  for (const s of spec.strikes) {
    let w = 1;
    if (s.altGroup != null) { if (seenAlt.has(s.altGroup)) continue; seenAlt.add(s.altGroup); w = 1; }
    if (s.onlyIf) w *= 0.6;
    const follow = s.followUp ? (0.5 + s.followUp * 0.5) : 1;
    let type = s.type;
    let res = s.untyped ? 0 : E.resistOf(profile, type);
    if (s.orType) { const r2 = E.resistOf(profile, s.orType); if (r2 < res) { res = r2; type = s.orType; } }
    const pen = Math.min(0.95, (s.penetration || 0));
    const crit = Math.min(0.75, dv.critChance + (s.critBonus || 0));
    const critMult = 1 + crit * (dv.critDamage + (s.critDamageBonus || 0) - 1);
    const hits = s.hits || 1;
    dmg += sp * s.power * share * hits * follow * w * critMult * (1 - Math.max(0, res) * (1 - pen));
    for (const a of (s.inflicts || [])) {
      riders += E.statusValue(a.id, a.intensity, a.duration) * (a.chance == null ? 1 : a.chance) * hits * w;
      stackTags.add(a.id);
    }
  }
  // conditions the spec lays on its targets whether or not a strike lands (class features:
  // a roar has no strike, and is worth exactly what it does to the room)
  for (const a of (spec.afflicts || [])) {
    riders += E.statusValue(a.id, a.intensity, a.duration) * (a.chance == null ? 1 : a.chance);
    stackTags.add(a.id);
  }
  const synergy = E.synergyBonus([...stackTags]);
  const splashV = spec.splash && profile && profile.count > 1 ? dmg * spec.splash : 0;
  const healV = spec.heal && !spec.healsEnemy ? spec.heal * sp * 0.8 : 0;
  const wardV = spec.buff ? spec.buff.mods.reduce((a, m) => a + (m.stat === 'armor' ? m.value : m.value * 40), 0) * 0.5 : 0;
  return { damage: (dmg + splashV) * targets, riders: riders * targets * (1 + synergy), stacks: stackTags.size, synergy, heal: healV, ward: wardV,
    total: (dmg + splashV) * targets + riders * targets * (1 + synergy) + healV + wardV };
}

// ---------- the builder ----------
// Random legal sentence from a lexicon. `structured` grows with intelligence: a structured
// sentence is noun+verb(+adverb) clauses, a loose one is any words in any order.
// Returns [] when no word in the lexicon is usable at `level` (a class can teach words above the
// caster's arcana level); checkSentence rejects [], so buildGrimoire ends with an empty grimoire.
function randomSentence(lexicon, level, structured, maxWords = null) {
  const max = maxWords || maxSentenceWords(level);
  const usable = lexicon.filter(id => WORDS[id].minLevel <= level);
  if (!usable.length) return [];
  const byKind = (k) => usable.filter(id => WORDS[id].kind === k);
  const nouns = byKind('noun'), verbs = byKind('verb'), advs = byKind('adverb'), conjs = byKind('conjunction'), tgts = byKind('target');
  const tierTok = (id) => { const t = masteredTier(level, WORDS[id]); const tier = t > 1 && R.chance(0.35) ? R.randInt(2, t) : 1; return tier > 1 ? `${id}:${tier}` : id; };
  const out = [];
  if (!structured || !nouns.length && !verbs.length) {
    const len = R.randInt(1, max);
    for (let i = 0; i < len; i++) out.push(tierTok(R.pick(usable)));
  } else {
    let budget = max;
    let clauses = 1 + (R.chance(0.35) && conjs.length ? 1 : 0) + (R.chance(0.15) && conjs.length ? 1 : 0);
    while (clauses-- > 0 && budget >= 2) {
      if (out.length && conjs.length) { out.push(R.pick(conjs)); budget--; }
      if (R.chance(0.3) && advs.length && budget > 2) { out.push(tierTok(R.pick(advs))); budget--; }
      const nounFirst = R.chance(0.5);
      const n = nouns.length ? tierTok(R.pick(nouns)) : null, v = verbs.length && R.chance(0.85) ? tierTok(R.pick(verbs)) : null;
      for (const t of nounFirst ? [n, v] : [v, n]) if (t) { out.push(t); budget--; }
      if (R.chance(0.35) && advs.length && budget > 1) { out.push(tierTok(R.pick(advs))); budget--; }
    }
    if (R.chance(0.2) && tgts.length && budget > 0) out.push(R.pick(tgts));
    if (!out.length) out.push(tierTok(R.pick(usable)));
  }
  return out.slice(0, max);
}

/**
 * Build a grimoire for a character: up to preparedCap spells chosen through AI.decide. The
 * scorer weighs damage per mana, burst inside the mana pool, condition stacking and sustain
 * by the doctrine. Returns { spells: [spec...], doctrine }.
 */
function buildGrimoire(c, level, profile, doctrine) {
  const lexicon = lexiconOf(c);
  if (!lexicon.length) return { spells: [], doctrine };
  const g = GF();
  const born = !g || g.has(c, 'arcana');
  // a class can widen the list they walk in with (classes.js Arcanist)
  const cl = CL();
  const cap = (born ? preparedCap(level) : DABBLER_PREPARED) + (cl ? cl.preparedBonus(c) : 0);
  const maxWords = born ? null : Math.min(DABBLER_WORDS, maxSentenceWords(level));
  const t = AIx.tier(c);
  const structuredP = 0.15 + 0.2 * AIx.tierIndex(c);
  const w = AIx.DOCTRINES[doctrine].w;
  const pool = St.effective(c).derived.mana;
  const seen = new Set();
  const generate = () => {
    for (let tries = 0; tries < 6; tries++) {
      const toks = randomSentence(lexicon, level, R.chance(structuredP), maxWords);
      const chk = checkSentence(lexicon, level, toks, maxWords);
      if (!chk.ok || seen.has(chk.spec.key)) continue;
      return chk.spec;
    }
    return null;
  };
  const score = (spec) => {
    if (spec.manaCost > pool) return 0.01;             // cannot be cast at all
    const v = castValue(spec, c, t.refine > 0 ? profile : null);
    const perMana = v.total / spec.manaCost;
    const castsInPool = Math.floor(pool / spec.manaCost);
    const burst = v.damage * Math.min(3, castsInPool) / Math.max(1, spec.cooldown / 90);
    const sustain = perMana * (90 / spec.cooldown) * Math.min(1, castsInPool / 6);
    return w.dpr * perMana * 10 + w.burst * burst * 0.2 + w.stack * (v.riders / spec.manaCost * 8 + v.stacks * 4 + v.synergy * 20) + w.sustain * sustain * 8;
  };
  const refine = (spec) => {
    // neighbour: swap one word for another of the same kind
    const toks = spec.words.slice();
    const i = R.randInt(0, toks.length - 1);
    const kind = WORDS[splitWordId(toks[i]).id].kind;
    const alts = lexicon.filter(id => WORDS[id].kind === kind && WORDS[id].minLevel <= level);
    if (!alts.length) return spec;
    toks[i] = R.pick(alts);
    const chk = checkSentence(lexicon, level, toks, maxWords);
    return chk.ok ? chk.spec : spec;
  };
  const spells = [];
  for (let slot = 0; slot < cap; slot++) {
    const best = AIx.decide(c, { generate, score, refine });
    if (!best) break;
    seen.add(best.key);
    spells.push(best);
  }
  return { spells, doctrine };
}

const SpellcraftAPI = { WORDS, STARTER_LEXICON, lexiconOf, STACK_POWER, STACK_MANA, OTHERS_POWER, maxSentenceWords, preparedCap, masteredTier, splitWordId, parseSentence, composeArcane, checkSentence, rollLexicon, learnWord, castValue, randomSentence, buildGrimoire };
if (typeof module !== 'undefined') module.exports = SpellcraftAPI;
if (typeof window !== 'undefined') window.Spellcraft = SpellcraftAPI;
})();
