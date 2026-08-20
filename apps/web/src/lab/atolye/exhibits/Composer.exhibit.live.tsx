// The tiptap-import boundary: a separate module so `Composer.exhibit.tsx` can `React.lazy` it and
// keep ProseMirror out of the atölye index chunk (#2523).

import {Composer, ReadOnlyComposer, useComposerEditor} from "@kampus/composer";
import {useState} from "react";
import {Link} from "react-router";

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
 * `editable` is fixed per mount (the parent remounts via `key`), so both branches run one baseKit
 * render path — editor≈reader parity, #2581.
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
