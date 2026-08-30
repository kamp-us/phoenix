---
id: 0341
title: A twice-failed epic review is a park, not the end of the run
status: accepted
date: 2026-08-29
tags: [fabrika, lane, pipeline, state-machine, epics]
---

# 0341 — A twice-failed epic review is a park, not the end of the run

**What this decides:** `human:epic-review` gets the same `UNBLOCKED` door `frozen` has. An epic run
whose tail spends its review budget is parked for a human, and `operate` reads it `LANE-PARKED`.

## Context

The epic tail's three `FAIL` arms — `review`, `ship`, `ship:queued` — all fall through to
`human:epic-review` once retries are spent
([`packages/fabrika-cli/src/lane/emit.ts`](../packages/fabrika-cli/src/lane/emit.ts), `epicRegion`).
That state was emitted as `{type: "final"}` with no `on` block, while its three sibling parks in the
same region (`blocked`, `human:cp-approval`, `human:queue-stall`) each carry
`UNBLOCKED → hist`. So a tail that failed twice landed in a state `lane transition` refuses at exit
`12`, and the lane read finished.

The omission was deliberate and said so in the source: `human:epic-review` was the safe placeholder
[#5793](https://github.com/kamp-us/phoenix/issues/5793) asked for, and #5793's own acceptance
criteria deferred the routing to a follow-up ruling.
[#6790](https://github.com/kamp-us/phoenix/issues/6790) is that follow-up.

The gap had a second half. `operate`'s SKILL.md routed the state twice, oppositely: §4 said "every
other error final has no door and ends `LANE-TERMINAL`", while the terminal vocabulary keyed
`LANE-PARKED` on `blocked`, `human:*` or `frozen`. `human:epic-review` satisfies both, and the same
section says a park reported as a terminal destroys the caller's routing. Which rule wins is
downstream of the door question, so both settle here.

## Decision

The founder ruled it on
[#6790](https://github.com/kamp-us/phoenix/issues/6790#issuecomment-5465608202): option 1, the
sibling door.

**`human:epic-review` keeps `"type": "final"` and gains `"<TASK>.UNBLOCKED": "hist"`** — exactly the
shape ADR [0297](0297-frozen-is-a-park-not-an-end.md) ruled for `frozen`, and for the same reason:
dropping `final` would take the state out of both `finals` and `errorFinals`, so a failed tail would
stop reading as tripped and the phase would never fold at all. It stays an error final, the tail
phase still trips on it, and the door out stays walkable.

**The door grants no retries.** The resume runs through the region's `hist` cell, which copies the
task's retry count forward, so a resumed tail walks back into the state it left with its budget
still spent. Budget comes from a founder clearance recorded with `build clear` and from nowhere
else. Because the state is an error final whose resume lands in a guarded state, a bare `UNBLOCKED`
with no `CLEARED` behind it is refused on exit `36` — the ADR
[0312](0312-event-anchored-retry-budget.md) gate, which now covers two parks instead of one.

**`operate` reads it `LANE-PARKED`.** The terminal vocabulary's `human:*` clause wins; §4's
"every other error final" sentence gains `human:epic-review` beside `frozen` as its second named
exception. The routing table gets its own row, so a driver reading the fold does not have to derive
the shape from the state's name.

**`recipe unpark` gets no `KNOWN_PARKS` row.** `isPark` already answers true for the leaf — it
starts with `human:` — so `classifyPark` seats it as Novel, and the verb refuses with the ledger
untouched and routes it to a human. That is the right answer: the clearing condition here is a
founder's judgment that the tail deserves another round, which is what `human:cp-approval` waits on
too and which no recipe may grant. Recognised, never cleared autonomously.

Today that classification is not what the verb actually reaches on this park. A lane whose only
unfinished task is the tail folds to the `tripped` terminal, and `leafOf` answers `Finished` for a
terminal `stateValue`, so `recipe unpark` refuses at `NOT_PARKED` before it ever classifies the
leaf. The outcome is the same — a human — and the gap is pre-existing and shared with every
`frozen` park that trips its whole lane, so it is
[#7347](https://github.com/kamp-us/phoenix/issues/7347)'s to close, not this ruling's.

## Consequences

An epic run carrying a fully-reviewed range of children can be recovered after a bad tail review
instead of needing its ledger hand-edited — which is the thing the ledger-is-the-only-state design
exists to avoid. The tail is the most expensive state in the pipeline to lose, and it now has the
recovery every cheaper state already had.

The cost is the one ADR 0297 already accepted: the door can be walked repeatedly, each pass ending
in the same park, and only a recorded clearance buys a round.

`human:epic-review` has trapped no real lane yet, so nothing needs migrating; a lane emitted before
this change carries the old doorless state and is re-emitted, not patched.

## Records

No vocabulary impact. `LANE-PARKED` and `LANE-TERMINAL` are the `operate` skill's own terminal
vocabulary, defined there rather than in `.glossary/TERMS.md`.
