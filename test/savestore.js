// Save undo and visible storage failures: savestore.js on its own, then game.html booted under Node.
// `node test/savestore.js`; exit code 1 on any failure.
//
// Part 1 runs SaveStore over a Map-backed storage stub with a quota and per-key write failures.
// Part 2 boots game.html with test/game.boot.js (stub DOM, virtual time, an in-memory localStorage)
// and drives the controls game.js builds on SaveStore: Reset, the save panel's Restore button,
// Import, the #tick failure text, and the boot message when catalog.json cannot be fetched.
// game.js is an IIFE over the DOM and cannot be required, which is why Part 2 goes through the page.

const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.join(__dirname, '..');
const SaveStore = require(path.join(root, 'savestore.js'));

let failed = 0, checks = 0;
const check = (cond, msg) => { checks++; if (!cond) { failed++; console.log('FAIL ' + msg); } };
const scenario = (name, fn) => {
  try { fn(); } catch (e) { failed++; console.log(`FAIL ${name}: threw ${e && e.stack}`); }
};
const ascenario = async (name, fn) => {
  try { await fn(); } catch (e) { failed++; console.log(`FAIL ${name}: threw ${e && e.stack}`); }
};

// ---------- Part 1: SaveStore over a stub ----------

const KEY = 'infinitegacha.save.v2', RB = KEY + '.rollback';
const quotaError = () => { const e = new Error('quota'); e.name = 'QuotaExceededError'; return e; };

/**
 * localStorage as a Map. `quota` counts key and value lengths together, as browsers do, and a
 * write over an existing key is charged only for the difference. `deny(key, value)` makes one
 * write fail whatever the quota is.
 */
function makeStorage(quota = Infinity) {
  const m = new Map();
  const used = () => [...m].reduce((n, [k, v]) => n + k.length + v.length, 0);
  const s = {
    m, quota, deny: null, used,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem(k, v) {
      v = String(v);
      const next = used() - (m.has(k) ? k.length + m.get(k).length : 0) + k.length + v.length;
      if (next > s.quota || (s.deny && s.deny(k, v))) throw quotaError();
      m.set(k, v);
    },
    removeItem: (k) => { m.delete(k); },
  };
  return s;
}

const A = 'save A \u{1F4BE}\n' + 'a'.repeat(100);      // an emoji and a newline: the text is opaque to SaveStore
const B = 'save B ' + 'b'.repeat(100);
const C = 'save C ' + 'c'.repeat(100);

scenario('replace then restore', () => {
  const st = makeStorage();
  st.setItem(KEY, A);
  const r = SaveStore.replace(st, KEY, B);
  check(r.ok && r.kept === true, 'replace reports ok and that the old save was kept');
  check(st.getItem(KEY) === B && st.getItem(RB) === A, 'after replace: current is the new text, rollback is the old save');
  check(SaveStore.hasRollback(st, KEY) && SaveStore.rollback(st, KEY) === A, 'hasRollback and rollback() read the slot');
  const back = SaveStore.restore(st, KEY);
  check(back.ok && st.getItem(KEY) === A, 'restore reproduces the original save byte for byte');
  check(st.getItem(RB) === B, 'the replaced save is now the rollback');
  SaveStore.restore(st, KEY);
  check(st.getItem(KEY) === B && st.getItem(RB) === A, 'restore twice returns to the replaced save');
});

scenario('replace with nothing to keep', () => {
  const st = makeStorage();
  const r = SaveStore.replace(st, KEY, B);
  check(r.ok && r.kept === false && st.getItem(KEY) === B, 'replace on an empty store writes the text');
  check(!SaveStore.hasRollback(st, KEY), 'and writes no rollback');
  const none = SaveStore.restore(st, KEY);
  check(!none.ok && st.getItem(KEY) === B && st.getItem(RB) === null, 'restore with no rollback fails and changes nothing');
});

scenario('replace: the new text hits quota', () => {
  const st = makeStorage();
  st.setItem(KEY, A);
  st.setItem(RB, C);
  st.deny = (k, v) => k === KEY && v === B;
  const r = SaveStore.replace(st, KEY, B);
  check(!r.ok && r.error && r.error.name === 'QuotaExceededError', 'replace returns { ok: false, error }');
  check(st.getItem(KEY) === A, 'the current save is untouched');
  check(st.getItem(RB) === C, 'and the rollback is what it was before the attempt');
  st.deny = null;
  const bare = makeStorage();
  bare.setItem(KEY, A);
  bare.deny = (k, v) => k === KEY && v === B;
  SaveStore.replace(bare, KEY, B);
  check(bare.getItem(KEY) === A && bare.getItem(RB) === null, 'with no earlier rollback, a failed replace leaves none');
});

