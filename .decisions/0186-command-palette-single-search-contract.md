---
id: 0186
title: The ⌘K command palette is the single search contract
status: accepted
date: 2026-07-16
tags: [product, nav-ia, search, a11y]
---

# 0186 — The ⌘K command palette is the single search contract

## Context

Search on kamp.us is a wayfinding fracture: three contradictory "ara" surfaces
exist side by side — the topbar search, the subnav search, and inline search — each
offering its own conflicting affordance for the same intent. A reader who learns one
"ara" gains nothing when they hit the next; the mental model resets per surface. The
topbar already renders a ⌘K affordance, but it is present-yet-unfulfilled: it hints at
a single palette that does not actually subsume the other two surfaces. Origin ticket
[#2412](https://github.com/kamp-us/phoenix/issues/2412).

The ticket originally framed this collapse as "held for move 3+, do not build." This
decision supersedes that framing: the collapse ships incrementally, surface-by-surface,
starting now — not deferred to a later move.

## Decision

The **⌘K command palette is the single search contract made physical** — the one search
entry point on kamp.us. The three "ara" surfaces (topbar, subnav, inline) collapse into
it: one contract, one affordance.

- **v1 scope is SEARCH only.** ⌘K is explicitly **not** a command runner at v1. A
  command-runner evolution is out of scope for this decision.
- **It searches over the global search contract** — the same one [#2995](https://github.com/kamp-us/phoenix/issues/2995)
  folds sözlük's own search into.
- **Accessibility is code-authoritative.** The palette's keyboard, assistive-technology,
  and reduced-motion behavior is owned by the a11y-spine contract in code, not
  reimplemented per surface.
- **The collapse is built incrementally, surface-by-surface** — not deferred to a later
  move. [#2995](https://github.com/kamp-us/phoenix/issues/2995) (sözlük search → ⌘K) is
  step 1 and is in flight now. Each remaining "ara" surface (topbar, subnav, inline) folds
  into ⌘K as its own subsequent drain item. This ADR records the target shape so every
  incremental fold has an unambiguous end-state to build toward.

## Consequences

- **One search contract.** Every "ara" affordance resolves to the same ⌘K palette over the
  same global search contract; the per-surface mental-model reset is gone.
- **Incremental collapse, unambiguous target.** No big-bang rewrite and no "held, do not
  build" freeze — surfaces fold one at a time, each toward the end-state this ADR fixes.
  Adding a new search surface that is *not* ⌘K is now a regression.
- **Not a command runner at v1.** Scoping ⌘K to search keeps the v1 surface small; a
  command-runner evolution is a separate future decision, not smuggled in here.
- **a11y is code-authoritative.** Keyboard / AT / reduced-motion behavior lives once in the
  a11y-spine contract; a fold that reimplements palette a11y per surface violates this ADR.
