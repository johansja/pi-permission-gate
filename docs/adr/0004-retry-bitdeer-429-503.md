# ADR 0004 — Gate-classifier retry: pass `maxRetries` into `complete()` (HTTP-layer, gate-local budget)

## Status
Accepted

## Context

The classifier model (`bitdeerai/deepseek-ai/DeepSeek-V4-Flash`) returns transient HTTP 429/503 during incidents. DeepSeek documents 429 with a `Retry-After` header and 503 with "≥30s delay" guidance. These arrive at the openai SDK as an `APIError` with `.status` + `.headers` — what pi-ai's `retryProviderRequest` catches and retries with `Retry-After`-honoring backoff.

The gate was not retrying these. Root cause is structural: extensions call `ctx.modelRegistry.complete()` → `ModelRuntime` directly, bypassing `Agent.streamFn` (the only site that injects `settings.retry.provider.maxRetries` into the call). `prepareRequest` forwards caller `options` verbatim with no settings injection; the provider API's `retryProviderRequest` defaults `maxRetries` to 0 without a provider-config fallback. So `settings.retry.provider.maxRetries` configures the agent's own chat turns and compaction, **not the gate** — adding it to `settings.json` alone is a no-op for the gate.

## Decision

**Path A — pass `maxRetries` + `maxRetryDelayMs` into `complete()`.** The extension reads two gate-local fields (`permissionGate.maxRetries` / `maxRetryDelayMs`, defaults 3 / 5000) and forwards them; `prepareRequest` passes them through to `retryProviderRequest`, which honors `Retry-After` and retries transient 429/5xx.

**Path B (message-level `retryAssistantCall`) declined.** It cannot see `Retry-After` headers (so cannot honor "retry after x seconds"; exponential-backoff-blind instead) and duplicates the HTTP layer. Add Path B only if a mid-stream SSE error (`stopReason:"error"` after a 200 OK) is observed — not described for 429/503 by the docs.

**Gate-local budget, not `settings.retry.provider`.** The gate is synchronous-per-tool-call: every bash/MCP command blocks on classification for the full retry sequence. Reusing the agent's chat-turn budget (3×30s tolerable for one response) stalls **every command** ~90s during an incident before `fallback`. Gate-local 3/5000 fails fast to `fallback=confirm`. Also decouples gate latency from chat-turn retry tuning.

**`maxRetryDelayMs` is a throw-ceiling, not a clamp.** `retryProviderRequest` throws (→ `fallback`) if the server requests a longer delay; it does not clamp-and-retry. A 30s request (DeepSeek 503 guidance) → immediate `fallback`. Exponential backoff (no header) is capped at 8s by pi-ai, independent of this field.

**429 and 503 are identical** — both retryable, both honor `Retry-After` the same way; no status-specific branch.

**`timeout` (default 60000) stays the global envelope.** Worst case under 3/5000: ~35s < 60s. No raise.

## Consequences

- **Config:** `permissionGate.maxRetries` (3) / `maxRetryDelayMs` (5000). No `settings.json` change required (defaults in code). `settings.retry.provider` does not affect the gate.
- **`fallback` governs post-exhaustion** (retries exhausted, timeout abort, or non-retryable like quota/billing).
- **Observability: final-outcome only** — `retryProviderRequest` gives no per-attempt callback; `errorDetail` records the last `errorMessage` on exhaustion.
- **`models.json` out of scope** — model metadata only; no retry knob the provider reads.
