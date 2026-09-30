---
id: 0441
title: A markdown task item renders a decorative glyph plus a visually-hidden state word
status: accepted
date: 2026-09-30
tags: [design, frontend, markdown, accessibility, manifest]
---

# 0441 — A markdown task item renders a decorative glyph plus a visually-hidden state word

**What this decides:** in the shared `Markdown` block, `- [x] done` renders as a glyph a sighted
reader sees plus a hidden word a screen reader hears once. It never renders as the literal `[x]`
and never as a disabled `<input type="checkbox">`.

## Context

`marked` emits a task item's marker as its own `checkbox` token. The `checkbox` case in
[`packages/design/src/Markdown.tsx`](../packages/design/src/Markdown.tsx) returns `token.raw`, so the
item reads `[x] done` beside rendered bold, tables and links. A builder picked that mid-ticket on
#8012, and [#8023](https://github.com/kamp-us/phoenix/issues/8023) asked the founder to choose
between three treatments instead.

The founder ruled on 2026-09-05:
<https://github.com/kamp-us/phoenix/issues/8023#issuecomment-5554841941>.

> **Ruling (founder, 2026-09-05): treatment 3.** A decorative glyph for sighted readers plus a
> visually-hidden state word (`done` / `not done`) for assistive tech, via the existing
> `kp-visually-hidden` idiom. Treatment 1 (literal `[x]`) and treatment 2 (disabled checkbox) are
> rejected: 1 leaves source syntax in rendered output, 2 either double-announces or drops state.

This record transcribes that ruling. It adds nothing the ruling did not decide, except where an
existing rule already answers the question, and each of those is cited below.

## Decision

**A markdown task item renders a decorative glyph plus a visually-hidden state word.**

1. **Sighted readers get a glyph.** One mark for a checked item, another for an unchecked one.
2. **Assistive tech gets a word, once.** The state reads `done` or `not done`, in a
   `kp-visually-hidden` span. That word is the only place the state reaches a screen reader.
3. **The glyph stays out of the accessible name.** It sits on an `aria-hidden` element. This is the
   second arm of each bound in [ADR 0166](0166-canonical-icon-idiom.md) §8: a state marker is not an
   icon when it pairs with a non-visual state signal and never leaks into the accessible name. A
   glyph that fails either bound is a functional glyph under §1's ban, and needs a Lucide icon.
4. **The state words come from the design package's message catalog.** The `Markdown` block already
   takes its accessible names from `packages/design/src/i18n.tsx` (`ui.markdown.table`, and
   `ui.markdown.code` through `CodeBlock`), so the state words follow that precedent.
   [ADR 0347](0347-web-copy-behind-i18n-catalog.md) sets the same rule for `apps/web`'s catalog;
   this record applies it here by that precedent, not by 0347's own scope. The ruling named the
   words, so the locale-free option #8023 raised, a glyph pair with no announced word, is out.

**Rejected.**

- **Treatment 1, the literal `[x]` / `[ ]` marker.** It leaves source syntax in rendered output,
  which is the complaint #8012 was filed to fix.
- **Treatment 2, a disabled `<input type="checkbox">`.** In a read-only block the control has no
  name of its own. Naming it with the item's text makes a screen reader announce that text twice;
  hiding it with `aria-hidden` drops the checked state for assistive tech, leaving state carried by
  shape alone ([ADR 0162](0162-four-pillars-design-law.md) Pillar 4).

## Consequences

- The `checkbox` case in `Markdown.tsx` changes, and the test that pins the literal marker ("keeps a
  task list's state as its source marker") is rewritten to pin the glyph and the hidden word.
- The design catalog gains two entries, one per state, beside the other `ui.markdown.*` keys.
- Until that build lands, the shipped code still prints the literal marker. Its inline comment
  points at this record instead of restating the builder's reasoning.
