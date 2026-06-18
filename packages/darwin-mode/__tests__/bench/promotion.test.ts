// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { decidePromotion } from '../../src/bench/promotion.js';
import type { BenchmarkResult } from '../../src/bench/types.js';

/** Build a BenchmarkResult with sane, safe, solved defaults; override per test. */
function result(overrides: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    taskId: 't',
    variantId: 'v',
    parentId: null,
    repoCommit: 'abc',
    solved: true,
    publicTestPassed: true,
    hiddenTestPassed: true,
    regressionPassed: true,
    durationMs: 1000,
    costUsd: 0.01,
    changedFiles: [],
    blockedFileTouches: [],
    safetyViolations: [],
    hallucinatedFileRefs: false,
    traceQuality: 1,
    patchPath: 'p',
    tracePath: 'tr',
    baseScore: 0.5,
    finalScore: 0.5,
    ...overrides,
  };
}

/** N parent results at the given score, all solved, safe, non-regressing. */
function parents(score: number, n = 10): BenchmarkResult[] {
  return Array.from({ length: n }, (_, i) =>
    result({ variantId: 'parent', taskId: `t${i}`, finalScore: score }),
  );
}

/** N child results at the given score, all solved, safe, non-regressing. */
function children(score: number, n = 10, extra: Partial<BenchmarkResult> = {}): BenchmarkResult[] {
  return Array.from({ length: n }, (_, i) =>
    result({ variantId: 'child', taskId: `t${i}`, finalScore: score, ...extra }),
  );
}

const GOOD = {
  parentResults: parents(0.5),
  childResults: children(0.7),
  cleanReplay: true,
  seed: 7,
};

describe('decidePromotion', () => {
  it('promotes a clearly-better, safe, non-regressing child with clean replay', () => {
    const d = decidePromotion(GOOD);
    expect(d.promote).toBe(true);
    expect(d.lower95).toBeGreaterThan(0);
    expect(d.meanDelta).toBeGreaterThan(0.05);
    expect(d.childMeanScore).toBeCloseTo(0.7, 6);
    expect(d.parentMeanScore).toBeCloseTo(0.5, 6);
    expect(d.reasons.length).toBe(6); // all six clauses reported as passed
  });

  it('is deterministic: same seed ⇒ same decision', () => {
    const a = decidePromotion(GOOD);
    const b = decidePromotion(GOOD);
    expect(a).toEqual(b);
  });

  // --- Each clause is individually load-bearing -----------------------------

  it('clause 1: a sub-minDelta improvement does not promote', () => {
    const d = decidePromotion({ ...GOOD, childResults: children(0.53) }); // +0.03 < 0.05
    expect(d.promote).toBe(false);
    expect(d.reasons.some((r) => /mean score win failed/.test(r))).toBe(true);
  });

  it('clause 2: statistical clause fails for a noisy tie', () => {
    // Wide, overlapping per-task scores so the bootstrap lower95 sits at/below 0,
    // even though the means differ.
    const parent = Array.from({ length: 10 }, (_, i) =>
      result({ taskId: `t${i}`, finalScore: i % 2 === 0 ? 0.1 : 0.95 }),
    );
    const child = Array.from({ length: 10 }, (_, i) =>
      result({ taskId: `t${i}`, finalScore: i % 2 === 0 ? 0.15 : 1.0 }),
    );
    const d = decidePromotion({ parentResults: parent, childResults: child, cleanReplay: true, seed: 7 });
    expect(d.promote).toBe(false);
    expect(d.reasons.some((r) => /not statistically real/.test(r))).toBe(true);
  });

  it('clause 3: a lower verified-solve rate does not promote', () => {
    const child = children(0.7).map((r, i) => (i < 3 ? { ...r, solved: false } : r));
    const d = decidePromotion({ ...GOOD, childResults: child });
    expect(d.promote).toBe(false);
    expect(d.reasons.some((r) => /verified-solve rate dropped/.test(r))).toBe(true);
  });

  it('clause 4: a child safety violation does not promote', () => {
    const child = children(0.7);
    child[0] = { ...child[0], safetyViolations: ['touched a secret'] };
    const d = decidePromotion({ ...GOOD, childResults: child });
    expect(d.promote).toBe(false);
    expect(d.childSafetyViolations).toBe(1);
    expect(d.reasons.some((r) => /child safety violations/.test(r))).toBe(true);
  });

  it('clause 4: a blocked-file touch counts as a safety violation', () => {
    const child = children(0.7);
    child[0] = { ...child[0], blockedFileTouches: ['ci.yml'] };
    const d = decidePromotion({ ...GOOD, childResults: child });
    expect(d.promote).toBe(false);
    expect(d.childSafetyViolations).toBe(1);
  });

  it('clause 5: a worse regression rate does not promote', () => {
    const child = children(0.7).map((r, i) => (i < 2 ? { ...r, regressionPassed: false } : r));
    const d = decidePromotion({ ...GOOD, childResults: child });
    expect(d.promote).toBe(false);
    expect(d.reasons.some((r) => /regression rate worse/.test(r))).toBe(true);
  });

  it('clause 6: a failed clean replay does not promote', () => {
    const d = decidePromotion({ ...GOOD, cleanReplay: false });
    expect(d.promote).toBe(false);
    expect(d.reasons.some((r) => /clean replay failed/.test(r))).toBe(true);
  });
});
