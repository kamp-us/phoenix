import type {Extensions} from "@tiptap/core";
import {Markdown} from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

/**
 * The one content type v1 stores. Narrowing tiptap's `'json' | 'html' | 'markdown'`
 * to the single `"markdown"` literal is the code-level assertion that the base is
 * markdown-only (epic #2476 emergent ruling): a call site that tries another content
 * type is a compile error, not a runtime surprise. Widen this only when a real
 * consumer forces it (rule of three) — see README "Emergent discipline".
 */
export type ComposerContentType = "markdown";

export interface BaseKitOptions {
	extensions: Extensions;
	contentType: ComposerContentType;
}

/**
 * The shared editor config every composer starts from: StarterKit for the common
 * block/inline nodes, plus `@tiptap/markdown` (which alone provides `getMarkdown()`
 * + `contentType: "markdown"` parsing — StarterKit leaves `# foo` as literal text)
 * so all I/O is markdown strings. This is the *only* kit v1 ships — emergent, no
 * speculative tagging/embedding/mention kits (epic #2476 founder ruling).
 */
export function baseKit(): BaseKitOptions {
	return {
		extensions: [StarterKit, Markdown],
		contentType: "markdown",
	};
}
