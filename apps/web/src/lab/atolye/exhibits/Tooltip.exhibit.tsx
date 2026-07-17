import type * as React from "react";
import {Tooltip} from "../../../components/ui/Tooltip";
import {defineExhibit} from "../exhibit";

export const tooltipExhibit = defineExhibit<React.ComponentProps<typeof Tooltip>>({
	id: "tooltip",
	title: "Tooltip",
	summary: "A short description bubble positioned above a trigger — in four directions.",
	component: Tooltip,
	knobs: {
		side: {
			kind: "enum",
			label: "Side",
			default: "top",
			options: [
				{value: "top", label: "Top"},
				{value: "right", label: "Right"},
				{value: "bottom", label: "Bottom"},
				{value: "left", label: "Left"},
			],
		},
		defaultOpen: {kind: "boolean", label: "Start open", default: true},
	},
	fixedProps: {content: "Kısa bir ipucu metni.", children: "üzerine gel"},
});
