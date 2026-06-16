---
id: 0076
title: "Distribute decisions-index by automated npm publish — drop `private`, publish public `@kampus/decisions-index` from a `.github/workflows/` release pipeline on a `decisions-index-v*` Release tag via OIDC Trusted Publishing, following ADR 0064's epic-ledger pattern. Uses `pnpm publish` (not `npm publish`) so `catalog:`/`workspace:` specifiers resolve into the tarball at pack time and the pnpm catalog stays the single source of truth — no dep pinning, no `npm install -g npm@latest` step. `pnpm/action-setup` pinned to 10.27.0 (pnpm 11 has a known OIDC 404 regression, pnpm#11513). The CLI operates on the local `.decisions/` filesystem so there is no repo-resolution / `CLAUDE_PIPELINE_REPO` logic. The workflow file is control-plane (ADR 0053) so the PR is human-merged. Human prereqs: the public `@kampus` npm org/scope + a one-time manual bootstrap publish + registering the repo/workflow as a Trusted Publisher"
status: accepted
date: 2026-06-16
tags: [plugin, pipeline, packaging, decisions-index, npm, ci, release]
---

# 0076 — Distribute decisions-index by automated npm publish

## Context

`@kampus/decisions-index` (`packages/decisions-index`) is the Effect CLI that derives
`.decisions/index.md` from the ADR files and gates a stale index / duplicate ADR id in CI
(ADR [0066](0066-decisions-index-derive-and-gate.md)). Today it is `private: true`,
`version: 0.0.0`, `exports: "./src/index.ts"` (it runs `.ts` directly), and its `effect` +
`@effect/platform-node` deps sit on the workspace `catalog:`.

ADR [0064](0064-epic-ledger-npm-publish-automated-release.md) made `@kampus/epic-ledger`
publishable and stood up its OIDC release pipeline. This ADR applies the **same treatment**
to `decisions-index`, with the corrections that pnpm's native trusted-publishing support
makes possible. The *why* of the mechanism — OIDC over a stored token, OIDC over staged
publishing, full automation after a one-time human bootstrap — is decided in 0064 and not
relitigated here; this ADR records the decisions-index-specific shape.

## Decision

### 1. Make the package publishable

`packages/decisions-index` drops `private: true`, sets `version: 0.1.0`, and points
`bin`/`main`/`module`/`types`/`exports` at `dist/` (compiled ESM JS), with `files: ["dist"]`,
`publishConfig.access: public`, and `license`/`repository` fields — mirroring epic-ledger. A
`build`/`prepublishOnly` script compiles `src/` → `dist/` via `tsc -p tsconfig.build.json`. The
package keeps its existing public name `@kampus/decisions-index` (no rename needed, unlike
epic-ledger's `@phoenix` → `@kampus` flip).

The package ships compiled JS, never raw `.ts`: Node refuses to strip types under
`node_modules`, so a source-only tarball is dead-on-arrival for a consumer. `dist/bin.js`
carries a `#!/usr/bin/env node` shebang so the published `bin` is executable.

### 2. `pnpm publish`, catalogs retained — no dep pinning

The publish step is **`pnpm publish --access public`** (run from the package dir), **not**
`npm publish`. pnpm resolves `catalog:` and `workspace:` specifiers into the published tarball
**at pack time**, so the runtime `dependencies` (`effect`, `@effect/platform-node`) stay
`"catalog:"` in the source `package.json` — the pnpm catalog remains the single source of truth
and there is **no dep pinning**. This is the key divergence from 0064, which pinned the catalog
deps to concrete versions because it published with `npm publish` (npm does not understand
`catalog:`).

Because pnpm has **native OIDC trusted-publishing support**, the `npm install -g npm@latest`
step that 0064's epic-ledger workflow needs (to get npm CLI ≥ 11.5.1) is **deleted** — it is
unnecessary with pnpm.

### 3. Release pipeline — OIDC, `decisions-index-v*` tag

A `.github/workflows/publish-decisions-index.yml` publishes the package on a published GitHub
Release whose tag matches `decisions-index-v*` (e.g. `decisions-index-v0.1.0`), mirroring
epic-ledger's `epic-ledger-v*` pattern. The package-scoped tag prefix keeps the workflow from
firing on unrelated tags. The workflow:

- authenticates via **OIDC Trusted Publishing** (`permissions: id-token: write`) — no
  `NPM_TOKEN` secret, provenance generated automatically;
- **pins `pnpm/action-setup` to `version: 10.27.0`** — **pnpm 11 must NOT be used**: it has a
  known OIDC trusted-publishing 404 regression (pnpm#11513);
- guards that the tag version matches `package.json`'s `version` (a mistagged release never
  publishes);
- typechecks, then builds `dist/` before publishing only this package.

### 4. No repo-resolution logic

The `decisions-index` CLI operates on the **local `.decisions/` filesystem** (`generate` writes
`.decisions/index.md`, `check` gates it). It has **no GitHub repo target**, so — unlike the
pipeline skills that resolve `$CLAUDE_PIPELINE_REPO` — there is **no repo-resolution logic** in
the package or the workflow.

## Consequences

- **The publish workflow is control-plane.** The `.github/workflows/` file lands under
  `.github/**` → **CONTROL-PLANE per ADR [0053](0053-control-plane-boundary.md)**. The PR that
  adds it is therefore **never auto-merged by `ship-it`** — a human merges it by hand, and
  `review-doc`/`review-code` are advisory on it. The package's own `package.json`/source changes
  (`packages/**`) stay non-blocking.
- **Catalogs retained — no pin drift.** Because `pnpm publish` resolves `catalog:` at pack time,
  the source keeps the catalog as the single source of truth; there is no second copy of the
  `effect` version to drift from the workspace. This is strictly better than 0064's pin-the-deps
  approach and is enabled solely by publishing with pnpm instead of npm.
- **One-time human bootstrap, then zero-touch** (same shape as 0064): create/confirm the public
  `@kampus` npm org, do a one-time manual bootstrap publish to bring `@kampus/decisions-index`
  into existence on the registry (trusted publishing requires the package to already exist), then
  register the repo/workflow as a Trusted Publisher for the package on npmjs.com. After that,
  every release is a `decisions-index-v<version>` tag away. Until the Trusted Publisher is
  registered, the OIDC publish step fails closed.
- **pnpm 11 is a footgun, pinned out.** The `version: 10.27.0` pin on `pnpm/action-setup` is
  load-bearing: pnpm 11's OIDC 404 regression (pnpm#11513) would break the publish, so the pin —
  and the comment recording why — must not be bumped to 11 without confirming the regression is
  fixed.
