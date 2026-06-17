# ADR-070: Darwin Mode — bounded empirical self-improvement for agent harnesses

**Status**: Proposed (prototype)
**Date**: 2026-06-17
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-014 (self-evolution + federation), ADR-041 (MetaHarness as program synthesis + search), ADR-047 (the algorithmic control plane), ADR-050 (harness intelligence), ADR-040/043 (routing), ADR-011 (witness + provenance)

> This is the head of a six-ADR series (ADR-070…075) that specifies **Darwin Mode**: a system that generates child agent harnesses, runs them against repo tasks in a sandbox, scores them, archives the lineage, and promotes only measured, safe improvements. It is filed in this repo as ADR-070 per the INDEX "append, do not renumber" convention; it corresponds to the externally-drafted *ADR 312: Darwin Mode* by rUv (2026-06-17).
>
> - **ADR-070** (this) — the thesis, the loop, the product surface, the top-level decision.
> - **ADR-071** — bounded mutation surfaces + the hard safety allowlist.
> - **ADR-072** — the scoring + promotion model.
> - **ADR-073** — the archive: evolve like species, not release like software.
> - **ADR-074** — ruVector as evolutionary memory + RuFlo as execution fabric.
> - **ADR-075** — prototype roadmap (reviewer → context builder → full harness) + acceptance.

## Context

"Self-improving agents" is widely misread as "the model trains itself." The cutting-edge, *practical* version is simpler and ships today: **an agent modifies its own harness, runs benchmarks, keeps the variants that improve, and builds an archive of successful descendants.** The foundation model stays frozen. What improves is the operating system around the model — planner, tool policy, memory, verifier, context builder, retry logic, scoring.

The **Darwin Gödel Machine** (DGM) demonstrated this for coding agents: iteratively modify the source of a coding agent, then *empirically validate* each variant on coding benchmarks. The paper reports SWE-bench improving 20.0% → 50.0% and Polyglot 14.2% → 30.7%, using sandboxing and human oversight as safety precautions. Crucially, DGM does **not** retrain the foundation model; it improves tools, workflows, editing strategy, context handling, review loops, and execution behaviour.

There are three levels of self-improvement, and only one is the right wedge for us:

| Level | What improves | Risk | Practical now |
|---|---|---|---|
| Prompt self-improvement | instructions | low | high |
| **Harness self-improvement** | **tools, memory, planner, verifier, context, routing** | **medium** | **very high** |
| Model self-improvement | weights, data, architecture | high | low for most teams |

**Level 2 is the sweet spot — powerful enough to matter, bounded enough to ship.** It also maps cleanly onto what this repo already is: MetaHarness *generates* harnesses (ADR-041 reframed that as program synthesis under search), RuFlo *orchestrates* runs, and ruVector is the long-term memory substrate. Darwin Mode is the loop that ties them together.

This connects directly to two ADRs already in the series. ADR-014 specified self-evolution as a *bandit loop that tunes a running harness's own configuration knobs* (routing thresholds, decay rates). Darwin Mode is the **generation-time, population-based** sibling: instead of nudging one live harness's scalars, it *forks the harness's source*, evaluates a population of structural variants offline, and keeps an archive. ADR-041 already adopted "search over harness designs, score, mutate topology, emit the best artifact + scorecard" as the thesis; Darwin Mode is the executable realisation of the *evolutionary* search operator in that loop.

## Decision

Build **MetaHarness Darwin Mode**: a TypeScript system (Node built-ins only for the prototype, no runtime deps) that can

1. **Profile** a repo (package manager, test command, source/risk files) into a `RepoProfile`.
2. **Generate** a baseline agent harness from that profile.
3. **Mutate** the baseline into child variants, editing only **approved mutation surfaces** (ADR-071).
4. **Run** each variant against fixed repo tasks in a **sandboxed task directory** (no network, no secrets, no escape).
5. **Score** quality, tests, cost, latency, trace quality, and safety; apply hard penalties (ADR-072).
6. **Archive** every parent→child relationship as a *tree*, not a single best branch (ADR-073).
7. **Promote** only variants that beat the parent under a strict gate, and **sample the next generation from the archive** — not only from the current best — so a weak-looking ancestor can still seed a strong branch.

### The core loop

```
repo
  → repo profiler        (RepoProfile: pkg mgr, test cmd, source/risk files)
  → baseline harness     (generate planner/context/reviewer/retry/tool/memory/score policy)
  → mutation generator   (pick one approved surface, perturb it)
  → variant writer       (copy parent dir, apply mutation)
  → sandbox runner       (safety-inspect → run test command, bounded, no network)
  → score engine         (weighted score − penalty layer)
  → safety gate          (blocked file writes ⇒ disqualify)
  → archive              (parent→children tree + scorecards)
  → selection policy     (sample parents for next generation from the whole archive)
  → next generation
```

### The product surface

One command, repo-in / evolution-out:

```bash
npx metaharness evolve ./my_repo --generations 3 --children 5
```

Writes a self-describing work tree (gitignorable):

