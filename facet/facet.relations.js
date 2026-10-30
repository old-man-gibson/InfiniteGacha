// Relations: composable structure operators used by the facet generator.
//
// Why this file exists. The previous generator composed effects, and effects combine only by
// conjunction: A and B and C. All structure came from six hand-written shape templates, so a corpus
// of six hundred generated abilities contained six distinct structures with different numbers
// substituted into them.
//
// Hand-authored abilities differ from each other in the relationship between their parts, not in
// the parts themselves:
//
//     immune to magic or physical, never both      exclusion between two states
//     absorb fire until full, then expel it        accumulate-and-release loop
//     draw a hand, better hands do more            a score imposed on a random draw
//     it cheats, and neither side is told          true value diverges from displayed value
//
// So the primitives in this file are relations rather than effects. A relation takes
// sub-expressions as arguments, so relations nest: `exclusive(escalate(X), trade(Y))` is a structure
// produced by composition rather than one enumerated in a template list. TABLE below defines twelve
// relations.
//
// Scope limit. A grammar produces mechanism only; the meaning a player reads comes from naming and
// framing, which are still authored by hand. The bar this file targets is that two characters
// holding different facets play differently, not only that they hold different numbers.
//
// Output format. Every relation emits ordinary cells and clauses, the same records the engine
// already runs, saves, prices and proves. Nothing in the runtime, the save format or the mortality
// bound reads this file.

