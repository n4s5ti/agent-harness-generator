// SPDX-License-Identifier: MIT
//
// Tests for epistatic linkage learning (ADR-093): co-occurrence accrues to pairs
// in high-fitness lineages, linked surfaces rank by weight, and the crossover
// block keeps a co-adapted pair together as a proper non-empty subset.

import { describe, expect, it } from 'vitest';
import { LinkageGraph, buildLinkage, linkedCrossoverBlock } from '../src/epistasis.js';
import { SURFACES } from '../src/safety.js';

describe('LinkageGraph', () => {
  it('accumulates symmetric co-occurrence weight for pairs', () => {
    const g = new LinkageGraph();
    g.record(['planner', 'retryPolicy'], 0.9);
    g.record(['planner', 'retryPolicy'], 0.5);
    expect(g.weight('planner', 'retryPolicy')).toBeCloseTo(1.4, 6);
    expect(g.weight('retryPolicy', 'planner')).toBeCloseTo(1.4, 6); // symmetric
    expect(g.weight('planner', 'planner')).toBe(0); // no self-edge
    expect(g.weight('planner', 'reviewer')).toBe(0); // never co-observed
  });

  it('ranks linked surfaces strongest-first', () => {
    const g = new LinkageGraph();
    g.record(['planner', 'retryPolicy'], 1.0);
    g.record(['planner', 'reviewer'], 0.3);
    expect(g.linkedTo('planner')).toEqual(['retryPolicy', 'reviewer']);
    expect(g.linkedTo('planner', 0.5)).toEqual(['retryPolicy']); // threshold filters
  });
});

describe('buildLinkage', () => {
  it('weights co-occurrence by lineage finalScore (high-fitness pairs dominate)', () => {
    const g = buildLinkage([
      { surfaces: ['planner', 'retryPolicy'], score: 0.985 },
      { surfaces: ['toolPolicy', 'memoryPolicy'], score: 0.2 },
    ]);
    expect(g.weight('planner', 'retryPolicy')).toBeGreaterThan(g.weight('toolPolicy', 'memoryPolicy'));
  });

  it('clamps negative scores to zero (no negative evidence)', () => {
    const g = buildLinkage([{ surfaces: ['planner', 'reviewer'], score: -1 }]);
    expect(g.weight('planner', 'reviewer')).toBe(0);
  });
});

describe('linkedCrossoverBlock', () => {
  it('returns the seed plus its strongly-linked neighbours, kept a proper subset', () => {
    const g = new LinkageGraph();
    g.record(['planner', 'retryPolicy'], 1.0);
    const block = linkedCrossoverBlock(g, 'planner');
    expect(block).toContain('planner');
    expect(block).toContain('retryPolicy'); // the co-adapted partner stays together
    expect(block.length).toBeLessThan(SURFACES.length); // never all seven
  });

  it('falls back to just the seed when nothing is linked', () => {
    expect(linkedCrossoverBlock(new LinkageGraph(), 'reviewer')).toEqual(['reviewer']);
  });
});
