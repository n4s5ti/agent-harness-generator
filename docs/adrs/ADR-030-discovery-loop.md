# ADR-030: The Discovery Loop — Build the Tool, Propagate Everywhere, Surface at the Moment of Need

**Status**: Accepted
**Date**: 2026-06-14
**Related**: ADR-010 (TDD test contracts), ADR-027 (CLI ↔ Web-UI integration), ADR-028 (Skew Detection and Liveness), ADR-029 (Cross-Language Invariants)
**Supersedes / Superseded-by**: none

## Context

By iter 90 the project had built `harness diag --bundle` — a one-command JSON snapshot that captures every diagnostic fact a maintainer would need to triage a support ticket. The tool worked and tests pinned its shape. But shipping the tool wasn't the same as users finding it. The dominant failure mode shifted from "the tool doesn't exist" to "the tool exists but the user doesn't know it does."

This is a generic class of friction that recurs every time a useful feature lands:

| Stage | User experience |
|---|---|
| 1. Tool exists in source | User has no way to discover it; only contributors who read the diff know |
| 2. Tool documented in README | User reading the README during onboarding may notice. User searching for a solution to a specific problem won't think to grep README. |
| 3. Tool surfaced in the matching CLI's `--help` text | User running `harness --help` sees it, but only if they already know to ask |
| 4. Tool surfaced contextually at the moment the user needs it | User hits the failure → sees the suggestion → uses the tool. Zero search cost. |

Stage 4 is where iter 93 + iter 94 landed: `harness doctor` and `harness validate` umbrellas both recommend `harness diag --bundle` on FAIL.

The progression from stage 1 (iter 90) to stage 4 (iter 94) took five iters and re-touched five different surfaces. Without a discipline this becomes ad-hoc: some features get the full treatment, others stop at stage 2. Users hit problems in the "stage 2" features and never find the tool.

This ADR documents the discipline so it's reusable. The next time we ship a feature like the bundle, the propagation sequence is mechanical.

## Decision

### 1. The Discovery Loop is a five-step sequence

Every user-facing feature follows the same propagation:

```
Step 1: Build       — Implement the tool + tests pin its shape
Step 2: Surface     — Add to README day-to-day commands table + harness help text + codex skill
Step 3: Catalog     — Add to dev-toolkit listing + plugin.json command description
Step 4: Discover    — Surface contextually at the moment of failure ("Next: …" block)
Step 5: Test the propagation — Tests grow teeth across each surface
```

iter 90→94 demonstrates the full sequence for the bundle:

| Step | Iter | Surface |
|---|---|---|
| 1 — Build | 90 | `diag.ts` + 3 new tests in `harness-diag.test.ts` |
| 2 — Surface | 91 | README day-to-day row + `.codex/skills/diag-harness/README.md` Equivalent CLI block |
| 3 — Catalog | 91 | `.claude-plugin/plugin.json` command description + `dev-toolkit.mjs` summary |
| 4 — Discover | 93 | `harness doctor` FAIL message — "Next: harness diag … --bundle" |
| 4 — Discover | 94 | `harness validate` umbrella FAIL message — same suggestion, same redaction reassurance |
| 5 — Test | 93+94 | `doctor-fail-message.test.ts` + 2 cases in `validate.test.ts` pin the FAIL output |

A feature that stops at step 2 is "documented but undiscoverable." A feature that stops at step 4 without step 5 is "discoverable but liable to regress silently when the next iter touches the failure path."

### 2. Step 4 has its own contract

The "Next:" block follows a specific shape every time:

```
Next: <one-line description of why this command is the right next step>
  <copy-pasteable command using the user's actual context (path, project, etc.)>
(then <one-line description of what to do with the output> at
 <URL or instruction> — <reassurance about safety/sanitisation/cost
 that removes the user's reason not to do it>)
```

Three load-bearing elements:

