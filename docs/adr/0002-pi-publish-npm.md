# ADR 0002 — Publish to npm (reverse ADR 0001's "npm deferred")

## Status
Accepted — amends ADR 0001.

## Context

ADR 0001 deferred npm publication: "npm adds gallery discovery + semver ceremony with no current payoff for a single-author single-file package."

The goal changed: the package must appear in the [pi.dev/packages](https://pi.dev/packages) gallery. The gallery is npm-backed — it lists packages published to npm with the `pi-package` keyword (verified from `packages.md` and the gallery page: "…published to npm. Install with `pi install npm:<package>`"). Git-only packages are invisible to it. Gallery listing was the deferred payoff ADR 0001 set aside.

The bare name `pi-permission-gate` is taken on npm by an active, unrelated package (v0.1.5, config-driven glob-matching permission gate). Publishing under that name is impossible.

## Decision

**Dual-source distribution.** Publish to npm under `@johansja/pi-permission-gate`; keep the `pi install git:…` line. npm and git are independent sources; both remain valid install paths. npm is required for gallery listing; git stays for pinned-ref installs and contributors.

**Scoped name.** `@johansja/pi-permission-gate` (not bare). Bare name taken; scope preserves author identity and the `permission-gate` category word while disambiguating from the sibling package. Trade-off accepted: the name does not signal the LLM-classification approach — the description and `keywords` (`llm`, `permission-gate`, `safety`) carry that.

**Recurring versioning cost accepted.** This is the price ADR 0001 named. Manual `npm publish` on tag for now; no release CI unless a second package or a slipping cadence justifies it.

**No change to:** self-contained/no-build, peerDeps `*` for pi-bundled core, `files`-minimal tarball, single-file principle (ADR 0001).

## Consequences

- Gallery-listed once published: appears at pi.dev/packages.
- Install commands: `pi install npm:@johansja/pi-permission-gate` (gallery) or `pi install git:github.com/johansja/pi-permission-gate` (contributor/pinned-ref).
- Release checklist: bump `version`, `git tag vX.Y.Z`, `npm pack --dry-run` (verify tarball = `.ts`/README/LICENSE only), `npm publish`.
- Preview asset (`pi.image`) deferred to a follow-up patch — v0.1.0 ships with gallery-card metadata (`repository`, `author`) minus the preview.
- Future rename is expensive (npm unpublish windows are short; the old name becomes a permanent stub). Name chosen accordingly.
