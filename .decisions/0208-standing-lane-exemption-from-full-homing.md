---
id: 0208
title: Standing lanes exempt from 100%-homed — exactly `wayfinder:backlog` + `axis:pipeline-hardening`
status: amended-in-part by [0286](0286-standing-lanes-come-from-config.md)
date: 2026-07-24
tags: [process, prioritization, triage, pipeline]
---

# 0208 — Standing lanes exempt from 100%-homed — exactly `wayfinder:backlog` + `axis:pipeline-hardening`

**What this decides:** Every open issue must live in a milestone (an arc or campaign) or be killed — except issues carrying one of exactly two labels, `wayfinder:backlog` and `axis:pipeline-hardening`, which are permanent milestone-less lanes by design; nothing else gets that exemption without a founder ruling.

## Context

Extends the CrewOps forward-motion doctrine (ADR [0202](0202-forward-motion-doctrine-crewops.md) — do not edit it; this ADR records the extension). Founder ruling, 2026-07-24, in conversation on issue #3894 — recorded on the conversation-authored path (ADR [0075](0075-issueless-doc-pr-merge-seam.md)).

The founder-directed home-or-kill sweep (#3894) drove the open backlog to 100% arc/campaign-homed: every open issue carries a milestone or dies. The sweep surfaced classes of issues that are milestone-less **by design**:

- **Fog** (`wayfinder:backlog`) is *upstream* of arcs (ADR [0203](0203-fog-reports-route-to-wayfinder-backlog.md)): it gets homed when it gets charted, not before. Forcing a milestone onto uncharted fog pre-classifies work whose shape is not yet known.
- **Pipeline hardening** (`axis:pipeline-hardening`) is a permanent lane, not an arc — it never "completes" into a milestone.

Forcing milestones onto either class would make the milestone counts lie, defeating the legibility goal the 100%-homed rule exists for.

### Relationship to ADR 0072 — amended in part

The 100%-homed rule collides with a live decision. ADR [0072](0072-milestones-encode-strategic-sequencing.md) §4 (**freeze-by-absence** — "deliberately leaving a cluster unmilestoned … is itself the signal that it is parked / deferred. Absence is meaningful — don't invent homes for frozen work") and §5 (**milestone is an optional pipeline dimension**) both say the opposite of "every open issue is milestone-homed or killed". That relationship is stated here rather than left implicit, and 0072's status line carries the forward pointer to this ADR.

**What this ADR amends in 0072, and how.** For every open issue *outside* the two exempt labels, milestone is no longer optional (§5) and a bare absence no longer reads as "parked by design" (§4) — it reads as un-triaged, and the issue is homed or killed per ADR [0202](0202-forward-motion-doctrine-crewops.md).

**What survives of freeze-by-absence.** The signal it carried — *this work is parked by design; don't force-fit it* — is not retired; it moves from an absence to a label. `wayfinder:backlog` and `axis:pipeline-hardening` are that same signal in explicit, greppable form: the standing-lane exemption **is** freeze-by-absence made legible. This is also why 0072's own Consequence ("if every issue gets a milestone, absence stops meaning anything and the deferral signal is lost") no longer binds — under this ADR the deferral signal does not ride on absence at all, so homing everything else cannot dilute it.

**Untouched in 0072:** §1 (milestones encode strategic sequencing, not feature breakdown), §2 (surface vs strategic kinds), §3 (the set stays small and human-curated), and the p0-stays-sovereign consequence.

## Decision

**The 100%-homed rule has a standing-lane exemption for exactly two labels — `wayfinder:backlog` and `axis:pipeline-hardening` — and nothing else inherits it without a founder ruling.**

A **standing lane** is a permanent, milestone-less workstream: work that is milestone-less by design, not by neglect. There are exactly two, and the exemption is the label, not a category — no third label, class, or judgment call inherits it. The declared end state of the open backlog is: milestone counts + the two exempt labels = the whole open backlog. Nothing open sits outside both.

Consequence for triage and sweeps: a home-or-kill pass treats an issue bearing either label as exempt — skip it, don't force-fit a milestone. Every other open issue takes a real home in an existing wave or is killed per ADR [0202](0202-forward-motion-doctrine-crewops.md).

**Binding constraints.**
- Exactly two exempt labels: `wayfinder:backlog` and `axis:pipeline-hardening`.
- Extending the exemption to any other label/class requires a founder ruling.
- Home-or-kill sweeps skip exempt-labeled issues; they never force-fit a milestone onto them.
- Every other open issue is milestone-homed or killed (ADR 0202) — this amends ADR [0072](0072-milestones-encode-strategic-sequencing.md) §4 and §5 in part, per Context above.

**Banned.**
- A third milestone-less category minted without a founder ruling.
- Milestones on `wayfinder:backlog` fog (it homes at charting time, ADR 0203) or on `axis:pipeline-hardening` items.

## Consequences

- Milestone counts stay honest: they measure homed, in-motion work, undiluted by design-time-unhomeable classes.
- The whole open backlog is legible from two reads: the milestone roster plus the two exempt labels.
- Triage/sweep logic gets a mechanical skip rule (label match) instead of per-issue judgment about what "counts" as homeable.
- The exemption is deliberately rigid: a genuinely new standing lane must go through the founder, which is friction — accepted, because a quietly growing exemption list is exactly the milestone-counts-lie failure this prevents.

## Records

- Ruling source: issue #3894 (the home-or-kill sweep + the recorded founder ruling, 2026-07-24).
- Amends ADR [0072](0072-milestones-encode-strategic-sequencing.md) §4 / §5 in part; 0072's status line points forward to this ADR.
- Vocabulary impact: coins **standing lane** — routed to `.glossary/TERMS.md` in this PR.
