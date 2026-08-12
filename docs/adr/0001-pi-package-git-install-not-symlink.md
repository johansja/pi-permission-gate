# ADR 0001 — Pi package (git-install), not symlink or npm-publish

## Status
Accepted

## Context

`pi-permission-gate` was deployed from a personal config repo by symlinking the `.ts` into `~/.pi/agent/extensions/`. That model is friction for external users: clone a personal repo, symlink one file, no upgrade path.

pi ships a package system (`pi install git:…` / `npm:…`) handling install, upgrade (`pi update --extensions`), and dedup. Adopting it removes the symlink step.

## Decision

**git-install first; npm-publish deferred.** Distribute via `pi install git:github.com/johansja/pi-permission-gate`. npm adds gallery discovery + semver ceremony with no current payoff for a single-author single-file package. Upgrade path from git to npm is trivial.

**pi-bundled core as `peerDependencies: "*"`.** `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` are pi-bundled; per [packages.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) declare them as `peerDependencies: "*"` and do not bundle. pi loads packages with separate module roots — bundling duplicates the runtime and breaks isolation. (`pi-mcp-adapter` lists `@earendil-works/pi-ai` under `dependencies`; this package follows the docs, not that deviation.)

**Test harness via local devDeps.** `npm install` resolves pi into local `node_modules`; tests run via `node --import tsx --test` with plain ESM imports — no `npm root -g`/`PI_ROOT`/jiti discovery, no global-pi prerequisite.

## Consequences

- Install is `pi install git:…`, not `ln -sf`.
- `pi update --extensions` reconciles to the latest ref.
- `npm install` + `npm test` work for any contributor without global pi.
- npm-publish is a one-step future upgrade.
