---
id: 0354
title: A running campaign admits p0 and p1, not p0 alone
status: accepted
date: 2026-09-05
tags: [fabrika, pipeline, roadmap]
---

# 0354 — A running campaign admits p0 and p1, not p0 alone

**What this decides:** a milestone pinned by an `active` campaign row admits new `p0` and `p1` work,
plus anything that blocks one of that milestone's own in-flight lanes. Only `p2` stays out.

## Context

ADR [0304](0304-campaign-active-is-the-dispatch-permission.md) makes a campaign's `State` cell the
dispatch permission. On top of it a second, narrower rule grew: a milestone whose campaign is
`active` is marked `running` and closed to new intake unless the work is `p0` or blocks one of that
milestone's own in-flight lanes. That narrowing was never recorded — it lived only in
`triage homes`'s `RUNNING_MARKER` and in the triage contract's prose, so no ADR carried its why and
no ADR could be amended to change it.

The narrowing was meant to keep a campaign that is being executed from filling with churn. What it
did instead was refuse work the founder wanted in his daily-driver milestone. On 2026-09-05 four
issues parked at `status:needs-info` against milestone #52 — #7882, #7894, #7933 and #7958's
neighbour — each needing a founder word to enter a milestone he was actively using. Every refusal
cost him a question.

Founder ruling, 2026-09-05, recorded on
[#7974, comment 5553978768](https://github.com/kamp-us/phoenix/issues/7974#issuecomment-5553978768),
verbatim, after being asked whether #7882 belongs in #52 at `p1`:

> yes, also let's change that rule to become p0 and p1s

This record is that ruling written down, per ADR
[0300](0300-a-cited-ruling-makes-a-decision-buildable.md); the citation above is what made the
decision issue agent-buildable.

`p1` is already "what you would genuinely pull next"
([`skills/triage/SKILL.md`](../claude-plugins/fabrika/skills/triage/SKILL.md) §7), which is the band
a founder hand-admits anyway. `p2` — the default, and what the same rubric calls the band for work
that is real but not next — is what the fence is left holding.

## Decision

**A `running` milestone admits `p0` and `p1` work, and work that blocks one of its own in-flight
lanes. `p2` is the only band the fence subtracts.**

- **The blocker clause is untouched.** This widens the band; it does not replace the exception.
- **The marker moves with the rule.** `RUNNING_MARKER` in
  [`homes-verb.ts`](../packages/fabrika-cli/src/triage/homes-verb.ts) reads
  `running: p0/p1 or blocker`, on both the text column and the `--json` `running` key — the marker
  is one string behind both channels, so the two cannot state different rules.
- **Nothing else about `running` changes.** Which milestone is running is still the `## Campaigns`
  `State` cell (ADR 0304), a marked row is still listed rather than removed, and the marker still
  states a subtraction and names no destination.
- **Priority stays decoupled from membership.** ADR
  [0219](0219-priority-decoupled-from-campaign-membership.md) holds: homing work in a campaign
  earns it no band. This rule reads a band that was already assigned on merit; it never confers one.

## Consequences

**The fence keeps only the churn it was built for.** `p2` is the band the rubric already calls
not-next, so subtracting it is the whole original intent minus the collateral. What the founder was
hand-admitting one question at a time now admits itself.

**Six surfaces carry the old wording and move together.** The verb's constant and docblock, its unit
test, the `homes` subcommand help text, the triage contract's `triage homes` section (prose, verb
table row, text example, `--json` example), the triage skill's step 6, and the guide's sample rows.
A change that lands the marker without the prose ships a spec and a marker that disagree.

**One documented drift is corrected on the way.** The contract documented the `--json` value as the
marker without its `running: ` prefix, but the verb assigns `RUNNING_MARKER` whole, so what it emits
carries the prefix on both channels. The source is authoritative; the contract now says what the verb
emits.

## Records

Fixes [#7974](https://github.com/kamp-us/phoenix/issues/7974). Amends in part ADR
[0304](0304-campaign-active-is-the-dispatch-permission.md): its `State`-cell dispatch permission and
every binding constraint stand, and only the intake band a marked milestone admits moves. Neighbours
cited rather than changed: ADR [0219](0219-priority-decoupled-from-campaign-membership.md)
(membership confers no band), ADR [0222](0222-p0-is-the-arc-pullable-frontier.md) (`p0`), and ADR
[0202](0202-forward-motion-doctrine-crewops.md) (the forward-motion pricing the bands are judged on).
