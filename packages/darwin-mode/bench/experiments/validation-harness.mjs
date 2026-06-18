// SPDX-License-Identifier: MIT
//
// ADR-122 — ADR-098 step 1: the long-horizon Validation Harness. A synthetic repo
// grows from 5 to 55 files over 50 sequential steps. One OLD load-bearing "core"
// module (added at step 0) is what every step's task is really about — the "thread".
// At each step we ask whether the context window still contains the core file under
// two policies: (a) the harness's REAL relevance-ranked contextBuilder (buildContext),
// and (b) a naive RECENCY window (last W files) — the default way agents "lose the
// thread" as a repo grows. Deterministic, no LLM. This validates that Darwin's context
// management holds architectural consistency over a long horizon BEFORE spending budget
// on a real external benchmark (ADR-098).
//
// Run: node --experimental-strip-types --no-warnings bench/experiments/validation-harness.mjs

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateBaselineHarness } from '../../dist/generator.js';
import { profileRepo } from '../../dist/repo_profiler.js';

const W = 30; // both policies use the same window size — the only difference is ranking vs recency
const STEPS = 50;
const CORE = 'payment_gateway_core.ts'; // old, load-bearing; task terms overlap it strongly
const TASK = 'fix the payment gateway core charge authorization bug';

// Get the harness's real relevance-ranked contextBuilder (a generated surface).
const hr = mkdtempSync(join(tmpdir(), 'vh-')); mkdirSync(join(hr, 'src'), { recursive: true });
writeFileSync(join(hr, 'package.json'), '{"name":"h","version":"1.0.0"}');
writeFileSync(join(hr, 'src', 'i.js'), 'export const x=1;\n');
const base = await generateBaselineHarness(await profileRepo(hr), mkdtempSync(join(tmpdir(), 'vh-h-')));
const { buildContext } = await import(`${base.dir}/context_builder.ts`);

// Distractor pool: realistic noise. A third share ONE task term ("payment"/"gateway"/
// "core") to create genuine ranking pressure; the core still outscores them (3 terms).
const partial = ['payment_history', 'gateway_metrics', 'core_logging', 'payment_export'];
const unrelated = ['user_profile_avatar', 'theme_settings', 'email_digest', 'image_thumbnail', 'csv_importer', 'locale_strings'];
function distractor(i) {
  const stem = i % 3 === 0 ? partial[i % partial.length] : unrelated[i % unrelated.length];
  return `${stem}_${i}.ts`;
}

// Repo at step s: the OLD core (index 0) + s freshly-added distractors (newest last).
function repoAt(s) {
  const files = [CORE];
  for (let i = 0; i < s + 4; i++) files.push(distractor(i)); // start with 4, grow by 1/step → 5..55 files
  return files;
}

const rankedHeld = [], recencyHeld = [];
let rankedLostAt = null, recencyLostAt = null;
for (let s = 0; s < STEPS; s++) {
  const files = repoAt(s);
  // (a) real relevance-ranked contextBuilder, capped to window W.
  const ranked = buildContext(TASK, files).slice(0, W).map((c) => c.path);
  // (b) naive recency window: the last W files by add-order (how agents drop old context).
  const recency = files.slice(-W);
  const rHeld = ranked.includes(CORE), cHeld = recency.includes(CORE);
  rankedHeld.push(rHeld); recencyHeld.push(cHeld);
  if (!rHeld && rankedLostAt === null) rankedLostAt = s;
  if (!cHeld && recencyLostAt === null) recencyLostAt = s;
}

const rate = (a) => +(a.filter(Boolean).length / a.length).toFixed(3);
console.log(JSON.stringify({
  experiment: 'ADR-098 step 1 — long-horizon context validation harness',
  steps: STEPS, window: W, fileCountRange: [repoAt(0).length, repoAt(STEPS - 1).length],
  coreFile: CORE, deterministic: true, llmCalls: 0,
  relevanceRanked: { threadRetentionRate: rate(rankedHeld), lostThreadAtStep: rankedLostAt, filesWhenLost: rankedLostAt === null ? null : repoAt(rankedLostAt).length },
  naiveRecency: { threadRetentionRate: rate(recencyHeld), lostThreadAtStep: recencyLostAt, filesWhenLost: recencyLostAt === null ? null : repoAt(recencyLostAt).length },
  verdict: rate(rankedHeld) === 1 && rate(recencyHeld) < 1
    ? 'VALIDATED: relevance-ranked harness holds the thread across all 50 steps; naive recency loses the old load-bearing file as the repo grows'
    : 'inconclusive',
}, null, 2));
