# ADR-091: Darwin Mode — hyperbolic behavioral phenotyping (MAP-Elites in Poincaré space)

**Status**: Accepted (implemented)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-088 (MAP-Elites structural niches), ADR-084 (failure-driven mutation / `tracesById`), ADR-086 (efficiency tie-break), RuVector (`ruvnet/ruvector` — hyperbolic + GNN vector engine)

> ADR-088 bins variants by a FLAT structural axis (which of the 7 surfaces was mutated). But agent *behaviour* is hierarchical — a deep recursive backtracker vs. a shallow linear tool-user — and hierarchies embed far more faithfully in hyperbolic space than in a flat categorical grid. This ADR adds a behavioural niche descriptor in the 2-D Poincaré ball.

## Context

`Archive.selectElites(limit, descriptorOf)` (ADR-088) was deliberately built with an **injectable** descriptor; the surface-based one was the first. Structural niches answer "which file changed", not "how did the variant behave". Two variants that both mutated `planner` can behave completely differently (one loops and times out, one is clean and fast) yet share a niche — so genuine behavioural diversity is invisible to selection.

Euclidean grids distort tree-like / hierarchical data: the volume needed to separate hierarchy levels grows polynomially, but hierarchy grows exponentially. **Hyperbolic space** (the Poincaré ball) matches that exponential growth — distances near the boundary blow up, so "depth" gets natural room. RuVector (`ruvnet/ruvector`) is a Rust vector-GNN engine that natively implements hyperbolic embeddings, GNN message passing, and 46+ attention mechanisms; it is the production backend this descriptor is designed to delegate to.

## Decision

Add `src/phenotype.ts` (dependency-free, closed-form):

- `behaviorFeatures(traces)` → a bounded 6-feature vector from a variant's run traces: fail rate, timeout rate, safety-block rate, output verbosity, **repeated-line fraction** (loop/backtracking proxy), and relative duration spread. All in `[0,1]`, deterministic.
- `poincareEmbed(features)` → a point in the open unit disk. **Radius** encodes hierarchical depth/struggle (failure + looping + timeouts → near the boundary); **angle** encodes behavioural mode (verbosity / safety-pressure / effort irregularity). Always `‖p‖ < 1`.
- `poincareDistance(u, v)` → `acosh(1 + 2‖u−v‖² / ((1−‖u‖²)(1−‖v‖²)))` — the exact Poincaré-ball metric (zero on equal, symmetric, boundary blow-up), with a guarded denominator.
- `behavioralNiche(traces, shells, sectors)` → a discrete niche `h<shell>_s<sector>` = radial shell (depth) × angular sector (mode).

Wired into `evolve()` via `selection: 'behavioral-diversity'`: the stalled-generation fallback becomes `selectElites(2, v => behavioralNiche(tracesById.get(v.id) ?? []))`. CLI: `--selection behavioral-diversity`. Default and `quality-diversity` paths are unchanged.

## On RuVector (honest scope)

The `ruvnet/ruvector` project genuinely implements hyperbolic/Poincaré geometry and GNN message passing. The currently-published `ruvector-wasm@2.1.0` npm bindings surface `VectorDB`/`HNSW` with euclidean/cosine/dotproduct/manhattan metrics — **not** a hyperbolic metric — so Darwin's Poincaré phenotyping is computed **natively** here (a few lines of closed-form math) rather than fabricating a binding that does not exist. This keeps Darwin Mode dependency-free and working today; a RuVector HNSW index can later back nearest-niche / large-archive lookups, and RuVector's hyperbolic engine can replace the native metric when exposed through the WASM surface, with no change to the `descriptorOf` seam.

## Consequences

- Opt-in runs preserve true *phenotypic* diversity: a recursive deep-thinker and a shallow linear agent occupy different niches even when they mutated the same surface.
- Deterministic and reproducible (closed-form, traces-derived), so it composes with the reproducible-by-construction selection paths.
- The descriptor is just a function; richer phenotypes (token-consumption splines, tool nesting depth from structured traces) extend it without touching the archive or the loop.

## Validation

`packages/darwin-mode` — 311 tests (was 303; +8): Poincaré metric axioms + boundary blow-up, embedding stays inside the open ball, clean-vs-struggling radius ordering, and distinct behaviours → distinct niches (a deep recursive struggler separates from a clean shallow agent). Default/`quality-diversity`/reproducibility paths unchanged and green.
