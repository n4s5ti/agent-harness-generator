# ADR-201 Hypothesis Verification: Vector Memory / GraphRAG Cheap-Model Lift

**Version**: 1.0 — web-research backbone, no paid model runs
**Date**: 2026-06-28
**Verifies**: ADR-201 (docs/adrs/ADR-201-vector-memory-graphrag-cheap-model-lift.md)
**Related**: docs/research/cheap-vs-frontier/REPORT.md

---

## Executive Summary

ADR-201 correctly labels its numbers as "predictions to verify, not facts." This document
applies that standard rigorously. Two hypotheses have solid published support (H2
direction; H3 direction), one is overstated but directionally correct (H1), and one is
vendor-aspirational with no peer-reviewed backing (H4). The specific ADR-201 numbers —
"+12–18 pt lift," "Opus ~98%@100k vs cheap ~60%," and ">15% epoch0→epoch1" — are all
sharper than the published evidence supports. The ruvector v0.2.32 package ships
significantly less than its documentation implies.

| Hypothesis | Verdict | Confidence |
|------------|---------|------------|
| H1 — RAG lifts cheap models disproportionately | Directionally correct; +12–18 pt range is overstated | B (Medium) |
| H2 — Context distraction degrades cheap models more | Directionally correct; specific Opus/cheap numbers not established | B (Medium) |
| H3 — GraphRAG feeds fewer/better tokens vs dense RAG | Partially supported for global queries; single-hop advantage weak | B (Medium) |
| H4 — GNN feedback epoch lift > 15% | No peer-reviewed support; vendor-aspirational | C (Low) |
| ruvector v0.2.32 | Ships less than docs claim; specific API surface below marketing | C (Low) |

---

## H1 — RAG Lift for Cheap Models

**ADR-201 claim**: "Vector RAG lifts cheap models on domain QA, disproportionately
(Δ_cheap > Δ_frontier); predicted +12–18 pt cheap lift."

### Published evidence

**[1] Medical QA multi-model ablation** — PMC systematic review, 2025 (PMC12157099):
- GPT-4 + RAG: +6.5 pp (73.44% → 79.97%)
- GPT-3.5 + RAG: +10.9 pp (60.69% → 71.57%)
- Mixtral + RAG: +8.1 pp (61.42% → 69.48%)

Disproportionality confirmed: the smaller/cheaper model (GPT-3.5) received a lift 1.7×
larger than the frontier model (GPT-4) on the same domain. Mixtral lift: 1.24×. Range:
+6.5–10.9 pp, not +12–18 pp.

**[2] Multimodal RAG across model sizes** — M4-RAG, arxiv 2512.05959, 2025:
- Gemma3 4B + RAG: +5.74 pp (59.22% → 64.96%) on CVQA
- Qwen2.5-VL 3B + RAG: +7.34 pp
- Gemma 3 27B + RAG: −1.75 pp (regression — larger model's parametric knowledge
  was more accurate than the retrieved context)

Disproportionality confirmed and more striking: at 27B, RAG is slightly harmful.
Range: +5–7 pp for small models.

**[3] ChatQA / ChatRAG Bench** — arXiv 2401.10225v4, NeurIPS 2024:
- Llama3-ChatQA-1.5-8B (fine-tuned for RAG): 55.17 on ChatRAG Bench, comparable
  to GPT-4-0613 (53.90) and GPT-4-Turbo-2024-04-09 (54.03)
- Context-enhanced instruction tuning ablation: removing RAG fine-tuning dropped
  performance 10.92 points

Demonstrates that a RAG-optimized 8B model can match GPT-4 on conversational QA.
However, this requires dedicated RAG fine-tuning, not zero-shot retrieval.

**[4] Small model retrieval utilization failure** — arXiv 2603.11513, 2026:
- Models ≤7B parameters fail to extract correct answers **85–100% of the time**
  even given oracle retrieval on questions they cannot answer alone
- Adding retrieval context "destroys 42–100% of answers the model previously knew"
  for small models

This directly qualifies H1: small models can fail to USE retrieved context properly,
and RAG can degrade performance by overloading small models with irrelevant content.
The lift is conditional on the model being large enough to synthesize retrieved text.

