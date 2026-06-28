// SPDX-License-Identifier: MIT
//
// scaffold-ablation.mjs — aggregate the scaffolding ablation into one table + verdict.
//
// Consumes the per-cell pred JSONL files produced by solve-gaia.mjs (one per
// condition×model) and the gold manifest, and emits:
//   - summary.json   machine-readable: every cell's resolve (Wilson CI), $/task,
//                    $/correct, mean steps, empty-rate, lift vs base, lift-per-dollar.
//   - ABLATION.json  the conditions×models matrix the report/chart plug in.
//   - the Self-Consistency cost-curve (majority vote @ N=1,3,5,7,10) derived FOR FREE
//     from the BoN cells' stored candidate_answers (no extra spend).
//
// Scoring is the SAME GAIA-style normalized exact-match as score-gaia.mjs (ported
// here so the curve/views score identically). Gold is read ONLY here, after preds exist.
//
// Run: node --experimental-strip-types scaffold-ablation.mjs \
//   --manifest manifest-frames-n50.json --preds-dir runs/ --out runs/summary.json

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));

// ── GAIA scorer.py normalization (identical to score-gaia.mjs) ──
function normalizeNumberStr(s) { const n = Number(String(s).replace(/[$%,]/g, '').trim()); return Number.isFinite(n) ? n : null; }
function normalizeStr(s) { return String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\w\s]/g, ' ').replace(/\b(a|an|the)\b/g, ' ').replace(/\s+/g, ' ').trim(); }
function splitList(s) { return String(s ?? '').split(/[,;]/).map((x) => x.trim()).filter(Boolean); }
function questionScorer(pred, gold) {
  pred = String(pred ?? ''); gold = String(gold ?? '');
  const gn = normalizeNumberStr(gold);
  if (gn !== null) { const pn = normalizeNumberStr(pred); return pn !== null && pn === gn; }
  const gl = splitList(gold);
  if (gl.length > 1) { const pl = splitList(pred); if (pl.length !== gl.length) return false; return gl.every((g, i) => { const gnum = normalizeNumberStr(g); if (gnum !== null) { const pnum = normalizeNumberStr(pl[i]); return pnum !== null && pnum === gnum; } return normalizeStr(g) === normalizeStr(pl[i]); }); }
  return normalizeStr(pred) === normalizeStr(gold);
}
function wilson(k, n, z = 1.96) { if (n === 0) return [0, 0]; const p = k / n, d = 1 + z * z / n; const c = (p + z * z / (2 * n)) / d; const h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d; return [Math.max(0, c - h), Math.min(1, c + h)]; }
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const r6 = (x) => Math.round(x * 1e6) / 1e6;

const manifest = JSON.parse(readFileSync(rel(argv('--manifest', 'manifest-frames-n50.json')), 'utf8'));
const gold = new Map(manifest.tasks.map((t) => [t.task_id, t]));
const PREDS_DIR = rel(argv('--preds-dir', 'runs'));
const OUT = rel(argv('--out', join(PREDS_DIR, 'summary.json')));

// Score one set of {task_id, answer, cost_usd, steps} rows against gold.
function scoreRows(rows, answerOf) {
  let em = 0, empty = 0, cost = 0, steps = 0, scored = 0;
  for (const p of rows) {
    const g = gold.get(p.task_id); if (!g) continue;
    scored++;
    const a = answerOf(p);
    if (!a || !String(a).trim()) empty++;
    if (questionScorer(a, g.answer)) em++;
    cost += p.cost_usd || 0; steps += p.steps || 0;
  }
  const [lo, hi] = wilson(em, scored);
  return { n: scored, correct: em, acc: r4(scored ? em / scored : 0), ci: [r4(lo), r4(hi)],
    empty_rate: r4(scored ? empty / scored : 0), total_cost: r4(cost),
    cost_per_task: r6(scored ? cost / scored : 0), cost_per_correct: em ? r6(cost / em) : null,
    mean_steps: r4(scored ? steps / scored : 0) };
}

