# Context — pi-permission-gate

## Glossary

### referenced-file expansion

The classifier may read files the command references before rating, via an LLM-driven `read_file` tool loop (not pre-inlining). The LLM decides whether/what to read; the extension executes reads in a bounded loop (≤ `PI_PERM_GATE_MAX_TOOL_ROUNDS`, default 3) and forces a final classify on cap-hit. `read_file` is extension-internal (text-only, CWD+HOME-bound, capped at `PI_PERM_GATE_SCRIPT_MAX_CHARS`, bypasses the gate), not pi's built-in `read` (unreachable from `ExtensionContext`; routing through the session pipeline would recurse the gate). Depth-1, prompt-instructed; deeper indirection falls to the "unseen → rate up" instruction. Any `isError` tool result triggers a code-side force-bump (factual signal, survives prompt drift). Tool-unsupported models gracefully fall back to single-shot command-string classify. Default on; `PI_PERM_GATE_SCRIPT_EXPANSION=off` disables. See ADR 0003.

### pi permission-gate approaches

The pi package ecosystem has multiple permission-gate packages. This package is positioned against the siblings by *approach*:

| Package | Approach |
|---|---|
| `pi-permission-gate` (juanjeojeda) | config-driven, glob matching, deny-by-default |
| `@diegopetrucci/pi-permission-gate` | prompt-on-dangerous, protected-file writes |
| `@johansja/pi-permission-gate` (this repo) | LLM-classified risk taxonomy, CWD-aware |

This package's differentiator: a fast LLM classifies each bash/MCP tool call by risk (safe/low/medium/high); CWD is passed so project-local ops score lower than system-wide. No regex/glob maintenance.

Risk taxonomy levels: see README (canonical home).

## Decisions

- ADR 0001 — git-install distribution; peerDeps `*` for pi-bundled core; no build step.
- ADR 0002 — publish to npm as `@johansja/pi-permission-gate`; dual-source (npm + git); amends ADR 0001.
- ADR 0003 — LLM-driven referenced-file read loop (not pre-inlining); accepted CWD+HOME-bounded leak surface; deviation from single-shot pitch; tool-unsupported models fall back to single-shot.
