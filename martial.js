// Martial techniques: positional combat lifted from Frontier Idle. Browser: window.Martial. Node: module.exports.
//
// A technique is a node: an entry position (or 'any'), an exit position, an optional reflex
// trigger (a recent event) and a payload. The fighter holds one position; executing a technique
// moves it to the technique's exit, and a plain swing always resets it to neutral. Loops are
// emergent: B follows A only because A's exit is B's entry, and a loop is only as tight as its
// cooldowns are short next to the swing interval, because a plain swing breaks it.
//
// Unlike the source game, a character carries a LOADOUT of up to MAX_LOADOUT techniques, chosen
// at mission launch through AI.decide (buildLoadout). A dim fighter drags everything it knows
// into the ring in whatever order; a sharp one keeps the few that chain.

(() => {
const R = (typeof Rng !== 'undefined') ? Rng : require('./rng.js');
const AIx = (typeof AI !== 'undefined') ? AI : require('./ai.js');
const GF = () => (typeof Gifts !== 'undefined') ? Gifts : (typeof require !== 'undefined' ? require('./gifts.js') : null);
const St = (typeof Stats !== 'undefined') ? Stats : require('./stats.js');
// Optional, and resolved on use: classes.js may not be loaded, and techniques predate it.
const CL = () => (typeof Classes !== 'undefined') ? Classes : (typeof require !== 'undefined' ? require('./classes.js') : null);

const MAX_LOADOUT = 6;
const EVENT_WINDOW = 2;

const POSITIONS = {
  neutral:     { icon: '⚖️', color: '#9aa5b1' },
  coiled:      { icon: '🌀', color: '#b58fe0' },
  extended:    { icon: '🫴', color: '#e0a855' },
  off_balance: { icon: '😵', color: '#e05555', incomingMult: 1.15 },
  guarded:     { icon: '🛡️', color: '#5b9bd5', incomingMult: 0.9 },
  wide_open:   { icon: '🤷', color: '#97f524', incomingMult: 1.2 },
};

// Families map onto affinity weapon types: sword, axe, spear, bow, dagger, staff, unarmed,
// buckler (any shield). `req` is the aptitude stage of the family (or 'unarmed') needed to know it.
const T = (id, name, icon, def) => ({ id, name, icon, ...def });
const TECHNIQUES = {};
for (const t of [
  T('gather',         'Gather',           '🧘', { family: null, req: 1, from: ['neutral'], to: 'coiled', move: { damageMult: 0.6, cooldown: 30 } }),
  T('heavy_blow',     'Heavy Blow',       '💥', { family: null, req: 2, from: ['coiled'], to: 'off_balance', move: { damageMult: 2.0, cooldown: 60, staminaCost: 0.08 }, addFromAt: { 4: ['neutral'] } }),
  T('sidestep',       'Sidestep',         '👟', { family: null, req: 3, trigger: { event: 'onHit', window: 20 }, from: 'any', to: 'guarded', move: { buff: { mods: [{ stat: 'dodge', op: 'add', value: 0.4 }], duration: 30 }, cooldown: 120 } }),
  T('riposte',        'Riposte',          '↩️', { family: null, req: 4, trigger: { event: 'onDodge', window: 20 }, from: 'any', to: 'extended', move: { damageMult: 1.4, cooldown: 40 } }),
  T('thrust',         'Thrust',           '🗡️', { family: 'sword', req: 2, from: ['extended'], to: 'neutral', move: { damageMult: 1.5, penetration: 0.15, cooldown: 30 } }),
  T('crosscut',       'Crosscut',         '✖️', { family: 'sword', req: 4, trigger: { event: 'onCrit', window: 20 }, from: ['neutral', 'extended'], to: 'extended', move: { damageMult: 1.3, splash: 0.3, cooldown: 50 } }),
  T('iai_draw',       'Iai Draw',         '🌙', { family: 'sword', req: 6, trigger: { event: 'onEncounterStart', window: 40 }, from: ['neutral'], to: 'extended', move: { damageMult: 1.9, penetration: 0.1, cooldown: 300 } }),
  T('deflecting_moon','Deflecting Moon',  '🌘', { family: 'sword', req: 7, trigger: { event: 'onParry', window: 20 }, from: 'any', to: 'coiled', move: { buff: { mods: [{ stat: 'crit', op: 'add', value: 0.2 }], duration: 30 }, cooldown: 100 } }),
  T('finishing_cut',  'Finishing Cut',    '⚔️', { family: 'sword', req: 9, trigger: { cond: { enemyHpPct: 25 } }, from: ['coiled', 'extended'], to: 'neutral', move: { damageMult: 2.2, cooldown: 80, staminaCost: 0.06 } }),
  T('slip_jab',       'Slip Jab',         '🥊', { family: 'unarmed', req: 3, trigger: { event: 'onDodge', window: 20 }, from: 'any', to: 'neutral', move: { damageMult: 1.15, cooldown: 20 } }),
  T('whirl_kick',     'Whirl Kick',       '🌪️', { family: 'unarmed', req: 5, from: ['coiled'], to: 'extended', move: { damageMult: 1.4, splash: 0.35, cooldown: 50, staminaCost: 0.05 } }),
  T('clinch_knee',    'Clinch Knee',      '🦵', { family: 'unarmed', req: 7, trigger: { event: 'onHit', window: 20 }, from: 'any', to: 'guarded', move: { damageMult: 1.5, inflicts: [{ id: 'dazed', intensity: 1, chance: 0.35 }], cooldown: 90, staminaCost: 0.05 } }),
  T('ginga',          'Ginga',            '💃', { family: 'unarmed', req: 4, from: ['off_balance'], to: 'coiled', move: { damageMult: 0.8, cooldown: 20 } }),
  T('meia_lua',       'Meia Lua',         '🌗', { family: 'unarmed', req: 6, from: ['off_balance'], to: 'neutral', move: { damageMult: 1.35, splash: 0.4, cooldown: 50, staminaCost: 0.05 } }),
  T('german_suplex',  'German Suplex',    '🤼', { family: 'unarmed', req: 9, from: ['wide_open'], to: 'off_balance', move: { damageMult: 2.0, cooldown: 120, damageType: 'bludgeoning' } }),
  T('taunt',          'Taunt',            '🗯️', { family: null, req: 5, from: 'any', to: 'wide_open', move: { damageMult: 0.25, cooldown: 100, inflicts: [{ id: 'taunted', intensity: 1, chance: 0.8 }] } }),
  T('flowing_shield', 'Flowing Shield',   '🌊', { family: 'buckler', req: 4, trigger: { event: 'onParry', window: 20 }, from: ['guarded'], to: 'coiled', move: { damageMult: 1.0, preventedMult: 1.2, cooldown: 70, staminaCost: 0.04 }, addFromAt: { 2: ['neutral'] } }),
  T('electric_cross', 'Electric Cross',   '⚡', { family: 'unarmed', req: 8, trigger: { event: 'onHit' }, from: ['guarded'], to: 'extended', move: { counter: { reduce: 0.4, pool: 'mana', cost: 0.06 }, damageMult: 1.0, preventedMult: 1.0, cooldown: 80, damageType: 'lightning' }, addFromAt: { 2: ['neutral'] } }),
  // Families the source game does not cover; same bands.
  T('lunge',          'Lunge',            '🔱', { family: 'spear', req: 2, from: ['neutral', 'coiled'], to: 'extended', move: { damageMult: 1.4, penetration: 0.2, cooldown: 30 } }),
  T('sweep_spear',    'Sweeping Haft',    '🥢', { family: 'spear', req: 5, from: ['extended'], to: 'neutral', move: { damageMult: 1.1, splash: 0.45, cooldown: 50, inflicts: [{ id: 'buffeted', intensity: 1, chance: 0.4 }] } }),
  T('cleave',         'Cleave',           '🪓', { family: 'axe', req: 2, from: ['coiled'], to: 'neutral', move: { damageMult: 1.6, splash: 0.4, cooldown: 50, staminaCost: 0.05, inflicts: [{ id: 'bleeding', intensity: 1, chance: 0.3 }] } }),
  T('hook',           'Hook',             '🪝', { family: 'axe', req: 5, from: ['neutral'], to: 'coiled', move: { damageMult: 0.9, cooldown: 30, inflicts: [{ id: 'buffeted', intensity: 1, chance: 0.5 }] } }),
  T('backstab',       'Backstab',         '🔪', { family: 'dagger', req: 3, trigger: { event: 'onDodge', window: 20 }, from: 'any', to: 'extended', move: { damageMult: 1.8, penetration: 0.25, cooldown: 60 } }),
  T('flurry_stab',    'Flurry',           '🗡️', { family: 'dagger', req: 5, from: ['extended'], to: 'neutral', move: { damageMult: 0.55, hits: 3, cooldown: 40, inflicts: [{ id: 'bleeding', intensity: 0.6, chance: 0.5 }] } }),
  T('aimed_shot',     'Aimed Shot',       '🎯', { family: 'bow', req: 2, from: ['neutral'], to: 'coiled', move: { damageMult: 1.3, penetration: 0.3, cooldown: 40 } }),
  T('volley',         'Volley',           '🏹', { family: 'bow', req: 5, from: ['coiled'], to: 'neutral', move: { damageMult: 0.7, hits: 2, splash: 0.5, cooldown: 60, staminaCost: 0.04 } }),
  T('staff_sweep',    'Staff Sweep',      '🪄', { family: 'staff', req: 2, from: ['neutral'], to: 'coiled', move: { damageMult: 0.9, splash: 0.3, cooldown: 30, inflicts: [{ id: 'concussed', intensity: 0.6, chance: 0.3 }] } }),
  T('crown_strike',   'Crown Strike',     '👑', { family: 'staff', req: 5, from: ['coiled'], to: 'neutral', move: { damageMult: 1.7, cooldown: 60, staminaCost: 0.05, inflicts: [{ id: 'concussed', intensity: 1, chance: 0.4 }] } }),
]) TECHNIQUES[t.id] = t;

const MASTERY_LADDER = [10, 100, 1000, 10000];
const MASTERY_NAMES = ['Practiced', 'Drilled', 'Honed', 'Perfected'];
const MASTERY_POWER = [1.05, 1.12, 1.20, 1.30];
const MASTERY_COOLDOWN = [1, 0.92, 0.85, 0.75];

function masteryTier(ledger, id) {
  const reps = (ledger && ledger[id] && ledger[id].executions) || 0;
  return MASTERY_LADDER.filter(t => t <= reps).length;
}

/** The move after mastery. */
function resolvedMove(ledger, def) {
  const tier = masteryTier(ledger, def.id);
  if (tier === 0) return def.move;
  const move = { ...def.move };
  if (move.damageMult !== undefined) move.damageMult *= MASTERY_POWER[tier - 1];
  if (move.preventedMult !== undefined) move.preventedMult *= MASTERY_POWER[tier - 1];
  move.cooldown = Math.max(10, Math.round(move.cooldown * MASTERY_COOLDOWN[tier - 1]));
  return move;
}

function entries(ledger, def) {
  const tier = masteryTier(ledger, def.id);
  const at = def.from === 'any' ? 'any' : def.from.slice();
  if (at !== 'any' && def.addFromAt) for (const [t, adds] of Object.entries(def.addFromAt)) if (tier >= Number(t)) for (const a of adds) if (!at.includes(a)) at.push(a);
  return at;
}
function admits(ledger, def, position) { const at = entries(ledger, def); return at === 'any' || at.includes(position); }

/**
 * Which techniques a character knows: family must match the weapon (or shield) it holds, and the
 * matching aptitude stage must reach `req`. Universal techniques key off the best weapon aptitude.
 *
 * A CLASS waives the aptitude gate for the techniques it teaches — that is what being taught
 * means — but never the weapon in the hand: an Assassin taught Finishing Cut still needs a sword
 * to do it with.
 */
function familyOf(c) {
  const w = c.equipment && c.equipment.weapon;
  return w ? w.type : 'unarmed';
}
function known(c) {
  const fam = familyOf(c);
  const shield = c.equipment && c.equipment.offhand;
  const stage = (k) => ((c.profs && c.profs[k]) ? c.profs[k].stage : -1);        // no table or no entry: no aptitude
  const best = Math.max(stage(fam), stage('unarmed'));
  const cl = CL();
  const taught = cl ? cl.techniquesOf(c) : [];
  const g = GF();
  // Born to the blade: aptitude opens techniques. Otherwise only a class does (gifts.js).
  const born = !g || g.has(c, 'blade');
  return Object.values(TECHNIQUES).filter(t => {
    const gift = taught.includes(t.id);
    if (t.family === null) return gift || (born && best >= t.req);
    if (t.family === 'buckler') return !!shield && (gift || (born && stage('shield') >= t.req));
    if (t.family === fam) return gift || (born && stage(fam) >= t.req);
    if (t.family === 'unarmed' && fam === 'unarmed') return gift || (born && stage('unarmed') >= t.req);
    return false;
  });
}

// ---------- loadout evaluation ----------
/**
 * Dry-run a rotation for `swings` swings against the character's own odds of the events its
 * reflexes wait on. Returns average damageMult per swing, technique uptime, stamina drawn,
 * rider count, and how front-loaded the damage is.
 */
function simulateRotation(rotation, ledger, odds, swings = 16, interval = 17) {
  let position = 'neutral', total = 0, early = 0, stamina = 0, riders = 0, used = 0;
  const cd = {};
  const events = { onEncounterStart: 0 };
  for (let s = 0; s < swings; s++) {
    const tick = s * interval;
    // roll events that may have happened during the last interval
    if (s > 0) {
      if (R.rand() < odds.hit) events.onHit = tick;
      if (R.rand() < odds.dodge) events.onDodge = tick;
      if (R.rand() < odds.parry) events.onParry = tick;
    }
    let pick = null, move = null;
    for (const id of rotation) {
      const def = TECHNIQUES[id];
      if (!def || (cd[id] || 0) > tick) continue;
      if (def.move.counter) continue;
      const m = resolvedMove(ledger, def);
      if (def.trigger) {
        if (def.trigger.event) { const at = events[def.trigger.event]; if (at === undefined || tick - at > (def.trigger.window || EVENT_WINDOW)) continue; }
        if (def.trigger.cond && def.trigger.cond.enemyHpPct !== undefined && R.rand() > odds.lowHp) continue;
      }
      if (!admits(ledger, def, position)) continue;
      pick = def; move = m; break;
    }
    if (pick && move.damageMult === undefined) {
      // a buff fires off the bar; the swing itself is plain
      cd[pick.id] = tick + move.cooldown; position = pick.to; used++;
      total += 1; if (s < 5) early += 1;
      position = 'neutral';
      continue;
    }
    if (pick) {
      const dmg = move.damageMult * (move.hits || 1) * (1 + (move.splash || 0) * odds.flankers);
      total += dmg; if (s < 5) early += dmg;
      stamina += move.staminaCost || 0;
      riders += move.inflicts ? move.inflicts.reduce((a, i) => a + (i.chance || 1), 0) : 0;
      cd[pick.id] = tick + move.cooldown; position = pick.to; used++;
      if (R.rand() < odds.crit) events.onCrit = tick;
    } else {
      total += 1; if (s < 5) early += 1; position = 'neutral';
      if (R.rand() < odds.crit) events.onCrit = tick;
    }
  }
  return { perSwing: total / swings, early: early / Math.min(5, swings), uptime: used / swings, stamina, riders: riders / swings };
}

/** Build the loadout for a mission. profile.count feeds splash value. */
function buildLoadout(c, profile, doctrine) {
  const pool = known(c);
  if (!pool.length) return { rotation: [], doctrine };
  const ledger = c.techniques || {};
  const w = AIx.DOCTRINES[doctrine].w;
  const d = St.effective(c).derived;
  const odds = {
    hit: 0.5, dodge: Math.min(0.6, 0.05 + d.critChance * 0.5), parry: 0.15, crit: d.critChance,
    lowHp: 0.25, flankers: Math.max(0, ((profile && profile.count) || 1) - 1) * 0.6,
  };
  const t = AIx.tier(c);
  const generate = () => {
    const ids = R.shuffle(pool.map(p => p.id));
    // dim minds take everything; sharper ones try a size
    const n = t.id === 'dim' ? Math.min(MAX_LOADOUT, ids.length) : R.randInt(1, Math.min(MAX_LOADOUT, ids.length));
    return ids.slice(0, n);
  };
  const score = (rotation) => {
    let acc = { perSwing: 0, early: 0, uptime: 0, stamina: 0, riders: 0 };
    const runs = 3;
    for (let i = 0; i < runs; i++) { const r = simulateRotation(rotation, ledger, odds); for (const k of Object.keys(acc)) acc[k] += r[k] / runs; }
    const perStamina = acc.perSwing / (1 + acc.stamina * 4);
    return w.dpr * perStamina * 10 + w.burst * acc.early * 6 + w.stack * acc.riders * 12 + w.sustain * acc.uptime * 6 + acc.perSwing * 2;
  };
  const refine = (rotation) => {
    const r = rotation.slice();
    const roll = R.rand();
    if (roll < 0.4 && r.length > 1) { const i = R.randInt(0, r.length - 1), j = R.randInt(0, r.length - 1); [r[i], r[j]] = [r[j], r[i]]; }
    else if (roll < 0.7 && r.length < Math.min(MAX_LOADOUT, pool.length)) { const add = pool.map(p => p.id).filter(id => !r.includes(id)); if (add.length) r.splice(R.randInt(0, r.length), 0, R.pick(add)); }
    else if (r.length > 1) r.splice(R.randInt(0, r.length - 1), 1);
    return r;
  };
  const best = AIx.decide(c, { generate, score, refine });
  return { rotation: best || [], doctrine };
}

function describeRotation(rotation) {
  return rotation.map(id => { const t = TECHNIQUES[id]; return t ? `${t.icon} ${t.name}` : id; }).join(' → ');
}

const MartialAPI = { MAX_LOADOUT, EVENT_WINDOW, POSITIONS, TECHNIQUES, MASTERY_LADDER, MASTERY_NAMES, MASTERY_POWER, MASTERY_COOLDOWN, masteryTier, resolvedMove, entries, admits, familyOf, known, simulateRotation, buildLoadout, describeRotation };
if (typeof module !== 'undefined') module.exports = MartialAPI;
if (typeof window !== 'undefined') window.Martial = MartialAPI;
})();
