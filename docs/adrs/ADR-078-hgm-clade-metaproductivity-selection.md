# ADR-078: Huxley–Gödel Machine — clade metaproductivity parent selection

**Status**: Proposed (prototype)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-073 (archive + selection), ADR-076 (benchmark), ADR-077 (DGM foundation), ADR-081 (Darwin Plus synthesis)

> Grounds the clade-selection upgrade in the **Huxley–Gödel Machine** paper (arXiv:2510.21614) and maps it onto `src/bench/lineage.ts`.

## Context

Naive DGM selection expands the agent with the highest *current* benchmark score, assuming high score implies promising descendants. HGM shows this assumption is wrong: there is a **Metaproductivity–Performance Mismatch** — the best agent *today* is not always the best *parent*. Inspired by Huxley's notion of a **clade** (an ancestor plus all its descendants), HGM introduces **Clade MetaProductivity (CMP)**: aggregate the benchmark performance of an agent's *descendants* as the signal for its self-improvement potential, and select nodes to expand by **Thompson sampling** over that signal. HGM consistently beats DGM and SICA on SWE-bench Verified and Polyglot, and reaches human-level on SWE-bench Lite (GPT-5).

For Darwin Mode this is the difference between **a leaderboard and an evolutionary system**: pick the best *branch*, not the best *agent*.

## Decision

Select next-generation parents by a blended **clade score**, not raw current score. Implemented in `src/bench/lineage.ts`:

```
descendant_potential(node)   = mean(top-k descendant scores) − node.score   // CMP, approximated
archive_diversity(node)      = 1 / (1 + sibling_count)                       // reward under-explored branches
parent_selection_score(node) = w_score·node.score
                             + w_potential·descendant_potential(node)
                             + w_diversity·archive_diversity(node)
                             + w_safety·safety_stability(node)               // SOTA weighting (ADR-081)
```

Two weightings are supported (both faithful to HGM's intent — current score is *not* the sole criterion):

- **ADR-076 default:** `0.70 / 0.20 / 0.10` (score / potential / diversity).
- **SOTA "clade" mode (ADR-081):** `0.60 / 0.25 / 0.10 / 0.05` adding a `safety_stability` term — the `--selection clade` setting.

`selectParentsByPotential(nodes, limit)` ranks the whole archive by this score with a deterministic id tie-break. A modest-scoring node whose descendants improve will be chosen as a parent over a high-scoring sterile leaf — the test that pins this asserts exactly that ("best branch beats best agent").

**Approximation honesty:** the paper estimates CMP from clade-aggregated descendant outcomes and expands via Thompson sampling. Our prototype uses a top-k descendant mean (a deterministic CMP approximation) for reproducibility; a Thompson-sampling expansion policy over CMP (with the same seeded-RNG discipline as the bootstrap, ADR-079/ADR-076) is the next increment.

## Consequences

### What gets easier
- Selection escapes the Metaproductivity–Performance Mismatch: the archive's diversity (ADR-073) becomes *actionable* — a weak ancestor that breeds strong children is now selected, not discarded.
- The "evolve like a species, not a release" thesis (ADR-073) gets a concrete, cited selection rule.

### What gets harder
- Descendant potential needs descendants to exist, so it only bites after a generation or two; early generations fall back to current score + diversity. Acceptable and expected.
- A deterministic top-k mean is a coarser estimator than the paper's clade-aggregated CMP with Thompson sampling; we trade some statistical fidelity for reproducibility until the seeded-Thompson policy lands.

### What does not change
- The archive structure (ADR-073) and promotion gate (ADR-076/079) are unchanged; HGM changes *which parents we expand*, not *what we promote*.

## Alternatives Considered
1. **Rank parents by raw current score (naive DGM).** Rejected — the Metaproductivity–Performance Mismatch the HGM paper identifies.
2. **Pure descendant potential (ignore current score).** Rejected — over-weights speculative branches; the blend keeps a strong current agent competitive.
3. **Thompson sampling now.** Deferred — desirable and paper-faithful, but the deterministic CMP approximation is reproducible today; Thompson expansion lands with the seeded-RNG policy.

## Test Contract
1. `descendantPotential` is positive for a node with strong descendants, 0 for a leaf, negative when descendants regress, and cycle-guarded.
2. `parentSelectionScore(lowBranchWithStrongDescendants) > parentSelectionScore(highScoringLeaf)` — best branch beats best agent (pinned in `lineage.test.ts`).
3. `selectParentsByPotential` is deterministic (id tie-break) and reproducible.
4. (Next increment) seeded Thompson-sampling expansion over CMP is reproducible from a clean checkout.

## References
- **Huxley–Gödel Machine: Human-Level Coding Agent Development by an Approximation of the Optimal Self-Improving Machine** — arXiv:2510.21614. https://arxiv.org/abs/2510.21614 (CMP, Metaproductivity–Performance Mismatch, clade selection, Thompson sampling; beats DGM/SICA on SWE-bench Verified + Polyglot).
- In-repo: `src/bench/lineage.ts`, ADR-073 (archive), ADR-077 (DGM), ADR-081 (synthesis).
