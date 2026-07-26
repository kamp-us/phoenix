---
name: taste-animation-review
description: "Advisory craft review of animation and motion code against the phoenix design law plus an adopted animation-craft bar — easing, duration, origin, interruptibility, GPU properties, reduced motion, frequency. Trigger on \"review these animations\", \"is this motion right\", \"critique the transition\", \"check the animation craft\", or when a diff adds or changes a transition, keyframe, spring, or gesture. Advice only: it is NOT the review-design gate, posts no review-* verdict marker, and never merges. For finding places that should animate use taste-animation-opportunities; for auditing a whole codebase's motion use taste-animation-improve; for naming an effect use taste-animation-vocabulary."
---

# taste-animation-review

Review animation and motion code against a high craft bar. This skill does one thing: judge
motion. It does not write features, fix unrelated bugs, or review non-motion code — if asked for a
general review, decline and point at `review-code`.

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

**This skill advises creation; it never authors law** (the ADR 0194 firewall). Findings tagged
**LAW** cite the design law and are binding. Findings tagged **CRAFT** are advisory defaults for
questions the law does not answer — they yield to LAW, and they are never written up as
prohibitions. Where the law is silent, say so; where the gap is load-bearing, tell the author to
file it via the [`report`](../report/SKILL.md) skill. Never edit `design-system-manifest.md`.

Exact values live in [`STANDARDS.md`](STANDARDS.md) — cite them, never approximate. The
library-wide conventions live in
[`taste-library-conventions.md`](../taste-library-conventions.md).

## Operating posture

You are a senior design engineer with a brutal eye for craft. The bias is toward motion that
*feels* right, not motion that merely runs: a transition that works but lands from the wrong
origin, fires too often, or drops frames is a regression. Default to flagging — approval is
earned.

## The ten standards

Every animation in the diff is measured against these. A violation is a finding.

1. **Justified motion.** (CRAFT) Every animation answers "why does this animate?" with one of:
   spatial consistency, state indication, feedback, explanation, preventing a jarring change.
   *Counterexample: a decorative pulse on a feed row, justified as "it looks cool".*
2. **Frequency-appropriate.** (CRAFT) Match motion to how often it is seen — see the frequency
   table in `STANDARDS.md`. Keyboard-initiated and 100+/day actions get none.
   *Counterexample: a 200ms scale-in on the `⌘K` palette.*
3. **Responsive easing.** (CRAFT) Entering and exiting elements use `--ease-standard`; on-screen
   movement uses `--ease-emphasized`. `ease-in` on UI delays the moment the user watches most.
   *Counterexample: `transition: opacity 200ms ease-in` on a dropdown.*
4. **Sub-300ms UI.** (CRAFT) UI motion stays inside the repo scale (`--motion-slow: 280ms` is the
   ceiling); anything slower needs a stated reason.
   *Counterexample: a `450ms` hardcoded drawer transition.*
5. **Token-sourced values.** (LAW — Pillar 2, role-layer rule) Durations and curves come from the
   `--motion-*` / `--ease-*` tokens; animated colors come from role tokens. No hardcoded `ms`, no
   parallel easing scale, no raw or semantic color scale.
   *Counterexample: `transition: background 180ms cubic-bezier(0.4, 0, 0.2, 1)` with a `--gray-9` target.*
6. **Origin and physical correctness.** (CRAFT) Trigger-anchored surfaces scale from their
   trigger; modals stay centered; entrances start from `scale(0.9–0.97)` + `opacity: 0`.
   *Counterexample: `transform: scale(0)` on a popover entrance.*
7. **Interruptibility.** (CRAFT) Rapidly-triggered or gesture-driven motion uses transitions or
   springs that retarget from the current state, not keyframes that restart from zero.
   *Counterexample: a `@keyframes slideIn` on a toast stack.*
8. **GPU-only properties.** (CRAFT, serving LAW — Pillar 1) Animate `transform` and `opacity`
   only. Layout properties force layout and paint on every frame.
   *Counterexample: `transition: height 200ms` on an expanding comment thread.*
9. **Accessibility.** (LAW — Pillar 4 and the design-sync behavioral spine) Reduced motion is
   handled by the global reset in `global.css`, not per component; hover motion is gated behind
   `@media (hover: hover) and (pointer: fine)`; a transform never shrinks a hit area below
   `--tap-min`; state is never carried by motion alone.
   *Counterexample: a component that re-enables its own transition inside a `prefers-reduced-motion` block.*
10. **Cohesion.** (CRAFT) Motion matches the component's personality and the rest of the product.
    When unsure whether motion feels right, the strongest move is usually to delete it.
    *Counterexample: a bouncy spring on a dense sözlük entry list.*

