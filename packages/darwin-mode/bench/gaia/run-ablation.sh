#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# run-ablation.sh — the scaffolding-intelligence ablation driver.
#
# Runs {base, plan, reflexion(ds-only backfire probe), SC+BoN N=10, PS+BoN N=5}
# × {deepseek-v4-pro, glm-5.2} on FRAMES n=50 seed 42, 12-step cap, reasoning OFF.
# Cheapest/most-essential cells FIRST so the budget meter, if it trips, truncates
# only the least-important (compound) cells. The account meter (--abort-usage) is
# the authoritative global budget gate; --max-cost is a per-run secondary guard.
#
# Resumable: a cell whose pred file already has 50 rows is skipped.
#
# Usage: ABORT_USAGE=2666 bash run-ablation.sh

set -uo pipefail
cd "$(dirname "$0")"
RUNS=runs; mkdir -p "$RUNS"
MAN=manifest-frames-n50.json
N=50; STEPS=12; CONC="${CONC:-6}"
ABORT_USAGE="${ABORT_USAGE:-2666}"   # absolute OpenRouter $ ceiling (start ~2608.85 + ~57)
STREAM="${STREAM:-all}"              # ds | glm | all — run only one model's cells (for parallelism)
NODE="node --experimental-strip-types --no-warnings"
DS=deepseek/deepseek-v4-pro
GLM=z-ai/glm-5.2
tag() { case "$STREAM" in ds) [ "$1" = "$DS" ];; glm) [ "$1" = "$GLM" ];; *) true;; esac; }

run() { # name scaffold model maxcost extra...
  local name="$1" scaffold="$2" model="$3" maxcost="$4"; shift 4
  tag "$model" || return 0                       # stream filter
  local out="$RUNS/preds-$name.jsonl"
  if [ -f "$out" ] && [ "$(wc -l < "$out")" -ge "$N" ]; then echo "SKIP $name (already $(wc -l < "$out") rows)"; return; fi
  echo "=== CELL $name | scaffold=$scaffold model=$model maxcost=\$$maxcost ==="
  $NODE solve-gaia.mjs --scaffold "$scaffold" --model "$model" --manifest "$MAN" \
    --max-steps "$STEPS" --concurrency "$CONC" --max-cost "$maxcost" \
    --meter --abort-usage "$ABORT_USAGE" --out "$out" --report "$RUNS/report-$name.json" "$@" 2>&1 | tail -4
  echo "--- $name done: $(wc -l < "$out" 2>/dev/null || echo 0) rows ---"
}

# 1-2: base ReAct (the 0.42 baseline, re-run here for a same-code controlled comparison)
run base-ds       none         "$DS"  3
run base-glm      none         "$GLM" 4
# 3-4: Plan-and-Solve (cheapest structured lift)
run plan-ds       plan         "$DS"  4
run plan-glm      plan         "$GLM" 6
# 5: Reflexion — ds-only backfire probe (SOTA: known-weak on cheap; verbal-only, no oracle)
run reflexion-ds  reflexion    "$DS"  4  --reflexion-rounds 2 --tau 0.7
# 6-7: Self-Consistency + Verifier-BoN N=10 (HEADLINE; one run scores SC@majority AND BoN@verifier)
run bon10-ds      verifier-bon "$DS"  12 --samples 10 --sample-temp 0.7
run bon10-glm     verifier-bon "$GLM" 22 --samples 10 --sample-temp 0.7
# 8-9: Plan-and-Solve + BoN compound N=5 (most expendable → last)
run psbon5-ds     ps-bon       "$DS"  7  --samples 5 --sample-temp 0.7
run psbon5-glm    ps-bon       "$GLM" 13 --samples 5 --sample-temp 0.7

echo "=== ABLATION COMPLETE ==="
ls -la "$RUNS"/preds-*.jsonl
