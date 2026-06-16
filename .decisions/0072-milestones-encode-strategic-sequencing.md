---
id: 0072
title: Milestones Encode Strategic Sequencing, Not Feature Breakdown
status: accepted
date: 2026-06-15
tags: [pipeline, roadmap, triage]
---

# 0072 — Milestones Encode Strategic Sequencing, Not Feature Breakdown

## Context

A CEO/CPO/CTO backlog review (~94 open issues, 0 p0) found the products are
"Potemkin" — built shell, hollow or broken interactions — while effort fanned out
into new products and meta-tooling. We adopted GitHub milestones to make the
strategic sequencing visible and trackable. Seven milestones now exist: #1
Pipeline hardening, #2 Broken core loops, #3 Search, #4 Report/bildir, #5
Bookmarks, #6 Account & profile, #7 Test & CI health. The new products
(imge / kampus-CLI / künye) were deliberately left **unmilestoned**.

Milestones are REST-accessible (`gh api .../milestones`, `...?milestone=<n>`), so
they fit the existing `gh api` path — the org's Projects-classic breaks GraphQL,
and milestones sidestep it (see the gh-api workaround the pipeline already relies
on).

A milestone is not an epic. Epics + native sub-issues already do feature
decomposition; we needed the cross-cutting strategic container an epic can't be.
This ADR pins what a milestone *means* and how we group them; the per-issue
mechanics are tracked in epic #406 and the `gh-issue-intake-formats.md` contract,
which cite this ADR as the source of truth.

## Decision

1. **Milestones encode strategic sequencing / campaign grouping** — "which
   focused push, in what order" — **not feature breakdown**. Feature decomposition
   stays with epics + native sub-issues. A GitHub issue is in at most one
   milestone, so a milestone is a *commitment*, not a tag.

2. **Two milestone kinds.** *Surface* milestones (Search, Bookmarks, Account &
   profile, Report/bildir) key off an issue's product surface and are mechanical
   to assign. *Strategic* milestones (Broken core loops, Pipeline hardening, Test
   & CI health) require judgment ("is this broken vs missing? pipeline-critical?").

3. **The set stays small and human-curated.** Creating or restructuring milestones
   is a roadmap (human / CPO) decision, not an autonomous one — fragmenting the set
   would destroy its single-source-of-truth value. There is no autonomous
   "create-milestones" skill.

4. **Freeze-by-absence.** Deliberately leaving a cluster unmilestoned (the new
   products) is itself the signal that it is parked / deferred. Absence is
   meaningful — don't invent homes for frozen work.

5. **Milestone is an optional pipeline dimension** alongside type / priority /
   status, maintained at the per-issue level: triage assigns on a clear match,
   plan-epic children inherit the epic's milestone, write-code prioritizes by it.
   The per-issue mechanics live in #406 and the `gh-issue-intake-formats.md`
   contract; this ADR is the "what milestones mean + how we group them" source
   those skills cite.

## Consequences

- Dashboards (#379) and the milestone-aware skills (#406) reference this ADR
  rather than re-deriving milestone semantics.
- **p0 stays sovereign.** write-code's milestone preference must never override
  priority: campaign bias is a within-bucket tiebreaker or an explicit invocation,
  not a re-ordering of p0 work.
- The freeze-by-absence signal only holds while the discipline of *not*
  auto-milestoning everything holds. If every issue gets a milestone, absence
  stops meaning anything and the deferral signal is lost.
- Restructuring milestones is now an explicitly human act; no skill may create or
  delete them.
