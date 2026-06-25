// SPDX-License-Identifier: MIT
//
// ADR-191 — TimesFM → ruvector translation via CHUNKED ITERATIVE SYNTHESIS.
//
// Greenfield Python/JAX → Rust/candle translation inverts the SWE-bench dynamic: instead of the
// agent localizing-and-patching within a known repo, *we act as the compiler* and feed strictly
// bounded, sequentially-verifiable generation tasks. A naive "port this repo" prompt collapses the
// context window and hallucinates invalid candle tensor math (sparse training signal); this driver
// decomposes the port into ordered chunks, each mapped to a routing tier and gated on its own Rust
// unit test, advancing only when the chunk's `cargo test` goes green.
//
// Per ADR-191 it implements:
//   (1) a manifest of chunks  [{id, module, tier, sourceFiles, targetPath, contextDocs, testCmd}]
//   (2) for each chunk in order, a BOUNDED prompt that PRE-SEEDS contextDocs (Phase-3 discipline §1),
//       forcing temperature 0 for `performance` tensor-math chunks via the chebTemp/zero-temp hook
//       in agentic-loop.mjs (ADR-189 §2 — no creative sampling while aligning matrix dims),
//   (3) generation via solve-agentic (imported `agenticSolve`, or shelled out with `--shell`),
//   (4) a per-chunk GATE on the Rust unit test (testCmd e.g. `cargo test -p timesfm attention_shapes`),
//       advancing only when green; on failure it ESCALATES the routing tier (economy → balanced →
//       performance), mirroring solve-agentic.mjs's empty-patch cascade (ADR-182).
//
// --plan / --dry-run prints the full chunk plan and the tier→model + temperature decisions for every
// chunk WITHOUT making any paid call (fully OFFLINE — this is the freeze-safe inspection path).
//
// Run (plan, offline, $0):
//   node --experimental-strip-types --no-warnings \
//     bench/translate/chunked-synthesis.mjs --manifest timesfm-port.json --plan
//
// Run (live — needs OPENROUTER_API_KEY; spends, gated by the freeze):
//   OPENROUTER_API_KEY=$(cat /tmp/.orkey) node --experimental-strip-types --no-warnings \
//     bench/translate/chunked-synthesis.mjs --manifest timesfm-port.json \
//     --repo ~/projects/RuVector --max-steps 20
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chebTemp } from '../swebench/agentic-loop.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const has = (f) => args.includes(f);
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));

const PLAN = has('--plan') || has('--dry-run');     // OFFLINE: print the chunk plan, make zero paid calls
const SHELL = has('--shell');                       // shell out to solve-agentic.mjs instead of importing
const MANIFEST = rel(argv('--manifest', 'timesfm-port.json'));
const REPO = argv('--repo', null);                  // candle/Rust crate work tree (required only for a live run)
const MAX_STEPS = +argv('--max-steps', 20);
const OUT = rel(argv('--out', 'chunked-synthesis-report.json'));

// ADR-191 + ADR-185 tiered-routing economics. Each tier maps to a default OpenRouter model.
// Tensor-math ('performance') chunks force greedy (temp 0); cheaper chunks may use the Chebyshev
// hot→greedy schedule. The escalation order mirrors the empty-patch cascade (cheap → expensive).
const TIER_MODEL = {
  economy: argv('--economy-model', 'deepseek/deepseek-chat'),
  balanced: argv('--balanced-model', 'anthropic/claude-3.5-sonnet'),
  performance: argv('--performance-model', 'anthropic/claude-opus-4'),
};
const TIER_ORDER = ['economy', 'balanced', 'performance'];

// Temperature policy (ADR-189): performance chunks are pinned greedy; others get the Chebyshev
// hot-early/greedy-late schedule (tempSchedule(step, maxSteps) passed to agenticSolve).
function tempPolicy(tier) {
  if (tier === 'performance') return { mode: 'zero-temp', tempSchedule: () => 0 };
  return { mode: 'cheb (hot→greedy)', tempSchedule: (step, maxSteps) => chebTemp(step, maxSteps) };
}

// Phase-3 §1 — PRE-SEED the bounded prompt with the chunk's contextDocs (the exact candle ops the
// module needs) so the generator never has to localize. Strictly bounded: no whole-repo context.
function buildPrompt(chunk, repoRoot) {
  const docs = (chunk.contextDocs || []).map((d) => {
    const p = repoRoot && !isAbsolute(d) ? join(repoRoot, d) : d;
    let body = '';
    try { if (existsSync(p)) body = readFileSync(p, 'utf8').slice(0, 4000); } catch { /**/ }
    return `### context: ${d}\n${body || '(doc not found — seed inline)'}`;
  }).join('\n\n');
  const sources = (chunk.sourceFiles || []).map((s) => {
    const p = repoRoot && !isAbsolute(s) ? join(repoRoot, s) : s;
    let body = '';
    try { if (existsSync(p)) body = readFileSync(p, 'utf8').slice(0, 6000); } catch { /**/ }
    return `### python source: ${s}\n${body || '(source not found at run time)'}`;
  }).join('\n\n');
  return [
    `# CHUNK ${chunk.id} — ${chunk.module} (tier=${chunk.tier})`,
    `Translate ONLY this module from Python/JAX to Rust/candle. Write to ${chunk.targetPath}.`,
    `Phase-3 discipline: write a Rust unit test with dummy [B,T,N] tensors FIRST, then the forward pass;`,
    `use only the candle ops in the pre-seeded context. Do not exceed this module's boundary.`,
    `The chunk is DONE only when \`${chunk.testCmd}\` is green.`,
    '',
    docs,
    '',
    sources,
  ].join('\n');
}

