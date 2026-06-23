# ADR-180 — Distributed benchmark runs: GCP VM runner + Firestore results store

**Status:** Accepted (runner: `scripts/gcp-swebench-runner.sh`; store: Firestore `darwin_runs`)
**Date:** 2026-06-23
**Related:** ADR-150 (local $0 inference), ADR-179

## Context

Getting Darwin's *own* numbers on SWE-bench **Verified (500)** and **Pro (731)** needs their Docker images
(hundreds of GB) and hours of compute — and the local box (a) lacks those cached images and (b) is shared
with a second session. Per-machine result files (JSON in the tree) also don't aggregate across runs.

## Decision

1. **Compute offload to GCP** (project `cognitum-20260110`): a self-contained startup-script runner
   (`gcp-swebench-runner.sh`) installs Docker/Node/swebench, clones the repo, restores the OpenRouter key from
   instance metadata, runs the interactive solver (single or Best-of-3+judge) on a chosen split, gold-evals,
   and leaves artifacts in `/opt/darwin/out` for `scp`. First use: `darwin-verified-runner` (e2-standard-8).
   Pro is runnable via its own OS harness (`scaleapi/SWE-bench_Pro-os` + `jefzda/sweap-images`).
2. **Firestore as the durable results store** (native mode, default DB). Run records (benchmark, mode, model,
   resolved/total, resolve %, Wilson CI, cost/inst, run total, conformant, source) go to the `darwin_runs`
   collection via `scripts/firestore-upload.mjs` (REST + token auth, no SDK dep).
3. **Security (configured via gcloud):** Firestore native mode is IAM-gated by default (no public client
   access; verified no `allUsers`/`allAuthenticatedUsers` bindings). A dedicated SA `darwin-bench-writer`
   holds **only** `roles/datastore.user` (least privilege) for automated writers; the ephemeral OpenRouter key
   rides instance metadata on short-lived VMs.

## Consequences

- Verified/Pro runs no longer contend with local work; results aggregate in one queryable store.
- Cost: VM ~$2–5/run + model spend; remember to delete the VM after retrieval.
- gcloud user creds need periodic interactive reauth (`gcloud auth login`) — a manual gate for provisioning.
- The leaderboard JSON can be regenerated from `darwin_runs` once enough runs accumulate.
