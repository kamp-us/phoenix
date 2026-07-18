# Design-system manifest — the four pillars, machine-readable

The **CLAUDE.md for design**: the agent-readable transcription of the four-pillars design law
that `write-code` reads *before* it generates any UI, the same way it reads
[CLAUDE.md](./CLAUDE.md) and [product-development-cycle.md](./product-development-cycle.md) at
their well-known paths. It encodes, per pillar: the **semantic token annotations** (what each
role token means and when to reach for it), the **component-selection rules** (reach for the
composite primitive, never hand-build), and the **prohibitions** (the machine-checkable "never"
rules a reviewer and a linter can enforce).

Its **sibling** for the marketing surface is [brand-imagery.md](./brand-imagery.md) — the same
founder-authored / agent-transcribed shape for **brand imagery** (the "ASCII cutaway kampüs" visual
grammar). This manifest governs the **UI**; that doc governs generated marketing / product art.
Both map to the *same* [`apps/web/src/styles/tokens.css`](apps/web/src/styles/tokens.css) tokens —
brand art and interface are one color system.

The normative content is **founder-authored, not agent-invented**. It is the machine form of ADR
[0162](https://github.com/kamp-us/phoenix/blob/main/.decisions/0162-four-pillars-design-law.md) —
the ratify-root of the frontend audit wave (epic
[#2168](https://github.com/kamp-us/phoenix/issues/2168)). An agent **transcribes** these
values into this artifact; it does **not** author design law. Where the ADR is silent, the gap is
surfaced to the founder — it is never filled here.

The token annotations below are grounded against the **live** token layer:
[`apps/web/src/styles/tokens.css`](apps/web/src/styles/tokens.css) (raw → semantic → role, plus
the compact/normal/spacious density ramps) and
[`apps/web/src/styles/global.css`](apps/web/src/styles/global.css) (where the focus-ring token
pair is defined). Each value cites where it **actually lives** in source.

> **Law vs live-value.** This manifest records the **law** — 0162's ratified target values —
> which the token recalibration legs ([#2164](https://github.com/kamp-us/phoenix/issues/2164),
> [#2163](https://github.com/kamp-us/phoenix/issues/2163)) then re-derive the live CSS to. Where
> the live CSS currently differs from the law (the focus ring is live a flush 2px ring, law adds
> the 2px gap), the manifest states the **law** and annotates the **current → target delta** so
> the recalibration leg knows its target and a reviewer knows what is not yet true; where a leg has
> landed (body text is now `14px` and elevation is now the four named levels + dark-mode tint, both
> per [#2164](https://github.com/kamp-us/phoenix/issues/2164)), the delta column records the
> achieved state.
> Encoding the law is not the same as the live CSS already satisfying it.

---

## How `write-code` consumes this

Before generating or editing any UI, `write-code`:

1. **Reads the four pillars and their prohibitions** (below) as the design contract the diff must
   satisfy — the design analogue of the acceptance criteria `review-code` checks.
2. **Reaches for role tokens only** (the semantic token annotations) — never a raw scale
   (`--mauve-*`) or a semantic scale (`--gray-N` / `--accent-N`) from a component.
3. **Reaches for the composite primitive** named in the component-selection rules — never
   hand-builds a card / meta-row / count-pill / button-wrapper / empty-state.
4. **Checks the diff against every prohibition** before opening the PR.

The `review-design` gate ([#1966](https://github.com/kamp-us/phoenix/issues/1966)) checks a UI PR
against these same four pillars; the design lint
([#2170](https://github.com/kamp-us/phoenix/issues/2170)) and the property-based a11y loop
([#2175](https://github.com/kamp-us/phoenix/issues/2175)) turn the machine-checkable prohibitions
into enforced gates. This manifest is the **single source** those consumers read — a value's
annotation, and the file it points at, is load-bearing for all three.

---

## The v1 design values (founder-ratified, cross-cutting)

The eight values below are law per ADR 0162 §"The v1 design values". Each is claimed by the
pillar it serves, but they are stated once here because several span pillars. Each row cites its
**source of truth** (where the value lives, or will live, in the CSS) and any **current → target
delta**.

| # | Value | Law (0162) | Where it lives in source | Current → target delta |
|---|---|---|---|---|
| 1 | **Grid** | 4px base grid; sanctioned **1px & 2px** exceptions (hairline borders, optical nudges). Everything lands on the 4px lattice unless a sanctioned exception. | The 4px lattice is the discipline behind the spacing ramp (`--s-1..--s-8`) and radius scale (`--r-sm: 2px`, `--r-md: 4px`, `--r-lg: 6px`) in [`tokens.css`](apps/web/src/styles/tokens.css). | On-grid re-derivation of the ramps is [#2164](https://github.com/kamp-us/phoenix/issues/2164)/[#2163](https://github.com/kamp-us/phoenix/issues/2163)'s job (some live density steps are off-grid, e.g. `normal --s-1: 5px`). |
| 2 | **Body text** | **14px** ratified body size. | `--t-body` in [`tokens.css`](apps/web/src/styles/tokens.css) (`:root` TYPE block). | **Achieved** — `--t-body` is now `14px` and the full `--t-*` ramp opened to that base by [#2164](https://github.com/kamp-us/phoenix/issues/2164). |
| 3 | **Spacing** | 4px-based ramp — hand-tuned but on-grid (Primer/Polaris perceptual ladder, not a rigid ×N multiplier); **all three density ramps re-derive to clean 4px multiples**. | `--s-1..--s-8` in [`tokens.css`](apps/web/src/styles/tokens.css), redefined per `[data-density="compact"\|normal\|spacious"]`. | Compact ramp is already 4px multiples (`4/8/12/16/20/24/32/40`); `normal`/`spacious` steps are re-derived to 4px multiples by [#2164](https://github.com/kamp-us/phoenix/issues/2164). |
| 4 | **Tap target** | **36px minimum hit area** for every interactive control (the hit area, not necessarily the visible glyph). | Not a single token — enforced per interactive control (min-height / min-width or hit-area padding). | New floor; the concrete fixes land in [#2166](https://github.com/kamp-us/phoenix/issues/2166). |
| 5 | **Elevation** | **Four levels — flat/resting · raised · dropdown · overlay** — plus a **dark-mode surface-tint bump** (each level lightens the surface, not shadow-only). | The four named levels `--shadow-flat` / `--shadow-raised` / `--shadow-dropdown` / `--shadow-overlay` in [`tokens.css`](apps/web/src/styles/tokens.css) (`[data-theme="dark"]` / `[data-theme="light"]` blocks). | **Achieved** — the four-level ramp + the dark-mode surface-tint bump are built by [#2164](https://github.com/kamp-us/phoenix/issues/2164); the old `--shadow-sm`/`--shadow-md` are retired and consumers rewired to the named levels. |
| 6 | **Focus — the spacer ring** | **2px ring + 2px gap** (a ring separated from the control by a transparent spacer). The gap guarantees the ring clears **3:1 contrast even on same-family dark surfaces**. Extends the existing `--focus-ring` token — its *definition* gains the gap; the ~13 correct consumers keep consuming `--focus-ring` unchanged. | `--focus-ring: 2px solid var(--accent-9)` and `--focus-ring-offset: 2px`, defined in [`apps/web/src/styles/global.css`](apps/web/src/styles/global.css) (**NOT** `tokens.css`), painted by the single `:focus-visible` rule there. | **Live `--focus-ring` is a flush 2px ring** (`--focus-ring-offset: 2px` already exists as the outline offset) → 0162's spacer ring adds the **2px transparent gap** to the token's definition; [#2169](https://github.com/kamp-us/phoenix/issues/2169) builds the systematic focus layer, [#2166](https://github.com/kamp-us/phoenix/issues/2166) fixes the ReactionBar double-wrap misuse. |
| 7 | **Contrast floors** | **AA 4.5:1** for body / any meaning-carrying text; **3:1** for large text and non-text UI (borders, icons, control affordances); **AAA where it comes for free** (`--text-primary` = `--gray-12` already clears AAA vs `--surface`). | The text-hierarchy ladder role tokens in [`tokens.css`](apps/web/src/styles/tokens.css) role block: `--text-primary` (`--gray-12`), `--text-secondary` (`mix(11,12)`), `--text-muted` (`--gray-11`, AA-safe floor for meaning), `--text-faint` (`--gray-10`, 3:1 only, decorative). | Law already holds for the ladder; the concrete WCAG-defect fixes (faint-for-meaning promotions, CTA-on-tomato) land in [#2166](https://github.com/kamp-us/phoenix/issues/2166). |
| 8 | **Density** | Expose **all three ramps — compact · normal · spacious**. | The `[data-density="compact"\|normal\|spacious"]` ramp infra in [`tokens.css`](apps/web/src/styles/tokens.css). | Infra exists; the user-facing density control is wired by [#2183](https://github.com/kamp-us/phoenix/issues/2183). |

---

## Semantic token annotations — reach for the role layer only

Components consume **role tokens only**. This is stated law in
[`tokens.css`](apps/web/src/styles/tokens.css) itself (the role-layer rule, "These are the ONLY
tokens components should reference") and is promoted to a pillar non-negotiable by 0162 (Pillar 2).
**Never** reference a raw scale (`--mauve-*`, `--tomato-*`, …) or a semantic scale (`--gray-N`,
`--accent-N`) from a component — reach for the role alias below.

### Surface roles

| Role token | Resolves to | Reach for it when |
|---|---|---|
| `--surface` | `--gray-2` | The default page / card surface. |
| `--surface-sunken` | `--gray-1` | A recessed well (inset panel, code block). |
| `--surface-raised` | `--gray-3` | A surface lifted above the page (raised card, popover body). |

### Border roles

| Role token | Resolves to | Reach for it when |
|---|---|---|
| `--border-faint` | `--gray-5` | The lightest hairline separator. |
| `--border` | `--gray-6` | The default control / card border. |
| `--border-strong` | `--gray-7` | An emphasized divider / focused-field border. |

### Text roles (the meaning-carrying ladder — contrast floor is load-bearing)

| Role token | Resolves to | Contrast floor | Reach for it when |
|---|---|---|---|
| `--text-primary` | `--gray-12` | AAA (free) | Primary body / headings — the strongest text. |
| `--text-secondary` | `color-mix(--gray-11, --gray-12)` | AA (≥4.5:1) | Secondary body text. |
| `--text-muted` | `--gray-11` | **AA (≥4.5:1) — the floor for meaning** | The *lowest* rung any meaning-carrying text may use. |
| `--text-faint` | `--gray-10` | **3:1 only — decorative ONLY** | Placeholders, disabled, hints — **never** meaning-carrying text (fails 4.5:1). |

### Accent / link roles

| Role token | Resolves to | Reach for it when |
|---|---|---|
| `--accent` | `--accent-9` | The primary accent fill (solid accent surfaces, the focus ring color). |
| `--accent-soft` | `--accent-5` | A soft accent background (hover wash, subtle highlight). |
| `--accent-faint` | `--accent-3` | The faintest accent tint. |
| `--link` | `--accent-11` | Link text (the AA-safe accent step). |
| `--accent-fg` | `--accent-contrast` | Foreground text/icon on a solid `--accent` fill. |

### Focus role (lives in `global.css`, not `tokens.css`)

| Role token | Definition | Where |
|---|---|---|
| `--focus-ring` | `2px solid var(--accent-9)` (law: + 2px spacer gap per 0162) | [`apps/web/src/styles/global.css`](apps/web/src/styles/global.css) |
| `--focus-ring-offset` | `2px` | [`apps/web/src/styles/global.css`](apps/web/src/styles/global.css) |

The single `:focus-visible` rule in `global.css` paints the ring once for all interactive
controls (`outline: var(--focus-ring); outline-offset: var(--focus-ring-offset)`). **Never**
hand-roll a per-component `outline` — reach for `--focus-ring` (Pillar 4).

### Type roles

| Role token | Value | Reach for it when |
|---|---|---|
| `--t-body` | `14px/1.5` (law body base — [#2164](https://github.com/kamp-us/phoenix/issues/2164)) | Default body copy. |
| `--t-body-sm` | `13px/1.45` | Small body copy. |
| `--t-meta` | `12px/1.4` | Meta rows (timestamps, counts, bylines). |
| `--t-micro` | `11px/1.4` | The smallest micro-copy. |
| `--t-h-feed` | `16px/1.35` | Feed-item headings. |
| `--t-h-page` | `22px/1.25` | Page titles. |
| `--t-mono` | `13px/1.5` (mono) | Code / monospace. |

---

## Component-selection rules — reach for the composite primitive, never hand-build

Per Pillar 2 (cohesiveness). Composite primitives are the **only** sanctioned way to build these
shells. The primitives are extracted by [#2163](https://github.com/kamp-us/phoenix/issues/2163);
until they land, the rule still governs (do not seed a fresh hand-built instance).

| To build a… | Reach for | Never |
|---|---|---|
| Card / surface shell | `Card` / `Surface` composite primitive | Hand-assemble a `<div>` with border/radius/shadow. |
| Meta row (timestamp · byline · counts) | `MetaRow` composite primitive | Hand-lay a flex row of meta spans. |
| Count pill / count toggle | `CountToggle` composite primitive | Hand-build a count badge / toggle. |
| A button (incl. `pressed` / `icon` / `loading`) | The widened `Button` primitive | Hand-roll a button wrapper around the primitive. |
| Empty / short / sparse state | The reusable empty-state primitive ([#2162](https://github.com/kamp-us/phoenix/issues/2162)) | Ship a bare `0 yorum`-style label as the whole treatment. |
| A reaction affordance | The on-brand controlled reaction asset ([#2165](https://github.com/kamp-us/phoenix/issues/2165)) | Ship a raw system-emoji glyph (OS-drift). |
| A functional icon (vote / nav / toolbar / inline) | A drawn **Lucide** icon at the ruled size + role token (the [icon idiom](#the-canonical-icon-idiom) below) | Ship a Unicode functional glyph (`△` `↑` `→` `⌘` `↵`) or a hand-inlined SVG as an icon. |

**One system throughout:** one type ramp, one four-level elevation system, one icon idiom — never
a second type/elevation system or a fourth icon idiom. The icon idiom's **positive** definition —
the set, stroke, sizes, color, vote glyph, and function/affect/key-legend partition — is
[encoded below](#the-canonical-icon-idiom) (ADR [0166](https://github.com/kamp-us/phoenix/blob/main/.decisions/0166-canonical-icon-idiom.md)).

---

## Design-sync authority — the behavioral spine is code-authoritative

A design round-trip (Claude Design / `/design-sync`) is **one-directional per layer**, never a
whole-file overwrite: **tokens/style → the visual tool is source** (it owns the paint — role-token
values, CSS declarations); **component logic + a11y → the repo primitive is source** (focus rings,
aria roles/labels/state, keyboard order/operability, `prefers-reduced-motion` respect). A visual
reskin consumes the behavioral spine **read-only**; it never re-authors it. This is the direct
consequence of Pillar 4 (accessibility is a property of the shared primitives, not per-component
paint) — a synced reskin that drops a control's focus ring, `aria-pressed`, keyboard order, or
reduced-motion handling is a regression no matter how good the new look is.

The full contract, the per-layer authority table, and its enforcement live in
[`.patterns/design-sync-authority.md`](.patterns/design-sync-authority.md); it is locked by the
property-based a11y loop (generic, every `ui/` primitive) and the entry-row spine tripwire
([`apps/web/src/components/entry-row-spine.test.tsx`](apps/web/src/components/entry-row-spine.test.tsx)).

---

## The canonical icon idiom

Per Pillar 2 (cohesiveness) and ADR
[0166](https://github.com/kamp-us/phoenix/blob/main/.decisions/0166-canonical-icon-idiom.md). This
leg is **encoded** (it was previously deferred — the manifest and 0162 stated only the "one icon
idiom / never a fourth" prohibition; 0166 records the positive ruling transcribed here). The
migration of the live glyph surfaces to this idiom is a **separate downstream chore** under epic
[#2168](https://github.com/kamp-us/phoenix/issues/2168), not yet performed.

- **Set — Lucide.** The canonical set is **[Lucide](https://lucide.dev)**: 24×24 grid, a single 2px
  stroke, round caps/joins, `fill: none`. MIT, tree-shakeable, added via `catalog:`. Icons are drawn
  Lucide glyphs — **never** a hand-inlined SVG, and **never** a Unicode functional glyph
  (`△` `↑` `→` `⌘` `↵`) as an icon (those drift per-OS font fallback, the same reason raw emoji are
  outlawed as reaction affordances).
- **Stroke — native optical per-size.** Icons use Lucide's **native per-size** stroke scaling — the
  stroke thickens/thins with the glyph at each size. **Never** pin a constant `absoluteStrokeWidth`
  across sizes.
- **Sizes — 16 / 20 / 24 on the 4px grid** (floor 16; below 16 muddies on dark). **16 (sm)** = dense
  rows · inline · vote; **20 (md)** = standalone · nav · toolbar; **24 (lg)** = emphasis ·
  empty-state (sparing). The **tap target is decoupled**: the glyph is centered in a **≥36px hit
  area** (padding fills), honoring the 36px minimum **without inflating the glyph**.
- **Color — monochrome, `stroke: currentColor`, role tokens only.** Default `--text-secondary`,
  hover `--text-primary`, active/on `--accent`, disabled `--text-muted`. The **one filled
  exception** is the active vote glyph (`--accent` fill). **No icon hardcodes a color.**
- **Vote glyph — a drawn triangle** (not a chevron — the HN / lobste.rs vote lineage): filled-accent
  (`--accent`) when active, outline-secondary (`--text-secondary`) when inactive, up/down symmetry,
  36px hit area. This is the one affordance that needs real design; the rest is substitution.
- **The three-way partition (the boundary rule).** **Function** → a drawn Lucide icon (anywhere).
  **Affect** → the curated six-emoji reaction set (monochrome-controlled per ADR
  [0139](https://github.com/kamp-us/phoenix/blob/main/.decisions/0139-reaction-curated-palette.md)),
  **only** in the reaction bar. **Key-legends** → `⌘` `⌥` `⇧` `↵` `⎋` are keycap typography, legal
  **only** inside a `<kbd>` chip — never free-floating, never an icon.

---

## The four pillars — intents & prohibitions

### Pillar 1 — Performance

**Intent.** Paint the shell first; keep the current screen interactive during navigation — the
user never stares at a blank frame waiting on the session.

**Prohibitions.**

- **Never** gate the static shell (first paint) on the session.
- **Never** block first paint on a data read that could be deferred.
- **Never** ship a skeleton that under-reserves the real payload height (it causes a layout
  shift when content lands).

### Pillar 2 — Cohesiveness

**Intent.** One coherent system: reach for the shared primitive, never re-assemble a
card / meta-row / count-pill by hand.

**Prohibitions.**

- **Never** hand-build a card / meta-row / count-pill instead of reaching for the primitive.
- **Never** hand-roll a button wrapper around the primitive.
- **Never** ship raw system-emoji glyphs as reaction affordances.
- **Never** introduce a fourth icon idiom or a second type/elevation system.
- **Never** ship a Unicode functional glyph (`△` `↑` `→` `⌘` `↵`) or a hand-inlined SVG as an
  icon — functional icons are drawn Lucide (the [icon idiom](#the-canonical-icon-idiom)).
- **Never** hardcode an icon's color — icons are `stroke: currentColor` driven by role tokens
  only (the active vote glyph's `--accent` fill is the one exception).
- **Never** place a keycap glyph (`⌘` `⌥` `⇧` `↵` `⎋`) free-floating as an icon — it is legal only
  inside a `<kbd>` chip.
- **Never** reference a raw scale (`--mauve-*`) or semantic scale (`--gray-N` / `--accent-N`)
  token from a component — role tokens only.

### Pillar 3 — Usability

**Intent.** A sparse page reads as intentionally composed, never as a broken void.

**Prohibitions.**

- **Never** leave a void state — a surface with no content and no designed empty treatment.
- **Never** ship a bare `0 yorum`-style label as the entire empty-state treatment.
- **Never** render a void with its content jammed at the top.

### Pillar 4 — Accessibility

**Intent.** Every control is perceivable and operable by keyboard and low-vision users, from one
systematic layer — a11y is a property of the shared primitives, not a per-component afterthought.

**Prohibitions.**

- **Never** carry meaning on `--text-faint` (or any token below the 4.5:1 floor).
- **Never** ship an interactive control with no focus ring, and **never** hand-roll a
  per-component `outline` in place of the shared spacer ring (`--focus-ring`).
- **Never** fall below the 36px tap-target minimum hit area.
- **Never** signal state or meaning by color alone.

---

## Navigation IA — the element taxonomy + placement law

Per ADR
[0176](https://github.com/kamp-us/phoenix/blob/main/.decisions/0176-nav-ia-discipline.md)
(founder-ratified on wayfinder map
[#2583](https://github.com/kamp-us/phoenix/issues/2583)). This section governs the
**navigation surface** — the topbar and the per-product Subnavs — so a nav affordance cannot
be bolted on without a placement law ("drift unrepresentable"). `write-code` reads it before
generating or editing any nav UI, the same way it reads the four pillars.

**The topbar job statement** (the criterion any element argues against): *the topbar answers
three questions, always — where can I go (destinations), who am I here (identity + account),
what needs my attention (signals) — plus at most ONE promoted action. Anything else must argue
its way in.*

### The element taxonomy (closed list — assign a class before you place)

Every nav element is exactly one of these four classes. It is a **closed list**: never add a
nav element without first assigning its class.

| Class | What it is | Examples |
|---|---|---|
| **destination** | A place you go — a product noun or top-level feed. | sözlük, pano, mecmua |
| **primary action** | The one verb the surface promotes (exactly one per surface). | the global `+` create menu |
| **utility** | An ambient control reached for on demand. | search (`⌘K`), theme (profile page) |
| **signal** | Read-only state reporting "what needs your attention". | bildirim (bell + count), divan, karma |

### The placement law — zone grammar (each class lives in one tier)

Placement is two-tier plus the account menu. An element may only sit in a zone whose grammar
admits its class.

| Zone | Admits | Never admits |
|---|---|---|
| **Topbar** (global) | destinations · signals · identity/account · the one primary action | a product-scoped action · a sub-destination · a page-scoped filter |
| **Subnav** (per-product) | product sub-destinations · product filters · the contextual (product-scoped) create CTA | a global destination · the global primary action |
| **User menu** | account-scoped utilities + account items | a destination · a signal · the primary action |

The topbar destinations row is **purely sözlük / pano / mecmua**. A product-scoped create verb
lives as a contextual CTA in *that product's* Subnav — never as a global topbar button.

### The class table — every current nav element → class → sanctioned zone

| Element | Class | Sanctioned zone |
|---|---|---|
| sözlük · pano · mecmua | destination | Topbar (destinations row) |
| the global `+` create menu | primary action | Topbar (the one promoted action) |
| a product-scoped create CTA (e.g. pano "new post") | primary action (contextual) | that product's Subnav |
| search (`⌘K`) | utility | Topbar |
| theme (light/dark/auto) | utility | Profile page only (no topbar toggle) |
| bildirim (bell + count → dropdown) | signal | Topbar (signals zone) |
| divan (gated glyph + tooltip) | signal | Topbar (signals zone) |
| karma | signal | Folded into the user-menu trigger as `name (karma)` |
| `akış` / `yazılarım` | destination (sub) | mecmua's Subnav |

### Prohibitions (machine-checkable)

- **Never** place a non-destination in the topbar destinations row (the destinations row is
  purely product nouns — sözlük / pano / mecmua).
- **Never** style a utility with the primary-action treatment — the primary action is
  distinguished by **container scarcity**: the `+` create menu is the **only** accent-filled
  element (`--accent` / `--accent-fg`) in the topbar. A second accent fill on the bar is a
  utility masquerading as the CTA.
- **Never** add a nav element without assigning its class (the taxonomy is a closed list).
- **Never** place an element in a zone whose grammar does not admit its class (a product-scoped
  action or a sub-destination in the topbar; a global destination or the global primary action
  in a Subnav).
- **Never** render a nav element as a **detached sibling of the bar** — a single orphan slot or
  a detached filter-row floating *next to* the topbar / Subnav instead of *inside* a zone the
  grammar admits. Every nav element lives inside a declared zone; an element rendered adjacent to
  the bar with no structural home is the amateur-composition smell (the sözlük-alphabet-as-detached-sibling
  shape, ADR [0182](https://github.com/kamp-us/phoenix/blob/main/.decisions/0182-subnavshell-pageshell-composition-api.md)).
  This holds **even where a product has not yet adopted the shell** — the zone grammar governs the
  render, not shell adoption, so the review-design gate flags the detached slot regardless.
- **Never** promote more than one primary action per surface.

### Where the IA law is silent, surface the gap — do not fill it

This section transcribes only what ADR 0176 (via map #2583) ratified. A nav decision not
covered by the taxonomy, the zone grammar, the class table, or a prohibition above is a **gap
to surface to the founder** (file it via the [report](.claude/skills/report/SKILL.md) skill) —
never a blank for an agent to fill with invented IA law. The IA section grows only when the
founder ratifies more law into ADR 0176 (or a successor).

---

## Where the ADR is silent, surface the gap — do not fill it

This manifest transcribes only what ADR 0162 ratified. If a UI decision is not covered by a
pillar, a value, a token annotation, or a prohibition above, that is a **gap to surface to the
founder** (file it via the [report](.claude/skills/report/SKILL.md) skill), not a blank for an
agent to fill with invented design law. The manifest grows only when the founder ratifies more
law into ADR 0162 (or a successor).
