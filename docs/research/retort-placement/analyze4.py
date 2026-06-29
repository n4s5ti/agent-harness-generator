#!/usr/bin/env python3
"""Iteration-4 placement analysis: does a MORE CAPABLE CHEAP model (glm-5.2) close
the coverage gap toward DOMINATING claude-code/frontier -- or is the cheap-tier
ceiling structural (glm ~= deepseek, both cost-corners)?

Reuses the SAME machinery as i2/i3 (retort_metaharness.diagnose + .analysis Type-II
ANOVA, retort.analysis.pareto). Nothing here re-scores a cell.

Inputs:
  --prior  results-combined-v2.csv     (committed i2 frame: cc/frontier, cc/cheap,
           mh/frontier, mh/cheap-i2 reference points)
  --new    results-cheapbase-v4.csv     (harvest4 of the i4 grid; model factor
           {deepseek-v4-pro|glm-5.2}, routing off both arms)
Outputs: placement-analysis-v4.json + stdout report.
"""
from __future__ import annotations
import json, math, sys
from pathlib import Path
import pandas as pd

G4 = Path("/tmp/claude-1000/-home-ruvultra-projects-agent-harness-generator/ec35bf87-f599-4921-ac41-4996378d9334/scratchpad/grid4")
RETORT = G4.parent / "retort"
sys.path.insert(0, str(RETORT / "src")); sys.path.insert(0, str(RETORT))

from retort_metaharness import analysis as mz_analysis
from retort_metaharness import diagnose as mz_diag
from retort.analysis.pareto import pareto_analysis

THR = mz_diag.DiagnosisThresholds(min_cost_usd=0.0005, min_latency_s=0.5, require_tokens=True)
CONTROL = "deepseek-v4-pro"
TREAT = "glm-5.2"


def wilson(k, n, z=1.96):
    if n == 0: return (0.0, 0.0, 0.0)
    p = k / n; d = 1 + z*z/n
    c = (p + z*z/(2*n)) / d
    h = (z*math.sqrt(p*(1-p)/n + z*z/(4*n*n))) / d
    return (round(p,4), round(max(0,c-h),4), round(min(1,c+h),4))


def agg(g):
    n = len(g); kpass = int((g["status"].str.lower()=="pass").sum())
    p, lo, hi = wilson(kpass, n)
    return {"n": n, "coverage_mean": round(float(g["requirement_coverage"].mean()),4),
            "coverage_median": round(float(g["requirement_coverage"].median()),4),
            "code_quality_mean": round(float(g["code_quality"].mean()),4),
            "cost_per_task_mean": round(float(g["cost_per_task"].mean()),6),
            "latency_s_mean": round(float(g["latency_s"].mean()),2),
            "latency_s_median": round(float(g["latency_s"].median()),2),
            "pass_rate": p, "pass_lo": lo, "pass_hi": hi,
            "n_full_cov": int((g["requirement_coverage"]>=1.0).sum())}


def allin(df):
    n=len(df); k=int((df["status"].str.lower()=="pass").sum()); p,lo,hi=wilson(k,n)
    return {"n_all": n, "pass_rate_allin": p, "pass_lo": lo, "pass_hi": hi,
            "timeouts": int(((df["tokens"]==0)&(df["latency_s"]>600)).sum())}


def diag_counts(df):
    d = mz_diag.diagnose_frame(df, thr=THR)
    v = d["verdict"].astype(str).str.upper()
    return {"pass": int((v=="PASS").sum()),
            "genuine_model_fail": int((v=="GENUINE_MODEL_FAIL").sum()),
            "tooling_false_fail": int((v=="TOOLING_FALSE_FAIL").sum())}


