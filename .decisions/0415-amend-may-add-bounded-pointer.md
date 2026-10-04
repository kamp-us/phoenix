---
id: 0415
title: An amend may add a bounded in-place pointer to the amending record, never a new ruling
status: accepted
date: 2026-09-27
tags: [fabrika, adr, decisions, governance]
---

# 0415 — An amend may add a bounded in-place pointer to the amending record, never a new ruling

**What this decides:** when a newer ADR supersedes or amends an older one, the older ADR's
`status:` line changes, and a hand-written pointer to the newer ADR may also be added inside the
older ADR's body. That pointer only cites and scopes. It never decides anything new.

## Context

The [`adr` skill](../claude-plugins/fabrika/skills/adr/SKILL.md) §4 said `adr supersede` and
`adr amend-in-part` touch "the `status:` line and nothing else", and told the author to name the
relationship in the newer ADR's own `## Context` instead. Two merged PRs annotated
[ADR 0317](0317-ui-lane-carries-its-own-shells.md)'s body in place anyway:

- PR [#6807](https://github.com/kamp-us/phoenix/pull/6807) added "**Narrowed by ADR 0320**" and
  three sentences of scope inside a `## Consequences` bullet, linking
  [ADR 0320](0320-the-review-bar-splits-across-two-cells-and-the-machine-decides.md).
- PR [#6919](https://github.com/kamp-us/phoenix/pull/6919) appended "— holds for the epic tail only,
  per ADR 0327" to a `###` heading, linking [ADR 0327](0327-ship-fail-routes-to-build.md).

Governance cleared the #6919 heading on the #6807 precedent, because the written rule did not answer
the question. A rule that forces a reviewer to weigh precedent lets two reviewers reach opposite
verdicts on the same shape ([#6921](https://github.com/kamp-us/phoenix/issues/6921)).

The founder ruled on 2026-09-02 that an amend may add a bounded in-place pointer to the amending
record, under a lens of less process toil and no new
gate unless a failure recurs:
https://github.com/kamp-us/phoenix/issues/6921#issuecomment-5519864260. This record transcribes
that ruling. It supersedes and amends no ADR; the rule it changes lived only in the skill. It sits
inside the immutability convention as [ADR 0305](0305-v1-cli-deletion-retires-three-git-boundary-guards.md)
reads it: that convention protects decision text, not bytes, and a pointer adds no substance.

## Decision

**An amend rewrites the older ADR's `status:` line and may add a bounded in-place pointer to the
amending record; the pointer carries a citation and a scope note, never a ruling.**

1. **The pointer is optional.** Naming the relationship only in the newer record's own `## Context`,
   with no edit to the older body, stays conforming. [ADR 0344](0344-verdict-repost-appends-below-fence.md)
   refines ADR 0058 that way, and that shape is as valid as a pointer.
2. **What a pointer may carry:** a link to the amending record, and a scope qualifier saying where
   the older text still holds or how far the newer record narrows it.
3. **The pointer is hand-authored.** `fabrika adr supersede` and `fabrika adr amend-in-part` keep
   rewriting only the `status:` line, and their one-line invariant is unchanged.
4. **Both landed annotations in ADR 0317 are in bounds.** Each cites its amending record and narrows
   scope without reversing anything, so neither is reverted and no remediation is owed.

**Banned.**

- A pointer that adds a new ruling. The ruling belongs in the amending record.
- A pointer that reverses the older decision, or rewrites the claims it makes. A reversal is a
  `supersede` plus a new record.
- A new gate, guard, verb, flag or label to enforce or detect pointers.

## Consequences

- Governance reads a pointer against this bound rather than against precedent, so the same shape
  gets the same verdict.
- A reader landing on an amended ADR may see the narrowing where the stale sentence stands, instead
  of only on the status line.
- Nothing checks the bound mechanically. A pointer that grows into a ruling is caught at review, the
  same way any other decision-text edit is.

## Records

- Issue: https://github.com/kamp-us/phoenix/issues/6921
- Ruling: https://github.com/kamp-us/phoenix/issues/6921#issuecomment-5519864260
- no vocabulary impact
