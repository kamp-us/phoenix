---
id: 0270
title: the calibration conjunct is discharged by a record written at the hand-off, and the criterion is reworded to the evidence class a reader can check
status: accepted
date: 2026-08-10
tags: [fabrika, skills, briefs, review]
---

# 0270 — the calibration record is written at the hand-off, and the criterion asks for the record, not the act

**What this decides:** how a fabrika authoring brief's calibration row is discharged. The authoring
session writes down which calibration inputs it handed `skill-reviewer` **while it hands them over**
(runbook step 5.5), and the acceptance criterion is worded to ask for exactly that record — not for
the act behind it. This closes a **forgotten** record. It does not, and is not written to, close an
**untrue** one.

## Context

Every fabrika authoring brief carries a criterion of the shape (verbatim from
[#5020](https://github.com/kamp-us/phoenix/issues/5020)): *"`skill-reviewer` ran on the authored
skill before the pull request opened, was handed `skill-conventions.md` and a landed sibling skill as
calibration, its findings were addressed, and the PR records the review pass."* Four conjuncts; the
second is the one at issue.

Three facts, each checked against the durable record rather than recalled:

- **The row fails on correct work.** PR [#5261](https://github.com/kamp-us/phoenix/pull/5261)
  (`prototyping`) took `review-skill: FAIL @ 35c1db4c` on that single row out of nineteen. The
  verdict's words: *"The calibration conjunct is recorded nowhere — not in the PR body, not in the
  handoff comment on #5020, not in the diff."* The calibration had in fact happened. Nothing wrote it
  down, so the row failed and the repair was a sentence added to the PR body afterwards.
- **The row passes on a sentence.** PR [#5268](https://github.com/kamp-us/phoenix/pull/5268)
  (`graduate`) passed the same row, and its verdict says why in its own words: *"this gate verifies
  the written record; it cannot re-run the reviewer, because the authoring runbook emits no
  calibration artifact."* Both landed siblings —
  [#5233](https://github.com/kamp-us/phoenix/issues/5233),
  [#5242](https://github.com/kamp-us/phoenix/issues/5242) — cleared it the same way: one sentence in
  the PR body, no independent artifact.
- **No artifact class exists to produce.** `skill-reviewer` is a generic upstream `plugin-dev` agent
  invoked in-session, and nothing under `claude-plugins/fabrika/` records what it was handed. That is
  [#4701](https://github.com/kamp-us/phoenix/issues/4701)'s own finding, and it is *why* the brief
  made handing over the doc an explicit act in the first place.

So the same criterion produced opposite outcomes on two sibling PRs, decided entirely by whether
someone remembered to type a sentence. And there is a second defect underneath: the obligation lives
**only** in the per-brief acceptance criteria. `authoring-brief-contract.md` field 6 — the contract
those criteria derive from — requires only that `skill-reviewer` *run*, and says nothing about
calibration. A session that boots from the brief alone reads the obligation as an unexplained row
rather than as part of its output contract.

One tension is worth naming, because it is the sharpest thing on the ticket and it is easy to
overstate. `prototyping` is built on the scar that a self-report is not evidence
([#4111](https://github.com/kamp-us/phoenix/issues/4111)), while its own calibration row can be
discharged only by a self-report. That is an **asymmetry**, not a contradiction: the #4111-grounded
criterion constrains the runtime artifact the authored skill produces, and this one constrains the
authoring process one level up. What is genuinely wrong is that fabrika applied to its own gate a
standard weaker than the one it ships — and never said so out loud.

## Decision

**1. The record is written at the hand-off, not reconstructed at PR time.** Runbook step 5.5 is
already where `skill-reviewer` runs. The session names its calibration inputs in the PR body's review
section **as it runs that pass** — the conventions doc, any other convention doc handed over, and
which landed sibling skill. A note written while the act happens cannot be forgotten afterwards; a
note owed at PR-open time can be, and was.

**2. The criterion asks for the record.** Its wording becomes: *"the PR records which calibration
inputs `skill-reviewer` was handed."* The old wording — *"was handed … as calibration"* — asserts a
fact about the session, and no reader of the PR can check it. The new wording asks for the thing a
reader can actually check, so a passing row means what it says.

**3. Field 6 of the brief contract carries both.** The contract and the briefs derived from it now
say the same thing, and a session booting from the brief alone reads the obligation there.

**4. Briefs already minted keep their bytes; the gate reads them at this evidence class.** The open
briefs carry the old wording, and a filed brief is amended, never rewritten. `review-skill` reads the
old wording as asking for the same record this ADR names, so no board-wide edit is owed and no
in-flight brief changes meaning.

## What this closes, and what it does not

Stated plainly, because the value of the row depends on it:

- **Closed: a forgotten record.** Observed — once in the three sibling PRs, at the cost of a review
  cycle and an after-the-fact body edit.
- **Not closed: an untrue record.** A note written by the same session at the moment of the act is
  still that session's unverified word. An earlier timestamp does not make it checkable. A reader of
  a passing row learns that the session wrote down which inputs it handed over — nothing stronger.

That is the honest reading of the row, and it is why conjunct 2 is reworded rather than left implying
verification it cannot deliver.

## Relationship to #4701's option 3 — left open, not subsumed

[#4701](https://github.com/kamp-us/phoenix/issues/4701) offered a third option: *"a fabrika-side gate
that reads `skill-conventions.md` is named and given the conformance job, or `skill-reviewer`'s
invocation is required to be handed the doc."* Its ruling deleted the sizing line band and left that
option unresolved. This decision does **not** resolve it. Verb-mediating the hand-off — so the record
is written by something other than the session vouching for itself — is the only shape that would
make the row independently checkable, and it is priced here rather than skipped: a verb plus a
wrapped invocation, against roughly a one-in-three chance of one lost review cycle on the remaining
briefs. Not worth building for the briefs that remain. It stays open under #4701 for whenever a
fabrika-side conformance gate is built for other reasons, and this ADR is not a ruling against it.

[#5290](https://github.com/kamp-us/phoenix/issues/5290) is the sibling one row over — the same shape
of problem on criterion 10 (v1-surface coverage), with its own answer. Neither decision subsumes the
other.

## Consequences

- A future fabrika authoring session has one more thing to write during step 5.5, and one fewer way
  to lose a review cycle at the end of it.
- A passing calibration row is now correctly readable as "the record exists", which is weaker than
  what the old wording implied and is the truth.
- If a fabrika-side conformance gate is ever built (#4701 option 3), this row is a natural first
  consumer: the record becomes the gate's input instead of its only evidence.

## Alternatives considered

- **Drop the conjunct.** Rejected: it exists to close #4701's "nothing hands the reviewer the doc"
  hole, and dropping it re-opens that hole while the calibration is still the only thing pointing a
  generic upstream reviewer at fabrika's conventions.
- **Verb-mediate the hand-off now.** Rejected on price for the remaining briefs; left open at #4701
  rather than ruled against (above).
- **Leave the wording and rely on authors remembering.** Rejected — that is the observed failure, and
  it also leaves a passing row claiming more than a reader can check.

## References

- [#5279](https://github.com/kamp-us/phoenix/issues/5279) — the decision issue this ADR settles.
- [#5261](https://github.com/kamp-us/phoenix/pull/5261) — the FAIL on this row; [#5268](https://github.com/kamp-us/phoenix/pull/5268) — the PASS, whose verdict states the gate verifies the record and cannot re-run the reviewer.
- [#4701](https://github.com/kamp-us/phoenix/issues/4701) — nothing hands `skill-reviewer` the conventions doc; option 3 unresolved.
- [#5290](https://github.com/kamp-us/phoenix/issues/5290) — the sibling criterion-10 decision.
- [#4111](https://github.com/kamp-us/phoenix/issues/4111) — the "a self-report is not evidence" scar, cited as grounding rather than as a standing law.
- [`claude-plugins/fabrika/docs/authoring-brief-contract.md`](../claude-plugins/fabrika/docs/authoring-brief-contract.md) field 6 — where the obligation now lives.
