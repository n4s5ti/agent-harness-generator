// SPDX-License-Identifier: MIT
//
// ADR-196 Phase-2 #4 — EXECUTION-TRACE LOCALIZATION (dynamic localization).
//
// The field's #1 untried hard-tail lever (LEARNINGS §53). The naive HNSW localizer (§52) anchored the
// agent on "symptom distractors" — code semantically similar to the issue text, which is where the
// symptom *manifests*, not where the fix *lives*. CoSIL (2503.22424), ORACLE-SWE, and AutoCodeRecover
// all converge on the same fix: use the EXECUTION TRACE of a reproduction run as the localization
// signal. The fix-site is IN the trace (the symptom sits on top of it). This is DYNAMIC localization —
// it observes what the failing run actually touched, rather than guessing from text similarity.
//
// PIPELINE (conformant — repro is written from the issue text only, run in the base Docker env with
// deps present, NO gold test_patch ever applied):
//   1. REPRO   reuse test-critic.buildReproTest / repro-gate's repro WRITE → a `reproduce_bug.py` that
//              FAILS on the buggy repo (it captures the bug). [Reused from ADR-195, not re-built here.]
//   2. TRACE   run that repro under a `sys.settrace` line tracer in the base env. Capture the ordered
//              (file, function, line) frames the failing run executed, plus the failure traceback. The
//              tracer is a stdlib-only Python wrapper (NO new dependency — see PY_TRACER below).
//   3. RANK    the trace-touched repo-source files/functions become the localization SEED, ranked by
//              proximity to the failure point: traceback frames first (deepest = innermost frame at the
//              raise), then by execution-frequency among the touched source files. The "from symptom
//              outward" ordering CoSIL describes.
//   4. SEED    inject as the agent's starting file surface — but framed as EVIDENCE ("the failing
//              reproduction executed through these files"), NOT an authoritative directive. §52's
//              lesson: a confident hint ANCHORS the agent; observed-execution evidence is honest about
//              what it is (what ran) and lets the agent reason from it.
//
// DESIGN FOR TESTABILITY: the core (`parseTrace`, `rankTraceFrames`, `formatTraceSeedForAgent`,
// `traceLocalize`) is PURE + dependency-injected — the repro writer and the trace RUNNER are injected.
// `solve-agentic.mjs` wires the real buildReproTest + a `sys.settrace`-instrumented runConformantTests
// run; the unit test injects a stub repro + a canned trace string. NO network / NO Docker in the tests.
//
// RELATIONSHIP TO ADR-195 repro-gate: that module WRITES a repro and ITERATES the solve against it
// (verification). THIS module REUSES the same repro WRITE, then adds the trace-CAPTURE + trace-as-
// LOCALIZER half (§53: "our repro-gate has the repro-WRITE half but NOT the trace-as-localization
// half"). The two compose: trace-localize seeds where to look; repro-gate verifies the fix.

// ── the Python tracer wrapper (stdlib only — sys.settrace; NO pip install) ──────────────────────────
// Staged into the container as `trace_repro.py` alongside `reproduce_bug.py`. It runs the repro under a
// line tracer, records the ordered (file:func:line) frames that touched repo source, and — crucially —
// the traceback frames at the failure point (the deepest one is the most likely fix-site). It prints a
// machine-readable block delimited by sentinels so the Node side can extract it robustly from a noisy
// log tail. The repro still raises (non-zero exit) exactly as before; the tracer just observes.
//
//   repoRoot   the in-container repo path (default /testbed) — only frames UNDER it are kept, so we
//              localize to PROJECT source, not stdlib / site-packages / the repro file itself.
//   reproPath  the repro filename relative to the repo root (default reproduce_bug.py).
export const TRACE_PATH = 'trace_repro.py';
export const TRACE_BEGIN = '@@DARWIN_TRACE_BEGIN@@';
export const TRACE_END = '@@DARWIN_TRACE_END@@';

