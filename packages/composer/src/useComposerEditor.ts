import {useEditor} from "@tiptap/react";
import {useMemo} from "react";
import {baseKit} from "./baseKit.ts";
import {type ComposerHandle, createComposerHandle} from "./handle.ts";

export interface UseComposerEditorOptions {
	/** Seed content as a markdown string (parsed via baseKit's `contentType: "markdown"`). */
	content?: string;
	/** Fires on every editor transaction — e.g. to re-derive the live markdown/JSON views. */
	onUpdate?: () => void;
}

/**
 * The factory that wraps tiptap headlessly: `useEditor` over `baseKit()`, returning a
 * `ComposerHandle` (the markdown/JSON I/O surface + `<Composer>` wiring) instead of the
 * raw `Editor`, so consumers never touch `@tiptap`. The return is `ComposerHandle | null`
 * — null until the instance mounts — so consumers guard the not-yet-ready state (SSR /
 * first render) rather than assume it exists.
 */
export function useComposerEditor(options: UseComposerEditorOptions = {}): ComposerHandle | null {
	const editor = useEditor({
		...baseKit(),
		...(options.content !== undefined ? {content: options.content} : {}),
		...(options.onUpdate ? {onUpdate: options.onUpdate} : {}),
	});
	// Keyed on the stable editor identity so the handle only changes when the instance does.
	return useMemo(() => (editor ? createComposerHandle(editor) : null), [editor]);
}
