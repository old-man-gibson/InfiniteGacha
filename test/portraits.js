// One portrait per species: the Bestiary.PORTRAITS table, Bestiary.loadIndex/ready/portrait and
// FieldView.spriteFor. `node test/portraits.js`; exit code 1 on any failure.
//
// Table checks read assets/enemies/index.json and the assets/enemies folder directly, so they do
// not depend on the loader. Every species in Missions.BESTIARY must have a row; the row must name
// a file that is in the index and on disk with the same spelling and case (a case-sensitive web
// server serves only that); and no two species of different tiers may share a file. Same-tier
// sharing is reported, not failed.
//
// Loader checks load bestiary.js again for each scenario (its index is module state) with a stub
// fetch. fieldview.js is browser code: it is loaded as field.html loads it, with `window` as the
// global object, Mapgen, Missions and Bestiary as globals, and Image stubbed.

const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..');
const file = (f) => path.join(root, f);

let failed = 0, checks = 0;
const check = (cond, msg) => { checks++; if (!cond) { failed++; console.log('FAIL ' + msg); } };

global.window = global;
const Missions = require(file('missions.js'));
global.Missions = Missions;
const species = Object.values(Missions.BESTIARY);

// ---------- the table ----------
const index = JSON.parse(fs.readFileSync(file('assets/enemies/index.json'), 'utf8'));
const inIndex = new Set(index);
const onDisk = new Set(fs.readdirSync(file('assets/enemies')));

const loadBestiary = () => {
  delete require.cache[require.resolve(file('bestiary.js'))];
  return require(file('bestiary.js'));
};
const Bestiary = loadBestiary();
const rows = Bestiary.PORTRAITS;

const owners = new Map();                              // file -> species using it
for (const d of species) {
  const row = rows[d.id];
  check(typeof row === 'string' && row.length > 0, `${d.id}: no PORTRAITS row`);
  if (typeof row !== 'string') continue;
  check(inIndex.has(row), `${d.id}: "${row}" is not in assets/enemies/index.json (names are case-sensitive)`);
  check(onDisk.has(row), `${d.id}: "${row}" is not a file in assets/enemies`);
  owners.set(row, (owners.get(row) || []).concat(d));
}
for (const [f, ds] of owners) {
  const tiers = new Set(ds.map(d => d.tier));
  check(tiers.size === 1, `${ds.map(d => `${d.id} (${d.tier})`).join(', ')} share "${f}" across tiers`);
  if (ds.length > 1 && tiers.size === 1) console.log(`note: ${ds.map(d => d.id).join(', ')} share "${f}" within tier ${ds[0].tier}`);
}
for (const id of Object.keys(rows)) check(Missions.BESTIARY[id], `${id}: PORTRAITS row for a species that is not in Missions.BESTIARY`);

