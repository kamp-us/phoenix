---
id: 0425
title: A table bet set on the founder's say-so approves a pitch at the size its pitch states, never at the Size cell alone
status: accepted
date: 2026-09-27
tags: [fabrika, governance, roadmap, pipeline]
---

# 0425 — A table bet set on the founder's say-so approves a pitch at the size its pitch states, never at the Size cell alone

**What this decides:** an agent working under the founder's GitHub token may set a table row's
Stage to `bet` when he tells it to, and that counts as his approval of the pitch. The approval is
for the appetite the pitch itself writes down. The row's Size cell must match that appetite, and
it never stands in for it.

## Context

ADR [0210](0210-direction-binds-at-intake.md) makes pitch approval and the appetite number founder
seats. Its binding constraint reads "Pitch approval and the appetite number are founder seats; an
agent may draft, never approve", and its Banned list names "Agent-approved pitches or agent-set
appetites."

Epic [#9850](https://github.com/kamp-us/phoenix/issues/9850) adds a second way to approve a pitch.
A row on the weekly table whose Stage is `bet` counts, next to the `pitch-approved:` comment
(`guard pitch-guard check`, `resolveBetApproval` in
[`packages/fabrika-cli/src/guard/pitch.ts`](../packages/fabrika-cli/src/guard/pitch.ts)). A project
field value carries no provenance stamp. So the guard cannot tell the founder's click from an
agent's write under his token. It checks only that the account that set the Stage has `write+`.

The governance verdict on [PR #9947](https://github.com/kamp-us/phoenix/pull/9947) failed that arm
against 0210. No record amended 0210, and the guard never checked who set the Size cell either.

Founder ruling, 2026-09-26, recorded on
[#9913, comment 5852689315](https://github.com/kamp-us/phoenix/issues/9913#issuecomment-5852689315).
The question put to him: an agent acting under the founder's GitHub token can set a row to `bet`,
and that counts as the pitch approval. Is that acceptable, given that agents set `bet` only on his
instruction, the same as they post `pitch-approved:` comments today (R22.1: an agent on his token
is his agent)? His answer, verbatim:

> yes

This record writes that ruling down, per ADR
[0300](0300-a-cited-ruling-makes-a-decision-buildable.md). The ruling answers who may set `bet`. It
does not say an agent-set Size cell may stand in for the founder's appetite number. So this record
keeps the Size cell out of the approval, on the side 0210 already takes.

## Decision

**A `bet` set under the founder's token on his instruction approves the pitch, and it approves the
appetite the pitch body writes, never a number the Size cell alone supplies.**

- **Who may set it.** The account that sets the Stage to `bet` must hold `write+`. The founder
  clicking it, and an agent writing it under his token because he said so, both count. An agent
  sets `bet` only on his instruction, exactly as it posts a `pitch-approved:` comment only on his
  instruction.
- **What it approves.** The appetite the approval binds to is the one the pitch's `Appetite` line
  writes. On a row's head, the row's Size must equal that size, or the guard reports a mismatch and
  asks for re-approval. A legacy `<N> cycles` pitch is approved only by comment.
- **Group rows.** A `bet` on an epic or chain row approves every member, per the founder ruling on
  [#9856, comment 5852710907](https://github.com/kamp-us/phoenix/issues/9856#issuecomment-5852710907).
  Each member keeps the appetite its own pitch writes. The row approves members only while its Size
  equals the size its head's pitch writes. If the head has no readable pitch, a legacy cycles
  appetite, or a different size, the row approves no member.
- **The comment arm is unchanged.** A `pitch-approved:` comment with an agent provenance stamp still
  never approves.

**Binding constraints.**

- The Size cell never supplies or overrides a pitch's appetite. It only has to match one a pitch
  body wrote.
- An agent sets `bet` only on the founder's instruction.

**Left open, for the founder.** Nothing checks who set the Size cell, and the table's over-size flag
and 2x stop price a row's spend by that cell. Whether a Size an agent set may serve as the founder's
appetite number for that spend limit is not answered by the ruling. This record does not decide it.

## Consequences

**The founder can approve a week's bets from the table.** He no longer has to post one comment per
pitch.

**The approval still binds a written appetite.** An agent that edits a Size cell cannot move what a
pitch is approved for. A wrong Size shows up as a refusal that names both sizes.

**A chain whose head has no sized pitch approves nothing through its row.** Its members need their
own approval until the head is pitched at the row's Size.

## Records

- Amends in part ADR [0210](0210-direction-binds-at-intake.md): its "an agent may draft, never
  approve" and its ban on "Agent-approved pitches" now read with this exception. A `bet` an agent
  sets under the founder's token on his instruction is his approval. The appetite half of 0210
  stands: the appetite approved is the one the pitch writes, never one an agent set in the Size
  cell alone.
- Transcribes the founder ruling on
  [#9913, comment 5852689315](https://github.com/kamp-us/phoenix/issues/9913#issuecomment-5852689315),
  per ADR [0300](0300-a-cited-ruling-makes-a-decision-buildable.md) as amended by ADR
  [0400](0400-a-relayed-founder-ruling-counts-as-a-quoted-authorization.md), since the ruling was
  given in a driver session and posted verbatim.
- The code is `resolveBetApproval` and `readBetTable` in `packages/fabrika-cli/src/guard/`, from
  [#9856](https://github.com/kamp-us/phoenix/issues/9856) and
  [#9913](https://github.com/kamp-us/phoenix/issues/9913) under epic #9850.

Vocabulary impact: none coined. The `.glossary/TERMS.md` rows for **pitch** and **appetite**
already name the `bet` carrier and cite the same two rulings.
