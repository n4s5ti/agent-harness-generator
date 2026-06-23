# ADR-176: SWE Conductor — role-specialized repair with deterministic verifiers + asymmetric escalation

**Status**: Proposed (empirically grounded by ADR-174 measurements)
**Date**: 2026-06-22
**Project**: `ruvnet/agent-harness-generator`
**Builds on**: ADR-173 (conformant), ADR-174 (Test-Critic + line-applicator + MCTS), ADR-175 (dual-mode).

## Context — what today's measurements forced

Three conformant batches (25-instance Lite pilots, gold-graded) isolated the bottleneck precisely:

| config | attempt-rate (non-empty) | repro-validity | branch-pass (in-loop) | gold resolve |
|---|---|---|---|---|
| DeepSeek search floor | 44% | 68% | ~8% | **5/25 = 20.0%** |
| MiniMax-M2.7 patch swap | 48% | 68% | ~16% | **5/25 = 20.0%** (2.2× cost) |
| Line-applicator (alone) | **80%** | 64% | ~16% | **4/25 = 16.0%** |
| Line + repro-gap fix (combined) | ~80% | **~91%** | ~27% | _pending_ |

**The decisive finding:** fixing the *plumbing* (attempt-rate 44→80%, repro-validity 68→91%, including the
historically-unreproducible django/sympy) did **not** lift gold resolve. The drop from 91% repro-valid to
~27% branch-pass is a **pure reasoning deficit** — DeepSeek-V4-Flash ($0.09/M) cannot comprehend the
cross-file/lifecycle fixes in the harder ~half of SWE-bench, no matter how forgiving the environment.
A bigger patch model (MiniMax) didn't help either. **Reasoning, not tooling, is the wall.**

## Decision

Build the **SWE Conductor**: a cheap conductor decomposes, routes, scopes context, and runs deterministic
verifiers; **frontier reasoning (Opus 4.8) is spent only where evidence proves it's needed** — the
asymmetric-routing answer to the measured reasoning ceiling. The conductor never authors patches.

Three runtime modes: **SWE Fast** (localized, ~$0.05), **SWE Ultra** (MCTS k≤15, ~$0.60), **SWE Sniper**
(Opus 4.8 on the bedrock tail, <10% of tasks). CLI: `metaharness swe {run,eval,replay,report}`.

### Architecture (six layers)
Conductor (state machine, DeepSeek-V4-Flash) · Context Builder (per-role visibility) · Agent Pool
(Test-Critic, Navigator, Coder, Sniper — strict output schemas, scoped tools) · Tool Kernel (schema-
validated, audited) · Verification Kernel (Linter `py_compile`, repro, tests, patch-quality — *deterministic,
no LLM*) · Trajectory Archive (replayable bundles).

### Asymmetric escalation (the Pareto play)
The cheap agents act as an aggressive intern: write the repro, localize, attempt, and *fail* — then hand
Opus 4.8 a **compressed package** (the validated failing repro + Navigator's implicated lines + DeepSeek's
failed-attempt traces), not a raw transcript. Sniper triggers: ≥5 Coder failures, MCTS collapse, repro-
passes-but-official-tests-fail, security/concurrency/lifecycle files, or sub-threshold confidence.

### What's already built (ADR-174) and maps directly
- Test-Critic (`test-critic.mjs`) = the repro agent (now framework-aware, exit-code judged, 91% valid).
- Line-applicator (`solve-mcts.mjs`) = Coder's `edit_lines` primitive (80% attempt-rate).
- `py_compile` backstop = the Linter. `runConformantTests` (Docker, no-gold) = repro/tests verifier.
- `--sniper` flag = the Sniper hook. MCTS best-of-k loop = SWE Ultra core.
So SWE Conductor is a **refactor + formalization** of validated pieces, not a greenfield build.

## Non-goals (phase 1)
No weight training, no auto-submission, no network in the repair sandbox, no benchmark leakage (gold tests
never in-loop — the conformance guarantee carries over), no edits outside the checkout.

## Scoring & guardrails
Candidate 0–100 (repro 30 / official-tests 30 / minimality 15 / static 10 / explanation 5 / cost 5 / risk 5).
Accept thresholds Fast 80 / Ultra 85 / Sniper 90. Hard rejects: empty patch, syntax fail, test deletion,
broad unrelated rewrite, network/secret/oracle access.

## First milestone (smallest useful)
Deterministic state machine + Test-Critic + Navigator + Coder + Linter + Fast pathway + replay archive +
50-task eval runner. Exit: end-to-end on fixtures, rejects empty patches, emits replay bundle, measures
cost/latency, escalates failed Fast → Ultra stub.

## Consequences
- The Pareto thesis survives **as a hybrid**: cheap conductor + cheap agents for evidence-gathering, Opus
  only on the tail. The measured ceiling says a pure-cheap-model #1 is not reachable; a cheap-evidence +
  frontier-sniper system at a fraction of frontier-only cost still can be a Pareto-frontier entry.
- Auditability (replay archive) becomes a first-class moat, not an afterthought.
- Honest reporting rule (ADR-175) unchanged: every number states its mode; leaderboard claims only from
  conformant, batch-verified, conformance-asserted runs.
