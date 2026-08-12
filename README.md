# pi-permission-gate

LLM-powered safety gate for [pi](https://github.com/earendil-works/pi). Instead of maintaining regex patterns, a fast model judges each bash command and MCP tool call by risk level before execution — with CWD-aware context so project-local operations are treated as less risky than system-wide equivalents.

## Install

```bash
pi install git:github.com/johansja/pi-permission-gate
```

Try without installing:

```bash
pi -e git:github.com/johansja/pi-permission-gate
```

Update:

```bash
pi update --extensions
```

## How it works

Each `tool_call` for `bash` or `mcp` is classified by a fast/cheap model via `ctx.modelRegistry.complete()`. The model returns `{risk, reason}`. Risk is compared to your `blockLevel` threshold:

- **safe** — auto-allowed (read-only: `ls`, `cat`, `git status`, `git log`, …)
- **low** — reversible/CWD-scoped (`rm -rf ./build`, `npm install`, `git commit`, `git checkout`, …)
- **medium** — significant/external (`git push`, `kubectl apply`, `helm install`, `npm publish`, …)
- **high** — destructive/irreversible (`sudo`, `rm -rf /etc`, `DROP TABLE`, `git push --force`, `shutdown`, …)

At or above `blockLevel` → confirm via TUI prompt (or block in headless). Below → allow. `safe` is always allowed even at `blockLevel=safe` (carve-out prevents threshold-0 false blocks).

CWD is passed to the model so `rm -rf ./build` is `low` but `rm -rf /etc` is `high` — no post-hoc heuristics.

The runtime resolves auth and endpoints, so OAuth-only providers (Claude Pro/Max, ChatGPT Plus, Copilot) and env-scoped provider configs classify correctly, not just API-key providers.

## Configuration (precedence: env var > settings.json > default)

`~/.pi/agent/settings.json`:

```json
{
  "permissionGate": {
    "model": "anthropic/claude-sonnet-4-5",
    "blockLevel": "low",
    "maxTokens": 128,
    "temperature": 0,
    "timeout": 10000
  }
}
```

Environment variables override settings.json:

| Variable | Default | Description |
|---|---|---|
| `PI_PERM_GATE_MODEL` | session model | Model for classification (`provider/modelId` or bare id) |
| `PI_PERM_GATE_BLOCK_LEVEL` | `low` | Minimum risk to block: `low` \| `medium` \| `high` |
| `PI_PERM_GATE_TIMEOUT` | `10000` | LLM call timeout in ms |
| `PI_PERM_GATE_FALLBACK` | `confirm` | If LLM fails: `allow` \| `block` \| `confirm` |
| `PI_PERM_GATE_MAX_TOKENS` | `128` | Max tokens for the classification call |
| `PI_PERM_GATE_TEMPERATURE` | unset | Sampling temperature (e.g. `0` or `0.1`) |

### `blockLevel` semantics

| Level | Blocks | Allows |
|---|---|---|
| `low` | low, medium, high | safe (safest, most confirms) |
| `medium` | medium, high | safe, low |
| `high` | high | safe, low, medium (fewest confirms) |

### `fallback` semantics (LLM call failed)

| Policy | UI | Headless |
|---|---|---|
| `allow` | allow | allow |
| `block` | block | block |
| `confirm` | confirm (unknown risk) | **block** (headless can't prompt; fail-closed) |

Default `confirm` is safety-favoring: headless classifier-failures fail-closed, not fail-open.

## Logging

Decisions are appended to `~/.pi/pi-permission-gate.jsonl` (timestamp, command, risk, blockLevel, decision, reason; raw LLM response attached only on parse failure, capped at 2000 chars).

## Development

```bash
npm install
npm test
```

Tests cover the risk taxonomy, the fallback × hasUI decision matrix, the threshold safe-edge carve-out, and the hardened JSON verdict parser (reasoning models wrapping JSON in prose). No build step — pi loads `.ts` via tsx at runtime.

## License

MIT