```
.metaharness/
  archive.json          # the population tree + every scorecard
  lineage.json          # parent→child edges for the graph
  runs/<variantId>.json # traces + scorecard per variant
  variants/<variantId>/ # the harness source for each variant
  reports/winner.json   # best variant by final score
```

The eight visible outputs that make the demo land: baseline harness · N mutated harnesses · sandbox benchmark runs · leaderboard · trace replay · evolution tree · winning harness "DNA" (its mutation lineage) · a CI badge.

### The prototype skeleton (committed under `examples/darwin-mode/`, not the kernel)

The reference implementation is intentionally dependency-free and lives as an **example**, not in `@metaharness/kernel`. It is the seed the later increments (LLM-backed mutator, ruVector memory, RuFlo orchestration) extend. Module layout:

```
src/
  cli.ts            types.ts         repo_profiler.ts
  generator.ts      templates.ts     mutator.ts
  safety.ts         sandbox.ts       scorer.ts
  archive.ts        evolve.ts
```

The deterministic `mutateContent` in the prototype is a placeholder; ADR-071 specifies the contract for swapping it for an LLM-backed `CodeGenerator` **behind the same hard allowlist**.

### The marketing frame (load-bearing — see ADR-071 for why)

Do **not** market this as uncontrolled recursive self-improvement. Market it as **bounded empirical self-improvement for agent harnesses**: *the model is not self-improving — the harness is.* The bound is enforced by the allowlist (ADR-071) and the promotion gate (ADR-072), and is made auditable by the archive + lineage (ADR-073) and witness provenance (ADR-011).

## Consequences

### What gets easier

- MetaHarness becomes a **measurable agent-evolution engine**, not a template emitter. The differentiator is the scorecard + lineage, consistent with ADR-041.
- The viral demo is visceral and true: *"I gave it my repo, it built agents, they competed, the best one evolved — here's the family tree, the score, and the patch."*
- ruVector gains a durable, valuable role as **evolutionary memory** (ADR-074); RuFlo gains a role as the **population orchestrator** (ADR-074).

### What gets harder

- **Benchmark integrity** is now a first-class concern (leakage, overfitting to task seeds). ADR-072 owns the mitigations (hidden tests, randomized seeds, frozen benchmarks the child cannot edit).
- **Cost** can grow with population × generations. ADR-072's cost term and a circuit breaker bound it.
- **Generated code can look impressive while adding little.** The strict promotion delta + regression gate (ADR-072) is the antidote; "keep only measured wins" is inherited from the DRACO discipline (ADR-037–040).

### What does not change

- The foundation model stays frozen. This is harness evolution, level 2 — not model training.
- The MCP default-deny posture (ADR-022) and witness model (ADR-011) continue to apply to every generated variant.

## Alternatives Considered

1. **Plain hill-climbing (keep only the current best).** Rejected — it gets stuck in local optima and discards ancestors whose descendants would have won. The archive (ADR-073) is DGM's key move precisely because it avoids this.
2. **Tune live config only (ADR-014 self-evolution).** Kept, but insufficient on its own: bandit knob-tuning cannot discover *structural* changes (a new reviewer pass, a different context strategy). Darwin Mode and ADR-014 are complementary — population search at generation time, bandit refinement at run time.
3. **Let the agent rewrite the whole platform.** Rejected as unsafe and unmeasurable on day one. ADR-071 restricts mutation to seven approved files.
4. **Model self-improvement (fine-tune per repo).** Rejected as the wedge: high cost, high risk, low practicality for most teams. Level 2 delivers most of the value at a fraction of the risk.

## Test Contract

This ADR is satisfied when:

1. `npx metaharness evolve <repo>` produces a populated `.metaharness/` tree (archive, runs, variants, winner report) on at least one of the three acceptance repos.
2. The baseline harness is generated purely from `RepoProfile` signals (no hand-authored per-repo content).
3. At least one child clears the promotion gate with **zero blocked safety actions**, and the run is reproducible from a clean checkout (ADR-072/075 own the numeric bar).
4. The lineage of the winner is renderable as a tree from `archive.json` alone (ADR-073).

The full numeric acceptance (≥10% final-score improvement, zero unsafe actions, reproducible `winner.json`) is specified in **ADR-075**.

## References

- Darwin Gödel Machine (DGM): a self-improving coding agent that modifies its own code and validates variants empirically — https://arxiv.org/abs/2505.22954 (SWE-bench 20.0%→50.0%, Polyglot 14.2%→30.7%, with sandboxing + human oversight).
- Gödel Machine (Schmidhuber) — the self-referential, provably-optimal self-improver this lineage is named for: https://people.idsia.ch/~juergen/goedelmachine.html
- Huxley–Gödel Machine line — *descendant potential* over raw benchmark score (motivates the archive, ADR-073).
- In-repo: ADR-014 (run-time self-evolution bandit), ADR-041 (synthesis-under-search thesis + scorecard), ADR-047 (the control plane Darwin Mode's variants run inside), ADR-037–040 (the "keep only measured wins" discipline).
