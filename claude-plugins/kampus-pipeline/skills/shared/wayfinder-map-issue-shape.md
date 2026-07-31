# The `wayfinder:map` issue shape — the ideation-layer map contract

The single source for the **body shape of a `wayfinder:map` issue**: its four sections and their
order, the origin-attribution rule every `## Decisions-so-far` entry carries, and the lockstep
invariant that moves a ticket off the frontier.

**Who reads it.** The `wayfinder` skill's **chart** and **work** modes, and the wayfinder CLI —
and nobody else. They **cite** this file; none re-derives it.

Extracted from [`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md), where this shape
sat in the shared intake contract that twenty skills load and only `wayfinder` reads (#4439). It
lives under `claude-plugins/kampus-pipeline/skills/`, so it is control-plane in whole under the
existing whole-tree `CONTROL_PLANE_RE` branch — the same gating every skill here carries, with no
boundary amendment.

## The `wayfinder:map` issue shape

A `wayfinder:map` issue (the [`wayfinder:map` label](#the-wayfindermap--wayfinderbacklog-ideation-layer-markers--not-pipeline-states-not-type)) is not a task and not an epic — it is a **living map**: the
ideation-layer surface the `wayfinder` skill's **chart** and **work** modes and the wayfinder
CLI all read and write. This section is the **single source** of that body shape, so every one
of those consumers cites *one* definition and cannot drift (the same single-source discipline
§Milestone and §CP use). The map is a **shared state contract**, not free prose: its four
sections are the durable seam between the modes, so a `wayfinder work` run picks up cold from
what a prior `chart`/`work` run left on the map.

The *why* — what the ideation layer is and how it feeds the pipeline — lives in the
[`wayfinder` skill](wayfinder/SKILL.md); this section is the **contract**.

### The four sections

A `wayfinder:map` issue body carries exactly these four sections, in order:

- **`## Destination`** — the named end-state the map is charting toward: one or two sentences
  stating *where we want to be*, concretely enough to tell "arrived" from "not yet." This is the
  fixed star the map steers by; it changes rarely, and only in **chart** mode.
- **`## Decisions-so-far`** — the **accreting answer log**: the settled decisions and
  established facts, newest last, each a one-line entry naming *what was decided/found* and its
  resolvable origin (`— from #N`). This is the map's growing spine of certainty; a **work** run
  appends to it as it resolves each frontier ticket. Nothing is ever deleted here — a decision
  that is later revisited gets a new superseding entry, so the log stays auditable. **Every entry
  carries a `— from #N` origin** (the validator's auditability floor); the `#N` differs by *how*
  the entry entered the log:
  - **A WORK-mode append** cites the **frontier ticket** it resolved — `— from #<frontier-ticket>`.
  - **A CHART-time seed** (a founder given brought in at charting, and an in-session founder
    ruling recorded during a chart/work run) has **no frontier ticket** to cite — it is
    attributed to the **map's own issue number**, `— from #<MAP>`. The seed *came from* the chart
    act that created the map, so the map number is its honest origin; this keeps the seed
    resolvable and auditable without inventing an unattributed form. A history-shaped given whose
    provenance is a person still uses `— from #<MAP>`, carrying the *who* alongside the ref (e.g.
    `— from #<MAP> (@founder)`), never *instead of* it — see the [`wayfinder` skill](wayfinder/SKILL.md)'s
    CHART step 3 for when a design-history given may be seeded at all.
- **`## Open frontier`** — the **live edge of the unknown**: the open investigation and decision
  tickets, kept as **native sub-issues** of the map (so each is a real, linkable, closable
  GitHub issue, reusing the existing infra). Each line references its sub-issue and states the
  open question. A ticket flagged a **founder-decision-fork** is marked as such — `wayfinder`
  surfaces it and stops rather than auto-resolving it (the preserved human seam). This section
  shrinks as tickets are answered and grows as answers reveal new unknowns; the map is "done
  enough" for handoff when it holds no more *answerable* unknowns.
- **`## Graduated fog`** — the **cleared unknowns**: tickets whose answers have been recorded
  into `## Decisions-so-far` and whose resolution *graduated* them off the frontier (often
  spawning the next frontier ticket in the process — that is the map's forward motion). Each
  line references the now-closed sub-issue and, where it spawned follow-on frontier, names it
  (`→ spawned #M`). This is the map's history of motion: the record of *how the fog cleared*,
  distinct from `## Decisions-so-far`, which records *what was decided*.

The invariant tying them together: **a ticket leaves `## Open frontier` only by its answer
landing in `## Decisions-so-far` and the ticket moving to `## Graduated fog`** — the three move
in lockstep, so the map is never left in a state where a resolved unknown has no recorded
answer.

### Worked example

```markdown
## Destination
kamp.us has a working invite (kefil) flow: an existing yazar can vouch a new person in, and
that person lands as a çaylak with a clear first-run path — no founder in the loop.

## Decisions-so-far
- The çaylak → yazar path is vouch-gated (kefil), not open signup — a founder given brought in at
  charting. — from #100 (@founder)
- Invites are karma-gated, not seat-gated — a yazar spends no quota, the çaylak's own karma
  ramp is the throttle. — from #101
- The invite artifact is a single-use signed link, not an in-app request/approve handshake. — from #102

## Open frontier
- #103 — Investigation: does better-auth's session model let us mint a single-use invite token
  without a new table, or do we need an `invite` store of record?
- #104 — Decision (founder-decision-fork): should an invited çaylak start at 0 karma or inherit
  a small vouch-backed starting balance? (options + trade-offs surfaced; awaiting founder)

## Graduated fog
- #101 — Decided invites are karma-gated. → spawned #104 (starting-balance question)
- #102 — Decided the artifact is a signed link. → spawned #103 (token storage investigation)
```

The map here is `#100`. Its first `## Decisions-so-far` entry is a **CHART-time seed** — a
founder given with no frontier ticket to cite — so it is attributed `— from #100`, the map's own
number (with `(@founder)` naming the *who*). `#101`/`#102` have graduated (their answers are in
`## Decisions-so-far`, they sit in `## Graduated fog`, and each spawned the next frontier ticket,
so those two entries cite their **frontier tickets**), `#103` is an answerable investigation
`work` mode can clear, and `#104` is a **founder-decision-fork** `wayfinder` surfaces and stops
on — never auto-resolves.

### Field notes

- **Read tolerantly, write canonically** (per §Reading stance): a map that spells a heading
  slightly differently, or carries an extra note under a section, still means what it means;
  emit the four canonical section headings.
- **The sub-issue infra is reused, not reinvented.** Frontier tickets are ordinary GitHub
  sub-issues of the map — they carry their own `type:*`/`status:*` as any issue does once they
  graduate into the execution pipeline; on the map they are referenced by number, not copied.
- **The map is not `write-code`-pickable.** Only the concrete work a map *graduates* into
  `triage` / `plan-epic` becomes pickable execution issues; the map itself is worked by
  `wayfinder`, never picked by `write-code`.
- **A `wayfinder:backlog` destination has no map body yet.** The [`wayfinder:backlog`
  label](#the-wayfindermap--wayfinderbacklog-ideation-layer-markers--not-pipeline-states-not-type)
  marks a destination *queued* for charting — a named end-state, not yet a living map — so it
  carries no four-section shape. Charting it is what *produces* this body shape: a
  `wayfinder:backlog` destination graduates when the cartographer charts it into a
  `wayfinder:map`, which then graduates its cleared frontier into emitted factory work. Like
  the map, it is never picked by `write-code`.

