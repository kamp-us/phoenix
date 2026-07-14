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
  The full walk is [WORK mode](#work-mode--resolve-one-frontier-ticket-graduate-its-fog) below.

**The one preserved human seam — the founder-decision-fork.** wayfinder clears *investigation*
fog autonomously, but it **never auto-resolves a founder decision**. When a frontier ticket is
a **founder-decision-fork** — a product/direction choice that is the founder's to make, not an
answerable question of fact — wayfinder **surfaces the fork and stops**: it presents the
options and their trade-offs on the map and hands the choice to the human, rather than picking
one on its own authority. This is the deliberate human-in-the-loop seam the whole ideation
layer is built to preserve (the same product-driven-decision boundary the pipeline honors
elsewhere): wayfinder does the legwork that *frames* a decision, never the deciding. The routing
mechanics — how a fork is framed for the founder, what the map records, and how the agent blocks
on the answer — are the [founder-decision-fork seam](#the-founder-decision-fork-seam--routing-the-fork-to-the-founder).

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
[founder-decision-fork seam](#the-founder-decision-fork-seam--routing-the-fork-to-the-founder)
below. CHART's job for a fork is only to *recognize* the unknown as a founder call, file it as
`type:decision`, and mark it a fork on the map. The
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

## WORK mode — resolve one frontier ticket, graduate its fog

WORK is invoked with **a map issue number** ("work the wayfinder map #N"). Where CHART lays the
frontier down, WORK is the mode that *clears* it: it takes the map's `## Open frontier`, resolves
**one** open ticket, records the answer, and graduates that ticket into the fog — the forward
motion that walks a charted map toward "done enough" for the pipeline. WORK is a **consumer** of
the four-section map-shape contract
([`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md), §The `wayfinder:map` issue
shape) — it never re-derives the section grammar, and it honors that contract's lockstep
invariant: **a ticket leaves `## Open frontier` only by its answer landing in
`## Decisions-so-far` and the ticket moving to `## Graduated fog`** — the three move together, so
the map is never left with a resolved unknown that has no recorded answer.

### The one-ticket-per-session law — resolve exactly one, then stop

A WORK run resolves **exactly one** frontier ticket and stops — the same one-unit-per-run
discipline `write-code` holds (one issue → one PR). This is not throttling for its own sake: each
resolution is an atomic, auditable step that appends **one** `## Decisions-so-far` entry and
graduates **one** ticket, so a later reader can trace *how the fog cleared* one move at a time,
and the next run picks up cold from the map's durable state. A run that chained several
resolutions would blur that history, compound un-reviewed answers, and race its own frontier
spawns. So: pick one, resolve it, record and graduate it, then hand back — never loop to a second
ticket in the same session.

### Map state is read and written through the `wayfinder-map` CLI — never ad-hoc markdown parsing

Every map-state read and mutation WORK performs — reading `## Open frontier` to pick the next
ticket, appending a `## Decisions-so-far` entry, moving a ticket into `## Graduated fog` — goes
through the `wayfinder-map` CLI (the pipeline-cli tool, #2426), **not** hand-rolled markdown
slicing of the issue body. Prose-guessing section boundaries with `sed`/regex is exactly the
brittle parsing the structured contract exists to remove: a stray heading, a reordered section, or
an extra note under a section silently corrupts a hand-edit, whereas the CLI reads and rewrites the
four sections against the single-source shape. The CLI is the same reader/writer CHART's output is
shaped for and the durable seam between runs — WORK mutates the map only through it.

### The walk

1. **Resolve the map and read its frontier through the CLI.** Load map `#N`'s state via
   `wayfinder-map` and take its `## Open frontier` list. First ask the CLI whether the map is
   **emission-ready** — its `## Open frontier` cleared of answerable unknowns (the
   graduation-readiness signal, see [Emission](#emission--the-cleared-map-emits-triaged-epics-into-the-pipeline));
   if so, this map has nothing left to resolve and WORK hands off to emission rather than picking a
   ticket. Otherwise pick the **next resolvable** ticket deterministically (oldest sub-issue
   first). A ticket already flagged **founder-decision-fork** and awaiting the founder is **not
   resolvable by the agent** — skip it (see the seam below) and take the next investigation ticket.
   A fork-only map (no answerable ticket left) is already caught by the emission-readiness check
   above, which routes it into emission's graceful-block-on-human handling — so it never reaches
   this pick step.

2. **Classify the picked ticket — investigation (AFK) or founder-decision-fork.** An investigation
   ticket (`type:investigation`, the AFK/Research + Prototype-spike rows of CHART's translation
   table) is one the agent clears autonomously. A `type:decision` ticket flagged a
   founder-decision-fork is **not** — it routes to the preserved human seam (below), never to a
   subagent.

3. **Resolve the one investigation ticket via a subagent.** Spawn an investigation / deep-research
   subagent (or a spike/tracer coder for a Prototype ticket) to answer the open question, and
   capture its finding. WORK does the legwork here autonomously — this is the fog wayfinder clears
   on its own authority.

4. **Record the answer into `## Decisions-so-far`.** Append **one** entry naming *what was
   decided/found* and the ticket it came from (`— from #N`), via the CLI. This is append-only
   history — never rewrite or delete an earlier entry; a later revision lands as a new superseding
   line (§the map-shape contract).

5. **Fog-graduation — graduate the resolved ticket and spawn any new frontier it reveals.** Close
   the resolved sub-issue, and move it from `## Open frontier` into `## Graduated fog` via the CLI
   (the lockstep counterpart to step 4). Then, **if the recorded answer uncovers further
   unknowns**, file those as new frontier sub-issues under `## Open frontier` — reusing CHART's
   filing mechanics (a real `type:investigation`/`type:decision` sub-issue linked to the map, held
   to the same plan-don't-do law: each new ticket resolves a decision or an unknown, never a
   deliverable) — and note them on the graduated line (`→ spawned #M`). A resolved unknown
   routinely reveals the next one; that spawn is the map's forward motion, not a failure to finish.

6. **Stop — exactly one ticket resolved.** One frontier ticket is now answered, recorded, and
   graduated, with any newly-revealed fog laid down for a future run. Do **not** pick a second
   ticket; the next WORK run resumes cold from the map's updated state.

### The founder-decision-fork seam — surfaced, never resolved by WORK

WORK clears investigation fog autonomously, but it **never auto-resolves a founder-decision-fork**
— the one preserved human seam (see [Two modes, one preserved human seam](#two-modes-one-preserved-human-seam)
for the *why*). When the ticket WORK would pick is a fork, it does **not** hand it to a subagent
and does **not** pick an option: it leaves the fork on `## Open frontier`, surfaces that the map is
awaiting a founder call, and stops. The mechanics of *routing* a fork to the founder — framing the
decision-request, recording the awaiting-founder state, and blocking on the founder's answer —
are the [founder-decision-fork seam](#the-founder-decision-fork-seam--routing-the-fork-to-the-founder)
below, which this step calls into; WORK's obligation here is only to **recognize the fork and
refuse to resolve it**, then hand off to that routing contract.

## The founder-decision-fork seam — routing the fork to the founder

This is the **one preserved human seam** of the whole ideation layer, and this section is its
**routing contract** — the mechanics WORK mode's
[founder-decision-fork seam](#the-founder-decision-fork-seam--surfaced-never-resolved-by-work)
calls into once it has recognized the ticket it would pick as a fork. wayfinder automates the
ideation layer end to end **except here**: a founder-decision-fork — a product/strategy/§CP choice
that is the founder's to make, not an answerable question of fact — is **never** resolved by the
agent. The agent **frames** it; the founder **decides** it. Two properties are asserted and held
load-bearing: **no second human gate is added anywhere in wayfinder** (this is the *only* one), and
**this seam is not a scaffold to be automated away later** — it is the telos constraint the
ideation layer exists to preserve, the same product-driven-decision boundary the execution
pipeline's §CP control point honors (ADR
[0078](https://github.com/kamp-us/phoenix/blob/main/.decisions/0078-product-driven-decisions-by-default.md)).

### Route — frame the fork as a sharp decision-request addressed to the founder

A fork already lives on the map as a `type:decision` sub-issue — CHART files it that way (the
Grilling row of the
[translation table](#the-ticket-type-translation-table--reuse-existing-types-invent-no-new-machinery)),
reusing the pipeline's existing `type:decision` type, inventing no new label. Routing it to the
founder is the **framing legwork** — the work that *frames* a decision without *making* it:

1. **Make the `type:decision` sub-issue decision-ready.** Its body must carry an explicit
   **decision-request** addressed to the founder: the one sharp question, the concrete **options**,
   and each option's **trade-offs** — the legwork that lets the founder decide in a single read
   rather than re-derive the analysis. The agent supplies everything *except the choice*.
2. **Never voice the founder.** The agent lays out the options and their trade-offs; it does
   **not** pre-pick a default, phrase a recommendation *as* the decision, or write the answer "the
   founder would probably give." A fork carrying an agent-supplied choice is the exact failure this
   seam exists to prevent — the agent's authority ends at the frame.

### Record — the fork stays on the frontier, marked awaiting the founder

Routing a fork touches the map's `## Open frontier` only, never `## Decisions-so-far`:

- The fork's line **stays on `## Open frontier`**, marked `(founder-decision-fork — awaiting
  founder)` and referencing its `type:decision` sub-issue — the map-shape contract's fork-marking
  ([`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md), §The `wayfinder:map` issue
  shape).
- It **does not graduate.** The lockstep invariant is that a ticket leaves `## Open frontier` only
  when its answer lands in `## Decisions-so-far`; a routed fork has **no answer yet**, so nothing is
  written to `## Decisions-so-far` and the fork is never moved to `## Graduated fog` at routing
  time. The agent has decided nothing, so the map records no decision.

### Block — the map waits on the founder; WORK never steps in

Once a fork is routed, the agent **blocks** on the founder's answer:

- A WORK run **skips** an awaiting-founder fork and takes the next investigation ticket instead
  (WORK's [seam step](#the-founder-decision-fork-seam--surfaced-never-resolved-by-work)) — the fork
  is simply not agent-resolvable.
- If **every** remaining frontier ticket is a fork awaiting the founder, the map is **blocked on
  the human**: there is nothing for WORK to resolve, so it surfaces that the map awaits a founder
  call and stops. This block is the seam **working, not a stall** — never route around it by having
  the agent pick an option to "unblock" the map.

### Consume — the founder's answer graduates the fork, the founder's voice as the answer

The founder answers by recording their choice on the `type:decision` sub-issue — their call, in
their own voice. That answer **unblocks** the fork: a later WORK run then treats it exactly as it
treats any resolved frontier ticket — it appends the founder's decision into `## Decisions-so-far`
(`— from #N`) and graduates the fork into `## Graduated fog`, in the same lockstep the
[WORK walk](#the-walk-1) holds for an investigation, and spawns any new frontier the decision
reveals. The **only** difference from an investigation is *whose answer it is*: the deciding voice
was the founder's, never the agent's. wayfinder did the framing legwork, the founder made the call,
and the map records it and moves on.

## Emission — the cleared map graduates into its durable artifact(s)

This is the **handoff seam** where the ideation layer graduates into the execution pipeline: a
map that has cleared enough fog emits its **durable artifact(s)** — most often one or more concrete
epics/features into the **existing** `report` → `triage` → `plan-epic` → `write-code` funnel, but a
map whose destination was itself a decision graduates into an **ADR** (authored via `/adr`), and a
map that charts strategic sequencing graduates into a **ROADMAP.md** entry. Emission is **not a
third mode with new machinery** — it is the terminal act of a map's life, reached from a WORK run
whose graduation-readiness check finds the frontier cleared. Where CHART lays the frontier down and
WORK clears it one ticket at a time, emission is what a map *becomes* once its frontier holds no
more answerable unknowns: the accreted plan, filed as intake the settled pipeline already knows
how to drain. Nothing downstream is rebuilt — emission only feeds the funnel from its front.

### When emission fires — the graduation-readiness signal

A map is **emission-ready** when its `## Open frontier` holds no more *answerable* unknowns: every
investigation ticket has graduated into `## Graduated fog`, and no founder-decision-fork remains
awaiting the founder that would gate the buildable plan. This readiness is the wayfinder CLI's
**graduation-readiness signal** (#2426) — WORK **asks the CLI**, and never re-derives readiness by
ad-hoc markdown parsing of the map body (the same single-source discipline every map-state op
holds; see [Map state is read and written through the `wayfinder-map` CLI](#map-state-is-read-and-written-through-the-wayfinder-map-cli--never-ad-hoc-markdown-parsing)).

- A WORK run that finds the frontier **still holds an answerable unknown** resolves that one ticket
  (the [WORK walk](#the-walk-1)) and does **not** emit — emission is never chained onto a
  resolution in the same run.
- A run that finds the frontier **cleared** performs emission instead of resolving a ticket.
  Emission is thus the natural terminus of the one-ticket-per-session walk, not a parallel machine.
- **Graceful block on the human.** A map that still holds a founder-decision-fork *awaiting the
  founder* is **not** emission-ready for the plan that fork gates — it is blocked on the human (the
  [founder-decision-fork seam](#the-founder-decision-fork-seam--routing-the-fork-to-the-founder)),
  and emission waits for the founder's answer to graduate the fork before that part of the plan
  becomes buildable. Emission never routes around an open fork by guessing the decision.

### Compose each brief from `## Destination` + `## Decisions-so-far`

The emitted issue's brief is composed from the map's **accreted state**, read through the CLI:

- The map's **`## Destination`** supplies the end-state the epic charts toward — *where we want to
  be*, concretely enough to tell "arrived" from "not yet."
- The map's **`## Decisions-so-far`** supplies the settled decisions and established facts that make
  the path buildable — these become the brief's **givens**, each carried with its `— from #N`
  provenance so a downstream reader can trace the decision back to the frontier ticket that settled
  it.
- `## Open frontier` and `## Graduated fog` do **not** go into a brief — the frontier is cleared,
  and the fog is the map's working history of *how* it cleared, not part of the spec.

One cleared map may emit **one or several** epics/features: decompose the cleared destination into
the coherent buildable units its accreted decisions now support, and give each emitted issue the
relevant slice of `## Decisions-so-far` as its givens plus a link back to the map for provenance.

### File into the existing `report` → `triage` entry seam — reuse, don't rebuild

Emit each epic/feature as a **`status:needs-triage`** issue — the **same intake entry the `report`
skill uses** — carrying only that one label, no `type:*` and no priority. This is a deliberate
reuse of the pipeline's front door, not new machinery:

- **Emission does not classify, type, or prioritize** the emitted issue — that is `triage`'s job.
  Applying a type or priority here would poison the triage queue exactly as a hand-typed label does
  (§the report skill's "no type, no priority" rule).
- **Emission does not plan an emitted epic into children** — that is `plan-epic`'s job once triage
  has classified it as an epic.
- Downstream `triage` → `plan-epic` → `write-code` is **reused verbatim, never re-invented.** The
  seam adds *no* downstream state, label, or step; it only files intake the existing pipeline
  already drains.

The emitted issue is **agent-filed intake**, so carry the report skill's `Filed by an agent` footer
([`../report/footer.sh`](../report/footer.sh)) — this marks the emitted epic as pipeline intake
rather than a hand-typed, human-owned issue, so triage's auto-close-eligibility semantics apply
correctly (§the report footer in the formats contract). Stream the composed brief straight into the
create over stdin (no shared temp file to collide on, per the report skill's filing rule):

```bash
REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
# One emitted epic per coherent buildable unit. The brief is composed from map #$MAP's
# ## Destination + the relevant ## Decisions-so-far slice (read via the wayfinder CLI, never
# ad-hoc markdown slicing). Files into the SAME status:needs-triage entry `report` uses.
{
  cat <<'EOF'
## Destination
<the epic's end-state, from the map's ## Destination>

## Given (decided on the map)
<the ## Decisions-so-far entries that make this epic buildable — each with its `— from #N` provenance>

## Emitted from wayfinder map
Charted and cleared on wayfinder:map #<MAP>. Downstream is the existing pipeline: triage → plan-epic → write-code.
EOF
  echo   # blank line before the footer block
  claude-plugins/kampus-pipeline/skills/report/footer.sh   # emits its own `---` + <sub>… line
} | gh api repos/$REPO/issues \
  -f title="<the epic, as one concrete deliverable>" \
  -F body=@- \
  -f "labels[]=status:needs-triage"
```

### Close the map on graduation — the close-on-source forcing function

Once the map's destination is fully realized in its durable artifact(s) — **whatever their kind:
epic(s) filed into triage, an ADR authored via `/adr`, and/or a ROADMAP.md entry** — the map is
**graduated**, and graduation **must close the map as part of the emission**, not leave it a step a
human/agent remembers to run. A graduated-but-open map is indistinguishable from live ideation
work: it looks pickable, inflates the backlog, and forces a manual dedup sweep to hand-close it
(#2988 — maps #2583/#2829/#2467/#2620 all graduated but were closed only by hand; #2940 is the
exemplar that *was* closed on graduation). The close is the durable "this map graduated into X"
record; generalize the #2940 close across **every** graduation artifact, not epics alone.

Make the ideation→execution handoff traceable from both ends, then close:

- Post a handoff comment on the map naming **every** artifact it graduated into — emitted epics
  (`#E1, #E2 → triage`), the ADR (`ADR NNNN`), the roadmap entry — so a reader can follow the map
  *forward* to what it became. This comment **is** the audit trail; it records source → artifact.
- Each emitted epic already references the map (`Emitted from wayfinder:map #<MAP>` in its brief),
  and an ADR/roadmap entry graduated from a map cites it likewise, so a reader of the artifact can
  follow it *back*. The link is **bidirectional** — that is what makes the handoff traceable.
- **Close vs annotate.** A map whose destination is **fully** graduated (its whole buildable/decided
  plan landed as artifacts) is **closed** — its frontier is cleared and its purpose (charting the
  fog) is complete; it remains the durable record of *how* the plan was discovered while the
  artifacts carry it forward. A map that graduates only **part** of its plan (some destinations
  still fogged, or a fork still awaiting the founder) is **annotated** with the artifact links but
  stays **open** for a future WORK run to clear the rest and graduate again. Only the *source map*
  is closed; the emitted epics, the ADR, and the roadmap entry are legitimately-live artifacts and
  stay as they are.

```bash
# Name every artifact the map graduated into (epics and/or ADR and/or roadmap), then close it
# IFF the destination is FULLY graduated. A partial graduation is annotated but stays open.
BODY="Graduated into: #$E1, #$E2 → triage → plan-epic → write-code; ADR 0176; ROADMAP.md v1. Frontier cleared — closing this map as the durable record of how the plan was discovered."
gh api repos/$REPO/issues/$MAP/comments -f body="$BODY"
gh api -X PATCH repos/$REPO/issues/$MAP -f state=closed -f state_reason=completed   # fully-graduated only; a partial graduation stays open
```

### What emission is not

- It **does not triage, type, or prioritize** the emitted issues — `triage` owns that.
- It **does not plan an emitted epic into children** — `plan-epic` owns that.
- It **does not write code, open a PR, or merge** — the execution pipeline owns that.
- It **invents no new downstream machinery** — the `report` → `triage` → `plan-epic` funnel is
  reused exactly; emission is only its front door for a cleared map.

> **Build status.** The construct — the `wayfinder:map` label, the map-issue shape contract, and
> the two-mode + one-seam description — both mode walks, **CHART** and **WORK**, the
> **founder-decision-fork** routing contract WORK surfaces-and-stops for, and the **emission** seam
> a cleared map hands off through are in place (#2421, #2422, #2423, #2424, #2425). Still to land:
> the **CLI tool** (#2426, the `wayfinder-map` reader/writer WORK's map-state ops and the
> graduation-readiness signal go through) and the dogfood bootstrap (#2427). Each fills in against
> the map-shape contract linked above; do not let a mode drift from that single source.
