---
id: 0162
title: "The four pillars — performance · cohesiveness · usability · accessibility as non-negotiable frontend design law, with the founder-ratified v1 values"
status: proposed
date: 2026-07-05
tags: [design, frontend, pipeline, accessibility, tokens, control-plane]
---

## Context

The frontend audit wave (epic [#2168](https://github.com/kamp-us/phoenix/issues/2168)) fixed a
snapshot of design and accessibility defects — but a snapshot decays. Nothing in the pipeline made
polish and a11y *standing law*, so every UI change re-derived design taste from scratch and the same
misses recurred: a hand-built card that skips the shared primitive, a meaning-carrying label dropped
onto a decorative faint token, a control shipped with no focus ring, a void empty state. A fix wave
without a ratified law is a treadmill.

This ADR is the **ratify-root** of that wave. It promotes the four design pillars —
**performance · cohesiveness · usability · accessibility** — to non-negotiable law that every UI
change is built and reviewed against, and it binds the founder-ratified **v1 design values** (the
grid, type, spacing, elevation, focus, contrast, tap-target, and density numbers) to the pillars
they serve. Design principles are the founder's domain by mandate: ADR
[0078](0078-product-driven-decisions-by-default.md) makes product/design decisions product-driven
and founder-authored by default (engineering leads only on platform/infra). An agent transcribes
these values; it does not invent them.

The values below are real numbers grounded in the live token layer — `apps/web/src/styles/tokens.css`
(the three-layer role system plus the compact/normal/spacious density ramps) and
`apps/web/src/styles/global.css` (where the focus-ring token pair lives). This ADR is `status:
proposed`: the founder does the final prose-and-values read at the reviewed-ready gate before it is
accepted.

## Decision

The pipeline adopts **four non-negotiable design pillars**. Every UI change is built and reviewed
against all four. Each pillar below carries a normative **intent**, its concrete **non-negotiables**
(including the v1 values it owns), the **audit findings** it governs, and its **prohibitions**
(the "never" rules a reviewer and a linter can check against).

### The v1 design values (founder-ratified, cross-cutting)

These values are law once this ADR is accepted; each is claimed by the pillar it serves, but they
are stated once here because several span pillars.

- **Grid.** A **4px base grid**, with sanctioned **1px and 2px exceptions** for hairline borders and
  optical nudges. Everything laid out lands on the 4px lattice unless it is a sanctioned exception.
- **Body text.** **14px** is the ratified body size. (The live `--t-body` is `13px`; the type
  recalibration in [#2164](https://github.com/kamp-us/phoenix/issues/2164) moves it to 14px.)
- **Spacing.** A **4px-based ramp**, hand-tuned but on-grid (the Primer/Polaris shape — a perceptual
  ladder, not a rigid ×N multiplier), and **all three density ramps re-derive to clean 4px
  multiples**. The live `--s-1..--s-8` ramps are re-derived to that discipline across
  compact/normal/spacious.
- **Tap target.** A **36px minimum hit area** for every interactive control (the hit area, not
  necessarily the visible glyph).
- **Elevation.** **Four levels — flat/resting · raised · dropdown · overlay** — plus a **dark-mode
  surface-tint bump**: shadows read poorly on dark surfaces, so each level *lightens the surface*
  rather than relying on shadow alone. (Today only `--shadow-sm`/`--shadow-md` exist; the elevation
  recalibration in [#2164](https://github.com/kamp-us/phoenix/issues/2164) builds the four-level ramp
  and the dark-mode tint.)
- **Focus — the spacer ring.** A **2px ring plus a 2px gap** (a ring separated from the control by a
  transparent spacer). The gap guarantees the ring clears **3:1 contrast even on same-family dark
  surfaces**, where a flush ring can blend into its neighbor. This **supersedes** the earlier
  "ratify the existing ring as-is" suggestion. It **builds on the existing `--focus-ring`** token
  (`apps/web/src/styles/global.css`) — the token's *definition* gains the gap, so the ~13 correct
  consumers keep consuming `--focus-ring` unchanged and are not churned.
- **Contrast floors.** **AA 4.5:1** for body and any meaning-carrying text; **3:1** for large text
  and non-text UI (borders, icons, control affordances); **AAA where it comes for free** (the
  `--text-primary` = `--gray-12` role already clears AAA against `--surface`).
- **Density.** Expose **all three ramps — compact · normal · spacious** (the existing `tokens.css`
  `[data-density]` infra; [#2183](https://github.com/kamp-us/phoenix/issues/2183) wires the user
  control). The founder may later collapse this to a binary; v1 ships the triad.

---

### Pillar 1 — Performance

**Intent.** Paint the shell first and keep the current screen interactive during navigation — the
user never stares at a blank frame waiting on the session.

**Non-negotiables.**

- The static shell paints without waiting on the session — first paint is never gated on an
  auth/session read (preserve the remount guard from #438).
- Navigation uses the fate / React 19 async primitives (`startTransition` / deferred reads) so the
  current screen stays interactive while the next loads.
- Loading skeletons reserve the **real** height of the payload they stand in for — a skeleton that
  under-reserves height causes a layout shift when the content lands, so skeletons are height-matched
  and the perceived layout-shift budget stays near zero.

**Audit findings governed by this pillar:**

| Issue | What it fixes |
|---|---|
| [#2160](https://github.com/kamp-us/phoenix/issues/2160) | Kill the blank first-paint flash — ungate the static shell from the session (preserving the #438 remount guard). |
| [#2161](https://github.com/kamp-us/phoenix/issues/2161) | Adopt the fate / React 19 async primitives (`startTransition` / deferred reads) + height-matched skeletons; add the async-React pattern doc. |

**Prohibitions.**

- **Never** gate the static shell (first paint) on the session.
- **Never** block first paint on a data read that could be deferred.
- **Never** ship a skeleton that under-reserves the real payload height.

---

### Pillar 2 — Cohesiveness

**Intent.** One coherent system: reach for the shared primitive, never re-assemble a
card / meta-row / count-pill by hand.

**Non-negotiables.**

- Composite primitives are the **only** sanctioned way to build a card shell, a meta row, or a
  count pill (see the component-selection rules below).
- **One type ramp and one elevation system** — the recalibrated type scale (14px body per the v1
  values) and the four-level elevation ramp with the dark-mode surface-tint bump.
- **One icon idiom** — no fourth icon system is introduced.
- On-brand **monochrome, controlled** reaction assets — not raw system-emoji glyphs, whose rendering
  drifts per OS.
- Components consume **role tokens only** (`--surface`, `--text-*`, `--border*`, `--accent*`) — never
  a raw scale (`--mauve-*`) or a semantic scale (`--gray-*` / `--accent-N`). This is stated law in
  `tokens.css` itself (the role-layer rule), promoted here to a pillar non-negotiable.

**Audit findings governed by this pillar:**

| Issue | What it fixes |
|---|---|
| [#2163](https://github.com/kamp-us/phoenix/issues/2163) | Extract the composite primitives (Card/Surface, MetaRow, CountToggle) + widen Button (`pressed` / `icon` / `loading`); migrate the call sites. |
| [#2164](https://github.com/kamp-us/phoenix/issues/2164) | Recalibrate the type scale to the 14px body ramp + define the four-level elevation system (token-value change on `--t-*` / the shadow + surface-tint tokens). |
| [#2165](https://github.com/kamp-us/phoenix/issues/2165) | Render the curated ADR-0139 reaction set as on-brand controlled assets (monochrome, OS-stable). |

**Prohibitions.**

- **Never** hand-build a card / meta-row / count-pill instead of reaching for the primitive.
- **Never** hand-roll a button wrapper around the primitive.
- **Never** ship raw system-emoji glyphs as reaction affordances.
- **Never** introduce a fourth icon idiom or a second type/elevation system.
- **Never** reference a raw or semantic scale token from a component.

---

### Pillar 3 — Usability

**Intent.** A sparse page reads as intentionally composed, never as a broken void.

**Non-negotiables.**

- Every list and detail surface has a **designed empty / short / sparse state** — served by a
  reusable empty-state primitive, not an ad-hoc bare label.
- The short-content layout answer is deliberate (centering / fill / height-cap) so a nearly-empty
  page is not content jammed at the top of a void.
- The A–Z index visually **distinguishes populated vs empty letters** — an empty letter is a real,
  legible state, not an undifferentiated dead link.

**Audit findings governed by this pillar:**

| Issue | What it fixes |
|---|---|
| [#2162](https://github.com/kamp-us/phoenix/issues/2162) | Intentional empty / short / sparse page states + a reusable empty-state primitive (including the A–Z index "no state" finding). |

**Prohibitions.**

- **Never** leave a void state — a surface with no content and no designed empty treatment.
- **Never** ship a bare `0 yorum`-style label as the entire empty-state treatment.
- **Never** render a void with its content jammed at the top.

---

### Pillar 4 — Accessibility

**Intent.** Every control is perceivable and operable by keyboard and low-vision users, from one
systematic layer — a11y is a property of the shared primitives, not a per-component afterthought.

**Non-negotiables.**

- The **contrast floors** hold: **AA 4.5:1** for body/meaning-carrying text, **3:1** for large text
  and non-text UI, **AAA where free**. Meaning-carrying text bottoms out at `--text-muted`
  (`--gray-11`, AA-safe); `--text-faint` (`--gray-10`, clears 3:1 but not 4.5:1) is decorative-only.
- **One shared focus layer** — the single `:focus-visible` treatment painting the **spacer ring**
  (2px ring + 2px gap) from the `--focus-ring` token pair, everywhere. No component hand-rolls its
  own outline.
- The **36px minimum tap-target** hit area on every interactive control.
- Correct ARIA on interactive controls (reactions, the A–Z index, toggles), and **never signal by
  color alone**.

**Audit findings governed by this pillar:**

| Issue | What it fixes |
|---|---|
| [#2166](https://github.com/kamp-us/phoenix/issues/2166) | Concrete WCAG defect fixes: promote `--text-faint` → `--text-muted` where meaning-carrying; the CTA-on-tomato contrast; the tap-target minimum; and the ReactionBar focus-ring double-wrap misuse (use `outline: var(--focus-ring)` per the global.css convention — the token already exists, this is a misuse fix). |
| [#2169](https://github.com/kamp-us/phoenix/issues/2169) | The systematic focus layer (one shared `:focus-visible` spacer-ring treatment) + the ARIA audit on reactions / A–Z index. |

**Prohibitions.**

- **Never** carry meaning on `--text-faint` (or any token below the 4.5:1 floor).
- **Never** ship an interactive control with no focus ring, and **never** hand-roll a per-component
  `outline` in place of the shared spacer ring.
- **Never** fall below the 36px tap-target minimum.
- **Never** signal state or meaning by color alone.

## Consequences

- **The DS manifest ([#2173](https://github.com/kamp-us/phoenix/issues/2173))** encodes these
  pillars and values as the agent-readable "CLAUDE.md for design" that `write-code` reads *before*
  it generates any UI — the machine-consumable transcription of this ADR.
- **The review-design gate ([#1966](https://github.com/kamp-us/phoenix/issues/1966))** checks every
  UI PR against these four pillars and their prohibitions, the way review-code checks acceptance
  criteria.
- **The design lint ([#2170](https://github.com/kamp-us/phoenix/issues/2170))** and the
  **property-based a11y loop ([#2175](https://github.com/kamp-us/phoenix/issues/2175))** turn the
  machine-checkable prohibitions (raw-token references, faint-for-meaning, missing focus ring,
  sub-floor contrast, sub-36px targets) into enforced gates so recurring misses cannot re-land.
- **The token recalibrations ([#2164](https://github.com/kamp-us/phoenix/issues/2164) and
  [#2163](https://github.com/kamp-us/phoenix/issues/2163))** re-derive the live token layer to these
  values: the 14px body ramp, the on-grid spacing across all three density ramps, the four-level
  elevation system with the dark-mode surface-tint bump, and the spacer-ring extension of
  `--focus-ring`.
- Because it ratifies design law that governs the pipeline's UI-generation and review surfaces, this
  ADR is **founder-ratified** (the prose-and-values read at the reviewed-ready gate) before it moves
  from `proposed` to `accepted`.

## Relationship to prior decisions

- **ADR [0078](0078-product-driven-decisions-by-default.md)** — product-driven decisions by default;
  the design-principle domain is the founder's. This ADR is authored under that mandate and carries
  founder-ratified values, not agent-invented ones.
- **ADR [0083](0083-agents-deploy-humans-release.md)** — containment / the agents-deploy ·
  humans-release boundary; this ADR's ratification (the founder prose-and-values read at the gate,
  and the cansirin human-merge of its PR) is the human-judgment half of that same discipline.
- **ADR [0147](0147-shared-moderation-admin-component-layer.md)** — the shared component layer; the
  cohesiveness pillar's composite-primitive extraction (#2163) seeds its shape from that layer.
- **Focus token — an extension, not a replacement.** The spacer ring **extends** the existing
  `--focus-ring` / `--focus-ring-offset` pair in `apps/web/src/styles/global.css`; the ~13 correct
  consumers keep consuming `--focus-ring` unchanged. The token's definition gains the 2px gap; the
  consumers do not churn.
- **Epic [#2168](https://github.com/kamp-us/phoenix/issues/2168)** — the frontend audit wave that
  made these pillars standing law; this ADR is its ratify-root.
