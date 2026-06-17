---
id: 0078
title: Decisions are product-driven by default; engineering leads only where the work *is* the platform
status: accepted
date: 2026-06-16
tags: [process, product, pipeline, prioritization]
---

# 0078 — Decisions Are Product-Driven by Default; Engineering Leads Only Where the Work *Is* the Platform

## Context

As the autonomous pipeline takes over more of the building, prioritization and design
need a north star. Without one, decisions drift toward **engineering elegance over user
value** — the tidiest abstraction, the most satisfying engine — because that is what the
machinery optimizes for when left to its own taste.

This crystallized in the [#120](https://github.com/kamp-us/phoenix/issues/120) site-search
decision. The call was *not* "FTS5 is the elegant engine." It was: the **search bar** is a
precision-lookup product surface (a user knows roughly what they want and wants it found —
this wants lexical), and **discovery** is a serendipity surface (a user wants to be shown
something they didn't know to ask for — this wants semantic). The **product surfaces drove
the engineering choice**, and semantic search became its own *product* — the discovery
layer — not a search refactor dressed up as one. Read engine-first, that decision is
invisible; read product-first, it is obvious.

## Decision

**Decisions on phoenix are product-driven by default; engineering leads only where the
work *is* the platform.**

- For anything a **user touches**, product sets direction and engineering serves it.
- Engineering **leads** only where the work **is the platform / infrastructure** — the
  agent pipeline, the fate/DO substrate, search-*infrastructure*, the primitives every
  feature stands on.

**The tell:** "what should this *do / feel like*" → product's call; "what do we build
*everything* on" → engineering's call.

## Consequences

- **`triage` prioritizes by product value**, not engineering tidiness. A more interesting
  refactor does not outrank a duller feature a user is waiting on.
- **`plan-epic`'s product-layer-leads structure (ADR [0046](0046-plan-epic-prd-grade-plans.md))
  is the embodiment of this doctrine and is reinforced by it.** Plans lead with the product
  layer (problem, user stories, testing strategy) precisely because the product drives the
  engineering that follows; ADR 0046 is the *mechanism*, this ADR is the *why*.
- **When a decision is being driven by engineering elegance over product value, name it and
  re-anchor to the product question** — "what should this do / feel like for the user?" —
  before choosing the engine. The [#120](https://github.com/kamp-us/phoenix/issues/120)
  search decision is the worked example: surfaces first, engine second.
- **Banned:** ranking the backlog or designing a user-facing surface by engineering
  appeal; letting "the elegant engine" set the product shape (the inversion #120 avoided).
- **Relationship:** reinforces ADR [0046](0046-plan-epic-prd-grade-plans.md). Supersedes
  nothing.
