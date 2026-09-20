# Decorative generated content

A CSS `::before` / `::after` that renders a string is not invisible to assistive tech. Accname's
name-from-content step names pseudo-element content explicitly, so a glyph, a bracket or a bullet
drawn in `content:` is folded into the accessible name of the element it decorates. On a row whose
name comes from its children — a `role="option"`, a link, a `<button>` with no `aria-label` — that
silently rewrites the name.

**Every `content:` string in this repo carries the alternative-text form.** Write the text the
reader sees, then `/ ""` for what AT reads:

```css
.kp-command-palette__option[data-active]::before {
	content: "\203A" / "";
	color: var(--accent);
}
```

That is the standing idiom for all decorative generated content, not only for state markers — the
same rule covers the brackets around pano's domain label
([`apps/web/src/components/pano/PanoPost.css`](../apps/web/src/components/pano/PanoPost.css)) and
the palette's active-row caret
([`packages/design/src/CommandPalette.css`](../packages/design/src/CommandPalette.css)). The one
alternative is a glyph rendered on an `aria-hidden` element from the component, which has no name to
leak; picking between the two is a design call, and for a *state* marker
[ADR 0166](../.decisions/0166-canonical-icon-idiom.md) §8 makes staying out of the name a condition
of the marker's lawfulness rather than a nicety.

An empty `content: ""` needs no alt text — it renders no text, so there is nothing to fold in. That
is why the palette's reserved caret column, which exists only to hold width, is bare.

## The support floor

The alternative-text syntax is CSS Content Level 3
([`content` in the CSS Generated Content spec](https://drafts.csswg.org/css-content/#propdef-content)),
and per MDN's browser-compat-data
([`css/properties/content.json`](https://github.com/mdn/browser-compat-data/blob/main/css/properties/content.json),
key `alt_text`) it lands in **Chrome 77, Firefox 128, Safari 17.4**. Under that floor the whole
declaration is invalid and dropped, so the generated content does not render at all — the reader
loses the glyph rather than gaining a corrupted name. Where the glyph is Pillar 4's second channel
on a state, that degradation is the tradeoff the floor buys; the repo declares no browserslist and
takes it.

## What enforces it

[`packages/design/src/generated-content-alt-text.unit.test.ts`](../packages/design/src/generated-content-alt-text.unit.test.ts)
sweeps every stylesheet under `apps/web/src`, `apps/tuval/src` and `packages/design/src` and reds on
a `::before`/`::after` `content:` that renders text without alt text, naming the file, selector and
value.

A rendered test cannot see this. `dom-accessibility-api` — the accname implementation
`@testing-library` computes names with — reads pseudo-element content only when
`computedStyleSupportsPseudoElements` is set, and jsdom leaves it off, so no `*.test.tsx` in this
repo ever evaluates a `::before` at all. The stylesheet source is the only surface a test can read
the rule from, which is why the check is a source sweep rather than an assertion on a rendered name.