scenario('replace: the rollback write hits quota', () => {
  const st = makeStorage();
  st.setItem(KEY, A);
  st.setItem(RB, C);
  st.deny = (k) => k === RB;
  const r = SaveStore.replace(st, KEY, B);
  check(r.ok && r.kept === false && st.getItem(KEY) === B, 'the new text is still written');
  check(st.getItem(RB) === null, 'and the older rollback is removed, not left to pass as the save just replaced');
});

scenario('wipe', () => {
  const st = makeStorage();
  st.setItem(KEY, A);
  const r = SaveStore.wipe(st, KEY);
  check(r.ok && r.kept && st.getItem(KEY) === null && st.getItem(RB) === A, 'wipe removes the current save and keeps it as the rollback');
  const back = SaveStore.restore(st, KEY);
  check(back.ok && st.getItem(KEY) === A, 'restore after a wipe brings the save back byte for byte');
  check(!SaveStore.hasRollback(st, KEY) && st.getItem(RB) === null, 'hasRollback is false after restoring over an empty slot, and no empty string is stored');
});

scenario('wipe: the rollback write hits quota', () => {
  const st = makeStorage();
  st.setItem(KEY, A);
  st.setItem(RB, C);
  st.deny = (k) => k === RB;
  const r = SaveStore.wipe(st, KEY);
  check(r.ok && r.kept === false, 'wipe reports ok and that nothing was kept');
  check(st.getItem(KEY) === null, 'the current save is still removed');
  check(st.getItem(RB) === null, 'the older rollback is removed too');
  const empty = makeStorage();
  const none = SaveStore.wipe(empty, KEY);
  check(none.ok && none.kept === false && empty.getItem(RB) === null, 'wipe of an empty store is ok and writes nothing');
});

scenario('write drops the rollback to make room', () => {
  const st = makeStorage();
  st.setItem(KEY, 'x'.repeat(100));
  st.setItem(RB, 'y'.repeat(100));
  st.quota = st.used() + 20;                              // room for a slightly larger current save only
  const text = 'z'.repeat(130);
  const r = SaveStore.write(st, KEY, text);
  check(r.ok && r.droppedRollback === true, 'write succeeds on the second try and says the rollback was dropped');
  check(st.getItem(KEY) === text && st.getItem(RB) === null, 'current is the new text and the rollback is gone');
  const fits = SaveStore.write(st, KEY, 'w'.repeat(50));
  check(fits.ok && fits.droppedRollback === false, 'a write that fits drops nothing');
});

scenario('write: the failure stays visible when dropping the rollback does not help', () => {
  const st = makeStorage();
  st.setItem(KEY, 'x'.repeat(100));
  st.setItem(RB, 'y'.repeat(100));
  st.quota = st.used();
  const r = SaveStore.write(st, KEY, 'z'.repeat(4000));
  check(!r.ok && r.error.name === 'QuotaExceededError' && r.droppedRollback === true, 'returns the error');
  check(st.getItem(KEY) === 'x'.repeat(100), 'the current save is untouched');
  const noRb = makeStorage(150);
  noRb.setItem(KEY, 'x'.repeat(100));
  const r2 = SaveStore.write(noRb, KEY, 'z'.repeat(4000));
  check(!r2.ok && r2.droppedRollback === false && noRb.getItem(KEY) === 'x'.repeat(100), 'with no rollback to drop it fails at once and leaves the save');
});

scenario('a blocked store never throws', () => {
  const boom = () => { const e = new Error('blocked'); e.name = 'SecurityError'; throw e; };
  const st = { getItem: boom, setItem: boom, removeItem: boom };
  let threw = null;
  let out;
  try {
    out = [SaveStore.replace(st, KEY, A), SaveStore.restore(st, KEY), SaveStore.wipe(st, KEY), SaveStore.write(st, KEY, A)];
    SaveStore.hasRollback(st, KEY); SaveStore.rollback(st, KEY);
  } catch (e) { threw = e; }
  check(threw === null, 'no function throws when every storage call does');
  check(out && out.every(r => r.ok === false && r.error && r.error.name !== undefined), 'each reports { ok: false, error }');
});

