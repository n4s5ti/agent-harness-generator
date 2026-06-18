# ADR-093: Darwin Mode — epistatic linkage learning & topology-aware crossover

**Status**: Accepted (implemented)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-089 (crossover), ADR-088/091/092 (niches + steering), ADR-071 (surfaces), RuVector GNN (`ruvnet/ruvector`)

> Crossover (ADR-089) swaps a RANDOM subset of surfaces. But surfaces are epistatic — a `planner` change may only pay off when matched by a complementary `retryPolicy` change. Splitting a co-adapted pair destroys both. This ADR learns which surfaces co-adapt and keeps them together during recombination: topology-aware crossover.

## Context

The seven surfaces are not independent genes. The largest gains come from *combinations* that fit each other, and random crossover routinely severs them — recombining noise. Linkage learning (a classic answer to epistasis in genetic programming) records which genes belong together and recombines at those boundaries. With behavioural niches (ADR-091) and steering (ADR-092) already directing *where* in behaviour-space to go, linkage answers *which surfaces to recombine* to get there.

## Decision

Add `src/epistasis.ts` (dependency-free, deterministic):

- `LinkageGraph` — a symmetric surface×surface co-occurrence graph: `record(surfaces, weight)` accrues evidence to every pair within a set; `weight(a,b)`; `linkedTo(a, minWeight)` ranks partners strongest-first; `toJSON()` for the work-tree report.
- `buildLinkage(lineages)` — from `{surfaces, score}` per scored lineage, accumulate co-occurrence **weighted by finalScore** (clamped ≥0), so surfaces that co-occur in HIGH-fitness lineages dominate.
- `linkedCrossoverBlock(graph, seedSurface, minWeight)` — the donor block = seed + its strongly-linked neighbours, kept a proper non-empty subset.

`createCrossoverVariant` gains an optional explicit `surfacesFromB`; when supplied it inherits exactly that block (else the existing random bit-subset). `evolve()` wires it behind `EvolutionConfig.epistasis` (with `crossover`): each generation builds the linkage graph from the archive (lineage surfaces via `archive.lineageOf` × `mutationSurface`, weighted by finalScore) and crossover inherits the donor surface's *linked block* instead of a random subset. CLI: `--crossover --epistasis`.

## On RuVector (honest scope)

`ruvnet/ruvector` implements GNN **message passing**, which would refine these edge weights by propagating linkage through the graph (a learned, higher-order epistasis model) at scale. This native co-occurrence graph is the dependency-free, deterministic model that works today behind the same `LinkageGraph` seam; a RuVector GNN can replace `buildLinkage`/`weight` without changing the crossover call site. We do **not** claim to run a GNN here — this is a learned co-occurrence linkage model, the standard linkage-learning primitive a GNN would generalise.

## Consequences

- Opt-in runs recombine at learned epistatic boundaries — co-adapted surfaces travel together, so crossover proposes *coherent* architecture combinations instead of noise.
- Pairs naturally with niche steering (ADR-092: choose the target behaviour) and behavioural diversity — steering picks *where*, linkage picks *what to combine* to get there.
- Deterministic and reproducible; default (random) crossover and all other paths unchanged.

## Validation

`packages/darwin-mode` — 321 tests (was 315; +6): symmetric weight accumulation + no self-edge, score-weighted co-occurrence (high-fitness pairs dominate, negatives clamped), strongest-first linked ranking with threshold, and `linkedCrossoverBlock` keeps a co-adapted pair together as a proper subset (falling back to the seed when unlinked). CLI `--crossover --epistasis` smoke-runs; all prior paths green.
