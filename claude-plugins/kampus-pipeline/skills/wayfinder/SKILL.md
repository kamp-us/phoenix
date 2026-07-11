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
  a fuzzy direction first becomes a structured, workable map. The full walk is
  [CHART mode](#chart-mode--name-the-destination-map-the-frontier-plan-dont-do) below.

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

## CHART mode — name the destination, map the frontier (plan-don't-do)

CHART is invoked with **no map yet** (a fresh foggy idea) or **a named destination against an
existing map** (a rewrite). It is the mode that first turns fog into structure. CHART does
**not** resolve any unknown — resolving is WORK mode's job — it only *frames* the unknowns as a
workable frontier. Its output is a single `wayfinder:map` issue whose body carries the
four-section shape from the map-shape contract
([`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md), §The `wayfinder:map` issue
shape), with the frontier laid out as **native sub-issues**. Read that contract for the section
grammar; this mode is a **producer** of that shape, never a re-derivation of it.

### The plan-don't-do law — the hard constraint CHART is built around

CHART obeys one non-negotiable law, inherited from wayfinder's Pocock lineage: **plan, don't
do.** Every frontier ticket CHART files must resolve a **decision or an unknown** — *never* a
deliverable. A frontier ticket asks "which storage model?", "does better-auth's session model
let us mint a single-use token without a new table?", "0 karma or a vouch-backed starting
balance?"; it never says "build the invite table" or "ship the kefil form." Charting a foggy
idea straight into an epic of build tasks is the exact over-commitment wayfinder exists to
prevent — the gap the ideation layer fills, where `plan-epic` would over-commit a genuinely
foggy idea into a premature, wrong plan. So CHART's output is a map of *questions to resolve*;
build work is committed only **after** WORK mode clears the frontier and the cleared map emits
concrete epics (the emission seam, out of scope here). **A frontier ticket that names a
deliverable is the failure mode:** reject it and re-frame it as the decision underneath — or, if
it is already settled, record it in `## Decisions-so-far` instead; if it is downstream build
work, it is not fog and does not belong on the map at all.

### The ticket-type translation table — reuse existing types, invent no new machinery

CHART decomposes fog by classifying each unknown against wayfinder's **Pocock→kampus**
translation. Pocock's wayfinder is **human-in-the-loop by design** (its Grilling/Prototype types
forbid the agent standing in for the human voice); kampus-pipeline is **agent-automation**, so
each HITL discipline maps to its automation analog — preserving exactly **one** human seam, the
founder-decision-fork. **No new `type:*` or label is invented:** the frontier reuses the
pipeline's existing `type:investigation` and `type:decision` types, so charting ripples no intake
floor (the same reuse-issue-infra choice the `wayfinder:map` label itself makes).

| Pocock ticket type (HITL) | kampus frontier ticket (agent-automation) | Filed as |
|---|---|---|
| **Research** (AFK) | an investigation / deep-research subagent clears it autonomously | `type:investigation` |
| **Grilling** (human voice) | route to the **founder** as a decision-fork — the one preserved human seam | `type:decision`, flagged founder-decision-fork |
| **Prototype** (HITL) | a spike/tracer coder produces a rough artifact for founder reaction | `type:investigation` (spike), surfaced to the founder |
| **Task** | a normal pipeline task — but this is **build work, not frontier**: it never enters the map; it waits for the cleared map to emit it into the pipeline | *(not a frontier ticket)* |

The table and the plan-don't-do law are the **same rule seen twice**: the frontier holds
Research / Grilling / Prototype (decisions and unknowns), never Task (deliverables). The two
autonomous rows file `type:investigation` tickets WORK mode clears on its own; the Grilling row
files a `type:decision` ticket flagged a **founder-decision-fork**, which WORK mode *surfaces and
stops on* rather than resolving — the fork-routing mechanics themselves live in the
founder-decision-fork seam (out of scope here). CHART's job for a fork is only to *recognize* the
unknown as a founder call, file it as `type:decision`, and mark it a fork on the map. The
**Task** row is deliberately not a frontier ticket: it is the deliverable side of the
plan-don't-do line, so it enters the pipeline only via emission, never as fog.

### The walk

1. **Resolve the map issue.** With no map yet, open a new issue carrying the `wayfinder:map`
   label; with a named destination against an existing map, rewrite that map in place. Never
   clobber accreted state on a rewrite — `## Decisions-so-far` and `## Graduated fog` are
   append-only history (§the map-shape contract); a rewrite may re-name the `## Destination` and
   re-lay the `## Open frontier`, but it preserves what earlier runs settled.

   ```bash
   REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
   # new map (REST only — the org bans GraphQL for issue ops):
   MAP=$(gh api -X POST repos/$REPO/issues \
     -f title="<destination, as a short noun phrase>" \
     -f "labels[]=wayfinder:map" \
     -f body="$BODY" --jq '.number')
   ```

2. **Name the `## Destination`.** State *where we want to be* in one or two sentences, concrete
   enough to tell "arrived" from "not yet." This is the fixed star the map steers by; it is the
   only section CHART sets authoritatively (WORK never rewrites it). If the founder's idea is too
   fuzzy to name a destination at all, that fuzziness is itself the first thing to resolve —
   name the sharpest destination you can and file the ambiguity as a frontier ticket.

3. **Seed `## Decisions-so-far`.** Record what is *already settled* about the idea — the facts and
   decisions the founder brought in, each a one-line entry. An empty log is fine for a truly
   green-field idea; more often a foggy idea carries a few givens, and naming them up front keeps
   the frontier focused on what is genuinely open.

4. **Decompose the fog into a frontier of resolvable tickets.** Break the destination's unknowns
   into the smallest set of tickets that, once answered, would make the path buildable. Apply the
   plan-don't-do law to every candidate: keep it only if it resolves a decision or an unknown;
   drop or re-frame any candidate that names a deliverable. Classify each survivor against the
   translation table above — Research/Prototype → `type:investigation`, Grilling → `type:decision`
   (founder-decision-fork).

5. **File each frontier ticket as a native sub-issue under `## Open frontier`.** Create a real
   GitHub issue for each — carrying its `type:investigation` or `type:decision` label and a body
   stating the open question — then link it to the map as a **native sub-issue** (not a copied
   task list; the map references it by number). The `sub_issues` endpoint takes the child's
   internal **database id** (`.id`), not its issue number:

   ```bash
   CHILD_ID=$(gh api -X POST repos/$REPO/issues \
     -f title="Investigation: <the open question>" \
     -f "labels[]=type:investigation" \
     -f body="<what's unknown, and what an answer would unblock>" --jq '.id')
   gh api -X POST repos/$REPO/issues/$MAP/sub_issues -F sub_issue_id="$CHILD_ID" >/dev/null
   ```

   Frontier tickets are **wayfinder-worked, not `write-code`-pickable** — they carry no
   `status:triaged`, so the execution pipeline's picker steps over them; only the concrete epics a
   cleared map later *emits* enter triage. Then write each ticket's line into the map's
   `## Open frontier` section, referencing its number and stating the open question, marking a
   `type:decision` fork as `(founder-decision-fork)`.

6. **Leave `## Graduated fog` empty.** Nothing has cleared yet — a freshly charted map has an open
   frontier and no motion to record. WORK mode is what moves tickets from `## Open frontier` into
   `## Graduated fog` as it resolves them; CHART only lays the frontier down.

The map is now charted: a named destination, the givens logged, and a frontier of
investigation/decision sub-issues WORK mode can resolve one at a time. CHART stops here — it does
not resolve a ticket, and it never resolves a founder-decision-fork.

## Handoff — the map graduates into the pipeline

A map is "done enough" when its open frontier holds no more answerable unknowns — every
investigation is graduated into the fog and every remaining item is either a settled
decision-so-far or a surfaced founder-decision-fork awaiting the human. At that point the map
is concrete enough to enter the execution pipeline: its accreted decisions become the spec a
`report` → `triage` → `plan-epic` pass turns into a dependency-ordered ledger. wayfinder is the
front of that funnel, not a replacement for it.

> **Build status.** The construct — the `wayfinder:map` label, the map-issue shape contract, and
> the two-mode + one-seam description — and the **CHART mode** walk above are in place (#2421,
> #2422). Still to land: the **WORK mode** walk (#2423), the **founder-decision-fork** routing
> mechanics (#2424), the **emission** path into the pipeline (#2425), and the **CLI tool**
> (#2426). Each fills in against the map-shape contract linked above; do not let a mode drift
> from that single source.
