import {Tooltip} from "@kampus/design";
import type * as React from "react";
import {defineExhibit} from "../exhibit";

export const tooltipExhibit = defineExhibit<React.ComponentProps<typeof Tooltip>>({
	id: "tooltip",
	title: "Tooltip",
	summary: "Manti Tooltip ile kısa açıklama balonu.",
	component: Tooltip,
	knobs: {},
	fixedProps: {content: "Kısa bir ipucu metni.", children: "üzerine gel"},
});
