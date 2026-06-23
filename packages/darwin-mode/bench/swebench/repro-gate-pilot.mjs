#!/usr/bin/env node
// ADR-183 pilot — is a JUDGE-VALIDATED self-written repro test a usable RESOLUTION gate (vs Goodhart)?
// Reuses EXISTING patches + gold (no re-solve) to measure, per instance:
//   reproValid  = agent's reproduce_bug.py FAILS on base (reproduces the bug)        [test-critic]
//   judgeOK     = a SEPARATE judge says the repro genuinely tests the issue          [writer≠evaluator]
//   passOnFix   = the repro PASSES once the candidate patch is applied               [resolution signal]
//   gold        = instance is gold-resolved (ground truth)
// Then: does (reproValid ∧ judgeOK ∧ passOnFix) predict gold? Does judgeOK improve precision over no-judge?
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runConformantTests } from './conformant-tests.mjs';
import { buildReproTest, REPRO_PATH } from './test-critic.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));
const MANIFEST = JSON.parse(readFileSync(rel(argv('--manifest', 'pilot-sample-25.json')), 'utf8')).instances;
const PREDS = rel(argv('--preds', 'predictions-interactive-ds-300.jsonl'));
const GOLD = rel(argv('--gold', '/tmp/darwin-agentic.setA-clean.json'));
const WRITER = argv('--writer-model', 'deepseek/deepseek-v4-flash');
const JUDGE = argv('--judge-model', 'deepseek/deepseek-v4-flash');
const CONC = Math.max(1, +argv('--concurrency', 2));
const OUT = rel(argv('--out', 'repro-gate-pilot-report.json'));
const key = (process.env.OPENROUTER_API_KEY || readFileSync('/tmp/.orkey', 'utf8')).trim();
const URL = 'https://openrouter.ai/api/v1/chat/completions';

const patchOf = {}; for (const l of readFileSync(PREDS, 'utf8').trim().split('\n')) { if (l) { const o = JSON.parse(l); patchOf[o.instance_id] = o.model_patch || ''; } }
const goldSet = new Set(JSON.parse(readFileSync(GOLD, 'utf8')).resolved_ids || []);

function mkLlm(model) {
  return async (prompt, system) => {
    const messages = system ? [{ role: 'system', content: system }, { role: 'user', content: prompt }] : [{ role: 'user', content: prompt }];
    for (let a = 0; a < 4; a++) { if (a) await new Promise(r => setTimeout(r, 1500 * 2 ** a));
      try { const res = await fetch(URL, { method: 'POST', signal: AbortSignal.timeout(60000), headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages, max_tokens: 1500, temperature: 0 }) });
        if (!res.ok && (res.status === 429 || res.status >= 500)) continue;
        const j = await res.json(); return { raw: j.choices?.[0]?.message?.content ?? '', cost: j.usage?.cost ?? 0 };
      } catch { /* retry */ } }
    return { raw: '', cost: 0 };
  };
}
const writer = mkLlm(WRITER), judge = mkLlm(JUDGE);

async function judgeRepro(issue, repro) {
  const { raw, cost } = await judge(`A GitHub issue and a candidate reproduce_bug.py written to test it. Does the test GENUINELY exercise the issue's described bug (not a trivial/tautological/unrelated assertion)?\n\nISSUE:\n${String(issue).slice(0, 4000)}\n\nTEST:\n\`\`\`python\n${repro.slice(0, 4000)}\n\`\`\`\n\nReply ONLY 'YES' (genuinely tests the issue) or 'NO' (trivial/disconnected).`);
  return { ok: /^\s*YES/i.test(raw), cost };
}

let cost = 0; const rows = []; let cursor = 0;
async function one(inst) {
  const id = inst.instance_id; const patch = patchOf[id] || '';
  const row = { id, gold: goldSet.has(id), hasPatch: !!patch.trim(), reproValid: false, judgeOK: false, passOnFix: false };
  try {
    const rb = await buildReproTest(id, inst.problem_statement, writer, { maxAttempts: 2 }); cost += rb.cost;
    row.reproValid = rb.valid;
    if (rb.valid) {
      const jr = await judgeRepro(inst.problem_statement, rb.repro); cost += jr.cost; row.judgeOK = jr.ok;
      if (patch.trim()) { // run the repro WITH the patch applied → does it now pass?
        const r = runConformantTests(id, patch, `python ${REPRO_PATH}`, { extraFiles: { [REPRO_PATH]: rb.repro }, timeoutMs: 300000 });
        row.passOnFix = r.ran && r.passed;
      }
    }
  } catch (e) { row.error = String(e).slice(0, 120); }
  rows.push(row);
  console.error(`[${rows.length}/${MANIFEST.length}] ${id} valid=${row.reproValid} judge=${row.judgeOK} passOnFix=${row.passOnFix} gold=${row.gold}`);
}
async function worker() { while (cursor < MANIFEST.length) await one(MANIFEST[cursor++]); }
await Promise.all(Array.from({ length: CONC }, worker));

// analysis: gate = reproValid ∧ judgeOK ∧ passOnFix ; compare to no-judge gate
const N = rows.length;
const gate = rows.filter(r => r.reproValid && r.judgeOK && r.passOnFix);
const gateNoJudge = rows.filter(r => r.reproValid && r.passOnFix);
const prec = (s) => s.length ? (s.filter(r => r.gold).length / s.length * 100).toFixed(0) + '%' : 'n/a';
const summary = {
  n: N, goldResolved: rows.filter(r => r.gold).length, cost_usd: Math.round(cost * 1e4) / 1e4,
  reproValidRate: rows.filter(r => r.reproValid).length + '/' + N,
  judgeApprovedOfValid: rows.filter(r => r.reproValid && r.judgeOK).length + '/' + rows.filter(r => r.reproValid).length,
  gate_judge: { fires: gate.length, precision_vs_gold: prec(gate), captured: gate.filter(r => r.gold).length },
  gate_nojudge: { fires: gateNoJudge.length, precision_vs_gold: prec(gateNoJudge), captured: gateNoJudge.filter(r => r.gold).length },
};
writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 2));
console.error('\n=== REPRO-GATE PILOT ===\n' + JSON.stringify(summary, null, 2));
