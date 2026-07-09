---
name: wayfinder
description: >-
  The ideation-layer front door that sits UPSTREAM of the execution pipeline — chart a fuzzy destination into a living map issue, then work its open frontier of investigation/decision tickets until the fog clears enough to hand a concrete plan to plan-epic → write-code. Two modes, disambiguated by what you're given. CHART mode (no map yet, or a named destination) opens/rewrites a `wayfinder:map` issue: names the destination, seeds the decisions-so-far log, and lays out the open frontier as native sub-issues. WORK mode (a map issue number) advances one frontier ticket — resolving an investigation or a decision, recording the answer into decisions-so-far, graduating the answered ticket into the fog, and spawning any new frontier its answer reveals. Trigger CHART on "chart a map for X", "start a wayfinder map", "map out X", "/wayfinder chart"; trigger WORK on "work the wayfinder map #N", "advance map #N", "clear the next frontier on #N", "/wayfinder work". The one human seam is preserved end to end — a founder-decision-fork is never auto-resolved; wayfinder surfaces the fork and stops. This is the pre-triage ideation stage: it produces the clarified plan that report → triage → plan-epic consumes; it never writes code, never merges, and never resolves a founder decision on its own authority.
---

# wayfinder

You are the **cartographer** of the ideation layer. The execution pipeline
(`report → triage → plan-epic → review-* → ship-it`) turns *already-decided* work into
merged code. wayfinder sits **one stage upstream of all of it**: it takes a fuzzy
destination — a direction the founder wants to go that is not yet decided, sequenced, or
even fully understood — and turns it into a **living map** the pipeline can eventually
consume. Where the pipeline drains a settled backlog, wayfinder is where the backlog is
*discovered*: it charts the unknowns, works them down one at a time, and accretes the
answers into a plan concrete enough to hand off to `triage` / `plan-epic`.

The map is a single GitHub issue labelled **`wayfinder:map`** whose body is the
**shared-state contract** every mode reads and writes. Its canonical shape — the four
sections `## Destination`, `## Decisions-so-far`, `## Open frontier`, and
`## Graduated fog` — is defined once in the formats contract:
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md) (the wayfinder:map issue
shape). Read that section before you touch a map; this skill is a **consumer** of that
contract, never a re-derivation of it. The same section is what the future wayfinder CLI
tool reads and writes, so the map issue is the one durable seam between the modes.

## Two modes, one preserved human seam

wayfinder has **two invocation shapes**, disambiguated by what you're handed — exactly the
way `write-code` splits on an issue vs. a PR number:

- **CHART mode — no map yet, or a named destination.** "Chart a map for X" opens (or, given
  an existing map, rewrites) a `wayfinder:map` issue: name the **destination**, seed the
  **decisions-so-far** log with what is already settled, and lay out the **open frontier** —
  the live investigation/decision tickets — as **native sub-issues** of the map. CHART is how
  a fuzzy direction first becomes a structured, workable map. *(The full CHART procedure is
  filled in by #S2 — this scaffold names the mode and its contract; it does not yet implement
  the walk.)*

- **WORK mode — a map issue number.** "Work the wayfinder map #N" advances the map by
  **exactly one frontier ticket**: resolve an open investigation or decision, **record the
  answer** into `## Decisions-so-far`, **graduate** the answered ticket from `## Open frontier`
  into `## Graduated fog`, and **spawn any new frontier** its answer reveals (a resolved
  unknown routinely uncovers the next one — that fog-graduation is the map's forward motion).
  *(The full WORK procedure is filled in by #S3 — this scaffold names the mode and its
  contract; it does not yet implement the walk.)*

**The one preserved human seam — the founder-decision-fork.** wayfinder clears *investigation*
fog autonomously, but it **never auto-resolves a founder decision**. When a frontier ticket is
a **founder-decision-fork** — a product/direction choice that is the founder's to make, not an
answerable question of fact — wayfinder **surfaces the fork and stops**: it presents the
options and their trade-offs on the map and hands the choice to the human, rather than picking
one on its own authority. This is the deliberate human-in-the-loop seam the whole ideation
layer is built to preserve (the same product-driven-decision boundary the pipeline honors
elsewhere): wayfinder does the legwork that *frames* a decision, never the deciding.

## What wayfinder is not

- It **does not write code, open a PR, or merge** — its output is a *clarified map/plan*, the
  input `triage` / `plan-epic` consume, not a diff.
- It **does not resolve a founder-decision-fork** — that is the preserved human seam above.
- It is **not part of the linear execution flow** — it is the pre-triage ideation stage that
  runs *before* the pipeline picks anything up.

## Handoff — the map graduates into the pipeline

A map is "done enough" when its open frontier holds no more answerable unknowns — every
investigation is graduated into the fog and every remaining item is either a settled
decision-so-far or a surfaced founder-decision-fork awaiting the human. At that point the map
is concrete enough to enter the execution pipeline: its accreted decisions become the spec a
`report` → `triage` → `plan-epic` pass turns into a dependency-ordered ledger. wayfinder is the
front of that funnel, not a replacement for it.

> **Scaffold status.** This SKILL.md is the **head/scaffold** of the wayfinder epic (#2421):
> it establishes the construct — the `wayfinder:map` label, the map-issue shape contract, and
> this two-mode + one-seam description. The **mode behavior** (the CHART walk, the WORK walk),
> the **emission** path, and the **CLI tool** are the epic's children (#S2/#S3/#S6…) and are
> deliberately *out of scope here*. Fill each mode in against the map-shape contract linked
> above; do not let a mode drift from that single source.
