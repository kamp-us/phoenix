# @kampus/audit-run

The **on-demand single-entry rite-audit run** — the capstone wiring slice of the rite-audit
epic ([#1510](https://github.com/kamp-us/phoenix/issues/1510), issue #1517). One command runs
a complete rite-audit end to end, so a maintainer triggers the whole capability without
orchestrating the pieces by hand:

```
provision audit stage  →  walk all dimensions  →  emit + archive the dated verdict  →  DESTROY the stage
   (@kampus/audit-stage)   (rite-audit explorer)        (@kampus/audit-verdict)        (guaranteed teardown)
```

It owns the operator-facing "run a rite-audit now" command and the guarantee that a run — pass
**or** fail — **always** tears its stage down. Scheduling (wrapping this in a routine/cron) is
explicitly a **later** follow-up and out of scope; this makes the on-demand run solid first.

## How the agentic explorer is invoked — the injected walk seam

The [rite-audit explorer](../../claude-plugins/kampus-pipeline/skills/rite-audit/SKILL.md) is
an **LLM driving the Playwright MCP**, not a plain function — so it cannot run as a programmatic
call inside this TS process. It is therefore the **injected walk seam** ([`AuditWalk`](./src/run.ts)),
exactly the shape [`@kampus/audit-stage`](../audit-stage/README.md)'s `runHook` was built as:

- The pure core ([`run.ts`](./src/run.ts)) is parameterized over `walk` — the unit test injects
  a fake, so the safety property is proven with **no real deploy and no real agent run**.
- The real adapter ([`adapter.ts`](./src/adapter.ts)) **shells out** to an operator-supplied
  walk command (`--walk`): the live stage's run context is handed over as
  `$RITE_AUDIT_RUN_CONTEXT` (JSON), the command drives the real agentic explorer against the
  real stage, and prints the raw findings bundle (`{ "dimensions": DimensionResult[] }`, the
  explorer's output #1516 consumes) to stdout. **This is never a faked automated LLM call** —
  the command provisions the live stage and owns everything around the walk, but the agentic
  walk itself is the handed-off external process.

A walk that exits non-zero, prints malformed JSON, or yields no dimensions **fails loud** (story
11: never silently pass) — in the `run-hook` error channel, so teardown still fires.

## Guaranteed teardown wraps whatever the run-hook is (story 10)

The teardown guarantee is **reused, not re-derived**: this core installs its
`walk → buildVerdict → archive` as `@kampus/audit-stage`'s `runHook`, so #1512's
`Effect.onExit(destroy)` wraps it. A walk that **crashes** mid-run and an **archive** that
**fails** both still tear the stage down — no flag-on stage is ever left alive. Placing
`buildVerdict` + archive inside the run-hook keeps the spec order (walk → archive → destroy):
the archive lands while the lifecycle body runs, before the onExit teardown. The
`run.unit.test.ts` suite pins teardown on the happy path, on a walk crash, and on an archive
failure, over the injected fakes.

## The operator surface

At the end of a completed run the command surfaces the run's overall verdict — per-dimension
pass/fail — via [`formatOperatorSummary`](./src/run.ts) (a pure string, unit-tested independent
of the bin's Console), plus where the dated verdict was archived.

## Architecture

A pure, unit-tested core + a thin Effect bin (the `@kampus/founder-seed` / `@kampus/preview-seed`
idiom — Node Effect tooling, never Python or an ad-hoc shell script):

- `src/run.ts` — the pure orchestration core: `runAuditOnce` (provision → walk → verdict →
  guaranteed teardown, via the #1512 lifecycle) + `formatOperatorSummary`.
- `src/adapter.ts` — the real seams: `makeWalkFromCommand` (the agentic walk subprocess),
  `makeFsArchiver` (the repo-relative verdict writer), `findRepoRoot`.
- `src/bin.ts` — the `audit-run run` CLI.
- `src/run.unit.test.ts` — the guaranteed-teardown + verdict-surface unit tests (fakes only).

## Running it

```bash
node packages/audit-run/src/bin.ts run \
  --walk '<command driving the rite-audit explorer; prints { "dimensions": [...] } to stdout>' \
  [--stage <name>] [--root <dir>]
```

Run from the repo root. Credentials come from the environment (`$CLOUDFLARE_ACCOUNT_ID`,
`$CLOUDFLARE_API_TOKEN`, `$ALCHEMY_PASSWORD`, `$BETTER_AUTH_SECRET`), never source. **No
scheduling** is added — the entry point is on-demand only (scheduling/cron is an explicit later
follow-up).

Out of scope: scheduling/cron, real-production runs, and any change to the dimensions
(#1513–#1515) or the verdict format (#1516).
