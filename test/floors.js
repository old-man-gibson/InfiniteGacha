// Town floors. `node test/floors.js`; exit code 1 on any failure.
//
// Layout (baselayout.js + townmap.js), town tiers 0..4, lodgings and taverns on every floor, on seeds
// that roll every platform style (1 lobed, 2 poly, 3 rect, 9 oval, 8 and 50 mixed):
//   styles         those seeds do roll those styles
//   reachable      every plot's doorstep is walkable from the square, through the stairs
//   no overlap     no two structures' bounding circles overlap
//   on its floor   BaseLayout.floorAt at each structure's centre is the floor it was placed on
//   stable         a structure on the same floor as last tier has not moved
//   heights        heightAt is FLOOR_H x k on floor k's core and ramps down each stair
// Standing (floors.js):
//   terms          stars + missions (1 per 10, cap 4) + depth (1 per 5 cleared, cap 3) + abilities + grant (cap 5)
//   reach          the highest open floor whose need the total meets
//   station        housed below reach: -3 x floors short x (1 + appetite tilt); 0 at reach or for tilt -1
// Lodging (lodging.js):
//   admits         a lodging on floor k refuses anyone whose reach is below k
//   billet order   the higher standing picks first
//   autoPlan       never a tavern, never a floor someone sleeping outside cannot use

'use strict';
const path = require('path');
const root = path.join(__dirname, '..');
global.window = global;
for (const m of ['rng', 'stats', 'economy', 'classes', 'condition', 'temper', 'lodging', 'floors', 'mapgen', 'baselayout', 'townmap']) require(path.join(root, m + '.js'));
const { Econ, Lodging, Floors, BaseLayout: BL, TownMap: TM, Mapgen: MG, Temper } = global;

let failed = 0, checks = 0;
const check = (cond, msg) => { checks++; if (!cond) { failed++; console.log('FAIL ' + msg); } };
const scenario = (name, fn) => {
  try { fn(); } catch (e) { failed++; console.log(`FAIL ${name}: threw ${e && e.stack}`); }
};

// ---------- layout ----------

scenario('layout across tiers', () => {
  const want = { 1: 'lobed', 2: 'poly', 3: 'rect', 9: 'oval', 8: 'mixed', 50: 'mixed' };
  for (const seed of [1, 2, 3, 9, 8, 50]) {
    const st = { town: 0, base: { seed, placed: {} }, buildings: { farm: 1, mine: 0, garden: 2, kitchen: 0, smithy: 1, lab: 0, training: 0, altar: 0 }, characters: [] };
    const add = (t) => Lodging.build(st, t, { free: true, instant: true, floor: Econ.LODGINGS[t].floor });
    add('bunkhouse'); add('tent'); add('tent');
    const adds = [[], ['longhouse', 'alehouse', 'barracks'], ['cottages', 'inn'], ['manor', 'salon', 'bunkhouse'], ['sanctum', 'crownhall', 'tent']];
    let prev = null;
    for (let town = 0; town <= 4; town++) {
      st.town = town;
      adds[town].forEach(add);
      if (town === 2) st.buildings.smithy = 2;                     // a workshop outgrowing its spot on a platform
      const m = TM.build(st), lay = m.layout, tag = `seed ${seed} tier ${town}`;
      if (town === 4) check(lay.style === want[seed], `${tag}: rolls ${want[seed]} platforms (got ${lay.style})`);
      const d = MG.distanceField(m.tiles, [[m.plots.square.at.x, m.plots.square.at.y]]);
      for (const p of Object.values(m.plots)) {
        const v = d[p.at.y * m.w + p.at.x];
        check(v >= 0 && v < 1e6, `${tag}: ${p.key} (floor ${p.floor || 0}) reachable from the square`);
      }
      const S = lay.structures;
      for (let i = 0; i < S.length; i++) for (let j = i + 1; j < S.length; j++) {
        check(Math.hypot(S[i].x - S[j].x, S[i].z - S[j].z) >= S[i].r + S[j].r, `${tag}: ${S[i].key} and ${S[j].key} do not overlap`);
      }
      for (const s of S) check(BL.floorAt(lay, s.x, s.z) === s.floor, `${tag}: ${s.key} stands on floor ${s.floor} (ground says ${BL.floorAt(lay, s.x, s.z)})`);
      for (const s of S) {
        const want = s.kind === 'work' || s.kind === 'altar'
          ? Math.min(town, Econ.BUILDINGS[s.key].floor || 0)
          : Lodging.find(st, s.bedId).floor;
        check(s.floor === want, `${tag}: ${s.key} on floor ${s.floor}, expected ${want}`);
      }
      if (prev) for (const s of S) {
        const q = prev[s.key];
        if (q && q.floor === s.floor && q.r >= s.r) check(q.x === s.x && q.z === s.z, `${tag}: ${s.key} stayed where it was`);
      }
      prev = Object.fromEntries(S.map(s => [s.key, { x: s.x, z: s.z, floor: s.floor, r: s.r }]));
      for (let k = 1; k <= town; k++) {
        const c = lay.floors[k].core;
        check(Math.abs(BL.heightAt(lay, c.x, c.z) - BL.FLOOR_H * k) < 1e-6, `${tag}: floor ${k}'s core is ${BL.FLOOR_H * k} up`);
      }
      for (const stair of lay.stairs) {
        const mid = { x: (stair.a.x + stair.b.x) / 2, z: (stair.a.z + stair.b.z) / 2 };
        check(Math.abs(BL.heightAt(lay, mid.x, mid.z) - BL.FLOOR_H * (stair.k - 0.5)) < 1e-6, `${tag}: stair ${stair.k} is halfway up at its middle`);
      }
    }
  }
});

