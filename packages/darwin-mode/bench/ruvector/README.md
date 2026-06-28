# ADR-201 — ruvector vs dense-RAG ablation harness (Phase 0 scaffold)

Tests whether vector/graph memory lifts **cheap** models over the turn-budget cliff
(ADR-201, `docs/adrs/ADR-201-vector-memory-graphrag-cheap-model-lift.md`).
This directory is the **Phase 0** build: the plumbing for a later, budget-gated
A/B/C × 2-epoch empirical run. It runs and self-validates at **$0**.

Augmentation is **removable** (ADR-150): everything sits behind the `MemoryLayer`
interface in `memory-layer.mjs`. The base cascade still runs on `DenseMemory` alone;
ruvector is a drop-in/drop-out.

---

## Ground-truth: LOCAL ruvector repo capability map (verified 2026-06-28)

### Local repo: `/home/ruvultra/projects/ruvector` (v0.1.2, HEAD 9ea2fd2, ~160 crates, 58 npm packages)

This is the ground-truth from the LOCAL Rust monorepo — NOT the published npm `ruvector@0.2.32`.
The local repo ships the missing capabilities that blocked ADR-201's H3.

| Capability | Local repo status | Node surface |
|---|---|---|
| **GraphDatabase + Cypher + kHop** | ✅ **REAL, BUILT** | `npm/packages/graph-node` + `node_modules/@ruvector/graph-node-linux-x64-gnu/ruvector-graph.node` |
| **RVF multi-vector HNSW (fixed)** | ✅ **REAL, BUILT** | `npm/packages/rvf-node/rvf-node.linux-x64-gnu.node` |
| **GNN node bindings** | ⚠️ source only | `crates/ruvector-gnn-node/` exists; NO pre-built `.node`. Needs `napi build`. |
| **Cypher engine (rvlite)** | ✅ full impl | `crates/rvlite/src/cypher/` — lexer/parser/AST/executor/graph_store. WASM-targeted, no Node binding. |

### Graph-node v2.0.4 — what actually works from Node

```js
const { GraphDatabase } = require('/home/ruvultra/projects/ruvector/npm/packages/graph-node');
const db = new GraphDatabase({ dimensions: 64, distanceMetric: 'Cosine' });
await db.createNode({ id: 'n1', embedding: new Float32Array([...]), labels: ['Document'], properties: {...} });
await db.createEdge({ from: 'n1', to: 'n2', description: 'RELATED', embedding: ..., confidence: 0.9 });
const neighbors = await db.kHopNeighbors('n1', 2); // returns [n1, n2, n3, ...]
const result = await db.query('MATCH (n:Document) RETURN n'); // label-scoped query works
// NOTE: bare 'MATCH (n) RETURN n' returns 0 nodes — must use label: 'MATCH (n:Label) RETURN n'
// NOTE: kHopNeighbors(id, k) includes the start node itself; isolated nodes return [self]
const stats = await db.stats(); // { totalNodes, totalEdges, avgDegree }
```

### Local rvf-node — sync API, fixes multi-vector bug

```js
const { RvfDatabase } = require('/home/ruvultra/projects/ruvector/npm/packages/rvf-node');
const db = RvfDatabase.create(path, { dimension: 384, metric: 'cosine' }); // synchronous
db.ingestBatch(new Float32Array([...flat vectors...]), [1, 2, 3]); // numeric ids
const results = db.query(new Float32Array([...query vector...]), k); // [{id: number, distance: number}]
const child = db.derive(childPath); // COW child (synchronous)
db.status(); // { totalVectors, totalSegments, ... }
db.close();
// DIFFERENCE from npm ruvector@0.2.32: local returns ALL k hits (not 1)
```

### What the local build fixes vs npm ruvector@0.2.32

| Issue (at 0.2.32) | Local fix |
|---|---|
| `rvfQuery` returns ≤1 hit regardless of ingest size | Local `RvfDatabase.query(vec, k)` returns all k hits correctly |
| GraphRAG / `@ruvector/graph-node` missing | Local `npm/packages/graph-node` is pre-built and loads from Node |
| `graphrag: true` on `RuvectorMemory` was a stub → kNN fallback | `GraphRagMemory` (kind:`'graph'`) now does REAL kHop graph expansion |

### H3 measurability — ground-truthed proof

**H3 "GraphRAG > dense"** is NOW UNBLOCKED. Key verified facts:

1. **Different candidate pools**: graph expands to the kHop neighborhood of the top-1 anchor; dense
   evaluates all docs globally. For a 6-doc corpus with PLANT_QUERY, graph considers 5 candidates
   (kHop union) vs dense's 6 — AND d2 (chlorophyll, graph-reachable) appears in the graph pool
   but NOT in dense's top-4.

