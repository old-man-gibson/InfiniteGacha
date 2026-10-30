I've verified the load-bearing claims against live source. Here is the specification.

---

# FACET — a portable procedural ability engine for InfiniteGacha and ksgproto28

## 0. Verification log — what I checked, and what it changes

Every claim below was run or read, not inherited from the judgments.

| Claim | Verdict | Evidence |
|---|---|---|
| IG's armor stage is dead | **TRUE** | `node -e` on a real `fromMonster`: `base.armor = 7.20`, `m.armor = undefined`, `E.bearerArmor(m) = 0`, `E.slice(m,'slashing',100,0).dealt = 100` |
| `bearer.ward` has no writer | **TRUE** | grep across all `.js`: only read site is `elements.js:36`; `def('ward',…,{mods:[]})` at `:112` is empty; `'ward' in m === false` |
| `healAllowance` is Infinity by default | **TRUE** | `E.healAllowance(m) === Infinity` |
| `blockedBy` gives mutual exclusion "for free" (D4's E1) | **FALSE** | Live test: apply A → true; apply B → **false**; held `['tA']`. `inflict()` (`elements.js:196`) *refuses application* while a blocker is held. It is a **first-come lock**, not a switchable mode. Remove-then-apply is required, and that is compiler code. |
| Growing the mercy dial makes you luckier (D4's E12) | **FALSE** | `mercyCurve` (`mercy.js:46-61`) bisects `slope` for 60 iterations so `1/meanRolls(base,slope,cap) === rate`. The dial changes *variance only*. To cheat you must drift the **rate**. D3 is correct. |
| `Rng.withSource(fn, body)` exists and is scoped | **TRUE** | `rng.js:68`, takes a body, restores in `finally`. CRN pricing is implementable in IG. |
| KSG has no encounter tick cap | **TRUE** | grep `MAX_TICKS|timedOut|tickCap` in `combat.ts` → zero hits |
| KSG `modFingerprint` already covers statuses | **TRUE** | `derived.ts:617`: `parts.push(\`s${s.id}:${effectiveIntensity(s)}:${s.stacks}\`)` |
| …and does **not** cover `held.data` | **TRUE (new finding, no judge caught it)** | `data` appears nowhere in `modFingerprint`. **This is a hard constraint on the design: any machine magnitude a status mod reads must ride on `intensity` or `stacks`, never on `data`.** |
| `conditionHolds` fails **open** on unknown subject | **TRUE** | `triggers.ts:216-218` |
| `hidden:true` / `buff:true` dodge the readout and the antidote | **TRUE** | `elements.js:363 visibleStatuses`; `consume.js:27 harmful = filter(s => d && !d.buff)` |
| `STATUSES` is a mutable exported Record in both hosts | **TRUE** | `elements.js:43`; `statuses.data.ts:23` |
| TS type-checks a bare side-effect `import './core.js'` with a global sidecar `.d.ts`, no `allowJs` | **TRUE (ran tsc)** | exit 0; and it still catches `TS2322` |
| …but TS does **not** verify the imported `.js` exists | **TRUE (new finding)** | `import './nosuch.js'` type-checks clean, exit 0. **`svelte-check` cannot catch a wrong core path; only `vite build` can.** |
| `stats.js:50 minDamage` declares `dex`, reads `dex` **and** `str` | **TRUE** | source |
| `equipLoad`/`walkSpeed`/`cooldownReduce`/`rewardMod` have zero consumers | **TRUE** | grep count 0 outside `stats.js` |
| `Facet` / `Knack` free as identifiers | **TRUE** | both appear only as nickname *strings* in `names.js:73,92` and as English prose in two KSG `desc` fields |

**The one verification that changes the architecture:** because the armor stage, the ward stage and `res:` buff mods are all inert *today*, any design that **declares** its coverage (D1, D2, D4) is computing a bound against a game that does not exist. This spec **measures** coverage through the host's own `slice`, which is correct against the game as it is, bugs included — and therefore **the three pre-existing balance bugs are not prerequisites.** That removes the largest single cost item every design listed.

---

## 1. Resolving the three judgments explicitly

The judges named three different bases and one nearly identical set of grafts. That is the shape of a disagreement about *layering*, not about content.

**Resolution 1 — base.** The base is **D2's rule kernel** (recursive `Expr`, recursive `Guard`, multiple cells per ability, wildcard reflection ports). The expressiveness judge is right that flatness is exactly the effect-table failure the brief forbids, and D1's one-machine rule and D4's one-machine rule both break on E9 by their own encodings. D3's organ multiplicity is adopted; D3's `Ref` language is rejected in favour of D2's `Expr` because it has no arithmetic.

**Resolution 2 — D4 is a backend, not an architecture.** All three judges wanted compile-to-`StatusDef`. It is adopted as the **emission backend**, and its scope is enlarged past what D4 imagined: a `status` emission's payload is a **host-declared `StatusDef` fragment**, so the vocabulary reaches `overrideRes`, `converts`, `amplifies`, `capOverrides`, `grafts`, `tends`, `magnetism`, `bar.onFill`, `retaliate`, `healCap`, `expiresTo` — the twenty rich mechanism fields the expressiveness judge said no design could reach. This is the single largest expressiveness win in the synthesis and it costs one adapter member (`host.statusSchema()`).

**Resolution 3 — measurement beats declaration, decisively.** The correctness judge broke D2's ledger on `ward` and D4's theorem on `overrideRes`, both because a *declared* coverage formula omits a mitigation path. D3's `probeSlice` cannot omit a path. Adopted. Corollary stated above: the three IG bugs stop being prerequisites.

**Resolution 4 — the invariant is a ratio, and it is time-averaged over the reachable set.** D3's `H = TTK_now / TTK_native` is host-scale-free and is adopted as the headline. But **every one of the four analytic invariants is defeated by E1**, exactly as the correctness judge constructed. The fix is not a rolling average alone (E1 against an all-physical enemy still passes a naive time-average, because ten elemental types sit idle and open). The fix is:

> **M1: `max over t ∈ reach(B) of openBar[t] ≥ SEAM_MIN`** — the time-averaged openness of at least one damage type *that a live opponent can actually deliver*.

This is new and it is the spec's own contribution. It survives the attack, and it **collapses D1's separate law-residue invariant into the same measurement**: an arena law that forbids physical actions shrinks `reach(B)`, which makes M1 bind harder — which is exactly right, and is the correct mechanical statement of "a law that closes every lethal channel is the same crime as an immunity that closes every lethal channel."

**Resolution 5 — the oracle, against the portability judge's objection.** The portability judge found a real unacknowledged failure in D3: the pricing oracle needs a multi-character party fixture and KSG has no party. Resolution, not a split: **pricing is a capability.** `host.caps.simulate` gates it. The oracle runs where it can (IG), writes `price`/`byOrgan`/`H_observed` **onto the artifact record**, and the record travels. KSG reads the stored number and never recomputes. Where no host can simulate, the **analytic estimator** (D4's `WORTH` unit + graph-cardinality for `nullify` + measured lawreach for `veto` + D2's `CERT` frequency term) is authoritative — and it is the same estimator that seeds the oracle's search, so the two never disagree by construction.

**Resolution 6 — the sustain dispute dissolves.** D2's `rho` against gross damage nerfs every healer in IG (D2 says so). D1 scopes to engine sustain but never quantifies whose ledger. Because the invariant is a **ratio**, native healing appears in both numerator and denominator and cancels. So: **the meter counts engine-sourced sustain only, keyed on the recipient** (D2's correct choice), and native potions/regen/cleric spells are untouched. Nothing in IG's balance moves.

**Resolution 7 — termination.** D4's **defiance** beats D2's **struggle**: it invents no new damage source. Adopted, and narrowed so it is strictly additive — defiance fires *only when an engine veto emptied the list*. With no facet law in force, IG's existing behaviour is byte-identical.

**Resolution 8 — the machine set, against the author's own principle.** D2 says three cells; D3 says five machines; the expressiveness judge says five names are better authoring vocabulary. Neither is the answer. **A cell has four axes (`hold`, `level`, `clock`, `exclusive`); the five machine names are readings of points in that space.** The reducer switches on axis values, never on a name. Delete a name and no cell changes; change an axis and the reducer does. This is the author's principle applied to the engine's own vocabulary, which is what the expressiveness judge's warning demanded.

**Resolution 9 — the missing axis all four designs share.** None of the four has target *selection*, while `combat.js:406 targetScore` already ships `wounded|strongest|caster|spread` and `combat.js:429` ships the taunt redirect. Scope gains a second dimension: `{ side, rank }`, where `rank` is a **host-declared ranker id**. IG's rankers are its own `targetScore` arms plus `lowestAlly` and `taunter`; KSG declares `front` and `random`. This closes the gap without inventing content.

**Resolution 10 — a stated principle for primitive vs sugar** (D2 admitted it had none): *a verb is a primitive iff it is the only route to a host adapter member. Everything else is sugar, defined as a data-table expansion at compile time, and the expansion is asserted in the test corpus.* `law` is sugar (`veto` at arena scope + a clock cell). `summon` is a primitive (`host.summon`). This is checkable, and it is what stops the op list growing.

---

## 2. File layout and the authoring format

### 2.1 Load-order-free authoring format

Every core file is plain `.js` with **no `import`, no `export`, no `require`**, and publishes only into `globalThis.Facet`. Each file opens with the idempotent namespace claim so **load order does not matter**:

```js
// facet.cells.js — first line of every core file
(() => {
const F = (globalThis.Facet || (globalThis.Facet = { _mods: {} }));
F._mods.cells = true;
// ... siblings are read LAZILY at call time (F.expr(...)), never captured at load time.
F.cellStep = function cellStep(cell, hook, detail, ctx) { /* ... */ };
})();
```

`Facet.install(host)` asserts every expected key of `F._mods` is present and **throws with the missing filenames**. A half-loaded engine that silently does nothing is the wrong failure mode for something carrying a mortality invariant.

**Why this works in all four environments** (each point verified, see §0):

| Environment | Mechanism | Verified |
|---|---|---|
| IG browser (`game.html`, `field.html`) | 10 classic `<script src>` tags. `globalThis === window`. No `export` (a `SyntaxError` in a classic script), no `type="module"` (module scripts are deferred and run *after* every classic script, so `combat.js`'s load-time `const R = typeof Rng !== 'undefined' ? …` captures would read `undefined`). | Matches the 46-tag pattern already in `game.html:518-563` |
| IG headless (`node --test`) | IG has no `package.json`, so `.js` is CJS and `require('./facet/facet.core.js')` executes it; `globalThis` is shared. | Ran it: `CJS require (no pkg json) -> object 42` |
| KSG `vite dev` / `vite build` | `import './facet/facet.core.js';` — **bare side-effect import only**. Vite serves/bundles the IIFE verbatim; no export rewriting is needed, which is precisely why the named-import form fails here and this one does not. | ESM side-effect import executes and publishes: `ESM side-effect import -> object 42` |
| KSG `vitest` | Same import, `environment:'node'`. | Same mechanism |
| KSG `svelte-check` | TS maps `./facet.core.js` to a sibling ambient `.d.ts`; globals declared in `declare global`. **No `allowJs`, no tsconfig change, no vite.config change.** | Ran `tsc`: exit 0, and `TS2322` still reported |

**Deliberately not used, with reasons:**
- **`module.exports` in the core.** Adding it makes Rollup wrap the reachable graph in a lazy CommonJS shim, turning eager top-level publication into invoked-on-require publication. The `globalThis`-only form is emitted byte-for-byte.
- **`window.X`.** Undefined under vitest's `environment:'node'`.
- **`require()` between core files.** Under vitest the fallback branch *is* taken and returns an empty `[Module: null prototype] {}` with **no throw** — every field reads `undefined`. IG's house convention (`combat.js:13-32`) cannot be used inside the core.
- **A named import in KSG.** `import { X } from './facet.core.js'` **passes `vitest` and fails `vite build` and `vite dev`.** `npm run verify` runs only `svelte-check && vitest run`, so this defect ships green. **Add `vite build` to `verify` (`package.json:14`).** And note the second finding: TS does not verify the `.js` path exists at all (`import './nosuch.js'` type-checks clean), so `vite build` is the *only* gate on a typo'd core path.

### 2.2 Two vendored copies, kept honest

The repos are on different drives (`path.relative('D:\\ksgproto28','C:\\Users\\…')` produces garbage) and KSG's Vite `server.fs.allow` is rooted at `D:/ksgproto28`, so a relative import across repos is impossible and a `/@fs/C:/…` fetch 403s. The core is **vendored byte-identical** in both, with `facet/MANIFEST.json` carrying a sha256 per file. Both test drivers assert the manifest; the KSG driver **skips** the cross-repo comparison when the sibling repo is absent so a fresh clone still passes. This is D1's idea and it is the only drift guard any design proposed.

### 2.3 Layout

**CORE — host-agnostic, vendored identically at `C:\Users\mersi\Documents\InfiniteGacha\facet\` and `D:\ksgproto28\src\core\facet\`:**

| File | Contents |
|---|---|
| `facet.core.js` | Namespace root, `install(host)`, module assert, `canon()`/`hash32()`, the `NULLED` sentinel, the `Expr` evaluator, the `Guard` evaluator (tri-state), the sugar expander, the clause dispatcher, `serialize`/`hydrate`, `fingerprint(ref)` |
| `facet.cells.js` | The one cell reducer over the four axes, the five readings, decks (`core:ranked`), scorers (`count`,`sum`,`poker`,`diminish`,`worstFor`), curve library |
| `facet.registry.js` | `QuantityDef` schema, `feeds`/`gates` inverse index, cycle refusal, transitive closures, the eleven quantity verbs, tri-state reads, `nullifiableSet()` |
| `facet.pipeline.js` | Named stages, `before/replace/after` joins, the per-call frame (re-entrancy safe), `engineMult`, the sealed floor, `skipStages` |
| `facet.gate.js` | Descriptor normalisation, veto/tax/redirect/transform chain, arena laws, scope+rank resolver, **defiance** |
| `facet.mortal.js` | The ledger, `openBar` EMA, `reach`, M0–M5, `prove()`, `enforce()`, the four punctures, deterministic `pickSeam()` |
| `facet.forge.js` | `generate(seed,tier)`, `fuse(a,b)`, analytic `price()`, `name()` / `render()` |
| `facet.oracle.js` | CRN-paired Monte-Carlo pricing. Inert unless `host.caps.simulate` |
| `facet.compile.js` | `compile(facet, host)` → `{defs, joins, rules, offers, overrides, hooks}`; the `StatusDef` emitter |
| `facet.data.js` | Every tuning number: `MORTALITY`, `WORTH`, `SCOPE_MULT`, `PERSIST_MULT`, `CERT_PRIOR`, `CELL_COST`, `BUDGET`, `CURVES`, `DECKS`, `SUGAR`, `READINGS`, `BANDS` |
| `facet.cases.js` | Runner-agnostic corpus: `globalThis.FacetCases = { 'name': (assert, H) => {…} }`. No runner import. |
| `MANIFEST.json` | Ordered file list + sha256 each |

**INFINITEGACHA binding — `C:\Users\mersi\Documents\InfiniteGacha\`:**

| File | Contents |
|---|---|
| `facet.host.ig.js` | The adapter. Ref↔fighter `WeakMap`, `probeSlice`/`probeNative`, `reachableTypes`, tier bags, `Rng`/`Mercy` wiring, `defineStatus` into `Elements.STATUSES`, `simulate` via `Rng.withSource` + `Combat.encounter` |
| `facet.quantities.ig.js` | The quantity registry as data. Both IG namespaces plus resistances. |
| `facet.schema.ig.js` | `descriptorSchema()`, `statusSchema()`, `vocabulary(field)`, `rankers()`, `stages()`, `channels()` |
| `test/facet.node.js` | 4-line `node --test` driver over `facet.cases.js`. IG stays a zero-install repo. |

**KSGPROTO28 binding — `D:\ksgproto28\`:**

| File | Contents |
|---|---|
| `src/core/facet/facet.*.js` + `MANIFEST.json` | byte-identical mirror |
| `src/core/facet/facet.d.ts` | `export {}; declare global { interface FacetApi {…}; var Facet: FacetApi }` |
| `src/core/facet/host.ts` | Adapter. `GameState` and `MonsterInstance` behind one bearer facade. **One `applyFacetOverrides()` called by *both* stat pipelines.** Declares `caps.simulate = false`, `caps.party = false`, `caps.mission = false`. |
| `src/core/facet/quantities.ts` | Registry over `StatKey` ∪ `SUBJECT_LIST`, resistance edges seeded from `RES_STAT_BY_TYPE`, base-formula edges beside `BASE_FORMULA_TEXT` |
| `tests/facet.test.ts` | vitest driver over the same corpus + KSG-only cases (fingerprint coverage, `getDerivedStats` never mutated, ported tick cap terminates a fully-lawed fight) |

---

## 3. The ability data schema

```js
// ============================================================================
// A FACET. Plain JSON end to end — no Map, no Set, no class, no function, no
// undefined. That is not tidiness: both hosts save by JSON.stringify of one
// blob (IG game.js:38; KSG save/save.ts:55) and both backfill missing keys on
// load, so a facet attached to a character persists in BOTH with zero new save
// code and, in KSG, one one-line migration.
//
// NAMING. "facet" and "Facet" are free as identifiers in both repos (verified).
// 'Facet' occurs once in IG names.js:73 as a token in a nickname pool — a
// string in an array, never read as anything but a string.
// ============================================================================
const FACET = {
  v: 1,
  id:   'fc_3f9c21',     // = hash32(canon(record)). Collision-asserted at install.
  seed: 0x3f9c21,        // regenerate(seed, tier) reproduces this record exactly
  tier: 3,               // 1..5. The ONLY thing that sets parameter magnitude bands.

  // ---- NAMES ARE READINGS -------------------------------------------------
  // `reading` is recomputed by Facet.render() from the axes below on every
  // draw and cached here for the UI only. Nothing in the engine reads it, and
  // it is STRIPPED before canon()/hash32(), so two facets with the same axes
  // and different names are the same facet. Delete the field and no behaviour
  // changes.
  reading: { name: 'Kindling Vow', icon: '🔥', lines: [/* see §10 */] },

  fused:   null,         // | { from:['fc_a','fc_b'], stripped:['c4','c7'], yield:0.75 }
  fusable: true,         // false once fused. Depth 1 and arity 2 are these two fields.

  // ---- STATE: 0..4 cells. One CELL type, four axes. --------------------------
  cells: [ /* Cell */ ],

  // ---- BEHAVIOUR: clauses. (hook, guard, effects). ---------------------------
  clauses: [ /* Clause */ ],

  // ---- EPISTEMICS: sparse overrides keyed by dotted path into this record. ---
  // Absent = truth is shown to everyone. Precedents: Mercy already separates
  // true from shown (mercy.js:66 says so outright); Affinity already separates
  // true from characterKnown (knownCompat, affinity.js:94). E12 is those two
  // with the honesty removed, and it is a TYPE here rather than a comment.
  lens: null,            // { shown:{ 'clauses.2.do.0.rate': 0.5 }, known:{ … } }

  // ---- LEDGERS -------------------------------------------------------------
  price:   { value: 41.6, byCell:{…}, byClause:{…}, source:'oracle'|'analytic',
             variance: 0.011, band:{…} },
  witness: { mortal:true, hCover:1.9, hSustain:1.3, hRevive:1.0, h:2.47,
             seams:['water','light'], punctures:[…], at:1740283 },

  hostOnly: null,        // e.g. 'ig' when it used a cap KSG lacks. Never generated
                         // portable-then-degraded: a facet that needs `mission`
                         // is not rolled on a host whose caps.mission is false.
};

// ---------------------------------------------------------------------------
// CELL — one type, four axes. The five machine names are READINGS of points in
// this space (see §5). The reducer switches on axis values, never on a name.
// ---------------------------------------------------------------------------
const CELL = {
  key:   'kiln',                 // facet-local

  hold:  'none',                 // 'none' | 'one' | 'many'   — what tags it holds
  level: 'real',                 // 'none' | 'int' | 'real'   — magnitude type
  clock: false,                  //                            — entries carry expiry
  exclusive: false,              // hold:'one' only            — entering evicts

  tags:  null,                   // null | ['a','b'] | {from:'vocab:<field>'}
                                 //      | {deck:'core:ranked', suits:{from:'vocab:element'}}
                                 //      | {from:'kill.tags'}  (tokens minted by an effect)

  cap:   { expr:'mul', a:{ q:'bearer.maxHp' }, b:0.45 },   // REQUIRED when level!=='none'
  floor: 0,
  decay: 0,                      // per tick, fraction of cap
  step:  1,                      // level:'int' increment

  tier:  'encounter',            // tick | encounter | mission | calendar
  scope: { side:'self' },        // see §3 Scope

  epistemic: 'open',             // 'hidden' removes it from every readout AND from
                                 // the AI's valuation, in one flag

  scorer: null,                  // {id:'poker'} | {id:'diminish', a:4} | {id:'count'}
                                 //   | {id:'sum'} | {id:'worstFor', of:'poker'}

  reading: 'accumulator',        // computed by render(); stripped before canon()

  // ---- RUNTIME. Flat JSON. See §3.1 CACHE DISCIPLINE. ----------------------
  state: { at:null, v:0.31, n:0, items:[], until:null, cd:0 },
};

// ---------------------------------------------------------------------------
// CLAUSE
// ---------------------------------------------------------------------------
const CLAUSE = {
  id:   'c3',
  on:   { at:'stage:resist', take:'value', mult:1 },   // Hook — see §4 registry
  when: /* Guard | null */ null,
  do:   [ /* Effect */ ],
  once: null,                    // null | 'encounter' | 'mission'   (firing budget)
  cost: false,                   // true = a DRAWBACK that bought budget. The only
                                 // thing fusion strips. See §7.
};

// ---------------------------------------------------------------------------
// GUARD — recursive, tri-state. TRUE | FALSE | NULLED.
//   unknown subject  -> TRUE   (fail OPEN; matches KSG triggers.ts:216-218's
//                               stale-save rationale, which is correct)
//   NULLED quantity  -> FALSE  (fail CLOSED; a nullified value must make its
//                               dependents fail, or nullification ENABLES them)
// Collapsing NULLED into TRUE is the single most dangerous available bug and
// facet.cases.js asserts the distinction in both directions.
// ---------------------------------------------------------------------------
//  { all:[Guard] } | { any:[Guard] } | { not: Guard }
//  { q:'fighter.base.speed', of:'target', op:'<=', v: Expr }
//  { cell:'kiln', of:'v'|'n'|'at'|'count', op:'>=', v: Expr }
//  { frame:'damageType', op:'in', v:['heat'] }        // the blow in flight
//  { act:'school',       op:'eq', v:'arcane' }        // the descriptor at the gate
//  { event:'onParry', within: 20 }                    // subsumes triggerOk
//  { chance: Expr }

// ---------------------------------------------------------------------------
// EXPR — recursive, data, evaluated by a ~70-line walker. No eval, no Function.
// EVERY MAGNITUDE IS RELATIVE. A bare number is legal only where the quantity
// is dimensionless (a probability, a tick count, a multiplier). IG's magic
// damage runs hotter than KSG's spell power — psionic.js:45 carries
// portScale 0.55 for exactly this reason — so an absolute constant is balanced
// in one host and broken in the other. compile() REFUSES a bare number in a
// dimensioned slot.
// ---------------------------------------------------------------------------
//  12                                        (dimensionless only)
//  { q:'derived.maxDamage', of:'value'|'frac'|'max', on:'self'|'target' }
//  { cell:'souls', of:'v'|'n'|'count'|'cap'|'frac' }
//  { frame:'amount'|'type'|'attacker'|'victim' }
//  { roll:[lo,hi] }                          // uniform int via host.rand
//  { pick:'uniform'|'weighted', from: TableRef | RegistryQuery }
//  { curve:'diminish'|'ramp'|'harmonic'|'geometric'|'sqrt'|'step', of:Expr, a:4, b:0.8 }
//  { expr:'add'|'sub'|'mul'|'div'|'min'|'max'|'floor'|'clamp'|'frac'|'pow', a:Expr, b:Expr }
//  { if:'$binding', then:Expr, else:Expr }   // $bindings written by roll / score
//  { lens:'luck' }                           // reads the epistemic triple by view

// ---------------------------------------------------------------------------
// SCOPE — two dimensions. All four candidate designs had only the first, while
// combat.js:406 targetScore already ships wounded/strongest/caster/spread and
// combat.js:429 ships the taunt redirect: the HOST was more expressive about
// targeting than any proposed engine.
// ---------------------------------------------------------------------------
const SCOPE = {
  side: 'self'|'ally'|'party'|'enemy'|'arena'|'world',
  rank: null,          // null = every member of the side.
                       // Otherwise a HOST-DECLARED ranker id from host.rankers().
                       // IG declares: wounded, strongest, caster, spread, weakest,
                       //   lowestAlly, taunter, front, random.
                       // KSG declares: front, random.
  n: 1,                // how many, after ranking. null = all.
  exclude: [],         // 'self' | 'ally' | 'summon'
};

// ---------------------------------------------------------------------------
// EFFECT — { emit:<target>, … }. Six emission targets; see §3.2.
// ---------------------------------------------------------------------------
```

### 3.1 CACHE DISCIPLINE (mandatory, and it is a verified constraint)

KSG's `modFingerprint` (`derived.ts:589`) folds in `s${id}:${effectiveIntensity(s)}:${s.stacks}` for every status — **but not `held.data`.** Therefore:

> **A compiled status's `mods` may read only `intensity` and `stacks`. Never `data`.**

Consequences the compiler enforces:
- An accumulator's fill is carried as the carrier status's **`intensity`**.
- A collection's count is carried as **`stacks`**; its **score** is written into `intensity` when it scores.
- A collection's *contents* live in `held.data['fc:<key>:<tag>']` (the exact shape `recordGraft` already uses at `elements.js:172-179`, and the shape KSG's `StatusInstance.data` carries) and are read **only at score time**, which then writes `intensity`.

With that discipline, **status-borne facet state is cache-correct in KSG for free**, which is the single largest cost saving in the whole design. Facet state that is *not* status-borne — the override table — is not covered, so the KSG adapter contributes exactly one line to `modFingerprint`, and it lands in the commit that introduces overrides (commit 4), not commit 1.

### 3.2 The six emission targets

| `emit` | Compiles to | Host member |
|---|---|---|
| `'status'` | A `StatusDef` registered into the host's `STATUSES`, or a `StatusApplication` on a target | `defineStatus`, `applyStatus` |
| `'quantity'` | A timed override in the host's own modifier path | `overrideQ` / `clearOverrides` |
| `'stage'` | A named join on the damage pipeline | `joinStage` |
| `'gate'` | A veto/tax/redirect/transform rule, or an offered descriptor | (in-core; the host calls `Facet.gate`) |
| `'world'` | `damage`, `heal`, `summon`, `dismiss`, `revive`, `mark`, `log` | one member each |
| `'cell'` | A cell verb on own state | (in-core) |

**`emit:'status'` is the expressiveness escape hatch, and it is the answer to the expressiveness judge's warning that "every design is strictly less expressive than IG's hand-authored StatusDef."** Its `def` payload is a fragment validated against `host.statusSchema()` — a host-declared table naming each `StatusDef` field with a `kind` (`mod|res|dot|veto|reactive|ladder|meta`), a `mortality` role, and a value grammar. The generator draws from declared fields; the prover reads the roles. So `soaked`'s `overrideRes` / `converts` / `amplifies` / `capOverrides`, `jolted`'s `bar.onFill` and `stacking.escalateFrom`, `seeded`'s `grafts`/`tends`, and `magnetized`'s `magnetism` are all **generable**, and the vocabulary grows by the host *describing more of itself* rather than by the core growing verbs.

---

## 4. The registries — CORE vocabulary vs HOST supply

| Registry | Owner | Why |
|---|---|---|
| Cell axes (`hold`,`level`,`clock`,`exclusive`) | **CORE** | The machine algebra |
| Scorers, decks, curves | **CORE** | Pure combinatorics; they name nothing game-specific |
| Verbs (30) | **CORE** | Each is the sole route to an adapter member; sugar is data |
| `Expr` / `Guard` node kinds | **CORE** | The language |
| Persistence tiers | **CORE** names, **HOST** bags | `tick / encounter / mission / calendar` |
| Scope *sides* | **CORE** names, **HOST** resolves | `self / ally / party / enemy / arena / world` |
| Scope *rankers* | **HOST** | IG has 9; KSG has 2 |
| Damage channels | **HOST** | `host.channels()` partitions the host's own types |
| Pipeline stages | **HOST** | `host.stages()` — the union, each host omits what it lacks |
| Descriptor fields | **HOST** | `host.descriptorSchema()` |
| **Predicate values** | **HOST** | `host.vocabulary(field)` — **the generator's entire content supply** |
| `StatusDef` fields | **HOST** | `host.statusSchema()` |
| Quantities | **HOST** | The two hosts' stat namespaces do not line up at all |
| Hook points | **CORE** shape, **HOST** membership | `stage:*` and `event:*` from host lists; `gate:*`, `tier:*`, `tick` are core |

**This is D1's central idea and it is what makes E7 honest.** The generator builds `{ act:'element', op:'eq', v:'water' }` by drawing the *field* from `descriptorSchema()` and the *value* from `vocabulary('element')`. The core contains neither the word "water" nor the physical partition. Declare a fifteenth damage type in IG and the generator immediately emits immunities, absorbers and laws over it with **zero core edits**. D2's five hand-written `LAW_CLAUSES` rows — the fake the expressiveness judge caught — do not exist here.

### 4.1 Quantity registry

```js
const QuantityDef = {
  id:    'fighter.base.speed',
  label: 'Speed',                  // rendering only
  kind:  'attribute'|'scalar'|'prob'|'mult'|'flat'|'rate'|'pool'|'cap'|'mode'|'veto',
  dimensioned: true,               // false => a bare number is legal in Expr slots

  from:  ['stat.eff.dex'],         // the REAL read set, audited (see below)
  feeds: ['fighter.bar'],          // downstream ids (inverse index built at install)
  gates: ['fighter.bar'],          // the SUBSET of feeds where a zero REMOVES an
                                   // option rather than shrinking a number.
                                   // E6 may only target quantities with gates.length>0.

  nul:   0,                        // what nullify writes. NOT always 0: a multiplier
                                   // slot nuls to 1.
  clamp: [0, null],
  nullifiable: true,               // attributes and hp are false — which is what makes
                                   // E6's "non-HP, non-attribute" a QUERY, not a list
  writable:    true,               // SEPARATE from nullifiable. E11 scales attributes
                                   // (writable) while E6 may not null them.
  sealed: false,                   // resistCap, damage.floor: no `replace` may target it
  mortalRole: null,                // null | 'coverage' | 'sustain' | 'vitality' | 'evade'
  namespace: 'fighter',
};
```

**IG's seed registry** (`facet.quantities.ig.js`), covering **both** IG namespaces plus the third that lives behind a string prefix:

1. **Six attributes** `stat.eff.{str,dex,con,int,wis,cha}` — `nullifiable:false`, `writable:true`.
2. **`stats.js` DERIVED, all 18** — with `from` **corrected**: `minDamage.from = ['stat.eff.dex','stat.eff.str']`. `stats.js:50` reads both and declares only `dex`; a graph built off the existing `stat` field is quietly wrong and E6's closure would silently under-nullify. `equipLoad`, `walkSpeed`, `cooldownReduce`, `rewardMod` carry `feeds:[]` (verified: zero consumers outside `stats.js`).
3. **The 13 `f.base` combat keys** (`combat.js:83`, `:114`). `staminaRegen`/`manaRegen`/`maxHp` are multiplier slots with `nul:1` and `from:[]`; `maxHp` carries `feeds:[]` (`stats(f).maxHp` is written by `corrupted` and read by nothing).
4. **The 14 resistances** `fighter.res.<type>`, `namespace:'res'`, `mortalRole:'coverage'`. In IG these are a genuinely separate namespace: `stats()` drops every `res:` mod (`combat.js:126`) and only `bearerResistance` reads them.
5. `fighter.resistCap` — `writable:false, sealed:true`; `fighter.ward` — `mortalRole:'coverage'`, `clamp:[0, 0.5×maxHp]` (**this design is its first writer**); `fighter.armor` (the `f.base.armor` edge, honestly recorded as currently inert).
6. **Nine pool quantities** `pool.{mana,stamina,focus}.{cur,max,regen}`.
7. `fighter.bar`, `fighter.position` (`kind:'mode'`), `fighter.rank`, `fighter.hp`/`maxHp` (`nullifiable:false`, `mortalRole:'vitality'`), `fighter.dodge`/`parry` (`mortalRole:'evade'`).

**The `from` graph is authored data and it will rot** — `stats.js:50` proves it already has. Mitigation: `facet.cases.js` carries a **graph audit** that instruments each registry entry's `read()` through a recording proxy and fails if the touched id set differs from the declared `from`. That catches a wrong edge on any quantity the corpus exercises. It does not catch one the corpus never touches, and I say so rather than pretending otherwise.

### 4.2 Pipeline stages

`host.stages()` returns the ordered union; a host omits what it lacks.

```
raw → crit → armor → resist → absorb → engine → ward → floor
```

- `absorb` is **new in both hosts** and is where accumulators intercept.
- `engine` is **not joinable**. It is the terminal application of the frame's accumulated engine multiplier and is where invariant M2's per-blow clamp lives.
- `floor` is **sealed**: no `replace`, and any `after` join must be *monotone non-decreasing in `frame.value`*, checked **structurally** by walking the `Expr` tree over its 14 node kinds (D2's idea, and the most rigorous single guard any design proposed).
- `crit` is currently applied by the *callers* in both hosts (`combat.js:222`, `:276`; `combat.ts:3441`) and is lifted into the pipeline in commit 3, preserving the exact per-hit `crit → variance → slice → sum → one floor` sequence and the single side-effecting `consumeMagnetCharge` per hit.
- KSG's two documented asymmetries survive as **stage parameters**, never tidied away: `floor: 0|1` and `penetration: on|off`. `combat.ts:1195-1202` says raising the monster floor "would change every fight in the game," and the file records that these twins already drifted apart once.

### 4.3 Action-descriptor fields

`host.descriptorSchema()` declares the fields; the gate is generic over field *names* and blind to field *values*.

```js
{ fields: {
    kind:       { kind:'enum', lethal:false },
    family:     { kind:'enum' },
    school:     { kind:'enum' },
    element:    { kind:'enum', nullable:true },
    elements:   { kind:'set' },        // EVERY strike type, not just strikes[0] —
                                       // E7's "no water spells" needs the whole set
    damageType: { kind:'enum', lethal:true },
    damageClass:{ kind:'enum', lethal:true, derived:'classOf(damageType)' },
    scope:      { kind:'scope' },
    cost:       { kind:'cost' },
    reach:      { kind:'bool' },
    heals:      { kind:'bool' },
    cooldownKey:{ kind:'key' },
    value:      { kind:'lens' },       // the epistemic triple lives here
    exec:       { kind:'exec' },       // host executor id or an Effect list
  },
  lethalField:'damageType', costField:'cost' }
```

### 4.4 Verbs (30 primitives + sugar)

| Family | Verbs |
|---|---|
| cell (10) | `set` `add` `enter` `draw` `discard` `score` `latch` `release` `reset` `decay` |
| quantity (11) | `nullify` `freeze` `clamp` `scale` `add` `invert` `swap` `copy` `drain` `redirect` `desync` |
| stage (2) | `join` `skip` |
| gate (5) | `veto` `tax` `redirect` `transform` `offer` |
| world (7) | `status` `damage` `heal` `summon` `dismiss` `revive` `mark` |
| meta (2) | `roll` `fuse` |

**Sugar** (`facet.data.js SUGAR`, expanded at compile time, expansions asserted in the corpus): `law` → `gate.veto` at `scope.side:'arena'` + a `clock` cell; `absorb` → `stage.join` at `absorb` + `cell.add`; `buff` → `world.status` on self with `buff:true`; `mode` → a `hold:'one', exclusive:true` cell + per-state `while` clauses.

*Principle:* a verb is a primitive **iff** it is the sole route to a host adapter member. `summon` reaches `host.summon`; `law` reaches nothing `veto` does not. Checkable, and it is what stops "op 27."

---

## 5. Machines — one cell, four axes, five readings

```js
// facet.cells.js — cellStep(cell, verb, arg, ctx) -> { changed, bindings }
// ONE reducer. It switches on cell.hold / cell.level / cell.clock, never on a
// name. The five names below are produced by render() and are read by nobody.
```

| Reading | `hold` | `level` | `clock` | `exclusive` | `scorer` |
|---|---|---|---|---|---|
| **mode** | `one` | `none` | false | **true** | — |
| **latch** | `one`/`many` | `none`/`int` | **true** | false | — |
| **accumulator** | `none` | `real` | false | — | — |
| **counter** | `none` | `int` | false | — | — |
| **collection** | `many` | `int` | false | — | required |

### 5.1 The reducer, verb by verb

**`enter(tag)`** — legal when `hold==='one'`.
```
if (cell.state.cd > 0) return { changed:false };
if (cell.state.at === tag) return { changed:false };
prev = cell.state.at;
cell.state.at = tag; cell.state.since = ctx.tick; cell.state.cd = cell.cooldown|0;
// COMPILED FORM: exclusive:true does NOT rely on blockedBy.
//   VERIFIED (§0): blockedBy REFUSES APPLICATION while a blocker is held
//   (elements.js:196), so two mutually-blockedBy statuses lock on whichever
//   lands first and never switch. D4's "exclusivity for free" is false.
//   The compiler emits: host.removeStatus(ref, carrierId(cell, prev))
//                       then host.applyStatus(ref, {id: carrierId(cell, tag), …}).
//   `blockedBy` is still emitted, as a belt against a third writer.
return { changed:true, bindings:{ '$from': prev, '$to': tag } };
```

**`add(x)`** — legal when `level!=='none'`, `hold==='none'`.
```
cap = evalExpr(cell.cap, ctx);
want = level==='int' ? Math.round(x) * (cell.step||1) : x;
before = cell.state.v;
cell.state.v = clamp(before + want, cell.floor|0, cap);
took = cell.state.v - before;                 // what actually fit
if (cell.state.v >= cap) fire('cap');         // hook 'cell:<key>:cap'
// CACHE DISCIPLINE: v is written straight onto the carrier status's intensity.
host.setStatusIntensity(ref, carrierId(cell), cell.state.v);
return { changed: took !== 0, bindings:{ '$took': took, '$spill': want - took } };
```

**`draw(n, from)`** — legal when `hold==='many'`.
```
for i in 0..n-1:
  tok = from.deck ? drawDeck(from, host.rand)          // core:ranked = 13 ranks x host suits
      : from === 'kill.tags' ? ctx.detail.victimTags    // one token per tag
      : host.weightedPick(resolveTable(from));
  if (cell.state.items.length >= cap) evict();          // FIFO unless scorer says otherwise
  cell.state.items.push(tok);
cell.state.n = cell.state.items.length;
host.setStatusStacks(ref, carrierId(cell), cell.state.n);   // stacks, not data
host.setStatusData(ref, carrierId(cell), tokenCounts(cell)); // contents in data; no mod reads them
```

**`score(scorerId)`** — pure over `state.items`, writes `intensity`, returns bindings.
```
r = SCORERS[scorerId](cell.state.items, cell.scorer);   // { rank, weight, tags, aim }
cell.state.v = r.weight;
host.setStatusIntensity(ref, carrierId(cell), r.weight);
return { changed:true, bindings:{ '$rank':r.rank, '$weight':r.weight, '$aim':r.aim } };
```

Core scorers (they name nothing game-specific, which is why the core is allowed to own them):
- `count` → `{ weight: items.length }`
- `sum` → `{ weight: Σ token.worth }`
- `diminish{a}` → `{ weight: a/(a+n) }` (also `harmonic`, `sqrt`, `geometric` in `CURVES`)
- `poker` → best of `{same:2|3|4}`, `{run:5}`, `{sameSuit:5}`, `{straightFlush}`, `{fullHouse}` over `(rank, suit)` pairs. **The ordered dimension is core-owned** (`core:ranked` supplies integer ranks 2..14); **suits are `host.vocabulary('element')`**. This is the only honest account of where poker ranks come from — D2 and D3 both hand-wave `{run:n}` over unordered tags, and D3's `{run:n}` over `tags:['hearts','rank9']` would force the scorer to *parse a name*, which is exactly what the author's principle forbids.
- `worstFor{of}` → the index set whose removal most improves `of`'s score. Greedy single-card replacement, evaluated once per candidate. **Declared as a heuristic, not as data**, because it is one.

**`latch(what, ticks)` / `release()`** — `clock:true`. Entries are `{ t, v, until }`; `tick` decrements `until` and fires `cell:<key>:release` on expiry. `maxHeld = cap`.

**`decay()`** — per tick: `v -= cell.decay * cap` (real), or `until--` (clock), or nothing.

**`reset(tier)`** — the host calls `Facet.tierEnd(tier, ref)`; every cell whose `tier` matches is reset to its `init`. This is the persistence table IG's single reset line (`combat.js:606`) has never had — and note that line *already* misses `f.charged`.

### 5.2 Why not five machine types

The author's own rule: *"Add a name and no character changes; change an axis and every system does."* A `mode` and a `latch` differ in whether the held tag has a clock. An `accumulator` and a `counter` differ in whether the magnitude is real or integral. Naming those four differences produces four reducers that must be kept in step; naming the *axes* produces one. The five names survive as **readings** because they are better authoring vocabulary — which is what the expressiveness judge's warning asked for — and `render()` computes them from a five-row table in `facet.data.js`.

---

## 6. The host adapter interface

```js
// ============================================================================
// Facet.install(host). Thirty-eight members. install() validates every one and
// THROWS with the missing names — the one place the core is allowed to be
// noisy, because IG's optional-thunk convention (combat.js:22-32) produces a
// game that runs with the feature silently doing nothing, which is fine for a
// potion module and wrong for something carrying a mortality invariant.
//
// TWO RULES THAT MAKE THE BOUNDARY REAL:
//  1. The core never holds a host object. Combatants are opaque string refs.
//     Consequence: core state is always plain JSON and survives both savers.
//  2. The core never WRITES a host object. It hands the host an override, a
//     status application or a modifier line, and the host applies it.
//     Consequence: KSG's frozen shared DerivedStats (derived.ts:663-666,
//     "treat the result as frozen — it is shared by every caller") is never
//     mutated, and the Svelte $state proxy trap (docs/PITFALLS.md §1) cannot
//     bite, because every lazy `??=` happens on the HOST's own line in bag().
// ============================================================================
Facet.install({

  // ---- identity and capabilities -----------------------------------------
  id: 'ig',                       // 'ig' | 'ksg'
  ticksPerSecond: 10,             // 10 in BOTH (elements.js S=10; loop.ts TPS=10).
                                  // Durations are AUTHORED IN SECONDS and converted
                                  // here. Never author ticks: IG's OUTER game tick is
                                  // 10 s (game.js:8) and KSG's is 100 ms.

  // Declared, not silently degraded. generate() REFUSES to roll a facet whose
  // scope, tier or verb the host cannot MEAN — rather than rolling it and
  // printing a caveat. KSG declares party:false (the player is a singleton
  // GameState; triggers.ts:82 hardwires enemies[0]) and mission:false (the
  // model is spot -> encounter -> travel, with no mission tier at all).
  caps: { party:true, ally:true, arena:true, mission:true, calendar:true,
          summon:true, revive:true, simulate:true, laws:true },

  encounterCap(),                 // -> max ticks or Infinity. install() REFUSES any
                                  // arena-law clause when this is Infinity. IG has
                                  // 900..3600 (combat.js:622); KSG's tickCombat has
                                  // none and must gain one before laws ship.

  // ---- randomness: the one place the hosts differ in KIND -----------------
  rand(),                         // IG: Rng.rand (crypto, unseedable).
                                  // KSG: rand(state) (seeded mulberry32).
  pick(a), weightedPick(a, wf),
  proc(ref, key, rate, mercy),    // drought-smoothed bool.
                                  // IG: Mercy.procChance(f.ledger, key, rate)
                                  // KSG: procChance(state, key, rate)
  curveRate(ref, key, rate, mercy, cap),
                                  // The BIASED RATE, for E12. VERIFIED: mercyCurve
                                  // (mercy.js:46-61) bisects so the achieved long-run
                                  // rate EQUALS the authored rate. Growing the `mercy`
                                  // dial changes VARIANCE, not luck. To cheat you must
                                  // drift `rate`; mercy then evens THAT. D4's E12 is a
                                  // no-op and must not be carried forward.
  withSeed(seed, body),           // IG: Rng.withSource(mulberry32(seed), body)  [rng.js:68]
                                  // KSG: save/restore state.rngState
                                  // Required only when caps.simulate.

  // ---- bearers, scope and ranking ----------------------------------------
  now(),
  bearerId(ref), isAlive(ref), sideOf(ref), levelOf(ref),
  hp(ref), maxHp(ref),
  personOf(ref),                  // the object that survives an encounter, or null
  resolve(fromRef, scope),        // {side, rank, n, exclude} -> [ref]. The RANKER is
                                  // host-declared; this is the axis all four candidate
                                  // designs lacked while combat.js:406 already had it.
  rankers(),                      // -> ['wounded','strongest','caster','spread','weakest',
                                  //     'lowestAlly','taunter','front','random']
  degradations(),                 // -> { party:'self', mission:'encounter' } or {}

  // ---- quantities ---------------------------------------------------------
  quantities(),                   // -> QuantityDef[]
  readQ(ref, qid),                // host-native, BEFORE facet overrides
  overrideQ(ref, qid, spec),      // {mode:'nullify'|'freeze'|'clamp'|'scale'|'add'|'set',
                                  //  value, min, max, ticks, sourceId} | null to clear
  clearOverrides(ref, sourceId),
  touchQ(ref),                    // Cache invalidation. KSG: contribute the override
                                  // table's hash to modFingerprint (derived.ts:589 —
                                  // its own header states the contract in capitals and
                                  // names tests/derivedcache as the tripwire).
                                  // IG: a no-op; stats(f) is uncached.

  // ---- statuses (the compile backend) -------------------------------------
  statusSchema(),                 // -> the host's StatusDef field table. THIS is what
                                  // lets a generated facet reach overrideRes, converts,
                                  // amplifies, capOverrides, grafts, tends, magnetism,
                                  // bar.onFill, retaliate, healCap, expiresTo.
  defineStatus(def),              // idempotent register into the host's STATUSES Record
                                  // (mutable in both: elements.js:43, statuses.data.ts:23).
                                  // Called from install() and rebuilt from the stored
                                  // facet records on load — a generated def is NEVER
                                  // serialised.
  applyStatus(ref, app, source), removeStatus(ref, id), findStatus(ref, id),
  setStatusIntensity(ref, id, v), setStatusStacks(ref, id, n), setStatusData(ref, id, o),

  // ---- damage pipeline ----------------------------------------------------
  stages(),                       // -> [{id, order, mitigating, joinable, sealed, floor?}]
  channels(),                     // -> [{id:'heat', group:'magical'}, …] — a PARTITION of
                                  // the host's own damage types
  classOf(type),                  // 'physical' | 'magical'
  joinStage(stageId, phase, fn, owner),   // -> unjoin
  slice(ref, type, raw, pen, hit),        // the staged pipeline; `hit` carries
                                          // {attacker, source, descriptor, skipStages, facetId}
  applyDamage(ref, amount, type, source, attackerRef),
  applyHeal(ref, amount, kind, source, facetId),
  refBlow(ref),                   // a REFERENCE blow magnitude for this bearer, in the
                                  // host's own units. IG: stats(attacker).damage averaged
                                  // over live opponents. Used only as the probe's `raw`;
                                  // it cancels out of every ratio.

  // ---- MEASUREMENT: the two calls the mortality proof rests on ------------
  probeSlice(ref, type, raw),     // dealt, WITH facet effects live
  probeNative(ref, type, raw),    // dealt, with EVERY facet-sourced effect suspended.
                                  // IG: detach facet-marked statuses + the override table
                                  // for the duration of one pure slice(), restore in a
                                  // `finally`. slice() is pure (verified) and this is
                                  // never called from inside another slice (§7 rule).
  reachableTypes(ref),            // -> Set<DamageType> the LIVE OPPONENTS of `ref` can
                                  // currently deliver through a non-vetoed action.
                                  // Reads plans and monster defs DIRECTLY; it must never
                                  // run the host's own candidate builder. (IG's options()
                                  // sits one call from E.consumeMagnetCharge, which
                                  // REMOVES a status — a speculative pass that ever
                                  // reached it would silently eat the charge.)

  // ---- the action gate ----------------------------------------------------
  descriptorSchema(),
  vocabulary(field),              // legal values per descriptor field. THE GENERATOR'S
                                  // ENTIRE CONTENT SUPPLY.
  describe(ctx, ref, candidate),  // host candidate -> descriptor
  execute(ctx, ref, targetRef, descriptor),
  poolOf(ref, pool), spendPool(ref, pool, amount),
  cooldownOf(ref, key), setCooldown(ref, key, ticks),

  // ---- world --------------------------------------------------------------
  summon({ tagQuery, level, ttl, side, scale }),   // TAG QUERY, never monster ids:
                                  // IG slime / slime_ice / slime_soldier / spider_queen
                                  // are KSG slime_base_basic / slime_ice_basic /
                                  // slime_soldier_spear / giant_spider_queen, while every
                                  // tag IG uses is registered in KSG bestiary.data.ts.
  dismiss(ref), isSummoned(ref),
  revive(ref, hpFrac, priceRecord),
  writeCalendar(person, entry),   // NEVER c.stats.base. stats.js:120-131 is explicit that
                                  // base is who the character IS. IG writes beside
                                  // condition.js; KSG writes a calendar-tier status.
  readCalendar(person),

  // ---- persistence --------------------------------------------------------
  bag(tier, ref),                 // plain JSON the core owns. THE HOST does the lazy init
                                  // ON ITS OWN LINE:
                                  //     obj.facet ??= {};  const b = obj.facet;
                                  // never `const b = (obj.facet ??= {})`, which lands on
                                  // the raw object and is invisible through the Svelte
                                  // $state proxy — a bug unit tests structurally cannot
                                  // catch (they use unproxied plain objects).
  onTierEnd(tier, fn),

  // ---- pricing (only when caps.simulate) ---------------------------------
  buildFixture(band),             // -> a runnable encounter from synthetic archetypes
  runEncounter(fixture),          // -> { won, ticks, subjectHpFrac, partyHpFrac,
                                  //      deaths, poolSpendFrac, subjectTtk }
  priceScale(),                   // -> the host's own currency multiplier

  // ---- output -------------------------------------------------------------
  log(line), trace(frame, stageId, before, after, why),
});
```

### 6.1 What the host calls back — thirteen entry points, most one line

```
Facet.install(host)                      once, at load
Facet.attach(ref, facets)                fromCharacter / fromMonster
Facet.detach(ref)
Facet.tick(ref)                           tickFighter — advances cells, decays, clocks,
                                          integrates openBar, processes dirty flags
Facet.event(evId, ref, detail)            markEvent + onDeath + heal + damageTaken
Facet.stage(stageId, frame) -> frame      inside slice()
Facet.gate(ctx, ref, descriptors)         BEFORE the host's value passes
Facet.encounterStart(refs) / encounterEnd(result)
Facet.tierEnd(tier, ref)
Facet.readQ(ref, qid) -> {ok, value, by}  TRI-STATE
Facet.dirty(ref)                          any status/buff/override mutation
Facet.fingerprint(ref) -> string           fold into KSG modFingerprint
Facet.generate / fuse / price / prove / render / serialize / hydrate
```

---

## 7. The mortality invariant system

### 7.1 The claim

For every live bearer B, define with facet effects **suspended** `TTK_native(B)` and with them **live** `TTK_now(B)`, and

> **HARDNESS  H(B) = TTK_now(B) / TTK_native(B)**
> **INVARIANT:  H(B) ≤ H_MAX = 6, at every tick, for every live bearer.**

Why a ratio: it is **dimensionless**, so it is independent of every balance number in either game. It does not care that IG's magic damage runs hotter than KSG's spell power, that `PARRY_CAP` is 0.6 here and 0.5 there, that `resistCap` is 0.75 for the party and 0.9 for monsters, or that monster hp scales 0.35/level. Every design that stated its bound in damage arithmetic produced a bound whose consequence-in-blows is host-dependent — and the correctness judge showed D1's, converted, needs ~530 blows against ~225 available in a real 900-tick 4v5.

`TTK_native` is already finite in IG by construction: `damage()` floors every landed blow at `Math.max(1, Math.round(amount))` (`combat.js:138`) **for both sides**, and hp is finite. So `H ≤ 6 ⟹ TTK_now` finite. **The engine's obligation is not to make the game lethal — it already is — but to bound by how much it may become less so.**

H factors into three, because the fourth invincibility route (an arena law that closes every lethal action) is *the same measurement seen from the other side*:

```
H(B) = H_cover(B) × H_sustain(B) × H_revive(B)      ≤ 6
```

### 7.2 M1 — COVERAGE, time-averaged over the reachable set

**This is the invariant that survives the correctness judge's attack, and it is where every candidate design failed.**

```
open[t]     = probeSlice(B, t, REF) / probeNative(B, t, REF)          ∈ [0,1]
openBar[t]  = EMA over W=50 ticks (5 s) of open[t]
reach(B)    = host.reachableTypes(B)
H_cover(B)  = 1 / max_{t ∈ reach(B)} openBar[t]        ≤ 1/SEAM_MIN = 2.857
```

**M1: `max_{t ∈ reach(B)} openBar[t] ≥ SEAM_MIN = 0.35`.**

Three properties, each load-bearing:

**(a) MEASURED, not declared.** `open[t]` is a ratio of two real slices through the host's own pipeline. It therefore captures armor, resistance, `damageTaken`, `ward`, `engineMult`, `overrideRes`, `resFloor` — **and any mitigation route added later, by anyone, including one the prover's author never thought of.** This is the decisive repair of D2 (whose multiplicative `leak` formula cannot see flat post-resist `ward`) and D4 (whose M1 theorem is stated over the `mitigate` verb while its own `res` verb reduces damage on a separate path, so `0.05 × 0.25 = 0.0125` and the theorem is false as written). It is also why the three inert IG paths are not prerequisites: a dead armor stage simply contributes nothing to *both* numerator and denominator.

**(b) TIME-AVERAGED.** Every candidate design's invariant is instantaneous and E1 — the *first* acceptance example — defeats all four. A mode that holds `physical` or `magic` but never both reads 3-of-14 or 11-of-14 closed at any instant, which passes D2's `sum ≤ 13`, passes D1's existence check *by explicit design decision* ("admits BOTH states at 1.0 unclamped"), passes D3's `max_t open[t]` measurement (the measurement is right; the quantity is wrong), and passes D4's `prove()` worst of all, since step 1 ignores the `when:{state:…}` guard entirely and evaluates both states as simultaneously live.

**(c) OVER `reach(B)`.** A rolling average alone is *not* enough, and this is the part no judge reached. E1 against an all-physical enemy still passes a naive time-average, because ten elemental types sit idle and wide open. **A seam nobody can strike is not a seam.** Restricting to what live opponents can actually deliver is what makes M1 bind on exactly the case that matters, and it simultaneously **absorbs D1's separate law-residue invariant**: an arena law forbidding physical actions shrinks `reach(B)`, which makes M1 bind *harder*. Immunity that closes every lethal channel and a law that closes every lethal channel are the same crime, and now they are the same measurement.

Worked, E1 as literally specified:
- vs. a mixed party (physical + heat + arcane): `reach = {slashing, heat, arcane}`. Sitting in `physical` mode, `openBar[heat] = 1`. `H_cover = 1`. **No puncture.** The fantasy is untouched — full physical immunity is admitted, because eleven elemental channels are open and the enemy uses three of them.
- vs. an all-slashing wolf pack with reactive flipping: `reach = {slashing}`, `openBar[slashing] ≈ 0.1 < 0.35`. **Puncture:** the seam is installed on slashing. The player reads *"the stone skin is not perfect against a blade — something always gets through."* And the fight resolves.

**Cost.** `open[]` is recomputed only when a **dirty flag** is set — by the adapter, on every status application/removal, buff push/expiry, mode transition, override write, and law enact/expire. `Facet.tick` integrates the *cached* vector into the EMA (14 multiply-adds per bearer per tick, negligible) and processes at most one dirty recompute per bearer per tick (28 pure slices). Measured shape: 30–80 dirty events per encounter ⇒ ~2,200 slices, against a baseline `C.encounter` of ~0.8 ms. **This also repairs D3's own worst flaw**, which the correctness judge found: D3 rebinds on encounter setup / mode transition / law change / death, and therefore **misses coverage that arms via a status mid-fight — including its own E3 accumulator reaching cap** — and its C3 "terminal seam stage" does not backstop it, because the seam is *installed by* puncture and no puncture ran.

**Supporting registry rows without which the measurement is defeatable:**
`fighter.resistCap` — `writable:false, sealed:true`. `fighter.ward` — `clamp:[0, 0.5×maxHp]`, tier `encounter`. `fighter.damageTaken` (KSG) — `clamp:[0.05, null]`, `nul:1`. The per-blow belt: the non-joinable `engine` stage ends with `value *= max(MIN_ENGINE_MULT = 0.05, frame.engineMult)`.

### 7.3 M2 — SUSTAIN, metered at the recipient, engine-sourced only

```
sustain(B) = engine-sourced hp restored to B + points absorbed on B's behalf, per second
threat(B)  = REF(B) × |permitted opponents| / 2s
share      = sustain(B) / threat(B)
H_sustain  = 1 / (1 − min(share, SUSTAIN_MAX_SHARE = 0.5))      ≤ 2
```

Two decisions:
- **Keyed on the RECIPIENT** (D2's correct choice, which D1 left unquantified): an ally's shield on B debits **B's** meter, so five allies each granting B 20% absorption is one measurement on B, not five unrelated legal ones. Party stacking is closed by a single choice of variable.
- **Engine-sourced only.** This is where D2's "makes all healing worse, everywhere" dissolves. Because H is a *ratio*, native healing appears in `TTK_native` and `TTK_now` alike and cancels. IG's potions (`consume.js:74`, which bypass `heal()` entirely), cleric spells and field regen (`sortie.js:374`) are untouched, and **no existing balance moves.**

Enforcement: one function in front of every engine sustain path.
```
spendSustain(B, want) {
  allowed = max(0, budget(B) - B.facetSustainSpent);
  got = min(want, allowed); B.facetSustainSpent += got; return got;
}
```
Called by `world.heal`, by `cell.add` on an absorbing accumulator, and by every `stage.join` at a mitigating stage (charged with the vitality it actually saved — the frame carries the value it was about to deal, so this is *measured*, not estimated). When the budget empties, sustain verbs become the identity for the rest of the encounter, which is legible in play: **a full kiln stops absorbing and the fire gets through.**

This matters because `healAllowance` returns **Infinity** unless a `blazing`/`blaze_burn` status happens to be held (verified live) — there is no throughput bound in either game today.

### 7.4 M3 — REVIVES: bounded, schema-forbidden in-encounter, self-consuming

- `revive`'s schema **has no `when:'now'`**. A revive never resolves inside an encounter; the only legal values are `'encounterEnd'` and `'missionEnd'`. Structural, not a runtime counter.
- `H_revive = 1 + revivesRemaining ≤ 2`, so `REVIVE_CAP = 1` per mission per bearer and `≤ min(2, party.length − 1)` per facet. *(D3's stated theorem said `1 + remaining ≤ 2` while its `REVIVE_CAP_MISSION` was 2, which yields 3; the correctness judge caught it. Fixed here by pinning the cap to the bound, not the other way round.)*
- **The SCAR:** each revive spent permanently raises the seam floor on the revived bearer's widest-open reachable type for the rest of the mission. Reviving makes you measurably easier to kill afterwards.
- **A revived bearer's `facetSustainSpent` does NOT reset** — D1's one uniquely correct rule, closing the revive-as-throughput-reset loop that D2, D3 and D4 all leave open. Graft verbatim.
- There is no verb that could express "cannot drop below 1 hp": `stage:floor` is a legal **hook** and an illegal **effect target**, and the schema validator rejects any effect naming it.
- Summons are not revivable (`host.isSummoned`), closing the infinite-body loop.

### 7.5 M4 — reach is never empty (DEFIANCE)

Today this route is open in IG **with no facet at all**: if `statusBlocks(f,'attack')` and `(f,'spell')` both hold, `options()` returns `[]`, `chooseAction` returns `null` (`combat.js:399`), `act()` returns silently **after the bar was spent** (`combat.js:589`), and both sides stall to the tick cap, which `sortie.js` scores as a *stalemate*, not a death.

**Rule.** `Facet.gate` partitions candidates into `legal` and `vetoedByFacet`. If `legal` is empty **and at least one facet veto fired**, the gate returns exactly one **defiant** descriptor: the highest-valued vetoed candidate, `lawExempt:true`, executed with a self-cost of `max(1, MIN_DEFIANCE × maxHp)` applied to the actor *before* the action resolves. `compile()` refuses any veto whose `penalty.hpFrac < MIN_DEFIANCE = 0.02` — *a rule that costs nothing to break is not a law.*

Two properties:
- **Strictly additive.** With no facet veto in force the branch never runs and IG's behaviour is byte-identical. This is D4's mechanism narrowed past D2's `struggle`, which invents a universal 1%-of-max-hp claw everyone always has — a design change the author did not ask for.
- **Termination.** At ≥2% max hp per action, a fully-lawbound field kills itself in ≤50 actions per fighter. The fight ends in a **death**, not a timeout, so the tick cap becomes a backstop rather than the only guarantee. `install()` still **refuses** arena-law clauses when `encounterCap()` is `Infinity`, which makes porting IG's `MAX_TICKS`/`MAX_TICKS_CAP` into KSG's `tickCombat` (verified: it has no cap) a **mechanically enforced precondition** rather than a follow-up.

### 7.6 M0 and M5 — registry honesty and fusion closure

**M0.** Every quantity a facet names must exist. `hp`/`maxHp`/the six attributes are `nullifiable:false`; `resistCap`/`ward` are `writable:false`/clamped; `sealed` quantities admit no `replace`. `compile()` throws on a violation.

**M5.** `fuse()` recomputes the ledger by summation and re-runs M0–M4 on the **result**. The invariant set is closed under fusion because `prove()` is total over facet records.

### 7.7 When each is checked

| Checkpoint | What runs | Cost | Catches |
|---|---|---|---|
| **C1 author/fuse time** — `prove(facet)` | Static audit: caps finite, no sealed writes, no unbounded nonrenewables, declared coverage over **all 14** types leaves one ≥ SEAM_MIN, `healRatio ≤ 0.9`, revives ≤ cap, every law has finite ticks ≤ 300, every `floor` join monotone | pure, ~O(clauses) | ~90% of violations, at zero runtime cost |
| **C2 tick time** — `Facet.enforce(ref)` | The ledger: `openBar` EMA + `reach` + sustain share + revive count → `H`. Punctures if `H > H_MAX`. | 14 EMA adds/bearer/tick + ≤28 slices per dirty bearer | **Composition, and E1** |
| **C3 door time** | The `engine` stage clamp, `spendSustain`, the revive counter, the defiance branch | O(1), unbypassable | Holds even if C1 and C2 are both wrong |
| **C4 pricing time** (`caps.simulate` only) | `H_observed` = max over bands of `median(ttk_on)/median(ttk_off)`. Punctures and reprices if `> H_MAX × 1.25`. | ~0.5–2.5 s, out of combat | A route the ledger is not positioned to see (a conditional immunity, an evade stack) |

**Rebind rule** (the repair of D3's cadence bug): the ledger is refreshed at **tick boundaries only**, on a dirty flag set by the adapter on *any* status/buff/override mutation, and **never from inside a `slice()`**. `slice` is re-entrant — `combat.js:145` calls it from inside `damage()`, which is called at `:228` right after the slice at `:224` — so the frame is per-invocation and the probe never runs while one is on the stack.

### 7.8 `enforce()` and the four punctures

```
enforce(ref):
  L = ledger(ref)
  for round in 0..PUNCTURE_MAX_ROUNDS(3):
    if L.h <= H_MAX: return L
    need  = L.h / H_MAX
    order = ['cover','sustain','revive'] sorted desc by (L[r]-1)/PUNCTURE_COST[r]
    for r in order:
      if L[r] <= 1.0001: continue
      bite = max(PUNCTURE_MIN_BITE = 0.2, 1 - 1/need)
      puncture(ref, r, bite); L = ledger(ref)
      if L.h <= H_MAX: return L
  // Terminates: each pass removes >= 20% of a route's excess and each route is
  // individually bounded (cover <= 2.857, sustain <= 2, revive <= 2), so the
  // product falls monotonically. PUNCTURE_MAX_ROUNDS caps cost only; if it is
  // ever hit the C3 doors clamp the remainder unconditionally.
```

**P1 SEAM (cover).** Install a `seam` override at the **top** of the mitigation walk for one type `t*`, forcing `open[t*] ≥ SEAM_MIN` by ignoring every *facet-sourced* mitigation of that type. **Native mitigation still applies** — the seam re-opens what the facet closed, never what the character earned. `pickSeam()` is deterministic from `facet.seed` and weighted by: (a) `SEAM_OPPOSITE[element]` — light for a shadow, water for a flame; (b) **restricted to `reach(B)`**, so the seam is always a door somebody is standing at; (c) never a type the bearer is *natively* vulnerable to, which would be free. Stored in the lens as `{true:'water', known:null, shown:'something that pours'}`.

**P2 BLEED (sustain).** Scale every facet-sourced heal and absorb by one factor until `share ≤ 0.5`. **Shown as a real number**, unlike the seam. That asymmetry is deliberate: a hidden seam is a mystery; a hidden heal rate is a lie about a figure the player watches tick by tick.

**P3 SCAR (revive).** A revive over cap is never refused — it is **converted**. The ally returns at 1 hp with a `deathbed` clock: they die at the end of the next encounter unless healed by something that is not a facet. The revive happened; the bargain got worse.

**P4 LOOPHOLE (law).** Carve a forced `except` into the law until `reach(B) ≠ ∅` for every live B. Pick the `(kind, damageType)` pair whose restoration recovers the most reachability per unit of the law's ΔU. **The law's reading does not change** — "No blade may be drawn" stays its name, and the exception is discoverable in play, not printed.

**Why puncture and not refusal** (D3's argument, and it is right):
1. A refusal is a **name-level branch** — "this combination is illegal" is precisely the hard-coded behaviour the author's headers forbid. A puncture is an **axis-level consequence**.
2. Refusal is **non-local**: whether A+B is legal depends on what else the character carries, so the same two inputs sometimes fuse and sometimes do not, with no explanation the player can act on.
3. Puncture preserves the fantasy and manufactures play: *"you are nearly untouchable — there is one way in and you do not know where it is."*

Refusal survives in exactly one place, where nobody sees it: the generator rejects **inert** and schema-invalid facets and rolls again.

### 7.9 The bound, worked

Under M1–M3, sustained pressure on B's best reachable seam from one permitted opponent:

```
net drain/sec ≥ (1 − SUSTAIN_MAX_SHARE) × SEAM_MIN × nativeDrain = 0.5 × 0.35 = 0.175 × native
TTK_now ≤ TTK_native / 0.175 ≈ 5.7 × TTK_native,  and the ledger holds the product to 6.
```

`maxHp` cancels out of every term. Against IG's real cap for a 4v5 — `min(3600, max(900, 900×9/8)) = 900` ticks — a fighter whose native TTK is ~150 ticks dies in ≤ 900. The proof does **not** lean on the cap, which matters: a timeout reports `timedOut` and `sortie.js:186` treats that as a stalemate, not a death.

### 7.10 What the proof does not cover, stated plainly

- **Evade.** Dodge, parry and miss chance never touch the damage pipeline (IG `rollHit`, `combat.js:169`), so `probeSlice` cannot see them. They are bounded by **declaration**: `H_evade = 1/(1 − min(0.5, Σ facet evade adds))`, computed analytically from emitted quantity verbs against `mortalRole:'evade'` rows, and folded into the same product. **A product is dominated by its worst factor, so the honest confidence interval on the whole proof is set by `H_evade`.** I state that rather than hide it. Mitigation: facets may not `set` an evade quantity, only `add`, and the adds are summed before the clamp.
- **Output.** Nothing here bounds how fast a facet lets you *kill*. That is a balance problem priced by the budget, and it is deliberately outside this proof.
- **Native infinities.** If a host's own healing is unbounded, `TTK_native` is already infinite and the ratio is undefined; the ledger then reports `H = 1` and the facet is innocent. That is honest and it is a host obligation, which is what `host.caps` and `sustainBudgetOf` exist to make visible.

---

## 8. The fusion operator

```
Facet.fuse(person, a, b) -> { ok:true, facet } | { ok:false, why }
```

**Structural preconditions — the only refusals, all four checkable and displayable *before* the player commits, so the button is never a trap:**
1. `a.fused === null && b.fused === null` (depth 1)
2. `a.id !== b.id` (exactly two distinct inputs)
3. the person holds both
4. a free fusion slot — mirroring `classes.js:1146 fusionSlots` / `FUSE_AT`, earned by tier-ups

**Nothing else is ever refused. Balance is never a refusal.**

**Merge, in order:**

1. **Cell union**, re-keyed `a$…`/`b$…`, clauses rewritten. Trim to `FUSE_CELL_MAX = 4` by `price.byCell` (the per-cell attribution the oracle already reports, so this is a lookup, not a judgement).

2. **Strip `cost:true`.** This *is* E8. The tag is assigned at generation from each clause's own **measured** ΔU sign, not from a hand-written list, so "conflicting abilities, penalties stripped" is a filter over a derived field rather than over authorial intent.

3. **Conflict is measured, not named.** So a *generated* pair qualifies as "two conflicting abilities" without anyone tagging it:
```
conflict = Σ over shared hooks (1 + Σ over shared targets [sign(Δa) ≠ sign(Δb)])
yield    = 0.55 + 0.10 × min(conflict, 4)          // 0.55 .. 0.95
```
Conflicting inputs fuse **better** than aligned ones. That is the fantasy, **priced** — mirroring KSG's `ArcaneConjunctionSpec.fuse` efficiency (`types.ts:~3205`), where the cap is a number rather than an assertion.

4. **Directional conflict resolution.** IG's own precedent is deliberately mixed and both halves are right about their own case, so the rule reads the **direction**, not the operator:
   - **BOON direction → MAX.** Mirrors `classes.js:1864 actMult` ("a Fighter fused with an Elemental Mage reaches for the technique like a Fighter and for the word like a mage, which is the whole fantasy").
   - **COST direction → MIN.** Mirrors `classes.js:1880 socialMult` ("fusion cannot make somebody easier to stand next to than their worst training left them").
   - This deliberately **inverts** `poolMult`/`magicMult` (`:1788`/`:1794`), which multiply so penalties compound. E8 asks for the opposite, so the anti-omnipotence guarantee **cannot be inherited from those rules** — it moves entirely to step 7.

   Per-cell:
   - two `hold:'one'` cells, either `exclusive` → **ONE exclusive cell over the union of states**. This is the single most important rule in the file: it is what stops a fused E1 holding physical *and* magical immunity at once, and it is structural rather than a check. If the restricted product (co-satisfiable state pairs only) is empty, refuse with `why:'these cannot hold at once'`.
   - two laws → one law, `veto:{any:[…]}`, `except` = the **union** (unions of exceptions weaken, which is the safe direction).
   - two accumulators on the same hook → caps MAX, decay MAX (faster decay is safe), `onCap` effects concatenate.
   - two collections → merge only if the deck matches; else both survive, subject to the trim.
   - two revive counters → caps ADD, then clamp to `REVIVE_CAP`. Clamped **here**, not left to the ledger, because a revive is a discrete event the ledger only sees after it has happened.
   - two quantity verbs on the same `q` → the stronger wins by a fixed lattice `nullify > freeze > clamp > invert > scale > add`. Two nullifies do not extend each other (max, not sum).

5. **Lens merge.** `true` merges by the above. **`known` and `shown` RESET to the pre-fusion `shown` values** — the character does not automatically know what it has become, and re-learns by use over `DISCOVER_USES = 25` (matching `affinity.js DISCOVER_TICKS`, so there is one discovery model rather than two). Pleasant second-order effect: a freshly fused character plays its own new ability badly for a while, because `chooseAction` reads `known`. A fused facet can never become **more** honest than its least honest parent.

6. **Budget.** Re-price the stripped list. Drawbacks refunded 0.7 × their worth at generation, so stripping them **raises** the price. The result must fit `BUDGET[max(tier)] × FUSE_HEADROOM (1.15)` — **not the sum of the two budgets**; that is the whole point. Two tier-3 facets (26 each) fuse into one with 29.9 of room, so roughly half the combined content survives. Overflow is shed in ascending `worth/price` order and the shed list is reported.

7. **Re-prove and puncture.** `prove()` from scratch, as if newly generated. Every violation is **clamped/punctured**, not dropped, and recorded in `witness.punctures`. So:
   - Fusing two E4s (each 55% physical coverage) yields `max(0.55,0.55)` by the boon-MAX rule, not 1.10.
   - Fusing an E4 with an E1 yields E1's full physical immunity, and **M1 admits it** because the elemental channels are open — *unless the enemy is all-physical, in which case the runtime seam fires.* This is the case that only the reach-restricted, time-averaged M1 can decide correctly.
   - Fusing two facets that each close a **different** group is the dangerous case, handled by **puncturing**: the player gets a very strong, legal, still-mortal result and a clamp line explaining it.
   - Two absorb cells sum their caps and then the *single* encounter sustain budget bounds what either can refuse. The cap got bigger; the throughput did not.

   `pickSeam()` on a fusion is biased **away** from the inputs' existing seams, so a fused facet tends to open a *second* door rather than reinforce the first.

8. `fused = {from:[a.id,b.id], stripped, yield}`; `fusable = false`. Precondition (1) makes the depth cap need no separate counter.

9. **Re-render the name** from the merged axes. A fused facet is not "A + B"; it is named for what it now *is*.

---

## 9. The pricing oracle

### 9.1 Two authorities, one stored number

`host.caps.simulate` decides. This is the resolution of the judges' only genuine three-way disagreement.

- **`simulate:true` (IG).** The oracle is authoritative. It writes `price.value`, `price.byCell`, `price.byClause`, `price.variance` and `witness.hObserved` **onto the record**. The record travels.
- **`simulate:false` (KSG).** The stored price is read and never recomputed. Where a facet has no stored price (generated on a host without simulation), the **analytic estimator** is authoritative — and it is the *same* estimator that seeds the oracle's search, so the two never disagree by construction.

This dissolves the portability judge's unacknowledged-failure finding (D3's `PriceBands` need a multi-character party fixture; KSG has no party) without weakening pricing where it can be done.

### 9.2 The analytic estimator (always available)

```
price(f) = Σ_clauses  WORTH[verb] × mag × SCOPE[side] × RANK[rank] × PERSIST[tier] × CERT[guard]
         + Σ_cells    CELL_COST[axes] × log2(1 + capInUnits) × PERSIST[tier]
         − 0.7 × Σ_{cost:true}  (the same product)
```

**Denominated in damage-equivalent WORTH** — the same unit as `Elements.statusValue` (`elements.js:367`) and the hand-authored `worth` field on all 46 IG statuses (D4's best idea). Consequences: a tooltip can honestly say *"worth about as much as three Blazings"*; and the four `AI.decide` scorers plus `options()`'s five value passes price a facet **with no new valuation code**.

- `mag` for a `status` emission is `statusValue()` on the compiled def — exact, no new table.
- `WORTH['nullify'] = 18 × (1 + |feeds| + 3|gates|)` — **value falls out of the registry**, so nullifying `fighter.base.speed` (whose `gates` closure is `fighter.bar` → the whole action path) is automatically the most expensive target in IG (D4).
- `WORTH['veto'] = 40 × lawreach`, measured against the actual descriptor space rather than guessed (D4).
- `SCOPE = {self:1, ally:1.3, party:2.0, enemy:1.5, arena:3.2, world:5.0}`; `RANK` adds 1.0–1.6 for a *chosen* target over a blind one.
- `PERSIST = {tick:0.6, encounter:1.0, mission:1.8, calendar:3.2}`.
- **`CERT = 1/(0.35 + 0.65 × P(guard holds))`** (D2) — an always-on clause prices 2.9× one gated on `hp ≤ 25%`. `P` comes from a per-quantity `CERT_PRIOR` table. **This is the frequency term D1 and D4 lack entirely, and without it a once-per-encounter latch and a per-tick counter price identically.**

*Known weakness, stated:* `cellCost` takes `log2(1+cap)` where `cap` is HP for a kiln and cards for a hand. It converges but the units are incommensurate. Fix applied: `capInUnits` is normalised — `cap / evalExpr(cap.reference)` for dimensioned caps, raw count for cardinal ones — so the log is always taken of a dimensionless ratio. That is not in any of the four designs and it is the minimum needed for the term to be sound.

### 9.3 The oracle (where `caps.simulate`)

**Common Random Numbers, paired, sequentially stopped.**

```
for each band in BANDS (weighted):
  n = 0; d = []
  loop:
    for j in 0..PRICE_BATCH(8)-1:
      seed = hash32(canon(f) ^ band.salt) + n + j
      host.withSeed(seed, () => Uoff = U(host.runEncounter(host.buildFixture(band))))
      host.withSeed(seed, () => Uon  = U(host.runEncounter(host.buildFixture(band, {bind:f}))))
      d.push(Uon - Uoff)
    n += PRICE_BATCH
    if 1.96*sd(d)/sqrt(n) < PRICE_TOL(0.02) or n >= PRICE_N_MAX(256): break
  dU[band] = mean(d)
price = priceScale() × Σ weight[band] × dU[band]
```

`Rng.withSource(fn, body)` exists at `rng.js:68`, takes a body and restores in a `finally` (verified), so this is implementable in IG **despite** IG's RNG being crypto-backed and deliberately unseedable — the swap is scoped and cannot leak. Under CRN, `Var(Uon − Uoff)` is 10–100× smaller than `Var(Uon)`, which is the difference between n≈40 and n≈2000.

**Fixtures** are data (`facet.data.js BANDS`): 5 bands (skirmish/brawl/horde/elite/boss), synthetic archetype parties from a fixed stat vector, **enemies selected by TAG, never by monster id** (four ids differ between hosts; every tag IG uses is registered in KSG's `bestiary.data.ts`). A price never depends on the player's roster, so two players never see different numbers.

**Outcome function**, also data:
```
U = 1.00·won + 0.60·hpFrac(subject) + 0.45·meanHpFrac(party)
  + 0.30·(1 − ticks/cap) − 0.20·poolSpendFrac(subject) − 1.20·partyDeaths
```
The negative death term stops a "big damage, kills an ally" facet pricing as pure upside; the pool term stops a free-cost ability pricing identically to a costed one.

**Per-cell attribution:** a second, cheaper pass re-runs the `on` arm with one cell suspended (n = one batch, tolerance ×4). Leave-one-out deltas give `price.byCell` — read by fusion's trim and by the tooltip to say **which part** of the ability is the expensive part.

**Inert rejection:** `|ΔU| < INERT_EPS (0.015)` across all bands ⇒ discard and re-roll. This is the **only** mechanism in any design that catches a generated ability whose whole payload is nullifying a dead quantity — verified necessary: `equipLoad`, `walkSpeed`, `cooldownReduce`, `rewardMod` have zero consumers, `stats(f).maxHp` is written by `corrupted` and read by nothing, and `statusBlocksRangedType` is exported and called from nowhere. Analytic fallback where simulation is unavailable: refuse `gates.length === 0` for `nullify`, and refuse any clause whose entire effect set targets `feeds:[]` quantities.

**`H_observed`:** the same runs record `subjectTtk` in both arms. `H_observed = max_band(median(ttk_on)/median(ttk_off))`. If `> H_MAX × 1.25`, puncture the dominant route and re-price (≤3 iterations). The analytic ledger is the **enforcement**; the oracle is the **audit**. Having both is how a route the ledger cannot see still gets caught.

**Cost, measured not guessed.** I timed real `C.encounter` runs at ~0.78 ms on IG's cheapest path (74 ticks mean). 5 bands × 40 pairs × 2 arms = 400 encounters ⇒ **~0.3 s floor; realistically 0.5–2.5 s** with real 4-character parties running `options()` and `castValue` every action. D3's "order 0.3 s" is a floor presented as an estimate; the honest figure is a second or two. Therefore: **the oracle runs out of combat only**, chunked across idle frames, synchronously in the test harness. Fusion is out-of-combat, so this is not a constraint on play.

**Caching:** memoised on `hash32(canon(f))` where `canon` strips `reading`, `price` and `witness` and sorts keys; versioned by `FacetData.version`, so a constants change invalidates every cached price at once.

**Calibration, honestly.** The `WORTH` numbers are hand-set for the first commit and are the least defensible part of the design. Mitigations: they live in one data file; the unit is shared with a table (`worth` on 46 statuses) the author already tuned by hand, so the first pass is *"does a tier-3 facet price near a Frozen plus a Blazing?"*, a question a human can answer by reading; and the oracle exists precisely to replace them where it can run.

---

## 10. Legality and dedup rules

Enforced by `Facet.validate(facet, host)` at generation, at fusion, and at `install()`.

**Structural**
1. `id === hash32(canon(facet))`, where `canon` strips `reading`/`price`/`witness` and sorts keys. **Ids collide iff the facets are identical**, so dedup is `id` equality. A person may not hold two facets with the same id.
2. `cells.length ≤ 3` (4 after fusion); `clauses.length ≤ 8` (12 after fusion).
3. Every `Clause.on.at` is a registered hook; every `Effect.emit` is a registered verb; every cell key referenced exists.
4. `hold:'one'` requires `tags`; `level!=='none'` requires a finite `cap`; `exclusive` requires `hold:'one'`; `scorer` requires `hold:'many'`.
5. `Expr` depth ≤ 6, `Guard` depth ≤ 5. No cycles (a cell's `cap` may not read its own `v`).
6. **Every dimensioned magnitude must be a ref, a curve or a clamp** — never a bare number. Justified by `psionic.js:45 portScale 0.55`.

**Mortality (M0)**
7. `nullify` requires `nullifiable && gates.length > 0`. `scale`/`add` require `writable`. `replace` on a `sealed` stage or quantity is refused. `stage:'floor'` is never a legal effect target.
8. Every `after` join on `floor` must be **monotone non-decreasing in `frame.value`** — a structural walk of the 14 `Expr` node kinds.
9. Every arena veto carries finite `ticks ≤ ENCOUNTER_LAW_MAX (300)` and `penalty.hpFrac ≥ MIN_DEFIANCE (0.02)`.
10. `revive.when ∈ {'encounterEnd','missionEnd'}`; `revives ≤ REVIVE_CAP`.

**Host legality**
11. A scope/tier/verb the host's `caps` denies is **refused at generation**, not degraded. `caps.mission:false` ⇒ E9 does not roll on KSG at all.
12. Predicate values must come from `host.vocabulary(field)`; `StatusDef` fragment fields from `host.statusSchema()`; rankers from `host.rankers()`.
13. Every registered compiled status id must be unique in `host.STATUSES`; **collision is an assert, not a spread-overwrite.** (KSG's `SKILLS = {...HAND_WRITTEN, ...WORD_SKILLS}` at `skills.data.ts:1585` silently shadows 20 hand-written entries today; the new registry must not inherit that failure mode.)

**Economic**
14. `INERT_EPS` (oracle) or the `feeds:[]`/`gates:[]` refusal (analytic).
15. `0.85 × BUDGET[tier] ≤ price ≤ 1.00 × BUDGET[tier]`; after 40 failed draws, drop a tier and restart.

**Fusion**
16. `!a.fused && !b.fused`; distinct; slot available; empty exclusive-product refused with a printable reason.

---

## 11. Description rendering — readings, never prose

**Rules.**
1. `render(facet, view)` is a **pure function of the record**, recomputed on every draw. `reading` is a cache and is **stripped before `canon()`**, so two facets with identical axes and different names hash the same and are the same facet.
2. **Nothing branches on a name, anywhere.** `facet.cases.js` carries an assert that permuting every `READINGS` label leaves every simulated outcome bit-identical.
3. `view ∈ {'true','known','shown'}`. The UI passes `'shown'`; `chooseAction` passes `'known'`; the rules engine passes `'true'`. Enforcement is a lint case in the corpus that greps the host adapters for `.true` outside the kernel — **weak, and I say so**: JavaScript gives no way to make this a type.
4. **Every rendered number carries its derivation.** `render` returns `{ text, terms:[{label, value, from}] }`, where `from` names a registry id, a cell key or a host quantity — so the tooltip can say *"0.45 of your fire — Kindling Vow, absorb stage, cap = 45% of your max HP (270)."* This is the author's traceability rule made structural.

**Mechanism.** Three data tables in `facet.data.js`, no prose generator:
- `READINGS.cell` — one row per axis point, giving a noun and an icon (`hold:'one',exclusive` → "a stance"; `hold:'none',level:'real'` → "a hoard").
- `READINGS.clause` — one row per `(verb, emit-target)` pair, a template with `{}` slots filled from **registry `label` strings and host vocabulary labels**, never from invented words.
- `READINGS.name` — a two-part namer: a noun drawn from the dominant cell's reading crossed with the dominant channel/element label, plus a modifier from the epistemic axis. *Kindling* (heat + accumulator) *Vow* (encounter-tier, self-scope).

**The seam is not rendered.** `witness.seams` is written into the lens as `{true:'water', known:null, shown:'<a poetic hint>'}`. The bound is on the *existence* of a kill path, not on its *discoverability* — a real limitation, stated: a player who never finds the seam experiences a punctured facet as invincible even though it provably is not. A bestiary-style discovery affordance is the right answer and this spec does not design one.

---

## 12. The twelve examples, literally encoded

Abbreviations: `S = host.ticksPerSecond` (10 in both). `@phys` = `{from:'vocab:damageClass', is:'physical'}` resolved at install into the host's own type list.

### E1 — immune to magic OR physical, never both
```js
{ tier:4, seed:0xE1,
  cells:[{ key:'skin', hold:'one', level:'none', exclusive:true,
           tags:{from:'vocab:damageClass'},          // ['physical','magic'] from the HOST
           cooldown:3*S, tier:'encounter', scope:{side:'self'} }],
  clauses:[
    { id:'c1', on:{at:'event:onHit'},
      when:{ not:{ cell:'skin', op:'eq', v:{frame:'damageClass'} } },
      do:[{ emit:'cell', cell:'skin', verb:'enter', tag:{frame:'damageClass'} }] },
    { id:'c2', on:{at:'while'},
      when:{ all:[ {cell:'skin', op:'eq', v:{frame:'damageClass'}} ] },
      do:[{ emit:'stage', at:'engine', op:'mul', value:0.0 }] } ] }
```
- **"Never both at once"** is `exclusive:true` on a `hold:'one'` cell — one boolean, no rule. **It is not `blockedBy`:** verified live that two mutually-`blockedBy` statuses lock on whichever lands first and never switch. The compiler emits `removeStatus(prev)` then `applyStatus(next)`; `blockedBy` is emitted as a belt against a third writer.
- Coverage is **full** (`0.0`), and M1 admits it unclamped whenever the enemy can reach a non-physical type. Against an all-physical enemy the runtime seam fires. *This is the example that defeats every candidate design's invariant and this spec's M1 is built to decide it.*
- **Gap:** immunity to a damage class does not stop **conditions** of that class landing — both hosts run status application through `applicationMult` with its own `APPLICATION_FLOOR = 0.25`. The generator pairs a `status`-application veto clause where `statusSchema()` declares one; where it does not, the immunity leaks conditions, and that leak is printed in the reading.

### E2 — less damage, but fixed and bypassing all defences
```js
{ tier:3, seed:0xE2,
  cells:[],
  clauses:[
    { id:'c1', on:{at:'gate:offer'},
      do:[{ emit:'gate', verb:'transform',
            match:{ act:'kind', op:'in', v:['swing','technique'] },
            set:{ fixed:{ q:'derived.maxDamage', mul:0.55 },
                  skipStages:['armor','resist','absorb','engine','ward'] } }] },
    { id:'c2', cost:true, on:{at:'stage:raw'},
      when:{ frame:'fixed', op:'!=', v:null },
      do:[{ emit:'stage', at:'raw', phase:'replace', op:'set', value:{frame:'fixed'} }] } ] }
```
- `skipStages` **can only remove mitigation**; `floor` is not in `stages()` and cannot be skipped, so a 0-damage result is still 1 hp. That is what keeps E2 from being a mortality lever.
- IG already has half of this as a **word, not an ability**: `strike.untyped` (`combat.js:280`) bypasses `E.slice` entirely, set by the spellcraft noun `zero` (`spellcraft.js:63`). This design absorbs it — `untyped` becomes a stage-skip list rather than a ternary, which also means facet stage joins are no longer silently skipped by every `zero` spell.

### E3 — absorb fire to a threshold, then expel it, harming neither allies nor self
```js
{ tier:4, seed:0xE3,
  cells:[{ key:'kiln', hold:'none', level:'real',
           cap:{expr:'mul', a:{q:'bearer.maxHp'}, b:0.45}, decay:0.002,
           tier:'encounter', scope:{side:'self'} }],
  clauses:[
    { id:'c1', on:{ at:'stage:absorb', take:'value' },
      when:{ frame:'damageType', op:'in', v:{vocab:'element', is:'heat'} },
      do:[ { emit:'cell', cell:'kiln', verb:'add', v:{frame:'amount'}, meter:'sustain' },
           { emit:'stage', at:'absorb', phase:'after', op:'sub', value:'$took' } ] },
    { id:'c2', on:{at:'while'},
      do:[{ emit:'quantity', verb:'scale', q:'fighter.base.damage',
            by:{curve:'ramp', of:{cell:'kiln', of:'frac'}, a:0.35} }] },
    { id:'c3', on:{at:'cell:kiln:cap'},
      do:[ { emit:'world', verb:'damage',
             scope:{side:'enemy', rank:null, n:null, exclude:['self','ally']},
             type:'heat', amount:{cell:'kiln', of:'v'} },
           { emit:'cell', cell:'kiln', verb:'reset' } ] } ] }
```
- **"Harms neither allies nor the user"** is `scope.side:'enemy'` — the scope axis, not an exclusion list. The resolver can never return self or allies for `'enemy'`.
- `meter:'sustain'` routes the absorb through `spendSustain`, so a full kiln stops absorbing and **the fire gets through**: the throughput bound is readable in play, not a hidden clamp.
- **CACHE DISCIPLINE:** `kiln.v` is written straight onto the carrier status's `intensity`, which KSG's `modFingerprint` covers.
- **Host obligation, flagged:** IG reports the wrong damage type at three sites — `combat.js:288` (after an `orType` swap), `:293` (hardcodes `'arcane'`), `:578` (types a summed multi-type DoT by `rep.damage[0]`). "Was I hit by fire" reads false where it should read true. The adapter must pass the **sliced** type, not the reported one; three lines in commit 3.
- **Compiles to:** one `StatusDef` with `stacking:{mode:'absorb', cap, onCap:'escalate'}` and an `escalatesTo` form carrying the burst — i.e. the `on_fire → blazing` ladder (`elements.js:52-53`) with a different payload. **The absorb-to-threshold-then-worse-thing machine already exists in the host**, and only D4 noticed.

### E4 — partially light, partially immune to physical
```js
{ tier:2, seed:0xE4,
  cells:[{ key:'lit', hold:'one', level:'none', tags:['flesh','light'],
           cooldown:8*S, tier:'encounter', scope:{side:'self'} }],
  clauses:[
    { id:'c1', on:{at:'gate:offer'},
      do:[{ emit:'gate', verb:'offer', descriptor:{
              kind:'facet', school:'facet', element:'light', scope:{side:'self'},
              cooldown:20*S, cost:{pool:'focus', frac:0.15},
              exec:[{ emit:'cell', cell:'lit', verb:'enter', tag:'light' }] } }] },
    { id:'c2', on:{at:'while'}, when:{ all:[{cell:'lit',op:'eq',v:'light'},
                                            {frame:'damageClass',op:'eq',v:'physical'}] },
      do:[{ emit:'stage', at:'engine', op:'mul', value:0.55 }] },
    { id:'c3', on:{at:'while'}, when:{cell:'lit',op:'eq',v:'light'},
      do:[{ emit:'quantity', verb:'scale', q:'fighter.base.speed', by:0.30 }] },
    { id:'c4', cost:true, on:{at:'while'}, when:{cell:'lit',op:'eq',v:'light'},
      do:[{ emit:'status', to:{side:'self'},
            def:{ mods:[{stat:'res:light', op:'add', value:-0.35}] } }] } ] }
```
- **The clearest demonstration of the axes principle:** E1 and E4 differ in a *number* (`0.0` vs `0.55`) and a cell's state count. Nothing branches on "Bodylight" or "Adamant" anywhere; swap the names and nothing changes.
- The light vulnerability is a `status` emission with a **definition** `res:` mod. Note the subtlety: `res:` mods on **buffs** are inert (`stats()` skips them at `combat.js:126`; `bearerResistance` never reads `f.buffs`), but `bearerResistance` **does** read `d.mods` (`elements.js:141`) — the *definition* mods. Compiling to a def reaches the resistance namespace without first fixing that bug. D4 gave up the resist stage for a reason that did not apply to its own mechanism.
- `cost:true` means fusion strips it. Re-admission does not object, because reduced light resistance was never what made it mortal.

### E5 — random poker hands, auto-swapping up to 2 at higher levels
```js
{ tier:3, seed:0xE5,
  cells:[
    { key:'hand', hold:'many', level:'int', cap:5,
      tags:{deck:'core:ranked', suits:{from:'vocab:element'}},
      scorer:{id:'poker'}, tier:'encounter', scope:{side:'self'} },
    { key:'mull', hold:'none', level:'int', cap:2, tier:'mission', scope:{side:'self'} }],
  clauses:[
    { id:'c0', on:{at:'event:onEncounterStart'},
      do:[{ emit:'cell', cell:'mull', verb:'set',
            v:{expr:'clamp', a:{expr:'floor', a:{expr:'div', a:{q:'facet.level'}, b:5}},
               min:0, max:2} }] },
    { id:'c1', on:{at:'gate:offer'},
      do:[{ emit:'gate', verb:'offer', descriptor:{
              kind:'facet', scope:{side:'enemy', rank:'wounded', n:1},
              cooldown:12*S, cost:{pool:'focus', frac:0.20},
              exec:[
                { emit:'cell', cell:'hand', verb:'reset' },
                { emit:'cell', cell:'hand', verb:'draw', n:5, mercyKey:'facet:$id:draw' },
                { emit:'cell', cell:'hand', verb:'discard',
                  pick:{scorer:'worstFor', of:'poker'}, n:{cell:'mull'} },
                { emit:'cell', cell:'hand', verb:'draw', n:{cell:'mull'} },
                { emit:'cell', cell:'hand', verb:'score', scorer:'poker' },
                { emit:'status', to:{side:'$aim'},
                  def:{pick:'facet.payouts', index:'$rank', permute:{seed:'facet.seed'}},
                  intensity:'$weight' } ] } }] } ] }
```
- **"At higher levels auto-swaps up to 2"** is **one `Expr` over `facet.level`**, not a level branch.
- **"Random effects"** is the payout table **permuted by the facet's own seed**, so two characters with this facet have different hands meaning different things. It is the generator, not a table of hand-written hand effects.
- **Suits are `host.vocabulary('element')`; ranks are core-owned.** This is the only honest account of where poker ranks come from, and it is why `{run:5}` does not require the scorer to parse a name.
- `mercyKey` routes the draw through `Mercy.mercyPick`, so a rare hand is drought-protected and exactly one `rand()` is consumed.
- **Gap, declared:** `worstFor` is a greedy single-card replacement — correct for pairs/trips, wrong for a four-card straight draw. It is engine code with a data-shaped label, and it is the one machine with no precedent in either repo.

### E6 — nullify a random non-HP, non-attribute value for 1 s, and everything downstream
```js
{ tier:3, seed:0xE6,
  cells:[{ key:'tick', hold:'none', level:'int', cap:1, tier:'tick', scope:{side:'self'} }],
  clauses:[
    { id:'c1', on:{at:'event:onHit'}, when:{ chance:0.18 },
      do:[{ emit:'quantity', verb:'nullify',
            q:{ pick:'uniform', from:{ registry:'query', where:{
                  nullifiable:true, gatesMin:1,
                  notKind:['attribute'], notId:['fighter.hp','fighter.maxHp'] } } },
            scope:{side:'enemy', rank:null, n:1},
            ticks:1*S, cascade:'gates' }] } ] }
```
- **"Non-HP, non-attribute" is a registry QUERY, not a blacklist**, because attributes and hp carry `nullifiable:false`. `writable` is a *separate* flag, which is why E11 may scale an attribute that E6 may not null.
- **"Effects downstream cannot trigger"** is `cascade:'gates'`: the transitive closure over `gates` edges, and `Facet.readQ` then returns `{ok:false}` so the host's trigger evaluator **fails CLOSED**. Worked from the real graph: nullify `fighter.base.speed` → `gates:['fighter.bar']` → the bar never fills → `act()` never runs → the target takes **no action at all** for one second. Deepest closure in IG from a single edge.
- `gatesMin:1` is what stops the generator picking `equipLoad`/`walkSpeed`/`cooldownReduce`/`rewardMod` — verified to have zero consumers.
- **KSG host change, non-negotiable:** `conditionHolds` returns `true` for an unknown subject (`triggers.ts:216-218`). That default is *correct* for a stale save and *exactly backwards* for a nulled quantity. It needs an explicit third state; four lines.
- `1*S` = 10 ticks = one second in **both** hosts (`elements.js S=10`; `loop.ts TPS=10`). This is the one constant that already matches.

### E7 — a rule nobody on the battlefield can break
```js
{ tier:5, seed:0xE7,
  cells:[{ key:'writ', hold:'one', level:'none', clock:true,
           tags:{from:'vocab:$lawField'},     // the FIELD is drawn from descriptorSchema();
                                              // the VALUE from host.vocabulary(field)
           tier:'encounter', scope:{side:'arena'} }],
  clauses:[
    { id:'c1', on:{at:'gate:offer'},
      do:[{ emit:'gate', verb:'offer', descriptor:{
              kind:'facet', scope:{side:'arena'}, cooldown:60*S,
              cost:{pool:'mana', frac:0.35},
              exec:[{ emit:'gate', verb:'veto', scope:{side:'arena'}, ticks:20*S,
                      match:{ act:'$lawField', op:'in', v:['$lawValue'] },
                      penalty:{ hpFrac:0.06, min:1 } }] } }] } ] }
```
- **`$lawField` and `$lawValue` are drawn at generation from `host.descriptorSchema()` and `host.vocabulary(field)`.** "No water spells and abilities" is `{act:'elements', op:'has', v:'water'}`; "no physical attacks" is `{act:'damageClass', op:'eq', v:'physical'}`. **The core contains neither the word "water" nor the physical partition.** There is no `LAW_CLAUSES` table — the hand-authored five-row table was D2's worst regression and the expressiveness judge was right to call it the effect table wearing a hat.
- **`elements`, not `element`:** E7 needs *every* strike type, which is why the descriptor schema carries a set field.
- The law is compiled to a `StatusDef` on the **arena bearer**, so it ticks, expires and stacks through the host's own `tickStatuses` with no new lifecycle code — and `statusBlocks`, generalised to take a descriptor, reads it for every fighter on both sides.
- **"Nobody" requires three IG host changes and they are the real cost of this example**: monsters short-circuit past `options()` at `combat.js:543` *before* `chooseAction`; `reflexes()` (`combat.js:557`) is a second completely ungated path, called before the bar test, with no `statusBlocks` check and no loop break; and a fully-vetoed fighter loses its turn silently with the bar already spent. Miss any one and the law binds the party only, **which is worse than having no law**.
- Termination: `ticks ≤ 300`, and defiance is `lawExempt`.

### E8 — fuse two conflicting abilities, stripping penalties
Fusion is the **operator** (§8). The facet that *grants* it:
```js
{ tier:5, seed:0xE8,
  cells:[{ key:'slots', hold:'none', level:'int', cap:1, tier:'calendar',
           scope:{side:'self'} }],
  clauses:[
    { id:'c1', on:{at:'tier:calendar'}, when:{cell:'slots', op:'>=', v:1},
      do:[ { emit:'meta', verb:'fuse',
             a:{pick:'ownFacet', by:'conflict', i:0},
             b:{pick:'ownFacet', by:'conflict', i:1} },
           { emit:'cell', cell:'slots', verb:'add', v:-1 } ] } ] }
```
- **Fusion is an ordinary verb, so E8 is an ability**, not a menu command — and a generated facet can be one that fuses your other facets. Only D2 made this move and it is the sharpest "axes not behaviours" thing in the set.
- Worked case: fuse E2 (`cost:true` on the 0.55 scale) with E4 (`cost:true` on the light vulnerability). Strip both; the points are disjoint so both survive; re-host E2's clause-only shape onto E4's cell as a per-state clause; **re-prove** — the coverage lease is unchanged because it was already inside M1, and bypassing defences makes the *world* more lethal, not less. Result: full-damage defence-piercing blows while partially immune to physical, at `price(a)+price(b)+premium` with both refunds removed.

### E9 — soul-tether allies, gain their power on death, revive them at mission end for a week's penalty
```js
{ tier:5, seed:0xE9, hostOnly:null,   // requires caps.mission && caps.calendar
  cells:[
    { key:'tether', hold:'many', level:'int', clock:false,
      cap:{expr:'sub', a:{q:'party.size'}, b:1},
      tags:{from:'bind.party'}, tier:'mission', scope:{side:'ally'} },
    { key:'borrowed', hold:'none', level:'int', cap:3, tier:'mission', scope:{side:'self'} }],
  clauses:[
    { id:'c1', on:{at:'event:onEncounterStart'},
      do:[{ emit:'cell', cell:'tether', verb:'draw',
            n:null, from:{scope:{side:'party', exclude:['self']}} }] },
    { id:'c2', on:{at:'event:onDeath'},
      when:{ all:[ {frame:'side', op:'eq', v:'ally'},
                   {cell:'tether', op:'has', v:{frame:'victim'}} ] },
      do:[ { emit:'cell', cell:'borrowed', verb:'add', v:1 },
           { emit:'quantity', verb:'copy', from:{ref:{frame:'victim'}, q:'fighter.base.damage'},
             to:'fighter.base.damage', ratio:0.4, tier:'mission' } ] },
    { id:'c3', on:{at:'tier:mission'},
      when:{ all:[ {cell:'borrowed', op:'>', v:0}, {q:'fighter.hp', op:'>', v:0} ] },
      do:[{ emit:'world', verb:'revive',
            scope:{side:'ally', rank:null}, from:{cell:'tether', filter:'fallen'},
            when:'missionEnd', hpFrac:0.25, max:1 }] },
    { id:'c4', cost:true, on:{at:'tier:mission'}, when:{cell:'borrowed', op:'>', v:0},
      do:[{ emit:'world', verb:'mark', target:'person', calendar:{
              id:'thread_debt', days:7,
              mods:[{stat:'attr.*', op:'add', value:-2}] } }] } ] }
```
- **"If they survive the mission"** is structural: the tether's tier is `mission`, and mission-tier clauses fire only if the holder reached the boundary.
- The revive bound is the cell cap (`party.length − 1`), clamped to `REVIVE_CAP`, tokens consumed on discharge, refill only at `tier:mission` — M3. `facetSustainSpent` does **not** reset on revive.
- The week-long penalty writes **beside `condition.js`**, never into `c.stats.base`: `stats.js:120-131` is explicit that base is who the character *is*, and that anything removable belongs outside it.
- **Interaction to wire, verified:** `bonds.js:228 mourn()` deletes every pair record naming the fallen (`:240-246`). A tether surviving that deletion is an **unbounded-revive bug**. The tether therefore lives on the **reviver's** own mission bag keyed by character id, never in `state.bonds`, and `mourn` is taught to defer for a tethered fallen until the revive resolves.
- **KSG: does not roll at all.** `caps.mission:false`, so `generate()` refuses it. Degrading `mission → encounter` would turn a between-missions bargain into an in-fight one — a *different ability*, not a narrower one.

### E10 — summon monsters from random dimensions for 5–15 s
```js
{ tier:4, seed:0xE10,
  cells:[{ key:'rift', hold:'none', level:'int', cap:1, tier:'encounter',
           scope:{side:'arena'} }],
  clauses:[
    { id:'c1', on:{at:'gate:offer'},
      do:[{ emit:'gate', verb:'offer', descriptor:{
              kind:'facet', scope:{side:'arena'}, cooldown:25*S,
              cost:{pool:'mana', frac:0.25},
              exec:[{ emit:'world', verb:'summon', side:'self',
                      n:{roll:[1,3]},
                      tagQuery:{ pick:'weighted', from:'host:spawnTable' },
                      level:{q:'arena.level'},
                      ttl:{roll:[5,15]},                 // SECONDS, converted by the host
                      scale:{ hardness:0.55, damage:0.7 } }] } }] } ] }
```
- **5–15 s, authored in seconds.** IG's outer game tick is 10 s and KSG's is 100 ms; only `ticksPerSecond` (10 in both) is safe to convert against, and the adapter does it.
- **Tag queries, never monster ids.** IG `slime`/`slime_ice`/`slime_soldier`/`spider_queen` are KSG `slime_base_basic`/`slime_ice_basic`/`slime_soldier_spear`/`giant_spider_queen`; every tag IG uses is registered in KSG's `bestiary.data.ts`. Each weighted tag cluster **is** a dimension.
- Summons are offence, not sustain, so they do not debit M2 — **but a summon that soaks blows is a de facto sustain source the ledger does not see.** Bounded three ways: `scale.hardness` caps the summon's own H at 0.55; summons are not revive targets; and `n × ttl` both scale the clause's severity so the price rises steeply. **That is an economic bound, not a proof, and I say so.**
- **Highest-risk host edit in the plan:** IG's `encounter()` takes fixed party/enemies arrays and `formRanks()` is computed per beat, so a mid-fight arrival must push into the array and set `reform` — about six lines, in the one place the fight's shape is mutated mid-loop.

### E11 — enslave souls, diminishing attribute buffs per kill
```js
{ tier:3, seed:0xE11,
  cells:[{ key:'souls', hold:'many', level:'int', cap:24,
           tags:{from:'kill.tags'}, scorer:{id:'diminish', a:4},
           tier:'mission', scope:{side:'self'} }],
  clauses:[
    { id:'c1', on:{at:'event:onKill'},
      do:[ { emit:'cell', cell:'souls', verb:'draw', n:1, from:'kill.tags' },
           { emit:'cell', cell:'souls', verb:'score', scorer:'diminish' } ] },
    { id:'c2', on:{at:'while'},
      do:[{ emit:'status', to:{side:'self'}, def:{ mods:[
              {stat:'attr.str', op:'add', value:1, perIntensity:true},
              {stat:'attr.con', op:'add', value:1, perIntensity:true},
              {stat:'attr.dex', op:'add', value:1, perIntensity:true} ] } }] } ] }
```
- **"Diminishing the more you defeat"** is a named core curve `a/(a+n)` with an authored `a`, shown to the player as its actual next-soul value. A linear or threshold variant is a data row.
- **CACHE DISCIPLINE, exactly:** `score` writes into the carrier's `intensity` (fingerprinted); the count into `stacks` (fingerprinted); the token multiset into `data` (**not** fingerprinted, and no mod reads it). This is the whole reason the compile backend is cache-correct in KSG for free.
- Souls are tokens carrying the **victim's tags**, so a later facet can guard on `{cell:'souls', op:'has', v:'undead'}` with no monster ids anywhere.
- Attributes are `nullifiable:false` **and** `writable:true` — two separate flags, and conflating them makes either E6 or E11 inexpressible.
- **Gap, emergent and not asked for:** bucketing by victim tag means twenty rats are worth less than twenty species. Also, mods land on the fighter's runtime block, so the buff is invisible on the character sheet mid-mission — correct for persistence, surprising for the player, and it needs a UI line.

### E12 — lucky coins, secretly cheating, telling neither the player nor the character
```js
{ tier:4, seed:0xE12,
  cells:[{ key:'luck', hold:'none', level:'real', cap:0.35, step:0.004,
           tier:'calendar', scope:{side:'self'}, epistemic:'hidden' }],
  clauses:[
    { id:'c1', on:{at:'gate:choose'},
      do:[{ emit:'meta', verb:'roll', key:'facet:$id:coin',
            // THE RATE DRIFTS. THE MERCY DIAL DOES NOT.
            // VERIFIED: mercyCurve (mercy.js:46-61) bisects base and slope for 60
            // iterations so 1/meanRolls(base,slope,cap) === rate. Growing `mercy`
            // with `rate` pinned changes VARIANCE ONLY — the character does not get
            // luckier. D4's E12 is a NO-OP and must not be carried forward.
            rate:{ expr:'add', a:0.5, b:{cell:'luck', of:'v'} },
            mercy:0.85,
            heads:[{ emit:'status', to:{side:'self'}, def:{ref:'coin_blessed'}, ticks:8*S }],
            tails:[{ emit:'status', to:{side:'self'}, def:{ref:'coin_cursed'},  ticks:8*S }] }] },
    { id:'c2', on:{at:'meta:roll:tails'},
      do:[{ emit:'cell', cell:'luck', verb:'add', v:0.004 }] } ],
  lens:{ shown:{ 'clauses.0.do.0.rate': 0.5 },
         known:{ 'clauses.0.do.0.rate': 0.5 } } }
```
- **All three views are genuinely separate and all three have readers**: the roll uses `true` (drifting toward 0.85 effective); IG's `options()` value chain and `chooseAction` read `known` (pinned 0.5, so the AI keeps pricing heads at even odds); every tooltip, report line and log reads `shown` (0.5). *"Without telling the player OR the character"*, verbatim.
- **The luck grows on TAILS**, so it is mercy pointed at itself.
- `epistemic:'hidden'` on the *cell* removes it from every readout **and** from the AI's valuation in one flag — cheaper than tagging every parameter. The precedent is `affinity.js:94 knownCompat`, which already returns 0 for a compatibility the character has not discovered, and `mercy.js:66`, which already says outright *"show the authored rate to players, not this."*
- **Gap, honest:** IG's `dim` AI tier picks with `R.pick` (`combat.js:401`) and reads no value at all, so a facet that lies about its own worth changes nothing for a dim character. Defensible in fiction — you cannot deceive someone who was not listening — and it belongs in the reading.
- **Gap, structural:** `lens.known` here is *pinned*, not converging over `DISCOVER_USES` like every other lens entry. "Without telling the character" means discovery must be permanently off for this path. It is a per-path flag, and it is the one special case in the epistemic layer.

### 12.13 ROUND-TRIP: existing content in the same schema

The expressiveness judge's warning: *"If the twelve examples fit and the existing content does not, the space was shaped around the acceptance spec."* Four encodings of content the author already wrote.

**`heavy_blow`** (`martial.js:37`) — a mode-machine node:
```js
{ clauses:[{ on:{at:'gate:offer'}, do:[{ emit:'gate', verb:'offer', descriptor:{
    kind:'technique', family:null, school:'martial',
    damageType:{q:'fighter.damageType'},
    cost:{pool:'stamina', frac:0.08}, cooldownKey:'technique:heavy_blow', cooldown:60,
    scope:{side:'enemy', rank:null, n:1},
    exec:[{ emit:'world', verb:'damage', mult:2.0 },
          { emit:'quantity', verb:'set', q:'fighter.position', v:'off_balance' }] } }],
  when:{ q:'fighter.position', op:'in', v:['coiled'] } }] }
```
The host's `position` is a `kind:'mode'` quantity, so `Ma.admits` becomes one guard. `addFromAt` is an `Expr` over the mastery ledger.

**`sidestep`** (`martial.js:39`) — a reflex buff:
```js
{ clauses:[{ on:{at:'tick'}, when:{ all:[ {event:'onHit', within:20},
                                          {q:'cooldown:technique:sidestep', op:'<=', v:0} ] },
   do:[ { emit:'status', to:{side:'self'},
          def:{ mods:[{stat:'dodge', op:'add', value:0.4}] }, ticks:30 },
        { emit:'quantity', verb:'set', q:'fighter.position', v:'guarded' },
        { emit:'quantity', verb:'set', q:'cooldown:technique:sidestep', v:120 } ] }] }
```
Off-bar reflexes are a `tick` hook, which is exactly what `reflexes()` is — and routing it through the gate is what makes an arena law binding.

**`soaked`** (`elements.js:88`) — the richest status in the game, entirely as a `status` emission:
```js
{ emit:'status', to:{side:'enemy', rank:null, n:1},
  def:{ element:'water', baseForm:'wet', duration:600,
        overrideRes:{ heat:{to:0.8, bonusIfMet:0.1}, lightning:{to:-0.5},
                      cold:{to:-0.5}, poison:{to:-0.5} },
        converts:[{from:'poison', to:'rotting', ratio:0.667}],
        amplifies:[{id:'chilled', mult:3}],
        capOverrides:[{id:'jolted', cap:3}],
        removal:[{on:'damageTaken', damageTypes:['heat','poison','lightning','cold'], after:3}],
        worth:25 } }
```
**Every field is a declared row in `host.statusSchema()` and is therefore generable.** This is the concrete answer to *"can the generator emit `soaked`?"* — yes, and it is the pass-through payload that makes it so.

**`jolted`** (`elements.js:74`):
```js
{ emit:'status', to:{side:'enemy'},
  def:{ element:'lightning', escalatesTo:'shocked', duration:200,
        stacking:{mode:'absorb', absorb:1, cap:6, onCap:'escalate', escalateFrom:2},
        bar:{ onFill:{type:'lightning', flat:1.2} },
        removal:[{on:'damageTaken', effect:'reduce', amount:0.5}], worth:8 } }
```

**Honest limits of the round-trip.** Techniques whose payload is `counter:{reduce, pool, cost}` — `electric_cross` (`martial.js:55`) — have **no home**, because neither host has a reactive/interrupt path (IG has none at all; the closest is hard-coded party-only parry at `combat.js:196`). `electric_cross` is currently unreachable data: every reader excludes it (`combat.js:317`, `:561`, `martial.js:153`) while `known(c)` does not filter it, so it can occupy a loadout slot and never fire. **This spec does not fix that**, and a facet cannot express a counter until a `stage:incoming` hook exists in `host.stages()`. Stated rather than papered over.

---

## 13. Incremental build order

**Every step ships alone, is revertable, and is independently correct.** The portability judge's warning is the governing constraint here: *"D4's value is not the schema; it is that commit one edits about five lines. If the staging collapses, D4 becomes D1 with a worse core-file story."*

### Commit 0 — NOT a prerequisite (this is the cost win)

Three live IG bugs — `bearerArmor` reading `b.armor` while combatants store `base.armor`; `res:` buff mods dropped twice; `statusBlocksRangedType` exported and never called — are **recommended, announced, separate** and **not blocking**, because coverage is *measured* through the host's own `slice`, so the ratio `H` is correct against the game as it is, bugs included. Every one of the four candidate designs listed these as prerequisites; measurement removes them.

### Commit 1 — the core, read-only, status emission only

**Adds:** 12 core files, `facet.host.ig.js`, `facet.quantities.ig.js`, `facet.schema.ig.js`, `test/facet.node.js`.

**Edits — 4 JS lines + 6 markup lines:**
1. `game.html:518` and `field.html:68` — 12 `<script src>` tags each, before `elements.js`. Order-free (§2.1), but grouped.
2. `combat.js` `fromCharacter` (`:93`) / `fromMonster` (`:118`) — one line: `FA() && FA().attach(ref(this), (c && c.facets) || [])`. Facets live at `f.facets`, a **sibling** of `plan` — never inside it. `f.plan` **is** `c.loadout` by reference (`missions.js:178`, `sortie.js:124`, `missions.js:126`); anything pushed into it is written permanently into the save.
3. `combat.js tickFighter` (`:584`) — one line: `FA() && FA().tick(ref(f))`.
4. `combat.js encounter` (`:606`) — one line inside the reset loop: `FA() && FA().tierEnd('encounter', ref(f))`.
5. `game.js load()` — two lines: `if (!c.facets) c.facets = []; if (!c.facetState) c.facetState = {};`

**Ships:** E11 whole. E1 and E4 as `overrideRes` approximations (capped by `bearerResistance`'s final clamp — 0.75 party, 0.9 monster — so 75%, not 85%; exclusive via the compiler's remove-then-apply, **not** `blockedBy`). The `soaked` and `jolted` round-trips. *(D4 claimed E1/E4 at Layer 0 with `do:'mitigate'`, which needs the stage list; corrected here.)*

**Does not ship:** anything needing stages, the gate, overrides or world verbs.

**Revert:** delete the script tags. `c.facets` backfills away harmlessly through `game.js:52`.

**Save format:** IG — two new per-character keys, backfilled in `load()`, **no version bump, no migration**. KSG — deferred to the KSG port.

### Commit 2 — the ledger and the seam (mortality, no new abilities)

`facet.mortal.js` goes live. Adapter gains `probeSlice`, `probeNative`, `reachableTypes`, `refBlow`, `dirty`. `Facet.tick` integrates `openBar`. `enforce` + P1/P2/P3.
**Edits:** ~6 lines in `combat.js` (dirty flags at status/buff mutation sites) and ~15 in the adapter.
**Revert:** the seam override is the only behaviour; removing the module restores commit 1.
**Save:** none.

### Commit 3 — the staged pipeline (behaviour-identical)

`elements.js slice()` (`:29`) becomes a named ordered stage list over a **per-call** frame — mandatory, because `slice` is re-entered from `damage()` at `combat.js:145` while a slice at `:224` is on the stack. `afterRes` is snapshotted at the end of `resist` so `resisted` stays exact. A 5th optional `hit` parameter is added; **all eight call sites pass ≤4 args, so this is source-compatible.** `crit` is lifted out of `combat.js:222` and `:276`, preserving per-hit `crit → variance → slice → sum → one floor` and the single side-effecting `consumeMagnetCharge`. `Combat.damage` and `Combat.heal` join the export line (`combat.js:646`) — they are module-private today. `consume.js:74` and `sortie.js:374` route through `Combat.heal`. New `absorb` and `engine` stages.
**Test gate:** a 20,000-blow arithmetic-identity sweep in `facet.cases.js` comparing old and new `slice` outputs bit-for-bit.
**Ships:** E3, and the `absorb`/`engine` mitigation route for E1/E4 at full strength.
**Save:** none.

### Commit 4 — the quantity registry and overrides

`facet.registry.js` live. `combat.js stats()` (`:122`) applies overrides **after the mod loop, before the clamps at `:130`**. `bearerResistance` gets the same check for `res:*` ids. `tickFighter` decrements the override table beside `f.cooldowns` (`:581`). `Stats.effective`'s WeakMap signature (`stats.js:156`) gains the override hash, or a nullified derived stat is served stale. `ai.js signature()` (`:188`) gains the facet fingerprint — without it `prepare()`'s cache (`missions.js:106`) hands back a pre-facet loadout, intermittently, only when nothing else changed.
**Ships:** E6.
**Save:** none new (override state is tick-tier and transient).

### Commit 5 — descriptors, the gate, defiance (the big one)

Widen all six push sites (`combat.js:322`, `:324`, `:333`, `:340`, `:362`, `consume.js:61`) to full descriptors; delete the three hardcoded `statusBlocks` guards (`:315`, `:326`, `:348`); `return out` (`:394`) becomes `return FA().gate(ctx, f, out)` — **before** the five value passes (`:369`, `:374`, `:380`, `:385-393`), because IG's `dim` tier picks uniformly and `plain` picks by weight, so a vetoed-but-scored candidate is not merely mispriced, it is **selectable**. Route the enemy branch (`:543`) and `reflexes()` (`:557`) through the same gate. Replace `act()`'s three-way chain (`:546-553`) with `choice.exec(...)` — it has no default arm today and an unknown kind dereferences `choice.spec.school` and throws inside the tick loop. Promote `:551` to the two-dimensional scope resolver. Generalise `statusBlocks` to take a descriptor, with the legacy string arm preserved so **zero** of IG's 46 / KSG's 67 existing defs need editing; fold in `statusBlocksRangedType`. Register `'facet'` in `classes.js mind.act` (or add a kind→parent-family fallback, which fits "names are readings" better) and `temper.js:276 actLean`.
**Ships:** E2, E5, E7, and the `heavy_blow`/`sidestep` round-trips.
**Save:** none.
**This is the commit most likely to break combat silently**, and it cannot be made smaller than it is: the pieces are not independently correct.

### Commit 6 — world verbs

`summon`, `dismiss`, `revive`, `mark`, calendar writes.
**Ships:** E9 (IG only), E10.
**Save:** IG — `c.facetState.calendar` entries (already backfilled by commit 1's two lines). KSG — n/a, `caps.mission:false`.

### Commit 7 — the oracle and fusion

`facet.oracle.js` + `facet.forge.js fuse()` + fusion slots.
**Ships:** E8, and real prices everywhere.
**Save:** IG — `c.facetSlots` (one more backfill line).

### Commits K1–K4 — the KSG port (after commit 3)

- **K1:** vendor the core + `MANIFEST.json` + `facet.d.ts` + `host.ts` + `quantities.ts` + `tests/facet.test.ts`. `GameState.facets` / `.facetState`; default in `createInitialState` (`state.ts:19` — which alone makes old saves load, because `deserialize` spreads over it); `SAVE_VERSION 48 → 49`; **one-line `MIGRATIONS[48]`**; null the encounter-tier state in `serialize` alongside `combat`/`fight`. **A bump without a matching migration makes `migrate()` throw, `loadFromStorage` return null, the game boot fresh, and `beforeunload` overwrite the good save** — `PITFALLS §2` records that sequence destroying a real playthrough. **Add `vite build` to `verify` (`package.json:14`)** — verified: a named import passes vitest and fails the browser build, and TS does not even check that the core path exists.
- **K2:** collapse `monsterSlice` (`:1204`) and `incomingSlice` (`:1267`) onto **one staged runner parameterised by `{floor: 0|1, penetration: on|off, bonusArmor}`.** 25 call sites, none changing signature. **The two asymmetries must survive as parameters**, per `combat.ts:1195-1202`. The shared pipeline puts the mandatory floor on the **damage door**, where IG has it, so KSG's monster side *gains* the mortality guarantee it lacks.
- **K3:** `pickActive` (`:1621`) reifies descriptors before its ~15 inline `continue` guards; `Facet.gate` runs over them; `activeRotation` (`:1579`) filters family-wide laws. `modFingerprint` (`:589`) gains the override hash — **mandatory**, `tests/derivedcache` is the tripwire. Overrides enter through `collectModifiers` (`:53`); **never mutate `getDerivedStats`'s frozen shared result.** `conditionHolds` (`:214`) gains the fail-closed NULLED state. **Port IG's `MAX_TICKS`/`MAX_TICKS_CAP` into `tickCombat`** (`:2965`, verified: no cap at all) — a *precondition* of shipping laws, mechanically enforced by `install()` refusing arena vetoes when `encounterCap()` is `Infinity`.
- **K4:** `monsterStats.ts` (`:449`) calls the **same** `applyFacetOverrides()` as `computeDerivedStats`, in the same position (after `applyDerivedMods`, before `applyResOverrides`). Implementing it twice reopens exactly the drift `docs/plans/monster-stat-parity.md` was written to close — the file records the hand-written `MONSTER_STAT_KEYS` was "already wrong by four keys." Note `MONSTER_STAT_KEYS.has(mod.stat)` silently drops any colon-bearing scoped key, so scoped facet mods vanish enemy-side with no error; declare scoped writes player-only or extend the test.

### What touches save format — the complete list

| Item | IG | KSG |
|---|---|---|
| `c.facets` / `state.facets` (records) | commit 1, two backfill lines in `load()`, **no version bump** | K1, `createInitialState` default + `SAVE_VERSION 48→49` + one-line `MIGRATIONS[48]` |
| `c.facetState` (mission/calendar cell state) | same two lines | same field |
| `c.facetSlots` (fusion) | commit 7, one line | K1 (defaulted to 0) |
| Compiled `StatusDef`s | **never serialised.** Rebuilt from the records at load, so a schema change costs no migration. | same |
| Status *instances* carrying facet state | ride on `bearer.statuses`, as persistent as the bearer is. In IG that means `sortie.js`'s cached `a.fighter` for the run's duration; character-tier state must live in `c.facetState`. | ride on `state.statuses`; nulled with `combat` in `serialize` for the encounter tier |
| Override table | **transient**, never serialised | transient |
| `openBar` EMA, ledger | **transient** | transient |
| Everything else | **untouched** | **untouched** |

**Everything persisted is plain JSON** — no `Map`, no `Set`, no class, no function, no `undefined`. `JSON.stringify` is the entire serializer in both hosts.

---

## 14. Weaknesses I am not hiding

1. **`H_evade` is declarative, and a product is dominated by its worst factor.** Dodge and parry never touch the pipeline (`combat.js:169`), so `probeSlice` cannot see them. The honest confidence interval on the whole mortality proof is set by the one factor that is audited by reading the facet's own paperwork.
2. **The `from`/`feeds` graph is authored and will rot.** `stats.js:50` proves it already has. The corpus's recording-proxy audit catches wrong edges on quantities the corpus exercises, and nothing catches one it never touches.
3. **`SEAM_MIN = 0.35` is large.** An "immunity" that leaks 35% on one hidden reachable type may not read as immunity. C2 and the power fantasy are in genuine tension and I have resolved it toward C2; the reverse resolution would need the whole constant table re-derived.
4. **Puncture hides the seam**, so the bound is on the *existence* of a kill path, not its *discoverability*. Mathematically true, experientially unavailable, and a discovery affordance is undesigned.
5. **The `WORTH` table is uncalibrated** where `caps.simulate` is false. Sharing the unit with 46 hand-tuned `worth` fields is an anchor, not a calibration.
6. **The oracle prices against five synthetic bands.** A facet worthless in all five and devastating in the one encounter shape the player farms is mispriced, and the only fix is more bands — unbounded work.
7. **E5's `worstFor` and E10's mid-fight summon have no precedent in either repo.** The summon mutates the party array inside `encounter()`'s main loop, the one place the fight's shape is fixed.
8. **KSG's declared degradations change what abilities MEAN.** `caps.party:false` and `caps.mission:false` mean E9 does not roll at all and E3/E7/E11's scope clauses become vacuous rather than narrower. Declaring is better than hiding; it is still a weaker portability than "one content set, two games."
9. **The generator has no taste.** Pricing keeps facets balanced and `prove()` keeps them survivable; nothing keeps them *interesting*. `gatesMin:1` and `INERT_EPS` stop two classes of dullness and not the rest.
10. **Commit 5 is unavoidably large** and its failures are silent: `act()`'s chain has no default arm, `classes.js mind.act` tables carry only four keys so a new kind silently prices at 1.0, and `temper.actLean` falls through to the swing arm — none of which throws.
11. **`electric_cross` still has no home.** A counter needs a `stage:incoming` reactive hook neither host has. The round-trip is incomplete and I have said where.
12. **No UI is designed.** Traceability demands pointable-at numbers, the epistemic layer demands `shown`/`known` rendered side by side where the player may see both, and install-time shed effects need explaining. That is real work in `game.js` and KSG's Svelte panels that this spec names and does not do.

---

## 15. Relevant absolute paths

**IG (new):** `C:\Users\mersi\Documents\InfiniteGacha\facet\{facet.core,facet.cells,facet.registry,facet.pipeline,facet.gate,facet.mortal,facet.forge,facet.oracle,facet.compile,facet.data,facet.cases}.js`, `…\facet\MANIFEST.json`, `…\facet.host.ig.js`, `…\facet.quantities.ig.js`, `…\facet.schema.ig.js`, `…\test\facet.node.js`

**IG (edited):** `combat.js`, `elements.js`, `stats.js`, `ai.js`, `missions.js`, `consume.js`, `sortie.js`, `classes.js`, `temper.js`, `game.js`, `game.html`, `field.html`

**KSG (new):** `D:\ksgproto28\src\core\facet\` (mirror + `facet.d.ts`, `host.ts`, `quantities.ts`), `D:\ksgproto28\tests\facet.test.ts`

**KSG (edited):** `src\core\systems\{combat,derived,monsterStats,statuses,triggers}.ts`, `src\core\{types,state}.ts`, `src\core\save\{migrations,save}.ts`, `package.json`