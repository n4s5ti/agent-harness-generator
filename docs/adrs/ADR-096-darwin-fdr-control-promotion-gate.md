# ADR-096: Darwin Mode — Benjamini–Hochberg FDR control on the promotion gate

**Status**: Accepted (implemented)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-076 (statistical promotion + bootstrap), ADR-087 (graded promotion in evolve), ADR-090 (SGM). Closes the horizon-tracker's **Gap 6** (multiple-testing).

> The bootstrap promotion gate (ADR-076) uses a per-comparison 95% bound — fine for one child vs one parent. But `evolve()` tests MANY children per generation, so at scale ~2–3 "lucky" variants promote by chance each generation. This ADR adds generation-wide Benjamini–Hochberg false-discovery-rate control.

## Context

`decidePromotion` gates the statistical clause on `lower95 > 0` (a 95% bootstrap CI ⇒ per-comparison α≈0.05). Running N candidates concurrently is a multiple-comparisons problem: the family-wise error grows with N, so the gate is *nominally* rigorous but *practically* inflated at scale — exactly the flaw a DeepMind/FAIR reviewer flagged. The standard, principled fix is FDR control (Benjamini–Hochberg), which bounds the expected fraction of false promotions among the accepted ones.

## Decision

- `bootstrapDelta` now also returns a **one-sided p-value** for `H0: delta ≤ 0` (the fraction of seeded bootstrap resamples with `delta ≤ 0`). Deterministic, reproducible. `decidePromotion` surfaces it as `PromotionDecision.pValue`.
- New pure `benjaminiHochberg(pValues, q)` in `bench/stats.ts`: standard step-up — sort ascending, find the largest `k` with `p_(k) ≤ (k/m)·q`, reject all hypotheses with `p ≤` that threshold. Empty input / `q ≤ 0` ⇒ reject nothing.
- `evolve()` applies BH **across each generation's candidates** behind `EvolutionConfig.fdrQ` (opt-in, with `benchSuite`): after all per-child decisions are computed, a child stays promoted **iff it already passed all clauses AND survives the generation-wide BH correction** at `q`. CLI: `--fdr Q`.

**Crucial property: BH here can only DEMOTE.** It never promotes a child that failed its clauses; it only revokes statistically-fragile promotions. So enabling it strictly tightens the gate — it can never make evolution less safe.

## Consequences

- At scale (many children/generation), promotions are corrected for multiple testing — the expected false-discovery rate among promoted variants is bounded by `q`. Lucky-but-noisy variants no longer seed the next generation.
- Default behaviour (no `fdrQ`) is unchanged; the per-comparison gate remains for single comparisons.
- Composes with clade selection (ADR-094) and the SGM budget (ADR-090): BH controls *which* discoveries are real, the budget controls *how many* total, clade controls *who* parents next.

## Validation

`packages/darwin-mode` — 331 tests (was 326; +5, one shape test updated for the new `pValue` field): the bootstrap p-value is low for a clear win and high for a tie; `benjaminiHochberg` rejects clearly-significant hypotheses, rejects nothing when all p-values are large, is **stricter than a naive α=0.05** (a p=0.04 among 9 nulls is *not* rejected), and handles empty / `q≤0`. CLI `evolve --bench --fdr 0.05` runs clean. All prior paths green.