// Discover pred files; each file = one cell (model + scaffold inferred from rows).
const files = readdirSync(PREDS_DIR).filter((f) => f.endsWith('.jsonl'));
const cells = [];
for (const f of files) {
  const rows = readFileSync(join(PREDS_DIR, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  if (!rows.length) continue;
  const model = rows[0].model, scaffold = rows[0].scaffold || 'none';
  const primary = scoreRows(rows, (p) => p.model_answer);
  const cell = { file: basename(f), model, scaffold, view: 'primary', ...primary };
  cells.push(cell);
  // For *-bon cells the SAME samples also yield the Self-Consistency (majority vote) view.
  const hasCands = rows.some((p) => Array.isArray(p.candidate_answers) && p.candidate_answers.length);
  if (hasCands) {
    cells.push({ file: basename(f), model, scaffold: scaffold + ':sc', view: 'majority',
      ...scoreRows(rows, (p) => p.majority_answer ?? p.model_answer) });
    // Self-Consistency cost-curve: majority over the first k candidates, k=1,3,5,7,10.
    const ks = [1, 3, 5, 7, 10];
    const curve = {};
    for (const k of ks) {
      const view = (p) => {
        const cs = (p.candidate_answers || []).slice(0, k).filter((x) => x && String(x).trim());
        if (!cs.length) return p.model_answer || '';
        const tally = new Map();
        for (const c of cs) { const key = normalizeStr(c); tally.set(key, (tally.get(key) || 0) + 1); }
        let best = '', bn = 0; for (const [key, n] of tally) if (n > bn) { bn = n; best = key; }
        return cs.find((c) => normalizeStr(c) === best) || cs[0];
      };
      const sc = scoreRows(rows, view);
      // cost @ k = mean per-task cost scaled by k/episodes (episodes≈samples); use actual mean cost / episodes * k.
      const meanEp = rows.reduce((s, p) => s + (p.episodes || 1), 0) / rows.length;
      const scaledCost = primary.cost_per_task * (k / Math.max(1, meanEp));
      curve[`k${k}`] = { acc: sc.acc, ci: sc.ci, correct: sc.correct, cost_per_task: r6(scaledCost) };
    }
    cells.push({ file: basename(f), model, scaffold: scaffold + ':sc-curve', view: 'sc-curve', sc_curve: curve, n: primary.n });
  }
}

// Lift vs base (per model), and lift-per-dollar (Δresolve / Δ$ per task).
const baseByModel = {};
for (const c of cells) if (c.scaffold === 'none' && c.view === 'primary') baseByModel[c.model] = c;
for (const c of cells) {
  if (c.view === 'sc-curve') continue;
  const b = baseByModel[c.model];
  if (b && c !== b && Number.isFinite(c.acc)) {
    c.lift_pp = r4((c.acc - b.acc) * 100);
    const dCost = (c.cost_per_task || 0) - (b.cost_per_task || 0);
    c.delta_cost_per_task = r6(dCost);
    c.lift_per_dollar = dCost > 1e-9 ? r4((c.acc - b.acc) / dCost) : null; // resolve gained per extra $/task
  }
}

const summary = { dataset: manifest.dataset, seed: manifest.seed, n: manifest.n,
  reasoning: 'off (no reasoning API param; scaffolds are prompt/orchestration-level)',
  scorer: 'gaia-style-normalized-exact-match (conformant, leak-free)',
  generated: new Date().toISOString(), cells };
writeFileSync(OUT, JSON.stringify(summary, null, 2));

// Console table.
const prim = cells.filter((c) => c.view === 'primary' || c.view === 'majority').sort((a, b) => a.model.localeCompare(b.model) || a.scaffold.localeCompare(b.scaffold));
console.log('\nmodel                       scaffold            n  acc    95%CI         $/task   $/corr   steps empty  lift  lift/$');
for (const c of prim) {
  console.log(
    c.model.padEnd(27).slice(0, 27),
    (c.scaffold).padEnd(18).slice(0, 18),
    String(c.n).padStart(2),
    (c.acc * 100).toFixed(1).padStart(5),
    `[${(c.ci[0] * 100).toFixed(0)},${(c.ci[1] * 100).toFixed(0)}]`.padStart(10),
    ('$' + (c.cost_per_task || 0).toFixed(4)).padStart(8),
    (c.cost_per_correct == null ? '   -' : '$' + c.cost_per_correct.toFixed(3)).padStart(8),
    (c.mean_steps || 0).toFixed(1).padStart(5),
    (c.empty_rate * 100).toFixed(0).padStart(4) + '%',
    (c.lift_pp == null ? '  -' : (c.lift_pp > 0 ? '+' : '') + c.lift_pp.toFixed(1)).padStart(6),
    (c.lift_per_dollar == null ? '   -' : c.lift_per_dollar.toFixed(2)).padStart(7),
  );
}
console.log(`\nwrote ${OUT}`);
