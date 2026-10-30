// Pricing oracle. Runs common-random-number Monte Carlo encounters against the five synthetic bands
// in O.BANDS. Commit 7 sets O.live to true. While O.live is false, or the host is missing any member
// O.available() checks, O.price returns F.forge.price(facet) instead and the record carries that
// estimator's source rather than 'oracle'.
//
// Why a simulation instead of a sum. Summing atom worth prices a linear modifier correctly and a
// stateful machine not at all. A cell that fills as it is struck and vents at a threshold has no
// closed form. A hand that draws five tokens and scores the multiset has a closed form, but it is
// impractical to write. Running the encounter measures both.
//
// Where the price is computed versus where it is used. The oracle needs a multi-character party
// fixture, and only one of the two hosts can build one. It runs on that host, writes the number onto
// the facet record, and the facet record is what moves between games. A host without caps.simulate
// reads the stored number and does not recompute it. When neither host can simulate, F.forge.price
// is authoritative. F.forge.price is also the estimator that seeds this search, so the two cannot
// disagree.
//
// Common random numbers. Each band is run twice from the same seed, once with the facet installed
// and once with it absent, and the pair is differenced. Without the pairing, encounter variance
// swamps the effect being measured: unpaired sampling needs roughly twenty times as many runs for
// the same resolution.

(() => {
const F = (globalThis.Facet || (globalThis.Facet = { _mods: {} }));
F._mods.oracle = true;

const O = F.oracle = {};

O.live = false;
O.RUNS_PER_BAND = 24;
O.BANDS = ['swarm', 'duel', 'elite', 'attrition', 'burst'];

O.available = function available() {
  const h = F.host();
  return !!(h && h.caps && h.caps.simulate && h.withSeed && h.buildFixture && h.runEncounter);
};

O.price = function price(facet) {
  if (!O.live || !O.available()) return F.forge.price(facet);
  const host = F.host();
  const perBand = [];

  for (const band of O.BANDS) {
    const on = [], off = [];
    for (let i = 0; i < O.RUNS_PER_BAND; i++) {
      const seed = ((facet.seed || 0) ^ (i * 2654435761)) >>> 0;
      // Both arms of the pair use the same seed value, so the difference cancels encounter variance.
      on.push(host.withSeed(seed, () => host.runEncounter(host.buildFixture({ band, facets: [facet] }))));
      off.push(host.withSeed(seed, () => host.runEncounter(host.buildFixture({ band, facets: [] }))));
    }
    perBand.push({
      band,
      ttkRatio: median(on.map(r => r.subjectTtk)) / Math.max(1e-6, median(off.map(r => r.subjectTtk))),
      winDelta: mean(on.map(r => r.won ? 1 : 0)) - mean(off.map(r => r.won ? 1 : 0)),
      hpDelta: mean(on.map(r => r.partyHpFrac)) - mean(off.map(r => r.partyHpFrac)),
    });
  }

  const hObserved = Math.max.apply(null, perBand.map(b => b.ttkRatio));
  const value = perBand.reduce((a, b) => a + b.winDelta * 40 + b.hpDelta * 25, 0) / perBand.length * host.priceScale();

  const out = { value: Math.round(value * 100) / 100, source: 'oracle', perBand, hObserved, variance: variance(perBand.map(b => b.winDelta)) };

  // hObserved is the largest per-band ttkRatio. The tick-time ledger cannot observe routes such as
  // conditional immunity or an evade stack, so those raise measured hardness without ever being
  // reported to it. Flag needsPuncture when hObserved exceeds F.data.MORTALITY.H_MAX by more than 25%.
  if (hObserved > F.data.MORTALITY.H_MAX * 1.25) out.needsPuncture = hObserved;
  return out;
};

const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const variance = (a) => { const m = mean(a); return a.length ? mean(a.map(x => (x - m) * (x - m))) : 0; };
})();
