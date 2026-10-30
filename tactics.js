// Tactics: when a squad stops doing the obvious thing. Browser: window.Tactics. Node: module.exports.
//
// field.js walks everyone at the same objective because that is what a squad with no other idea
// does. This is the other idea. A DETAIL is a few of them given a different job — one slipping
// ahead to a mark alone while the rest keep walking, two standing in a doorway so the others get
// past — and putting one together needs four separate things to be true at once:
//
//   A REASON      the situation has to actually call for it. Nobody splits up for fun: there is
//                 a mark they have found and a long way to walk, or something coming at them
//                 that they would lose to as they stand.
//   AN EYE        somebody has to SEE the play, and READ THE ODDS. Both are acumen (ai.js), read
//                 off the sharpest mind in the party. The odds are field.js `odds` — the fight the
//                 resolver would actually hold, on the ground it would be held on — seen through
//                 that mind with the noise ai.js puts on a loadout: a genius reads them straight,
//                 a dim squad is guessing, and a squad of dim ones walks at the objective forever.
//   A HAND        somebody has to be the right person for it. A Shadow slips ahead; a Warden
//                 stands in the doorway. Class, aptitude and temper, in that order.
//   TRUST         and the rest of them have to believe it will work, which is bonds.js. This is
//                 the term that makes the play depend on who is in the squad as well as on the
//                 odds: five strangers with a perfect assassin among them do not send her off
//                 alone, and the same five people after twenty missions together do.
//
// Trust is separate from competence. The two terms are added, so a beloved mediocrity gets sent
// and a brilliant stranger does not. This is intended: it is most of what a squad is, and it is
// why a team is worth building rather than drafting.
//
// The party's TEMPER moves the bar: a bold party splits readily, a cunning one wants better odds
// than that, and a craven one stays together whatever anybody is good at.
//
// THE PLAYS, in the order they are looked for:
//   stand    something is coming and they would lose to it here, but there is tighter ground
//            within reach where fewer of it can swing at once. Everybody goes there and waits.
//   hold     something is coming, no ground makes it a fight worth having, and the job is
//            somewhere else: the two best suited stand and meet it while the rest go on.
//   strike   a mark a long way off, alone or as good as: the one best suited slips ahead to it.
//   pounce   what is coming is too much all at once, but the nearest group of it is not, and
//            the rest are still a walk behind: everybody goes at that group now.
//   retreat  what is coming is hopeless and no ground fixes it: everybody falls back to the way
//            in. Hostiles hunt what they can see and give up a while after they lose it
//            (field.js GIVE_UP), and some of them are slower than people, so a squad that turns
//            round can be a squad that is no longer being hunted. If it is still being hunted
//            at the gate, the plan is to leave.
// A squad that would win where it stands does none of them. Splitting a squad that was going to
// win together is the worst outcome there is, and every play is gated on the odds first.

