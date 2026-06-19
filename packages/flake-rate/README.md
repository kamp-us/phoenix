# @kampus/flake-rate

The **flake-rate metric + zero-flake budget** for the test-flake elimination epic
[#765](https://github.com/kamp-us/phoenix/issues/765) (issue
[#770](https://github.com/kamp-us/phoenix/issues/770), Phase 2). It surfaces the CI
flake rate **over time** so a re-introduced flake is self-evident, and pins a budget
the number is held against. This closes the loop after the inventory
([#768](https://github.com/kamp-us/phoenix/issues/768),
[`tests/FLAKE-INVENTORY.md`](../../tests/FLAKE-INVENTORY.md)) and the determinism
fixes ([#769](https://github.com/kamp-us/phoenix/issues/769)) landed: without a trend,
a re-introduced flake is invisible until it reddens a PR; with one, the budget being
blown is the alarm.

It is a `packages/` Effect CLI per the repo's Node-over-Python convention (the
`epic-ledger` / `leak-guard` idiom) — a pure, unit-tested core plus a thin
`effect/unstable/cli` bin.

## The flake signal

The signal is a workflow run's final **`run_attempt`**, read straight from the GitHub
Actions REST API — no new recording hook, no workflow change:

- `run_attempt == 1` + `conclusion: success` → **first-try-green**.
- `run_attempt > 1` + `conclusion: success` → **rerun-to-green** — a flake that reached
  green by *retry*, not by determinism. This is exactly the laundered-flake signal
  [`heal-ci`](../../.claude/skills/heal-ci/SKILL.md) produces when it reruns a known
  transient once (the failure mode behind PR
  [#755](https://github.com/kamp-us/phoenix/pull/755)).

The metric is the **rerun-to-green ratio over runs that reached green** (`failure`
runs are red builds, not laundered flakes, so they stay out of the rate denominator;
in-progress/cancelled runs are ignored). It is reported as a **trend** — the trailing
window is split into buckets ordered oldest → newest — so a regression shows as a
non-zero (or rising) rate in the recent buckets, not hidden inside a single
window-wide average.

## The zero-flake budget (the policy)

**Budget: zero net-new laundered flakes** — `maxRerunToGreen = 0` over the trailing
window (`ZERO_FLAKE_BUDGET` in `src/flake-rate.ts`). The metric is the instrument; the
budget is the policy it is measured against. The budget is blown the moment a single
rerun-to-green run appears in the window, at which point `flake-rate report` prints a
`✗ BUDGET BLOWN` line and **exits non-zero**.

**A blown budget is a regression, and the required response is fixed:**

1. The flake gains an entry in [`tests/FLAKE-INVENTORY.md`](../../tests/FLAKE-INVENTORY.md)
   (a `quarantined` row, per that file's status vocabulary), and
2. a **determinism child** is filed under epic
   [#765](https://github.com/kamp-us/phoenix/issues/765) to make the test deterministic.

Reaching green by rerunning the suite is never a resolution — it hides the debt and
reddens the next innocent PR. The budget makes that debt loud.

## Shape

- **`src/flake-rate.ts`** — the pure, IO-free core: `classifyRun` / `isFlake`,
  `flakeStats` (the rate), `flakeTrend` (the trailing-window buckets), and
  `checkBudget` against `ZERO_FLAKE_BUDGET`. Total over already-decoded
  `WorkflowRun[]`; never touches the network. This is where the metric lives.
- **`src/report.ts`** — pure rendering of the trend + the budget alarm line.
- **`src/github.ts`** — the `gh api` boundary. Schema decodes the untrusted
  workflow-runs envelope at the trust boundary; the `Github` `Context.Service` shells
  `gh api repos/<repo>/actions/workflows/<wf>/runs` over `ChildProcessSpawner` (REST
  only — GraphQL is broken on the kamp-us org), every infra fault a typed error.
  Mirrors `@kampus/epic-ledger`'s `github.ts`.
- **`src/bin.ts`** — the `effect/unstable/cli` `report` command. Reads a trailing
  window, prints the trend + budget verdict, and **exits `2`** on a blown budget (any
  other non-zero means the report could not run).
- **`src/*.unit.test.ts`** — the core's unit tests (classification, rate, trend,
  budget, render, and the Schema decode at the boundary).

## Usage

```bash
# Default: ci.yml on main, trailing 50 runs, 10-run trend buckets.
node packages/flake-rate/src/bin.ts report

# Tune the window / workflow / branch.
node packages/flake-rate/src/bin.ts report --workflow ci.yml --branch main --window 80 --bucket 20
```

`flake-rate report` resolves the target repo per ADR
[0062](../../.decisions/0062-repo-as-config-plugin.md) §1
(`CLAUDE_PIPELINE_REPO` → `GITHUB_REPOSITORY` → `gh repo view`); it never silently
defaults to a repo, so a foreign install can't read phoenix's runs.

## Observability over time

The CLI emits the trend + budget verdict as plain text — planner-agnostic on the
destination. To make the trend a **standing** signal (not just an on-demand command),
run `flake-rate report` from a **new, separate** `flake-rate.yml` scheduled workflow
that fails on a non-zero exit. This package deliberately adds **no** `.github/workflows`
change itself: the harness lane owns `ci.yml`, and a scheduled `flake-rate.yml` is a
clean, collision-free follow-up rather than a `ci.yml` job-add.
