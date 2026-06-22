# ADR-173: Leaderboard-conformant top-10 on SWE-bench Lite → Verified, at the cost-per-resolve frontier

**Status**: Accepted — implementing (conformant solver first)
**Date**: 2026-06-22
**Project**: `ruvnet/agent-harness-generator`
**Builds on**: ADR-153 (agentic loop), ADR-170 (PTY loop), ADR-172 (SOTA roadmap). Supersedes the
escalation-cascade approach *for leaderboard purposes* (that path uses an in-loop oracle — see below).

## Context — why our 68.3% does not place, and what actually does

Our blended 68.3% (RESULTS §30) and the whole 7.7%→58.3%→68.3% ladder **use the official `FAIL_TO_PASS`
harness as an in-loop oracle** (`evalOne` / `run_tests` gate repair + escalation). The SWE-bench
leaderboard forbids access to the held-out grading tests during solving → **our numbers are valid
research metrics but not submittable.** A conformant run will score lower; *that* is the real number.

**Live leaderboards (fetched 2026-06-22):**
- **SWE-bench Lite (300):** #1 ExpeRepair+Claude-4-Sonnet **60.33%**; top-5 ≈ 50%+; **top-10 cutoff ≈ 45%**
  (EntroPO+Qwen3-Coder-30B 45.0). Board skews 2024–2025; ripe for a 2026-model entry.
- **SWE-bench Verified (500):** top ~76.8% (Claude 4.5 Opus), **top-10 cutoff ≈ 70%**, all via
  **mini-SWE-agent v2** with a single harness.
- **Cost-per-resolve champions (the user's goal — "lowest cost at best intelligence"):**
  **MiniMax M2.5 = 75.8% Verified @ ~$0.07/inst**, Kimi K2.5 70.8% @ $0.15, DeepSeek V3.2 70.0% @ $0.45
  — all ~10× cheaper than Claude Opus ($0.75). OpenRouter-available (verified): `minimax/minimax-m2.5`
  ($0.15/$0.90 per M), `deepseek/deepseek-v3.2` ($0.23/$0.34 — cheapest reasoning), `moonshotai/kimi-k2.5`
  ($0.38/$2.02), `qwen/qwen3-coder-30b-a3b-instruct` ($0.07/$0.27).

## Decision

A **leaderboard-conformant, cost-optimal** entry — single system, no gold-test oracle, cheapest model
that clears the bar.

1. **Conformant solver (`--no-test-oracle`).** The agent NEVER runs the gold `FAIL_TO_PASS`/`PASS_TO_PASS`
   in-loop. Its self-signal is (a) the repo's **pre-existing** test suite at the base commit, and (b) a
   **self-written reproduction test** inferred from the issue. One patch per instance; the official
   harness scores **once**, after solving. (Implementation: the loop's `run_tests` tool runs `pytest` on
   agent-chosen paths in the work tree *without applying the gold test patch*.)
2. **Model = cost-per-resolve frontier, not raw frontier.** Primary **MiniMax M2.5** (best measured
   $/resolve); ultra-cheap option **DeepSeek V3.2**; backup **Kimi K2.5**. Opus-4.8 only as a
   last-resort escalation tier if a conformant cheap run stalls below target. The whole point: top-10 at
   a fraction of the leaders' cost.
3. **Loop = mini-SWE-agent-style / stateful-PTY (ADR-170)** — explore (`grep`/`cat`), edit by line range,
   run the agent's *own* tests, self-correct. The conformant mechanic the board leaders use.
4. **Conformant best-of-N** — sample k patches, select by the agent's *own* reproduction test passing
   (never the gold tests). Buys recall legitimately.
5. **Submit** — PR to `swe-bench/experiments` with `predictions.jsonl` + full trajectories +
   `metadata.yaml`; passes their leakage check. (Confirm current process at swebench.com/submit.)

## Phased plan (each gated on a clean conformant batch)

| phase | target | approach | est. cost |
|---|---|---|---|
| **L0** | build `--no-test-oracle` + offline tests | $0 code (this ADR) | $0 |
| **L1 — Lite top-10** | ≥ 45% conformant | MiniMax M2.5, agentic, single attempt, full-300 | ~$25 |
| **L2 — Lite top-5→#1** | > 60.33% | + PTY loop + conformant best-of-N (k=3–5) | ~$60 |
| **V1 — Verified top-10** | ≈ 70% | same conformant stack on Verified-500 | ~$40 (MiniMax) |

## Gates / discipline
- **Conformant or it doesn't count:** automated leakage check (assert the solver made zero gold-harness
  calls during solving; only the final scoring run touches `FAIL_TO_PASS`).
- Only **batch-eval** numbers; Wilson 95% CI; `--max-cost` bounds every paid run.
- Report **$/resolve** alongside % (the leaderboard does — it's our edge).
- Submit only after a clean conformant batch clears the phase threshold.

## Consequences
- Honest near-term number drops from 68.3% (oracle) to the conformant figure — but it becomes a *real
  leaderboard entry*. Top-10 Lite is very achievable conformant (cutoff ~45%, cheap 2026 models hit
  70%+ Verified); #1 needs L2. Verified top-10 needs ~70% — within reach of MiniMax M2.5 + PTY.
- Positions the project exactly where it's strongest: **best intelligence per dollar**, not biggest model.
