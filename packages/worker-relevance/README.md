# @kampus/worker-relevance

The pure classifier for whether a PR's diff **can affect the `apps/web` worker**,
so CI's `changes` job can skip the slow real-D1 `integration` / `e2e` tiers for a
diff confined to packages the worker never imports (issue #1014).

## What it is

A zero-runtime-dependency package in the repo tooling idiom — a pure, unit-tested
core plus a thin Node bin the CI step runs without `pnpm install`:

- **`src/worker-relevance.ts`** — the pure, IO-free core. `classify` maps a
  `ClassifyInput` (changed files + lockfile-changed flag + lockfile unified diff +
  the test-import closure) to a `ClassifyResult` (`verdict` + `trigger` +
  `reason`); same inputs ⇒ same verdict. Also exported: `parseChangedFiles`
  (NUL/newline-separated path list → array), `extractKampusPackages` (every
  `@kampus/<name>` specifier in TS/JS text, deliberately over-inclusive),
  `parseTestImportedPackages`, `inputFromEnv` (the CI step's `env:` →
  `ClassifyInput`), the `INTEGRATION_RELEVANT_PACKAGES` set, and the `LOCKFILE`
  constant.
- **`src/bin.ts`** — the IO shell ci.yml runs. It walks
  `apps/web/tests/integration/` and `apps/web/tests/e2e/`, computes the
  test-import closure from the real imports it finds, reads
  `CHANGED_FILES` / `LOCKFILE_DIFF` from the environment, classifies, prints what
  it scanned plus the verdict reason, and emits `worker_relevant=true|false` to
  `$GITHUB_OUTPUT`. Exits 0 always — a classifier, not a gate.
- **`src/index.ts`** — the public barrel re-exporting the core above.

## Why it exists

The `backend` / `e2e` path filters in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)
list `pnpm-lock.yaml` as a trigger, because a lockfile delta *can* bump a
worker-imported dependency's resolution and that genuinely needs integration.
`dorny/paths-filter` can't attribute a lockfile diff to a specific package, so it
conservatively runs the worker integration tier on **every** lockfile change — and
a packages-only PR (every tooling-package reorg child, #994) edits the
lockfile, so it paid the worker-integration tier (and the #1010/#813 stage-leak
flake) despite touching nothing the worker runs. This classifier distinguishes a
lockfile delta confined to non-worker importer blocks from one that touches a
worker dependency, and decides whether the tiers can skip.

**Fail-safe to running** — the load-bearing invariant: a wrong skip is a missed
worker regression, so the verdict is `irrelevant` (safe to skip) **only** when the
whole diff is provably confined to worker-irrelevant surfaces. Any non-package
path, any relevant package, any lockfile change outside an irrelevant importer
block, any ambiguity or parse failure ⇒ `relevant` (RUN). When unsure, run.

**Two closures — worker-import ∪ test-import** ([ADR 0114](../../.decisions/0114-test-import-closure-gates-test-consumed-packages.md)).
The relevance verdict unions:

1. **The worker-import closure** — the fixed three-package
   `INTEGRATION_RELEVANT_PACKAGES` set: `{db-schema, fate-effect}` (the worker's
   in-repo `@kampus/*` import closure) plus `preview-seed`, which owns its **own**
   real-D1 integration tier ([ADR 0082](../../.decisions/0082-two-test-tiers-unit-integration.md),
   #672).
2. **The test-import closure** — the `packages/**` members imported under
   `apps/web/tests/integration/**` and `apps/web/tests/e2e/**`, **computed from
   the real imports** in those trees on every run (not a maintained list).

A `packages/<name>` change is integration-relevant iff `<name>` is in **either**
closure. This closes the hole ADR 0114 records: a package the **worker** never
imports but an integration test **does** (e.g. `founder-seed`, imported by
`apps/web/tests/integration/kunye-moderate-seam.test.ts`) used to classify
`irrelevant` and skip the integration tier on the very PR that broke it — the
#1352 → #1378/#1380 → #1383 incident chain. Because the closure comes off the
actual `import` graph, a newly test-imported package joins the relevant set the
instant a test imports it, with no list to maintain and no silent-drift window.
Per the invariant, a **scan failure** resolves to `relevant` (RUN) — an
unprovable test-import closure never yields a silent skip (a missing tree is not
a failure: a repo with no e2e tree scans to empty).

**Scope:** this package decides *skip-or-run* for the worker `integration`/`e2e`
tiers and nothing else. It never fails a build (the bin exits 0 always) and owns
no freshness gate over itself — the drift-guard question lives with #2627.

## How to use it

In CI (the only production consumer), the `changes` job's classify step exports
`CHANGED_FILES` and `LOCKFILE_DIFF` into the environment and runs the bin with no
install:

```bash
node packages/worker-relevance/src/bin.ts
```

The bin prints the computed test-import closure and the verdict reason (ADR 0092
§1 "emit what you scanned"), then emits the `worker_relevant=true|false` line the
job's gating expressions read. Locally, the same shell is the package's
`classify` script:

```bash
pnpm --filter @kampus/worker-relevance classify
```

Programmatically, import the pure core from the package root:

```ts
import {classify, type ClassifyInput} from "@kampus/worker-relevance";

const result = classify({
	changedFiles: ["packages/composer/src/x.ts"],
	lockfileChanged: false,
	lockfileDiff: "",
}); // ⇒ { verdict: "irrelevant", trigger: null, reason: "irrelevant — …" }
```

## Reference

Environment variables the bin reads (via `inputFromEnv`; all optional — absent
inputs are empty):

| Variable | Content |
| --- | --- |
| `CHANGED_FILES` | Changed paths, base...head, repo-root-relative, newline/NUL-separated |
| `LOCKFILE_DIFF` | `git diff base...head -- pnpm-lock.yaml`; consulted only when the lockfile changed |
| `TEST_IMPORTED_PACKAGES` | Pre-computed test-import closure override; normally unset — the bin computes it by scanning the test trees |

Fail-safe rules (each row is `relevant` unless provably otherwise):

| Input | Verdict |
| --- | --- |
| Any changed path outside `packages/<irrelevant>/` | `relevant` |
| Lockfile hunk outside an irrelevant package's `importers:` block, or an unreadable diff | `relevant` |
| Test-tree scan throws | `relevant` (bin short-circuits before classifying) |
| Whole diff confined to irrelevant packages and their lockfile importer blocks | `irrelevant` |

Public exports: `classify`, `parseChangedFiles`, `parseTestImportedPackages`,
`extractKampusPackages`, `inputFromEnv`, `INTEGRATION_RELEVANT_PACKAGES`,
`LOCKFILE`, and the `Verdict` / `ClassifyInput` / `ClassifyResult` types.

## Testing

```bash
pnpm --filter @kampus/worker-relevance test       # vitest over the pure core
pnpm --filter @kampus/worker-relevance typecheck
```
