// SPDX-License-Identifier: MIT
//
// Integration tests for the risk budget + SOTA/SGM admission gate (ADR-079).
// Covers chargeRisk budget arithmetic and admitWithStatisticalGate clause-by
// -clause, including the "charge only on admission" invariant.

import { describe, expect, it } from 'vitest';
import {
  admitWithStatisticalGate,
  chargeRisk,
  makeRiskBudget,
  riskRemaining,
} from '../../src/bench/risk.js';
import type { StatisticalGateInput } from '../../src/bench/risk.js';
import type { PromotionDecision } from '../../src/bench/types.js';

/** A promoting base decision; flip `promote` per test. */
function decision(promote: boolean): PromotionDecision {
  return {
    promote,
    reasons: [],
    meanDelta: 0.2,
    lower95: 0.1,
    childMeanScore: 0.7,
    parentMeanScore: 0.5,
    childVerifiedSolveRate: 1,
    parentVerifiedSolveRate: 1,
    childRegressionRate: 0,
    parentRegressionRate: 0,
    childSafetyViolations: 0,
    cleanReplay: true,
  };
}

/** A gate input that should ADMIT; override one field per test to break it. */
function admittingInput(overrides: Partial<StatisticalGateInput> = {}): StatisticalGateInput {
  return {
    decision: decision(true),
    childHiddenTestRate: 0.9,
    parentHiddenTestRate: 0.9,
    childCostPerSolve: 1.0,
    parentCostPerSolve: 1.0,
    ...overrides,
  };
}

describe('chargeRisk / riskRemaining', () => {
  it('admits a charge within budget and mutates spent', () => {
    const budget = makeRiskBudget(10);
    const r = chargeRisk(budget, 4);
    expect(r.ok).toBe(true);
    expect(budget.spent).toBe(4);
    expect(r.remaining).toBe(6);
    expect(riskRemaining(budget)).toBe(6);
  });

  it('admits a charge that exactly consumes the budget', () => {
    const budget = makeRiskBudget(5);
    expect(chargeRisk(budget, 5).ok).toBe(true);
    expect(budget.spent).toBe(5);
    expect(riskRemaining(budget)).toBe(0);
  });

  it('refuses a charge over budget and does NOT mutate spent', () => {
    const budget = makeRiskBudget(5);
    chargeRisk(budget, 4); // spent = 4
    const r = chargeRisk(budget, 2); // would be 6 > 5
    expect(r.ok).toBe(false);
    expect(budget.spent).toBe(4); // unchanged
    expect(r.remaining).toBe(1);
    expect(riskRemaining(budget)).toBe(1);
  });
});

describe('admitWithStatisticalGate', () => {
  it('admits and charges the risk budget EXACTLY once when every gate passes', () => {
    const riskBudget = makeRiskBudget(3);
    const res = admitWithStatisticalGate(admittingInput({ riskBudget }));
    expect(res.admit).toBe(true);
    expect(riskBudget.spent).toBe(1); // default riskPerEdit = 1
    expect(res.riskRemaining).toBe(2);
    expect(res.reasons.some((r) => /admitted/.test(r))).toBe(true);
  });

  it('refuses when the base statistical decision does not promote (and does not charge)', () => {
    const riskBudget = makeRiskBudget(3);
    const res = admitWithStatisticalGate(
      admittingInput({ decision: decision(false), riskBudget }),
    );
    expect(res.admit).toBe(false);
    expect(res.reasons.some((r) => /base statistical promotion gate/.test(r))).toBe(true);
    expect(riskBudget.spent).toBe(0); // charged ONLY on admission
  });

  it('refuses on a hidden-test regression (and does not charge)', () => {
    const riskBudget = makeRiskBudget(3);
    const res = admitWithStatisticalGate(
      admittingInput({ childHiddenTestRate: 0.8, parentHiddenTestRate: 0.9, riskBudget }),
    );
    expect(res.admit).toBe(false);
    expect(res.reasons.some((r) => /hidden-test regression/.test(r))).toBe(true);
    expect(riskBudget.spent).toBe(0);
  });

  it('refuses when cost-per-solve exceeds 1.20× the parent (and does not charge)', () => {
    const riskBudget = makeRiskBudget(3);
    const res = admitWithStatisticalGate(
      admittingInput({ childCostPerSolve: 1.21, parentCostPerSolve: 1.0, riskBudget }),
    );
    expect(res.admit).toBe(false);
    expect(res.reasons.some((r) => /cost-per-solve/.test(r))).toBe(true);
    expect(riskBudget.spent).toBe(0);
  });

  it('admits at exactly 1.20× the parent cost (boundary is inclusive)', () => {
    const res = admitWithStatisticalGate(
      admittingInput({ childCostPerSolve: 1.2, parentCostPerSolve: 1.0 }),
    );
    expect(res.admit).toBe(true);
  });

  it('refuses when the risk budget is exhausted, leaving spent unchanged', () => {
    const riskBudget = makeRiskBudget(1);
    chargeRisk(riskBudget, 1); // exhaust it -> spent = 1, remaining = 0
    const res = admitWithStatisticalGate(admittingInput({ riskBudget }));
    expect(res.admit).toBe(false);
    expect(res.reasons.some((r) => /risk budget exhausted/.test(r))).toBe(true);
    expect(riskBudget.spent).toBe(1); // the refused admission did not spend more
  });

  it('a refused admission (failed gate) never touches the budget even with room', () => {
    const riskBudget = makeRiskBudget(100);
    admitWithStatisticalGate(admittingInput({ decision: decision(false), riskBudget }));
    expect(riskBudget.spent).toBe(0);
    expect(riskRemaining(riskBudget)).toBe(100);
  });

  it('reports an Infinity remaining when no risk budget is supplied', () => {
    const res = admitWithStatisticalGate(admittingInput());
    expect(res.admit).toBe(true);
    expect(res.riskRemaining).toBe(Infinity);
  });
});
