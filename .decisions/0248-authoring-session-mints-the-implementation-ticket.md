---
id: 0248
title: The authoring session mints a fabrika contract's implementation ticket at handoff, and review-skill checks it exists
status: accepted
date: 2026-08-10
tags: [fabrika, pipeline, process]
---

# 0248 — The authoring session mints a fabrika contract's implementation ticket at handoff, and review-skill checks it exists

**What this decides:** who turns a landed fabrika `contract.md` into an implementation ticket, at
what moment, and what checks it happened. The answer is: **the authoring session, as part of its
handoff, and the `review-skill` gate on the skill PR asserts the ticket exists and is named.**
Nothing mints a ticket by machine — the session files it, triage prices it, the gate refuses a
contract PR that arrives without one.

## Context

A fabrika authoring session's lane ends at the spec: it emits `SKILL.md` + `contract.md` and is
forbidden from implementing the verbs it just specified (the
[authoring-brief contract](../claude-plugins/fabrika/docs/authoring-brief-contract.md) field 6,
[#4638](https://github.com/kamp-us/phoenix/issues/4638)). The build end is the crew's. Between them
sat nothing: no actor, no moment, no artifact carrying the hand-off.

That gap is not merely manual, it is **unowned**, and the only route into the build pool is an open
issue — `write-code`'s picker selects on open + `status:triaged` + a priority label + a null
assignee and reads nothing else
(`claude-plugins/kampus-pipeline/skills/write-code/scripts/step1-candidate-pool.sh`). No issue means
no build, with no other path. The failure reads as success: a green PR, a merged spec, a brief that
auto-closes on `Fixes #<brief>`, and a skill on `main` whose verbs do not exist.

Both early instances got a ticket by accident, from different actors on opposite sides of the merge
that was supposedly the trigger: `adr`'s ([#4725](https://github.com/kamp-us/phoenix/issues/4725))
2h14m *before* its contract merged, filed by an agent reading the open PR; `report`'s
([#4748](https://github.com/kamp-us/phoenix/issues/4748)) 1h39m *after*, filed by an agent closing a
brief. Two for two by noticing is a pattern, not a guarantee.

The answer was then proven three times live, in one evening, before it was written down:
`plan-epic`'s session → [#5179](https://github.com/kamp-us/phoenix/issues/5179), `governance`'s →
[#5199](https://github.com/kamp-us/phoenix/issues/5199), `front-door`'s →
[#5214](https://github.com/kamp-us/phoenix/issues/5214). Each handoff filed (or directly caused the
filing of) its verbs ticket before the session closed, triage priced it, and the founder stamped it.
The `front-door` skill PR's own `review-skill` verdict already asserted the linkage informally
("#5214 costs no second lane"). This decision codifies exactly the behavior that was already
working.

## Decision

### 1. The actor and the moment

**The authoring session mints the implementation ticket, as part of its handoff.** The handoff is
not complete until the ticket exists and the handoff names its number.

The session is the right filer because it holds the context nobody else has: it just derived the
verb inventory and ran the judgment/verb split, so it can name what is to be built without a second
reader reconstructing it from the spec. The ticket carries, at minimum: the skill it serves, the
repo-relative path of its `contract.md`, the verb inventory, and any sequencing dependency on the
verb package existing.

This does **not** move the lane's end. The session still does not implement its verbs, and a skill
on `main` with unbuilt verbs is still an expected state. What is no longer permitted is a merged
contract with **no ticket**, because that is the state that reads as done and is not.

### 2. The check

**The `review-skill` gate lists it as a criterion.** On a PR that adds or changes a fabrika
`contract.md`, the gate asserts the implementation ticket exists, is open, and is named in the PR
body or the handoff comment.

Scope and zero-scope behavior (ADR [0092](0092-gates-fail-closed-on-zero-scope.md)): the check is
selected off the PR's changed-file list. A diff carrying no
`claude-plugins/fabrika/skills/*/contract.md` is out of scope and records PASS with that evidence —
the check ran, it had nothing to assert. A file list that could not be read is **UNKNOWN and
fails**, never "no contract touched".
Unlike the sibling gap at [#4693](https://github.com/kamp-us/phoenix/issues/4693), scope is
non-empty today: contracts are already on `main`.

### 3. Nothing mints a ticket automatically

A machine-minted ticket is un-sized, un-priced and un-homed work entering the board without passing
triage — a second door into the build pool, the exact defect class the one-door ruling
([#4637-C](https://github.com/kamp-us/phoenix/issues/4637)) fights. The mechanism's job is to
**demand** the ticket, never to author one.

## Why the teeth are a gate criterion and not a CI guard

An earlier reading of this seam proposed a repo CI job that reds when a PR adds a `contract.md`
without referencing an implementation issue. It was not taken, and the reason is what the check has
to establish.

The question is not "does the PR body contain an issue number" — a grep-shaped guard is satisfied by
any number, including the brief's own `Fixes #<brief>` line, which is a **done-signal** and the exact
opposite of a hand-off. The question is "does an open ticket exist that routes to *these* verbs" —
a semantic read of the ticket against the contract the PR carries. `review-skill` already opens both
the PR and its linked issues, already reads the contract text under review, and already performed
this exact check informally on the `front-door` PR. Putting the assertion where the reader already
is costs one listed criterion; a second CI job would re-derive a weaker version of the same answer
and drift from it.

So enforcement is **both** halves in the sense the seam needed — a documented obligation (the brief
contract states the filing half) plus teeth (a listed, conjunctive gate criterion that fails the
PR) — but the teeth are the gate, not a new fail-closed CI job. Teeth were not declined; they were
placed at the only surface that can judge the ticket rather than count a number.

## Rejected alternatives

- **The wave epic carries an implementation child per skill up front.** Contradicts
  [#4650](https://github.com/kamp-us/phoenix/issues/4650)'s ruled plan ("authoring briefs, not
  code") and its non-goals, so it is an amendment to a p0 epic rather than a fix to this seam. It
  also drops unassigned children into the `write-code` candidate pool — the second-door problem
  tracked at #4693.
- **Leave it to ambient noticing.** This is the status quo the seam documents: two of two tickets
  filed because somebody happened to look. A rule that depends on remembering is the failure mode,
  not the fix.
- **Auto-mint on merge.** Ruled out above — an un-triaged ticket is a second door.

## Consequences

- The 17 briefs still open need **no edit**. A brief points at the authoring-brief contract rather
  than paraphrasing it, so every session boots against the live doc and picks the filing obligation
  up from field 6.
- The two landed instances reconcile with nothing to re-file: `adr` (#4725) and `report` (#4748) are
  both closed, so the rule is retroactively satisfied and this decision applies at authoring time
  only.
- The obligation is written in exactly two in-repo places — field 6 of the authoring-brief contract
  (what the session owes) and `review-skill`'s rigor checklist (what the gate asserts). The
  `/fabrika-skill-creator` wrapper's handoff step lives outside this repo's tree; it cites this
  decision rather than restating the rule, so the two cannot drift.
- The criterion belongs to **whichever skill is the live skill-class gate**. When fabrika's own
  `review` skill takes that role from `claude-plugins/kampus-pipeline/skills/review-skill/`, it
  carries this criterion with it; it is not a second, parallel check.
