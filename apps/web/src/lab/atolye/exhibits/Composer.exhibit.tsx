/**
 * The composer exhibit — atölye's first FEATURE-level exhibit (beyond the UI primitives):
 * the shared `@kampus/composer` editor folded in as a live, knob-driven piece (#3095).
 *
 * This module is deliberately tiptap-free: the heavy demo is `React.lazy`-loaded from
 * `Composer.exhibit.live` so the atölye registry/index chunk never pays for ProseMirror
 * (the #2523 performance-pillar split). The standalone `/lab/composer` route stays the
 * canonical full round-trip playground (documented NOT-throwaway); this exhibit shows a
 * focused live demo and links out to it — it does not embed or regress that proof.
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
