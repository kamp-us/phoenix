import type {Editor} from "@tiptap/core";
import {EditorContent} from "@tiptap/react";

export interface ComposerProps {
	editor: Editor | null;
	/** App-supplied class for the editor surface — the base ships no styling of its own. */
	className?: string;
}

/**
 * The headless editor surface — a thin wrap of tiptap's `EditorContent` with zero app
 * chrome and no styling opinions. All chrome (masthead, panels) and CSS live app-side;
 * the base only renders the contenteditable region.
 */
export function Composer({editor, className}: ComposerProps) {
	return <EditorContent editor={editor} className={className} />;
}
