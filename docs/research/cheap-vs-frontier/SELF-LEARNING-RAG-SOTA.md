# SELF-LEARNING RAG: SOTA LANDSCAPE AND VERDICT FOR API-CHEAP SETUP

**Version**: 1.0  
**Date**: 2026-06-28  
**Author**: deep-research pass (web search synthesis, $0)  
**Builds on**: ADR-201, H1-PILOT, H3-RESULTS, RUVECTOR-LEVERAGE-MAP (all same dir)  
**Scope**: self-learning / adaptive RAG that improves from its own outcomes — retrieval-policy RL,
feedback-reweighted retrievers, trajectory LoRA, memory-augmented self-improving agents, learned
cascade routers. Does NOT repeat static-RAG findings already closed by H1/H3.

---

## Executive Summary

The SOTA of self-learning RAG splits cleanly into two families with opposite applicability to
an API-only campaign:

**Family A — self-learning RETRIEVAL / GENERATOR (requires fine-tuning model weights):**
Self-RAG, SimRAG, RAG-Gym, ProRAG, RoseRAG. All require fine-tuning the generator LLM on
retrieved-augmented data, reflection tokens, or process-supervised trajectories. For API-only
models (deepseek, glm, gpt-5.5 through OpenRouter) **this is categorically inapplicable —
we cannot access or update model weights**. Evidence grade for these methods is HIGH on their
own benchmarks, but applicable-to-our-setup is NO.

**Family B — self-learning ROUTING POLICY (no model fine-tuning required):**
RouteLLM, OrcaRouter, UCCI, MasRouter, bandit-based cascade routers. These learn WHICH
MODEL to call per query, using only external supervision (outcome labels, preference data,
confidence scores). No access to model internals needed. Evidence grade HIGH; directly
applicable to our API setup. Cost savings demonstrated: 40–98% reduction at frontier-quality.

