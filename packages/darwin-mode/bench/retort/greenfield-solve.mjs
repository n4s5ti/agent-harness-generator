// SPDX-License-Identifier: MIT
//
// MetaHarness greenfield solver — the Retort adapter for the darwin-mode agentic
// harness. Where solve-agentic.mjs runs a bounded ReAct loop to REPAIR an existing
// SWE-bench repo, this runs the *same* loop primitives (agentic-loop.mjs:
// parseAction / makeTools / stateHash / the anti-thrash convo protocol) on a
// GREENFIELD task: an empty workspace + a TASK.md spec → the model writes the code,
// builds it, runs its own tests, and finishes. Retort then builds/tests/scores the
// workspace with its OWN scorers (we touch nothing in Retort's scoring path).
//
// What makes it "MetaHarness" and not a one-shot completion:
//   • bounded ReAct loop with read/grep/ls/edit/write/run tools (genuine reuse of
//     the darwin-mode loop primitives — imported, not reimplemented);
//   • model ROUTING — a cheap default model (deepseek-v4-pro) that ESCALATES to a
//     frontier model after repeated build/test failures (the cost lever);
//   • optional agenticow COW memory (--memory) for cross-step scratch state.
//
// The OpenRouter key is read from env (OPENROUTER_API_KEY) or /tmp/.orkey and is
// passed only to the LLM HTTP call — never written into the workspace or the prompt.
//
// Usage (invoked by the Retort metaharness runner, cwd = the playpen workspace):
//   node --experimental-strip-types greenfield-solve.mjs \
//     --lang python --model deepseek/deepseek-v4-pro \
//     --escalate deepseek/deepseek-r1 --max-steps 40 --out result.json
//
// Emits ONE JSON line on stdout (the runner parses it for tokens/cost):
//   {"tokens":N,"cost":USD,"steps":S,"calls":C,"model":"...","escalated":bool,"done":bool}

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── genuine reuse of the darwin-mode agentic core ──
const HERE = dirname(fileURLToPath(import.meta.url));
const { parseAction, makeTools, stateHash } = await import(join(HERE, '..', 'swebench', 'agentic-loop.mjs'));

const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const has = (f) => args.includes(f);

const WORK = process.cwd();
const LANG = argv('--lang', 'python');
const MODEL = argv('--model', 'deepseek/deepseek-v4-pro');   // cheap tier-1 default
const ESCALATE = argv('--escalate', '');                      // frontier tier-2 (empty = single-tier)
const ESCALATE_AFTER = +argv('--escalate-after', 2);          // consecutive run-failures before escalating
const MAX_STEPS = +argv('--max-steps', 40);
const TASK_FILE = argv('--task', 'TASK.md');
const OUT = (() => { const o = argv('--out', 'metaharness-result.json'); return isAbsolute(o) ? o : join(WORK, o); })();
const BASE_URL = argv('--base-url', 'https://openrouter.ai/api/v1').replace(/\/$/, '');
const KEY_ENV = argv('--api-key-env', 'OPENROUTER_API_KEY');
const USE_MEMORY = has('--memory');
const RUN_TIMEOUT_MS = +argv('--run-timeout', 120) * 1000;
const MAX_TOKENS = +argv('--max-tokens', 8192);

const key = (process.env[KEY_ENV] || (() => { try { return readFileSync('/tmp/.orkey', 'utf8'); } catch { return ''; } })()).trim();
if (!key) { console.error('metaharness: no API key (set OPENROUTER_API_KEY or /tmp/.orkey)'); process.exit(2); }

const taskPath = isAbsolute(TASK_FILE) ? TASK_FILE : join(WORK, TASK_FILE);
const problem = existsSync(taskPath) ? readFileSync(taskPath, 'utf8') : '';
if (!problem.trim()) { console.error(`metaharness: empty/missing task spec at ${taskPath}`); process.exit(2); }

