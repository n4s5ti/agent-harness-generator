// SPDX-License-Identifier: MIT
//
// Seeded bootstrap statistics (ADR-076) — the anti-noise guard on promotion.
// A child is only "really" better than its parent when the lower 95% bound on
// the bootstrapped parent→child score delta is above zero, not one lucky run.
//
// CRITICAL: the bootstrap MUST be reproducible. The reference design used
// `Math.random()`, which is non-deterministic and would itself fail the Repro
// gate (ADR-076 §statistical promotion). This module uses a SEEDED mulberry32
// PRNG, so the verdict is byte-reproducible from a clean checkout: the same
// (scores, seed) always yields the identical lower95/meanDelta.
//
// Pure (the RNG is seeded), no I/O.

import type { BootstrapResult } from './types.js';

/**
 * mulberry32 — a tiny, fast, deterministic 32-bit PRNG. Returns a stateful
 * generator producing floats in [0, 1). Seeding it makes the whole bootstrap
 * reproducible, which is the entire point: re-running from a clean checkout
 * yields the identical promotion verdict (ADR-076 Repro gate).
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Round to 6 decimal places. Kills float-representation noise so the bootstrap
 * output is byte-identical across runs and clean in JSON artifacts. The leading
 * `+` drops any `-0`. Re-implemented locally to keep this module dependency-free.
 */
function round6(value: number): number {
  return +(Math.round(value * 1e6) / 1e6).toFixed(6);
}

/**
 * Seeded bootstrap over the parent→child per-task score deltas.
 *
 * Draws `samples` independent bootstrap deltas: each iteration picks one parent
 * score and one child score uniformly at random (from the seeded PRNG) and
 * records `child - parent`. The sorted deltas give the mean and the 2.5%/97.5%
 * percentiles. `promote` requires both a meaningful mean (> `minDelta`) and a
 * lower-95% bound above zero (the win is statistically real).
 *
 * Empty parent or child arrays yield a safe zero result (nothing to promote).
 * Pure and deterministic for a fixed `seed`.
 */
export function bootstrapDelta(
  parentScores: number[],
  childScores: number[],
  opts?: { samples?: number; seed?: number; minDelta?: number },
): BootstrapResult {
  const samples = opts?.samples ?? 5000;
  const seed = opts?.seed ?? 0;
  const minDelta = opts?.minDelta ?? 0.05;

  if (parentScores.length === 0 || childScores.length === 0) {
    return { meanDelta: 0, lower95: 0, upper95: 0, promote: false, samples };
  }

  const rng = makeRng(seed);
  const deltas: number[] = new Array(samples);
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const parent = parentScores[Math.floor(rng() * parentScores.length)];
    const child = childScores[Math.floor(rng() * childScores.length)];
    const delta = child - parent;
    deltas[i] = delta;
    sum += delta;
  }

  deltas.sort((x, y) => x - y);

  const meanDelta = round6(sum / samples);
  const lower95 = round6(deltas[Math.floor(samples * 0.025)]);
  const upper95 = round6(deltas[Math.floor(samples * 0.975)]);
  const promote = meanDelta > minDelta && lower95 > 0;

  return { meanDelta, lower95, upper95, promote, samples };
}
