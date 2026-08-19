---
id: 0219
title: Campaign membership confers a home, never a priority band (supersedes 0214)
status: accepted
date: 2026-07-26
tags: [process, prioritization, triage, pipeline]
---

# 0219 — Campaign membership confers a home, never a priority band (supersedes 0214)

**What this decides:** Being homed in an active campaign no longer earns an issue any priority label. Every issue still needs a home — that requirement is untouched — but its priority is now judged purely on the value of the work itself, so product work outside every campaign can outrank factory work inside one.

## Context

Founder ruling, 2026-07-26, in conversation — recorded on the conversation-authored path (ADR [0075](0075-issueless-doc-pr-merge-seam.md)).

Supersedes [0214](0214-active-campaign-confers-p1.md). Amends in part [0202](0202-forward-motion-doctrine-crewops.md) — see the ruling on §2 below.

ADR 0214 (grounded on `origin/main` at commit `3c3a63b`) says two different things about the same question, and both readings are in live use. Its `## Decision` states a **sufficiency** rule:

> **An active campaign confers a `p1` band exactly as the active arc does; `p1` is bounded to "an active arc *or* an active campaign", not to the single active arc alone.**

Its `**Binding constraints.**` list states a **necessity** rule:

> - `p1` requires a home in an `active` `## Arcs` row **or** an `active` `## Campaigns` row of `ROADMAP.md`.
> - An issue homed in neither is not `p1` — `p1` is never a general "worth doing soon" tier.

"Confers" and "requires" are not the same rule. A reader who takes the first reads campaign membership as *earning* a band; a reader who takes the second reads it as a *floor gate* on a band assigned some other way. The two diverge the moment an agent asks whether campaign-homed work may exceed `p1`.

**The divergence is measured, not hypothetical.** Two sibling issues in the same milestone (`Pipeline Anywhere campaign`), triaged six minutes apart by the same audit on 2026-07-26, were labeled from the same ADR and came out opposite (label timings read live from the REST API):

- **#4268** was labeled `p1` + `status:triaged` at 19:23:48Z. The triage declined to mint `p0`, on the reasoning that campaign-homed work tops out at `p1` and a `p0` would be rubric-violating.
- **#4271** was labeled `p0` + `status:triaged` at 19:29:49Z — campaign-homed work in the same milestone, minted `p0` without difficulty.