(() => {
const AI = () => (typeof window !== 'undefined' ? window.AI : null) || (typeof require !== 'undefined' ? require('./ai.js') : null);
const CL = () => (typeof Classes !== 'undefined') ? Classes : (typeof require !== 'undefined' ? require('./classes.js') : null);
const TE = () => (typeof Temper !== 'undefined') ? Temper : (typeof require !== 'undefined' ? require('./temper.js') : null);
const BO = () => (typeof Bonds !== 'undefined') ? Bonds : (typeof require !== 'undefined' ? require('./bonds.js') : null);
const P = () => (typeof Prof !== 'undefined') ? Prof : (typeof require !== 'undefined' ? require('./proficiency.js') : null);
const FI = () => (typeof Field !== 'undefined') ? Field : (typeof require !== 'undefined' ? require('./field.js') : null);
const R = () => (typeof Rng !== 'undefined') ? Rng : (typeof require !== 'undefined' ? require('./rng.js') : null);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dist = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

// ---------- who is any good at what ----------
// Class comes first because a class is a decision the player made about this character, and it
// should beat a stat line that happened. Groups, not names, so a fused Shadow still reads as one.
const FIT = {
  strike: {
    groups: { shadow: 1.0, marksman: 0.55, gifted: 0.35 },
    profs: ['dagger', 'bow', 'unarmed'],
    stats: (b) => (b.dex * 1.2 + b.int * 0.4) / 30,
    // going alone into a room full of them is a nerve question before it is a skill question
    temper: (t, c) => 0.5 * t.t(c, 'nerve') + 0.35 * t.t(c, 'guile') + 0.2 * t.t(c, 'appetite'),
  },
  anchor: {
    groups: { warrior: 1.0, faith: 0.5, primal: 0.55 },
    profs: ['shield', 'heavy_armor', 'medium_armor', 'spear'],
    stats: (b) => (b.con * 1.1 + b.str * 0.6) / 30,
    temper: (t, c) => 0.55 * t.t(c, 'grit') + 0.4 * t.t(c, 'nerve') - 0.15 * t.t(c, 'guile'),
  },
  backer: {
    groups: { marksman: 1.0, gifted: 0.7, alchemy: 0.6, faith: 0.5 },
    profs: ['bow', 'arcana', 'psionics', 'light', 'alchemy'],
    stats: (b) => (b.dex * 0.7 + b.int * 0.7 + b.wis * 0.5) / 30,
    temper: (t, c) => 0.35 * t.t(c, 'rigor') + 0.25 * t.t(c, 'grit'),
  },
};

/** How suited this character is to a role, roughly -0.4..1.6. */
function fitFor(role, c) {
  const def = FIT[role];
  if (!def || !c) return 0;
  const cl = CL(), p = P(), te = TE();
  let cls = 0;
  if (cl) for (const h of cl.held(c)) cls = Math.max(cls, def.groups[h.def.group] || 0);
  let apt = 0;
  for (const k of def.profs) if (c.profs && c.profs[k]) apt = Math.max(apt, p.share(c.profs[k]));
  const raw = def.stats(c.stats.base);
  const want = te ? def.temper(te, c) : 0;
  return cls * 0.6 + apt * 0.5 + clamp(raw, 0, 1) * 0.35 + want * 0.3;
}

// ---------- what the rest of them think of it ----------
/**
 * How far the others would follow this one, -1..+1. Half of it is what they are to each other
 * (bonds.js) and half is whether they have done anything like this before — and a party with no
 * history at all falls back on temperament, which is a guess and is treated as one.
 */
function trustIn(state, party, c) {
  const bo = BO(), te = TE();
  const others = party.filter(o => o.id !== c.id);
  if (!others.length) return 0;
  let sum = 0, runs = 0, known = 0;
  for (const o of others) {
    const p = bo ? bo.peek(state, c.id, o.id) : null;
    if (p) { sum += p.v / 100; runs = Math.max(runs, p.runs || 0); known++; }
  }
  const bond = known ? sum / others.length : 0;
  const guess = te ? (te.accord(party) - 1) / 0.18 * 0.4 : 0;   // the pre-acquaintance expectation
  const weight = known / others.length;
  const record = clamp(runs / 14, 0, 0.25);                     // a dozen missions together is a record
  return clamp(bond * weight + guess * (1 - weight) + record, -1, 1);
}

// ---------- the plays ----------
// `minTier` is the acumen tier index in ai.js: 2 is sharp, 3 brilliant. Nobody below it ever
// thinks of the play at all, however good the person for it would have been.
const PLAYS = {
  // Sending one person off alone is a bigger call than leaving two behind, and the bars say so.
  // Walking everybody to a doorway is no call at all, and anybody but a dim squad thinks of it.
  strike: { minTier: 3, minFit: 0.75, needTrust: 0.45, label: 'a quiet way in' },
  hold:   { minTier: 2, minFit: 0.55, needTrust: 0.25, label: 'a rearguard' },
  stand:  { minTier: 1, label: 'a stand' },
  pounce: { minTier: 2, label: 'the near ones first' },
  retreat: { minTier: 1, label: 'a step back' },
};
const HOPELESS = 0.35;     // odds below which the fight is not one to have at all
const BEHIND = 6;          // tiles: how far the rest have to be for the near group to be a fight on its own
const GATE = 4;            // tiles: this close to the way in with them still coming, and the plan is to leave
const GOOD = 0.6;          // odds at which a fight is one to take where they are
const EDGE = 0.05;         // how much the odds have to improve before ground is worth walking to: a narrow front
                           // favours the side with the better single fighters, so against a boss it can lose them ground
const HOLD_MIN = 0.3;      // odds below which a rearguard is not a rearguard, it is two more bodies
const NEAR = 14;           // tiles: how far off something coming at them is worth planning around
const STAND_FOR = 90;      // in-game seconds a stand is kept with nobody arriving
// what the job is when it is not the thing coming at them: orders under which the rest go on
const ELSEWHERE = new Set(['strike', 'avoid', 'delve', 'work']);
// orders under which the ground is not theirs to choose: a guard stands where the ward is, and a
// squad paid to hold a point holds that point
const ROOTED = new Set(['guard', 'hold']);

/**
 * The odds as this mind reads them. field.js `odds` is the fight the resolver would hold; the
 * tier's noise (ai.js TIERS) is how far off the reading can be, and a dim mind is guessing.
 */
function judge(mind, ours, theirs, width) {
  const F = FI(), ai = AI(), r = R();
  if (!F) return 0.5;
  const raw = F.odds(ours, theirs, width);
  const t = ai ? ai.TIERS[Math.max(0, Math.min(ai.TIERS.length - 1, mind.tier))] : null;
  if (!t || !r) return raw;
  if (t.id === 'dim') return r.rand();
  return clamp(raw * (1 + t.noise * r.jitter()), 0, 1);
}

/**
 * Odds a party is happy with where it stands. A bold party takes a worse fight than that as it
 * comes; a cunning one wants better before it stops looking for ground.
 */
function fine(party) {
  const te = TE();
  const m = te ? te.mood(party) : null;
  return m ? GOOD - 0.15 * m.nerve + 0.1 * m.guile : GOOD;
}

/** The sharpest mind in the party. A plan is only ever as good as whoever thought of it. */
function bestMind(party) {
  const ai = AI();
  if (!ai) return { tier: 0, who: null };
  let best = { tier: -1, who: null };
  for (const c of party) {
    const i = ai.tierIndex(c);
    if (i > best.tier) best = { tier: i, who: c };
  }
  return best;
}

/**
 * How much better than the bar the party needs to feel. A bold squad splits on a hunch; a cunning
 * one wants the odds; a craven one would rather everybody stayed where they can see each other.
 */
function bar(party, play) {
  const te = TE();
  const m = te ? te.mood(party) : null;
  if (!m) return play.needTrust;
  return play.needTrust - 0.3 * m.nerve + 0.25 * m.guile - 0.1 * m.appetite;
}

const alive = (s) => s.actors.filter(a => a.role === 'squad' && a.alive && !a.extracted);
const inDetail = (s, a) => (s.details || []).some(d => d.members.includes(a.id));
const seen = (s, t) => s.omniscient || !!t.found;

/**
 * A mark or a structure worth one person walking at alone: found, still standing, and far enough
 * away that arriving early actually buys something.
 */
function strikeTarget(s) {
  // a mark, never a structure: there is no quiet way to bring down a gate
  const wants = s.mission.win.filter(w => ['eliminate', 'subdue'].includes(w.atom));
  if (!wants.length) return null;
  const crew = alive(s);
  if (!crew.length) return null;
  const centre = { x: crew.reduce((t, a) => t + a.x, 0) / crew.length, y: crew.reduce((t, a) => t + a.y, 0) / crew.length };
  for (const w of wants) {
    const pool = s.actors.filter(a => a.alive && a.side === 'theirs' && a.role !== 'structure' &&
      (a.role === w.who || a.name === w.who || a.kind === w.who) && seen(s, a));
    const t = pool.find(x => dist(centre, x) > 8);
    if (t) return t;
  }
  return null;
}

const centreOf = (crew) => ({ x: crew.reduce((t, a) => t + a.x, 0) / crew.length, y: crew.reduce((t, a) => t + a.y, 0) / crew.length });

/**
 * Everything known to be coming at them: found, not already fighting, hunting (field.js hunting:
 * walking at a squad member, at another hostile it is collecting, or at the last place one was
 * seen, or just alerted by a sighting) and near enough to arrive. A hostile that has spotted the
 * squad and stands at its post is not coming, and counting it started a step back that ended when
 * the squad was out of range and started again when it was back.
 */
function closing(s) {
  const F = FI();
  const crew = alive(s);
  if (!F || !crew.length) return [];
  const centre = centreOf(crew);
  return s.actors.filter(a => a.alive && a.side === 'theirs' && a.role !== 'structure' && !a.engaged &&
    seen(s, a) && !(a.cowedUntil && a.cowedUntil > s.clock) && F.hunting(s, a) && dist(centre, a) <= NEAR);
}

/** Kept for the old meaning: two or more coming at them. */
function pressure(s) {
  const near = closing(s);
  return near.length >= 2 ? near : null;
}

/** What the squad's fight would be held on now: the ground under them (field.js frontage). */
function groundHere(s, crew) {
  const F = FI();
  return (F && F.frontage(s, crew)) || 8;
}

const ESCORT = 6;          // tiles: anything this close to a mark is in the fight the moment it opens

/** Everything hostile standing with a target, which is what a striker would actually meet. */
function escortOf(s, t) {
  return s.actors.filter(a => a !== t && a.alive && a.side === 'theirs' && a.role !== 'structure' && dist(a, t) <= ESCORT);
}

/**
 * The whole decision, once every dozen seconds. field.js hands us the run and takes back details
 * to start and details to end; everything about who these people are is read here and nowhere in
 * the field. `state` is the town, for the ledger of who trusts whom.
 */
function propose(s, state) {
  if (!s || s.withdrew || s.escalated || s.phase === 'leaving') return null;
  const F = FI();
  const crew = alive(s);
  const party = crew.map(a => a.char).filter(Boolean);
  if (!party.length) return null;
  const mind = bestMind(party);
  const free = crew.filter(a => a.char && !inDetail(s, a) && !a.engaged);
  const already = (kind) => (s.details || []).some(d => d.kind === kind);
  const start = [];

  // ----- what is coming, and whether they can take it here -----
  const threat = closing(s);
  const here = groundHere(s, crew);
  const oddsHere = threat.length ? judge(mind, crew, threat, here) : 1;
  const ok = fine(party);
  let choke = null, oddsThere = 0;
  if (threat.length && F && oddsHere < ok && !already('stand') && !already('hold') && !ROOTED.has(s.mission.orders)) {
    const centre = centreOf(crew);
    const from = crew.reduce((b, a) => (!b || dist(a, centre) < dist(b, centre) ? a : b), null);
    choke = F.chokepoint(s, from, threat, here);
    if (choke) oddsThere = judge(mind, crew, threat, choke.open);
  }

  // ----- the stand -----
  // The ground is the play. Nobody is sent anywhere alone, so there is no trust term: it only
  // needs somebody to have thought of it, and the ground to actually buy something.
  const standWorth = choke && oddsThere - oddsHere >= EDGE;
  if (standWorth && mind.tier >= PLAYS.stand.minTier && free.length >= 2 && (oddsThere >= ok || !ELSEWHERE.has(s.mission.orders))) {
    const width = Math.max(1, Math.min(8, Math.round(choke.open)));
    start.push({
      id: 'd' + s.clock + 't', kind: 'stand', label: PLAYS.stand.label, since: s.clock,
      members: free.map(a => a.id), point: { x: choke.x, y: choke.y }, sneak: false,
      line: `\u{1F6E1}\uFE0F ${threat.length} coming at them — they fall back and stand ${F.groundWord(width)}, where ${width === 1 ? 'one' : width} can reach them at a time`,
    });
  }

  // ----- the near ones first -----
  // They are collecting on the squad (field.js rally), and collecting takes time. If the group
  // in front is a fight worth having on its own and the rest are still a walk away, it is had
  // now, while the numbers are what they are.
  if (threat.length >= 2 && oddsHere < ok && !standWorth && !start.length && !already('pounce') && !already('retreat')
      && mind.tier >= PLAYS.pounce.minTier && free.length >= 2 && !ROOTED.has(s.mission.orders)) {
    const centre = centreOf(crew);
    const first = threat.reduce((b, a) => (!b || dist(a, centre) < dist(b, centre) ? a : b), null);
    // everything known to be standing with the front one, coming or not: it is in the fight the
    // moment the fight opens next to it
    const near = s.actors.filter(a => a.alive && a.side === 'theirs' && a.role !== 'structure' && !a.engaged && seen(s, a) && dist(a, first) <= 3);
    const rest = threat.filter(a => !near.includes(a));
    const gap = rest.length ? Math.min(...rest.map(a => dist(a, first))) : Infinity;
    if (near.length < threat.length && gap >= BEHIND && judge(mind, crew, near, here) >= ok) {
      start.push({
        id: 'd' + s.clock + 'p', kind: 'pounce', label: PLAYS.pounce.label, since: s.clock,
        members: free.map(a => a.id), targetId: first.id, sneak: false,
        line: `\u{2694}\uFE0F ${threat.length} coming, ${near.length} of them well ahead of the rest — they go at ${near.length === 1 ? 'that one' : `those ${near.length}`} now`,
      });
    }
  }

  // ----- the step back -----
  // Nothing above answers it and it is hopeless: they fall back to the way in, and if they are
  // stood at the gate with them still coming, they have their answer.
  let leave = null;
  if (threat.length && oddsHere < HOPELESS && !standWorth && !start.length && !already('retreat')
      && mind.tier >= PLAYS.retreat.minTier && !ROOTED.has(s.mission.orders)) {
    const exit = F ? F.portalPoint(s) : null;
    if (exit && dist(centreOf(crew), exit) <= GATE) {
      leave = `${threat.length} coming and no ground to meet them on — they read it and go`;
    } else if (free.length >= 2) {
      start.push({
        id: 'd' + s.clock + 'r', kind: 'retreat', label: PLAYS.retreat.label, since: s.clock,
        members: free.map(a => a.id), sneak: false,
        line: `\u{21A9}\uFE0F ${threat.length} coming and no ground to meet them on — they fall back to the way in`,
      });
    }
  }

  // ----- the rearguard -----
  // Coming at them, no ground that makes it a fight worth having, and the job somewhere else:
  // the two best suited meet it while the rest go on. The two of them have to be able to stand
  // for a while, or it buys nothing.
  const holdWorth = threat.length >= 2 && oddsHere < ok && !standWorth && ELSEWHERE.has(s.mission.orders);
  if (holdWorth && !already('hold') && !start.length && mind.tier >= PLAYS.hold.minTier && party.length >= 3 && free.length >= 3) {
    const anchors = free.map(a => ({ a, fit: fitFor('anchor', a.char), trust: trustIn(state, party, a.char) }))
      .sort((x, y) => (y.fit + y.trust) - (x.fit + x.trust));
    const anchor = anchors[0];
    if (anchor && anchor.fit >= PLAYS.hold.minFit && anchor.trust >= bar(party, PLAYS.hold)) {
      const backers = free.filter(a => a.id !== anchor.a.id)
        .map(a => ({ a, fit: fitFor('backer', a.char), bond: bondBetween(state, anchor.a.char, a.char) }))
        .sort((x, y) => (y.fit + y.bond * 0.6) - (x.fit + x.bond * 0.6));
      // A backer must not dislike the anchor (bond above -0.2) and must suit the role (fit above
      // 0.3). A backer who would rather be anywhere else is worse than no backer, so a bad
      // pairing is not made.
      const backer = backers[0] && backers[0].bond > -0.2 && backers[0].fit > 0.3 ? backers[0].a : null;
      const rear = backer ? [anchor.a, backer] : [anchor.a];
      const width = choke ? choke.open : here;
      const rearOdds = judge(mind, rear, threat, width);
      if (crew.length - rear.length >= 2 && rearOdds >= HOLD_MIN) {
        const where = choke ? ` ${F.groundWord(Math.max(1, Math.round(choke.open)))}` : '';
        start.push({
          id: 'd' + s.clock + 'h', kind: 'hold', label: PLAYS.hold.label, since: s.clock,
          members: rear.map(a => a.id), anchorId: anchor.a.id, point: choke ? { x: choke.x, y: choke.y } : null, sneak: false,
          line: backer
            ? `\u{1F6E1}\uFE0F ${anchor.a.label} holds them${where} with ${backer.label} — the rest go on`
            : `\u{1F6E1}\uFE0F ${anchor.a.label} stays to hold them${where} — the rest go on`,
        });
      }
    }
  }

  // ----- the quiet way in -----
  // A mark a long way off. Whoever goes meets the mark and whatever is standing with it, alone,
  // and is only sent if they would win that.
  const target = (already('strike') || start.length || threat.length) ? null : strikeTarget(s);
  if (target && mind.tier >= PLAYS.strike.minTier && party.length >= 3 && free.length >= 2) {
    const ranked = free.map(a => ({ a, fit: fitFor('strike', a.char), trust: trustIn(state, party, a.char) }))
      .sort((x, y) => (y.fit + y.trust) - (x.fit + x.trust));
    const pick = ranked[0];
    if (pick && pick.fit >= PLAYS.strike.minFit && pick.trust >= bar(party, PLAYS.strike)) {
      const escort = escortOf(s, target);
      const alone = judge(mind, [pick.a], [target, ...escort], 8);
      if (alone >= ok) {
        start.push({
          id: 'd' + s.clock + 's', kind: 'strike', label: PLAYS.strike.label, since: s.clock,
          members: [pick.a.id], targetId: target.id, sneak: true,
          line: `\u{1F5E1}\uFE0F ${pick.a.label} goes on ahead alone — ${escort.length ? `${escort.length} with it` : 'nothing is with it'}, and they are trusted with it`,
        });
      }
    }
  }

  // ----- and what is over -----
  const end = [];
  for (const d of (s.details || [])) {
    const busy = d.members.some(id => { const a = s.actors.find(x => x.id === id); return a && a.engaged; });
    if (d.kind === 'strike') {
      const t = s.actors.find(x => x.id === d.targetId);
      if (!t || (!t.alive && !t.subdued)) end.push(d.id);
    } else if (d.kind === 'hold') {
      if (!busy && !closing(s).length) end.push(d.id);
    } else if (d.kind === 'stand') {
      if (!busy && (!closing(s).length || s.clock - (d.since || 0) > STAND_FOR)) end.push(d.id);
    } else if (d.kind === 'pounce') {
      const t = s.actors.find(x => x.id === d.targetId);
      if (!busy && (!t || !t.alive || !closing(s).length)) end.push(d.id);
    } else if (d.kind === 'retreat') {
      // the hunt has died down, or it has not and they are at the gate
      const still = closing(s);
      if (!busy && !still.length) end.push(d.id);
      else if (!busy && F && dist(centreOf(crew), F.portalPoint(s)) <= GATE && judge(mind, crew, still, here) < HOPELESS) {
        end.push(d.id); leave = leave || `${still.length} still coming, and they are at the gate — they go`;
      }
    }
  }
  return (start.length || end.length || leave) ? { start, end, leave } : null;
}

const bondBetween = (state, a, b) => {
  const bo = BO();
  return (bo && a && b) ? bo.value(state, a.id, b.id) / 100 : 0;
};

// ---------- grief ----------
//
// The other half of a squad being people. When one of them goes down, everybody still standing
// is handed to this, and what comes back is what it did to them.
//
// Grief has two outcomes, and temper decides which. Somebody dogged and unafraid hardens: they
// fight on further into a wound, they stop wanting to leave, and the floor they are given means
// this map cannot take it back off them. Somebody brittle or timid breaks, and past a point they
// stop taking orders at all and make for the gate on their own.
//
// The size of it is the bond (bonds.js) and the direction is the temper (temper.js), which is
// exactly the split those two files were built for: what they were to each other, and what kind
// of person is being asked to carry it.
const NOTICE = 0.35;      // what a body is worth to somebody who barely knew them
const PANIC_AT = -0.55;   // below this they are not soldiers any more

function reaction(state, fallenChar, c) {
  const te = TE(), bo = BO();
  if (!te || !c) return null;
  const bond = (bo && fallenChar) ? bo.value(state, c.id, fallenChar.id) / 100 : 0;
  const care = Math.max(0, bond);
  // hatred is not grief. Somebody they could not stand going down is a small, ugly relief.
  const spite = Math.max(0, -bond);
  const steel = clamp(0.6 * te.t(c, 'grit') + 0.4 * te.t(c, 'nerve')
    + 0.25 * te.t(c, 'appetite') - 0.25 * te.t(c, 'guile'), -1, 1);
  const weight = NOTICE + 1.35 * care;
  const delta = clamp(weight * steel + spite * 0.15, -1, 1);
  return { bond, care, steel, delta };
}

/**
 * field.js's `grieve` callback. Returns one entry per survivor it has anything to say about —
 * the rest of them saw a body and kept walking, which is also a thing people do.
 */
function grieve(state, fallenChar, survivors) {
  const out = [];
  for (const a of survivors) {
    const r = reaction(state, fallenChar, a.char);
    if (!r) continue;
    const strong = r.care > 0.25;
    const entry = { actor: a, delta: r.delta };
    if (r.delta >= 0.3) {
      // hardened, and it does not wear off on this map
      entry.floor = r.delta * 0.55;
      if (strong) entry.line = `${a.label} will not leave them out here`;
      else if (r.delta > 0.55) entry.line = `${a.label} steadies the line`;
    } else if (r.delta <= PANIC_AT) {
      entry.panic = true;
      entry.line = `${a.label} breaks and runs`;
    } else if (r.delta < -0.25 && strong) {
      entry.line = `${a.label} is badly shaken`;
    }
    out.push(entry);
  }
  return out;
}

const TacticsAPI = { FIT, PLAYS, GOOD, fitFor, trustIn, bestMind, bar, judge, fine, closing, propose, grieve, reaction, strikeTarget, pressure };
if (typeof module !== 'undefined') module.exports = TacticsAPI;
if (typeof window !== 'undefined') window.Tactics = TacticsAPI;
})();