2. **Different top-k after feedback**: after 5 positive feedbacks on d2 (a graph-expanded doc),
   graph promotes d2 to #2 position (`score 0.318`). A fresh DenseMemory (no feedback) keeps d2
   out of its top-4 entirely. Proved by `tests/graph-memory.test.mjs:feedback-divergence`.

3. **Structural difference**: Dense is pure cosine kNN. Graph uses kHopNeighbors for multi-hop
   expansion THEN re-ranks by cosine + reward bias. The mechanism differs regardless of outcome.

4. **Hash embedder caveat**: with the cheap hash-based embedder (`embedder.mjs`), the H3 effect
   only manifests after feedback accumulation (same embedder → same cosine ranking). With an ONNX
   semantic embedder (384-dim), semantically related but lexically distant docs ("chlorophyll" for
   "plants sunlight") would rank higher naturally, and graph expansion would differentiate top-k
   from round 1.

5. **Conclusion**: H3 pilot is measurable with the current scaffold. A $0 mock run shows
   divergent top-k after feedback. A paid pilot with `--embed onnx` will show natural divergence
   without requiring prior feedback.

**H4 "GNN self-learning"** still implemented as reward-rerank (no GNN node available — needs
`napi build` on `crates/ruvector-gnn-node`). This is unchanged from 0.2.32.

---

## Files

| File | Role |
|---|---|
| `memory-layer.mjs` | The seam. `DenseMemory` (in-proc cosine, $0, dep-free) + `RuvectorMemory` (local RvfDatabase HNSW, no rvfDegraded) + `GraphRagMemory` (real kHop graph expansion, H3 unblocked). `makeMemory(kind, opts)`. |
| `embedder.mjs` | Keyless deterministic hashed-bigram embedder + cosine + token estimate. Shared by all arms so A/B/C isolates the *index*, not the embedding model. |
| `telemetry.mjs` | Pure ADR-201 math: Retrieval Lift Δ, Compression Cr, Turn-Budget Survival S_T, Cost-Adjusted Lift L_C, Context-Degradation knee, Wilson CI. No I/O → unit-tested. |
| `ruvector-eval.mjs` | A/B/C runner. Control A (dense, hard bail) / Test B (ruvector, static bail) / Test C (ruvector, dynamic bail @ τ). Emits all telemetry; per-task preds exfil. |
| `warmup-epoch.mjs` | H4 protocol: Epoch0 → solve-outcome feedback → RVF COW branch → Epoch1 → Wilson-CI verdict. Per-instance isolation + persistent reward map. |
| `exfil.mjs` | Per-task pred exfil mirroring the FRAMES/cve-bench Firestore REST pattern. **Default = local JSONL ($0/no-GCP)**; `--exfil` also POSTs to Firestore via `gcloud` token. |
| `synthetic.mjs` | $0 offline fixtures: deterministic RAG-QA manifest + mock LLM + answer normalizer. |
| `tests/` | `telemetry.test.mjs` (10) + `dense-memory.test.mjs` (9) + `graph-memory.test.mjs` (17). First two are dep-free; graph tests require local ruvector repo at default path. |

## Conformance firewall

`feedback()` consumes **solve outcomes** (`resolved: boolean` from the harness's own
test signal) — there is **no gold parameter**. Synthetic gold answers live in the
**corpus** (what RAG is allowed to read); the separate `task.answer` is used only by the
offline scorer, never placed in a prompt or in feedback.

---

## Run

### $0 self-validation (no network, no GCP) — what proves the plumbing

```bash
# dep-free: dense baseline + telemetry math (9+10=19 tests)
node --test tests/telemetry.test.mjs tests/dense-memory.test.mjs

# requires local ruvector repo: graph + rvf (17 tests, all pass)
node --test tests/graph-memory.test.mjs

# all 36 tests at once
node --test tests/telemetry.test.mjs tests/dense-memory.test.mjs tests/graph-memory.test.mjs

# mocked A/B/C dry-run (dense + ruvector local-rvf + graph arms)
node ruvector-eval.mjs --arm all --synthetic 12 --mock --k 5 --concurrency 2 \
  --out /tmp/preds.jsonl --report /tmp/report.json

# mocked H4 warm-up epoch (Epoch0→feedback→COW branch→Epoch1→verdict)
node warmup-epoch.mjs --synthetic 20 --mock --kind ruvector --k 2 --report /tmp/wu.json
```

