---
id: 0166
title: "The canonical icon idiom — Lucide line-icons at native per-size stroke, monochrome role-token color, a drawn triangle vote glyph, and the function/affect/key-legend/state-marker partition"
status: proposed; amended-in-part by [0240](0240-icon-dense-tier.md); extended in place by §8 (state markers, ruled 2026-09-05)
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
keycap is `<kbd>` typography. Nothing crosses those lines. The partition grew a fourth class in §8;
these three are unchanged by it.

### 8. A state marker is not an icon — the fourth class (ruled 2026-09-05)

§7 sorted every glyph three ways and left one shape homeless: a Unicode glyph doing **state** work
— a `::before` caret marking the active row, a check standing for a set item, a dot marking an open
section. It names no function, is not a reaction, and is not a keycap, so §1's ban neither covered
it nor exempted it, and two live surfaces were left to per-agent reading (the palette caret of
[#7983](https://github.com/kamp-us/phoenix/issues/7983), the markdown checkbox of
[#8023](https://github.com/kamp-us/phoenix/issues/8023)). Founder ruling, transcribed here:
<https://github.com/kamp-us/phoenix/issues/8073#issuecomment-5555958957>.

**A CSS state marker is not an icon.** §1's ban is about a functional glyph standing in for
iconography; a marker decorating a state the component already carries is typography, and it stays
legal as CSS generated content. This is **not** a general exemption for Unicode glyphs — two
conditions bound it, and a marker failing either is back under §1's ban:

1. **It pairs with a non-visual state signal** — either the ARIA state the component already exposes
   (`aria-selected`, `aria-checked`, `aria-expanded`) or a visually-hidden state word. The state
   never rides on the glyph alone; this is 0162's Pillar 4 applied, not a new rule.
2. **It never leaks into the accessible name** — either the alternative-text form
   (`content: "\203A" / ""`) or a glyph rendered on an `aria-hidden` element. Generated content
   carrying no alt text is folded into a name-from-content computation by design, so an unbounded
   marker corrupts the name of the very row it decorates
   ([#8079](https://github.com/kamp-us/phoenix/issues/8079)).

A glyph that names a **function** is still a Lucide icon wherever it is drawn; a marker that fails
either condition is not a state marker but a functional glyph in the wrong delivery.

The two live cases follow from this. **#7983's active-row caret stays a CSS `content:` glyph** — not
a Lucide chevron rendered from `packages/design/src/CommandPalette.tsx` — and owes the alt-text form
plus the `aria-selected` the palette already sets. **#8023's ruled treatment** (a decorative glyph
plus a visually-hidden state word) satisfies the same two conditions by the other arm of each, and
stands.

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
