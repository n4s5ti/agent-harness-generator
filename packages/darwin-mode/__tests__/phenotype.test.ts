// SPDX-License-Identifier: MIT
//
// Tests for hyperbolic behavioral phenotyping (ADR-091): the Poincaré geometry
// is correct (metric axioms + boundary blow-up), the embedding stays inside the
// open ball, and distinct behaviours land in distinct hyperbolic niches.

import { describe, expect, it } from 'vitest';
import {
  behaviorFeatures,
  poincareEmbed,
  poincareDistance,
  behavioralNiche,
} from '../src/phenotype.js';
import type { RunTrace } from '../src/types.js';

function trace(over: Partial<RunTrace> = {}): RunTrace {
  return {
    variantId: 'v', taskId: 't', startedAt: '', finishedAt: '', exitCode: 0,
    stdout: '', stderr: '', durationMs: 100, timedOut: false, blockedActions: [],
    ...over,
  };
}

describe('poincareDistance (metric axioms)', () => {
  it('is zero for identical points', () => {
    expect(poincareDistance([0.2, 0.3], [0.2, 0.3])).toBeCloseTo(0, 12);
  });

  it('is symmetric and positive for distinct points', () => {
    const a = [0.1, 0.0], b = [0.4, 0.2];
    expect(poincareDistance(a, b)).toBeGreaterThan(0);
    expect(poincareDistance(a, b)).toBeCloseTo(poincareDistance(b, a), 12);
  });

  it('blows up toward the boundary (same Euclidean gap costs more near the edge)', () => {
    const near = poincareDistance([0.0, 0], [0.1, 0]);
    const edge = poincareDistance([0.88, 0], [0.98, 0]);
    expect(edge).toBeGreaterThan(near * 3); // hyperbolic expansion near ‖p‖→1
  });
});

describe('poincareEmbed', () => {
  it('always lands strictly inside the open unit ball', () => {
    const extreme = poincareEmbed({
      failRate: 1, timeoutRate: 1, blockRate: 1, verbosity: 1, repetition: 1, durationSpread: 1,
    });
    const norm = Math.hypot(extreme[0], extreme[1]);
    expect(norm).toBeLessThan(1);
  });

  it('clean behaviour sits near the origin; struggling behaviour near the boundary', () => {
    const clean = poincareEmbed(behaviorFeatures([trace(), trace()]));
    const struggling = poincareEmbed(behaviorFeatures([
      trace({ exitCode: 1, timedOut: true, stdout: 'retry\nretry\nretry\nretry' }),
      trace({ exitCode: 1, timedOut: true, stdout: 'loop\nloop\nloop' }),
    ]));
    expect(Math.hypot(...clean)).toBeLessThan(Math.hypot(...struggling));
  });
});

describe('behavioralNiche', () => {
  it('is deterministic for the same behaviour', () => {
    const ts = [trace({ exitCode: 1, stdout: 'a\na\nb' })];
    expect(behavioralNiche(ts)).toBe(behavioralNiche(ts));
  });

  it('separates a deep recursive struggler from a clean shallow agent', () => {
    const shallow = behavioralNiche([trace(), trace()]);
    const deep = behavioralNiche([
      trace({ exitCode: 1, timedOut: true, stdout: 'x\nx\nx\nx\nx' }),
      trace({ exitCode: 1, timedOut: true, stdout: 'y\ny\ny\ny' }),
    ]);
    expect(shallow).not.toBe(deep);
  });

  it('empty traces map to a stable origin niche', () => {
    expect(behavioralNiche([])).toBe(behavioralNiche([]));
  });
});
