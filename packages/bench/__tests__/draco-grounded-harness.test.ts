// SPDX-License-Identifier: MIT
// DRACO grounded harness (ADR-038 arms 5+6 wired into fuseResearch). Proves the
// deterministic grounding pass, fed the harness's OWN retrieved sources as the
// live-mirror pool, makes the final dossier cite only live sources — offline,
// via a mock transport + mock URL checker. No API key, no run.

import { describe, it, expect } from 'vitest';
import { fuseResearch, type FusionModelMap, type OpenRouterTransport } from '../src/draco/fusion.js';
import { poolFromSourceText } from '../src/draco/live-citation.js';
import { extractUrls, type UrlChecker } from '../src/draco/scorer.js';

// "/live" resolves; everything else dead.
const checker: UrlChecker = async (u) => (/\/live/.test(u) ? 'ok' : 'dead');

// Single-model harness map (enforceFusion:false path).
const models: FusionModelMap = {
  decompose: 'anthropic/claude-haiku-4.5',
  search: 'anthropic/claude-haiku-4.5',
  grade: 'anthropic/claude-haiku-4.5',
  synthesize: 'anthropic/claude-haiku-4.5',
  verify: 'anthropic/claude-haiku-4.5',
  cite: 'anthropic/claude-haiku-4.5',
};

// Mock transport: the search/grade stages emit a rich source pool (incl. LIVE
// alternatives), and the synthesize/cite stages emit a dossier whose claims are
// cited by DEAD urls — exactly the scenario arms 5+6 target.
function mockTransport(): OpenRouterTransport {
  const dossier =
    'Solar capacity additions hit a record in 2025 https://grid.example/dead-solar this year. ' +
    'Hydrogen electrolyser costs fell sharply https://h2.example/dead-hydrogen too. ' +
    'Offshore wind stalled on permitting https://wind.example/dead-wind delays.';
  return async (_model, messages) => {
    const sys = messages.find((m) => m.role === 'system')?.content ?? '';
    let text = 'ok';
    if (/sub-queries/i.test(sys)) text = 'solar additions\nhydrogen costs\noffshore wind';
    else if (/list the primary sources/i.test(sys))
      // The retrieved pool — LIVE mirrors for solar + hydrogen exist; wind has none.
      text =
        '- IEA solar additions report https://iea.example/live-solar — solar capacity additions 2025\n' +
        '- IRENA hydrogen electrolyser costs https://irena.example/live-hydrogen — hydrogen electrolyser costs\n';
    else if (/Grade each source/i.test(sys)) text = 'All authoritative and recent. Keep all.';
    else if (/Write the dossier/i.test(sys)) text = dossier;
    else if (/adversarially verify/i.test(sys)) text = 'All SUPPORTED.';
    else if (/Revise the dossier/i.test(sys)) text = dossier;
    else if (/Normalise every citation/i.test(sys)) text = dossier;
    return { text, tokens: 10 };
  };
}

describe('poolFromSourceText', () => {
  it('extracts each URL with the topic terms sharing its line', () => {
    const pool = poolFromSourceText('- IEA solar report https://iea.example/live-solar — solar capacity additions');
    expect(pool).toHaveLength(1);
    expect(pool[0].url).toBe('https://iea.example/live-solar');
    expect(pool[0].supports).toContain('solar');
    expect(pool[0].supports).toContain('capacity');
    expect(pool[0].supports).not.toContain('the'); // stop-word filtered
  });
});

describe('fuseResearch grounding pass (arms 5+6 wired)', () => {
  it('without a checker: behaves exactly as before (dead citations remain)', async () => {
    const r = await fuseResearch({ id: 'q1', prompt: 'energy 2025' }, models, mockTransport(), { enforceFusion: false });
    expect(r.grounding).toBeUndefined();
    expect(r.answer).toContain('dead-solar'); // untouched
  });

  it('with a checker: rescues dead citations via live mirrors from its OWN pool, drops the unmirror­ed claim', async () => {
    const r = await fuseResearch({ id: 'q2', prompt: 'energy 2025' }, models, mockTransport(), {
      enforceFusion: false,
      groundingChecker: checker,
    });
    expect(r.grounding).toBeDefined();
    // solar + hydrogen had live mirrors in the retrieved pool → swapped in
    expect(r.grounding!.mirrorsSwapped).toBe(2);
    // wind had NO live mirror → its claim is honestly dropped
    expect(r.grounding!.claimsDropped).toBe(1);
    // every surviving citation resolves live
    for (const u of extractUrls(r.answer)) expect(await checker(u)).toBe('ok');
    expect(r.answer).toContain('live-solar');
    expect(r.answer).toContain('live-hydrogen');
    expect(r.answer).not.toContain('dead-wind');
    // coverage of rescued claims preserved (terms still present)
    expect(r.answer.toLowerCase()).toContain('solar');
    expect(r.answer.toLowerCase()).toContain('hydrogen');
  });

  it('honesty: the grounding pass never emits a dead citation', async () => {
    const r = await fuseResearch({ id: 'q3', prompt: 'energy 2025' }, models, mockTransport(), {
      enforceFusion: false,
      groundingChecker: checker,
    });
    for (const u of extractUrls(r.answer)) expect(await checker(u)).toBe('ok');
  });
});
