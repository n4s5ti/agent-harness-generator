#!/usr/bin/env bash
# GCP VM runner: run the OFFICIAL Terminal-Bench harness (`tb`) with the Darwin terminal agent,
# HARDEST-FIRST, score the cost-Pareto row, self-report to Firestore, autostop. Mirrors
# gcp-swebench-runner.sh's structure (the proven self-running-VM pattern, ADR-180/181) but the
# scoring is `tb`'s own (we never hand-roll a scorer — the harness builds each task's Docker env,
# runs our agent, then runs the task's hidden tests and writes results.json).
#
# Inputs via env or instance metadata:
#   ORKEY       = OpenRouter API key                     (required; metadata key `orkey`)
#   MODEL       = solver model slug                       (default deepseek/deepseek-chat)
#   NTASKS      = run the hardest N tasks (0 = all 80)    (default 8)
#   BAND        = restrict to a difficulty band (hard|medium|easy|"")  (default "" = all, hardest-first)
#   MAXSTEPS    = agent step budget                       (default 30)
#   PERTASKCOST = per-task agent $ cap                    (default 1.5)
#   CONCURRENCY = tb --n-concurrent                       (default 4)
#   BRANCH      = git branch                              (default claude/darwin-mode-evolve-polyglot)
#   AUTOSTOP    = 1 → shutdown after run (default 1)
#
# Results land in /opt/darwin/tbench-out/ for `gcloud compute scp`.
set -euo pipefail
M(){ curl -sf -H 'Metadata-Flavor: Google' "http://metadata/computeMetadata/v1/instance/attributes/$1" 2>/dev/null || true; }
ORKEY="${ORKEY:-$(M orkey)}"; [ -n "$ORKEY" ] || { echo "FATAL: ORKEY not set"; exit 1; }
MODEL="${MODEL:-$(M model)}"; MODEL="${MODEL:-deepseek/deepseek-chat}"
NTASKS="${NTASKS:-$(M ntasks)}"; NTASKS="${NTASKS:-8}"
BAND="${BAND:-$(M band)}"
MAXSTEPS="${MAXSTEPS:-$(M maxsteps)}"; MAXSTEPS="${MAXSTEPS:-30}"
PERTASKCOST="${PERTASKCOST:-$(M pertaskcost)}"; PERTASKCOST="${PERTASKCOST:-1.5}"
CONCURRENCY="${CONCURRENCY:-$(M concurrency)}"; CONCURRENCY="${CONCURRENCY:-4}"
BRANCH="${BRANCH:-$(M branch)}"; BRANCH="${BRANCH:-claude/darwin-mode-evolve-polyglot}"
SLUG="$(echo "$MODEL" | tr '/:.' '-')"

