#!/usr/bin/env node
// ADR-195 — tests for the Phase-2 capability GENES added to the evolve-config genome (localize /
// reproGate / reviewer). Verifies: default-off backward compatibility (keys unchanged), the cap
// suffix is stable + sorted, capFlags maps to solve-agentic flags, and mutate/crossover carry genes.
// No GCP / no spend. Run: node evolve-config-phase2.test.mjs
import assert from 'node:assert';
import {
  normalizeGenome, gkey, readbackKey, mutate, crossover, mkRng, randomGenome,
  capSuffix, capFlags, seedPopulation, PHASE2_CAPS, CAP_FLAGS,
} from './evolve-config.mjs';

let pass = 0; const t = (name, fn) => { try { fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; } };

console.log('evolve-config Phase-2 gene tests:');

t('Phase-2 genes default OFF — keys byte-identical to pre-Phase-2', () => {
  const g = normalizeGenome({ mode: 'single', baseModel: 'z-ai/glm-5.2', maxSteps: 15 });
  assert(g.localize === false && g.reproGate === false && g.reviewer === false && g.traceLocalize === false, 'all default false');
  assert(capSuffix(g) === '', 'no cap suffix when all off');
  assert(gkey(g) === 'single|glm-5.2|s15', `gkey unchanged, got ${gkey(g)}`);
  assert(readbackKey(g) === 'single|glm-5.2', `readbackKey unchanged, got ${readbackKey(g)}`);
});

t('capSuffix is stable + sorted regardless of which genes are on', () => {
  assert(capSuffix(normalizeGenome({ mode: 'single', baseModel: 'z-ai/glm-5.2', localize: true })) === '+loc');
  assert(capSuffix(normalizeGenome({ mode: 'single', baseModel: 'z-ai/glm-5.2', reproGate: true })) === '+repro');
  assert(capSuffix(normalizeGenome({ mode: 'single', baseModel: 'z-ai/glm-5.2', reviewer: true })) === '+rev');
  // ADR-196: execution-trace localization gene
  assert(capSuffix(normalizeGenome({ mode: 'single', baseModel: 'z-ai/glm-5.2', traceLocalize: true })) === '+trace');
  // sorted: loc < repro < rev — order of the input flags must not matter
  const a = normalizeGenome({ mode: 'single', baseModel: 'z-ai/glm-5.2', reviewer: true, localize: true });
  const b = normalizeGenome({ mode: 'single', baseModel: 'z-ai/glm-5.2', localize: true, reviewer: true });
  assert(capSuffix(a) === capSuffix(b) && capSuffix(a) === '+loc+rev', `stable+sorted, got ${capSuffix(a)}`);
});

t('a Phase-2 genome gets a DISTINCT, readback-consistent key', () => {
  const plain = normalizeGenome({ mode: 'single', baseModel: 'anthropic/claude-opus-4.8', maxSteps: 15 });
  const loc = normalizeGenome({ mode: 'single', baseModel: 'anthropic/claude-opus-4.8', maxSteps: 15, localize: true });
  assert(gkey(plain) !== gkey(loc), 'localize genome distinct from plain');
  assert(gkey(loc) === 'single|claude-opus-4.8|s15+loc');
  assert(readbackKey(loc) === 'single|claude-opus-4.8+loc', 'readback carries the same suffix');
});

t('capFlags maps on-genes to solve-agentic CLI flags', () => {
  assert.deepEqual(capFlags(normalizeGenome({ mode: 'single', baseModel: 'z-ai/glm-5.2' })), [], 'none on → no flags');
  assert.deepEqual(capFlags(normalizeGenome({ mode: 'single', baseModel: 'z-ai/glm-5.2', localize: true })), ['--localize']);
  assert.deepEqual(capFlags(normalizeGenome({ mode: 'single', baseModel: 'z-ai/glm-5.2', traceLocalize: true })), ['--trace-localize']);
  const all = capFlags(normalizeGenome({ mode: 'single', baseModel: 'z-ai/glm-5.2', localize: true, reproGate: true, reviewer: true, traceLocalize: true }));
  assert.deepEqual(all, ['--localize', '--repro-gate', '--reviewer', '--trace-localize'], `all flags, got ${JSON.stringify(all)}`);
  // CAP_FLAGS covers every declared capability
  for (const c of PHASE2_CAPS) assert(CAP_FLAGS[c], `flag declared for ${c}`);
});

t('mutate can toggle a Phase-2 gene and always normalizes', () => {
  const rng = mkRng(7);
  let togglesSeen = false;
  const base = normalizeGenome({ mode: 'single', baseModel: 'z-ai/glm-5.2', maxSteps: 15 });
  for (let i = 0; i < 500; i++) {
    const m = mutate(rng, base);
    assert(typeof m.localize === 'boolean' && typeof m.reproGate === 'boolean' && typeof m.reviewer === 'boolean' && typeof m.traceLocalize === 'boolean', 'genes are booleans');
    if (m.localize || m.reproGate || m.reviewer || m.traceLocalize) togglesSeen = true;
  }
  assert(togglesSeen, 'over 500 mutations, the cap mutation eventually turns a gene on');
});

t('crossover inherits each gene independently from a parent', () => {
  const rng = mkRng(13);
  const a = normalizeGenome({ mode: 'single', baseModel: 'z-ai/glm-5.2', localize: true, reviewer: true });
  const b = normalizeGenome({ mode: 'single', baseModel: 'deepseek/deepseek-v3.2', reproGate: true, traceLocalize: true });
  for (let i = 0; i < 300; i++) {
    const c = crossover(rng, a, b);
    // every inherited gene value must have come from one of the parents (true only where a/b had it)
    if (c.localize) assert(a.localize || b.localize, 'localize only from a parent that had it');
    if (c.reproGate) assert(a.reproGate || b.reproGate, 'reproGate only from a parent that had it');
    if (c.reviewer) assert(a.reviewer || b.reviewer, 'reviewer only from a parent that had it');
    if (c.traceLocalize) assert(a.traceLocalize || b.traceLocalize, 'traceLocalize only from a parent that had it');
  }
});

t('seed population includes the three Phase-2 capability probes', () => {
  const keys = seedPopulation().map(gkey);
  assert(keys.some((k) => k.endsWith('+loc')), 'localize probe seeded');
  assert(keys.some((k) => k.endsWith('+repro')), 'reproGate probe seeded');
  assert(keys.some((k) => k.endsWith('+rev')), 'reviewer probe seeded');
  assert(keys.some((k) => k.endsWith('+trace')), 'traceLocalize probe seeded');
  // and the pre-Phase-2 anchors are still present unchanged
  assert(keys.some((k) => k === 'single|claude-opus-4.8|s15'), 'plain full-Opus anchor intact');
});

t('randomGenome always carries boolean Phase-2 genes', () => {
  const rng = mkRng(99);
  for (let i = 0; i < 1000; i++) {
    const g = randomGenome(rng);
    assert(typeof g.localize === 'boolean' && typeof g.reproGate === 'boolean' && typeof g.reviewer === 'boolean' && typeof g.traceLocalize === 'boolean');
  }
});

console.log(`\n${pass} tests passed.`);
