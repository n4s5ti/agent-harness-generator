// SPDX-License-Identifier: MIT
//
// ADR-129 — symbol-index selection (finishes the ADR-128 finding). Path-term ranking cannot
// find a symbol whose name differs from its filename (poincareDistance ∈ phenotype.ts). The
// runner's selectFiles() augments the contextBuilder: files that DEFINE a symbol named in the
// problem statement are prioritized, then the path ranking fills the rest. Deterministic A/B:
// for a camelCase query, does phenotype.ts make the top-6 selection? No LLM.
//
// Run: node --experimental-strip-types --no-warnings bench/experiments/symbol-index-selection.mjs

import { readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateBaselineHarness } from '../../dist/generator.js';
import { profileRepo } from '../../dist/repo_profiler.js';
import { selectFiles } from '../swe-bench-runner.mjs';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));
const QUERY = 'paretoFront returns dominated items; poincareDistance fails near the boundary';
const TARGETS = ['pareto.ts', 'phenotype.ts'];

const hr = mkdtempSync(join(tmpdir(), 'si-')); writeFileSync(join(hr, 'package.json'), '{"name":"h","version":"1.0.0"}');
const base = await generateBaselineHarness(await profileRepo(hr), mkdtempSync(join(tmpdir(), 'si-h-')));
const { buildContext } = await import(`${base.dir}/context_builder.ts`);

// PATH-ONLY (contextBuilder) top-6 vs SYMBOL-AUGMENTED (selectFiles) top-6.
const pathOnly = (buildContext(QUERY, files) ?? []).map((c) => c.path).slice(0, 6);
const augmented = selectFiles(QUERY, SRC, files, buildContext, 6);

const inTop = (arr, f) => arr.includes(f);
console.log(JSON.stringify({
  experiment: 'ADR-129 — symbol-index selection',
  query: QUERY, candidateFiles: files.length, deterministic: true, llmCalls: 0,
  pathOnly_top6: pathOnly,
  symbolAugmented_top6: augmented,
  targetsInPathOnly: Object.fromEntries(TARGETS.map((f) => [f, inTop(pathOnly, f)])),
  targetsInAugmented: Object.fromEntries(TARGETS.map((f) => [f, inTop(augmented, f)])),
  verdict: TARGETS.every((f) => inTop(augmented, f)) && !TARGETS.every((f) => inTop(pathOnly, f))
    ? 'FIXED: symbol indexing selects BOTH buggy files (incl. phenotype.ts, found by its poincareDistance definition); path-only ranking missed it'
    : 'inconclusive',
}, null, 2));
