#!/usr/bin/env node
// Pure-function tests for trace-localize.mjs (ADR-196 Phase-2 #4). NO network / NO Docker: the repro
// writer and the trace runner are stubbed; the tracer output is a canned string. Run: node trace-localize.test.mjs
import assert from 'node:assert';
import {
  parseTrace, rankTraceFrames, traceLocalize, formatTraceSeedForAgent,
  buildPyTracer, TRACE_BEGIN, TRACE_END, TRACE_PATH,
} from './trace-localize.mjs';

let pass = 0;
const ta = async (name, fn) => { try { await fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; } };
const t = (name, fn) => { try { fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; } };

// Helper: wrap a trace object in the sentinel block the way the Python tracer prints it, plus noise.
const wrap = (obj, noise = '') =>
  `some pytest noise\nTraceback (most recent call last)\n${noise}\n${TRACE_BEGIN}\n${JSON.stringify(obj)}\n${TRACE_END}\nexit status 1`;

console.log('trace-localize.mjs unit tests:');

// ── parseTrace ──────────────────────────────────────────────────────────────────────────────────
t('parseTrace extracts the JSON block from a noisy log tail', () => {
  const obj = { seen: [['src/a.py', 'foo', 10]], counts: { 'src/a.py': 3 }, tb: [['src/a.py', 'foo', 12]], err: ['ValueError', 'boom'] };
  const p = parseTrace(wrap(obj));
  assert(p.ok === true, 'parsed');
  assert.deepEqual(p.tb, [['src/a.py', 'foo', 12]], 'traceback frames recovered');
  assert(p.counts['src/a.py'] === 3, 'counts recovered');
  assert(p.err[0] === 'ValueError', 'err recovered');
});

t('parseTrace returns ok:false on missing / malformed block (no fabricated trace)', () => {
  assert(parseTrace('no sentinels here').ok === false, 'no block → not ok');
  assert(parseTrace(`${TRACE_BEGIN}\n{not valid json\n${TRACE_END}`).ok === false, 'malformed json → not ok');
  assert(parseTrace('').ok === false && parseTrace(null).ok === false, 'empty/null safe');
});

t('parseTrace takes the LAST block when several are present (re-run robustness)', () => {
  const a = wrap({ seen: [], counts: { 'old.py': 1 }, tb: [], err: null });
  const b = wrap({ seen: [], counts: { 'new.py': 9 }, tb: [], err: null });
  const p = parseTrace(a + '\n' + b);
  assert(p.counts['new.py'] === 9 && !p.counts['old.py'], 'last block wins');
});

// ── rankTraceFrames ────────────────────────────────────────────────────────────────────────────
t('rankTraceFrames ranks the failure path FIRST, then by execution frequency', () => {
  const parsed = parseTrace(wrap({
    // a high-frequency util that is NOT on the failure path (a symptom distractor — §52)
    seen: [['lib/util.py', 'helper', 5], ['lib/core.py', 'process', 40], ['lib/api.py', 'wrap', 7]],
    counts: { 'lib/util.py': 500, 'lib/core.py': 30, 'lib/api.py': 12 },
    // traceback: outermost = api.wrap, innermost = core.process (where it raised → the fix-site)
    tb: [['lib/api.py', 'wrap', 7], ['lib/core.py', 'process', 44]],
    err: ['TypeError', 'bad'],
  }));
  const r = rankTraceFrames(parsed, { k: 12 });
  // the innermost traceback frame's file (core.py) must outrank the hot-but-off-path util.py
  assert(r.files[0].file === 'lib/core.py', `innermost-frame file leads, got ${r.files[0].file}`);
  assert(r.files[0].inTraceback === true, 'leader is flagged on the failure path');
  const util = r.files.find((f) => f.file === 'lib/util.py');
  assert(util && util.inTraceback === false, 'the hot off-path util is included but not on the path');
  const coreIdx = r.files.findIndex((f) => f.file === 'lib/core.py');
  const utilIdx = r.files.findIndex((f) => f.file === 'lib/util.py');
  assert(coreIdx < utilIdx, 'failure-path file ranks above the hot symptom distractor');
});

t('rankTraceFrames frames list is innermost-first (raise site leads)', () => {
  const parsed = parseTrace(wrap({
    seen: [], counts: { 'a.py': 1, 'b.py': 1 },
    tb: [['a.py', 'outer', 1], ['b.py', 'inner', 99]], err: ['E', 'x'],
  }));
  const r = rankTraceFrames(parsed);
  assert(r.frames[0].file === 'b.py' && r.frames[0].line === 99, 'innermost (raise) frame is first');
  assert(r.frames[0].depth === 0, 'innermost frame has depth 0');
});

t('rankTraceFrames on an unparseable trace returns empty (no hallucinated files)', () => {
  const r = rankTraceFrames({ ok: false }, { k: 12 });
  assert(r.files.length === 0 && r.frames.length === 0, 'empty surface on no trace');
});

