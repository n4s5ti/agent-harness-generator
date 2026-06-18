// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import {
  allGatesPass,
  costGate,
  evaluateGates,
  regressionGate,
  reproGate,
  safetyGate,
  solveGate,
} from '../../src/bench/gates.js';
import type { BenchmarkResult, BenchmarkTask } from '../../src/bench/types.js';

/** A passing-everything result; override only what a test cares about. */
function result(overrides: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    taskId: 't',
    variantId: 'v',
    parentId: null,
    repoCommit: 'abc123',
    solved: true,
    publicTestPassed: true,
    hiddenTestPassed: true,
    regressionPassed: true,
    durationMs: 1000,
    costUsd: 1,
    changedFiles: [],
    blockedFileTouches: [],
    safetyViolations: [],
    hallucinatedFileRefs: false,
    traceQuality: 0.9,
    patchPath: 'p',
    tracePath: 't',
    baseScore: 0.96,
    finalScore: 0.96,
    ...overrides,
  };
}

/** A task whose cost budget the default result is within. */
function task(overrides: Partial<BenchmarkTask> = {}): BenchmarkTask {
  return {
    id: 't',
    repo: 'r',
    commit: 'abc123',
    title: 'title',
    prompt: 'do it',
    publicTestCommand: 'npm test',
    hiddenTestCommand: 'npm run hidden',
    regressionTestCommand: 'npm run all',
    timeoutMs: 100_000,
    maxCostUsd: 10,
    allowedMutationFiles: ['src/x.ts'],
    blockedFiles: ['ci.yml'],
    successCriteria: ['passes'],
    difficulty: 2,
    tags: [],
    ...overrides,
  };
}

describe('solveGate', () => {
  it('passes iff public AND hidden tests pass', () => {
    expect(solveGate(result()).pass).toBe(true);
    expect(solveGate(result({ publicTestPassed: false })).pass).toBe(false);
    expect(solveGate(result({ hiddenTestPassed: false })).pass).toBe(false);
  });
  it('reports gate name', () => {
    expect(solveGate(result()).gate).toBe('solve');
  });
});

describe('regressionGate', () => {
  it('passes iff regression suite passes', () => {
    expect(regressionGate(result()).pass).toBe(true);
    expect(regressionGate(result({ regressionPassed: false })).pass).toBe(false);
  });
});

describe('safetyGate', () => {
  it('passes iff no violations and no blocked-file touches', () => {
    expect(safetyGate(result()).pass).toBe(true);
    expect(safetyGate(result({ safetyViolations: ['x'] })).pass).toBe(false);
    expect(safetyGate(result({ blockedFileTouches: ['ci.yml'] })).pass).toBe(false);
  });
});

describe('costGate', () => {
  it('passes iff costUsd <= task.maxCostUsd', () => {
    expect(costGate(result({ costUsd: 10 }), task({ maxCostUsd: 10 })).pass).toBe(true);
    expect(costGate(result({ costUsd: 11 }), task({ maxCostUsd: 10 })).pass).toBe(false);
  });
});

describe('reproGate', () => {
  it('passes iff cleanReplay', () => {
    expect(reproGate(true).pass).toBe(true);
    expect(reproGate(false).pass).toBe(false);
  });
});

describe('evaluateGates', () => {
  it('returns all five gates in canonical order', () => {
    const gates = evaluateGates(result(), task(), true);
    expect(gates.map((g) => g.gate)).toEqual([
      'solve',
      'regression',
      'safety',
      'cost',
      'repro',
    ]);
  });

  it('an unsafe result fails the safety gate (and only it)', () => {
    const gates = evaluateGates(result({ safetyViolations: ['rm'] }), task(), true);
    const failed = gates.filter((g) => !g.pass).map((g) => g.gate);
    expect(failed).toEqual(['safety']);
  });

  it('an over-budget result fails the cost gate (and only it)', () => {
    const gates = evaluateGates(result({ costUsd: 99 }), task({ maxCostUsd: 10 }), true);
    const failed = gates.filter((g) => !g.pass).map((g) => g.gate);
    expect(failed).toEqual(['cost']);
  });

  it('a dirty replay fails the repro gate (and only it)', () => {
    const gates = evaluateGates(result(), task(), false);
    const failed = gates.filter((g) => !g.pass).map((g) => g.gate);
    expect(failed).toEqual(['repro']);
  });
});

describe('allGatesPass', () => {
  it('is true only when every gate passes', () => {
    expect(allGatesPass(evaluateGates(result(), task(), true))).toBe(true);
    expect(allGatesPass(evaluateGates(result(), task(), false))).toBe(false);
    expect(
      allGatesPass(evaluateGates(result({ regressionPassed: false }), task(), true)),
    ).toBe(false);
  });
});
