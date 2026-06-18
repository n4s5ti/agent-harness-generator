// SPDX-License-Identifier: MIT
//
// ADR-136 — evolve the FULL genome, including the model. ADR-135 found deepseek-chat best by a
// manual frontier sweep; this lets the (1+λ) evolve loop DISCOVER it autonomously by mutating a
// `model` gene alongside {patchMode, maxAttempts}. Fitness = cross-package resolve-rate (cost
// tie-break) over 3 external packages. Closes the "evolve every axis" story: the harness
// self-selects its own model. Bounded: cheap models only, elitism + genome cache.
//
// Run: OPENROUTER_API_KEY=$(cat /tmp/.orkey) \
//   node --experimental-strip-types --no-warnings bench/experiments/swe-evolve-fullgenome.mjs

import { readFileSync, cpSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSweBenchTask } from '../swe-bench-runner.mjs';

const PKGS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MODELS = ['google/gemini-2.5-flash', 'deepseek/deepseek-chat', 'openai/gpt-5-mini'];

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

const short = (m) => m.split('/')[1];
const key = (g) => `${short(g.model)}/${g.patchMode}/a${g.maxAttempts}`;
const cache = new Map();
async function fitness(g) {
  if (cache.has(key(g))) return cache.get(key(g));
  let resolved = 0, cost = 0;
  for (const spec of SPECS) {
    let r; try { r = await runSweBenchTask(taskFor(spec, g), { model: g.model }); } catch { r = { resolved: false, cost_usd: 0 }; }
    if (r.resolved) resolved++; cost += r.cost_usd ?? 0;
  }
  const f = { genome: key(g), resolved, total: SPECS.length, cost_usd: Math.round(cost * 10000) / 10000 };
  cache.set(key(g), f); return f;
}
const better = (a, b) => (b.resolved - a.resolved) || (a.cost_usd - b.cost_usd);
const nextModel = (m) => MODELS[(MODELS.indexOf(m) + 1) % MODELS.length];
const neighbours = (g) => [
  { ...g, model: nextModel(g.model) },
  { ...g, patchMode: g.patchMode === 'searchreplace' ? 'wholefile' : 'searchreplace' },
  { ...g, maxAttempts: g.maxAttempts === 1 ? 2 : 1 },
];

// Gen 0: deliberately seeded on the (suboptimal) default model.
let pop = [
  { model: 'google/gemini-2.5-flash', patchMode: 'searchreplace', maxAttempts: 2 },
  { model: 'google/gemini-2.5-flash', patchMode: 'wholefile', maxAttempts: 1 },
];
const trajectory = []; let elite = null;
for (let gen = 0; gen < 4; gen++) {
  const scored = [];
  for (const g of pop) scored.push({ g, f: await fitness(g) });
  scored.sort((a, b) => better(a.f, b.f));
  if (!elite || better(scored[0].f, elite.f) < 0) elite = scored[0];
  trajectory.push({ gen, best: elite.f.genome, bestResolved: `${elite.f.resolved}/${elite.f.total}`, bestCost: elite.f.cost_usd, evaluatedThisGen: scored.map((s) => `${s.f.genome}:${s.f.resolved}/${s.f.total}`) });
  const fresh = neighbours(elite.g).filter((n) => !cache.has(key(n)));
  if (!fresh.length) break;
  pop = fresh.slice(0, 2);
}

const totalCost = [...cache.values()].reduce((s, f) => s + f.cost_usd, 0);
const modelChosen = elite.f.genome.split('/')[0];
console.log(JSON.stringify({
  experiment: 'ADR-136 — evolve the full genome (model + patchMode + maxAttempts)',
  corpus: SPECS.map((s) => s.id), modelGene: MODELS.map(short), generations: trajectory.length, configsEvaluated: cache.size,
  trajectory,
  evolvedWinner: { genome: elite.f.genome, resolved: `${elite.f.resolved}/${elite.f.total}`, cost_usd: elite.f.cost_usd },
  totalCost_usd: Math.round(totalCost * 10000) / 10000,
  verdict: `evolution autonomously selected model '${modelChosen}' (winner ${elite.f.genome}, ${elite.f.resolved}/${elite.f.total}, $${elite.f.cost_usd}) — the harness self-optimizes its own model, no hand-picking (cf. ADR-135 manual frontier)`,
}, null, 2));
