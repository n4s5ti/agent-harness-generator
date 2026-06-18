# ADR-077: Darwin Gödel Machine — empirical, open-ended harness evolution (the foundation)

**Status**: Proposed (prototype)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-070 (Darwin Mode head), ADR-072 (scorer), ADR-073 (archive), ADR-076 (benchmark), ADR-078 (HGM), ADR-079 (SGM), ADR-080 (Hyperagents), ADR-081 (Darwin Plus synthesis)

> First of the SOTA grounding ADRs (ADR-077…081). This one pins what we take directly from the **Darwin Gödel Machine** paper (arXiv:2505.22954, Zhang, Hu, Lu, Lange, Clune) and how it maps onto the code already shipped in `@metaharness/darwin`.

## Context

The June-2026 state of the art for self-improving agents is **not** model retraining. It is: a *frozen* foundation model + a *self-modifying agent harness* + *archive-based evolution* + *sandboxed empirical evaluation* + *statistical promotion gates*. In our framing: **the model stays fixed, the harness evolves, and the proof is in replay.**

DGM is the practical foundation of that stack. It iteratively modifies the *source code of a coding agent*, empirically validates each child on coding benchmarks, and keeps an **archive of diverse generated agents** rather than only the current best. Reported gains: **SWE-bench 20.0% → 50.0%** and **Polyglot 14.2% → 30.7%**, with **sandboxing + human oversight** as safety precautions. Critically, DGM does not retrain the foundation model — the discovered improvements were *harness* changes: **better code-editing tools, long-context window management, and peer-review mechanisms.**

The load-bearing lesson: **do not optimize a prompt — evolve the harness.**

## Decision

Adopt the DGM loop as the foundation of Darwin Mode, and record the exact correspondence so this is grounded, not aspirational:

| DGM element (arXiv:2505.22954) | Darwin Mode implementation |
|---|---|
| Frozen foundation model; modify the agent's *code* | Seven approved mutation surfaces (`safety.ts`, ADR-071); the model is never trained |
| Empirical validation on benchmarks | The frozen scorer (`scorer.ts`, ADR-072) + the rigorous benchmark layer (`bench/`, ADR-076) |
| Archive of diverse agents, not a single best | `Archive` as a tree with retention + archive-wide selection (`archive.ts`, ADR-073) |
| Sample an agent → foundation model creates a new variant | `CodeGenerator` hook + `createChildVariant` (`mutator.ts`, ADR-071); deterministic mutator is the prototype stand-in for the LLM generator |
| Sandboxing + human oversight | Gate-first, shell-free, env-scrubbed sandbox (`sandbox.ts`); the ADR-071 allowlist; promotion requires evidence |
| Discovered gains (editing tools, long context, peer review) | The mutation surfaces are exactly these levers: `context_builder` (long context), `reviewer` (peer review), `tool_policy`/`retry_policy` (editing/execution) |

**What we deliberately keep from DGM:** open-endedness (keep a growing tree, explore many branches) and empiricism (no promotion without measured benchmark evidence).

**What we add on top** (subsequent ADRs): clade-level parent selection (HGM, ADR-078), statistical admission + a global risk budget (SGM, ADR-079), and a bounded path to evolving the improvement procedure itself (Hyperagents, ADR-080) — combined in ADR-081.

## Consequences

### What gets easier
- The project has a credible, cited foundation: every Darwin Mode mechanism traces to a DGM element with a concrete module.
- The framing ("evolve the harness, not the prompt; the proof is in replay") is defensible and differentiating.

### What gets harder
- DGM's headline numbers come from real LLM-generated self-modifications on SWE-bench/Polyglot. Our deterministic mutator cannot reproduce those gains until the LLM `CodeGenerator` is wired in — we are honest that the *framework* is shipped, the *gains* await the generator (ADR-075 staging).

### What does not change
- The safety boundary (ADR-071) and frozen-scorer principle (ADR-072) are the local analogue of DGM's "sandboxing + human oversight" and remain unchanged.

## Alternatives Considered
1. **Prompt optimization instead of harness evolution.** Rejected — DGM's whole result is that the durable gains live in the harness (tools, context, review), not the prompt.
2. **Single-best-branch hill-climbing.** Rejected — DGM's archive of diverse agents is the mechanism that escapes local optima (ADR-073).
3. **Formal proof of improvement (classic Gödel machine).** Rejected as impractical; DGM's empirical validation is the workable substitute (and SGM, ADR-079, makes it statistically rigorous).

## Test Contract
This ADR is satisfied by the existing Darwin Mode suite: the archive-as-tree (ADR-073 tests), the safety-gated sandbox + scorer (ADR-071/072 tests), and the mutation surfaces matching DGM's discovered levers. No new code is required by ADR-077; it is the grounding record. The DGM-derived numeric claim (≥X% gain) is gated on the LLM generator and tracked in ADR-075/081 acceptance.

## References
- **Darwin Gödel Machine: Open-Ended Evolution of Self-Improving Agents** — Zhang, Hu, Lu, Lange, Clune. arXiv:2505.22954. https://arxiv.org/abs/2505.22954
- Gödel Machine (Schmidhuber) — the self-referential optimal self-improver DGM is named for.
- In-repo: ADR-070 (loop), ADR-071 (surfaces), ADR-072 (scorer), ADR-073 (archive).
