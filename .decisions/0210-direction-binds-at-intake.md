---
id: 0210
title: Direction binds at intake — pitch, platform quota, appetite circuit-breaker; never a merge gate
status: accepted
date: 2026-07-24
tags: [governance, roadmap, pipeline]
---

# 0210 — Direction binds at intake — pitch, platform quota, appetite circuit-breaker; never a merge gate

**What this decides:** The roadmap steers the factory at the moment work is *admitted* — a founder-approved pitch at triage, a lane quota for platform work, an appetite budget that auto-parks an overspent bet — and never by failing a finished PR at merge time.

## Context

Founder ruling, 2026-07-24, on wayfinder:map #3227 (frontier tickets #3904, #3907, #3908, #3909, #3927). The factory is built to run AFK. Attention-based enforcement — a human reading reports and steering by hand — is absent exactly when it matters, so direction must bind *structurally*, through a carrier the org cannot skip. Intake is the seam where that binding is cheap, judgment-free, and never wastes a finished build; merge is the most expensive possible moment to discover misdirection.

A ship-time conformance gate was analyzed and rejected: its exemption class (legitimate maintenance/platform work, the bulk of the backlog) either swallows the gate or gets blocked by it; it checks provenance metadata rather than actual alignment; and it catches misdirection after the build is already paid for. The adopted pattern follows the studied exemplars (Shape Up's shaped pitch / appetite / betting table; cadence heartbeats): doctrine + a binding carrier the org cannot skip + a named human seat for the calls doctrine cannot discharge.

This lands on the same triage surface two live ADRs already govern, so the boundaries are stated here rather than left to be inferred. ADR [0202](0202-forward-motion-doctrine-crewops.md) (CrewOps forward-motion doctrine, same day) makes **kill/close a valid triage verdict** for work with no forward-motion answer, and *bans* such work surviving triage — so an unqualified "arc-unhomed work parks, it does not die" would hand triage two incompatible instructions for the same input. ADR [0072](0072-milestones-encode-strategic-sequencing.md) §4 (freeze-by-absence) makes milestone-*absence* the durable parked signal for deliberately-unmilestoned clusters — so an unqualified expiry clock would put a destructive timer on a state 0072 defines as deliberate and durable. The founder ruling recorded in the Decision below bounds this ADR's park lane so neither collision exists.

## Decision

**The roadmap binds structurally at intake — pitch, platform lane quota, appetite circuit-breaker — and never blocks a merge; two coupled rulings (roster #3908, governance #3909).**

1. **Roster (#3908).** The factory thinks in four disciplines: **pipeline, product engineering, product management, product design.**

2. **Governance (#3909).** Direction binds at intake, never at merge:
   - A **pitch** — Problem / Arc / Appetite / Rabbit-holes / No-gos — is required at triage before work enters the drain. Arc-unhomed work **parks only when it carries the `wayfinder:backlog` fog label**; everywhere else **kill/close stays a valid triage verdict** per ADR [0202](0202-forward-motion-doctrine-crewops.md). Agents may DRAFT pitches; only the founder APPROVES — the betting-table verdict and the appetite number are founder seats that do not translate to agents.
   - **Platform work is budgeted, never exempted and never judged:** a lane quota caps concurrent platform builds. Founder-set: **2 of 6 lanes**. The quota **is** platform work's binding carrier — platform work is bound by the quota rather than by the arc test, which is why the permanently arc-less pipeline-hardening lane ([ROADMAP.md](../ROADMAP.md): "continuous, milestone-less … never a product arc") is neither parked nor exempted.
   - **Appetite is a circuit breaker:** a bet that exhausts its appetite auto-parks and requires a founder re-pitch — the factory cannot silently overspend founder intent.
   - **Fog-parked unpitched work auto-expires** — founder-set: **3 weeks**. Important ideas come back with a pitch. The clock runs on the fog park lane only; it does not reach ADR [0072](0072-milestones-encode-strategic-sequencing.md) §4's deliberately-unmilestoned clusters.
   - A **cycle heartbeat** — a machine-computed arc/lane/appetite audit — is written for founder read every cycle. Founder-set cycle: **2 weeks**. The heartbeat is AUDIT, not enforcement.
   - **Explicitly rejected: any merge-blocking conformance gate on shipped work.** No finished PR ever fails for *direction*; merge gates stay mechanical **on the direction/roadmap-conformance axis**. This says nothing about the judgment-based quality gates the pipeline already runs (`review-code`, `review-doc`, `review-design`) — those keep failing PRs on judgment, and this clause is not a licence to delegitimize them.

**Relationship to ADR [0202](0202-forward-motion-doctrine-crewops.md) — this ADR amends it in part; it does not overturn it.** 0202 §3 prices every issue against forward motion and makes **kill/close a sanctioned triage verdict**, banning improvement-for-improvement's-sake from surviving triage. Founder ruling, 2026-07-25, verbatim: *"Parking is only for fog (`wayfinder:backlog`). Kill stays a valid triage verdict everywhere else."* So this ADR's park lane is a **bounded, label-keyed exemption** from 0202's kill verdict, not a replacement for it: arc-unhomed work outside the fog label still dies at triage exactly as 0202 says. The bound deliberately takes the same shape as the standing-lane exemption ADR 0208 draws — a narrow label-keyed carve-out rather than a general escape hatch. (0208 is not yet on `main`; it is cited by its open lane, PR #3896, rather than by a link that would not resolve.) 0202 carries the reciprocal `amended-in-part by [0210]` status-line pointer; its body is untouched.

**Relationship to ADR [0072](0072-milestones-encode-strategic-sequencing.md) §4 — no overlap, by construction of the fog bound.** 0072 §4 makes milestone-absence itself the durable parked signal ("Absence is meaningful — don't invent homes for frozen work"). Because the 3-week expiry runs only on fog-labelled parked work, it never puts a clock on those clusters — absence stays meaningful and un-expiring. 0072 is unamended and its status line is untouched.

**Alternatives considered and rejected.**
- A merge-blocking work↔roadmap conformance gate — rejected: its exemption class swallows or blocks it, it checks provenance not alignment, and it fires at the most expensive moment.
- A fully non-binding roadmap with heartbeat-only oversight — rejected: its entire enforcement is founder attention, absent in the AFK regime.

**Binding constraints.**
- Pitch approval and the appetite number are founder seats; an agent may draft, never approve.
- Concurrent platform builds are capped at the founder-set lane quota (2 of 6).
- An appetite-exhausted bet auto-parks pending founder re-pitch — never silently continues.
- Parking is bounded to the `wayfinder:backlog` fog label; kill/close per ADR [0202](0202-forward-motion-doctrine-crewops.md) stays the triage verdict everywhere else.
- Fog-parked unpitched work expires at the founder-set window (3 weeks); no expiry clock touches 0072 §4 parked-by-absence clusters.
- The cycle heartbeat is read-only audit; it gates nothing.

**Banned.**
- Any merge-blocking direction/roadmap-conformance gate on a finished PR.
- An unbounded park lane — parking any arc-unhomed issue regardless of label, which would make the unmilestoned pile the steady state and read as a repeal of 0202's kill verdict.
- Agent-approved pitches or agent-set appetites.
- Platform-work exemptions from the intake binding (it is budgeted via the quota, not exempted, not judged per-item).

This names the founder's intent-seat structurally — the same boundary ADR [0078](0078-product-driven-decisions-by-default.md) draws for decisions, drawn here for direction: the machine carries and enforces the structure; the judgment calls (the bet, the budget) stay human.

## Consequences

- Direction holds while the founder is AFK: the pitch requirement, quota, appetite breaker, and expiry are structural, not attention-based.
- No finished build is ever wasted on a direction verdict — misalignment is caught before work starts, at the cheap seam.
- Triage grows an intake obligation (pitch present + active arc, else fog-park or kill); the intake machinery is epic #3947, the heartbeat is epic #3948.
- The founder gains a bounded, periodic read (the 2-week heartbeat) instead of a standing report-reading duty.
- Fog-parked work carries an expiry cost: an unpitched idea must be re-argued within 3 weeks or re-enter later with a pitch.
- Triage keeps exactly one disposition per input class, so no agent has to choose between two ADRs: fog-labelled and arc-unhomed ⇒ park (3-week clock); arc-unhomed outside fog ⇒ kill/close per 0202; deliberately unmilestoned per 0072 §4 ⇒ stays frozen, no clock.

## Records

- Decided on wayfinder:map #3227 (frontier tickets #3904, #3907, #3908, #3909, #3927); emitted build epics: #3947 (intake machinery), #3948 (heartbeat); related: #3946, #3949.
- **Amends in part** ADR [0202](0202-forward-motion-doctrine-crewops.md) — bounds its kill verdict with the `wayfinder:backlog` fog park lane (founder ruling, 2026-07-25, recorded on this ADR's PR). 0202 carries the reciprocal status-line pointer; its body is unedited.
- Cross-references ADR [0072](0072-milestones-encode-strategic-sequencing.md) §4 (freeze-by-absence) — no overlap, so 0072 is unamended.
- Cross-references the standing-lane exemption of ADR 0208 (open lane, PR #3896) as the precedent shape for a label-keyed bound.
- Relates to ADR [0078](0078-product-driven-decisions-by-default.md) — names the founder's intent-seat structurally.
- Vocabulary impact: coins **pitch**, **appetite**, **betting table**, and **cycle heartbeat** in the factory-governance sense — rows added to `.glossary/TERMS.md` in this PR.
