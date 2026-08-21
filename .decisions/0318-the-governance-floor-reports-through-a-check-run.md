---
id: 0318
title: The governance floor reports through a check-run, pending while nobody has judged the head
status: accepted
date: 2026-08-20
tags: [fabrika, ship, governance, ci, pipeline]
---

# 0318 — The governance floor reports through a check-run, pending while nobody has judged the head

**What this decides:** `fabrika ship floor --publish-check` writes the floor's answer to a check-run
named `governance floor at head` instead of seating it on the job's exit code. `absent` — no
governance verdict posted at this head yet — leaves that check-run `in_progress`; `stale`, `fail` and
UNKNOWN conclude `failure`; `satisfied` and `n/a` conclude `success`. The job then exits 0 whenever
the verb published an answer. Founder ruling on
[#6161](https://github.com/kamp-us/phoenix/issues/6161), 2026-08-20:
[the comment](https://github.com/kamp-us/phoenix/issues/6161#issuecomment-5364681459).

## Context

A GitHub Actions job's conclusion is `success`, `failure`, `cancelled` or `skipped`. Nothing else is
representable. So while the floor was seated on `ship floor`'s exit code (ADR
[0228](0228-scripts-relay-never-derive.md)'s relay shape, landed for #5408), one red carried two
facts that route opposite ways:

- **not yet** — the PR touches a governance root and nobody has posted a verdict at this head. Every
  governance-root PR passes through this state, by construction: `governance-floor.yml` fires on
  `pull_request`, so it always runs before the verdict a human or an agent has to read the diff to
  write (#5585).
- **wrong** — a verdict exists and it is FAIL, or it is bound to another head.

On 2026-08-18 five of the six red open PRs (#6159, #6158, #6140, #6122, #6031) were red on only this
check while healthy mid-pipeline. A red that usually means "not yet" is a red people stop reading,
and the reds that mean something go with it.

## Decision

The verb publishes a check-run; the job relays what it did.

| Floor at the head | Check-run | Job |
|---|---|---|
| `satisfied`, `n/a` | `completed` / `success` | exit 0 |
| `absent` | left `in_progress` — **pending** | exit 0 |
| `stale`, `fail` | `completed` / `failure` | exit 0 |
| UNKNOWN (`ship floor` 7 / 11 / 13) | `completed` / `failure` | exit 0 |
| the check-run could not be written, or the head's check-runs could not be read | — | non-zero |

The executable spec for those rows — the stdout shapes, the exit codes and their messages — is
`ship/contract.md`'s **The check-run mode** heading. This table is what the decision is, not a second
home for the mechanics.

Three things this does not change, each load-bearing:

- **`ship gate` is untouched and stays the single merge authority.** It still refuses while a
  governance verdict is absent. Only the human-facing report moved.
- **Every other caller of `ship floor` keeps its exit semantics.** The check-run lives behind
  `--publish-check`; without the flag the verb is byte-for-byte what it was, and no exit code was
  repurposed. The mode's own refusals (`8` write failed, `9` echo mismatch, `11` the head's
  check-runs could not be read) are the `ship` group's existing meanings.
- **UNKNOWN concludes `failure`, never pending.** A floor nobody could read is not a floor still
  being read (ADR [0092](0092-gates-fail-closed-on-zero-scope.md)).

## Why pending, and not neutral

GitHub treats a `neutral` required check as **passing**: "Required status checks must have a
`successful`, `skipped`, or `neutral` status before collaborators can make changes to a protected
branch" ([About protected branches → Require status checks before
merging](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#require-status-checks-before-merging)).
`neutral` would therefore un-bind the floor at the moment it is most needed — the window in which no
verdict exists.

A check-run that has not concluded is on neither list, so it is not a passing one. What that buys
today and what it buys after the ruleset flip are different things, and the difference is the next
section: `ship checks` already rolls a pending gating run up as `pending` rather than `green`, which
is what withholds the merge now; once the check is **required**, branch protection and the merge
queue withhold it too. Pending is the only non-red state that reads as waiting to a human without
telling the platform the gate is satisfied.

## What it costs

`governance post` re-fires the floor run at the head it just posted to, and that re-fire is what
turns a pending check-run green — no new workflow trigger. Two consequences follow from the job now
succeeding whenever it published:

- The re-fire decision moved off the job's conclusion onto the check-run's state. A green job beside a
  pending check-run is the ordinary "no verdict yet" shape, and the old rule would have read it as
  nothing to clear.
- It requests a **whole-run** re-run rather than `rerun-failed-jobs`, which GitHub refuses on a run
  with no failed job.

The floor's own state is written by the verb rather than derived by the job, so the job needs
`checks: write`. It reads nothing new.

## Status of the ruleset

Making `governance floor at head` a **required** status check on `main` is a repository-ruleset
change, which is the founder's. Until that flip the check is visible but not required, exactly as the
job's context was before this — no weaker, and recorded here rather than glossed.
