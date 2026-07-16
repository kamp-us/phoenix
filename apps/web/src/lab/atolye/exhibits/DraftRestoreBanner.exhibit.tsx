import type * as React from "react";
import {DraftRestoreBanner} from "../../../components/ui/DraftRestoreBanner";
import {defineExhibit} from "../exhibit";

// `onRestore`/`onDismiss` are callbacks (non-knobbable) — pinned to no-ops so the
// banner's two-button landmark can be rendered on its own.
export const draftRestoreBannerExhibit = defineExhibit<
	React.ComponentProps<typeof DraftRestoreBanner>
>({
	id: "draft-restore-banner",
	title: "Taslak Geri Yükleme",
	summary: "Auth turundan sonra kurtulan taslağı sunar; sessizce geri enjekte etmez.",
	component: DraftRestoreBanner,
	knobs: {},
	fixedProps: {onRestore: () => {}, onDismiss: () => {}},
});
