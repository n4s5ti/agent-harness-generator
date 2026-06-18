// SPDX-License-Identifier: MIT
//
// ADR-138 — quantify the ADR-137 noise floor. ADR-137 asserted per-cell LLM-fitness variance
// dominates single-run micro-evolve. This MEASURES it: run the same genome N times on the same
// 3-package corpus (no cache) and report the resolve-rate distribution. A "noisy" genome
// (deepseek/wholefile — observed 0/3 and 2/3) vs a "stable" one (gemini/searchreplace — observed
// 2/3 repeatedly). Turns the qualitative claim into a measured variance and tells us how many
// averaged runs a stable evolutionary signal would need.
//
// Run: OPENROUTER_API_KEY=$(cat /tmp/.orkey) \
//   node --experimental-strip-types --no-warnings bench/experiments/swe-fitness-variance.mjs

import { readFileSync, cpSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSweBenchTask } from '../swe-bench-runner.mjs';

const PKGS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

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

function taskFor(spec, g) {
  const root = join(PKGS, spec.pkg);
  return {
    instance_id: spec.id, problem_statement: spec.problem, test_suites: spec.suites,
    patchMode: g.patchMode, maxAttempts: g.maxAttempts, selectK: 6,
    materialize(work) {
      for (const d of ['src', '__tests__']) cpSync(join(root, d), join(work, d), { recursive: true });
      for (const f of ['package.json', 'tsconfig.json']) if (existsSync(join(root, f))) cpSync(join(root, f), join(work, f));
      writeFileSync(join(work, '.gitignore'), 'node_modules\n_vitest.json\n_patch.diff\n');
      symlinkSync(join(root, 'node_modules'), join(work, 'node_modules'), 'dir');
      const p = join(work, spec.bug.file); writeFileSync(p, readFileSync(p, 'utf8').replace(spec.bug.from, spec.bug.to));
    },
  };
}

async function corpusResolved(g) {
  let resolved = 0;
  for (const spec of SPECS) { let r; try { r = await runSweBenchTask(taskFor(spec, g), { model: g.model }); } catch { r = { resolved: false }; } if (r.resolved) resolved++; }
  return resolved;
}
const stats = (xs) => { const n = xs.length, m = xs.reduce((a, b) => a + b, 0) / n; const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / n); return { mean: Math.round(m * 100) / 100, sd: Math.round(sd * 100) / 100, min: Math.min(...xs), max: Math.max(...xs) }; };

const GENOMES = [
  { label: 'noisy: deepseek/wholefile/a1', g: { model: 'deepseek/deepseek-chat', patchMode: 'wholefile', maxAttempts: 1 }, N: 5 },
  { label: 'stable?: gemini/searchreplace/a2', g: { model: 'google/gemini-2.5-flash', patchMode: 'searchreplace', maxAttempts: 2 }, N: 3 },
];

const out = [];
for (const { label, g, N } of GENOMES) {
  const runs = [];
  for (let i = 0; i < N; i++) runs.push(await corpusResolved(g));
  out.push({ label, runs: runs.map((r) => `${r}/3`), ...stats(runs) });
}

console.log(JSON.stringify({
  experiment: 'ADR-138 — quantifying the micro-evolve fitness noise floor',
  corpus: SPECS.map((s) => s.id), metric: 'corpus resolve count (0..3) per repeated run',
  genomes: out,
  verdict: `noise quantified: ${out.map((o) => `${o.label} → ${o.runs.join(',')} (mean ${o.mean}, sd ${o.sd}, range [${o.min},${o.max}])`).join(' | ')} — a single run is unreliable where sd is large; averaging ~⌈(sd/0.5)²⌉ runs is needed for a 0.5-resolve-stable signal (ADR-137).`,
}, null, 2));
