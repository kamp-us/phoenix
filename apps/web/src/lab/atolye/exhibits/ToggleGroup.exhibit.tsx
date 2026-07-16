import * as React from "react";
import {ToggleGroup} from "../../../components/ui/ToggleGroup";
import {defineExhibit} from "../exhibit";

function ToggleGroupDemo({variant}: {variant?: "pill" | "segmented" | "square" | "swatch"}) {
	const [value, setValue] = React.useState<string[]>(["orta"]);
	return (
		<ToggleGroup.Root variant={variant} value={value} onValueChange={setValue}>
			<ToggleGroup.Item value="sol">Sol</ToggleGroup.Item>
			<ToggleGroup.Item value="orta">Orta</ToggleGroup.Item>
			<ToggleGroup.Item value="sag">Sağ</ToggleGroup.Item>
		</ToggleGroup.Root>
	);
}

export const toggleGroupExhibit = defineExhibit<React.ComponentProps<typeof ToggleGroupDemo>>({
	id: "toggle-group",
	title: "Değiştirici Grubu",
	summary: "Tek seçimli segment/hap/kare varyantlarıyla değiştirici grubu — base-ui üstünde.",
	component: ToggleGroupDemo,
	knobs: {
		variant: {
			kind: "enum",
			label: "Görünüm",
			default: "segmented",
			options: [
				{value: "pill", label: "Hap"},
				{value: "segmented", label: "Segment"},
				{value: "square", label: "Kare"},
				{value: "swatch", label: "Renk"},
			],
		},
	},
});
