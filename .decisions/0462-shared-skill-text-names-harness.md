---
id: 0462
title: Shared skill text states the plain rule first and names the harness beside its knob
status: accepted
date: 2026-10-04
tags: [fabrika, skills, harness, conventions]
---

# 0462 — Shared skill text states the plain rule first and names the harness beside its knob

**What this decides:** when a fabrika skill tells the reader to use a control that only one harness
has, it first says the rule in words every harness can follow, then names that harness next to the
control.

## Context

[ADR 0367](0367-codex-is-a-supported-harness.md) admits Codex alongside Claude Code and pi and binds
"Shared skills remain the stage contract". One skill text is read on all three.

The `review` skill's CI-wait step told the reader to set "the Bash tool's own `timeout`", with its
`600000` ms ceiling and the `BASH_MAX_TIMEOUT_MS` escape. Those are Claude Code's. A Codex or pi
shell reading the step finds a control with a different name, or none.
[#9104](https://github.com/kamp-us/phoenix/issues/9104) filed that, and noted the fabrika skill
conventions carried no rule for it, so each author decided per sentence. A second copy of the same
paragraph was already queued for the `ship` skill
([#9103](https://github.com/kamp-us/phoenix/issues/9103)).

[ADR 0379](0379-audit-selection-through-conversation.md) is adjacent and does not cover this. It
rules that a skill uses its current harness's native tools and never launches another harness. This
record is about the other direction: shared prose naming one harness's control.

#9104 put three options to the founder: write the shape down as a convention and sweep the corpus,
reword `review` only, or leave it. The ruling is recorded on
[#9104, comment 5625299764](https://github.com/kamp-us/phoenix/issues/9104#issuecomment-5625299764),
2026-09-10, by an EA session on the founder's behalf. The question it put and the answer:

> Asked: Should shared skill text always state the plain rule first and name the tool when it names
> that tool's knob, written down once as a convention?
>
> Ruled: the recommended answer stands — yes.

This record is that ruling written down, per
[ADR 0300](0300-a-cited-ruling-makes-a-decision-buildable.md).

## Decision

**Shared skill text states the plain rule first, and names the harness whenever it names that
harness's knob.**

- **The rule lives once, in the conventions.** Its home is
  [`skill-conventions.md` §15](../claude-plugins/fabrika/docs/skill-conventions.md#15-the-plain-rule-first-then-the-harness-beside-its-knob).
  A skill follows it and does not restate it.
- **The shape is rule, then instance.** The harness-free rule comes first. The harness-named
  instance follows, and carries every number that belongs to the knob.
- **The corpus is swept once against it.** The `review` CI-wait paragraph and its contract are
  reworded, and every other hit under the fabrika skills tree is reworded or listed with why it
  stays, in the pull request that lands this record.

The ruling does not say what counts as a knob beyond the question's own words. The convention reads
it as a control the step tells the reader to operate. Text that only describes what a harness does,
with nothing for the reader to set, is not ruled here.

## Consequences

**A reader on any harness can finish the step.** The plain rule is enough to act on, and a named
instance tells the other readers it is not theirs.

**#9103 copies the new shape.** Whatever mirrors the CI-wait paragraph into `ship` mirrors the rule
and the Claude Code instance, not the bare knob.

**A new harness adds instances, not rules.** Admitting one means writing its instance where a step
has one, once someone has run the step there.

**One verb's refusal text still names the knob bare.** `ship scope`'s exit-`33` line says
`isolation: worktree` with no harness. That string is CLI source, outside the skill text this sweep
covers, and is filed as [#10463](https://github.com/kamp-us/phoenix/issues/10463).

## Records

- Source: [#9104](https://github.com/kamp-us/phoenix/issues/9104) and its ruling comment.
- No vocabulary impact.
