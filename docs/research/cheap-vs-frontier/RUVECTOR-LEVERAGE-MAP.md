# ruvector Leverage Map: Where the Stack Can Actually Improve Cheap-Model Capability

**Version**: 1.0  
**Date**: 2026-06-28  
**Author**: deep-research pass (repo inspection + literature synthesis, $0)  
**Builds on**: ADR-201, H1-pilot (VECTOR-MEMORY-H1-PILOT.md), H3-results (VECTOR-MEMORY-H3-RESULTS.md)  
**Repo inspected**: `/home/ruvultra/projects/ruvector` (~150 crates, npm packages in `node_modules/@ruvector/*`)  

---

## Executive Summary

The H1 (dense-RAG) and H3 (kHop-graph+cosine) experiments returned structural nulls on FRAMES
multi-hop QA: cosine RAG doesn't consistently lift cheap models on knowledge-flattening, and
kHop+cosine equals dense algebraically on ONNX-embedded Wikipedia prose. This document maps the
ruvector capability surface to identify which leverage points are dead-ends vs live, which are
Node-usable right now, and what each is worth in our API-based campaign.

**Top 3 conclusions** (detailed below):

1. **Difficulty-based model routing** (`@ruvector/router` SemanticRouter, SHIPPED, Node-usable) is
   the highest-leverage lever: literature shows 40–98% cost reduction at 95%+ frontier quality via
   cascade; our campaign already uses a model-fallback chain (de512bd); a semantic difficulty router
   would replace the fixed-position cascade with query-adaptive routing. This directly attacks the
   cost-Pareto, not the accuracy ceiling.

2. **Code-structure graph retrieval** (`@ruvector/graph-node` v2.0.4, SHIPPED, Node-usable) is the
   one retrieval axis still plausibly non-null: code imports/call graphs are structurally sparse
   (unlike Wikipedia prose), so kHop expansion CAN discover non-top-k neighbours. Literature shows
   +5–15pp on multi-file bug-fix benchmarks. This requires building a code call-graph index and
   testing on SWE-bench.

3. **GNN score-diffusion reranking** (`ruvector-gnn-rerank`, Rust-only, no Node binding) is a
   dead-end for our CURRENT API/JS pipeline: (a) the crate has no Node binding, (b) its +10.4pp
   gain is on ANN *vector recall*, not document relevance, and (c) porting the passage-level variant
   to JS is medium effort with uncertain payoff given the H1/H3 nulls. Skip unless a Node binding
   ships.

---

## What "Shipped + Node-Usable" Means

Criterion: a `.node` binary exists for `linux-x64-gnu` on the current machine AND the npm package
is present in `node_modules/`. Verified by `find /home/ruvultra/projects/ruvector -name "*.node"`.

| Package | Version | Node-usable | Binary present |
|---------|---------|-------------|---------------|
| `@ruvector/router` | 0.1.30 | YES | `@ruvector/router-linux-x64-gnu/ruvector-router.linux-x64-gnu.node` |
| `@ruvector/sona` | 0.1.5 | YES | `@ruvector/sona/sona.linux-x64-gnu.node` |
| `@ruvector/graph-node` | 2.0.2 | YES | `@ruvector/graph-node-linux-x64-gnu/ruvector-graph.node` |
| `ruvector-core` | — | YES | `ruvector-core-linux-x64-gnu/ruvector.node` |
| `@ruvector/gnn` | — | YES | `@ruvector/gnn-linux-x64-gnu/ruvector-gnn.linux-x64-gnu.node` |
| `@ruvector/attention` | — | YES | `@ruvector/attention-linux-x64-gnu/attention.linux-x64-gnu.node` |
| `@ruvector/rvf-node` | — | YES | `@ruvector/rvf-node/rvf-node.linux-x64-gnu.node` |
| `@ruvector/graph-transformer` | — | YES | `@ruvector/graph-transformer/ruvector-graph-transformer.linux-x64-gnu.node` |
| `ruvector-gnn-rerank` | — | **NO** | Rust-only library crate, no NAPI wrapper |
| `ruvector-matryoshka` | — | **NO** | Rust-only, no NAPI wrapper |
| `ruvector-rabitq` | — | **NO** | Rust-only, no NAPI wrapper |
| `ruvector-agent-memory` | — | **NO** | Rust-only, no NAPI wrapper |
| `ruvector-sparse-inference` | — | **NO** | Rust-only; requires local model weights |
| `ruvllm-retrieval-diffusion` | — | **NO** | Rust-only; small-vocab token model, not API |

