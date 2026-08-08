---
id: 0240
title: The icon scale gains a 12/14 dense tier, legal only beside a label
status: accepted
date: 2026-08-08
tags: [design, frontend, icons, cohesiveness]
---

# 0240 — The icon scale gains a 12/14 dense tier, legal only beside a label

**What this decides:** phoenix's icon sizes now run 12/14/16/20/24 instead of 16/20/24. The two new small steps exist for chrome that is physically smaller than a 16px glyph wants — the topbar's 24px-tall search box, an 11px meta-text back link — and they are legal **only** when the icon sits next to a text label that already carries the meaning. Everything else about the icon idiom is exactly as ADR 0166 ruled it.

## Context

ADR [0166](0166-canonical-icon-idiom.md) §4 ruled three sizes on the 4px grid — 16 / 20 / 24 — with **16 as a hard floor**, reasoned "below 16 muddies on dark surfaces", and the tap target decoupled from the glyph (a ≥36px hit area filled by padding).

That floor was calibrated against 0166's own size table, whose rows are *dense rows · inline · vote*, *standalone · nav · toolbar*, and *emphasis · empty-state* — icons that own their space. phoenix's compact chrome has rows the table does not describe:

- The topbar search box is **24px tall** at compact density, and it sits among controls of the same order — `.kp-topbar__btn` at 24px, `.kp-topbar__user` at 26px, the field's own inner height on `--letter-size` (22px compact). A 16px magnifier inside a 24px box leaves 4px of air per side; it reads as a glyph wearing the box rather than a mark inside a field.
- The `akışa dön` back links are set in `--t-meta` (11px), where a 16px arrow outweighs the label it prefixes.

The floor's stated reason is a **rendering** claim — stroke legibility on a dark ground — and it holds for a glyph a reader must decode on its own. It does not bind the same way for a glyph that is redundant with an adjacent label: a magnifier beside an `ara…` placeholder, an arrow before the words `akışa dön`. There the icon is a marker for something already written, so a stroke that reads as *quiet* costs nothing, while an oversized one visibly breaks the row it sits in.

The alternative — keeping the floor and growing the chrome to fit it — was rejected: the topbar's 24px scale is deliberate density (it has its own control-height overrides precisely to resist Manti's shared 36px control height), and 0162's tap-target law is already satisfied by the decoupled hit area, so the box has no other reason to grow.

**Amends in part [0166](0166-canonical-icon-idiom.md)** — §4's scale and floor only. The rest of
0166 (the Lucide set, the stroke discipline, the colour-role mapping, the vote glyph, the three-way
partition) stands untouched, and 0166 is still `status: proposed` pending its own ratification; this
records the amendment on its status line without touching its body. The contradiction sweep surfaced
[0176](0176-nav-ia-discipline.md), [0182](0182-subnavshell-pageshell-composition-api.md) and
[0223](0223-pillar-4-bans-motion-alone.md) as lexically adjacent — all three cite or place icons but
none rules on their size, so none is re-decided here.

## Decision

**The icon size scale is 12 / 14 / 16 / 20 / 24; 16 stays the floor for any icon that carries meaning on its own, and 12/14 are legal only for a glyph paired with an adjacent text label in dense chrome.**

The new steps are not a free-for-all smaller tier — they are a *labelled-glyph* tier. The test is whether removing the icon would cost the reader anything: if the adjacent text already says it (`ara…`, `akışa dön`), the glyph is a marker and may go to 12/14; if the icon is the only thing saying it (the divan gavel, the bildirim bell, the vote triangle), it stays at ≥16 where its stroke is unambiguous.

12 and 14 are off the 4px grid that 0166 §4 invokes. That is deliberate and confined to this tier: they are glyph sizes chosen against the *host row's* height (a 22–26px control, an 11px meta line), not spacing steps, and the spacing ramp they sit inside is untouched.

**Binding constraints.**
- A 12 or 14 glyph must have an adjacent text label in the same control that carries its meaning.
- An icon-only control — no visible label — stays at 16 or above, whatever its host's height.
- The tap target is unchanged: ≥36px hit area, padding fills, the glyph never inflates to reach it (0162 Pillar 4, 0166 §4).
- Everything else in 0166 stands untouched: drawn Lucide glyphs (never a hand-inlined SVG, never a Unicode functional glyph), native per-size optical stroke (never a pinned `absoluteStrokeWidth`), monochrome `stroke: currentColor` on role tokens only, the drawn triangle vote glyph, and the function / affect / key-legend partition.

**Banned.**
- A 12/14 glyph as the sole content of a control.
- Reaching for 12/14 to fit an icon into a row that is itself a spacing defect — resize the row.
- Adding a sixth step. The scale is closed at 12/14/16/20/24; a size outside it is a `IconSize` type error, which is where this is enforced.

## Consequences

`IconSize` in [`Icon.tsx`](../apps/web/src/components/Icon.tsx) is the enforcement point — the union type makes an unruled size uncompilable, so the scale needs no separate guard. Three call sites use the new tier today: the topbar search magnifier at 12, and the two `akışa dön` arrows at 14. Everything else stays on 16/20/24.

The cost is a judgement call at each call site that the old rule did not require: "does this glyph have a label?" is softer than "is this ≥16?". The binding constraints above are written to make the common case mechanical, and the type still refuses anything off the scale, but a reviewer now has to check pairing rather than just a number.

The doc surfaces that transcribe 0166 §4 move with it — the size bullet in [`design-system-manifest.md`](../design-system-manifest.md) (which `write-code` reads before generating UI, so a stale floor there would silently re-impose the old rule) and the `Icon.tsx` docblock, which still described a "16/20/24 size scale" while its own type had already widened.

## Records

- **No vocabulary impact.** This re-decides a scale over already-named concepts (icon, size, tap target); it coins no domain noun and redefines none. Nothing routed to [`.glossary/TERMS.md`](../.glossary/TERMS.md).
- ADR [0166](0166-canonical-icon-idiom.md) status set to `amended-in-part`; its body is untouched.
