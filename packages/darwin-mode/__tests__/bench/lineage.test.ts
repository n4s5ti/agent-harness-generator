// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import {
  archiveDiversity,
  descendantPotential,
  parentSelectionScore,
  selectParentsByPotential,
} from '../../src/bench/lineage.js';
import type { LineageNode } from '../../src/bench/types.js';

/** Build a LineageNode with sane defaults; override only what a test cares about. */
function node(overrides: Partial<LineageNode> & { id: string }): LineageNode {
  return {
    parentId: null,
    score: 0,
    children: [],
    ...overrides,
  };
}

/** Assemble a Map<string, LineageNode> from a list of nodes. */
function lineage(...ns: LineageNode[]): Map<string, LineageNode> {
  return new Map(ns.map((n) => [n.id, n]));
}

describe('descendantPotential', () => {
  it('lifts a low-scoring node by its best descendants (top-K average minus self)', () => {
    // low (0.3) → [high1 (0.9), high2 (0.85)]
    // avgTop2 = (0.9 + 0.85) / 2 = 0.875; potential = 0.875 - 0.3 = 0.575
    const nodes = lineage(
      node({ id: 'low', score: 0.3, children: ['high1', 'high2'] }),
      node({ id: 'high1', parentId: 'low', score: 0.9 }),
      node({ id: 'high2', parentId: 'low', score: 0.85 }),
    );
    expect(descendantPotential('low', nodes)).toBeGreaterThan(0);
    expect(descendantPotential('low', nodes)).toBe(0.575);
  });

  it('returns 0 for a leaf (no descendants)', () => {
    const nodes = lineage(node({ id: 'leaf', score: 0.7 }));
    expect(descendantPotential('leaf', nodes)).toBe(0);
  });

  it('returns 0 for an absent node', () => {
    expect(descendantPotential('ghost', lineage())).toBe(0);
  });

  it('honours topK when more descendants exist', () => {
    // self 0.0; descendants 0.9, 0.8, 0.1. topK=2 ⇒ avg(0.9,0.8)=0.85.
    const nodes = lineage(
      node({ id: 'r', score: 0, children: ['a', 'b', 'c'] }),
      node({ id: 'a', parentId: 'r', score: 0.9 }),
      node({ id: 'b', parentId: 'r', score: 0.8 }),
      node({ id: 'c', parentId: 'r', score: 0.1 }),
    );
    expect(descendantPotential('r', nodes, 2)).toBe(0.85);
  });

  it('can be negative when descendants regressed below the node', () => {
    const nodes = lineage(
      node({ id: 'r', score: 0.8, children: ['a'] }),
      node({ id: 'a', parentId: 'r', score: 0.2 }),
    );
    expect(descendantPotential('r', nodes)).toBe(-0.6);
  });

  it('is cycle-guarded: a 2-cycle a↔b terminates', () => {
    // a lists b as a child and b lists a as a child — a malformed tree.
    const nodes = lineage(
      node({ id: 'a', score: 0.5, children: ['b'] }),
      node({ id: 'b', score: 0.6, children: ['a'] }),
    );
    // Must terminate (not infinite-loop). From a, the only descendant is b.
    expect(descendantPotential('a', nodes)).toBe(round6(0.6 - 0.5));
    expect(descendantPotential('b', nodes)).toBe(round6(0.5 - 0.6));
  });
});

describe('archiveDiversity', () => {
  it('a node with 0 siblings scores 1', () => {
    const nodes = lineage(
      node({ id: 'p', children: ['only'] }),
      node({ id: 'only', parentId: 'p' }),
    );
    expect(archiveDiversity('only', nodes)).toBe(1);
  });

  it('a node with 3 siblings scores 1/4', () => {
    const nodes = lineage(
      node({ id: 'p', children: ['x', 's1', 's2', 's3'] }),
      node({ id: 'x', parentId: 'p' }),
      node({ id: 's1', parentId: 'p' }),
      node({ id: 's2', parentId: 'p' }),
      node({ id: 's3', parentId: 'p' }),
    );
    expect(archiveDiversity('x', nodes)).toBe(0.25);
  });

  it('a root (no parent) scores 1', () => {
    const nodes = lineage(node({ id: 'root', parentId: null }));
    expect(archiveDiversity('root', nodes)).toBe(1);
  });

  it('a node whose parent is absent from the map scores 1', () => {
    const nodes = lineage(node({ id: 'orphan', parentId: 'missing' }));
    expect(archiveDiversity('orphan', nodes)).toBe(1);
  });
});

