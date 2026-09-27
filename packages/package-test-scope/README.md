# @kampus/package-test-scope

Decides which workspace packages CI's `packages unit tests` job runs for a diff, so a
change to one package stops paying for every other package's suite (issue #10023).

## What it is

A zero-runtime-dependency package in the repo tooling idiom: a pure, unit-tested core
plus a thin Node bin that CI's `changes` job runs without `pnpm install`.

- **`src/scope.ts`** is the core. `decideScope` maps the event, the diff base, the changed
  files and the workspace members to one `Scope`:
  - `scoped` with a non-empty package list: the changed packages, their transitive
    workspace dependents, and the packages in `CROSS_PACKAGE_READS` whose tests read a
    changed file through `fs`. The list keeps only tested packages under `packages/`
    plus `@kampus/infra`, the set the job has always run.
  - `full`: every package. It is the answer on any event other than `pull_request` or
    `merge_group`, with no diff base, with an unreadable diff, when a changed path is
    outside every workspace package, or when a member's `package.json` changed.
  - `none`: the diff changed nothing a tested package owns or depends on. The reason
    says what it did change.
- **`src/workspace.ts`** reads the member roots from `pnpm-workspace.yaml` and one
  member's manifest. Both throw on a shape they cannot read.
- **`src/bin.ts`** reads `GITHUB_EVENT_NAME`, `SCOPE_BASE` and the NUL-separated file list
  named by `CHANGED_FILES_FILE`, then writes `packages_scope`, `packages_selection`,
  `packages_scope_reason` and `tuval_sdk_proof` to `$GITHUB_OUTPUT`. Any read failure
  writes `full`.

## Why the fallbacks are wide

A wrong narrowing skips a suite that would have gone red, so every doubt runs everything.
Package tests read many files outside their own package, such as skills, decisions,
patterns and root config, and no manifest records those reads. So any changed path
outside a workspace package runs the full suite. Reads of another package's files, such
as the migrations under `apps/web`, are listed in `CROSS_PACKAGE_READS`. When the table
misses one, the full run on every `push` to `main` catches it within one merge.

## Usage

```sh
git diff --name-only --no-renames -z <base> HEAD > /tmp/files
GITHUB_EVENT_NAME=pull_request SCOPE_BASE=<base> CHANGED_FILES_FILE=/tmp/files \
  pnpm --filter @kampus/package-test-scope scope
pnpm --filter @kampus/package-test-scope test
```

With no `$GITHUB_OUTPUT` the bin prints the output lines instead.
