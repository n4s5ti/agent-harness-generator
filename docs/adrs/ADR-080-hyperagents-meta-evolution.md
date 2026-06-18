# ADR-080: Hyperagents — evolving the improvement procedure itself (bounded)

**Status**: Proposed (frontier — phased)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-071 (mutation surfaces), ADR-077 (DGM), ADR-078 (HGM), ADR-079 (SGM), ADR-081 (Darwin Plus synthesis)

> Grounds the meta-evolution frontier in the **Hyperagents** paper (arXiv:2603.19461, Zhang, Zhao, Yang, Foerster, Clune, Jiang, Devlin, Shavrina) and defines the **bounded, phased** path Darwin Mode will take toward it.

## Context

DGM, HGM, and SGM all evolve the *task* agent while the *meta* level — the mutation policy and the selection policy — stays hand-crafted and fixed. **Hyperagents** remove that ceiling: they combine the task agent and the meta agent into a **single, self-referential, editable program**, so *"the meta-level modification procedure is itself editable, enabling metacognitive self-modification."* This extends DGM to **DGM-Hyperagents (DGM-H)**, which improve both task performance *and the improvement mechanism itself*, with meta-level gains that **transfer across domains and accumulate across runs**.

This is the frontier — and the riskiest tier. A system that can edit how it edits itself is exactly where bounded-by-design matters most.

## Decision

Pursue Hyperagent-style meta-evolution **bounded and phased**. Do not start by letting the system rewrite its own improvement procedure on day one.

### The four phases (only advance when the prior phase is green + safe)
1. **Phase 1 — evolve the task harness.** The seven mutation surfaces (ADR-071). **Shipped.**
2. **Phase 2 — evolve the mutation policy.** Let the `CodeGenerator` strategy (which surface to mutate, how aggressively) become a bounded, benchmarked, swappable artifact — itself selected by the same gates. Mutation policy changes are admitted only through ADR-079's statistical + risk-budget gate.
3. **Phase 3 — evolve the selection policy.** Let the clade-selection weights (ADR-078) and expansion policy (Thompson sampling) become evolvable, again behind the gates.
4. **Phase 4 — evolve the benchmark generator.** Frontier and most dangerous (a system that writes its own tests can game them). Gated hardest; the immutable task-hash snapshot (ADR-076) and the "child never edits the benchmark" rule (ADR-071/072) remain absolute even here — a generated benchmark must be human-ratified before it can grade promotions.

### Hard invariants that hold across ALL phases
- The **safety allowlist** (ADR-071) and **frozen authoritative scorer** (ADR-072) never become self-editable. Meta-evolution may change *how variants are proposed and selected*; it may never change *what is forbidden* or *who grades*.
- Every meta-level change is itself a *variant* subject to the five gates (ADR-076), statistical certification, and the **global risk budget** (ADR-079). Meta-edits spend from the same bounded budget.
- Full lineage + clean-replay (ADR-073/076) apply to meta-level edits exactly as to task-level edits.

We call the shippable slice **Hyperagent-lite**: Phases 1–2 under hard gates; Phases 3–4 are roadmap, not prototype.

## Consequences

### What gets easier (eventually)
- Meta-level improvements that **transfer across repos and accumulate across runs** (the paper's headline) — the compounding that ruVector evolutionary memory (ADR-074) is designed to capture.
- Removes the hand-crafted-meta ceiling that limits DGM/HGM/SGM improvement speed.

### What gets harder / the risk
- Self-referential modification is the highest-risk tier. The mitigation is the bound: the forbidden-set and the grader are *outside* the self-editable surface, and every meta-edit is gated + budgeted + replayable. We market this as **bounded** meta-evolution, never "uncontrolled recursive self-improvement."
- Phase 4 (self-authored benchmarks) is a benchmark-integrity hazard; it stays gated behind human ratification and the immutable task hash.

### What does not change
- ADR-071's allowlist and ADR-072's frozen scorer are the permanent floor. Hyperagent-lite expands *what can evolve*, never *what is unsafe*.

## Alternatives Considered
1. **Jump straight to full self-referential meta-modification (Phase 4).** Rejected — un-attributable, benchmark-gameable, and unsafe without the lower phases proven.
2. **Never evolve the meta level (stay DGM/HGM/SGM).** Rejected as the end state — it caps improvement speed, which is precisely the limitation Hyperagents removes; but it is the correct *starting* state.
3. **Let the grader/forbidden-set evolve too.** Rejected absolutely — that destroys the bound and benchmark integrity.

## Test Contract
1. **Phase boundary** — a meta-level (mutation-policy) change is admitted only through the ADR-079 statistical + risk-budget gate, with full lineage.
2. **Invariant** — no meta-evolution path can modify the ADR-071 allowlist or the ADR-072 authoritative scorer (assert these are not in any mutation surface).
3. **Budgeted** — meta-edits spend from the same global risk budget as task-edits (ADR-079).
4. (Phases 3–4) roadmap — tracked, not yet implemented.

## References
- **Hyperagents** — Zhang, Zhao, Yang, Foerster, Clune, Jiang, Devlin, Shavrina. arXiv:2603.19461. https://arxiv.org/abs/2603.19461 (self-referential task+meta agent in one editable program; DGM-H; cross-domain transfer; accumulation across runs).
- **Darwin Gödel Machine** — arXiv:2505.22954 (the base DGM-H extends).
- In-repo: ADR-071 (the permanent bound), ADR-074 (evolutionary memory for cross-run accumulation), ADR-081 (synthesis).