describe('parentSelectionScore — best branch beats best agent', () => {
  // A LOW-scoring branch root vs. a HIGH-scoring sterile leaf, both roots so
  // archiveDiversity = 1 for each and the contest turns on descendant potential.
  //
  //   lowBranch (0.30) → [d1 (0.90), d2 (0.85)]   highLeaf (0.70), no children
  //
  // descendantPotential(lowBranch) = avg(0.90, 0.85) - 0.30 = 0.875 - 0.30 = 0.575
  // descendantPotential(highLeaf)  = 0  (leaf)
  // archiveDiversity = 1 for both (both are roots).
  //
  // With weights {score: 0.40, potential: 0.50, diversity: 0.10}:
  //   lowBranch = 0.40*0.30 + 0.50*0.575 + 0.10*1 = 0.120 + 0.2875 + 0.10 = 0.5075
  //   highLeaf  = 0.40*0.70 + 0.50*0      + 0.10*1 = 0.280 + 0      + 0.10 = 0.380
  //   ⇒ 0.5075 > 0.380: the fertile branch wins.
  const weights = { score: 0.4, potential: 0.5, diversity: 0.1 };
  const nodes = lineage(
    node({ id: 'lowBranch', score: 0.3, children: ['d1', 'd2'] }),
    node({ id: 'd1', parentId: 'lowBranch', score: 0.9 }),
    node({ id: 'd2', parentId: 'lowBranch', score: 0.85 }),
    node({ id: 'highLeaf', score: 0.7 }),
  );

  it('descendantPotential(lowBranch) > 0', () => {
    expect(descendantPotential('lowBranch', nodes)).toBeGreaterThan(0);
  });

  it('the best BRANCH out-ranks the best AGENT', () => {
    const branch = parentSelectionScore('lowBranch', nodes, weights);
    const leaf = parentSelectionScore('highLeaf', nodes, weights);
    expect(branch).toBe(0.5075);
    expect(leaf).toBe(0.38);
    expect(branch).toBeGreaterThan(leaf);
  });

  it('returns 0 for an absent node', () => {
    expect(parentSelectionScore('ghost', nodes)).toBe(0);
  });

  it('uses ADR-076 defaults {0.70, 0.20, 0.10} when no weights given', () => {
    // highLeaf: 0.70*0.7 + 0.20*0 + 0.10*1 = 0.49 + 0.10 = 0.59
    expect(parentSelectionScore('highLeaf', nodes)).toBe(0.59);
  });
});

describe('selectParentsByPotential', () => {
  it('returns the 2 highest selection-score ids, deterministic across runs', () => {
    const weights = { score: 0.4, potential: 0.5, diversity: 0.1 };
    const nodes = lineage(
      node({ id: 'lowBranch', score: 0.3, children: ['d1', 'd2'] }),
      node({ id: 'd1', parentId: 'lowBranch', score: 0.9 }),
      node({ id: 'd2', parentId: 'lowBranch', score: 0.85 }),
      node({ id: 'highLeaf', score: 0.7 }),
    );
    // Selection scores under these weights / default diversity:
    //   lowBranch = 0.5075
    //   d1 = 0.4*0.9 + 0 + 0.1*0.5 = 0.36 + 0.05 = 0.41
    //   highLeaf  = 0.38
    //   d2 = 0.4*0.85 + 0 + 0.1*0.5 = 0.34 + 0.05 = 0.39
    // Top 2 = [lowBranch, d1].
    const first = selectParentsByPotential(nodes, 2, weights);
    const second = selectParentsByPotential(nodes, 2, weights);
    expect(first).toEqual(['lowBranch', 'd1']);
    expect(first).toEqual(second); // deterministic across runs
  });

  it('breaks ties by id ascending', () => {
    // Three roots, all identical score, all leaves ⇒ identical selection score.
    const nodes = lineage(
      node({ id: 'gamma', score: 0.5 }),
      node({ id: 'alpha', score: 0.5 }),
      node({ id: 'beta', score: 0.5 }),
    );
    expect(selectParentsByPotential(nodes, 2)).toEqual(['alpha', 'beta']);
    expect(selectParentsByPotential(nodes, 3)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('returns an empty list for a non-positive limit', () => {
    const nodes = lineage(node({ id: 'a', score: 0.5 }));
    expect(selectParentsByPotential(nodes, 0)).toEqual([]);
    expect(selectParentsByPotential(nodes, -1)).toEqual([]);
  });
});

/** Local 6-decimal rounder mirroring the module, for asserting derived values. */
function round6(value: number): number {
  return +(Math.round(value * 1e6) / 1e6).toFixed(6);
}
