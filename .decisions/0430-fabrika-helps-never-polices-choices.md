---
id: 0430
title: A fabrika guard stops a real failure, never a choice a teammate, agent or repo may make
status: accepted
date: 2026-09-27
tags: [fabrika, governance, pipeline]
---

# 0430 — A fabrika guard stops a real failure, never a choice a teammate, agent or repo may make

**What this decides:** fabrika is there to help teams, solo devs and agents. It does not add a
guard just to stop someone from making a choice they are allowed to make. When a gap is only
"nothing checks who set X" or "a repo can set Y loosely", that is the team's or the repo's call.

## Context

ADR [0429](0429-size-stop-parks-at-multiple.md) left two questions open for the founder. Both were
about who can loosen the size stop.

- [#10065](https://github.com/kamp-us/phoenix/issues/10065): the size stop reads a row's Size
  cell, and nothing checks who set that cell.
- [#10066](https://github.com/kamp-us/phoenix/issues/10066): `table.stopMultiple` has no upper
  bound, so a repo can raise the stop as high as it likes.

The founder ruled on both on 2026-09-27. On #10065, verbatim:

> no, dont […] complicate shit, this is team trust issue, not something fabrika needs to solve itself.

On #10066, verbatim:

> same thing, repo's choice, close it

Then he made it the general rule, verbatim:

> tbh, this should be how we should approach things all the time. fabrika is there to help the
> teams, solo devs, agents. not constraint them for everything

This record writes that down, per ADR [0300](0300-a-cited-ruling-makes-a-decision-buildable.md),
so the next gap of this kind gets the same answer without a new ruling.

## Decision

**A fabrika guard exists to stop a real failure, never to stop a teammate, agent or repo from
making a choice it is allowed to make.**

- **The test.** A reviewer or triager asks one question of a proposed guard or a reported gap: does
  it stop a real failure, or does it only stop someone from making a choice? A real failure is a
  bug, an accident, a leak, or a bypass of the founder's control-plane approval. If it only stops a
  choice, close it as not planned.
- **Who set it.** A gap that is really "nothing checks who set X" is a team trust question. The
  default answer is no new guard.
- **How loose a repo sets it.** A gap that is really "a repo can configure Y loosely" is the repo's
  call. Config stays permissive. Defaults and flags can guide, but fabrika does not cap the value.
- **What stays.** This retires no guard against failures. Guards against bugs, accidents and leaks
  stay in scope, and so does the founder's control-plane approval gate. Hardening against failures
  is still the work.

**How this fits the records it touches.**

- ADR [0210](0210-direction-binds-at-intake.md) still binds. The founder still approves the pitch
  and its appetite, and an agent may still only draft one. ADR
  [0425](0425-a-bet-set-on-founder-say-so-approves.md) still ties that approval to the size the
  pitch writes. This record does not touch either.
- What this record adds: fabrika does not police who edits the Size cell afterwards. That is team
  trust, per the #10065 ruling. 0210's ban on "agent-set appetites" is a rule the team keeps, not a
  check fabrika adds.
- ADR [0429](0429-size-stop-parks-at-multiple.md) still decides how the size stop works. This record
  answers its two open questions: no ceiling on `table.stopMultiple`, and no check on who set the
  Size cell. Both are the repo's or team's call.

**Binding constraints.**

- A gap whose only harm is that someone may make a choice they are allowed to make is closed as not
  planned. It does not get a new guard.
- A config key is not capped just because a repo could set it loosely.

**Banned.**

- Using this record to drop a guard that stops a bug, an accident, a leak, or a bypass of the
  control-plane approval gate.

## Consequences

**Fewer guards to build and keep.** Gaps like #10065 and #10066 close at triage instead of turning
into new checks.

**A team or repo can loosen things fabrika used to be asked to hold.** That is on purpose. Trust
between teammates carries it, not a check.

**Reviewers need to tell the two kinds apart.** The test above is the one question they ask. When
it is unclear, the gap is triaged like any other, not closed on this record alone.

## Records

- First applications: [#10065](https://github.com/kamp-us/phoenix/issues/10065) and
  [#10066](https://github.com/kamp-us/phoenix/issues/10066), both closed as the team's or repo's
  call.
- Relates to ADR [0210](0210-direction-binds-at-intake.md), ADR
  [0425](0425-a-bet-set-on-founder-say-so-approves.md) and ADR
  [0429](0429-size-stop-parks-at-multiple.md) as set out under Decision. It amends none of them.
- Founder ruling of 2026-09-27, quoted in Context, per ADR
  [0300](0300-a-cited-ruling-makes-a-decision-buildable.md) as amended by ADR
  [0400](0400-a-relayed-founder-ruling-counts-as-a-quoted-authorization.md).
- Same stance as ADR [0417](0417-campaigns-are-themes-not-dispatch-permission.md): fabrika guides
  work, it does not refuse it.
- no vocabulary impact
