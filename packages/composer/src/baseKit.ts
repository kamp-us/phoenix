import type {Extensions} from "@tiptap/core";
import {Markdown} from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

export interface BaseKitOptions {
	extensions: Extensions;
	contentType: "markdown";
}

/**
 * The shared editor config every composer starts from: StarterKit for the common
 * block/inline nodes, plus `@tiptap/markdown` (which alone provides `getMarkdown()`
 * + `contentType: "markdown"` parsing — StarterKit leaves `# foo` as literal text)
 * so all I/O is markdown strings. v1 is emergent — baseKit only, no speculative
 * tagging/embedding/mention kits (epic #2476 founder ruling).
 */
export function baseKit(): BaseKitOptions {
	return {
		extensions: [StarterKit, Markdown],
		contentType: "markdown",
	};
}
