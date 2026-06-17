# ADR-075: Darwin Mode — prototype roadmap + acceptance

**Status**: Proposed (prototype)
**Date**: 2026-06-17
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-070 (Darwin Mode head), ADR-071 (mutation surfaces), ADR-072 (scoring), ADR-073 (archive), ADR-074 (memory + fabric)

> Part of the Darwin Mode series (ADR-070…075). The preceding ADRs specify *what* Darwin Mode is and *how* its pieces work. This ADR specifies *the order we build it in* and *the bar that says it works* — so the series ships as measured increments, not a big-bang.

## Context

Self-modification is risky to build all at once: let the system rewrite planner + reviewer + tools + memory + retry on day one and a failure is hard to attribute and easy to make unsafe. The DRACO discipline already used in this repo (ADR-037–040) is "land increments, each with a measured win." Darwin Mode follows the same staging: start with the **safest, smallest** mutation surface, prove the loop end-to-end, then widen.

## Decision

### Prototype 1 — self-improving reviewer (safest first)

Mutate **only** `reviewer.ts` (ADR-071 `reviewer` surface). Input: a patch + test output + repo map. Output: a review decision + fix suggestions. Benchmark questions: can it catch broken patches? reduce false positives? predict test failures? identify risky files? This avoids any destructive self-modification while exercising the full loop (generate → sandbox → score → archive → promote). It is the proof-of-loop.

### Prototype 2 — self-improving context builder (fastest measurable gain)

Mutate **only** `context_builder.ts`. Metrics: fewer tokens · more relevant files · higher patch success · lower cost. Context selection is one of the biggest failure points in coding agents, so this is where a bounded search is most likely to produce a real, commercially-useful delta quickly. It also stresses the cost/latency terms of the scorer (ADR-072).

### Prototype 3 — self-improving full harness (only after 1 and 2)

Open the remaining surfaces — planner, tool policy, memory policy, retry policy, score policy — once the loop, the gate, and the archive are proven on the two single-surface prototypes. This is the full ADR-070 system with ruVector memory and RuFlo orchestration (ADR-074) wired in.

### 30-day target (the credible, viral claim)

> *MetaHarness evolved a repo-specific agent harness that improved task success by at least 15% over the baseline, with full traceability and rollback.*

Credible, measurable, and demonstrable — not "recursive AI." Traceability = the lineage tree (ADR-073); rollback = witness-signed promoted nodes (ADR-011).

### Acceptance test — three repos

Run on **ruVector**, **agent-harness-generator** (this repo), and **ruQu**. For each:

1. Generate **10** harness variants.
2. Run **20** repo-specific tasks.
3. Promote only variants that beat baseline by **≥ 10%** (the ADR-072 gate with `promotion_delta` tuned to the per-repo baseline).
4. Store all traces in ruVector (ADR-074).
5. Render a public lineage graph (ADR-073).
6. Reproduce the winning score from a **clean checkout**.

**The demo passes when at least one repo shows a reproducible improvement, zero unsafe actions, and a clear winning-harness lineage.**

### Run recipe (prototype)

```bash
npm install        # devDeps only: typescript + @types/node
npm run build
node dist/cli.js evolve ../ruvector --generations 3 --children 5
# → .metaharness/{archive.json, runs/*, variants/*, reports/winner.json}
```

The published artifacts per acceptance repo: baseline score · winner score · mutation lineage · score delta · safety score · cost proxy · trace replay — plus a GitHub Action badge.

## Consequences

### What gets easier

- **Attributable progress.** Each prototype changes one thing; a regression is traceable to one surface.
- **A safe public demo.** Prototypes 1–2 cannot perform destructive self-modification, so the first shippable demo is also the safest.
- **A concrete 30-day deliverable** with a number attached, not a vibe.

### What gets harder

- **Resisting scope creep into Prototype 3.** The temptation is to open all surfaces early; the staging exists precisely to resist that.
- **Per-repo baseline tuning.** "≥10%" is relative to each repo's baseline; the promotion delta must be calibrated per repo, which is extra setup the acceptance harness must script.

### What does not change

- The allowlist (ADR-071), the gate (ADR-072), and the archive (ADR-073) are identical across all three prototypes — only the *set of open surfaces* widens. The safety envelope does not loosen as capability grows.

## Alternatives Considered

1. **Build the full harness first.** Rejected — un-attributable failures and an unsafe first demo. Staging is the whole point.
2. **Start with the planner (the most "impressive" surface).** Rejected — higher blast radius and harder to measure than reviewer/context; impressiveness is not the selection criterion, safety-times-measurability is.
3. **Single-repo acceptance.** Rejected — one repo cannot demonstrate the transfer-learning claim (ADR-074); three repos of different shapes is the minimum to show generality.
4. **No reproducibility-from-clean-checkout clause.** Rejected — reproducibility is the credibility anchor; without it the numbers are unfalsifiable.

## Test Contract

1. **Prototype 1** — a reviewer-only evolution run promotes a variant that catches a known-broken patch the baseline passed, with zero blocked safety actions.
2. **Prototype 2** — a context-builder-only run promotes a variant with strictly fewer context tokens **and** no test-pass regression (ADR-072 non-regression clause).
3. **Prototype 3** — a full-surface run on one acceptance repo clears the ≥10% gate with `safety_score = 1.0`.
4. **Acceptance reproducibility** — `reports/winner.json` regenerates byte-identically from a clean checkout on at least one of the three repos.
5. **30-day claim** — an end-to-end run produces a baseline-vs-winner delta ≥ 15% task success on at least one repo, with a renderable lineage and a rollback path.

## References

- ADR-070–074 (the rest of the Darwin Mode series).
- ADR-037–040 (the "land measured increments" discipline this roadmap inherits).
- DGM staged self-modification + sandboxed evaluation — https://arxiv.org/abs/2505.22954.
