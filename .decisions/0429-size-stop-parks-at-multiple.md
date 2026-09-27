---
id: 0429
title: An overspent bet is flagged past its size and parks only at a configured multiple of it
status: accepted
date: 2026-09-27
tags: [fabrika, governance, roadmap, pipeline]
---

# 0429 — An overspent bet is flagged past its size and parks only at a configured multiple of it

**What this decides:** a lane whose bet spends past its size keeps going and is flagged onto the
next table. It parks only when the spend reaches a configured multiple of the size, 2 by default.
This replaces ADR 0210's rule that a bet parks as soon as its appetite is exhausted.

## Context

ADR [0210](0210-direction-binds-at-intake.md) makes the appetite a circuit breaker: "a bet that
exhausts its appetite auto-parks and requires a founder re-pitch". Its binding constraints say the
same: "An appetite-exhausted bet auto-parks pending founder re-pitch — never silently continues."

Epic [#9850](https://github.com/kamp-us/phoenix/issues/9850) writes the appetite as a **size** on
the weekly table, and builds a breaker that does not fire at the size. Spend past the size raises
the over-size flag and the lane keeps going. The lane stops only at `table.stopMultiple` times the
size ([`size-stop.ts`](../packages/fabrika-cli/src/table/size-stop.ts),
[`flags.ts`](../packages/fabrika-cli/src/table/flags.ts),
[`config/keys/table.ts`](../packages/fabrika-cli/src/config/keys/table.ts)). The governance verdict
on [PR #9947](https://github.com/kamp-us/phoenix/pull/9947) failed that breaker against 0210,
because no record amended 0210 on it.

The founder ruled on this on grilling session #9821, question R11.1. The question was put in
[round 11](https://github.com/kamp-us/phoenix/issues/9821#issuecomment-5850970727), verbatim:

> What does a lane do when it spends past its size? It keeps going and is flagged onto the next
> table with a rec (extend, re-shape, or drop). It stops only at 2× its size. Both the flag point
> and the stop multiple are configurable.

He ruled it on 2026-09-26, recorded by the
[`grill-ruled: R11.1` marker](https://github.com/kamp-us/phoenix/issues/9821#issuecomment-5850971335)
(`grill read 9821` reads it as `ruled`, proof `acl+authorization`). The ruling sits under R10.3 on
the same session: guide work with defaults, visible flags and configurable guardrails, never by
refusing work.

This record writes that ruling down, per ADR
[0300](0300-a-cited-ruling-makes-a-decision-buildable.md). It decides nothing the ruling left open.

## Decision

**Spend past a bet's size is a flag, not a park. The breaker parks the bet's lanes only at a
configured multiple of its size.**

- **The flag.** A row whose spend passes `table.flagMultiple` times its size (1 by default, so as
  soon as it passes the size) comes back to the next table with a rec: extend, re-shape or drop.
  Its lanes keep going.
- **The stop.** A row whose spend reaches `table.stopMultiple` times its size (2 by default) parks
  its lanes. `lane brief` refuses at exit 71 before the next shell, and the lane records
  `BLOCKED --cause size-stop`. It stays parked until the table extends, re-shapes or drops the bet.
  That table call is where 0210's re-pitch now happens.
- **Both points are configurable,** as the ruling says. The order the ruling states is kept: the
  flag comes first, and the stop comes past the size. So `flagMultiple` is at least 1,
  `stopMultiple` is above 1, and `flagMultiple` is below `stopMultiple`.

**Binding constraints.**

- Spend short of the stop multiple never parks a lane. It is a flag.
- A stopped bet goes back to the table. A lane never resumes past the stop on its own.

**Left open, for the founder.** The ruling does not answer these, so this record decides neither.

- **A ceiling on `stopMultiple`.** The ruling sets none, and neither does this record. The key can
  be raised without limit in `.fabrika.jsonc`. Put to the founder on
  [#10066](https://github.com/kamp-us/phoenix/issues/10066).
- **Who may set the Size that prices the stop.** The flag and the stop are priced by the row's Size
  cell, and nothing checks who set it. ADR 0210 bans "agent-set appetites". ADR
  [0425](0425-a-bet-set-on-founder-say-so-approves.md) leaves the same question open. Put to the
  founder on [#10065](https://github.com/kamp-us/phoenix/issues/10065).

## Consequences

**A bet can overspend its size, up to the stop multiple, before anything parks it.** The round
that put R11.1 named that trade-off: up to a week of spend between the flag and the next table, capped at 2× by
default.

**The founder sees an overspend at the next table rather than a stalled lane.** A lane is parked
only once it reaches the multiple.

## Records

- Amends in part ADR [0210](0210-direction-binds-at-intake.md): its "Appetite is a circuit breaker"
  bullet and its "An appetite-exhausted bet auto-parks" binding constraint now read with this rule.
  Spend past the size is a flag, and the park is at `table.stopMultiple` times the size. The rest of
  0210 stands, including that the appetite number is a founder seat.
- Transcribes founder ruling R11.1 on
  [#9821](https://github.com/kamp-us/phoenix/issues/9821#issuecomment-5850971335), per ADR
  [0300](0300-a-cited-ruling-makes-a-decision-buildable.md).
- The code is `readSizeStop`, `stopOf` and the `table.flagMultiple` / `table.stopMultiple` keys
  under `packages/fabrika-cli/src/`, from
  [#9858](https://github.com/kamp-us/phoenix/issues/9858) under epic #9850. ADR
  [0417](0417-campaigns-are-themes-not-dispatch-permission.md) names the same stop in its coverage
  table.

Vocabulary impact: none coined. The `.glossary/TERMS.md` rows for **appetite**, **size** and
**park / expiry** name the flag and stop keys.
