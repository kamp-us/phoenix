import type * as React from "react";
import {Tooltip} from "../../../components/ui/Tooltip";
import {defineExhibit} from "../exhibit";

export const tooltipExhibit = defineExhibit<React.ComponentProps<typeof Tooltip>>({
	id: "tooltip",
	title: "İpucu",
	summary: "Bir tetikleyicinin üstüne konumlanan kısa açıklama balonu — dört yönde.",
	component: Tooltip,
	knobs: {
		side: {
			kind: "enum",
			label: "Yön",
			default: "top",
			options: [
				{value: "top", label: "Üst"},
				{value: "right", label: "Sağ"},
				{value: "bottom", label: "Alt"},
				{value: "left", label: "Sol"},
			],
		},
		defaultOpen: {kind: "boolean", label: "Açık başlat", default: true},
	},
	fixedProps: {content: "Kısa bir ipucu metni.", children: "üzerine gel"},
});
