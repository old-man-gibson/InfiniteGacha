// Random numbers. Browser: window.Rng. Node: module.exports.
//
// Every roll in the game comes through here and is drawn from the platform's cryptographic
// generator (crypto.getRandomValues), not a seeded PRNG. Luck is meant to be real luck:
// there is no state to save, nothing to replay, nothing a player could steer by timing.
//
// Words are pulled in blocks of 256 uint32s so a pull, a fight or a whole mission costs a
// handful of syscalls rather than one per roll. `rand()` has the Math.random contract
// (uniform in [0, 1)) so every existing `rand = Math.random` parameter accepts it.
//
// Tests can pin the stream with `Rng.withSource(fn)`, which swaps in any [0,1) function for
// the duration of a callback. Nothing in the game itself does this.

(() => {
const BLOCK = 256;
let buf = null;
let at = BLOCK;

function cryptoObj() {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.getRandomValues) return globalThis.crypto;
  try { return require('crypto').webcrypto; } catch (e) { return null; }
}

function refill() {
  const c = cryptoObj();
  if (!buf) buf = new Uint32Array(BLOCK);
  if (c) c.getRandomValues(buf);
  else for (let i = 0; i < BLOCK; i++) buf[i] = (Math.random() * 4294967296) >>> 0; // last resort only
  at = 0;
}

function cryptoRand() {
  if (at >= BLOCK) refill();
  return buf[at++] / 4294967296;
}

let source = cryptoRand;

/** Uniform in [0, 1). */
function rand() { return source(); }

/** Integer in [min, max] inclusive. */
function randInt(min, max) { return min + Math.floor(rand() * (max - min + 1)); }

function chance(p) { return rand() < p; }

/** Uniform pick from an array. */
function pick(a) { return a[Math.floor(rand() * a.length)]; }

/** In-place Fisher-Yates. */
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** Weighted pick from entries with a `weight` field (or use weightOf). */
function weightedPick(entries, weightOf = (e) => e.weight) {
  const total = entries.reduce((s, e) => s + weightOf(e), 0);
  let roll = rand() * total;
  for (const e of entries) { roll -= weightOf(e); if (roll <= 0) return e; }
  return entries[entries.length - 1];
}

/** Normal-ish sample (sum of three uniforms), mean 0, roughly ±1.5. */
function jitter() { return (rand() + rand() + rand()) - 1.5; }

/** Run fn with a replacement [0,1) source. For tests. */
function withSource(fn, body) {
  const prev = source;
  source = fn;
  try { return body(); } finally { source = prev; }
}

const RngAPI = { rand, randInt, chance, pick, shuffle, weightedPick, jitter, withSource };
if (typeof module !== 'undefined') module.exports = RngAPI;
if (typeof window !== 'undefined') window.Rng = RngAPI;
})();
