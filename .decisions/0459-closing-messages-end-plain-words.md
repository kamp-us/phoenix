---
id: 0459
title: A stage's closing message ends in two plain lines, under one shared rule skill review checks
status: accepted
date: 2026-10-04
tags: [fabrika, skills, pipeline, docs]
---

# 0459 — A stage's closing message ends in two plain lines, under one shared rule skill review checks

**What this decides:** when a fabrika stage finishes or stops, the last thing it writes for a person
is two plain lines: what happened, and what the person does next. The rule has one home, the skill
review rubric checks skill text against it, and the seven stage skills are rewritten to pass.

## Context

A usability test on 2026-10-03 ([#10365](https://github.com/kamp-us/phoenix/issues/10365)) ran a
newcomer through fabrika on a fresh repo. Each stage's last message was true and written for another
agent. The newcomer read "No governance verdict was owed", "the claim is released" and "The first
try refused (exit 33)" and could not tell what had happened or what to do. They got through only
because the session translated each message.

No shared rule existed.
[`skill-conventions.md`](../claude-plugins/fabrika/docs/skill-conventions.md) had fourteen sections
and none was about what a person reads. Three narrow rules stood in the stage skills: `operate`
makes a command written for a person pasteable, `build` words its stop on an issue that has a
screen, and `review-ui` posts the note its verb prints when it cannot see the screen.

Three options were put to the founder. The smaller was a glossary page. The larger was a CLI verb
that writes each stop note from a fixed table. The one in between was a shared rule checked by skill
review. The question asked was: do we want one shared rule that every stage's closing message says in
plain words what happened and what the person does next, checked by the skill review rubric? He
answered "yes" on
[#10365, comment 5977510124](https://github.com/kamp-us/phoenix/issues/10365#issuecomment-5977510124).
This record writes that ruling down, per ADR
[0300](0300-a-cited-ruling-makes-a-decision-buildable.md).

## Decision

**A stage's closing message ends with two plain lines for the person, what happened and what they do
next, and that rule lives in one section of the skill conventions that skill review checks.**

- **One home.**
  [Skill conventions §15](../claude-plugins/fabrika/docs/skill-conventions.md#a-closing-message-ends-in-two-plain-lines)
  states the rule and how a pipeline word is handled: left out, or explained in a few everyday words
  where it appears. An exit code number never stands alone as the explanation. A stage skill links to
  that section and does not restate its word list.
- **Every ending.** The two lines are owed on every way a stage can end, a stop included. When
  nothing is needed from the person, the second line says so.
- **The driver's token does not move.** Every terminal token a driver reads is unchanged, and the
  plain lines sit above it.
- **Skill review checks it.** The
  [skill rubric](../claude-plugins/fabrika/skills/review/rubrics/skill.md) holds a skill-class file
  that tells an agent to write a closing message for a person to that section. A miss refuses PASS
  on the `review-skill` namespace.
- **The seven stage skills pass it.** `triage`, `build`, `build-ui`, `review`, `review-ui`, `ship`
  and `operate` each carry a closing-message step that links to the section.

**Binding constraints.**

- The check reads a skill's text. It does not read the message an agent wrote on a given run. That
  limit was named when the question was asked, and it is accepted.
- No CLI verb writes stop notes from a table, and no glossary page is added. The ruling picked
  neither.
- The three narrow rules stay, and the section adds to them.

## Consequences

**A person reads the outcome and their next step without a translator.** That holds on a session
whose settings do not already ask for plain answers, which the test did not cover.

**A skill change that adds a closing message with pipeline words fails review.** The cost is one
more rubric check per skill-class diff.

**Nothing checks a real run's message.** A stage can still write a poor closing message while its
skill text passes. A later record decides whether a verb should write those messages, if the gap
shows up in use.

## Records

- Transcribes the founder ruling on
  [#10365, comment 5977510124](https://github.com/kamp-us/phoenix/issues/10365#issuecomment-5977510124),
  per ADR [0300](0300-a-cited-ruling-makes-a-decision-buildable.md).

Vocabulary impact: none coined.
