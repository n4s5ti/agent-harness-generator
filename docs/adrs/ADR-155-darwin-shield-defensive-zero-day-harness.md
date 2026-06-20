# ADR-155: Darwin Shield — evolving a defensive zero-day discovery harness

**Status**: Proposed (reference implementation landed — see §Reference implementation)
**Date**: 2026-06-20
**Project**: `ruvnet/agent-harness-generator`
**Codename**: `DARWIN-SHIELD`
**Owner**: MetaHarness / Darwin Mode
**Deciders**: rUv
**Scope**: Defensive vulnerability discovery and remediation on **owned or authorized** repositories
**Related**: ADR-070 (Darwin Mode head), ADR-071 (mutation surfaces + allowlist), ADR-072 (frozen scorer), ADR-073 (archive), ADR-074 (Darwin ↔ ruVector memory fabric), ADR-076 (parent-vs-child benchmark), ADR-077–081 (DGM/HGM/SGM/Hyperagents → Darwin Plus synthesis), ADR-082 (expected gains + effective-performance metric), ADR-153 (agentic-loop architecture)

> This is the security application of the Darwin Plus stack (ADR-077…081). It changes the *task* — defensive vulnerability discovery instead of SWE-bench repair — and the *fitness function*, but keeps the load-bearing thesis intact: **the foundation model stays frozen; the harness evolves; the proof is in replay.** The spec this ADR ratifies was drafted internally as "ADR-301"; it is recorded here under the repo's sequential numbering (ADR-NNN, never renumber) per the INDEX conventions.

## Context

Current AI security tooling falls into three buckets, each optimizing the model while treating orchestration as fixed:

1. **Static analyzers** (Semgrep, CodeQL, `cargo audit`, OSV) — precise but high false-positive, no remediation.
2. **LLM security assistants** — single-pass review of ranked files; capability-bound, not loop-bound.
3. **Autonomous security agents** — fixed multi-agent workflows; no empirical self-improvement.

The evidence from the Darwin Gödel Machine (ADR-077, arXiv:2505.22954) and AISLE-style vulnerability research is that most of the gain comes from **orchestration, not the foundation model**: workflow decomposition, retrieval quality, validation loops, tool selection, context engineering, and iterative review. DGM showed SWE-bench 20→50% and Polyglot 14.2→30.7% from *harness* changes alone (editing tools, long context, peer review) — the model was never trained.

The opportunity: apply the same population → mutate → score → select → archive loop to **defensive** software security. The model remains frozen. The harness evolves. Findings are validated by tests, fuzzers, and sanitizers, stored in ruVector (ADR-074) so the system compounds across runs, and every output passes a hard safety gate before it leaves the sandbox.

**This is a defensive system.** The "zero-day" in the title is the *defender's* zero-day: surfacing an unknown weakness in your own code before an attacker does, and shipping a tested patch. It is not an exploit generator.

## Decision

Build **Darwin Shield**: a Darwin-Mode-based defensive security harness, coordinated by RuFlo as an evolving agent swarm, that continuously evolves vulnerability-discovery workflows through empirical, reproducible evaluation. It shall:

- **mutate** harness configurations (planner, retrieval, reviewer count, retry budget, toolset, model mix, fuzz budget);
- **evaluate** each variant on a curated security corpus + authorized OSS;
- **select** superior descendants by clade metaproductivity (ADR-078), not just best-of-run;
- **archive** genomes, findings, patches, and benchmark receipts in SQLite + ruVector (ADR-073/074);
- **reject** unsafe outputs unconditionally (the only `-∞` term in the fitness function).

Hard invariants:

```
model_frozen      = true     # no model training; only orchestration evolves
harness_evolves   = true
scope             = owned_or_authorized_repos
unsafe_output     = rejected # immediate, before and after every model call
exploit_payloads  = forbidden
```

### Non-goals

The system shall not generate weaponized exploit chains, attack external systems, perform autonomous offensive actions, bypass authorization controls, or create malware/persistence/evasion tooling. `Finding.exploitCodeAllowed` is hard-coded `false`. Output is patches, advisory drafts, failing repro tests, and risk reports — never working exploits.

### Architecture

```
                  ┌───────────────┐
                  │ Darwin Engine │   mutate · evaluate · select · archive
                  └───────┬───────┘
                          ▼
              ┌─────────────────────┐
              │ Harness Population  │   (16 genomes × 50 cycles, default)
              └─────────┬───────────┘
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
     Planner     Context Builder     Reviewer
        └───────────────┼───────────────┘
                        ▼
                Security Agents (RuFlo swarm)
                        ▼
          Static + Dynamic Analysis (Semgrep/CodeQL/audit · fuzz/sanitizers)
                        ▼
                Findings + Patches
                        ▼
                  Safety Filter      ← reject unsafe; redact exploit code
                        ▼
              Archive / Receipts (SQLite + ruVector)
```