1. **Copy-pasteable command using the user's actual context.** iter-93's test pins this: `harness doctor /some/path` produces a suggestion that uses `/some/path`, not `cwd`. Users on Windows with spaces in paths shouldn't have to mentally substitute.
2. **Reassurance about the cost of taking the suggested action.** iter-93's bundle suggestion includes "the bundle is sanitised; secret_/token_/key_/password_ fields are redacted" — without this, users hesitate to paste a "bundle" into a public issue. The reassurance is the contract that makes the suggestion actionable.
3. **Suggestion appears only on FAIL**, never on success. HEALTHY output stays clean. The contextual nature is the whole value; surfacing the suggestion on every run dilutes it to noise.

### 3. Step 5 has its own contract too

Tests that pin the propagation must do two things:

1. **Assert the suggestion appears on FAIL**, including the URL + reassurance lines, AND
2. **Assert the suggestion does NOT appear on HEALTHY**.

iter 94's `validate.test.ts` pair is the canonical shape:

```ts
it('umbrella FAIL message recommends diag --bundle', async () => {
  // empty dir → forces FAIL
  const r = await validate([emptyDir, '--skip-gcp']);
  expect(r.code).toBe(1);
  expect(r.lines.join('\n')).toMatch(/Next:\s*capture/);
  expect(r.lines.join('\n')).toContain('github.com/.../issues');
  expect(r.lines.join('\n')).toMatch(/secret_\/token_\/key_\/password_ fields are redacted/);
});

it('HEALTHY result has no bundle suggestion noise', async () => {
  // clean harness → HEALTHY
  const r = await validate([cleanDir, '--skip-gcp']);
  expect(r.code).toBe(0);
  expect(r.lines.join('\n')).not.toMatch(/Next:\s*capture/);  // ← load-bearing
});
```

The "doesn't appear on HEALTHY" half is the one contributors forget; without it, a future refactor can leak the suggestion onto every run and the change goes undetected.

### 4. Which features warrant the full 5-step treatment

Not every feature needs all five steps. The discovery loop is overhead. The right gate:

| Feature shape | Discovery treatment |
|---|---|
| User-facing CLI tool that solves a problem users will independently encounter (`harness diag --bundle`, `harness audit`, `harness sbom`) | Full 5 steps |
| Internal helper script (`scripts/version-bump.mjs`, `scripts/pack-all.mjs`) | Step 1 + step 3 (dev-toolkit). No README row, no "Next:" suggestion. |
| Cross-cutting infrastructure (`pages-monitor.yml`, healthcheck checks) | Step 1 + step 5 only. Users don't invoke these directly; CI does. |
| A new vertical or host adapter | Different propagation — see iter 80→89's pattern documented separately in ADR-029 step #3 (the tour-script form). |

### 5. The cost of skipping a step

| Step skipped | What goes wrong |
|---|---|
| Skip step 2 (README/skill) | The feature is undiscoverable except by reading the source. Users hit problems and don't realise the tool exists. |
| Skip step 3 (catalog) | Tab-completion drift (iter 67-69 caught this for the harness subcommand surface). Users find the feature when they encounter the failure but don't tab-discover it. |
| Skip step 4 (contextual surfacing) | The user must already know what they need to ask for. Users who don't recognise their problem map to the tool don't reach it. |
| Skip step 5 (tests) | A later refactor can silently break the discovery flow. Most painful when steps 1-4 are all there but the failure-context suggestion goes away in a regression that nobody catches. |

## Consequences

**Good**:

- Five-step propagation is now mechanical. The next time we ship a tool like the bundle, we know the surfaces to touch and the test shapes to write.
- The "Next:" block contract is explicit: command + URL + reassurance, on FAIL only. iter 93/94's regex tests can be copied to any new feature.
- ADR-029's catalog-gate pattern (4 defensive layers) and ADR-030's discovery loop (5 propagation steps) together cover most of what "shipping a user-facing feature properly" actually involves.

