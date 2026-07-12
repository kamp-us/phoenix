---
id: 0176
title: Nav IA discipline — element taxonomy + placement law, encoded in the design manifest
status: accepted
date: 2026-07-11
tags: [design, frontend, navigation, information-architecture, manifest]
---

# 0176 — Nav IA discipline — element taxonomy + placement law

## Context

The kamp.us navigation surface had **no information-architecture discipline**. Elements
accreted onto the topbar one affordance at a time, each classified nowhere and placed by
whoever added it. The absence minted a recurring class of nit: a verb-pill dropped among
product nouns (#2543), a draft view with no nav entry (#2579), a utility toggle rubbing
against the primary CTA and stealing its clicks (#2582). Each was fixed in isolation; none
of the fixes closed the door, because there was no law that said *where a nav element of
this kind is allowed to live* — so the next affordance re-opened it.

This ADR records the IA discipline that makes that drift **unrepresentable**: a closed
element **taxonomy** (what a nav element *is*), a **placement law** (where each class is
allowed to live), and the **manifest IA rule** that encodes both as agent-readable design
law `write-code` reads before generating nav UI. It is the nav-surface analogue of ADR
[0162](0162-four-pillars-design-law.md)'s four-pillars discipline: a founder-authored law,
agent-transcribed into [`design-system-manifest.md`](../design-system-manifest.md), enforced
by the same design gates.

### Provenance

This is a **conversation/chart-authored** decision, authored directly (not via report → triage)
and merged issueless on the doc lane per ADR
[0075](0075-issueless-doc-pr-merge-seam.md). It is not agent-invented: every clause below was
ratified by the founder on the wayfinder map
[#2583](https://github.com/kamp-us/phoenix/issues/2583) ("Nav IA discipline"), which
graduated six founder-decision-forks into its Decisions-so-far log:

- **#2591** — first-principles interrogation: the topbar *job statement* + all seven
  per-element verdicts.
- **#2586** — the element taxonomy (the closed class list).
- **#2587** — the placement law (Model 2, two-tier + zone grammar).
- **#2589** — how the primary CTA is distinguished (container scarcity).
- **#2588** — the `tema` verdict.
- **#2590** — the shape of the manifest IA rule itself.

The claims here are grounded in those forks' ratified resolutions, not in intuition. Where
this ADR and the forks disagree, the forks (and the map's Decisions-so-far) are authoritative.

## Decision

### The topbar job statement (the criterion)

Ratified on #2591. The topbar is not a shelf for whatever needs a home; it answers three
questions and promotes one action:

> The topbar answers three questions, always: **where can I go** (destinations), **who am I
> here** (identity + account), **what needs my attention** (signals). Plus at most **ONE**
> promoted action. Anything else must argue its way in.

Every element on the surface is measured against this. An element that does not answer one
of the three questions and is not *the* one promoted action does not earn permanent
top-bar real estate — it is demoted to a product zone, folded into the account trigger, or
killed.

### The element taxonomy (four classes, closed list)

Ratified on #2586. Every nav element is assigned to exactly one of four classes. This is a
**closed list** — a new affordance is not added until its class is chosen.

| Class | What it is | Examples |
|---|---|---|
| **destination** | A place you go — a product noun or a top-level feed. | sözlük, pano, mecmua |
| **primary action** | The one verb the surface promotes. Exactly one per surface. | the global `+` create menu |
| **utility** | An ambient control the user reaches for on demand. | search (`⌘K`), theme (on the profile page) |
| **signal** | Read-only state that reports "what needs your attention". | bildirim (bell + count), divan access, karma |

Two notes on the ratification: the candidate fourth class "status" was **sharpened to
"signal"** (it reports attention, it is not a passive readout), and **search is a utility**,
not a destination (it is a control you invoke, not a place in the product noun row).

The model is deliberately two-level: **classes** say what an element *is*; **zones** (below)
say where a class *lives*. Keeping them separate is what makes the placement law checkable —
you assign the class once, and the zone follows from law.

### The placement law (Model 2 — two-tier + zone grammar)

Ratified on #2587. Placement is two-tier: a **global** zone (the topbar) and a **product**
zone (the per-product Subnav), plus the **user menu** for account-scoped utilities. Each
zone carries a fixed allowed-class list — the *zone grammar* — and an element may only sit
in a zone whose grammar admits its class.

| Zone | Admits | Never admits |
|---|---|---|
| **Topbar** (global) | destinations · signals · identity/account · the one primary action | a product-scoped action, a sub-destination, a page-scoped filter |
| **Subnav** (per-product) | product sub-destinations · product filters · the contextual (product-scoped) create CTA | a global destination, the global primary action |
| **User menu** | account-scoped utilities + account items | a destination, a signal, the primary action |

The load-bearing consequence: **every product's primary affordance lives in its own product
zone**. A product-scoped create verb (e.g. pano's "new post") is a *contextual CTA in that
product's Subnav*, never a global topbar button wearing global placement — that mismatch is
exactly the #2543 shape.

### How the primary CTA is distinguished (container scarcity)

Ratified on #2589. The primary action — the global `+` create menu — is distinguished **not**
by a bespoke spatial rule but by **container scarcity under the containment law**: it is the
**only accent-filled element in the topbar** (`--accent` / `--accent-fg`). Because the
containment law already forbids resting accent chrome elsewhere on the bar, "a utility styled
as the CTA" is unrepresentable — there is no second accent fill for a utility to borrow. One
accent container, one promoted action.

### The seven element verdicts (the taxonomy applied)

Ratified on #2591 (with #2588 for `tema`). Applying the law to today's topbar produced seven
verdicts — the concrete restructure the discipline demands:

1. **`+ gönderi` — EVICTED.** A pano-scoped verb wearing global placement. Split into (a) the
   global `+` create menu (the one promoted action) and (b) a contextual CTA in pano's Subnav.
2. **`tema` — KILLED from the topbar** (#2588). The profile page's light/dark/auto picker is
   the single theme control; no user-menu item. `DEFAULT_CHOICE` flips to **auto** so
   signed-out visitors follow the OS.
3. **bildirim badge → a standalone bell** (Lucide, per the icon idiom) with a count, opening a
   dropdown of the last 10 notifications + "tüm bildirimleri gör" → `/bildirim`. The
   user-menu "bildirimler" item dies.
4. **karma → folds into the user-menu trigger** as `name (karma)` (HN-style). The standalone
   chip dies; detail + çaylak progress live on the profile. (A karma-provenance ledger was
   filed separately into intake, #2592.)
5. **`akış` / `yazılarım` → demoted under mecmua's Subnav.** They are product sub-destinations,
   not top-level product nouns — they leave the destinations row.
6. **search (`ara`) → utility**, invoked via `⌘K`; it is not a destination.
7. **divan → the signals zone** (a gated Lucide glyph + tooltip, with a future pending-count
   badge). The destinations row is purely **sözlük / pano / mecmua**.

These verdicts are recorded here as the ratified target; the topbar restructure and the Subnav
standardization that implement them ship as separate epics downstream of this ADR (the map's
hand-off items 2 and 3).

### The manifest IA rule

Ratified on #2590. The discipline is only load-bearing if `write-code` reads it before
generating nav UI, the same way it reads the four pillars. So the taxonomy and placement law
are transcribed into a new **IA section** of
[`design-system-manifest.md`](../design-system-manifest.md), in the manifest's existing
grammar (ADR 0162's mechanism):

- a **class table** (element → class → sanctioned zone),
- the **zone grammar** (each zone's allowed-class list),
- and machine-checkable **prohibitions** — "Never place a non-destination in the topbar
  destinations row", "Never style a utility with the primary-action (accent-fill) treatment",
  "Never add a nav element without assigning its class".

The rule **extends beyond the topbar** to the per-product Subnavs (the zone grammar governs
both tiers). It carries its own **"Where the ADR is silent"** clause — a nav decision this ADR
does not cover is a gap to surface to the founder via [report](../.claude/skills/report/SKILL.md),
never a blank for an agent to fill — mirroring the manifest's existing silence rule so the IA
section grows only when the founder ratifies more law.

## Consequences

- The `#2543 / #2579 / #2582` nit class is closed at the root: a nav affordance cannot be added
  without a class, and its class fixes its zone — "drift unrepresentable".
- `write-code` gains a nav contract to satisfy; `review-design` (#1966) and the design lint
  (#2170) gate a nav PR against the IA prohibitions the same way they gate the four pillars.
- The manifest is the **single source** for the IA law; this ADR is the *why* + the ratified
  record, the manifest section is the machine-readable *what*. The two are coordinated — a change
  to one without the other is a defect.
- This ADR **adds** the IA law; it relaxes no existing guard. It is a doc/knowledge change on
  `.decisions/**` + the manifest, not a control-plane change.

### References

- Wayfinder map [#2583](https://github.com/kamp-us/phoenix/issues/2583) — the chart + ratified
  Decisions-so-far this ADR transcribes.
- Forks: [#2591](https://github.com/kamp-us/phoenix/issues/2591) (interrogation),
  [#2586](https://github.com/kamp-us/phoenix/issues/2586) (taxonomy),
  [#2587](https://github.com/kamp-us/phoenix/issues/2587) (placement),
  [#2589](https://github.com/kamp-us/phoenix/issues/2589) (CTA),
  [#2588](https://github.com/kamp-us/phoenix/issues/2588) (tema),
  [#2590](https://github.com/kamp-us/phoenix/issues/2590) (manifest rule).
- ADR [0162](0162-four-pillars-design-law.md) — the four-pillars design law + the manifest
  mechanism this section extends.
- ADR [0075](0075-issueless-doc-pr-merge-seam.md) — the issueless doc-PR merge seam (the
  conversation-authored doc lane this PR ships on).
