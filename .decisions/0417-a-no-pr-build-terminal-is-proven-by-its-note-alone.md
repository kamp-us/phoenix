---
id: 0417
title: A no-PR build terminal is proven by its note alone, whatever the issue's type
status: accepted
date: 2026-09-26
tags: [lane, build]
---

# 0417 — A no-PR build terminal is proven by its note alone, whatever the issue's type

**What this decides:** `lane prove` proves a builder's `SUCCESS-NO-PR` from one artifact, a comment
on the issue written since the task entered `build`. It no longer requires the issue to carry
`type:investigation`.

## Context

A build lane can finish work that leaves no diff. The case that surfaced it was a board-data repair:
rewriting other issues' acceptance-criteria headings, where nothing in the repo changes and no PR
opens ([#6911](https://github.com/kamp-us/phoenix/issues/6911)). That lane did the work, posted its
note, and still could not record a finish. `SHIPPED-PR` needs a PR, `BUILT-NO-PR` needs an epic
child's commits, and `SUCCESS-NO-PR` refused because the issue was a `type:bug`. The only token that
appended was `STOPPED`, so a finished lane read on the ledger exactly like a dead one.

The `type:investigation` gate existed because `SUCCESS-NO-PR` was written as an investigation's
terminal: a diagnosis is the one deliverable that was expected to ship without a PR, so the label
stood in for "this issue may end with no PR". It proved nothing about the work. The proof was always
the second test in `traceDiagnosis`, a comment written after the task entered `build`, which keeps a
triage note from passing as a builder's output.

Three routes were on the table: widen the no-PR proof, add a dedicated terminal token for data
repairs, or have triage route board-data work away from build lanes.

## Decision

The founder ruled for widening the proof and against the other two
([ruling](https://github.com/kamp-us/phoenix/issues/6911#issuecomment-5519863361), 2026-09-02). The
lens he set: reduce process toil, raise trust between agents and skills, take the cheapest option,
and add no new gate and no new token unless a failure has actually recurred.

- `traceDiagnosis` in `packages/fabrika-cli/src/lane/prove.ts` takes no labels. Its whole proof is
  the recency read: the newest comment written since the task entered `build`.
- `INVESTIGATION_LABEL` is deleted, and `lane prove`'s no-PR diagnostic names only that comment.
- The `build` skill describes `SUCCESS-NO-PR` as work finished with no diff, proven by the builder's
  note, with an investigation as one example rather than the precondition.
- No terminal token is added to `lane/report.ts`, and no gate is added anywhere.

## Consequences

- A board-data repair, or any build that honestly ends with no diff, records a proven `DONE` and
  folds to the machine's `diagnosed` final instead of parking on a human.
- A no-PR `DONE` on a feature or bug is now provable where it was refused before. The artifact still
  has to exist: a lane that posts no note since entering `build` stays unproven at exit `22`. What
  the lane claimed to do is on the issue in its own words for anyone who reads it.
- Whether triage should stop routing board-data work to build lanes, and whether `build`'s rule that
  a build lane does not write issue bodies should move, are separate questions this record leaves
  open.
