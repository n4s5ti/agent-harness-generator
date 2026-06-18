// SPDX-License-Identifier: MIT
//
// ADR-123 — ADR-098 step 2: the BenchmarkRunner adapter. Conforms the harness to the
// SWE-bench Verified "resolved" contract and implements the REAL resolved criterion that
// none of ADR-117…121 checked: a patch is RESOLVED iff EVERY FAIL_TO_PASS test goes
// red→green AND EVERY PASS_TO_PASS test stays green (a fix must not break existing tests).
// The two sets are auto-derived from the base (bugged) state via vitest's JSON reporter —
// exactly SWE-bench's definition (FAIL_TO_PASS = failing at base; PASS_TO_PASS = passing
// at base). Validated two ways on a synthetic instance shaped like a real task:
//   (A) real LLM fix  → expected RESOLVED
//   (B) deterministic test-gaming patch (hard-codes one target case) → expected UNRESOLVED,
//       proving the all-must-pass criterion has teeth against patches that game one test.
// Step 3 (external corpus) becomes: feed real instances to runSweBenchTask().
//
// Run: OPENROUTER_API_KEY=$(cat /tmp/.orkey) \
//   node --experimental-strip-types --no-warnings bench/experiments/swe-bench-adapter.mjs [model]

import { mkdtempSync, writeFileSync, readFileSync, readdirSync, cpSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateBaselineHarness } from '../../dist/generator.js';
import { profileRepo } from '../../dist/repo_profiler.js';

const model = process.argv[2] || 'google/gemini-2.5-flash';
const key = (process.env.OPENROUTER_API_KEY || readFileSync('/tmp/.orkey', 'utf8')).trim();
const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---- The SWE-bench-Verified-compatible task contract (the conformance surface) ----
// A real instance carries {instance_id, repo, base_commit, problem_statement, test_patch,
// FAIL_TO_PASS, PASS_TO_PASS, patch}. Here we synthesize one instance from this package so
// the adapter is exercised end-to-end; step 3 supplies real instances in this same shape.
const instance = {
  instance_id: 'synthetic__darwin-pareto-dominance-1',
  problem_statement: 'paretoFront returns dominated items instead of the non-dominated front.',
  test_files: ['pareto', 'phenotype', 'clade'], // suites to run for FAIL/PASS partition
  bug: { file: 'pareto.ts', from: 'if (!dominated) front.push(items[i]);', to: 'if (dominated) front.push(items[i]);' },
};

function setupRepo() {
  const work = mkdtempSync(join(tmpdir(), 'swebench-'));
  for (const d of ['src', '__tests__']) cpSync(join(PKG, d), join(work, d), { recursive: true });
  cpSync(join(PKG, 'package.json'), join(work, 'package.json'));
  cpSync(join(PKG, 'tsconfig.json'), join(work, 'tsconfig.json'));
  symlinkSync(join(PKG, 'node_modules'), join(work, 'node_modules'), 'dir');
  return work;
}

