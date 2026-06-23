# ADR-184 — Sovereign Evolution: evolve the solver architecture (genome engine)

**Status:** Engine implemented + validated on mock fitness (`evolve-arch.mjs`); real `prove`-fitness run pending
**Date:** 2026-06-23
**Related:** ADR-179 (Value Score), ADR-181 (prove substrate), ADR-087/096 (statistical-gate promotion), §18-20

## Context

We mapped the SWE-solver architecture space BY HAND (single → Best-of-N → discriminator → cascade → repro-gate).
Darwin's thesis is "freeze the model, evolve the harness" — so the search itself should be evolutionary. The
substrate exists (`prove`/`rank`/SAMPLE, ADR-181). The risk: n=25 fitness is volatile (measured 52%→39.7%
drift, §18) → blind small-sample selection over-fits to noise.

## Decision

`evolve-arch.mjs` evolves a **config genome** `{model, mode(single|bo3|cascade), escalate, judge, maxSteps}`
toward the **Value Score** (ADR-179: `w·resolve% + (1-w)·cheapness`), with a **2-phase gate**:
1. **Phase 1 (filter):** evaluate the population on a fast small `prove` slice (high noise ≈ n=25); keep the elite.
2. **Phase 2 (promote):** re-evaluate finalists K× on a larger slice (low noise ≈ n=100); rank by confirmed
   mean ± 95% CI. Only a genome whose Value survives the gate is promoted/scaled — the over-fitting guard.

Pluggable fitness: `--fitness mock` (seeded, grounded in measured anchors §13/18/20 — for testing the engine)
vs `--fitness prove` (production — emits each genome as a `gcp-cluster prove` config, scored by a real GCP run).

## Validation (mock)

The engine converges, gives phase-2 CIs, and **traces the real frontier**: w≤0.5 → cheap single-traj;
w≥0.7 → Best-of-3 — matching our hand-measured champions, and surfacing that **the cost-Pareto optimum is
w-dependent** (there is no single "best" — it's a frontier). Testing also caught a real scale bug (resolve
fraction vs 0-100 cheapness) — fixed. This proves the search mechanics before spending GCP compute.

## Consequences

- A turn-key, over-fitting-safe architecture search: generate → small-`prove` filter → larger-`prove` gate → scale winner.
- Next: run `--fitness prove` once the fleet's multi-model rows seed the population from real data (not priors).
- The genome surface is extensible (temperatures, N, env-filter toggle, model-mix) as new levers are measured.
