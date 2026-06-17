# ADR-074: Darwin Mode — ruVector as evolutionary memory + RuFlo as execution fabric

**Status**: Proposed (prototype)
**Date**: 2026-06-17
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-070 (Darwin Mode head), ADR-073 (archive + selection), ADR-006 (memory + learning), ADR-041 (ruvector substrate), ADR-047 (control plane), ADR-050 (harness intelligence)

> Part of the Darwin Mode series (ADR-070…075). The archive (ADR-073) is *local* memory of one repo's run. This ADR specifies the two substrates that make Darwin Mode more than local hill-climbing: **ruVector** as cross-repo evolutionary memory, and **RuFlo** as the population orchestrator.

## Context

A single `evolve` run learns within one repo. The compounding value — the real product claim — is **transferable learning across repos**: *the harness gets better because it remembers which agent structures worked, not because the model was retrained.* That requires a memory that outlives one run and a fabric that can run a population of variants concurrently and safely.

The repo already names both substrates. ADR-006 establishes the memory/learning integration (AgentDB + HNSW + ReasoningBank + emergent-time decay); ADR-041 names `@ruvector/*` (GNN, tiny-dancer, HNSW) as the proven Rust/NAPI substrate for graph-intelligence, routing, and memory; ADR-047 is the control plane variants execute inside; ADR-050 promoted "retrieve-to-seed + learn-from-outcome" to a default loop. Darwin Mode is the consumer that ties these into an evolutionary loop.

## Decision

### ruVector — the evolutionary memory

Store, per run, the full evolutionary record so future runs (on the same or different repos) can retrieve it:

1. task descriptions · 2. repo summaries · 3. failed traces · 4. successful traces · 5. patch diffs · 6. test failures · 7. mutation descriptions · 8. score deltas.

Retrieve, before mutating and before selecting:

1. similar tasks · 2. similar failures · 3. similar repos · 4. mutations that worked before · 5. mutations that caused regressions.

The interface:

```ts
export interface EvolutionMemory {
  put(record: {
    repo: string; variantId: string;
    mutationSurface: string; mutationSummary: string;
    scoreDelta: number; trace: string;
  }): Promise<void>;

  search(query: string, limit: number): Promise<Array<{
    mutationSurface: string; mutationSummary: string;
    scoreDelta: number; trace: string;
  }>>;
}
```

**Where it plugs into the loop:**

- **Mutation (ADR-071):** before generating a child, `search` for prior mutations that improved *similar* repos or fixed *similar* failures, and bias the `CodeGenerator` toward them — and *away* from mutation families that historically regressed.
- **Selection (ADR-073):** the descendant-potential / diversity bias is informed by cross-repo priors — a mutation surface that paid off on similar repos is weighted up.
- **After scoring (ADR-072):** `put` every variant's `{surface, summary, scoreDelta, trace}` so the memory self-tunes (success up-weights, regression down-weights), exactly the ADR-006/ADR-050 retrieve-to-seed-then-learn loop.

This is what turns Darwin Mode from local evolution into **cross-repo learning**. Substrate: ruVector HNSW for retrieval, consistent with ADR-041's `@ruvector/*` stack; it stays an optional dependency with a lexical fallback so a bare `evolve` run needs no model (mirrors ADR-025/ADR-026 embedding-optionality).

### RuFlo — the execution fabric

RuFlo orchestrates the population as a set of specialised agents, one per stage of the loop:

| RuFlo agent | Responsibility | Maps to |
|---|---|---|
| repo cartographer | profile the repo | `repo_profiler.ts` |
| mutation designer | propose the next child mutation | `mutator.ts` / `CodeGenerator` (ADR-071) |
| patch engineer | apply the mutation, write the variant | `mutator.ts` |
| test runner | run the sandboxed task | `sandbox.ts` |
| trace critic | refine trace-quality + penalty signals | feeds ADR-072 scorer |
| safety auditor | enforce the allowlist gate | `safety.ts` (ADR-071) |
| archive curator | maintain the tree + lineage | `archive.ts` (ADR-073) |
| promotion judge | apply the promotion gate | scorer verdict (ADR-072) |

RuFlo runs variants concurrently within the per-generation cost budget (ADR-072 circuit-breaker), under the ADR-047 control-plane invariant (`no action runs unless confidence ≥ threshold ∧ risk ≤ budget ∧ cost ≤ budget ∧ verification == pass`). Division of labour: **MetaHarness generates and mutates the harness · RuFlo orchestrates the runs · ruVector stores the memory.**

## Consequences

### What gets easier

- **Transferable learning.** A mutation that worked on repo A is a prior for repo B. The product claim ("remembers which structures worked") becomes mechanically true.
- **Concurrency with safety.** RuFlo runs the population in parallel while the safety auditor + cost breaker keep each variant inside the envelope.
- **Reuse of proven substrate.** ruVector HNSW / GNN / tiny-dancer are benchmarked native primitives (ADR-041), not bespoke code.

### What gets harder

- **Cross-repo poisoning.** A regression pattern learned on one repo could mislead another. Mitigated by storing *score deltas* (so regressions are recorded as negative priors, not silently dropped) and by trust-weighting retrieval — the same posture ADR-014 uses for federated patterns.
- **Two more moving parts.** ruVector and RuFlo are now in the critical path. Both stay optional for the prototype (lexical fallback; single-process runner) so `evolve` works standalone, and become upgrades, not prerequisites.

### What does not change

- The local archive (ADR-073) remains the source of truth for one run; ruVector is the *cross-run* layer on top. The promotion gate and allowlist are unchanged regardless of which substrate is wired in.

## Alternatives Considered

1. **No cross-repo memory (archive only).** Rejected as the end state — it forfeits the compounding claim, though it is the valid prototype default.
2. **A single global shared pattern pool across all users.** Rejected for the same reasons as ADR-014 Alternative 3: pattern quality varies wildly across domains and cross-org trust is intractable. ruVector memory is per-owner, retrieval is similarity-scoped.
3. **A bespoke vector store.** Rejected — ADR-041 already commits to the proven `@ruvector/*` substrate; reusing it avoids re-benchmarking.
4. **Hand-rolled concurrency instead of RuFlo.** Rejected — RuFlo already provides the orchestration, budgets, and control-plane invariant (ADR-047); re-implementing them is waste.

## Test Contract

1. **`put`/`search` round-trip** — a stored mutation record is retrievable by a similar-task query with its `scoreDelta` intact.
2. **Regression-as-negative-prior** — a mutation with a negative `scoreDelta` is retrievable and down-weights that surface in the next mutation proposal.
3. **Lexical fallback** — with no embedding model present, `search` degrades to deterministic lexical matching and `evolve` still completes.
4. **Orchestration budget** — RuFlo halts new variant launches when the per-generation cost budget is hit (ADR-072 breaker).
5. **Cross-repo transfer canary** — a mutation that improved repo A appears as a prior when evolving a structurally similar repo B.

## References

- ADR-006 (memory + learning), ADR-041 (`@ruvector/*` substrate + reward), ADR-047 (control-plane invariant), ADR-050 (retrieve-to-seed + learn-from-outcome), ADR-014 (trust-weighted shared memory precedent), ADR-025/026 (embedding optionality + lexical fallback).
- DGM cross-task archive reuse — https://arxiv.org/abs/2505.22954.
