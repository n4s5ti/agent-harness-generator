# ADR-079: Statistical Gödel Machine — statistical admission gates + global risk budget

**Status**: Proposed (prototype)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-072 (scorer/gate), ADR-076 (benchmark + bootstrap promotion), ADR-077 (DGM), ADR-081 (Darwin Plus synthesis)

> Grounds the statistical safety layer in the **Statistical Gödel Machine** paper (arXiv:2510.10232) and maps it onto `src/bench/stats.ts`, `src/bench/promotion.ts`, and `src/bench/risk.ts`.

## Context

The classic Gödel machine admits a self-modification only after a *formal proof* that it improves the agent — unattainable in stochastic, high-dimensional settings. DGM replaced proof with *empirical* validation, but a single benchmark run can be lucky. SGM closes that gap: admit a modification only when superiority is **statistically certified** (via **e-values / Hoeffding bounds**) at a chosen confidence level, **while allocating a global error budget to bound cumulative risk across rounds.** It adds **Confirm-Triggered Harmonic Spending (CTHS)** — index the error budget by confirmation events, concentrating spend on promising edits while preserving family-wise validity. The paper positions SGM as *the first practical safety layer for recursive self-modification.*

For Darwin Mode this is the enterprise-credibility layer: **no child is promoted on a lucky run, and recursive editing cannot accumulate unbounded risk.**

## Decision

Promote a child only when the win is **statistically real** AND the **global risk budget** can absorb the edit.

### Statistical certification (`stats.ts`, `promotion.ts`)
- A **seeded bootstrap** over the per-task parent→child score deltas yields a 95% confidence interval (`bootstrapDelta`). The seed is mandatory: the reference `Math.random()` bootstrap would itself be non-reproducible and fail the Repro gate (ADR-076). This is our practical stand-in for the paper's e-value/Hoeffding certification — same intent (certify superiority at a confidence level), reproducible by construction.
- The base promotion rule (`decidePromotion`, ADR-076) already requires `lower_95_delta > 0` plus the effect-size margin, solve-rate, regression, safety, and clean-replay clauses.

### Global cumulative risk budget (`risk.ts`)
- `RiskBudget { total, spent }` is shared across evolution rounds; `chargeRisk` admits an edit only if it fits, mutating `spent` **only on success** (monotonic, bounded — the analogue of SGM's global error budget).
- `admitWithStatisticalGate` composes the full SOTA admission gate: the base statistical decision **AND** hidden-test rate held/improved **AND** cost-per-solve within 1.20× of the parent **AND** the risk budget can absorb `riskPerEdit`. The budget is charged **only on admission**. When exhausted, promotion is refused regardless of local score — exactly SGM's "bounded cumulative risk across rounds."

### The SOTA promotion rule (ADR-081)
```
promote child only if:
  child_mean_score        > parent_mean_score + 0.05
  lower_95_bootstrap_delta > 0
  hidden_test_rate         >= parent_hidden_test_rate
  safety_violations        == 0
  cost_per_solve           <= parent_cost_per_solve × 1.20
  clean_replay             == true
  global_risk_budget        has remaining capacity
```

**Approximation honesty:** we ship a seeded bootstrap CI + a simple linear risk budget today. e-values, Hoeffding bounds, and CTHS (confirmation-indexed harmonic spending with family-wise validity) are the paper-faithful upgrades, droppable behind the same `admitWithStatisticalGate` interface without changing callers.

## Consequences

### What gets easier
- Promotion becomes a defensible statistical claim, not a lucky run — the standard DGM-class systems are now held to.
- Recursive self-modification gains a hard, global stop: once the risk budget is spent, no further edits are admitted, bounding cumulative risk across the whole run.

### What gets harder
- A real budget can halt promotion even when a local child looks good; operators must size `total` and `riskPerEdit` deliberately. This is the point, but it is a knob that needs documentation.
- A bootstrap CI is weaker than an e-value/Hoeffding certificate; we are explicit that the rigorous certification is the next increment.

### What does not change
- The ADR-071 safety boundary and ADR-076 gates are unchanged; SGM wraps them with statistical + budget admission.

## Alternatives Considered
1. **Mean delta with no confidence bound (plain DGM).** Rejected — promotes lucky runs; the lower-95% bound is the anti-noise guard.
2. **Per-round risk caps instead of a global budget.** Rejected — does not bound *cumulative* risk across rounds, which is SGM's contribution (and CTHS's confirmation-indexed spending refines it further).
3. **Formal proof of improvement.** Rejected as impractical (the reason SGM exists).
4. **`Math.random()` bootstrap (as drafted in the spec).** Rejected — non-reproducible; replaced with a seeded PRNG.

## Test Contract
1. **Reproducible CI** — `bootstrapDelta(..., {seed})` twice ⇒ identical `lower95` (pinned in `stats.test.ts`).
2. **Risk budget** — `chargeRisk` admits within budget and mutates `spent`; refuses over budget and does not; exhausted budget makes `admitWithStatisticalGate` refuse (pinned in `risk.test.ts`).
3. **Extended gate** — each SOTA clause (hidden-test regression, cost > 1.20×, exhausted budget, base-gate fail) independently flips `admit` to false with a matching reason.
4. **Charge-on-admission only** — a refused admission leaves `spent` unchanged.

## References
- **SGM: A Statistical Gödel Machine for Risk-Controlled Recursive Self-Modification** — arXiv:2510.10232. https://arxiv.org/abs/2510.10232 (e-values, Hoeffding bounds, global error budget, Confirm-Triggered Harmonic Spending; "first practical safety layer for recursive self-modification").
- In-repo: `src/bench/stats.ts`, `src/bench/promotion.ts`, `src/bench/risk.ts`, ADR-076 (benchmark), ADR-081 (synthesis).