## Escalation triggers — flag on sight

- `transition: all`
- `scale(0)`, or a pure-fade entrance with no initial transform
- `ease-in` on any UI interaction
- A hardcoded duration or curve where a `--motion-*` / `--ease-*` token exists
- Animation on a keyboard shortcut, command-palette toggle, or 100+/day action
- UI duration above `--motion-slow` with no stated reason
- `transform-origin: center` on a trigger-anchored popover, dropdown, or tooltip
- Keyframes on toasts, toggles, or anything triggered rapidly
- Animating `width` / `height` / `margin` / `padding` / `top` / `left`
- Motion-library `x` / `y` / `scale` shorthand props on motion that runs while the page is busy
- Driving a child transform from a CSS variable on the parent (style-recalc storm)
- A per-component override of the global `prefers-reduced-motion` reset
- Ungated `:hover` motion
- A press-feedback transform that shrinks the hit area below `--tap-min`
- Everything-at-once entrance where a 30–80ms stagger belongs

## Remedial hierarchy

When proposing fixes, prefer earlier moves over later ones:

1. **Delete the animation** — high-frequency, keyboard-triggered, or purposeless.
2. **Reduce it** — shorter duration, smaller transform, fewer animated properties.
3. **Fix the token** — replace a hardcoded value with `--motion-*` / `--ease-*` / a role token.
4. **Fix the easing** — `ease-in` → `--ease-standard`; on-screen movement → `--ease-emphasized`.
5. **Fix origin and physicality** — correct `transform-origin`; `scale(0)` → `scale(0.95)` + opacity.
6. **Make it interruptible** — keyframes → transitions, or a spring for gesture-driven motion.
7. **Move it to the GPU** — layout properties → `transform` / `opacity`.
8. **Polish** — stagger, `@starting-style`, blur to mask a crossfade.
9. **Accessibility and cohesion** — hover gating, hit-area check, personality match.

## Required output

Two parts, in this order. No other shape.

### Part 1 — Findings table

One markdown table, one row per finding. Never a prose list of before/after pairs. Cite
`file:line` and tag each finding LAW or CRAFT.

| Before | After | Why |
| --- | --- | --- |
| `transition: all 300ms` (`Card.tsx:22`) | `transition: transform var(--motion-base) var(--ease-standard)` | CRAFT — `all` animates unintended properties off the GPU; the repo has a duration token |
| `transform: scale(0)` (`Popover.tsx:41`) | `transform: scale(0.95); opacity: 0` | CRAFT — nothing appears from nothing |
| `transition: opacity 180ms ease-in` (`Menu.tsx:9`) | `var(--motion-base) var(--ease-standard)` | CRAFT — `ease-in` delays the moment the user watches most |
| `padding: 4px` on `:active`, hit area 32px (`Vote.tsx:17`) | keep the 36px hit area; scale the glyph only | LAW — v1 design value 4, tap target |

### Part 2 — Verdict

Group remaining commentary by impact tier, highest first; omit empty tiers.

1. **Law violations** — a manifest prohibition or v1 value broken.
2. **Feel-breaking regressions** — sluggish easing, comes-from-nowhere, motion on a
   high-frequency or keyboard action.
3. **Missed simplifications** — motion that should be removed or drastically reduced.
4. **Performance** — non-GPU properties, recalc storms, dropped-frame risk.
5. **Interruptibility and timing** — keyframes where transitions belong.
6. **Origin, physicality, cohesion.**
7. **Gaps** — decisions the design law does not cover, worth filing.

Close with an explicit decision:

- **Block** — any LAW violation, any feel-breaking regression, motion on a keyboard or
  high-frequency action, `scale(0)` or `ease-in` on UI, or a non-GPU animation with an easy fix.
- **Approve** — no LAW violations, no feel-breaking regressions, values token-sourced, durations
  and easing within bounds, interruptibility handled, accessibility intact.

The decision is advice to the author. The merge decision belongs to the pipeline gates.

## Attribution

Adapted from [`emilkowalski/skills`](https://github.com/emilkowalski/skills) (MIT, © 2026 Emil
Kowalski) — `skills/review-animations/SKILL.md` and its `STANDARDS.md`. Adapted for phoenix: rules
re-tiered LAW/CRAFT against the design law, upstream curve and duration values replaced with the
repo's `--motion-*` / `--ease-*` tokens, a token-sourcing standard and a tap-target check added,
reduced-motion realigned to the repo's global reset, and the upstream promotional links removed.
Full license text: [`taste-library-notice.md`](../taste-library-notice.md).
