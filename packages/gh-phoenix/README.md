# @kampus/gh-phoenix

A `gh` REST **shim** + a skill **grep-lint** that kill the Projects-classic GraphQL error
class on the kamp-us org (issue #743). The org runs a legacy Projects-classic integration
that breaks GraphQL-backed `gh` calls, yet subagents reflexively reach for `gh pr edit` /
`gh project` (GraphQL paths) and eat the error. This package absorbs that class mechanically.

Built the Node Effect-CLI-under-`packages/` way (the `@kampus/leak-guard` / `@kampus/epic-ledger`
idiom, CLAUDE.md): a pure, unit-tested core + a thin `effect/unstable/cli` bin. Never a `.py` hook.

```
gh argv ──► route() ──► passthrough | rewrite (gh api REST) | block (REST hint)   (router.ts)
skill text ──► lintCorpus() ──► findings + scanned-scope ──► fail-closed on zero scope (lint.ts)
```

## The two surfaces

### `gh` shim (shadows `gh` on PATH)

`bin.ts` shadows `gh` on the subagent PATH. For each invocation it runs the pure `route` core
and then:

- **passthrough** — a safe REST/porcelain call (`gh api repos/...`, `gh pr create`, `gh pr list`,
  a `--json` view with no GraphQL-only fields): exec the real `gh` unchanged.
- **rewrite** — a GraphQL-breaking verb with a known REST equivalent: run `gh api` REST instead.
  - `gh pr edit N` / `gh issue edit N` → `gh api -X PATCH repos/<owner>/<repo>/issues/N -f ...`
    (body / title / milestone). A milestone **title** is flagged for number-resolution (the
    REST PATCH needs the number); a **numeric** milestone passes straight through.
  - `gh pr/issue view --json …` → the same view with GraphQL-only fields
    (`closingIssuesReferences`, `projectCards`, `projects`, `projectsV2`, …) **stripped** from the
    projection.
  - `--body-file <path>` → `-F body=@<path>`, but only after the path is validated to exist.
- **block** — a GraphQL-breaking verb with no safe rewrite: fail fast (non-zero) with a REST hint,
  never shell the breaking call. `gh project …` (classic Projects has no REST surface here), a
  `--json` requesting only GraphQL-only fields, an `edit` with no rewritable field, or a missing
  `--body-file`.

The real `gh` is resolved via `$GH_PHOENIX_REAL_GH` or the first PATH `gh` whose realpath differs
from the shim (so the shim never recurses into itself). `$CLAUDE_PIPELINE_REPO` (else `gh repo
view`, else `kamp-us/phoenix`) is the repo the REST rewrites target.

#### Wiring it onto the subagent PATH

Put a directory holding a `gh` that forwards to this bin **ahead of** the real `gh` on the
subagent `PATH`. The simplest wrapper:

```sh
#!/usr/bin/env sh
exec node /abs/path/to/packages/gh-phoenix/src/bin.ts "$@"
```

Name it `gh`, `chmod +x`, place its dir first on `PATH`, and set `GH_PHOENIX_REAL_GH` to the real
`gh` so the shim can forward. See the PR body's wiring note for the harness `PATH` injection.

### `lint-skills` (the grep-lint, CI-callable)

```sh
node packages/gh-phoenix/src/bin.ts lint-skills <file>...
```

Flags GraphQL-path `gh` invocations in the handed skill files and **fails closed on zero scope**
(ADR 0092): it emits the file count + scanned paths, exits **3** when it scanned nothing (a silently
no-op lint is a FAIL, not a clean pass), **2** on any finding, **0** when clean. The
`.github/workflows/skill-gh-lint.yml` workflow runs it over the whole
`claude-plugins/kampus-pipeline/skills/**` corpus on every PR. Self-exempt files (the skills that
*document* the REST-only rule — write-code, review-code, ship-it, gh-issue-intake-formats — and this
package's README) are dropped from scope so the lint doesn't flag the text that explains what it
forbids.

## Tests

- `router.unit.test.ts` — breaking verb routed/hinted, safe REST verb passed through, field-strip,
  milestone title-vs-number, `--body-file` existence.
- `lint.unit.test.ts` — finding vs clean, self-exempt, and the zero-scope fail-closed predicate.
- `bin.test.ts` — the CLI exit contract (3 zero-scope, 2 finding, 0 clean) and the shim routing
  against a stub `gh`.
