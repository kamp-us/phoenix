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

This lands on the same triage surface three live ADRs already govern, so the boundaries are stated here rather than left to be inferred. ADR [0202](0202-forward-motion-doctrine-crewops.md) (CrewOps forward-motion doctrine, same day) makes **kill/close a valid triage verdict** for work with no forward-motion answer, and *bans* such work surviving triage — so an unqualified "arc-unhomed work parks, it does not die" would hand triage two incompatible instructions for the same input. ADR [0203](0203-fog-reports-route-to-wayfinder-backlog.md) coins the `wayfinder:backlog` fog queue this ADR parks into and gives it exactly one exit — **charting** — with no time element, so an expiry clock over that label is a real change to 0203's rule. ADR [0072](0072-milestones-encode-strategic-sequencing.md) §4 (freeze-by-absence) makes milestone-*absence* the durable parked signal for deliberately-unmilestoned clusters, and those clusters demonstrably *do* carry the fog label — so a clock scoped by label alone would put a destructive timer on a state 0072 defines as deliberate and durable. The Decision below resolves all three on the record: a label-bounded park lane (0202), an explicit precedence rule for parked-by-design clusters (0072 §4), and a recorded partial amendment (0203).

## Decision

**The roadmap binds structurally at intake — pitch, platform lane quota, appetite circuit-breaker — and never blocks a merge; two coupled rulings (roster #3908, governance #3909).**

1. **Roster (#3908).** The factory thinks in four disciplines: **pipeline, product engineering, product management, product design.**

2. **Governance (#3909).** Direction binds at intake, never at merge:
   - A **pitch** — Problem / Arc / Appetite / Rabbit-holes / No-gos — is required at triage before work enters the drain. Arc-unhomed work **parks only when it carries the `wayfinder:backlog` fog label**; everywhere else **kill/close stays a valid triage verdict** per ADR [0202](0202-forward-motion-doctrine-crewops.md). Agents may DRAFT pitches; only the founder APPROVES — the betting-table verdict and the appetite number are founder seats that do not translate to agents.
   - **Platform work is budgeted, never exempted and never judged:** a **bounded lane quota per cycle**, and **over-quota platform work parks in priority order**. Founder-set: **2 of 6 lanes** per cycle. The quota **is** platform work's binding carrier — platform work is bound by the quota rather than by the arc test, which is why the permanently arc-less pipeline-hardening lane ([ROADMAP.md](../ROADMAP.md): "continuous, milestone-less … never a product arc") is neither parked nor exempted. The **unit is per cycle**, taken from the founder's written ruling on [#3909](https://github.com/kamp-us/phoenix/issues/3909#issuecomment-5076949710) ("a bounded lane quota per cycle; over-quota platform work parks in priority order"); the **2 of 6** number is founder-confirmed on this ADR's PR. Recorded here in the ruling's own unit so a later reader inherits what was decided rather than a paraphrase.
   - **Appetite is a circuit breaker:** a bet that exhausts its appetite auto-parks and requires a founder re-pitch — the factory cannot silently overspend founder intent.
   - **Fog-parked work auto-expires** — founder-set: **3 weeks** in the `wayfinder:backlog` lane. Important ideas come back with a pitch. The clock adds a second exit to the fog queue ADR [0203](0203-fog-reports-route-to-wayfinder-backlog.md) governs, amending it in part; and it **never runs on a parked-by-design cluster** — deliberately unmilestoned per ADR [0072](0072-milestones-encode-strategic-sequencing.md) §4, or the `axis:pipeline-hardening` standing lane of ADR [0208](0208-standing-lane-exemption-from-full-homing.md). 0208's other standing lane is `wayfinder:backlog` itself, and its exemption there is from **milestone homing**, not from this clock — uncharted fog still expires. Both boundaries are stated in the relationship paragraphs below.
   - A **cycle heartbeat** — a machine-computed arc/lane/appetite audit — is written for founder read every cycle. Founder-set cycle: **2 weeks**. The heartbeat is AUDIT, not enforcement.
   - **Explicitly rejected: any merge-blocking conformance gate on shipped work.** No finished PR ever fails for *direction*; merge gates stay mechanical **on the direction/roadmap-conformance axis**. This says nothing about the judgment-based quality gates the pipeline already runs (`review-code`, `review-doc`, `review-design`) — those keep failing PRs on judgment, and this clause is not a licence to delegitimize them.

**Relationship to ADR [0202](0202-forward-motion-doctrine-crewops.md) — this ADR amends it in part; it does not overturn it.** 0202 §3 prices every issue against forward motion and makes **kill/close a sanctioned triage verdict**, banning improvement-for-improvement's-sake from surviving triage. Founder ruling, 2026-07-25, verbatim: *"Parking is only for fog (`wayfinder:backlog`). Kill stays a valid triage verdict everywhere else."* So this ADR's park lane is a **bounded, label-keyed exemption** from 0202's kill verdict, not a replacement for it: arc-unhomed work outside the fog label still dies at triage exactly as 0202 says. The bound deliberately takes the same shape as the standing-lane exemption ADR [0208](0208-standing-lane-exemption-from-full-homing.md) draws — a narrow label-keyed carve-out rather than a general escape hatch. 0202 carries the reciprocal `amended-in-part by [0210]` status-line pointer; its body is untouched.

**Relationship to ADR [0203](0203-fog-reports-route-to-wayfinder-backlog.md) — this ADR amends it in part; it does not overturn it.** 0203 coins `wayfinder:backlog` as the cartographer's queue of fuzzy destinations and gives it exactly one exit: **charting**. It carries no time element anywhere. A 3-week expiry over that label therefore adds a *second* exit to 0203's queue, and the "unpitched" qualifier does not narrow it away — 0203's discriminator is "no buildable deliverable," while a pitch requires a nameable Problem / Arc / Appetite, so fog is unpitched by definition. Stated plainly rather than by qualifier: **the clock reaches the whole 0203 queue, minus the parked-by-design carve-out below.** Charting still works exactly as 0203 says — fog charted inside the window exits by 0203's original route and is never clocked out; only fog left uncharted for 3 weeks closes and comes back with a pitch. 0203 carries the reciprocal `amended-in-part by [0210]` status-line pointer; its body is untouched.

**Relationship to ADR [0072](0072-milestones-encode-strategic-sequencing.md) §4 — 0072 §4 outranks this ADR's park lane; the clock never reaches a parked-by-design cluster.** 0072 §4 makes milestone-absence itself the durable parked signal ("Absence is meaningful — don't invent homes for frozen work"). The two rules key off **orthogonal dimensions** — 0072 §4's signal is milestone-*absence*, this ADR's park lane is a *label* — so one issue can carry both, and the live board already holds several that do. ADR [0208](0208-standing-lane-exemption-from-full-homing.md) goes further still, relocating freeze-by-absence's signal *into* the `wayfinder:backlog` label as a permanent, milestone-less workstream. The sets therefore intersect **by design**, so the reconciliation is a **precedence rule, not a disjointness claim**: **a cluster parked by design — deliberately unmilestoned per 0072 §4, or the `axis:pipeline-hardening` standing lane of 0208 — is neither clocked nor killed.** That precedence is tested first and outranks both the 3-week expiry and 0202's kill verdict, which is what keeps the deliberately-unmilestoned new products (imge, kampus-CLI, künye) frozen rather than expired or closed. **0208's exemption is scoped to milestone homing and does not carry into this clock.** 0208 exempts exactly two labels from the 100%-homed rule; it says nothing about expiry, and one of those two labels *is* the fog label. Reading it as clock-immunity would make every fog issue match the parked-by-design test first, leaving the founder's 3-week expiry unreachable — a silent repeal. So only `axis:pipeline-hardening` takes the exemption here (it is arc-less, and without it would fall through to 0202's kill verdict); `wayfinder:backlog` is exempt from *homing*, not from the clock, and uncharted fog still expires at 3 weeks. Precedence leaves 0072's own rule intact, so **this ADR does not amend 0072** and its status line is untouched here.

**Alternatives considered and rejected.**
- A merge-blocking work↔roadmap conformance gate — rejected: its exemption class swallows or blocks it, it checks provenance not alignment, and it fires at the most expensive moment.
- A fully non-binding roadmap with heartbeat-only oversight — rejected: its entire enforcement is founder attention, absent in the AFK regime.

**Binding constraints.**
- Pitch approval and the appetite number are founder seats; an agent may draft, never approve.
- Platform work is capped at the founder-set lane quota **per cycle** (2 of 6 lanes); over-quota platform work parks in priority order.
- An appetite-exhausted bet auto-parks pending founder re-pitch — never silently continues.
- **Triage** parking is bounded to the `wayfinder:backlog` fog label; kill/close per ADR [0202](0202-forward-motion-doctrine-crewops.md) stays the triage verdict everywhere else. (The appetite-exhaustion and over-quota parks above are in-drain parks of already-admitted work, not triage dispositions, so this bound does not reach them.)
- Fog-parked work expires at the founder-set window (3 weeks), amending ADR [0203](0203-fog-reports-route-to-wayfinder-backlog.md) in part; a parked-by-design cluster (0072 §4, or the `axis:pipeline-hardening` standing lane of ADR [0208](0208-standing-lane-exemption-from-full-homing.md)) is exempt from both the clock and 0202's kill verdict, and that exemption is tested first. 0208's exemption for `wayfinder:backlog` is from milestone homing only — it never confers clock-immunity, or the expiry would be unreachable.
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
- Fog-parked work carries an expiry cost: outside the parked-by-design exemption, an uncharted idea must be re-argued within 3 weeks or re-enter later with a pitch. ADR 0203's charting exit is unchanged and remains the ordinary way out.
- Triage reaches exactly one disposition per issue, so no agent has to choose between two ADRs. The classes are **ordered**, not disjoint — an issue can satisfy more than one, so the tests run in sequence and the first match wins: (1) **parked by design** (deliberately unmilestoned per 0072 §4, or the `axis:pipeline-hardening` standing lane of 0208 — *not* `wayfinder:backlog`, whose 0208 exemption is from milestone homing rather than from the clock) ⇒ stays frozen — never clocked, never killed; (2) else **fog-labelled** (`wayfinder:backlog`) ⇒ parks with the 3-week clock; (3) else **arc-unhomed** ⇒ kill/close per 0202.

## Records

- Decided on wayfinder:map #3227 (frontier tickets #3904, #3907, #3908, #3909, #3927); emitted build epics: #3947 (intake machinery), #3948 (heartbeat); related: #3946, #3949.
- **Amends in part** ADR [0202](0202-forward-motion-doctrine-crewops.md) — bounds its kill verdict with the `wayfinder:backlog` fog park lane (founder ruling, 2026-07-25, recorded on this ADR's PR). 0202 carries the reciprocal status-line pointer; its body is unedited.
- **Amends in part** ADR [0203](0203-fog-reports-route-to-wayfinder-backlog.md) — adds a 3-week expiry as a second exit from the `wayfinder:backlog` fog queue, where 0203 gave it only charting. 0203 carries the reciprocal status-line pointer; its body is unedited.
- Cross-references ADR [0072](0072-milestones-encode-strategic-sequencing.md) §4 (freeze-by-absence) — 0072 §4 **outranks** this ADR's expiry clock and 0202's kill verdict for parked-by-design clusters. Precedence leaves 0072's rule intact, so 0072 is unamended and its status line is untouched.
- Cross-references the standing-lane exemption of ADR [0208](0208-standing-lane-exemption-from-full-homing.md) — as the precedent shape for a label-keyed bound, and, for `axis:pipeline-hardening` only, as the second carrier of the parked-by-design exemption above. 0208's `wayfinder:backlog` exemption is scoped to milestone homing and does not reach this ADR's clock.
- Relates to ADR [0078](0078-product-driven-decisions-by-default.md) — names the founder's intent-seat structurally.
- Vocabulary impact: coins **pitch**, **appetite**, **betting table**, and **cycle heartbeat** in the factory-governance sense — rows added to `.glossary/TERMS.md` in this PR.
