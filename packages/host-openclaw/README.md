# @ruflo/host-openclaw

[OpenClaw](https://github.com/openclaw/openclaw) host adapter for the [agent-harness-generator](https://github.com/ruvnet/agent-harness-generator) project.

> OpenClaw — Personal AI Assistant. Any OS. Any Platform. The lobster way. 🦞

Generates the per-harness files an OpenClaw-targeted harness needs:

- `openclaw.json` — MCP server snippet to merge into `~/.openclaw/openclaw.json`
- `SKILL.md` — workspace skill (placed at `~/.openclaw/workspace/skills/<name>/SKILL.md`)
- `install-openclaw.sh` — runbook script (idempotent)

## Usage

```js
import adapter from '@ruflo/host-openclaw';

const config = adapter.generateConfig({
  name: 'my-bot',
  description: 'My personal lobster assistant',
  systemPrompt: 'You are a helpful agent.',
  mcpServers: [{ name: 'my-bot', command: ['npx', '-y', 'my-bot', 'mcp'] }],
});
// config['openclaw.json'] = '<JSON>'
// config['SKILL.md'] = '<YAML+markdown>'
// config['install-openclaw.sh'] = '<bash>'
```

## OpenClaw integration surface

| Aspect | Value |
|---|---|
| Install | `npm install -g openclaw@latest` then `openclaw onboard --install-daemon` |
| Main config | `~/.openclaw/openclaw.json` (JSON, not TOML/YAML) |
| Skills | `~/.openclaw/workspace/skills/<name>/SKILL.md` (YAML frontmatter + markdown) |
| First-class tools | browser, canvas, nodes, cron, sessions |
| MCP servers | register under `mcp_servers` in `openclaw.json` |
| Node version | ≥ 22.19 / 24 |
| License | MIT |

## What's different from the other host adapters

| | OpenClaw | Claude Code | Codex | Hermes | pi.dev |
|---|---|---|---|---|---|
| Config format | **JSON** | JSON | TOML | YAML | TypeScript module |
| Hooks system | (none documented) | rich, 5-handler | none | none | none |
| MCP support | yes | yes | yes | yes | **no (by design)** |
| Multi-platform messaging | **yes (built-in)** | no | no | no | no |

OpenClaw is the only host with built-in multi-platform messaging (WhatsApp/Telegram/Slack/Discord). For a harness that needs to push notifications to the user across channels, OpenClaw is the natural fit.

## License

MIT