### Rust workspace (crates)

| Crate | Responsibility |
|---|---|
| `darwin-core` | mutation, crossover, evaluation, lineage, population management |
| `darwin-swarm` | RuFlo-coordinated agent topology + message contracts |
| `darwin-security` | repo analysis, weakness detection, patch proposals, remediation validation |
| `darwin-eval` | scoring, benchmark execution, fitness calculation |
| `darwin-archive` | genomes, findings, patches, benchmarks, receipts (SQLite) |
| `darwin-sandbox` | sandboxed tool/fuzz/test execution (Docker via `bollard`, WASM via `wasmtime`) |
| `darwin-policy` | scope validation, exploit redaction, disclosure policy, safety gates |
| `darwin-ruvector` | semantic + structural code memory (collections below) |
| `darwin-cli` | `darwin-security scan|bench|swarm` entrypoint |

Companion TypeScript packages: `ruflo_swarm`, `security_agents`, `benchmark_runner`, `policy_guard` (RuFlo workflow, agent implementations, bench harness, MCP-exposed policy guard).

### Genome

```ts
type HarnessGenome = {
  id: string
  parentId?: string
  planner: "file-first" | "sink-first" | "diff-first" | "callgraph-first" | "risk-first" | "memory-first"
  contextPolicy: "minimal" | "semantic" | "callgraph" | "hybrid"
  reviewerCount: number          // clamp 1..5
  retryBudget: number            // clamp 1..6
  fuzzBudgetSeconds: number      // clamp 10..600
  tools: string[]
  modelMix: string[]
  validationPipeline: string[]
  safetyProfile: "strict-defensive"   // never mutated
}
```

Mutation operators (bounded; `safetyProfile` is immutable and the policy/scorer are never self-editable per ADR-071/080): planner family swaps; retrieval `semantic → semantic+graph → hybrid`; reviewer count ±1; retry budget ±1; fuzz budget ×{0.5,1,2}; tool enable/disable over the allowlisted set (Semgrep, CodeQL, `cargo-audit`, Trivy, `cargo-fuzz`, …).

### Agent topology (RuFlo swarm)

`SwarmCoordinator` → `repo-profiler` · `file-ranker`/`risk-ranker` · `context-builder` · `hypothesis-generator` · `static-analysis-runner` · `fuzz-runner` · `patch-writer` · `reviewer` (adversarial: tries to *disprove* findings to kill hallucinations) · `safety-redactor` · `disclosure-writer` · `archive-curator`.

The reviewer's job is falsification, not confirmation; reviewer disagreement is itself a quality signal fed back to ranking.

### Findings + scoring

```ts
type Finding = {
  repo: string; commit: string; file: string; symbol?: string
  weakness: string; confidence: number
  evidence: string[]; patch?: string; test?: string
  verdict: "confirmed" | "false_positive" | "needs_review"
  exploitCodeAllowed: false      // hard invariant
}
```

Operational scoring (per-finding promotion):

```
score = 0.35·confirmed_repro
      + 0.25·patch_passes_tests
      + 0.20·static_tool_agreement
      + 0.10·novelty
      + 0.10·maintainer_acceptance
      - 0.30·false_positive
      - 1.00·unsafe_output          # immediate rejection
```

Benchmark fitness (genome selection — `DARWIN-SHIELD-BENCH`):

```
fitness = 0.30·true_positive_rate
        + 0.20·patch_test_pass_rate
        + 0.15·reproduction_success
        + 0.15·false_positive_reduction
        + 0.10·time_to_finding
        + 0.10·cost_efficiency
        - 1.00·unsafe_output
```

### ruVector memory (ADR-074 fabric, security collections)

Seven collections — `code_chunks`, `callgraph_nodes`, `confirmed_findings`, `false_positives`, `patches`, `genomes`, `benchmark_receipts` — with the `SecurityVectorMeta` schema (repo/commit/language/path/symbol/chunk_type/risk_tags/callgraph_degree/taint_role/finding_id/genome_id/benchmark_id/verdict).

Hybrid retrieval rank:

```
rank = 0.45·vector_similarity
     + 0.20·callgraph_centrality
     + 0.15·taint_sink_proximity
     + 0.10·historical_finding_similarity
     + 0.10·recent_change_weight
     - 0.25·false_positive_similarity   # negative memory: don't repeat dead hypotheses
```