// ---------- standing ----------

const tempers = (appetite) => ({ nerve: 50, appetite, rigor: 50, grit: 50, guile: 50 });
function person(id, { stars = 2, out = 0, grant = 0, gifts = ['blade'], heroic = null, appetite = 50 } = {}) {
  return {
    id, name: 'p' + id, stats: { stars, base: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 } },
    record: { out }, standingGrant: grant, gifts, heroic, temper: tempers(appetite), class: null,
  };
}

scenario('standing terms', () => {
  const a = person(1, { stars: 3, out: 27, grant: 2, gifts: ['blade', 'arcana'], heroic: { title: 'Starborn human' } });
  const st = Floors.standing(a), part = (k) => st.parts.find(p => p.key === k).v;
  check(part('stars') === 3, 'stars term is the star count');
  check(part('missions') === 2, `27 sorties is +2 (got ${part('missions')})`);
  check(part('depth') === 0, 'no floors cleared is +0');
  check(part('abilities') === 2, `two gift paths and a heroic bloodline is +2 (got ${part('abilities')})`);
  check(part('grant') === 2, 'the grant is added as set');
  check(st.total === 9, `total is the sum (got ${st.total})`);
  check(Floors.standing(person(2, { out: 999 })).parts.find(p => p.key === 'missions').v === Floors.MISSIONS_CAP, 'missions cap');
  check(Floors.standing(person(3, { grant: 40 })).parts.find(p => p.key === 'grant').v === Floors.GRANT_MAX, 'grant cap');
  const deep = person(4); deep.record.floorCleared = 12;
  check(Floors.standing(deep).parts.find(p => p.key === 'depth').v === 2, 'floor 12 cleared is +2');
});

