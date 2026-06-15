// SPDX-License-Identifier: MIT
//
// DRACO optimization arm 1 (ADR-038) — AUGMENT-not-replace.
//
// The frontier baseline (ADR-038) showed the 6-stage fusion pipeline DEGRADES
// quality vs a single direct dossier call (harness 0.61 < vanilla 0.71): the
// decompose→grade→synthesize chain rebuilds the dossier from an intermediate
// summary and sheds grounding (re-fetchable URLs). Fusion's verifier recovered
// only ~0.035 of the lost 0.10.
//
// This arm applies the ruflo intelligence pattern (JUDGE → DISTILL) as a REFINE
// pass ON TOP of the strong direct dossier, instead of replacing it:
//
//   1. base   — one strong model writes the cited dossier (= vanilla; KEEPS the
//               grounding the lossy pipeline threw away).
//   2. verify — an INDEPENDENT model family flags ONLY unsupported claims and
//               unconfirmable citations (JUDGE).
//   3. prune  — the base model removes ONLY the flagged spans, returning the
//               rest verbatim (DISTILL). A length guard rejects a prune that
//               collapsed the dossier, so refinement can never lose grounding.
//
// Hypothesis: cleanliness + faithfulness rise (unsupported claims dropped) while
// grounding + coverage are preserved → augmented > vanilla. MEASURED by the
// ablation, never assumed. Dependency-injected transport → offline-testable.

import type { OpenRouterTransport, ChatMessage } from './fusion.js';
import { modelFamily } from './fusion.js';
import { SINGLE_MODEL_PROMPT } from './optimized.js';

export interface AugmentResult {
  questionId: string;
  answer: string;
  totalTokens: number;
  /** Did the prune pass survive the length guard (true) or fall back to base (false)? */
  prunedAdopted: boolean;
}

/**
 * Assert the verifier is an independent family from the base writer — the whole
 * point of the augment pass is an INDEPENDENT check (a same-family verifier
 * rubber-stamps its own blind spots, exactly like the single-model harness).
 */
export function assertAugmentDistinct(baseModel: string, verifyModel: string): void {
  if (modelFamily(baseModel) === modelFamily(verifyModel)) {
    throw new Error(
      `DRACO augment requires the verifier (${verifyModel}) to be a DIFFERENT family than ` +
        `the base writer (${baseModel}); both are "${modelFamily(baseModel)}". A same-family ` +
        `verifier cannot catch the base model's own blind spots (ADR-038).`,
    );
  }
}

const VERIFY_PROMPT =
  'You are an independent, adversarial fact-checker. Read the research dossier ' +
  'below. List ONLY the claims that are UNSUPPORTED by a cited source and the ' +
  'citations you cannot confirm. Quote each offending span exactly. Do NOT ' +
  'rewrite the dossier — only enumerate what should be removed. If everything ' +
  'is supported, reply "NONE".';

const PRUNE_PROMPT =
  'Below is a research dossier and a list of unsupported claims / unconfirmable ' +
  'citations flagged by an independent verifier. Return the dossier with ONLY ' +
  'those flagged spans removed (and any sentence left dangling tidied). Keep ' +
  'every other word, every confirmed citation, and every section VERBATIM. Do ' +
  'NOT summarise, re-research, or add anything. If the flag list is "NONE", ' +
  'return the dossier unchanged.';

/**
 * AUGMENT arm. base (vanilla) → independent verify → prune-only refine.
 * Pure w.r.t. the injected transport.
 */
export async function augmentedResearch(
  question: { id: string; prompt: string },
  opts: {
    baseModel: string;
    verifyModel: string;
    transport: OpenRouterTransport;
    /** Reject a prune that left < this fraction of the base dossier (default 0.5). */
    minRetained?: number;
  },
): Promise<AugmentResult> {
  assertAugmentDistinct(opts.baseModel, opts.verifyModel);
  const minRetained = opts.minRetained ?? 0.5;
  let totalTokens = 0;

  const base = await opts.transport(opts.baseModel, [
    { role: 'system', content: SINGLE_MODEL_PROMPT },
    { role: 'user', content: question.prompt },
  ]);
  totalTokens += base.tokens;

  const verdict = await opts.transport(opts.verifyModel, [
    { role: 'system', content: VERIFY_PROMPT },
    { role: 'user', content: base.text },
  ]);
  totalTokens += verdict.tokens;

  // Fast path: nothing flagged → keep the base dossier as-is (no prune call).
  if (/^\s*none\s*$/i.test(verdict.text.trim())) {
    return { questionId: question.id, answer: base.text, totalTokens, prunedAdopted: false };
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: PRUNE_PROMPT },
    { role: 'user', content: `Dossier:\n${base.text}\n\nFlagged for removal:\n${verdict.text}` },
  ];
  const pruned = await opts.transport(opts.baseModel, messages);
  totalTokens += pruned.tokens;

  // Guard: a prune REMOVES a little; a stage that returned a fraction of the
  // dossier summarised or rebuilt it — reject and keep the grounded base.
  const adopt = pruned.text.length >= base.text.length * minRetained;
  return {
    questionId: question.id,
    answer: adopt ? pruned.text : base.text,
    totalTokens,
    prunedAdopted: adopt,
  };
}
