import type * as React from "react";
import {ReviewBadge} from "../../../components/ui/ReviewBadge";
import {defineExhibit} from "../exhibit";

export const reviewBadgeExhibit = defineExhibit<React.ComponentProps<typeof ReviewBadge>>({
	id: "review-badge",
	title: "ReviewBadge",
	summary: "The “in review” badge a rookie sees on their own content inside their sandbox.",
	component: ReviewBadge,
	knobs: {},
});
