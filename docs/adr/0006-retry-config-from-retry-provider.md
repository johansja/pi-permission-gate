# ADR 0006 — Gate retry/timeout budget sourced from `retry.provider` (amends 0004)

## Status
Accepted — amends ADR 0004 (config source); ADR 0005's mechanism stands.

## Context

ADR 0004 gave the gate its own retry budget (`permissionGate.maxRetries`/`maxRetryDelayMs`, later joined by `timeout` in ADR 0005) on two grounds: (a) structural — extensions calling `ctx.modelRegistry.complete()` bypass `Agent.streamFn`, the only site injecting `settings.retry.provider.*`, so the pi-level settings were a no-op for the gate; (b) SLO decoupling — the gate is synchronous-per-tool-call, so it should fail fast rather than inherit a chat-turn budget.

Both grounds have weakened:

- (a) remains structurally true — `ModelRuntime` is constructed without a `SettingsManager` reference, so `complete()` cannot see the settings itself. But the extension can read them: `SettingsManager.getProviderRetrySettings()` is public and typed, and pi's own `streamFn` applies them as *fallback under caller options* (`options?.maxRetries ?? providerRetry.maxRetries`). The "no-op" finding described pi's injection, not an extension's ability to mirror it.
- (b) assumed chat and gate could want different budgets. In the target deployment they share a single provider (chat and classifier on one OpenAI-compatible endpoint), and the operator tunes provider resilience centrally — the same flakiness profile drives both. With one provider, two blocks holding the same three knobs (namesake duplication — same vocabulary, different facts) cost more in operator surprise ("why didn't my `retry.provider` change the gate?") than the decoupling buys.
- pi's own guidance warns against `retry.provider.maxRetries > 0` for chat in some quota scenarios, but the deployment's 429s are rate-limit-shaped, and provider retries now sit *under* the agent-level retry (`retry.maxRetries`), which already exists for chat.

## Decision

**Delete the gate-local retry knobs.** `permissionGate.maxRetries`, `permissionGate.maxRetryDelayMs`, and `permissionGate.timeout` are removed. The gate reads `SettingsManager.getProviderRetrySettings()` once per tool call and forwards `{timeoutMs, maxRetries, maxRetryDelayMs}` into `complete()`, dropping non-numeric values (settings.json is unvalidated input; a non-numeric `maxRetries` would stall `retryProviderRequest`'s attempt accounting indefinitely). Unset fields pass as `undefined` (pi-ai defaults: maxRetries → 0, timeoutMs → SDK default); the SettingsManager getter pre-applies maxRetryDelayMs → 60000. The code defaults 3/5000/10000 are deleted, which makes this a breaking change (see Consequences).

**Full consolidation, including timeout** — no gate-local override retained.

**Mechanism unchanged.** ADR 0005 stands: `retryProviderRequest` still owns both 429/5xx-retry (`Retry-After` honoring, `maxRetryDelayMs` throw-ceiling) and timeout-retry; `fallback` still governs post-exhaustion; no message-level retry. Only the *config source* moves.

**Agent-level `retry.*` (enabled/maxRetries/baseDelayMs) remains chat-only.** It wraps whole assistant turns; extensions cannot invoke it via `complete()`, and ADR 0004's decline of message-level retry stands.

**Legacy-key migration:** the three removed keys are silently ignored. Released as 0.7.0 with a README migration note.

## Consequences

- **Config:** `retry.provider.*` governs gate and chat alike — tuning one tunes both. The gate consumes it synchronously per tool call: `maxRetries × timeoutMs` bounds how long every command can stall during an incident before `fallback` fires.
- **Default-config users get fewer retries:** with no `retry.provider` block, the gate drops from 3 retries (old code default) to 0 (pi-ai default). Migration note tells users to set `retry.provider.maxRetries` explicitly.
- **Pacing is not configurable — recorded gap.** The provider-layer backoff is hardcoded in pi-ai (`min(0.5·2ⁿ, 8)`s); no settings block — pi's or the former gate-local one — exposes a provider-layer `baseDelayMs`. The agent-level `retry.baseDelayMs` paces chat turns only and is unreachable from `complete()`. The available levers for riding out an incident are `maxRetries` (more attempts) and `Retry-After` honoring (server-dictated waits).
- **Single-provider assumption.** The consolidation is sound because chat and classifier share one provider. `retry.provider` is global (not per-provider); if a second provider is introduced for either chat or the classifier, one global block can mistune the other — revisit this decision then.
- **Coupling accepted:** chat-turn retry tuning can now lengthen per-command gate stalls, and vice versa. This reverses ADR 0004's decoupling goal deliberately, for a single-config operator experience.
- **ADR 0004 preserved** except its "gate-local budget" decision and its claim that `settings.retry.provider` is permanently unreachable for the gate. The bypass finding (no pi-side injection into `complete()`), Retry-After layering, throw-ceiling semantics, and 429≡503 all stand.