export function buildPyTracer(repoRoot = '/testbed', reproPath = 'reproduce_bug.py') {
  // Single self-contained script. Keeps the LAST N touched-source frames (cap memory on hot loops) and
  // the full failure traceback. Emits JSON between sentinels. Re-raises so the exit code is unchanged.
  return `# auto-generated execution tracer (ADR-196) — stdlib only
import sys, os, json, runpy, traceback
REPO = ${JSON.stringify(repoRoot)}
REPRO = os.path.join(REPO, ${JSON.stringify(reproPath)})
TRACER_SELF = os.path.abspath(__file__)
seen = []            # ordered unique (file, func, line) touched in repo source
counts = {}          # file -> exec line-event count (frequency = how central to the run)
MAX = 4000
def _rel(p):
    try: return os.path.relpath(p, REPO)
    except Exception: return p
def tracer(frame, event, arg):
    if event == 'call' or event == 'line':
        fn = frame.f_code.co_filename
        if fn and fn.startswith(REPO) and os.path.abspath(fn) != TRACER_SELF:
            rf = _rel(fn)
            counts[rf] = counts.get(rf, 0) + 1
            if event == 'call' and len(seen) < MAX:
                seen.append([rf, frame.f_code.co_name, frame.f_lineno])
    return tracer
tb_frames = []
err = None
sys.settrace(tracer)
try:
    runpy.run_path(REPRO, run_name='__main__')
except SystemExit as e:
    err = ('SystemExit', str(e.code))
except BaseException as e:
    err = (type(e).__name__, str(e)[:500])
    tb = e.__traceback__
    for fr, lineno in traceback.walk_tb(tb):
        fn = fr.f_code.co_filename
        if fn and fn.startswith(REPO) and os.path.abspath(fn) != TRACER_SELF:
            tb_frames.append([_rel(fn), fr.f_code.co_name, lineno])
finally:
    sys.settrace(None)
print(${JSON.stringify(TRACE_BEGIN)})
print(json.dumps({'seen': seen, 'counts': counts, 'tb': tb_frames, 'err': err}))
print(${JSON.stringify(TRACE_END)})
# preserve the repro's own failure signal (non-zero exit) so the gate logic is unchanged
sys.exit(0 if err is None else 1)
`;
}

// ── parse the tracer's emitted block out of a (possibly noisy) log tail ─────────────────────────────
/**
 * Extract the JSON trace object the Python tracer printed between TRACE_BEGIN/TRACE_END.
 * Pure. Returns { ok, seen, counts, tb, err } — ok:false if no parseable block was found (the trace
 * could not be captured; the caller falls back to no-seed, never blocks the solve).
 *   logTail   the stdout captured from the traced run (runConformantTests' logTail).
 */
export function parseTrace(logTail) {
  const s = String(logTail || '');
  const b = s.lastIndexOf(TRACE_BEGIN);
  const e = s.lastIndexOf(TRACE_END);
  if (b < 0 || e < 0 || e <= b) return { ok: false, seen: [], counts: {}, tb: [], err: null };
  const json = s.slice(b + TRACE_BEGIN.length, e).trim();
  try {
    const o = JSON.parse(json);
    return {
      ok: true,
      seen: Array.isArray(o.seen) ? o.seen : [],
      counts: o.counts && typeof o.counts === 'object' ? o.counts : {},
      tb: Array.isArray(o.tb) ? o.tb : [],
      err: o.err ?? null,
    };
  } catch { return { ok: false, seen: [], counts: {}, tb: [], err: null }; }
}

// ── rank trace frames → ranked file/function surface (the localization seed) ────────────────────────
/**
 * Turn a parsed trace into a ranked {files, frames, err} surface. "From symptom outward" ordering:
 *   - the traceback frames (the failure path) rank FIRST — the innermost (deepest) frame is the most
 *     probable fix-site, so it leads. Each tb file gets a large rank bonus.
 *   - remaining trace-touched source files follow, ranked by execution frequency (how central they
 *     were to the failing run) — the CoSIL "the fix is in what the run touched" signal.
 * Pure. Returns { files:[{file,score,functions,inTraceback}], frames:[{file,func,line,kind}], err }.
 *   parsed   the parseTrace() result.
 *   k        number of files to surface.
 */
export function rankTraceFrames(parsed, { k = 12, maxFrames = 8 } = {}) {
  if (!parsed || !parsed.ok) return { files: [], frames: [], err: parsed?.err ?? null };
  const byFile = new Map(); // file -> { file, freq, functions:Set, inTraceback, tbDepth }
  const touch = (file, func, { tb = false, depth = 0 } = {}) => {
    const cur = byFile.get(file) || { file, freq: 0, functions: new Set(), inTraceback: false, tbDepth: Infinity };
    if (func && func !== '<module>') cur.functions.add(func);
    if (tb) { cur.inTraceback = true; cur.tbDepth = Math.min(cur.tbDepth, depth); }
    byFile.set(file, cur);
  };
  // execution frequency from the counts map (every touched source file)
  for (const [file, freq] of Object.entries(parsed.counts)) {
    const cur = byFile.get(file) || { file, freq: 0, functions: new Set(), inTraceback: false, tbDepth: Infinity };
    cur.freq = (cur.freq || 0) + (Number(freq) || 0);
    byFile.set(file, cur);
  }
  for (const [file, func] of parsed.seen) touch(file, func);
  // traceback: tb[0] is outermost (the repro call), tb[last] is innermost (the raise). Depth = distance
  // from the innermost frame, so the innermost (the raise site) gets depth 0 → the strongest bonus.
  const tb = parsed.tb;
  for (let i = 0; i < tb.length; i++) {
    const [file, func, line] = tb[i];
    touch(file, func, { tb: true, depth: tb.length - 1 - i });
  }
  const maxFreq = Math.max(1, ...[...byFile.values()].map((v) => v.freq || 0));
  const scored = [...byFile.values()].map((v) => {
    // freq term in [0,1]; traceback bonus dominates (so the failure path leads), innermost frame wins.
    const freqTerm = (v.freq || 0) / maxFreq;
    const tbBonus = v.inTraceback ? 10 + (Number.isFinite(v.tbDepth) ? 1 / (1 + v.tbDepth) : 0) : 0;
    return { file: v.file, score: +(tbBonus + freqTerm).toFixed(4), functions: [...v.functions].slice(0, 6), inTraceback: v.inTraceback };
  }).sort((a, b) => b.score - a.score);
  const files = scored.slice(0, k);
  // the ordered failure frames (innermost first) — the most surgical evidence for the agent.
  const frames = [];
  for (let i = tb.length - 1; i >= 0 && frames.length < maxFrames; i--) {
    const [file, func, line] = tb[i];
    frames.push({ file, func, line, kind: 'traceback', depth: tb.length - 1 - i });
  }
  return { files, frames, err: parsed.err };
}

