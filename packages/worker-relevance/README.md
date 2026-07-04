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
`packages/**` is dev-tooling the worker never imports — **unless an integration/e2e
test imports it** (see below).

## Two closures — worker-import ∪ test-import (ADR 0114)

The relevance verdict is the **union of two closures**, not one:

1. **The worker-import closure** — the fixed four packages above
   (`INTEGRATION_RELEVANT_PACKAGES`) the worker imports (or that own their own
   real-D1 tier).
2. **The test-import closure** — the `packages/**` members imported under
   `apps/web/tests/integration/**` and `apps/web/tests/e2e/**`, **computed from the
   real imports** in those trees on every run (not a maintained list).

A `packages/<name>` change is integration-relevant iff `<name>` is in **either**
closure. This closes the hole ADR
[0114](../../.decisions/0114-test-import-closure-gates-test-consumed-packages.md)
records: a package the **worker** never imports but an integration test **does**
(e.g. `founder-seed`, imported by `apps/web/tests/integration/kunye-moderate-seam.test.ts`)
used to classify `irrelevant` and skip the integration tier on the very PR that broke
it — the #1352 → #1378/#1380 → #1383 incident chain. Because the test-import closure
is computed from the actual `import`/`require` graph, a newly test-imported package
joins the relevant set the instant a test imports it, with **no list to maintain and
no silent-drift window** — the drift that was the root cause of #1352 is structurally
removed.

The scan is the **bin's** job (it walks the two test trees, extracts `@kampus/*`
specifiers, and resolves each to a real `packages/**` workspace member); the pure
core takes the computed closure as `ClassifyInput.testImportedPackages` and unions it
into both the changed-path check and the lockfile importer-block attribution. Per the
fail-safe-to-running invariant, a **scan failure** resolves to `relevant` (RUN) — an
unprovable test-import closure never yields a silent skip.

## How it's used

The `changes` job passes the PR's changed-file list and the `pnpm-lock.yaml`
unified diff into the bin's env, then runs the classifier with no install:

```bash
node packages/worker-relevance/src/bin.ts
```

The bin computes the test-import closure off the checked-out test trees, prints the
verdict + the triggering path (ADR 0092 §1 "emit what you scanned"), and emits the
`relevant` / `irrelevant` decision the `changes` job reads to gate the worker
`integration` / `e2e` tiers. No `ci.yml` change is needed — the bin reads the trees
directly, so the closure stays in lockstep with the real imports.

## Architecture

A pure, unit-tested core + a thin Node bin (the repo tooling idiom), **zero
runtime dependencies** so the `changes` step runs it without `pnpm install`:

- `src/worker-relevance.ts` — the pure, IO-free core: `classify` over a
  `ClassifyInput` (changed files + lockfile diff + the test-import closure),
  `parseChangedFiles`, the `INTEGRATION_RELEVANT_PACKAGES` set, the pure import
  extractor `extractKampusPackages`, and `inputFromEnv`. Same inputs ⇒ same verdict,
  no IO.
- `src/bin.ts` — the thin Node shell: walk the test trees to compute the test-import
  closure, read env, classify, print, emit the verdict (fail-safe to running on a
  scan error).
- `src/index.ts` — the package's public exports.

```bash
pnpm --filter @kampus/worker-relevance test       # vitest over the pure core
pnpm --filter @kampus/worker-relevance typecheck
```