// ── traceLocalize (the injected core) ────────────────────────────────────────────────────────────
await ta('traceLocalize: valid repro + good trace → seed with failure-path file leading', async () => {
  const calls = { wrote: 0, traced: 0 };
  const r = await traceLocalize({
    writeRepro: async () => { calls.wrote++; return { valid: true, repro: 'assert fix', cost: 0.01 }; },
    runTrace: async ({ repro }) => {
      calls.traced++;
      assert(repro === 'assert fix', 'tracer receives the written repro');
      return { ran: true, cost: 0.02, logTail: wrap({ seen: [['core.py', 'f', 3]], counts: { 'core.py': 10, 'util.py': 2 }, tb: [['core.py', 'f', 9]], err: ['ValueError', 'boom'] }) };
    },
    k: 12,
  });
  assert(r.traced === true && r.reproValid === true, 'gate armed + traced');
  assert(r.seed && r.seed.files[0].file === 'core.py', 'failure-path file leads the seed');
  assert(Math.abs(r.cost - 0.03) < 1e-9, 'cost accumulates writer + trace run');
  assert(calls.wrote === 1 && calls.traced === 1, 'each injected dep called once');
});

await ta('traceLocalize: invalid repro → seed null, traced false (gate cannot arm)', async () => {
  let traced = 0;
  const r = await traceLocalize({
    writeRepro: async () => ({ valid: false, repro: '', cost: 0.005 }),
    runTrace: async () => { traced++; return { ran: true, logTail: wrap({ seen: [], counts: {}, tb: [], err: null }) }; },
  });
  assert(r.seed === null && r.traced === false && r.reproValid === false, 'no seed when repro invalid');
  assert(traced === 0, 'never runs the tracer without a valid repro');
});

await ta('traceLocalize: trace touched no repo source → seed null (no fabricated hint)', async () => {
  const r = await traceLocalize({
    writeRepro: async () => ({ valid: true, repro: 'r', cost: 0 }),
    // empty counts/seen/tb → nothing under the repo root was touched
    runTrace: async () => ({ ran: true, logTail: wrap({ seen: [], counts: {}, tb: [], err: ['ImportError', 'x'] }) }),
  });
  assert(r.seed === null && r.traced === false && r.reproValid === true, 'no seed when no source frames');
});

await ta('traceLocalize: unparseable tracer output → seed null (never blocks, never fabricates)', async () => {
  const r = await traceLocalize({
    writeRepro: async () => ({ valid: true, repro: 'r', cost: 0 }),
    runTrace: async () => ({ ran: true, logTail: 'garbage with no sentinels' }),
  });
  assert(r.seed === null && r.traced === false, 'no seed on unparseable trace');
});

// ── formatTraceSeedForAgent (the agent-facing string) ────────────────────────────────────────────
t('formatTraceSeedForAgent frames the seed as EVIDENCE, not a directive (§52 lesson)', () => {
  const parsed = parseTrace(wrap({ seen: [['core.py', 'f', 3]], counts: { 'core.py': 10 }, tb: [['core.py', 'f', 9]], err: ['ValueError', 'boom'] }));
  const seed = rankTraceFrames(parsed);
  const block = formatTraceSeedForAgent(seed);
  assert(/EXECUTION-TRACE LOCALIZATION \(EVIDENCE/.test(block), 'labeled EVIDENCE');
  assert(/OBSERVED execution, not a guess/.test(block), 'explicitly observed, not a guess');
  assert(/you may still explore elsewhere/.test(block), 'invites exploration (non-authoritative)');
  assert(!/AUTHORITATIVE|MUST edit|the fix is in/i.test(block), 'no authoritative/directive language');
  assert(/raise site/.test(block) && /core\.py/.test(block) && /ValueError: boom/.test(block), 'surfaces raise site, file, error');
});

t('formatTraceSeedForAgent returns empty string for an empty seed', () => {
  assert(formatTraceSeedForAgent(null) === '', 'null seed → empty');
  assert(formatTraceSeedForAgent({ files: [] }) === '', 'no files → empty');
});

// ── buildPyTracer (the stdlib tracer wrapper) ────────────────────────────────────────────────────
t('buildPyTracer emits a stdlib-only script with the sentinels and repo-root filter', () => {
  const py = buildPyTracer('/testbed', 'reproduce_bug.py');
  assert(/import sys, os, json, runpy, traceback/.test(py), 'stdlib imports only — no pip dependency');
  assert(/sys\.settrace\(tracer\)/.test(py), 'installs sys.settrace tracer');
  assert(py.includes(TRACE_BEGIN) && py.includes(TRACE_END), 'prints the sentinels parseTrace expects');
  assert(/fn\.startswith\(REPO\)/.test(py), 'filters frames to repo source only (not stdlib/site-packages)');
  assert(/REPO = "\/testbed"/.test(py), 'repo root wired in');
  assert(/sys\.exit\(0 if err is None else 1\)/.test(py), 'preserves the repro non-zero exit on failure');
  assert(TRACE_PATH === 'trace_repro.py', 'tracer staged filename is stable');
});

console.log(`\n${pass} tests passed.`);
