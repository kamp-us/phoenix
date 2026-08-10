---
id: 0253
title: The `ready-for:` gap closes in the data — backfill plus an inflow cutover, never a default
status: accepted
date: 2026-08-10
tags: [fabrika, pipeline, triage, process]
---

# 0253 — The `ready-for:` gap closes in the data — backfill plus an inflow cutover, never a default

**What this decides:** Almost none of the triaged board carries a `ready-for:` label, and fabrika's
picker refuses an issue that has none. We fix the board, not the rule: label the issues that are
missing one, and get new issues labelled where triage happens. A missing label keeps meaning "nobody
said an agent may take this."

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
no audience label and **229** of those are unassigned. So the audience axis, on its own, takes the
live pool from 266 to 12.

**The inflow is open, and v1 is why.** Coverage by creation day runs 12/55 on 2026-08-09 and 1/20 on
2026-08-10. The live triage path is v1's, which writes only the type / priority / `status:triaged`
triple — `ready-for:` appears nowhere under `claude-plugins/kampus-pipeline/skills/triage/`. The
facet is mandatory only on the v2 path, where `packages/fabrika-cli/src/triage/facets.ts` owns
`^ready-for:` exclusively and `fabrika triage apply` requires `--ready-for`. That split is deliberate:
#4780 scoped its rule to fabrika and held v1 out, and ADR
[0238](0238-fabrika-reimplements-v1-never-calls-it.md) keeps v1 frozen so it stays deletable.

**The house already answered this shape twice, and both times in the data, not the rule.** ADR 0208
met a fence that starved 199 milestone-less issues with a closed, enumerated exemption set.
[#5175](https://github.com/kamp-us/phoenix/issues/5175) met an absent audience label starving 19 of
20 epics by narrowing *where the axis binds* — `plan` and `gate` claims are unbound, `build` stays
bound — leaving #4780's reading untouched. Neither made an absent value mean something.

**On #4780's "no backfill" line.** That ruling's acceptance criteria include "no backfill of
already-triaged tickets." It is a scope hold on *that* ticket — three spec appends and two label
definitions, nothing more — not a standing ban. #5041 was triaged precisely to settle the sequencing
#4780 left open, so deciding to backfill here does not re-litigate it.

## Decision

**Absence of a `ready-for:` label stays an exclusion; the gap closes in the data — a backfill of the
already-triaged board, plus moving new triage onto the seam that already requires the value.**

**The rule does not move.** `audienceAxisOf` keeps reading absence as an unknown audience. No default,
no per-type heuristic, no "treat absence as agent inside the focused milestone." Every seam that
consults the axis keeps refusing exactly what it refuses today, and the `build pick` contract's
fail-closed filter means what it says.

**The backfill translates a signal a triager already set; it does not fill a blank.** v1 documents
`status:triaged` as "Triage signed off; ready for write-code to pick" — and #4780's own #4706
amendment says the *audience half* of that description is what `ready-for:` now owns. An issue
triaged on the v1 path therefore already carries an agent-audience assertion; the backfill writes it
into the label the fabrika picker reads. It is bounded so it cannot destroy a real signal: it writes
**only** onto an issue carrying no `ready-for:` label at all, which is what leaves untouched the
`ready-for:human` children `plan-epic` sets deliberately at creation time. It is idempotent, so
re-running it while the inflow is still open is the interim answer, and each run's count is the
coverage number.

**The inflow closes by moving the runs, not by growing v1 a facet.** Triage runs go through
`fabrika triage apply --ready-for`. Nothing under `claude-plugins/kampus-pipeline/` or
`packages/pipeline-cli/` is edited for this.

**Rejected — default the absence.** It is the precise failure mode #4780 named, and it is
unobservable besides: once absence means agent, nobody can tell an issue no one classified from one
someone classified as agent. The gap would stop being visible without becoming smaller.

**Rejected — gate the cutover on a coverage threshold.** A threshold blocks without producing. The
backfill is what produces coverage, and its own run count is the number a threshold would have read,
so a gate on top adds a stall and no signal.

**Binding constraints.**
- Absence of a `ready-for:` label is never read as an agent audience, at any seam.
- A backfill writes only onto an issue carrying no `ready-for:` label.
- The audience facet's meaning is #4780's; this ADR sequences its rollout and does not redefine it.

**Banned.**
- Editing `claude-plugins/kampus-pipeline/` to emit an audience label.

## Consequences

The cutover to fabrika's picker stops being a cliff. The pool it computes reflects the campaign's
real shape instead of the age of the label, and the near-empty-but-valid pool — the failure that
reads as "no work available" rather than as a config gap — cannot happen.

The cost is that the backfill asserts an agent audience over ~239 in-focus issues on the strength of
what v1's `status:triaged` meant, not a fresh per-issue read. Where that is wrong in the individual
case, an agent opens a lane on work someone wanted a human for; the remedy is re-labelling one issue,
and every other gate on that lane still runs. The counterfactual is a live pool of 12.

Coverage decays until the inflow moves, so the backfill is expected to run more than once. That is
why it is specified idempotent and why it reports its counts — the alternative, a one-shot correction
against an unstopped inflow, is what makes "backfill first" fail on its own.

## Records

- Closes [#5041](https://github.com/kamp-us/phoenix/issues/5041).
- Follow-up filed: [#5269](https://github.com/kamp-us/phoenix/issues/5269) (run the backfill),
  [#5270](https://github.com/kamp-us/phoenix/issues/5270) (route triage through the fabrika seam).
- No vocabulary impact. *Audience axis* and *scope axis* are ADR 0245's, *standing lane* is ADR
  0208's, and `ready-for:<human|agent>` is #4780's; this ADR sequences their rollout and coins
  nothing.
