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

## Decision

**The roadmap binds structurally at intake — pitch, platform lane quota, appetite circuit-breaker — and never blocks a merge; two coupled rulings (roster #3908, governance #3909).**

1. **Roster (#3908).** The factory thinks in four disciplines: **pipeline, product engineering, product management, product design.**

2. **Governance (#3909).** Direction binds at intake, never at merge:
   - A **pitch** — Problem / Arc / Appetite / Rabbit-holes / No-gos — is required at triage before work enters the drain. Work serving no active roadmap arc **parks** (it does not die). Agents may DRAFT pitches; only the founder APPROVES — the betting-table verdict and the appetite number are founder seats that do not translate to agents.
   - **Platform work is budgeted, never exempted and never judged:** a lane quota caps concurrent platform builds. Founder-set: **2 of 6 lanes**.
   - **Appetite is a circuit breaker:** a bet that exhausts its appetite auto-parks and requires a founder re-pitch — the factory cannot silently overspend founder intent.
   - **Parked-unpitched work auto-expires** — founder-set: **3 weeks**. Important ideas come back with a pitch.
   - A **cycle heartbeat** — a machine-computed arc/lane/appetite audit — is written for founder read every cycle. Founder-set cycle: **2 weeks**. The heartbeat is AUDIT, not enforcement.
   - **Explicitly rejected: any merge-blocking conformance gate on shipped work.** No finished PR ever fails for direction; merge gates stay mechanical.

**Alternatives considered and rejected.**
- A merge-blocking work↔roadmap conformance gate — rejected: its exemption class swallows or blocks it, it checks provenance not alignment, and it fires at the most expensive moment.
- A fully non-binding roadmap with heartbeat-only oversight — rejected: its entire enforcement is founder attention, absent in the AFK regime.

**Binding constraints.**
- Pitch approval and the appetite number are founder seats; an agent may draft, never approve.
- Concurrent platform builds are capped at the founder-set lane quota (2 of 6).
- An appetite-exhausted bet auto-parks pending founder re-pitch — never silently continues.
- Parked-unpitched work expires at the founder-set window (3 weeks).
- The cycle heartbeat is read-only audit; it gates nothing.

**Banned.**
- Any merge-blocking direction/conformance gate on a finished PR.
- Agent-approved pitches or agent-set appetites.
- Platform-work exemptions from the intake binding (it is budgeted via the quota, not exempted, not judged per-item).

This names the founder's intent-seat structurally — the same boundary ADR [0078](0078-product-driven-decisions-by-default.md) draws for decisions, drawn here for direction: the machine carries and enforces the structure; the judgment calls (the bet, the budget) stay human.

## Consequences

- Direction holds while the founder is AFK: the pitch requirement, quota, appetite breaker, and expiry are structural, not attention-based.
- No finished build is ever wasted on a direction verdict — misalignment is caught before work starts, at the cheap seam.
- Triage grows an intake obligation (pitch present + active arc, else park); the intake machinery is epic #3947, the heartbeat is epic #3948.
- The founder gains a bounded, periodic read (the 2-week heartbeat) instead of a standing report-reading duty.
- Parked work carries an expiry cost: an unpitched idea must be re-argued within 3 weeks or re-enter later with a pitch.

## Records

- Decided on wayfinder:map #3227 (frontier tickets #3904, #3907, #3908, #3909, #3927); emitted build epics: #3947 (intake machinery), #3948 (heartbeat); related: #3946, #3949.
- Relates to ADR [0078](0078-product-driven-decisions-by-default.md) — names the founder's intent-seat structurally.
- Vocabulary impact: coins **pitch**, **appetite**, **betting table**, and **cycle heartbeat** in the factory-governance sense — rows added to `.glossary/TERMS.md` in this PR.
