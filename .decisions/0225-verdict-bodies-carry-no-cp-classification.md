---
id: 0225
title: Verdict bodies carry no machine-readable §CP classification
status: accepted
date: 2026-07-26
tags: [pipeline, control-plane, gates]
---

# 0225 — Verdict bodies carry no machine-readable §CP classification

**What this decides:** A review verdict will not gain a machine-readable "this PR is control-plane" field, and the merge gate will not read one as a second opinion — `ship-it` keeps working the classification out itself, at the head it is about to merge. This is a cost decision, not a safety concession: no unsafe divergence exists to protect against.

## Context

A report proposed that every review gate record two canonical lines in every verdict body it emits —
`CP-class:` (the resolved §CP state, the SHA it was computed at, the deriving verb, and the scanned
scope) and `Classes-present:` (the artifact classes the diff spans) — held to the same anchored-matcher
discipline ADR [0151](0151-cp-advisory-body-sha-resolves-approval-aware-enqueue.md) gave `Reviewed-head:`.
`ship-it` Step 0 would then read those fields off the latest current-head verdict, derive the
classification itself, and assert the two agree.

The proposal was pitched on a safety premise: *`ship-it` derives alone, so nothing in the system
disagrees with it.* **That premise did not survive grounding.** All six divergence paths between the
review-side and merge-side derivations were traced against `origin/main`, and **every one of them
terminates in a refusal to merge** — a bank or a stall, never a merge that should have banked:

| divergent input | review gate | `ship-it` Step 0 | direction |
| --- | --- | --- | --- |
| `CONTROL_PLANE_RE` read from the base ref fails | fail-closed default ⇒ every path §CP | same fail-closed default | bank |
| changed-file list unreadable | sentinels non-empty ⇒ §CP | prints `BLOCKING` and exits non-zero | bank |
| head SHA unreadable | ADR content unprobeable ⇒ held §CP | `BLOCKING` | bank |
| shared content probe returns an undetermined state | catch-all arm ⇒ §CP | catch-all arm ⇒ §CP | bank |
| head moved between review and ship | classification bound to the old head | re-derives at current head | stale-head marker ⇒ refuse |
| the boundary is amended between review and ship | read at review time | read at ship time — the newer, authoritative line | this live re-read *is* the #981 fix |

**Nothing disagrees with `ship-it` because nothing trusts it.** Step 0 reads no classification off any
verdict body; the only body-anchored field it consumes is `Reviewed-head:`, which carries the head, not
the class. A reviewer's classification — right or wrong — has zero influence on the merge gate's §CP
decision. That is precisely why a wrong reviewer classification cannot ship anything, and equally why no
cross-check exists today. **There is no control-plane fail-open here, and this ADR must never be cited
as accepting one.**

What survived the grounding was cost and auditability, not safety — which is what this decision weighs.

## Decision

**A review verdict body does not carry a machine-readable §CP classification, and the merge gate does not read one as a cross-check — `ship-it` continues to derive the classification itself, alone, at the current head.**

Two reasons, in the order they were weighed by the founder ruling on this question.

**1. The proposed cross-check has near-zero detection power.** The two derivations are not independent
in the sense that matters. Both read the **same** `CONTROL_PLANE_RE` from the **same** live source with
the **same** fail-closed default, and both call the **same** shared `guard-content-probe` verb
(ADR [0164](0164-guard-relaxing-adr-cp-gate.md)). They are two invocations of one recipe — one
hand-rolled copy each — not two implementations. So the failure modes a cross-check exists to catch (a
wrong-but-non-empty boundary regex on the base ref, a probe defect) are **shared-mode**: both sides
would compute the same wrong answer and agree, and the check would pass. The only class of error the
cross-check could actually catch is a transient read failure, and those already fail closed on both
sides independently — see the table above. A guard that agrees with itself on every failure it was
built for is not a guard.

**2. The cost is a change to what a verdict body *means*, across the whole gate surface.** The change
would touch a verdict-body contract in six review gates, plus the shared formats contract, plus two
`pipeline-cli` tools — and every one of those surfaces is §CP by path. That is a run of pull requests
each requiring a control-plane human approval, landing inside a milestone whose explicit goal is to
make these skills *smaller* and the human review load *smaller*. Paying that in human approvals for a
check with near-zero detection power inverts the milestone.

**Binding constraints.**
- `ship-it` must **NEVER** substitute a recorded classification for its own derivation at the current head. That is the #981 self-authorization class: trusting a reviewer-authored classification to authorize a control-plane merge. This ruling keeps the constraint trivially true by declining to record such a classification at all.
- If a future ADR reverses this and introduces a recorded field, it is a **cross-check only**, and the fail-closed direction is always toward §CP — disagreement, absence, or a stale-SHA binding must each refuse.
- The classification-site register in the shared formats contract stays as it is; this ruling changes no site's status.

**Banned.**
- Citing this ADR as evidence that a control-plane fail-open was accepted. No unsafe divergence was demonstrated; the decision rests on cost and detection power alone.
- Re-filing the auditability half as a fresh issue. It folds into the existing `cp-classify` migration work.

**The four sub-questions the source issue posed** — whether the field replaces or sits beside the prose
advisory, whether the hand-rolled→shared-verb migration lands first, whether `Classes-present:`
mechanizes the mixed-class routing-completeness rule, and what the fail-closed behavior on absence is —
are all **moot under this no**, and are recorded as such rather than left open. Only the third would
survive a future reversal as an independent question.

## Consequences

**What gets easier.** The verdict-body contract stays where it is: `Reviewed-head:` remains the single
anchored, matcher-read field, and no gate acquires a new emission obligation. Six §CP pull requests are
not spent. The #981 invariant needs no new enforcement surface, because there is no recorded
classification that could tempt a substitution.

**What stays harder — and is not dismissed.** The auditability concern from the report is real. A verdict
body today says "path-§CP **OR** content-§CP" without resolving which clause fired; it carries no
scanned-file count, no probed-ADR count, and no SHA binding for the classification. The computed scope
is echoed to the run log and dies with the run. And the derivation itself is still hand-rolled in three
skills while three others are already on the shared `cp-classify` verb.

That concern **folds into #4405**, which migrates `ship-it`'s hand-rolled derivation to the shared
`cp-classify` verb — the deduplication win without changing what a verdict *means*. It is deliberately
not re-filed as a separate issue.

**Reversal condition.** If the two derivations ever stop being invocations of one recipe — different
boundary sources, different probe implementations, or a genuinely independent second derivation — the
detection-power argument above lapses and the question is worth reopening. Until then it does not.

## Records

- Records the founder ruling on #4397 (the question was re-typed `decision` at triage; no code lands under it). That issue closes pointing here.
- The surviving auditability cost folds into #4405 — not re-filed.
- Related: #981 (the stale-snapshot self-authorization class), #4396, #1460.
- Related ADRs: [0053](0053-control-plane-boundary.md), [0065](0065-gate-critical-skills-are-blocking.md), [0073](0073-review-skill-gate.md), [0111](0111-blocking-set-verdicts-sha-less-by-design.md), [0151](0151-cp-advisory-body-sha-resolves-approval-aware-enqueue.md), [0164](0164-guard-relaxing-adr-cp-gate.md), [0218](0218-pipeline-cli-cp-enforcement-core.md).
- **Vocabulary impact: none.** This ADR rules on mechanics over already-named concepts (§CP classification, verdict body, the merge gate, the fail-closed direction) — it coins no term and redefines none.
