---
id: 0138
title: The divan is an actor-centric judgment chamber — moderation and vouch share the actor as their join key
status: accepted
date: 2026-07-03
tags: [divan, moderation, kefil, kunye, product, actor, epic-1665]
---

# 0138 — The divan is an actor-centric judgment chamber: moderation and vouch share the actor

## Context

Grounds and re-plans the moderator-UI epic [#1665](https://github.com/kamp-us/phoenix/issues/1665).
Conversation-authored per ADR [0075](0075-issueless-doc-pr-merge-seam.md) — the record of a
product-design pass with the founder on 2026-07-03, not the resolution of a triage ticket.

Two things live in `/divan`: the moderator UI (the epic-#1665 surface, built on the shipped
[#1701](https://github.com/kamp-us/phoenix/issues/1701)/[#1702](https://github.com/kamp-us/phoenix/issues/1702)
`Moderate`-gated report reads) and the vouch/**kefil** promotion rite that elevates a çaylak to
yazar. The naive framing treats these as two unrelated moderator features that merely happen to
share a route — a mod queue over *here*, a vouch button over *there*.

The design pass rejected that framing. Moderation — "suppress this actor's bad content" — and the
kefil rite — "elevate this çaylak to yazar" — are **the same job seen from two ends: judgment about
an actor's trajectory**. phoenix runs open registration; the kefil/vouch rite (not a registration
gate) is the community's quality valve. That makes the divan the chamber of judgment about *people*,
and content-moderation is that same judgment at the content granularity. A reader who models the
divan as "two colocated tools" will build two data paths, two disconnected views, and miss the one
view that is the divan's entire reason to exist.

## Decision

Commit to an **actor-centric spine**: the actor — the künye identity — is the **join key** across
both divan modes, `raporlar` (moderation) and `kefil` (vouch).

### 1. One shared künye actor-drawer, rendered in both modes

A single actor-drawer is the divan's central surface, opened from either mode. It renders the
actor's tier, karma, üretim counts, the two trust tells (`kaldırılan` — how much of theirs was
removed; `bildirilen` — how much was reported), kefil durumu, and the actor's other reported
targets. It is authored once and reused; `raporlar` and `kefil` are two entries into the same
drawer, not two drawers.

### 2. Cross-mode hops both directions

From a reported target you reach that actor's kefil rite; from a kefil rite you reach their
moderation record. Judging content pulls up the person; vouching a person pulls up their content.
The hop is the spine made navigable.

### 3. The mod record informs the rite — it never gates it

In the kefil rite the actor's moderation record is **visible-but-never-auto-verdicting**: it is
shown to the human deciding the vouch, and it does **not** gate, block, or auto-decide the rite.
Judgment stays human — the record is evidence for a person, not a machine veto. This is the
divan-local expression of the agents-deploy/humans-release boundary (ADR
[0083](0083-agents-deploy-humans-release.md)): the machine surfaces state, the human renders the
verdict.

### 4. Every mod-UI slice is a MODE/enrichment over the shipped report reads — never a second data path

Architecturally, each mod-UI slice is a **MODE over, or an enrichment of, the existing
`Moderate`-gated report reads** — the #1701/#1702 foundation — joined with the künye DO. The
actor-drawer is that join (report reads ⋈ künye) rendered. No slice re-fetches; no slice opens a
second data path to actor state. The report-resolution lifecycle and `Moderate` capability those
reads sit on are ADR [0098](0098-moderation-role-resolution-lifecycle.md) (superseded in its role
mechanism by the capability framework, ADR [0107](0107-capability-authz-framework.md), whose
`CurrentActor` §7 is the actor identity this spine joins on); the divan enriches those reads, it
does not fork them.

### 5. Keystone ordering: the actor-drawer ships second

The actor-drawer ([#1852](https://github.com/kamp-us/phoenix/issues/1852)) is the epic's
**keystone**. It ships **second** — immediately after the reshaped triage-loop
([#1703](https://github.com/kamp-us/phoenix/issues/1703)) — because both remove-the-wave
([#1855](https://github.com/kamp-us/phoenix/issues/1855)) and the two-person team-ledger
([#1704](https://github.com/kamp-us/phoenix/issues/1704)) **depend on it**. Scheduling a
drawer-dependent slice before the drawer is the ordering mistake this ADR names explicitly, so
the re-plan of #1665 cannot re-make it.

## Alternatives rejected

- **Two separate destinations — a standalone admin/mod panel split out of the divan.** Rejected:
  splitting moderation into its own panel severs the actor-centric view that is the divan's reason
  to exist (you would judge content without the person, and vouch the person without their content
  record), and it creates a discovery problem for a two-person mod team (the founder + his brother)
  — two places to learn, two places to check, when the whole value is that they are one. The fusion
  is the decision; two destinations un-make it.

## Consequences

- The fused divan is worth more than two separate pages: you **never judge content without seeing
  the person, and never vouch a person without seeing their content record** — a view available
  *only because* the two modes were fused on the actor. That single fused view is what this ADR buys.
- **Cost:** the queue/ledger reads must join the künye DO (report reads ⋈ künye), and the
  actor-drawer becomes load-bearing for three downstream slices (#1855, #1704, and the triage loop
  reads through it) — hence the keystone ordering. A regression in the drawer is a regression in
  three slices.
- **UI corollary (not the core decision):** the divan adopts the product's `cyan` accent theme
  rather than the default `ember`, so that destructive-red (`Kaldır` / `--danger`) stays
  semantically distinct from the accent on a judgment surface — on a page whose whole job is
  weighing people, "remove" must not read as "the accent color."

## References

- Epic [#1665](https://github.com/kamp-us/phoenix/issues/1665) — the moderator-UI epic this
  decision grounds and re-plans; children
  [#1703](https://github.com/kamp-us/phoenix/issues/1703) (reshaped triage loop),
  [#1852](https://github.com/kamp-us/phoenix/issues/1852) (the keystone actor-drawer),
  [#1855](https://github.com/kamp-us/phoenix/issues/1855) (remove-the-wave),
  [#1704](https://github.com/kamp-us/phoenix/issues/1704) (two-person team-ledger),
  [#1856](https://github.com/kamp-us/phoenix/issues/1856).
- Shipped foundation [#1701](https://github.com/kamp-us/phoenix/issues/1701) /
  [#1702](https://github.com/kamp-us/phoenix/issues/1702) — the `Moderate`-gated report reads every
  mod-UI slice is a MODE/enrichment over.
- ADR [0075](0075-issueless-doc-pr-merge-seam.md) — the issueless doc-PR merge seam this
  conversation-authored record is filed under.
- ADR [0083](0083-agents-deploy-humans-release.md) — the machine-surfaces / human-decides boundary
  the "mod record informs but never gates the rite" guardrail expresses.
- ADR [0098](0098-moderation-role-resolution-lifecycle.md) — the report-resolution lifecycle the
  divan's moderation reads sit on.
- ADR [0107](0107-capability-authz-framework.md) — the capability-authz framework and its
  `CurrentActor` (§7), the künye actor identity this spine joins moderation and vouch on.
</content>
