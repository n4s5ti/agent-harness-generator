// SPDX-License-Identifier: MIT
//
// Falsification (ADR-111): is ADR-109/110's result caused by the contextBuilder's
// RANKING quality, or merely by the context WINDOW SIZE? The reviewer's null
// model: replace the real contextBuilder with naive selectors (first-N, random-N)
// and see if the same files get surfaced. If a naive selector at the same window
// surfaces the bug just as well, then ranking is irrelevant and the honest claim
// is "a sufficient window lets the LLM fix the bug", not "the surface's ranking
// determines outcomes". Zero LLM calls — the fix is deterministic (s< → s<=), so
// we apply the known fix and let the REAL test be the verdict.
//
// Run: node --experimental-strip-types --no-warnings bench/experiments/falsify-context-selection.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateBaselineHarness } from '../../dist/generator.js';
import { profileRepo } from '../../dist/repo_profiler.js';
import { mulberry32 } from '../../dist/clade.js';

const BUGGY = `export function merge(intervals){const xs=[...intervals].sort((a,b)=>a[0]-b[0]);const out=[];for(const [s,e] of xs){const last=out[out.length-1];if(last&&s<last[1]){last[1]=Math.max(last[1],e);}else out.push([s,e]);}return out;}\n`;
const FIX = BUGGY.replace('s<last[1]', 's<=last[1]'); // the known correct fix
const TEST = `import { merge } from './merge_intervals.js'; import assert from 'node:assert';
assert.deepStrictEqual(merge([[1,4],[4,5]]),[[1,5]],'touching'); console.log('PASS');\n`;
const TASKS = [{ id: 't-near', before: 8 }, { id: 't-mid', before: 38 }, { id: 't-far', before: 65 }];

function repoFor(task) {
  const r = mkdtempSync(join(tmpdir(), 'fcs-'));
  mkdirSync(join(r, 'src'), { recursive: true });
  const files = [];
  for (let i = 0; i < task.before; i++) { const f = `src/merge_intervals_${i}.ts`; writeFileSync(join(r, f), `export const k${i}=${i};\n`); files.push(f); }
  writeFileSync(join(r, 'merge_intervals.js'), BUGGY); files.push('merge_intervals.js');
  writeFileSync(join(r, 'test.mjs'), TEST);
  return { dir: r, files, buggy: 'merge_intervals.js' };
}
function testPasses(dir) { try { execFileSync(process.execPath, ['test.mjs'], { cwd: dir, timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] }); return true; } catch { return false; } }

import { cpSync } from 'node:fs';
const prof = await profileRepo(repoFor(TASKS[0]).dir);
const wr = mkdtempSync(join(tmpdir(), 'fcs-wr-'));
const base = await generateBaselineHarness(prof, wr);

// Real contextBuilder at a given INTERNAL window: copy the variant, rewrite its
// own `.slice(0, N)` (exactly what the mutator does in ADR-110), import it fresh.
const ctxbCache = new Map();
async function realCtxb(window) {
  if (!ctxbCache.has(window)) {
    const d = join(wr, 'variants', `w${window}`);
    cpSync(base.dir, d, { recursive: true });
    const src = readFileSync(join(d, 'context_builder.ts'), 'utf8');
    writeFileSync(join(d, 'context_builder.ts'), src.replace('.slice(0, 30)', `.slice(0, ${window})`));
    ctxbCache.set(window, await import(`${d}/context_builder.ts`));
  }
  return ctxbCache.get(window);
}

// Three selectors. real-contextBuilder uses its own internal window (fair);
// first-N / random-N take N files externally (no ranking) for the comparison.
const selectors = {
  'real-contextBuilder': async (files, window) => (await realCtxb(window)).buildContext('fix merge intervals', files).map((c) => c.path),
  'first-N': async (files, window) => files.slice(0, window),
  'random-N': async (files, window) => { const rng = mulberry32(42); return [...files].sort(() => rng() - 0.5).slice(0, window); },
};

// For each (selector, window): how many tasks are solvable (bug surfaced → known fix → real test)?
async function solvedCount(selector, window) {
  let solved = 0;
  for (const task of TASKS) {
    const repo = repoFor(task);
    const selected = await selector(repo.files, window);
    if (!selected.includes(repo.buggy)) continue;
    writeFileSync(join(repo.dir, repo.buggy), FIX);
    if (testPasses(repo.dir)) solved++;
  }
  return solved;
}

const out = {};
for (const [name, sel] of Object.entries(selectors)) {
  out[name] = { 'window-30': await solvedCount(sel, 30), 'window-70': await solvedCount(sel, 70) };
}
console.log(JSON.stringify({
  question: 'Does the contextBuilder RANKING matter, or only the window size?',
  note: 'distractors have FLAT term-overlap with the prompt (equal scores), so the real contextBuilder falls back to input order — same as first-N. Verdict below.',
  results: out,
}, null, 2));
