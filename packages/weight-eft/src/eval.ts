// SPDX-License-Identifier: MIT
//
// eval.ts — the eval-harness hook.
//
// Given a tuned adapter, measure the COST-PARETO win — NOT hard-tail cracking.
// The metric that matters is:
//   1. cheap-tier-ALONE resolve on the HELD-OUT clean set, and
//   2. the cascade's ESCALATION-RATE delta (fewer $0.50 frontier escalations).
//
// A LoRA tune on 7-14B will NOT crack the hard tail (frontier reasoning
// ceiling, clean-eval 37.3% + §53). The honest win is: the cheap tier resolves
// more on its own → the cascade escalates less → $/resolved drops. This module
// computes that delta from two eval runs (base vs adapter) and stays honest
// about what it measures.
//
// The eval RUN itself (conformant swebench gold eval) is the existing darwin
// path; this hook consumes its per-instance outcomes and folds them into the
// cost-Pareto metric. No eval is executed here ($0).

/** Per-instance outcome from a conformant cascade eval run on the held-out set. */
export interface CascadeOutcome {
  instance_id: string;
  /** Did the cheap tier resolve it WITHOUT escalating? */
  cheapResolved: boolean;
  /** Did the run escalate to the frontier tier? */
  escalated: boolean;
  /** Final resolved status (cheap OR post-escalation), from gold eval. */
  resolved: boolean;
  /** Measured $ for this instance (cheap + any escalation). */
  costUsd: number;
}

/** The cost-Pareto summary for one eval run (base OR adapter). */
export interface CascadeSummary {
  n: number;
  /** Fraction the CHEAP tier resolved alone. */
  cheapResolveRate: number;
  /** Fraction of runs that escalated to the frontier tier. */
  escalationRate: number;
  /** Final resolve rate (the headline, expected ~unchanged — ceiling unmoved). */
  resolveRate: number;
  /** Mean $ per RESOLVED instance (the cost-Pareto figure of merit). */
  costPerResolved: number;
  /** Total $ across the run. */
  totalCostUsd: number;
}

/** The delta between an adapter run and the base run — the cost-Pareto win. */
export interface CostParetoDelta {
  base: CascadeSummary;
  adapter: CascadeSummary;
  /** adapter.cheapResolveRate − base.cheapResolveRate (want > 0). */
  cheapResolveLift: number;
  /** base.escalationRate − adapter.escalationRate (want > 0 — FEWER escalations). */
  escalationRateReduction: number;
  /** base.costPerResolved − adapter.costPerResolved (want > 0 — cheaper). */
  costPerResolvedReduction: number;
  /** adapter.resolveRate − base.resolveRate (expected ≈ 0 — ceiling unmoved). */
  resolveRateDelta: number;
  /** Honest verdict string for telemetry. */
  verdict: string;
}

/** Fold per-instance cascade outcomes into the cost-Pareto summary. */
export function summarizeCascade(outcomes: CascadeOutcome[]): CascadeSummary {
  const n = outcomes.length;
  if (n === 0) {
    return {
      n: 0,
      cheapResolveRate: 0,
      escalationRate: 0,
      resolveRate: 0,
      costPerResolved: 0,
      totalCostUsd: 0,
    };
  }
  let cheap = 0;
  let escalated = 0;
  let resolved = 0;
  let totalCost = 0;
  for (const o of outcomes) {
    if (o.cheapResolved) cheap++;
    if (o.escalated) escalated++;
    if (o.resolved) resolved++;
    totalCost += o.costUsd;
  }
  return {
    n,
    cheapResolveRate: cheap / n,
    escalationRate: escalated / n,
    resolveRate: resolved / n,
    costPerResolved: resolved > 0 ? totalCost / resolved : 0,
    totalCostUsd: totalCost,
  };
}

/**
 * Compute the cost-Pareto delta between an adapter run and the base run.
 * Stays HONEST: the headline is escalation-rate-reduction + cost/resolved, and
 * the verdict flags when the resolve ceiling is (as expected) unmoved.
 */
export function costParetoDelta(
  baseOutcomes: CascadeOutcome[],
  adapterOutcomes: CascadeOutcome[],
): CostParetoDelta {
  const base = summarizeCascade(baseOutcomes);
  const adapter = summarizeCascade(adapterOutcomes);
  const cheapResolveLift = adapter.cheapResolveRate - base.cheapResolveRate;
  const escalationRateReduction = base.escalationRate - adapter.escalationRate;
  const costPerResolvedReduction = base.costPerResolved - adapter.costPerResolved;
  const resolveRateDelta = adapter.resolveRate - base.resolveRate;

  const fewer = escalationRateReduction > 0;
  const cheaper = costPerResolvedReduction > 0;
  const ceilingMoved = Math.abs(resolveRateDelta) > 0.02;
  let verdict: string;
  if (fewer && cheaper) {
    verdict =
      `COST-PARETO WIN: ${(escalationRateReduction * 100).toFixed(1)}pp fewer escalations, ` +
      `$${costPerResolvedReduction.toFixed(3)} cheaper per resolved` +
      (ceilingMoved
        ? ` (note: resolve rate also moved ${(resolveRateDelta * 100).toFixed(1)}pp — investigate)`
        : ` (resolve ceiling unmoved, as expected — this tunes COST, not the frontier ceiling)`);
  } else if (fewer || cheaper) {
    verdict = `PARTIAL: escalation−${(escalationRateReduction * 100).toFixed(1)}pp, cost−$${costPerResolvedReduction.toFixed(3)}/resolved`;
  } else {
    verdict =
      `NO COST WIN: adapter did not reduce escalations or cost — the prune-the-overfitter ` +
      `gene should select BASE over this adapter.`;
  }
  return {
    base,
    adapter,
    cheapResolveLift,
    escalationRateReduction,
    costPerResolvedReduction,
    resolveRateDelta,
    verdict,
  };
}
