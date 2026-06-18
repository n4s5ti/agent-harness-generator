// Polyglot code benchmark — one (model × language) cell, execution-scored.
// Usage: node run-cell.mjs <model-id> <lang>
// Emits one JSON line and writes /tmp/polyglot/out/<safe>__<lang>.json
//
// Task: merge overlapping intervals. Simple line I/O (no JSON lib needed in any
// language → fair). Touching intervals ([1,4],[4,5]) MUST merge. We compile (if
// needed) and run the model's program against 8 hidden cases; quality = pass rate.

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const model = process.argv[2];
const lang = process.argv[3];
const key = (process.env.OPENROUTER_API_KEY || readFileSync('/tmp/.orkey', 'utf8')).trim();

// ── the task contract (identical across languages) ──
const CONTRACT = `Read from standard input:
- line 1: an integer N (number of intervals, N >= 0)
- next N lines: two space-separated integers "start end" (may be negative, may be unsorted)
Merge all overlapping intervals. Intervals that only TOUCH at an endpoint (e.g. "1 4" and "4 5") MUST be merged (treated as overlapping).
Write to standard output:
- line 1: an integer M (number of merged intervals)
- next M lines: each merged interval as "start end", sorted ascending by start.
Output nothing else (no prompts, no debug).`;

// ── 8 hidden test cases: input -> expected stdout (normalized) ──
const TESTS = [
  ['0\n', '0'],
  ['1\n1 3\n', '1\n1 3'],
  ['3\n1 3\n2 6\n8 10\n', '2\n1 6\n8 10'],
  ['2\n1 10\n2 5\n', '1\n1 10'],            // nested
  ['2\n1 4\n4 5\n', '1\n1 5'],              // touching -> merge
  ['3\n8 10\n1 3\n2 6\n', '2\n1 6\n8 10'],  // unsorted
  ['2\n-5 -1\n-3 0\n', '1\n-5 0'],          // negatives
  ['3\n1 2\n3 4\n5 6\n', '3\n1 2\n3 4\n5 6'], // disjoint
];

const LANGS = {
  python: { file: 'sol.py',  run: ['python3', 'sol.py'] },
  js:     { file: 'sol.js',  run: ['node', 'sol.js'] },
  ts:     { file: 'sol.ts',  run: ['node', '--experimental-strip-types', 'sol.ts'] },
  rust:   { file: 'sol.rs',  compile: ['rustc', '-O', 'sol.rs', '-o', 'sol'], run: ['./sol'] },
  cpp:    { file: 'sol.cpp', compile: ['g++', '-O2', '-o', 'sol', 'sol.cpp'], run: ['./sol'] },
  c:      { file: 'sol.c',   compile: ['gcc', '-O2', '-o', 'sol', 'sol.c'],   run: ['./sol'] },
};

const cfg = LANGS[lang];
if (!cfg) { console.error('unknown lang', lang); process.exit(2); }

const langName = { python: 'Python', js: 'JavaScript', ts: 'TypeScript', rust: 'Rust', cpp: 'C++', c: 'C' }[lang];
const PROMPT = `Write a complete, self-contained ${langName} program that solves this task.\n\n${CONTRACT}\n\nOutput ONLY the ${langName} source code — no markdown fences, no explanation.`;

function unfence(t) {
  const m = t.match(/```(?:[a-zA-Z+#]*)\n([\s\S]*?)\n```/);
  return (m ? m[1] : t).trim() + '\n';
}
const norm = (s) => s.replace(/\r/g, '').split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n+$/, '');

const t0 = Date.now();
let j;
try {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: PROMPT }], max_tokens: 4000, temperature: 0.2 }),
  });
  j = await res.json();
} catch (e) {
  j = { error: String(e) };
}
const latency_ms = Date.now() - t0;
const code = unfence(j.choices?.[0]?.message?.content || '');
const tokens = j.usage?.total_tokens || 0;
const cost_reported = j.usage?.cost ?? null;

const safe = model.replace(/[^a-z0-9]+/gi, '_');
const dir = join('/tmp/polyglot/work', `${safe}__${lang}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, cfg.file), code);

let compile_ok = true, compile_err = '';
if (cfg.compile) {
  try {
    execFileSync(cfg.compile[0], cfg.compile.slice(1), { cwd: dir, timeout: 30000, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    compile_ok = false;
    compile_err = (e.stderr ? e.stderr.toString() : String(e)).slice(0, 300);
  }
}

let passed = 0;
const total = TESTS.length;
const failures = [];
if (compile_ok && code.trim().length > 0) {
  for (const [input, expected] of TESTS) {
    try {
      const got = execFileSync(cfg.run[0], cfg.run.slice(1), { cwd: dir, input, timeout: 10000, stdio: ['pipe', 'pipe', 'ignore'] }).toString();
      if (norm(got) === norm(expected)) passed++;
      else failures.push({ input: input.replace(/\n/g, '|'), want: expected.replace(/\n/g, '|'), got: norm(got).replace(/\n/g, '|').slice(0, 60) });
    } catch (e) {
      failures.push({ input: input.replace(/\n/g, '|'), err: 'runtime/timeout' });
    }
  }
}

const out = { model, lang, passed, total, quality: Math.round((passed / total) * 100), compile_ok, compile_err, tokens, cost_reported, latency_ms, code_bytes: code.length, failures: failures.slice(0, 3) };
mkdirSync('/tmp/polyglot/out', { recursive: true });
writeFileSync(join('/tmp/polyglot/out', `${safe}__${lang}.json`), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ model, lang, passed, total, quality: out.quality, compile_ok, tokens, cost_reported, latency_ms }));
