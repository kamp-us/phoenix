---
id: 0424
title: A defect a signed-out visitor can see is never priced below p1
status: accepted
date: 2026-09-27
tags: [process, prioritization, triage, pipeline]
---

# 0424 — A defect a signed-out visitor can see is never priced below p1

**What this decides:** When triage prices a bug that anyone can see without signing in, the band is
`p1` or `p0`, never the `p2` default, however small the fix is.

## Context

Founder ruling, 2026-09-20, recorded on #9553:
<https://github.com/kamp-us/phoenix/issues/9553#issuecomment-5755829364>. This record transcribes
that ruling and adds nothing to it.

The triage rubric (`claude-plugins/fabrika/skills/triage/SKILL.md`, step 7) prices on one sentence:
`p0` for ship-work and fires, `p1` for what you would pull next, `p2` the default. Nothing in it reads
what a visitor sees. So #9541, the kamp.us homepage heading a column "son 24 saat" over posts days
old, was priced `p2` on fix size while following the rubric exactly. The founder objected, and the
band was raised to `p1` by hand.

## Decision

**A defect a signed-out visitor can see is never priced below `p1`.**

The triager judges "a visitor can see it" per issue and says why in the triage note. The rule is
portable prose in the shipped triage skill. There is no per-repo list of public pages and no config
key, so the rule travels unchanged to any repo the triage skill ships to.

The founder accepted the tradeoff: the read is a judgment call, so a few small cosmetic defects get
raised to `p1`. That is cheaper than a visible falsehood sitting at the default.

**Relation to [ADR 0219](0219-priority-decoupled-from-campaign-membership.md).** This record neither
supersedes nor amends 0219. Priority stays decoupled from campaign membership: this rule prices on
what a visitor sees, not on which campaign or milestone the issue belongs to. It is a floor on the
merit read 0219 asks for, not a new input from the roadmap.

**Binding constraints.**

- A defect a signed-out visitor can see is priced `p1` or `p0`, whatever the fix costs.
- The triage note states why the triager judged the defect visible or not.
- The rule is prose in the shipped skill. No repo declares its public surfaces in config for it.
- Campaign or milestone membership stays no argument for any band (ADR 0219).

## Consequences

- **Owed work: the triage rubric text.** Step 7 of `claude-plugins/fabrika/skills/triage/SKILL.md`
  must gain this rule. This record does not make that edit. The skill text is control-plane, so that
  edit carries a CODEOWNERS approval.
- **The active-campaign intake gate gets no exception.** The same skill closes an `active`
  campaign's milestone to new work unless it is `p0` or `p1`, or blocks one of that milestone's
  lanes. Because the gate reads the band, a visible defect priced `p1` under this rule clears it like
  any other `p1`, and that is allowed. There is no interaction to design for: the campaign gate is
  being removed once bets-first picking lands. See the 2026-09-27 entry under `## Amendments`.
- **#9541 matches the rule.** It carries `p1`, the band this rule requires for a false statement on
  a public page.

## Records

- No vocabulary impact.
- Ruling: <https://github.com/kamp-us/phoenix/issues/9553#issuecomment-5755829364>. Incident: #9541.

## Amendments

- **#9553 — the intake-gate question is ruled (2026-09-27).** Founder ruling on criterion 3 of #9553,
  given in the driver session and recorded at
  <https://github.com/kamp-us/phoenix/issues/9553#issuecomment-5858945330>. The founder answered
  "yes" to: "No interaction to design for: the campaign gate is being removed once bets-first picking
  lands (ruling on #9852, <https://github.com/kamp-us/phoenix/issues/9852#issuecomment-5852643522>),
  and bets-first picking is built in epic #9850 (#9857)." So the `p1` floor may change which issues
  clear the active-campaign intake gate, and no exception to that gate is owed.