// ---------- the loader ----------
const realFetch = global.fetch;
const fetchOf = (list, counter) => async (url) => {
  counter.urls.push(url);
  return { json: async () => list };
};
const asyncCheck = async () => {
  {
    const B = loadBestiary();
    const c = { urls: [] };
    global.fetch = fetchOf(index, c);
    check(!B.ready(), 'ready() is true before loadIndex()');
    check(B.portrait('spider_queen') === null, 'portrait() answers before the index has loaded');
    const [a, b] = await Promise.all([B.loadIndex(), B.loadIndex()]);
    await B.loadIndex();
    check(c.urls.length === 1 && c.urls[0] === 'assets/enemies/index.json', `loadIndex() fetched ${c.urls.length} times, expected 1 (${c.urls})`);
    check(a === b && a.length === index.length, 'concurrent loadIndex() callers got different lists');
    check(B.ready(), 'ready() is false after loadIndex()');
    for (const d of species) {
      const url = B.portrait(d.id);
      check(url === 'assets/enemies/' + encodeURIComponent(B.PORTRAITS[d.id]), `${d.id}: portrait() is ${url}`);
      check(url && !/[ '"]/.test(url), `${d.id}: portrait() URL has an unescaped space or quote: ${url}`);
    }
    check(B.portrait('no_such_species') === null, 'portrait() of an unlisted species is not null');
    // a row whose file is not in the loaded index gives null, not another file
    B.PORTRAITS.test_missing = 'Not In The Index.png';
    check(B.portrait('test_missing') === null, 'portrait() of a row whose file is not in the index is not null');
    // a row matches the index case-insensitively and returns the index's own spelling
    B.PORTRAITS.test_case = 'wild boar.PNG';
    check(B.portrait('test_case') === 'assets/enemies/Wild%20Boar.png', `portrait() with a different case is ${B.portrait('test_case')}`);
    // file names with an apostrophe or a space survive as one URL path segment
    B.PORTRAITS.test_apostrophe = "Halloween Stein's Monster MK2.png";
    check(B.portrait('test_apostrophe') === "assets/enemies/Halloween%20Stein's%20Monster%20MK2.png", `apostrophe file is ${B.portrait('test_apostrophe')}`);
  }
  {
    const B = loadBestiary();
    const c = { urls: [] };
    global.fetch = async (url) => { c.urls.push(url); throw new Error('offline'); };
    const list = await B.loadIndex();
    await B.loadIndex();
    check(Array.isArray(list) && list.length === 0, 'a failed fetch does not give an empty list');
    check(B.ready(), 'ready() is false after a failed fetch');
    check(B.portrait('wolf') === null, 'portrait() after a failed fetch is not null');
    check(c.urls.length === 1, `a failed fetch was retried (${c.urls.length} requests)`);
  }

  // ---------- fieldview.js ----------
  {
    const B = loadBestiary();
    global.Bestiary = B;
    global.Mapgen = { T: {} };
    global.Image = class { };
    delete require.cache[require.resolve(file('fieldview.js'))];
    require(file('fieldview.js'));
    const FV = global.FieldView;
    const c = { urls: [] };
    global.fetch = fetchOf(index, c);
    check(typeof FV.loadSprites === 'undefined', 'FieldView.loadSprites still exists');

    const queen = Missions.BESTIARY.spider_queen;
    check(FV.spriteFor(queen) === null, 'spriteFor() answered before the index loaded');
    await B.loadIndex();
    const img = FV.spriteFor(queen);
    check(img && img.src === B.portrait('spider_queen'), 'spriteFor() after loadIndex() did not recover from the early null (it was cached)');
    check(FV.spriteFor(queen) === img, 'spriteFor() built a second Image for the same species');
    for (const d of species) {
      const s = FV.spriteFor(d);
      check(s && s.src === B.portrait(d.id), `${d.id}: the field sprite is ${s && s.src}, the report portrait is ${B.portrait(d.id)}`);
    }
    const none = { id: 'no_such_species', name: 'No Such Species', tier: 'basic' };
    check(FV.spriteFor(none) === null, 'spriteFor() of an unlisted species guessed a sprite');
    const named = FV.namer({ species: 'spider_queen' }, { theme: [] });
    check(named.sprite === img && named.label === queen.name, 'namer() did not carry the species art');
  }

  // ---------- who loads and calls what ----------
  const html = fs.readFileSync(file('field.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  const at = (s) => scripts.indexOf(s);
  check(at('bestiary.js') >= 0, 'field.html does not load bestiary.js');
  check(at('bestiary.js') > at('missions.js') && at('bestiary.js') < at('fieldview.js'), 'field.html must load bestiary.js after missions.js and before fieldview.js');
  const loadAt = html.indexOf('Bestiary.loadIndex()');
  check(loadAt >= 0 && loadAt < html.indexOf('rollMission();'), 'field.html does not await Bestiary.loadIndex() before the first mission');
  for (const f of fs.readdirSync(root).filter(n => /\.(js|html)$/.test(n))) {
    const src = fs.readFileSync(file(f), 'utf8');
    check(!/enemies\.json/.test(src), `${f} reads assets/enemies.json, which was replaced by assets/enemies/index.json`);
    check(!/loadSprites/.test(src), `${f} calls FieldView.loadSprites, which was replaced by Bestiary.loadIndex`);
  }
  check(!fs.existsSync(file('assets/enemies.json')), 'assets/enemies.json exists; assets/enemies/index.json is the only file list');
};

asyncCheck().then(() => {
  global.fetch = realFetch;
  console.log(`${species.length} species, ${owners.size} distinct files, ${checks} checks, ${failed ? failed + ' failed' : 'all passed'}`);
  process.exit(failed ? 1 : 0);
}, (e) => { console.log('FAIL threw ' + (e && e.stack)); process.exit(1); });