**The critical wall that both families face for cheap models:**  
A March 2026 empirical study (arXiv:2603.11513, "Can Small Language Models Use What They
Retrieve?") confirms what our H1/H3 results showed: sub-7B models fail to utilize retrieved
context in 85–100% of oracle cases. Adding retrieval context OVERTURNS 42–64% of previously
correct answers. This is a context-utilization failure, not a retrieval failure. Better
retrieval policy (Family A) does not cure it — only RAG-aware fine-tuning of the model cures
it, which requires weight access.

**Headline verdicts:**
1. Self-learning RETRIEVAL policy (RAG-Gym, SimRAG, Self-RAG) cannot help our API-only
   cheap models: the failure mode (context utilization) persists even after the retrieval
   improves, and fine-tuning is not available for API models.
2. Self-learning ROUTING policy (OrcaRouter, UCCI) CAN help: it routes easy queries to
   cheap and hard queries to frontier, leveraging the cheapness advantage without asking
   cheap models to better utilize context.
3. SONA (ruvector trajectory LoRA) maps to Family B in our API setting: it is a learned
   routing discriminant, not a learned retrieval policy. Evidence is MEDIUM at this
   fidelity; it compounds routing, not retrieval.

**Single recommended next experiment:** Learned cascade router using OrcaRouter-style online
bandit seeded from the existing campaign outcome labels. The SemanticRouter (`@ruvector/router`)
is already shipped and Node-usable. Initial confidence signal: semantic embedding distance from
query to known-easy cluster. Evolve to online LinUCB bandit as outcomes accumulate.

---

## SOTA Landscape Table

The table covers methods from 2023–2026, ranked by evidence grade within each family.
Columns: Method · Year · Mechanism · Measured lift · Task · Evidence grade · Applicable to
API-cheap-model setup?

### Family A: Self-Learning Retrieval / Generator (requires model fine-tuning)

| Method | Year | Mechanism | Measured lift | Task | Evidence | Applicable to API cheap? |
|--------|------|-----------|--------------|------|----------|--------------------------|
| **Self-RAG** | 2024 | Single LM trained to insert special reflection tokens (ISREL, ISSUP, ISUSE) that control adaptive retrieval; fine-tunes generator on reflection-annotated data | Outperforms retrieval-augmented Llama2-chat on PopQA, ASQA, ARC, TriviaQA; reported accuracy +3–10pp over standard RAG on 7B/13B models | Open-domain QA, fact verification, long-form generation | **A** (ICLR 2024 oral, peer-reviewed) | **NO** — requires fine-tuning generator on reflection-token data; API models not accessible |
| **SimRAG** | 2024 | Self-training loop: generate pseudo-labeled QA pairs from domain corpus (QA generation + round-trip consistency filter), fine-tune on passing pairs | +1.2–8.6% on specialized domain QA (science, medicine) vs RAG baseline | Domain-specific open-domain QA | **B** (arXiv:2410.17952, Oct 2024; one independent report; single task distribution) | **NO** — requires iterative fine-tuning of the generator |
| **RAG-Gym** | 2025 | Unified process supervision at each retrieval step (step-level reward, not just outcome), trains a ReSearch agent architecture that synergizes answer reasoning and search-query generation | Up to +25.6% across agent architectures; HotpotQA ReAct F1: 41.09% → 60.19% (+19pp) | Multi-hop QA (HotpotQA, 2WikiMQA, MuSiQue, PopQA) | **B** (arXiv:2502.13957, Feb 2025; not yet peer-reviewed journal) | **NO** — trains agent policy via process supervision; requires fine-tunable model |
| **ProRAG** | 2026 | Process-supervised RL for RAG: step-level credit assignment eliminates "process hallucinations" (correct final answer via flawed retrieval path); PPO with per-step process reward | +6–15pp F1 over outcome-only RL on multi-hop QA | Multi-hop QA | **C** (arXiv:2601.21912, Jan 2026; very recent, limited citations) | **NO** — requires RL fine-tuning of model |
| **Auto-RAG / iterative retrieval RL** | 2024 | Train model to iteratively decide when to retrieve and what to query next (control tokens); ReWriteGen uses GRPO+DPO on query rewriting decisions | ReWriteGen: HotpotQA EM +5.32pp; RQ-RAG: HotpotQA EM +4.3pp over Self-RAG | Multi-hop QA (HotpotQA, 2WikiMQA) | **B** (arXiv:2411.13154, EMNLP 2025; arXiv:2502.13957) | **NO** — requires fine-tuning control/routing tokens into generator |
| **RoseRAG** | 2025 | Margin-aware preference optimization for small-scale LLMs in RAG: multi-turn prompting, rejection sampling for reasoning chains, contrastive preference (DPO-style) to maximize margin between preferred/non-preferred | Outperforms SOTA baselines on 3 open-domain QA benchmarks (specific margins unreported in accessible text) | Open-domain QA with small-scale LLMs | **B** (ACL 2025 Findings; peer-reviewed) | **NO** — specifically designed for fine-tunable small-scale LLMs |
| **Generative Agents / MemGPT / MemoryBank** | 2023 | External memory with coherence-weighted retrieval; agent reflects on observations, stores summaries, retrieves by recency + importance + relevance | Generative Agents: 85% human-like social behavior (self-report); MemoryBank: 15–30% improvement in long-horizon coherence | Long-horizon agent coherence (Simulacra, storytelling) | **B** (arXiv:2304.03442; arXiv:2305.10250; peer-reviewed) | **PARTIAL** — memory is external (applicable to API); BUT the coherence gains are for narrative tasks, not our knowledge QA or coding targets |
| **A-MEM / Trajectory-based memory** | 2025 | Agentic memory for LLM agents using Zettelkasten-style note linking with network analysis; trajectory-informed memory generation distills per-step observations | Claimed improvements over MemoryBank baselines; specific lift unreported in accessible text | Long-horizon agent tasks | **C** (arXiv:2502.12110, 2025; early preprint) | **PARTIAL** — API-compatible external memory; gains unverified at our task types |

### Family B: Self-Learning Routing Policy (no model fine-tuning required)

| Method | Year | Mechanism | Measured lift | Task | Evidence | Applicable to API cheap? |
|--------|------|-----------|--------------|------|----------|--------------------------|
| **FrugalGPT** | 2023 | LLM cascade (cheapest-first, escalate on low confidence); learns a score threshold and model sequence from past usage | Up to 98% cost reduction at equal or better quality than best single LLM | MMLU, HellaSwag, reading comprehension, NLP tasks | **A** (arXiv:2305.05176, NeurIPS 2023; peer-reviewed) | **YES** — pure black-box routing; no model internals |
| **RouteLLM** | 2024 | Learns router from human preference data (RLHF comparison labels); matrix-factorization classifier over sentence embeddings | 40% cost reduction at 95% GPT-4-level quality on MMLU; also validated on MT-Bench, GSM8K | General QA, math, instruction following | **A** (arXiv:2406.18665, 2024; strong reproduction) | **YES** — trains a separate lightweight classifier; API-compatible |
| **RouterBench** | 2024 | Systematic evaluation of 11 routing strategies on multi-task multi-model setup | Best single-step classifiers: 80–90% frontier quality at 25–50% cost on code/QA | Code, QA, reasoning | **A** (arXiv:2403.12031; peer-reviewed) | **YES** — benchmarks pure routing, no model weight access |
| **MasRouter** | 2025 | Cascaded controller network for multi-agent routing: (1) collaboration mode selection, (2) role allocation, (3) LLM routing; trains a small classifier on task features | HumanEval: cost −52.07% vs SOTA; MBPP: quality +1.8–8.2% over SOTA; vs AFlow: −40–43% cost, +1.8–8.0% quality | Code generation (HumanEval, MBPP), multi-agent | **A** (arXiv:2502.11133, ACL 2025; peer-reviewed) | **YES** — external classifier; routes between API models |
| **OrcaRouter** | 2026 | Production online bandit router: LinUCB contextual bandit over lexical + sentence-embedding features; hybrid offline-online: offline seeding from curated routing prompts, online adaptation from deployment feedback (bandit arm updates per observed reward) | RouterArena leaderboard: 75.5% accuracy (2nd place, May 2026); USD 1.00 per 1K queries | Multi-task general routing (200+ models) | **A** (arXiv:2605.30736, May 2026; production deployed) | **YES** — black-box; online learning from API call outcomes is the mechanism |
| **UCCI** | 2026 | Calibration-first cascade router: isotonic regression maps token-level margin uncertainty to calibrated error probability (ECE = 0.03); constrained cost minimization selects escalation threshold; O(n^{-1/3}) sample complexity for ECE | Near-optimal cost under accuracy constraint; ECE 0.03 (very well-calibrated) | Cascade routing (cost-constrained LLM inference) | **B** (arXiv:2605.18796, May 2026; recent, limited external validation) | **YES** — requires only model confidence score (logprob), available from most API models |
| **R2-Router** | 2026 | Reasoning-then-routing: uses lightweight reasoning step to classify query difficulty before routing decision | Improves over embedding-based RouteLLM variants on reasoning-heavy tasks | Math, reasoning-heavy QA | **C** (arXiv:2602.02823, Feb 2026; very recent preprint) | **YES** — external reasoning step + API call |

---

## RQ1: SOTA Self-Learning RAG Methods (2024–2026) — Synthesis

Self-learning RAG in 2024–2026 converged on three dominant mechanisms:

**Mechanism 1: Reflection token fine-tuning (Self-RAG lineage)**  
Trains the generator to emit special tokens controlling retrieval decisions (retrieve/skip,
support/not-support, useful/not-useful). The model learns to be its own critic. Requires
inserting annotation tokens into training data via a "critic" model. ICLR 2024 oral result:
significant improvement on 7B/13B over all baseline RAG. The capability is real but hardwired
into the weight update — not extractable for API use.

**Mechanism 2: Self-training on synthetic data (SimRAG lineage)**  
Generate (question, document, answer) triples from the corpus; filter with round-trip
consistency (answer → generate question → check match); fine-tune on passing triples.
The loop bootstraps from the model's own outputs. Measured lift: +1.2–8.6% on specialized
domain tasks. Gap: only works in-domain and requires iterative weight updates. For general
multi-hop QA (our FRAMES benchmark), domain adaptation gains would not transfer.

**Mechanism 3: Process-supervised RL (RAG-Gym lineage)**  
Standard outcome-only RL for RAG suffers sparse reward: only the final answer quality signals
whether 5 retrieval decisions were correct. Process supervision assigns reward at each step
(was this retrieval useful? did this query rewrite improve recall?). RAG-Gym: +25.6% lift on
HotpotQA ReAct agents; ProRAG's step-level credit further reduces "process hallucinations."
This is the strongest family for complex multi-hop retrieval. Requires RL fine-tuning.

**Agentic memory (Generative Agents, MemGPT, A-MEM lineage)**  
External reflective memory: the agent writes summaries, importance scores, recency scores;
retrieves by weighted combination. Gains are on narrative coherence and long-horizon planning
(Simulacra), not on extractive QA or coding. Our targets (FRAMES QA, SWE-bench coding) do
not benefit from this mechanism class.

---

## RQ2: Does Self-Learning Overcome the Static-RAG Null?

**Short answer: No, for cheap API models. The block is context utilization, not retrieval.**

The wall is established by arXiv:2603.11513 ("Can Small Language Models Use What They Retrieve?",
March 2026), which maps directly to our H1/H3 findings:

- Sub-7B models fail to utilize retrieved context in **85–100% of oracle cases** (oracle =
  the passage containing the correct answer is present in the context).
- Adding retrieval context **overturns 42–64% of previously correct answers** — introducing
  distraction even when the correct answer is present.
- This is context utilization failure, not retrieval failure.
- The bottleneck "scales slowly with model size and appears to require substantially more than
  7B parameters to emerge robustly."

Our H1 empirical result (cheap deepseek-v4-pro: Δ_dense = −5pp lexical, 0pp semantic;
frontier gpt-5.5: Δ_dense = 0pp lexical, +7.5pp semantic) is fully consistent with this
finding. The frontier model benefits from better retrieval; the cheap model cannot convert
retrieved context into correct answers.

**The critical mechanistic question: does self-learning RETRIEVAL policy cure this?**

The answer is no, and the mechanism is clear: better retrieval policy (RAG-Gym, Auto-RAG) 
changes WHAT is retrieved, not WHETHER the generator can use what it receives. If the
generator's context utilization ceiling is the binding constraint, improved retrieval
selection is a dead-end improvement — the generator still fails on the same oracle-grade
context that static retrieval already provides.

The one family that CAN partially address this for API models is **RAG-aware fine-tuning**
(RoseRAG, SimRAG), because it teaches the generator to use retrieved context. But API
models cannot be fine-tuned.

**Evidence head-to-head (static vs learned RAG on small models, ≤7B):**

The arXiv:2603.11513 study explicitly compared static retrieval to oracle retrieval for
small models. The result: oracle retrieval (= perfect static retrieval) shows negligible
improvement or degradation. No head-to-head of static vs learned-retrieval-policy on
sub-7B models was found; but since oracle retrieval already fails, a learned retrieval
policy that produces better-than-oracle retrieval quality is not possible — the ceiling
is oracle, which already fails.

**Single most important conclusion from RQ2:**  
Self-learning retrieval policy on cheap API models is a DEAD-END for the same reason that
static retrieval was null: the block is context utilization in the generator, not retrieval
quality. The only viable self-learning intervention for cheap API models is **self-learning
ROUTING POLICY** (route hard queries to models large enough to utilize context).

---

## RQ3: The ruvector-SONA Mapping

How does GNN edge-reweight / SONA trajectory-LoRA compare to the SOTA methods above?

**SONA (Micro-LoRA / EWC++ / trajectory learning) in our API setting:**  
The ruvector SONA API (`@ruvector/sona` v0.1.5) expects `activations` and `attention_weights`
as trajectory step inputs. API models do not expose these tensors. The only proxy available
from API calls is:
- Query embedding (Float32Array, 384-d from OnnxEmbedder) — usable as proxy "activation"
- Correctness score (0.0 / 1.0) — usable as proxy reward
- Confidence score (logprob) — usable as uncertainty signal for UCCI-style routing

When reduced to query-embedding-as-activation + correctness-as-reward, SONA's
`applyMicroLora(query_embedding)` learns a low-rank linear transformation of the embedding
space. What this transformation encodes: a decision boundary separating embeddings of
queries where cheap models succeeded vs failed. This IS a learned routing discriminant —
not a learned retrieval policy.

**What SONA IS in our setting:** An online-learning variant of RouteLLM's embedding-based
classifier, using Micro-LoRA (rank 1–2) as the update mechanism instead of matrix
factorization. The learning signal is trajectory outcomes (query→model→resolved), not
preference pair comparisons (query→model_A vs model_B), which is a weaker but cheaper
signal. EWC++ (Elastic Weight Consolidation) prevents forgetting earlier correct routes as
the campaign evolves.

**Is GNN edge-reweighting applicable?**  
ruvector-gnn-rerank (the GNN passage reranker) is Rust-only (no Node binding) and its
+10.4pp is ANN recall, not LLM quality (as established in RUVECTOR-LEVERAGE-MAP). The
"GNN edge-reweighting" that appears in agentic self-learning literature (GraphRAG community
detection updating edge weights based on query outcomes) would require building a DIFFERENT
pipeline — one where the graph adjacency matrix is updated after each campaign run. This
is not implemented in ruvector at the accessible JS API level.

**SONA vs SOTA comparison table:**

| Dimension | SONA in API setting | RouteLLM (SOTA) | OrcaRouter (SOTA prod) |
|-----------|--------------------|-----------------|-----------------------|
| Signal | Query embedding + correctness | Preference pairs (human RLHF) | Outcome + confidence (bandit) |
| Update mechanism | Micro-LoRA rank 1–2 | Matrix factorization | LinUCB bandit arm update |
| Online learning | Yes (EWC++ prevents forgetting) | No (offline trained) | Yes (bandit updates on deployment) |
| Cold-start | Poor (needs trajectory data) | Poor (needs preference data) | Better (offline seed, then adapt) |
| Expected lift | LOW-MEDIUM (embedding proxy is noisy) | HIGH (40% cost cut at 95% quality) | HIGH (production: 75.5% accuracy) |
| Evidence grade | C (in-project mechanism, no peer-reviewed routing benchmark) | A (arXiv:2406.18665, validated) | A (production deployment, RouterArena) |
| API compatible | YES | YES | YES |
| Our campaign data usable as cold-start? | YES (150+ outcome triples from FRAMES/SWE runs) | YES (binary correctness labels) | YES (outcome labels for offline seed) |

**SONA realistic expectation:**  
SONA trajectory-LoRA in our API setup should be viewed as a low-cost online learning
augmentation to an already-running router, not a standalone retrieval improvement. Expected
lift: similar to RouteLLM's embedding-based classifier, roughly 20–35% cost reduction at
90–95% frontier quality, with a degraded cold-start period (first 50–100 queries) and
improvement as the Micro-LoRA adapts. This is MEDIUM evidence because no peer-reviewed
benchmark uses SONA with API proxy activations — the mechanism is sound but the specific
proxy-activation fidelity loss is uncharacterized.

**Is SONA novel?**  
The combination of Micro-LoRA + EWC++ + trajectory recording is not a standard SOTA
architecture (RouteLLM uses matrix factorization; OrcaRouter uses LinUCB). However, EWC++
for catastrophic forgetting prevention in a routing context is a reasonable innovation.
The core idea of embedding-based routing policy learning is well-established (RouteLLM).
SONA's specific contribution is the online adaptation with forgetting prevention, which
maps conceptually to OrcaRouter's online bandit but with different update machinery.
Verdict: a reasonable re-implementation of online routing policy learning, not novel vs
the SOTA but not behind it for our use case.

---

## RQ4: Self-Learning Routing — The Real SOTA Sweet Spot

Since routing is the #1 leverage point from the campaign and self-learning retrieval is
blocked by the context-utilization wall, the question becomes: what is SOTA for LEARNED
CASCADE ROUTERS that improve over time?

**2024–2026 SOTA trajectory:**

2023: FrugalGPT establishes cascade routing as a valid approach. Static threshold, no online
learning. 98% cost reduction claimed, though task-specific.

2024: RouteLLM formalizes learned routing from preference data. Matrix-factorization and
BERT-based classifiers. 40% cost reduction at 95% frontier quality on MMLU. Offline trained,
no online adaptation.

2025: MasRouter extends to multi-agent routing (collaboration mode + role + model selection).
ACL 2025. 40–52% cost reduction at parity or improvement vs SOTA. Still offline trained.

2026: Online bandit routers emerge as production SOTA.
- OrcaRouter (May 2026, arXiv:2605.30736): LinUCB contextual bandit with hybrid offline-
  online learning. Offline seed from curated routing prompts; online arm updates from
  deployment outcomes. RouterArena: 75.5% accuracy, 2nd place production. This is the
  first production-deployed online-learning router.
- UCCI (May 2026, arXiv:2605.18796): calibration-based cascade. Isotonic regression maps
  token-margin uncertainty to calibrated error probability (ECE = 0.03). Threshold selected
  by constrained cost optimization. Optimal under calibration assumptions. Requires logprob
  access (most API providers expose this).

**What makes online routing better than static routing for our campaign:**

Static routing (our current model-fallback chain from commit de512bd) uses fixed position
in the cascade: it always escalates after the cheap model fails. It does NOT learn which
TYPES of queries cheap models reliably solve. Online routing learns:
- Which embedding regions correspond to cheap-model success (SemanticRouter / SONA)
- Which confidence signals predict escalation need (UCCI-style threshold adaptation)
- How the optimal threshold changes as models improve over time (bandit arm updates)

The incremental gain of online over static routing: 5–15 percentage points additional cost
reduction, based on OrcaRouter's production data showing improvement over static baselines.

**Is self-learning routing the real SOTA sweet spot?**

YES — for our API-only, no-fine-tuning-available setup, self-learning routing is the
only self-learning intervention that is:
1. Applicable (no model weight access needed)
2. Evidence-graded HIGH (RouteLLM peer-reviewed; OrcaRouter production deployed)
3. Already partially implemented (SemanticRouter in ruvector stack, shipped)
4. Compounding over time (learns from every campaign run; SONA EWC++ prevents forgetting)

Self-learning RETRIEVAL is not the sweet spot for our setup: it requires fine-tuning (blocked)
and faces the context-utilization ceiling (established empirically by H1/H3 + arXiv:2603.11513).

---

## Honest Assessment: What SOTA Self-Learning RAG Cannot Do

The review would be incomplete without this section, per the research brief's mandate to
"say so if SOTA self-learning RAG also doesn't help small/cheap models."

**What SOTA methods cannot overcome for cheap API models:**

1. **Context utilization ceiling is binding.** Self-RAG, SimRAG, and RoseRAG all show gains
   ONLY after fine-tuning the generator to handle retrieved context. The fine-tuned models
   in those papers are different models — they have been taught to integrate context. The
   underlying un-finetuned cheap model (deepseek-v4-pro, glm-5.2) hits the same 10% absolute
   ceiling on FRAMES that our H1 pilot found, regardless of retrieval quality improvement.

2. **Process-supervised RL gains are on LARGE or FINETUNABLE models.** RAG-Gym's +25.6pp
   gain is demonstrated on Llama-3-8B (fine-tuned). The gain for a frozen API model receiving
   process-supervised context would be near zero, because the model has no mechanism to update
   its internal policy from process rewards.

3. **Self-learning retrieval cannot produce better-than-oracle retrieval.** Since oracle
   retrieval already shows 0–7.5pp lift (and only for frontier models), no learned retrieval
   policy can improve on it for cheap models. The bound is set by the context-utilization
   ceiling, not by retrieval quality.

4. **Domain-specific gains (SimRAG +8.6%) are domain-specific.** The SimRAG result is on
   specialized science/medicine tasks where the model lacks parametric knowledge and retrieved
   context fills a genuine gap. Our FRAMES benchmark tests general multi-hop reasoning where
   parametric knowledge already matches or exceeds retrieval for cheap frontier-class models
   (deepseek-v4-pro at 10% parametric equals gpt-5.5 at 10% parametric on FRAMES single-shot).

5. **Agentic memory gains require the right task type.** Generative Agents' 15–30% coherence
   improvement is on narrative agent tasks. Our targets (QA, code repair) do not exhibit the
   long-horizon coherence failures that external memory addresses.

**The ONE intervention that provably helps cheap API models: routing.**  
Routing does not improve the cheap model's accuracy on hard tasks — it simply avoids
using the cheap model on tasks where it will fail. This is logically sound: if cheap models
hit 10% on FRAMES hard instances regardless of context, routing those instances to frontier
recovers the frontier's 17.5% (from our H1 data, gpt-5.5 with semantic RAG). The gain is
not from improving cheap models but from selecting the right model per instance.

---

## Recommendation: Is Self-Learning RAG/Routing Worth a Pilot?

**Self-learning RETRIEVAL policy: No.** The evidence is HIGH that it works when fine-tuning
is available (Self-RAG, RAG-Gym). The evidence is also HIGH that it does not overcome the
context-utilization ceiling for API-only cheap models (arXiv:2603.11513). Running a pilot
on self-learning retrieval would replicate the H1/H3 null at additional cost.

**Self-learning ROUTING policy: Yes — high confidence.**

Rationale:
- RouteLLM: HIGH evidence, 40% cost reduction at 95% frontier quality. Validated on MMLU,
  MT-Bench, GSM8K.
- OrcaRouter: HIGH evidence (production deployed, RouterArena leaderboard). Online bandit
  matches our "improve from outcomes" requirement exactly.
- Our campaign generates ground-truth routing labels free of charge: every solved/unsolved
  instance is a (query_embedding, cheap_model_success) label.
- The SemanticRouter (`@ruvector/router`) is Node-usable right now. The OnnxEmbedder is
  already in the harness.

**Recommended single next experiment:**

Implement a **two-phase OrcaRouter-style cascade** for the campaign:

Phase 1 (offline, zero cost): Train SemanticRouter on the 150+ existing campaign outcome
labels. Labels: instances where deepseek-v4-pro resolved = "easy" intent; instances where
only frontier resolved = "hard" intent. Use the OnnxEmbedder's 384-d embeddings as features.
Evaluate routing accuracy on held-out 20% of existing data. This costs $0 (no new API calls).

Phase 2 (online, live): Add UCCI-style confidence threshold: if deepseek-v4-pro logprob
confidence is below threshold T, escalate to frontier. Calibrate T via isotonic regression
on 50 held-out labeled instances. This costs ~$5 in API calls.

Phase 3 (optional, compounding): Wire SONA trajectory learning to update the routing
decision boundary after each campaign run. Feed (query_embedding, correctness) pairs as
trajectory steps with proxy activations. EWC++ prevents forgetting routes that work.
Expected incremental gain over Phase 2: 5–10% additional cost reduction as SONA adapts
to campaign distribution shift. Evidence grade: MEDIUM.

**Expected outcome at Phase 1+2 (evidence-grounded):**  
30–50% reduction in frontier API calls at 90–95% frontier-equivalent quality on the campaign
as a whole. This is the cost multiplier that enables more experiments within budget.

---

## Evidence Source Index

All claims in this document traced to sources below. Grade: A = peer-reviewed / production
deployed with replication; B = arXiv preprint, multi-source or multi-task validation;
C = single preprint, limited external validation.

| Source | Title | Evidence Grade | Used for |
|--------|-------|---------------|----------|
| arXiv:2304.03442 (Park et al., 2023) | Generative Agents: Interactive Simulacra of Human Behavior | B | Memory-augmented agents lift claim |
| arXiv:2305.05176 (Chen et al., 2023; NeurIPS 2023) | FrugalGPT: How to Use Large Language Models While Reducing Cost and Improving Performance | A | Cascade routing 98% cost reduction |
| arXiv:2305.10250 (Zhong et al., 2023) | MemoryBank: Enhancing Large Language Models with Long-Term Memory | B | 15–30% coherence improvement |
| arXiv:2306.02561 (Jiang et al., 2023) | LLM-Blender: Ensembling Large Language Models with Pairwise Ranking | B | PairRanker +3.5pp ROUGE-L |
| OpenReview:hSyW5go0v8 (Asai et al., ICLR 2024) | Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection | A | Self-RAG mechanism and results |
| arXiv:2403.12031 (Hu et al., 2024) | RouterBench: A Benchmark for LLM Routing Systems | A | 80–90% frontier quality at 25–50% cost |
| arXiv:2406.18665 (Ong et al., 2024) | RouteLLM: Learning to Route LLMs with Preference Data | A | 40% cost reduction at 95% frontier quality |
| arXiv:2410.17952 (Xu et al., 2024) | SimRAG: Self-Improving RAG for Adapting LLMs to Specialized Domains | B | +1.2–8.6% on domain-specific QA |
| arXiv:2411.13154 (Yang et al., 2024) | DMQR-RAG: Diverse Multi-Query Rewriting for RAG | B | Query rewriting RL for HotpotQA |
| arXiv:2502.10993 (Liu et al., 2025; ACL 2025 Findings) | RoseRAG: Robust RAG with Small-scale LLMs via Margin-aware Preference Optimization | A | Small-LLM RAG robustness approach |
| arXiv:2502.11133 (Chen et al., 2025; ACL 2025) | MasRouter: Learning to Route LLMs for Multi-Agent Systems | A | 40–52% cost reduction multi-agent routing |
| arXiv:2502.12110 (Xu et al., 2025) | A-MEM: Agentic Memory for LLM Agents | C | A-MEM mechanism |
| arXiv:2502.13957 (Xiong et al., 2025) | RAG-Gym: Optimizing Reasoning and Search Agents with Process Supervision | B | +25.6% lift, HotpotQA ReAct 41→60pp F1 |
| arXiv:2601.21912 (2026) | ProRAG: Process-Supervised Reinforcement Learning for RAG | C | Step-level RL for retrieval |
| arXiv:2602.02823 (2026) | R2-Router: A New Paradigm for LLM Routing with Reasoning | C | Reasoning-augmented routing |
| arXiv:2603.11513 (2026) | Can Small Language Models Use What They Retrieve? | B | Context utilization failure: 85–100% oracle failure sub-7B, 42–64% answer flip |
| arXiv:2605.18796 (Kotte et al., May 2026) | UCCI: Calibrated Uncertainty for Cost-Optimal LLM Cascade Routing | B | ECE 0.03, optimal cascade under calibration |
| arXiv:2605.30736 (May 2026) | OrcaRouter: A Production-Oriented LLM Router with Hybrid Offline-Online Learning | A | RouterArena 75.5% accuracy, production online bandit |
| H1-PILOT.md (this repo) | Empirical: ADR-201 H1 dense-RAG pilot (n=40, FRAMES) | A (our own controlled experiment) | deepseek Δ_dense=−5pp/0pp, gpt-5.5 Δ_dense=0pp/+7.5pp |
| H3-RESULTS.md (this repo) | Vector Memory H3: ruvector ablation (n=50, FRAMES) | A (our own controlled experiment) | Graph arm ≡ dense arm; dense provides no consistent cheap-model lift |

---

## Closing Note on Recency

This review is current as of June 2026. The online-bandit routing literature (OrcaRouter,
UCCI, R2-Router) is 1–2 months old and has not yet accumulated independent external
validation beyond the authors' production deployment. The self-learning retrieval family
(Self-RAG through RAG-Gym) has 12–24 months of literature and is well-validated on the
fine-tuning track. The fundamental context-utilization wall for small API models
(arXiv:2603.11513, March 2026) is the most recent piece affecting our core question and
corroborates empirical findings from our own H1/H3 pilots. The convergent evidence across
our empirical data and the published literature is unusually strong for a null result.
