# ADR-009: Anti-Slop — Marketplace Quality Model

**Status**: Proposed
**Date**: 2026-06-13
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-005 (Marketplace), ADR-007 (CI guards), ADR-011 (Witness)

## Context

When the marketplace becomes easy to publish to, the marketplace becomes easy to flood. Other open marketplaces — npm, PyPI, the VS Code marketplace, Hugging Face Hub — have all had to learn this the hard way. The failure modes range from accidental ("a half-finished plugin gets published as v0.0.1 and is the top result for 'auth' for two years") to deliberate (typosquatting, supply-chain attacks via dependency confusion, prompt-injection payloads in plugin metadata).

We use the term **"slop"** for the broader category: low-quality output that flowed through a publish workflow because nothing stopped it. The defining property of slop is that it is recoverable — quality could have been higher with discipline. The defining property of malice is that it is targeted. Anti-slop techniques (smoke tests, quality signals, reputation) raise the floor; anti-malice techniques (signatures, sandboxes, CVE feeds) plug specific attacks. Both matter; this ADR covers both, and is honest about which is which.

Two contrasting prior arts shape the decision:

- **Hugging Face Hub** ships a metadata-rich, signal-heavy marketplace with downloads / likes / model cards / "spaces" but no central review. Quality emerges from signals.
- **VS Code marketplace** runs centralised editorial review. Publishers must register; gated for malware; manually reviewed in some categories. Reduces slop, raises the publishing bar significantly, is centralised under Microsoft.

We have rejected the central-review path (ADR-001 §Non-goal 4) — no "ruflo-certified" badge, no editorial body. So our model must look more like Hugging Face's: signals, not judgement. But Hugging Face also has hard floors (it removes models that violate ToS, surfaces "unsafe" model warnings). We need the equivalent.

This ADR pins down the quality model: smoke contract, signal weighting, trust tier derivation, schema-version migrations, gate vs surface decisions.

## Decision

### Five pillars of anti-slop

1. **Smoke contract** — a plugin / harness / pack that does not pass its bundled smoke contract is not publishable.
2. **Quality signals** — a structured set of measured signals on every entry. Decorated, not gating.
3. **Trust tiers** — derived deterministically from signals. The marketplace surface filters by tier.
4. **Sandbox + permission model** — every plugin declares its required permissions; the kernel enforces them at runtime.
5. **CVE / abuse feed** — entries flagged for security or abuse are removed or marked. Operated by ruflo maintainers initially; transferable.

We discuss each in detail.

### Pillar 1 — Smoke contract

Every plugin, harness, vertical pack, and host adapter ships a `smoke/` test directory. The contract:

- **For plugins.** A test that installs the plugin in a fresh test harness, asserts the plugin loads, asserts every declared export (agents, skills, MCP tools, hooks, commands per the `exports` field in ADR-005 §2) is reachable, and the plugin's `init` lifecycle returns without error.
- **For harnesses.** The harness-level smoke from ADR-007 §B1.
- **For vertical packs.** Same as plugins, plus a "scenario test" — at least one end-to-end scenario the pack ships (e.g. for a legal pack, "ingest a contract and produce a redline").
- **For host adapters.** The adapter contract from ADR-004 §Test Contract.

