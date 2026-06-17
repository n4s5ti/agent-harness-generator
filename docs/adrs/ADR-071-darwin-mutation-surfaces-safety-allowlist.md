# ADR-071: Darwin Mode — bounded mutation surfaces + the hard safety allowlist

**Status**: Proposed (prototype)
**Date**: 2026-06-17
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-070 (Darwin Mode head), ADR-072 (scoring + promotion), ADR-022 (MCP default-deny), ADR-011 (witness), ADR-047 (control plane)

> Part of the Darwin Mode series (ADR-070…075). This ADR pins **what a child variant is allowed to change** and the **hard gate** that enforces it. The bound is the product: it is what lets us market Darwin Mode as *bounded* empirical self-improvement rather than uncontrolled recursive rewriting.

## Context

A self-modifying agent that can edit anything is a liability, not a feature. DGM's safety argument rests on sandboxing and human oversight; ours adds a third, stronger leg: **a structural allowlist enforced before any variant is allowed to run.** The child may *generate and improve code*, but only inside approved files, and only code that passes a static safety scan. Everything else — dependency manifests, lockfiles, secrets, env files, git config, network clients, shell-escape helpers, deploy scripts — is blocked by default.

This is the same posture as ADR-022 (MCP is default-deny, one selectable primitive) applied to self-modification: the harness's *capacity to change itself* is itself a default-deny surface.

## Decision

### Approved mutation surfaces (the only files a child may write)

Seven files, one concern each:

| Surface (`MutationSurface`) | File | What it controls |
|---|---|---|
| `planner` | `planner.ts` | how tasks are decomposed |
| `contextBuilder` | `context_builder.ts` | which files/symbols/logs enter context |
| `reviewer` | `reviewer.ts` | how patches are critiqued |
| `retryPolicy` | `retry_policy.ts` | when to retry / abandon / escalate / split |
| `toolPolicy` | `tool_policy.ts` | which tools are allowed and in what order |
| `memoryPolicy` | `memory_policy.ts` | what is remembered / retrieved / forgotten |
| `scorePolicy` | `score_policy.ts` | the scoring weights (read-only at run time — see below) |

A mutation picks exactly one surface, copies the parent variant directory, perturbs that one file, and writes a new variant. Nothing outside these seven files is created or modified.

### Blocked by default (never written, never executed)

`package.json` · lockfiles · `.env` / secrets / credentials / tokens / keys · git config · network clients · shell-escape helpers · deployment/release/infra scripts.

### The hard gate — `inspectVariant(dir)` runs *before* execution

Every variant is statically inspected before the sandbox runs it. The inspection disqualifies a variant (returns blocking findings) if **any** of these hold:

- a directory or file appears that is **not** one of the seven approved filenames;
- a filename matches a blocked pattern (`.env`, `secret`, `credential`, `token`, `private_key`, `id_rsa`, `.git`);
- file *content* matches a blocked-capability pattern: `process.env`, `child_process`, `execSync`, `spawn`, `curl`, `wget`, `ssh`, `sudo`.

A variant with any blocked action gets `exitCode = 99` and `safetyScore = 0` — it cannot be promoted (ADR-072 requires `safetyScore ≥ 0.95`). The gate is **code, not a comment**; this is the load-bearing rule of the whole system.

### Contract for the LLM-backed mutator (the next increment)

The prototype's `mutateContent` is deterministic string-replacement. It is replaced — behind the *same gate* — by a `CodeGenerator`:

```ts
export interface CodeGenerator {
  generateMutation(input: {
    parentCode: string;
    surface: string;
    repoSummary: string;
    parentScore: number;
    failedTraces: string[];
  }): Promise<{ code: string; summary: string }>;
}
```

Before the generated code is written to disk, it must pass a static validator that is independent of `inspectVariant` (defense in depth):

```ts
function validateGeneratedCode(code: string): string[] {
  const v: string[] = [];
  if (/process\.env/i.test(code))                      v.push("environment access blocked");
  if (/child_process/i.test(code))                     v.push("process spawn blocked");
  if (/fetch\(/i.test(code))                           v.push("network access blocked");
  if (/rm\s/i.test(code))                              v.push("destructive command blocked");
  if (/private_key|credential|token|secret/i.test(code)) v.push("secret handling blocked");
  return v;
}
```

The generation prompt fixes the contract: *edit only the provided file; return TypeScript only; keep exported signatures stable; no process spawning, no network, no env access, no secret handling, no filesystem access, no dependency changes.* A generation that violates the validator is discarded, not repaired-in-place.

### The ten containment rules (the marketing-safe envelope)

1. No production writes. 2. No credential access. 3. No network access by default. 4. No mutation outside approved files. 5. No promotion without benchmark evidence (ADR-072). 6. No deletion commands. 7. No child-process escape. 8. No hidden state. 9. No benchmark changes by the child (the child cannot edit the tasks it is scored on — ADR-072). 10. Full lineage and rollback (ADR-073 archive + ADR-011 witness).

## Consequences

### What gets easier

- The system is **honestly describable as bounded**. The allowlist is enumerable, the gate is testable, and a reviewer can audit the entire self-modification surface in seven files.
- Swapping the deterministic mutator for an LLM is a *contained* change: the gate and validator do not move.

### What gets harder

- The seven surfaces cap what evolution can discover. A genuinely new capability (e.g. a new tool integration) cannot emerge until a human widens the allowlist. This is intentional — capability expansion is a human decision, not an evolved one.
- Two independent checks (`inspectVariant` + `validateGeneratedCode`) must be kept in sync as patterns are added. The Test Contract pins both.

### What does not change

- ADR-022's MCP default-deny still gates *tool execution* at run time; this ADR gates *self-modification* at generation time. They are orthogonal layers.

## Alternatives Considered

1. **Allow arbitrary file edits with a post-hoc reviewer.** Rejected — a reactive reviewer cannot guarantee a destructive or exfiltrating variant never *runs*. The gate must be pre-execution.
2. **A single combined safety check.** Rejected — defense in depth (filename + content + generated-code validator) catches classes the others miss, and the cost is trivial.
3. **Let `score_policy.ts` be a live, mutable scorer.** Rejected — if the child can edit how it is scored, it games the benchmark. Score weights are a *mutation surface for proposing* different weightings, but the **authoritative** scorer that gates promotion lives outside the variant (ADR-072).

## Test Contract

1. **Allowlist enforcement** — a variant containing an eighth file (or a renamed/extra directory) is disqualified by `inspectVariant` with a clear finding.
2. **Blocked-content scan** — a variant whose approved file contains `process.env` / `child_process` / `fetch(` / `curl` is disqualified.
3. **Generated-code validator** — `validateGeneratedCode` rejects each blocked pattern; a generation that violates it is discarded, and the discard is logged.
4. **Gate precedes execution** — assert the sandbox never invokes the test command for a disqualified variant (`exitCode === 99`, no run trace beyond the inspection).
5. **Signature stability** — a mutated surface still exports the same function signatures the harness runtime imports.

## References

- ADR-070 (Darwin Mode loop + product surface), ADR-072 (why benchmark-immutability and `safetyScore ≥ 0.95` matter), ADR-022 (default-deny precedent), ADR-011 (witness/rollback).
- DGM safety model (sandboxing + human oversight) — https://arxiv.org/abs/2505.22954 — extended here with a structural allowlist.
