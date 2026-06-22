# ADR-171: Web-UI — surface Darwin capabilities + model-tier configuration

**Status**: Accepted — implementing in `apps/web-ui`
**Date**: 2026-06-22
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-022 (composable primitives), ADR-148/152/154 (tiered escalation), ADR-153/169/170
(agentic loop, self-learning, PTY), the live Studio at https://ruvnet.github.io/agent-harness-generator

## Context

A live browser review of the deployed MetaHarness Studio (GitHub Pages) found:
- **Kernel options** exposes three `<select>` dropdowns — MEMORY (AgentDB/SQLite/In-memory), ROUTING
  (3-tier/Single-tier), MARKETPLACE (Powered-by/Independent).
- ROUTING says "3-tier" but **the user cannot choose which models** back the tiers. The whole Darwin
  result — cheap base → Scholar → Sage — is a *model-tier* story, and the UI hides it.
- An `evolve` command and an "Exotic / Self-Evolving" template exist, but there is **no Darwin
  (frozen-model / evolving-harness) configuration block** — no way to enable the evolutionary loop,
  pick mutation surfaces, set a generation budget, or choose the sandbox tier.
- The single long scroll (hosts → 20 templates → ~80 compose chips → kernel → primitives) is dense;
  the model/Darwin config belongs in its own clearly-labeled, dropdown-driven group.

## Decision

Extend the browser generator's data model + form so the configuration the Studio captures matches what
the harness actually runs:

1. **Model-tier selectors (dropdowns).** Add a `models: { barbarian, scholar, sage }` field to
   `HarnessConfig`, each a `<select>` over a curated `MODEL_CATALOG` (deepseek-v4-pro, deepseek-chat,
   gpt-5-mini, gpt-5, claude-haiku-4.5, claude-sonnet-4, claude-opus-4, plus a `local/ollama`
   $0 option). Scholar+Sage selectors render only when `routing === '3-tier'`; single-tier shows just
   the base. Defaults match the validated ladder (barbarian=deepseek-v4-pro, scholar=sonnet-4,
   sage=opus-4).
2. **Darwin / self-evolution block.** Add `darwin: { enabled, surfaces, generations, sandbox }`.
   When enabled: surface chips over the 7 ADR-071 mutation surfaces (planner, contextBuilder, reviewer,
   retryPolicy, toolPolicy, memoryPolicy, scorePolicy), a generations dropdown (5/10/25/50), and a
   sandbox-tier dropdown (mock $0 / real / agent). Off by default — opt-in, like every primitive.
3. **Emit it for real.** The choices thread into the generated artifacts (CLAUDE.md kernel block +
   `.harness/manifest.json` vars), so the download is not UI-only — the CLI/kernel would accept it
   verbatim, consistent with the existing config round-trip.

## Rationale
- The model tiers ARE the product story (ADR-154's 58.3% is a 3-model blend); hiding them
  under an opaque "3-tier" label undersells the harness and blocks cost/quality tuning.
- Darwin is the headline differentiator (frozen model, evolving harness) yet was absent from the
  builder. Surfacing it — gated, safe-by-default — closes the gap between the docs and the Studio.
- Dropdowns over a curated catalog keep the surface small and prevent typos, matching the existing
  Kernel-options idiom (no new UI paradigm).

## Consequences
- `HarnessConfig` gains two fields; defaults keep existing downloads byte-stable except the new block.
- The form stays 100% client-side (no model calls in the browser) — model ids are configuration only.
- Follow-up: a deeper Darwin "run preview" (read-only RESULTS ladder) could live behind the evolve
  command; out of scope here. The page is deployed via the existing Pages build on merge to main.
