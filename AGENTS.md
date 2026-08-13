# Agent Instructions — pi-permission-gate

## Overview

Single-file pi extension. Classifies bash and MCP tool calls via `ctx.modelRegistry.complete()` before execution; blocks or confirms based on a 4-level risk taxonomy (safe/low/medium/high). CWD-aware: project-local ops are lower risk than system-wide.

## Development

- **No build step.** pi loads `.ts` via tsx at runtime. Do not add a compile step.
- **Self-contained.** No cross-imports; shared patterns are duplicated inline. Intentional — pi extensions are independently deployable.
- **Tests.** `npm test` runs `node --import tsx --test pi-permission-gate.test.mjs`. Behavioral tests on pure decisions (`decideFallback`, `decideThreshold`); source-shape guards on env-var plumbing and CWD-aware prompt content.
- **Config.** Env vars `PI_PERM_GATE_*` (env > settings.json `permissionGate` block > defaults).
- **Distribution.** Dual-source: `pi install npm:@johansja/pi-permission-gate` (gallery-listed) and `pi install git:github.com/johansja/pi-permission-gate` (pinned-ref). See `docs/adr/0001`, `docs/adr/0002`.
