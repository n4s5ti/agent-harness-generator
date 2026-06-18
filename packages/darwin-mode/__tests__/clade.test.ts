// SPDX-License-Identifier: MIT
//
// Tests for clade-metaproductivity selection (ADR-094, Huxley-Gödel). The seeded
// Beta sampler is calibrated (sample mean ≈ a/(a+b)), clade outcomes aggregate
// over the subtree, and Thompson selection favours high-metaproductivity clades
// while staying reproducible for a fixed seed.

import { describe, expect, it } from 'vitest';
import { Archive } from '../src/archive.js';
import { mulberry32, sampleBeta, cladeOutcomes, cladeThompsonSelect } from '../src/clade.js';
import type { HarnessVariant, ScoreCard } from '../src/types.js';

function variant(id: string, parentId: string | null): HarnessVariant {
  return {
    id, parentId, generation: 0, dir: `/tmp/${id}`,
    mutationSurface: 'planner', mutationSummary: id, createdAt: '2026-06-17T00:00:00.000Z',
  };
}
function score(id: string, promoted: boolean): ScoreCard {
  return {
    variantId: id, taskSuccess: 1, testPassRate: 1, traceQuality: 0.9,
    costEfficiency: 1, latencyEfficiency: 1, safetyScore: 1,
    secretExposure: 0, destructiveAction: 0, hallucinatedFile: 0, toolLoop: 0, costOverrun: 0,
    baseScore: 0.985, finalScore: 0.985, promoted, reason: 't',
  };
}

describe('sampleBeta (seeded, calibrated)', () => {
  it('sample mean approximates a/(a+b)', () => {
    const rng = mulberry32(12345);
    let sum = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) sum += sampleBeta(rng, 3, 7);
    expect(sum / N).toBeCloseTo(3 / 10, 1); // within ~0.05
  });

  it('is reproducible for a fixed seed', () => {
    const a = mulberry32(99), b = mulberry32(99);
    expect(sampleBeta(a, 2, 5)).toBe(sampleBeta(b, 2, 5));
  });
});

describe('cladeOutcomes', () => {
  it('aggregates promoted/non-promoted over the whole descendant subtree', () => {
    // baseline → c1 (promoted) → c2 (promoted); baseline → c3 (not promoted)
    const a = new Archive('/unused.json');
    for (const v of [variant('baseline', null), variant('c1', 'baseline'), variant('c2', 'c1'), variant('c3', 'baseline')]) {
      a.addVariant(v);
    }
    a.setScore('baseline', score('baseline', false));
    a.setScore('c1', score('c1', true));
    a.setScore('c2', score('c2', true));
    a.setScore('c3', score('c3', false));

    expect(cladeOutcomes(a, 'c1')).toEqual({ passes: 2, failures: 0 }); // c1 + c2
    expect(cladeOutcomes(a, 'baseline')).toEqual({ passes: 2, failures: 2 }); // whole tree
  });
});

describe('cladeThompsonSelect', () => {
  it('favours the high-metaproductivity clade over a barren one', () => {
    const a = new Archive('/unused.json');
    // 'fertile' subtree: many promoted descendants. 'barren': all failures.
    a.addVariant(variant('fertile', null));
    a.addVariant(variant('barren', null));
    for (let i = 0; i < 6; i++) {
      a.addVariant(variant(`f${i}`, 'fertile'));
      a.setScore(`f${i}`, score(`f${i}`, true));
    }
    for (let i = 0; i < 6; i++) {
      a.addVariant(variant(`b${i}`, 'barren'));
      a.setScore(`b${i}`, score(`b${i}`, false));
    }
    a.setScore('fertile', score('fertile', true));
    a.setScore('barren', score('barren', false));

    // High τ (exploitation): the fertile root should top the ranking most of the time.
    let fertileWins = 0;
    for (let s = 0; s < 30; s++) {
      const top = cladeThompsonSelect(a, 5, 1, s)[0];
      if (top && (top.id === 'fertile' || top.id.startsWith('f'))) fertileWins += 1;
    }
    expect(fertileWins).toBeGreaterThan(20);
  });

  it('is reproducible for a fixed seed and returns [] on an empty archive', () => {
    const a = new Archive('/unused.json');
    a.addVariant(variant('x', null));
    a.setScore('x', score('x', true));
    expect(cladeThompsonSelect(a, 1, 1, 7).map((v) => v.id)).toEqual(
      cladeThompsonSelect(a, 1, 1, 7).map((v) => v.id),
    );
    expect(cladeThompsonSelect(new Archive('/u.json'), 1, 2, 1)).toEqual([]);
  });
});
