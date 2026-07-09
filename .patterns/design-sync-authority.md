# Design-sync authority — one-directional source-of-truth per layer

The contract every Claude Design (`/design-sync`) round-trip runs against: **which
layer owns which fact**, so a visual reskin can rewrite look-and-feel without ever
overwriting the code-authoritative behavioral spine. This is the guardrail the
`/design-sync` enforcement seam and every round-trip must honor; it is grounded in
ADR [0162](../.decisions/0162-four-pillars-design-law.md) (the four-pillars design
law — a11y is a property of the shared primitives, not a per-component afterthought)
and the design/a11y-review lineage of epic
[#2168](https://github.com/kamp-us/phoenix/issues/2168).

## The rule — authority is one-directional, split by layer

A design round-trip is **not** a whole-file overwrite in either direction. Each layer
has exactly one source of truth, and a sync only ever flows *from* that source:

| Layer | Source of truth | A round-trip may… | A round-trip may **never**… |
|---|---|---|---|
| **Tokens / style** — color, spacing, radius, elevation, type scale, the visual surface | the visual tool (Claude Design) | rewrite role-token *values* and CSS declarations (paint) | — |
| **Component logic + a11y** — focus rings, aria roles/labels/state, keyboard order & operability, `prefers-reduced-motion` respect, event wiring | the repo primitive (`apps/web/src/components/**`) | — | drop, weaken, or re-author the behavioral shell |

Read it as two sentences:

- **Tokens/style → the visual tool is source.** A reskin is free to change what a
  control *looks* like — the design tool owns the paint.
- **Component logic + a11y → the repo primitive is source.** The behavioral spine —
  focus-ring presence, aria wiring, keyboard order/operability, reduced-motion
  handling — is authored and owned in code. A visual sync consumes it read-only; it
  never regenerates it.

The failure this prevents is the one-way leak in the wrong direction: a synced
reskin that, in restyling a button, quietly ships it as a `<div>`, drops its
`aria-pressed`, or strips the shared focus ring. Pillar 4 (accessibility) is
non-negotiable law; a round-trip that erodes it is a regression no matter how good
the new paint looks.

## The layers are complementary, not a hierarchy

Tokens and behavior are orthogonal seams that meet at the primitive. The token layer
(re-stratification, role-token values) is iterated **on hold behind visual design**;
this behavioral contract is independent of it and is buildable now. The two never
contend for the same fact: a token change moves a value in `styles/tokens.css`; a
behavioral change moves logic in a primitive. `/design-sync` keeps them one-directional
so neither round-trip clobbers the other's layer.

## Enforcement — the spine tests are the tripwire

The rule is only law if a broken round-trip fails a gate. Two rungs enforce it:

- **The property-based a11y loop** ([property-based-a11y.md](./property-based-a11y.md),
  `apps/web/src/components/ui/a11y/`) — a standing generic gate over *every* `ui/`
  primitive: axe name/ARIA/focusability invariants over randomized valid props. A
  reskin that drops a name or breaks ARIA on any primitive fails it.
- **The entry-row spine lock**
  ([`apps/web/src/components/entry-row-spine.test.tsx`](../apps/web/src/components/entry-row-spine.test.tsx))
  — the composite-specific tripwire for the entry-row shell (`Button`, `MetaRow`,
  `CountToggle`, `ToggleGroup`, `ReactionBar*`). It asserts the four behavioral facts
  a visual sync must not touch: **focus-ring presence** (the control is a native
  focusable element the single shared `:focus-visible` ring paints), **aria
  roles/labels/state**, **keyboard order/operability**, and **`prefers-reduced-motion`
  respect** (the single global reset that neutralizes every primitive's motion). If a
  synced reskin drops any of them, this suite goes red.

The `/design-sync` tool itself (a separate seam) is out of scope here — this contract
is the invariant that tool must honor, and the spine tests are the guardrail its
round-trips run against.

## When you touch an entry-row primitive

Changing a primitive's *behavior* (its aria wiring, keyboard handling, focusable
shell, or motion) is an authored code change — update the spine test alongside it, on
purpose. Changing only its *paint* (token values, CSS declarations) must leave the
spine test green: if a style-only edit turns it red, the edit crossed a layer boundary
and dropped a behavioral fact it should have preserved.
