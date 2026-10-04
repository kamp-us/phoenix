---
id: 0443
title: A triage sweep queues amended agent-ready issues for a human re-grade, never a build claim axis
status: accepted
date: 2026-09-30
tags: [fabrika, triage, build, pipeline-hardening]
---

# 0443 — A triage sweep queues amended agent-ready issues for a human re-grade, never a build claim axis

**What this decides:** an open `ready-for:agent` issue whose body changed after its last criterion
was ticked is found by a read-only triage sweep and handed to a human to re-grade; `build claim`
gains no axis that judges whether merged work already met the criteria.

## Context

[#8091](https://github.com/kamp-us/phoenix/issues/8091) found that nothing re-grades an open issue
once its contract stops being open. When a `Part of` PR merges and a later body amendment carves the
last unmet criterion out, the issue keeps `status:triaged` and `ready-for:agent`, stays unassigned,
and the next build lane claims it, proves the work already landed, and backs off with no diff. The
live instance was #8064: PR #8081 merged as `Part of`, an amendment moved the blocked half of one
criterion to #8078, the labels never moved, and a lane claimed it and backed off.

`build claim`'s admission test (`packages/fabrika-cli/src/build/scope-admission.ts`) reads whether
a criteria block exists, through `read` in `packages/fabrika-cli/src/wire/acceptance-criteria.ts`.
No axis reads whether the block is already met, and `packages/fabrika-cli/src/triage/` has no
re-grade verb.

#8091 put two candidates to the founder:

1. A new `build claim` axis that refuses when the issue's linked merged PRs already cover every
   criterion. It acts where the cost is paid, but it needs a matcher from criterion to diff, the
   expensive and least reliable half.
2. A triage re-grade over open issues whose body was amended after their work landed. It is cheap
   and needs no matcher, but it is a heuristic: an amendment that tightened a contract is flagged as
   readily as one that discharged it, so it produces a queue for a human, not a verdict.

It also named a third reading, a discipline that keeps the criteria boxes true as work lands, and
the choice of accepting the cost and building nothing.

The founder ruled option 2:
[the ruling comment](https://github.com/kamp-us/phoenix/issues/8091#issuecomment-5556193355). This
record transcribes that ruling; the choice is not the author's.

## Decision

**The re-grade seat is a triage sweep verb that lists open `ready-for:agent` issues whose body was
amended after their last criterion was checked, for a human to re-grade.**

- **It produces a review queue, not a verdict.** The verb lists; a human re-grades. It does not
  relabel, unassign or close an issue on its own reading.
- **The evidence it reads is the issue body's own history:** the time a criterion checkbox was last
  ticked, and whether the body was amended after that. Checkbox state and body-amendment timestamps
  are the evidence. Linked merged PRs are not part of the ruled test.
- **Option 1, the `build claim` axis with a criterion-to-diff matcher, is not taken now.** The
  ruling names its revisit trigger: the sweep's queue proving too noisy to keep up with.
- **The third reading and the do-nothing choice are not ruled.** The ruling picks option 2 and says
  nothing about a checkbox discipline or about accepting the cost, so this record decides neither.
  The sweep reads checkbox state, so it relies on boxes being ticked; it does not make ticking them
  a rule.
- **Implementation is filed as [#10291](https://github.com/kamp-us/phoenix/issues/10291)**, with its
  own acceptance criteria. #8091 closes on this record alone.

**What the ruling left open, sent back to the founder.** An issue where no criterion was ever ticked
has no "last criterion checked", so read literally it never lists. #8064 was exactly that case: all
boxes unchecked while five of six were met. Whether the sweep lists such an issue, and against which
timestamp, is not in the ruling. It is carried on #10291 as a question to settle before that issue
is built.

## Relationship to ADR 0343

[ADR 0343](0343-a-partial-merge-sends-the-lane-round-again.md) sends a lane back to `queued` when its
PR merged as `Part of #N`, so an operator can dispatch it again. That is right when work remains. It
is also the path that delivers the wasted spawn #8091 describes, when the only thing that knows no
work remains is a later body amendment.

This record does not amend or supersede 0343. The lane still returns to `queued` on a partial merge,
and nothing here reads the lane ledger. The sweep works on the issue side: it puts the amended issue
in front of a human, whose re-grade (closing it, or moving its labels) is what takes it out of the
pool before the queued lane is dispatched into it again.

## Consequences

- A discharged-by-amendment issue can now be found without a build lane spending a spawn to find it,
  once #10291 lands. Until then, the gap #8091 names stays open.
- The sweep flags amendments that tighten a contract as readily as ones that discharge it. The human
  reading the queue sorts them; the verb never guesses.
- If the queue grows faster than a human keeps up with, that is the ruled trigger to revisit the
  `build claim` axis.
