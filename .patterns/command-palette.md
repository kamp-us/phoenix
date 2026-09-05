# Command palette

`CommandPalette` is the shared modal search surface in
[`packages/design/src/CommandPalette.tsx`](../packages/design/src/CommandPalette.tsx). Its first
product use is the search-only `⌘K` contract fixed by
[ADR 0186](../.decisions/0186-command-palette-single-search-contract.md); callers supply result
data and selection behavior, so the design package never imports an app router or search service.

## Interface

- `items` carry a stable `value`, searchable string copy, optional group/keywords/icon/key legend,
  and a disabled state. Labels stay strings because they are both the accessible option name and
  the default filter corpus.
- Open state and query each support controlled and uncontrolled use. `onSelect` receives the full
  item; navigation remains app-owned.
- `disabled` renders the trigger as a disabled control rather than removing it, and closes the
  `⌘K` shortcut. An affordance that vanishes reads as a broken surface, not an unavailable one.
- The default filter preserves caller order and matches label, description and keywords. A caller
  with server-ranked results passes `filter={() => true}` and replaces `items` as results arrive.
- All user copy is caller-owned (`title`, `placeholder`, `emptyLabel`, `loadingLabel`, every
  `scopes[].label`, `scopeHintLabel`). The shared package does not choose a locale.
- `variant` picks the search field's frame, not its behavior: `flush` (default) spans the dialog
  edge to edge; `inset` boxes the field inside the dialog padding. Both share one input, one ARIA
  spine and one density ramp.
- `showSearchIcon` (default on) is a separate axis from `variant` — the leading icon is present or
  absent the same way in both frames, so a caller never has to pick a frame to get an icon.
- Density is inherited from the document-level `data-density` choice. The palette has no local
  size prop: its search field, result rows, groups, empty state and footer consume the shared
  `--s-*` / `--pop-row-y` ramps while `--tap-min` keeps every density keyboard- and pointer-safe.
  It carries no per-mode override: one formula follows the compact/normal/spacious values already
  owned by `tokens.css`, so changing the global ramp changes the palette with the rest of Kampüs.

## Caller hooks

A consumer whose keys or copy differ takes one of these rather than building a second palette —
the ARIA spine, the movement and the scroll-into-view stay here, which is the whole point of the
component. Tuval's spell palette
([`apps/tuval/src/palette/Palette.tsx`](../apps/tuval/src/palette/Palette.tsx)) is the worked
example: it used to hand-roll all of it, and #7882 folded it back onto these five.

- `onKeyDown(event, active)` runs before the palette's own key handling and receives the option
  `aria-activedescendant` currently names. `preventDefault` claims the key; anything else falls
  through to arrow / Home / End / Enter unchanged. Tuval claims `Tab` (accept the completion) and
  `Escape` (its opener owns where the caret goes back to).
- `onEnter()` is asked before Enter selects the active item. `true` spends the key on the caller's
  action; anything else leaves the default — active item wins — in place. Tuval returns whether the
  typed line parsed into a runnable spell, so an unfinished line still completes.
- `onActiveChange(active)` reports the active option, for a caller that describes it beside the
  list. It reports, it never moves the selection.
- `announcement` holds a sentence in a visually-hidden polite live region until the caller replaces
  it. The caret never leaves the field, so this is the only thing that tells a screen-reader user
  what a keystroke did; the `emptyLabel` / `loadingLabel` `role="status"` copy is separate and
  visible.
- `error` marks the field invalid and shows the message under it. It is the reply-correlated
  refusal, not a validation of the query.
- `closeOnEscape={false}` hands Escape to `onKeyDown` alone, so a caller owning focus restoration
  is not racing the dialog's own close.

`aria-expanded` follows the rendered options rather than being pinned to `true`: an empty or
loading list is not an expanded popup.

## Scope sigils

`scopes` declares the leading-sigil prefixes that narrow a search, each a `{sigil, label}` pair.
The contract fixed with [ADR 0186](../.decisions/0186-command-palette-single-search-contract.md)'s
single search surface is `@` kullanıcı, `#` pano konusu, `:` sözlük başlığı — `:` because a sözlük
entry is literally *terim: tanım*, and because the sözlük idiom `(bkz:` already ends in one. This
leaves `?` free for a help affordance.

Only a **leading** sigil counts. The palette is a mode-switching search field, not a mention-aware
editor: `AgentChatInput`'s mid-string `completionFor` regex is a different job on a different
element, and `packages/composer` ships no mention kit at all (epic #2476). Reuse the idea, never
put a contenteditable inside this input — `role="combobox"` + `aria-activedescendant` is a
different ARIA pattern than a rich-text surface.

The parsed sigil is stripped before filtering, so `filter` always receives the bare term. Narrowing
is the **default filter's** job — it keeps items whose `item.scope` matches the active sigil. A
caller that passes its own `filter` owns narrowing entirely; the palette still parses the sigil,
still fires `onScopeChange` (so a server-driven caller can swap `items` per scope), and still
renders the legend. The legend is wired to the input through `aria-describedby`, so the available
sigils reach a screen reader instead of only a sighted eye. It shares one footer row with the
`footer` slot — sigils left, key legend right — so the palette closes on a single rule, not a
stack of hint bars.

## Behavioral spine

The palette composes the shared Manti-backed `Dialog`, which owns the modal, focus trap, Escape,
outside-click dismissal and trigger-focus restoration. Its search field follows the WAI-ARIA
editable combobox with list autocomplete pattern: DOM focus stays on the input; the active option
is exposed through `aria-activedescendant`; Arrow Up/Down, Home, End and Enter operate the list.
Disabled results remain perceivable but are skipped by keyboard selection.

The active option is scrolled into view whenever it changes. This is part of the accessibility
contract for zoomed interfaces, not a visual flourish. Do not move DOM focus into result rows or
put links/buttons inside an option; selection crosses the single `onSelect` seam.

Sources: [WAI-ARIA combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/),
[WAI-ARIA modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).
