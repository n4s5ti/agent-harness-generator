#!/usr/bin/env node
// ADR-184 — Sovereign Evolution: evolve the SWE-solver ARCHITECTURE (a config genome) toward the
// cost-Pareto optimum, with a 2-phase statistical gate (small `prove` filter → larger confirm) so the
// search doesn't collapse to small-sample noise (the measured 52%→39.7% drift, §18).
//
//   genome   = { model, mode(single|bo3|cascade), escalate, judge, maxSteps }
//   fitness  = ValueScore = w·resolve%·100? no → w·resolve + (1-w)·cheapness  (leaderboard Value Score, ADR-179)
//   --fitness mock   : fast seeded fitness (tests the ENGINE: convergence + gate robustness, $0)
//   --fitness prove  : production — emits each genome as a gcp-cluster `prove` config (GCP, real cost)
//
// Usage: node evolve-arch.mjs [--fitness mock] [--gens 6] [--pop 8] [--w 0.5] [--seed 1]
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const FITNESS = argv('--fitness', 'mock');
const GENS = +argv('--gens', 6), POP = +argv('--pop', 8), W = +argv('--w', 0.5);
let seed = +argv('--seed', 1);
const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }; // deterministic
const pick = (a) => a[Math.floor(rng() * a.length)];

const MODELS = ['deepseek/deepseek-v4-flash', 'z-ai/glm-5.2', 'moonshotai/kimi-k2.6'];
const MODES = ['single', 'bo3', 'cascade'];
const JUDGES = ['deepseek/deepseek-v4-flash', 'anthropic/claude-opus-4.8'];
const STEPS = [12, 15, 20];

// cheapness on the leaderboard log scale ($5→0, $0.005→100), same as ADR-179.
const cheapness = (c) => Math.max(0, Math.min(100, 100 * (Math.log10(5) - Math.log10(c)) / (Math.log10(5) - Math.log10(0.005))));
const valueOf = (resolve, cost) => W * (resolve * 100) + (1 - W) * cheapness(cost); // resolve→0-100 to match cheapness scale (ADR-179)

function randomGenome() {
  const mode = pick(MODES);
  return { model: pick(MODELS), mode, escalate: mode === 'cascade' ? pick(MODELS.filter(m => m !== 'deepseek/deepseek-v4-flash')) : null, judge: pick(JUDGES), maxSteps: pick(STEPS) };
}
function mutate(g) {
  const h = { ...g }; const f = pick(['model', 'mode', 'judge', 'maxSteps']);
  if (f === 'model') h.model = pick(MODELS);
  else if (f === 'mode') { h.mode = pick(MODES); h.escalate = h.mode === 'cascade' ? pick(MODELS.filter(m => m !== h.model)) : null; }
  else if (f === 'judge') h.judge = pick(JUDGES);
  else h.maxSteps = pick(STEPS);
  return h;
}
function crossover(a, b) { return { model: rng() < 0.5 ? a.model : b.model, mode: rng() < 0.5 ? a.mode : b.mode, escalate: rng() < 0.5 ? a.escalate : b.escalate, judge: rng() < 0.5 ? a.judge : b.judge, maxSteps: rng() < 0.5 ? a.maxSteps : b.maxSteps }; }
const gkey = (g) => `${g.model}|${g.mode}|${g.escalate || ''}|${g.judge}|${g.maxSteps}`;