/**
 * The pure trace-localization core. Injected:
 *   writeRepro  async () => { valid, repro, cost?, ... }     (test-critic.buildReproTest — reused)
 *   runTrace    async ({ repro }) => { ran, logTail, cost? } (run the repro under the tracer)
 *   k           files to surface.
 * Returns { seed:{files,frames,err}|null, reproValid, traced, cost, stats }.
 *   reproValid : the writer produced a repro that fails on the buggy code (the trace can be captured).
 *   traced     : the tracer emitted a parseable block AND it touched ≥1 repo-source file.
 *   seed       : the ranked surface, or null when no usable trace was captured (caller → no hint).
 * Honesty (mirrors repro-gate): if the repro is invalid, or the trace can't be captured/parsed, or no
 * repo-source frame was touched, we return seed:null + traced:false so the caller injects NO hint —
 * never a fabricated localization (a wrong confident hint is worse than none, §52).
 */
export async function traceLocalize({ writeRepro, runTrace, k = 12 } = {}) {
  let cost = 0;
  const rb = await writeRepro();
  cost += rb.cost || 0;
  if (!rb.valid || !rb.repro) {
    return { seed: null, reproValid: false, traced: false, cost, stats: { note: 'no valid repro — trace gate cannot arm' } };
  }
  const tr = await runTrace({ repro: rb.repro });
  cost += tr.cost || 0;
  if (!tr.ran) return { seed: null, reproValid: true, traced: false, cost, stats: { note: 'trace run did not execute' } };
  const parsed = parseTrace(tr.logTail);
  if (!parsed.ok) return { seed: null, reproValid: true, traced: false, cost, stats: { note: 'no parseable trace block' } };
  const ranked = rankTraceFrames(parsed, { k });
  if (!ranked.files.length) {
    return { seed: null, reproValid: true, traced: false, cost, stats: { note: 'trace touched no repo-source files' } };
  }
  return {
    seed: ranked,
    reproValid: true,
    traced: true,
    cost,
    stats: { n_files: ranked.files.length, n_frames: ranked.frames.length, n_seen: parsed.seen.length, err: parsed.err },
  };
}

/**
 * Render a trace seed into the text block injected at the head of the agent's first turn. Deterministic,
 * compact, and explicitly framed as OBSERVED-EXECUTION EVIDENCE — NOT an authoritative directive (the
 * §52 lesson). It says what the failing reproduction actually ran through and where it raised, and
 * invites the agent to start there while still exploring. Pure.
 */
export function formatTraceSeedForAgent(seed, { maxFiles = 8, maxFrames = 6 } = {}) {
  if (!seed || !seed.files || !seed.files.length) return '';
  const frameLines = (seed.frames || []).slice(0, maxFrames).map((f, i) =>
    `  ${i === 0 ? '→ (raise site) ' : '  '}${f.file} :: ${f.func}()  line ${f.line}`);
  const fileLines = seed.files.slice(0, maxFiles).map((f, i) => {
    const fns = f.functions && f.functions.length ? `  (functions: ${f.functions.join(', ')})` : '';
    const tag = f.inTraceback ? '  [on the failure path]' : '';
    return `  ${i + 1}. ${f.file}${fns}${tag}`;
  });
  const errLine = seed.err && Array.isArray(seed.err)
    ? `The reproduction failed with: ${seed.err[0]}: ${String(seed.err[1] ?? '').slice(0, 200)}`
    : '';
  return [
    '--- EXECUTION-TRACE LOCALIZATION (EVIDENCE — what a failing reproduction of this bug actually executed) ---',
    'A self-written reproduction of the issue was run under a tracer. This is OBSERVED execution, not a guess:',
    'the bug surfaces on top of the code below, so the fix almost certainly lives along this path.',
    'Use this as a starting point — read the failure-path files first; you may still explore elsewhere.',
    errLine,
    seed.frames && seed.frames.length ? '\nFailure path (innermost frame = where it raised, the most likely fix-site):' : '',
    ...(seed.frames && seed.frames.length ? frameLines : []),
    '\nFiles the failing reproduction executed through (ranked: failure-path first, then by execution centrality):',
    ...fileLines,
    '--- end execution-trace evidence ---',
  ].filter(Boolean).join('\n');
}
