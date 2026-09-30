---
id: 0436
title: Manti on Zag replaced Base UI as the primitive layer, and a design wrapper adds code only to correct or complete it
status: accepted
date: 2026-09-30
tags: [design-system, dependencies, frontend, accessibility]
---

# 0436 — Manti on Zag replaced Base UI as the primitive layer, and a design wrapper adds code only to correct or complete it

**What this decides:** phoenix's UI primitives come from Manti (`@manti-ui/react`, built on Zag
state machines), not Base UI (`@base-ui/react`). The wrapper files in `packages/design/src/`
stay bare re-exports unless a primitive needs fixing or needs something phoenix owns that Manti
cannot take as a prop.

## Context

Until 2026-08-09, phoenix's primitive layer was Base UI: `@base-ui/react ^1.4.1` in the workspace
catalog, wrapped by `apps/web/src/components/ui/`. Community member @tutkuofnight opened
[#4433](https://github.com/kamp-us/phoenix/pull/4433), which moved all of `apps/web` onto
`@manti-ui/react` and `@manti-ui/styles` `0.9.0` across 167 files. The founder merged it on
2026-08-09. [#5174](https://github.com/kamp-us/phoenix/issues/5174) tracks the swap. No ADR
recorded it, and the corpus never named Base UI at all. That gap left stale Base UI claims in
`.patterns/` with no record to check them against ([#6669](https://github.com/kamp-us/phoenix/issues/6669)).

[#6775](https://github.com/kamp-us/phoenix/issues/6775) asked the founder whether to write this
record. He said yes, including the rule for when a wrapper earns more than a re-export:
[the ruling comment](https://github.com/kamp-us/phoenix/issues/6775#issuecomment-5519865255).
He added "also replace any base ui patterns with manti ones, if not create a tracking issue for that
so we can create manti patterns". The lens he set for that batch was "reduce process toil, increase
trust between agents and skills — pick the cheapest option, add no new gate or token unless a
failure actually recurred."

**Why Manti, in the founder's words.** The one recorded reason is the founder's ruling on #4433,
relayed on that PR on 2026-08-09: "we got the most awesomest contribution from one of our community
members … we have to find a way to merge this." He ruled it a one-off exception to the campaign
scope in force then. So Manti arrived because someone in the community built the whole migration
and the founder wanted it in. It was not the result of a comparison phoenix ran.

**What stays unrecoverable.** Nobody recorded a technical comparison of Manti against Base UI, or
against any other library, before or after the merge. This record does not invent one. What leaving
Base UI cost was also never written down. The costs this record can point to are fixes that landed
after the merge, listed under Consequences. They are not reasons anyone weighed beforehand.

The contributor's own reasoning is on record in #4433's body, and it is the contributor's, not the
founder's. Manti is the "component, behavior, anatomy, and accessibility foundation", while phoenix
stays "the source of truth for semantic colors, density, typography, dimensions, interaction
emphasis, and product-specific behavior". Components with phoenix domain behavior were kept rather
than forced onto a Manti primitive, "to avoid creating wrappers that only imitate an API Manti does
not currently need to own".

On 2026-09-03, [#7647](https://github.com/kamp-us/phoenix/pull/7647) moved the wrapper layer out of
`apps/web/src/components/ui/` into the shared `@kampus/design` package at `packages/design/src/`.
The rule below applies to that layer wherever it lives.

## Decision

**Manti, driven by Zag, is phoenix's UI primitive layer, and Base UI is the approach it
superseded.**

New primitives come from `@manti-ui/react` through a file in `packages/design/src/`. Nothing imports
`@base-ui/react`. No `package.json` in the workspace names it and no `.patterns/` doc teaches it, so
the founder's "replace any base ui patterns with manti ones" asks for nothing more today. Manti
patterns live in [`.patterns/manti-accessibility.md`](../.patterns/manti-accessibility.md) and
[`.patterns/zag-machine-interaction-tests.md`](../.patterns/zag-machine-interaction-tests.md).

**What the wrapper layer is for.** Each file in `packages/design/src/` that fronts a Manti
primitive is where callers import it. It carries the `@component` docblock that says when to use it
and imports the primitive's phoenix CSS. By default it is a bare re-export and nothing more:
`Menu.tsx`, `Collapsible.tsx`, `Popover.tsx`, `ToggleGroup.tsx`, `Tabs.tsx`, `Select.tsx`,
`ScrollArea.tsx` and `NumberInput.tsx` are that shape today.

**When a wrapper earns more than a re-export.** A wrapper adds code only when one of these holds:

1. **It corrects verified Manti or Zag behavior.** The comment names the upstream package, its
   version and the file that shows the defect, so the correction can be deleted once upstream fixes
   it.
2. **It supplies something phoenix owns that Manti cannot take as a prop**, such as an accessible
   name in the reader's language.

The worked case is `Switch.tsx`. Zag's switch machine renders its hidden input uncontrolled:
`getHiddenInputProps()` emits `defaultChecked`, never a React-owned `checked`
(`@zag-js/switch@1.43.0`, `dist/switch.connect.mjs`). After a programmatic change, every
`data-state` updates but the input's `checked` property goes stale. That property is what
assistive tech reads off `role="switch"`. The wrapper re-asserts `input.checked` on every render and
forces a render on every attempted change, so a flip the parent declines is corrected too. A bare
re-export would ship that defect to every caller. That is why this file holds code.

`Dialog.tsx` and `Toast.tsx` earn their code the second way: Manti's close buttons carry no
translated name, so the wrappers supply one through `useDesignT`.

**Binding constraints.**

- A primitive with neither a correction nor a phoenix-owned addition stays a bare re-export. Its
  file carries the docblock and CSS import, and no pass-through props.
- A correction cites the upstream source it works around, with a version, in the comment beside it.
- A Manti defect that can only be fixed inside the package is carried as a local patch and offered
  upstream, as [ADR 0361](0361-manti-menu-highlighted-value-patch.md) does for `Menu`.

## Consequences

- The corpus now names the layer that was replaced, so a stale Base UI claim can be checked against
  this record.
- The cost of adopting Manti shows up as fixes after the merge: `Switch`'s hidden-input correction
  ([#6496](https://github.com/kamp-us/phoenix/pull/6496)), the dialog and toast close-button names
  ([#6776](https://github.com/kamp-us/phoenix/issues/6776),
  [#6777](https://github.com/kamp-us/phoenix/issues/6777)), the `Menu` highlight patch
  ([ADR 0361](0361-manti-menu-highlighted-value-patch.md)), and the icon tier that sits beside
  Manti's shared 36px control height ([ADR 0240](0240-icon-dense-tier.md)).
- Manti's components are flat, not compound. A primitive's accessible name comes from a prop, not a
  nested child. `.patterns/manti-accessibility.md` owns that guidance.
- Whether Manti beats the alternatives on technical grounds is still an open question. Nobody weighed
  it when the swap landed, and this record does not claim otherwise.