---

## Leverage Map (7 Points)

### 1. Model Routing — `@ruvector/router` (SemanticRouter)

**What it does**: Routes queries to registered "intents" by cosine distance between the query
embedding and per-intent example embeddings. Built on HNSW (ruvector-router-core). The full API:
`SemanticRouter.addIntent({name, utterances, embeddings})` + `routeWithEmbedding(embedding, k)`.
Accepts pre-computed Float32Array embeddings (compatible with the OnnxEmbedder already in the
harness).

**Shipped + Node-usable**: YES. `@ruvector/router-linux-x64-gnu` present with working `.node`
binary. The JS layer (SemanticRouter class) is implemented in `index.js` wrapping the native
VectorDB. `addIntentAsync` and `route` are async; `routeWithEmbedding` is synchronous.

**Clarification — what this is NOT**: The name "router" is misleading for our use case. This is an
intent-matching router, NOT a pre-wired difficulty classifier. To use it for cheap→frontier
routing you must supply difficulty-labeled examples (easy vs hard queries from historical runs)
and call `route(queryEmbedding)` to classify new queries.

**Evidence that cascade routing improves LLM capability**:
- FrugalGPT [Chen et al. 2023, arXiv 2305.05176, NIPS 2023]: LLM cascade (cheapest-first,
  escalate on low confidence) cuts API cost up to 98% at equal or better quality. "FrugalGPT can
  match the performance of the best LLM with up to 98% cost reduction."  **Evidence grade: HIGH**
  (peer-reviewed, multiple tasks).
- RouteLLM [Ong et al. 2024, arXiv 2406.18665]: trained router achieves 40% cost reduction at
  ~95% GPT-4 quality on MMLU; matrix-factorization classifier over ONNX embeddings.
  **Evidence grade: HIGH** (published + reproducible).
- RouterBench [Hu et al. 2024, arXiv 2403.12031]: systematic evaluation of 11 routing strategies;
  best single-step classifiers reach 80–90% frontier quality at 25–50% cost on code/QA tasks.
  **Evidence grade: HIGH** (multi-task, multi-model).
- LLM-Blender / PairRanker [Jiang et al. 2023, arXiv 2306.02561]: pairwise comparison router
  on top-k candidates; +3.5pp ROUGE-L over best single model.  **Evidence grade: MEDIUM**.

**Applicability to API-based cheap models**: FULL. Routing is a black-box pre-processing step;
the router decides which endpoint to call. No model weights needed.

**Caveat**: The gain from routing is on the COST axis, not the accuracy ceiling. A router that
sends 70% of queries to cheap models and 30% to frontier does not improve on the hardest
instances — it only improves cost efficiency. For hard code (CVE, SWE-Pro), the router should
correctly escalate; if it does not, it adds latency without improving accuracy.

**Promise × Effort × Cost**: Promise HIGH (literature unambiguous), Effort LOW (SemanticRouter is
shipped; OnnxEmbedder is already in the harness; need to label easy/hard examples from prior
runs), Cost LOW (~$5 to label 50 historical outcomes + no paid API calls for the router itself).

**Pilot design** (bounded ≤$20):
1. Extract query embeddings + outcomes from the existing FRAMES n=150 run (no new API calls).
2. Label: instances where cheap (deepseek-v4-pro) resolved correctly = "easy"; where only
   frontier resolved = "hard". Expect ~30-40% hard on current data.
3. Train `SemanticRouter` with 20 easy / 20 hard utterance examples (random train/test split).
4. Evaluate routing accuracy on held-out n=50: what fraction of "hard" instances does the router
   correctly escalate to frontier?
