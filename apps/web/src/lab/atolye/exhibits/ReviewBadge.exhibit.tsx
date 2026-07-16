import type * as React from "react";
import {ReviewBadge} from "../../../components/ui/ReviewBadge";
import {defineExhibit} from "../exhibit";

// Propsuz bir rozet — durumu rengiyle değil, kelimesiyle taşır; knob yok.
export const reviewBadgeExhibit = defineExhibit<React.ComponentProps<typeof ReviewBadge>>({
	id: "review-badge",
	title: "İnceleme Rozeti",
	summary: "Bir çaylağın kendi kum havuzundaki içeriğinde gördüğü “incelemede” rozeti.",
	component: ReviewBadge,
	knobs: {},
});
