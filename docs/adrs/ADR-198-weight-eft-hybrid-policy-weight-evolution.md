# ADR-198: Weight-EFT (`@metaharness/weight-eft`) — hybrid policy + weight evolution

**Status**: Accepted (scaffold shipped; training GPU-gated)
**Date**: 2026-06-27
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-073 (darwin archive & selection), ADR-179 (cost-Pareto leaderboard), ADR-181/182 (multi-model cost-cascade), ADR-184 (sovereign evolution genome engine), ADR-194/195/196 (per-instance evolution + Phase-2 capability genes), ADR-177 §53 (conformant ceiling), ADR-197 (redblue — same package conventions)

> MetaHarness's thesis is **"freeze the model, evolve the harness"** — gradient-FREE policy evolution. This ADR adds the *complementary* lever: **gradient/weight self-learning on the open cheap tier.** We distil the harness's archival success into GLM/Qwen via LoRA so the cost-cascade escalates to a frontier model **less often**. The two levers compose: Darwin evolves *which* policy runs; weight-EFT makes the *cheap policy in that cascade* stronger.

## Context

The cost-cascade (ADR-181/182) runs a cheap open model first and escalates to a frontier model only on the hard tail; each escalation costs ~$0.50. Darwin (ADR-073/184) has accumulated a large archive of conformant-measured solve trajectories — both cheap-tier own successes and frontier escalations. That archive is unused training signal. Meanwhile, every self-learning lever in the stack so far is **gradient-free** (policy/scaffold evolution); we have never touched **weights**. The open question: can distilling the archive into the cheap tier via LoRA reduce escalation frequency (a cost win) without pretending to move the frontier reasoning ceiling (which a 7-14B tune cannot)? Doing this safely requires three things the naive approach gets wrong: (1) train/eval disjointness (or the lift is fake), (2) a reward-hacking filter on the training data (or we teach the model to cheat), and (3) an evolutionary safety net that prunes an overfit adapter. This ADR establishes all three.

## Decision

Ship a new package `@metaharness/weight-eft` with: an archive→training-data **exporter**, a GPU-gated LoRA **training runner**, a `weightAdapter` **genome gene** wired into darwin's evolve-config, and an **eval hook** measuring the cost-Pareto delta. Wire it into the umbrella `metaharness` CLI as `metaharness weight-eft <export|train|eval|status>`.

### The thesis is bounded: COST-Pareto, not the frontier ceiling

A 7-14B local-GPU tune **will not crack the hard tail.** The hard tail is a frontier reasoning ceiling (clean-eval ~37.3%, ADR-177 §53) — distilling cheap-tier behaviour cannot manufacture reasoning the base model lacks. The honest, measurable win is **fewer $0.50 frontier escalations**: a distilled cheap model resolves more issues on its own, so the cascade escalates less, so **$/resolved drops.** The eval metric is **escalation-rate-reduction + cost/resolved**, *not* hard-tail cracking. The package's telemetry and the eval-hook verdict string both stay honest about this.

### The data recipe (the load-bearing on/off-policy decision)

- **SFT = ALL gold-resolved trajectories** — cheap-OWN *and* frontier-escalation. SFT (max-likelihood) is off-policy-stable, so a frontier success on an issue the cheap model couldn't solve is **off-policy-safe distillation**: the cheap model learns to imitate a known-good solution.
- **DPO = ON-POLICY cheap-vs-cheap pairs ONLY.** `chosen` = a resolved sample, `rejected` = an empty/failed sample by the **same cheap model on the same instance** (BoN-derived). We deliberately do **not** emit frontier-chosen-vs-cheap-rejected DPO pairs: an off-policy preference pair is **unstable** (the reference policy never produced the chosen completion, so the implicit-reward gradient is ill-conditioned). That signal is routed to SFT instead.
- Two-stage: **SFT first** (distil), then **on-policy DPO** from the SFT checkpoint (preference-sharpen).

"Gold-resolved" means the **official swebench harness** `resolved_ids` — never an in-loop oracle signal.

### Output formats — canonical standard, not custom

Portability across `ruvllm`/MicroLoRA, TRL, axolotl, unsloth:

- **SFT**: OpenAI chat JSONL with `tool_calls` **preserved** (the ReAct loop is not flattened to plain text — the model must learn real tool-use trajectories).
- **DPO**: TRL/HF conversational preference (`prompt` = system+issue; `chosen`/`rejected` = full trajectories, since ReAct diverges at the first action).
- A **thin runner-adapter** at the training boundary maps the standard schema → whatever the runner ingests, so the exported files stay portable.

### The contamination guard (the headline correctness property)

**Strict train/eval instance-ID disjointness.** The exporter takes an `evalHoldout` set of `instance_id`s, excludes any trajectory whose id is in it, and `assertTrainEvalDisjoint` **throws** on any overlap. *Training on eval instances is fake lift — the exact contamination we debunk elsewhere (the clean-eval discipline of ADR-177).* This is enforced in code (`src/export.ts`) and proven by a test that a train/eval overlap is rejected.

### The reward-hacking filter (Ornith-1.0 borrow; the training-data conformance firewall)