// Run the named suites and return a map: "<file> › <title>" -> 'passed'|'failed'.
function runTests(work) {
  const out = join(work, '_vitest.json');
  try { execSync(`npx vitest run ${instance.test_files.join(' ')} --reporter=json --outputFile=${out}`, { cwd: work, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { /* non-zero exit when tests fail — the JSON is still written */ }
  if (!existsSync(out)) return {};
  const j = JSON.parse(readFileSync(out, 'utf8'));
  const map = {};
  for (const tr of j.testResults ?? []) {
    const file = (tr.name || '').split('/').pop()?.replace('.test.ts', '');
    for (const a of tr.assertionResults ?? []) map[`${file} › ${a.title}`] = a.status;
  }
  return map;
}

// resolved = every FAIL_TO_PASS now 'passed' AND every PASS_TO_PASS still 'passed'.
function evaluate(F2P, P2P, after) {
  const f2pGreen = F2P.filter((t) => after[t] === 'passed');
  const p2pGreen = P2P.filter((t) => after[t] === 'passed');
  return { resolved: f2pGreen.length === F2P.length && p2pGreen.length === P2P.length, f2p: `${f2pGreen.length}/${F2P.length}`, p2p: `${p2pGreen.length}/${P2P.length}` };
}

// ---- Base state: introduce the bug, derive FAIL_TO_PASS / PASS_TO_PASS ----
const base = setupRepo();
const orig = readFileSync(join(base, 'src', instance.bug.file), 'utf8');
writeFileSync(join(base, 'src', instance.bug.file), orig.replace(instance.bug.from, instance.bug.to));
const baseRun = runTests(base);
const FAIL_TO_PASS = Object.keys(baseRun).filter((t) => baseRun[t] === 'failed');
const PASS_TO_PASS = Object.keys(baseRun).filter((t) => baseRun[t] === 'passed');

// ---- Arm A: the real harness loop (contextBuilder selects → real LLM patches) ----
async function harnessFix(work) {
  const realFiles = readdirSync(join(work, 'src')).filter((f) => f.endsWith('.ts'));
  const hr = mkdtempSync(join(tmpdir(), 'sb-h-')); cpSync(join(PKG, 'package.json'), join(hr, 'package.json'));
  const b = await generateBaselineHarness(await profileRepo(hr), mkdtempSync(join(tmpdir(), 'sb-hw-')));
  const { buildContext } = await import(`${b.dir}/context_builder.ts`);
  const selected = (buildContext(instance.problem_statement, realFiles) ?? []).map((c) => c.path).slice(0, 6);
  const seen = selected.map((f) => `// FILE: ${f}\n${readFileSync(join(work, 'src', f), 'utf8')}`).join('\n\n');
  const prompt = `${instance.problem_statement}\nIdentify the buggy file among the selected sources and fix it. Return STRICT JSON {"file":"<selected file>","content":"<full corrected file>"}. No fences/prose.\n--- selected files ---\n${seen}\n--- failing tests ---\n${FAIL_TO_PASS.join('\n')}\n`;
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 2000, temperature: 0.1 }) });
  const j = await res.json();
  let raw = j.choices?.[0]?.message?.content ?? ''; const m = raw.match(/```(?:json)?\n([\s\S]*?)\n```/i); if (m) raw = m[1];
  let patch = null; try { patch = JSON.parse(raw); } catch { /**/ }
  if (patch && realFiles.includes(patch.file) && typeof patch.content === 'string') writeFileSync(join(work, 'src', patch.file), patch.content);
  return { chose: patch?.file ?? null, tokens: j.usage?.total_tokens ?? null, cost: j.usage?.cost ?? null };
}

const armA = setupRepo();
writeFileSync(join(armA, 'src', instance.bug.file), readFileSync(join(base, 'src', instance.bug.file), 'utf8')); // same bugged base
const fix = await harnessFix(armA);
const realLlm = { ...evaluate(FAIL_TO_PASS, PASS_TO_PASS, runTests(armA)), chose: fix.chose, tokens: fix.tokens, cost_usd: fix.cost };

// ---- Arm B: a deterministic TEST-GAMING patch (type-safe, partially correct) ----
// Correct ONLY for tiny inputs (≤2 items) but keeps the dominated-push bug for >2.
// It passes the simple target tests (1- and 2-item) but fails the multi-item ones, so
// the all-FAIL_TO_PASS-must-pass rule must still mark it UNRESOLVED — passing SOME
// target tests is not enough.
const armB = setupRepo();
const gamed = orig.replace(
  'if (!dominated) front.push(items[i]);',
  'const keep = items.length <= 2 ? !dominated : dominated; if (keep) front.push(items[i]);',
);
writeFileSync(join(armB, 'src', instance.bug.file), gamed);
const gaming = evaluate(FAIL_TO_PASS, PASS_TO_PASS, runTests(armB));

for (const d of [base, armA, armB]) { try { rmSync(d, { recursive: true, force: true }); } catch { /**/ } }

console.log(JSON.stringify({
  experiment: 'ADR-098 step 2 — SWE-bench BenchmarkRunner adapter (real resolved criterion)',
  instance_id: instance.instance_id, model,
  FAIL_TO_PASS_count: FAIL_TO_PASS.length, PASS_TO_PASS_count: PASS_TO_PASS.length,
  criterion: 'resolved ⇔ all FAIL_TO_PASS green AND all PASS_TO_PASS stay green',
  armA_realLLM: realLlm,
  armB_testGamingPatch: gaming,
  verdict: realLlm.resolved && !gaming.resolved
    ? 'ADAPTER VALIDATED: real LLM fix RESOLVED; test-gaming patch correctly UNRESOLVED (all-FAIL_TO_PASS-must-pass has teeth)'
    : 'inconclusive',
}, null, 2));
