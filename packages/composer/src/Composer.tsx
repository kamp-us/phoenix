import {EditorContent} from "@tiptap/react";
import type {ComposerHandle} from "./handle.ts";

export interface ComposerProps {
	/** The handle from `useComposerEditor` — `null` until the editor mounts. */
	composer: ComposerHandle | null;
	/** App-supplied class for the editor surface — the base ships no styling of its own. */
	className?: string;
}

/**
 * The headless editor surface — a thin wrap of tiptap's `EditorContent` with zero app
 * chrome and no styling opinions. Takes the `ComposerHandle` (not a raw `Editor`) so a
 * consumer passes the same value it holds everywhere else. All chrome (masthead, panels)
 * and CSS live app-side; the base only renders the contenteditable region.
 */
export function Composer({composer, className}: ComposerProps) {
	return <EditorContent editor={composer?.editor ?? null} className={className} />;
}