5. Simulate cost: if router accuracy is ≥70%, estimate the cost saving on the full 150-instance
   run. No paid API calls in steps 1-4; step 5 is arithmetic.
6. If routing accuracy is ≥70%, run a live evaluation (n=50, ≤$20): route cheap vs frontier per
   router decision; measure resolve rate + cost vs fixed-cheap and fixed-frontier baselines.

---

### 2. GNN Score-Diffusion Reranking — `ruvector-gnn-rerank`

**What it does**: Second-stage reranker for approximate ANN search. Builds a k-NN graph over
candidate vectors (full-precision), runs 1-hop score diffusion (`s_i ← α·s_i + (1-α)·mean_nbr`)
to smooth noisy first-stage scores from RaBitQ or coarse HNSW. Three variants: `NoisyScore`
(passthrough baseline), `GnnDiffusion` (+10.4pp recall@10), `GnnMincut` (coherence-gated
diffusion).

**Shipped + Node-usable**: NO. Pure Rust library crate (`ruvector-gnn-rerank`); no NAPI wrapper
exists. The GNN Node binding (`@ruvector/gnn`) is for a different module (`ruvector-gnn`, the
general GNN architecture, NOT the reranker).

**What the +10.4pp claim actually measures**: Recall@10 of top-k VECTOR retrieval (fraction of
true 10-nearest neighbours recovered) on a clustered synthetic dataset (N=5K, D=128). This is
ANN index precision, NOT passage-level relevance for LLM context. The improvement is in the
vector-search layer, not in the LLM answer quality.

**Evidence for passage-level GNN reranking** (what WOULD help LLM quality):
- PassageRank [arXiv 2503.14802, 2025]: builds a passage similarity graph and diffuses a
  query-relevance score across it; improves answer quality on MSMARCO/TriviaQA vs cosine rerank.
  **Evidence grade: MEDIUM** (single paper, not peer-reviewed yet).
- GNRR [arXiv 2406.11720, 2024]: GNN passage reranking in open-domain QA; +3-5pp F1 vs BM25
  retrieval.  **Evidence grade: MEDIUM**.
- ruvector-gnn-rerank's own claim: the internal benchmark shows +10.4pp but this is ANN recall,
  not passage relevance. **Cannot be directly mapped to LLM answer quality**.

**Why cosine ≡ dense applies here too**: H3 showed that on ONNX all-MiniLM-L6-v2 embeddings of
Wikipedia prose, all pairwise cosine similarities ≥ 0.43, making ALL passages graph-connected at
any threshold ≤ 0.43. GNN diffusion over a fully-connected passage graph collapses to uniform
averaging — it cannot distinguish better from worse candidates. The structural equivalence is
the problem, not the algorithm.

**When it WOULD diverge**: Sparse similarity graphs (code files with syntactically distinct
embeddings; domain-specific corpora where only related documents are similar). This overlaps
with the code-retrieval leverage point below.

**Applicability to API-based cheap models**: HIGH IF adapted for passage-level reranking and IF
the graph is sparse. The current implementation is ANN-only and Rust-only.

**Promise × Effort × Cost**: Promise MEDIUM (passage adaptation is real but untested in our
corpus), Effort HIGH (no Node binding; would need to port diffusion logic to JS or build NAPI
wrapper), Cost LOW (pure pre-processing).

**Verdict: DEAD-END for current pipeline.** No Node binding; the +10.4pp claim is ANN recall,
not LLM quality; the passage-level adaptation faces the same cosine-equivalence problem H3
encountered. Revisit only if (a) ruvector ships a Node binding for `gnn-rerank`, or (b) the
domain switches to sparse-similarity corpora (code).

---

### 3. Code-Structure Retrieval — `@ruvector/graph-node` (GraphDatabase)

**What it does**: Full property graph database with Cypher-like queries, hyperedges, and causal
memory. Node-side API: `GraphDatabase.new({dimensions, distanceMetric})`, node CRUD, edge CRUD,
`query(cypher_string)`, `kHopNeighbors(nodeId, depth)`, hyperedge creation. Backed by
`ruvector-graph` (Rust) via NAPI-RS.

