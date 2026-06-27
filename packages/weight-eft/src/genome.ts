// SPDX-License-Identifier: MIT
//
// genome.ts — the `weightAdapter` genome gene.
//
// This is the bridge that lets Darwin evolution SELECT among LoRA adapters
// (the evolutionary prune-the-overfitter safety net). The Darwin genome stays
// gradient-FREE policy evolution; this gene adds a single reference to a tuned
// weight adapter so an evolved config can run the cheap tier with-or-without a
// distilled adapter, and let selection decide.
//
// SAFETY-NET RATIONALE: a LoRA tune can overfit (memorize the SFT set, regress
// on held-out). Rather than trust the tune blindly, we make the adapter a GENE:
// base (no adapter) competes against SFT-only / SFT+DPO / ratio variants under
// the same conformant fitness, and evolution prunes an adapter that doesn't
// actually lift held-out resolve. The default is ALWAYS base/no-adapter, so a
// genome that never opts into an adapter is byte-identical to a pre-gene genome.
//
// The CONCRETE wiring into darwin-mode's evolve-config genome lives in
// packages/darwin-mode/bench/swebench/evolve-config.mjs (the WEIGHT_ADAPTERS /
// normalizeWeightAdapter / weightAdapterFlags helpers + the mutate/crossover/
// seed integration). This module is the typed SPEC + reference implementation
// of the gene's semantics, so the cross-package contract is testable from here.

/**
 * The value of the `weightAdapter` gene. `null` (or absent) === BASE: the cheap
 * tier runs with no LoRA adapter — the pre-gene default, byte-identical key.
 * A string is an adapter id (e.g. "glm5.2-sft", "glm5.2-sft-dpo").
 */
export type WeightAdapterGene = string | null;

/** The canonical "no adapter" sentinel. Absent gene === BASE === this. */
export const BASE_ADAPTER: WeightAdapterGene = null;

/**
 * The adapter variants Darwin evolution may choose among. BASE is always first
 * (the control). The tuned variants reference adapters the runner produced:
 * SFT-only and SFT+DPO are the two recipes; a ratio variant blends adapter
 * strength. ALL are inert until an actual adapter is trained (GPU job) — the
 * gene only NAMES an adapter; it does not create one.
 */
export const WEIGHT_ADAPTERS: WeightAdapterGene[] = [
  BASE_ADAPTER, // control — no adapter (the safety-net baseline)
  'sft', // SFT-distill only
  'sft-dpo', // SFT then on-policy DPO
];

/**
 * Normalize a raw gene value. Absent / '' / 'base' / 'none' all coerce to BASE
 * so an unset gene is indistinguishable from an explicit base choice — that's
 * what keeps pre-gene genomes byte-identical.
 */
export function normalizeWeightAdapter(v: unknown): WeightAdapterGene {
  if (v == null) return BASE_ADAPTER;
  if (typeof v !== 'string') return BASE_ADAPTER;
  const s = v.trim().toLowerCase();
  if (s === '' || s === 'base' || s === 'none') return BASE_ADAPTER;
  return v.trim();
}

/**
 * Stable key fragment for a genome's adapter choice. Empty string for BASE so
 * the gene contributes NOTHING to a genome key unless an adapter is selected —
 * the backward-compatibility invariant (a base-adapter genome keys identically
 * to a pre-gene genome).
 */
export function weightAdapterSuffix(gene: WeightAdapterGene): string {
  const norm = normalizeWeightAdapter(gene);
  return norm == null ? '' : `+w:${norm}`;
}

/**
 * Map an adapter gene to the CLI flag the cheap-tier solver forwards. BASE
 * emits NO flag (runs the stock model). A tuned adapter emits `--lora-adapter
 * <id>` (the solver loads the adapter onto the cheap base before solving).
 */
export function weightAdapterFlags(gene: WeightAdapterGene): string[] {
  const norm = normalizeWeightAdapter(gene);
  return norm == null ? [] : ['--lora-adapter', norm];
}

/** True iff the gene selects a real adapter (not base). */
export function usesAdapter(gene: WeightAdapterGene): boolean {
  return normalizeWeightAdapter(gene) != null;
}
