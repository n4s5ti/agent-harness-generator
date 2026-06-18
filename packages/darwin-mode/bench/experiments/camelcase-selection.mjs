// SPDX-License-Identifier: MIT
//
// ADR-128 — contextBuilder camelCase tokenization (fixes the ADR-127 file-selection finding).
// A bug report naming camelCase symbols ("paretoFront", "poincareDistance") must select the
// files that define them ("pareto.ts", "phenotype.ts"). The old tokenizer lowercased then split
// on non-alphanumerics, so "paretoFront" → ["paretofront"] which never matched "pareto". The new
// tokenizer splits camelCase first → ["pareto","front"]. Deterministic A/B over the 21 real src
// files: report the score and rank of each buggy file under OLD vs NEW. No LLM.
//
// Run: node --experimental-strip-types --no-warnings bench/experiments/camelcase-selection.mjs

import { readdirSync } from 'node:fs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateBaselineHarness } from '../../dist/generator.js';
import { profileRepo } from '../../dist/repo_profiler.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));
const QUERY = 'paretoFront returns dominated items; poincareDistance fails near the boundary';
const TARGETS = ['pareto.ts', 'phenotype.ts'];

// NEW: the harness's current generated contextBuilder (camelCase-aware).
const hr = mkdtempSync(join(tmpdir(), 'cc-')); writeFileSync(join(hr, 'package.json'), '{"name":"h","version":"1.0.0"}');
const base = await generateBaselineHarness(await profileRepo(hr), mkdtempSync(join(tmpdir(), 'cc-h-')));
const { buildContext } = await import(`${base.dir}/context_builder.ts`);
const ranked = buildContext(QUERY, files);

// OLD: the pre-ADR-128 tokenizer (lowercase + split, NO camelCase split), same scoring.
const oldTerms = (t) => t.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length >= 2);
const wanted = new Set(oldTerms(QUERY));
const oldRanked = files.map((path, index) => {
  let score = 0; for (const t of oldTerms(path)) if (wanted.has(t)) score += 1; return { path, score, index };
}).sort((a, b) => (b.score - a.score) || (a.index - b.index));

const pos = (arr, f) => { const i = arr.findIndex((c) => c.path === f); return i < 0 ? null : { rank: i + 1, score: arr[i].score }; };
const report = (arr) => Object.fromEntries(TARGETS.map((f) => [f, pos(arr, f)]));
const oldR = report(oldRanked), newR = report(ranked);

console.log(JSON.stringify({
  experiment: 'ADR-128 — contextBuilder camelCase tokenization',
  query: QUERY, candidateFiles: files.length, deterministic: true, llmCalls: 0,
  old_tokenizer: oldR,
  new_tokenizer: newR,
  // Honest two-part finding: camelCase splitting fixes selection when the symbol stem
  // matches the filename (paretoFront→pareto.ts), but NOT when the symbol lives in a
  // differently-named file (poincareDistance is in phenotype.ts — no path overlap).
  improved: TARGETS.filter((f) => (newR[f]?.score ?? 0) > (oldR[f]?.score ?? 0)),
  stillUnmatched: TARGETS.filter((f) => (newR[f]?.score ?? 0) === 0),
  verdict: 'PARTIAL FIX: camelCase tokenization lifts symbols whose stem matches the filename '
    + `(pareto.ts rank ${oldR['pareto.ts']?.rank}→${newR['pareto.ts']?.rank}); it cannot help when the symbol name `
    + 'differs from the filename (poincareDistance ∈ phenotype.ts stays unmatched) — that needs content/symbol indexing (step-3 item).',
}, null, 2));
