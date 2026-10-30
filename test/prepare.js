// Missions.prepare on characters who qualify for each base class, and Spellcraft.randomSentence on a
// lexicon with no usable word. `node test/prepare.js`; exit code 1 on any failure.
//
// A class teaches words by rank (classes.js wordsOf), and a word has a minimum arcana level
// (spellcraft.js WORDS). A character not born to arcana can therefore hold a lexicon in which every
// word is above its own arcana level. randomSentence used to pick from the empty usable list and
// read WORDS[undefined]; Missions.prepare, and so Sortie.launch, threw.
//
// The characters are made eligible by raising the stats and aptitudes the class asks for
// (classes.js eligible), then assigned without `force`. Four variants per class cover the arcana
// aptitude as rolled and at its floor, and the class at rank 0 and at its top rank.

const path = require('path');
const root = path.join(__dirname, '..');
const load = (f) => require(path.join(root, f + '.js'));
const Stats = load('stats'), Prof = load('proficiency'), Temper = load('temper'), AI = load('ai'),
  Classes = load('classes'), Missions = load('missions'), Gifts = load('gifts'), Sp = load('spellcraft'),
  Psionic = load('psionic'), Affinity = load('affinity');

const RACES = ['human', 'draconic', 'therian'];
const PER_CELL = 200;
const ZONE = { id: 'prepare-test', name: 'prepare test', icon: 'x', level: 3, encounters: [['forest_rat', 'goblin']] };

let failed = 0;
const check = (cond, msg) => { if (!cond) { failed++; console.log('FAIL ' + msg); } };

// ---------- randomSentence on a lexicon with nothing usable ----------
const attempt = (label, fn) => { try { fn(); } catch (e) { failed++; console.log(`FAIL ${label}: threw ${e.message}`); } };
for (const structured of [true, false]) {
  attempt(`randomSentence structured=${structured}`, () => {
    const say = (lexicon, level) => Sp.randomSentence(lexicon, level, structured);
    check(say([], 5).length === 0, 'empty lexicon: expected []');
    // iron needs arcana 11, ward needs 5, mend needs 7
    check(say(['iron', 'ward', 'mend'], 0).length === 0, 'lexicon above level 0: expected []');
    check(say(['iron', 'ward', 'mend'], 4).length === 0, 'lexicon above level 4: expected []');
    check(say(['iron', 'ward', 'mend'], 5).length > 0, 'ward is usable at level 5: expected a sentence');
  });
}
attempt('checkSentence', () => check(!Sp.checkSentence([], 0, []).ok, 'checkSentence([]) must reject an empty sentence'));
attempt('buildGrimoire', () => {
  const dim = { id: 1, name: 'Dim', race: 'human', stats: Stats.rollCharacterStats('human', Math.random, 2), equipment: {}, mind: { traits: [] },
    temper: Temper.roll(), gifts: ['blade'], xp: {}, potions: [], lexicon: [], techniques: {}, psiOrder: Psionic.rollAxisOrder(), affinity: Affinity.roll() };
  dim.profs = Prof.rollAll(2, 'human'); dim.profs.arcana = { stage: 0, level: 1 };
  Classes.assign(dim, 'cleric', { force: true });
  const g = Sp.buildGrimoire(dim, 0, null, 'efficiency');
  check(Array.isArray(g.spells) && g.spells.length === 0, 'buildGrimoire with no usable word: expected an empty grimoire');
});

// ---------- Missions.prepare for every base class at every star count ----------
function rawCharacter(i, stars) {
  const race = RACES[i % RACES.length];
  const c = { id: i, name: 'C' + i, race, stats: Stats.rollCharacterStats(race, Math.random, stars), equipment: {}, mind: { traits: AI.rollMindTraits() },
    temper: Temper.roll(), xp: {}, potions: [], injured: 0, mission: null, techniques: {}, lexicon: [] };
  c.profs = Prof.rollAll(stars, race);
  c.affinity = Affinity.roll(); c.psiOrder = Psionic.rollAxisOrder();
  c.gifts = Gifts.roll(c.stats, race);
  Gifts.ensure(c, null);
  if (Gifts.has(c, 'arcana')) c.lexicon = Sp.rollLexicon(stars);
  return c;
}

/** Raise whatever the class asks for until Classes.eligible says yes. */
function qualify(c, id) {
  const req = Classes.CLASSES[id].req || {};
  for (const [k, v] of Object.entries(req.stats || {})) c.stats.base[k] = Math.max(c.stats.base[k], v);
  const raise = (k, name) => {
    const want = Prof.STAGE[name];
    if (!c.profs[k] || c.profs[k].stage < want) c.profs[k] = { stage: want, level: 1 };
  };
  for (const [k, name] of Object.entries(req.profs || {})) raise(k, name);
  // the first alternative, so a Cleric qualifies through light armour and keeps whatever arcana it rolled
  const first = Object.entries(req.oneOf || {})[0];
  if (first) raise(first[0], first[1]);
}

const results = {};
let emptyLexicon = 0, prepared = 0;
for (let stars = 1; stars <= 5; stars++) {
  for (const base of Classes.BASES) {
    const cell = results[`${stars}:${base.id}`] = { n: 0, threw: 0, notEligible: 0 };
    // a birthright class is never taught: it is admitted as born, which skips the stat and aptitude entry terms
    const how = base.summonOnly ? { born: true } : {};
    for (let i = 0; i < PER_CELL; i++) {
      const c = rawCharacter(i + 1, stars);
      qualify(c, base.id);
      if (!Classes.eligible(c, base.id, how).ok) { cell.notEligible++; continue; }
      const a = Classes.assign(c, base.id, how);
      if (!a.ok) { cell.notEligible++; continue; }
      // variants: arcana as rolled / at its floor, class at rank 0 / at its top rank
      if (i % 2) c.profs.arcana = { stage: 0, level: 1 };
      if (Math.floor(i / 2) % 2) c.class.xp = 1e9;
      cell.n++;
      try {
        const l = Missions.prepare(c, ZONE);
        prepared++;
        const level = Missions.aptLevel(c, 'arcana');
        const usable = Sp.lexiconOf(c).filter(id => Sp.WORDS[id].minLevel <= level);
        if (Sp.lexiconOf(c).length && !usable.length) {
          emptyLexicon++;
          check(l.spells.length === 0, `${base.id} with no usable word: expected no spells, got ${l.spells.length}`);
          check(Array.isArray(l.rotation), `${base.id} with no usable word: expected a martial rotation list`);
        }
      } catch (e) {
        cell.threw++;
        if (cell.threw === 1) console.log(`THROW ${stars}* ${base.id}: ${e.message}`);
      }
    }
    check(cell.notEligible === 0, `${stars}* ${base.id}: ${cell.notEligible} of ${PER_CELL} characters could not be made eligible`);
    check(cell.threw === 0, `${stars}* ${base.id}: Missions.prepare threw for ${cell.threw} of ${cell.n}`);
  }
}
// a run in which no character reached the empty case would pass without exercising the guard
check(emptyLexicon > 0, 'no character had a lexicon with nothing usable; the guard was not exercised');

const total = Object.values(results).reduce((a, r) => a + r.n, 0);
console.log(`prepared ${prepared} of ${total} characters (${emptyLexicon} with no usable word), ${Object.keys(results).length} star/class cells`);
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
