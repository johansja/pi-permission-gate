# ADR 0005 — Gate-classifier timeout-retry via `timeoutMs` (amends 0004)

## Status
Accepted — amends ADR 0004.

## Context

ADR 0004 made the gate pass `maxRetries`/`maxRetryDelayMs` into `complete()`, activating `retryProviderRequest` for transient HTTP 429/5xx. **Timeouts were not retried.** The extension enforced its own timeout via an `AbortController`+`setTimeout` envelope around `complete()`, and `retryProviderRequest` cannot retry an abort: on `signal.aborted` it throws `AbortError` immediately, and `isProviderError` rejects it (no `status`/`headers`). A 60s hang fired the envelope once → `fallback=confirm`, zero retries. User symptom (Aug 20 sessions): repeated `fallback=confirm` on full-duration hangs against `bitdeerai/deepseek-ai/DeepSeek-V4-Flash`.

Three facts unlock a simpler fix:

1. pi-ai accepts `timeoutMs` (`StreamOptions`, `types.d.ts:88`).
2. The openai-completions adapter (bitdeerai V4-Flash uses `api:"openai-completions"`) passes it to the SDK as `{ timeout }` (`api/openai-completions.js:136`).
3. The SDK throws `APIConnectionTimeoutError` on `timeout` expiry. `isProviderError` → true (`APIError` sets `status`/`headers` as own properties); `isRetryableProviderError` → `error.status === undefined` → returns **true**.

So ADR 0004's plumbing plus `timeoutMs` makes pi-ai own **both** timeout-retry (exp backoff) and 429/5xx-retry (`Retry-After` honoring + `maxRetryDelayMs` throw-ceiling) — one layer. The extension's envelope is the accidental complexity; `timeoutMs` is the essential mechanism that was there all along.

## Decision

Pass `timeoutMs` into `complete()` alongside ADR 0004's knobs. `retryProviderRequest` owns both retry classes:

- **Timeout** → `APIConnectionTimeoutError` (status=undefined → retryable) → exp backoff (0.5s/1s/2s, capped 8s).
- **429/503** → HTTP error (status set) → `Retry-After` honoring + `maxRetryDelayMs` throw-ceiling (ADR 0004, unchanged).

**Delete the extension's timeout envelope** — `AbortController`, `setTimeout`, `timedOut` flag, `onAbort` signal-forwarding, `finally` cleanup. Net code deletion (~25 lines in `classifyCommand`). `signal: ctx.signal` (user-cancel) goes straight into `complete()`; no wrapper.

**`timeout` semantics flip: whole-session envelope → per-attempt.** `permissionGate.timeout` (back-compat name) is forwarded as `timeoutMs`; pi-ai enforces it per SDK request, and `retryProviderRequest` issues a fresh request per retry.

**`maxRetries:3` = 4 attempts** (1 initial + 3 retries). Matches pi's `settings.retry.maxRetries` default. Under `timeoutMs:30000`: 4×30s + ~3.5s backoff ≈ **124s worst case**.

**Conscious override of ADR 0004's fail-fast rationale.** ADR 0004 rejected the 3×30s chat-turn stall (~90s/command) and chose gate-local fail-fast. This ADR reverses that: retry-through-transient-hangs preferred over fail-fast, ~124s worst case accepted. Rationale: repeated `fallback=confirm` on transient hangs is worse UX than a 124s stall on a persistent one. 429/5xx `Retry-After` honoring + `maxRetryDelayMs` throw-ceiling preserved — a long server-requested delay still fails fast to `fallback`.

**Empty-response retry declined.** `complete()` resolves successfully (`stopReason:"stop"`/`"end"`, no text) — no throw, `retryProviderRequest` can't see it. Re-adding an extension loop re-introduces deleted complexity for a class with weak evidence of transience. Add later if proven transient.

**`ctx.signal` (user-cancel) propagates naturally** via `retryProviderRequest`'s `abortableSleep` + `signal?.aborted` check.

## Consequences

- **Config:** `permissionGate.timeout` semantics = per-attempt. Code default 10000 (unchanged). **User should lower 60000→30000** — at 60000 the new design is ~244s worst case; at 30000 ~124s.
- **`fallback` governs post-exhaustion** (retries exhausted, non-retryable, or long `Retry-After`). Unchanged.
- **Error-detail surface** (verified by tracing, not assumed): timeout-exhaustion surfaces as a resolved response (`stopReason:"error"`, `errorMessage:"Request timed out."`) — path (b), not a thrown error. Self-identifies the failure class (timeout / HTTP / empty); no catch-block normalization needed. Both paths funnel to `decideFallback` → `fallback=confirm`.
- **Catch-block simplifies:** the `timedOut`/`signal?.aborted` rewrites are removed; thrown errors carry native messages to `errDetail`.
- **ADR 0004 preserved** except its fail-fast rationale + "timeout envelope" framing. Its `Retry-After` layering, `maxRetryDelayMs` throw-ceiling semantics, 429≡503, and `settings.retry.provider` no-op finding all stand.
- **Observability: final-outcome only** (ADR 0004 limitation) — no per-attempt callback from `retryProviderRequest`.
