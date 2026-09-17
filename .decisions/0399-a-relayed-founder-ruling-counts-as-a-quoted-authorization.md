---
id: 0399
title: A relayed founder ruling counts, posted as a quoted authorization by decision rule
status: accepted
date: 2026-09-16
tags: [fabrika, decision, governance, pipeline-hardening]
---

# 0399 — A relayed founder ruling counts, posted as a quoted authorization by `decision rule`

**What this decides:** `decision rule` takes `grill rule`'s `--authorization <file>` beside its
`--cites <url>`. A ruling the founder gave in conversation is recorded by posting his words verbatim
and dated, and citing that comment in the marker — so a decision he already made costs him no comment
to type.

## Context

`type:decision` issues park on `ready-for:human` until a ruling is recorded, and until this change the
only way to record one was `decision rule --cites <url>` over a comment that already existed on the
issue. When the ruling was given in conversation, somebody had to type it into the issue first, and
the somebody was the founder: on lane 8766 the operator relayed the ruling, ran the verb, was blocked
by the harness classifier on the ground that an agent-authored ruling comment is agent authority, and
the lane sat in `build` with nothing dispatched until the founder pasted a one-line comment himself.
The `gh` token was his in both cases, so no ACL on the marker's author could have told the two apart.

That is the round-trip [#8807](https://github.com/kamp-us/phoenix/issues/8807) R4.1 rules out — the
founder pulled into the engine loop to transcribe a decision he had already made — and every
decision-typed child in every epic pays it.

`grill rule` already answered the same question on its own surface: `--authorization <file>`,
required rather than inferred, posted as a dated verbatim comment beside the marker, with an ISO-8601
date check, a bare-`@` refusal and a machine-local-path refusal. So the two verbs disagreed about one
governance question and only one of them had an answer written down.

The founder ruled it on [#8857](https://github.com/kamp-us/phoenix/issues/8857), verbatim *"rec
(yes)"*:
[the ruling comment](https://github.com/kamp-us/phoenix/issues/8857#issuecomment-5625302485). This
record transcribes it; the choice is not the author's.

## Decision

**A relayed ruling counts when it is posted verbatim and dated, and `decision rule` posts it.**

- **One check, two verbs.** The five clauses `grill rule` ran inline — the file read, an empty body,
  an undated body, a bare `@` path, a machine-local path — move to `packages/fabrika-cli/src/authorization.ts`
  and both verbs judge through it. The shape is reused, not redesigned, so the two cannot drift about
  what a quoted authority has to survive. `build clear` still carries its own copy of the same five
  clauses; folding it in is follow-up work, not this decision.
- **Exactly one flag names the ruling.** `--cites <url>` when the ruling is already a comment on the
  issue, `--authorization <file>` when it was given in conversation. Neither, or both, is exit `1` at
  the adapter: a verb that picked between two authorities would be the one deciding which comment a
  ruling is.
- **The quote lands first, the marker second.** A marker citing a comment that never posted points at
  nothing, while a dated quote with no marker beside it rules nothing and harms no one. This mirrors
  `grill rule`'s write order and inverts nothing about the existing `--cites` path.
- **The ACL does not move.** The invoking account must still be on the control-plane roster resolved
  from CODEOWNERS, the comment the verb posts is that account's, and `decision ruling` still honours a
  marker only when its author is on that roster. What moves is who types the words, not who holds the
  authority.
- **What the record proves is bounded, and it is stated rather than implied.** A marker with a quoted
  authorization beside it proves a roster account posted those bytes and dated them. It does not prove
  the quote is a truthful record of what the founder said, and nothing mechanical can: a relayed
  ruling and a fabricated one are indistinguishable at the point of recording. The founder reading the
  quote later is the check, which is the same limit `grill rule` has carried since it shipped.

**The harness classifier is not expected to follow this rule.** It is a separate gate, with its own
input, that reads neither the roster nor the marker, and this decision binds the fabrika verbs only.
A lane whose `decision rule` call is refused by the classifier does what
[`build`](../claude-plugins/fabrika/skills/build/SKILL.md) already says to do with any denied tool
call: stop, quote the denied action in a note, end `STOPPED`, and let a human route it. Re-spelling
the command to get past a refusal is never the answer. What this decision removes is the *reason* the
lane needed a founder — a ruling recorded by the verb is the verb's write, not an agent-authored
comment cited as authority — and what it does not claim is that the classifier now reads it that way.

## Consequences

- A `type:decision` child whose ruling was given in conversation is recorded and flipped to
  `ready-for:agent` in one command, by whoever holds control-plane write, without the founder typing a
  comment.
- The `decision` group's exit table gains the base's two redaction seats, `5` and `6`, which its own
  table had recorded as unreachable: the verb now posts free human text. `21` is its own seat for an
  empty or undated authorization — `grill`'s `15` belongs to that group's private band and is not
  importable here.
- The audience flip's guard is unchanged: a body with no readable `### Acceptance criteria` block
  keeps its marker and stays on `ready-for:human`, whichever flag recorded the ruling.
