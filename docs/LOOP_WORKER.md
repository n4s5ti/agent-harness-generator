# Darwin Mode — autonomous loop worker directive

Versioned source of truth for the cron/`/loop` worker. **Cadence: every 5 min until complete.**
Updated 2026-06-22 for the **ADR-173 leaderboard-conformant phase**.

## Active goal (ADR-173): a LEGITIMATE top-10 on SWE-bench Lite → then Verified
Our 68.3% used the gold `FAIL_TO_PASS` as an in-loop oracle → **not submittable**. Drive a conformant,
cost-per-resolve-optimal entry to a real placement. **Completion = a conformant batch clears the phase
threshold AND is submitted (or no lever fits remaining budget).**

| phase | target | how | done? |
|---|---|---|---|
| L0 | conformant solver | `solve-agentic --no-test-oracle` + leakage guard | ✅ shipped |
| L0.5 | strong conformant signal | run repo's OWN tests in the instance Docker image (no gold patch) | pending |
| L1 | **Lite top-10 (≥45%)** | conformant MiniMax-M2.5, full-300, 1 attempt, `--max-cost` | pending |
| L2 | **Lite #1 (>60.33%)** | + PTY loop (ADR-170) + conformant best-of-N | pending |
| V1 | **Verified top-10 (~70%)** | same stack on Verified-500 | pending |

Model = cost-per-resolve frontier (leaderboard data): **MiniMax M2.5** (75.8% Verified @ ~$0.07/inst),
DeepSeek V3.2 ($0.23/$0.34 — cheapest reasoning), Kimi K2.5. NOT Opus (10× cost). All verified on OpenRouter.

## Each 5-min tick
1. **HEALTH** — prune docker + `/tmp/sbrepo-*` >30min; `docker kill` sweb.eval >12min (requests-2317 hangs); warn disk<50G/RAM<10G.
2. **RUN** — if a conformant solve/eval is in flight, check it; on completion → official batch eval → resolve-rate + Wilson CI + **assert `leaderboardConformant:true`** → commit RESULTS. Only batch numbers are authoritative.
3. **ADVANCE** — pilot → full-300 → next phase, each gated on the prior batch clearing its threshold. Every paid run carries `--max-cost` (the in-solver cap; never rely on an external watchdog — see the $2.64 overage lesson).
4. **UPKEEP** — branch+main sync; #39 + gist + README current; publish darwin when a *conformant* number materially changes the story.
5. **SUBMIT** — once a conformant batch clears a phase threshold: package predictions + trajectories + metadata, PR to `swe-bench/experiments`.

## Stop / complete condition
Stop when (a) a conformant top-10 (Lite, then Verified) is achieved + submitted, OR (b) no resolve-rate
lever fits the remaining budget. Then idle on health + upkeep. ONLY real measured numbers + CIs, never fabricate.

See `docs/adrs/ADR-173-leaderboard-conformant-top10.md` (plan) · ADR-170 (PTY) · ADR-172 (SOTA roadmap).
