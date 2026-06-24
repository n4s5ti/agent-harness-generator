#!/usr/bin/env node
// ADR-184 — Sovereign Evolution: evolve the SWE-solver ARCHITECTURE (a config genome) toward the
// cost-Pareto optimum, with a 2-phase statistical gate so the search doesn't collapse to small-sample
// noise (the measured 52%→39.7% drift, §18). Exports pure pieces for tests; CLI-guarded at the bottom.
//
//   genome  = { model, mode(single|bo3|cascade), escalate, judge, maxSteps }
//   fitness = ValueScore = w·resolve% + (1-w)·cheapness   (leaderboard Value Score, ADR-179)
//   --fitness mock      : seeded fitness grounded in measured anchors (engine self-test, $0)
//   --fitness firestore : REAL — reads measured resolve from Firestore darwin_runs; unmeasured genomes
//                         are emitted as `prove` jobs (run on GCP → Firestore → next generation)
import { execSync } from 'node:child_process';

export const MODELS = ['deepseek/deepseek-v4-flash', 'z-ai/glm-5.2', 'moonshotai/kimi-k2.6', 'deepseek/deepseek-v3.2', 'minimax/minimax-m2.5'];
export const MODES = ['single', 'bo3', 'cascade', 'xbo']; // xbo = cross-model Best-of-N (model = comma-list of DIFFERENT models)
export const JUDGES = ['deepseek/deepseek-v4-flash', 'anthropic/claude-opus-4.8'];
export const STEPS = [12, 15, 20];

export const mkRng = (s) => () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
export const cheapness = (c) => Math.max(0, Math.min(100, 100 * (Math.log10(5) - Math.log10(c)) / (Math.log10(5) - Math.log10(0.005))));
export const valueOf = (w, resolvePct, cost) => w * resolvePct + (1 - w) * cheapness(cost); // both 0-100
export const gkey = (g) => `${g.model}|${g.mode}|${g.escalate || ''}|${g.judge}|${g.maxSteps}`;
// the {model,mode} key Firestore measures by (judge/steps are secondary dims). xbo keys on the model SET.
export const mkey = (g) => g.mode === 'xbo'
  ? `xbo|${String(g.model).replace(/^xbo:/, '').split(',').map((m) => m.split('/').pop()).sort().join('+')}`
  : `${g.model.split('/').pop()}|${g.mode}`;

const pickW = (rng, a) => a[Math.floor(rng() * a.length)];
// pick K distinct models, comma-joined (for xbo cross-model Best-of-N)
function pickModels(rng, k) { const pool = [...MODELS]; const out = []; for (let i = 0; i < k && pool.length; i++) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]); return out.join(','); }
function modelFor(rng, mode) { return mode === 'xbo' ? pickModels(rng, 2 + Math.floor(rng() * 2)) : pickW(rng, MODELS); }
export function randomGenome(rng) {
  const mode = pickW(rng, MODES);
  return { model: modelFor(rng, mode), mode, escalate: mode === 'cascade' ? pickW(rng, MODELS) : null, judge: pickW(rng, JUDGES), maxSteps: pickW(rng, STEPS) };
}
export function mutate(rng, g) {
  const h = { ...g }; const f = pickW(rng, ['model', 'mode', 'judge', 'maxSteps']);
  if (f === 'model') h.model = modelFor(rng, h.mode);
  else if (f === 'mode') { h.mode = pickW(rng, MODES); h.model = modelFor(rng, h.mode); h.escalate = h.mode === 'cascade' ? pickW(rng, MODELS.filter((m) => m !== h.model)) : null; }
  else if (f === 'judge') h.judge = pickW(rng, JUDGES);
  else h.maxSteps = pickW(rng, STEPS);
  return h;
}
export function crossover(rng, a, b) { return { model: rng() < 0.5 ? a.model : b.model, mode: rng() < 0.5 ? a.mode : b.mode, escalate: rng() < 0.5 ? a.escalate : b.escalate, judge: rng() < 0.5 ? a.judge : b.judge, maxSteps: rng() < 0.5 ? a.maxSteps : b.maxSteps }; }

// per-single-model priors (cost $/inst, resolve %) — real data overrides these via Firestore.
export const baseCost = (m) => m.includes('glm') ? 0.018 : m.includes('kimi') ? 0.02 : m.includes('v3.2') ? 0.012 : m.includes('minimax') ? 0.012 : m.includes('opus') ? 0.5 : 0.005;
export const singleResolve = (m) => m.includes('glm') ? 31 : m.includes('kimi') ? 33 : m.includes('v3.2') ? 34 : m.includes('minimax') ? 32 : m.includes('opus') ? 60 : 34;
// deterministic cost model (mode/model) — cost is calculable; resolve is the measured part.
export function costModel(g) {
  if (g.mode === 'xbo') { let c = g.model.split(',').reduce((s, m) => s + baseCost(m), 0) + 0.0002; if ((g.judge || '').includes('opus')) c += 0.01; return c * (g.maxSteps / 15); }
  const m = baseCost(g.model);
  let c = m; if (g.mode === 'bo3') c = 3 * m + 0.0002; if (g.mode === 'cascade') c = m + 0.62 * (m * 6);
  if ((g.judge || '').includes('opus') && g.mode !== 'single') c += 0.01;
  return c * (g.maxSteps / 15);
}

