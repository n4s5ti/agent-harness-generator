# Known-flaky SWE-bench Lite instances

Instances whose **official `swebench` harness evaluation** is environment-flaky (not a
solver/prediction problem). For reporting integrity these are scored **conservatively as
unresolved** and their flakiness is noted here rather than re-footnoted per run.

## `psf__requests-2317`

- **Symptom:** the instance's eval Docker container (`sweb.eval.psf__requests-2317.*`) **hangs past
  the 1200 s timeout** and must be killed for the batch to finalize. Observed across **every** run
  that touched it (RESULTS.md §10 merged-300, §13 14b-300, §14 hybrid-300; plus the Scholar repair).
- **Handling:** counted as **unresolved** (conservative) in all reported denominators. Our tick loop
  proactively `docker kill`s any `sweb.eval.*` container running >12 min to prevent it wedging a run.
- **Denominator impact:** negligible. Reported rates use **n=300**; excluding it (n=299) shifts a
  rate by ≤ +0.03pp at these magnitudes (e.g. 100/300 = 33.33% → 100/299 = 33.44%). All headline
  numbers in RESULTS.md / ADRs use n=300, so they are the *lower* bound.

This is an upstream harness/container-environment issue, not a Darwin Mode solver issue.
