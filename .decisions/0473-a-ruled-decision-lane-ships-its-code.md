---
id: 0473
title: A ruled decision lane builds the ruling's record and the code it calls for
status: accepted
date: 2026-10-04
tags: [fabrika, pipeline, decisions, agents]
---

# 0473 — A ruled decision lane builds the ruling's record and the code it calls for

**What this decides:** when a founder has ruled on a `type:decision` issue, the lane that picks it
up writes the ruling down and also builds the code the ruling calls for. Before this, that lane
could only write the record, and the code had to move to a new ticket.

Founder ruling, 2026-10-04, on
[#10516](https://github.com/kamp-us/phoenix/issues/10516):
[the ruling comment](https://github.com/kamp-us/phoenix/issues/10516#issuecomment-5984033730).
The rulings desk asked: "Should a ruled decision ticket be allowed to ship its code in the same
lane?" He picked "Yes, one lane does both" and typed no note. This record transcribes that answer;
the choice is not the author's.

## Context

[ADR 0300](0300-a-cited-ruling-makes-a-decision-buildable.md) opened a ruled decision issue to an
agent lane, but only as transcription: "the deliverable is transcribing that ruling into the ADR or
amendment it names." [ADR 0400](0400-a-relayed-founder-ruling-counts-as-a-quoted-authorization.md)
restated that the builder "transcribes only what the ruling says". The claim's admission line, the
`build` skill and its contract all said the same.

So when a ruled decision issue's acceptance criteria described code, the builder wrote the record,
pushed it with `--partial`, and the code went to a new ticket. On lane 10035 the record merged as
[#10514](https://github.com/kamp-us/phoenix/pull/10514), the lane folded back to `queued`, and the
only route from there was a second build that could only transcribe the same ruling again. The issue
stayed open and the lane had no ending it could record.

## Decision

**A lane on a `type:decision` issue that carries a cited founder ruling builds what the issue's
acceptance criteria ask for: the ADR or amendment that records the ruling, and the code the ruling
calls for, in the same lane.**

- `build claim --cites <url>` admits the lane to both. Its admission line says the deliverable is
  what the criteria ask for, record and code alike.
- The lane ends the way any lane ends. A pull request that meets every criterion says `Fixes #<n>`,
  so its merge closes the issue and the lane records a full `DONE`. A round that leaves a criterion
  unmet pushes `--partial`, the lane folds to `queued`, and the next round may now build the rest.
- The citation still lands inside the record, as 0300 requires.

**What does not change.**

- A `type:decision` issue with no cited founder ruling is still refused at `build claim` on `30`.
- `build pick` still never offers a decision issue; a ruled one is entered by number.
- The audience fence still binds: the issue has to carry `ready-for:agent`.
- The builder still decides nothing. A gap the ruling left open goes back to the founder, and the
  code built is only the code the ruling calls for.

**Not decided here.** The ruling says one lane. It does not say whether the record and the code are
one pull request or two pull requests in that lane, and this record does not pick. Both reach the
ending above. A park cause naming a ticket the remaining work moved to was suggested on #10516 and
is not part of this ruling.

## What this amends

- [ADR 0300](0300-a-cited-ruling-makes-a-decision-buildable.md), in part: its decision sentence
  limits the deliverable to "transcribing that ruling into the ADR or amendment it names", and its
  binding constraint "The builder transcribes only what the ruling says" reads as record-only. Both
  now read as this record states: the lane builds the record and the code the ruling calls for, and
  it still fills no gap the ruling left open. Every other constraint of 0300 stands.
- [ADR 0400](0400-a-relayed-founder-ruling-counts-as-a-quoted-authorization.md), in part: its list of
  what 0300 binds says the builder "transcribes only what the ruling says". That clause now reads as
  above. The rest of 0400 is unchanged.

## Consequences

A ruled decision costs one lane, not a lane plus a new ticket that gets filed, triaged and sometimes
approved again. The lane reaches a recorded ending through the ordinary merge, with no new park
cause and no person closing the issue by hand.

The cost is a wider lane on a decision issue. A reviewer grades its code against the issue's
criteria like any other code, and the fence against deciding is the same one 0300 named: the
builder's discipline plus the cited ruling a reviewer can read in the diff.

## Records

no vocabulary impact
