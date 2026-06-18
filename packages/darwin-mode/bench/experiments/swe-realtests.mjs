// SPDX-License-Identifier: MIT
//
// ADR-121: the SWE loop with the package's OWN committed vitest suite as the
// oracle (not a hand-written contract test). A real bug is introduced into a
// COPY of the package (committed tree untouched; node_modules symlinked); the
// harness's real contextBuilder selects among the real src files; a real LLM
// fixes the real TypeScript; and the package's REAL `pareto.test.ts` (vitest) is
// the verdict. The most authentic real-code task short of git-mining. Bounded (1 call).
//
// Run: OPENROUTER_API_KEY=$(cat /tmp/.orkey) \
//   node --experimental-strip-types --no-warnings bench/experiments/swe-realtests.mjs [model]

import { mkdtempSync, writeFileSync, readFileSync, readdirSync, cpSync, symlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateBaselineHarness } from '../../dist/generator.js';
import { profileRepo } from '../../dist/repo_profiler.js';

const model = process.argv[2] || 'google/gemini-2.5-flash';
const key = (process.env.OPENROUTER_API_KEY || readFileSync('/tmp/.orkey', 'utf8')).trim();
const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..'); // packages/darwin-mode

// Temp copy of the package (committed tree untouched); symlink node_modules.
const work = mkdtempSync(join(tmpdir(), 'realtests-'));
for (const d of ['src', '__tests__']) cpSync(join(PKG, d), join(work, d), { recursive: true });
cpSync(join(PKG, 'package.json'), join(work, 'package.json'));
cpSync(join(PKG, 'tsconfig.json'), join(work, 'tsconfig.json'));
symlinkSync(join(PKG, 'node_modules'), join(work, 'node_modules'), 'dir');

const realFiles = readdirSync(join(work, 'src')).filter((f) => f.endsWith('.ts'));
const target = 'pareto.ts';
const orig = readFileSync(join(work, 'src', target), 'utf8');
const bugged = orig.replace('if (!dominated) front.push(items[i]);', 'if (dominated) front.push(items[i]);');
if (bugged === orig) { console.log(JSON.stringify({ error: 'bug pattern not found' })); process.exit(1); }
writeFileSync(join(work, 'src', target), bugged);

function vitest() {
  try { execSync('npx vitest run pareto', { cwd: work, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }); return { pass: true, out: 'PASS' }; }
  catch (e) { const o = (e.stdout?.toString() || '') + (e.stderr?.toString() || ''); return { pass: false, out: o.split('\n').filter((l) => /FAIL|✗|×|Expected|AssertionError|pareto/.test(l)).slice(0, 5).join(' | ').slice(0, 300) }; }
}

const before = vitest();

// Harness contextBuilder (generated baseline) selects among the real src files.
const hr = mkdtempSync(join(tmpdir(), 'rt-h-')); cpSync(join(PKG, 'package.json'), join(hr, 'package.json'));
const prof = await profileRepo(hr);
const hw = mkdtempSync(join(tmpdir(), 'rt-hw-'));
const base = await generateBaselineHarness(prof, hw);
const ctxb = await import(`${base.dir}/context_builder.ts`);
const selected = (ctxb.buildContext('fix the pareto front dominance bug', realFiles) ?? []).map((c) => c.path).slice(0, 6);
const seen = selected.map((f) => `// FILE: ${f}\n${readFileSync(join(work, 'src', f), 'utf8')}`).join('\n\n');

const prompt = `The package's vitest suite for paretoFront is failing. Among the selected real source files, identify the buggy one and fix it. Return STRICT JSON {"file":"<selected file>","content":"<full corrected file>"}. No fences/prose.\n--- selected src files ---\n${seen}\n--- failing test output ---\n${before.out}\n`;
const res = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 2000, temperature: 0.1 }) });
const j = await res.json();
let raw = j.choices?.[0]?.message?.content ?? ''; const m = raw.match(/```(?:json)?\n([\s\S]*?)\n```/i); if (m) raw = m[1];
let patch = null; try { patch = JSON.parse(raw); } catch { /**/ }
let after = before, chose = patch?.file ?? null;
if (patch && realFiles.includes(patch.file) && typeof patch.content === 'string') {
  writeFileSync(join(work, 'src', patch.file), patch.content); after = vitest();
}
console.log(JSON.stringify({
  model, oracle: "package's own pareto.test.ts (vitest)", realCandidateFiles: realFiles.length,
  buggyFileRankedTop: selected[0] === target, llmChoseFile: chose, choseCorrect: chose === target,
  beforePass: before.pass, afterPass: after.pass,
  verdict: !before.pass && after.pass ? 'FIXED (real code, real committed vitest suite as oracle)' : after.pass ? 'already passing' : 'still failing',
  tokens: j.usage?.total_tokens ?? null, cost_usd: j.usage?.cost ?? null,
}, null, 2));