(The label names and timestamps are verified live against the REST API; the `p1` triage's stated reasoning is as reported by the audit that produced both.)

Both agents applied the ADR in good faith. The text supports both.

**The board-level failure it caused.** #4226 (closed) measured, live, that all **19** open `p0` issues were factory/pipeline work and **zero** were product; 13 of the 19 sat in one factory milestone and 11 of those were a single crew-teardown epic, while the whole long-form reader backlog, the whole taste-skill library, and the undefined new-user onboarding journey sat at `p2`/`p1`. The mechanism it named is the conferral reading: factory work lives in campaigns and inherits a band; product work lives in no campaign and never rises. A founder-approved manual re-level on 2026-07-26 took `p0` from 19 down to single digits (7 open `p0` measured at the time of writing). Its stated purpose was that **`p0` should encode value, not campaign membership** — and the founder approved and executed exactly that. This ADR records the rule that action already implies, so the skew cannot re-seed the next time a campaign opens.

**Two live ADRs already point this way and need no amendment.** ADR [0072](0072-milestones-encode-strategic-sequencing.md) §"p0 stays sovereign" already ruled that milestone preference must never override priority — "campaign bias is a within-bucket tiebreaker … not a re-ordering of p0 work." ADR 0214 inverted exactly that, letting the milestone set the bucket. ADR [0210](0210-direction-binds-at-intake.md) governs *lane allocation* per cycle (a bounded platform quota, over-quota work parking in priority order), not which band a label carries; it is unaffected and continues to bind on top of whatever priorities this ADR's merit test produces.

**The cost right now.** The pipeline is itself a first-class product (ADR [0201](0201-pipeline-tenant-phoenix-first.md)), and the founder has named "Pipeline Anywhere" — an `active` campaign row in `ROADMAP.md` — as one of two things to complete this weekend. Under the conferral reading, campaign-homed work cannot be ranked above product work homed elsewhere. The board structurally cannot express a stated founder priority.

## Decision

**Campaign membership determines a *home*, not a *priority band*: an `active` arc or campaign row confers no priority, and priority is assigned on the work's own merit.**

Priority and homing answer different questions and are now decoupled. **Priority** encodes value — what this work is worth relative to everything else on the board. A **home** (a milestone, or a standing lane under ADR [0208](0208-standing-lane-exemption-from-full-homing.md)) makes work pickable and auditable — where it belongs and who is accountable for it. Conflating them made the ordering signal a restatement of the milestone column, which carries no ranking information at all.

The conferral half of ADR 0214 is withdrawn. Its homing half survives in the place homing actually lives: the homing requirement and its guard, not the priority rubric. Nothing about what needs a home changes.

This is not a new rubric. Priority remains `p0`/`p1`/`p2` with their existing meanings under ADR [0202](0202-forward-motion-doctrine-crewops.md) §1 and the triage rubric; the only thing that changes is that campaign membership is no longer an input to which band an issue gets.

**Binding constraints.**

- An `active` `## Arcs` or `## Campaigns` row of `ROADMAP.md` confers **no** priority band on the work homed in it.
- Campaign membership is neither necessary nor sufficient for any band, `p0` included.
- Priority is assigned on the work's own merit — value shipped, or ship-rate raised (ADR [0202](0202-forward-motion-doctrine-crewops.md) §1) — and product work in no campaign may outrank factory work in one.
- **Every issue still needs a home** — a milestone, or a standing lane per ADR [0208](0208-standing-lane-exemption-from-full-homing.md). Unchanged. `homing-guard` and its exempt-label set are unaffected by this ADR.
- ADR [0202](0202-forward-motion-doctrine-crewops.md) §2 is amended in part: a `p0` is still never homeless, but its home need not be the *active arc's* structure — any milestone or standing lane satisfies it. The no-orphan-priorities rule stands; the active-arc restriction on where a `p0` may live does not.

**Banned.**

- Reading campaign membership as an argument for or against any priority band.
- Capping campaign-homed work at `p1`, or floor-gating any band on campaign membership.
- Demoting or promoting an issue on the strength of its milestone alone.

## Consequences

- **Owed work: the triage rubric text.** `claude-plugins/kampus-pipeline/skills/triage/SKILL.md` Step 6 still teaches the conferral — its `p1` row reads "Serves an active milestone" and the prose above it says an active campaign "confers a `p1` band exactly as the active arc does," citing ADR 0214. That text must be rewritten to price on merit and to stop keying the band on roadmap rows. Until it is, agents will keep reproducing the divergence. This ADR does not do that edit.
- **Owed work: `ROADMAP.md` line 11** still reads "priority is relative to it (`p1` = current arc)". That line is founder-voice and revised on the conversation-authored path (ADR [0075](0075-issueless-doc-pr-merge-seam.md)), so it is deliberately not reconciled here; it disagrees with this ADR until the founder calls it. This ADR governs in the interim. (ADR 0214 left the same line outstanding.)
- **Priority becomes a real ranking again, and a harder judgment.** The milestone column no longer does the pricing, so a triage agent must actually argue value. Expect more variance in individual calls than the mechanical rule produced — that variance is the signal returning, not noise.
- **Existing labels are not invalidated by this ADR.** No mass repricing is owed. The 2026-07-26 re-level already corrected the board; this ADR stops it from re-seeding.
- **The band populations shift.** Under 0214, thirteen `active` roadmap rows were a standing `p1` generator. Removing the conferral makes `p2` the honest default again (as the rubric always said) and shrinks `p1` to work someone would genuinely pull next.
- **Campaign lifecycle hygiene stops being a priority lever.** Under 0214, a campaign left `active` past its end inflated bands by neglect. That failure mode is gone — a stale `active` row now only misstates the roadmap, it no longer misprices the board.
- **The generalizable lesson.** ADR 0214 stated its rule twice, once as sufficient and once as necessary, and the mismatch survived review because each sentence read correctly on its own. A rule that grants a property and a rule that requires it are different rules; an ADR that means one must not phrase the other.

## Records

- **Vocabulary impact: none.** This re-prices already-named concepts — `arc`, `campaign`, and the `p0`/`p1`/`p2` bands — and coins nothing. The home/priority distinction it draws is a relationship between two existing terms, not a new one.
- Supersedes [0214](0214-active-campaign-confers-p1.md); amends in part [0202](0202-forward-motion-doctrine-crewops.md) (§2's active-arc restriction only — §1 and points 3–5 stand).
- Records the standing rule behind the founder-approved re-level tracked on #4226 (closed). Evidence issues: #4268, #4271.

> Amendment 2026-08-19: the first "Owed work" item is discharged. The `kampus-pipeline` plugin is retired (ADR 0303); the live rubric is `claude-plugins/fabrika/skills/triage/SKILL.md`, whose priority section already prices on merit and states "A roadmap row confers no band either way" (line 176). No conferral text remains to rewrite.