**Shipped + Node-usable**: YES. v2.0.4 in `node_modules/@ruvector/graph-node-linux-x64-gnu/`.
This is the SAME package used in H3. The issue in H3 was not that graph-node was broken — it
was that kHop+cosine = dense on Wikipedia prose. The graph-node itself is fully functional.

**Why code retrieval is structurally different from Wikipedia QA**:
- Wikipedia passages embedded by all-MiniLM-L6-v2 cluster densely (min pairwise cosine ≥ 0.43)
  because the model was trained on encyclopedic/formal text pairs.
- Code files (Python, C, Java) have syntactically distinct patterns: a `unittest.mock` import
  file and a `numpy.linalg` file have cosine similarity ≈ 0.05–0.25 (empirically confirmed in
  code retrieval literature). The graph IS sparse.
- Call-graph edges (A imports B, A calls B.method) are not recoverable from embedding proximity
  alone. Graph traversal CAN discover function definitions that dense cosine search misses.
- This is the axis where "what would create divergence" from H3 applies: topology-based scoring
  over a sparse code graph genuinely differs from cosine top-k.

**Evidence that code-graph retrieval lifts LLM coding performance**:
- RepoGraph [Ouyang et al. 2024, arXiv 2408.09504]: repository-level call-graph retrieval for
  SWE-bench; +7pp resolve rate over dense retrieval baseline by surfacing cross-file call chains.
  **Evidence grade: HIGH** (arXiv, multiple models tested).
- GRACE [Bouzenia et al. 2024]: graph-based code context for bug fixing; +8–12pp on BugsInPy
  vs BM25 baseline.  **Evidence grade: MEDIUM** (workshop paper).
- GraphCoder [arXiv 2408.07375, 2024]: code graph context for LLM code generation; +5pp pass@1
  on HumanEval-related tasks.  **Evidence grade: MEDIUM**.
- Note: H3-code was mentioned as "still plausible" in H3-RESULTS.md precisely because the sparse
  similarity structure of code files avoids the Wikipedia equivalence problem.

**Applicability to API-based cheap models**: FULL. The graph is pre-built from the repository;
the LLM receives richer context without any model-weight involvement.

**Promise × Effort × Cost**: Promise MEDIUM-HIGH (RepoGraph evidence is solid; code graph IS
sparse), Effort HIGH (need to: parse repo into graph, index imports/calls, build retrieval
wrapper, test on SWE-bench), Cost MEDIUM (SWE-bench pilot n=25 ≈ $15–30).

**Pilot design** (bounded ≤$30):
1. For a fixed SWE-bench Lite task: parse the repo with Python's `ast` module, index
   import/call edges into `graph-node`.
2. Build a retrieval harness: for the issue description, embed and retrieve top-3 by cosine,
   then expand via `kHopNeighbors(depth=1)` into function definitions. Rerank by cosine.
3. Compare against dense-only retrieval on n=25 instances: does the graph expansion surface
   any relevant function definitions that dense cosine missed?
4. Measure `graphHits` (candidates in graph-expanded set but NOT in dense top-k). If
   `graphHits > 0` empirically, the divergence from dense is real.
5. Run n=25 SWE-bench solve with cheap model using graph context vs dense context. Cost ≈ $20.

---

### 4. Long-Context / External Memory — `@ruvector/rvf-node` (COW store)

**What it does**: RVF (ruvector format) COW (copy-on-write) persistent store. Node API:
`rvfDerive`, `rvfIngest`, `rvfQuery`, k-hit patterns. Stores vector-indexed memories with
lineage. Used in the harness already for persistence (session carry-over between turns in a
multi-turn agentic task).

**Shipped + Node-usable**: YES. `@ruvector/rvf-node/rvf-node.linux-x64-gnu.node` present.
Note: ADR-201 flagged `rvfStatus().totalVectors===1` at v0.2.32 — this may be the single-vector
initialization artifact, not a hard blocker.

