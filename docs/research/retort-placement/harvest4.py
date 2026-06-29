#!/usr/bin/env python3
"""Harvest the iteration-4 stronger-cheap-model campaigns into a CellResult CSV.

Reads ONLY each campaign retort.db (Retort's own runner + scorers + conformance
spec-gate produced them, untouched). The DoE factor is `model` [deepseek-v4-pro |
glm-5.2]; routing is OFF for both arms (pure single-tier cheap). `tier` is recorded
as "cheap" for ALL i4 cells (both are cheap models) so the combined frame keeps
each base model as a distinct stack while reusing the cc/frontier reference.
"""
from __future__ import annotations
import csv, json, sqlite3, sys, glob
from pathlib import Path

G4 = Path("/tmp/claude-1000/-home-ruvultra-projects-agent-harness-generator/ec35bf87-f599-4921-ac41-4996378d9334/scratchpad/grid4")
CAMPAIGNS = {
    "mh4-crud": ("metaharness", "rest-api-crud"),
    "mh4-cli":  ("metaharness", "cli-data-pipeline"),
}
COLS = ["cell_id","replicate","model","harness_config","scaffold","base_model","routing","language","task",
        "status","requirement_coverage","code_quality","cost_per_task","latency_s",
        "tokens","runner","notes","x_raw_model"]


def harvest_db(db: Path, harness: str, task: str) -> list[dict]:
    con = sqlite3.connect(str(db)); con.row_factory = sqlite3.Row
    rows = []
    for r in con.execute("SELECT id, replicate, status, run_config_json FROM experiment_runs"):
        cfg = json.loads(r["run_config_json"] or "{}")
        lang = cfg.get("language", "unknown")
        base = cfg.get("model", "deepseek-v4-pro")  # the swapped cheap base
        m = {x["metric_name"]: x["value"] for x in con.execute(
            "SELECT metric_name, value FROM run_results WHERE run_id=?", (r["id"],))}
        sraw = (r["status"] or "").lower()
        status = "pass" if sraw in ("done","completed","success","ok") else "fail"
        rc = m.get("requirement_coverage")
        cost = float(m.get("_cost_usd", 0.0))
        rows.append({
            "cell_id": f"{harness}-{task}-{lang}-{base}",
            "replicate": r["replicate"],
            # `model` here is the STACK-TIER label used by the combined-frame groupby:
            # keep the base-model name so deepseek and glm are distinct stacks.
            "model": base,
            "harness_config": harness,
            "scaffold": "none", "base_model": base, "routing": "off",
            "language": lang, "task": task,
            "status": status,
            "requirement_coverage": float(rc) if rc is not None else 0.0,
            "code_quality": float(m.get("code_quality", 0.0)),
            "cost_per_task": cost,
            "latency_s": float(m.get("_duration_seconds", 0.0)),
            "tokens": int(m.get("_tokens", 0) or 0),
            "runner": harness, "notes": f"req_cov_raw={rc}", "x_raw_model": base,
        })
    con.close(); return rows


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else G4 / "results-cheapbase-v4.csv"
    all_rows = []
    for name, (harness, task) in CAMPAIGNS.items():
        db = G4 / name / "retort.db"
        if not db.exists():
            print(f"  (skip {name}: no retort.db)"); continue
        rows = harvest_db(db, harness, task)
        print(f"  {name}: {len(rows)} runs"); all_rows.extend(rows)
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLS); w.writeheader(); w.writerows(all_rows)
    # empty-response / artifact corroboration from solver step logs
    empties = 0
    for lg in glob.glob(str(G4 / "mh4-*/run.shard*.log")):
        try: empties += sum(1 for ln in open(lg) if "noop" in ln or "Output ONE valid JSON" in ln)
        except OSError: pass
    print(f"Wrote {len(all_rows)} rows -> {out}")
    print(f"noop/format-artifact log-lines across shard logs: {empties}")


if __name__ == "__main__":
    main()
