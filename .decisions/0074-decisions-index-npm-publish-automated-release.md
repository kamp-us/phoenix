---
id: 0074
title: "Distribute decisions-index by automated npm publish — make `@kampus/decisions-index` publishable (drop `private`, ship compiled `dist/`, concrete deps) and stand up a parallel OIDC release workflow on a package-scoped `decisions-index-v*` Release tag, mirroring ADR 0064. One-workflow-per-package, not a generalization; no repo-resolution (the CLI operates on the local `.decisions/` filesystem). The workflow file is control-plane (ADR 0053) so the PR is human-merged. Human prereq: register the repo/workflow as a Trusted Publisher for the package after a one-time bootstrap publish"
status: accepted
date: 2026-06-16
tags: [plugin, pipeline, packaging, decisions-index, npm, ci, release]
---

# 0074 — Distribute decisions-index by automated npm publish

## Context

`@kampus/decisions-index` (`packages/decisions-index`) is the Effect CLI that
generates `.decisions/index.md` from the ADR files and the CI `check` gate that fails
on a stale index or a duplicate ADR id (ADR [0066](0066-generate-decisions-index.md)).
The `/adr` skill calls it to regenerate the index instead of hand-appending a row. For
that skill to be portable into a foreign install — the same in-repo-first /
published-fallback shape `review-plan` uses for its `epic-ledger` gate — the package
must be **available on npm**.

Today the package is `private: true`, `version: 0.0.0`, `exports: "./src/index.ts"` (it
runs `.ts` directly), and its `effect` + `@effect/platform-node` deps sit on the
workspace `catalog:` — none of which is publishable. This ADR records making it
publishable and standing up its release pipeline, **mirroring** the already-shipped
epic-ledger treatment (ADR [0064](0064-epic-ledger-npm-publish-automated-release.md)).

## Decision

Apply the ADR 0064 mechanism to `decisions-index`, unchanged in shape:

### 1. Make the package publishable

`packages/decisions-index/package.json` drops `private: true`, sets a real `version`
(`0.1.0`), and adds `license`, `repository` (with `directory`), a `bin`
(`decisions-index` → `./dist/bin.js`), `main`/`module`/`types`/`exports` pointing at
`dist/`, `files: ["dist"]`, `publishConfig.access: "public"`, and a `build` +
`prepublishOnly` script (`tsc -p tsconfig.build.json`). The `catalog:` deps are pinned
to the concrete versions (`effect` / `@effect/platform-node` `4.0.0-beta.78`, matching
epic-ledger) so a published `package.json` resolves outside the workspace.

The package ships **compiled ESM JS** (`dist/`), never raw `.ts` — Node refuses to strip
types under `node_modules`, so a source-only tarball is dead-on-arrival for any consumer
(issue #405, the lesson the epic-ledger build step encodes). `tsconfig.build.json`
mirrors epic-ledger's: `composite:false`, `noEmit:false`, `rootDir: src`, `outDir:
dist`, declaration + maps, `rewriteRelativeImportExtensions` (so `./x.ts` imports emit as
`./x.js`), excluding tests.

### 2. Parallel OIDC release workflow on a package-scoped tag

`.github/workflows/publish-decisions-index.yml` is a **parallel** workflow to
`publish-epic-ledger.yml`, **not** a generalization of it. ADR 0064 deliberately chose
package-scoped tag prefixes precisely so each publishable package fires its own workflow
as the repo grows — one-workflow-per-package is the established convention.

- **Trigger:** a published GitHub Release whose tag matches **`decisions-index-v*`**
  (e.g. `decisions-index-v0.1.0`); the job gates on that tag prefix.
- **Version source:** `packages/decisions-index/package.json`'s `version`. A guard step
  strips the `decisions-index-v` prefix and fails the run if it disagrees with the
  `package.json` version, so a mistagged release never publishes.
- **Scope:** publishes **only** `packages/decisions-index`, from its own dir.
- **Auth — OIDC Trusted Publishing (no stored token).** `permissions: id-token: write`
  mints a short-lived per-run credential; no `NPM_TOKEN`. Trusted Publishing requires
  npm CLI ≥ 11.5.1 (upgraded explicitly), and **provenance is automatic** on a public
  repo — no `--provenance` flag (the flag broke non-CI publish; #398/#399).

### 3. No repo-resolution — the CLI operates on the local filesystem

Unlike `epic-ledger` (#408's `$CLAUDE_PIPELINE_REPO` repo-resolution work),
`decisions-index` has **no GitHub repo target** — it reads and writes the local
`.decisions/` filesystem. So this package needs **no** `$REPO`/`$CLAUDE_PIPELINE_REPO`
resolution; the only portability swap is in-repo-first vs published CLI invocation, owned
by the `/adr` skill cutover (the sibling child), not here.

## Consequences

- **The publish workflow is control-plane.** The `.github/workflows/` file lands under
  `.github/**` → CONTROL-PLANE per ADR [0053](0053-control-plane-boundary.md). This
  implementation PR is therefore **never auto-merged by `ship-it`** — a human merges it
  by hand, `review-doc`/`review-code` advisory. The `packages/**` changes stay
  non-blocking; only the workflow file forces the human merge.
- **Human prerequisites (an agent cannot do these).** The public `@kampus` npm scope
  already exists (from epic-ledger). Still required, one-time: a **bootstrap `npm
  publish` (with 2FA)** to bring `@kampus/decisions-index` into existence on the
  registry, then **register this repo + workflow as a Trusted Publisher** for the
  package on npmjs.com. Trusted publishing requires the package to already exist, so the
  first OIDC-automated release is the next bump after the bootstrap (e.g. bootstrap
  `0.1.0` → first automated `0.1.1`). Until the Trusted Publisher is configured, the
  workflow fails closed.
- **Version discipline.** As with epic-ledger (ADR 0064 §3), a change to the gate logic
  should bump `version` and cut a matching `decisions-index-v*` release so the published
  artifact tracks source; the version-match guard step is the backstop.
- **One source of truth.** The same package phoenix runs locally is the one a foreign
  `/adr` install pulls — no hand-rolled re-implementation, no parity-test burden.
