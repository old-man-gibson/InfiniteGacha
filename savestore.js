// SaveStore: the current save and one undo copy of it, over a localStorage-like object.
// Browser: window.SaveStore. Node: module.exports.
//
// Two keys per save. `key` holds the current save. `key + '.rollback'` holds the save that was
// current before the last replace(), restore() or wipe(), or nothing. What the text is belongs to
// game.js; this file moves strings between the two keys, which is what lets a Node test run it over
// a Map (game.js is an IIFE over the DOM and cannot be required).
//
// No function here throws. A storage error comes back as { ok: false, error }. The one expected
// error is quota, and the undo copy is always the first thing given up for it:
//   - a rollback write that fails drops the rollback and the operation goes on;
//   - a write of the new text that fails puts both keys back as they were, in replace();
//   - write() removes the rollback to make room, then tries the live save once more.
// So the rollback only ever holds the save that was current before the last replace/restore/wipe.
//
// These functions can only guard calls on the object they are handed. Evaluating `localStorage`
// can itself throw (SecurityError with site data blocked, undefined in some sandboxes), and that
// happens in the caller before any function here runs. guard() is the caller's way to reach the
// storage object: pass its result to the functions below.
(() => {
const SUFFIX = '.rollback';
const slotOf = (key) => key + SUFFIX;

/**
 * The object `getStorage()` returns. If the call throws or returns nothing, a stand-in whose
 * methods throw that same error: reads then come back as an empty slot and writes as
 * { ok: false, error }, with the browser's own error name.
 */
function guard(getStorage) {
  let error;
  try {
    const storage = getStorage();
    if (storage) return storage;
    error = new Error('storage is not available');
  } catch (e) { error = e || new Error('storage is not available'); }
  const refuse = () => { throw error; };
  return { getItem: refuse, setItem: refuse, removeItem: refuse };
}

function get(storage, k) {
  try { return storage.getItem(k); } catch (e) { return null; }
}

/** text === null removes the key. Returns the error, or null when the write went through. */
function put(storage, k, text) {
  try {
    if (text === null) storage.removeItem(k); else storage.setItem(k, text);
    return null;
  } catch (e) { return e || new Error('storage error'); }
}

/** Make `text` the rollback. If it does not fit, the rollback is removed rather than left holding an older save. */
function keep(storage, key, text) {
  if (!put(storage, slotOf(key), text)) return true;
  put(storage, slotOf(key), null);
  return false;
}

/** The text of the rollback, or null. */
const rollback = (storage, key) => get(storage, slotOf(key));
const hasRollback = (storage, key) => rollback(storage, key) !== null;

/**
 * The current save becomes the rollback and `text` becomes the current save. `kept` is false when
 * there was nothing to keep or the copy did not fit. If `text` does not fit, the current save and
 * the rollback are left as they were and the result is { ok: false, error }.
 */
function replace(storage, key, text) {
  const before = get(storage, key), older = get(storage, slotOf(key));
  const kept = before !== null && keep(storage, key, before);
  const error = put(storage, key, text);
  if (error) {
    if (put(storage, slotOf(key), older)) put(storage, slotOf(key), null);
    return { ok: false, error };
  }
  return { ok: true, kept };
}

/**
 * Swap the current save and the rollback. The save that was replaced becomes the rollback, so a
 * restore can itself be undone by a second restore. With no rollback, nothing is changed.
 */
function restore(storage, key) {
  const back = rollback(storage, key);
  if (back === null) return { ok: false, error: new Error('there is no previous save') };
  const current = get(storage, key);
  const error = put(storage, key, back);
  if (error) return { ok: false, error };
  if (put(storage, slotOf(key), current)) put(storage, slotOf(key), null);
  return { ok: true };
}

/**
 * Remove the current save and keep it as the rollback. A rollback write that fails does not stop
 * the wipe: the save is removed and `kept` is false.
 */
function wipe(storage, key) {
  const before = get(storage, key);
  const kept = before !== null && keep(storage, key, before);
  const error = put(storage, key, null);
  return error ? { ok: false, error } : { ok: true, kept };
}

/**
 * The ordinary save. The live save outranks the undo copy: when the write fails and a rollback
 * exists, the rollback is removed and the write is tried once more. `droppedRollback` says it was.
 */
function write(storage, key, text) {
  let error = put(storage, key, text);
  if (!error) return { ok: true, droppedRollback: false };
  if (!hasRollback(storage, key)) return { ok: false, error, droppedRollback: false };
  put(storage, slotOf(key), null);
  error = put(storage, key, text);
  return error ? { ok: false, error, droppedRollback: true } : { ok: true, droppedRollback: true };
}

const SaveStoreAPI = { guard, replace, restore, wipe, write, rollback, hasRollback };
if (typeof module !== 'undefined') module.exports = SaveStoreAPI;
if (typeof window !== 'undefined') window.SaveStore = SaveStoreAPI;
})();
