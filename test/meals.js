// Launch meals. `node test/meals.js`; exit code 1 on any failure. VERBOSE=1 prints every passing check as well.
//
// Each squad member takes one meal from the pantry when a run launches, best quality first. The meal adds
// stat points in that member's fights until the run ends (economy.js mealInfo, condition.js feed,
// stats.js withPoints, combat.js fromCharacter) and changes no figure in town.
//
// Part A loads the modules in Node:
//   points      mealInfo of every recipe at every quality craftItem makes: one total per quality shared equally over
//               the recipe's stats, each stat under MEAL_CAP, MEAL_CAP and every total under a weapon of the same quality
//   withPoints  adds to base, derives again, and leaves effective() and its cache alone
//   plan, feed  best quality first, the later recipe on a tie, one each in party order, pantry counts, the line printed
//               at launch, a member the pantry cannot feed loses a stale c.meal, unfeed and returnMeal restore the pantry
//   fighter     Combat.fromCharacter reads c.meal; Stats.effective, Condition, Prowess and the work readers do not
//   gate        Missions.launch feeds and logs, every fight is built from c.meal, finish deletes it, a failed launch takes nothing,
//               an empty pantry leaves the run log as it was
// Part B boots game.html through test/game.boot.js and plays real contracts through Sortie:
//   launch      pantry, c.meal, the launch log line, fighters built with the points, the town readers unchanged;
//               with an empty pantry no c.meal and no log line
//   run end     settle deletes c.meal; a call-off before contact returns the meals, one after contact does not
//   failure     a launch that throws after the meals were taken gives them back
//   save        persist and resume keep c.meal and rebuild the same fighters; a c.meal with no run behind it is dropped on load
//   screens     the party picker line, the inventory label and the sheet's reading (Condition.mealOf)

'use strict';
const path = require('path');
const root = path.join(__dirname, '..');
const { boot, mulberry } = require('./game.boot.js');

global.window = global;
for (const m of ['rng', 'mercy', 'roster', 'stats', 'proficiency', 'economy', 'affinity', 'classes', 'condition', 'temper', 'bonds', 'crew',
  'ai', 'gifts', 'elements', 'spellcraft', 'psionic', 'martial', 'prowess', 'consume', 'combat', 'bestiary', 'missions', 'sacrifice']) require(path.join(root, m + '.js'));

