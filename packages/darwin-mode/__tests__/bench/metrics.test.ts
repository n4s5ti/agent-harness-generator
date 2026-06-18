// SPDX-License-Identifier: MIT
//
// effective_agent_performance metric (ADR-082).

import { describe, it, expect } from 'vitest';
import {
  aggregateMetrics,
  effectiveAgentPerformance,
  effectivePerformanceGain,
} from '../../src/bench/metrics.js';
import type { BenchmarkResult } from '../../src/bench/types.js';

function result(over: Partial<BenchmarkResult>): BenchmarkResult {
  return {
    taskId: 't',
    variantId: 'v',
    parentId: null,
    repoCommit: 'c',
    solved: false,
    publicTestPassed: false,
    hiddenTestPassed: false,
    regressionPassed: false,
    durationMs: 0,
    costUsd: 0,
    changedFiles: [],
    blockedFileTouches: [],
    safetyViolations: [],
    hallucinatedFileRefs: false,
    traceQuality: 1,
    patchPath: '',
    tracePath: '',
    baseScore: 0,
    finalScore: 0,
    ...over,
  };
}

describe('effectiveAgentPerformance', () => {
  it('matches the ADR-082 worked example', () => {
    // baseline: 0.40 / 1.00 × 0.98 = 0.392
    expect(
      effectiveAgentPerformance({ verifiedSuccessRate: 0.4, costPerSuccess: 1.0, safetyScore: 0.98 }),
    ).toBe(0.392);
    // evolved: 0.52 / 0.80 × 1.00 = 0.65
    expect(
      effectiveAgentPerformance({ verifiedSuccessRate: 0.52, costPerSuccess: 0.8, safetyScore: 1.0 }),
    ).toBe(0.65);
  });

  it('reports the ~66% effective gain even though solve rate rose only 12 points', () => {
    const gain = effectivePerformanceGain(0.392, 0.65);
    expect(gain).toBeCloseTo(0.658, 3);
  });

  it('treats zero/unmetered cost as neutral (1×), never diverging', () => {
    expect(
      effectiveAgentPerformance({ verifiedSuccessRate: 0.5, costPerSuccess: 0, safetyScore: 1 }),
    ).toBe(0.5);
  });

  it('zero baseline ⇒ zero gain (no division blow-up)', () => {
    expect(effectivePerformanceGain(0, 0.5)).toBe(0);
  });
});

describe('aggregateMetrics', () => {
  it('aggregates per-task results into the report-card numbers', () => {
    const results = [
      result({ solved: true, costUsd: 0.5 }),
      result({ solved: true, costUsd: 0.5 }),
      result({ solved: false, costUsd: 0.2 }),
      result({ solved: false, costUsd: 0, safetyViolations: ['blocked content'] }),
    ];
    const m = aggregateMetrics(results);
    expect(m.total).toBe(4);
    expect(m.solved).toBe(2);
    expect(m.verifiedSuccessRate).toBe(0.5);
    expect(m.costPerSuccess).toBe(0.6); // (0.5+0.5+0.2+0)/2
    expect(m.safetyScore).toBe(0.75); // 3 of 4 tasks clean
    expect(m.effectiveAgentPerformance).toBe(
      effectiveAgentPerformance({ verifiedSuccessRate: 0.5, costPerSuccess: 0.6, safetyScore: 0.75 }),
    );
  });

  it('empty results ⇒ safe zeros (safetyScore defaults to 1)', () => {
    const m = aggregateMetrics([]);
    expect(m.verifiedSuccessRate).toBe(0);
    expect(m.costPerSuccess).toBe(0);
    expect(m.safetyScore).toBe(1);
    expect(m.effectiveAgentPerformance).toBe(0);
  });
});
