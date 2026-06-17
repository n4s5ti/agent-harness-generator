# ADR-073: Darwin Mode — the archive: evolve like species, not release like software

**Status**: Proposed (prototype)
**Date**: 2026-06-17
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-070 (Darwin Mode head), ADR-072 (scoring + promotion), ADR-074 (ruVector memory), ADR-011 (witness/provenance), ADR-014 (self-evolution)

> Part of the Darwin Mode series (ADR-070…075). This ADR pins **the archive** — the single most important idea Darwin Mode borrows from DGM — and the **selection policy** that samples from it.

## Context

A naïve optimizer says *"keep the best current agent."* That is hill-climbing, and it gets stuck: it discards every ancestor the moment a better sibling appears, even though that ancestor might be the only path to a future breakthrough. DGM's defining move is different: **keep a tree of agents.** A weak-looking ancestor can produce a strong future branch; diversity in the population is what escapes local optima.

The Huxley–Gödel Machine line sharpens this further: raw current benchmark score is not the same as *future self-improvement potential*. An agent that scores modestly today may have high *descendant potential*. An archive lets us defer that judgement — we do not have to discard a branch to find out whether it leads somewhere.

For MetaHarness the slogan is: **agent harnesses should evolve like species, not update like software releases.** A release pipeline keeps one HEAD; a species keeps a population.

## Decision

### The archive is a tree, persisted as `archive.json`

Each record is a variant + its scorecard + its children:

```ts
export interface ArchiveRecord {
  variant: HarnessVariant;   // id, parentId, generation, dir, mutationSurface, summary
  score: ScoreCard | null;   // null until evaluated
  children: string[];        // child variant ids
}
```

The `Archive` class (`addVariant`, `setScore`, `best`, `selectParents`, `load`, `save`) maintains the map and the parent→child edges. `lineage.json` is the projection used to render the evolution tree; `reports/winner.json` is the single highest-`final_score` record.

**Non-promoted variants are retained, not deleted.** "Did not clear the promotion gate" (ADR-072) means "not chosen as a parent of the *next* generation by the default policy" — it does **not** mean "removed from the archive." The archive is the memory of everything tried.

### Selection policy — sample parents from the whole archive

The next generation's parents are chosen from the archive, not only from the current best:

- **Default:** when at least one child was promoted, the promoted children seed the next generation (forward progress).
- **Stall fallback:** when no child clears the gate in a generation, `selectParents(k)` samples the top-k archive records by `final_score` — including older, non-promoted branches — so evolution explores sideways instead of dead-ending.
- **Diversity bias (next increment):** weight sampling toward under-explored mutation surfaces and toward branches with high *descendant potential* (a branch whose children have been improving), so the policy is not pure greedy top-k. ruVector (ADR-074) supplies the cross-repo prior for which branches historically paid off.

This is deliberately *not* plain hill-climbing: a branch that is not currently best remains a candidate parent.

### Lineage is the demo, and the provenance

The winner's "DNA" is its path through the tree, e.g.:

```
Winner: harness 17
Lineage: baseline → h3 → h9 → h17
Mutations: + test-first planner · + ruVector similar-issue retrieval · + patch critic
           · context size −38% · pass rate 42% → 61% · avg cost −21%
```

Every node carries its mutation summary and scorecard, so the tree is simultaneously the marketing artifact (evolution graph), the debugging artifact (why did this win?), and the provenance artifact. Each promoted variant is witness-signed per ADR-011, making the lineage tamper-evident and the winner reproducible from a clean checkout.

## Consequences

### What gets easier

- **Escaping local optima.** Diversity is retained by construction; a dead generation explores sideways instead of stopping.
- **A visceral, true visualization.** The evolution tree is the product's most shareable output and doubles as an audit trail.
- **Cross-repo learning has somewhere to live.** The archive is the local population; ruVector (ADR-074) is the cross-repo memory that biases selection.

### What gets harder

- **The archive grows.** Population × generations records, each with a variant directory. Variant dirs are prunable (regenerable from `parentId` + `mutationSurface` + seed); scorecards and lineage are kept. A retention policy (keep all metadata, GC variant source beyond depth N) is a later refinement.
- **Selection is now a policy with knobs** (top-k, diversity weight, descendant-potential weight). Wrong knobs waste budget on barren branches. The knobs are explicit and testable.

### What does not change

- The promotion gate (ADR-072) is unchanged; the archive changes *what we keep*, not *what we promote*. Promotion decides parentage; the archive decides memory.

## Alternatives Considered

1. **Single best branch (hill-climbing).** Rejected — the core failure DGM's archive exists to avoid; gets stuck and throws away future breakthroughs.
2. **Flat list of all variants, pick global best each round.** Rejected — loses the parent→child structure needed for lineage, descendant-potential, and reproducible provenance.
3. **Greedy top-k always (no diversity bias).** Kept as the prototype default, flagged as insufficient long-term — pure top-k under-explores; the diversity/descendant-potential bias is the planned upgrade.
4. **Discard non-promoted variants to save space.** Rejected — that re-introduces hill-climbing through the back door; metadata retention is cheap and is the whole point.

## Test Contract

1. **Tree integrity** — `addVariant` records parent→child edges; `lineage.json` reconstructs the full path baseline→winner.
2. **Retention** — a non-promoted variant remains queryable in the archive after its generation completes.
3. **Stall fallback** — a generation with zero promotions triggers `selectParents(k)` sampling from the archive (including older branches), not termination.
4. **Winner selection** — `best()` returns the global max-`final_score` record; `reports/winner.json` matches it.
5. **Reproducible lineage** — from a clean checkout, the winner's lineage and score reconstruct from `archive.json` alone.

## References

- ADR-070 (loop + product surface), ADR-072 (promotion vs retention distinction), ADR-074 (cross-repo memory feeding selection), ADR-011 (witness on each promoted node).
- DGM archive of descendants — https://arxiv.org/abs/2505.22954.
- Huxley–Gödel Machine — descendant potential over raw score (the diversity/selection rationale).
- Quality-Diversity precedent (MAP-Elites: Mouret & Clune, "Illuminating search spaces by mapping elites," https://arxiv.org/abs/1504.04909) — population-as-archive over single-champion search.