def anova(df, factors):
    out = {}
    fs = [f for f in factors if f in df.columns and df[f].nunique()>1]
    try:
        eff = mz_analysis.attribute(df, factors=fs, include_interactions=True, transform="log")
        for resp, e in eff.items():
            rows = [{"effect": r.term,
                     "pct_variance": (None if r.pct_variance!=r.pct_variance else round(float(r.pct_variance),2)),
                     "p_value": (None if (r.p_value is None or r.p_value!=r.p_value) else round(float(r.p_value),4)),
                     "significant": bool(r.significant)} for r in e.rows]
            out[resp] = {"rows": rows, "r_squared": round(float(e.r_squared),4),
                         "residual_pct": round(float(e.residual_pct),2), "n": int(e.n_obs)}
    except Exception as ex:
        out["error"] = str(ex)
    return {"factors": fs, "effects": out}


def dominance(stacks, ccf, prefixes=("metaharness",)):
    dom = {}
    if not ccf: return dom
    for s in stacks:
        if not any(s["stack"].startswith(p) for p in prefixes): continue
        if s["stack"] == "claude-code/frontier": continue
        cov_ge = s["coverage_mean"] >= ccf["coverage_mean"] - 1e-9
        cost_le = s["cost_per_task_mean"] <= ccf["cost_per_task_mean"] + 1e-9
        pass_ge = s["pass_rate"] >= ccf["pass_rate"] - 1e-9
        strict = (s["coverage_mean"] > ccf["coverage_mean"] + 1e-9) or (s["cost_per_task_mean"] < ccf["cost_per_task_mean"] - 1e-9)
        dom[s["stack"]] = {
            "coverage": s["coverage_mean"], "pass_rate": s["pass_rate"], "cost": s["cost_per_task_mean"],
            "coverage_ge_ccf": bool(cov_ge), "pass_ge_ccf": bool(pass_ge), "cost_le_ccf": bool(cost_le),
            # beyond-SOTA = dominate on the accuracy AXES (cov AND pass) at <= cost
            "dominates_ccf": bool(cov_ge and pass_ge and cost_le and strict)}
    return dom


