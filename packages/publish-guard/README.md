# @kampus/publish-guard

The deterministic floor for **"which `@kampus/*` packages the kampus-pipeline
plugin consumes must be publishable"** (epic #803). The plugin's skills invoke
internal CLIs from npm (`@kampus/epic-ledger`, `@kampus/decisions-index`); if one
of those packages is `private` or lacks a public `publishConfig`, a release
*can't* publish it and the plugin breaks for anyone installing from the registry.
This package makes that risk a checkable, offline gate.

The required set is **derived, not hand-maintained** — scanning the skills tree
for `@kampus/*` references *is* the single source of truth, so a second manifest
can't drift out of sync with what the skills actually use (epic #803 Resolved
questions).

It is a `packages/` Effect CLI per the repo's Node-over-Python convention — a
pure, unit-tested core plus a thin `effect/unstable/cli` bin, **run from source**
(`node packages/publish-guard/src/bin.ts`) like `leak-guard` / `ci-required`.
`publish-guard` is itself **not published** (epic #803 Resolved questions).

## Shape

- **`src/required.ts`** — derive the consumed set. `extractKampusRefs(text)` is
  the pure matcher (every distinct `@kampus/<name>` slug in `text`);
  `requiredPackages(skillsDir)` walks the tree and folds every file's refs into
  one sorted, deduped set.
- **`src/drift.ts`** — the offline publishability check. `checkDrift(required,
  packages)` is pure over already-loaded manifests and returns a per-package
  verdict (`ok` / `private-but-required` / `missing-publishConfig` /
  `not-found`); `loadManifests` / `loadPackageManifest` are the thin IO that read
  `packages/<name>/package.json`. **Config only — no network**, so the PR gate
  that calls it can't flake.
- **`src/bin.ts`** — the `effect/unstable/cli` with two subcommands:
  - `list` — print the derived required-published set.
  - `check` — run `checkDrift`, print a per-package table, **exit non-zero on any
    drift**, exit `0` when clean.
- **`src/*.unit.test.ts`** + **`src/bin.check.test.ts`** — fixture-driven tests
  over a skill tree and synthetic `package.json`s covering each verdict variant
  and both bin exit-code paths.

## What "publishable" means

A required package passes only when **both** hold:

- `publishConfig.access` is `"public"`, and
- it is **not** `private: true`.

| verdict | meaning |
| --- | --- |
| `ok` | public + not private — publishable |
| `private-but-required` | the plugin needs it, but it's `private: true` |
| `missing-publishConfig` | no `publishConfig.access: "public"` |
| `not-found` | no `package.json` found under `packages/` |

## Scope

Offline/config-only by design (epic #803 Resolved questions): it checks the
config that governs whether a release *can* publish, not whether a version is
*already* on the registry — a network presence check belongs (if ever) in a
separate non-blocking informational check, never the merge gate.

Out of scope here: the CI workflow that runs `check` fail-closed on every PR
(sibling child #808) and the publish-workflow consolidation (sibling child #809).

## Commands

```bash
pnpm --filter @kampus/publish-guard typecheck
pnpm --filter @kampus/publish-guard test
node packages/publish-guard/src/bin.ts list    # the derived required set
node packages/publish-guard/src/bin.ts check   # exit non-zero on drift, 0 clean
```
