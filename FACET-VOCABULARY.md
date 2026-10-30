# Facet vocabulary backlog

Abilities the engine cannot currently express, and what each one actually demands. This is the
useful form of an example: not a template to imitate, but a **demand signal for vocabulary**. The
generator draws from registries; an example only widens it when it implies a verb, a quantity, a
scope or a bearer that does not yet exist.

The original twelve are in `FACET-SPEC.md` §12. These are the ones raised since, with the demand
each makes named explicitly, so it is clear which are unlocked by work already scoped and which need
something new.

---

## V1 — Soulbound / ego weapons

*A character makes a weapon that stays attached to them, grows with them, grants new powers, and can
eventually take actions of its own.*

Demands, in order of how new each is:

- **A facet borne by an item, not a person.** Everything today attaches to a combatant via
  `Facet.attach(ref, facets)`. Equipment would need `c.equipment.weapon.facets`, and the attach
  point becomes the loadout rather than the character. Cheap: the core already keys on an opaque
  ref, so an item is just another ref.
- **`calendar`/`mission` tier state that grows.** Already in the schema (`cell.tier`), not yet
  reachable because `caps.calendar` is false. Commit 6.
- **An autonomous sub-actor.** *This is the genuinely new one.* A weapon that takes its own actions
  is a second entity on the action bar that is not a summon and not the bearer. Nothing in the
  design covers it — the closest is `world.summon`, but a summon is a separate body with its own hp,
  and an ego weapon acts *through* the wielder's initiative. Needs either a new emission target
  (`emit:'act'`, an action inserted into the bearer's own queue) or the gate's `offer` verb, which
  adds a descriptor to the candidate list — commit 5. **`gate.offer` is probably the right home**
  and would cost nothing extra once the gate exists.

## V2 — Cooking that lifts morale and willpower past their normal ceiling

*Food this character makes leaves the eater happier, and pushes morale and willpower beyond the
limits anything else can reach.*

- **Non-combat quantities.** The registry is 64 entries and every one is combat. Morale lives in
  `temper.js`/`crew.js`, willpower is `derived.willpower`. Registering the town half is the single
  highest-leverage vocabulary expansion available and needs no new verb at all.
- **A cap-breaking verb.** "Beyond normal limits" is not `scale` — it is raising the clamp itself.
  The registry already stores `clamp` per quantity and `sealed` to protect the ones that must not
  move. A `raise`/`uncap` verb writing the clamp is a new mode in `registry.apply`, and the seal
  already exists to say which quantities may never be uncapped.
- **A facet that fires outside combat.** Hooks today are combat events and tier boundaries. Cooking
  resolves in town. Needs town-side `Facet.event` call sites — one line each, same as `markEvent`.

## V3 — Personal wealth spent as a combat resource, with the risk of running dry

*Spend their own money to cut damage and buff themselves, and it can run out.*

- **An economy quantity registered as a pool.** `state.gems` / the character's own purse becomes a
  `pool`-kind quantity with `cur`. No new verb: `add` with a negative value is spending.
- **A resource whose depletion is visible and permanent within a run.** The sustain meter in
  `facet.mortal.js` already does exactly this shape — a budget that empties and stops working, which
  the design notes is legible in play. Same machinery, different pool.
- **Second-order into the town half by construction**, which is the property the whole design is
  supposed to have and currently does not demonstrate anywhere. This is the best single test case
  for whether the "register more of the engine" claim is real.

## V4 — Spell scrolls: arcane sentences anyone can cast, with the mana prepaid by the writer

*Writes a scroll carrying a real spellcraft sentence. Anyone can use it, because the writer already
paid the mana.*

- **A facet that transfers between characters.** Records are plain JSON and already portable between
  saves, so the object moves fine. What is missing is a bearer that is an *item in inventory* and an
  attach point when it is used.
- **A facet carrying a spellcraft sentence as its payload.** New emission target: today a facet can
  emit a status, a quantity change, a stage join, a gate rule, a world verb or a cell verb — it
  cannot emit *a spell*. `emit:'cast'` handing a parsed sentence to `Spellcraft` would be one
  adapter member and would immediately let generated facets reach the entire existing spell system
  rather than reimplementing bits of it. **Probably the highest expressiveness-per-line item on this
  whole list.**
- **Cost paid by one character, benefit taken by another.** The sustain meter is keyed on the
  recipient deliberately, to close party stacking. A prepaid scroll is the legitimate case that rule
  would wrongly block, so it needs an explicit exemption: a cost already paid at write time is not
  engine-sourced sustain at use time.

---

## What this list says about priority

Counting demands rather than examples:

| Demand | Unlocks | Status |
|---|---|---|
| Register non-combat quantities | V2, V3 | **Not scoped.** No new verbs needed. Cheapest large win. |
| `gate.offer` | V1's autonomous actions | Commit 5 |
| `emit:'cast'` | V4 | Not scoped. One adapter member, very large reach. |
| Item-borne facets | V1, V4 | Not scoped. Core already ref-agnostic. |
| Cap-raising verb | V2 | Not scoped. Registry already has `clamp` and `sealed`. |
| `caps.calendar` | V1 growth | Commit 6 |

Three of the six are unscoped and none of them is large. The pattern holds from the first twelve:
what limits the generator is never the number of examples, it is the size of the vocabulary the host
has described.
