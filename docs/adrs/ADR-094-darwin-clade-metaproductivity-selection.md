# ADR-094: Darwin Mode — clade-metaproductivity parent selection (Huxley-Gödel)

**Status**: Accepted (implemented)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-073 (archive), ADR-090 (SGM risk budget — τ source), ADR-092 (niche steering), ADR-077/078 (DGM/HGM grounding)

> Selecting parents by current score is a known failure mode: the best-*scoring* variant is a poor *parent* because its descendant line is exhausted (the "metaproductivity–performance mismatch", Huxley-Gödel Machine, Wang/Piękos/Li et al., arXiv:2510.21614, 2025). This ADR selects parents by **descendant potential** — the success rate of a variant's whole subtree — via Thompson sampling, with the exploration schedule tied to the SGM risk budget.

## Context

An hourly horizon-tracker research review (8 SOTA techniques, 2024–2026) ranked this its **Priority 1**: dependency-free, highest-evidence (DGM + HGM independently validate), and it fixes the most fundamental flaw in score-greedy selection. HGM defines **Clade Metaproductivity**:

```
CMP(a) = passes_subtree(a) / (passes_subtree(a) + failures_subtree(a))
```

and selects parents by Thompson sampling `u ~ Beta(τ·passes+1, τ·failures+1)`, picking the argmax — favouring clades that *produce* successful descendants, with τ scheduling exploration→exploitation.

## Decision

Add `src/clade.ts` (dependency-free):

- A seeded PRNG (`mulberry32`) + seeded Gamma (Marsaglia–Tsang) → **seeded `sampleBeta`**. Crucially, this makes Thompson sampling **reproducible** (same seed ⇒ same parents) — the paper uses `Math.random`, which would violate ADR-075; ours does not.
- `cladeOutcomes(archive, id)` — passes/failures over the descendant subtree (a scored variant is a pass iff promoted), cycle-guarded, derived purely from the archive tree (no extra serialized state).
- `cladeThompsonSelect(archive, τ, limit, seed)` — draw a Beta sample per scored variant and return the top-`limit`.

Wired into `evolve()` via `selection: 'clade'`: each generation selects parents by clade Thompson sampling (bypassing the promoted-first rule, per HGM), with **τ = SGM-budget-spent / SGM-budget-total** (ADR-090) — full budget ⇒ τ→0 ⇒ flat Betas ⇒ exploration; spent budget ⇒ τ large ⇒ sharp Betas ⇒ exploitation. τ defaults to 1 when no risk budget is set. Falls back to promoted/score selection only when nothing is scored. CLI: `--selection clade`.

## Incidental fix (id uniqueness)

Clade selection exercised a latent collision: child ids were `g<gen>_v<index>` with `index` reset per parent, so two parents produced the same id, and on a reused work-tree a stale variant could be selected as a parent of a same-id child (cp src===dest → EINVAL). Fixed by making the child index unique per generation across all parents (`pIdx·children + localIndex`) and guarding `copyVariantDir` against src===dest. Deterministic; all prior tests unchanged.

## Consequences

- Opt-in runs select parents that have demonstrated *generative* capacity, not just a high one-shot score — the open-ended-search property that took DGM from 20%→50% on SWE-bench.
- Native integration with the SGM budget gives a principled, free exploration schedule.
- Seeded Beta keeps the whole mechanism reproducible — an improvement over the source method.
- Honest gaps still open (from the same research review): a Poincaré-vs-Euclidean niche **ablation** (Gap 1), multiple-testing correction on the statistical gate (Gap 6), and benchmark saturation / difficulty-ladder (Gap 3) — queued.

## Validation

`packages/darwin-mode` — 326 tests (was 321; +5): seeded Beta is calibrated (sample mean ≈ a/(a+b)) and reproducible; `cladeOutcomes` aggregates over the subtree; `cladeThompsonSelect` favours a fertile clade over a barren one (>20/30 draws) and is reproducible / empty-safe. CLI `--selection clade` runs clean on a fresh tree; all prior paths green.