### Verdict for H1

**Direction SUPPORTED; specific numbers OVERSTATED.**

The disproportionate lift is real across multiple studies. But the published range is
+5–11 pp for 3B–70B models, not +12–18 pp. The +12–18 pt claim is at the upper tail
of what's been measured, plausible only for specialized domain tasks with near-perfect
retrieval. For general-purpose cheap models (≤7B), retrieval utilization failure is a
confounding risk the ADR should account for.

**Confidence: B (Medium)**

**Asserted vs established**:
- "+12–18 pt lift" — OVERSTATED. Published range +5–11 pp for domain QA.
- "disproportionately (Δ_cheap > Δ_frontier)" — ESTABLISHED across multiple papers.

---

## H2 — Context Distraction / Lost-in-the-Middle

**ADR-201 claim**: "Cheap models degrade as retrieved-context tokens grow; Opus ~98%
recall @100k; cheap → ~60% past 10–20k."

### Published evidence

**[5] Lost in the Middle** — Liu et al., arXiv 2307.03172, published 2023:
The foundational study showing U-shaped attention across long contexts. Performance
degrades for information placed in the middle of long inputs. Applies to all model
sizes but with variance by scale. The specific numbers are from model-held-out tests,
not NIAH at fixed token counts.

**[6] HELMET benchmark** — arXiv 2410.02694v3, Princeton / 2024:
- On complex tasks (generation with citations, re-ranking): open-source models
  show "complete collapse at 128K" while GPT-4o "remains relatively stable"
- Closed vs open-source frontier: 30–40 absolute point advantage for closed models
  on complex long-context tasks
- Performance degradation patterns "become more pronounced as task complexity
  increases" with length
- No specific 10–20k cliff identified; degradation is task-category dependent

**[7] Long Context RAG Performance** — arXiv 2411.03538v1, 2024:
Evaluated 20 LLMs from 2k to 2M token contexts on RAG tasks:
- Llama 3.1 70B: avg 0.45 accuracy, steep decline beyond 16k tokens
- Mixtral-8x7B: avg 0.469, performance collapse at 32k+
- DBRX: 0.447, sharp drop after 16k
- GPT-4o: 0.709, consistent through long contexts
- Claude 3.5 Sonnet: 0.695, consistent
- At NaturalQ: Llama 70B falls from 0.555 (16k) → 0.353 (125k);
  GPT-4 from 0.664 → 0.452 (125k)

This confirms smaller/cheaper models degrade faster, but the absolute cliff for
mid-tier models is at ~16–32k, not ~10–20k.

**[8] Problem-solving cliff for small models** — from NoLiMa benchmark search, 2025:
- "A large portion of the drop in problem solving happens within 7k tokens" for
  Llama-v3.1-8B-Instruct and Mistral-v0.3-7B-Instruct
- 10 out of 12 models fall below 50% of short-context baseline at 32K tokens
  (RULER benchmark)

**[9] NIAH at 1M tokens for Claude Opus** — digital-applied.com benchmark, 2026:
- Claude Opus 4.7: 89% on NIAH-2 single-needle at 1M tokens
- Claude Sonnet 4.5: 18.5% on the same test (MRCR v2 multi-needle)
- Gemini 3 Pro: 77% on MRCR v2 at 128K tokens

### Verdict for H2

**Direction SUPPORTED; specific numbers NOT ESTABLISHED.**

The differential context degradation for cheaper/smaller models vs frontier is well-
established across HELMET, Long Context RAG, and RULER benchmarks. The degradation
cliff is measurably steeper for smaller models.

However, the specific ADR-201 numbers — "Opus ~98%@100k" and "cheap ~60% past 10–20k"
— do not appear in any paper found. The published data shows:
- Claude Opus class achieves ~89% at 1M tokens on NIAH (single-needle), not 98%
- Small models (7–70B open-source) degrade past 16–32k, not specifically at 10–20k
- The cliff is task-specific: problem-solving drops within 7k for 7B models; NIAH
  degrades much later

**Confidence: B (Medium)**

