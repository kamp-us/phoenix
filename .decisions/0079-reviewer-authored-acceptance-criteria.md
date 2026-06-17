---
id: 0079
title: Reviewer-Authored Acceptance Criteria
status: proposed
date: 2026-06-16
tags: [pipeline, review, gates]
---

# 0079 — Reviewer-Authored Acceptance Criteria

## Context

Our gates verify a PR against the linked issue's `### Acceptance criteria` checklist (formats §2): the verdict is conjunctive — every criterion must PASS — and SHA-bound, ACL-authored, merge-gating. The AC list is authored once, upstream, by `triage` (Step 4 enrichment) and `plan-epic`, before any work starts.

This has a blind spot. A real defect that the linked issue's AC never named has **no home in any verdict**. The gate verifies against the named criteria and the fixed hygiene/rigor checklists; an in-scope omission triage under-specified — a swallowed fault, a missing invariant, an untested behavioral path that is genuinely part of "make this work" — sails through a green gate. There is no open-ended correctness sweep, by design (focus over nitpick-firehose), so the omission is structurally invisible.

The obvious fix — let reviewers emit open-ended findings with a severity/confidence rubric — bolts a *parallel* track onto the gate (advisory vs gating, severity tiers, a confidence floor) and reintroduces a convergence problem: open-ended findings over a changing diff regenerate each repair round and can outrun the fixer, burning the bounded repair budget and escalating PRs whose AC all pass.

Analysis of Anthropic's `pr-review-toolkit` plugin surfaced the reusable parts — specialist fan-out over one diff, confidence-floored reporting, adversarial enumeration as a forcing function — but its architecture (advisory, terminal-only, no PR-binding) is strictly weaker than ours. The asset is the prompts, not the plumbing.

## Decision

Reviewers route findings back into the single converging mechanism — the AC checklist — rather than onto a parallel track.

1. **Specialist fan-out.** Each `review-*` gate fans out parallel specialist dimensions over the diff (silent-failure, type-design, test-gap to start; deep-enough concerns earn a dedicated agent, thin ones stay a checklist line). The conjunctive AC verdict, its SHA-bound marker, and the single-merge-authority invariant are unchanged — the fan-out feeds findings, it does not replace the verdict.

2. **Route, don't grade.** A specialist finding is a binary routing decision, not a severity score:
   - **In-scope** — traces to the issue's stated goal/user-story (the same trace test `plan-epic` already enforces) → **append a new acceptance criterion** to the linked issue. The next `write-code` repair round drains it like any other `[FAIL]` row; the next review verifies it. The finding now lives in the finite, machine-readable, already-checked work-list that the loop is built to converge on.
   - **Out-of-scope** → **`report`** a new issue. The current PR is **not** blocked.

3. **Four invariants fence the new write surface:**
   - **Append-only.** Reviewers may *add* criteria, never edit or remove existing ones. Removing a criterion weakens the gate — the catastrophic case `review-skill`'s gate-invariant-preservation check exists to catch.
   - **In-scope-only.** The boundary is the trace-to-stated-goal test. Tangential findings go to `report`, never the AC list — this is what keeps the list from ballooning and the loop converging.
   - **ACL-gated.** Only a write+ reviewer's appended AC counts (ADR [0055](0055-author-bound-pass-marker.md) author-gate, resolved at the GitHub ACL, fails closed). Each appended AC is provenance-tagged so triage-authored vs review-authored stays auditable.
   - **Frozen after round K.** An AC appended in the final repair round escalates to a human instead of looping again, so append-rate can never outrun fix-rate.

## Consequences

- **Makes an invalid state representable.** "A real in-scope defect that triage under-specified" previously had nowhere to live in the verdict; it now lands in the same converging slot as every other criterion. No parallel severity/advisory machinery, no confidence threshold to tune — the routing decision is binary.
- **The convergence guarantee is preserved**, not weakened: the AC list stays finite and authored-toward-a-goal (in-scope-only + append-only + freeze-after-K), so the existing bounded `write-code` repair loop still terminates.
- **The AC contract becomes time-varying within a PR's lifecycle.** A worker can be graded against a criterion that did not exist at pickup; in the loop this self-corrects (the next round sees it), but it is a real change to "the contract is fixed at triage."
- **This extends `gh-issue-intake-formats.md`** (the AC contract — gate-critical/control-plane, human-merged, must clear `review-skill`) and touches `triage` (authors AC), all four `review-*` (now also route findings), `write-code` (drains appended ACs), and `plan-epic` (donates the trace boundary). It is an epic, not an edit.
- **The reviewer gains a write surface on the issue.** Fenced by ACL + append-only, but it is a new privilege; the provenance tag and the `review-skill` gate are what keep it honest.