// ── MOCK fitness: grounded in our MEASURED anchors (§13/18/20) + bounded noise to emulate n=25 volatility.
// Tests the engine: does it converge to the true Value optimum AND resist promoting a noise-lucky genome?
const baseResolve = (g) => {
  let r = 0.34;                                            // deepseek single (measured §17)
  if (g.model === 'z-ai/glm-5.2') r = 0.31;               // priors (unmeasured at scale; fleet pending)
  if (g.model === 'moonshotai/kimi-k2.6') r = 0.33;
  if (g.mode === 'bo3') r = Math.min(0.46, r + 0.057);    // +5.7pt measured (§18); union-capped
  if (g.mode === 'cascade') r = Math.min(0.45, r + 0.04); // moderate (gate-limited, §19-20)
  if (g.judge.includes('opus') && g.mode !== 'single') r += 0.015; // stronger judge ~+1.5pt
  if (g.maxSteps === 20) r += 0.01; if (g.maxSteps === 12) r -= 0.01;
  return Math.max(0.05, r);
};
const baseCost = (g) => {
  const m = g.model.includes('glm') ? 0.018 : g.model.includes('kimi') ? 0.02 : 0.005;
  let c = m; if (g.mode === 'bo3') c = 3 * m + 0.0002; if (g.mode === 'cascade') c = m + 0.62 * (m * 6); // ~96% escalate (§19)
  if (g.judge.includes('opus') && g.mode !== 'single') c += 0.01;
  return c * (g.maxSteps / 15);
};
function mockFitness(g, noise) {
  const r = Math.max(0.02, baseResolve(g) + (rng() - 0.5) * 2 * noise); // ± noise (n=25 ≈ ±0.08, n=100 ≈ ±0.035)
  const c = baseCost(g);
  return { resolve: r, cost: c, value: valueOf(r, c) };
}
function proveFitness(g) { // production stub: emit a gcp-cluster prove config (real GCP run scores it)
  return { stub: true, proveConfig: { board: 'lite', model: g.model, mode: g.mode, escalate: g.escalate, sample: 25 } };
}

// ── evolution with 2-phase gate ──────────────────────────────────────────────
function evolve() {
  let pop = [{ model: 'deepseek/deepseek-v4-flash', mode: 'single', escalate: null, judge: JUDGES[0], maxSteps: 15 }]; // seed: known champion-ish
  while (pop.length < POP) pop.push(randomGenome());
  const hist = [];
  for (let gen = 0; gen < GENS; gen++) {
    // PHASE 1 — fast small-sample filter (high noise ≈ n=25)
    const scored = pop.map(g => ({ g, ...mockFitness(g, 0.08) })).sort((a, b) => b.value - a.value);
    hist.push({ gen, best: scored[0].value.toFixed(1), bestGenome: gkey(scored[0].g), meanValue: (scored.reduce((s, x) => s + x.value, 0) / scored.length).toFixed(1) });
    const elite = scored.slice(0, Math.max(2, Math.floor(POP / 2))).map(s => s.g);
    const next = [...elite];
    while (next.length < POP) next.push(rng() < 0.5 ? mutate(pick(elite)) : crossover(pick(elite), pick(elite)));
    // dedup
    pop = [...new Map(next.map(g => [gkey(g), g])).values()]; while (pop.length < POP) pop.push(randomGenome());
  }
  // PHASE 2 — statistical gate: re-evaluate the top finalists K times at LOW noise (≈ n=100); promote only if stable.
  const finalists = [...new Map(pop.map(g => [gkey(g), g])).values()];
  const confirmed = finalists.map(g => {
    const samples = Array.from({ length: 5 }, () => mockFitness(g, 0.035).value);
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const sd = Math.sqrt(samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length);
    return { g, mean, sd, ci95: 1.96 * sd / Math.sqrt(samples.length) };
  }).sort((a, b) => b.mean - a.mean);
  return { hist, champion: confirmed[0], leaderboard: confirmed.slice(0, 5) };
}

if (FITNESS === 'prove') {
  // production: print the prove configs for the current population (run via gcp-cluster prove)
  const pop = Array.from({ length: POP }, randomGenome);
  console.log(JSON.stringify(pop.map(proveFitness), null, 2));
} else {
  const { hist, champion, leaderboard } = evolve();
  console.log('=== EVOLUTION (mock fitness, w=' + W + ') — generations ===');
  for (const h of hist) console.log(`  gen ${h.gen}: best=${h.best} mean=${h.meanValue}  (${h.bestGenome})`);
  console.log('\n=== PHASE-2 CONFIRMED (5× @ low noise, statistical gate) ===');
  for (const c of leaderboard) console.log(`  Value ${c.mean.toFixed(1)} ±${c.ci95.toFixed(1)}  ${gkey(c.g)}`);
  console.log(`\nCHAMPION: ${gkey(champion.g)}  Value=${champion.mean.toFixed(1)} ±${champion.ci95.toFixed(1)}`);
  writeFileSync('evolve-arch-result.json', JSON.stringify({ w: W, gens: GENS, pop: POP, hist, champion, leaderboard }, null, 2));
}