// ── MOCK fitness: measured anchors (§13/18/20) + priors + bounded noise (engine self-test) ──
export function mockResolve(g) {
  if (g.mode === 'xbo') { const rs = g.model.split(',').map(singleResolve); return Math.min(55, Math.max(...rs) + 6); } // orthogonality union-capture bonus
  let r = singleResolve(g.model);
  if (g.mode === 'bo3') r = Math.min(46, r + 5.7); if (g.mode === 'cascade') r = Math.min(45, r + 4);
  if ((g.judge || '').includes('opus') && g.mode !== 'single') r += 1.5;
  if (g.maxSteps === 20) r += 1; if (g.maxSteps === 12) r -= 1;
  return Math.max(5, r);
}

// ── FIRESTORE fitness: real measured resolve from darwin_runs (model|mode → resolve%) ──
// normalize stored mode strings → genome vocabulary (single|bo3|cascade); null = not a runnable config (e.g. ceiling)
export function normMode(m) {
  m = (m || '').toLowerCase();
  if (/union|ceiling/.test(m)) return null;          // oracle ceiling, not a config
  if (/bo3|best-of-3|best of 3/.test(m)) return 'bo3';
  if (/cascade/.test(m)) return 'cascade';
  if (/single/.test(m)) return 'single';
  return m || 'single';
}
export function buildLookup(docs) {
  const lookup = {};
  for (const d of docs) {
    const f = d.fields; const model = f.model?.stringValue || ''; const mode = normMode(f.mode?.stringValue);
    const pct = f.resolve_pct?.doubleValue ?? (f.resolve_pct?.integerValue && +f.resolve_pct.integerValue);
    if (model && mode && pct != null) {
      const k = mode === 'xbo'
        ? `xbo|${model.replace(/^xbo:/, '').split(',').map((m) => m.split('/').pop()).sort().join('+')}`
        : `${model.split('/').pop().replace(/ .*/, '')}|${mode}`;
      lookup[k] = Math.max(lookup[k] ?? 0, pct);
    }
  }
  return lookup;
}
export function fetchFirestoreLookup(project = 'cognitum-20260110') {
  const token = execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
  const out = execSync(`curl -s -H "Authorization: Bearer ${token}" "https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/darwin_runs?pageSize=200"`, { encoding: 'utf8', maxBuffer: 1 << 24 });
  return buildLookup(JSON.parse(out).documents || []);
}

// ── LLM-as-mutation-operator: given the measured frontier + Value formula, propose INFORMED genomes ──
// (complements blind GA mutation; shrinks the search space. NEVER used for promotion — stats decide that.)
export function parseGenomes(raw) {
  let arr; try { arr = JSON.parse(raw.replace(/^```(json)?\n?|\n?```$/g, '').trim()); } catch { const m = raw.match(/\[[\s\S]*\]/); arr = m ? JSON.parse(m[0]) : []; }
  if (!Array.isArray(arr)) return [];
  const norm = (g) => Array.isArray(g.models) ? g.models.join(',') : g.model; // accept {models:[...]} for xbo
  const okModel = (g) => g.mode === 'xbo'
    ? (typeof norm(g) === 'string' && norm(g).split(',').length >= 2 && norm(g).split(',').every((m) => MODELS.includes(m)))
    : MODELS.includes(g.model);
  return arr.filter((g) => g && MODES.includes(g.mode) && okModel(g) && (!g.judge || JUDGES.includes(g.judge)))
    .map((g) => ({ model: norm(g), mode: g.mode, escalate: g.mode === 'cascade' ? (MODELS.includes(g.escalate) ? g.escalate : MODELS[1]) : null, judge: JUDGES.includes(g.judge) ? g.judge : JUDGES[0], maxSteps: STEPS.includes(g.maxSteps) ? g.maxSteps : 15 }));
}
export async function llmPropose(lookup, { w = 0.7, n = 4, model = 'deepseek/deepseek-v4-flash', key } = {}) {
  key = (key || process.env.OPENROUTER_API_KEY || '').trim(); if (!key) return [];
  const frontier = Object.entries(lookup).map(([k, v]) => `${k}: ${v}% resolve`).join('\n') || '(none yet)';
  const prompt = `You are the mutation operator of an architecture search optimizing a SWE-bench solver for VALUE = ${w}·resolve% + ${1 - w}·cheapness (cheapness = log-scaled, $5/inst→0, $0.005/inst→100).\n\nGenome fields: model ∈ ${JSON.stringify(MODELS)}; mode ∈ ${JSON.stringify(MODES)}:\n- single: cheapest, 1 trajectory\n- bo3: same model ×3 temps + judge (3× cost, +~6pt resolve)\n- cascade: cheap then escalate (expensive)\n- xbo: CROSS-MODEL Best-of-N — set "model" to a comma-list of 2-3 DIFFERENT models; orthogonal failure modes raise the UNION ceiling. Cost = sum of the distinct models' base costs.\nescalate (cascade only) ∈ models; judge ∈ ${JSON.stringify(JUDGES)}; maxSteps ∈ ${JSON.stringify(STEPS)}.\n\nMeasured frontier (resolve%, all n=25 noisy):\n${frontier}\n\nPropose ${n} NEW genomes (not already measured) most likely to maximize VALUE — reason about cost vs capability (e.g. mix orthogonal cheap models in xbo to capture a richer union without paying frontier prices). Reply ONLY a JSON array of {model,mode,escalate,judge,maxSteps} (for xbo, model is the comma-list).`;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', signal: AbortSignal.timeout(60000), headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 800, temperature: 0.4 }) });
    const j = await res.json(); const proposed = parseGenomes(j.choices?.[0]?.message?.content ?? '');
    return proposed.filter((g) => lookup[mkey(g)] == null); // only unmeasured
  } catch { return []; }
}

