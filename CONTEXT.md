# Context — pi-permission-gate

## Glossary

### gate reasoning scope

`ctx.modelRegistry.complete()` calls made by extensions (this gate's classifier included) do **not** inherit the session's `defaultThinkingLevel` from `settings.json` — that field routes the agent-harness turn loop only. The classifier also sets no `reasoning` of its own: `complete()` routes to the provider's `stream`, which never reads `options.reasoning` (only `streamSimple` maps reasoning → `reasoningEffort` via `clampThinkingLevel`, and the extension-facing `ModelRegistry` does not expose it). The classifier therefore always runs the model's intrinsic reasoning behavior, bounded by `permissionGate.maxTokens`. Contrast: interactive chat turns DO honor `defaultThinkingLevel` (their streamFn is `streamSimple`).

### pi permission-gate approaches

The pi package ecosystem has multiple permission-gate packages. This package is positioned against the siblings by *approach*:

| Package | Approach |
|---|---|
| `pi-permission-gate` (juanjeojeda) | config-driven, glob matching, deny-by-default |
| `@diegopetrucci/pi-permission-gate` | prompt-on-dangerous, protected-file writes |
| `@johansja/pi-permission-gate` (this repo) | LLM-classified risk taxonomy, CWD-aware |

This package's differentiator: a fast LLM classifies each bash/MCP tool call by risk (safe/low/medium/high); CWD is passed so project-local ops score lower than system-wide. No regex/glob maintenance.

Risk taxonomy levels: see README (canonical home).

### gate retry budget

The gate's retry/timeout knobs (`timeoutMs`, `maxRetries`, `maxRetryDelayMs`) come from pi's `retry.provider` block — the same settings chat turns use — not from the `permissionGate` block. Pi cannot inject them itself: `ModelRuntime` is built without a `SettingsManager` reference, and the only pi-side injection site (`Agent.streamFn`) is bypassed by extension `ctx.modelRegistry.complete()` calls. So the gate *mirrors* the settings: it reads `SettingsManager.getProviderRetrySettings()` per tool call and forwards the values into `complete()`, where `retryProviderRequest` owns 429/5xx-retry (`Retry-After` honoring, `maxRetryDelayMs` throw-ceiling) and timeout-retry. Unset or non-numeric fields fall back to pi/pi-ai defaults (0 retries, 60000 ceiling, SDK timeout). Provider-layer backoff is hardcoded in pi-ai (`min(0.5·2ⁿ, 8)`s); agent-level `retry.*` (`baseDelayMs` etc.) paces whole chat turns only and is unreachable from `complete()`. Budget assumes a single provider: `retry.provider` is global, so chat and classifier tune identically — revisit if a second provider is added. See ADRs 0004–0006 (0006 reversed 0004's gate-local-budget decision).

### gate activity indicator

Footer status pill (single `setStatus` key `pi-permission-gate`) attributing in-flight time to the gate vs the tool, so a running tool render unambiguously means real execution. Grammar `🛡 gate: <phase>`. Two gate-owned phases marked: **classifying** (`🛡 gate: classifying…`) — set before classification in the tool_call handler, cleared in the classify try's `finally` on every outcome; both confirm dispatches live after that finally (a finally runs at `return` evaluation, not promise settlement — a catch-scoped dispatch would clobber the awaiting-input pill). **Confirm-wait** (`🛡 gate: {risk icon} awaiting input`; ⚪ on the fallback unknown-risk prompt). The `user-input:blocked` status payload carries the same string as the footer pill — one grammar across footer and transports. No elapsed-seconds ticker: the classify window is bounded by the `retry.provider` budget (`maxRetries × timeoutMs`), and seconds add no actionable signal over the static pill. Visual-only: no `pi.events` bus event parallels `user-input:blocked` for the classify phase; no settings opt-out.

## Decisions

- ADR 0001 — git-install distribution; peerDeps `*` for pi-bundled core; no build step.
- ADR 0002 — publish to npm as `@johansja/pi-permission-gate`; dual-source (npm + git); amends ADR 0001.
- ADR 0004 — gate-classifier retry via knobs passed into `complete()`, activating `retryProviderRequest` (HTTP-layer `Retry-After` honoring); `fallback` governs post-exhaustion; message-level `retryAssistantCall` declined (cannot see `Retry-After`, duplicates HTTP layer). (Its gate-local-budget decision was reversed by ADR 0006.)
- ADR 0005 — `timeoutMs` into `complete()`; `retryProviderRequest` owns timeout-retry too; deletes gate's `AbortController` envelope; `timeout` → per-attempt semantics; amends 0004.
- ADR 0006 — gate retry/timeout budget sourced from `retry.provider` (read via `getProviderRetrySettings()`, forwarded into `complete()`); gate-local `maxRetries`/`maxRetryDelayMs`/`timeout` keys deleted (silently ignored); breaking in 0.7.0. Amends ADR 0004's config source; ADR 0005's mechanism stands.
- Removed env-var config tier (`PI_PERM_GATE_*`); settings.json + defaults only. Fixes unvalidated `blockLevel`/`fallback` casts on the env path (the settings path already validated `blockLevel`; `fallback` validation added there too). Env tier had zero usage across the user's pi config, agent sources, shell configs, and history; keeping it was accidental layering against a hypothetical per-subagent-defaults feature.
- Removed never-functional `permissionGate.thinkingLevel`: `complete()` routes to the provider's `stream`, which silently drops `options.reasoning`; `streamSimple` (the only path mapping it, via `clampThinkingLevel`) is not exposed on the extension-facing `ModelRegistry`. Classifier always runs the model's intrinsic reasoning. Restoring configurable reasoning needs pi to expose `completeSimple`.
- Default `maxTokens` raised 128 → 4096. Modern reasoning models don't fit a 128-token budget for one-shot JSON classification. User's settings.json keeps 16384 for V4-Pro.
