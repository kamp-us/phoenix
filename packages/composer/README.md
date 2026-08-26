# @kampus/composer

The shared **headless composer base** — one tiptap-wrapped editor (an editable
composer and a read-only reader over the same render path) every kamp.us product
composes from.

## What it is

A minimal, headless rich-text base built on [tiptap](https://tiptap.dev), exposed
as a single stable surface of root imports from `@kampus/composer` — no deep-path
imports, and **nothing imports tiptap directly**: the handle keeps `@tiptap`'s own
types and methods off consumer call sites.

- `baseKit()` — the shared StarterKit + `@tiptap/markdown` config; the only kit v1 ships,
- `useComposerEditor()` — a factory hook that returns a `ComposerHandle | null`,
- `ComposerHandle` — the markdown/JSON I/O surface (`getMarkdown()` /
  `setContent(md)` / `toJSON()`, plus an `editor` escape hatch),
- `<Composer>` — a headless component that renders only the editor surface (no chrome,
  no styling opinions),
- `<ReadOnlyComposer>` — the same baseKit path with editing switched off: renders
  stored markdown non-editably (the mecmua reader half, #2581),
- `renderTestMarkdown` — the canonical render-test fixture every element round-trips.

## Why it exists

kamp.us composers are **in-house** — no external editor framework (founder ruling,
epic [#2476](https://github.com/kamp-us/phoenix/issues/2476)). tiptap is the
in-house-wrapped base, wrapped **headlessly** here so every product composes from one
editor definition and **consumers never import tiptap directly**.

Read and write share **one render path**: `<ReadOnlyComposer>` is the editor with
`editable: false`, so a rendered post body and the editor that produced it cannot
re-diverge (the two-render-path bug #2578, closed structurally by #2581).

v1 is emergent, enforced in code rather than convention:

- **One kit, markdown only.** `baseKit()` (StarterKit + `@tiptap/markdown`) is the
  single exported kit, no speculative tagging / embedding / mention kits (design
  [#2464](https://github.com/kamp-us/phoenix/issues/2464)). `ComposerContentType`
  narrows tiptap's `'json' | 'html' | 'markdown'` to the `"markdown"` literal, so a
  call site reaching for another content type is a **compile error**.
- **No styling opinions.** The base renders only the contenteditable (or read-only)
  region; chrome and CSS live app-side via `className`.

Speculative marks slot in later as a **new named kit** alongside `baseKit()` (e.g. a
`mentionKit()`), composed by that consumer's own wiring — never by widening
`baseKit()` itself (rule of three).

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

	// markdown in — a no-op once the editor instance is torn down (#2593)
	function load(md: string) {
		composer?.setContent(md);
	}

	// the headless surface — supply your own class for chrome/CSS
	return <Composer composer={composer} className="my-editor" />;
}
```

To render stored markdown without editing affordances, use the reader half — it owns
its own handle and re-seeds when `content` changes:

```tsx
import {ReadOnlyComposer} from "@kampus/composer";

function PostBody({markdown}: {markdown: string}) {
	return <ReadOnlyComposer content={markdown} className="post-body" />;
}
```

A second consumer adopts the base cold: hold the `ComposerHandle`, render
`<Composer>`, and read/write markdown through the handle. A product supplies only its
own chrome and persistence — markdown is the source of truth the product persists
(`getMarkdown()`); `toJSON()` is available when a product wants the structural doc as
a render-fast cache. A composer draft that writes a fanned entity must publish the
`/fate/live` invalidation and be classified in
[`apps/web/worker/features/fate-live/fanned-mutations.ts`](../../apps/web/worker/features/fate-live/fanned-mutations.ts)
— the base owns editing, the product owns persistence.

[`/lab/composer`](../../apps/web/src/pages/LabComposerPage.tsx) is the live proof of
the whole surface — kept + canonical under the `/lab/*` public convention
([#2469](https://github.com/kamp-us/phoenix/issues/2469) / PR #2474).

## Surface

| export                | what it is                                                            |
| --------------------- | -------------------------------------------------------------------- |
| `useComposerEditor`   | factory hook → `ComposerHandle \| null` wired to `baseKit()`; options are `content?`, `onUpdate?`, and `editable?` (`false` gives the read-only mode) |
| `UseComposerEditorOptions` | the hook options (`content`, `onUpdate`, `editable`)             |
| `ComposerHandle`      | the I/O handle: `getMarkdown()` / `setContent(md)` / `toJSON()`, plus the raw `editor` escape hatch for advanced tiptap use |
| `Composer`            | headless `<EditorContent>` wrapper taking the handle (no chrome)     |
| `ComposerProps`       | the `<Composer>` props                                               |
| `ReadOnlyComposer`    | the reader half: same baseKit path, `editable: false`; re-seeds on `content` change |
| `ReadOnlyComposerProps` | the `<ReadOnlyComposer>` props (`content`, `className`)            |
| `baseKit`             | the shared editor config (StarterKit + Markdown, markdown I/O)       |
| `BaseKitOptions`      | the `baseKit()` return type                                          |
| `ComposerContentType` | `"markdown"` — the only content type v1 accepts                      |
| `ComposerJSON`        | the ProseMirror JSON doc type `toJSON()` returns                     |
| `SetContentOptions`   | `setContent()`'s options (`{contentType?}`)                          |
| `renderTestMarkdown`  | the canonical render-test fixture (see below)                        |

`useComposerEditor` returns `null` until the editor mounts (SSR / first render) — guard
it, as the example does. Once an editor instance is destroyed (StrictMode/remount
teardown), further `setContent` calls on its stale handle are a **no-op**, not a crash
(#2593); remount and use the fresh handle instead.

### Render-test fixture

`renderTestMarkdown` exercises every block + inline element `baseKit()` round-trips —
headings h1–h6, bold/italic/strikethrough, inline + fenced code,
ordered/unordered/nested lists, plain + nested blockquotes, horizontal rule, and links.
It is the **single source** for that content:
[`/lab/composer`](../../apps/web/src/pages/LabComposerPage.tsx) seeds its playground from
it and the base's round-trip test drives it, so the public render checklist and the base
fixture can never drift.

Task-lists and tables are **not** in the fixture — the v1 set is StarterKit-only, which
ships no such node, so they'd be dropped by the markdown parser rather than round-trip;
they land here only when a kit that round-trips them does.

## Testing

`pnpm test` in this package runs the vitest suite: the pinned public-export surface,
markdown round-trip + `toJSON()` through the handle, the read-only mode's serialization
parity with the editable path, `setContent` teardown readiness, and the render tests
over `renderTestMarkdown`. `pnpm typecheck` asserts the compile-error guarantees
(non-markdown content types don't type).
