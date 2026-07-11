# @kampus/composer

The shared **headless composer base** — one tiptap-wrapped editor every kamp.us
product composes from.

## What it is

A minimal, headless rich-text base built on [tiptap](https://tiptap.dev), exposed as a
single stable surface:

- `baseKit()` — the shared StarterKit + `@tiptap/markdown` config,
- `useComposerEditor()` — a factory hook that returns a `ComposerHandle`,
- `ComposerHandle` — the markdown/JSON I/O surface (`getMarkdown()` /
  `setContent(md)` / `toJSON()`),
- `<Composer>` — a headless component that renders only the editor surface (no chrome,
  no styling opinions).

Everything a consumer needs is a **root import** from `@kampus/composer` — no deep-path
imports, and **nothing imports tiptap directly**: the handle keeps `@tiptap`'s own types
and methods off consumer call sites.

## Why it exists

kamp.us composers are **in-house** — no external editor framework (founder ruling,
epic [#2476](https://github.com/kamp-us/phoenix/issues/2476)). tiptap is the
in-house-wrapped base, wrapped **headlessly** here so every product composes from one
editor definition and **consumers never import tiptap directly**. v1 is emergent:
`baseKit()` only (StarterKit + `@tiptap/markdown`), no speculative tagging / embedding
/ mention kits (design [#2464](https://github.com/kamp-us/phoenix/issues/2464)).

`react` / `react-dom` are `peerDependencies` — the base does not own React; the
consuming app does.

## How to use it

```tsx
import {Composer, useComposerEditor} from "@kampus/composer";

function MyComposer() {
	const composer = useComposerEditor({
		content: "# merhaba\n\nbir **paragraf**.", // seed markdown
		onUpdate: () => rerender(),                // fires per transaction
	});

	// markdown / JSON out (guard the not-yet-mounted null)
	const markdown = composer ? composer.getMarkdown() : "";
	const json = composer ? composer.toJSON() : null;

	// markdown in
	function load(md: string) {
		composer?.setContent(md);
	}

	// the headless surface — supply your own class for chrome/CSS
	return <Composer composer={composer} className="my-editor" />;
}
```

### Surface

| export                | what it is                                                            |
| --------------------- | -------------------------------------------------------------------- |
| `useComposerEditor`   | factory hook → `ComposerHandle \| null` wired to `baseKit()`         |
| `ComposerHandle`      | the I/O handle: `getMarkdown()` / `setContent(md)` / `toJSON()`      |
| `Composer`            | headless `<EditorContent>` wrapper taking the handle (no chrome)     |
| `baseKit`             | the shared editor config (StarterKit + Markdown, markdown I/O)       |
| `BaseKitOptions`      | the `baseKit()` return type                                          |
| `UseComposerEditorOptions` | the hook options (`content`, `onUpdate`)                         |
| `ComposerProps`       | the `<Composer>` props                                               |
| `ComposerContentType` | `"markdown"` — the only content type v1 accepts (see below)          |
| `ComposerJSON`        | the ProseMirror JSON doc type `toJSON()` returns                     |
| `SetContentOptions`   | `setContent()`'s options (`{contentType?}`)                          |
| `renderTestMarkdown`  | the canonical render-test fixture (see below)                        |

`useComposerEditor` returns `null` until the editor mounts (SSR / first render) — guard
it, as the example does.

## Consuming it (mecmua / sözlük / pano adoption path)

A second consumer adopts the base cold — no need to re-derive the wiring from
[`/lab/composer`](../../apps/web/src/pages/LabComposerPage.tsx)'s source. The pattern is
identical everywhere: hold the `ComposerHandle`, render `<Composer>`, and read/write
markdown through the handle. A product supplies only its own chrome and persistence.

```tsx
import {Composer, useComposerEditor} from "@kampus/composer";
import {useState} from "react";

// e.g. mecmua's entry editor — the composer is the base; the save button + styling are the product.
function MecmuaEntryEditor({initialMarkdown, onSave}: {initialMarkdown: string; onSave: (md: string) => void}) {
	const composer = useComposerEditor({content: initialMarkdown});
	const [, setRev] = useState(0);

	return (
		<div className="mecmua-entry">
			<Composer composer={composer} className="mecmua-entry__body" />
			<button
				type="button"
				onClick={() => composer && onSave(composer.getMarkdown())}
				onMouseDown={() => setRev((n) => n + 1)}
			>
				kaydet
			</button>
		</div>
	);
}
```

Markdown is the source of truth the product persists (`getMarkdown()`); `toJSON()` is
available when a product wants the structural doc as a render-fast cache. A composer draft
that writes a fanned entity must publish the `/fate/live` invalidation and be classified in
`apps/web/worker/features/fate-live/fanned-mutations.ts` — the base owns editing, the
product owns persistence.

## Emergent discipline — one kit, markdown only

v1 is deliberately **`baseKit()`-only** and stores **markdown only** — StarterKit's common
nodes plus `@tiptap/markdown`, nothing more. This is enforced in code, not just documented:
`baseKit()` is the single exported kit, and `ComposerContentType` narrows tiptap's
`'json' | 'html' | 'markdown'` to the `"markdown"` literal, so a call site that reaches for
another content type is a **compile error** (`pnpm typecheck` fails).

Speculative marks — tagging, embedding, `@mentions` — are **not** built here (design
[#2464](https://github.com/kamp-us/phoenix/issues/2464) founder ruling). When a real
consumer needs one (rule of three), it slots in as a **new named kit** alongside `baseKit()`
(e.g. a `mentionKit()` returning its own `Extensions`), composed by that consumer's own
`useEditor` wiring — never by widening `baseKit()` itself. Until then, the surface stays
emergent.

## Render-test fixture — `renderTestMarkdown`

`renderTestMarkdown` is a shared markdown document exercising every block + inline element
`baseKit()` round-trips — headings h1–h6, bold/italic/strikethrough, inline + fenced code,
ordered/unordered/nested lists, plain + nested blockquotes, horizontal rule, and links. It is
the **single source** for that content: [`/lab/composer`](../../apps/web/src/pages/LabComposerPage.tsx)
seeds its playground from it and the base's round-trip test drives it, so the public render
checklist and the base fixture can never drift. A downstream consumer (mecmua / sözlük / pano)
reuses it to prove the base round-trips before depending on it.

Task-lists and tables are **not** in the fixture — the v1 set is StarterKit-only, which ships
no such node, so they'd be dropped by the markdown parser rather than round-trip; they land here
only when a kit that round-trips them does (the emergent discipline above).

## First consumer

[`/lab/composer`](../../apps/web/src/pages/LabComposerPage.tsx) is the live proof —
kept + canonical under the `/lab/*` public convention
([#2469](https://github.com/kamp-us/phoenix/issues/2469) / PR #2474).