The smoke contract is **gating** on publish. The publish workflow (ADR-005 §9) refuses to push a plugin whose `npm test -- --suite smoke` fails. This is enforced both client-side (the `plugin publish` command runs the smoke first) and server-side (the IPFS registry append-only mutation validates the entry's `smokeStatus` flag must be `"pass"` at registration time, signed by the same key that signs the entry).

The flag is signed because otherwise a publisher could lie about smoke status. The Ed25519 signature covers `(id | version | checksum | registryCid | smokeStatus | smokeCommit)`. To produce a `smokeStatus: "pass"` signature, the publisher must have run the smoke and signed the artefact in the same CI flow.

A plugin can declare itself `"smokeStatus": "skip"` with a reason — but the registry tags such entries with the `unsmoked` flag and the marketplace UI surfaces a warning. Anti-slop accepts that `skip` exists; anti-slop refuses to hide it.

### Pillar 2 — Quality signals

Each entry in the marketplace carries a structured signal block:

```jsonc
{
  // ... ADR-005 schema fields ...
  "signals": {
    "smoke": {
      "status": "pass" | "fail" | "skip",
      "lastRunCommit": "<sha>",
      "lastRunAt": "2026-06-13T...",
      "skipReason": null
    },
    "provenance": {
      "npmProvenance": true,                 // ADR-005 §3
      "witnessManifestPresent": true,        // ADR-011
      "ed25519Signature": true
    },
    "compatibility": {
      "kernelEngines": "^1.0.0",
      "hostsSupported": ["claude-code","codex"],
      "lastCompatibilityCheck": "<sha of kernel commit it was last green against>",
      "currentlyCompatible": true            // re-derived periodically (see Pillar 5)
    },
    "usage": {
      "weeklyDownloads": 1234,               // from npm
      "totalDownloads": 50432,
      "downloadsTrend": "up" | "flat" | "down",   // 4-week trend
      "lastUpdated": "2026-06-13T..."
    },
    "maintenance": {
      "lastReleaseAt": "2026-06-01T...",
      "openIssuesCount": 3,
      "averageIssueAgeDays": 14,
      "responsivenessHours": 36              // median time to first maintainer response on a new issue
    },
    "feedback": {
      "thumbsUp": 42,
      "thumbsDown": 3,
      "ratio": 0.93
    },
    "warnings": ["unsmoked"] | ["abandoned"] | ["security:advisory-2026-06-13"] | []
  }
}
```

The signals are not editorial. Every value is measured: npm download stats, GitHub issue timing, CI status, signature verification. The marketplace surface (the `plugin search` command, the future web view) sorts and filters on these. The user can decide what they care about.

Specifically rejected as a signal: a star rating. Star ratings are gameable, low-signal, and selected-for-the-loud. Thumbs-up / thumbs-down is also gameable but at least is binary, less amplified than 5-star scales, and the marketplace can de-duplicate by signing thumbs with the user's public key (one user, one vote per plugin).

### Pillar 3 — Trust tier derivation

A plugin's `trustLevel` (`official | verified-author | community | experimental`) is **derived**, not declared. The derivation:

```
trustLevel := MAX_DOWN(
  if author.id is in registry's officialAuthors[] AND signals.provenance.witnessManifestPresent
     AND signals.smoke.status = "pass" AND signals.compatibility.currentlyCompatible
  → "official"

  else if signals.provenance.npmProvenance AND signals.provenance.ed25519Signature
     AND signals.smoke.status = "pass" AND author.verified = true
  → "verified-author"

  else if signals.smoke.status = "pass"
     AND signals.maintenance.lastReleaseAt within last 6 months
     AND signals.warnings does not contain "security:*"
  → "community"

  else
  → "experimental"
)
```

The derivation runs in the publish workflow and re-runs daily (when signals refresh). A plugin can drop tier (e.g. if its smoke status flips to `fail`, or if it goes unmaintained for 6 months and slides to "community", or if a security advisory is filed). The marketplace UI surfaces tier prominently. Users filtering for `"official"` are filtering for verified+witnessed+smoked+compatible — a high bar that is mechanically checked.

We deliberately do not have a "ruflo-approved" tier. There is no editorial layer that can promote a plugin. The criteria for the top tier are objective and re-derived. This avoids the failure mode "the editorial team becomes a bottleneck" or "the editorial team plays favourites." It accepts the cost that a genuinely excellent community plugin cannot get to "official" tier without a maintainer being on the official list — which is fine; "official" means "by-the-ruflo-team" not "best."

### Pillar 4 — Sandbox + permission model

Plugins declare required permissions in their manifest (`permissions: ["memory","network:acme.example.com"]`). The kernel enforces:

- **`memory`** — read/write to the harness's memory namespaces.
- **`network:<host>`** — outbound HTTPS to specified host. Wildcards (`network:*`) are permitted but raise the "experimental" trust tier ceiling — they cannot be `official`.
- **`fs:<path-glob>`** — file system access scoped to a path.
- **`exec:<allowlist>`** — child-process spawn restricted to an allowlist of binaries (no `exec:*`).
- **`mcp-tool:<id>`** — call other plugins' MCP tools.

At install time, the harness inspects the plugin's permissions and either (a) grants automatically (if they match the harness's default allowlist), (b) prompts the user (CLI: print the permission list, ask y/N), or (c) refuses (if the permission is forbidden by `harness.config.json` `plugins.deniedPermissions`).