// ── evolution with 2-phase statistical gate ──
export function evolve({ w = 0.5, gens = 6, pop = 8, seed = 1, resolveFn, noise1 = 8, noise2 = 3.5 }) {
  const rng = mkRng(seed);
  let P = [{ model: 'deepseek/deepseek-v4-flash', mode: 'single', escalate: null, judge: JUDGES[0], maxSteps: 15 }];
  while (P.length < pop) P.push(randomGenome(rng));
  const score = (g, noise) => { const r = Math.max(2, resolveFn(g) + (rng() - 0.5) * 2 * noise); return valueOf(w, r, costModel(g)); };
  const hist = [];
  for (let gen = 0; gen < gens; gen++) {
    const scored = P.map((g) => ({ g, value: score(g, noise1) })).sort((a, b) => b.value - a.value); // phase 1: noisy filter
    hist.push({ gen, best: +scored[0].value.toFixed(1), bestGenome: gkey(scored[0].g) });
    const elite = scored.slice(0, Math.max(2, Math.floor(pop / 2))).map((s) => s.g);
    const next = [...elite];
    while (next.length < pop) next.push(rng() < 0.5 ? mutate(rng, pickW(rng, elite)) : crossover(rng, pickW(rng, elite), pickW(rng, elite)));
    P = [...new Map(next.map((g) => [gkey(g), g])).values()]; while (P.length < pop) P.push(randomGenome(rng));
  }
  // phase 2: re-evaluate finalists K× at low noise; rank by confirmed mean ± CI (over-fitting guard)
  const confirmed = [...new Map(P.map((g) => [gkey(g), g])).values()].map((g) => {
    const s = Array.from({ length: 5 }, () => score(g, noise2)); const mean = s.reduce((a, b) => a + b) / s.length;
    const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length);
    return { g, mean, ci95: 1.96 * sd / Math.sqrt(s.length) };
  }).sort((a, b) => b.mean - a.mean);
  return { hist, champion: confirmed[0], leaderboard: confirmed.slice(0, 6) };
}

// ── CLI (guarded so imports don't execute) ──
if (process.argv[1] && process.argv[1].endsWith('evolve-arch.mjs')) {
  const args = process.argv.slice(2); const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
  const FITNESS = argv('--fitness', 'mock'), w = +argv('--w', 0.5), gens = +argv('--gens', 6), pop = +argv('--pop', 8), seed = +argv('--seed', 1);
  let resolveFn = mockResolve; let lookup = null;
  if (FITNESS === 'firestore') {
    lookup = fetchFirestoreLookup();
    console.error(`firestore lookup: ${Object.keys(lookup).length} measured combos: ${JSON.stringify(lookup)}`);
    const unmeasured = new Set();
    resolveFn = (g) => { const v = lookup[mkey(g)]; if (v == null) { unmeasured.add(mkey(g)); return mockResolve(g); } return v; }; // measured where known, prior elsewhere
    process.on('exit', () => { if (unmeasured.size) console.error(`\nUNMEASURED (emit as prove jobs): ${[...unmeasured].join(', ')}`); });
  }
  const { hist, champion, leaderboard } = evolve({ w, gens, pop, seed, resolveFn });
  console.log(`=== EVOLUTION (${FITNESS} fitness, w=${w}) ===`);
  for (const h of hist) console.log(`  gen ${h.gen}: best=${h.best}  ${h.bestGenome}`);
  console.log('\n=== PHASE-2 CONFIRMED (statistical gate) ===');
  for (const c of leaderboard) console.log(`  Value ${c.mean.toFixed(1)} ±${c.ci95.toFixed(1)}  ${gkey(c.g)}`);
  console.log(`\nCHAMPION: ${gkey(champion.g)}  Value=${champion.mean.toFixed(1)} ±${champion.ci95.toFixed(1)}`);
  execSync(`true`); // noop
}
