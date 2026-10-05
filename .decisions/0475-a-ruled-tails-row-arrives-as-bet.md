---
id: 0475
title: A ruled Tails row arrives at the table as bet, up to the week's free rows
status: accepted
date: 2026-10-05
tags: [fabrika, governance, pipeline]
---

# 0475 — A ruled Tails row arrives at the table as bet, up to the week's free rows

**What this decides:** `table prep` may write Stage `bet` on a Tails row whose issue the founder
already ruled on, because that ruling is his yes. It does so only in a repository that turns it on,
and only for as many rows as the running bets leave free.

## Context

ADR [0425](0425-a-bet-set-on-founder-say-so-approves.md) lets an agent set a row's Stage to `bet`
under the founder's token, and counts that as his approval of the row's pitch. Its binding
constraint reads: "An agent sets `bet` only on the founder's instruction."

Every week `table prep` brought each ruled-but-unbuilt issue onto the table at `proposed`, with a
Rec saying "yes: you ruled on it". The founder then flipped each one to `bet` by hand: 24 of them at
the 2026-10-03 table. Looking at those rows he said, as recorded on
[#10351](https://github.com/kamp-us/phoenix/issues/10351):

> also going through the tails, i think if i already said yes, they can actually come as bet into
> the table, wdyt?

and, pointing at the rows still reading `proposed`:

> i a mtalking about these ones

The next day the rulings desk asked him "Cap how many arrive per week?" He picked "Cap at the
week's free slots" over "No cap"
([#10351, comment 5983086943](https://github.com/kamp-us/phoenix/issues/10351#issuecomment-5983086943)).

## Decision

**A ruled Tails row arrives as `bet` where `table.ruledStage` is `bet`, and only while the running
bets leave rows of `table.agendaCap` free.**

- **Which rows.** Only a row prep put on the agenda because its issue carries a standing ruling
  (the `Ruled` candidate). A follow-up under a closed epic, a customer report, a pitched epic and a
  flagged bet never arrive as `bet` this way. A ruled row whose group holds a `ready-for:human`
  issue still waits on a pick, so it arrives `proposed`.
- **How many.** Every open `bet` row already on the table takes one row of the agenda cap. Ruled
  rows fill what is left, oldest ruling first, and the rest arrive `proposed`. A ruled issue the cap
  leaves off the agenda gets no row, as before. This is how this record reads "the week's free
  slots": the cap stops bets from piling up week over week, which is the risk the desk asked about.
- **Who turns it on.** `table.ruledStage` ships as `proposed`, so an adopter's table is unchanged
  until it opts in. Phoenix sets it to `bet` in its own `.fabrika.jsonc`.

**Binding constraints.**

- Prep writes `bet` only on a `Ruled` row. The agenda row type carries the ruling on its `Bet`
  variant, so no other kind of row can be written as `bet`.
- The free-row bound is never skipped: with no free row, a ruled row arrives `proposed`.

## Consequences

**The founder's job at the table becomes leave it or pull it** for the rows he already ruled on.

**Each such `bet` is a pitch approval under 0425**, given once for every ruled row by the
2026-10-03 instruction above rather than one click at a time. The appetite half of 0425 is
unchanged: the approval binds the appetite the pitch writes, never the Size cell alone.

**A week with many running bets brings ruled rows in as `proposed` again.** That is the cap
working, not a fault.

## Records

- Amends in part ADR [0425](0425-a-bet-set-on-founder-say-so-approves.md): its "An agent sets `bet`
  only on the founder's instruction" now reads with this standing instruction for ruled rows, bound
  as above.
- Transcribes the founder's words recorded on
  [#10351](https://github.com/kamp-us/phoenix/issues/10351) and his ruling on
  [#10351, comment 5983086943](https://github.com/kamp-us/phoenix/issues/10351#issuecomment-5983086943),
  per ADR [0300](0300-a-cited-ruling-makes-a-decision-buildable.md).
- The code is `agendaOf` and `prepPlan` in `packages/fabrika-cli/src/table/agenda.ts`, and the
  `ruledStage` key in `packages/fabrika-cli/src/config/keys/table.ts`.

Vocabulary impact: none coined.
