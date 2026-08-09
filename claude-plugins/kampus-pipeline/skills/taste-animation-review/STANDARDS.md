# Animation standards — values only

The exact figures the `taste-animation-*` skills cite instead of approximating. Values only: no
procedure, no verdict language, no rules — those live in the SKILL.md files. The only prose here is
the two forms §4 of [`taste-library-conventions.md`](../taste-library-conventions.md) permits — a
provenance gloss under a table, and a firewall-mandated `Known divergence` note.

Every row carries a **provenance** tag, per §2 of
[`taste-library-conventions.md`](../taste-library-conventions.md):

- **LAW** — from the phoenix design law: a `design-system-manifest.md` section, or the source file
  the manifest names as where the value lives. Binding. Never softened or extended by inference.
- **CRAFT** — an advisory default (adopted from `emilkowalski/skills`, or repo-grown) for a
  question the design law does not answer. CRAFT yields to LAW on every conflict.

## Motion tokens (the repo's shipped scale)

Defined in [`apps/web/src/styles/tokens.css`](https://github.com/kamp-us/phoenix/blob/main/apps/web/src/styles/tokens.css)
(the `motion` block).

| Token | Value | Provenance |
|---|---|---|
| `--motion-fast` | `120ms` | LAW — tokens.css motion block |
| `--motion-base` | `160ms` | LAW — tokens.css motion block |
| `--motion-slow` | `280ms` | LAW — tokens.css motion block |
| `--ease-standard` | `ease-out` | LAW — tokens.css motion block |
| `--ease-emphasized` | `cubic-bezier(0.32, 0.72, 0, 1)` | LAW — tokens.css motion block |

These tokens are motion's **role layer**, which is what the LAW tag on each row binds: under the
manifest's Pillar 2 role-layer rule a component references them rather than restating their values,
so a hardcoded duration or a parallel easing scale is a law violation, not a style choice. (The rule
itself is standard 5 in [`SKILL.md`](SKILL.md).)

## Duration budget

| Element | Duration | Token | Provenance |
|---|---|---|---|
| Button / press feedback | 100–160ms | `--motion-fast` … `--motion-base` | CRAFT |
| Tooltip, small popover | 125–200ms | `--motion-fast` … `--motion-base` | CRAFT |
| Dropdown, select | 150–250ms | `--motion-base` | CRAFT |
| Modal, drawer | 200–500ms | `--motion-slow` | CRAFT |
| Marketing / explanatory | may exceed 300ms | — | CRAFT |
| Any UI element | < 300ms | — | CRAFT |

The repo scale tops out at `--motion-slow: 280ms`, inside the sub-300ms budget. A drawer that
wants the upper half of the 200–500ms band has no token — that is a gap to surface, not a
hardcoded `420ms`.

## Easing decision

| Motion | Easing | Provenance |
|---|---|---|
| Entering or exiting | `--ease-standard` (`ease-out`) | CRAFT |
| Moving / morphing on screen | `--ease-emphasized` | CRAFT |
| Hover / color change | `--ease-standard` | CRAFT |
| Constant motion (marquee, progress) | `linear` | CRAFT |
| Default | `--ease-standard` | CRAFT |
| Any UI interaction | never `ease-in` | CRAFT |

**Known divergence (surface, do not resolve locally).** The adopted craft holds that built-in CSS
easings are too weak for deliberate motion and prefers strong custom curves; the repo's
`--ease-standard` is the built-in `ease-out`. `--ease-emphasized` (`cubic-bezier(0.32, 0.72, 0, 1)`)
is the repo's strong curve and is the right reach for emphasized motion. Do **not** add a third
easing token to close the gap — file it via the [`report`](../report/SKILL.md) skill.

## Physicality

| Rule value | Figure | Provenance |
|---|---|---|
| Entrance scale floor | `scale(0.9)`–`scale(0.97)` + `opacity: 0` — never `scale(0)` | CRAFT |
| Press feedback scale | `scale(0.97)` (range `0.95`–`0.98`) on `:active` | CRAFT |
| Trigger-anchored surfaces (popover, dropdown, tooltip) | `transform-origin` at the trigger | CRAFT |
| Modals | `transform-origin: center` — exempt from trigger-anchoring | CRAFT |
| Translate distances | land on the 4px lattice (1px/2px sanctioned exceptions) | LAW — v1 design value 1, Grid |
| Hit area under any transform | ≥ `--tap-min` (`36px`) | LAW — v1 design value 4, Tap target |

A press-feedback scale shrinks the painted glyph, never the hit area: `--tap-min` is a
density-invariant floor.

## Performance

| Rule value | Figure | Provenance |
|---|---|---|
| Animatable properties | `transform` and `opacity` only | CRAFT |
| Never animated | `width`, `height`, `margin`, `padding`, `top`, `left` | CRAFT |
| Child transforms | set `transform` on the element; never drive it from a CSS variable on the parent | CRAFT |
| Motion-library shorthands | full transform string (`transform: "translateX(100px)"`), not `x`/`y`/`scale` props | CRAFT |
| First paint | never gated on the session; never blocked on a deferrable read | LAW — Pillar 1, Performance |
| Skeleton / placeholder height | reserves the real payload height | LAW — Pillar 1, Performance |

Pillar 1 is the law these craft rules serve: an animation that forces layout or repaints during
navigation is the same defect as a blocked first paint, arriving later.

## Accessibility

| Rule value | Figure | Provenance |
|---|---|---|
| `prefers-reduced-motion` | honored by the shared layer, not per component | LAW — manifest, Design-sync authority (the behavioral spine is code-authoritative) |
| Shipped reduced-motion baseline | `animation-duration: 0.01ms`, `animation-iteration-count: 1`, `transition-duration: 0.01ms`, `scroll-behavior: auto` — global reset in [`global.css`](https://github.com/kamp-us/phoenix/blob/main/apps/web/src/styles/global.css) | LAW — global.css |
| Hover motion | gated behind `@media (hover: hover) and (pointer: fine)` | CRAFT |
| Meaning carried by motion | never motion alone — the state must also be readable when motion is off | LAW — Pillar 4, "never signal state or meaning by motion alone" (the manifest's own prohibition, per ADR 0223 — no longer an analogy to the colour rule) |
| Focus ring during motion | `--focus-ring` + `--focus-ring-offset`, never a hand-rolled per-component `outline` | LAW — Pillar 4 |

**Known divergence (surface, do not resolve locally).** The adopted craft holds that reduced
motion means *gentler, not zero*; phoenix ships a global near-zero reset. The repo's behavior is
the law here — do not write a per-component escape from the global rule to preserve a "gentler"
animation. If an animation genuinely aids comprehension and is lost under the reset, file it via
the [`report`](../report/SKILL.md) skill.

## Interruptibility

| Rule value | Figure | Provenance |
|---|---|---|
| Rapidly-triggered motion (toasts, toggles, drags) | CSS transitions or springs — retarget from current state | CRAFT |
| Keyframes | only for predetermined, non-interruptible motion | CRAFT |
| Entry without JS | `@starting-style` | CRAFT |

## Springs

| Parameter | Value | Provenance |
|---|---|---|
| Default config | `{ type: "spring", duration: 0.5, bounce: 0.2 }` | CRAFT |
| Bounce range | `0.1`–`0.3`; reserve bounce for drag-to-dismiss and playful surfaces | CRAFT |

## Gestures

| Parameter | Value | Provenance |
|---|---|---|
| Velocity dismissal threshold | `Math.abs(distance) / elapsedMs > 0.11` px/ms | CRAFT |
| Boundary behavior | rising resistance (rubber-banding), never a hard stop | CRAFT |
| Pointer capture | acquired once dragging starts | CRAFT |
| Extra touch points after drag start | ignored | CRAFT |

## Frequency

| Frequency | Decision | Provenance |
|---|---|---|
| 100+ times/day (keyboard shortcuts, command palette) | No animation | CRAFT |
| Tens of times/day (hover, list navigation) | Remove, or near-imperceptible only | CRAFT |
| Occasional (modals, drawers, toasts) | Standard animation | CRAFT |
| Rare / first-time (onboarding, empty states, success) | Delight budget available | CRAFT |

## Stagger and masking

| Parameter | Value | Provenance |
|---|---|---|
| Stagger interval | 30–80ms between items; never blocks interaction | CRAFT |
| Crossfade masking blur | `filter: blur(2px)`; keep under `20px` | CRAFT |
