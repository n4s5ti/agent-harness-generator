// SPDX-License-Identifier: MIT
//
// Tests for multi-objective Pareto selection (ADR-100). Higher is better on every
// objective; the front is the non-dominated set, order-preserving.

import { describe, expect, it } from 'vitest';
import { paretoFront } from '../src/pareto.js';

describe('paretoFront', () => {
  it('keeps only non-dominated items', () => {
    // objectives [score↑, -bytes↑]. C is dominated by B (same score, fewer bytes).
    const items = [
      { id: 'A', score: 0.9, bytes: 100 }, // high score, big
      { id: 'B', score: 0.7, bytes: 50 },  // lower score, small
      { id: 'C', score: 0.7, bytes: 90 },  // dominated by B
    ];
    const front = paretoFront(items, (o) => [o.score, -o.bytes]);
    expect(front.map((o) => o.id).sort()).toEqual(['A', 'B']); // A and B trade off; C drops
  });

  it('a single item is its own front', () => {
    expect(paretoFront([{ x: 1 }], (o) => [o.x])).toEqual([{ x: 1 }]);
  });

  it('the global max on every axis is the sole front member', () => {
    const items = [
      { id: 'best', a: 9, b: 9 },
      { id: 'x', a: 1, b: 1 },
      { id: 'y', a: 5, b: 2 },
    ];
    expect(paretoFront(items, (o) => [o.a, o.b]).map((o) => o.id)).toEqual(['best']);
  });

  it('preserves input order among front members (deterministic)', () => {
    const items = [
      { id: 'p', a: 1, b: 3 },
      { id: 'q', a: 2, b: 2 },
      { id: 'r', a: 3, b: 1 },
    ];
    // All three are mutually non-dominated (a classic trade-off front).
    expect(paretoFront(items, (o) => [o.a, o.b]).map((o) => o.id)).toEqual(['p', 'q', 'r']);
  });

  it('empty input → empty front', () => {
    expect(paretoFront([], (o) => [o])).toEqual([]);
  });
});
