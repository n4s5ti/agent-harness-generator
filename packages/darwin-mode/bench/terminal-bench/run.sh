#!/usr/bin/env bash
# Local Terminal-Bench run recipe (the VERIFIED contract — see ADAPTER.md §6 LEARNINGS).
# Usage: ./run.sh [model] [nTasks] [band]
#   ./run.sh                              # hardest 6, deepseek
#   ./run.sh z-ai/glm-4.6 8 hard          # hardest 8 of the hard band, GLM
set -euo pipefail
cd "$(dirname "$0")"
MODEL="${1:-deepseek/deepseek-chat}"; N="${2:-6}"; BAND="${3:-}"
export PATH="$HOME/.local/bin:$PATH"
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-$(cat /tmp/.orkey)}"
export PYTHONPATH="$PWD:${PYTHONPATH:-}"

command -v tb >/dev/null || { echo "installing official harness…"; uv tool install terminal-bench; }
tb datasets download -d terminal-bench-core==0.1.1 || true

# 1) EVAL-VALIDATE FIRST (§42): oracle must PASS, nop must FAIL — else the number is meaningless.
echo "=== eval-validation: oracle (known-good) must PASS ==="
tb run -d terminal-bench-core==0.1.1 -t hello-world --agent oracle --output-path ./runs/val-oracle --cleanup
echo "=== eval-validation: nop (empty) must FAIL ==="
tb run -d terminal-bench-core==0.1.1 -t hello-world --agent nop --output-path ./runs/val-nop --cleanup

# 2) build hardest-first manifest
node build-manifest.mjs

# 3) hardest-first run with the Darwin agent (conformant: agent never sees the hidden tests)
BAND_ARG=""; [ -n "$BAND" ] && BAND_ARG="--band $BAND"
node hardest-first.mjs --model "$MODEL" --n "$N" $BAND_ARG \
  --max-steps 30 --per-task-cost 1.5 --concurrent 3 --out "runs/hardest-$(echo "$MODEL" | tr '/:.' '-')"
