# ADR-081: MetaHarness Darwin Plus — the SOTA synthesis (DGM + HGM + SGM + Hyperagent-lite)

**Status**: Proposed (prototype)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-070…076 (Darwin Mode + benchmark), ADR-077 (DGM), ADR-078 (HGM), ADR-079 (SGM), ADR-080 (Hyperagents)

> The umbrella ADR. It composes the four grounding ADRs into one architecture — **MetaHarness Darwin Plus** — and pins the SOTA promotion rule, the CLI surface, the report card, and the acceptance test.

## Context

As of June 2026 the state of the art for self-improving agents is **not** model retraining. It is:

> frozen foundation model + self-modifying agent harness + archive-based evolution + sandboxed empirical evaluation + statistical promotion gates.

In our framing: **the model stays fixed, the harness evolves, the proof is in replay.**

The leaderboard of *ideas* (not vibes):

| Rank | Approach | Contribution | Build now? |
|---|---|---|---|
| 1 | Darwin Gödel Machine (ADR-077) | open-ended empirical harness evolution + archive | Yes |
| 2 | Huxley–Gödel Machine (ADR-078) | select parents by descendant potential (clade), not current score | Yes |
| 3 | Statistical Gödel Machine (ADR-079) | statistical admission + global cumulative risk budget | Yes |
| 4 | Hyperagents (ADR-080) | evolve the improvement procedure itself | Yes, bounded |
| 5 | Model-retraining loop | change weights, not harness | No (impractical for most) |

SOTA vs hype:

| Claim | Status | Build now? |
|---|---|---|
| Agent improves its own harness | real, practical | ✅ |
| Agent improves its ability to improve | emerging | ✅ bounded (ADR-080) |
| Agent statistically validates improvement | practical | ✅ (ADR-079) |
| Agent modifies its model weights | mostly impractical | ❌ |
| Agent proves its own improvement formally | impractical | ❌ |
| Agent self-modifies without a sandbox | bad idea | ❌ |

## Decision

Build **MetaHarness Darwin Plus** = DGM archive evolution + HGM clade selection + SGM statistical gates + Hyperagent-lite (bounded meta-evolution). Each piece is shipped or roadmapped in a grounding ADR and a concrete module:

| Layer | ADR | Module |
|---|---|---|
| Archive evolution (keep the whole tree) | ADR-073/077 | `archive.ts` |
| Clade parent selection (best branch) | ADR-078 | `bench/lineage.ts` |
| Statistical gate + risk budget | ADR-079 | `bench/stats.ts`, `bench/promotion.ts`, `bench/risk.ts` |
| Five gates + verified-solve score | ADR-076 | `bench/score.ts`, `bench/gates.ts` |
| Secure sandbox + allowlist | ADR-071 | `sandbox.ts`, `safety.ts` |
| Bounded meta-evolution | ADR-080 | phased roadmap |

### The SOTA promotion rule (the one rule to remember)

```
promote child only if:
  child_mean_score        > parent_mean_score + 0.05      # effect size
  lower_95_bootstrap_delta > 0                             # statistically real (seeded, reproducible)
  hidden_test_rate         >= parent_hidden_test_rate      # no held-out regression
  safety_violations        == 0                            # bounded
  cost_per_solve           <= parent_cost_per_solve × 1.20 # efficient
  clean_replay             == true                         # reproducible
  global_risk_budget        has remaining capacity         # bounded cumulative risk (SGM)
```

Implemented by `decidePromotion` (ADR-076) + `admitWithStatisticalGate` (ADR-079).

### Clade selection weighting (`--selection clade`)

```
parent_selection_score = 0.60·current_score + 0.25·top_descendant_average
                       + 0.10·mutation_diversity + 0.05·safety_stability
```

### Architecture

```
repo → baseline harness → mutation generator → child harness → sandbox evaluation
     → public tests → hidden tests → safety audit → statistical gate (SGM)
     → archive (DGM) → clade selection (HGM) → next generation
```

### CLI surface (target)

```
npx metaharness evolve ./repo \
  --generations 5 --children 8 \
  --bench ruvbench.json \
  --selection clade \      # HGM clade scoring (ADR-078)
  --gate statistical \     # SGM gate + risk budget (ADR-079)
  --replay                 # clean-checkout reproduction of the winner
```

**Shipped in this increment:** the benchmark framework (`bench/`) — verified-solve scoring, five gates, seeded bootstrap, statistical + risk-budget promotion, clade selection, immutable hash-pinned suites, the parent-vs-child runner, and `metaharness-darwin bench create|verify`. **Next increment:** wiring `--selection`/`--gate`/`--replay`/`--bench` as `evolve` flags that swap the ADR-072 ScoreCard path for the `bench` evaluation path in the archive (a score-type unification), and the report/replay CLI verbs.

### Report card (the deliverable)

```
Baseline score: 0.54   Winner score: 0.68   Delta: +0.14
Hidden task gain: +0.11   Cost per solve: −18%   Safety violations: 0
Replay: passed   Lineage depth: 5   Best mutation family: context_builder + reviewer
```

## Consequences

### What gets easier
- One coherent, cited architecture — every claim maps to a paper (ADR-077/078/079/080) and a module.
- The wedge is sharp and honest: **"self-improving agents are not recursive model training — they are replayable harness evolution."**
- Maps onto the rUv stack: RuFlo = orchestration, ruVector = evolutionary memory, MetaHarness = generator + mutation engine, RUV Bench = verification (ADR-074).

### What gets harder
- Running the full SOTA loop is costly (public+hidden+regression × variants × generations × seeds, under a risk budget). The cost gate + breaker bound it; Levels 0/1 keep it cheap (ADR-076).
- The headline gains require the LLM `CodeGenerator`; the deterministic mutator ties on a single repo. We ship the *framework + gates*; the *gains* follow the generator. Stated plainly.

### What does not change
- The permanent floor: ADR-071 allowlist + ADR-072 frozen scorer. Darwin Plus expands what evolves and how rigorously it is judged — never what is forbidden or who grades.

## Alternatives Considered
1. **Ship DGM only.** Rejected — leaves the Metaproductivity–Performance Mismatch (HGM) and lucky-run promotions (SGM) on the table.
2. **Ship the rigorous gates but not clade selection.** Rejected — that is a leaderboard, not an evolutionary system (ADR-078).
3. **Go straight to full Hyperagents.** Rejected — unsafe/unmeasurable without the lower tiers (ADR-080); Hyperagent-lite is the bounded slice.

## Test Contract (acceptance)
Across **100 repo-native tasks** (ruVector, this repo, ruQu), MetaHarness Darwin Plus must:
1. beat baseline by **≥ 10% on hidden tests**;
2. maintain **zero safety violations**;
3. **reduce or cap** cost-per-solve (≤ 1.20× parent);
4. **reproduce the winning lineage from a clean checkout** (the Repro gate);
5. promote children **only** under the SOTA promotion rule above (statistically certified, budget-bounded).

The framework, gates, selection, and statistics that make this measurable are shipped and tested (ADR-076…079); the ≥10% hidden-test gain is gated on the LLM `CodeGenerator` (ADR-075 staging) and tracked here.

## References
- DGM arXiv:2505.22954 · HGM arXiv:2510.21614 · SGM arXiv:2510.10232 · Hyperagents arXiv:2603.19461.
- In-repo: ADR-070…076 (Darwin Mode + benchmark), ADR-077–080 (the grounding ADRs), and the `src/bench/` modules listed above.
