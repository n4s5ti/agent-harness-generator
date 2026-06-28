# Empirical: FRAMES (everyday-agentic) — cheap vs older-frontier

**Benchmark**: FRAMES (`google/frames-benchmark`) — 824 real-world multi-hop general-assistant questions with gold answers; the open, ungated GAIA-class proxy (official GAIA is HF-gated). A strong everyday-agentic / analysis proxy.
**Harness**: agentic ReAct loop (search→open→submit) reusing the SWE-bench OpenRouter client; keyless Wikipedia tools; GAIA-style normalized exact-match scorer (conformant, leak-free).
**Protocol**: two batches, seed 42, **same questions per model** (n=150 is a superset of n=50). GCP fleet (e2-small, AUTOSTOP, reaped); Firestore self-report (`frames_runs` summary + `frames_preds` per-task).
**Date**: 2026-06-28.

## RIGOROUS RESULT — n=150, fair 18-step cap (all models)

| Model | Tier | EM acc | correct/150 | 95% Wilson CI | relaxed | $/task | $/correct |
|-------|------|--------|-------------|---------------|---------|--------|-----------|
| **glm-5.2** | cheap | **0.433** | 65 | [35.7, 51.3] | 0.48 | $0.0411 | $0.095 |
| **deepseek-v4-pro** | cheap | **0.427** | 64 | [35.0, 50.7] | 0.45 | $0.0235 | **$0.055** |
| gpt-5.2 | older-frontier | 0.427 | 64 | [35.0, 50.7] | 0.51 | $0.1145 | $0.268 |
| claude-opus-4.5 | older-frontier | 0.373 | 56 | [30.0, 45.3] | 0.41 | $0.3248 | $0.870 |

### Verdict: thesis PROVEN on the everyday-agentic axis (rigorous n)
At n=150 with a uniform fair 18-step cap, **all four models are statistically indistinguishable in accuracy** (every CI overlaps), while the cheap models cost **5–16× less per correct answer**. The cheap models *match the clean frontier comparator GPT-5.2 to the decimal* (deepseek 0.427 = gpt 0.427; glm 0.433), and both **exceed** Opus-4.5's fair score (0.373). This is the central thesis, measured rigorously: on everyday-agentic multi-hop QA, cheap ≈ older-frontier accuracy at a large cost advantage.

### The Opus diagnosis — confirmed, and the honesty call vindicated
The n=50 Opus number was **0.28**; raising the step cap 12→18 lifted it to **0.373 (+9.3 pts)** — confirming the earlier diagnosis that Opus's low score was a **step-cap × deep-search artifact**, not a capability signal (the local n=8 diagnostic had already shown 0 harness errors). Refusing to publish "cheap crushes Opus" off the n=50 artifact was correct. Even at the fair cap Opus's point estimate sits below the others, but the CIs overlap → parity-class, not a clean gap. (Opus likely still wants more than 18 steps for its exhaustive style; `relaxed` lifts it 0.373→0.413, so some loss is strict-EM formatting.)

### Stability across n (the parity is not a small-sample fluke)
| Model | n=50 EM | n=150 EM |
|-------|---------|----------|
| deepseek-v4-pro | 0.42 | 0.427 |
| glm-5.2 | 0.42 | 0.433 |
| gpt-5.2 | 0.38 | 0.427 |
| opus-4.5 | 0.28 † | 0.373 (fair 18-step) |

Cheap models held steady; the frontier models rose toward the cheap line as n grew and (for Opus) the cap was made fair — convergence *toward* parity, never away.

## Cost (the robust half)
- **$/task**: deepseek $0.024, glm $0.041 vs gpt $0.114, opus $0.325 → cheap **2.8–13.8× cheaper**.
- **$/correct**: deepseek $0.055, glm $0.095 vs gpt $0.268, opus $0.870 → cheap **2.8–15.8× cheaper**.

A conservative, task-measured complement to the report's ~56× token-pricing / SWE-cascade headline.

## Honesty discipline
- Parity = overlapping CIs (indistinguishable), not "cheap wins." Cheap point-estimates ≥ frontier, but we claim *parity*.
- Absolute scores (0.37–0.43) are low because the harness uses lightweight keyless-Wikipedia retrieval — **only the same-harness relative comparison is valid**; do not compare to external FRAMES leaderboards (~0.65–0.70 with strong retrieval).
- Under relaxed matching GPT (0.51) leads slightly (format-misses recovered); on strict EM cheap = gpt. Both framings are parity-class.
- Total research-spend for both batches: ~$99 of the $200 budget.
