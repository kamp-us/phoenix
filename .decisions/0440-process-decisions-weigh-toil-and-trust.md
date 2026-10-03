---
id: 0440
title: A process decision takes the cheapest option that cuts toil and builds trust, never a gate no recurred failure earned
status: accepted
date: 2026-09-30
tags: [process, pipeline, decisions, agents]
---

# 0440 — A process decision takes the cheapest option that cuts toil and builds trust, never a gate no recurred failure earned

**What this decides:** When a choice about how the pipeline works is on the table, pick the cheapest
option that means less process work and more trust between agents and skills. Add a new gate, token
or word only after a failure has actually recurred.

## Context

On 2026-09-02 the founder ruled a batch of 46 open `type:decision` issues in one session, under one
stated lens. The lens was written only inside those ruling comments. Nothing in `.decisions/` said
it, so the next batch of process decisions would park on `ready-for:human` and wait for the same
sentence again.

This record transcribes the founder ruling on
[#7293, comment 5519863018](https://github.com/kamp-us/phoenix/issues/7293#issuecomment-5519863018),
which reads:

> Lens he set for this whole batch: reduce process toil, increase trust between agents and skills —
> pick the cheapest option, add no new gate or token unless a failure actually recurred.

The same lens sits on the
[#6922 ruling](https://github.com/kamp-us/phoenix/issues/6922#issuecomment-5519905316) in other
words: "Lens: reduce process toil, add no new gate for a thing that never caused a failure." The
founder restated the lens when #7522 was filed, and the ruling recorded on
[#7522, comment 5519936650](https://github.com/kamp-us/phoenix/issues/7522#issuecomment-5519936650)
is what made this transcription buildable under
[ADR 0300](0300-a-cited-ruling-makes-a-decision-buildable.md). The founder's own words in that
session: "ideally we should minimize the process by reducing the process toil + somehow increasing
the trust between agents & skills."

Same-day rulings that applied the lens:

- [#7404](https://github.com/kamp-us/phoenix/issues/7404) and
  [#6947](https://github.com/kamp-us/phoenix/issues/6947): no wider CODEOWNERS rows ("i trust my
  agents").
- [#7401](https://github.com/kamp-us/phoenix/issues/7401): a tracked `permissions.allow` for fabrika
  verbs.

## Decision

**A process decision is weighed by one lens: reduce process toil and increase trust between agents
and skills.**

The batch applied it four ways, and those four are the lens in practice:

1. **Pick the cheapest option.** Among options that solve the problem, the one with the least new
   machinery and the least ongoing work wins.
2. **Add no new gate, token or vocabulary unless a failure actually recurred.** A failure that is
   only imagined does not earn a new check, a new marker token or a new term, and neither does one
   that happened once. A failure that came back does.
3. **Ratify shipped behaviour rather than re-litigate it.** When the pipeline already does a thing and
   it works, the decision records it as it is.
4. **Retire bookkeeping-only decisions.** A decision whose only deliverable is a record nobody then
   acts on is closed, not written up.

How this sits beside existing law:

- [ADR 0078](0078-product-driven-decisions-by-default.md) says **who** leads a decision: product by
  default, engineering where the work is the platform. This record says **how** a process decision is
  weighed once it is on the table. The two do not overlap.
- [ADR 0430](0430-fabrika-helps-never-polices-choices.md) answers a different question: what
  **kind** of harm a fabrika guard may stop. Its test is "does it stop a real failure, or does it
  only stop someone from making a choice?", and it reads a real failure as a bug, an accident, a
  leak, or a bypass of the founder's control-plane approval. It states no count and says nothing on
  recurrence. Application 2 asks how much evidence a new gate needs: a failure that recurred. The
  two stand side by side, and a new guard has to pass both: it stops a real failure in 0430's
  sense, and that failure came back.
- The #6922 wording, "a thing that never caused a failure", is looser than the #7293 wording this
  record transcribes. The recurrence wording is the standing one: live records 0382, 0412, 0415,
  0423, 0426, 0427, 0436, 0438 and 0439 each carry it from the same day's rulings. This record
  keeps their bar and re-reads none of them.
- The triage value bar in the fabrika `triage` skill (step 8) is this lens applied at intake. Its
  process-ceremony clause is application 4. Its hardening-with-no-incident clause asks "has this
  ever failed in production?" and passes on a single incident. That is a looser neighbour of
  application 2, not its bar: it decides whether an issue is worth keeping at intake, while
  application 2 decides whether a process decision may add a gate.

**Binding constraints.**

- A process decision that adds a gate, token, label or term names the failure that recurred and
  earns it. With no such failure, the cheaper option stands.
- This record adds no gate, verb, label or vocabulary of its own.

## Consequences

Process decisions that fit the lens no longer need the founder to restate it. Triage can close a
ceremony-only decision on this record's authority, and the fabrika-verb permission list from #7401
has a stated reason.

The cost is that "cheapest" and "recurred" are still judgement calls. The lens tells an agent which
way to lean. It does not settle a case where two options cost about the same, and a decision that
turns on product direction still goes to the founder under ADR 0078.
