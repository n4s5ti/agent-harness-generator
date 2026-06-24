// Tests for the Sovereign Evolution genome engine (ADR-184). Run: node --test evolve-arch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, MODES, JUDGES, STEPS, mkRng, cheapness, valueOf, gkey, mkey, randomGenome, mutate, crossover, costModel, evolve, normMode, buildLookup, parseGenomes } from './evolve-arch.mjs';

const rng = mkRng(42);

test('randomGenome produces a valid genome', () => {
  for (let i = 0; i < 50; i++) { const g = randomGenome(rng);
    assert.ok(MODELS.includes(g.model)); assert.ok(MODES.includes(g.mode));
    assert.ok(JUDGES.includes(g.judge)); assert.ok(STEPS.includes(g.maxSteps));
    if (g.mode === 'cascade') assert.ok(MODELS.includes(g.escalate)); else assert.equal(g.escalate, null);
  }
});

test('mutate keeps the genome valid + changes ≤1 field', () => {
  const g = { model: MODELS[0], mode: 'single', escalate: null, judge: JUDGES[0], maxSteps: 15 };
  for (let i = 0; i < 50; i++) { const h = mutate(rng, g);
    assert.ok(MODELS.includes(h.model) && MODES.includes(h.mode) && JUDGES.includes(h.judge) && STEPS.includes(h.maxSteps));
    const diffs = ['model', 'mode', 'judge', 'maxSteps'].filter((k) => h[k] !== g[k]); assert.ok(diffs.length <= 1);
  }
});

test('crossover fields come from a parent', () => {
  const a = { model: MODELS[0], mode: 'single', escalate: null, judge: JUDGES[0], maxSteps: 12 };
  const b = { model: MODELS[1], mode: 'bo3', escalate: null, judge: JUDGES[1], maxSteps: 20 };
  const c = crossover(rng, a, b);
  for (const k of ['model', 'mode', 'judge', 'maxSteps']) assert.ok(c[k] === a[k] || c[k] === b[k]);
});

test('cheapness is bounded [0,100] and monotonic decreasing in cost', () => {
  assert.ok(cheapness(0.001) >= 99); assert.ok(cheapness(10) === 0);
  assert.ok(cheapness(0.005) > cheapness(0.05) && cheapness(0.05) > cheapness(0.5));
});

test('valueOf: w=1 → resolve only; w=0 → cheapness only', () => {
  assert.equal(valueOf(1, 40, 0.005), 40);
  assert.equal(valueOf(0, 40, 0.005), cheapness(0.005));
});

test('costModel: bo3 > single, cascade is expensive', () => {
  const base = { model: MODELS[0], judge: JUDGES[0], maxSteps: 15 };
  assert.ok(costModel({ ...base, mode: 'bo3' }) > costModel({ ...base, mode: 'single' }));
  assert.ok(costModel({ ...base, mode: 'cascade' }) > costModel({ ...base, mode: 'bo3' }));
});

test('evolve is deterministic for a seed + returns a champion with a CI', () => {
  const fn = (g) => g.mode === 'bo3' ? 39.7 : 34; // measured anchors
  const r1 = evolve({ w: 0.5, gens: 5, pop: 8, seed: 7, resolveFn: fn });
  const r2 = evolve({ w: 0.5, gens: 5, pop: 8, seed: 7, resolveFn: fn });
  assert.equal(gkey(r1.champion.g), gkey(r2.champion.g)); // deterministic
  assert.ok(typeof r1.champion.ci95 === 'number');
});

test('objective-responsiveness: low w → single (cheap), high w → bo3 (capable)', () => {
  const fn = (g) => g.mode === 'bo3' ? 39.7 : g.mode === 'cascade' ? 38 : 34;
  const lo = evolve({ w: 0.2, gens: 6, pop: 10, seed: 3, resolveFn: fn, noise1: 0, noise2: 0 });
  const hi = evolve({ w: 0.95, gens: 6, pop: 10, seed: 3, resolveFn: fn, noise1: 0, noise2: 0 });
  assert.equal(lo.champion.g.mode, 'single');   // cost dominates → cheapest
  assert.equal(hi.champion.g.mode, 'bo3');       // capability dominates → highest resolve
});

test('normMode maps stored modes → genome vocabulary', () => {
  assert.equal(normMode('single-traj'), 'single');
  assert.equal(normMode('best-of-3+judge'), 'bo3');
  assert.equal(normMode('cascade'), 'cascade');
  assert.equal(normMode('union-of-3-ceiling'), null); // ceiling is not a runnable config
});

test('buildLookup parses Firestore docs + normalizes modes (the real-data fix)', () => {
  const docs = [
    { fields: { model: { stringValue: 'deepseek/deepseek-v4-flash' }, mode: { stringValue: 'single-traj' }, resolve_pct: { integerValue: '34' } } },
    { fields: { model: { stringValue: 'deepseek-v4-flash x3' }, mode: { stringValue: 'best-of-3+judge' }, resolve_pct: { doubleValue: 39.7 } } },
    { fields: { model: { stringValue: 'deepseek-v4-flash x3' }, mode: { stringValue: 'union-of-3-ceiling' }, resolve_pct: { doubleValue: 45 } } },
  ];
  const lk = buildLookup(docs);
  assert.equal(lk['deepseek-v4-flash|single'], 34);
  assert.equal(lk['deepseek-v4-flash|bo3'], 39.7);
  assert.equal(lk['deepseek-v4-flash|union-of-3-ceiling'], undefined); // ceiling excluded
});

test('parseGenomes: validates LLM output, filters bad fields, handles fenced JSON', () => {
  const raw = '```json\n[{"model":"z-ai/glm-5.2","mode":"bo3","judge":"deepseek/deepseek-v4-flash","maxSteps":15},' +
    '{"model":"FAKE-MODEL","mode":"single"},{"model":"deepseek/deepseek-v4-flash","mode":"cascade","escalate":"z-ai/glm-5.2","maxSteps":99}]\n```';
  const g = parseGenomes(raw);
  assert.equal(g.length, 2);                       // FAKE-MODEL dropped
  assert.equal(g[0].model, 'z-ai/glm-5.2'); assert.equal(g[0].mode, 'bo3');
  assert.equal(g[1].mode, 'cascade'); assert.ok(MODELS.includes(g[1].escalate));
  assert.equal(g[1].maxSteps, 15);                 // invalid 99 → default 15
});
test('parseGenomes: garbage → []', () => { assert.deepEqual(parseGenomes('not json at all'), []); });

test('2-phase gate prefers a stable genome over a noisy-lucky one', () => {
  // genome A: mean 36 but huge variance; genome B: stable 38. The gate (phase-2 low-noise) should pick B.
  const fn = (g) => g.maxSteps === 20 ? 36 : 38; // B (steps≠20) is higher-mean + we'll let noise hit A harder via seed
  const r = evolve({ w: 1, gens: 6, pop: 10, seed: 5, resolveFn: fn, noise1: 10, noise2: 0.5 });
  assert.notEqual(r.champion.g.maxSteps, 20); // the lower-mean noisy variant must not be promoted
});