// The per-chunk GATE: run the chunk's Rust unit test. Green ⇒ advance. (Offline plan never calls this.)
function runGate(chunk, repoRoot) {
  try {
    execSync(chunk.testCmd, { cwd: repoRoot || HERE, stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000, maxBuffer: 1 << 26 });
    return { green: true };
  } catch (e) {
    const out = String((e.stdout || '') + (e.stderr || '')).split('\n').slice(-30).join('\n');
    return { green: false, tail: out.slice(-2000) };
  }
}

// Live synthesis of one chunk at a given tier. Imports agenticSolve unless --shell.
async function synthChunk(chunk, tier, repoRoot) {
  const model = TIER_MODEL[tier];
  const { tempSchedule } = tempPolicy(tier);
  const prompt = buildPrompt(chunk, repoRoot);
  if (SHELL) {
    // Shell out to the existing agentic solver as a subprocess (kept simple — uses its CLI surface).
    const cebFlag = tier === 'performance' ? '--temperature 0' : '--cheb-temp';
    execSync(
      `node --experimental-strip-types --no-warnings ${join(HERE, '../swebench/solve-agentic.mjs')} ` +
      `--model ${model} --max-steps ${MAX_STEPS} ${cebFlag} --instance ${chunk.id}`,
      { cwd: repoRoot || HERE, stdio: ['ignore', 'pipe', 'pipe'], timeout: 1800000, maxBuffer: 1 << 28 },
    );
    return { ok: true, model };
  }
  // Import path: drive the ReAct core directly against the Rust work tree as the io surface.
  const { agenticSolve } = await import('../swebench/agentic-loop.mjs');
  const { mkLlm, makeRepoIo } = await import('./synthesis-runtime.mjs').catch(() => ({}));
  if (!mkLlm || !makeRepoIo) throw new Error('live import runtime not present — use --shell or run --plan');
  const llm = mkLlm(model);
  const io = makeRepoIo(repoRoot);
  await agenticSolve({ problem: prompt, io, llm, maxSteps: MAX_STEPS, tempSchedule });
  return { ok: true, model };
}

// ----- OFFLINE PLAN -----
function printPlan(chunks) {
  console.log('ADR-191 — chunked iterative synthesis plan (OFFLINE dry-run, $0 — no paid calls)\n');
  console.log(`manifest : ${MANIFEST}`);
  console.log(`repo     : ${REPO || '(not set — live run requires --repo)'}`);
  console.log(`chunks   : ${chunks.length}   tiers: ${JSON.stringify(TIER_MODEL)}\n`);
  for (const [i, c] of chunks.entries()) {
    const pol = tempPolicy(c.tier);
    const start = TIER_ORDER.indexOf(c.tier);
    const escPath = TIER_ORDER.slice(start).map((t) => `${t}(${TIER_MODEL[t]})`).join(' → ');
    console.log(`[${i + 1}/${chunks.length}] CHUNK ${c.id}  module=${c.module}`);
    console.log(`        tier        : ${c.tier}  →  ${TIER_MODEL[c.tier]}`);
    console.log(`        temperature : ${pol.mode}`);
    console.log(`        sources     : ${(c.sourceFiles || []).join(', ') || '(none)'}`);
    console.log(`        target      : ${c.targetPath}`);
    console.log(`        contextDocs : ${(c.contextDocs || []).join(', ') || '(none)'}`);
    console.log(`        gate (test) : ${c.testCmd}`);
    console.log(`        escalation  : ${escPath}`);
    console.log('');
  }
  console.log('Each chunk advances only when its gate is green; on failure the tier escalates along');
  console.log('the escalation path above (empty-patch cascade, ADR-182). No model is invoked in --plan.');
}

// ----- LIVE DRIVER -----
async function run() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const chunks = manifest.chunks || manifest.instances || [];
  if (PLAN) { printPlan(chunks); return; }

  if (!REPO) { console.error('live run requires --repo <rust crate work tree>'); process.exit(2); }
  const report = [];
  for (const [i, chunk] of chunks.entries()) {
    const row = { id: chunk.id, module: chunk.module, baseTier: chunk.tier, tierUsed: null, green: false, attempts: [] };
    const start = TIER_ORDER.indexOf(chunk.tier);
    let green = false;
    // Cascade: try the chunk's base tier; on a red gate, escalate up the tier ladder (cheap → expensive).
    for (let t = start; t < TIER_ORDER.length && !green; t++) {
      const tier = TIER_ORDER[t];
      console.error(`[${i + 1}/${chunks.length}] CHUNK ${chunk.id} @ tier=${tier} (${TIER_MODEL[tier]})`);
      try { await synthChunk(chunk, tier, REPO); } catch (e) { row.attempts.push({ tier, error: String(e.message || e) }); continue; }
      const gate = runGate(chunk, REPO);
      row.attempts.push({ tier, green: gate.green, tail: gate.tail });
      if (gate.green) { green = true; row.tierUsed = tier; }
      else console.error(`        gate RED — escalating tier`);
    }
    row.green = green;
    report.push(row);
    if (!green) { console.error(`        CHUNK ${chunk.id} FAILED all tiers — STOP (sequential gate).`); break; }
  }
  writeFileSync(OUT, JSON.stringify({ manifest: MANIFEST, repo: REPO, tiers: TIER_MODEL, chunks: report }, null, 2));
  const passed = report.filter((r) => r.green).length;
  console.error(`\nDONE ${passed}/${chunks.length} chunks green → ${OUT}`);
}

run().catch((e) => { console.error(e); process.exit(1); });