scenario('guard: an expression that throws becomes a refusing store', () => {
  const blocked = () => { const e = new Error('Access is denied'); e.name = 'SecurityError'; throw e; };
  const st = SaveStore.guard(blocked);
  let threw = null, out;
  try {
    out = [SaveStore.replace(st, KEY, A), SaveStore.wipe(st, KEY), SaveStore.write(st, KEY, A), SaveStore.restore(st, KEY)];
  } catch (e) { threw = e; }
  check(threw === null, 'no function throws over a guarded store whose getter threw');
  check(out && out.slice(0, 3).every(r => r.ok === false && r.error && r.error.name === 'SecurityError'), 'replace, wipe and write report the browser\'s own error');
  check(out && out[3].ok === false, 'restore reports { ok: false }');
  check(SaveStore.rollback(st, KEY) === null && !SaveStore.hasRollback(st, KEY), 'the rollback slot reads as empty');

  const real = makeStorage();
  check(SaveStore.guard(() => real) === real, 'a getter that works returns the storage object itself');
  for (const [label, get] of [['returns nothing', () => undefined], ['returns null', () => null], ['throws nothing useful', () => { throw undefined; }]]) {
    const r = SaveStore.write(SaveStore.guard(get), KEY, A);
    check(!r.ok && r.error && /not available/.test(r.error.message), `a getter that ${label} is a refusal too`);
  }
});

// ---------- Part 2: game.html under Node ----------

const walk = (el, out = []) => { out.push(el); for (const k of el._kids) walk(k, out); return out; };
const textOf = (el) => el._text || el._html || '';
const findText = (el, re) => walk(el).filter(e => re.test(textOf(e)));
const findButton = (el, label) => walk(el).find(e => e.tagName === 'BUTTON' && textOf(e) === label);
const chars = (text) => JSON.parse(text).characters.length;
// Errors the missing catalog.json is expected to leave in game.boot's list. 'Game.state never appeared'
// is what init() stopping looks like from outside.
const expected = (e) => e.where === 'boot';

/** Total-size quota on the boot stub's localStorage, charged like a browser does. */
function limit(ls, extra) {
  const used = () => [...ls.map].reduce((n, [k, v]) => n + k.length + v.length, 0);
  const quota = used() + extra;
  const real = ls.setItem.bind(ls);
  ls.setItem = (k, v) => {
    v = String(v);
    const next = used() - (ls.map.has(k) ? k.length + ls.map.get(k).length : 0) + k.length + v.length;
    if (next > quota) throw quotaError();
    real(k, v);
  };
}

