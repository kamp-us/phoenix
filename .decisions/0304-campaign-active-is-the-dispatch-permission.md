---
id: 0304
title: Campaign active status is the dispatch permission, and the Focus table retires
status: amended-in-part by [0354](0354-running-campaign-admits-p0-and-p1.md)
date: 2026-08-19
tags: [fabrika, pipeline, roadmap]
---

# 0304 — Campaign active status is the dispatch permission, and the Focus table retires

**What this decides:** the milestones an agent may open lanes against are the ones whose
`ROADMAP.md` `## Campaigns` row says `active`. The separate `## Focus` table goes away, and a
campaign that is alive but not being executed carries `paused` instead.

## Context

Two surfaces answered one question. `## Campaigns` marks many rows `active` at once — campaigns run
concurrently by design — so `## Focus` was stacked on top to say which of those an execution engine
may open lanes against. ADR [0245](0245-campaign-scope-fence-binds-both-seams.md) built that fence
and ADR [0298](0298-declared-focus-is-a-set-of-milestones.md) made the declaration a set of
milestones rather than one.

On 2026-08-18 the split cost a founder round. PR [#6287](https://github.com/kamp-us/phoenix/pull/6287)
added an M47 row to `## Focus` so lanes could open against a campaign whose `## Campaigns` row
already said `active`, and when the driver explained why both edits were needed the founder rejected
the layer.

Founder ruling, 2026-08-18 PT, recorded on
[#6288, comment 5337663028](https://github.com/kamp-us/phoenix/issues/6288#issuecomment-5337663028),
verbatim:

> we could fucking turn other milestones off active and keep the focused one(s) the only active ones
> instead of inventing another layer on top of it.

This record is that ruling written down, per ADR
[0300](0300-a-cited-ruling-makes-a-decision-buildable.md); the citation above is what made the
decision issue agent-buildable. The ruling settles the direction and delegates exactly one gap — the
name of the non-dispatching status value — so that name is the only thing here nobody else decided.

## Decision

**A campaign's `State` cell is the dispatch permission: an issue is admitted on the scope axis when
its home milestone is pinned by a `## Campaigns` row whose state is `active`.**

- **`State ∈ {active, paused, done}`.** `paused` is the value the ruling asked for and did not name:
  the campaign is alive, its milestone is open, and no lane opens against it. `done` still means the
  milestone closed. Resuming is flipping the cell back — the same one-cell edit declaring a focus
  used to be.
- **`## Focus` retires**, and `roadmap-guard`'s invariant **I6** with it. With no second declaration
  surface there is nothing left for I6 to keep honest.
- **The fence reads the campaigns table.** Scope admission
  ([`packages/fabrika-cli/src/build/scope-admission.ts`](../packages/fabrika-cli/src/build/scope-admission.ts))
  takes its rows from `## Campaigns` instead of `## Focus`. ADR 0245's rule that one predicate
  answers both `build` seams is untouched, as is the standing-lane exemption of ADR
  [0208](0208-standing-lane-exemption-from-full-homing.md).
- **A declaration that names nothing still admits everything.** An absent `## Campaigns` table, a
  table with no rows, and a table with no `active` row are one well-formed default — the fence is
  off, not closed — exactly as an absent or empty `## Focus` was (founder ruling on #5011, carried by
  ADR 0245). Pausing every campaign is therefore not a board freeze; freezing is not what this
  surface does, and never was.
- **Malformed still binds the whole declaration.** ADR 0298's rule survives the table it was written
  for: one unreadable row makes the reading `Malformed`, never the rows that parsed.

**Binding constraints.**
- One cell answers "may a lane open here". A second declaration surface for dispatch permission is
  banned, in `ROADMAP.md` or anywhere else.
- `paused` never means the milestone closed: `roadmap-guard`'s I5 symmetry gains it as an
  open-milestone state beside `active`.
- Arcs are untouched. `## Arcs` keeps `active | queued | done` and I2's exactly-one-active-arc rule.

## Consequences

**An arc milestone is no longer a dispatch permission, and nothing running loses by it.** The fence
reads campaign rows only, so work homed on the active arc's milestone (Geçit, #24) needs a campaign
row pinned to that milestone before a lane opens against it. Today's declared focus is #46 and #47,
both campaigns, so this narrows nothing that is running — and the lever, if arc work should be
dispatched, is one campaign row.

**The collapse lands in one pull request.** Retiring `## Focus`, dropping I6, repointing the fence
and `triage homes`'s `running` marker, teaching `roadmap-guard` the `paused` state, and flipping
Taste-Skill #42 — alive, not being executed — from `active` to `paused` are one change: repointing
the fence while every alive campaign still says `active` opens lanes on work nobody declared. That
build is [#6289](https://github.com/kamp-us/phoenix/issues/6289). PR #6287's M47 focus row dies with
the table.

**Declaring focus stays exactly as cheap, and now there is one place to look.** It was a pull request
editing a focus row; it becomes a pull request editing a state cell. The saving is not keystrokes —
it is that a founder reading `## Campaigns` reads the whole answer.

## Records

Fixes [#6288](https://github.com/kamp-us/phoenix/issues/6288). Supersedes ADR
[0298](0298-declared-focus-is-a-set-of-milestones.md), whose whole subject is the `## Focus` table's
cardinality; with the table gone there is nothing left for it to govern. Amends in part ADR
[0245](0245-campaign-scope-fence-binds-both-seams.md): its both-seams-one-predicate rule and its
explicit, recorded override both stand, and only the surface the predicate reads moves.

Vocabulary impact: **declared focus** retires as a term and **paused** is coined as a campaign state.
Both `.glossary/TERMS.md` rows that carry the old surface — `declared focus` and `scope admission` —
describe behaviour that is still live until the collapse build lands, so they move with
[#6289](https://github.com/kamp-us/phoenix/issues/6289) rather than with this record.
