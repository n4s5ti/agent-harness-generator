# SWE-rebench (DECONTAMINATED) — Darwin clean-frontier test (§63)

The §53 directive: measure the Darwin GLM→Opus cascade on a DECONTAMINATED,
conformant eval — does it hold the contaminated Lite 51.3% / Verified 55.6%, or
drop? SWE-rebench (`nebius/SWE-rebench`, arxiv 2505.20411) is the clean test:
continuously-updated, post-training-cutoff repos, decontaminated.

**All numbers are real:** the EXACT shipped GLM-5.2→Opus-4.8 cascade (zero
per-instance tuning, conformance firewall HV-1), scored by the official
SWE-rebench fork gold harness (`github.com/SWE-rebench/SWE-bench-fork`,
`--namespace swerebench`). Date: 2026-06-27.

## The clean sample (decontaminated)

- Source: `nebius/SWE-rebench` `filtered` split (decontaminated, curated).
- Window: **created 2025-01-06 → 2025-04-30** (post-cutoff).
- Eval-runtime filter: PASS_TO_PASS ≤ 100 (tractable eval; NOT a difficulty filter).
- §42 gold-validation: 65 candidates → **gold resolves 51/65, empty resolves 0/65**
  → eval discriminates correctly; 14 dropped for broken auto-built images (gold
  itself can't pass). **n = 51** gold-validated, scorable instances, **51 distinct repos**.
- Difficulty (llm_score 0=easy..3=hard): {0:19, 1:22, 2:9, 3:1}.

## The decisive comparison — clean vs contaminated

| Eval | Contamination | Darwin cascade | Wilson 95% CI | n |
|---|---|---|---|---|
| SWE-bench Lite (§28/§47) | CONTAMINATED | 51.3% | [45.7, 56.9] | 300 |
| SWE-bench Verified (§47) | CONTAMINATED | 55.6% | [51.2, 59.9] | 500 |
| **SWE-rebench (decontaminated)** | **CLEAN** | **37.3%** | **[25.3, 51.0]** | **51** |

**Finding (honest, not spun):** the clean resolve (**37.3%**, 19/51) is **below**
the contaminated band. Consistent with our headline being contamination-inflated
too (the §53 pattern). **Caveat:** SWE-rebench is a different, plausibly-harder
distribution, so the drop is *partly decontamination + partly benchmark-difference*
— confounded, and n=51 is directional (wide CI). The matched Opus-alone control
arm (below) isolates orchestration value from benchmark-difference.

## Coordinator-vs-constituents (the Fugu / orchestration-value test, clean data)

**Full-51 arms:**
| Arm | resolve | Wilson 95% CI | n | give-up % | cost |
|---|---|---|---|---|---|
| GLM-5.2 alone (single) | 19.6% (10/51) | [11.0, 32.5] | 51 | 62.7% | $4.25 ($0.083/inst) |
| **Darwin coordinator (GLM→Opus cascade)** | **37.3%** (19/51) | [25.3, 51.0] | 51 | 35.3% | ~$44 (~$0.85/inst) |
| Opus-4.8 alone (single) | partial — see matched-15 | — | — | — | (full-51 not run: held +$60 cap) |

**Matched subset — the 15 instances Opus-alone covered before the budget cap (apples-to-apples):**
| Arm | resolve on the SAME 15 |
|---|---|
| **Ornith-1.0-9B alone** (FREE, local — §64) | **2/15 = 13.3%** [3.7, 37.9] |
| GLM-5.2 alone | 3/15 = 20.0% |
| Darwin coordinator (cascade) | 5/15 = 33.3% |
| **Opus-4.8 alone** | **6/15 = 40.0%** [19.8, 64.3] |

**§64 free-local probe:** Ornith-1.0-9B (Qwen3.5-hybrid GGUF, ~93 tok/s, 6 GB VRAM, $0 inference via ollama 0.30.11) ALONE on the matched-15 = **2/15 = 13.3%** — does **NOT** bridge GLM(20%)→Opus(40%); it lands *below* GLM-alone, and its 2 wins are a strict subset of Opus's 6. Cause is behavioral: 14/15 exhausted the 20-step budget without `submit` (Ornith is trained to drive its own scaffold, not our fixed ReAct submit-protocol). Tool-call FORMAT bridged with zero harness changes (`<think>`+JSON parses via `parseAction`); the misfit is the finalize behavior. Added as a documented `ornith-1.0-9b` local allele in `evolve-arch.mjs` for later evolution.

Key deltas (clean data, matched n=15):
- **coordinator − best-single-constituent (Opus) = −6.7pp** — the coordinator does NOT beat its best constituent; it sits *below* Opus-alone.
- coordinator − GLM-alone = +13.3pp (cascade lifts the cheap base by escalating to Opus).
- Opus-alone resolved a strict SUPERSET of the cascade (the 5 cascade got + `zarr-python-2661`); union = Opus-alone = 6/15.

**Verdict:** orchestration's value on clean data is **cost** (resolve-per-dollar), NOT a resolve-rate edge over the best constituent. The "coordinator beats every model it coordinates" (Fugu-style) claim does NOT hold here — the cascade is a cost-Pareto play, and orchestration cannot bypass the shared hard tail (union ceiling = best single model). n=15 matched is directional (wide CI); the direction is unambiguous.

## Conformance + budget

- HV-1 firewall: solver reads only instance_id/repo/base_commit/problem_statement
  (grep-verified — zero gold-field access). `--no-test-oracle`; `leaderboardConformant:true`.
- Budget: user cap +$60 account delta (gate on `auth/key`, base 1052.01). All setup
  ($0 LLM); cascade ~$44; constituent arms capped to stay under +$60.

## Reproduce

```bash
# 0. fork harness (one-time): git clone github.com/SWE-rebench/SWE-bench-fork; pip install -e . (py3.12 venv at /tmp/rebench-venv)
# 1. manifest:        node bench/swerebench/build-manifest.mjs --since 2025-01-01 --max-p2p 100 --n 65 --out candidates-65.json
# 2. gold-validate:   node bench/swerebench/eval.mjs --mode gold --manifest candidates-65.json --run-id reb65 --workers 10   # -> clean-reb65.json
# 3. cascade solve:   SWE_IMAGE_NAMESPACE=swerebench OPENROUTER_API_KEY=$(cat /tmp/.orkey) node --experimental-strip-types \
#      bench/swebench/solve-agentic.mjs --manifest clean-reb65.json --model z-ai/glm-5.2 --cascade anthropic/claude-opus-4.8 \
#      --no-test-oracle --max-steps 20 --concurrency 5 --out predictions-cascade-51.jsonl
# 4. score:           node bench/swerebench/eval.mjs --mode score --manifest clean-reb65.json --preds predictions-cascade-51.jsonl --run-id cascade51 --workers 10
```
