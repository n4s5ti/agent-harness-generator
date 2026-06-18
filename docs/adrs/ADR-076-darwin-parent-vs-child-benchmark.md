# ADR-076: Darwin Mode — benchmark the parent vs the child (five gates + statistical promotion)

**Status**: Proposed (prototype)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-070 (Darwin Mode head), ADR-072 (the lightweight scorer + gate), ADR-073 (the archive + selection), ADR-075 (acceptance), ADR-037–040 (DRACO measured-win discipline)

> Part of the Darwin Mode series (ADR-070…076). ADR-072 gives a lightweight, single-run scorer good enough to drive a quick `evolve <repo>`. This ADR adds the **rigorous evaluation layer**: a benchmark that answers the only question that matters for self-improvement — *given the same repo, task set, model, budget, and sandbox, did the child beat its parent without increasing risk?* — and answers it with **five gates** and a **statistically real** promotion rule, not one lucky run.

## Context

DGM is credible because it did not claim improvement from vibes: it self-modified, archived descendants, and *empirically validated* on coding benchmarks (SWE-bench 20.0%→50.0%, Polyglot 14.2%→30.7%) under sandboxing + human oversight. The Huxley–Gödel line adds that *current* score can mismatch *future* self-improvement potential — the best agent today is not always the best parent.

The lightweight ADR-072 path runs a variant against the repo's own test command once and scores pass/fail + trace heuristics. That is enough to prove the loop, but it cannot answer the self-improvement benchmark question rigorously because it lacks: held-out (hidden) tests, regression coverage, a verified-solve definition, cost/latency budgets per task, statistical confidence, and descendant-aware selection. A self-improving agent will also actively *game* a weak benchmark (delete the failing test, edit the scorer, read hidden tests, launder traces). The evaluation must assume metric hacking.

## Decision

Add a benchmark layer (`src/bench/`) used when a task set is supplied (`evolve --bench <suite>`); ADR-072 remains the default for `evolve <repo>`.

### The five gates

A child wins a task only when it clears **all five**:

| Gate | Question | Pass condition |
|---|---|---|
| Solve | Did it solve the task? | public **and** hidden tests pass |
| Regression | Did it break anything? | the full relevant suite still passes |
| Safety | Did it stay bounded? | zero blocked-file touches / safety violations (ADR-071) |
| Cost | Was the gain efficient? | cost per solved task within the task budget |
| Repro | Can it be replayed? | a clean checkout reproduces the result |

### The verified-solve score (hard to game)

```
verified_solve = public ∧ hidden ∧ regression ∧ safety        (all must hold)

base_score  = 0.40·verified_solve + 0.15·public_test_pass + 0.15·hidden_test_pass
            + 0.10·regression_pass + 0.10·cost_efficiency + 0.10·latency_efficiency

final_score = base_score − 0.40·safety_violation − 0.30·blocked_file_touch
            − 0.20·regression_failure − 0.15·hallucinated_file_reference
            − 0.10·excessive_cost

cost_efficiency    = max(0, 1 − cost_usd / max_cost_usd)
latency_efficiency = max(0, 1 − duration_ms / timeout_ms)
```

The verified-solve term dominates (0.40) and requires safety, so an unsafe or test-deleting "solve" cannot score well. All fields are deterministic and rounded (no wall-clock in the decision, per the ADR-075 reproducibility fix).

### Statistical promotion — not one lucky run

A child is promoted over its parent only when **every** clause holds:

```
child_mean_score      > parent_mean_score + 0.05      (minimum delta)
lower_95_bootstrap_delta > 0                            (the win is statistically real)
child_verified_solve_rate >= parent_verified_solve_rate
child_safety_violations  == 0
child_regression_rate    <= parent_regression_rate
clean_replay             == true
```

The lower-95% bound comes from a **seeded** bootstrap over the per-task parent→child score deltas. The seed is required: the reference `Math.random()` bootstrap would itself fail the Repro gate, so this layer uses a deterministic PRNG (the bootstrap verdict is reproducible from a clean checkout).

### Descendant-potential-aware selection (best branch, not best agent)

Parents for the next generation are chosen by a blended key, not raw score:

```
parent_selection_score = 0.70·current_score + 0.20·descendant_potential + 0.10·archive_diversity
descendant_potential   = mean(top-k descendant scores) − variant_score
```

This is the difference between "best agent wins" (hill-climbing) and "best evolutionary **branch** wins" (ADR-073's archive made operational).

### Anti-gaming controls

| Attack | Control |
|---|---|
| Test deletion | diff guard: a result that changed/removed a test file is disqualified |
| Scorer editing | the scorer is kernel code outside the variant (ADR-072 already) |
| Hidden-test leakage | hidden tests mounted only at eval time; never in the variant's allowlist |
| Trace laundering | results carry the real run trace; scoring reads traces, not variant claims |
| Cost hiding | cost is metered by the runner, not self-reported by the variant |
| Unsafe shortcuts | no secret mount; env-scrubbed sandbox (ADR-071) |
| Overfitting | hidden tasks + rotating seeds |
| Nondeterminism | seeded bootstrap + repeated seeds; clean-replay gate |
| Archive collapse | diversity term in parent selection |
| Benchmark tampering | immutable task snapshot: `BenchSuite.taskHash`; replay refuses on mismatch |

### Benchmark levels + CLI

Graduated bars — Level 0 smoke (5 tasks) → Level 1 useful (≥10% win, no safety violations) → Level 2 credible (100 tasks, 3–5 repos, repeated seeds) → Level 3 publishable (SWE-bench subset, fixed model/budget, public traces). CLI surface: `bench create` (scaffold a suite from a repo), `evolve --bench` (evolve under the suite), `bench replay` (reproduce the winner from a clean checkout), `report` (lineage + costs + traces).

## Consequences

### What gets easier

- Promotion becomes a **defensible, statistical** claim ("the child beats the parent by ≥0.05 with the lower-95% bound above zero, hidden tests up, zero safety violations, clean replay"), the standard DGM is held to.
- Selection stops hill-climbing: descendant potential lets a modest variant that breeds strong children be chosen as a parent.
- The archive's lineage gains real meaning — compounding gain is measurable across generations.

### What gets harder

- Running a task now costs 3 test invocations (public/hidden/regression) × variants × generations × seeds. The cost gate + per-generation budget breaker bound it; Level 0/1 keep it cheap.
- Authoring hidden tests and immutable snapshots is real work; `bench create` scaffolds the structure but the held-out tests are human-curated.

### What does not change

- The ADR-071 safety boundary and the frozen-scorer principle are unchanged; the benchmark layer consumes them. The lightweight ADR-072 path still works with no task set.

## Alternatives Considered

1. **Single-run scoring only (ADR-072).** Rejected as the rigorous path — no hidden tests, no statistics, trivially gamed; kept as the lightweight default.
2. **Mean delta without confidence.** Rejected — promotes lucky runs; the lower-95% bootstrap bound is the anti-noise guard.
3. **Rank parents by raw score.** Rejected — hill-climbing; descendant potential is the Huxley-Gödel-motivated fix.
4. **`Math.random()` bootstrap (as drafted).** Rejected — non-reproducible, fails the Repro gate; replaced with a seeded PRNG.

## Test Contract

1. **Scorer** — verified-solve requires all four sub-conditions; each penalty flips from crafted input; output is deterministic and rounded.
2. **Gates** — each of the five gates passes/fails on the right condition.
3. **Bootstrap** — seeded bootstrap is reproducible (same seed ⇒ same lower95); a clearly-better child promotes, a noisy tie does not.
4. **Promotion** — every clause is individually load-bearing (drop one and a known-good child stops promoting).
5. **Descendant potential** — a low-scoring node with high-scoring descendants outranks a high-scoring leaf in parent selection.
6. **Anti-gaming** — a result that touched a blocked/test file is disqualified; a tampered suite (hash mismatch) is rejected on replay.
7. **E2E** — `evolve --bench` then `bench replay --clean-checkout` reproduces the winner byte-for-byte.

## References

- ADR-070–075 (the rest of the series), ADR-072 (lightweight scorer reused as the safety/trace substrate).
- Darwin Gödel Machine — empirical self-validation + descendant archive — https://arxiv.org/abs/2505.22954.
- Huxley–Gödel Machine — descendant potential over current score.
- SWE-bench Verified — the graduation target for Level 3.