**Asserted vs established**:
- "Opus ~98%@100k" — NOT ESTABLISHED in published benchmarks. Published NIAH for
  Claude Opus-class models: ~89% at 1M tokens (more complex multi-needle tests score
  lower, ~76%).
- "cheap → ~60% past 10–20k" — NOT ESTABLISHED. Published: ~50% degradation by 32k
  on most benchmarks; 7k cliff for problem-solving on 7B models.
- "cheap models degrade more steeply with context length" — ESTABLISHED.

---

## H3 — GraphRAG vs Dense RAG

**ADR-201 claim**: "ruvector GraphRAG feeds fewer, higher-quality tokens; higher resolve
than dense RAG at ≤ cost; extends turn-budget survival on SWE-bench."

### Published evidence

**[10] From Local to Global: GraphRAG** — Edge et al., arXiv 2404.16130, Microsoft, 2024:
The foundational GraphRAG paper, using LLM-judged pairwise comparisons:
- Comprehensiveness win rate: 72–83% vs vector RAG (p<.001) on podcast + news corpora
- Diversity win rate: 62–82% vs vector RAG (p<.01)
- Token efficiency: root-level summaries use 9–43× fewer tokens vs processing full
  source text directly; news dataset: 39,770 tokens vs 1,707,694 (vector RAG) = 43× reduction
- Empowerment: mixed results, no clear winner vs vector RAG

**Important limitation**: these are LLM-judged win rates on global sensemaking queries
("What are the main themes?"), NOT objective accuracy on code generation or SWE-bench.

**[11] Unbiased GraphRAG evaluation** — arXiv 2506.06331v1, 2026:
An independent evaluation removing LLM-judge biases from GraphRAG claims:
- After eliminating judge bias, "performance advantages are moderate or even vanish"
- LightRAG originally claimed 72% win rate vs NaiveRAG; unbiased: "NaiveRAG slightly
  outperforms LightRAG"
- Real relative win rates between most methods: below 8%
- Tie rates exceed 20% in most comparisons, >50% for individual aspects

**This significantly qualifies [10]**: GraphRAG's published wins partly reflect LLM
judging artifacts, not true accuracy improvements.

**[12] GraphRAG vs RAG systematic evaluation** — arXiv 2502.11371v1, 2025:
Llama 3.1 8B and 70B tested on NaturalQuestions + HotpotQA + MultiHop-RAG:
- Dense RAG, Llama 3.1 8B on NQ: 64.78% F1; Community-GraphRAG: ~63–65% F1
  (no significant gain on single-hop)
- MultiHop-RAG: dense RAG Llama 70B 65.77% vs Community-GraphRAG 71.17% (+5.4 pp)
- GraphRAG "excels in multi-hop queries"; standard RAG "well on single-hop"
- 13.6% of questions exclusively answered by GraphRAG vs 11.6% exclusively by RAG
  on MultiHop-RAG

