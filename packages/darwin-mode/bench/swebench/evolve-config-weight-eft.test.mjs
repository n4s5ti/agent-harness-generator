#!/usr/bin/env node
// ADR-198 — tests for the `weightAdapter` weight-EFT GENE wired into the evolve-config genome.
// Verifies: default base/no-adapter is BYTE-IDENTICAL (by key) to a pre-gene genome; the +w: suffix is
// stable + only present for a non-base adapter; weightAdapterFlags maps to the cheap-tier solver flag;
// mutate can select an adapter and always normalizes; crossover inherits the gene from a parent; the seed
// population carries the sft / sft-dpo probes AND keeps the pre-gene anchors unchanged.
// No GCP / no spend / no GPU. Run: node evolve-config-weight-eft.test.mjs
import assert from 'node:assert';
import {
  normalizeGenome, gkey, readbackKey, mutate, crossover, mkRng, randomGenome,
  weightAdapterSuffix, weightAdapterFlags, normalizeWeightAdapter, WEIGHT_ADAPTERS, seedPopulation,
} from './evolve-config.mjs';

let pass = 0; const t = (name, fn) => { try { fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; } };

console.log('evolve-config weight-EFT (ADR-198) gene tests:');

t('weightAdapter defaults to BASE — genome key byte-identical to pre-gene', () => {
  const g = normalizeGenome({ mode: 'single', baseModel: 'z-ai/glm-5.2', maxSteps: 15 });
  assert(g.weightAdapter === null, 'default null = base');
  assert(weightAdapterSuffix(g) === '', 'no suffix when base');
  // EXACT pre-gene keys (same assertions as the Phase-2 backward-compat test).
  assert(gkey(g) === 'single|glm-5.2|s15', `gkey unchanged, got ${gkey(g)}`);
  assert(readbackKey(g) === 'single|glm-5.2', `readbackKey unchanged, got ${readbackKey(g)}`);
});

t('base / "" / "none" all normalize to null (indistinguishable from unset)', () => {
  assert(normalizeWeightAdapter(undefined) === null);
  assert(normalizeWeightAdapter('') === null);
  assert(normalizeWeightAdapter('base') === null);
  assert(normalizeWeightAdapter('none') === null);
  assert(normalizeWeightAdapter('sft') === 'sft');
});

t('a selected adapter yields a DISTINCT, stable, readback-consistent key', () => {
  const base = normalizeGenome({ mode: 'ecascade', baseModel: 'z-ai/glm-5.2', escalateModel: 'anthropic/claude-opus-4.8', maxSteps: 15 });
  const sft = normalizeGenome({ mode: 'ecascade', baseModel: 'z-ai/glm-5.2', escalateModel: 'anthropic/claude-opus-4.8', maxSteps: 15, weightAdapter: 'sft' });
  assert(gkey(base) !== gkey(sft), 'adapter genome distinct from base');
  assert(gkey(sft).endsWith('+w:sft'), `gkey carries the suffix, got ${gkey(sft)}`);
  assert(readbackKey(sft).endsWith('+w:sft'), 'readback carries the same suffix');
});

t('the weight-adapter suffix composes with a Phase-2 cap suffix (stable order)', () => {
  const g = normalizeGenome({ mode: 'single', baseModel: 'z-ai/glm-5.2', maxSteps: 15, localize: true, weightAdapter: 'sft-dpo' });
  // cap suffix first (+loc), then weight suffix (+w:sft-dpo) — deterministic.
  assert(gkey(g) === 'single|glm-5.2|s15+loc+w:sft-dpo', `composed key, got ${gkey(g)}`);
});

t('weightAdapterFlags maps a selected adapter to --lora-adapter (base → none)', () => {
  assert.deepEqual(weightAdapterFlags(normalizeGenome({ mode: 'single', baseModel: 'z-ai/glm-5.2' })), []);
  assert.deepEqual(weightAdapterFlags(normalizeGenome({ mode: 'single', baseModel: 'z-ai/glm-5.2', weightAdapter: 'sft' })), ['--lora-adapter', 'sft']);
  assert.deepEqual(weightAdapterFlags(normalizeGenome({ mode: 'single', baseModel: 'z-ai/glm-5.2', weightAdapter: 'sft-dpo' })), ['--lora-adapter', 'sft-dpo']);
});

t('mutate can select a weight adapter and always normalizes', () => {
  const rng = mkRng(11);
  const base = normalizeGenome({ mode: 'ecascade', baseModel: 'z-ai/glm-5.2', escalateModel: 'anthropic/claude-opus-4.8', maxSteps: 15 });
  let adapterSeen = false;
  for (let i = 0; i < 500; i++) {
    const m = mutate(rng, base);
    assert(m.weightAdapter === null || WEIGHT_ADAPTERS.includes(m.weightAdapter), 'gene is a valid adapter value');
    if (m.weightAdapter != null) adapterSeen = true;
  }
  assert(adapterSeen, 'over 500 mutations, the wadapter mutation eventually selects an adapter');
});

t('crossover inherits the weight-adapter gene from a parent', () => {
  const rng = mkRng(23);
  const a = normalizeGenome({ mode: 'single', baseModel: 'z-ai/glm-5.2', weightAdapter: 'sft' });
  const b = normalizeGenome({ mode: 'single', baseModel: 'deepseek/deepseek-v3.2', weightAdapter: 'sft-dpo' });
  for (let i = 0; i < 300; i++) {
    const c = crossover(rng, a, b);
    // the child's adapter must be one of the parents' (or base if normalizeGenome coerced it)
    assert([a.weightAdapter, b.weightAdapter, null].includes(c.weightAdapter), `inherited from a parent, got ${c.weightAdapter}`);
  }
});

t('randomGenome always carries a valid weightAdapter (defaults to base)', () => {
  const rng = mkRng(101);
  for (let i = 0; i < 1000; i++) {
    const g = randomGenome(rng);
    assert(g.weightAdapter === null || WEIGHT_ADAPTERS.includes(g.weightAdapter));
  }
});

t('seed population includes the weight-EFT probes AND keeps anchors unchanged', () => {
  const keys = seedPopulation().map(gkey);
  assert(keys.some((k) => k.endsWith('+w:sft')), 'sft probe seeded');
  assert(keys.some((k) => k.endsWith('+w:sft-dpo')), 'sft-dpo probe seeded');
  // pre-gene anchors still byte-identical (no spurious +w: suffix on the controls)
  assert(keys.some((k) => k === 'single|claude-opus-4.8|s15'), 'plain full-Opus anchor intact');
  assert(keys.some((k) => k === 'ecascade|glm-5.2>claude-opus-4.8|s15'), 'plain glm→opus ecascade anchor intact');
});

console.log(`\n${pass} tests passed.`);
