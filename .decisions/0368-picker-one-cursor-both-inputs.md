---
id: 0368
title: Every picker drives mouse and keyboard through one cursor model, never two input paths
status: accepted
date: 2026-09-09
tags: [tuval, accessibility, frontend, picker]
---

# 0368 — Every picker drives mouse and keyboard through one cursor model, never two input paths

**What this decides:** a Tuval list you pick from answers the mouse and the keyboard with the same
code, so the two can never disagree about which row is highlighted or what choosing it does.

## Context

Tuval's window picker (`<c-b> w`) answered key presses only. `pickerKey`
(`apps/tuval/src/shell/picker/view.ts`) normalized a key name and matched it against a move, a
choose or a dismiss; a pointer event had no way in, so clicking a row did nothing and hovering one
did nothing ([#8655](https://github.com/kamp-us/phoenix/issues/8655)).

The founder ruled it on 2026-09-08, quoted verbatim in that issue's "What the founder ruled"
section and again in the body of the pull request that answered it
([#8658](https://github.com/kamp-us/phoenix/pull/8658)):

> i want to be able to use mouse as well (any picker we have should use the same underlying
> structure for both mouse and keyboard)

The ruling has two halves and the second is the one worth a record. Adding mouse support is a
feature; ruling that both inputs share **one** structure is a constraint on every picker Tuval will
grow. Its only homes were two issue bodies and a bullet in
[`.patterns/tuval-shell-assembly.md`](../.patterns/tuval-shell-assembly.md) that cited an issue
number for its authority, which is the shape with no why beside it — so the next person building a
buffer switcher or a spell palette would meet the constraint with nothing to weigh it against
([#8660](https://github.com/kamp-us/phoenix/issues/8660)). The likely failure is not disobedience
but re-litigation: someone writes a second, pointer-only write path, and the review that should
catch it has no record to point at.

The cost of two paths is concrete, not stylistic. A picker's highlight is announced off
`aria-activedescendant`, which names exactly one row. Two write paths mean two places that set it,
and they drift: hover moves the visual highlight while the keyboard cursor stays put, `<enter>`
then runs the row the mouse never touched, and a screen-reader user hears a row nobody is looking
at. The same defect is already recorded one layer down for a third-party menu — ADR
[0361](0361-manti-menu-highlighted-value-patch.md) rejected a `scrollIntoView` workaround precisely
because it scrolled the panel while leaving the machine's highlight elsewhere.

## Decision

**Every picker in Tuval answers the pointer and the keyboard through one cursor model and one
answer type; a second write path for either input is a defect, not an implementation choice.**

The shape that landed in [#8658](https://github.com/kamp-us/phoenix/pull/8658) is the reference
implementation, and it is four things:

- **One answer union.** `pickerKey` takes a key, `pickerPointer` takes a row index plus a
  `"hover"` / `"click"` gesture, and both return the same `PickerKeyAnswer`
  (`apps/tuval/src/shell/picker/view.ts`) — `Moved`, `Cleared`, `Chose` or `Ignored`. The pointer
  arm can express nothing the keyboard arm cannot.
- **One move.** Both arms route their move through the shared `movedTo`, so a hover clears a showing
  refusal exactly as an arrow key does, and landing on the row already under the cursor keeps that
  refusal exactly as a press that cannot move does.
- **One highlight.** `aria-activedescendant` on the listbox is the only highlight either input
  moves. There is no second visual state a pointer sets and the keyboard does not read.
- **One dispatch.** The React surface holds a single `run(answer)` switch over the union and hands
  it both arms' answers (`apps/tuval/src/shell/ui/PickerView.tsx`). The listbox keeps DOM focus, a
  click takes that focus before it dispatches, and the options stay non-tabbable and listen to
  nothing else — the `aria-activedescendant` pattern is announced only off the element that
  actually has focus.

**Scope.** Every picker and option-list surface under `apps/tuval` (ADR
[0345](0345-tuval-lives-under-apps.md)). The window picker is the only one today; a buffer
switcher, a spell palette and a file picker are the ones named as coming. The ruling says *any*
picker, so it binds a surface before that surface exists.

**A picker delegated to a component that already owns both inputs satisfies this.** The composer's
mode/model/thinking controls go through `AgentSettingMenu` from `@kampus/design`, whose Zag machine
holds one `highlightedValue` both inputs write — one structure, not ours. ADR
[0361](0361-manti-menu-highlighted-value-patch.md) is how that component's highlight route gets
fixed when it is missing. What this ADR forbids is a *hand-rolled* picker growing a second path.

**Binding constraints.**

- A pointer gesture on a picker row resolves to a value in the same answer type the keyboard
  resolves to. A handler that mutates picker state directly is banned.
- The cursor lives in one place — the window's own view slot — and both inputs write that one
  place. A pointer-only highlight held anywhere else is banned.
- `aria-activedescendant` is the single highlight. A picker that paints a hover highlight the
  keyboard cursor does not follow is banned.
- The listbox holds DOM focus and the options are not tabbable, on the pointer path as much as the
  keyboard path. A click that leaves focus somewhere else is banned.
- An index naming no row answers `Ignored` rather than clamping. A pointer event carries a row that
  was really under it, so an out-of-range index means the list changed under the gesture, and moving
  the cursor somewhere the user never pointed is worse than doing nothing.

## Consequences

Easier: a new picker gets both inputs by writing one arm against an existing union, and every
keyboard test it already has covers the pointer path's state too. A reviewer has one question to
ask — does the pointer answer in the keyboard's type — instead of comparing two implementations.

Harder: a pointer gesture that has no keyboard equivalent has nowhere to go. Drag-to-reorder or a
per-row hover affordance would need the union extended and the keyboard given the same capability,
which is more work than a local pointer handler. That is the intended cost.

This ADR adds no gate. It is read at review time against the picker code and
[`.patterns/tuval-shell-assembly.md`](../.patterns/tuval-shell-assembly.md), whose picker bullet
points here for its why. Tuval's keyboard routing is unchanged: keys still reach the picker over the
prefix table the kernel sent (ADR [0353](0353-kernel-sends-the-prefix-table.md)).

## Records

No vocabulary impact. "Picker", "cursor" and "listbox" are used in their existing repo and ARIA
senses; nothing here is coined or redefined, so `.glossary/TERMS.md` is untouched.
