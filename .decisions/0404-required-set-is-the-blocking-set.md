---
id: 0404
title: Only a check the base branch declares required may block a ship
status: accepted
date: 2026-09-21
tags: [pipeline, fabrika, ship, heal-ci, review, ci]
---

# 0404 — Only a check the base branch declares required may block a ship

**What this decides:** a red check that GitHub does not require on the base branch is reported as a
note and nothing more — it never parks a lane, never routes to `heal-ci`, and never makes a verb
call the pull request red.

## Context

[ADR 0061](0061-ship-it-gating-check-set.md) defined the blocking set as a denylist of known
informational checks, fail-safe to blocking: an unrecognized red blocks until someone adds its name
to the list. It rejected reading GitHub's required set for one stated reason — `main` declared no
required status checks at the time, so under that definition nothing would block and a merge could
land over red unit tests. It expected the design to "degrade cleanly" once a ruleset existed,
because then "those checks are all gating (none would be on the informational denylist)".

[ADR 0071](0071-enforce-control-plane-at-github.md) then built the ruleset 0061 anticipated, and
`main` declares four required contexts today. But 0061's expectation covers one direction only:
every required context is gating. It says nothing about a context that is neither required nor on
the denylist, while the repository produces dozens of check runs.

The gap is reproduced in source. `packages/fabrika-cli/src/heal-ci/diagnose-verb.ts` builds its
gating set from the denylist alone, then rolls it up and fires the `red` arm in
`packages/fabrika-cli/src/heal-ci/stall.ts` four arms above `gated-unshipped` — while the same verb
reads the base branch's declared required set sixty lines later for the check-surface arm and never
consults it for CI. `packages/fabrika-cli/src/heal-ci/logs-verb.ts` and
`packages/fabrika-cli/src/ship/checks-verb.ts` share that denylist through `isInformational` in
`packages/fabrika-cli/src/review/rollup.ts`, two patterns wide. `packages/fabrika-cli/src/review/ci-verb.ts`
is wider still: it rolls up every run at the head with no informational dimension at all.

On PR #9549 at head `9770d7edef4ba979548e3aaf6a163c4d81df2976`, `diagnose` printed `stall red`,
`gates satisfied 3/3` and `queue none`; `surface` printed `required:4 producing:4 extra:41` with all
four required contexts green and `Analyze (python)` under `extra`; the platform read
`mergeable: MERGEABLE`, `mergeStateStatus: UNSTABLE`. A merge-eligible pull request with no owner
was routed to a repair lane that had nothing to repair.

