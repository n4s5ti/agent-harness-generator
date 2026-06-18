# ADR-085: Polyglot code benchmark — execution-scored model routing for the mutator

**Status**: Accepted (measured)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-071 (`CodeGenerator` contract), ADR-076 (parent-vs-child benchmark), ADR-077 (DGM — cites Polyglot 14.2%→30.7%), ADR-084 (failure-driven mutation), ADR-037–040 (DRACO measured-win discipline)

> The DRACO frontier (research-writing) suggested cheap models rival frontier ones, but the Darwin mutator emits **code**, not prose. This ADR records an **execution-scored** code benchmark across six languages to answer the mutator-routing question directly — and the answer is sharper than "cheap is fine."

## Context

ADR-084 wired failure-driven mutation; the natural next question is *which model* should drive `OpenRouterMutator`. The DRACO benchmark (ADR-037-040) measured *research dossier* quality and found cheap-beats-frontier on quality-per-dollar — but that is the wrong task to generalize from: the mutator regenerates a TypeScript surface file. We needed a code benchmark, scored by **compilation + execution**, not by an LLM judge (objective, no judge bias, no fabrication).

## Decision

A self-contained harness (`packages/darwin-mode/bench/polyglot/`):

- **Task**: merge overlapping intervals, with touching intervals merging. Chosen for a clean edge-case spread (empty, nested, adjacent, unsorted, negatives, disjoint).
- **I/O contract**: plain line format (`N`, then `N` `"start end"` lines) — *no JSON library needed in any language*, so C and Rust are judged on the same footing as Python.
- **Scoring**: each `(model × language)` cell makes one live OpenRouter call, writes the program, **compiles it (if compiled) and runs it against 8 hidden cases**. `quality` = pass rate 0-100. Cost = real `total_tokens × blended USD/Mtok`.
- **Matrix**: 7 priced models × 6 languages (Python, JS, TS, Rust, C++, C) = 42 cells, fanned out concurrently. `.NET`, `Go`, and `javac` were not installed on the runner and are reported as unavailable rather than faked.

## Results (real, 2026-06-18) — 15 models, US + China + France

| model | origin | $/Mtok | avgQ | quality/$ | py·js·ts·rs·cpp·c |
|---|---|--:|--:|--:|---|
| **deepseek/deepseek-chat** (V3) | 🇨🇳 China | 0.4 | **100** | **519,931** | 100·100·100·100·100·100 |
| moonshotai/kimi-k2 | 🇨🇳 China | 1 | **100** | 221,811 | 100·100·100·100·100·100 |
| mistralai/mistral-large | 🇫🇷 France | 4 | **100** | 54,905 | 100·100·100·100·100·100 |
| z-ai/glm-4.6 | 🇨🇳 China | 0.7 | **100** | 52,040 | 100·100·100·100·100·100 |
| openai/gpt-5-mini | 🇺🇸 USA | 2 | **100** | 43,122 | 100·100·100·100·100·100 |
| anthropic/claude-sonnet-4 | 🇺🇸 USA | 9 | **100** | 19,741 | 100·100·100·100·100·100 |
| openai/gpt-5 | 🇺🇸 USA | 12 | **100** | 4,672 | 100·100·100·100·100·100 |
| anthropic/claude-opus-4 | 🇺🇸 USA | 45 | **100** | 4,027 | 100·100·100·100·100·100 |
| google/gemini-2.5-flash | 🇺🇸 USA | 1 | 98 | 167,378 | 100·100·100·**88**·100·100 |
| deepseek/deepseek-r1 | 🇨🇳 China | 1 | 98 | 29,881 | 100·100·**88**·100·100·100 |
| mistralai/mistral-medium-3 | 🇫🇷 France | 0.8 | 94 | 247,195 | 100·100·88·88·100·88 |
| mistralai/codestral-2508 | 🇫🇷 France | 0.5 | 83 | 340,136 | 100·100·100·**0**·100·100 |
| anthropic/claude-haiku-4.5 | 🇺🇸 USA | 3 | 50 | — | 100·100·100·**0·0·0** |
| google/gemini-2.5-pro | 🇺🇸 USA | 7 | 50 | — | **0**·100·**0**·100·100·**0** |
| qwen/qwen-2.5-coder-32b | 🇨🇳 China | 0.3 | — | — | excluded* |

\* Qwen-2.5-Coder-32B: the default OpenRouter provider returned **empty output** for the benchmark prompt (a trivial prompt succeeds, and the same harness scores every other model) — recorded as a provider/endpoint issue, **not** a capability verdict.

### Findings

1. **Cheap-beats-frontier for code — globally, and decisively.** **8 of 15 models score a perfect 100% across all six languages**, and the four cheapest of those eight are **non-US** (DeepSeek V3 $0.4, GLM-4.6 $0.7, Kimi-K2 $1, Mistral-Large $4). **DeepSeek V3 ($0.4/Mtok) tops the entire field at 519,931 quality/$ — ~129× better than `opus-4`**, which has the *worst* quality/$ of any perfect-scoring model despite the highest price. The two US frontier models (gpt-5, opus-4) sit at the **bottom** of the quality-per-dollar ranking.
2. **Reliability is NOT monotonic with price.** `haiku-4.5` ($3) is perfect on Python/JS/TS but **fails to compile** Rust/C++/C; mid-tier `gemini-2.5-pro` ($7) is the least reliable model in the field. Ironically the *code-specialized* `codestral` fails Rust. Tier/price is a poor proxy for per-language code correctness.
3. **Reasoning models are expensive here.** `deepseek-r1` passed almost everything but burned 5k–7.6k tokens and up to **260 s** on Rust/C++ — for a task the $0.4 V3 nails in ~500 tokens / ~10 s. Reasoning is the wrong tool for small, well-specified codegen.
4. **The operational rule is per-language routing, not "use the cheapest."**
5. **For the Darwin mutator (TypeScript):** every model except `gemini-2.5-pro` scores 100 on TS. The default `OpenRouterMutator` model is `google/gemini-2.5-flash` (fastest perfect-on-TS, $1); **`deepseek/deepseek-chat` is the top quality-per-dollar alternative** (100 on TS at $0.4, more reliable across languages, ~9 s vs ~2 s). Do **not** route to `haiku-4.5` if the harness ever emits a compiled language.

## Consequences

- The mutator's default model becomes a measured choice, not a guess. (Code change tracked separately; 0.1.0 is already published, so it ships on the next version bump.)
- The harness is reusable: `node run-cell.mjs <model> <lang>` is the unit; the swarm script fans out the matrix. New languages slot in by adding a compile/run entry.
- Honesty boundary: results reflect *one* task. A single algorithmic problem is not a full coding-competence claim — it is a routing signal calibrated to the mutator's actual job (small, self-contained, signature-stable regenerations), which is exactly that shape. Broader suites (SWE-bench-style multi-file edits) remain future work under ADR-076's benchmark layer.
