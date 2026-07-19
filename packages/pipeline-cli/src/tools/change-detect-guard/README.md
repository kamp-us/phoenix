# change-detect-guard

`pipeline-cli change-detect-guard check` — the mechanical enforcement that `ci.yml`'s
`changes` job runs **API-free git-mode** change detection (issue
[#3245](https://github.com/kamp-us/phoenix/issues/3245)).

## What it enforces

`ci.yml`'s `changes` (`detect changed areas`) job uses `dorny/paths-filter` to gate the
cost-bearing CI jobs. On a `pull_request` event dorny reads the changed-file set **two
ways**: it calls the GitHub REST API (`pulls.listFiles`) **whenever a `token` is set**, and
falls back to a pure `git diff` against `pull_request.base.sha` **only when the token is
empty** (grounded in dorny v3.0.2 `src/main.ts` — the PR-event branch of `getChangedFiles`:
`if (token) return getChangedFilesFromApi(...)`, else _"Github token is not available -
changes will be detected using git diff"_). dorny's `action.yml` **defaults** `token` to
`${{ github.token }}`, so an **absent** `token:` still selects API mode.

That live GitHub-API read is the **sole flake surface** of the change-detection step: a
transient GitHub-API-HTML blip served an error page where JSON was expected (`invalid
character '<'`), hard-failing the step → `produce run-evidence bundle` → the `ci-required`
aggregate went **RED on a defect-free docs-only PR** ([#3244](https://github.com/kamp-us/phoenix/pull/3244)).
`ci.yml` pins `token: ''` on the dorny step to force the API-free git path — removing the
read entirely so the transient **cannot** occur. This guard fails closed if that ever
regresses (an explicit non-empty token, or an absent `token:` falling back to the
`github.token` default), which would reopen the flake.

A genuine git/detection error still hard-fails the step (fail-closed) — only the API-HTML
transient is removed, never the real gate signal.

The core (`change-detect-guard.ts`) parses `ci.yml`, finds the `changes` job's
`dorny/paths-filter` step, and asserts its `with.token` is present and empty (git-mode).

Fail-closed on zero scope (ADR
[0092](../../../../../.decisions/0092-gates-fail-closed-on-zero-scope.md)): a missing file,
missing `changes` job or paths-filter step, or a missing `with:` block is a FAILURE — a
guard that could not locate the step to check is broken, never a vacuous pass.

## Usage

```bash
pipeline-cli change-detect-guard check              # the CI gate (exit non-zero on API mode / zero scope)
pipeline-cli change-detect-guard check --root <dir> # read ci.yml under a specific root (default: walk up for one)
```

Wired as the always-on `.github/workflows/change-detect-guard.yml` gate (the
`path-filter-guard` / `readme-guard` idiom). The pure core + IO seam live in
`change-detect-guard.ts` / `gate.ts`; the pure verdict is unit-tested in
`change-detect-guard.unit.test.ts`, the filesystem gate in `gate.unit.test.ts`.

```bash
pnpm --filter @kampus/pipeline-cli test    # vitest over the core + gate
```