Memory is what makes Darwin Shield *compound*: cycle 1 of a new repo seeds its population from nearest prior winning genomes (`seed_population`), retrieves accepted patches for similar historical issues as patch-agent context, and down-ranks hypotheses similar to past false positives. Without memory each run starts from zero; with it, the next repo starts smarter.

Key API (`darwin-ruvector`):

```rust
impl RuvSecurityMemory {
    pub async fn index_repo(&self, repo: RepoRef) -> Result<IndexReport>;
    pub async fn retrieve_context(&self, q: SecurityQuery, p: RetrievalPolicy) -> Result<SecurityContext>;
    pub async fn write_receipt(&self, r: BenchmarkReceipt) -> Result<()>;
    pub async fn seed_population(&self, profile: RepoProfile, k: usize) -> Result<Vec<HarnessGenome>>;
}
```

### Safety controls (mandatory gates)

Scope gate · repo-ownership gate · secret-scanning gate · unsafe-output gate · exploit-redaction gate · network-isolation gate · human-approval gate · audit-receipt gate. The policy filter runs **before and after every model call** (ADR-071 gate-first). Human approval is required before any patch merge, disclosure publication, or production deployment.

Sandbox (`darwin-sandbox`): no external network by default, read-only repo mount, write only to workspace, time-boxed execution, memory limits, tool allowlist, full trace logging. Reject any output containing credential theft, persistence, evasion, live exploitation, weaponized payloads, or third-party targeting.

### CLI (MVP)

```bash
darwin-security scan ./repo \
  --scope owned \
  --baseline semgrep,codeql,cargo-audit \
  --population 16 --cycles 50 \
  --policy strict-defensive \
  --output ./receipts

darwin-security swarm ./repo \
  --scope owned --cycles 50 --population 16 \
  --policy strict-defensive --memory ruvector --receipts ./receipts

darwin-security bench \
  --corpus ./bench/corpus \
  --baselines static,llm,fixed-agent,darwin \
  --cycles 50 --population 16 \
  --policy strict-defensive --out ./bench/results
```

## Consequences

**Positive**: continuously improving, model-agnostic security workflows; full auditability via receipts; a compounding security-intelligence archive (ruVector); differentiation that lives in the *evolving harness + empirical loop + lineage archive*, not the model. **Negative**: higher compute (population × cycles × fuzzing); benchmark-maintenance burden; requires curated evaluation datasets; gains are capped by corpus quality. **Strategic**: positions Darwin Mode as a practical self-improving agent for *defensive* security — the moat is the loop, not the weights.

## Alternatives considered

1. **Buy/wrap a single static analyzer or LLM assistant** — rejected: that is baseline `B0`/`B1`; no compounding, no remediation loop, and the FP rate is the core pain point.
2. **Fixed multi-agent harness, no evolution** (`B2`) — rejected as the *product*, kept as the mandatory benchmark baseline: Darwin Mode is not accepted as "self-improving" unless it beats `B2` on confirmed defensive findings without raising unsafe-output risk.
3. **Fine-tune a security model** — rejected: violates `model_frozen`; the DGM/AISLE evidence says orchestration dominates; training adds cost, opacity, and contamination risk for a smaller marginal gain.
4. **Reuse ADR-076's SWE fitness directly** — rejected: SWE solve-rate is the wrong target; security needs TPR/FPR/repro/safety terms and a hard `unsafe_output` rejection, hence a dedicated fitness function and corpus.
5. **Offensive/red-team variant** — out of scope by invariant; see Non-goals. The platform is strictly defensive and `exploitCodeAllowed` is hard-coded `false`.

## Test Contract

The decision is "shipped" only when the four-layer test set passes and the benchmark gates are met.

- **Unit** (`darwin-core`/`darwin-policy`): genome mutation stays inside bounds; policy rejects unsafe output (and exploit payloads) deterministically; ranker order is deterministic; archive receipts are reproducible.
- **Integration**: a small repo scan completes end-to-end; Semgrep/CodeQL output parses; ruVector retrieval returns expected chunks; patch agent emits a patch **and** a test; safety agent strips unsafe content.
- **Regression**: a seeded bug is found; a known false positive is rejected; a known patch passes its tests; the same input reproduces the same receipt byte-for-byte.
- **Swarm**: all agents complete; a failed agent retries within budget; a bad genome is eliminated; the champion beats all baselines (`static`, `llm`, `fixed-agent`).

**`DARWIN-SHIELD-BENCH` corpus** (`bench/corpus/{rust,typescript,python,go}`): seeded vulns, real-CVE pre-fix snapshots, and clean repos (FP measurement), with `bench/results/{RESULTS.md,scores.json,lineage.json,findings.json,patches/,receipts/}`.

