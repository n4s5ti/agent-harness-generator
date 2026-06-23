// SPDX-License-Identifier: MIT
// ADR-178 — the LLM-judge Discriminator (Sakana/SWE-Search reverse-engineering, LEARNINGS §14).
// Best-of-N selection WITHOUT the gold oracle: given N candidate patches (independent interactive
// trajectories), an LLM judge picks the one most likely to correctly fix the issue. SWE-Search reports
// 73% (single value-agent) → 84% (debate) gold-correct selection — fully conformant (no gold tests).
//
// Inputs: --manifest + --preds a.jsonl,b.jsonl,c.jsonl (N independent prediction sets, same instance_ids).
// Output: one merged prediction per instance (the judged pick) + a report with the UNION marker so the
// gold eval can report both the oracle upper bound (any-of-N) and the discriminator's realistic pick.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));
const MODEL = argv('--judge-model', 'deepseek/deepseek-v4-flash'); // cheap judge by default; --judge-model anthropic/claude-opus-4.8 for the strong judge
const OUT = rel(argv('--out', 'predictions-bestof-judged.jsonl'));
const REPORT = rel(argv('--report', 'discriminator-report.json'));
const BASE_URL = (argv('--base-url', 'https://openrouter.ai/api/v1')).replace(/\/$/, '');
const key = (process.env.OPENROUTER_API_KEY || (() => { try { return readFileSync('/tmp/.orkey', 'utf8'); } catch { return ''; } })()).trim();
const manifest = JSON.parse(readFileSync(rel(argv('--manifest', 'pilot-sample-25.json')), 'utf8')).instances;
const predFiles = (argv('--preds', '')).split(',').filter(Boolean).map(rel);
if (predFiles.length < 2) { console.error('need --preds with >=2 comma-separated prediction files'); process.exit(1); }

const load = (f) => { const m = {}; for (const l of readFileSync(f, 'utf8').trim().split('\n')) { if (!l) continue; const o = JSON.parse(l); m[o.instance_id] = o.model_patch || ''; } return m; };
const sets = predFiles.map(load);

async function judge(issue, cands) {
  // cands: [{i, patch}] non-empty unique. Ask the judge for the index most likely to correctly fix the issue.
  const body = cands.map((c, k) => `### CANDIDATE ${k}\n\`\`\`diff\n${c.patch.slice(0, 6000)}\n\`\`\``).join('\n\n');
  const prompt = `A GitHub issue and ${cands.length} candidate patches (independent attempts). Pick the ONE most likely to CORRECTLY fix the issue without breaking existing behavior. Judge by: does it address the issue's root cause? minimal + correct? no obvious bug/oversilencing?\n\n--- ISSUE ---\n${String(issue).slice(0, 5000)}\n\n${body}\n\n--- Respond with ONLY the integer index (0..${cands.length - 1}) of the best candidate. ---`;
  for (let a = 0; a < 4; a++) {
    if (a) await new Promise((r) => setTimeout(r, 1500 * 2 ** a));
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 8, temperature: 0 }) });
      if (!res.ok && (res.status === 429 || res.status >= 500)) continue;
      const j = await res.json(); const raw = j.choices?.[0]?.message?.content ?? '';
      const m = raw.match(/\d+/); const idx = m ? +m[0] : 0;
      return { idx: idx >= 0 && idx < cands.length ? idx : 0, cost: j.usage?.cost ?? 0 };
    } catch { /* retry */ }
  }
  return { idx: 0, cost: 0 };
}

writeFileSync(OUT, ''); const report = []; let cost = 0;
for (const inst of manifest) {
  const id = inst.instance_id;
  const all = sets.map((s) => s[id] || '');
  const nonEmpty = [...new Map(all.map((p, i) => [p, { i, patch: p }])).values()].filter((c) => c.patch.trim()); // unique non-empty
  let picked = '';
  let pickIdx = -1;
  if (nonEmpty.length === 1) { picked = nonEmpty[0].patch; pickIdx = nonEmpty[0].i; }
  else if (nonEmpty.length > 1) { const r = await judge(inst.problem_statement, nonEmpty); cost += r.cost; picked = nonEmpty[r.idx].patch; pickIdx = nonEmpty[r.idx].i; }
  writeFileSync(OUT, JSON.stringify({ instance_id: id, model_name_or_path: 'darwin-bestof-judged', model_patch: picked }) + '\n', { flag: 'a' });
  report.push({ instance_id: id, nCandidates: nonEmpty.length, nNonEmptyTotal: all.filter((p) => p.trim()).length, pickIdx });
  console.error(`${id}: ${nonEmpty.length} unique cand → pick set#${pickIdx}`);
}
writeFileSync(REPORT, JSON.stringify({ judgeModel: MODEL, nSets: predFiles.length, judgeCost_usd: Math.round(cost * 1e4) / 1e4, instances: report }, null, 2));
console.error(`\nDONE judged ${report.length} | judge cost $${Math.round(cost * 1e4) / 1e4} | → ${OUT} (gold-eval this; also union-eval each --preds for the oracle upper bound)`);
