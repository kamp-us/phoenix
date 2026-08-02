import * as React from "react";
import {ToggleGroup} from "../../../components/ui/ToggleGroup";
import {defineExhibit} from "../exhibit";

function ToggleGroupDemo({variant}: {variant?: "primary" | "secondary" | "tertiary"}) {
	const [value, setValue] = React.useState<string[]>(["orta"]);
	return (
		<ToggleGroup
			variant={variant}
			value={value}
			onValueChange={setValue}
			className="kp-toggle-group kp-toggle-group--segmented"
			items={[
				{value: "sol", label: "Sol"},
				{value: "orta", label: "Orta"},
				{value: "sag", label: "Sağ"},
			]}
		/>
	);
}

export const toggleGroupExhibit = defineExhibit<React.ComponentProps<typeof ToggleGroupDemo>>({
	id: "toggle-group",
	title: "ToggleGroup",
	summary: "Manti ToggleGroup with Phoenix's segmented token treatment.",
	component: ToggleGroupDemo,
	knobs: {
		variant: {
			kind: "enum",
			label: "Appearance",
			default: "primary",
			options: [
				{value: "primary", label: "Primary"},
				{value: "secondary", label: "Secondary"},
				{value: "tertiary", label: "Tertiary"},
			],
		},
	},
});
