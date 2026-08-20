# Context — pi-permission-gate

## Glossary

### referenced-file expansion

The classifier may read files the command references before rating, via an LLM-driven `read_file` tool loop (not pre-inlining). The LLM decides whether/what to read; the extension executes reads in a bounded loop (≤ `PI_PERM_GATE_MAX_TOOL_ROUNDS`, default 3) and forces a final classify on cap-hit. `read_file` is extension-internal (text-only, CWD+HOME-bound, capped at `PI_PERM_GATE_SCRIPT_MAX_CHARS`, bypasses the gate), not pi's built-in `read` (unreachable from `ExtensionContext`; routing through the session pipeline would recurse the gate). Depth-1, prompt-instructed; deeper indirection falls to the "unseen → rate up" instruction. Any `isError` tool result triggers a code-side force-bump (factual signal, survives prompt drift). Tool-unsupported models gracefully fall back to single-shot command-string classify. Default on; `PI_PERM_GATE_SCRIPT_EXPANSION=off` disables. See ADR 0003.

### gate reasoning scope

`ctx.modelRegistry.complete()` calls made by extensions (this gate's classifier included) do **not** inherit the session's `defaultThinkingLevel` from `settings.json` — that field routes the agent-harness turn loop only. The gate's classifier call passes `{ maxTokens, temperature?, reasoning?, signal }`; `reasoning` is set only when `permissionGate.thinkingLevel` is configured, and is clamped to the model's supported levels by pi-ai's `clampThinkingLevel` at the provider layer. Unconfigured, the classifier model's intrinsic reasoning behavior runs, bounded only by `maxTokens` and the model's own `thinkingLevelMap`. Gate behavior is therefore determined by `permissionGate.model` (+ its provider-side `thinkingLevelMap`), `permissionGate.maxTokens`, and `permissionGate.thinkingLevel` — **not** by `defaultThinkingLevel`. Contrast: interactive chat turns DO honor `defaultThinkingLevel`.

### pi permission-gate approaches

The pi package ecosystem has multiple permission-gate packages. This package is positioned against the siblings by *approach*:

| Package | Approach |
|---|---|
| `pi-permission-gate` (juanjeojeda) | config-driven, glob matching, deny-by-default |
| `@diegopetrucci/pi-permission-gate` | prompt-on-dangerous, protected-file writes |
| `@johansja/pi-permission-gate` (this repo) | LLM-classified risk taxonomy, CWD-aware |

This package's differentiator: a fast LLM classifies each bash/MCP tool call by risk (safe/low/medium/high); CWD is passed so project-local ops score lower than system-wide. No regex/glob maintenance.

Risk taxonomy levels: see README (canonical home).

### gate-retry-bypass

`ctx.modelRegistry.complete()` — the call path extensions use — bypasses `Agent.streamFn` (the only site injecting `settings.retry.provider.maxRetries`); `ModelRuntime.prepareRequest` forwards caller `options` verbatim with no settings injection. So the gate must pass `maxRetries` explicitly into `complete()` to activate `retryProviderRequest` (HTTP-layer `Retry-After` honoring) for transient 429/5xx — `settings.retry.provider` alone is a no-op for the gate. Budget is gate-local (`permissionGate.maxRetries` / `maxRetryDelayMs`, defaults 3 / 5000), not the agent's chat-turn budget: the gate is synchronous-per-tool-call (every command blocks on classification), so reusing a 3×30s chat budget stalls every command ~90s during an incident — gate-local fails fast to `fallback` instead. `maxRetryDelayMs` is a throw-ceiling on server-requested `Retry-After` (throws → `fallback` if the server requests longer; not a clamp); 429 and 503 are treated identically. See ADR 0004.

## Decisions

- ADR 0001 — git-install distribution; peerDeps `*` for pi-bundled core; no build step.
- ADR 0002 — publish to npm as `@johansja/pi-permission-gate`; dual-source (npm + git); amends ADR 0001.
- ADR 0003 — LLM-driven referenced-file read loop (not pre-inlining); accepted CWD+HOME-bounded leak surface; deviation from single-shot pitch; tool-unsupported models fall back to single-shot.
- ADR 0004 — gate-classifier retry via `permissionGate.maxRetries`/`maxRetryDelayMs` passed into `complete()`, activating `retryProviderRequest` (HTTP-layer `Retry-After` honoring); gate-local budget (not `settings.retry.provider`) because the gate is synchronous-per-tool-call; `fallback` governs post-exhaustion; message-level `retryAssistantCall` declined (cannot see `Retry-After`, duplicates HTTP layer).
- Removed env-var config tier (`PI_PERM_GATE_*`); settings.json + defaults only. Fixes unvalidated `blockLevel`/`fallback` casts on the env path (the settings path already validated `blockLevel`; `fallback` validation added there too). Env tier had zero usage across the user's pi config, agent sources, shell configs, and history; keeping it was accidental layering against a hypothetical per-subagent-defaults feature.
- Added `permissionGate.thinkingLevel` setting; passed as `reasoning` to `ctx.modelRegistry.complete()`. Accepts `ModelThinkingLevel` ("off"…"max"); pi-ai's `clampThinkingLevel` clamps per-model at the provider layer — no static-list validation. No-op on models whose `thinkingLevelMap` floors every usable level to ≥"high" (bitdeerai DeepSeek-V4-Pro: low/medium/high → "high", xhigh/max → "max", no `off` entry). Future-proof for models/providers that honor lower levels.
- Default `maxTokens` raised 128 → 4096. Modern reasoning models don't fit a 128-token budget for one-shot JSON classification. User's settings.json keeps 16384 for V4-Pro.