**Acceptance / Definition of Done** — PASS only when:

| Gate | Target |
|---|---|
| Evolution cycles complete | 50, champion selected, baseline comparison generated |
| Confirmed-finding / TPR improvement vs fixed harness | **≥ +25%** |
| False-positive reduction | **≥ 40%** |
| Patch test-pass rate | **≥ 80%** (all accepted patches include tests) |
| Reproducible findings | **≥ 90%**; every finding has a receipt |
| Unsafe outputs emitted | **0** (hard gate) |
| Cost increase vs fixed harness | **≤ 2×** |
| ruVector: context recall@20 | **≥ 0.85** |
| ruVector: FP repeat-rate drop | **≥ 35%** |
| ruVector: patch-reuse success | **≥ +20%** |
| ruVector: seeded vs random genomes | **≥ +15%** |
| ruVector: retrieval latency p95 | **≤ 150 ms** |

Champion-promotion rule (inherits ADR-076/079): the champion genome must beat the previous champion **and** all baselines on confirmed defensive findings, with statistical certification and **zero** increase in unsafe-output risk.

## Reference implementation

A working, dependency-free reference implementation landed in
`packages/darwin-mode/src/security/` (exported as the `security` namespace from
`@metaharness/darwin`). It models the **orchestration layer** — the actual thesis
— against a deterministic, seeded substrate, so the whole pipeline is reproducible
without the external toolchain (Semgrep/CodeQL/Docker/fuzzers) the production
system would shell out to. The crate layout in this ADR is the production target;
the TypeScript module is the validated prototype that proves the loop.

| Concern | Module |
|---|---|
| Genome, bounded mutation, crossover, baselines | `genome.ts` |
| Safety layer (scope gate, exploit redactor, unsafe-output gate) | `policy.ts` |
| ruVector security memory (7 collections, hybrid + negative memory) | `memory.ts` |
| Swarm agents + capability model (genome → detection / FP power) | `agents.ts` |
| RuFlo-coordinated pipeline + receipts | `swarm.ts` |
| Frozen per-finding score + genome fitness | `scoring.ts` |
| Darwin loop (mutate / evaluate / select / archive) | `evolve.ts` |
| DARWIN-SHIELD-BENCH + acceptance gates | `bench.ts` |

**Status of the acceptance gates** (run: `npm run bench:shield`, or
`metaharness-darwin security bench`; default config pop 16 × 50 cycles, seeded):

| Gate | Target | Measured |
|---|---|---|
| TPR improvement vs fixed harness | ≥ +25% | **+150%** (0.4 → 1.0) |
| FPR reduction | ≥ 40% | **−100%** (0.89 → 0.0) |
| Patch-test pass rate | ≥ 80% | **100%** |
| Reproduction success | ≥ 90% | **100%** |
| Unsafe outputs | 0 | **0** |
| Cost increase vs fixed harness | ≤ 2× | **~1.76×** |
| Reproducible from receipts | 100% | **byte-identical re-run** |
| Champion beats every baseline | yes | **yes** |

Coverage: 4 baselines (static / LLM single-pass / fixed agent / Darwin), ~80
unit/integration/regression/swarm/perf tests, all deterministic. What is
**mocked vs real**: the evolutionary loop, genome/mutation, safety gate, scoring,
fitness, and ruVector ranking are real and exercised; the static-analyzer / fuzzer
/ sandbox *adapters* are modeled by a seeded corpus (`corpus.ts`) so the gradient
is reproducible — wiring the real tools behind those adapters is the production
follow-up, not a change to the loop.

## References

- ADR-070–073 — Darwin Mode head, mutation surfaces + allowlist, frozen scorer, archive.
- ADR-074 — Darwin ↔ ruVector memory/RuFlo fabric (the substrate this ADR's seven security collections extend).
- ADR-076 — parent-vs-child benchmark (the five-gate evaluation pattern reused with a security fitness function).
- ADR-077–082 — DGM (arXiv:2505.22954), HGM (arXiv:2510.21614), SGM (arXiv:2510.10232), Hyperagents (arXiv:2603.19461), Darwin Plus synthesis, expected-gains/effective-performance metric.
- ADR-153 — agentic-loop architecture (the bounded ReAct tool surface the security agents run inside).
- Prior art: Darwin Gödel Machine; AISLE-style AI-assisted vulnerability research (orchestration > foundation model); Semgrep, CodeQL, OSV, `cargo audit`/`cargo deny`, Trivy/Grype/Syft, AFL++/libFuzzer/honggfuzz/`cargo-fuzz`.
