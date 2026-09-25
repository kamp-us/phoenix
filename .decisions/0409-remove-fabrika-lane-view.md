---
id: 0409
title: fabrika ships no lane viewer, and `lane view` is removed rather than vendored
status: accepted
date: 2026-09-25
tags: [fabrika, lane, viewer, dependencies, retirement]
---

# 0409 — fabrika ships no lane viewer, and `lane view` is removed rather than vendored

**What this decides:** `fabrika lane view` is deleted, fabrika ships nothing in its place, and the
"finished elsewhere" viewer band from ADR [0322](0322-closed-issue-lanes-demote-at-read-time.md) goes
with it.

## Context

`lane view` served the lane viewer from `@demlik/tea/chart`. `@demlik/tea` 0.14 deleted the whole
chart family, the viewer included
([kamp-us/demlik#108](https://github.com/kamp-us/demlik/pull/108), under demlik's ADR 0016). `lane
view` was the viewer's only consumer in fabrika. Keeping the verb held fabrika-cli on tea 0.12.0, and
that pin raised the vitest peer warning in [#9771](https://github.com/kamp-us/phoenix/issues/9771).
Nothing else in fabrika calls the viewer, and the viewer was premature.

Two live records name the verb. ADR 0322 decides that `lane view` renders a board-closed lane in a
"finished elsewhere" band. ADR [0365](0365-a-board-closed-lane-ends-in-a-recorded-terminal.md) says
that band is still correct. ADR [0305](0305-v1-cli-deletion-retires-three-git-boundary-guards.md)
requires a deletion like this to carry its own authorizing record, so that the corpus does not keep
describing a surface nobody ships. This is that record.

The ruling is Can's (founder), 2026-09-24/25, agreed with Umut:
https://github.com/kamp-us/phoenix/issues/9771#issuecomment-5826967280.

## Decision

**`fabrika lane view` is removed, and it is not replaced by another viewer or by a vendored copy of
tea's.**

- The verb, its page and its tests are deleted.
- 0322's viewer band is withdrawn, and so is 0365's statement that the band is still correct. The rest
  of both records stands. 0365's `lane settle` terminals are what keep a board-closed lane from
  holding a seat, and they never depended on the viewer.
- fabrika-cli moves to `@demlik/tea` 0.18.0 through a `catalogs.fabrika` entry, pinned exactly. That
  entry is a stopgap until [#9787](https://github.com/kamp-us/phoenix/issues/9787) folds every tea
  consumer onto one root pin.

**Banned.** Re-adding a lane viewer to fabrika-cli, or vendoring tea's deleted chart code, without a
record that supersedes this one.

## Consequences

The tea pin moves forward and the vitest peer warning goes away. Open issues about `lane view` are
moot. To see a lane's state, an operator runs `lane status` or `lane history`.

## Records

- Issue: https://github.com/kamp-us/phoenix/issues/9771
- Ruling: https://github.com/kamp-us/phoenix/issues/9771#issuecomment-5826967280
- Amends in part: ADR [0322](0322-closed-issue-lanes-demote-at-read-time.md), ADR
  [0365](0365-a-board-closed-lane-ends-in-a-recorded-terminal.md)
- Authorizing-record rule: ADR [0305](0305-v1-cli-deletion-retires-three-git-boundary-guards.md)
- no vocabulary impact
