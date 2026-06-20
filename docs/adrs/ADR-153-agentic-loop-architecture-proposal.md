# ADR-153: Beyond escalation — the agentic-loop architecture for the 65–88% tier

**Status**: Proposed (roadmap; the resolve-rate ceiling of the current paradigm is mapped)
**Date**: 2026-06-19
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-149/151/152 (the 7.7→40.3% ladder), ADR-148 (tiering), issue #39

## Why now

The single-shot-localize + search/replace + repair + tiered-escalation paradigm has been pushed to a
measured **40.3%** on SWE-bench Lite (ADR-152), via two compounding levers:

| lever | rate |
|---|---|
| baseline | 7.7% |
| closed-loop repair | 15.3% |
| stronger cheap base (v4-pro) | 29.3% |
| + frontier-tail Scholar | 33.3% → **40.3%** (v4-pro base) |

The remaining levers within this paradigm are now low-ROI: a 3rd frontier tier (Sage, ADR-152
follow-up) attacks an ever-harder residual at steeply rising $/resolve; router (ADR-145) and knob
evolution are cost optimizations, not resolve-rate. **The gap from 40.3% to the 65–88% agentic-SOTA
tier is architectural, not a tuning gap.**

## The structural limitation

Every solver in this arc is **single-turn-per-attempt**: localize → emit a patch → (repair) re-emit.
It never *explores*. The instances it fails share a signature: the fix requires **discovering**
context the lexical/LLM localizer can't surface in one shot — reading call sites, running a failing
test to see the actual stack, grep-ing for a helper, checking a sibling module's convention. SOTA
agents (the 65–88% systems) are **multi-step autonomous loops** with a real tool surface.

## Proposal: an agentic execution loop as a new sandbox mode

Add `--sandbox agentic` (alongside `real`/`mock`/`agent`) — a bounded ReAct-style loop where the model
drives, per step, a **restricted tool surface inside the existing safety gate**:

- `read(path, range)` · `grep(pattern)` · `ls(dir)` — repo navigation (read-only)
- `run_tests(ids)` — execute FAIL_TO_PASS in the instance's Docker image, return the real trace
- `edit(search, replace)` — the current search/replace primitive (already validated)
- `submit()` — finalize the diff

Bounded by: max steps (e.g. 20), max tokens, wall-clock, and the **same `validateGeneratedCode`
safety gate** (no new imports/network/shell/secret access in emitted edits). Darwin's 7 mutation
surfaces become the *policy* the loop evolves: `planner` = step strategy, `toolPolicy` = tool
ordering/budget, `contextBuilder` = what to read next, `retryPolicy` = when to re-test vs re-read.

## Why this is the right next investment

1. It targets the *measured* failure mode (can't-discover, not can't-emit) — §9's emission wall was
   climbed by repair; the residual is a **discovery** wall.
2. It reuses everything proven: search/replace primitive, Docker test oracle, safety gate, the
   tiered cheap→frontier routing (run the agentic loop on a cheap base, escalate hard cases).
3. It keeps the project's thesis intact: **the harness (now an agentic loop) is the lever**; evolve
   the loop's policies, keep the model swappable.

## Honest expectation

Agentic loops are where the 65–88% numbers live, but they cost more tokens/instance (multi-step) and
add failure modes (loops, tool-thrash, context blow-up) the single-shot paradigm doesn't have. The
deliverable of this ADR is the *architecture + safety envelope*; the empirical number is the next arc.

## Status of the current paradigm

Frozen at **40.3%** (ADR-152) as the cheap-base + tiered-escalation ceiling. Further escalation tiers
are recorded but yield diminishing pp at rising cost. The resolve-rate frontier now moves to this
agentic architecture.
