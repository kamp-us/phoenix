---
id: 0444
title: A founder ruling that names a parentless feature by number in its own arc discharges that feature's pitch, never one it only implies
status: accepted
date: 2026-09-30
tags: [fabrika, governance, roadmap, pipeline]
---

# 0444 — A founder ruling that names a parentless feature by number in its own arc discharges that feature's pitch, never one it only implies

**What this decides:** a parentless feature normally needs a pitch the founder approves. If a
founder ruling already names that feature by its number, and the feature sits in the same arc as
the ruling, the feature needs no pitch. Triage posts a comment on the feature linking the ruling
instead of rewriting its body.

## Context

ADR [0210](0210-direction-binds-at-intake.md) requires a pitch at triage before work enters the
drain, and only the founder approves one. Triage's step 6 carries that rule for "an epic, or a
parentless feature". It had no answer for a feature that is parentless in the graph but whose
direction a founder ruling already approved by number.

[#8083](https://github.com/kamp-us/phoenix/issues/8083) is the case that raised it. It is a
parentless `type:feature` on milestone 52, and the amendment ruling 5 on epic
[#8070](https://github.com/kamp-us/phoenix/issues/8070), in the same milestone, names it by number.
Writing its pitch would ask the founder to re-approve a direction he already named. A feature's
pitch also has one route into the body, a full `triage enrich` rewrite, so honouring the rule meant
recomposing a good enriched body to add a section whose whole content is a citation.

Founder ruling, 2026-09-06, recorded on
[#8113, comment 5556193662](https://github.com/kamp-us/phoenix/issues/8113#issuecomment-5556193662),
verbatim:

> **Ruling (founder, 2026-09-06): yes.** A founder ruling that names an issue by number, in that
> ruling's own arc (same milestone or epic), discharges the parentless-feature pitch. The citation
> lands as a comment on the feature issue linking the ruling, never a body rewrite. 'Vaguely
> implied by an epic' does not count; the guard is by number, same arc. Amend the triage skill's
> step 6 to say so.

This record writes that ruling down, per ADR
[0300](0300-a-cited-ruling-makes-a-decision-buildable.md). It is the same move 0300 makes for a
decision issue, applied one step over to a pitch.

## Decision

**A founder ruling that names a parentless feature by its number, in the ruling's own arc,
discharges the pitch that feature would otherwise owe; a ruling that only implies the feature
discharges nothing.**

- **By number.** The ruling names the feature by its issue number. A feature an epic only implies,
  however plainly, still owes its pitch.
- **Same arc.** The feature is homed in the ruling's own arc: the same milestone, or the same epic.
- **Where the citation lands.** Triage posts a comment on the feature issue linking the ruling
  comment. It never rewrites the feature's body to carry the citation.

**Binding constraints.**

- The ruling is a founder ruling recorded on the board. Triage cites it; triage never judges a
  direction approved on its own.
- A discharged pitch leaves a trace: the comment linking the ruling. A skipped pitch with no such
  comment is a missing pitch.

## Consequences

**A direction the founder named by number costs no second round-trip.** Triage links his ruling
and moves on.

**An enriched body stays as it is.** The citation is a comment, so no good body is recomposed to
carry it.

**Everything the ruling does not name still owes a pitch.** The guard is narrow on purpose: a
number, in the same arc.

## Records

- Amends in part ADR [0210](0210-direction-binds-at-intake.md): its pitch requirement at triage
  now reads with this exception for a parentless feature a founder ruling names by number in its
  own arc. Pitch approval stays a founder seat; this record only says a named ruling is one.
- Transcribes the founder ruling on
  [#8113, comment 5556193662](https://github.com/kamp-us/phoenix/issues/8113#issuecomment-5556193662),
  per ADR [0300](0300-a-cited-ruling-makes-a-decision-buildable.md).
- The rule lives in step 6 of
  [`claude-plugins/fabrika/skills/triage/SKILL.md`](../claude-plugins/fabrika/skills/triage/SKILL.md).

Vocabulary impact: none coined. The `.glossary/TERMS.md` **pitch** row gains this exception.

**Left open, since ruled.** This record did not say how a machine reads the discharge, so
`guard pitch-guard check` kept counting such a feature as unpitched. The founder ruled on
2026-10-03, on
[#10294, comment 5974132205](https://github.com/kamp-us/phoenix/issues/10294#issuecomment-5974132205),
that the guard may accept triage's comment. The guard now reads a `pitch-ruled:` comment on the
feature and verifies the ruling it links before it reads the body; the comment's shape is in
[`wire-formats.md`](../claude-plugins/fabrika/docs/wire-formats.md#pitch-ruling) and the checks are
in [`guard-contract.md`](../claude-plugins/fabrika/docs/guard-contract.md#pitch-guard-check).

That ruling said the guard may accept the comment, not what the comment looks like or how the
ruling behind it is checked. Both are triage's reading, recorded on
[#10294](https://github.com/kamp-us/phoenix/issues/10294). The reading is narrower than "same
milestone or epic" above: the guard accepts a ruling on the feature itself, or one on another issue
in the same open milestone. A feature with no milestone does not pass on another issue's ruling.