// ── the validated search/replace primitive (shared shape with solve-repair.mjs) ──
function applyEdit(content, search, replace) {
  if (search.length && content.includes(search)) return content.replace(search, replace);
  const cl = content.split('\n'); const sl = search.split('\n');
  while (sl.length && sl[sl.length - 1].trim() === '') sl.pop();
  while (sl.length && sl[0].trim() === '') sl.shift();
  if (!sl.length) return null;
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  for (let i = 0; i + sl.length <= cl.length; i++) {
    let ok = true; for (let j = 0; j < sl.length; j++) { if (norm(cl[i + j]) !== norm(sl[j])) { ok = false; break; } }
    if (!ok) continue;
    const indOf = (s) => (s.match(/^[ \t]*/) || [''])[0];
    const delta = indOf(cl[i]).length - indOf(sl[0]).length;
    const rl = replace.split('\n').map((line) => { if (!line.trim()) return line; if (delta >= 0) return ' '.repeat(delta) + line; const lead = indOf(line).length; return line.slice(Math.min(-delta, lead)); });
    return [...cl.slice(0, i), ...rl, ...cl.slice(i + sl.length)].join('\n');
  }
  return null;
}

// ── tool I/O injected into the reused makeTools(); greenfield: tests are editable ──
function listDirRec(abs) {
  // shallow list with a dir marker — enough for the model to navigate.
  return readdirSync(abs, { withFileTypes: true }).map((d) => (d.isDirectory() ? d.name + '/' : d.name));
}
function grepRepo(pattern, glob) {
  try {
    const a = ['-rIn', '--exclude-dir=.git', '--exclude-dir=node_modules', '--exclude-dir=.venv'];
    if (glob) a.push(`--include=${glob}`);
    a.push(pattern, '.');
    return execFileSync('grep', a, { cwd: WORK, encoding: 'utf8', maxBuffer: 1 << 24 });
  } catch { return ''; }
}
const io = {
  work: WORK, path: { join }, MAX_OUT: 4000,
  readFile: (p) => readFileSync(p, 'utf8'),
  listDir: listDirRec,
  writeFile: (p, c) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); },
  exists: existsSync,
  grepRepo,
  applyEdit,
  isTestPath: () => false,        // greenfield: the agent writes the tests too
  gitDiff: () => '',              // unused (scoring is Retort's job)
  runTests: () => ({ resolved: false, logTail: 'use the {"tool":"run"} tool to run builds/tests' }),
};
const baseTools = makeTools(io);

// ── greenfield-only tools layered on top of the reused read/grep/ls/edit set ──
let runFailures = 0;
const tools = {
  ls: baseTools.ls, read: baseTools.read, grep: baseTools.grep,
  edit: baseTools.edit, line_edit: baseTools.line_edit,
  write(a) {
    try {
      const rel = String(a.path || '').replace(/^\.?\//, '');
      const abs = join(WORK, rel);
      if (!abs.startsWith(WORK)) return 'write error: path escapes workspace';
      if (typeof a.content !== 'string') return 'write error: content must be a string';
      io.writeFile(abs, a.content);
      return `wrote ${rel} (${a.content.length} bytes)`;
    } catch (e) { return `write error: ${String(e.message || e)}`; }
  },
  run(a) {
    if (!a.cmd || typeof a.cmd !== 'string') return 'run error: cmd (string) required';
    try {
      const out = execSync(a.cmd, { cwd: WORK, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] });
      runFailures = 0;
      const t = (out || '').slice(-3500);
      return `run ok (exit 0):\n${t || '(no output)'}`;
    } catch (e) {
      runFailures++;
      const tail = ((e.stdout || '') + '\n' + (e.stderr || '')).slice(-3500);
      return `run FAILED (exit ${e.status ?? '?'}):\n${tail || String(e.message || e)}`;
    }
  },
};

const SYSTEM =
  'You are an autonomous software engineer working in an EMPTY project workspace. '
  + 'Your job: read the spec in TASK.md and implement everything it asks for, in '
  + `the ${LANG} language, writing real files into the current directory. Each turn, output `
  + 'EXACTLY ONE JSON object on a single line — a tool call — and NOTHING else (no prose, '
  + 'no markdown). Tools:\n'
  + '{"tool":"ls","dir":"."}                         list a directory\n'
  + '{"tool":"read","path":"f","start":1,"end":80}    read a file (range optional)\n'
  + '{"tool":"write","path":"app/main.py","content":"<full file text>"}  create/overwrite a file\n'
  + '{"tool":"edit","path":"f","search":"<exact lines>","replace":"<new lines>"}  search/replace edit\n'
  + '{"tool":"line_edit","path":"f","start":12,"end":15,"replace":"<new text>"}  replace a line range\n'
  + '{"tool":"grep","pattern":"reg","glob":"*.py"}    search the workspace\n'
  + '{"tool":"run","cmd":"python -m pytest -q"}        run a shell command (build / install deps / tests)\n'
  + '{"tool":"done"}                                  finish (only after tests pass)\n'
  + 'Strategy: implement the code with `write`, add a README.md and AT LEAST 3 tests, install '
  + 'any deps and RUN the build + tests with `run`, fix failures from the output, and only then '
  + 'call done. Prefer the standard/embedded options the spec names (e.g. SQLite). Keep the '
  + 'project runnable from the current directory. Output ONE JSON action per turn.';

