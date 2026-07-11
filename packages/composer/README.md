# @kampus/composer

The shared **headless composer base** — one tiptap-wrapped editor every kamp.us
product composes from.

## What it is

A minimal, headless rich-text base built on [tiptap](https://tiptap.dev): a shared
StarterKit config (`baseKit`), a `useComposerEditor` factory hook, markdown-string
I/O (`getMarkdown` / `setMarkdown` / `getJSON`), and a headless `<Composer>`
component that renders only the editor surface — no chrome, no styling opinions.

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
import {Composer, getJSON, getMarkdown, setMarkdown, useComposerEditor} from "@kampus/composer";

function MyComposer() {
	const editor = useComposerEditor({
		content: "# merhaba\n\nbir **paragraf**.", // seed markdown
		onUpdate: () => rerender(),                // fires per transaction
	});

	// markdown / JSON out (guard the not-yet-mounted null)
	const markdown = editor ? getMarkdown(editor) : "";
	const json = editor ? getJSON(editor) : null;

	// markdown in
	function load(md: string) {
		if (editor) setMarkdown(editor, md);
	}

	// the headless surface — supply your own class for chrome/CSS
	return <Composer editor={editor} className="my-editor" />;
}
```

### Surface

| export              | what it is                                                        |
| ------------------- | ----------------------------------------------------------------- |
| `baseKit()`         | the shared editor config (StarterKit + Markdown, markdown I/O)    |
| `useComposerEditor` | factory hook → `Editor \| null` wired to `baseKit()`              |
| `Composer`          | headless `<EditorContent>` wrapper (no chrome)                    |
| `getMarkdown`       | editor → markdown string                                          |
| `setMarkdown`       | markdown string → editor                                          |
| `getJSON`           | editor → tiptap/ProseMirror JSON doc                              |

## First consumer

[`/lab/composer`](../../apps/web/src/pages/LabComposerPage.tsx) is the live proof —
kept + canonical under the `/lab/*` public convention
([#2469](https://github.com/kamp-us/phoenix/issues/2469) / PR #2474).
