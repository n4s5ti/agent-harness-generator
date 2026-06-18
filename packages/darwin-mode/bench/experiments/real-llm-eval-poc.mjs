// SPDX-License-Identifier: MIT
//
// Real-LLM evaluation proof-of-concept (ADR-107, toward ADR-098). The Tier-2
// sandbox (ADR-106) runs the variant's real surface code on SYNTHETIC tasks.
// This PoC closes the last gap with ONE real example: a genuinely failing test,
// a real OpenRouter model asked to fix the code, and the REAL test command as
// the verdict — the production evaluation path, end-to-end, for a single call.
//
// It is intentionally NOT wired into evolve() (that would cost one LLM call per
// variant per generation). It proves the path works and is honest about cost.
//
// Run: OPENROUTER_API_KEY=$(cat /tmp/.orkey) node bench/experiments/real-llm-eval-poc.mjs [model]

import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const model = process.argv[2] || 'google/gemini-2.5-flash';
const key = (process.env.OPENROUTER_API_KEY || readFileSync('/tmp/.orkey', 'utf8')).trim();

// A real micro-task: merge-intervals with a real bug (does NOT merge touching
// intervals like [1,4] & [4,5]); the hidden test covers exactly that case.
const BUGGY = `export function merge(intervals) {
  const xs = [...intervals].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of xs) {
    const last = out[out.length - 1];
    if (last && s < last[1]) { last[1] = Math.max(last[1], e); }
    else out.push([s, e]);
  }
  return out;
}
`;
const TEST = `import { merge } from './sol.js';
import assert from 'node:assert';
// touching intervals must merge: [1,4]+[4,5] => [1,5]
assert.deepStrictEqual(merge([[1,4],[4,5]]), [[1,5]], 'touching intervals must merge');
assert.deepStrictEqual(merge([[1,3],[2,6],[8,10]]), [[1,6],[8,10]]);
assert.deepStrictEqual(merge([[1,4],[0,4]]), [[0,4]]);
console.log('ALL TESTS PASS');
`;

const dir = mkdtempSync(join(tmpdir(), 'llm-eval-'));
writeFileSync(join(dir, 'sol.js'), BUGGY);
writeFileSync(join(dir, 'test.mjs'), TEST);

function runTest() {
  try {
    const out = execFileSync(process.execPath, ['test.mjs'], { cwd: dir, timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { pass: true, output: out.toString().trim() };
  } catch (e) {
    return { pass: false, output: (e.stderr?.toString() || e.message || '').split('\n').slice(0, 4).join(' | ').slice(0, 300) };
  }
}

const before = runTest();
console.log('BEFORE fix:', before.pass ? 'PASS' : 'FAIL —', before.output);

// The harness "agent": the failing test output is the signal the surfaces would
// carry (contextBuilder → the file; planner → plan; retryPolicy → persistence).
// Here we make one real model call to produce the corrected file.
const prompt =
  `This JavaScript file (sol.js) fails its test. Return ONLY the corrected full contents of sol.js — no fences, no prose.\n\n` +
  `--- sol.js ---\n${BUGGY}\n--- failing test output ---\n${before.output}\n`;

const t0 = Date.now();
const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 1200, temperature: 0.1 }),
});
const j = await res.json();
const latency_ms = Date.now() - t0;
let fix = j.choices?.[0]?.message?.content ?? '';
const m = fix.match(/```(?:[a-z]*)\n([\s\S]*?)\n```/i);
if (m) fix = m[1];
writeFileSync(join(dir, 'sol.js'), fix.trim() + '\n');

const after = runTest();
console.log('AFTER fix :', after.pass ? 'PASS' : 'FAIL —', after.output);
console.log(JSON.stringify({
  model,
  verdict: !before.pass && after.pass ? 'FIXED (real test now passes)' : after.pass ? 'already passing' : 'still failing',
  beforePass: before.pass, afterPass: after.pass,
  tokens: j.usage?.total_tokens ?? null, cost_usd: j.usage?.cost ?? null, latency_ms,
}, null, 2));
