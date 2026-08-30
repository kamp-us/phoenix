# @kampus/fabrika-cli

## What it is

The deterministic verb package the [fabrika](../../claude-plugins/fabrika/) skills call.
`fabrika <group> <verb> …` dispatches to a registered verb group. fabrika is a two-layer split:
deterministic work is pushed into CLI verbs, and each skill is a thin wrapper carrying only the
judgment that cannot be mechanized. This package is the deterministic layer.

It is internal tooling for the kamp.us agent pipeline, not a general-purpose CLI. It ships on the
public npm registry so a consumer repo can pin a version of it. For what fabrika as a whole is, read
[the guide](../../claude-plugins/fabrika/guide/README.md).

## Why it exists

- Which copy of the binary answers an invocation, and why a copy from another repository is refused
  rather than delegated to: ADR
  [0287](../../.decisions/0287-delegation-stays-inside-one-repository.md).
- The GitHub credential order, and why `gh` is a convenience rather than a prerequisite: ADR
  [0315](../../.decisions/0315-fabrika-cli-github-token-resolution-and-the-three-non-rest-carves.md).
- Why this package re-implements v1's work and never calls into it: ADR
  [0238](../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md). v1 is deleted, so that is
  history rather than a live constraint.

## How to use it

```bash
pnpm add --global @kampus/fabrika-cli
fabrika --help
```

Inside a phoenix checkout you can skip the install and run the working tree:
`node packages/fabrika-cli/src/bin.ts --help`.

Every verb that touches GitHub needs a credential in the environment — `GITHUB_TOKEN`, else
`GH_TOKEN`. With neither set and `gh` on `PATH`, the credential is resolved once from an existing
login before any request. A credential that resolves nowhere is a refusal naming both variables,
never an anonymous call. There is no `gh` prerequisite: the package reaches api.github.com over HTTP
([`src/io/gh-api.ts`](./src/io/gh-api.ts)), and `guard no-gh check` keeps it that way on every push.

Ordered recipes — installing, credentialing, finding a group and a verb, reading a refusal, running
from a consumer repo — are in
[`docs/running-fabrika-in-a-repo.md`](./docs/running-fabrika-in-a-repo.md).

`review-ui render` remains the default evidence producer. A localhost-only product enters through
trusted CI only when the repository declares its harness: the workflow runs `review-ui ci-produce`,
and the independent reviewer runs `review-ui fetch`. Callers cannot select a workflow, run,
artifact, manifest, receipt, or local evidence path. See the
[localhost evidence pattern](../../.patterns/review-ui-localhost-ci-evidence.md),
[operator runbook](../../ops/runbook-review-ui-localhost-evidence.md), and
[verb reference](./docs/verb-reference.md#review-ui).

## Reference

- [`docs/verb-reference.md`](./docs/verb-reference.md) — every registered verb group, its verbs, its
  flags and its exit codes, plus the four caller-facing interface rules, the shared exit table those
  codes are read against, and the `capture` library subpath. The governing convention is
  [`claude-plugins/fabrika/docs/interface-convention.md`](../../claude-plugins/fabrika/docs/interface-convention.md).
  Each verb's own `--help` states the same contract at the point of use, and the `--help` index is
  derived from [`src/registry.ts`](./src/registry.ts) — a group appears by being registered and
  nowhere else.
- [`docs/packaging.md`](./docs/packaging.md) — which copy of the binary serves an invocation, the
  delegation-outcome table, the environment variables, the two Node floors and the `publishConfig`
  rewrite.
- [`.patterns/fabrika-verb-shape.md`](../../.patterns/fabrika-verb-shape.md) — how a verb module is
  put together and which services it takes.

## Testing

```bash
pnpm --filter @kampus/fabrika-cli test        # vitest
pnpm --filter @kampus/fabrika-cli typecheck   # tsc
pnpm --filter @kampus/fabrika-cli build       # tsc -> dist/, for the published tarball only
```

The development loop has no build step: `bin` points at `./src/bin.ts` and Node ≥ 24 strips the types
natively, so an edit to `src/` is live on the next invocation. `build` emits `dist/` for the
published tarball and nothing else reads it — see
[`docs/packaging.md`](./docs/packaging.md) for the two floors and the `publishConfig` rewrite.
