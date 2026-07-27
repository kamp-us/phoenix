---
name: taste-color
description: "Creation-shaped colour and theming guidance for phoenix UI, grounded in the design law's semantic role-token layer — which role token to reach for per surface/border/text/accent/focus decision, the meaning-carrying text ladder and its contrast floor, and the Pillar 2/4 prohibitions (never a raw or semantic scale, never colour-alone meaning). Trigger on \"what colour should this be\", \"which token for this surface\", \"pick the text colour\", \"theme this component\", \"is this contrast okay\", or whenever a diff assigns a colour, a background, a border, a hover wash, or a focus indicator. Advice only: it is NOT the review-design gate, posts no review-* verdict marker, and never merges. For motion craft use taste-animation-review."
---

# taste-color

Choose colour by role, before you write the declaration. This skill does one thing: decide which
role token a surface, border, text run, accent, or focus indicator gets, and refuse the decisions
the design law does not authorise. It does not review non-colour code — for a general review point
at `review-code`; for motion at [`taste-animation-review`](../taste-animation-review/SKILL.md).

**Advice, not a gate.** This is a taste skill (ADR
[0209](https://github.com/kamp-us/phoenix/blob/main/.decisions/0209-taste-voice-per-aspect-skills.md)):
its output informs the author before the gate sees the PR. It never posts a
`review-(code|doc|skill|design)` marker, never stands in for the `review-design` gate, and never
merges.

## Grounding and firewall

Grounded exclusively in three artifacts, and there is no fourth:

- [`design-system-manifest.md`](https://github.com/kamp-us/phoenix/blob/main/design-system-manifest.md) — the four pillars, the prohibitions, the role tokens (ADR [0162](https://github.com/kamp-us/phoenix/blob/main/.decisions/0162-four-pillars-design-law.md)).
- [`design-system-inventory.md`](https://github.com/kamp-us/phoenix/blob/main/design-system-inventory.md) — which primitives exist and when to use them (ADR [0194](https://github.com/kamp-us/phoenix/blob/main/.decisions/0194-design-law-jsdoc-firewall.md)).
- The blessed goldens — the visual reference a surface is measured against (ADR [0183](https://github.com/kamp-us/phoenix/blob/main/.decisions/0183-golden-screen-storage-depo-git-pointer.md)).

**This skill advises creation; it never authors law** (the ADR 0194 firewall). Rules tagged **LAW**
are transcribed from a named section of the design law and are binding — never softened, never
re-worded into a new threshold, never extended by inference. Rules tagged **CRAFT** are advisory
defaults for questions the law does not answer; they yield to LAW on every conflict and are never
written as prohibitions. A rule that is a craft default in service of a law carries the compound
tag **(CRAFT, serving LAW — `<section>`)**. Colour is the aspect where this matters most, because
the design law is unusually complete here: almost everything below is LAW, and inventing a
thirteenth "obvious" colour rule is exactly what the firewall forbids. Never edit
`design-system-manifest.md` or `design-system-inventory.md`.

The library-wide conventions live in
[`taste-library-conventions.md`](../taste-library-conventions.md).

**No `STANDARDS.md` for this aspect, deliberately.** Every concrete colour figure — each role
token, what it resolves to, and each contrast floor — is already a row in the manifest's own
tables. Copying those rows into a library values file would create a second copy of a founder-owned
value, and a duplicated value is a value that drifts. Cite the manifest section by name and read
the row there.

## Operating posture

You are a design engineer working inside a settled colour system, not choosing a palette. The bias
is toward the role that already exists: if you are reaching past the role layer, the answer is
almost always that you picked the wrong role, not that the system is missing one. When the role
layer genuinely has no answer, that is a gap to surface — never a value to invent.

## The role decision table — reach for the role layer only

The whole colour vocabulary available to a component. Read the row, take the token, stop. Every
row is transcribed from the manifest's **Semantic token annotations — reach for the role layer
only** section (its `Surface roles`, `Border roles`, `Text roles`, `Accent / link roles`, and
`Focus role` tables); the section is LAW, so the table is not a menu of suggestions.

| What you are colouring | Reach for | Manifest anchor |
|---|---|---|
| The default page or card surface | `--surface` | Surface roles |
| A recessed well (inset panel, code block) | `--surface-sunken` | Surface roles |
| A surface lifted above the page (raised card, popover body) | `--surface-raised` | Surface roles |
| The lightest hairline separator | `--border-faint` | Border roles |
| The default control or card border | `--border` | Border roles |
| An emphasised divider, or a focused field's border | `--border-strong` | Border roles |
| Primary body copy or a heading | `--text-primary` | Text roles |
| Secondary body text | `--text-secondary` | Text roles |
| Meaning-carrying text at its lowest rung (meta rows, timestamps, counts, bylines) | `--text-muted` | Text roles |
| Text that carries **no** meaning (placeholder, disabled, hint) | `--text-faint` | Text roles |
| A solid accent fill (the promoted action, the focus-ring colour) | `--accent` | Accent / link roles |
| A hover wash or subtle highlight | `--accent-soft` | Accent / link roles |
| The faintest accent tint | `--accent-faint` | Accent / link roles |
| Link text | `--link` | Accent / link roles |
| Text or an icon sitting on a solid `--accent` fill | `--accent-fg` | Accent / link roles |
| A focus indicator on any interactive control | `--focus-ring` + `--focus-ring-offset`, painted by the single `:focus-visible` rule in `global.css` | Focus role |
| A status or category colour (success, warning, danger, per-kind chips) | **Nothing — the law is silent.** See [Where the law is silent](#where-the-law-is-silent-surface-the-gap--never-fill-it) | — (no annotated role) |

The last row is what makes this table fail-closed rather than a lookup that quietly runs out: the
manifest annotates six role families and no seventh, so a colour question outside them has no
answer here by construction.

## The twelve rules

1. **Reach for a role token; never reference a raw or semantic scale from a component.** (LAW —
   Pillar 2, "Never reference a raw scale (`--mauve-*`) or semantic scale (`--gray-N` /
   `--accent-N`) token from a component") The role alias is the only layer the manifest annotates,
   so a scale reference bypasses every annotation — including the one carrying the contrast floor.
   *Counterexample: `color: var(--gray-11)` on a meta row where `--text-muted` is the annotated role.*
2. **Never carry meaning on `--text-faint`.** (LAW — Pillar 4, "Never carry meaning on
   `--text-faint` (or any token below the 4.5:1 floor)"; the ladder's rungs are the manifest's
   `Text roles` table) `--text-muted` is the lowest rung meaning-carrying text may use; `--text-faint`
   clears 3:1 only and is decorative.
   *Counterexample: a `MetaRow` timestamp dropped to `--text-faint` so the row "reads calmer".*
3. **Never drop meaning-carrying text or a border below its contrast floor by mixing, fading, or
   filtering a role token.** (LAW — v1 design value 7, Contrast floors: AA 4.5:1 for any
   meaning-carrying text, 3:1 for large text and non-text UI) A token's annotated floor is a
   property of that exact token; a hand-mix or an `opacity` fade carries none of it forward, so the
   derived value stands or falls on its own measured ratio.
   *Counterexample: `color: color-mix(in oklab, var(--text-muted), transparent 30%)` on a byline, landing under 4.5:1 instead of stepping the ladder.*
4. **Never signal state or meaning by colour alone.** (LAW — Pillar 4, "Never signal state or
   meaning by color alone") Colour is the one channel a colour-blind user, a high-contrast mode, or
   a monochrome render does not deliver.
   *Counterexample: an upvoted arrow that differs from the un-voted one only by its `--accent` fill.*
5. **Give every colour-carried signal a second channel — a text label, a drawn icon, or a shape
   change.** (CRAFT, serving LAW — Pillar 4) Rule 4 states what is forbidden; a second channel is
   the cheapest thing that discharges it, and picking one at authoring time is easier than
   retrofitting it after a review.
   *Counterexample: a selected filter chip that adds `--accent-soft` and nothing else — no checkmark, no pressed state, no label change.*
6. **Paint focus with `--focus-ring` and `--focus-ring-offset`; never hand-roll a per-component
   `outline`.** (LAW — Pillar 4, "never hand-roll a per-component `outline` in place of the shared
   spacer ring"; the `Focus role` table) The single `:focus-visible` rule in
   [`apps/web/src/styles/global.css`](https://github.com/kamp-us/phoenix/blob/main/apps/web/src/styles/global.css)
   paints the ring once for every control, so a local outline is a second focus system that drifts
   from the ratified one.
   *Counterexample: `&:focus { outline: 2px solid var(--accent-9); }` on a hand-rolled button.*
7. **Put `--accent-fg` on any solid `--accent` fill.** (LAW — `Accent / link roles`: `--accent-fg`
   is "Foreground text/icon on a solid `--accent` fill") It is the step the manifest pairs with
   `--accent`; a hardcoded `#fff` is a guess about a value the role layer already resolves.
   *Counterexample: `color: #fff` on a primary CTA sitting on `--accent`.*
8. **Build a hover or highlight wash from the accent rungs.** (LAW — `Accent / link roles`:
   `--accent-soft` is "A soft accent background (hover wash, subtle highlight)", `--accent-faint`
   "The faintest accent tint") The wash rungs exist precisely so a hover state is not a new colour
   decision per component.
   *Counterexample: `background: rgba(255, 0, 0, 0.08)` on a feed-row hover.*
9. **Drive an icon's colour from `currentColor` and a role token.** (LAW — Pillar 2, "Never
   hardcode an icon's color — icons are `stroke: currentColor` driven by role tokens only (the
   active vote glyph's `--accent` fill is the one exception)") An icon that inherits reads correctly
   in every context the surrounding text does.
   *Counterexample: `<VoteIcon stroke="#8b8b8b" />` in a row whose `--text-muted` already cascades.*
10. **Express elevation in dark mode as a surface lift, not a shadow alone.** (LAW — v1 design
    value 5, Elevation: four levels "plus a **dark-mode surface-tint bump** (each level lightens the
    surface, not shadow-only)") A cast shadow is near-invisible on a dark ground, so a shadow-only
    treatment reads flat exactly where the lift is needed.
    *Counterexample: a dropdown that keeps `--surface` and adds only a `box-shadow`.*
11. **Reach for the primitive that already owns the colour decision.** (CRAFT, serving LAW —
    Pillar 2, "Never hand-build a card / meta-row / count-pill instead of reaching for the
    primitive") `Card`/`Surface` for a shell, `MetaRow` for muted metadata, `Tag` for a category
    chip, `FieldError` for validation text — each one's when-to-use is in the inventory under its
    own named section. A hand-styled span re-decides a colour the primitive already settled, which
    is how a second colour system starts.
    *Counterexample: a hand-styled `<span>` for a post-kind chip where the inventory's `Tag` exists.*
12. **Name what a colour does, never the hue — in copy, class names, and props.** (CRAFT) The role
    is the only stable name; a hue name is unverifiable and goes stale the moment the role resolves
    to something else.
    *Counterexample: a `.red-badge` class, or the user-facing copy `kırmızı butona bas`.*

## Escalation triggers — stop on sight

- `--gray-N`, `--accent-N`, or any raw scale token (`--mauve-*`, `--tomato-*`, …) in a component.
- A hex, `rgb()`, `hsl()`, or `oklch()` literal anywhere outside the token layer.
- `color-mix()`, an `opacity` fade, or a `filter` applied to meaning-carrying text or a border.
- `--text-faint` on anything a reader needs in order to understand the surface.
- A state (selected, voted, error, unread) whose only difference is colour.
- `outline` or `box-shadow` used as a focus indicator on a single component.
- A foreground on `--accent` that is not `--accent-fg`.
- A hardcoded `stroke` or `fill` on an icon.
- A dark-mode-only colour override hand-written in a component.
- A colour name in an identifier, a class, or Turkish user-facing copy.

## The pre-ship gate

Walk it in order. Each gate has a stated verdict, so the call is mechanical rather than a taste
guess. Stop at the first gate you fail, fix it, and restart from gate 1.

1. **Is every colour in the diff a role token taken from the decision table?** No → replace it with
   the table's row. If no row fits, go to gate 5. **Stop.**
2. **Does any meaning-carrying text sit on `--text-faint`, or on a mix, fade, or filter you have
   not measured against the 4.5:1 floor?** Yes → step it up to `--text-muted` or higher, unmixed.
   **Stop.**
3. **Does any state or meaning read through colour alone?** Yes → add the second channel (rule 5).
   **Stop.**
4. **Does any control paint its own focus indicator?** Yes → delete it and let the shared
   `:focus-visible` rule paint. **Stop.**
5. **Is the colour you need outside the six annotated role families?** Yes → the law is silent.
   Do not mint a value; surface the gap (below). **Stop.**
6. **All five clear** → the colour layer is law-clean. Rules 11–12 are advice from here, and a
   disagreement with them is a conversation, not a blocker.

## Where the law is silent, surface the gap — never fill it

This is the manifest's own closing clause, inherited: *"If a UI decision is not covered by a
pillar, a value, a token annotation, or a prohibition above, that is a gap to surface to the
founder … not a blank for an agent to fill with invented design law."*

The manifest's role tables annotate exactly six families — surface, border, text, accent/link,
focus, and type. Anything else is silence. The load-bearing instance: **there is no annotated
status or categorical role** (success, warning, danger, per-kind chips), so this skill states no
rule about one and you must not derive one.

When you hit the silence:

- **Never invent a value**, and never promote a craft default into a prohibition to cover the gap.
- **Never add a token, and never edit** `design-system-manifest.md` or `design-system-inventory.md`
  — that is authoring law, which the ADR 0194 firewall reserves to the founder.
- **The pillars still bind through the gap.** An unannotated colour is still forbidden from
  carrying meaning alone (rule 4) and still owes the contrast floors of v1 design value 7. Silence
  about *which* colour is not silence about *how* it may behave.
- **Use what the surface already ships** rather than introducing a new decision, and say plainly in
  the PR that the choice is unlawed.
- **File the gap** via the [`report`](../report/SKILL.md) skill when it is load-bearing, so the
  founder can ratify law into ADR 0162 (or a successor). The manifest grows there, never here.
