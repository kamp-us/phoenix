---
id: 0214
title: An active campaign confers `p1` exactly as the active arc does (amends 0202 in part)
status: superseded by [0219](0219-priority-decoupled-from-campaign-membership.md)
date: 2026-07-25
tags: [process, prioritization, triage, pipeline]
---

# 0214 — An Active Campaign Confers `p1` Exactly as the Active Arc Does (amends 0202 in part)

**What this decides:** `p1` is not reserved for the one active product arc — work homed in any *active campaign* earns `p1` too. The triage rubric only ever named arcs, which accidentally made every `p1` on the board invalid; this fixes the bound, and `p1` stays milestone-relative rather than becoming a general "worth doing soon" tier.

## Context

Superseded by [0219](0219-priority-decoupled-from-campaign-membership.md).

Founder ruling, 2026-07-25, in conversation — recorded on the conversation-authored path (ADR 0075). It resolves a fork escalated from the intake-desk retro sweep on issue #3939.

The triage rubric (`claude-plugins/kampus-pipeline/skills/triage/SKILL.md` Step 6) defined the `p1` row as *"Serves the active milestone — the arc pinned by `ROADMAP.md`'s single `active` `## Arcs` row."* It named **arcs only**. But `ROADMAP.md` carries exactly one `active` arc — **Geçit (#24)** — alongside **12 active campaigns**.

The retro sweep measured the collision directly: of the **34 open `p1` issues created 2026-07-24..25, zero serve Geçit** — all of them are campaign work. Under a literal reading of the rubric, every `p1` on the board was invalid *by construction*. Six independent read-only verdict batches hit the same ambiguity and split on the remedy: some repriced campaign `p1`s up to `p0`, others down to `p2`. Both readings were defensible from the text.

This sits on ADR 0072 (milestones encode strategic sequencing), ADR 0078 (engineering leads on platform/infra), and ADR 0208 (standing lanes are milestone-less by design). It **amends in part** ADR 0202 — specifically the priority rubric that decision drove into the triage skill.

## Decision

**An active campaign confers a `p1` band exactly as the active arc does; `p1` is bounded to "an active arc *or* an active campaign", not to the single active arc alone.**

The rubric's `p1` row was **under-specified, not intentionally arc-exclusive**. Campaigns are milestone-backed pushes that run *concurrently* with the active product arc through the platform lane (ADR 0072 semantics, ADR 0078 engineering-led) — a roadmap object of the same standing as an arc for sequencing purposes.

The rejected alternative — `p1` reserved to the active arc alone — would have flattened the entire pipeline-hardening and crew-mechanics backlog to `p2`, leaving it unsequenceable, and would contradict the standing position that pipeline hardening is a priority lane rather than background work.

`p1` remains **milestone-relative and bounded**. The bound moves from *"the active arc"* to *"an active arc or an active campaign"* — it does not dissolve.

**Binding constraints.**

- `p1` requires a home in an `active` `## Arcs` row **or** an `active` `## Campaigns` row of `ROADMAP.md`.
- An issue homed in neither is not `p1` — `p1` is never a general "worth doing soon" tier.
- A `done` or `queued` arc/campaign confers nothing; only `active` state does.
- `p0` semantics are untouched — ADR 0202 §1/§2 stand unchanged.

## Consequences

- **The existing campaign-homed `p1` issues are valid as they stand.** No repricing is owed, and the retro sweep's proposed `p1 → p2` batch is void.
- **`p0` is unaffected.** Whether a given campaign-homed `p1` should escalate to `p0` is a separate per-issue judgment this ADR does not settle.
- **The `p1` set grows.** Twelve active campaigns plus one active arc is a wider band than one arc, so `p1` carries less discriminating power than the rubric's "bounded set" language assumed. The discipline that keeps it honest is the state column: campaigns that finish must be moved to `done` promptly, or the band inflates by neglect.
- **`ROADMAP.md` line 11 still reads `p1` = current arc.** That line is founder-voice and revised on the conversation-authored path (ADR 0075), so it is deliberately not reconciled here; it disagrees with this ADR until the founder calls it. This ADR governs in the interim.
- **The ambiguity class is worth noting.** The rubric named one roadmap object (`## Arcs`) while `ROADMAP.md` carried two kinds. Any future rubric that keys on roadmap structure should name every object kind it means, or say explicitly which it excludes and why.

## Records

- **Vocabulary impact: none.** Re-prices already-named concepts — `arc`, `campaign` (both in `.glossary/TERMS.md`), and the `p0`/`p1`/`p2` tiers from ADR 0202's rubric.
- Resolves the `p1` fork escalated on #3939 by the intake-desk retro sweep; routed to build as #4072.
