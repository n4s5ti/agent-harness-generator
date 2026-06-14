# MetaHarness: repo-maintainer vertical

A ready-made multi-agent template that scaffolds an open-source repo maintenance bot on top of Claude Code. The vertical ships three coordinated agents — a triager, a reviewer, and a release manager — wired to GitHub MCP, settings.json permissions for `gh` and `git`, and a routing config that pushes the expensive work onto Sonnet/Opus while keeping triage cheap on Haiku. It is for maintainers who want an opinionated starting point instead of assembling agents, prompts, and MCP servers by hand. It does NOT replace human review on merges, automate destructive git operations, or open PRs without your confirmation — the default permission mode requires acceptEdits.

## Quickstart

```bash
npx @metaharness/repo-maintainer@latest my-bot
cd my-bot && npm install && harness doctor
```

The `harness doctor` step verifies your Node version, that the GitHub MCP server can authenticate (`GITHUB_TOKEN` or `gh auth status`), and that Claude Code is on PATH. Once it passes, point Claude Code at the folder and the three agents register automatically.

## What you get

- `agents/triager.md` — Tier 2 (Haiku). Labels new issues, asks for repros, closes duplicates against the existing issue corpus.
- `agents/reviewer.md` — Tier 3 (Sonnet). Reads PR diffs, runs the lint/test commands declared in `harness.config.json`, leaves inline review comments.
- `agents/release-manager.md` — Tier 3 (Opus). Drafts changelogs from merged PRs, bumps semver in `package.json`, opens the release PR.
- `.mcp.json` — GitHub MCP server pre-wired (issues, pulls, releases scopes) plus a filesystem MCP scoped to the repo root.
- `.claude/settings.json` — allowlist for `gh issue *`, `gh pr *`, `gh release *`, `git status`, `git log`, `git diff`, `npm test`, `npm run lint`. Everything else prompts.
- `harness.config.json` — declares lint/test/build commands, label taxonomy, release branch, and the maintainer handle the bot should @-mention on escalation.
- `commands/triage.md`, `commands/review.md`, `commands/release.md` — slash commands that kick off each agent.

## Advanced

```bash
# Verify environment, tokens, and MCP servers
harness doctor
# expected: "GitHub MCP: ok (user=ruvnet, scopes=repo,read:org)"
#           "Claude Code: 1.x on PATH"
#           "harness.config.json: valid"

# Validate the scaffold's agent + command definitions
harness validate
# expected: "3 agents ok, 3 commands ok, 0 schema errors"

# Run headless against an issue without opening Claude Code
claude -p --plugin-dir my-bot "/triage #482"

# Dry-run a release to see the changelog without bumping or pushing
claude -p --plugin-dir my-bot --permission-mode plan "/release patch"
```

Tune model routing in `harness.config.json` — set `triager.model` to `sonnet` for noisier issue trackers, or bind the reviewer to `opus` on security-sensitive repos. Add custom labels in the `labels` map and they flow into the triager's prompt at next session start.

## FAQ

**Does this work on a private repo?** Yes, as long as your `GITHUB_TOKEN` (or `gh` CLI auth) has `repo` scope on the target. The GitHub MCP server uses whichever credential it finds first.

**Can I use it with GitLab or Bitbucket?** Not out of the box. The agents call `gh` commands directly. You'd need to swap the MCP server and rewrite the three command files; at that point you're better off using the host scaffold (`@metaharness/claude-code`) and building up from there.

**Why are there three agents instead of one prompt?** Routing. Triage runs hundreds of times a week and should stay on Haiku; review runs on diff context and needs Sonnet; release happens rarely but synthesizes a lot of history and benefits from Opus. One mega-prompt would either overpay or underperform.

## License

MIT. Built on metaharness (https://www.npmjs.com/package/metaharness).
