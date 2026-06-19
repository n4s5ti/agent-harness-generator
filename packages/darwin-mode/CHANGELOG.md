# Changelog — @metaharness/darwin

All notable changes to this package. Dates UTC.

## 0.2.4 — 2026-06-19

- New result (ADR-151): swapping the cheap base deepseek-V3 -> deepseek-v4-pro nearly doubles the repair floor **15.3% -> 29.3%** [24.5,34.7] on full SWE-bench Lite (same harness). Falsifies "paradigm exhausted regardless of model IQ."

## 0.2.3 — 2026-06-19

- Add `LEARNINGS.md` — the measured findings distilled into harness defaults (repair=2x lever, cost-routing, Barbarian&Scholar tiering, format-contract, batch-eval discipline, capability floor).

## 0.2.2 — 2026-06-19

- **Docs: full SWE-bench Lite (300) evidence ladder** now in the description + README, all official `swebench` Docker harness, batch-verified:
  - open-loop **7.7%** [5.2, 11.2] (ADR-144)
  - + localization **8.0%** [5.4, 11.6] (ADR-146)
  - + closed-loop repair **15.3%** [11.7, 19.8] (ADR-149)
  - + Barbarian&Scholar hybrid (cheap base + frontier-tail escalation) **33.3%** [28.2, 38.8] (ADR-148)
- Blended cost ~$0.01/instance (cheap) → ~$0.34/instance (hybrid) vs $1–20/instance for frontier agents.
- README now links `bench/results/RESULTS.md` (the full reproducible evidence) for npm-only readers.
- `RuvllmMutator` (local/$0 air-gapped mutator, ADR-259) ships in `dist/`.
- Added `bench/swebench/KNOWN_FLAKY.md` (standing `psf__requests-2317` Docker-hang exclusion note).

## 0.2.1 — 2026-06-19

- Metadata: repositioned as "an LLM supercharger and cost optimizer"; keywords/description.

## 0.2.0 — 2026-06-18

- Integrated into the `metaharness` scaffolder (`npm run evolve`, ADR-147).
- Evolutionary stack (mutation + crossover + diverse selection + graded promotion) over a frozen core.

## 0.1.x — 2026-06

- Initial release: frozen-model / evolving-harness over 7 mutation surfaces; deterministic mutator default; `validateGeneratedCode` safety gate; pluggable `CodeGenerator`.
