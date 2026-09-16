---
id: 0396
title: The head's diff decides the classes a review round owes; the triage stamp decides the first build
status: accepted
date: 2026-09-16
tags: [fabrika, lane, review, ui, guards]
---

# 0396 — The head's diff decides the classes a review round owes

**What this decides:** a lane's `classes` mean the ticket's kind only while no head exists. Once a
pull request exists, every stage reads the classes off that head's diff. The triage `class:ui` stamp
still routes the first build to `build:ui`; a head with no rendered file owes no `review-ui` round
and no hand-verification.

Founder ruling, 2026-09-15 PT, on
[#9169](https://github.com/kamp-us/phoenix/issues/9169):
[the ruling comment](https://github.com/kamp-us/phoenix/issues/9169#issuecomment-5688656577).
This record transcribes it; the choice is not the author's.

## Context

`withPayload` in `packages/fabrika-cli/src/lane/machine.ts` replaces a task's standing `classes`
only when the event carries a `classes` field, and `classesForEvent` in
`packages/fabrika-cli/src/lane/report.ts` maps an empty `--class` set to an omitted field. So an
omitted flag means "no opinion", and the last opinion stands for the rest of the lane.

Two skill contracts read that opposite ways, and both were followed correctly:

- `operate/SKILL.md` told the driver the `WIP`-time class stands from there — "the `PASS` out of
  `review` routes to `review:ui` without you naming it again".
- `review/SKILL.md` told the reviewer to add `--class ui` only when `review scope` printed a
  `routed\treview-ui` row, and never otherwise.

A ticket stamped `class:ui` whose fix turns out text-only satisfies both and still routes into a
rendered round. `review-ui route` refuses a diff with no rendered surface, so the lane parks on a
person — one park per lane, for a namespace no verb derived. `#8000` reproduced it on three lanes;
cansirin's comment on #9169 showed the same stickiness one stage earlier, at the `ISSUE.WIP` after a
cleared park, spawning a ui builder for a text-only lane.

## Decision

**A class is a property of the ticket until a head exists, and a property of the head after that.**

- **The triage stamp keeps the first build.** `triage apply --class ui` stamps the label, the boot
  verb seeds `context.<task>.classes`, and the `queued` → `build:ui` arm routes on it. At that
  moment there is no diff to read, which is exactly what ADR
  [0317](0317-ui-lane-carries-its-own-shells.md) needs, and nothing here touches it.
- **Every stage that has a head relays the head's whole derived class set.** The reviewer relays
  every `class` row `review scope` prints, not the `routed` rows alone, so the relayed set replaces
  the standing one. A driver recording a `WIP` over an existing pull request relays the same
  derivation. `ship scope` and `review scope` print it from one map, so the two cannot disagree.
- **The `WIP` arm reads the same way.** A cleared park's follow-on `WIP` carries the head's classes
  where a head exists, so a text-only lane returns to `build`, not `build:ui`.
- **The machine stays sticky, and the guard sits at the proof.** `withPayload` is unchanged: a state
  machine cannot read a diff, so a narrowing written there would be a guess. `lane prove` is where
  the head is in reach, and it now refuses at exit `67` (`ROUTE_UNDERIVED`) a `PASS` whose standing
  classes route it into a cell the head derives nothing for. The refusal names the relay as its
  remedy.

**This narrows ADR [0320](0320-the-review-bar-splits-across-two-cells-and-the-machine-decides.md).** 0320 decides
that out of `review` a routed namespace is the next cell's, and that "every other `review` `PASS`
still stands on the whole set". That second sentence now has a refusal beside it: a deferred
namespace must also be one this head derives, so a ui-stamped lane whose head is text-only no longer
stands on the whole set and walks into `review:ui` — it refuses at exit `67`. The rest of 0320 is
untouched: the deferral is still derived from the compiled arm rather than from a constant, and a
`PASS` out of `review:ui` still stands on the whole derived set. 0320's frontmatter records this
amendment.

Hand-verification follows the same read. ADR
[0391](0391-hand-verification-binds-ui-content.md) binds hand-verification to ui-file content, and
that stays the guard for the other direction: a head with no ui file derives no `review-ui`
namespace, so nothing asks for the verification in the first place.

## Consequences

- **`classes` means one thing at each end of a lane, and the two are now written down.** Before a
  head it is the ticket's kind; after a head it is that head's kind. The cost the filer named — a
  word meaning two things — is accepted, because the alternative leaves a per-lane human tax on
  every ui-stamped ticket with a text-only fix.
- **A relay that goes stale now refuses instead of parking.** A reviewer who omits the flag over a
  ui-stamped lane gets exit `67` with nothing appended, and re-runs with the head's classes. That is
  a refusal an agent clears in one command, where the old behaviour spent a person.
- **The refusal is head-scoped only.** An epic child's `PASS` defers `review-ui` unconditionally,
  because a child opens no pull request and no verb posts that namespace at range scope. The guard
  reads the head path and leaves the range path byte-identical.
- **#9147 is the opposite direction and is unaffected in shape.** It is about a class that fails to
  carry where it should; the guard this record adds fires only where a class carries and the head
  asks for nothing. Its budget-aware rendered guard is still its own work.
