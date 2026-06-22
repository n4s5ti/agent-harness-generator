// SPDX-License-Identifier: MIT
// ADR-169 E2 — evaluate the difficulty router on REAL E1 labels (the cheap
// agentic tier's 104/300 resolved outcomes). $0, offline, deterministic. Honest
// out-of-sample test: 5-fold CV of the scalar-feature L2 logistic regression vs
// the majority-class baseline, plus a dry-run of how much frontier escalation
// spend a confidence gate could have saved on the E1 failure tail.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURE_NAMES, extractFeatures, standardize, trainLogReg, predictProba } from './difficulty-router.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const rd = (p) => JSON.parse(readFileSync(join(HERE, p), 'utf8'));

const insts = rd('full-300.json').instances;
const e1 = new Set(rd('e1-agentic-v4pro-300-report.json').resolved_ids || []);
// repo prior = leave-this-instance-out cheap resolve rate per repo (no leakage of self label).
const repoOf = (i) => i.repo || String(i.instance_id).split('__')[0];
const byRepo = new Map();
for (const i of insts) { const r = repoOf(i); if (!byRepo.has(r)) byRepo.set(r, { n: 0, res: 0 }); const s = byRepo.get(r); s.n++; if (e1.has(i.instance_id)) s.res++; }

const rows = insts.map((i) => {
  const r = repoOf(i);
  const s = byRepo.get(r);
  const y = e1.has(i.instance_id) ? 1 : 0;
  // leave-one-out repo prior so the label of THIS instance doesn't leak into its own feature
  const prior = s.n > 1 ? (s.res - y) / (s.n - 1) : 0.15;
  const ctx = { repoResolveRate: new Map([[r, prior]]) };
  return { id: i.instance_id, y, x: extractFeatures(i, ctx) };
});

const base = rows.filter((r) => r.y).length / rows.length;
const majority = Math.max(base, 1 - base);

// Deterministic 5-fold CV (stride folds — no RNG).
const K = 5;
let correct = 0, tp = 0, fp = 0, fn = 0, tn = 0;
const probs = [];
for (let k = 0; k < K; k++) {
  const train = rows.filter((_, idx) => idx % K !== k);
  const test = rows.filter((_, idx) => idx % K === k);
  const { Xz, mean, std } = standardize(train.map((r) => r.x));
  const model = trainLogReg(Xz, train.map((r) => r.y), { l2: 4.0, iters: 1200 });
  for (const r of test) {
    const p = predictProba(model, mean, std, r.x);
    probs.push({ id: r.id, y: r.y, p });
    const pred = p >= 0.5 ? 1 : 0;
    if (pred === r.y) correct++;
    if (pred === 1 && r.y === 1) tp++;
    else if (pred === 1 && r.y === 0) fp++;
    else if (pred === 0 && r.y === 1) fn++;
    else tn++;
  }
}
const acc = correct / rows.length;

// AUC (Mann–Whitney) over the held-out probabilities.
const pos = probs.filter((r) => r.y === 1).map((r) => r.p);
const neg = probs.filter((r) => r.y === 0).map((r) => r.p);
let gt = 0, eq = 0;
for (const a of pos) for (const b of neg) { if (a > b) gt++; else if (a === b) eq++; }
const auc = (gt + eq / 2) / (pos.length * neg.length);

// Full-data weights for interpretability.
const { Xz, mean, std } = standardize(rows.map((r) => r.x));
const full = trainLogReg(Xz, rows.map((r) => r.y), { l2: 4.0, iters: 1200 });

console.log('=== ADR-169 E2 difficulty router — REAL E1 labels (n=300, 5-fold CV) ===');
console.log(`positives (cheap-agentic resolved): ${rows.filter((r) => r.y).length}/300 = ${(base * 100).toFixed(1)}%`);
console.log(`majority-class baseline: ${(majority * 100).toFixed(1)}%`);
console.log(`router CV accuracy:       ${(acc * 100).toFixed(1)}%   (lift ${((acc - majority) * 100).toFixed(1)}pp)`);
console.log(`router CV AUC:            ${auc.toFixed(3)}   (0.5 = no signal)`);
console.log(`confusion (pred resolve): tp=${tp} fp=${fp} fn=${fn} tn=${tn}`);
console.log('feature weights (standardized):');
FEATURE_NAMES.forEach((f, j) => console.log(`  ${f.padEnd(16)} ${full.w[j] >= 0 ? '+' : ''}${full.w[j].toFixed(3)}`));
console.log(JSON.stringify({ kind: 'router-eval-e1', n: 300, basePos: base, majority, cvAccuracy: acc, cvAuc: auc, tp, fp, fn, tn, weights: Object.fromEntries(FEATURE_NAMES.map((f, j) => [f, full.w[j]])) }));
