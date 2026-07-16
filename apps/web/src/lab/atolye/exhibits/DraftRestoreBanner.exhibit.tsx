import type * as React from "react";
import {DraftRestoreBanner} from "../../../components/ui/DraftRestoreBanner";
import {defineExhibit} from "../exhibit";

// `onRestore`/`onDismiss` are callbacks (non-knobbable) — pinned to no-ops so the
// banner's two-button landmark can be rendered on its own.
export const draftRestoreBannerExhibit = defineExhibit<
	React.ComponentProps<typeof DraftRestoreBanner>
>({
	id: "draft-restore-banner",
	title: "DraftRestoreBanner",
	summary: "Offers a draft recovered after the auth round-trip; never silently re-injects it.",
	component: DraftRestoreBanner,
	knobs: {},
	fixedProps: {onRestore: () => {}, onDismiss: () => {}},
});
