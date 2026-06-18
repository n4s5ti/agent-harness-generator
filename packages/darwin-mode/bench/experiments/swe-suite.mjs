// SPDX-License-Identifier: MIT
//
// ADR-118: does the SWE-nucleus loop (ADR-117) GENERALIZE across varied real bugs,
// or did it fix one lucky case? Five independent multi-file tasks across different
// domains (intervals, slugify, gcd, chunk, query-parse), each with a real bug, real
// distractors (varied relevance), and a real test. For each: the variant's real
// contextBuilder selects files → real LLM identifies+fixes from real code → real
// test verdict. Reports pass-rate + per-task. Bounded (~5 calls, ~$0.003).
//
// Run: OPENROUTER_API_KEY=$(cat /tmp/.orkey) \
//   node --experimental-strip-types --no-warnings bench/experiments/swe-suite.mjs [model]

import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateBaselineHarness } from '../../dist/generator.js';
import { profileRepo } from '../../dist/repo_profiler.js';

const model = process.argv[2] || 'google/gemini-2.5-flash';
const key = (process.env.OPENROUTER_API_KEY || readFileSync('/tmp/.orkey', 'utf8')).trim();

const TASKS = [
  {
    id: 'intervals', prompt: 'fix the merge intervals bug', buggy: 'intervals.js',
    files: {
      'intervals.js': `export function merge(iv){const xs=[...iv].sort((a,b)=>a[0]-b[0]);const o=[];for(const [s,e] of xs){const l=o[o.length-1];if(l&&s<l[1]){l[1]=Math.max(l[1],e);}else o.push([s,e]);}return o;}\n`,
      'sort_helpers.js': `export const bySize=(a,b)=>(a[1]-a[0])-(b[1]-b[0]);\n`,
      'fmt.js': `export const fmt=iv=>'['+iv+']';\n`,
    },
    test: `import {merge} from './intervals.js';import a from 'node:assert';a.deepStrictEqual(merge([[1,4],[4,5]]),[[1,5]]);console.log('PASS');\n`,
  },
  {
    id: 'slugify', prompt: 'fix the slugify bug', buggy: 'slug.js',
    files: {
      'slug.js': `export function slug(s){return s.toLowerCase().replace(/[^a-z0-9]+/g,'-');}\n`, // bug: leading/trailing dash not trimmed
      'casing.js': `export const upper=s=>s.toUpperCase();\n`,
      'slug_notes.js': `// slug helpers for urls\nexport const MAXLEN=80;\n`,
    },
    test: `import {slug} from './slug.js';import a from 'node:assert';a.strictEqual(slug('Hello, World!'),'hello-world');console.log('PASS');\n`,
  },
  {
    id: 'gcd', prompt: 'fix the gcd bug', buggy: 'gcd.js',
    files: {
      'gcd.js': `export function gcd(a,b){while(b){[a,b]=[b,a%b];}return a;}\n`, // bug: negative inputs → negative result
      'math_utils.js': `export const lcm=(a,b)=>a*b;\n`,
      'gcd_doc.js': `// greatest common divisor\nexport const NAME='gcd';\n`,
    },
    test: `import {gcd} from './gcd.js';import a from 'node:assert';a.strictEqual(gcd(-12,8),4);a.strictEqual(gcd(0,5),5);console.log('PASS');\n`,
  },
  {
    id: 'chunk', prompt: 'fix the array chunk bug', buggy: 'chunk.js',
    files: {
      'chunk.js': `export function chunk(arr,n){const o=[];for(let i=0;i<arr.length;i+=n)o.push(arr.slice(i,i+n));return o;}\n`, // bug: n<=0 infinite loop
      'flatten.js': `export const flatten=a=>a.flat();\n`,
      'chunk_meta.js': `// split arrays into chunks\nexport const DEFAULT_N=2;\n`,
    },
    test: `import {chunk} from './chunk.js';import a from 'node:assert';a.deepStrictEqual(chunk([1,2,3],0),[[1,2,3]]);a.deepStrictEqual(chunk([1,2,3,4,5],2),[[1,2],[3,4],[5]]);console.log('PASS');\n`,
  },
  {
    id: 'query', prompt: 'fix the query string parser bug', buggy: 'query.js',
    files: {
      'query.js': `export function parse(q){const o={};for(const p of q.split('&')){const [k,v]=p.split('=');o[k]=v;}return o;}\n`, // bug: key without '=' → undefined instead of ''
      'encode.js': `export const enc=encodeURIComponent;\n`,
      'query_notes.js': `// parse url query strings\nexport const SEP='&';\n`,
    },
    test: `import {parse} from './query.js';import a from 'node:assert';a.deepStrictEqual(parse('a=1&b=2'),{a:'1',b:'2'});a.deepStrictEqual(parse('flag'),{flag:''});console.log('PASS');\n`,
  },
];

function makeRepo(task) {
  const r = mkdtempSync(join(tmpdir(), `swes-${task.id}-`));
  for (const [n, b] of Object.entries(task.files)) writeFileSync(join(r, n), b);
  writeFileSync(join(r, 'test.mjs'), task.test);
  return r;
}
function runTest(dir) { try { execFileSync(process.execPath, ['test.mjs'], { cwd: dir, timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] }); return { pass: true, out: 'PASS' }; } catch (e) { return { pass: false, out: (e.stderr?.toString() || e.message || '').split('\n').slice(0, 3).join(' | ').slice(0, 200) }; } }

const prof = await profileRepo(makeRepo(TASKS[0]));
const wr = mkdtempSync(join(tmpdir(), 'swes-wr-'));
const base = await generateBaselineHarness(prof, wr);
const ctxb = await import(`${base.dir}/context_builder.ts`);

async function solveOne(task) {
  const dir = makeRepo(task);
  const before = runTest(dir);
  const fileList = Object.keys(task.files);
  const selected = (ctxb.buildContext(task.prompt, fileList) ?? []).map((c) => c.path);
  const seen = selected.map((f) => `// FILE: ${f}\n${readFileSync(join(dir, f), 'utf8')}`).join('\n');
  const prompt = `A test fails. Identify the buggy file among those selected and fix it. Return STRICT JSON {"file":"<selected file>","content":"<full corrected file>"}. No fences/prose.\n--- selected files ---\n${seen}\n--- test.mjs ---\n${task.test}\n--- output ---\n${before.out}\n`;
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 1200, temperature: 0.1 }),
  });
  const j = await res.json();
  let raw = j.choices?.[0]?.message?.content ?? ''; const m = raw.match(/```(?:json)?\n([\s\S]*?)\n```/i); if (m) raw = m[1];
  let patch = null; try { patch = JSON.parse(raw); } catch { /**/ }
  let after = before, chose = patch?.file ?? null;
  if (patch && fileList.includes(patch.file) && typeof patch.content === 'string') {
    writeFileSync(join(dir, patch.file), patch.content); after = runTest(dir);
  }
  return { id: task.id, buggyRankedTop: selected[0] === task.buggy, llmChose: chose, choseCorrect: chose === task.buggy, fixed: !before.pass && after.pass, cost: j.usage?.cost ?? null };
}

const results = [];
for (const t of TASKS) results.push(await solveOne(t));
const fixed = results.filter((r) => r.fixed).length;
const totalCost = results.reduce((s, r) => s + (r.cost ?? 0), 0);
console.log(JSON.stringify({ model, fixed: `${fixed}/${TASKS.length}`, choseCorrectFile: results.filter((r) => r.choseCorrect).length, totalCostUSD: +totalCost.toFixed(5), perTask: results }, null, 2));
