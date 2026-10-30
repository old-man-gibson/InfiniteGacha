# Written before the relational generator was built

The claim under test: **the corpus is dull because the generator composes lists of effects, not
relationships between them.** If that is right, replacing six hand-written shape templates with a
dozen nesting relations should move specific numbers. If those numbers move and the output still
reads as dull, the claim was wrong and the honest conclusion is that runtime generation is the wrong
tool for this, not that the grammar needs another dozen relations.

Recording the thresholds now so the verdict cannot be adjusted to fit whatever comes out.

## Baseline, measured over 600 facets from the current generator

| | |
|---|---|
| Distinct STRUCTURES (not leaves) | **6** — plain, accumulator, counter, mode, collection, latch |
| Any part refers to another part | 69% (almost all of it one template) |
| Real feedback loop | 55% (almost all of it the accumulator template) |
| Purely conjunctive — A and B and C, unlinked | 31% |
| Drawback coupled to the upside | **4%** of the facets that have one |
| Maximum reference depth | 1 (a clause reads a cell) |

## What counts as the machinery working

1. **Distinct structures ≥ 60** in a 600-facet corpus. Not distinct facets — distinct *shapes of
   relation tree*, ignoring which quantities filled the leaves. Six is the number to beat and the
   bar is a tenfold rise, because if nesting works the count should be combinatorial rather than
   enumerable.
2. **Coupled drawbacks ≥ 60%.** A cost drawn from the same resource the upside spends is the single
   clearest marker of a relationship rather than a staple. 4% is the number to beat.
3. **Reference depth ≥ 2** on at least a quarter of facets — a relation whose argument is itself a
   relation. Depth 1 is what templates give; depth 2+ is the only evidence that composition is
   happening at all.
4. **Conjunctive share ≤ 10%.**
5. Everything still passes: the mortality bound, the 40,000-blow pipeline identity, the price band.

## What counts as it being INTERESTING, which is a different question

The numbers above can all be met by a system that is mechanically composed and still boring. So the
real test is reading twenty-five of them, and the honest markers are:

- Can a player state, in one sentence, what DECISION the ability gives them? An ability that only
  makes numbers larger poses no decision.
- Does the drawback make the upside a *choice* rather than a tax?
- Would two characters holding different facets from this corpus play differently, or merely have
  different numbers?

If 1–5 are met and those three still read as no, then the diagnosis was wrong, and the right move is
to stop building the generator and turn what exists into a candidate mill for hand-curation. That is
a legitimate outcome and this file exists so that it can be called honestly.

## Prediction

I expect 1, 3 and 4 to pass comfortably, 2 to pass, and the qualitative read to come out **partly**
better — noticeably less filler, several genuinely interesting shapes, and a long tail that is still
mechanical noise. I do not expect it to reach hand-authored quality. If the qualitative read comes
out no better at all, the conjunction-versus-relation diagnosis was wrong.
