---
id: 0416
title: An integrate FAIL missing its pair gets it from a driver-appended correction
status: accepted
date: 2026-09-27
tags: [lane, ledger]
---

# 0416 — An integrate FAIL missing its pair gets it from a driver-appended correction

**What this decides:** a lane whose integrate `FAIL` was recorded without its exit and assembly head
can get them later, on an appended `CORRECTED` line a driver writes with `lane attach-integrate`.

## Context

`build claim` reads an epic child's integrate `FAIL` as a repair round only off the
`integrate: {exit, head}` pair on the ledger line. A lane that recorded its `FAIL` before the pair
existed holds a pair-less line, and the child's task has already folded from `integrate` back into
`build`. There `lane report` refuses the pair at `68`, so re-running `lane integrate` and reporting a
new `FAIL` cannot add it, and the builder's claim refuses on `31`. The lane is wedged
([#9882](https://github.com/kamp-us/phoenix/issues/9882)).

ADR [0350](0350-a-correction-supersedes-a-recorded-line.md) already has the append-only tool: a
`<TASK>.CORRECTED` line that names an earlier line by its `at` and supersedes its payload. But it
makes only `partial` corrigible, says widening that is a decision rather than an extension, and names
`lane reconcile` as the one verb that appends a correction. This record is that decision, and it
amends 0350 in part.

## Decision

**`integrate` joins `partial` as a corrigible payload, and `lane attach-integrate` is its writer.**

1. A `CORRECTED` line carries `corrects` and exactly one of `partial` or `integrate`. The fold writes
   an `integrate` correction onto the entry it names, and only onto a `FAIL`; one naming any other
   event is a defect that makes the correction set undecidable, never a silent no-op.
2. `lane attach-integrate` appends it, run by a driver by hand. It judges before and under the ledger
   lock and appends only onto a `FAIL` recorded out of `integrate` that no later `DONE` on the task
   has answered, whose recorded line carries no pair of its own, with an exit of `42`, `43` or `44`
   and a head that is a commit sha. Every refusal leaves the log byte-identical.
3. A `FAIL` an earlier attach already paired is not refused. The second `CORRECTED` supersedes the
   first, exactly as 0350 item 2 orders any two corrections over one line, which is how a wrong exit
   or head is fixed.
4. `build claim` and `build resume-child` read the ledger with corrections applied, and an
   undecidable correction set refuses the claim as UNKNOWN rather than reading the raw lines.

**Binding constraints.**

- The attach never re-routes a round the lane walked past. The pair is admission evidence for
  `build claim`; the machine holds no cell that reads it, so the task stays where it stood.
- An integrate `FAIL` a later `DONE` answered stays retired. Attaching to it would reopen a repair
  nobody owes.
- No other payload becomes corrigible by this record. `partial` and `integrate` are the whole set,
  and widening it again is again a decision.

## Relationship to ADR 0350

0350 stands except where this widens it: its Consequence "only `partial` is corrigible today" now
reads `partial` and `integrate`, and its Decision item 1 and its 0297 section, which name
`lane reconcile` as the one writer, now have a second one in `lane attach-integrate`. The concern
behind 0350's fence, a sweep re-routing rounds a lane has walked past, does not reach this payload:
the pair routes nothing in the fold, and the verb is not a sweep but a driver naming one line.

## Consequences

- Wedged lanes from before the pair existed have a runnable way out, and nothing in `events.jsonl`
  is rewritten. `lane history` prints the `FAIL` and the correction beside it.
- The driver supplies the exit and head from the integrate run's own output. The verb checks their
  shape, not that they match that run, so a wrong pair is fixed by attaching again.

## Records

no vocabulary impact
