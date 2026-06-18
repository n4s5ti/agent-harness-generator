# ADR-082: Expected gains, the effective-agent-performance metric, and the honest ceiling

**Status**: Proposed (prototype)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-076 (benchmark), ADR-077 (DGM), ADR-081 (Darwin Plus synthesis), ADR-075 (acceptance)

> Pins what improvement to *expect* from harness evolution, the single composite metric we report (not raw solve rate), the conditions under which it works and doesn't, and the business-credible framing. Implemented by `src/bench/metrics.ts`.

## Context

Harness evolution can plausibly improve coding-agent performance by **10%–150% relative**, depending on how weak the starting harness is. The strongest public signal is DGM (ADR-077): **SWE-bench 20.0% → 50.0%** (+30 pts, **+150% relative**) and **Polyglot 14.2% → 30.7%** (+16.5 pts, **+116% relative**) — from *harness* self-modifications (editing tools, long-context handling, peer review, validation), not model retraining.

Gains depend on the baseline's maturity (diminishing returns):

| Starting point | Likely relative gain | Why |
|---|---|---|
| Basic prompt-only agent | 50–150% | lots of low-hanging fruit |
| Simple tool-using agent | 20–80% | planner / retry / verifier / context gains |
| Strong harness | 5–30% | mostly eval + routing left |
| SOTA commercial agent | 0–15% | already optimized; regression risk |
| Production enterprise agent | 10–40% task-success | workflow / memory / policy / routing / guardrails |

Where the gains come from (and the mutation surfaces that capture them, ADR-071): context selection (`context_builder`, 5–25%), tool policy (`tool_policy`, 5–20%), reviewer/verifier loops (`reviewer`, 10–40% — the biggest lever), retry/recovery (`retry_policy`, 10–35%), and archive evolution itself (ADR-073, 20–100% over enough generations).

## Decision

### 1. Report the composite, not raw solve rate

Solve rate alone is misleading — a harness that solves more but costs more or acts unsafely is not better. Report:

```
effective_agent_performance = verified_success_rate / cost_per_success × safety_score
```

Worked example (the canonical one): baseline `0.40 / 1.00 × 0.98 = 0.392`; evolved `0.52 / 0.80 × 1.00 = 0.650` — a **+66% effective gain** even though raw solve rate rose only 12 points. Implemented as `effectiveAgentPerformance`, `effectivePerformanceGain`, and `aggregateMetrics` in `src/bench/metrics.ts` (zero/unmetered cost is treated as neutral 1× so the metric never diverges).

### 2. The business framing (what we promise)

Do **not** promise "2× better agents." Promise, and measure:

- **10–30%** higher verified task completion
- **10–25%** lower cost per solved task
- **20–50%** fewer unsafe tool actions
- **clean lineage + replay** for every promoted change

### 3. The honest ceiling (when it works / doesn't)

Works when: the task has executable feedback; the benchmark is stable; the agent can safely modify useful harness code; the archive explores diverse strategies; promotion is strict. Will **not** help when: there is no reliable evaluator; the task is subjective; the benchmark is contaminated; the child can game the metric; the model lacks the domain knowledge; or the sandbox blocks useful feedback.

**Benchmark caution (recorded so we don't over-claim):** SWE-bench-style scores can overstate real-world capability — 2025 work found SWE-bench Verified may overlap model training data (models scored far higher on it than on newer alternatives), and benchmark *mutations* can substantially reduce apparent performance for some agents. Mitigations are already in the design: **hidden tests + rotating seeds** (ADR-076 anti-overfitting), **immutable task-hash snapshots** (ADR-076 anti-tampering), and **repo-native tasks first**, graduating to SWE-bench only once the runner/gates/replay are stable (ADR-076 levels). We treat benchmark numbers as evidence under these controls, not as ground truth.

### 4. Expected trajectory for MetaHarness (compounding, diminishing)

| Layer | Baseline | Target | Relative gain |
|---|---|---|---|
| Basic repo harness | 25% | 40% | +60% |
| + verifier & retry | 40% | 52% | +30% |
| + ruVector memory | 52% | 60% | +15% |
| + archive evolution | 60% | 66% | +10% |
| + clade selection | 66% | 70% | +6% |

Time horizon: 10–25% on repo-native tasks in the first 30 days; 25–60% over 90 days; best case ~2× from a weak baseline; sustained 5–15% incremental once the harness is already strong.

## Consequences

- **Credible, not hyped.** The composite metric + the promise band keep claims defensible to enterprises and reviewers.
- **Anti-overfitting is a first-class requirement**, not an afterthought — hidden tests, rotating seeds, immutable snapshots, repo-native-first are mandated, not optional.
- **Diminishing returns are stated up front**, so a 6% gain on an already-strong harness reads as success, not failure.

## Alternatives Considered
1. **Report raw solve rate.** Rejected — ignores cost and safety; the composite is the honest headline.
2. **Promise 2× across the board.** Rejected — only credible from weak baselines; over-claiming invites the benchmark-contamination critique.
3. **Trust SWE-bench numbers as ground truth.** Rejected — contamination/mutation studies; we gate numbers behind hidden tests + immutable snapshots + repo-native-first.

## Test Contract
1. `effectiveAgentPerformance` matches the worked example (0.392, 0.650) and `effectivePerformanceGain ≈ 0.66` (pinned in `metrics.test.ts`).
2. `aggregateMetrics` computes verified-success rate, cost-per-success, safety score, and the composite from `BenchmarkResult[]`; zero/empty cases are safe.
3. **Acceptance (Darwin Plus, ADR-081):** across 100 repo-native hidden tasks, the evolved harness beats baseline by **≥10 absolute points or ≥20% relative**, with **zero safety violations** and **cost-per-solve ≤ 1.20× parent** — gated on the LLM `CodeGenerator` (ADR-075 staging).

## References
- DGM arXiv:2505.22954 (the +150%/+116% relative signal). HGM arXiv:2510.21614, SGM arXiv:2510.10232 (the gates that keep gains real).
- Benchmark-contamination / mutation cautions (2025 SWE-bench analyses) — motivate the hidden-test + immutable-snapshot + repo-native-first controls (ADR-076).
- In-repo: `src/bench/metrics.ts`, ADR-076 (benchmark + anti-gaming), ADR-081 (synthesis + acceptance).