The founder ruled the direction on
[issue 9570](https://github.com/kamp-us/phoenix/issues/9570#issuecomment-5753839456), 2026-09-20,
naming the day's hand-fixed gates — lanes 9514, 8946 and 9537 — as the cost: `Analyze (python)` on
branches cut before `main` carried Python files, and a roadmap-guard run against a stale merge
snapshot. This record transcribes that ruling and amends 0061's definition in part; 0061's
`pending` handling, its treatment of `skipped` and `cancelled`, and the run-evidence bundle's
standing as the SHA-bound authority ([ADR 0054](0054-run-evidence-bundle.md)) are untouched.

## Decision

**A red check blocks only when the base branch's declared required set names its context.**

The required set is read from the base branch the pull request targets, the same read
`heal-ci surface` already performs. A red check outside that set is reported as a note on the pull
request. It never parks a lane, never routes to `heal-ci`, and never makes `diagnose` answer `red`.

The ruling is one definition for every reader of it, not a `heal-ci` local fix. It binds
`fabrika ship checks`, `fabrika heal-ci diagnose`, `fabrika heal-ci logs` and `fabrika review ci`
alike, because all four answer the same question — what blocks this pull request — and the three
open issues resting on that question ([#9570](https://github.com/kamp-us/phoenix/issues/9570),
[#7226](https://github.com/kamp-us/phoenix/issues/7226),
[#9550](https://github.com/kamp-us/phoenix/issues/9550)) are one definition read three ways.

The founder's stated tradeoff is accepted as part of the ruling: a real failure in a non-required
check surfaces only as a note. A check that should block gets added to the required set.

**Binding constraints.**

- The base branch's declared required set is the only source of blocking authority.
- A red outside that set is reported, never blocking, in every verb that reads a head's checks.
- Making a check blocking means adding its context to the ruleset, not to a list in this repository.

**Alternatives not taken.**

- **Extend the denylist.** Adding the CodeQL contexts to `INFORMATIONAL` in
  `packages/fabrika-cli/src/review/rollup.ts` is the cheapest change and leaves ADR 0061 intact, but
  it buys one quiet check at a time: every non-required check the repository gains later reds a
  mergeable pull request once, and someone hand-edits the list after the fact. It also keeps
  blocking authority in this repository's source while GitHub already holds the answer on the base
  branch, so the two can drift.
- **Fix the check and let the old branches drain.**
  [#9562](https://github.com/kamp-us/phoenix/issues/9562) records `Analyze (python)` failing on
  branches cut before `main` carried Python files, and those branches do drain. That removes this
  symptom and leaves the definition as it was, so the next non-required red strands the next pull
  request exactly the same way. It is worth doing on its own merits and is not a ruling on what
  blocks.

**Not ruled here.**

- **What holds when the required set is empty or unreadable.** Ruled since, in the Amendment of
  2026-09-21 (#9597) below, which answers the two states apart. This record no longer sends the
  case away.
- **Arm order in `heal-ci`.** The original report proposed moving `stall.ts`'s ownership arms above
  its `red` arm. `stall.ts`'s own docblock calls the arm order the contract, the ruling does not
  reach it, and under this decision the non-required red that motivated the reorder no longer
  reaches the `red` arm at all. It is out of scope for this record and needs its own.

## Consequences

A merge-eligible pull request is no longer routed to repair by a check that gates nothing, and the
hand-fixed gates of 2026-09-20 stop recurring. The denylist in `review/rollup.ts` stops being the
blocking criterion; whether it survives as a reporting classifier is an implementation question this
record leaves to the change that lands it.

This record is the ruling written down, not the implementation. Each of the four verbs named above
needs its own change: `ship checks`, `heal-ci diagnose` and `heal-ci logs` because they read the
denylist through `isInformational`, and `review ci` because it filters nothing at all and rolls up
every run at the head. The required-set read has to fail closed rather than silently gate nothing.

## Records

- Ruling: [issue 9570, founder comment](https://github.com/kamp-us/phoenix/issues/9570#issuecomment-5753839456).
- Amendment ruling: [issue 9597, ruling comment](https://github.com/kamp-us/phoenix/issues/9597#issuecomment-5754418554).
- Amends in part: [ADR 0061](0061-ship-it-gating-check-set.md).
- no vocabulary impact

## Amendment (2026-09-21, #9597) — an unreadable required set refuses, an empty one falls back to ADR 0061

The Decision above left one case under `Not ruled here`: what holds when the base branch's declared
required set is empty or cannot be read. It is answered now, and the two states are answered apart,
matching the split `packages/fabrika-cli/src/heal-ci/surface.ts` already drew between
`no-requirements` and `unprobeable`.

Ruling, 2026-09-20, made by the driver under the standing engine-loop grant
([#8807](https://github.com/kamp-us/phoenix/issues/8807) R4.1 — pipeline internals are the driver's
call, the founder rules product):
[the ruling comment on issue 9597](https://github.com/kamp-us/phoenix/issues/9597#issuecomment-5754418554).

**The required set could not be read (`unprobeable`): fail closed.** No ship. The verb names the
read failure as the cause, and the lane waits or parks on that cause, never on a check's colour.
Nothing may read this record as permission to merge over an unreadable set. Any read that does not
produce a declared set is this case, whatever failed in it.

**The read succeeded and the base branch declares nothing required (`no-requirements`): fall back to
[ADR 0061](0061-ship-it-gating-check-set.md)'s gating set.** Every non-informational check blocks,
exactly as it did before this record. An empty declaration is a branch nobody has said what gates,
not a branch that gates nothing.

**Why these, and not the whole-question alternative.** The question named two directions that each
covered both states: fail closed everywhere, which is what ADR 0061 had, or refuse outright with
`UNKNOWN` everywhere. Neither is taken whole. Refusing outright is not taken for `no-requirements`,
because it parks every lane on a repository that has simply never declared its checks, and fabrika
has to stay usable there — falling back to ADR 0061 gates that repository instead of stopping it.
Fail-closed-on-colour is not taken for `unprobeable`, because with the authority unread, whether any
red blocks is underivable, so the refusal names the read rather than serving a colour over it. Both
arms keep a ship from going out ungated, which is the case ADR 0061 rejected the required-set
definition over.

**Accepted tradeoff.** On a repository with an empty required set, a non-required red still blocks,
so this record's relief applies only once that repository declares its required checks.

**Scope.** This amendment carries the Decision's binding scope unchanged: it binds all four readers
named there — `fabrika ship checks`, `fabrika heal-ci diagnose`, `fabrika heal-ci logs` and
`fabrika review ci` — because the two zero-signal states are part of the one answer those verbs
share, not a per-verb detail.
