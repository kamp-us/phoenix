---
id: 0228
title: Extracted skill scripts relay verb decisions, never derive them
status: amended-in-part by [0229](0229-mechanical-combination-is-relay.md)
date: 2026-07-28
tags: [pipeline, skills, control-plane, tooling]
---

# 0228 — Extracted skill scripts relay verb decisions, never derive them

**What this decides:** For the shell scripts extracted from pipeline skills under the #4435
programme, the test for what must become a `pipeline-cli` verb is **derive-vs-relay**: a script may
call a verb and branch on its answer (relay — sanctioned), but must never compute a decision itself
in shell (derive — banned). This amends the ledger's earlier candidate test ("feeds a
gate/merge/classification decision").

## Context

The #4435 programme extracts the fenced shell embedded in pipeline skill markdown into sourced
`.sh` scripts, then — as a later phase (#1929) — migrates the ad-hoc `gh`/`jq`/`git` glue *inside*
those scripts into tested `pipeline-cli` verbs. The founder's ordering ruling (#4435 comment
5112916299) is explicit that phase 1 moves the shell out **as-is — glue and all — and is
mechanical**; the glue→verb migration happens later, inside the scripts. What that left open
(#4447) is the boundary question: where does sanctioned orchestration in a script end, and
reimplemented decision logic — which must be a verb — begin? The candidate test recorded on the
epic's ledger was: *any logic whose output feeds a gate/merge/classification decision must be a
verb by end of the glue→verb phase.*

**Provenance.** The founder explicitly delegated this call to the chief-of-staff seat ("go with
your approval"). Per ADR [0078](0078-product-driven-decisions-by-default.md) this is
engineering-led platform territory, so it was ruled there rather than escalated — ruled and
recorded first-hand at #4447 comment 5113662215.

Adjacent rulings this decision sits alongside:

- #4435 comment 5112916299 — the `markdown → scripts → verbs` ordering; phase 1 mechanical.
- #4446 comment 5113523009 — the wide §CP row (the pipeline skills tree entirely) and the
  negative-case proof standard that produced it.
- The #4436 exclusions ruling (PR #4455's gate verdict, comment 5113399249) — condense/never-delete
  plus the no-other-home retention test.
- #4427 — four agent roles independently refused by the worktree guard on the shell forms the
  skills are written in, which is why extraction restores determinism to the merge procedure.

## Decision

**The test for what must be a `pipeline-cli` verb is derive-vs-relay: a script relays a verb's
decision, it never derives the decision itself.**

Two branches, each readable off a single script:

- **RELAY — sanctioned.** The script calls a `pipeline-cli` verb, receives its answer (exit code or
  stdout), and branches on it. The **verb** made the decision; the script routed it. A script may
  sequence verbs, pass one verb's output to another, and control flow on the results. This branch
  is also what sanctions a bash script orchestrating existing verbs as an accepted extraction
  target under the Node-over-shell convention.
- **DERIVE — banned.** The script computes the decision itself: matching the boundary regex in
  shell, re-implementing a classification, re-deriving a gate's arithmetic. That recreates untested
  glue one directory over — the same unverifiable `gh`/`jq`/`git` reasoning, now in `.sh` instead
  of `.md`, still with no unit tests.

The checkable question, which is the point of the amendment: **read one script and ask — did this
branch consult a verb, or compute the answer itself?**

**Why the candidate test was amended, not confirmed.** "Feeds a gate/merge/classification decision"
is not a discriminator, because in a merge-authority skill almost everything feeds the decision:
reading the head SHA feeds it, reading check-runs feeds it, resolving the changed-file set feeds
it. Taken literally, it would force nearly all of the merge skill's shell into verbs *in phase 1* —
directly contradicting the ordering ruling that phase 1 moves shell out as-is and is mechanical,
and defeating the plan's touch-each-§CP-file-once economy. A test that makes phase 1 a no-op
cannot be the right reading. Derive-vs-relay instead restates the founder's own formulation of the
target shape: **the skill invokes, the script implements, the verb decides.**

**What this does not settle — recorded as open, not glossed.** A script that reads **two** verbs'
outputs and combines them into a conclusion neither verb reached is arguably deriving. This ruling
does not resolve that case; it is named here as unresolved because a test that pretends to more
precision than it has is worse than one that marks its own boundary.

**Confidence and revision clause.** Confidence 8/10: no extracted script exists yet, so the test is
sound against the plan and the ordering ruling but untested against real code. The first extraction
child (#4448) is the first opportunity to falsify it. **If it does not discriminate cleanly there,
that is a finding, and this ruling should be amended rather than defended** — a decision that
forbids its own revision is worse than the ambiguity it replaced.

**Binding constraints.**
- Every decision-bearing branch in an extracted script consults a verb; sequencing verbs, piping
  one verb's output to another, and controlling flow on their results are all sanctioned.
- By end of the glue→verb phase (#1929), any decision a script still computes itself becomes a verb.
- The two-verbs-combined edge is unresolved; do not treat this ADR as ruling it either way.
- If #4448 shows the test does not discriminate cleanly, amend this ADR (dated `## Amendments`
  note or supersede) rather than defend it.

**Banned.**
- A script re-deriving in shell what a verb decides: boundary-regex matching, re-implemented
  classification, re-derived gate arithmetic.

## Consequences

- The seven extraction children apply one settled boundary instead of re-litigating it
  independently at one control-plane approval per round.
- Phase 1 stays mechanical: relay glue moves out as-is, and nothing forces verb-ification during
  the byte-move.
- Scope: per the #4435 ledger, #4447 gates **only** the glue→verb phase (#1929) — nothing in the
  current build waits on this ADR.
- The test carries a named blind spot (the two-verbs-combined case); the first real extraction is
  its falsification site, and an amendment there is the designed outcome, not a failure.

## Records

- Vocabulary impact: coins **derive-vs-relay** (the boundary test for extracted skill scripts:
  relay a verb's decision, never derive it). Routed to `.glossary/TERMS.md` via a filed report
  issue, since this PR touches only `.decisions/`.
- Records the ruling on #4447. The issue's enforcement question (a guard vs a norm for keeping new
  shell out of skill markdown) is **explicitly deferred** — it remains open on #4447, unruled by
  the recorded comment.
