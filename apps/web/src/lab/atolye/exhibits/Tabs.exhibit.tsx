import {Tabs} from "@kampus/design";
import type * as React from "react";
import {defineExhibit} from "../exhibit";

function TabsDemo({variant}: {variant?: "line" | "pill" | "soft"}) {
	return (
		<Tabs
			variant={variant}
			defaultValue="genel"
			items={[
				{value: "genel", label: "Genel", content: "Genel içerik."},
				{value: "ayarlar", label: "Ayarlar", content: "Ayarlar içeriği."},
				{value: "gelismis", label: "Gelişmiş", content: "Gelişmiş içerik."},
			]}
		/>
	);
}

export const tabsExhibit = defineExhibit<React.ComponentProps<typeof TabsDemo>>({
	id: "tabs",
	title: "Tabs",
	summary: "Manti Tabs'in line, pill ve soft görünümleri.",
	component: TabsDemo,
	knobs: {
		variant: {
			kind: "enum",
			label: "Appearance",
			default: "line",
			options: [
				{value: "line", label: "Line"},
				{value: "pill", label: "Pill"},
				{value: "soft", label: "Soft"},
			],
		},
	},
});