**Hurts**:

- Five steps takes five iters. iter 90→94 was a focused sequence; in retrospect we could have batched into 2 iters (build+surface, then propagate+discover+test). The trade-off is each iter's diff stays reviewable.
- The "Next:" block costs lines on FAIL output, and some users prefer terse output. We accept the cost because users who already know what to do can ignore the block; users who don't are exactly who needs it.
- Step 4's "appears on FAIL but not on HEALTHY" is testable but easy to forget when refactoring. The tests are the only defense; if the test pattern isn't followed for a new tool, the regression goes undetected.

## Alternatives Considered

**A) Single iter that does all 5 steps at once.** Tempting — fewer commits, less context-switching. Rejected: the bigger the diff, the harder the review, the more likely a step is missed silently. The 5-iter cadence keeps each step's diff focused and explicit.

**B) Skip step 5 (tests for the FAIL/HEALTHY surfaces).** Rejected: this is the step most often skipped in practice (the suggestion looks "obviously correct" so why test it?) and the step whose absence has the highest cost (silent regression on the user's primary discovery path).

**C) Embed step 4 in step 1.** Combine "build the tool" with "build the failure surfacing." Considered but rejected: at iter 90's "build" stage we didn't know which failure paths would benefit from the suggestion. iter 93's doctor + iter 94's validate emerged from "where do users hit problems?" not "where do we already have failure-paths in the source?". The discovery is real even if the implementation is mechanical.

**D) A "discovery framework" — generic Next:-block infrastructure.** Considered: a helper that generates the "Next:" block from a config. Rejected as premature: we have N=1 fully-propagated tool (bundle). The shape may need to evolve as N grows. Until 3+ tools follow the same pattern, the right move is to copy the iter-93 implementation; the abstraction will emerge with usage data.

## Test Contract

The architecture is shipped when ALL of these are green:

| # | Test | Pins |
|---|---|---|
| 1 | `__tests__/doctor-fail-message.test.ts` "on FAIL, the message includes the diag --bundle suggestion" | Step 4 (doctor) |
| 2 | `__tests__/doctor-fail-message.test.ts` "the bundle command in the suggestion uses the user-passed path" | Step 4 — copy-pasteable command shape |
| 3 | `packages/create-agent-harness/__tests__/validate.test.ts` "umbrella FAIL message recommends diag --bundle (iter 94)" | Step 4 (validate) |
| 4 | `packages/create-agent-harness/__tests__/validate.test.ts` "HEALTHY result has no bundle suggestion noise" | Step 4 — only on FAIL invariant |
| 5 | `__tests__/harness-diag.test.ts` "sanitises secret-like keys in the manifest" (iter 90) | Step 4 reassurance — sanitisation is real |
| 6 | `__tests__/codex-skills.test.ts` "all 7 codex skills are present" | Step 2 (codex skill) |
| 7 | `__tests__/claude-marketplace-plugin.test.ts` (any skill-presence pin) | Step 3 (plugin.json) |

A PR that ships a new "Next:" suggestion path without (1)+(2)+(4) is incomplete by the discipline this ADR documents.

## References

- iter 90 — `harness diag --bundle` shipped (step 1 + tests)
- iter 91 — README + codex skill + plugin.json + dev-toolkit propagation (steps 2-3)
- iter 92 — ADR-029 documents the cross-language invariant pattern (parallel architecture decision)
- iter 93 — `harness doctor` FAIL message recommends `--bundle` (step 4 + tests)
- iter 94 — `harness validate` umbrella FAIL message recommends `--bundle` (step 4 + step 5)
- iter 67-69 — the "subcommand surface drift" pattern that step 3 prevents
- ADR-010 — TDD test contracts
- ADR-027 — CLI ↔ Web-UI integration
- ADR-028 — Skew Detection and Liveness
- ADR-029 — Cross-Language Invariants and Defense-in-Depth Catalog Gates
