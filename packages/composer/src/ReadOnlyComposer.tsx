import {useEffect} from "react";
import {Composer} from "./Composer.tsx";
import {useComposerEditor} from "./useComposerEditor.ts";

export interface ReadOnlyComposerProps {
	/** The markdown to render — parsed + rendered through the SAME baseKit path the editor uses. */
	content: string;
	/** App-supplied class for the render surface — the base ships no styling of its own. */
	className?: string;
}

/**
 * The reader half of editor≈reader parity (#2581): renders stored markdown through the composer's
 * own tiptap/baseKit path with editing switched off (`editable: false`), non-editable and
 * chromeless. Because read and write share this ONE render path, the two halves can't re-diverge —
 * the two-render-path bug (#2578) is structurally gone. XSS-safety comes from the baseKit
 * ProseMirror schema: markup outside the schema (a `<script>`, `onerror`/event-handler attributes,
 * arbitrary raw HTML) is dropped on parse, so untrusted stored content can't inject.
 */
export function ReadOnlyComposer({content, className}: ReadOnlyComposerProps) {
	const composer = useComposerEditor({content, editable: false});
	// The editor seeds content only at creation; re-seed on change so one mounted reader can
	// render a different post's body without a remount.
	useEffect(() => {
		if (composer) composer.setContent(content);
	}, [composer, content]);
	return <Composer composer={composer} {...(className !== undefined ? {className} : {})} />;
}