scenario('reach and station', () => {
  const st = { town: 2, buildings: {}, characters: [] };
  const low = person(1, { stars: 2 }), mid = person(2, { stars: 3 }), high = person(3, { stars: 5 }), capped = person(4, { stars: 7, grant: 5 });
  st.characters.push(low, mid, high, capped);
  check(Floors.reach(st, low) === 0 && Floors.reach(st, mid) === 1 && Floors.reach(st, high) === 2, 'reach follows FLOORS need');
  check(Floors.reach(st, capped) === 2, 'reach stops at the highest open floor');
  // nobody housed: everybody "lives" on floor 0
  const avg = Floors.station(st, high);
  check(avg.short === 2 && Math.abs(avg.v - (-Floors.STATION_PER_FLOOR * 2 * (1 + Temper.t(high, 'appetite')))) < 1e-9, 'station = -3 x floors short x (1 + appetite tilt)');
  const ascetic = person(5, { stars: 5, appetite: 0 });
  st.characters.push(ascetic);
  check(Math.abs(Floors.station(st, ascetic).v) < 1e-9, 'an ascetic (tilt -1) does not mind');
  check(Floors.station(st, low).v === 0, 'nobody minds being where their standing puts them');
});

// ---------- lodging ----------

scenario('floor gates on beds and taverns', () => {
  const st = { town: 2, buildings: {}, characters: [person(1, { stars: 1 }), person(2, { stars: 3 }), person(3, { stars: 5 })] };
  Lodging.build(st, 'cottages', { free: true, instant: true, floor: 2 });
  Lodging.build(st, 'longhouse', { free: true, instant: true, floor: 1 });
  Lodging.build(st, 'tent', { free: true, instant: true, floor: 0 });
  const ale = Lodging.build(st, 'alehouse', { free: true, instant: true, floor: 1 }).inst;
  const bed = (c) => Lodging.bedOf(st, c);
  check(bed(st.characters[2]).type === 'cottages', 'standing 5 sleeps on floor 2');
  check(bed(st.characters[1]).type === 'longhouse', 'standing 3 sleeps on floor 1');
  check(bed(st.characters[0]).type === 'tent', 'standing 1 sleeps on the ground');
  check(Floors.tavernFor(st, st.characters[0]) === null, 'standing 1 has no tavern to enter');
  check(Floors.tavernFor(st, st.characters[1]) === ale, 'standing 3 drinks at the alehouse');
  check(Lodging.capacity(st) === 4 + 6 + 2, 'a tavern adds no beds');
  // order: five want the four cottage beds; the one with the highest standing is served first even
  // though it has the highest id (the tie-break that would otherwise leave it out)
  const five = [1, 2, 3, 4, 5].map(id => person(id, { stars: 5, grant: id === 5 ? 2 : 0 }));
  const st2 = { town: 2, buildings: {}, characters: five };
  Lodging.build(st2, 'cottages', { free: true, instant: true, floor: 2 });
  Lodging.build(st2, 'tent', { free: true, instant: true, floor: 0 });
  check(Lodging.bedOf(st2, five[4]).type === 'cottages', 'the highest standing gets a cottage bed');
  check(Lodging.bedOf(st2, five[3]).type === 'tent', 'the lowest in order takes what is left');
});

scenario('autoPlan on floors', () => {
  const st = { town: 2, buildings: {}, gems: 1e6, ore: 1e6, crops: 1e6, herbs: 1e6, characters: [person(1, { stars: 1 }), person(2, { stars: 5 })] };
  Lodging.autoPolicy(st).types = ['tent', 'longhouse', 'cottages', 'alehouse'];
  const pick = Lodging.autoPlan(st);
  check(pick && Econ.LODGINGS[pick.type].floor === 0, `with a standing-1 character outside, only a ground-floor type (got ${pick && pick.type})`);
  const st2 = { town: 2, buildings: {}, gems: 1e6, ore: 1e6, crops: 1e6, herbs: 1e6, characters: [person(2, { stars: 5 }), person(3, { stars: 6 })] };
  Lodging.autoPolicy(st2).types = ['alehouse', 'cottages'];
  const p2 = Lodging.autoPlan(st2);
  check(p2 && p2.type === 'cottages', `a tavern is never auto-built (got ${p2 && p2.type})`);
});

console.log(failed ? `${checks} checks, ${failed} failed` : `${checks} checks, all passed`);
process.exit(failed ? 1 : 0);
