# @kampus/ci-required

The pure verdict for the **`ci-required` CI aggregator** — the single always-on
status context the `main` branch ruleset requires (issue #786, ADR
[0092](../../.decisions/0092-gates-fail-closed-on-zero-scope.md)).

CI's cost-bearing gating jobs (`check` / `unit` / `packages-tests` / `actionlint`
/ `integration` / `e2e`) each `if:`-skip on a PR whose changed paths, flags, or
author they don't cover, so a green checkmark alone can't tell a **legitimate
not-applicable skip** from a **should-have-run job that was silently skipped** —
the silent-no-op ADR 0092 forbids. `ci-required` is the one required check that
makes that distinction and **fails closed** on the second case rather than waving
the skip through.

This package is the behavioral half that distinction rests on, and it is kept as
its **own** package — not folded into `@kampus/pipeline-cli` (ADR
[0103](../../.decisions/0103-consolidate-pipeline-cli-package.md))
— because of the ADR 0092 constraint below.

## Why it stays its own zero-dep package

The `ci-required` gate job runs only `actions/checkout` + `node
packages/ci-required/src/bin.ts` — **no `pnpm install`**. As the always-on
aggregator that gates every merge, it must stay fast and never depend on a green
install step (an install failure here would block all merges). So both the core
and the bin are **plain Node with zero runtime dependencies**: no Effect import,
nothing the pipeline-cli Effect-CLI idiom would pull into the gate's path. ADR
0103 consolidated the *other* pipeline tooling into `@kampus/pipeline-cli`; this
one is the documented special-case that stays standalone for the no-install
guarantee.

## How it's used

The `ci-required` job in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)
passes the gating jobs' `needs.<job>.result` and the single-sourced `*_required`
booleans (emitted by the `changes` job from the SAME expression that gates each
job's own `if:`, so run-ness and required-ness can't drift — #375/#738) into the
bin's `env:` block, then runs:

```bash
node packages/ci-required/src/bin.ts
```

The bin reads that env, runs the pure core, prints the per-job verdicts (ADR 0092
§1 "emit what you scanned"), and exits **0 on PASS / 1 on FAIL**. A FAIL means a
should-have-run job did not succeed (or the `changes` source job itself didn't
succeed, so its `*_required` outputs are untrustworthy) — the aggregator fails
closed.

The same verdict is also exposed as a `pipeline-cli ci-required` subcommand for
local use; the byte-for-byte print + exit contract is shared.

## Architecture

A pure, unit-tested core + a thin bin (the repo tooling idiom):

- `src/ci-required.ts` — the pure, IO-free core: `inputFromEnv` maps the GHA
  `env:` record to a `CiRequiredInput`, and `judge` / `judgeJob` decide the
  per-job and whole-aggregator verdict. Same inputs ⇒ same verdict, no IO.
- `src/bin.ts` — the thin Node shell: read `process.env`, print the verdicts,
  exit 0/1. Zero runtime deps on purpose (see above).
- `src/index.ts` — the package's public exports.

```bash
pnpm --filter @kampus/ci-required test       # vitest over the pure core
pnpm --filter @kampus/ci-required typecheck
```
