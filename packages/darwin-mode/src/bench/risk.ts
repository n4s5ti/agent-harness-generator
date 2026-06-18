// SPDX-License-Identifier: MIT
//
// Statistical-Gödel-Machine layer (ADR-079). The base promotion rule (ADR-076)
// certifies a single child is statistically better than its parent. SGM adds two
// things on top:
//
//   1. The SOTA promotion clauses — a child must also hold or improve the hidden
//      -test rate and keep cost-per-solve within 1.20× of the parent.
//   2. A GLOBAL cumulative risk budget — every admitted self-modification spends
//      from a bounded budget, so recursive editing cannot accumulate unbounded
//      risk across rounds. When the budget is exhausted, promotion is refused
//      regardless of local score.

import type { PromotionDecision } from './types.js';

/** A bounded, monotonically-spent risk budget shared across evolution rounds. */
export interface RiskBudget {
  total: number;
  spent: number;
}

export function makeRiskBudget(total: number): RiskBudget {
  return { total: Math.max(0, total), spent: 0 };
}

export function riskRemaining(budget: RiskBudget): number {
  return Math.max(0, budget.total - budget.spent);
}

/**
 * Charge `amount` against the budget iff it fits. Mutates `budget.spent` only on
 * success. Returns whether the charge was admitted and the remaining budget.
 */
export function chargeRisk(budget: RiskBudget, amount: number): { ok: boolean; remaining: number } {
  const cost = Math.max(0, amount);
  if (budget.spent + cost > budget.total) {
    return { ok: false, remaining: riskRemaining(budget) };
  }
  budget.spent += cost;
  return { ok: true, remaining: riskRemaining(budget) };
}

export interface StatisticalGateInput {
  /** The base statistical promotion decision (ADR-076). */
  decision: PromotionDecision;
  /** Hidden-test pass rate must not regress (SOTA rule). */
  childHiddenTestRate: number;
  parentHiddenTestRate: number;
  /** Cost-per-solve must stay within `costCeilingFactor`× the parent (SOTA rule). */
  childCostPerSolve: number;
  parentCostPerSolve: number;
  /** Default 1.20 (≤ +20%). */
  costCeilingFactor?: number;
  /** Optional global risk budget; charged `riskPerEdit` on admission. */
  riskBudget?: RiskBudget;
  /** Risk charged per admitted self-modification. Default 1. */
  riskPerEdit?: number;
}

export interface StatisticalGateResult {
  admit: boolean;
  reasons: string[];
  riskRemaining: number;
}

/**
 * The full SOTA / SGM admission gate. A child is admitted only when the base
 * statistical decision promotes AND the hidden-test rate is held/improved AND
 * cost-per-solve is within the ceiling AND the global risk budget can absorb the
 * edit. The risk budget is charged ONLY on admission.
 */
export function admitWithStatisticalGate(input: StatisticalGateInput): StatisticalGateResult {
  const ceiling = input.costCeilingFactor ?? 1.2;
  const riskPerEdit = input.riskPerEdit ?? 1;
  const reasons: string[] = [];

  const baseOk = input.decision.promote;
  if (!baseOk) reasons.push('base statistical promotion gate not cleared (ADR-076)');

  const hiddenOk = input.childHiddenTestRate >= input.parentHiddenTestRate;
  if (!hiddenOk) {
    reasons.push(
      `hidden-test regression ${input.childHiddenTestRate.toFixed(3)} < ` +
        `${input.parentHiddenTestRate.toFixed(3)}`,
    );
  }

  const costCeiling = input.parentCostPerSolve * ceiling;
  const costOk = input.childCostPerSolve <= costCeiling;
  if (!costOk) {
    reasons.push(
      `cost-per-solve ${input.childCostPerSolve.toFixed(4)} > ` +
        `${ceiling}× parent ${costCeiling.toFixed(4)}`,
    );
  }

  const gatesOk = baseOk && hiddenOk && costOk;

  // Charge the global risk budget only if every gate passed.
  let remaining = input.riskBudget ? riskRemaining(input.riskBudget) : Infinity;
  let budgetOk = true;
  if (gatesOk && input.riskBudget) {
    const charge = chargeRisk(input.riskBudget, riskPerEdit);
    budgetOk = charge.ok;
    remaining = charge.remaining;
    if (!budgetOk) reasons.push('global risk budget exhausted (SGM): edit refused');
  }

  const admit = gatesOk && budgetOk;
  if (admit) reasons.push('admitted: statistical + hidden-test + cost + risk-budget gates all clear');
  return { admit, reasons, riskRemaining: remaining };
}
