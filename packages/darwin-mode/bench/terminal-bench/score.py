# SPDX-License-Identifier: MIT
#
# Terminal-Bench SCORE join — the cost-Pareto row. Joins the OFFICIAL harness results.json
# (authoritative resolved / accuracy — we do NOT recompute it) with our darwin-cost.jsonl sidecar
# (authoritative $, from OpenRouter usage.cost). Output:
#   accuracy, n, n_resolved, total_usd, mean_usd_per_task, usd_per_resolved, plus per-task rows.
#
# Usage:
#   python score.py <run_dir> [--cost darwin-cost.jsonl] [--out pareto.json]
# where <run_dir> is a tb output dir (contains results.json or a timestamped subdir with one).

import json
import sys
from pathlib import Path


def find_results_json(run_dir: Path) -> Path | None:
    direct = run_dir / "results.json"
    if direct.exists():
        return direct
    # else newest timestamped subdir's results.json
    cands = sorted(run_dir.glob("*/results.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    return cands[0] if cands else None


def main():
    if len(sys.argv) < 2:
        print("usage: python score.py <run_dir> [--cost darwin-cost.jsonl] [--out pareto.json]")
        sys.exit(1)
    run_dir = Path(sys.argv[1])
    args = sys.argv[2:]

    def opt(flag, default):
        return args[args.index(flag) + 1] if flag in args else default

    cost_path = Path(opt("--cost", str(Path(__file__).parent / "darwin-cost.jsonl")))
    out_path = Path(opt("--out", str(run_dir / "pareto.json")))

    rj = find_results_json(run_dir)
    if rj is None:
        print(f"No results.json under {run_dir}")
        sys.exit(1)
    results = json.loads(rj.read_text())
    # official results.json: {results:[{task_id, is_resolved, ...}], accuracy, ...}
    trials = results.get("results", [])
    resolved_by_task: dict[str, bool] = {}
    for t in trials:
        tid = t.get("task_id")
        # a task may have multiple trials (n-attempts); resolved if ANY trial resolved (pass@k)
        resolved_by_task[tid] = resolved_by_task.get(tid, False) or bool(t.get("is_resolved"))

    # cost sidecar: one row per task run; sum $ per task (a task may appear once per attempt)
    cost_by_task: dict[str, dict] = {}
    if cost_path.exists():
        for line in cost_path.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            tid = r.get("task_id")
            agg = cost_by_task.setdefault(tid, {"usd": 0.0, "in": 0, "out": 0, "steps": 0, "n": 0})
            agg["usd"] += float(r.get("usd", 0))
            agg["in"] += int(r.get("input_tokens", 0))
            agg["out"] += int(r.get("output_tokens", 0))
            agg["steps"] += int(r.get("steps", 0))
            agg["n"] += 1

    rows = []
    for tid, resolved in sorted(resolved_by_task.items()):
        c = cost_by_task.get(tid, {})
        rows.append({
            "task_id": tid,
            "resolved": resolved,
            "usd": round(c.get("usd", 0.0), 6),
            "input_tokens": c.get("in", 0),
            "output_tokens": c.get("out", 0),
            "steps": c.get("steps", 0),
        })

    n = len(resolved_by_task)
    n_resolved = sum(1 for v in resolved_by_task.values() if v)
    total_usd = round(sum(r["usd"] for r in rows), 6)
    pareto = {
        "run_dir": str(run_dir),
        "results_json": str(rj),
        "accuracy_official": results.get("accuracy"),
        "n_tasks": n,
        "n_resolved": n_resolved,
        "accuracy": round(n_resolved / n, 4) if n else None,
        "total_usd": total_usd,
        "mean_usd_per_task": round(total_usd / n, 6) if n else None,
        "usd_per_resolved": round(total_usd / n_resolved, 6) if n_resolved else None,
        "rows": rows,
    }
    out_path.write_text(json.dumps(pareto, indent=2))
    print(f"=== Terminal-Bench cost-Pareto ({run_dir.name}) ===")
    print(f"  accuracy        : {pareto['accuracy']}  ({n_resolved}/{n})  [official: {results.get('accuracy')}]")
    print(f"  total $         : ${total_usd}")
    print(f"  $/task          : ${pareto['mean_usd_per_task']}")
    print(f"  $/resolved-task : ${pareto['usd_per_resolved']}")
    print(f"  wrote {out_path}")


if __name__ == "__main__":
    main()