This is patterned on the VS Code extension permission model and the browser-extension permission model (https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions). It is not as strong as a process-level sandbox (we are running JavaScript in the same node process), but combined with the witness signature and the trust tier it raises the bar for a hostile plugin meaningfully.

A future ADR can add real sandboxing (`isolated-vm`, WASM, sub-process isolation). v1.0 stops at declared permissions.

### Pillar 5 — CVE / abuse feed

Entries in the registry can be tagged `signals.warnings: ["security:<advisory-id>"]` or `signals.warnings: ["abuse:<reason>"]`. The marketplace UI surfaces these prominently; the kernel refuses to install a plugin with a `security:` warning unless the user passes `--accept-risk`.

Operationally:

- A security advisory feed at `signals/security-advisories.json` (a separate signed JSON document, fetched alongside the registry). Lists `{ pluginId, version, advisory, severity, mitigation }`. The kernel checks at install time.
- An abuse-flag mechanism for the registry maintainer (initially ruflo's team) to mark a plugin as abusive. The flag is signed by the registry maintainer's key.
- For independence-mode harnesses (ADR-015) that point at their own registry, the harness operator is the one maintaining their advisory feed. They can subscribe to ruflo's feed and re-export.

The CVE/abuse feed is the only place editorial judgement enters the system, and even there it is bounded: a maintainer can flag, they cannot upvote. The flag is a "do not install this" signal; positive promotion is mechanical.

### Schema-version migration policy

The plugin manifest schema (ADR-005 §2) will evolve. When `schemaVersion` increments, the registry serves both `N` and `N+1` shapes during a documented deprecation lane:

- **Day 0** — `N+1` lands; new plugins ship in `N+1`. The registry tools dual-stack: every entry exists in both shapes (the registry JSON is rendered twice; clients pick the version they support).
- **Day 0 + 6 months** — new plugins must use `N+1`. The registry refuses `N`-only entries.
- **Day 0 + 12 months** — the `N` shape is removed from rendered registry output. Clients on the old kernel can no longer find any plugins. The kernel ships a soft deprecation warning a month before this.

This is the npm registry / VS Code marketplace migration model. Twelve-month tail is the minimum that respects users on long-lived ruflo installations.

### Surface vs gate decisions

A clean way to think about every pillar above: is it a **gate** (cannot publish if X) or a **surface** (we publish but show Y)?

| Concern | Gate | Surface |
|---|---|---|
| Failed smoke contract | **Yes** | n/a |
| Missing npm provenance | No (anti-slop accepts non-GitHub CI) | **Yes** (lowers trust tier) |
| Missing witness manifest | No | **Yes** (cannot reach "official") |
| Permission wildcard | No | **Yes** (caps trust tier at "experimental") |
| Security advisory | **Yes** (kernel refuses install w/o `--accept-risk`) | **Yes** (prominent warning) |
| Abuse flag | **Yes** (registry removes from default search) | **Yes** (the flag is shown if the user explicitly looks) |
| Stale (6+ months) | No | **Yes** ("abandoned" warning, drops tier) |
| Low download count | No | **Yes** (sort order) |

The bias is: gate only when the alternative is dangerous (broken plugin, known-vulnerable plugin, abuse). Otherwise surface. This keeps the marketplace participatory while making slop visible.

### What happens when slop wins anyway

We will publish a plugin that passes its smoke contract, accumulates downloads, and turns out to be slop (poorly maintained, misleading docs, narrow use case). The marketplace will surface it. We accept this. The remedies are:

- **Time** — the maintenance signal degrades; the trust tier drops.
- **Substitution** — a better plugin appears, its signals are stronger, search ranking favours it.
- **Curation in vertical packs** — vertical pack owners (ADR-013) pick their own preferred plugins for the pack's recommendations; "what does the legal pack recommend?" carries more signal than "what is popular in legal-tagged plugins?"

What we will not do is hide the slop. Hiding requires editorial judgement, which we have deliberately rejected.

## Consequences

### What gets easier

- **A clear publishing path with built-in floor.** The smoke contract is binary and mechanical. Either it passes or it does not.
- **A trust badge that means something.** "official" tier means specific measurable things, not "we like this author."
- **An adversary's path is narrower.** Typosquatting still happens but lands as `experimental`; the user must go out of their way to install it.

### What gets harder

- **Smoke contracts are real work to write.** Every plugin author writes their own. We mitigate by shipping good defaults via the `plugin scaffold` command (the smoke directory is scaffolded with sensible stubs).
- **Trust tier derivation must be transparent.** Users and authors will challenge tier assignments. We commit to the derivation being readable; the `signals` block is in the plugin's registry entry; "why is this `community` not `official`?" has a checkable answer.
- **The signals refresh is a CI job.** Daily, registry-wide. As the marketplace grows this is a real workload; sharded by category if needed.

### What does not change

- The publishing path (ADR-005 §9) is the same. Plugins are still npm packages with IPFS-registered metadata. Anti-slop is a layer on top of the schema.
- The kernel's runtime plugin loading is unchanged except for the new permission check.

## Alternatives Considered

### Alternative 1: Editorial review for the top tier

A team of maintainers explicitly promotes plugins to "official." Rejected per ADR-001 §Non-goal 4 — the team becomes a bottleneck and a target of favouritism complaints. The derivation rule is harder to game and easier to audit.

### Alternative 2: 5-star ratings

Reject. 5-star ratings are amplified by loud voices, gameable by the maintainer's friends, and have no clear semantics. Thumbs-up/down is honest enough.

### Alternative 3: No quality signals; let users figure it out

The minimal-paternalism position. Rejected because the user's "figure it out" requires reading the source of every plugin before installing, which scales catastrophically. The signals are the user's force multiplier.

### Alternative 4: Mandatory editorial review for all plugins (closed marketplace)

Reject as a stronger form of Alternative 1. Closes the participation we want.

### Alternative 5: Sandbox every plugin in a separate process / WASM module

The strongest defense-in-depth. Rejected for v1.0 because (a) the engineering cost is large, (b) the perf impact is real (every MCP tool call crosses a process boundary), and (c) the permission model + signed publishes already raise the bar materially. A future ADR can add sandboxing; this ADR sets up the permission model that a sandbox would enforce.

## Test Contract

This ADR is satisfied when the following exist:

### Smoke contract enforcement

1. **A plugin that fails its smoke contract cannot be published.** Test: scaffold a plugin, deliberately break the smoke test, run `plugin publish`, assert it refuses.
2. **A plugin that lies about smoke status (signs `pass` without running) is detected.** Test: forge a registry entry with `smokeStatus: pass` but a `smokeCommit` SHA that does not exist; assert the kernel rejects the entry.

### Trust-tier derivation

3. **The derivation is deterministic.** Given a fixture of `signals` blocks, the derived `trustLevel` matches the spec table verbatim.
4. **Tier degradation works.** A fixture plugin with `smokeStatus: pass` at first, then `fail` after a signal refresh, drops from `community` to `experimental`. Asserted via a synthetic time sequence.

### Permission enforcement

5. **A plugin requesting `network:*` cannot reach `"official"` tier.** Asserted via the derivation test.
6. **A plugin requesting an unallowlisted permission prompts the user at install.** Asserted via a CLI-driven integration test with a tty mock.
7. **A plugin denied a permission cannot exercise it at runtime.** Specifically, a plugin declared `permissions: ["memory"]` cannot make outbound HTTPS calls; the kernel intercepts and throws.

### Signal refresh

8. **The daily signal refresh job** populates `signals.usage.weeklyDownloads`, `signals.maintenance.lastReleaseAt`, etc. Given a fixture of mock-npm and mock-GitHub APIs, the refresh produces the expected signal block.

### Security advisory + abuse feed

9. **A plugin flagged with `security:advisory-X` cannot be installed without `--accept-risk`.** Asserted via integration test.
10. **An abused plugin disappears from default search but remains explicitly addressable.** Asserted via the marketplace search test.

### Schema migration

11. **Dual-stack registry serving** — a fixture registry with both `N` and `N+1`-shaped entries; the kernel parsing either works. Cross-version compatibility table is in the test fixture.

## References

### Ruflo internals cited

- `v3/@claude-flow/cli/src/plugins/trust/` — the existing trust-tier infrastructure; ADR-009 specifies the derivation rule that replaces ad hoc trust assignment.
- `v3/@claude-flow/cli/src/plugins/store/types.ts` — the schema the `signals` block extends.

### External prior art

- **npm provenance attestation** (the gating signal for "official" tier) — https://docs.npmjs.com/generating-provenance-statements.
- **Hugging Face Hub Model Cards spec** (the structured-metadata model the `exports` and `signals` fields draw from) — https://huggingface.co/docs/hub/model-cards.
- **SLSA v1.0** (supply-chain levels for software artifacts; the long-term roadmap for the witness layer) — https://slsa.dev/spec/v1.0/.
- **in-toto attestation** (the standardised attestation format the witness manifest wraps for marketplace consumers) — https://github.com/in-toto/attestation.
- **Sigstore** (the transparency-log path optional under ADR-011) — https://www.sigstore.dev/.
- **Socket.dev "author typosquatting on npm"** (the heuristic the anti-slop signal layer borrows: Levenshtein ≤ 2 + ≥1000× download ratio, plus 70+ behavioural signals) — https://socket.dev/blog/author-typosquatting-on-npm.
- **VS Code marketplace clean-room VM dynamic analysis** (the centralised-review model we explicitly reject in favour of mechanical signals, cited for the trade-off context) — https://developer.microsoft.com/blog/security-and-trust-in-visual-studio-marketplace.
- **VS Code marketplace publisher policies** (the verified-publisher badge model influence) — https://code.visualstudio.com/api/working-with-extensions/publishing-extension.
- **Chrome Web Store review process** (the "dynamic analysis with publish gating" precedent we reject for being centralised) — https://developer.chrome.com/docs/webstore/review-process.
- **Chrome Web Store program policies** (typosquat / malware framing) — https://developer.chrome.com/docs/webstore/program-policies.
- **Chrome / browser-extension permission model** (the permission-list pattern Pillar 4 mirrors) — https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions.
- **Cargo's `cargo-vet` / `cargo-crev`** review systems (distributed code review as an alternative to editorial; informs the "no editorial body" stance) — https://github.com/mozilla/cargo-vet, https://github.com/crev-dev/cargo-crev.

### Ruflo ADRs cited

- ADR-005 (Marketplace) — the schema this layer decorates.
- ADR-007 (CI guards) — the publish-side enforcement points.
- ADR-011 (Witness) — the witness-manifest signal feeds Pillar 2.
