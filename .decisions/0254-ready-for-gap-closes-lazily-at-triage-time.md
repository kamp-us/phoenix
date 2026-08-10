---
id: 0254
title: The `ready-for:` gap closes lazily — labelled at triage time, never by backfill or default
status: accepted
date: 2026-08-10
tags: [fabrika, pipeline, triage, process]
---

# 0254 — The `ready-for:` gap closes lazily — labelled at triage time, never by backfill or default

**What this decides:** Almost none of the triaged board carries a `ready-for:` label, and fabrika's
picker refuses an issue that has none. We do not soften the rule and we do not bulk-mint the missing
labels. The label gets applied where the judgment is actually made — at triage time, going forward —
so the labelled set grows exactly as fast as someone reads an issue and decides its audience. A
missing label keeps meaning "nobody said an agent may take this."

## Context

fabrika's `build` seams admit an issue on two axes (ADR
[0245](0245-campaign-scope-fence-binds-both-seams.md)): **scope**, campaign membership against the
`ROADMAP.md` `## Focus` declaration, and **audience**, whether the issue carries `ready-for:agent`.
The audience axis is older than the fence and belongs to founder ruling
[#4780](https://github.com/kamp-us/phoenix/issues/4780), which made it fail-closed in as many words:
`status:triaged` with no `ready-for:` label is not pickable, and absence never defaults to agent.

[#5041](https://github.com/kamp-us/phoenix/issues/5041) reported that the board cannot satisfy that
rule, and asked which of three sequencings we take.

**The board, re-measured 2026-08-10** (paginated REST over open `status:triaged` issues, pull
requests excluded):

| bucket | count |
|---|---|
| open `status:triaged`, non-PR | 422 |
| `ready-for:agent` | 25 |
| `ready-for:human` | 18 |
| **no `ready-for:` label** | **379** |

The scope axis does not absorb it. Restricting to the issues scope *already* admits — milestone #44
(declared 2026-08-09) or a standing lane under ADR
[0208](0208-standing-lane-exemption-from-full-homing.md) — leaves 266 issues, of which **239** carry
no audience label and **229** of those are unassigned.

**The inflow is where the number actually moves.** Coverage by creation day runs 12/55 on 2026-08-09
and 1/20 on 2026-08-10. The live triage path is v1's, which writes only the type / priority /
`status:triaged` triple — `ready-for:` appears nowhere under
`claude-plugins/kampus-pipeline/skills/triage/`. The facet is mandatory only on the v2 path, where
`packages/fabrika-cli/src/triage/facets.ts` owns `^ready-for:` exclusively and `fabrika triage apply`
requires `--ready-for`. That split is deliberate: #4780 scoped its rule to fabrika and held v1 out,
and ADR [0238](0238-fabrika-reimplements-v1-never-calls-it.md) keeps v1 frozen so it stays deletable.

**The 379 are not a backlog waiting to be labelled; they are a backlog waiting to be killed.** They
are overwhelmingly v1-era rows, and the standing post-fabrika plan is a kill-sweep over roughly 300
of them. Labelling a set headed for the scythe is double work — the survivors get their label from
the sweep's KEEP verdicts, which is a real per-issue read rather than a bulk assertion.

**The house already answered this shape twice, both times in the data and never in the rule.** ADR
0208 met a fence that starved 199 milestone-less issues with a closed, enumerated exemption set.
[#5175](https://github.com/kamp-us/phoenix/issues/5175) met an absent audience label starving 19 of
20 epics by narrowing *where the axis binds* — `plan` and `gate` claims are unbound, `build` stays
bound — leaving #4780's reading untouched, and leaving epic planning free of this cutover entirely.
Neither made an absent value mean something, and neither minted a value nobody set.

**The ruling history, because it is the load-bearing part of this record.** #5041 carried two
contradictory recorded answers before this ADR settled:

| when | what landed |
|---|---|
| 2026-08-10T00:15:28Z | A **founder-delegated** ruling on #5041 (chief-of-staff seat, ~92% confidence, founder's veto explicitly left open): *lazy cutover — no bulk backfill*, on the ground that a `ready-for:` minted in bulk is false signal. |
| 2026-08-10T04:18:57Z | The first draft of this ADR took the **opposite** line — backfill first — and cited the 00:15 ruling nowhere. |
| 2026-08-10T04:23:00Z | #5269's triage flagged the contradiction on #5041; the backfill ticket was parked `status:needs-info` pending the call. |
| 2026-08-10T~07:43Z | The **founder ruled directly**: lazy cutover, no bulk backfill. The 00:15 delegated ruling is **confirmed, not overturned**, and its veto window is closed. |

This ADR records the founder's direct ruling. The delegated ruling it confirms is the earlier record
of the same answer, not a competing one.

**On #4780's "no backfill" line.** That ruling's acceptance criteria include "no backfill of
already-triaged tickets", written as a scope hold on *that* ticket rather than a standing ban. The
reading is not what decides this: the bulk backfill is refused here on substance — false signal —
not on #4780's scope note.

## Decision

**Absence of a `ready-for:` label stays an exclusion, and the gap closes lazily: the label is applied
at triage time going forward. The 379 already-triaged issues are not backfilled.**

**The rule does not move.** `audienceAxisOf` keeps reading absence as an unknown audience. No
default, no per-type heuristic, no "treat absence as agent inside the focused milestone." Every seam
that consults the axis keeps refusing exactly what it refuses today, and the `build pick` contract's
fail-closed filter means what it says.

**The label is minted where the judgment is made.** Triage runs go through `fabrika triage apply
--ready-for`, which already requires the value, so every newly triaged issue carries an audience
somebody actually decided. The labelled set grows at the rate judgment is exercised — which is the
only rate at which the label carries information. Nothing under `claude-plugins/kampus-pipeline/` or
`packages/pipeline-cli/` is edited to emit an audience label.

**Rejected — backfill the already-triaged board.** Minting 379 judgments nobody made produces a
label that looks like a decision and is not one; it recreates the phantom-label class #4780 exists to
prevent (absence = unknown audience, never agent). It is also double work against a set scheduled for
a kill-sweep, and it would be self-defeating besides: with the inflow still open, a one-shot bulk
write decays immediately, so the run would have to repeat — each repetition asserting more audiences
nobody read.

**Rejected — default the absence.** It is the precise failure mode #4780 named, and it is
unobservable besides: once absence means agent, nobody can tell an issue no one classified from one
someone classified as agent. The gap would stop being visible without becoming smaller.

**Rejected — gate the cutover on a coverage threshold.** Under lazy cutover there is no coverage
event to gate on — coverage rises continuously as triage runs, and #5175 already unbound `plan` and
`gate` from the audience axis, so epic planning never waits on this. A threshold would stall the
cutover against a number that no single action moves.

**What the cutover therefore looks like.** The agent pool starts small and grows with triage. That is
the intended shape, not a regression: a small pool of issues someone judged agent-ready is the
correct reading of #4780, and a large pool of issues nobody judged is exactly what the rule refuses.

**Binding constraints.**
- Absence of a `ready-for:` label is never read as an agent audience, at any seam.
- No bulk write of `ready-for:` over the already-triaged board.
- Any labelling — at triage time, or a kill-sweep KEEP verdict — writes onto an issue carrying **no**
  `ready-for:` label at all, so a value `plan-epic` set deliberately at creation time (the
  `ready-for:human` children) is never overwritten. Under this decision no bulk pass exists to
  overwrite them in the first place; the constraint holds for the per-issue path too.
- The audience facet's meaning is #4780's; this ADR sequences its rollout and does not redefine it.

**Banned.**
- Editing `claude-plugins/kampus-pipeline/` to emit an audience label.
- A bulk `ready-for:` mint over already-triaged issues.

## Consequences

The label keeps meaning what it says. Every `ready-for:agent` on the board is one a triager set after
reading the issue, so the picker's pool is small and honest rather than large and asserted.

The cost is that the fabrika picker's agent pool is genuinely narrow at cutover — on today's numbers,
tens of issues, not hundreds — and it widens only as triage runs and as the kill-sweep's KEEP
verdicts land. Work that deserves an agent and sits unlabelled waits until someone triages it. The
remedy is per-issue and cheap: label it. The counterfactual — a wide pool built from judgments nobody
made — is worse, because a wrong `ready-for:agent` is invisible while an absent one is merely
unpicked.

Nothing about this reads as a config gap, which was the original hazard in #5041: a small pool under
lazy cutover is the expected state, and it is expected to grow.

## Records

- Closes [#5041](https://github.com/kamp-us/phoenix/issues/5041).
- Records the founder's direct ruling of 2026-08-10 ~07:43Z on #5041, confirming the
  founder-delegated ruling of 2026-08-10T00:15:28Z on the same issue.
- [#5269](https://github.com/kamp-us/phoenix/issues/5269) (run the backfill) is **not to be run**
  under this decision. [#5270](https://github.com/kamp-us/phoenix/issues/5270) (route triage runs
  through the fabrika seam) stands — it implements this ADR's inflow half.
- No vocabulary impact. *Audience axis* and *scope axis* are ADR 0245's, *standing lane* is ADR
  0208's, and `ready-for:<human|agent>` is #4780's; this ADR sequences their rollout and coins
  nothing.
