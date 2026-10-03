---
id: 0447
title: A fabrika skill ships from an ordinary ticket through the review skill's skill rubric, never from an authoring brief
status: accepted
date: 2026-10-03
tags: [fabrika, skills, briefs, review, process]
---

# 0447 — A fabrika skill ships from an ordinary ticket through the review skill's skill rubric, never from an authoring brief

**What this decides:** the authoring-brief process is retired. A change to a fabrika skill is a
normal ticket: triaged, built by `build`, and judged by the `review` skill's skill rubric. The two
records that ruled the brief's hand-off obligations,
[0248](0248-authoring-session-mints-the-implementation-ticket.md) and
[0270](0270-calibration-record-is-written-at-the-handoff.md), are superseded.

## Context

The authoring brief was the boot issue for the one-time rebuild of the fabrika skill set: one
brief per skill, each fired by a human starting a fresh session. Two accepted records ruled what
that session owed at hand-off. 0248 said the session files the implementation ticket for its
contract's verbs and `review-skill` checks the ticket exists. 0270 said the session writes down, at
the hand-off, which calibration inputs it gave the `skill-reviewer` agent.

The pipeline stopped following both, and
[#10333](https://github.com/kamp-us/phoenix/issues/10333) recorded the evidence on 2026-10-03:

- 31 issues have a title starting `Authoring brief:` and all are closed. The newest was created
  2026-08-10 and the last closed 2026-08-19. The search matches words rather than the title prefix,
  so the count keeps only the titles that start with it (`gh issue list --state all --limit 200
  --search '"Authoring brief:" in:title' --json title,state,createdAt,closedAt --jq '[.[] |
  select(.title | startswith("Authoring brief:"))]'`, run 2026-10-03). The issue's own body counts
  43, which is every closed hit of the unfiltered search, tickets about briefs included.
- Skills landed afterwards without one. `skill-doctor` came from an ordinary feature ticket
  ([#8048](https://github.com/kamp-us/phoenix/issues/8048), landed 2026-09-20) and `test-audit`
  landed 2026-09-26 (`git log --diff-filter=A` on each `SKILL.md`).
- No skill emits a brief. `claude-plugins/fabrika/skills/plan-epic/SKILL.md` has no brief step.
- `claude-plugins/fabrika/skills/review/rubrics/skill.md` carries no implementation-ticket
  criterion and no calibration criterion, and names no `skill-reviewer` pass.

So the docs page and two accepted records described a process nobody ran. The question "is the
authoring-brief process retired?" went to the founder with a recommendation of yes.
[The ruling comment](https://github.com/kamp-us/phoenix/issues/10333#issuecomment-5973508581)
records the answer as yes, and records how it was reached: the founder delegated the call rather
than answering it directly, and his standing rule is that a recommendation at 85% or above is acted
on. He can reverse it on that issue.

## Decision

**The authoring-brief process is retired, and a fabrika skill ships from an ordinary ticket through
the `review` skill's skill rubric.**

1. **No brief.** Nothing emits an authoring brief and a skill needs none to start. A skill ticket
   takes the ordinary types, labels and routing.
2. **One gate.** The skill-class review gate is the `review` skill's
   [`rubrics/skill.md`](../claude-plugins/fabrika/skills/review/rubrics/skill.md), under the
   `review-skill` namespace. No `skill-reviewer` pass is owed before a PR opens.
3. **0248 is superseded.** The hand-off obligation it ruled, and the `review-skill` criterion that
   checked it, are gone. The rubric already carries neither, so no rubric edit follows.
4. **0270 is superseded.** With no `skill-reviewer` pass there is no calibration hand-off to
   record.
5. **The docs page says what happens now.**
   [`authoring-brief-contract.md`](../claude-plugins/fabrika/docs/authoring-brief-contract.md)
   keeps its path, because other records link it, and becomes a short reference to the stage, the
   gates and the page that owns each rule.

## What this does not decide

- **The one-door rule.** 0248 §3 ("nothing mints a ticket automatically") restated the ruling in
  [#4637](https://github.com/kamp-us/phoenix/issues/4637). That ruling is not 0248's, and this
  record leaves it alone.
- **Who files a ticket for verbs a contract specifies but nobody built.** The ruling retires the
  brief-era hand-off and names no replacement. The ship gate in
  [`skill-conventions.md` §8](../claude-plugins/fabrika/docs/skill-conventions.md#8-the-ship-gate)
  still requires the derived contract to be implemented; how a gap there gets tracked is open, and
  it is the founder's call if it comes up.

## Consequences

- A session writing a skill reads one short page and the documents it points at. It runs no gate
  the pipeline does not read.
- Older records and contracts still say "authoring brief" and "authoring session". They describe
  the rebuild as it happened and stay as written.
- A PR that adds or changes a `contract.md` is no longer owed an implementation ticket by any
  record. If verbs go unbuilt and untracked, that is the open question above, not a gate failure.

## Records

- **authoring brief** — redefined as retired in [`.glossary/TERMS.md`](../.glossary/TERMS.md), in
  the same PR as this record.
