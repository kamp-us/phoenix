---
id: 0385
title: A descoped epic child leaves a running plan by name, and its issue stays open
status: accepted
date: 2026-09-10
tags: [fabrika, lane, ledger, pipeline, governance]
---

# 0385 — A descoped epic child leaves a running plan by name, and its issue stays open

**What this decides:** `lane amend --defer <task> --defer-reason "<why>"` is the one route that drops
a task carrying recorded history from a running epic's machine, and it records the drop on the
amendment line it was already appending. `ledger defer` is the board half: comment, unlink, leave the
issue open. Neither closes anything, and the silent widening of the `61` refusal is rejected.

## Context

Epic [#8892](https://github.com/kamp-us/phoenix/issues/8892) had four children with independently
reviewed, recorded landings and a fifth, Pi
([#8951](https://github.com/kamp-us/phoenix/issues/8951)), whose only recorded event was one
`BLOCKED`. The founder deferred Pi and kept its issue open as the follow-up
([ruling](https://github.com/kamp-us/phoenix/issues/8921#issuecomment-5623257520)). The release could
not then be finished through any supported operation.

Two verbs stood in the way, each correct as specified.

`lane amend` builds `historied` from every non-`AMENDED` entry and refuses any of those the new
topology places in no phase, at `AMEND_UNREPLAYABLE` (`61`). Pi's one `BLOCKED` put it in that set.
The refusal's own remedy — "let it reach a leaf the amendment can carry, or amend a different part of
the topology" — reads as "finish the work you just cancelled" or "do not make the change you were
asked to make". That is exactly what [#7727](https://github.com/kamp-us/phoenix/issues/7727)'s
acceptance criteria asked for, so the verb was not defective; the case had no route.

`ledger supersede` always runs three legs — comment, unlink, **close as `not_planned`**. A deferred
child is work the founder still wants, so closing it deletes the follow-up the deferral exists to
keep. There was no keep-open unlink anywhere in the group.

The remaining routes were the two [#7727](https://github.com/kamp-us/phoenix/issues/7727) retired:
retire the lane directory and re-emit, which discards `events.jsonl` and with it the only record the
four landed children have, or hand-drive the rest of the epic outside its own ledger. The revised
plan sat staged and unpublished rather than take either.

## The rejected shape

The obvious patch is to widen `61` — let a historied task be dropped when the topology no longer
places it. It is rejected. A dropped task's recorded lines stay in `events.jsonl`, so after a silent
widening the ledger holds lines it no longer accounts for: the fold would have to either refuse them
as unknown tasks (which breaks the lane) or ignore them (which is the ledger quietly ceasing to
account for what it recorded). ADR [0352](0352-an-unreplayable-lane-is-archived-not-sealed.md)
declined exactly that trade for the unreplayable case — an unreadable lane is archived, not sealed
over — and ADR [0350](0350-a-correction-supersedes-a-recorded-line.md) settled the general shape:
a recorded line is superseded by a later line that names it, never edited and never dropped.

## Decision

**A deferral is named, bounded and recorded, and it rides the amendment's own line.**

`lane amend` takes `--defer <task>` (repeatable) with a mandatory `--defer-reason`. The `AMENDED`
entry it already appends gains a `defers` payload: one row per deferred task carrying `task`,
`through` and `reason`. `through` is the `at` of that task's last recorded entry, derived by the verb
off the log under the same lock the append takes — an operator cannot be asked to type a timestamp
that has to match a log line exactly.

The field is spelled `defers` rather than `deferred` because `LogEntry.deferred` already means the
review namespaces a `PASS` was proven short of. Two different things do not share one word in the
journal.

`resolveDeferrals` ([`deferral.ts`](../packages/fabrika-cli/src/lane/deferral.ts)) resolves every
payload against the entries it claims, and four shapes are defects on the fold's own unreplayable
channel rather than resolutions: a `through` naming no entry of that task, one naming more than one,
an entry the bound does not cover (which is how a silently reintroduced child is caught), and one
task deferred twice. `foldLog` excuses a resolved deferred task from the unknown-task check and
nothing else — every other unknown task is the defect it always was.

**Only the naming is new. Every other refusal stands:**

- an unnamed historied drop is still `61`;
- a deferred task the ledger proves landed is still `AMEND_DROPS_LANDED` (`60`), which runs first;
- a log that already does not replay is still refused before anything is judged;
- a deferral that does not describe this lane is a new code, `DEFERRAL_REFUSED` (`64`) — the task is
  not this lane's, the topology still places it, it carries no history to defer, or a live worker
  holds the child. It is its own seat because `61`'s remedy is to change the plan and this one's is
  to change the flag or the board.

**A deferral proves the worker is gone before it writes.** The deferred child's own issue is read for
an authorized `build-claim:` marker; a held claim refuses at `64`, and an unreadable thread is
UNKNOWN at `11`, never an absence. The deferral kills nothing and discards no branch or worktree:
the commits stay where they are, under the same open issue.

**`ledger defer` is the board half, and it never closes.** Comment, unlink, then a read-back proving
the child open and no longer a sub-issue. It reads no staged plan run, for
[`ledger retopology`](../packages/fabrika-cli/src/ledger/retopology-verb.ts)'s reason: a descoped
epic is found with its run already cleared, so requiring one would make the supported route
unreachable in the state it is for. It runs under the epic claim like every other verb in the group.

**Deferred is not completed, and the surfaces say so.** `lane history` prints the deferred child's
own events verbatim and the amendment carrying the decision, because no line was ever rewritten.
`lane status` prints a `deferred` array on a lane that has one — absent where the lane deferred
nothing, so every other lane's status is byte for byte what it always was. Nothing records `DONE`,
`PASS` or a landing for the deferred child anywhere.

## Consequences

The Pi case is now one authorized route: `ledger defer 8892 --child 8951 --reason "…"` on the board,
`lane amend 8892 --defer issue_8951 --defer-reason "…"` on the ledger, after the epic body's
`## Dependencies` block drops the child. Four landed children keep their states and their evidence,
`events.jsonl` keeps every byte, and the epic reaches its tail.

The partial-write shape is unchanged and stays recoverable: the amendment line lands before the
machine write, so a failed write leaves a log the OLD machine still replays — the deferred task is
still in that machine, so its lines fold exactly where they stood — and re-running completes it. A
failed append leaves the machine unamended.

`defers` is a seventh payload on `LogEntry` and every line written before it existed folds exactly as
it did. A reader on an older build meeting a `defers` payload reads it as an unknown field and folds
the amendment inert, which is what it already does with `tasks`; it would then refuse the deferred
task as unknown rather than accept a plan change it cannot read.

The `61` refusal text still says "let it reach a leaf the amendment can carry, or amend a different
part of the topology". It now names `--defer` as the third arm.