def main():
    a = {x.split("=")[0]: x.split("=")[1] for x in sys.argv[1:] if "=" in x}
    prior_p = Path(a["--prior"]); new_p = Path(a["--new"])
    prior = pd.read_csv(prior_p)
    new = pd.read_csv(new_p)
    report = {"inputs": {"prior": str(prior_p), "new": str(new_p)},
              "design": "model{deepseek-v4-pro(control),glm-5.2} x language{py,ts,go,rust} x task{crud,cli} x 3 reps; routing OFF"}

    # ---------- A. NEW i4 run: diagnosis + arms by base model ----------
    report["new_diagnosis"] = diag_counts(new)
    new_gen = mz_diag.drop_tooling_fails(new, thr=THR).copy()
    report["new_n_genuine"] = int(len(new_gen))
    arms = {}
    for lvl, g in new_gen.groupby("base_model"):
        arms[lvl] = agg(g)
    report["new_by_model_genuine"] = arms
    report["new_by_model_allin"] = {lvl: allin(g) for lvl, g in new.groupby("base_model")}
    report["new_timeouts_total"] = int(((new["tokens"]==0) & (new["latency_s"]>600)).sum())
    report["control_model"] = CONTROL; report["treatment_model"] = TREAT

    # ---------- B. TOOLING vs GENUINE diagnosis split by base model ----------
    report["diagnosis_by_model"] = {lvl: diag_counts(g) for lvl, g in new.groupby("base_model")}

    # ---------- C. per-language + per-task coverage (control vs glm) ----------
    pl = {}
    for lang in sorted(new_gen["language"].unique()):
        row = {}
        for lvl in (CONTROL, TREAT):
            gg = new_gen[(new_gen["language"]==lang)&(new_gen["base_model"]==lvl)]
            row[lvl] = {"coverage": round(float(gg["requirement_coverage"].mean()),4) if len(gg) else None,
                        "n": int(len(gg)),
                        "pass": int((gg["status"].str.lower()=="pass").sum())}
        pl[lang] = row
    report["per_language"] = pl
    pt = {}
    for tk in sorted(new_gen["task"].unique()):
        row = {}
        for lvl in (CONTROL, TREAT):
            gg = new_gen[(new_gen["task"]==tk)&(new_gen["base_model"]==lvl)]
            row[lvl] = round(float(gg["requirement_coverage"].mean()),4) if len(gg) else None
        pt[tk] = row
    report["per_task_coverage"] = pt

    # ---------- D. Combined-v4 frame: reuse cc/frontier, cc/cheap, mh/frontier;
    #              add BOTH i4 cheap-base arms as distinct stacks ----------
    keep = prior[~((prior["harness_config"]=="metaharness") & (prior["model"]=="cheap"))].copy()
    addn = new.copy()  # model column already holds the base-model name
    for c in keep.columns:
        if c not in addn.columns:
            addn[c] = "none" if c in ("memory","scaffold") else 0
    combined = pd.concat([keep, addn[keep.columns]], ignore_index=True)
    report["combined_diagnosis"] = diag_counts(combined)
    cgen = mz_diag.drop_tooling_fails(combined, thr=THR).copy()
    stacks = []
    for (h, t), g in cgen.groupby(["harness_config","model"]):
        s = {"stack": f"{h}/{t}", "harness": h, "tier": t}; s.update(agg(g)); stacks.append(s)
    stacks.sort(key=lambda s: (-s["coverage_mean"], s["cost_per_task_mean"]))
    report["combined_stacks"] = stacks

    labels = [s["stack"] for s in stacks]
    cov = [s["coverage_mean"] for s in stacks]
    negcost = [-s["cost_per_task_mean"] for s in stacks]
    neglat = [-s["latency_s_mean"] for s in stacks]
    pr_cost = pareto_analysis(labels, list(zip(cov, negcost)), ["coverage","neg_cost"])
    pr_lat = pareto_analysis(labels, list(zip(cov, neglat)), ["coverage","neg_latency"])
    report["pareto_cost"] = {"frontier": list(pr_cost.frontier_labels),
                             "dominated": [l for l in labels if pr_cost.is_dominated(l)]}
    report["pareto_latency"] = {"frontier": list(pr_lat.frontier_labels),
                                "dominated": [l for l in labels if pr_lat.is_dominated(l)]}
    ccf = next((s for s in stacks if s["stack"]=="claude-code/frontier"), None)
    report["dominance_vs_ccf"] = {
        "ccf": ({"coverage": ccf["coverage_mean"], "pass_rate": ccf["pass_rate"], "cost": ccf["cost_per_task_mean"]} if ccf else None),
        "metaharness": dominance(stacks, ccf)}

    # ---------- E. ANOVA (model as a factor) ----------
    report["anova_new"] = anova(new_gen, ["base_model","language","task"])
    report["anova_combined"] = anova(cgen, ["model","harness_config","language","task"])

    # ---------- F. head-to-head glm vs deepseek (the core question) ----------
    dctl = arms.get(CONTROL, {}); dtrt = arms.get(TREAT, {})
    report["head_to_head"] = {
        "control_deepseek": dctl, "treatment_glm": dtrt,
        "delta_coverage": (round(dtrt.get("coverage_mean",0)-dctl.get("coverage_mean",0),4) if dctl and dtrt else None),
        "delta_pass_rate": (round(dtrt.get("pass_rate",0)-dctl.get("pass_rate",0),4) if dctl and dtrt else None),
        "delta_cost": (round(dtrt.get("cost_per_task_mean",0)-dctl.get("cost_per_task_mean",0),6) if dctl and dtrt else None),
        "delta_latency": (round(dtrt.get("latency_s_mean",0)-dctl.get("latency_s_mean",0),2) if dctl and dtrt else None),
    }

    out = G4 / "placement-analysis-v4.json"
    out.write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    print(f"\nWrote {out}")


if __name__ == "__main__":
    main()
