---
id: 0476
title: An owner's comment counts as a rule when it starts with one fixed first line, with no command run after it
status: accepted
date: 2026-10-05
tags: [fabrika, decision, pipeline-hardening, review]
---

# 0476 — An owner's comment counts as a rule when it starts with one fixed first line, with no command run after it

**What this decides:** a repo owner can make an issue comment count as a rule just by starting it
with one fixed first line. Nobody has to run `fabrika decision rule` afterwards. What that first line
says is not decided yet.

Founder ruling, 2026-10-04, on [#10398](https://github.com/kamp-us/phoenix/issues/10398):
[the ruling comment](https://github.com/kamp-us/phoenix/issues/10398#issuecomment-5983090434).
The rulings desk asked:

> When an owner writes a build rule as a normal issue comment, the reviewer does not grade against
> it (#10398). Should a comment count as a rule when it starts with one fixed first line, with no
> command to run after?

He picked "Yes, a fixed first line". The other button was "No, keep the command". He typed no note.
This record writes that answer down, per [ADR 0300](0300-a-cited-ruling-makes-a-decision-buildable.md).
The choice is not the author's.

## Context

Today a ruling on an issue counts only when a `decision-ruled:` marker records it, and only
`fabrika decision rule <n> --cites <url>` writes that marker. `review criteria` grades the body's
criteria plus those marked rulings and nothing else
([`graded-set.ts`](../packages/fabrika-cli/src/review/graded-set.ts)). An adopting team wrote a new
rule as a plain comment, never ran the verb, and the reviewer graded the older rule instead. That
cost a repair round and a wrong FAIL.

The fix for [#10309](https://github.com/kamp-us/phoenix/issues/10309) made three verbs list such
comments. It does not grade them, the owner who wrote one is never told, and in a repo where agents
post as the owner most listed comments are agent notes.

## Decision

**A comment an owner writes on an issue counts as a rule when it starts with one fixed first line,
and no command has to be run after it.**

**How it sits with #9517.** The ruling on
[#9517](https://github.com/kamp-us/phoenix/issues/9517#issuecomment-5752597880) made rulings
something the review gate grades, and its acceptance criteria say "A ruling marker is written by a
CLI verb, not by hand-posting bytes". This ruling reverses that part: a line the owner types by hand
now records a rule too. The rest of #9517 stands. Rulings are still graded, the newest still wins
over a body criterion it contradicts, and a verdict older than the newest ruling still is not
current.

**Not decided here.**

- The exact text of the fixed first line. The ruling chose a fixed line and did not say what it
  reads. That goes back to the founder.
- Anything else the ruling did not mention: whether `fabrika decision rule` stays as a second way
  to record a rule, whether a typed rule also changes the issue's audience label the way that verb
  does, and how agent notes posted under the owner's account are kept from carrying the line.

## Consequences

- A typed rule carries no digest of the issue body, which the verb's marker does. An agent posting
  under the owner's account could type the line too. That is the same limit
  [ADR 0455](0455-owner-steps-confirm-the-account.md) states for every owner-only step: the check
  confirms the account, not the person.
- The tools do not read the line yet. The build work is
  [#10578](https://github.com/kamp-us/phoenix/issues/10578), and it waits on the open first-line
  text above.