(() => {
const F = (globalThis.Facet || (globalThis.Facet = { _mods: {} }));
F._mods.relations = true;

const REL = F.relations = {};

// A slot declares what may fill it. `effect` accepts a leaf or another relation; `trigger` accepts
// a hook; `resource` accepts a registered quantity that can be spent.
const S = { EFFECT: 'effect', TRIGGER: 'trigger', RESOURCE: 'resource', TYPE: 'type' };

// ---------- the relations ----------
//
// Each entry declares its slots, its selection weight and its depth cost, and supplies emit().
// emit(a, c) returns a { cells, clauses } fragment that the caller merges; it never touches host
// state.
const TABLE = {

  // a.trigger adds the event frame's `amount` to a real-valued store cell. When the cell reaches
  // cap, a.effect fires with magnitude equal to the stored value and the cell resets to 0. Cap
  // comes from c.capExpr(0.2, 0.6); the cell's element is a.type. This is the one shape the old
  // generator had; the payload is now a sub-expression, so the released effect can itself be a
  // relation.
  until: {
    role: 'burst',
    slots: [S.TRIGGER, S.EFFECT], weight: 3, depthCost: 1,
    emit(a, c) {
      const key = c.key('store');
      return {
        cells: [c.cell(key, { hold: 'none', level: 'real', cap: c.capExpr(0.2, 0.6), element: a.type })],
        clauses: [
          { on: a.trigger, when: a.triggerGuard, do: [{ emit: 'cell', cell: key, verb: 'add', value: { frame: 'amount' } }] },
          { on: 'cell:' + key + ':cap', when: null, do: c.effects(a.effect, { magnitude: { cell: key, of: 'v' } }).concat([{ emit: 'cell', cell: key, verb: 'reset' }]) },
        ],
        read: { when: 'Fills on ' + c.plain(a.trigger), then: 'at the brim, it all comes back out' },
      };
    },
  },

  // One cell holding two mutually exclusive states, 'first' and 'second' (hold: 'one',
  // exclusive: true), with a switch cooldown of 20-60. a.trigger (default event:onHit) enters
  // 'first' with chance 0.25-0.5; event:onDodge enters 'second' with chance 0.25-0.5. On tick,
  // a.effect runs while in 'first' and a.effect2 runs while in 'second'.
  exclusive: {
    role: 'hold',
    slots: [S.EFFECT, S.EFFECT], weight: 3, depthCost: 1,
    emit(a, c) {
      const key = c.key('stance');
      const tags = ['first', 'second'];
      return {
        cells: [c.cell(key, { hold: 'one', level: 'none', exclusive: true, tags, cooldown: c.int(20, 60) })],
        clauses: [
          { on: a.trigger || 'event:onHit', when: { chance: c.num(0.25, 0.5) }, do: [{ emit: 'cell', cell: key, verb: 'enter', arg: 'first' }] },
          { on: 'event:onDodge', when: { chance: c.num(0.25, 0.5) }, do: [{ emit: 'cell', cell: key, verb: 'enter', arg: 'second' }] },
          { on: 'tick', when: { cell: key, of: 'at', op: 'eq', v: 'first' }, do: c.effects(a.effect) },
          { on: 'tick', when: { cell: key, of: 'at', op: 'eq', v: 'second' }, do: c.effects(a.effect2) },
        ],
        read: { when: 'Two stances', then: 'one or the other, never both, and switching takes a moment' },
      };
    },
  },

  // a.trigger adds 1 to an int 'heat' cell capped at 4-12. On tick, once heat is at least 1,
  // a.effect fires with magnitude on a ramp curve of heat (a: 6). From heat 2 up, a cost clause
  // scales a.resource on self by 1 - ramp(heat, a: 14). The cell is not reset, so the player
  // chooses when to stop building.
  escalate: {
    role: 'hold',
    slots: [S.TRIGGER, S.EFFECT, S.RESOURCE], weight: 3, depthCost: 1,
    emit(a, c) {
      const key = c.key('heat');
      return {
        cells: [c.cell(key, { hold: 'none', level: 'int', cap: c.int(4, 12) })],
        clauses: [
          { on: a.trigger, when: a.triggerGuard, do: [{ emit: 'cell', cell: key, verb: 'add', value: 1 }] },
          { on: 'tick', when: { cell: key, of: 'v', op: 'gte', v: 1 },
            do: c.effects(a.effect, { magnitude: { curve: 'ramp', of: { cell: key, of: 'v' }, a: 6 } }) },
          // The cost clause reads the same `key` cell as the upside clause above, so the penalty
          // scales with what the player built rather than being a flat deduction.
          { cost: true, on: 'tick', when: { cell: key, of: 'v', op: 'gte', v: 2 },
            do: [{ emit: 'quantity', verb: 'scale', q: a.resource,
                   value: { expr: 'sub', a: 1, b: { curve: 'ramp', of: { cell: key, of: 'v' }, a: 14 } },
                   scope: { side: 'self' } }] },
        ],
        read: { when: 'Builds on ' + c.plain(a.trigger), then: 'stronger each time, and each time it costs more' },
      };
    },
  },

  // a.trigger (default event:damageTaken) runs a.effect while a.resource on self is above 0, and a
  // parallel cost clause subtracts 0.02-0.12 of a.resource per firing. Both clauses stop firing at
  // resource 0. A 'spent' real cell counts firings, cap from c.capExpr(0.15, 0.4).
  convert: {
    role: 'hold',
    slots: [S.RESOURCE, S.EFFECT], weight: 3, depthCost: 1,
    emit(a, c) {
      const key = c.key('spent');
      return {
        cells: [c.cell(key, { hold: 'none', level: 'real', cap: c.capExpr(0.15, 0.4) })],
        clauses: [
          { on: a.trigger || 'event:damageTaken', when: { q: a.resource, of: 'self', op: 'gt', v: 0 },
            do: c.effects(a.effect).concat([{ emit: 'cell', cell: key, verb: 'add', value: 1 }]) },
          { cost: true, on: a.trigger || 'event:damageTaken', when: { q: a.resource, of: 'self', op: 'gt', v: 0 },
            do: [{ emit: 'quantity', verb: 'add', q: a.resource, value: -c.num(0.02, 0.12), scope: { side: 'self' } }] },
        ],
        read: { when: 'Runs on ' + c.label(a.resource), then: 'and stops working when that is gone' },
      };
    },
  },

  // A 'held' int cell counts ticks, capped at 20-60, tier 'encounter'. Two tick clauses increment
  // it: one unconditional, plus a second while the value is below 1. Once held is at least 3,
  // a.trigger fires a.effect with magnitude sqrt(held) and resets the cell to 0, so a longer wait
  // gives a larger payload.
  defer: {
    role: 'burst',
    slots: [S.TRIGGER, S.EFFECT], weight: 2, depthCost: 1,
    emit(a, c) {
      const key = c.key('held');
      return {
        cells: [c.cell(key, { hold: 'none', level: 'int', cap: c.int(20, 60), tier: 'encounter' })],
        clauses: [
          { on: 'tick', when: { cell: key, of: 'v', op: 'lt', v: 1 }, do: [{ emit: 'cell', cell: key, verb: 'add', value: 1 }] },
          { on: 'tick', when: null, do: [{ emit: 'cell', cell: key, verb: 'add', value: 1 }] },
          { on: a.trigger, when: { cell: key, of: 'v', op: 'gte', v: 3 },
            do: c.effects(a.effect, { magnitude: { curve: 'sqrt', of: { cell: key, of: 'v' } } })
                 .concat([{ emit: 'cell', cell: key, verb: 'reset' }]) },
        ],
        read: { when: 'Waits, then fires on ' + c.plain(a.trigger), then: 'and the longer the wait the bigger it lands' },
      };
    },
  },

  // a.trigger adds 1 to a counter capped at n, where n is drawn from c.int(3, 6). On reaching cap,
  // a.effect fires once and the counter resets to 0. The intervening n-1 triggers produce nothing.
  nth: {
    role: 'burst',
    slots: [S.TRIGGER, S.EFFECT], weight: 2, depthCost: 1,
    emit(a, c) {
      const key = c.key('count');
      const n = c.int(3, 6);
      return {
        cells: [c.cell(key, { hold: 'none', level: 'int', cap: n })],
        clauses: [
          { on: a.trigger, when: a.triggerGuard, do: [{ emit: 'cell', cell: key, verb: 'add', value: 1 }] },
          { on: 'cell:' + key + ':cap', when: null, do: c.effects(a.effect).concat([{ emit: 'cell', cell: key, verb: 'reset' }]) },
        ],
        read: { when: 'Every ' + n + c.ordinal(n) + ' ' + c.plain(a.trigger), then: 'and only then' },
      };
    },
  },

  // No cells. On a.trigger, a.effect fires against the source of the event (onTarget: true) with
  // magnitude taken from the event frame's `amount`.
  mirror: {
    role: 'burst',
    slots: [S.TRIGGER, S.EFFECT], weight: 2, depthCost: 1,
    emit(a, c) {
      return {
        cells: [],
        clauses: [{ on: a.trigger, when: a.triggerGuard,
                    do: c.effects(a.effect, { onTarget: true, magnitude: { frame: 'amount' } }) }],
        read: { when: 'On ' + c.plain(a.trigger), then: 'it goes back the way it came' },
      };
    },
  },

  // No cells. On tick, while fighter.hp on self is at or below 30-60% of fighter.maxHpAbs, a.effect
  // fires with magnitude on an inverse curve of the hp fraction (a: 0.5), so lower hp gives a
  // larger effect.
  trade: {
    role: 'hold',
    slots: [S.EFFECT], weight: 3, depthCost: 1,
    emit(a, c) {
      return {
        cells: [],
        clauses: [{ on: 'tick', when: { q: 'fighter.hp', of: 'self', op: 'lte',
                      v: { expr: 'mul', a: { q: 'fighter.maxHpAbs' }, b: c.num(0.3, 0.6) } },
                    do: c.effects(a.effect, { magnitude: { curve: 'inverse', of: { q: 'fighter.hp', of: 'frac' }, a: 0.5 } }) }],
        read: { when: 'While badly hurt', then: 'and the worse it gets the stronger it is' },
      };
    },
  },

  // On event:damageTaken: apply an 'absorb' stage multiplier of 0.2-0.6 on self for 3-9 seconds,
  // and add the event frame's `amount` to a real 'held' cell, cap from c.capExpr(0.1, 0.3). When
  // the cell reaches cap, deal the stored value as a.type damage to self and reset the cell to 0.
  // While the cell is at 1 or more, a.effect runs on tick.
  ward: {
    role: 'hold',
    slots: [S.TRIGGER, S.EFFECT], weight: 2, depthCost: 1,
    emit(a, c) {
      const key = c.key('held');
      return {
        cells: [c.cell(key, { hold: 'none', level: 'real', cap: c.capExpr(0.1, 0.3) })],
        clauses: [
          { on: 'event:damageTaken', when: null,
            do: [{ emit: 'stage', at: 'absorb', verb: 'after', value: c.num(0.2, 0.6), scope: { side: 'self' }, seconds: c.num(3, 9) },
                 { emit: 'cell', cell: key, verb: 'add', value: { frame: 'amount' } }] },
          { on: 'cell:' + key + ':cap', when: null,
            do: [{ emit: 'world', verb: 'damage', value: { cell: key, of: 'v' }, damageType: a.type, scope: { side: 'self' } },
                 { emit: 'cell', cell: key, verb: 'reset' }] },
          { on: 'tick', when: { cell: key, of: 'v', op: 'gte', v: 1 }, do: c.effects(a.effect) },
        ],
        read: { when: 'Holds the blows off', then: 'but it is keeping them, and it lets go all at once' },
      };
    },
  },

  // a.trigger adds 1 to an int 'luck' cell capped at 8-20 and marked epistemic: 'hidden', so its
  // value is shown to neither the player nor the character. On the same trigger, a.effect fires
  // with probability 0.15-0.3 plus ramp(luck, a: 30), so the real firing rate rises above the
  // displayed one. The relation sets veil: true on its fragment. The engine models the epistemic
  // layer as a cell field, so this relation costs one field.
  veil: {
    role: 'burst',
    slots: [S.TRIGGER, S.EFFECT], weight: 1, depthCost: 1,
    emit(a, c) {
      const key = c.key('luck');
      return {
        cells: [c.cell(key, { hold: 'none', level: 'int', cap: c.int(8, 20), epistemic: 'hidden' })],
        clauses: [
          { on: a.trigger, when: a.triggerGuard, do: [{ emit: 'cell', cell: key, verb: 'add', value: 1 }] },
          { on: a.trigger, when: { chance: { expr: 'add', a: c.num(0.15, 0.3), b: { curve: 'ramp', of: { cell: key, of: 'v' }, a: 30 } } },
            do: c.effects(a.effect) },
        ],
        veil: true,
        read: { when: 'On ' + c.plain(a.trigger), then: 'sometimes — and it is luckier than it lets on' },
      };
    },
  },

  // a.trigger runs a.effect and adds 1 to an int 'toll' cell capped at 5-15, tier 'mission', so the
  // count persists across encounters instead of resetting. From count 1 up, a cost clause scales
  // a.resource on self by 1 - ramp(toll, a: 18) every tick.
  toll: {
    role: 'burst',
    slots: [S.TRIGGER, S.EFFECT, S.RESOURCE], weight: 2, depthCost: 1,
    emit(a, c) {
      const key = c.key('toll');
      return {
        cells: [c.cell(key, { hold: 'none', level: 'int', cap: c.int(5, 15), tier: 'mission' })],
        clauses: [
          { on: a.trigger, when: a.triggerGuard,
            do: c.effects(a.effect).concat([{ emit: 'cell', cell: key, verb: 'add', value: 1 }]) },
          { cost: true, on: 'tick', when: { cell: key, of: 'v', op: 'gte', v: 1 },
            do: [{ emit: 'quantity', verb: 'scale', q: a.resource,
                   value: { expr: 'sub', a: 1, b: { curve: 'ramp', of: { cell: key, of: 'v' }, a: 18 } },
                   scope: { side: 'self' } }] },
        ],
        read: { when: 'On ' + c.plain(a.trigger), then: 'and every use makes the next one cost more, for the rest of the road' },
      };
    },
  },

  // a.trigger runs a.effect and adds the resulting frame `amount` to a real 'carry' cell, cap from
  // c.capExpr(0.15, 0.5). On tick, while carry is above 0, a.effect2 fires with magnitude equal to
  // the carry value. The output of the first effect sets the size of the second.
  chain: {
    role: 'hold',
    slots: [S.TRIGGER, S.EFFECT, S.EFFECT], weight: 3, depthCost: 1,
    emit(a, c) {
      const key = c.key('carry');
      return {
        cells: [c.cell(key, { hold: 'none', level: 'real', cap: c.capExpr(0.15, 0.5) })],
        clauses: [
          { on: a.trigger, when: a.triggerGuard,
            do: c.effects(a.effect).concat([{ emit: 'cell', cell: key, verb: 'add', value: { frame: 'amount' } }]) },
          { on: 'tick', when: { cell: key, of: 'v', op: 'gt', v: 0 },
            do: c.effects(a.effect2, { magnitude: { cell: key, of: 'v' } }) },
        ],
        read: { when: 'On ' + c.plain(a.trigger), then: 'and what it takes feeds what it gives' },
      };
    },
  },
};

REL.TABLE = TABLE;
REL.IDS = Object.keys(TABLE);
REL.SLOTS = S;

// Returns a relation tree's shape signature as a string, ignoring which quantities filled the
// leaves. Two trees with the same signature have the same structure, which makes the number of
// distinct structures in a generated corpus countable.
REL.signature = function signature(node) {
  if (!node || !node.rel) return 'leaf';
  const kids = (node.args || []).map(REL.signature).filter(x => x !== 'leaf');
  return kids.length ? node.rel + '(' + kids.join(',') + ')' : node.rel;
};

REL.depth = function depth(node) {
  if (!node || !node.rel) return 0;
  const kids = (node.args || []).map(REL.depth);
  return 1 + (kids.length ? Math.max.apply(null, kids) : 0);
};
})();