// ── OpenRouter chat call with usage/cost; returns {raw, cost, tokens} ──
async function llmCall(model, convo) {
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: convo }];
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'retort-metaharness' },
        body: JSON.stringify({ model, messages, max_tokens: MAX_TOKENS, temperature: 0, usage: { include: true } }),
      });
      if (!res.ok && (res.status === 429 || res.status >= 500)) { lastErr = new Error(`http ${res.status}`); continue; }
      const j = await res.json();
      if (j.error) { lastErr = new Error(j.error.message || 'api error'); continue; }
      const u = j.usage || {};
      const tokens = (u.total_tokens ?? ((u.prompt_tokens || 0) + (u.completion_tokens || 0))) || 0;
      return { raw: j.choices?.[0]?.message?.content ?? '', cost: u.cost ?? 0, tokens };
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error('llm failed');
}

// ── optional agenticow COW memory (best-effort; absent => no-op) ──
let memory = null;
if (USE_MEMORY) {
  try { const m = await import('agenticow'); memory = (m.default || m).create ? (m.default || m).create() : null; }
  catch { console.error('metaharness: agenticow not installed; continuing without COW memory'); }
}

// ── the bounded ReAct loop (greenfield variant of agenticSolve) ──
const transcript = [];
const seen = new Set();
let cost = 0, tokens = 0, calls = 0, done = false, escalated = false;
let model = MODEL;
const header = `--- TASK.md ---\n${problem.slice(0, 7000)}\n--- begin. Output ONE JSON action. ---`;

for (let step = 1; step <= MAX_STEPS && !done; step++) {
  // routing: escalate to the frontier tier after repeated build/test failures.
  if (ESCALATE && !escalated && runFailures >= ESCALATE_AFTER) {
    model = ESCALATE; escalated = true;
    transcript.push({ actionRaw: '(router)', obs: `⚙️ SYSTEM: escalated to frontier model ${ESCALATE} after ${runFailures} consecutive failures.` });
  }
  const convo = header + '\n' + transcript.map((t) => `>>> ${t.actionRaw}\n${t.obs}`).join('\n').slice(-14000);
  let r;
  try { r = await llmCall(model, convo); }
  catch (e) { transcript.push({ actionRaw: '(model error)', obs: String(e.message || e) }); break; }
  calls++; cost += r.cost || 0; tokens += r.tokens || 0;
  const action = parseAction(r.raw);
  let obs;
  if (action.tool === 'done' || action.tool === 'submit') { done = true; obs = 'done.'; }
  else if (action.tool === 'noop') obs = `error: ${action.error}. Output ONE valid JSON tool action.`;
  else if (tools[action.tool]) obs = tools[action.tool](action);
  else obs = `error: unknown tool "${action.tool}". Valid: ls, read, write, edit, line_edit, grep, run, done.`;
  if (['read', 'grep', 'ls'].includes(action.tool)) {
    const h = stateHash(action.tool + '|' + JSON.stringify(action) + '|' + obs);
    if (seen.has(h)) obs += '\n⚠️ SYSTEM: you already ran this exact action with this result — change strategy (write/run/edit) or call done.';
    else seen.add(h);
  }
  if (memory) { try { memory.set(`step:${step}`, JSON.stringify({ tool: action.tool, obs: obs.slice(0, 500) })); } catch { /**/ } }
  const actionRaw = JSON.stringify(action.tool === 'noop' ? { raw: (r.raw || '').slice(0, 160) } : action).slice(0, 400);
  transcript.push({ actionRaw, obs });
  console.error(`[step ${step}/${MAX_STEPS}] ${action.tool}${escalated ? ' (esc)' : ''} — ${obs.split('\n')[0].slice(0, 100)}`);
}

const summary = { tokens, cost: +cost.toFixed(6), steps: transcript.length, calls, model, escalated, done };
try { writeFileSync(OUT, JSON.stringify({ ...summary, lang: LANG }, null, 2)); } catch { /**/ }
console.log(JSON.stringify(summary));
