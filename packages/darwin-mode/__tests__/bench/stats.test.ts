// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { bootstrapDelta, makeRng } from '../../src/bench/stats.js';

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
    });
    expect(bootstrapDelta([0.5], [], { seed: 7, samples: 100 })).toEqual({
      meanDelta: 0,
      lower95: 0,
      upper95: 0,
      promote: false,
      samples: 100,
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
});
