import type {Editor, JSONContent} from "@tiptap/core";
import type {ComposerContentType} from "./baseKit.ts";

/**
 * The markdown/JSON I/O surface a consumer holds — the seam that keeps tiptap's own
 * `Editor` methods (and its imports) off consumer call sites. `useComposerEditor`
 * returns one of these; every product reads and writes the editor through it, never
 * through `@tiptap` directly.
 */

/** The editor content as a ProseMirror JSON doc — aliased so consumers type `toJSON()` without importing `@tiptap`. */
export type ComposerJSON = JSONContent;

export interface SetContentOptions {
	/** v1 only parses markdown; the `ComposerContentType` literal makes any other value a compile error. */
	contentType?: ComposerContentType;
}

export interface ComposerHandle {
	/** Escape hatch: the wrapped tiptap `Editor`. Prefer the methods below — reach for this only for advanced tiptap use. */
	readonly editor: Editor;
	/** The document as a markdown string. */
	getMarkdown(): string;
	/** Replace the document from a markdown string (routes through `setContent(..., {contentType: "markdown"})`). */
	setContent(markdown: string, options?: SetContentOptions): void;
	/** The document as a ProseMirror JSON doc. */
	toJSON(): ComposerJSON;
}

export function createComposerHandle(editor: Editor): ComposerHandle {
	return {
		editor,
		getMarkdown: () => editor.getMarkdown(),
		// Default the content type to "markdown" — the only value v1 accepts — so a bare
		// setContent(md) is the common path and an explicit contentType stays type-checked.
		// No-op once the editor is torn down: tiptap's `destroy()` nulls `commandManager`, so the
		// `editor.commands` getter throws `Cannot read properties of null (reading 'commands')` — a
		// stale re-seed after a StrictMode/remount teardown hit exactly that and hard-crashed the
		// read-only mecmua reader (#2593). `isDestroyed` is the readiness signal safe to read
		// post-teardown; gating here fixes every consumer of setContent, not just one call site.
		setContent: (markdown, options) => {
			if (editor.isDestroyed) return;
			editor.commands.setContent(markdown, {contentType: options?.contentType ?? "markdown"});
		},
		toJSON: () => editor.getJSON(),
	};
}
