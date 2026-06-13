# @ruflo/vertical-trading

Standalone vertical pack for the [agent-harness-generator](https://github.com/ruvnet/agent-harness-generator) — trading harness with paper-mode-default + circuit breakers + fractional-Kelly position sizing.

## What you get

5-agent pipeline:

| Agent | Tier | Role |
|---|---|---|
| `market-watcher` | Haiku | Polls market data; detects regime shifts |
| `signal-gen` | Sonnet | Generates BUY/SELL/HOLD signals from indicators |
| `risk-checker` | Codemod (deterministic) | Vets every signal against position-sizing + circuit-breaker state |
| `executor` | Codemod | Submits orders (or simulates in paper mode) |
| `postmortem` | Sonnet | Daily P&L review + blameless lessons-learned |

Safety defaults:

- **Paper mode unless `RUFLO_TRADE_CONFIRM=YES_LIVE`**
- Circuit breakers: daily P&L > -2%, < 5 consecutive losses, latency < 500ms
- Fractional-Kelly with 0.25 multiplier (never full Kelly)
- `mcp__broker__live_order*` denied by default

## Use

```bash
npx create-agent-harness my-trader --template-package @ruflo/vertical-trading
```

Or programmatically:

```js
import pack from '@ruflo/vertical-trading';
const { manifest, templateRoot } = await pack.load();
// Pass to your scaffolder.
```

## Risk disclosure

Trading carries risk. Past backtest performance does not predict future results. This pack ships defaults that minimize risk in paper mode — verify them yourself before going live. The author and the agent-harness-generator project are not responsible for any losses.

## License

MIT
