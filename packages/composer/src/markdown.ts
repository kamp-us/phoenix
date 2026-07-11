import type {Editor, JSONContent} from "@tiptap/core";

/**
 * Markdown-string + JSON I/O over the editor handle — the seam that keeps tiptap's
 * own methods off consumer call sites. `getMarkdown`/`getJSON` are the augmented
 * `@tiptap/markdown` surface (see baseKit); `setMarkdown` routes through
 * `setContent(..., {contentType: "markdown"})` so a raw markdown string parses
 * rather than landing as literal text.
 */
export function getMarkdown(editor: Editor): string {
	return editor.getMarkdown();
}

export function setMarkdown(editor: Editor, markdown: string): void {
	editor.commands.setContent(markdown, {contentType: "markdown"});
}

export function getJSON(editor: Editor): JSONContent {
	return editor.getJSON();
}