A **deterministic monitor** (`src/reward-hack.ts`) runs over each gold-resolved trajectory and **drops** any that (a) read a withheld gold/test path (`gold_patch`, `FAIL_TO_PASS`/`PASS_TO_PASS`, `test_patch`, the swebench evaluator), (b) modified the verification/test harness (`conftest.py`, `run_evaluation`, `pytest.ini`, …), or (c) touched a path outside the sandboxed repo. An archived "success" that secretly reward-hacked would teach the model to **reward-hack** — so this is the **training-data analog of the conformance firewall**, SEPARATE from and IN ADDITION TO the disjointness guard. The drop count is surfaced in the export report and proven by a test (a trajectory that read a withheld gold path is excluded with a logged reason). Prior art: **Ornith-1.0** (DeepReinforce) — its reward-hacking defense flags trajectories acting outside the sanctioned tool surface → zero reward + excluded.

### The long-context filter

SWE/ReAct trajectories can exceed a 7-14B context window (~32k). The exporter filters to a configurable max-token budget and **drops (or truncates with `--truncate`) and REPORTS** over-length trajectories — no silent loss. Proven by a test that an over-length trajectory is dropped/flagged.

### The `weightAdapter` genome gene (the prune-the-overfitter safety net)

A LoRA tune can overfit (memorize SFT, regress on held-out). Rather than trust it blindly, the adapter is a **gene** in darwin's evolve-config genome (`packages/darwin-mode/bench/swebench/evolve-config.mjs`):

- `weightAdapter: null` = **BASE** (no adapter) — the default and the control. A genome that never opts in is **byte-identical (by key) to a pre-gene genome** — the `+w:<id>` suffix is appended to `gkey`/`readbackKey` *only* when a non-base adapter is selected, exactly mirroring the Phase-2 `+cap` suffix discipline (ADR-195). `normalizeGenome` coerces absent/`''`/`base`/`none` → `null`.
- `weightAdapter: 'sft'` / `'sft-dpo'` = the two recipes.
- Wired into `normalizeGenome` / `mutate` (a `wadapter` field) / `crossover` (uniform inheritance) / `seedPopulation` (two probes), and `weightAdapterFlags` forwards `--lora-adapter <id>` to the cheap-tier solver.

Base competes against the tuned variants under the **same conformant fitness**, so **evolution prunes an adapter that doesn't actually lift held-out resolve.** This is gradient-free selection providing the *safety net* for the gradient tune — the hybrid loop. The gene is **inert until an adapter is trained** (a GPU job); it only *names* an adapter.

### The training runner is GPU-gated ($0 by default)

`runTraining` refuses to actually train unless **BOTH** an explicit `--train`/`train:true` flag **AND** a detected GPU/endpoint are present; otherwise it dry-runs (emits the plan) or refuses. Target is **7-14B** (Qwen2.5-Coder-7B / GLM-4-9B) — *not* 32B (§59: 32B q4 spills a 16GB GPU). The actual `spawn(plan.command)` against ruvllm/MicroLoRA is the documented integration seam a GPU host implements; no training has been executed.

### Architecture

`src/{types,export,reward-hack,train,genome,eval,index,cli}.ts`. Dependency-free (Node built-ins), mirroring darwin-mode and redblue: `tsc` build, `vitest`, ESM, a `weight-eft` bin. Wired into the npm workspaces and added as a dependency of the umbrella `metaharness` package, which exposes `metaharness weight-eft <export|train|eval|status>` by delegating to `@metaharness/weight-eft/cli`.

## Self-scaffolding RL — the future direction (roadmap; not built here)

Ornith-1.0 (DeepReinforce, <https://deep-reinforce.com/ornith_1_0.html>) **co-trains scaffold + policy**: the model proposes a refined scaffold, then solves, and both are rewarded — self-scaffolding RL for agentic coding. Our synthesis:

> **Use Darwin's winning evolved scaffolds as the scaffold-generation training target.** Darwin's genome archive (ADR-073/184) is a population of *evolved, conformant-measured scaffolds*. Evolutionary scaffold-search (gradient-free) produces a **supervised signal** — "given this issue class, here is a high-fitness scaffold" — that an Ornith-style RL loop can learn to **author**. Darwin discovers the scaffold; weight-EFT teaches the model to write it.

This is a **convergent-design validation**: Ornith arrived at scaffold+policy co-training via RL; MetaHarness arrived at scaffold-search via evolution. The roadmap unifies them — Darwin as the gradient-free scaffold oracle, RL as the gradient internalizer. **Documented as the ADR-198 roadmap; deliberately NOT built in this iteration** (it needs a real RL training loop + GPU budget). Cited here as prior art and the next milestone.

## Consequences

- **+** A real second self-learning axis (weights), composable with policy evolution, attacking cost where the frontier ceiling is fixed.
- **+** The contamination guard + reward-hacking filter make the *training data* as honest as the eval discipline — no fake lift, no learned reward-hacking.
- **+** The `weightAdapter` gene means an overfit tune is *selected against*, not shipped blind.
- **−** The headline win (fewer escalations) is unverified until a GPU run happens; this ADR ships the **scaffold + the guards + the gene**, gated honestly.
- **−** Adds a small surface to darwin's genome; mitigated by byte-identical-when-base keys + the full existing darwin test suite passing.

## Status (real)

- **Runnable, $0:** exporter (disjointness + reward-hack + long-context guards, SFT/DPO recipe, tool-call fidelity), training-plan emission, cost-Pareto eval folding, the `weightAdapter` gene (in darwin's evolve-config + the umbrella CLI). 37 weight-eft tests + 9 new darwin gene tests green; existing darwin genome tests unchanged and green; `tsc` clean.
- **Scaffolded, GPU-gated:** the actual LoRA training (the ruvllm/MicroLoRA `spawn` seam). **No training run, no GPU job, no paid model call executed.**
- **Roadmap:** self-scaffolding RL (Ornith-1.0 convergent design) — documented, not built.
