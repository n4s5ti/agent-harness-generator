// SPDX-License-Identifier: MIT
//
// ADR-197 (§63) — SWE-rebench DECONTAMINATED manifest builder. SWE-rebench (nebius/SWE-rebench,
// arxiv 2505.20411) is the clean test for the §53 contamination reframe: continuously-updated,
// post-training-cutoff repos, decontaminated. This builds a Darwin-format manifest from the
// HF `filtered` (decontaminated, curated) split, recent window (>=2025-01), so the GLM->Opus
// cascade can be measured on data it could not have memorized.
//
// Output manifest is the SAME shape solve-agentic.mjs consumes (instance_id/repo/base_commit/
// problem_statement) PLUS the eval/gold-validation fields (patch, test_patch, FAIL_TO_PASS,
// PASS_TO_PASS, image_name, created_at, difficulty) so a single file drives BOTH the solve and
// the gold validation + final scoring. This mirrors the proven full-300.json pattern.
//
// Run (uses the rebench venv's python to read the HF parquet; node just orchestrates):
//   node build-manifest.mjs --since 2025-01-01 --max-p2p 100 --n 65 --out candidates-65.json
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const SINCE = argv('--since', '2025-01-01');
const MAX_P2P = +argv('--max-p2p', 100);
const N = +argv('--n', 65);
const SEED = +argv('--seed', 1776);
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));
const OUT = rel(argv('--out', 'candidates.json'));
const PY = argv('--python', '/tmp/rebench-venv/bin/python');

// One python call extracts + balances the sample (datasets lib lives in the rebench venv).
const pyScript = `
import json, random
from collections import defaultdict
from datasets import load_dataset
SINCE=${JSON.stringify(SINCE)}; MAX_P2P=${MAX_P2P}; N=${N}; SEED=${SEED}
ds = load_dataset("nebius/SWE-rebench", split="filtered")
pool = [r for r in ds if str(r['created_at'])>=SINCE and len(r['PASS_TO_PASS'])<=MAX_P2P]
# Round-robin across repos for diversity (no single repo dominates), deterministic with SEED.
random.seed(SEED)
by_repo = defaultdict(list)
for r in pool: by_repo[r['repo']].append(r)
for v in by_repo.values(): random.shuffle(v)
repos = sorted(by_repo); random.shuffle(repos)
picked=[]; idx=0
while len(picked)<min(N,len(pool)):
    progressed=False
    for repo in repos:
        if idx < len(by_repo[repo]):
            picked.append(by_repo[repo][idx]); progressed=True
            if len(picked)>=min(N,len(pool)): break
    if not progressed: break
    idx+=1
out=[]
for r in picked:
    out.append({
        "instance_id": r['instance_id'],
        "repo": r['repo'],
        "base_commit": r['base_commit'],
        "problem_statement": r['problem_statement'],
        # eval/gold-validation fields (NOT seen by the solver — used by gold-validate + final scoring):
        "patch": r['patch'],
        "test_patch": r['test_patch'],
        "FAIL_TO_PASS": r['FAIL_TO_PASS'],
        "PASS_TO_PASS": r['PASS_TO_PASS'],
        "image_name": r['image_name'],
        "created_at": str(r['created_at']),
        "difficulty": r['meta'].get('llm_score',{}).get('difficulty_score'),
        "is_lite": bool(r['meta'].get('is_lite')),
    })
print(json.dumps({"dataset":"nebius/SWE-rebench","split":"filtered","since":SINCE,"maxP2P":MAX_P2P,"n":len(out),"instances":out}))
`;
const json = execFileSync(PY, ['-c', pyScript], { maxBuffer: 1 << 28 }).toString();
const parsed = JSON.parse(json);
writeFileSync(OUT, JSON.stringify(parsed, null, 2));
const repos = new Set(parsed.instances.map((i) => i.repo));
console.error(`Wrote ${parsed.n} candidates (${repos.size} repos, since ${SINCE}, P2P<=${MAX_P2P}) -> ${OUT}`);
