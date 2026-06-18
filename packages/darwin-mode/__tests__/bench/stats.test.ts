// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { bootstrapDelta, makeRng, benjaminiHochberg } from '../../src/bench/stats.js';

/** Deterministic pseudo-distribution around `centre` ± `spread`, seeded. */
function distribution(centre: number, spread: number, n: number, seed: number): number[] {
  const rng = makeRng(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) out.push(centre + (rng() - 0.5) * 2 * spread);
  return out;
}

describe('makeRng', () => {
  it('is deterministic for a fixed seed and yields floats in [0,1)', () => {
    const a = makeRng(42);
    const b = makeRng(42);
    for (let i = 0; i < 10; i += 1) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('differs across seeds', () => {
    expect(makeRng(1)()).not.toBe(makeRng(2)());
  });
});

describe('bootstrapDelta', () => {
  it('is reproducible: same seed ⇒ identical lower95 and meanDelta', () => {
    const parent = distribution(0.5, 0.05, 20, 1);
    const child = distribution(0.7, 0.05, 20, 2);
    const a = bootstrapDelta(parent, child, { seed: 7 });
    const b = bootstrapDelta(parent, child, { seed: 7 });
    expect(a.lower95).toBe(b.lower95);
    expect(a.meanDelta).toBe(b.meanDelta);
    expect(a.upper95).toBe(b.upper95);
    expect(a.promote).toBe(b.promote);
  });

  it('promotes a clearly-better child (lower95 > 0, promote true)', () => {
    const parent = distribution(0.5, 0.03, 30, 11);
    const child = distribution(0.7, 0.03, 30, 12);
    const res = bootstrapDelta(parent, child, { seed: 7 });
    expect(res.lower95).toBeGreaterThan(0);
    expect(res.meanDelta).toBeGreaterThan(0.05);
    expect(res.promote).toBe(true);
  });

  it('does not promote a noisy tie (overlapping distributions)', () => {
    const parent = distribution(0.5, 0.3, 40, 21);
    const child = distribution(0.51, 0.3, 40, 22);
    const res = bootstrapDelta(parent, child, { seed: 7 });
    expect(res.promote).toBe(false);
    expect(res.lower95).toBeLessThanOrEqual(0);
  });

  it('returns a safe zero result for empty arrays', () => {
    expect(bootstrapDelta([], [0.7], { seed: 7 })).toEqual({
      meanDelta: 0,
      lower95: 0,
      upper95: 0,
      promote: false,
      samples: 5000,
      pValue: 1,
    });
    expect(bootstrapDelta([0.5], [], { seed: 7, samples: 100 })).toEqual({
      meanDelta: 0,
      lower95: 0,
      upper95: 0,
      promote: false,
      samples: 100,
      pValue: 1,
    });
  });

  it('different seeds may differ but both are finite', () => {
    const parent = distribution(0.5, 0.05, 20, 1);
    const child = distribution(0.7, 0.05, 20, 2);
    const a = bootstrapDelta(parent, child, { seed: 1 });
    const b = bootstrapDelta(parent, child, { seed: 999 });
    expect(Number.isFinite(a.meanDelta)).toBe(true);
    expect(Number.isFinite(b.meanDelta)).toBe(true);
    expect(Number.isFinite(a.lower95)).toBe(true);
    expect(Number.isFinite(b.lower95)).toBe(true);
  });

  it('honours the samples option', () => {
    const res = bootstrapDelta([0.5], [0.7], { seed: 7, samples: 250 });
    expect(res.samples).toBe(250);
  });

  it('reports a low p-value for a clear win and a high one for no difference', () => {
    const win = bootstrapDelta([0.2, 0.3], [0.9, 0.95], { seed: 1, samples: 2000 });
    const tie = bootstrapDelta([0.5, 0.5], [0.5, 0.5], { seed: 1, samples: 2000 });
    expect(win.pValue).toBeLessThan(0.05);
    expect(tie.pValue).toBeGreaterThan(0.5); // delta==0 counts as ≤0
  });
});

describe('benjaminiHochberg (FDR control, ADR-096)', () => {
  it('rejects nothing when all p-values are large', () => {
    expect(benjaminiHochberg([0.4, 0.6, 0.9], 0.05)).toEqual([false, false, false]);
  });

  it('rejects the clearly-significant hypotheses at q=0.05', () => {
    // 4 hypotheses; two tiny p-values should survive BH, two large should not.
    const rejected = benjaminiHochberg([0.001, 0.002, 0.40, 0.80], 0.05);
    expect(rejected[0]).toBe(true);
    expect(rejected[1]).toBe(true);
    expect(rejected[2]).toBe(false);
    expect(rejected[3]).toBe(false);
  });

  it('is stricter than the per-comparison threshold (controls false discoveries)', () => {
    // p=0.04 would pass a naive α=0.05 test, but among 10 hypotheses where it is
    // the only smallish one, BH at q=0.05 rejects it (no false discovery).
    const ps = [0.04, ...Array(9).fill(0.9)];
    expect(benjaminiHochberg(ps, 0.05)[0]).toBe(false);
  });

  it('handles empty input and q<=0', () => {
    expect(benjaminiHochberg([], 0.05)).toEqual([]);
    expect(benjaminiHochberg([0.001], 0)).toEqual([false]);
  });
});