Local paths used by default (no env vars needed if local ruvector repo is at default location):
- `GRAPH_NODE_PATH` — override path to graph-node package (default: `/home/ruvultra/projects/ruvector/npm/packages/graph-node`)
- `RVF_NODE_PATH` — override path to rvf-node package (default: `/home/ruvultra/projects/ruvector/npm/packages/rvf-node`)
- `RUVECTOR_PATH` — override path to npm ruvector (used only if local rvf-node is unavailable)
- `RVF_DIR` — override RVF store directory (default: `/tmp`; set if `/tmp` rejects `fsync`)

Arm A (dense) needs NO external deps. Arms B+C require local ruvector repo at default paths.

### Paid, BUDGET-GATED A/B/C × 2-epoch run (NOT run in Phase 0)

```bash
OPENROUTER_API_KEY=$KEY node ruvector-eval.mjs --arm all \
  --manifest <frames-or-swebench-manifest>.json \
  --model deepseek/deepseek-v4-pro --escalate anthropic/claude-opus-4.8 \
  --k 8 --max-context-tokens 12000 --concurrency 4 --tau 0.35 \
  --max-cost 5 --meter --abort-usage 2620 \
  --out preds.jsonl --report report.json --exfil
```

Manifest shape: `{ "tasks": [{ "id", "question"|"problem", "answer", "corpus": [{"id","text"}] }] }`.

## Budget gate

Phase 1 is **expensive and gated on a new budget allocation** — it does **not** run from
this scaffold automatically. Two layers:

- `--max-cost <USD>` — soft per-process tally (secondary guard only).
- `--meter --abort-usage <USD>` — **authoritative** gate: polls OpenRouter
  `auth/key.usage` (absolute account spend) *before each cell* and stops launching new
  cells once spend exceeds the ceiling (skip + LOG). Mirrors
  `cve-bench/gcp-cascade-dispatch.mjs` §56 — Opus undercounts ~1.7× on OpenRouter, so the
  account meter is the real fence, not the in-process tally. Fail-open (a meter read
  failure falls back to the soft cap). Off by default → no network in $0/mock runs.

Do not launch a paid run without an explicit budget allocation **from the user**.

### Planned H1 pilot config (awaiting user authorization — NOT yet run)

> A coordinator relayed a request to run this with a +$25 cap. That relay carries no user
> authority; this scaffold documents the config so the run is one authorized command away.
> No pilot numbers exist until the user authorizes the spend.

- **FRAMES n=40, seed 42.** 3 conditions each: base no-RAG / +dense RAG (`--arm A`) /
  +ruvector (`--arm B`; ruvector adds no lift over dense at 0.2.32 — see RVF fallback note).
- **Cheap:** `deepseek/deepseek-v4-pro`.
  **Current frontier (comparators):** `openai/gpt-5.5` and `anthropic/claude-opus-4.8`.
- **Free bonus:** the **base no-RAG** cells (deepseek-v4-pro vs gpt-5.5 vs opus-4.8) are
  the **cheap-vs-CURRENT-frontier** FRAMES reference — report that gap explicitly (the live
  lag vs *today's* frontier, complementing the parity-vs-months-ago-frontier result). Add a
  one-line "cheap vs current-frontier (base, no-RAG)" callout.
- **Budget:** +$25 hard cap → `--meter --abort-usage 2620` (abort cell if absolute usage
  > $2620; skip + LOG). If 3 models × 3 conditions × 40 risks the cap, **trim priority**:
  (1) keep all base cells (cheap-vs-current-frontier headline), (2) deepseek dense+ruvector
  (the H1 Δ), (3) frontier dense+ruvector last. `opus-4.8` may hit the step-cap on multi-hop
  — give it the same fair budget and note any cap.

### Estimated cost

- Per-cell (one model × one task, RAG-augmented, ~8 ctx passages): ≈ **$0.15**
  agentic-equivalent (matches the SWE-bench cascade `~$0.15/instance`). FRAMES QA cells are
  cheaper (~$0.01–0.05); frontier-priced cells (gpt-5.5 ~$5/$30, opus-4.8 ~$5/$25 per Mtok
  as relayed — unverified) cost more per cell.
- **FRAMES H1 pilot** (n=40 × 3 models × 3 conditions ≈ 360 cells, frontier-weighted) →
  order **≈ $15–25** — why the +$25 / `--abort-usage 2620` gate + trim priority exist.
- **Full hard-code A/B/C × 2-epoch** (SWE-Lite 150 + Pro 50 × 3 arms × 2 epochs ≈ 1,200
  instance-runs × ~$0.15) → **≈ $180** — needs its own allocation.
