import type {Editor} from "@tiptap/core";
import {useEditor} from "@tiptap/react";
import {baseKit} from "./baseKit.ts";

export interface UseComposerEditorOptions {
	/** Seed content as a markdown string (parsed via baseKit's `contentType: "markdown"`). */
	content?: string;
	/** Fires on every editor transaction — e.g. to re-derive the live markdown/JSON views. */
	onUpdate?: () => void;
}

/**
 * The factory that wraps tiptap headlessly: `useEditor` over `baseKit()`, returning
 * the editor handle consumers pass to `<Composer>` and the markdown I/O helpers. The
 * return is `Editor | null` — null until the instance mounts — so consumers guard the
 * not-yet-ready state (SSR / first render) rather than assume it exists.
 */
export function useComposerEditor(options: UseComposerEditorOptions = {}): Editor | null {
	return useEditor({
		...baseKit(),
		...(options.content !== undefined ? {content: options.content} : {}),
		...(options.onUpdate ? {onUpdate: options.onUpdate} : {}),
	});
}