async function part2() {
  let boot;
  try { ({ boot } = require('./game.boot.js')); } catch (e) {
    console.log(`part 2 skipped: test/game.boot.js could not be loaded (${e.message})`);
    return;
  }

  await ascenario('script order', async () => {
    const b = await boot();
    const at = b.scripts.indexOf('savestore.js');
    check(at >= 0 && at < b.scripts.indexOf('game.js'), 'game.html loads savestore.js before game.js');
    check(b.errors.length === 0, `the page boots with no uncaught exception (${b.errors.map(e => e.message).join('; ')})`);
    b.dispose();
  });

  await ascenario('reset keeps the save as the previous save', async () => {
    const b = await boot();
    const ls = b.localStorage;
    b.click('#pull'); b.click('#pull');
    const before = ls.getItem(KEY);
    check(chars(before) === 2, 'two summons are in the stored save');
    check(/previous save/.test(b.el('#reset').title) && /Export or Import/.test(b.el('#reset').title), 'the Reset button says where the previous save is restored from');
    b.click('#reset');
    check(ls.getItem(KEY) === before, 'the first click only arms the button');
    b.click('#reset');
    check(ls.getItem(RB) === before, 'Reset leaves the wiped save, byte for byte, under the rollback key');
    check(chars(ls.getItem(KEY)) === 0, 'and the current save is a new town');
    b.click('#reset'); b.click('#reset');
    check(ls.getItem(RB) === before, 'a second Reset on the empty town does not overwrite the previous save');
    b.dispose();
  });

  await ascenario('save panel offers the previous save and Restore swaps it in', async () => {
    const b = await boot();
    const ls = b.localStorage;
    b.click('#import');
    check(findText(b.el('#picker-list'), /Previous save/).length === 0, 'with no rollback the panel has no previous-save row');
    b.click('#pull'); b.click('#pull');
    const before = ls.getItem(KEY);
    b.click('#reset'); b.click('#reset');
    const fresh = ls.getItem(KEY);

    for (const mode of ['#export', '#import']) {
      b.click(mode);
      const row = findText(b.el('#picker-list'), /^Previous save: 2 characters, 0 on the memorial, Camp, 800 gems/);
      check(row.length === 1, `${mode.slice(1)} panel shows "Previous save: 2 characters, 0 on the memorial, Camp, 800 gems"`);
      check(!!findButton(b.el('#picker-list'), 'Restore previous save'), `${mode.slice(1)} panel has the Restore previous save button`);
    }

    const reloads = b.reloads.n;
    const btn = findButton(b.el('#picker-list'), 'Restore previous save');
    btn.click();
    check(b.reloads.n === reloads && ls.getItem(KEY) === fresh, 'the first click only arms the button');
    check(textOf(btn) === 'Replace current save?', 'and the armed button says what it will do');
    btn.click();
    check(b.reloads.n === reloads + 1, 'the second click reloads the page');
    check(ls.getItem(KEY) === before, 'the current save is the original, byte for byte');
    check(ls.getItem(RB) === fresh, 'the town it replaced is now the previous save, so a restore is undoable');

    // The page is on its way out. The in-memory state is still the new town; none of these may write it back.
    b.advance(15000);
    b.fire('window', 'beforeunload');
    b.fire('document', 'visibilitychange', { hidden: true });
    b.advance(15000);
    check(ls.getItem(KEY) === before, 'the tick, beforeunload and visibilitychange do not write the old state over the restored save');
    check(b.Game.state.characters.length === 0, 'the in-memory state was the new town throughout, so a write would have been visible');
    b.dispose();
  });

  await ascenario('import keeps the save it replaces', async () => {
    const b = await boot();
    const ls = b.localStorage;
    b.click('#pull');
    const before = ls.getItem(KEY);
    const file = JSON.parse(before);
    file.characters = []; file.gems = 5;
    b.click('#import');
    const list = b.el('#picker-list');
    const paste = walk(list).find(e => e.tagName === 'TEXTAREA');
    paste.value = JSON.stringify({ game: 'InfiniteGacha', format: 1, exported: new Date(0).toISOString(), state: file });
    b.fire(paste, 'input');
    const load = findButton(list, 'Load this save');
    check(load && !load.disabled, 'the file is accepted');
    check(findText(list, /kept as the previous save, one undo deep, until the next import or reset/).length > 0, 'the dialog says what is kept and until when');
    const reloads = b.reloads.n;
    load.click(); load.click();
    check(b.reloads.n === reloads + 1, 'the second click reloads');
    check(JSON.parse(ls.getItem(KEY)).gems === 5 && chars(ls.getItem(KEY)) === 0, 'the imported save is current');
    check(ls.getItem(RB) === before, 'the replaced save is the previous save, byte for byte');
    b.advance(15000);
    b.fire('window', 'beforeunload');
    check(JSON.parse(ls.getItem(KEY)).gems === 5, 'nothing writes the old state over the import');
    b.dispose();
  });

  await ascenario('a failed save shows in #tick and clears after the next good one', async () => {
    const b = await boot();
    const ls = b.localStorage;
    const real = ls.setItem.bind(ls);
    ls.setItem = () => { throw quotaError(); };
    b.click('#pull');
    b.advance(600);
    check(/save failed: QuotaExceededError/.test(b.el('#tick').textContent), `#tick names the failure (${b.el('#tick').textContent})`);
    check(/^next tick in \d+s - save failed/.test(b.el('#tick').textContent), 'and keeps the countdown');
    ls.setItem = real;
    b.click('#pull');
    b.advance(600);
    check(!/save failed/.test(b.el('#tick').textContent), `#tick clears after the next successful save (${b.el('#tick').textContent})`);
    check(chars(ls.getItem(KEY)) === 2, 'and the stored save has both summons');
    b.dispose();
  });

  await ascenario('a full store gives up the previous save, not the live one', async () => {
    const b = await boot();
    const ls = b.localStorage;
    b.click('#pull'); b.click('#pull');
    b.click('#reset'); b.click('#reset');
    check(ls.getItem(RB) !== null, 'a previous save exists to be given up');
    limit(ls, 500);                                     // room for the live save to grow by about 500 characters
    b.click('#pull');                                   // one character is several KB
    check(ls.getItem(RB) === null, 'the write failed, the previous save was removed');
    check(chars(ls.getItem(KEY)) === 1, 'and the live save, with the new character, was written on the retry');
    b.advance(600);
    check(!/save failed/.test(b.el('#tick').textContent), 'which is not reported as a failure');
    b.dispose();
  });

  await ascenario('restore failing leaves the page working', async () => {
    const b = await boot();
    const ls = b.localStorage;
    b.click('#pull');
    b.click('#reset'); b.click('#reset');
    const fresh = ls.getItem(KEY), prev = ls.getItem(RB);
    b.click('#import');
    const btn = findButton(b.el('#picker-list'), 'Restore previous save');
    const real = ls.setItem.bind(ls);
    ls.setItem = () => { throw quotaError(); };
    const reloads = b.reloads.n;
    btn.click(); btn.click();
    ls.setItem = real;
    check(b.reloads.n === reloads, 'no reload when the store refuses the swap');
    check(ls.getItem(KEY) === fresh && ls.getItem(RB) === prev, 'both slots are as they were');
    check(findText(b.el('#picker-list'), /the browser would not store the previous save \(QuotaExceededError\)/).length > 0, 'the panel says why');
    b.click('#pull');                                   // frozen must be off again, or this save is lost
    check(chars(ls.getItem(KEY)) === 1, 'saving works again afterwards');
    b.dispose();
  });

  await ascenario('storage that throws when read leaves the save panel and Reset working', async () => {
    const b = await boot();
    const ls = b.localStorage;
    b.click('#pull'); b.click('#pull');
    b.click('#reset'); b.click('#reset');
    b.click('#pull');
    b.click('#import');
    check(findText(b.el('#picker-list'), /^Previous save:/).length === 1, 'with working storage the panel has a previous-save row');
    const keyBefore = ls.getItem(KEY), rbBefore = ls.getItem(RB);

    // Evaluating `localStorage` now throws, as in a browser with site data blocked.
    Object.defineProperty(b.context, 'localStorage', {
      configurable: true,
      get() { const e = new Error('Failed to read the localStorage property from Window: Access is denied'); e.name = 'SecurityError'; throw e; },
    });
    const errors = b.errors.length;
    for (const mode of ['#export', '#import']) {
      b.click(mode);
      check(b.errors.length === errors, `opening the ${mode.slice(1)} panel throws nothing (${b.errors.slice(errors).map(e => e.message).join('; ')})`);
      check(findText(b.el('#picker-list'), /Previous save/).length === 0, `the ${mode.slice(1)} panel shows no previous save, since none can be read`);
    }
    check(!!findButton(b.el('#picker-list'), 'Load this save') && !!walk(b.el('#picker-list')).find(e => e.tagName === 'TEXTAREA'), 'and the import controls are there');
    b.click('#export');
    check(!!findButton(b.el('#picker-list'), 'Download the file'), 'the export controls are there');

    check(b.Game.state.characters.length === 1, 'one character before Reset');
    b.click('#reset'); b.click('#reset');
    check(b.errors.length === errors, `Reset throws nothing (${b.errors.slice(errors).map(e => e.message).join('; ')})`);
    check(b.Game.state.characters.length === 0, 'and Reset replaced the state');

    b.advance(10500);                                   // the next tick calls save() against the refused store
    check(/save failed/.test(b.el('#tick').textContent), `#tick reports the failed save (${b.el('#tick').textContent})`);
    check(b.errors.length === errors, 'and the tick throws nothing');
    check(ls.getItem(KEY) === keyBefore && ls.getItem(RB) === rbBefore, 'nothing was written to the real store through the refusal');
    b.dispose();
  });

  await ascenario('init names catalog.json when it cannot be loaded', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-nocatalog-'));
    try {
      fs.cpSync(root, dir, {
        recursive: true,
        filter: (src) => {
          const rel = path.relative(root, src).replace(/\\/g, '/');
          if (rel === '') return true;
          if (/^(assets|ulpc|test|\.team|\.team-backup|\.claude)(\/|$)/.test(rel)) return false;
          return rel !== 'catalog.json';
        },
      });
      const b = await boot({ root: dir });
      const content = b.el('#content');
      const note = findText(content, /catalog\.json could not be loaded/)[0];
      check(!!note, '#content holds the message');
      check(note && /catalog\.json could not be loaded: HTTP 404\./.test(textOf(note)), `it names the file and the status (${note && textOf(note).slice(0, 80)})`);
      check(note && /python -m http\.server/.test(textOf(note)), 'and gives the http server command');
      check(content._kids.length === 1, 'and nothing else is left in #content');
      const stray = b.errors.filter(e => !expected(e));
      check(stray.length === 0, `init no longer rejects (${stray.map(e => e.where + ': ' + e.message).join('; ')})`);
      check(!b.Game || !b.Game.state, 'no town was started');
      b.dispose();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

(async () => {
  await part2();
  console.log(`${checks} checks, ${failed ? failed + ' failed' : 'all passed'}`);
  process.exit(failed ? 1 : 0);
})();
