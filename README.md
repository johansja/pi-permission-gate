# pi-permission-gate

LLM-powered safety gate for [pi](https://github.com/earendil-works/pi). Instead of maintaining regex patterns, a fast model judges each bash command and MCP tool call by risk level before execution — with CWD-aware context so project-local operations are treated as less risky than system-wide equivalents.

## Install

```bash
pi install npm:@johansja/pi-permission-gate
```

Or from git (pinned-ref friendly):

```bash
pi install git:github.com/johansja/pi-permission-gate
```

Try without installing:

```bash
pi -e npm:@johansja/pi-permission-gate
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

## Configuration (precedence: settings.json > default)

`~/.pi/agent/settings.json`:

```json
{
  "permissionGate": {
    "model": "anthropic/claude-sonnet-4-5",
    "blockLevel": "low",
    "maxTokens": 4096,
    "temperature": 0
  }
}
```

| Field | Default | Description |
|---|---|---|
| `model` | session model | Model for classification (`provider/modelId` or bare id) |
| `blockLevel` | `low` | Minimum risk to block: `low` \| `medium` \| `high` |
| `fallback` | `confirm` | If LLM fails: `allow` \| `block` \| `confirm` |
| `maxTokens` | `4096` | Max tokens for the classification call |
| `temperature` | unset | Sampling temperature (e.g. `0` or `0.1`) |
| `reasoningEffort` | unset | Reasoning effort for the classifier: `minimal`\|`low`\|`medium`\|`high`\|`xhigh`\|`max`, mapped through the model's thinkingLevelMap. Always-thinking models like Kimi-K3 default to **max** server-side, so set `"low"` for fast gates |

### Retry and timeout (`retry.provider`)

The gate's retry/timeout budget comes from pi's own `retry.provider` block — the same config that governs chat turns — read once per tool call and forwarded into `complete()`. See [ADR 0006](docs/adr/0006-retry-config-from-retry-provider.md) (amends [0004](docs/adr/0004-retry-bitdeer-429-503.md)/[0005](docs/adr/0005-timeout-retry-via-timeoutMs.md)).

```json
{
  "retry": {
    "provider": {
      "maxRetries": 5
    }
  }
}
```

| `retry.provider` field | Default | Description |
|---|---|---|
| `maxRetries` | `0` | Retries on transient HTTP 429/5xx **and** per-attempt timeout. Note the default: with no `retry.provider` block the gate makes a single attempt, then `fallback` applies. |
| `maxRetryDelayMs` | `60000` | Ceiling on server-requested `Retry-After`. If the server requests a longer delay, `retryProviderRequest` **throws** (→ `fallback`) — it does **not** clamp-and-retry. Exponential backoff (no `Retry-After` header) is hardcoded by pi-ai (`min(0.5·2ⁿ, 8)`s), independent of this field. 429 and 503 are treated identically. |
| `timeoutMs` | SDK default | Per-attempt timeout in ms. Timeout is retried alongside 429/5xx; not a whole-session envelope. See [ADR 0005](docs/adr/0005-timeout-retry-via-timeoutMs.md). |

The budget is shared with chat turns — tuning it for one tunes both. Note the gate consumes it synchronously per tool call: a large `maxRetries × timeoutMs` product delays every command during a provider incident before `fallback` fires.

Agent-level `retry.*` (`enabled`/`maxRetries`/`baseDelayMs`) does **not** apply to the gate: it wraps whole chat turns in pi's agent loop, which extension `complete()` calls never enter.

**Migrating from <0.7.0:** `permissionGate.maxRetries`, `permissionGate.maxRetryDelayMs`, and `permissionGate.timeout` were removed and are silently ignored (previously defaulted to 3, 5000, and 10000). `permissionGate.thinkingLevel` was also removed — it never reached the model (`ctx.modelRegistry.complete()` routes to the provider's `stream`, which drops `reasoning`; the clamping `streamSimple` path is not exposed to extensions), and the classifier always runs the model's intrinsic reasoning. Move `maxRetries` to `retry.provider.maxRetries` — set it explicitly if you want any retries, since the pi default is `0` — and `maxRetryDelayMs`/`timeoutMs` likewise if you don't want the pi/SDK defaults.

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
