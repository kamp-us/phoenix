import {ReviewBadge} from "@kampus/design";
import type * as React from "react";
import {defineExhibit} from "../exhibit";

export const reviewBadgeExhibit = defineExhibit<React.ComponentProps<typeof ReviewBadge>>({
	id: "review-badge",
	title: "ReviewBadge",
	summary: "The “in review” badge a rookie sees on their own content inside their sandbox.",
	component: ReviewBadge,
	knobs: {},
});
