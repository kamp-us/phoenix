# @kampus/worker-relevance

The pure classifier for whether a PR's diff **can affect the `apps/web` worker**,
so CI's `changes` job can skip the slow real-D1 `integration` / `e2e` tiers for a
diff confined to packages the worker never imports (issue #1014).

## Why it exists

The `backend` / `e2e` path filters in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)
list `pnpm-lock.yaml` as a trigger, because a lockfile delta *can* bump a
worker-imported dependency's resolution and that genuinely needs integration.
`dorny/paths-filter` can't attribute a lockfile diff to a specific package, so it
conservatively runs the worker integration tier on **every** lockfile change — and
a packages-only PR (every `@kampus/pipeline-cli` reorg child, #994) edits the
lockfile, so it paid the worker-integration tier (and the #1010/#813 stage-leak
flake) despite touching nothing the worker runs. This classifier distinguishes a
lockfile delta confined to non-worker importer blocks from one that touches a
worker dependency, and decides whether the tiers can skip.

## Fail-safe to running

The load-bearing invariant: a **wrong skip is a missed worker regression**, so the
verdict is `irrelevant` (safe to skip) **only** when the whole diff is provably
confined to worker-irrelevant surfaces. Any non-package path, any worker-relevant
package, any lockfile change outside a non-worker importer block, any ambiguity or
parse failure ⇒ `relevant` (RUN). When unsure, run.

The worker's grounded in-repo import closure is exactly `{db-schema, fate-effect}`
(`apps/web`'s only `@kampus/*` deps, both leaves), plus `preview-seed` and
`moderator-grant` which own their **own** real-D1 integration tiers (ADR
[0082](../../.decisions/0082-two-test-tiers-unit-integration.md), #672/#930). A
change to any of those four is integration-relevant; everything else under
`packages/**` is dev-tooling the worker never imports.

## How it's used

The `changes` job passes the PR's changed-file list and the `pnpm-lock.yaml`
unified diff into the bin's env, then runs the classifier with no install:

```bash
node packages/worker-relevance/src/bin.ts
```

The bin prints the verdict + the triggering path (ADR 0092 §1 "emit what you
scanned") and emits the `relevant` / `irrelevant` decision the `changes` job reads
to gate the worker `integration` / `e2e` tiers.

## Architecture

A pure, unit-tested core + a thin Node bin (the repo tooling idiom), **zero
runtime dependencies** so the `changes` step runs it without `pnpm install`:

- `src/worker-relevance.ts` — the pure, IO-free core: `classify` over a
  `ClassifyInput` (changed files + lockfile diff), `parseChangedFiles`, the
  `INTEGRATION_RELEVANT_PACKAGES` set, and `inputFromEnv`. Same inputs ⇒ same
  verdict, no IO.
- `src/bin.ts` — the thin Node shell: read env, classify, print, emit the verdict.
- `src/index.ts` — the package's public exports.

```bash
pnpm --filter @kampus/worker-relevance test       # vitest over the pure core
pnpm --filter @kampus/worker-relevance typecheck
```
