# ADR-100: Darwin Mode — multi-objective Pareto selection (parsimony vs capability)

**Status**: Accepted (implemented)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-072 (scalar gate ceiling), ADR-086 (efficiency tie-break), ADR-091 (phenotype), ADR-099 (audit — trace degeneracy). Realizes the horizon-tracker's **P2** (escape the scalar ceiling) and the user's "complexity-vs-cost per niche" idea.

> The scorer is a scalar GATE that ceilings at 0.985 — it cannot rank the passing variants, and a single scalar forces a false choice between competing goods. Pareto dominance keeps the whole non-dominated front, so a small/cheap "mini" variant and a capable "grand" variant both survive as parents instead of collapsing to one winner.

## Context

ADR-099's audit showed the trace-derived behavioural manifold is **degenerate** (nicheEntropy = 0): the current sandbox scores a variant by running the *repo's* test command, which does not depend on the variant's harness surfaces, so every variant's runtime trace is identical. Behavioural objectives therefore can't discriminate *yet* (they await an agent-executing sandbox — a larger future build). But **code size is a genuinely non-degenerate, deterministic signal**: mutations and crossover change the surface files, so `variantBytes` differs across variants today. Parsimony (Occam: the smallest harness that still clears the gate) is a real, defensible secondary objective available now.

## Decision

Add `src/pareto.ts`: a generic, pure `paretoFront(items, objectives)` returning the non-dominated set (higher = better on every axis; negate costs). `dominates(a,b)` = `≥` on all and `>` on one. Order-preserving → deterministic.

Wire into `evolve()` via `selection: 'pareto'`: parents are the non-dominated front over **(finalScore ↑, code bytes ↓)**, capped at 2 (by score, then fewer bytes). So among ceiling-tied variants, the front retains both the highest-scoring and the most parsimonious — the "mini vs grand" coexistence — instead of the arbitrary insertion-order pick. CLI: `--selection pareto`. Deterministic/reproducible; default unchanged.

## Honest scope

- The chosen cost axis is **code size**, not wall-clock or tokens, precisely because it is deterministic *and* non-degenerate today (per ADR-099). Wall-clock parsimony is already available opt-in via the efficiency tie-break (ADR-086, `--tie faster`).
- The richer multi-objective vision (capability × latency × token-cost × safety-margin, per AlphaEvolve) needs metered cost/latency that the current runner stubs for reproducibility, and behavioural objectives need the agent-executing sandbox. Those remain future work; this ships the part that is real now.

## Consequences

- Selection finally has a second axis that actually varies across the passing variants, so it is no longer arbitrary at the ceiling.
- Generic `paretoFront` is reusable for any future objective set (drop in latency/tokens once metered).
- Composes with the rest of the selection stack as another opt-in mode.

## Validation

`packages/darwin-mode` — 341 tests (was 336; +5): `paretoFront` keeps non-dominated items and drops dominated ones, treats a singleton/global-max correctly, preserves input order on a trade-off front, and handles empty input. CLI `--selection pareto` runs clean; default and prior paths green.
