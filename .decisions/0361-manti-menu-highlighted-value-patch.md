---
id: 0361
title: "`@manti-ui/react`'s `Menu` forwards Zag's highlight props, carried as a local patch until upstream takes it"
status: accepted
date: 2026-09-07
tags: [design-system, dependencies, accessibility, tuval]
---

# 0361 — `@manti-ui/react`'s `Menu` forwards Zag's highlight props, carried as a local patch until upstream takes it

**What this decides:** phoenix patches its pinned `@manti-ui/react` so the composer's model picker
can open on the model you are actually using, and offers the same change upstream rather than
working around the gap in our own code.

## Context

Tuval's composer renders its model and thinking-level pickers through `SettingMenu`
(`packages/design/src/AgentChatInput.tsx`), which is a Manti `Menu` holding one radio group. With
Pi's ~30-model catalogue the picker opened at row 1 every time, so the row you were on sat below
the fold and you had to hunt for yourself before you could move
([#8078](https://github.com/kamp-us/phoenix/issues/8078)). An option list that opens away from its
checked option is an accessibility defect, not a polish item.

The behaviour already exists in the machine. `@zag-js/menu@1.43.0` runs `scrollToHighlightedItem`
as an effect of its open state and resolves the element to scroll from the machine's
`highlightedValue` (`dist/menu.machine.mjs`, the `scrollToHighlightedItem` effect and the
`highlightedId` computed). The machine's public props already include `highlightedValue`,
`defaultHighlightedValue` and `onHighlightChange` (`dist/menu.props.mjs`).

What was missing was a route to them. `@manti-ui/react@0.9.0`'s `MenuProps` exposes
`open`/`defaultOpen`/`onOpenChange`/`onSelect`/`contentProps`/`getItemProps` and forwards none of
the three; `contentProps` and `getItemProps` are plain attribute bags carrying no `ref`, so there is
no handle on the panel or a row either.

The founder ruled the route on the issue
([comment](https://github.com/kamp-us/phoenix/issues/8078#issuecomment-5555642577)): patch the pin
and offer the same diff upstream. The rejected alternative was a `useEffect` in `SettingMenu` that
queries the portaled row and calls native `Element.scrollIntoView`. It scrolls the panel while
leaving the machine's highlight on row 1, so the visible panel and the next arrow key disagree —
worse for a screen-reader or keyboard user than an honest top-of-list.

ADR [0038](0038-dependency-patches-local-only.md) already governs this shape: a local `pnpm patch`
committed to the repo, never an external patch source, with upstreaming encouraged and the merged
release — not the in-flight PR — as the thing phoenix eventually depends on. ADR
[0170](0170-workers-cache-via-alchemy-effect-pnpm-patch.md) is the same move on alchemy.

## Decision

**`@manti-ui/react@0.9.0` is patched in-repo so `Menu` forwards `highlightedValue`,
`defaultHighlightedValue` and `onHighlightChange` into the Zag machine it already owns, and the same
change is offered upstream to `manti-ui/ui`.**

The patch lives at `patches/@manti-ui__react@0.9.0.patch`, wired through `patchedDependencies` in
`pnpm-workspace.yaml`. It touches two files and adds no behaviour of its own: three destructured
props threaded into the existing `useMachine` options in `dist/index.js`, and the matching entries
on `MenuProps` in `dist/components/Menu/Menu.d.ts`. `onHighlightChange` is unwrapped to
`(value: string | null) => void`, matching how the adapter already unwraps `onOpenChange` and
`onSelect`.

`SettingMenu` drives the highlight as controlled state: it seeds the highlight to the checked row
when the menu opens and mirrors the machine afterwards. Seeding is required rather than optional —
Zag clears the highlight on the machine's `closed` entry, so `defaultHighlightedValue` alone would
work for the first open and no other.

**Binding constraints.**

- Re-key this patch on the next `@manti-ui/react` bump, and drop it once a release ships the props.
- The rejected DOM route stays rejected: `SettingMenu` never reaches into the portaled panel by
  Zag's private id template, and never scrolls a row the machine does not also have highlighted.
- Manti's surface coming up short a third time is when driving `@zag-js/menu` directly from
  `@kampus/design` becomes the answer. [#6776](https://github.com/kamp-us/phoenix/issues/6776) was
  the first, this is the second.

## Consequences

The picker opens where the user is, and the first arrow key moves from there — one behaviour, so
the panel and the screen reader cannot disagree. Every Manti `Menu` in the repo gains the props,
not just this one.

The cost is a fourth patched dependency and one more thing a pin bump re-litigates. It is bounded:
the patch adds a passthrough and changes no default, so an upstream release that ships the same
props retires it with no consumer change. Until then `packages/design` resolves a patched copy of
`@manti-ui/react`, which is visible in the lockfile and in the diff.

Nothing pins the patch by machine beyond
`apps/tuval/src/shell/chat/chat-picker-opens-on-checked-row.unit.test.tsx`, which fails on all three
assertions with the props unwired — an unpatched or badly re-keyed copy reds there rather than
shipping a picker that silently reverted to row 1.

## Records

no vocabulary impact
