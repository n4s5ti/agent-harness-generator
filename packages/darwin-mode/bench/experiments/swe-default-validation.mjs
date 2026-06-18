// SPDX-License-Identifier: MIT
//
// ADR-139 — validate the ADR-135/138 default-model change with AVERAGED runs. ADR-135 picked
// deepseek-chat as the SWE-fix default from a single run; ADR-138 showed single runs are noisy
// (sd≈0.45). Responsible follow-up: average N runs of the NEW default (deepseek/searchreplace)
// vs the OLD default (gemini/searchreplace) on the same corpus, and check the new default is
// robustly ≥ the old — not just lucky once. Applies the noise-floor lesson to the decision itself.
//
// Run: OPENROUTER_API_KEY=$(cat /tmp/.orkey) \
//   node --experimental-strip-types --no-warnings bench/experiments/swe-default-validation.mjs

import { readFileSync, cpSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSweBenchTask } from '../swe-bench-runner.mjs';

const PKGS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const N = 4;

const SPECS = [
  { id: 'kernel-js', pkg: 'kernel-js', suites: ['trajectory'],
    problem: 'The trajectory store rotateIfLarger rotates a small file and skips rotation when over the size limit — the size threshold is inverted.',
    bug: { file: 'src/trajectory.ts', from: 'if (s.size <= maxBytes) return false;', to: 'if (s.size > maxBytes) return false;' } },
  { id: 'create-agent-harness', pkg: 'create-agent-harness', suites: ['constraints'],
    problem: 'The constraints summarise function reports allHardPass true even when a hard constraint fails.',
    bug: { file: 'src/constraints.ts', from: 'allHardPass: hard.every((r) => r.passed),', to: 'allHardPass: hard.some((r) => r.passed),' } },
  { id: 'vertical-base', pkg: 'vertical-base', suites: ['base'],
    problem: 'validateVerticalManifest accepts an empty string id instead of rejecting it.',
    bug: { file: 'src/index.ts', from: "if (!m.id || typeof m.id !== 'string') throw new Error('manifest.id must be a string');", to: "if (typeof m.id !== 'string') throw new Error('manifest.id must be a string');" } },
];

function taskFor(spec, model) {
  const root = join(PKGS, spec.pkg);
  return {
    instance_id: spec.id, problem_statement: spec.problem, test_suites: spec.suites,
    patchMode: 'searchreplace', maxAttempts: 2, selectK: 6,
    materialize(work) {
      for (const d of ['src', '__tests__']) cpSync(join(root, d), join(work, d), { recursive: true });
      for (const f of ['package.json', 'tsconfig.json']) if (existsSync(join(root, f))) cpSync(join(root, f), join(work, f));
      writeFileSync(join(work, '.gitignore'), 'node_modules\n_vitest.json\n_patch.diff\n');
      symlinkSync(join(root, 'node_modules'), join(work, 'node_modules'), 'dir');
      const p = join(work, spec.bug.file); writeFileSync(p, readFileSync(p, 'utf8').replace(spec.bug.from, spec.bug.to));
    },
  };
}
async function corpusResolved(model) {
  let resolved = 0, cost = 0;
  for (const spec of SPECS) { let r; try { r = await runSweBenchTask(taskFor(spec, model), { model }); } catch { r = { resolved: false, cost_usd: 0 }; } if (r.resolved) resolved++; cost += r.cost_usd ?? 0; }
  return { resolved, cost };
}
const mean = (xs) => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100;
const sd = (xs) => { const m = mean(xs); return Math.round(Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) * 100) / 100; };

const MODELS = { 'new default (deepseek/searchreplace)': 'deepseek/deepseek-chat', 'old default (gemini/searchreplace)': 'google/gemini-2.5-flash' };
const out = {};
for (const [label, model] of Object.entries(MODELS)) {
  const res = [], costs = [];
  for (let i = 0; i < N; i++) { const r = await corpusResolved(model); res.push(r.resolved); costs.push(r.cost); }
  out[label] = { runs: res.map((r) => `${r}/3`), meanResolved: mean(res), sd: sd(res), meanCost: Math.round(mean(costs) * 10000) / 10000 };
}
const nw = out['new default (deepseek/searchreplace)'], od = out['old default (gemini/searchreplace)'];
const robustlyBetter = nw.meanResolved >= od.meanResolved && nw.meanCost <= od.meanCost;
console.log(JSON.stringify({
  experiment: 'ADR-139 — averaged validation of the deepseek default (vs gemini)',
  corpus: SPECS.map((s) => s.id), runsPerModel: N, config: 'searchreplace / a2 / k6',
  results: out,
  verdict: robustlyBetter
    ? `DEFAULT VALIDATED: deepseek mean ${nw.meanResolved}/3 (sd ${nw.sd}, $${nw.meanCost}) ≥ gemini ${od.meanResolved}/3 (sd ${od.sd}, $${od.meanCost}) on both resolve-rate AND cost across ${N} runs — the ADR-135 default change holds under averaging`
    : `MIXED: deepseek ${nw.meanResolved}/3 $${nw.meanCost} vs gemini ${od.meanResolved}/3 $${od.meanCost} — reconsider the default (report as measured)`,
}, null, 2));