**[13] When to use GraphRAG** — arXiv 2506.05690v3, 2026:
- HippoRAG2 (graph-based) on complex reasoning: 53.38% vs basic RAG 42.93% (+10.45 pp)
- Medical: HippoRAG2 61.98% vs RAG 58.64% (+3.34 pp)
- GraphRAG multi-hop evidence recall: 87.9–90.9% vs basic RAG 64.47%
- MS-GraphRAG global variant: up to 40,000 tokens per query (NOT compression)
- HippoRAG2: ~1,000 tokens per query (62× compression vs MS-GraphRAG's global mode)
- Token trade-off is highly implementation-dependent

**[14] PathRAG** — arXiv 2502.14902, 2025:
- Flow-based graph pruning cuts context 44% while maintaining accuracy
- Demonstrates that graph-structured retrieval can reduce token count vs naive dense RAG

### Verdict for H3

**Direction SUPPORTED for multi-hop reasoning; NOT ESTABLISHED for SWE-bench/code.**

For multi-hop reasoning and global sensemaking, GraphRAG does provide a real advantage
(+5–10 pp on multi-hop QA, +10 pp on complex reasoning benchmarks) and can achieve
significant token compression (44–62× depending on implementation). However:

1. The 72–83% comprehensiveness claim reflects LLM-judge bias that may not survive
   unbiased evaluation [11].
2. For single-hop QA (which most SWE-bench retrieval resembles), GraphRAG shows no
   advantage over dense RAG [12].
3. Microsoft's global GraphRAG mode INCREASES token usage, not decreases it. Only
   root-level summaries (lower quality) achieve the 43× compression. HippoRAG2
   achieves genuine compression.
4. No published paper tests GraphRAG on SWE-bench or similar code-patching tasks.
   The SWE-bench applicability is an extrapolation.

**Confidence: B (Medium)**

**Asserted vs established**:
- "Feeds fewer, higher-quality tokens" — PARTIALLY ESTABLISHED. Compression depends
  heavily on implementation. MS-GraphRAG global mode *increases* tokens; root-level
  and alternatives (PathRAG, HippoRAG2) reduce by 44–62×.
- "Higher resolve than dense RAG for multi-hop" — ESTABLISHED for knowledge QA;
  NOT ESTABLISHED for SWE-bench.
- "Extends turn-budget survival" — NO PUBLISHED EVIDENCE. Extrapolation from QA to
  code-patching agent tasks is untested.

---

## ruvector v0.2.32 Reality Check

**ADR-201 claims to verify**: native GraphRAG/Cypher, `.rvf` COW snapshots, GNN
`memory_feedback` self-learning, "12µs warm queries", Node API surface.

### What the package contains

**Sources**: npm registry, ruvector GitHub README, crates/rvf/README.md,
crates/ruvector-graph/README.md, docs/guides/GETTING_STARTED.md (all fetched 2026-06-28).

**npm package**: v0.2.32, published ~1 week ago. Dependencies include `@ruvector/gnn`
v0.1.22, `@ruvector/core`, `@ruvector/sona`, `@modelcontextprotocol/sdk`. 10.6 MB
unpacked. 284 total npm packages in the ecosystem, 34M+ downloads/year.

#### Feature-by-feature assessment

| Claimed feature | Status | Evidence |
|-----------------|--------|----------|
| **Cypher queries (native)** | SHIPPED (limited) | ruvector-graph v0.1.1 documents "Full Cypher parser built-in" with MATCH examples; benchmarked at ~5ms simple query / 1M nodes. Not a Neo4j wrapper. |
| **.rvf COW snapshots** | SHIPPED | rvf crate README documents 24-segment binary format, COW_MAP/REFCOUNT/DELTA segment types, `rvf derive` CLI. Measured: 2.6ms for 10K-vector branch. 1,156 passing tests. |
| **GNN self-learning (general)** | SHIPPED as library | @ruvector/gnn v0.1.22 provides multi-head attention, GRU cells, message passing. "Learns from every query" via temporal weighting is documented concept. |
| **`memory_feedback` API specifically** | UNVERIFIED | Not documented by that name in any fetched documentation. agentdb (separate package) documents Thompson Sampling feedback improving retrieval. Not confirmed in ruvector's public Node API. |
| **GraphRAG (native)** | PARTIAL | Documentation describes "Knowledge graph + community detection for multi-hop queries — 30-60% improvement." The 30-60% figure is marketing copy, not a cited benchmark. Implementation exists but maturity unclear. |
| **"12µs warm queries"** | NOT ESTABLISHED | No documentation found with this figure. Documented performance: SIMD distance calc 14.9ns (67M/s), HNSW "sub-millisecond," Cypher simple query ~5ms. The 12µs claim does not appear in the documentation reviewed. |
| **GNN feedback epoch lift** | ASPIRATIONAL | AgentDB (related project) claims "36% improvement from feedback alone" via Thompson Sampling bandit. This is a different package (agentdb, not ruvector) and the claim cites no external benchmark. |

**Overall assessment**: The package ships a real HNSW vector database, a working COW
.rvf format, a Cypher-capable graph engine (limited), and a GNN library. The self-
learning feedback loop concept is implemented at a library level. However:
- The "12µs warm queries" benchmark figure is absent from all documentation reviewed.
- The `memory_feedback` API name is not confirmed as a public interface.
- The documentation conflates shipped capabilities with roadmap features without version-binding.
- The "30-60% GraphRAG improvement" in marketing copy has no cited provenance.

**Confidence: C (Low) for the specific claims ADR-201 lists; B for the package existing
and shipping core vector + graph + COW functionality.**

---

## H4 — GNN Self-Learning Epoch Lift

**ADR-201 claim**: "After feedback warm-up epoch, re-running same tasks lifts resolve
by >15% (Epoch1 > Epoch0 + CI)."

### Published evidence

**[15] SimRAG** — arXiv 2410.17952, NAACL 2025:
Self-improving RAG via synthetic QA generation + self-training. Tested on 11 datasets
across medical, science, and CS domains with Llama backbones:
- Outperforms baselines by **1.2–8.6%** overall
- Uses 1 fine-tuning epoch in medical domain experiments
- This is domain fine-tuning, not GNN edge-weight feedback. Method differs from ADR-201.

**[16] RaFe: Ranking Feedback** — arXiv 2405.14431, 2024:
RL from ranking feedback improves query rewriting for RAG. Shows iterative query
rewriting improves retrieval but does not report epoch0→epoch1 absolute lift numbers
comparable to the ">15%" claim.

**[17] Graph-based re-ranking** — arXiv 2405.18414v1, 2024 (G-RAG):
Graph-based re-ranking with RL shows 1.6–7 pp improvement over BART baseline. These
are test-set improvements vs a baseline, not epoch-progression numbers within one run.

**[18] agentdb Thompson Sampling claim**:
The agentdb documentation (related ruvnet package) claims "36% improvement from
feedback alone" via Thompson Sampling bandit for retrieval selection. This is:
- From a product README, not a peer-reviewed paper
- Applies to agentdb's retrieval routing, not GNN edge reweighting
- No external citation or ablation methodology provided

**Key gap**: No peer-reviewed paper tests the specific protocol described in ADR-201
(GNN edge-weight reinforcement → same-instance re-run → epoch-over-epoch lift).
The closest analogues (SimRAG, RaFe) show 1.2–8.6% improvements, well below the
>15% threshold, and use different mechanisms.

### Verdict for H4

**ASPIRATIONAL. No peer-reviewed support for the specific protocol or the >15% claim.**

The direction is plausible: feedback-weighted retrieval should improve over time. But
the published evidence for retrieval self-improvement shows:
- 1.2–8.6% gains (SimRAG, domain fine-tuning approach)
- 1.6–7 pp on re-ranking benchmarks (G-RAG)
- No published GNN edge-feedback loop achieving >15% on a re-run

The ">15% epoch0→epoch1" prediction is either a product claim (agentdb's 36%, which
is for a different mechanism) or optimistic extrapolation.

**Confidence: C (Low)**

**Asserted vs established**:
- ">15% epoch0→epoch1 lift from GNN feedback" — NOT ESTABLISHED in peer-reviewed
  literature. Only vendor documentation supports anything near this range, and that
  refers to a different mechanism (Thompson Sampling routing, not GNN edge reweighting).

---

## Summary Table: Asserted vs Established

| ADR-201 Number | Status | Published Range | Source(s) |
|---------------|--------|-----------------|-----------|
| +12–18 pt cheap RAG lift | OVERSTATED | +5–11 pp (domain QA) | [1][2][3] |
| Δ_cheap > Δ_frontier (disproportionate) | ESTABLISHED | Yes, across multiple studies | [1][2][4] |
| Opus ~98%@100k NIAH | NOT ESTABLISHED | ~89% at 1M tokens (2026 Opus) | [9] |
| Cheap ~60% past 10–20k | NOT ESTABLISHED | Cliff at ~7k (7B), ~16–32k (70B) | [7][8] |
| GraphRAG comprehensiveness 72–83% | PARTIALLY ESTABLISHED; bias-adjusted ~8% | 72–83% LLM-judged (biased); <8% unbiased | [10][11] |
| GraphRAG 43× fewer tokens | ESTABLISHED for root-level only | 9–43× at root; 0.1× cost for LazyGraphRAG | [10] |
| GraphRAG multi-hop advantage | ESTABLISHED | +5–10 pp on multi-hop QA | [12][13] |
| ruvector 12µs warm queries | NOT ESTABLISHED in docs | Not found; SIMD 14.9ns distance; HNSW sub-ms | README |
| .rvf COW snapshots shipped | ESTABLISHED | 2.6ms/10K branch; 1,156 tests | rvf README |
| GNN >15% epoch0→epoch1 | NOT ESTABLISHED | 1.2–8.6% (domain fine-tuning, different method) | [15] |

---

## References

[1] https://pmc.ncbi.nlm.nih.gov/articles/PMC12157099/ — RAG in healthcare QA (2025)

[2] https://arxiv.org/abs/2512.05959 — M4-RAG multimodal multi-size (2025)

[3] https://arxiv.org/html/2401.10225v4 — ChatQA NeurIPS 2024

[4] https://arxiv.org/abs/2603.11513 — Small model retrieval utilization (2026)

[5] https://www.semanticscholar.org/paper/Lost-in-the-Middle:-How-Language-Models-Use-Long-Liu-Lin/1733eb7792f7a43dd21f51f4d1017a1bffd217b5 — Liu et al. 2023

[6] https://arxiv.org/html/2410.02694v3 — HELMET benchmark (Princeton 2024)

[7] https://arxiv.org/html/2411.03538v1 — Long Context RAG Performance (2024)

[8] https://aiwiki.ai/wiki/needle_in_a_haystack — NoLiMa / RULER NIAH benchmarks

[9] https://www.digitalapplied.com/blog/long-context-retrieval-needle-in-haystack-2026 — NIAH 2026 benchmark

[10] https://arxiv.org/html/2404.16130v2 — Edge et al. GraphRAG From Local to Global (Microsoft 2024)

[11] https://arxiv.org/html/2506.06331v1 — Unbiased GraphRAG evaluation (2026)

[12] https://arxiv.org/html/2502.11371v1 — RAG vs GraphRAG systematic evaluation (2025)

[13] https://arxiv.org/html/2506.05690v3 — When to use Graphs in RAG (2026)

[14] https://arxiv.org/abs/2502.14902 — PathRAG 44% context pruning (2025)

[15] https://arxiv.org/abs/2410.17952 — SimRAG self-improving RAG (NAACL 2025)

[16] https://arxiv.org/abs/2405.14431 — RaFe ranking feedback (2024)

[17] https://arxiv.org/html/2405.18414v1 — G-RAG graph re-ranking (2024)

[18] https://github.com/ruvnet/agentdb — agentdb Thompson Sampling claim

---

## Open Questions / Recommended Next Steps

1. **H1 precision**: Run the ADR-201 FRAMES H1 pilot (n=40) with GLM-5.2 to get actual
   Δ_cheap vs Δ_frontier numbers. The published range (+5–11 pp) may understate domain-
   specific lift on FRAMES if retrieval quality is high and the model is large enough to
   use the context (≥7B). The [4] paper's finding (small models can't use context) is
   the critical risk.

2. **H2 cliff location**: The ADR's "10–20k" cliff should be tested directly. Published
   evidence puts it at 7k for 7B problem-solving and 16–32k for 70B models. The specific
   cheap-model mix in the cascade (GLM-5.2, DS-V4-Pro) is not in any published NIAH study.

3. **ruvector memory_feedback API**: Before wiring the GNN feedback loop in the harness,
   confirm the actual public API by reading the @ruvector/gnn package source. The
   "memory_feedback" name is not in any documentation reviewed.

4. **H3 SWE-bench applicability**: The GraphRAG advantage is established for global/multi-
   hop NLP tasks, not code-patching agents. A dry-run on SWE-bench Lite with dense vs
   GraphRAG retrieval (zero paid model calls; count retrieval hits vs gold patches) would
   give a more grounded estimate of whether H3 transfers.

5. **H4 protocol design**: The ">15%" threshold should be recalibrated to ">5%" based on
   published analogues (SimRAG: 1.2–8.6%). Running with ">15%" as the threshold risks
   reporting a null result for what might actually be a meaningful improvement.