let failed = 0, checks = 0;
const check = (cond, msg) => { checks++; if (!cond) { failed++; console.log('FAIL ' + msg); } else if (process.env.VERBOSE) console.log('ok   ' + msg); };
const scenario = (name, fn) => {
  try { fn(); } catch (e) { failed++; console.log(`FAIL ${name}: threw ${e && e.stack}`); }
};
const ascenario = async (name, fn) => {
  try { await fn(); } catch (e) { failed++; console.log(`FAIL ${name}: threw ${e && e.stack}`); }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
/** A pantry as a comparable value: entries sorted by key, so a restored entry does not fail on insertion order. */
const pantryOf = (inv) => JSON.stringify(Object.entries(inv || {}).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
const mealCount = (inv) => Object.values(inv || {}).filter(i => i.kind === 'meal').reduce((n, i) => n + i.count, 0);

// ---------- Part A: modules in Node ----------

// every meal craftItem can make, by inventory key, from the kitchen's best tier and an aptitude that allows Legendary
const MADE = new Map();
{
  const rand = mulberry(5);
  for (let i = 0; i < 20000; i++) { const it = Econ.craftItem('meal', 4, { stage: 22 }, rand); MADE.set(Econ.itemId(it), it); }
}
/** A pantry entry of a made meal: made('stew', 4, 2) is two Masterwork stews. */
const made = (key, quality, count = 1) => { const it = MADE.get(`meal:${key}:${quality}`); if (!it) throw new Error(`craftItem never made meal:${key}:${quality}`); return [Econ.itemId(it), { ...it, count }]; };
const pantry = (...rows) => Object.fromEntries(rows);

const RACES = ['human', 'draconic', 'therian'];
function makeChar(id, { stars = 3, cls = 'fighter' } = {}) {
  const race = RACES[id % RACES.length];
  const c = { id, name: 'C' + id, race, stats: Stats.rollCharacterStats(race, Math.random, stars), equipment: {}, mind: { traits: [] },
    temper: Temper.roll(), xp: {}, potions: [], injured: 0, mission: null, job: null, progress: 0, techniques: {}, lexicon: [], facets: [], facetState: {} };
  c.profs = Prof.rollAll(stars, race);
  c.affinity = Affinity.roll(); c.psiOrder = Psionic.rollAxisOrder();
  c.gifts = Gifts.roll(c.stats, race); Gifts.ensure(c, null);
  if (Gifts.has(c, 'arcana')) c.lexicon = Spellcraft.rollLexicon(stars);
  Classes.assign(c, cls, { force: true });
  Condition.ensure(c);
  return c;
}
function makeTown(chars, inventory = {}) {
  return { gems: 1000, crops: 0, ore: 100, herbs: 0, characters: chars, inventory, log: [], mercy: {}, bonds: {},
    missions: { active: [], done: {}, history: [] }, nextId: 1, field: { board: [], rolledAt: 0 }, teams: [], trials: {} };
}
const zone = { id: 'meals-test', name: 'Meals Test', icon: '', level: 1, encounters: [['forest_rat']] };
const fighterOf = (c) => Combat.fromCharacter(c, Missions.prepare(c, zone), {});

scenario('points', () => {
  check(MADE.size === Econ.MEALS.length * Econ.QUALITY.length, `setup: craftItem made ${MADE.size} of ${Econ.MEALS.length * Econ.QUALITY.length} recipe and quality pairs`);
  const totals = {};
  let top = 0, topTotal = 0;
  for (const [id, it] of MADE) {
    const info = Econ.mealInfo(it), recipe = Econ.MEALS.find(m => m.key === it.key);
    const stats = Object.keys(info.points), vals = Object.values(info.points);
    check(same(stats, recipe.buffs), `${id}: points sit on the recipe's stats (${stats})`);
    check(vals.every(v => near(v, vals[0])), `${id}: the points are equal on every stat`);
    check(info.amount === Math.max(...Object.values(it.buffs)), `${id}: amount is the authored per-stat value (${info.amount})`);
    check(near(vals[0], Math.min(Econ.MEAL_CAP, Econ.MEAL_K * info.amount / stats.length)), `${id}: ${vals[0]} = MEAL_K x ${info.amount} / ${stats.length}, held to MEAL_CAP`);
    check(vals.every(v => v <= Econ.MEAL_CAP + 1e-9), `${id}: no stat is over MEAL_CAP`);
    const total = vals.reduce((a, v) => a + v, 0);
    (totals[it.quality] = totals[it.quality] || []).push(total);
    top = Math.max(top, vals[0]); topTotal = Math.max(topTotal, total);
    check(total < Econ.equipBonusAt(it.quality), `${id}: the meal's total ${total.toFixed(2)} is under a weapon of the same quality (+${Econ.equipBonusAt(it.quality)})`);
    check(Econ.mealText(info.points).split(' ').length === stats.length * 2 && /^\+\d/.test(Econ.mealText(info.points)), `${id}: mealText prints one "+n STAT" per stat (${Econ.mealText(info.points)})`);
  }
  for (const [q, list] of Object.entries(totals)) check(list.every(t => near(t, list[0])), `quality ${q}: every recipe has the same total (${list.map(t => t.toFixed(3))})`);
  // the Masterwork weapon in the same data: the cap and the largest meal are under its bonus
  const rand = mulberry(8);
  let sword = null;
  for (let i = 0; i < 2000 && !sword; i++) { const it = Econ.craftItem('equipment', 4, { stage: 22 }, rand); if (Econ.QUALITY[it.quality].name === 'Masterwork') sword = it; }
  check(!!sword, 'setup: craftItem made a Masterwork weapon');
  const bonus = sword ? Object.values(sword.bonus)[0] : 0;
  check(bonus === Econ.equipBonusAt(4), `a Masterwork piece carries +${bonus}, which is what equipBonusAt(4) gives the cap`);
  check(Econ.MEAL_CAP < bonus, `MEAL_CAP ${Econ.MEAL_CAP} is under a Masterwork weapon's +${bonus}`);
  check(topTotal < bonus && top <= Econ.MEAL_CAP, `the largest meal (${topTotal.toFixed(2)} in total, ${top.toFixed(2)} on one stat) is under +${bonus}`);
  // the cap holds if the amounts or MEAL_K are raised later
  const huge = Econ.mealInfo({ key: 'stew', name: 'Huge Stew', quality: 5, buffs: { con: 99, str: 99 } });
  check(huge.points.con === Econ.MEAL_CAP && huge.points.str === Econ.MEAL_CAP, `an amount of 99 is held to MEAL_CAP (${huge.points.con})`);
  check(/held to/.test(Econ.mealWhy(huge)), `mealWhy says when the cap was applied (${Econ.mealWhy(huge)})`);
  const plain = Econ.mealInfo(MADE.get('meal:stew:2'));
  check(Econ.mealWhy(plain) === 'Fine quality: 2 x 0.35 = 0.7, shared over 2 stats', `mealWhy gives the arithmetic (${Econ.mealWhy(plain)})`);
  check(same(Econ.mealInfo({ key: 'x', name: 'x', quality: 0 }).points, {}), 'an item with no buffs gives no points');
  // better means higher quality, then the later recipe
  const order = [...MADE.values()].sort(Econ.betterMeal);
  check(order[0].quality === 5 && order[0].key === 'banquet' && order[order.length - 1].quality === 0 && order[order.length - 1].key === 'porridge', `betterMeal sorts Legendary banquet first and Crude porridge last (${order[0].name}, ${order[order.length - 1].name})`);
  check(order.every((it, i) => i === 0 || it.quality < order[i - 1].quality || (it.quality === order[i - 1].quality && Econ.MEALS.findIndex(m => m.key === it.key) < Econ.MEALS.findIndex(m => m.key === order[i - 1].key))), 'betterMeal is a strict order: quality falls, and on a tie the recipe falls');
});

scenario('withPoints', () => {
  const c = makeChar(1);
  const eff = Stats.effective(c), snap = JSON.stringify(eff), baseSnap = JSON.stringify(c.stats.base);
  const w = Stats.withPoints(eff, { con: 1.4, str: 0.5, wis: -2, dex: NaN, cha: 0, foo: 9 });
  check(near(w.base.con, eff.base.con + 1.4) && near(w.base.str, eff.base.str + 0.5), 'positive points are added to the base');
  check(w.base.wis === eff.base.wis && w.base.dex === eff.base.dex && w.base.cha === eff.base.cha && w.base.int === eff.base.int, 'negative, NaN and zero points change nothing');
  check(!('foo' in w.base) && same(Object.keys(w.base), Stats.BASE_STATS), 'a key that is not a base stat is ignored');
  check(same(w.derived, Stats.deriveStats(w.base)), 'derived is deriveStats of the new base');
  check(near(w.derived.hp, eff.derived.hp + 12 * 1.4), `HP rises by 12 per CON point (${w.derived.hp} against ${eff.derived.hp})`);
  check(JSON.stringify(eff) === snap, 'the effective() result is not changed');
  check(same(Stats.withPoints(eff, undefined).base, eff.base) && same(Stats.withPoints(eff, {}).derived, eff.derived), 'no points gives the same stats');
  c.meal = Econ.mealInfo(MADE.get('meal:porridge:4'));
  check(Stats.effective(c) === eff, 'effective() returns the cached object with c.meal set: it does not read the meal');
  check(JSON.stringify(c.stats.base) === baseSnap, 'c.stats.base is not written');
});

scenario('plan and feed', () => {
  const chars = [1, 2, 3, 4, 5].map(i => makeChar(i));
  const inv = pantry(made('stew', 2, 1), made('porridge', 4, 2), made('roast', 4, 1), made('porridge', 0, 5),
    ['equipment:sword:4', { kind: 'equipment', key: 'sword', quality: 4, name: 'Masterwork Iron Sword', bonus: { str: 5 }, count: 3 }],
    ['meal:banquet:5', { ...MADE.get('meal:banquet:5'), count: 0 }]);
  const state = makeTown(chars, inv);
  const before = pantryOf(state.inventory);
  const plan = Condition.mealPlan(state, chars);
  check(pantryOf(state.inventory) === before && chars.every(c => !c.meal), 'mealPlan takes nothing and sets nothing');
  const names = plan.map(r => r.meal && `${r.meal.key}:${r.meal.quality}`);
  check(same(names, ['roast:4', 'porridge:4', 'porridge:4', 'stew:2', 'porridge:0']), `five members eat Masterwork roast, 2 Masterwork porridge, Fine stew, Crude porridge in that order (${names})`);
  check(plan.every((r, i) => r.c === chars[i]), 'rows follow party order');
  check(plan.every(r => state.inventory[r.id] && state.inventory[r.id].kind === 'meal'), 'rows name the pantry entry they draw from');

  chars[4].meal = { key: 'junk', name: 'stale', quality: 0, amount: 1, points: { str: 9 } };
  const fed = Condition.feed(state, chars);
  check(chars.every(c => c.meal && c.meal.name), 'feed sets c.meal on every member');
  check(chars.map(c => c.meal.name).join(',') === 'Masterwork Roast,Masterwork Porridge,Masterwork Porridge,Fine Stew,Crude Porridge', `each took the planned meal (${chars.map(c => c.meal.name)})`);
  check(!state.inventory['meal:roast:4'] && !state.inventory['meal:porridge:4'] && !state.inventory['meal:stew:2'], 'entries that reached 0 are deleted');
  check(state.inventory['meal:porridge:0'].count === 4, `Crude porridge is down by one (${state.inventory['meal:porridge:0'].count})`);
  check(state.inventory['equipment:sword:4'].count === 3 && state.inventory['meal:banquet:5'].count === 0, 'equipment is not eaten and an empty meal entry is skipped');
  check(fed.plan.length === 5 && fed.line.startsWith('C1 Masterwork Roast +0.47 STR +0.47 DEX +0.47 CON; C2 Masterwork Porridge +1.4 CON'), `the line says who ate what (${fed.line})`);
  check(!/no meal left/.test(fed.line), 'nobody went without');
  check(near(chars[1].meal.points.con, 1.4) && chars[1].meal.amount === 4, 'c.meal carries the points and the amount they came from');

  Condition.unfeed(state, fed);
  check(chars.every(c => !c.meal), 'unfeed deletes c.meal');
  check(pantryOf(state.inventory) === before, 'unfeed puts every meal back, the deleted entries included');
  check(Condition.returnMeal(state, chars[0]) === false, 'returnMeal with no meal does nothing');

  // fewer meals than members: the last ones go without and a stale c.meal does not carry over
  const lean = makeTown(chars, pantry(made('stew', 2, 1), made('porridge', 4, 1)));
  chars[3].meal = chars[4].meal = { key: 'junk', name: 'stale', quality: 0, amount: 1, points: { str: 9 } };
  const one = Condition.feed(lean, chars);
  check(chars[0].meal.key === 'porridge' && chars[1].meal.key === 'stew' && chars.slice(2).every(c => c.meal === undefined), 'two meals feed the first two, and the others have no c.meal even if they had a stale one');
  check(mealCount(lean.inventory) === 0, 'the pantry is empty');
  check(/; no meal left for C3, C4, C5$/.test(one.line), `the line names who went without (${one.line})`);
  Condition.unfeed(lean, one);
  check(mealCount(lean.inventory) === 2 && chars.every(c => !c.meal), 'unfeed after a short pantry returns both meals');

  // nothing to eat, and no pantry at all
  const bare = Condition.feed({ inventory: {} }, chars.slice(0, 2));
  check(bare.line === '' && bare.plan.length === 2 && chars.slice(0, 2).every(c => !c.meal), `an empty pantry gives no line and no meal (${JSON.stringify(bare.line)})`);
  check(Condition.feed({}, chars.slice(0, 2)).line === '', 'a state with no inventory does not throw');
  check(Condition.feed(lean, []).line === '' && Condition.mealPlan(null, chars.slice(0, 1))[0].meal === null, 'an empty squad and a null state are handled');

  // sheet reading
  chars[0].meal = Econ.mealInfo(MADE.get('meal:porridge:4'));
  const sheet = Condition.mealOf(chars[0]);
  check(sheet.text === 'fed: Masterwork Porridge, +1.4 CON until the mission ends', `the sheet line (${sheet.text})`);
  check(sheet.why.includes('Masterwork quality: 4 x 0.35 = 1.4'), `the sheet tooltip has the arithmetic (${sheet.why})`);
  check(Condition.mealOf(chars[1]) === null && Condition.mealOf({}) === null, 'a character with no meal has no line');
  Condition.clearMeal(chars[0]);
  check(chars[0].meal === undefined, 'clearMeal deletes c.meal');
});

scenario('fighter', () => {
  const c = makeChar(7, { cls: 'fighter' });
  const noMeal = fighterOf(c);
  const baseSnap = JSON.stringify(c.stats.base);
  const eff = JSON.stringify(Stats.effective(c)), desc = JSON.stringify(Condition.describe(c)), work = Condition.workMult(c);
  const ready = JSON.stringify(Condition.readyIn(c)), prow = JSON.stringify(Prowess.of(c));
  c.meal = Econ.mealInfo(MADE.get('meal:stew:4'));                    // +0.7 CON, +0.7 STR
  const withMeal = fighterOf(c);
  check(near(withMeal.maxHp, noMeal.maxHp + 12 * 0.7), `0.7 CON raises HP by 8.4 (${noMeal.maxHp} to ${withMeal.maxHp})`);
  check(withMeal.hp === withMeal.maxHp, 'the fighter starts at its raised HP');
  check(withMeal.base.damage > noMeal.base.damage, `0.7 STR raises damage (${noMeal.base.damage.toFixed(3)} to ${withMeal.base.damage.toFixed(3)})`);
  check(withMeal.base.critDamage > noMeal.base.critDamage && near(withMeal.base.critDamage - noMeal.base.critDamage, 0.025 * 0.7), 'crit damage follows STR by 0.025 a point');
  check(Combat.rating(withMeal).power > Combat.rating(noMeal).power && Combat.rating(withMeal).guard >= Combat.rating(noMeal).guard, 'the rating the field reads is taken after the meal');
  check(JSON.stringify(Stats.effective(c)) === eff, 'Stats.effective is the same with the meal');
  check(JSON.stringify(Condition.describe(c)) === desc && Condition.workMult(c) === work && JSON.stringify(Condition.readyIn(c)) === ready, 'Condition: bars, work multiplier and ready time are the same with the meal');
  check(JSON.stringify(Prowess.of(c)) === prow, 'Prowess (the sheet radar) is the same with the meal');
  check(JSON.stringify(c.stats.base) === baseSnap, 'c.stats.base is not written');
  delete c.meal;
  const again = fighterOf(c);
  check(again.maxHp === noMeal.maxHp && again.base.damage === noMeal.base.damage, 'with c.meal deleted the fighter is the one built without a meal');
  // a meal with no points, or points the base does not know, changes nothing
  c.meal = { key: 'x', name: 'x', quality: 0, amount: 0, points: {} };
  check(fighterOf(c).maxHp === noMeal.maxHp, 'an empty meal changes nothing');
  c.meal = { key: 'x', name: 'x', quality: 0, amount: 1 };
  check(fighterOf(c).maxHp === noMeal.maxHp, 'a meal record without points does not throw');
});

scenario('gate', () => {
  const chars = [11, 12, 13, 14].map((i, k) => makeChar(i, { cls: ['fighter', 'cleric', 'ranger', 'rogue'][k] }));
  const state = makeTown(chars, pantry(made('porridge', 4, 1), made('stew', 2, 2)));
  const real = Combat.fromCharacter;
  const seen = [];
  Combat.fromCharacter = function (c) { seen.push([c.id, c.meal ? `${c.meal.key}:${c.meal.quality}` : null]); return real.apply(this, arguments); };
  try {
    Rng.withSource(mulberry(3), () => {
      const run = Missions.launch(state, 'forest_edge', chars.map(c => c.id));
      check(typeof run === 'object', `Gate launch returns a run (${typeof run === 'string' ? run : 'ok'})`);
      if (typeof run !== 'object') return;
      check(chars.map(c => (c.meal ? `${c.meal.key}:${c.meal.quality}` : null)).join(',') === 'porridge:4,stew:2,stew:2,', `three eat and the fourth does not (${chars.map(c => c.meal && c.meal.key)})`);
      check(mealCount(state.inventory) === 0, 'the pantry is empty');
      const line = run.log.find(l => l.startsWith('\u{1F372}'));
      check(!!line && line.includes('C11 Masterwork Porridge +1.4 CON') && line.includes('no meal left for C14'), `the run log says who ate what (${line})`);
      let done = null;
      for (let i = 0; i < 100 && !done; i++) done = Missions.tick(state).find(r => r === run) || null;
      check(!!done, 'the Gate run finishes');
      check(seen.length > 0, `setup: fighters were built during the run (${seen.length})`);
      for (const [id, meal] of seen) {
        const want = { 11: 'porridge:4', 12: 'stew:2', 13: 'stew:2', 14: null }[id];
        if (want !== undefined) check(meal === want, `a fight built for C${id} used its meal (${meal})`);
      }
      check(chars.every(c => c.meal === undefined && c.mission === null), 'when the run ends every c.meal is deleted and c.mission cleared');
    });
  } finally { Combat.fromCharacter = real; }

  // a launch that cannot prepare somebody takes nothing from the pantry
  const chars2 = [21, 22, 23].map(i => makeChar(i));
  const state2 = makeTown(chars2, pantry(made('porridge', 4, 2)));
  const before = pantryOf(state2.inventory);
  const sig = AI.signature;
  AI.signature = (c) => { if (c.id === 23) throw new Error('boom'); return sig(c); };
  let r;
  try { r = Missions.launch(state2, 'forest_edge', chars2.map(c => c.id)); } finally { AI.signature = sig; }
  check(typeof r === 'string' && /cannot be prepared/.test(r), `the launch fails (${r})`);
  check(pantryOf(state2.inventory) === before && chars2.every(c => c.meal === undefined && !c.mission), 'and the pantry and the characters are as they were');

  // an empty pantry changes nothing about the run record: one log line per member, no meal line
  const chars3 = [31, 32].map(i => makeChar(i));
  const run3 = Missions.launch(makeTown(chars3), 'forest_edge', chars3.map(c => c.id));
  check(typeof run3 === 'object' && run3.log.length === 2 && chars3.every(c => c.meal === undefined), 'with an empty pantry the Gate log has one line per member and nobody has a c.meal');
});

// ---------- Part B: the booted page ----------

const texts = (e, out = []) => { if (!e) return out; if (e._html) out.push(e._html); if (e._text) out.push(e._text); (e._kids || []).forEach(k => texts(k, out)); return out; };
const findAll = (e, pred, out = []) => { if (!e) return out; if (pred(e)) out.push(e); (e._kids || []).forEach(k => findAll(k, pred, out)); return out; };

async function partB() {
  const { setup } = require('./sortie.harness.js');
  const lab = await setup({ poolSize: 12 });
  if (lab.bootFailed || lab.failed) { failed++; console.log('FAIL part B: ' + (lab.failed || 'the page did not boot')); if (lab.b) lab.b.dispose(); return; }
  const { b, ctx, st, S } = lab;
  const MT = ctx.MissionTypes;
  const contract = (type, level, seed = 1) => {
    const roll = MT.roll;
    MT.roll = (t, o) => roll.call(MT, type, Object.assign({}, o, { level }));
    try { return b.withSeed(seed, () => S.board(st, true)[0]); } finally { MT.roll = roll; }
  };
  const free = (n) => st.characters.filter(c => !c.mission && !(c.injured > 0)).slice(0, n);
  const fresh = () => { S.discard(); lab.restore(); };
  /** An extermination contract and four free characters, with the given pantry in the town. */
  const stage = (seed, rows) => {
    fresh();
    b.advance(1000);                          // the virtual clock does not move on its own, and a run's id is its start time
    st.inventory = JSON.parse(JSON.stringify(pantry(...rows)));      // a copy: launch changes the counts of the entries it is given
    const mission = contract('extermination', 3, seed);
    const chars = free(Math.min(4, mission.party[1]));
    return { mission, chars, ids: chars.map(c => c.id) };
  };
  const launch = (seed, mission, ids) => b.withSeed(seed, () => S.launch(mission, ids));
  const squad = (run) => run.field.actors.filter(a => a.role === 'squad' && a.char);
  const hpOf = (Sx, c, points) => (points ? Sx.withPoints(Sx.effective(c), points) : Sx.effective(c)).derived.hp;

  await ascenario('launch', async () => {
    const { mission, chars, ids } = stage(31, [made('stew', 4, 1), made('porridge', 2, 2)]);
    check(chars.length === 4, `setup: a squad of four (${chars.length})`);
    const eff0 = chars.map(c => JSON.stringify(ctx.Stats.effective(c)));
    const cond0 = chars.map(c => JSON.stringify(ctx.Condition.describe(c)));
    const run = launch(31, mission, ids);
    check(typeof run === 'object', `launch returns a run (${typeof run === 'string' ? run : 'ok'})`);
    if (typeof run !== 'object') return;
    const keys = chars.map(c => (c.meal ? `${c.meal.key}:${c.meal.quality}` : null));
    check(same(keys, ['stew:4', 'porridge:2', 'porridge:2', null]), `the first eats the Masterwork stew, then two Fine porridges, the fourth nothing (${keys})`);
    check(mealCount(st.inventory) === 0, 'the pantry is empty');
    const log = run.field.log.map(l => l.text);
    const line = log.find(t => t.startsWith('\u{1F372}'));
    check(!!line && chars.slice(0, 3).every(c => line.includes(c.name)) && line.includes('Masterwork Stew +0.7 CON +0.7 STR') && line.includes(`no meal left for ${chars[3].name}`), `the launch log lists who ate what (${line})`);
    check(log.indexOf(line) > 0, 'it is in the sortie log, after the party reading');
    for (const a of squad(run)) {
      const c = a.char;
      check(near(a.fighter.maxHp, hpOf(ctx.Stats, c, c.meal && c.meal.points)), `${c.name}: the fighter was built with the meal's points (HP ${a.fighter.maxHp.toFixed(1)})`);
    }
    check(near(squad(run)[0].fighter.maxHp, hpOf(ctx.Stats, chars[0]) + 12 * 0.7), 'the stew adds 0.7 CON, which is 8.4 HP');
    check(chars.every((c, i) => JSON.stringify(ctx.Stats.effective(c)) === eff0[i] && JSON.stringify(ctx.Condition.describe(c)) === cond0[i]), 'Stats.effective and the condition bars are the same as before the meal');
    check(squad(run).every(a => near(a.speed, ctx.Field.BASE_SPEED * ctx.Field.pace(ctx.Stats.effective(a.char).derived.walkSpeed))), 'the walking pace still reads the character, not the meal');
    // the end of the run
    b.withSeed(31, () => S.skip());
    check(run.field.result && st.field.history.length === 1, 'the run settled');
    check(st.characters.every(c => c.meal === undefined), 'settle() deleted c.meal on every survivor, and the dead left the roster');
    check(mealCount(st.inventory) === 0, 'nothing is given back for a run that was fought');
  });

  await ascenario('launch with an empty pantry', async () => {
    const { mission, chars, ids } = stage(37, []);
    const run = launch(37, mission, ids);
    check(typeof run === 'object', `launch returns a run (${typeof run === 'string' ? run : 'ok'})`);
    if (typeof run !== 'object') return;
    check(chars.every(c => c.meal === undefined) && !run.field.log.some(l => l.text.startsWith('🍲')), 'nobody has a c.meal and the sortie log has no meal line');
    check(squad(run).every(a => near(a.fighter.maxHp, hpOf(ctx.Stats, a.char))), 'every fighter is built from the character alone');
  });

  await ascenario('call-off', async () => {
    const rows = [made('stew', 4, 1), made('porridge', 2, 2), made('roast', 1, 3)];
    let { mission, chars, ids } = stage(32, rows);
    const before = pantryOf(st.inventory);
    b.withSeed(32, () => { S.launch(mission, ids); });
    check(chars.filter(c => c.meal).length === 4 && mealCount(st.inventory) === 2, 'setup: four ate and two meals are left');
    b.withSeed(32, () => S.abandon());
    check(chars.every(c => c.meal === undefined && c.mission === null), 'a call-off before contact deletes c.meal and frees the squad');
    check(pantryOf(st.inventory) === before, 'and returns the four meals');
    check(/4 meals returned to the pantry/.test(st.log[0].text), `the town log says so (${st.log[0].text})`);

    ({ mission, chars, ids } = stage(33, rows));
    let contact = false;
    b.withSeed(33, () => {
      const run = S.launch(mission, ids);
      for (let i = 0; i < 6000 && !run.contact && !run.field.result; i++) ctx.Field.step(run.field);
      contact = run.contact;
      S.abandon();
    });
    check(contact, 'setup: the squad reached a fight');
    check(chars.every(c => c.meal === undefined), 'a call-off after contact deletes c.meal');
    check(mealCount(st.inventory) === 2, `and returns no meal (${mealCount(st.inventory)} in the pantry: the 2 that were not eaten)`);
  });

  await ascenario('a failed launch', async () => {
    const { mission, chars, ids } = stage(34, [made('stew', 4, 2), made('porridge', 2, 3)]);
    const before = pantryOf(st.inventory);
    const realFeed = ctx.Condition.feed, realPrep = ctx.Missions.prepare;
    let fed = 0;
    ctx.Condition.feed = function () { fed++; return realFeed.apply(this, arguments); };
    ctx.Missions.prepare = (c, z) => { if (c.id === chars[2].id) throw new Error('boom'); return realPrep(c, z); };
    let r;
    try { r = launch(34, mission, ids); } finally { ctx.Condition.feed = realFeed; ctx.Missions.prepare = realPrep; }
    check(typeof r === 'string' && /cannot be prepared/.test(r), `the launch fails (${r})`);
    check(fed === 1, `setup: the meals were taken before the failure (${fed} calls to feed)`);
    check(pantryOf(st.inventory) === before, 'the pantry is as it was');
    check(chars.every(c => c.meal === undefined && !c.mission) && S.run === null, 'no c.meal, nobody flagged out, no run');
  });

  await ascenario('save and resume', async () => {
    const { mission, chars, ids } = stage(35, [made('roast', 3, 1), made('porridge', 4, 1), made('stew', 2, 2)]);
    const bystander = st.characters.find(c => !ids.includes(c.id));
    const run = launch(35, mission, ids);
    check(typeof run === 'object', `launch returns a run (${typeof run === 'string' ? run : 'ok'})`);
    if (typeof run !== 'object') return;
    bystander.meal = { key: 'junk', name: 'Stale Junk', quality: 0, amount: 1, points: { str: 9 } };
    const meals = chars.map(c => JSON.stringify(c.meal));
    const hp = squad(run).map(a => [a.char.id, a.fighter.maxHp]);
    b.fire('window', 'beforeunload');
    const b2 = await boot({ html: 'game.html', storage: new Map(b.localStorage.map) });
    try {
      check(b2.errors.length === 0, `the second page booted cleanly (${b2.errors.length} errors)`);
      const s2 = b2.Game.state, run2 = b2.Sortie && b2.Sortie.run;
      check(!!run2, 'the run came back');
      check(same(chars.map(c => JSON.stringify(s2.characters.find(x => x.id === c.id).meal)), meals), 'every squad member still has the meal they ate');
      check(s2.characters.find(c => c.id === bystander.id).meal === undefined, 'a c.meal on somebody with no run behind it is dropped on load');
      if (run2) {
        const hp2 = squad(run2).map(a => [a.char.id, a.fighter.maxHp]);
        check(same(hp2, hp), `the rebuilt fighters have the same HP, so the points are back in (${hp2.map(x => x[1].toFixed(1))})`);
        b2.withSeed(36, () => b2.Sortie.skip());
        check(s2.characters.every(c => c.meal === undefined), 'finishing the resumed run deletes c.meal');
      }
    } finally { b2.dispose(); }
    // a save from a gate run that no longer exists: c.meal and c.mission both stale
    fresh();
    const orphan = st.characters[0];
    orphan.meal = { key: 'junk', name: 'Stale Junk', quality: 0, amount: 1, points: { str: 9 } };
    orphan.mission = 999;
    ctx.Game.save();
    const b3 = await boot({ html: 'game.html', storage: new Map(b.localStorage.map) });
    try {
      const o = b3.Game.state.characters.find(c => c.id === orphan.id);
      check(o && o.mission === null && o.meal === undefined, 'a c.meal whose gate run is gone is dropped with the c.mission');
    } finally { b3.dispose(); }
  });

  await ascenario('screens', async () => {
    fresh();
    const item = MADE.get('meal:stew:4');
    st.inventory = pantry(made('stew', 4, 2), made('porridge', 0, 3));
    ctx.Game.renderAll();
    const inv = texts(b.el('#inventory')).join(' | ');
    check(inv.includes('+0.7 CON +0.7 STR for one mission') && inv.includes('+0.35 CON for one mission'), `the inventory prints points, not the authored amount (${inv.slice(0, 200)})`);
    check(inv.includes('Masterwork quality: 4 x 0.35 = 1.4, shared over 2 stats'), 'and the arithmetic is in the tooltip');
    check(!inv.includes('+4 CON'), 'the authored amount is not printed as a stat bonus');

    // the party picker: pick a contract, send two characters, read the pantry line
    S.render();
    findAll(b.el('#sortie'), e => /mcard/.test(e.className))[0].click();
    for (let i = 0; i < 2; i++) findAll(b.el('#sortie'), e => e.tagName === 'BUTTON' && e._text === 'Send')[0].click();
    const picker = texts(b.el('#sortie')).filter(t => t.includes('\u{1F372}'));
    check(picker.length === 1 && picker[0].includes('Pantry: 5 meals. Each eats one at launch, best first:') && picker[0].includes('Masterwork Stew +0.7 CON +0.7 STR'), `the picker reads the pantry and the draw (${picker[0] && picker[0].slice(0, 220)})`);
    st.inventory = {};
    S.render();
    const none = texts(b.el('#sortie')).filter(t => t.includes('\u{1F372}'));
    check(none.length === 1 && none[0].includes('Pantry: no meals. Nobody eats before setting out'), `with no meals it says so (${none[0] && none[0].slice(0, 120)})`);

    // the sheet: its data is Condition.mealOf; open a sheet for a fed character if the page lets the test click a tile
    const c = st.characters[0];
    c.meal = ctx.Econ.mealInfo(item);
    ctx.Game.renderRoster();
    const tile = findAll(b.el('#roster-panel'), e => /\btile\b/.test(e.className) && String(e.title || '').startsWith(c.name + ' '))[0];
    if (tile) {
      tile.click();
      const sheet = texts(b.el('#sheet')).join(' | ');
      check(sheet.includes('fed: Masterwork Stew, +0.7 CON +0.7 STR until the mission ends'), `the sheet's Condition section shows the meal (${sheet.length} characters of sheet)`);
    } else check(false, 'setup: the roster tile of the fed character was found');
    delete c.meal;
  });

  const late = lab.b.errors.length - lab.bootErrors;
  check(late === 0, `no uncaught exception in the page after boot (${late})`);
  lab.b.dispose();
}

(async () => {
  await partB();
  console.log(`${checks} checks, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
