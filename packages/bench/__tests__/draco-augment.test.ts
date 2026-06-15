// SPDX-License-Identifier: MIT
// DRACO augment arm (ADR-038) — offline, mock-transport tests.

import { describe, it, expect, vi } from 'vitest';
import { augmentedResearch, assertAugmentDistinct } from '../src/draco/augment.js';
import type { OpenRouterTransport } from '../src/draco/fusion.js';

const Q = { id: 'sci-001', prompt: 'What is the evidence for X?' };

describe('assertAugmentDistinct', () => {
  it('throws when base + verify are the same family', () => {
    expect(() => assertAugmentDistinct('anthropic/claude-opus-4', 'anthropic/claude-haiku-4.5')).toThrow(
      /DIFFERENT family/,
    );
  });
  it('accepts distinct families', () => {
    expect(() => assertAugmentDistinct('anthropic/claude-opus-4', 'openai/gpt-5')).not.toThrow();
  });
});

describe('augmentedResearch — base → verify → prune', () => {
  it('adopts the pruned dossier when it survives the length guard', async () => {
    const base = 'A grounded dossier with claim1 [src1] and claim2 [src2]. '.repeat(4);
    const pruned = 'A grounded dossier with claim1 [src1]. '.repeat(4); // ~65% of base
    const transport = vi.fn(async (model: string) => {
      if (model === 'anthropic/claude-opus-4' /* base or prune */) {
        // first opus call = base, second opus call = prune
        return transport.mock.calls.filter((c) => c[0] === 'anthropic/claude-opus-4').length === 1
          ? { text: base, tokens: 100 }
          : { text: pruned, tokens: 40 };
      }
      return { text: 'claim2 [src2] is UNSUPPORTED', tokens: 20 }; // verify (gpt-5)
    }) as unknown as OpenRouterTransport & { mock: { calls: unknown[][] } };
    const r = await augmentedResearch(Q, {
      baseModel: 'anthropic/claude-opus-4',
      verifyModel: 'openai/gpt-5',
      transport,
    });
    expect(r.prunedAdopted).toBe(true);
    expect(r.answer).toBe(pruned);
    expect(r.totalTokens).toBe(160);
  });

  it('falls back to base when the prune collapsed the dossier (length guard)', async () => {
    const base = 'X'.repeat(1000);
    const collapsed = 'X'.repeat(100); // 10% — below the 0.5 guard
    let opusCalls = 0;
    const transport = (async (model: string) => {
      if (model === 'anthropic/claude-opus-4') {
        opusCalls++;
        return opusCalls === 1 ? { text: base, tokens: 100 } : { text: collapsed, tokens: 10 };
      }
      return { text: 'something UNSUPPORTED', tokens: 20 };
    }) as OpenRouterTransport;
    const r = await augmentedResearch(Q, {
      baseModel: 'anthropic/claude-opus-4',
      verifyModel: 'openai/gpt-5',
      transport,
    });
    expect(r.prunedAdopted).toBe(false);
    expect(r.answer).toBe(base); // grounding preserved
  });

  it('skips the prune call entirely when the verifier returns NONE', async () => {
    const base = 'A fully supported dossier [src1].';
    let opusCalls = 0;
    const transport = (async (model: string) => {
      if (model === 'anthropic/claude-opus-4') {
        opusCalls++;
        return { text: base, tokens: 100 };
      }
      return { text: 'NONE', tokens: 5 };
    }) as OpenRouterTransport;
    const r = await augmentedResearch(Q, {
      baseModel: 'anthropic/claude-opus-4',
      verifyModel: 'openai/gpt-5',
      transport,
    });
    expect(r.answer).toBe(base);
    expect(opusCalls).toBe(1); // base only — no prune call
    expect(r.totalTokens).toBe(105); // base + verify, no prune
  });
});
