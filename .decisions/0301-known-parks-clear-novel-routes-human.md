---
id: 0301
title: Only a registered recipe proven by a re-fold clears a lane park without a human
status: accepted
date: 2026-08-19
tags: [fabrika, lane, pipeline, recipes, agents]
---

# 0301 — Only a registered recipe proven by a re-fold clears a lane park without a human

**What this decides:** a parked lane gets out on its own only when a recipe table already names that
exact park and a second fold proves the task left it. Every other park goes to a person through a
cell in the machine. No agent ever judges a park clear.

## Context

A lane task parks at `blocked` or at any `human:*` state, and until 2026-08-16 the rule was flat: a
human records the `UNBLOCKED` that walks it out, and the operator never records one. Epic
[#5840](https://github.com/kamp-us/phoenix/issues/5840) put the flat rule to the founder in a grill,
and he qualified it — the answer is recorded verbatim on
[#5840, comment 5311487661](https://github.com/kamp-us/phoenix/issues/5840#issuecomment-5311487661)
("yes, autonomous on known recipes"), with the escalation half on
[comment 5311537313](https://github.com/kamp-us/phoenix/issues/5840#issuecomment-5311537313)
(a novel park goes to the driver first, and to the founder only when it is decision-shaped).

That ruling shipped as code under #5847 and #5848 and has governed real machine behaviour since. It
was never written to `.decisions/`, so the only written authority was skill prose plus an epic body
that closes when the epic does. The corpus had 0228 (a script relays, never derives), 0231 (logic
that computes a decision becomes a verb) and 0283 (the local ledger holds ownable orderings) — verb
shape and ledger placement, none of them about who may clear a park.

This record is a transcription of the founder ruling above, entered under ADR
[0300](0300-a-cited-ruling-makes-a-decision-buildable.md)'s citation arm, not a fresh decision.

**It amends ADR [0297](0297-frozen-is-a-park-not-an-end.md) in part.** 0297 landed after the grill
and restated the flat form as a binding constraint — "clearing a park stays a human's event, as it
already is for `blocked` and `human:*`". Everything else in 0297 stands: `frozen` is still a park
with a door out, the door still hands out no retries, and the operator still records no `UNBLOCKED`.
What narrows is the actor list, which was already narrower in the tree than 0297's sentence read.

## Decision

**A park clears without a human only when a registered recipe classifies it and a re-fold proves the
clear; everything else routes to a person through a cell in the machine, never through an agent's
judgement.**

The split is data, not reasoning. `KNOWN_PARKS` in
[`packages/fabrika-cli/src/recipe/parks.ts`](../packages/fabrika-cli/src/recipe/parks.ts) is a
literal table of park states, one row per park a fixed fix exists for, and `classifyPark` returns
`Known` only on a row it finds. A park with no row is `Novel` — including a bare `blocked`, which
records the event and not the cause, so nothing keys on it.

**The refuse-before-any-write ordering is the load-bearing part.**
[`packages/fabrika-cli/src/recipe/unpark-verb.ts`](../packages/fabrika-cli/src/recipe/unpark-verb.ts)
seats the leaf against the table as step 2 of five, before it reads any clearance and long before it
appends anything. A novel park therefore exits `PARK_NOVEL` with the ledger untouched, so the refusal
is a proven no-op rather than a claim about one. On the other side, the verb emits nothing until step
5 re-folds the ledger and reads the task out of the park; an `UNBLOCKED` appended without that proof
is a fail-loud, not a success.

Those two ends are what make the autonomy safe, and they are what a future widening has to argue
against. "If a known park may clear itself, why not a known FAIL" is the shape to expect: the answer
is that a park names one blocked state with one enumerated cause and one read that proves the cause
gone, while a FAIL is a verdict about content with no such read. Widening this needs a table row and
a proving read, not an analogy.

The novel side is a machine cell, not a message.
[`packages/fabrika-cli/src/lane/templates/chore.workflow.json`](../packages/fabrika-cli/src/lane/templates/chore.workflow.json)
routes every `PARK_SWEEP.BLOCKED` to `human:novel-park`, and only a `PARK_SWEEP.UNBLOCKED` leaves it.
A human's clear is a recorded transition, so it sits in the ledger and survives the session.

**Binding constraints.**

- The exception belongs to a recipe verb, never to the operator. `operate` records no `UNBLOCKED`
  anywhere; it relays `recipe unpark`'s exit into the chore lane's event. ADR 0297's constraint holds
  for the operator unchanged.
- A park is `Known` only by a row in `KNOWN_PARKS`. Reasoning that a park resembles a known one, or
  that its cause looks gone, is not a classification.
- Classification refuses before any write. A verb that reads a clearance, or appends, before it has
  seated the park against the table is not implementing this decision.
- No clear is reported without a re-fold proving it. An unproven append is a fail-loud that hands the
  lane to a human.
- Every other park routes to a human through a state in the machine, reachable only by a recorded
  `UNBLOCKED`.

## Consequences

The parks worth automating are the ones somebody enumerated, which is deliberate friction: adding an
autonomous clear means adding a row and the read that proves it, in a file a reviewer reads as data.
Today that table holds exactly one row, `human:cp-approval`, whose read is `ship cp-approval`'s own
discharge table (ADR [0175](0175-cp-self-approval-cardinality-check.md)) relayed rather than
re-derived.

The cost is that a bare `blocked` can never clear autonomously, however obvious its cause looks in a
comment. That is the honest position — the ledger records the event, not the cause — and the remedy
is a park state that names its cause, not a smarter reader.

## Records

`known park` and `novel park` are named here for the corpus. They are not added to
`.glossary/TERMS.md` in this PR: the glossary's existing `park / expiry` row carries the
roadmap-appetite sense, and disambiguating two senses of one noun is `/glossary`'s call, not this
record's. Routed there with a follow-up filed.
