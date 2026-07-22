# path-filter-guard

`pipeline-cli path-filter-guard check` — the mechanical enforcement of the
ci.yml/deploy.yml path-filter **sync invariant** (issue
[#2372](https://github.com/kamp-us/phoenix/issues/2372); the invariant landed in issue
[#2366](https://github.com/kamp-us/phoenix/issues/2366) / PR
[#2371](https://github.com/kamp-us/phoenix/pull/2371)).

## What it enforces

`deploy.yml`'s `changes.deploy` dorny/paths-filter list and `ci.yml`'s `changes.e2e`
dorny/paths-filter list must be the **same set** of glob entries. This pins the
load-bearing invariant **deploy's RUN-set ⊇ e2e's RUN-set** — deploy skips a preview
only where e2e also skips. `ci.yml`'s `e2e` job polls `deploy.yml`'s sticky
`<!-- preview-deploy -->` comment on a 10-minute deadline, so a PR that trips e2e but
skips its deploy makes the poll time out and wedge the required `ci-required` check.

Set **equality** is the checkable form: equality ⇒ superset, and equality is exactly what
both files' reciprocal comments already pin (a general superset check would let deploy
grow entries e2e lacks, which the comments forbid). The two lists were guarded **only** by
those human comments — nothing mechanical stopped a future edit to one from silently
drifting the other. This guard closes that gap.

The core (`path-filter-guard.ts`) parses each workflow YAML, finds the `changes` job's
`dorny/paths-filter` step, parses its `with.filters` string as YAML (as dorny does — so
the inline `#` comments are inert), reads the `e2e:` / `deploy:` key, and diffs the two
as sets (order-independent).

## Equal globs are only half the invariant — the diff basis must match too

A glob list decides which paths matter. dorny's **`token`** and **`base`** inputs decide
which *changed-file set* those globs are applied to, and the guard compares that pair as
well (issue [#3722](https://github.com/kamp-us/phoenix/issues/3722)):

- **`token`** picks the reader. Absent (it defaults to `${{ github.token }}`) or non-empty
  ⇒ dorny calls `pulls.listFiles`, i.e. GitHub's three-dot **merge-base** diff. Empty ⇒ a
  local `git diff`. (dorny v3.0.2 `src/main.ts`, the PR-event branch of `getChangedFiles`.)
- **`base`** picks what that local diff is taken *from*. Absent ⇒ a **two-dot** diff from
  `pull_request.base.sha`, the base *branch tip* at event time rather than the common
  ancestor — so once `main` advances past the PR's merge ref, `main`'s own drift is
  reported as this PR's changes.

Those two inputs drifted while the glob lists stayed byte-identical, and this guard
**passed** the resulting wedge. On PR
[#3713](https://github.com/kamp-us/phoenix/pull/3713) `ci.yml` (git mode, no `base`) saw 22
phantom `e2e:` hits from `main`'s post-branch drift while `deploy.yml` (API mode) saw only
the PR's real four files: `e2e_required` went true, `deploy` correctly skipped, and the e2e
poll waited out its deadline for a preview that could never arrive — reddening
`ci-required` on a PR with no defect in it. Both steps now pin `token: ''` plus a
merge-base `base:`, and a `basis-drift` verdict fires if that pairing ever diverges again.

Fail-closed on zero scope (ADR
[0092](../../../../../.decisions/0092-gates-fail-closed-on-zero-scope.md)): a missing
file, missing `changes` job or paths-filter step, a missing `e2e:`/`deploy:` key, or an
empty list is a FAILURE — a guard that extracted nothing is broken, never a vacuous pass.

## Usage

```bash
pipeline-cli path-filter-guard check              # the CI gate (exit non-zero on drift / zero scope)
pipeline-cli path-filter-guard check --root <dir> # read the two workflow files under a specific root (default: walk up for one)
```

Wired as the always-on `.github/workflows/path-filter-guard.yml` gate (the `readme-guard`
/ `fanout-guard` idiom). The pure core + IO seam live in `path-filter-guard.ts` /
`gate.ts`; the pure verdict + extractor are unit-tested in
`path-filter-guard.unit.test.ts`, the filesystem gate in `gate.unit.test.ts`.

```bash
pnpm --filter @kampus/pipeline-cli test    # vitest over the core + gate
```
