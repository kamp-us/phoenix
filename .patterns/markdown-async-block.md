# A `Markdown` block that finishes after its first paint

`@kampus/design`'s [`Markdown`](../packages/design/src/Markdown.tsx) promises that everything paints
on the first render, because its main consumer — Tuval's transcript — virtualizes rows and measures
each one after it paints
([`apps/tuval/src/shell/chat/ChatWindow.tsx`](../apps/tuval/src/shell/chat/ChatWindow.tsx)). That is
why an image renders as a link and why nothing is syntax-highlighted asynchronously.

[`MermaidBlock`](../packages/design/src/MermaidBlock.tsx) is the one block that finishes later, and
this is the shape it holds so the promise still means something. Read it before adding a second one
(KaTeX, a highlighter, an embedded preview).

## The three rules

**1. The first paint is the real content, never a placeholder.** `MermaidBlock` paints the fence
through [`CodeBlock`](../packages/design/src/CodeBlock.tsx) — the same element every other fence
gets — and swaps the diagram in when it arrives. A spinner or an empty sized box would measure at a
height the finished block never has, and the row's scroll offset would be wrong from then on. The
fallback doubles as the failure state: a fence mermaid refuses stays exactly the code block it
already was, with the reason on a line above it.

**2. The re-measure comes from the virtualizer, not from a callback out of the block.**
`@tanstack/virtual-core@3.17.8`'s `Virtualizer.measureElement` calls `this.observer.observe(node)`
on every row node it is handed, and that `ResizeObserver`'s callback runs `resizeItem` — so a row
whose border box changes after the first measure is re-measured with no cooperation from the
content. `Markdown` therefore needs no re-measure prop, and a consumer needs no `onLoad`. What the
block owes is that its own height actually changes the row's: it must not be absolutely positioned,
and it must not sit inside a fixed-height box.

**3. Ground the safety of anything that arrives as a string.** `Markdown` renders `marked`'s token
stream to React elements and never produces HTML, so it has no `innerHTML` seam to sanitize.
`MermaidBlock` reacquires one, because `mermaid.render` returns SVG as a string. That is only safe
because mermaid sanitizes its own output: at any `securityLevel` but `loose`, `render`'s
`serializeSvg` returns `DOMPurify.sanitize(code, …)` (`mermaid@11.17.2`, `dist/mermaid.core.mjs`).
The block passes `securityLevel: "strict"` explicitly rather than leaning on the default, so a
reader can find the decision. **A block that cannot cite a sanitizer in its dependency's source does
not get an `innerHTML`** — render to elements instead.

## Reading design tokens into a third-party renderer

A library that paints its own colours needs them handed over as plain colour strings, and getting
them out of the token layer takes two hops that are each easy to get wrong:

- `getComputedStyle(el).getPropertyValue("--text-secondary")` does **not** give a colour. A custom
  property's computed value is its specified value with `var()` substituted and nothing else
  evaluated (CSS Custom Properties Level 1, §3), so a token defined as `color-mix(in oklab, …)`
  reads back as that literal text. Assign the token to a real `color` on a throwaway probe inside
  the block's own host and read *that* back — then the cascade has resolved it, and it resolved
  under the host's own theme.
- The answer arrives in the space it was authored in. This repo's tokens are `oklch()`, and
  mermaid's colour library (khroma) reads hex, `rgb()` and `hsl()` only. Filling a 1×1 canvas and
  reading the pixel converts anything the engine can paint, because `getImageData` returns 8-bit
  sRGB whatever was filled.

Resolve nothing and hand the library no palette at all rather than half of one — under jsdom no
stylesheet is loaded and an unresolved `var()` reads back as the literal `var(--surface)`, which is
the check that keeps a test environment off this path entirely.

## What a test can hold

Neither jsdom nor happy-dom lays out text, so a diagram cannot be drawn in a unit test and the
palette cannot be resolved. Mock the library and assert the wiring and both fallbacks: that the
fence reaches it, that what it hands back lands in the block with the source still reachable, and
that a source it refuses stays the code block with the reason visible
([`packages/design/src/Markdown.test.tsx`](../packages/design/src/Markdown.test.tsx)). Assert the
*first* paint on the transcript side, without `waitFor` — that is the measurement contract, and a
test that waits for the finished block would pass on a broken one
([`apps/tuval/src/shell/chat/transcript-markdown.unit.test.tsx`](../apps/tuval/src/shell/chat/transcript-markdown.unit.test.tsx)).
Judging the drawn diagram is `review-ui`'s.

## Where this stops applying

Only inside `Markdown`, and only for a block whose content is derived from source already in the
document. Content that needs the network is out: it can fail slowly, it can change between renders,
and images are already excluded for exactly that reason.
