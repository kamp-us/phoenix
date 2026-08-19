---
id: 0233
title: New decision-computing shell is caught by a review-skill criterion row
status: accepted
date: 2026-07-30
tags: [pipeline, skills, review-gates, tooling]
---

# 0233 — New decision-computing shell is caught by a review-skill criterion row

**What this decides:** After the shell-extraction campaign, the thing that keeps *new*
decision-computing shell out of skill markdown and `scripts/` is a mandatory criterion row in the
review-skill gate — a reviewer applies ADR 0229's falsifiable test to every diff's new or changed
shell and writes a FAIL when it hits — rather than a CI scanner or a documented norm alone.

## Context

ADR [0231](0231-decision-computing-logic-becomes-a-verb.md) ruled the line for the whole
extracted-script corpus — a script may sequence `pipeline-cli` verbs and relay their answers, but
logic that *computes* a gate, merge, or classification decision becomes a verb — and explicitly
deferred its enforcement to #4527: what keeps NEW decision-deriving shell from re-entering skill
markdown (or `scripts/`) after the campaign? #4527 posed three candidate shapes: **(a)** a
fail-closed CI guard verb, **(b)** a criterion row in the review-skill gate (ADR
[0073](0073-review-skill-gate.md)), **(c)** a documented norm in a patterns doc. The founder ruled
on #4527 (issue comment 5137633837, 2026-07-31Z): **"go with b, implementation to successor."**

The rejected shapes, with the reasons as recorded in the ruling:

- **(a) A CI guard — rejected.** "Decision-deriving shell" is not a mechanically-checkable
  predicate: a scanner needs an arbitrary threshold, asserts less than its name implies, and joins
  the wrong-surface guard family (#4509) it exists to prevent. This is ADR
  [0229](0229-mechanical-combination-is-relay.md)'s guard-scoping objection, now ruled fatal for
  this question rather than left as review input. Had (a) won, the #4505 pre-build adversarial
  threat-model review would have been binding.
- **(c) A norm alone — rejected.** The campaign evidence cuts against it: every fail-open found
  during the extraction lived in decision-deriving shell (#4479/#4514, #4520, #4497), and a norm is
  what failed to prevent that class the first time. The patterns-doc note
  ([`.patterns/skill-script-shell-shape.md`](../.patterns/skill-script-shell-shape.md) and
  siblings) **accompanies** (b); it never replaces it.

Family boundary, so the four adjacent ADRs read as one line each: ADR
[0228](0228-scripts-relay-never-derive.md) coins the derive-vs-relay boundary, ADR
[0229](0229-mechanical-combination-is-relay.md) supplies the falsifiable test for it, ADR
[0231](0231-decision-computing-logic-becomes-a-verb.md) fixes its scope and phase-2 endpoint, ADR
0232 (in flight as PR #4559, cited by number because its file is not yet on `main`) rules how
extracted scripts are invoked — this ADR rules a third axis none of them touch: **where enforcement
of that line lives.** It also satisfies, rather than contradicts, 0229's and 0231's explicit
"enforcement is decided in #4527, nowhere else" deferrals: this is #4527's answer.

## Decision

**Enforcement of ADR 0231's line — new decision-computing shell must not enter skill markdown or
`scripts/` — lives as a criterion row in the review-skill gate: the reviewer judges each diff's new
or changed shell against ADR 0229's falsifiable test, and a hit is a FAIL row citing 0231.**

The test the row applies is exactly ADR [0229](0229-mechanical-combination-is-relay.md)'s derive
family, per diff hunk: does the new or changed shell add a threshold, a precedence between
disagreeing verbs, a tie-break, or a regex that reinterprets a verb's output? If yes, the shell
computes a decision, and the criterion fails with a row citing ADR
[0231](0231-decision-computing-logic-becomes-a-verb.md). A FAIL row on a §CP PR follows ADR
[0226](0226-cp-advisory-never-carries-a-failing-criterion.md): the gate emits its FAIL marker, never
an advisory carrying the failing row.

**Governed surface (falsifiable, so a phase-2 implementer applies it without relitigation):** both
skill markdown (`claude-plugins/kampus-pipeline/skills/**/SKILL.md` and sibling docs) **and**
`scripts/**` — anywhere shell a skill executes can carry a computed decision.

**Sequencing.** The criterion-row implementation is **successor-milestone work by explicit founder
ruling** — filed as #4560 (entering via `status:needs-triage`, placed in the successor milestone,
never m43), not built under #4527. Interim posture until the row lands: reviewers **may** already
FAIL on 0231 discretionarily; the row makes it mandatory.

**Binding constraints.**
- The 0231 line is enforced in the review-skill gate as a criterion row, applying 0229's test to
  each diff's new/changed shell; a hit is a FAIL row citing 0231.
- The governed surface is skill markdown and `scripts/**`, both.
- The row's implementation is successor-milestone work (#4560); m43 does not carry it.
- The patterns-doc note accompanies the row; it is documentation, not the enforcement.

**Banned.**
- A CI guard verb scanning for "decision-deriving shell" (the rejected shape (a)); reopening it
  without a new decision and the #4505 adversarial threat-model review.
- Treating the patterns-doc norm alone as the enforcement (the rejected shape (c)).
- Building the criterion row inside m43.

## Consequences

- The enforcement mechanism matches the predicate's nature: "did this shell compute a decision?" is
  a judgement call a reviewer can make per diff and a scanner cannot make honestly, so the check
  lives where judgement lives — the gate ADR [0073](0073-review-skill-gate.md) built precisely for
  behavioral properties of skill changes that mechanical gates are blind to. The shape has
  precedent: ADR [0119](0119-comment-discipline-is-an-independent-review-criterion.md) made comment
  discipline an independent review-code criterion for the same reason — a judgement predicate
  enforced as a gate row, not a scanner.
- No new guard surface: nothing joins the wrong-surface family (#4509), and no threat-model review
  is owed, because no scanner is built.
- The enforcement window 0229 and 0231 recorded as an open residual narrows now (discretionary
  FAILs are sanctioned immediately) and closes when #4560 lands the mandatory row.
- The cost of shape (b) stands accepted: enforcement is per-review judgement, so its consistency
  depends on the gate's checklist discipline rather than a deterministic scanner — the recorded
  trade against a guard that would assert less than its name.

## Records

- Records the founder ruling on #4527 (issue comment 5137633837): shape (b), implementation to
  successor. Closes #4527 — per its own acceptance criteria it closes on the recorded choice, and
  the follow-up implementation is filed as #4560.
- Contradiction sweep: 0228/0229/0231/0232 are the relay-boundary/test/scope/invocation family;
  this ADR rules the enforcement axis they each explicitly deferred to #4527 — no amendment needed.
  0073 (the gate this row extends) and 0226 (FAIL-not-advisory emission, which the row's FAIL
  follows) are consistent and cited.
- Vocabulary impact: **none.** "Criterion row", "review-skill gate", and the derive family are all
  already-named concepts; this ADR re-decides where enforcement lives, coining and redefining
  nothing. Considered and explicitly none.

> Amendment 2026-08-19: the governed skill-markdown surface is now `claude-plugins/fabrika/skills/**/SKILL.md` and sibling docs — `claude-plugins/kampus-pipeline/` was deleted (ADR 0303) and the review-skill gate it names is fabrika's `review` skill. `scripts/**` is unchanged; the decision itself stands.
