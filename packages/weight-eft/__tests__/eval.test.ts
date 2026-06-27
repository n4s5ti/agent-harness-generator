// SPDX-License-Identifier: MIT
//
// Tests for the eval-harness hook: the metric is escalation-rate-reduction +
// cost/resolved (the cost-Pareto win), NOT hard-tail cracking. The verdict
// stays honest when the resolve ceiling is unmoved.

import { describe, it, expect } from 'vitest';
import { summarizeCascade, costParetoDelta } from '../src/eval.js';
import type { CascadeOutcome } from '../src/eval.js';

// Base run: cheap resolves 1/4 alone, escalates the other 3, final 3/4 resolved.
const baseRun: CascadeOutcome[] = [
  { instance_id: 'i1', cheapResolved: true, escalated: false, resolved: true, costUsd: 0.02 },
  { instance_id: 'i2', cheapResolved: false, escalated: true, resolved: true, costUsd: 0.52 },
  { instance_id: 'i3', cheapResolved: false, escalated: true, resolved: true, costUsd: 0.52 },
  { instance_id: 'i4', cheapResolved: false, escalated: true, resolved: false, costUsd: 0.52 },
];

// Adapter run: cheap now resolves 2/4 alone (i2 distilled), so only 2 escalate.
// Final resolve rate UNCHANGED (3/4) — the ceiling did not move, by design.
const adapterRun: CascadeOutcome[] = [
  { instance_id: 'i1', cheapResolved: true, escalated: false, resolved: true, costUsd: 0.02 },
  { instance_id: 'i2', cheapResolved: true, escalated: false, resolved: true, costUsd: 0.02 },
  { instance_id: 'i3', cheapResolved: false, escalated: true, resolved: true, costUsd: 0.52 },
  { instance_id: 'i4', cheapResolved: false, escalated: true, resolved: false, costUsd: 0.52 },
];

describe('eval hook — cascade summary', () => {
  it('computes cheap-resolve, escalation, resolve rates and cost/resolved', () => {
    const s = summarizeCascade(baseRun);
    expect(s.n).toBe(4);
    expect(s.cheapResolveRate).toBeCloseTo(0.25);
    expect(s.escalationRate).toBeCloseTo(0.75);
    expect(s.resolveRate).toBeCloseTo(0.75);
    // total 1.58 over 3 resolved
    expect(s.costPerResolved).toBeCloseTo(1.58 / 3, 4);
  });
  it('empty run is well-defined (no NaN)', () => {
    const s = summarizeCascade([]);
    expect(s.costPerResolved).toBe(0);
    expect(s.resolveRate).toBe(0);
  });
});

describe('eval hook — cost-Pareto delta (the honest win)', () => {
  it('reports FEWER escalations and lower cost/resolved with the ceiling unmoved', () => {
    const d = costParetoDelta(baseRun, adapterRun);
    expect(d.escalationRateReduction).toBeCloseTo(0.25); // 0.75 → 0.50
    expect(d.cheapResolveLift).toBeCloseTo(0.25);
    expect(d.costPerResolvedReduction).toBeGreaterThan(0);
    expect(Math.abs(d.resolveRateDelta)).toBeLessThanOrEqual(0.02); // ceiling unmoved
    expect(d.verdict).toMatch(/COST-PARETO WIN/);
    expect(d.verdict).toMatch(/ceiling unmoved/i);
  });

  it('flags an adapter that does NOT cut escalations or cost (prune-the-overfitter)', () => {
    // adapter run identical to base → no win → selection should keep BASE
    const d = costParetoDelta(baseRun, baseRun);
    expect(d.escalationRateReduction).toBe(0);
    expect(d.costPerResolvedReduction).toBe(0);
    expect(d.verdict).toMatch(/NO COST WIN/);
  });
});
