# ADR-087: Darwin Mode — wire the graded benchmark gate into `evolve()`

**Status**: Accepted (implemented)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-072 (lightweight scorer), ADR-076 (parent-vs-child benchmark + statistical promotion), ADR-079 (risk budget), ADR-084 (failure-driven mutation), ADR-086 (efficiency-aware selection)

> ADR-076 built a full graded benchmark layer — `evaluateChildAgainstParent` runs a child vs its parent over a hash-pinned suite in the real sandbox, scores with `scoreBenchmark`, and `decidePromotion` returns a statistically-grounded decision. But that layer was never connected to the loop: `evolve()` promoted on the single-run ADR-072 delta. This ADR connects them — opt-in.

## Context

The lightweight ADR-072 promotion asks "did this one run beat the parent by `promotionDelta`?" — one sample, ceiling-bound (every safe variant scores 0.985), and trivially game-able by a self-modifying agent. ADR-076 answers the rigorous question — public ∧ hidden ∧ regression ∧ safety, over a tamper-evident suite, with a seeded-bootstrap confidence interval and a clean-replay gate — but only as a standalone API. The two never met, so a real `evolve` run could not actually use the graded gate.

## Decision

Make the graded gate an **opt-in promotion authority** inside the evolution loop.

- `EvolutionConfig.benchSuite?: BenchSuite` (plus `benchSamples?`, `benchMinDelta?`). When **unset**, behaviour is exactly as before — the lightweight single-run promotion. Every existing test and call site is untouched.
- When **set**: after the normal (lightweight) evaluation of a generation, each child is additionally run through `evaluateChildAgainstParent(parent, child, profile, suite, …)` under the **same bounded concurrency**. The returned `PromotionDecision.promote` **overrides** `score.promoted`, the `reason` is tagged `bench(ADR-076): …`, and the full decision is persisted to `runs/<childId>.bench.json`.
- Selection (ADR-073) is unchanged: it consumes `promoted`, which is now the statistically-validated flag. `archive.best()` still ranks by the lightweight `finalScore` (the graded layer governs *promotion*, i.e. who seeds the next generation, not the displayed leaderboard order).
- The suite's hash is verified before any task runs (`verifySuite`), so a child cannot quietly rewrite the benchmark to look better (ADR-076 anti-tampering).

CLI: `metaharness-darwin evolve <repo> --bench <suite.json> [--tie faster]`. `--bench` loads + hash-verifies the suite (throws on tamper); the existing `bench create` scaffolds one from a repo.

## Why opt-in rather than the default

The graded gate runs three test commands (public/hidden/regression) per task per variant — real cost and time, and it needs a curated suite with genuine held-out tests. The lightweight path stays the zero-config default for `evolve <repo>`; the graded path is for `evolve --bench` when a real suite exists. This mirrors ADR-076's own "ADR-072 remains the default" stance and keeps the reproducibility tests (which set no suite) byte-identical.

## Consequences

- A real `evolve --bench` now promotes only on a statistically real, safety-gated, regression-checked, tamper-evident improvement — the DGM acceptance bar, in the loop rather than beside it.
- Promotion and leaderboard ranking are now distinct concerns (graded gate vs. lightweight score); this is intentional and documented, and leaves room for a later unification where `archive.best()` can also consult the graded `BenchScore`.
- Combined with ADR-084 (failure-driven mutation) and ADR-086 (efficiency tie-break), the opt-in stack now is: mutate toward real failures → gate promotion on a statistical benchmark → break residual ties by efficiency. Each is independent and additive.

## Validation

`packages/darwin-mode` — 295 tests (was 293; +2 e2e): with a trivial all-pass suite, `evolve` writes a valid `PromotionDecision` per child, the `promoted` flag equals `decision.promote`, the reason is tagged, and a winner + work tree still result. Default (no-suite) e2e and reproducibility suites unchanged and green. CLI smoke: `evolve --bench suite.json --tie faster` runs the verified gate end-to-end.
