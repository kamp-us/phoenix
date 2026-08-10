---
id: 0256
title: the kill audit keys on the not-planned close; `closed-by-triage` is provenance only
status: accepted
date: 2026-08-09
tags: [triage, fabrika, audit, pipeline]
---

# 0256 — the kill audit keys on the not-planned close; `closed-by-triage` is provenance only

**What this decides:** the maintainer's kill audit finds kills by the close itself — `state_reason=not_planned` — not by the `closed-by-triage` label. The label stays, but it now only says *who* executed the kill; it never says *whether* a kill happened.

## Context

The kill audit is the compensating control for the whole kill path: one query the maintainer runs so
an over-close is caught and reopened cheaply. It queries the label
(`claude-plugins/kampus-pipeline/skills/triage/scripts/audit-kills.sh:12`), and the protocol states
the guarantee plainly — *"Apply `closed-by-triage` so every kill shows up in one query"*
(`claude-plugins/kampus-pipeline/skills/triage/close-not-planned.md:28`) and *"The maintainer audits
all kills with one query"* (`:46`).

Both sentences rest on one premise: **every kill is a triage kill.** That premise is false, and it
came apart the first time a non-triage actor performed a legitimate kill. In a single decision wave
(2026-08-08), #4722 and #4715 were killed through triage and carry the label; #4720 was killed
first-hand in a founder session, carries no label, and is invisible to the audit. Same wave, same
authority, different visibility — purely by who ran the close.

Stamping the label on #4720 would restore coverage by **falsifying provenance**: the label names an
actor, and nothing downstream can tell a truthful marker from a courtesy one. An incomplete audit is
recoverable; a wrong one is not. So the label's two jobs have to be separated rather than
re-conflated: its *function* is coverage, its *name* asserts an actor.

Three measurements decide the shape (#4921's triage, 2026-08-08, and #4291):

- **The label has exactly one reader.** A repo-wide census returns nine sites; the only thing that
  reads the label for anything is the audit query itself. No CI workflow, no `pipeline-cli` guard, no
  projection consumes it. Changing the audit's key therefore breaks nothing downstream.
- **The gap is ~451 issues, not one.** 106 closed issues carry `closed-by-triage`; the search index
  reports ~547 closed as not planned. #4291 read a bounded week of that population: 70 unlabelled
  not-planned closes, and for the 35 with no agent footer it read the last comment before each close
  — all 35 carried a specific, issue-tailored reason, most naming an explicit human authorization.
  Its conclusion is the one this ADR builds on: **the audit surface is blind while the audit
  substance is intact.**
- **The substance is the reason comment, not the label.** Every kill path — triage's and a founder
  session's — leaves a reason comment before the close. That is what a maintainer actually reads when
  judging whether a close was wrong.

This is the same split ADR [0244](0244-live-stage-key-vs-recorded-provenance.md) already made in the
eval corpus: a value used as a **live key** and the same value recorded as **provenance** are two
things, and forcing one to serve both corrupts the recorded half. This ADR applies that split to the
kill audit.

## Decision

**The kill audit's key is `state_reason=not_planned`, and `closed-by-triage` is demoted to a
provenance stamp that records who executed a kill — never whether one happened.**

**What the audit is an audit of.** Every not-planned close in the repository, whoever executed it —
because the risk it guards against (an issue wrongly declared won't-be-done) does not depend on who
ran the close.

**The precision cost is paid with a window and a column, never an actor filter.** Re-keying widens
the audit roughly five-fold (106 → ~547), and those rows are not noise: a sample of the most recently
updated reads as genuine kills and supersessions performed outside the triage kill path. That is the
population actually at risk, so it belongs in the audit. What makes it readable is **scope in time**
— the audit reads every page of a bounded recent window (it is a periodic sweep, not a census) — and
**provenance as a column**: each row shows whether it carries `closed-by-triage`, so a maintainer can
still see triage's kills as a distinct set inside the honest total. Filtering by actor to keep the
list short buys a short list that is wrong; a window buys a short list that is true.

**`closed-by-triage` survives, as provenance only.** It is written by triage's own kill path and by
nothing else. It is never applied to a close triage did not execute, never applied on another actor's
behalf, and never retro-applied — #4720 stays bare, and the recorded reasoning for declining that
stamp stands. No second marker is minted for founder or other actor classes; a new label per actor
class only relocates the gap to the next actor nobody minted one for.

**fabrika's `triage kill` keeps refusing when the label is absent (exit `7`), with a restated
reason.** The behaviour is unchanged, but its rationale is no longer *"refusing a kill that would be
invisible to the audit"* — under this key the kill is visible either way. It refuses because the kill
would be **unattributable**: a triage kill that cannot carry its stamp is indistinguishable from a
founder-session close, which is the confusion this ADR exists to remove. The verb gains **no** actor
flag and **no** courtesy stamp for a human actor: a founder-session close does not run this verb and
must not, and it is auditable through the key plus its reason comment.

**Binding constraints.**
- The audit query keys on `state_reason == not_planned`, reads every page, and is bounded by a time window.
- Every audit row carries its provenance (labelled = triage's kill path; unlabelled = another actor).
- `closed-by-triage` is written only by triage's own kill path.
- Every kill, by any actor, carries a reason comment before the close — that is the audit's substance.

**Banned.**
- Keying the audit on an actor label, or on any actor at all.
- Applying `closed-by-triage` to a close triage did not execute, including a retro-backfill.
- Minting a second `closed-by-<actor>` marker per actor class.

## Consequences

- `close-not-planned.md:28` and `:46` are amended in this PR: the label's line now says what the
  label records, and the audit line's "all kills" becomes a true claim about the ruled key.
- `claude-plugins/fabrika/skills/triage/contract.md` records the ruling next to the kill verb, so the
  spec and the refusal's rationale stop asserting the superseded premise.
- **The audit query is not re-keyed in this PR.** The re-key travels with the same query's pagination
  repair (#4928 — it already reads one unpaginated page of 30 against 106 kills, and under this key
  it must read every page or the widening makes the blindness worse), together with the two shipped
  message strings that still say "invisible to the audit". Per ADR
  [0248](0248-authoring-session-mints-the-implementation-ticket.md) that implementation unit is
  minted from this session rather than left implicit: **#5280**, which names #4928 as the same edit
  site so the two land together instead of racing over one line.
- #4291's `tracker close-not-planned` envelope keeps applying the label — it is the triage kill path,
  so the stamp is truthful — but its acceptance criteria must not name the label as the audit's key.
- Harder: a maintainer skims a wider list. Cheaper: no new marker, no migration of the 106 already
  labelled kills, and no union query.

## Records

- Closes #4921.
- Related: #4291 (the enforcement gap), #4928 (the audit query's pagination blindness), #4720 /
  #4722 / #4715 (the wave that exposed this), ADR
  [0159](0159-never-auto-close-signal-is-the-report-footer.md) (who may be closed at all), ADR
  [0092](0092-gates-fail-closed-on-zero-scope.md) (the fail-closed refusal the verb's exit `7` is).
- **No vocabulary impact.** The key-vs-provenance distinction this rests on is already named by ADR
  [0244](0244-live-stage-key-vs-recorded-provenance.md); this ADR applies it to a second surface and
  coins nothing.
