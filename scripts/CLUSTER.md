# Darwin GCP benchmarking cluster — metaharness

A self-managing fleet for SWE-benchmarking cheap models on GCP. Runs **on GCP**, not locally.

## Architecture
```
darwin-controller (e2-small, SA=darwin-bench-writer)
  └─ systemd: node scripts/gcp-cluster.mjs supervise   # monitors fleet, auto-collects
workers: darwin-<board>-<tag>  (e2-standard-8, pd-standard)
  └─ startup-script → gcp-swebench-runner.sh           # deps → solve → gold-eval → SELF-REPORT to Firestore
Firestore darwin_runs  ← every run's resolve% lands here (worker self-reports via SA token)
```

## Why it's built this way (lessons → ADR-180/181)
- **Workers self-run via startup-script** (not SSH-launch — SSH relaunch was unreliable/wedged).
- **Workers self-report to Firestore** (SA token) — results land with zero controller/SSH dependency.
- **python3-venv installed explicitly** (Ubuntu ships python3 without ensurepip → venv failed → 0 preds bug).
- **pd-standard disks** (us-central1 SSD quota = 500 GB; standard disk dodges it).
- **CPU-quota-aware** provisioning (region CPUS = 32 ⇒ ≤4× e2-standard-8).
- **Serial-console monitoring** (read-only; never wedges the VM like SSH did).

## CLI (`scripts/gcp-cluster.mjs`)
| cmd | does |
|-----|------|
| `up <board> <model> [tag]` | provision one self-running worker (board ∈ lite/verified/multilingual) |
| `matrix` | provision the default model×board matrix, CPU-quota-aware |
| `status` | phase + preds for every `darwin-*` VM (via serial log) |
| `logs <vm>` | last 30 serial lines |
| `collect <vm>` | scp `/opt/darwin/out` → `./fleet-out/<vm>` + push to Firestore |
| `supervise` | loop: status + auto-collect finished workers (what the controller runs) |
| `down <vm\|all>` | delete VM(s) to stop billing |

## Operate
```
node scripts/gcp-cluster.mjs status                  # from anywhere with gcloud auth
node scripts/gcp-cluster.mjs up lite z-ai/glm-5.2     # add a worker
node scripts/gcp-cluster.mjs down all                 # tear down when done (STOP BILLING)
```
Results query: Firestore `darwin_runs` collection (benchmark, model, resolved/total, resolve_pct, source).
**Remember to `down all` when the run set is complete** — workers are e2-standard-8.
