# DRACO — Cross-Domain Benchmark for Deep Research

**DRACO** (Cross-Domain Benchmark for Deep Research) is the quality gate for the
`vertical:research` harness in `agent-harness-generator`. It produces a measured,
re-runnable **DRACO score** — a number backed by a committed corpus, not a narrative.

> ADR-037 is the authoritative design document. This README is the operator reference.

---

## What DRACO measures

Five scoring dimensions per question (0–1 each), mean = DRACO score:

| Dimension | How | Offline? |
|---|---|---|
| **Grounding** | Cited URLs are re-fetched; 404 or content-mismatch = 0 | No (network) |
| **Coverage** | `must_contain` terms present (regex + embedding similarity) | Yes |
| **Balance** | Both positions present for "compare" questions | Yes |
| **Faithfulness** | Independent LLM-judge rates synthesis vs sources | No (LLM) |
| **Efficiency** | Tokens + wall-clock + USD, normalised vs baseline | Yes |

Dimensions 2, 3, 5 are **deterministic** and run offline (`--no-judge`).
Dimensions 1 and 4 require network / API access.

---

## Corpus

`corpus.json` — versioned, checksummed, never silently mutated.
A score is only comparable across runs that share the same `version`.

| Domain | Questions (v1) |
|---|---|
| science | 4 |
| finance | 4 |
| law | 4 |
| current-events | 3 |
| technical | 5 |
| **Total** | **20** |

The corpus checksum is pinned in
`packages/bench/__tests__/draco-corpus.test.ts`. Editing `corpus.json`
without updating the pin **fails CI** — this is intentional.

---

## Running

### M1 — corpus only (this milestone)

```bash
npm run bench:draco          # prints milestone status; no live score yet
```

The runner lands in **M3**. The LLM-judge lands in **M4**. Do not fake a score
before then.

### Future milestones (M3+)

```bash
# Deterministic checks only (offline CI)
npm run bench:draco -- --no-judge

# Single domain
npm run bench:draco -- --domain=science

# Subset of N questions
npm run bench:draco -- --n=5

# Full judged run (requires OPENROUTER_API_KEY in environment)
npm run bench:draco
```

---

## Proof JSON (M4 target shape)

```jsonc
{
  "corpusVersion": 1,
  "harness": { "fusionModels": { "synthesize": "...", "verify": "..." } },
  "score": 0.0,
  "perDomain": { "science": 0.0, "finance": 0.0, "law": 0.0, "current-events": 0.0, "technical": 0.0 },
  "perQuestion": [{ "id": "sci-001", "grounding": 0, "coverage": 0, "balance": 0, "faithfulness": 0 }],
  "efficiency": { "tokens": 0, "usd": 0, "wallMs": 0 },
  "judge": { "model": "...", "version": 1 }
}
```

---

## Milestone status

| Milestone | Deliverable | Status |
|---|---|---|
| M1 | Corpus v1 + schema + checksum gate | **Done** |
| M2 | OpenRouter fusion client + secret gate | Pending |
| M3 | Deterministic scorer + `--no-judge` runner + first baseline | Pending |
| M4 | LLM-judge dimension + full proof JSON | Pending |
| M5 | `harness draco` subcommand + CI job + README score row | Pending |
| M6 | Fusion-vs-single-model ablation (the proof) | Pending |
