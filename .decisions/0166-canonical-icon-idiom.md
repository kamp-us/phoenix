---
id: 0166
title: "The canonical icon idiom — Lucide line-icons at native per-size stroke, monochrome role-token color, a drawn triangle vote glyph, and the function/affect/key-legend partition"
status: proposed
date: 2026-07-06
tags: [design, frontend, cohesiveness, icons, tokens, control-plane]
---

## Context

ADR [0162](0162-four-pillars-design-law.md) Pillar 2 (cohesiveness) states the icon rule only as
**law-by-prohibition** — "one icon idiom … never a fourth icon idiom" — and the design-system
manifest (`design-system-manifest.md`) carries the same prohibition. What neither did was **define
the positive canonical idiom**: the icon set, the stroke discipline, the size scale, the color-role
mapping, and — the genuinely open fork — whether phoenix's existing thin-line Unicode glyphs
(`△` `↑` `→` `⌘↵`) are *adopted* as the canonical set or *replaced*. Today three unrelated glyph
systems coexist with no shared stroke weight, size, or color: full-color emoji, thin-line Unicode
functional glyphs, and the wordmark dot — the UI reads as assembled from different kits, the exact
cohesion defect Pillar 2 exists to outlaw.

This is a taste call, product/design-driven per ADR [0078](0078-product-driven-decisions-by-default.md),
whose output is a recorded choice. The founder ruled every fork below. An agent **transcribes** this
ruling; it does not invent it. This ADR is the positive companion to 0162 Pillar 2: it completes the
"one icon idiom" leg by naming *which* idiom, and it is the single icon rule the review-design gate
(ADR [0165](0165-review-design-gate.md)) checks a UI PR against. Issue
[#2248](https://github.com/kamp-us/phoenix/issues/2248).

## Decision

phoenix has **one canonical icon idiom**, ruled as follows.

### 1. Replace, don't adopt — the Unicode functional glyphs are out as icons

The thin-line Unicode functional glyphs `△` `↑` `→` `⌘` `↵` are **retired as icons**. They fail the
same font-fallback drift test Pillar 2 already used to outlaw raw system-emoji reaction glyphs: a
Unicode character renders through whatever font the platform substitutes, so its weight and shape
drift per-OS and per-font. The **semantics** those glyphs carried (vote, up, forward/next, command,
enter) are kept; the **Unicode-character-as-icon** delivery mechanism is dropped.

### 2. The canonical set is Lucide

The canonical icon set is **[Lucide](https://lucide.dev)** — this is *the* idiom, not "an icon
library." Its icons are 24×24 grid, a **single 2px stroke**, round caps and joins, `fill: none`.
Lucide is MIT-licensed, tree-shakeable, and is added as a dependency via `catalog:` (per the repo's
one-shared-version rule). Icons are **drawn Lucide glyphs**, not hand-inlined SVG.

### 3. Stroke scaling is native optical per-size

Icons scale with **Lucide's native per-size optical scaling** — the stroke thickens and thins with
the glyph as it is drawn at each size. We do **not** pin a constant `absoluteStrokeWidth` across
sizes. Native per-size scaling keeps each icon optically correct at its own size rather than
mechanically uniform.

### 4. The size scale is 16 / 20 / 24 on the 4px grid, with a decoupled tap target

Three sizes, all on the 4px grid, floor **16** (below 16 muddies on dark surfaces):

| Size | Use |
|---|---|
| **16 (sm)** | Dense rows · inline · vote |
| **20 (md)** | Standalone · nav · toolbar |
| **24 (lg)** | Emphasis · empty-state (used sparingly) |

The **tap target is decoupled from the glyph size**: the glyph is centered in a **≥36px hit area**
(padding fills the difference), honoring 0162's ratified 36px minimum tap target **without inflating
the glyph**.

### 5. Color is monochrome, `stroke: currentColor`, role tokens only

Icons are monochrome and paint via **`stroke: currentColor`**, driven by **role tokens only** (the
Pillar 2 role-layer rule — never a raw or semantic scale):

| State | Role token |
|---|---|
| Default | `--text-secondary` |
| Hover | `--text-primary` |
| Active / on | `--accent` |
| Disabled | `--text-muted` |

The **one filled exception** is the active vote glyph, which is an **`--accent` fill** (see §6). **No
icon hardcodes a color.**

### 6. The vote glyph is a drawn triangle

The vote affordance keeps the **triangle** (not a chevron) — the HN / lobste.rs vote lineage is
deliberate. It is **drawn**, not a Unicode `△`: **filled-accent** (`--accent`) when active, **outline
secondary** (`--text-secondary`) when inactive, with up/down symmetry, in a 36px hit area. The vote
glyph is the **one component that needs real design work**; every other surface is a mechanical
substitution.

### 7. The three-way partition — the boundary rule

Glyphs partition into exactly three classes, and the class decides the delivery:

- **Function** → a **drawn Lucide icon**, legal anywhere.
- **Affect** → the curated **six-emoji reaction set** (monochrome-controlled per ADR
  [0139](0139-reaction-curated-palette.md)), legal **only in the reaction bar**.
- **Key-legends** → `⌘` `⌥` `⇧` `↵` `⎋` are **keycap typography**, legal **only inside a `<kbd>`
  chip** — never free-floating, never an icon.

A functional glyph is a Lucide icon; a reaction is a controlled emoji in the reaction bar only; a
keycap is `<kbd>` typography. Nothing crosses those lines.

## Alternatives considered (rejected)

- **Phosphor** (rejected). Its multi-weight family is a multi-vector for exactly the drift Pillar 2
  outlaws — each weight is a different look, and the set stays cohesive only by convention.
- **Radix Icons** (rejected). Coverage is too sparse; it forces a second icon set to fill the gaps,
  which reintroduces the "fourth idiom" problem.
- **Hand-inlined SVG** (rejected). No shared stroke/grid discipline; every icon is a fresh taste
  call — the ad-hoc-per-surface state this ADR exists to end.
- **Constant `absoluteStrokeWidth`** (rejected). Pinning a uniform stroke across sizes trades Lucide's
  per-size optical correctness for mechanical uniformity; native per-size scaling (§3) reads better.
- **A chevron vote glyph** (rejected). It abandons the HN / lobste.rs triangle vote lineage for no
  gain; the triangle is kept (§6).

## Consequences

- **The design-system manifest encodes this idiom.** `design-system-manifest.md`'s Pillar-2
  icon-idiom leg — previously deferred, stating only the prohibition — is filled in with the ruled
  values above, so `write-code` reads the positive idiom before it generates any UI.
- **The review-design gate (ADR [0165](0165-review-design-gate.md)) checks against it.** This ADR is
  the single icon rule that gate verifies a UI PR against — the positive counterpart to Pillar 2's
  prohibition.
- **The glyph-surface migration is deferred to epic [#2168](https://github.com/kamp-us/phoenix/issues/2168),
  not performed here.** This ADR records the idiom only. Migrating the live surfaces is a **separate
  downstream chore** under #2168: grep the five retired glyphs, do the mechanical Lucide swap, do the
  real vote-cluster design (§6), reclassify `⌘K` / `↵` / `↑` into `<kbd>` chips or Lucide icons per
  §7, and likely add a small icon wrapper component that pins size + role-token + native per-size
  scaling. No `apps/web` component code changes in the PR that lands this ADR.

## Relationship to prior decisions

- **ADR [0162](0162-four-pillars-design-law.md)** — the four-pillars design law; Pillar 2
  (cohesiveness) states "one icon idiom" as a prohibition. This ADR is the positive completion of
  that leg, naming the idiom the prohibition guards.
- **ADR [0139](0139-reaction-curated-palette.md)** — the curated six-emoji reaction set. This ADR's
  §7 partition scopes that set to the **affect** class, legal only in the reaction bar; it is not an
  icon idiom and does not compete with Lucide.
- **ADR [0165](0165-review-design-gate.md)** — the review-design gate; this ADR is the icon rule it
  consumes.
- **ADR [0078](0078-product-driven-decisions-by-default.md)** — product/design decisions are
  founder-authored by default; every fork above was founder-ruled and is transcribed here, not
  invented.
