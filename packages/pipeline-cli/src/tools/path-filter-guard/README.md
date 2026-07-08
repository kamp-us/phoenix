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
