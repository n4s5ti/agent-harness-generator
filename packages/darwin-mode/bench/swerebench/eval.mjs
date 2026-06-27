// SPDX-License-Identifier: MIT
//
// ADR-197 (§63) — SWE-rebench gold-validate + scoring driver. Wraps the SWE-rebench FORK harness
// (github.com/SWE-rebench/SWE-bench-fork, installed at /tmp/rebench-venv) which reads each row's
// per-instance install_config/log_parser and pulls the prebuilt swerebench/sweb.eval.* images
// (--namespace swerebench). The upstream PyPI `swebench` does NOT support nebius/SWE-rebench — the
// fork is required (researcher-confirmed, §63).
//
// Three modes:
//   --mode gold       : write gold preds from the manifest's `patch`, eval -> which instances RESOLVE
//                       (the §42 gate: only gold-resolving instances are scorable). Also runs empty
//                       preds so we confirm empty FAILS (no false-positive images).
//   --mode score      : score a model predictions JSONL against the gold tests -> resolve set.
//
// Run:
//   node eval.mjs --mode gold  --manifest candidates-65.json --run-id reb-gold  --workers 6
//   node eval.mjs --mode score --manifest clean-50.json --preds preds.jsonl --run-id reb-cascade --workers 6
import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));
const MODE = argv('--mode', 'gold');
const MANIFEST = rel(argv('--manifest', 'candidates-65.json'));
const RUN_ID = argv('--run-id', `reb-${MODE}-${Date.now()}`);
const WORKERS = +argv('--workers', 6);
const TIMEOUT = +argv('--timeout', 1200);
const PREDS = argv('--preds', null);
const VENV = argv('--venv', '/tmp/rebench-venv');
const DATASET = 'nebius/SWE-rebench';
const SPLIT = 'filtered';

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')).instances;
const ids = manifest.map((i) => i.instance_id);

// Run the fork harness. The fork resolves images from each row's `image_name` when --namespace
// swerebench is set; --dataset_name/--split pull the gold tests (FAIL_TO_PASS/PASS_TO_PASS) for scoring.
function runEval(predsPath, runId) {
  const cmd = `. ${VENV}/bin/activate && cd /tmp && python -m swebench.harness.run_evaluation` +
    ` --dataset_name ${DATASET} --split ${SPLIT}` +
    ` --predictions_path ${predsPath}` +
    ` --instance_ids ${ids.join(' ')}` +
    ` --namespace swerebench --cache_level instance --run_id ${runId}` +
    ` --max_workers ${WORKERS} --timeout ${TIMEOUT}`;
  console.error(`[eval] run_id=${runId} n=${ids.length} workers=${WORKERS}`);
  try { execSync(cmd, { cwd: '/tmp', shell: '/bin/bash', stdio: ['ignore', 'inherit', 'inherit'], timeout: (TIMEOUT + 600) * 1000 * Math.ceil(ids.length / WORKERS) }); }
  catch (e) { console.error(`[eval] harness exited non-zero (partial results may exist): ${String(e).split('\n')[0]}`); }
  // the fork writes <model>.<run_id>.json into cwd (/tmp); read whichever matches
  const candidates = [`/tmp/gold.${runId}.json`, `/tmp/empty.${runId}.json`];
  for (const c of candidates) if (existsSync(c)) return JSON.parse(readFileSync(c, 'utf8'));
  // model preds: model_name_or_path-derived; scan /tmp for *.<runId>.json
  try { const f = execSync(`ls -1 /tmp/*.${runId}.json 2>/dev/null | head -1`, { shell: '/bin/bash' }).toString().trim(); if (f) return JSON.parse(readFileSync(f, 'utf8')); } catch { /**/ }
  return null;
}

if (MODE === 'gold') {
  const goldPreds = `/tmp/reb-gold-${RUN_ID}.jsonl`;
  const emptyPreds = `/tmp/reb-empty-${RUN_ID}.jsonl`;
  writeFileSync(goldPreds, manifest.map((i) => JSON.stringify({ instance_id: i.instance_id, model_name_or_path: 'gold', model_patch: i.patch })).join('\n') + '\n');
  writeFileSync(emptyPreds, manifest.map((i) => JSON.stringify({ instance_id: i.instance_id, model_name_or_path: 'empty', model_patch: '' })).join('\n') + '\n');
  const goldRep = runEval(goldPreds, `${RUN_ID}-gold`);
  const goldResolved = new Set(goldRep?.resolved_ids || []);
  console.error(`\n[gold] resolved ${goldResolved.size}/${ids.length}`);
  const emptyRep = runEval(emptyPreds, `${RUN_ID}-empty`);
  const emptyResolved = new Set(emptyRep?.resolved_ids || []);  // MUST be empty
  if (emptyResolved.size) console.error(`⚠️ ${emptyResolved.size} instances resolve with EMPTY patch — BROKEN (false-positive tests): ${[...emptyResolved].join(', ')}`);
  // Clean = gold resolves AND empty does NOT resolve.
  const clean = manifest.filter((i) => goldResolved.has(i.instance_id) && !emptyResolved.has(i.instance_id));
  const broken = manifest.filter((i) => !goldResolved.has(i.instance_id) || emptyResolved.has(i.instance_id));
  writeFileSync(rel(`gold-validation-${RUN_ID}.json`), JSON.stringify({
    runId: RUN_ID, n: ids.length, goldResolved: goldResolved.size, emptyResolved: emptyResolved.size,
    cleanCount: clean.length, cleanIds: clean.map((i) => i.instance_id), brokenIds: broken.map((i) => i.instance_id),
  }, null, 2));
  // Emit the clean manifest (gold-validated, scorable) for the solve.
  const cleanManifest = { dataset: DATASET, split: SPLIT, goldValidated: true, n: clean.length, instances: clean };
  writeFileSync(rel(`clean-${RUN_ID}.json`), JSON.stringify(cleanManifest, null, 2));
  console.error(`\n[clean] ${clean.length}/${ids.length} instances pass the §42 gate (gold resolves + empty fails)`);
  console.error(`[clean] manifest -> clean-${RUN_ID}.json | validation -> gold-validation-${RUN_ID}.json`);
} else if (MODE === 'score') {
  if (!PREDS) { console.error('--preds required for score mode'); process.exit(1); }
  const rep = runEval(rel(PREDS), `${RUN_ID}-score`);
  if (!rep) { console.error('no report produced'); process.exit(1); }
  const resolved = rep.resolved_ids || [];
  const n = ids.length, k = resolved.length, p = k / n;
  // Wilson 95% CI
  const z = 1.96, z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  const lo = Math.max(0, center - half), hi = Math.min(1, center + half);
  const out = {
    dataset: DATASET, split: SPLIT, runId: RUN_ID, n, resolved: k,
    resolvePct: Math.round(p * 1000) / 10,
    wilson95: [Math.round(lo * 1000) / 10, Math.round(hi * 1000) / 10],
    resolved_ids: resolved, unresolved_ids: ids.filter((i) => !resolved.includes(i)),
  };
  writeFileSync(rel(`score-${RUN_ID}.json`), JSON.stringify(out, null, 2));
  console.error(`\n[SCORE] ${k}/${n} = ${out.resolvePct}% resolved | Wilson 95% CI [${out.wilson95[0]}%, ${out.wilson95[1]}%]`);
  console.error(`[SCORE] -> score-${RUN_ID}.json`);
}
