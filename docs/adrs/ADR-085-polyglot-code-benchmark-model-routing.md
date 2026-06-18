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

## Results (real, 2026-06-18)

| model | tier | $/Mtok | avg quality | quality/$ | per-language (py/js/ts/rust/cpp/c) |
|---|---|--:|--:|--:|---|
| openai/gpt-5-mini | cheap | 2 | **100** | 43,122 | 100·100·100·100·100·100 |
| google/gemini-2.5-flash | cheap | 1 | 98 | **167,378** | 100·100·100·88·100·100 |
| anthropic/claude-sonnet-4 | mid | 9 | **100** | 19,741 | 100·100·100·100·100·100 |
| openai/gpt-5 | frontier | 12 | **100** | 4,672 | 100·100·100·100·100·100 |
| anthropic/claude-opus-4 | frontier | 45 | **100** | 4,027 | 100·100·100·100·100·100 |
| anthropic/claude-haiku-4.5 | cheap | 3 | 50 | — | 100·100·100·**0·0·0** |
| google/gemini-2.5-pro | mid | 7 | 50 | — | **0**·100·**0**·100·100·**0** |

### Findings

1. **Cheap-beats-frontier holds for code — strongly on quality-per-dollar.** `gpt-5-mini` ($2) matches `opus-4` ($45) at a perfect 100% across all six languages, at **10.7× better quality-per-dollar**. `gemini-2.5-flash` ($1) is near-perfect (one Rust miss) at **41.6× better quality-per-dollar than opus-4**.
2. **Reliability is NOT monotonic with price.** `haiku-4.5` ($3) is perfect on Python/JS/TS but **fails to compile** in Rust/C++/C — it cannot reliably write compiled-systems code for this task. And mid-tier `gemini-2.5-pro` ($7) is the **least reliable model in the field** (wrong output in Python/TS, compile failure in C). Price tier is a poor proxy for code correctness.
3. **The operational rule is per-language routing, not "use the cheapest."** The right cheap model depends on the target language.
4. **For the Darwin mutator specifically (TypeScript):** `gemini-2.5-flash`, `gpt-5-mini`, `haiku-4.5`, `sonnet-4`, `gpt-5`, and `opus-4` all score **100 on TS**; only `gemini-2.5-pro` fails. This is execution-based justification for the ADR-084 follow-on: **default `OpenRouterMutator` to `google/gemini-2.5-flash`** ($1/Mtok, 100 on TS, fastest), with `gpt-5-mini` as a fallback. Do **not** route to `haiku-4.5` if the harness ever emits a compiled language.

## Consequences

- The mutator's default model becomes a measured choice, not a guess. (Code change tracked separately; 0.1.0 is already published, so it ships on the next version bump.)
- The harness is reusable: `node run-cell.mjs <model> <lang>` is the unit; the swarm script fans out the matrix. New languages slot in by adding a compile/run entry.
- Honesty boundary: results reflect *one* task. A single algorithmic problem is not a full coding-competence claim — it is a routing signal calibrated to the mutator's actual job (small, self-contained, signature-stable regenerations), which is exactly that shape. Broader suites (SWE-bench-style multi-file edits) remain future work under ADR-076's benchmark layer.
