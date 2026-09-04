import {DraftRestoreBanner} from "@kampus/design";
import type * as React from "react";
import {defineExhibit} from "../exhibit";

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
