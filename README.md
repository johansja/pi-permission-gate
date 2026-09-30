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

Each `tool_call` for `bash`, for built-in MCP tools (names like `mcp__<server>__<tool>`, called directly or from codemode scripts), or for the legacy gateway `mcp` tool (pi-mcp-adapter installs) is classified by a fast/cheap model via `ctx.modelRegistry.complete()`. The model returns `{risk, reason}`. Risk is compared to your `blockLevel` threshold:

- **safe** — auto-allowed (read-only: `ls`, `cat`, `git status`, `git log`, …)
- **low** — reversible/CWD-scoped (`rm -rf ./build`, `npm install`, `git commit`, `git checkout`, …)
- **medium** — significant/external (`git push`, `kubectl apply`, `helm install`, `npm publish`, …) or credential disclosure — exposing live secrets into the transcript (`cat ~/.ssh/id_rsa`, `cat .env`, literal tokens in the command text) or shipping file contents off-host (`curl --post-file …`)
- **high** — destructive/irreversible (`sudo`, `rm -rf /etc`, `DROP TABLE`, `git push --force`, `shutdown`, …)

At or above `blockLevel` → confirm via TUI prompt (or block in headless). Below → allow. `safe` is always allowed even at `blockLevel=safe` (carve-out prevents threshold-0 false blocks).

CWD is passed to the model so `rm -rf ./build` is `low` but `rm -rf /etc` is `high` — no post-hoc heuristics.

Credential disclosure draws a **use vs leak** line: in-place use at the credential's own service or established infrastructure (`kubectl`, `aws` CLI) and config-metadata reads stay `low` — sending credential values to unrelated hosts, or leaking them into the transcript, gets a checkpoint.

Identical commands in the same pi process reuse the cached verdict (keyed on CWD + command). The cache stores the classifier's opinion, never a permission — threshold logic re-applies per call. Parse-failure and empty-response verdicts are never cached. Denying a confirm keeps the entry: the denied command re-prompts deterministically, instead of paying a fresh classify that could sample below threshold and slip through silently.

## How this differs from Claude Code's auto mode

Same mechanism (a model classifier reviews actions before execution), different product:

- **Human-in-the-loop by default.** Auto mode *replaces* the human — its classifier allows or blocks autonomously, and you re-enter only after repeated blocks. This gate *triages*: safe/low run silently, medium/high confirm with you.
- **It adds a checkpoint where none exists.** pi executes everything natively — no permission popups, no sandbox. Claude Code ships modes, allow/deny rules, hooks, and a sandbox; auto mode is one layer among many there. Here, this gate is the layer.
- **Any classifier model.** `permissionGate.model` accepts any provider — including OAuth-only ones (Claude Pro/Max, ChatGPT Plus, Copilot) and env-scoped configs; the runtime resolves auth and endpoints. Auto mode's classifier is Anthropic-controlled.

**What it deliberately does not do:** it judges the command, not the agent's intent — it does not read the conversation, so it cannot catch prompt-injection-driven actions that are neither destructive, secret-exposing, nor MCP writes. That residual risk is accepted; pi's own security model treats prompt injection as inherent local-agent risk. Also inherent to the design: classifying sends the full command text — including any literal secrets — to the classifier provider, and the decision log stores commands locally.

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

The gate's retry/timeout budget comes from pi's own `retry.provider` block — the same config that governs chat turns — read once per tool call and forwarded into `complete()`. See [ADR 0006](docs/adr/0006-retry-config-from-retry-provider.md) (amends [0004](docs/adr/0004-retry-classifier-429-503.md)/[0005](docs/adr/0005-timeout-retry-via-timeoutMs.md)).

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

## Troubleshooting

**Parse-failure storms** (`Could not parse LLM verdict` on most commands): the classifier model must answer with the exact JSON verdict; the log (see Logging below) attaches the raw response on parse failures so you can see what the model actually returned.

Common cause: the gateway, not the model. pi-ai sends reasoning models' system prompts as `role: "developer"` on providers it doesn't recognize, and some OpenAI-compatible gateways only honor prompt contracts as `role: "system"` (observed on DeepSeek/GLM chat templates; Kimi-K3 complies under either role). The model then ignores the JSON instruction and answers with markdown analysis. The fix lives in your model config (`~/.pi/agent/models.json`), not gate-side:

```json
{
  "providers": {
    "your-gateway": {
      "models": [
        {
          "id": "your-model",
          "compat": { "supportsDeveloperRole": false }
        }
      ]
    }
  }
}
```

Also worth checking: `maxTokens` too small for a reasoning model's thinking budget (empty or truncated verdicts — the log shows `finish=length` details), and transient 429/503s (configure `retry.provider.maxRetries`, see above).

## Development

```bash
npm install
npm test
```

Tests cover the risk taxonomy, the fallback × hasUI decision matrix, the threshold safe-edge carve-out, and the hardened JSON verdict parser (reasoning models wrapping JSON in prose). No build step — pi loads `.ts` via tsx at runtime.

## License

MIT