echo "=== [1/6] system deps ==="
export DEBIAN_FRONTEND=noninteractive
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
if ! command -v node >/dev/null || [ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
fi
apt-get update -y >/dev/null 2>&1 || true
apt-get install -y python3 python3-venv python3-pip git curl >/dev/null 2>&1 || true

echo "=== [2/6] repo + agent ==="
mkdir -p /opt/darwin && cd /opt/darwin
[ -d agent-harness-generator ] || git clone --depth 1 -b "$BRANCH" https://github.com/ruvnet/agent-harness-generator.git
cd agent-harness-generator/packages/darwin-mode/bench/terminal-bench
echo "$ORKEY" > /tmp/.orkey

echo "=== [3/6] official terminal-bench harness (uv tool) ==="
command -v uv >/dev/null || { curl -LsSf https://astral.sh/uv/install.sh | sh; export PATH="$HOME/.local/bin:$PATH"; }
export PATH="$HOME/.local/bin:$PATH"
uv tool install terminal-bench >/dev/null 2>&1 || uv tool install terminal-bench
tb datasets download -d terminal-bench-core==0.1.1 || true

echo "=== [4/6] build hardest-first manifest ==="
node build-manifest.mjs

echo "=== [5/6] HARDEST-FIRST run (model=$MODEL n=$NTASKS band=${BAND:-all}) ==="
export OPENROUTER_API_KEY="$ORKEY"
export PYTHONPATH="$PWD:${PYTHONPATH:-}"
OUT=/opt/darwin/tbench-out; mkdir -p "$OUT"
BAND_ARG=""; [ -n "$BAND" ] && BAND_ARG="--band $BAND"
# EVAL VALIDATION GATE (§42): prove the harness scores a known-good (oracle) PASS before trusting any number.
echo "--- eval-validation: oracle on hello-world must PASS ---"
tb run -d terminal-bench-core==0.1.1 -t hello-world --agent oracle --output-path "$OUT/val-oracle" --cleanup || true
ORACLE_OK=$(node -pe "try{(JSON.parse(require('fs').readFileSync(require('fs').readdirSync('$OUT/val-oracle').map(d=>'$OUT/val-oracle/'+d+'/results.json').find(p=>require('fs').existsSync(p)))).accuracy)===1?'PASS':'FAIL'}catch(e){'FAIL'}" 2>/dev/null || echo FAIL)
echo "oracle eval-validation: $ORACLE_OK"
[ "$ORACLE_OK" = "PASS" ] || { echo "FATAL: eval cannot score a known-good solution as PASS — number would be meaningless. Aborting."; exit 1; }

node hardest-first.mjs --manifest tbench-manifest.json --model "$MODEL" \
  --n "$NTASKS" $BAND_ARG --max-steps "$MAXSTEPS" --per-task-cost "$PERTASKCOST" \
  --concurrent "$CONCURRENCY" --out "$OUT/run" 2>&1 | tee "$OUT/hardest-first.log"
cp darwin-cost.jsonl "$OUT/darwin-cost.jsonl" 2>/dev/null || true

echo "=== [6/6] self-report to Firestore darwin_tbench_runs ==="
PARETO=$(find "$OUT/run" -name pareto.json | head -1)
if [ -n "$PARETO" ]; then
  TOKEN=$(curl -s -H 'Metadata-Flavor: Google' 'http://metadata/computeMetadata/v1/instance/service-accounts/default/token' | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token' 2>/dev/null)
  PROJECT_ID=$(curl -s -H 'Metadata-Flavor: Google' 'http://metadata/computeMetadata/v1/project/project-id')
  RES=$(node -pe "JSON.parse(require('fs').readFileSync('$PARETO')).n_resolved" 2>/dev/null || echo 0)
  TOT=$(node -pe "JSON.parse(require('fs').readFileSync('$PARETO')).n_tasks" 2>/dev/null || echo 0)
  USD=$(node -pe "JSON.parse(require('fs').readFileSync('$PARETO')).total_usd" 2>/dev/null || echo 0)
  PUR=$(node -pe "JSON.parse(require('fs').readFileSync('$PARETO')).usd_per_resolved||0" 2>/dev/null || echo 0)
  PCT=$(node -pe "$TOT>0?($RES/$TOT*100).toFixed(1):0")
  curl -s -X POST "https://firestore.googleapis.com/v1/projects/$PROJECT_ID/databases/(default)/documents/darwin_tbench_runs" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"fields\":{\"benchmark\":{\"stringValue\":\"terminal-bench-core-0.1.1\"},\"model\":{\"stringValue\":\"$MODEL\"},\"band\":{\"stringValue\":\"${BAND:-all-hardest-first}\"},\"resolved\":{\"integerValue\":\"$RES\"},\"total\":{\"integerValue\":\"$TOT\"},\"resolve_pct\":{\"doubleValue\":$PCT},\"total_usd\":{\"doubleValue\":$USD},\"usd_per_resolved\":{\"doubleValue\":$PUR},\"conformant\":{\"booleanValue\":true},\"source\":{\"stringValue\":\"gcp-fleet\"},\"ts\":{\"stringValue\":\"$(date -I)\"}}}" >/dev/null \
    && echo "self-reported $RES/$TOT = $PCT% (\$$USD) to Firestore darwin_tbench_runs" || echo "Firestore self-report failed (results in $OUT)"
fi
echo "=== DONE — results in $OUT ==="
if [ "${AUTOSTOP:-1}" = "1" ]; then echo "AUTOSTOP: halting VM in 2 min"; (sleep 120; shutdown -h now) & fi