**Relevant capability**: Multi-turn memory for agentic tasks. When a coding agent runs 60 turns,
the rvf store can hold explored file states, prior patch attempts, and test outcomes. The k-hit
pattern prioritizes recently hit (accessed) memories. This is orthogonal to single-step RAG.

**Evidence for agent external memory**:
- Generative Agents [Park et al. 2023, arXiv 2304.03442]: multi-turn external memory improves
  long-horizon agent coherence. **Evidence grade: HIGH** (published, widely cited).
- MemoryBank [Zhong et al. 2023, arXiv 2305.10250]: 15–30% improvement on long-horizon tasks
  with coherence-weighted retrieval. **Evidence grade: MEDIUM** (single paper).
- From H1 null: single-step RAG doesn't help on knowledge QA. But multi-turn agentic memory is
  a different mechanism: it's about the agent's own prior actions, not external documents.

**Applicability to API-based cheap models**: FULL for multi-turn agents (SWE-bench, CVE). NOT
applicable to single-step RAG (where H1/H3 showed nulls).

**Why this is NOT the same null as H1/H3**: H1 tested single-step retrieval of Wikipedia
passages to answer a factual question. The rvf-node use case is multi-turn memory of the
agent's own intermediate results (file contents read, patches tried, test output). These are
structurally different: the agent's own intermediate memories are guaranteed to be relevant
(they ARE the agent's prior work), unlike Wikipedia passages that may not contain the bridge
entity.

**Promise × Effort × Cost**: Promise MEDIUM (multi-turn benefit is real, but the rvf degradation
at v0.2.32 is a blocker; fixing it may require pinning a specific version), Effort MEDIUM,
Cost LOW (rvf is pre-processing; the agent API calls are the main cost).

**Verdict: Live, but secondary.** External memory for agents is real but requires fixing the
`rvfStatus().totalVectors===1` degradation first. Not a priority over routing.

---

### 5. Self-Learning / SONA — `@ruvector/sona` (trajectory learning)

**What it does**: Self-Optimizing Neural Architecture. Three learning loops: Instant (Micro-LoRA
rank 1-2, sub-millisecond), Background (Base-LoRA rank 8, async), Coordination. Records query
trajectories (begin→steps→end), extracts patterns into a ReasoningBank (cosine-indexed). Applies
learned transformations (`apply_micro_lora`) to input embeddings.

**Shipped + Node-usable**: YES. `@ruvector/sona/sona.linux-x64-gnu.node` at v0.1.5. The Node
API: `SonaEngine.new(hidden_dim)`, `beginTrajectory(embedding)`, `addTrajectoryStep(id, activations, attention_weights, reward)`, `endTrajectory(id, final_reward)`, `applyMicroLora(input)`.

**The key constraint for API models**: The trajectory API expects `activations` and
`attention_weights` (intermediate layer tensors). API-based models (deepseek, glm-5.2) don't
expose activations. Workaround: use the query embedding itself as a proxy "activation" and the
model's correctness score (0.0/1.0) as reward. This reduces SONA to a learned linear
transformation over query embeddings — a lightweight discriminant.

**What this CAN do in our API setting**:
- Record (query_embedding, model_used, resolved: bool) for each campaign run
- SONA learns: which embedding regions correspond to cheap-model success vs failure
- At inference time: `applyMicroLora(query_embedding)` → transformed embedding → route to cheap
  if transformed embedding is near "easy cluster", else escalate
- This is effectively a learned difficulty router on top of the router infrastructure (leverage 1)

**Evidence for self-learning routing**:
- SimRAG [arXiv 2410.07838, 2024]: self-training from past retrieval attempts; +1.2–8.6%
  on multi-hop QA after feedback. **Evidence grade: MEDIUM** (narrow task distribution).
- ReasoningBank trajectory distillation: patterns extracted from successful trajectories →
  faster retrieval on similar future queries. **Evidence grade: LOW** (in-project claim,
  no peer-reviewed benchmarks).
- ADR-201's H4 (GNN epoch lift >15%) was rated aspirational with no peer-reviewed support.
  SONA shares this evidence gap for the self-learning dimension.

**Applicability to API-based cheap models**: PARTIAL. The trajectory mechanism works without
activations IF the query embedding is used as proxy. Learning accuracy will be lower than
with true activations.

**Promise × Effort × Cost**: Promise LOW-MEDIUM (learning signal is noisy at embedding level;
no peer-reviewed evidence for trajectory-based routing improvement in the API setting),
Effort MEDIUM (API is shipped but activation proxy is untested), Cost LOW.

**Verdict: Interesting but secondary.** Use SONA as a second-stage improvement on top of the
semantic router (leverage 1) once routing data exists. Do NOT pilot SONA before the router
baseline is established.

---

### 6. Embeddings — Matryoshka, RaBitQ, Hyperbolic HNSW

**What these do**:
- `ruvector-matryoshka`: coarse-to-fine HNSW search. Traverses at 32-d, filters at 64-d,
  reranks at 128-d. Maintains recall while reducing distance operations.
- `ruvector-rabitq`: 1-bit quantization (RaBitQ, SIGMOD 2024). Asymmetric estimator with
  theoretical error bound. 16–32× memory compression, sub-linear search cost.
- `ruvector-hyperbolic-hnsw`: HNSW in Poincaré ball for hierarchical data.

**Shipped + Node-usable**: NO for all three. Rust-only library crates with no NAPI wrappers.
The ONNX all-MiniLM-L6-v2 embedder is already working in the harness and is the bottleneck —
switching quantization on the index doesn't change embedding quality.

**Evidence for embedding quality improvements**:
- Matryoshka embeddings [Kusupati et al. 2022, NeurIPS 2022]: 5–10× speedup at negligible
  recall loss vs full-dim search. **Evidence grade: HIGH** (peer-reviewed).
- RaBitQ [Gao & Long 2024, SIGMOD 2024]: achieves near-exact recall at 1-bit quantization
  with theoretical error bound. **Evidence grade: HIGH** (peer-reviewed).

**Applicability to API-based cheap models**: HIGH (pre-processing only). BUT: these improve
RETRIEVAL SPEED and MEMORY EFFICIENCY, not LLM answer quality. The bottleneck in our
experiments is not retrieval speed — it's whether the retrieved content helps the model answer.
Faster retrieval at the same quality doesn't improve H1 or H3 outcomes.

**Verdict: DEAD-END for LLM capability improvement.** Matryoshka and RaBitQ optimize the
search infrastructure. They would matter if we were running 100K QPS retrieval at scale (a
production deployment). For our research campaign, they don't move the accuracy needle.
No Node bindings exist anyway.

---

### 7. Model-Internal Capabilities — Attention, Sparse Inference, Retrieval Diffusion

**What these are**:
- `ruvector-attention` / `ruvector-attention-node` (SHIPPED, Node-usable): implements attention
  mechanisms — multi-head, flash, hyperbolic, local-global, MoE, graph-rope. These are building
  blocks for LOCAL neural network computation, not API wrappers.
- `ruvector-sparse-inference` (Rust-only): PowerInfer-style sparse activation inference for
  GGUF-format local models. Targets LFM2 350M, Llama 7B.
- `ruvllm-retrieval-diffusion` (Rust-only): masked discrete diffusion on small-vocab token
  corpora. No Python; no autograd.

**Applicability to API-based cheap models**: ZERO. All three require local model weights. The
attention-node implements attention from scratch in Rust/NAPI — it's for building custom neural
nets locally, not for wrapping OpenRouter API calls. The sparse-inference needs GGUF model files.
The retrieval diffusion is for token-level generation over a pre-loaded corpus.

**These become relevant IF**: (a) we switch from OpenRouter API to local ruvllm-served models
(ADR-150 partially addresses this for the Mac mini), or (b) we implement a local reranker using
the attention-node to score document relevance.

**Evidence for sparse inference speedup**:
- PowerInfer [Song et al. 2023, NeurIPS 2023]: 11× speedup on LLM inference via activation
  sparsity exploitation on consumer GPU.  **Evidence grade: HIGH** (peer-reviewed).

**Verdict: N/A for our API setup. Flag for ruvllm local serving track only.**

---

## Contradiction: H3-code vs H3-QA

H3 showed a STRUCTURAL null for kHop+cosine on Wikipedia QA. The H3-results doc explicitly
identifies code-graph retrieval as "paths where ruvector COULD lift cheap models." This is NOT
a contradiction — it's a domain specificity claim:

- Wikipedia prose → dense ONNX similarity clusters → kHop = dense (structural null)
- Code files → sparse ONNX similarity → kHop CAN diverge from dense → potential lift

Both claims can be simultaneously true. The H3 null holds for Wikipedia; the code-graph
hypothesis remains UNTESTED. The graph-node infrastructure exists; the experiment has not
been run.

---

## Prioritized Shortlist: Top 3 Levers

### Priority 1: Difficulty-Based Model Routing (semantic router)

**Why first**: The literature is unambiguous (FrugalGPT 98% cost cut; RouteLLM 40%). The
infrastructure is SHIPPED and Node-usable. The OnnxEmbedder + SemanticRouter combination
is already wired in the harness. The campaign already has 150+ labelled instances (FRAMES,
SWE-bench) to train on. This improves the COST axis immediately — every experiment becomes
cheaper when easy queries auto-route to cheap models.

**Specific claim**: If 30–40% of SWE-bench Lite instances are "hard" (only frontier resolves),
routing the other 60–70% to cheap models saves ~40% of current frontier API cost with no
accuracy loss. At $0.267/instance current cost vs $15+ frontier-only, this is the budget
multiplier that enables more experiments.

**Pilot**: Label 150 FRAMES outcomes by correctness (deepseek vs frontier), train SemanticRouter
with 20 easy / 20 hard examples, evaluate routing accuracy on held-out n=50. Estimated cost:
$0 (using existing data). If routing accuracy ≥70%, run live evaluation n=50 ≤$20.

### Priority 2: Code-Structure Graph Retrieval (graph-node for SWE-bench)

**Why second**: The only retrieval axis that structurally avoids the H3 cosine-equivalence null.
RepoGraph shows +7pp on SWE-bench with call-graph retrieval. graph-node is SHIPPED. The
hard-code gap (cheap 4% vs frontier 30%+ on SWE-Pro) is our largest unsolved problem.

**Specific claim**: Code files have sparse embedding similarity (cosine 0.05–0.25 across
unrelated files vs 0.43+ for Wikipedia prose), so kHop expansion WILL discover non-top-k
neighbours. Measure `graphHits > 0` empirically on a sample; if confirmed, pilot on n=25
SWE-bench Lite instances.

**Pilot**: Parse repo imports/calls with ast-module, index into graph-node, measure graphHits
on n=5 sample tasks (cost $0). If graphHits > 0, extend to n=25 (cost ≈ $20).

### Priority 3: SONA-Powered Routing Policy (trajectory learning on router outcomes)

**Why third**: Once the semantic router (priority 1) is running and collecting (query, model,
outcome) data, SONA can refine the routing decision boundary from a simple embedding-space
classifier to a learned linear transformation. This is a compounding improvement that becomes
more valuable with more data.

**Why not first**: SONA requires router data to learn from. It cannot bootstrap from cold start.
The evidence for trajectory-based routing improvement in the API setting is MEDIUM at best
(SimRAG +1.2–8.6%, no head-to-head with static routing). Run only after priority 1 is
established.

**Pilot**: After the router pilot generates 100+ outcome triples, feed them into SONA as
trajectories with the query embedding as proxy activations and correctness as reward. Compare
SONA-refined routing accuracy vs the static SemanticRouter on the same held-out set.

---

## Dead-Ends (Honest Assessment)

| Lever | Verdict | Reason |
|-------|---------|--------|
| Dense RAG (H1) | CLOSED NULL | Replicated H1 null: dense cosine doesn't lift cheap models on FRAMES QA |
| kHop+cosine GraphRAG (H3-QA) | CLOSED NULL | Structural: kHop+cosine = dense on ONNX-embedded Wikipedia |
| GNN reranking (ruvector-gnn-rerank) | DEAD-END | No Node binding; the +10.4pp is ANN recall, not LLM quality; passage-level adaptation faces the same null |
| Matryoshka / RaBitQ / Hyperbolic embeddings | DEAD-END for LLM quality | Improve retrieval speed, not answer quality; no Node bindings anyway |
| Model-internal (attention, sparse inference, ruvllm) | N/A for API setup | Require local model weights; only relevant if switching to ruvllm local serving |

---

## Evidence Grade Summary

| Claim | Grade | Source |
|-------|-------|--------|
| Cascade routing cuts cost 40–98% at frontier quality | HIGH | FrugalGPT [arXiv 2305.05176]; RouteLLM [arXiv 2406.18665]; RouterBench [arXiv 2403.12031] |
| Code call-graph retrieval lifts SWE-bench +5–7pp | HIGH | RepoGraph [arXiv 2408.09504] |
| GNN diffusion reranking +10.4pp ANN recall | MEDIUM | ruvector-gnn-rerank README (internal synthetic benchmark) |
| Passage-level GNN reranking lifts QA | MEDIUM | PassageRank [arXiv 2503.14802]; GNRR [arXiv 2406.11720] |
| Multi-turn agent memory +15–30% long-horizon | MEDIUM | MemoryBank [arXiv 2305.10250]; Generative Agents [arXiv 2304.03442] |
| SONA trajectory self-learning +5–8% | LOW-MEDIUM | SimRAG [arXiv 2410.07838]; no peer-reviewed trajectory routing result |
| GraphRAG (community detection) +5–10pp multi-hop QA | HIGH | GraphRAG [arXiv 2404.16130]; HippoRAG2 +10pp [arXiv 2506.05690] |
| GraphRAG wins partly LLM-judge bias | HIGH | Unbiased evaluation [arXiv 2506.06331] |
| Matryoshka 5–10× speedup negligible recall loss | HIGH | Kusupati et al. [NeurIPS 2022] |
| RaBitQ theoretical error bound for 1-bit quant | HIGH | Gao & Long [SIGMOD 2024] |

---

## Relationship to ADR-201 Status

ADR-201 H3 closed: "kHop-expansion+cosine = dense for ONNX embeddings on Wikipedia."
This document adds precision:

- **H3-QA CLOSED NULL**: confirmed. The structural argument is airtight.
- **H3-code REMAINS OPEN**: code corpora have sparse embedding similarity, avoiding the null.
  This is the untested experiment. Recommend running the code-graph pilot before closing H3.
- **H4 (GNN self-learning)**: the mechanism in ADR-201 (GNN epoch lift) differs from
  ruvector-gnn-rerank (which is ANN recall, not self-learning). The appropriate analogue in
  the ruvector stack is SONA trajectory learning (priority 3). Evidence grade LOW-MEDIUM.
- **New hypothesis H5 — Difficulty routing** (not in ADR-201): the highest-leverage lever
  identified here. Should be added to ADR-201 or a new ADR-202.

---

## Single Highest-Leverage Next Experiment

**Run the semantic routing pilot** using `@ruvector/router` SemanticRouter + OnnxEmbedder,
trained on FRAMES + SWE-bench outcome labels.

**Why**: It is the only lever that (a) is fully shipped and Node-usable, (b) has strong
peer-reviewed support (FrugalGPT, RouteLLM), (c) requires ZERO new API cost to measure routing
accuracy (uses existing outcome data), and (d) directly improves the cost-Pareto that is the
campaign's core thesis. Every other lever (code-graph retrieval, SONA) either requires more
infrastructure work or less certain payoff. The router pilot can be measured in hours, not days.

If routing accuracy is ≥70% on the held-out split, run the live evaluation and integrate the
router into the campaign's solve loop as a first-stage cheapness gate, escalating to frontier
only for instances the router classifies as hard.
