/**
 * Deliberately tiptap-free: the demo is `React.lazy`-loaded from `Composer.exhibit.live` so the
 * atölye registry/index chunk never pays for ProseMirror (#2523). A direct import undoes that.
 */

import type * as React from "react";
import {lazy, Suspense} from "react";
import {defineExhibit} from "../exhibit";
import "./Composer.exhibit.css";

const ComposerExhibitLive = lazy(() =>
	import("./Composer.exhibit.live").then((m) => ({default: m.ComposerExhibitLive})),
);

// Remount on the readOnly flip so `editable` is fixed per mount — the editor≈reader parity
// path (#2581) branches at mount, not reactively; the `key` makes the knob toggle a remount.
function ComposerExhibitDemo({readOnly}: {readOnly?: boolean}) {
	return (
		<Suspense fallback={<p className="kp-atolye-composer__note">yükleniyor…</p>}>
			<ComposerExhibitLive key={readOnly ? "ro" : "rw"} readOnly={readOnly ?? false} />
		</Suspense>
	);
}

export const composerExhibit = defineExhibit<React.ComponentProps<typeof ComposerExhibitDemo>>({
	id: "composer",
	title: "Composer",
	summary:
		"The shared @kampus/composer editor — markdown round-trip and one read-only/editable render path.",
	component: ComposerExhibitDemo,
	knobs: {
		readOnly: {kind: "boolean", label: "Read-only", default: false},
	},
});
