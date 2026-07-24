---
id: 0203
title: Triage relabels fog reports to `wayfinder:backlog`; no new intake skill
status: accepted
date: 2026-07-19
tags: [pipeline, triage, wayfinder, intake]
---

# 0203 — Triage relabels fog reports to `wayfinder:backlog`; no new intake skill

**What this decides:** When a filed report turns out to be fog — undecided decisions and unknowns with nothing concrete to build — the existing `triage` skill relabels it into the cartographer's `wayfinder:backlog` queue, instead of us adding a separate skill for filing fog directly.

## Context

`wayfinder:backlog` is the cartographer's queue of fuzzy destinations — fog that needs charting before it can become buildable work. It sits one step *upstream* of triage: an issue there is deliberately not `status:needs-triage` and not `write-code`-pickable. Until now there was no sanctioned mechanism to route intake into it; the label was hand-applied (e.g. #3556).

Two mechanisms were weighed (#3557):

- **Option A — a new `/wayfinder-backlog` intake skill**, mirroring `/report`. This re-introduces file-time classification: the filer must decide "this is fog, not buildable" just to pick the skill, breaking `report`'s load-bearing type-blind principle ("classifying is triage's job, not the filer's"), and it mints new machinery the `report`/`wayfinder` philosophy deliberately avoids.
- **Option B — one more branch in `triage`'s existing classification**, relabeling a fog report to `wayfinder:backlog`.

The options also differ in control-plane cost: the `triage` skill is §CP (ADR [0053](0053-control-plane-boundary.md); `claude-plugins/kampus-pipeline/skills/triage/` matches `CONTROL_PLANE_RE`), so Option B's implementation PR banks for human merge, while Option A's net-new skill would likely auto-ship. The founder ruled for Option B (2026-07-19, per ADR [0078](0078-product-driven-decisions-by-default.md)): the one-time §CP merge buys type-blind fog intake permanently.

## Decision

**Fog reports route to `wayfinder:backlog` via a new branch of the `triage` skill's classification — not via a new intake skill.**

When a `status:needs-triage` report has **no buildable deliverable underneath** — its "work" is undecided decisions/unknowns, the same plan-don't-do line `wayfinder` CHART draws — triage relabels it `wayfinder:backlog` and drops `status:needs-triage`, instead of typing it buildable. This keeps `/report` type-blind (the filer stays dumb; the fog-vs-buildable call stays where classification already lives), reuses triage's existing role rather than minting machinery, and mirrors the ideation-layer discipline: triage is the natural gate that recognizes a report belongs further upstream and pushes it there.

The load-bearing discriminator, stated precisely so triage never mis-routes concrete work upstream: **no buildable deliverable ⇒ fog ⇒ `wayfinder:backlog`.** A concrete bug/feature/refactor with a nameable deliverable stays buildable and is typed normally; only genuine fog — undecided decisions/unknowns, nothing a `write-code` could build cold — goes to `wayfinder:backlog`.

**Binding constraints.**
- Fog intake enters through `/report` like everything else; the filer never classifies fog-vs-buildable at file time.
- The fog relabel swaps labels atomically in intent: add `wayfinder:backlog`, drop `status:needs-triage` — never both states at once.
- A report with a nameable buildable deliverable is never routed to `wayfinder:backlog`.

**Banned.**
- A dedicated fog-intake skill (`/wayfinder-backlog` or similar) — file-time classification is the exact failure `report` exists to prevent.

## Consequences

- `wayfinder:backlog` destinations can be filed through the pipeline (a plain `/report`) instead of by hand; triage becomes the single classification point for buildable-vs-fog as it already is for everything else.
- The `triage` skill gains one classification branch. That edit is §CP, so the implementation PR banks for human merge — a one-time cost, accepted knowingly for the recurring type-blind-intake win. This build work is tracked by #3557.
- Triage carries a new mis-route risk (concrete work pushed upstream as fog); the precise discriminator above is the guard, and the implementation must encode it verbatim.

## Records

- Vocabulary impact: coins **`wayfinder:backlog`** (the cartographer's queue of fuzzy destinations, upstream of triage — a routing label, not a `status:*`); routed to `.glossary/TERMS.md` via #3862.
- Decision recorded from the founder ruling on #3557; the triage-skill implementation remains tracked there.
