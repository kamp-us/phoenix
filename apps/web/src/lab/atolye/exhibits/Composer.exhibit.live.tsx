/**
 * The composer exhibit's live demo — the tiptap-import boundary. `Composer.exhibit.tsx`
 * `React.lazy`-loads this module, so `@kampus/composer` (tiptap/ProseMirror) stays out of
 * the atölye registry/index chunk and only loads when the exhibit actually renders — the
 * same performance-pillar split the composer routes make (#2523).
 */

import {Composer, ReadOnlyComposer, useComposerEditor} from "@kampus/composer";
import {useState} from "react";
import {Link} from "react-router";

// A compact sample exercising headings, inline marks, a list, and a blockquote — enough to
// prove the editor is a real rich surface. The exhaustive round-trip fixture lives at the
// canonical `/lab/composer` playground (linked below), which this exhibit does not touch.
const SAMPLE_MARKDOWN = [
	"## Merhaba, atölye",
	"",
	"Bu **canlı** editör, *paylaşılan* `@kampus/composer` tabanının üstünde çalışır.",
	"",
	"- markdown ↔ tiptap gidiş-dönüşü",
	"- salt-okunur ile düzenlenebilir tek render yolu",
	"",
	"> Yazan ile okuyan aynı yoldan geçer.",
].join("\n");

/**
 * Editable ⇄ read-only share ONE render path (editor≈reader parity, #2581). The parent
 * remounts this on the knob flip (via `key`), so `editable` is fixed per mount and the
 * read-only branch renders through `ReadOnlyComposer` — the same baseKit path, editing off.
 */
export function ComposerExhibitLive({readOnly = false}: {readOnly?: boolean}) {
	if (readOnly) {
		return (
			<div className="kp-atolye-composer">
				<ReadOnlyComposer
					content={SAMPLE_MARKDOWN}
					className="kp-atolye-composer__surface kp-prose"
				/>
				<PlaygroundNote />
			</div>
		);
	}
	return <EditableComposer />;
}

function EditableComposer() {
	// Bumped on every transaction so the round-trip readout re-derives `getMarkdown()` live —
	// the visible proof that the editor's structural state round-trips back to markdown.
	const [rev, setRev] = useState(0);
	const composer = useComposerEditor({
		content: SAMPLE_MARKDOWN,
		onUpdate: () => setRev((n) => n + 1),
	});
	void rev;
	const markdown = composer ? composer.getMarkdown() : "";
	return (
		<div className="kp-atolye-composer">
			<Composer composer={composer} className="kp-atolye-composer__surface kp-prose" />
			<div className="kp-atolye-composer__roundtrip">
				<span className="kp-atolye-composer__roundtrip-label">getMarkdown()</span>
				<pre className="kp-atolye-composer__out">{markdown}</pre>
			</div>
			<PlaygroundNote />
		</div>
	);
}

function PlaygroundNote() {
	return (
		<p className="kp-atolye-composer__note">
			Tam markdown gidiş-dönüş oyun alanı için{" "}
			<Link to="/lab/composer" className="kp-atolye-composer__link">
				/lab/composer
			</Link>
			.
		</p>
	);
}
