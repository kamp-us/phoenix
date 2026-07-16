import type * as React from "react";
import {CountToggle} from "../../../components/ui/CountToggle";
import {defineExhibit} from "../exhibit";

export const countToggleExhibit = defineExhibit<React.ComponentProps<typeof CountToggle>>({
	id: "count-toggle",
	title: "CountToggle",
	summary:
		"A reaction pill carrying its pressed state via aria-pressed and an accent tint, with a count badge.",
	component: CountToggle,
	knobs: {
		pressed: {kind: "boolean", label: "Pressed", default: false},
		count: {kind: "number", label: "Count", default: 12, min: 0, step: 1},
		showZero: {kind: "boolean", label: "Show zero", default: false},
		disabled: {kind: "boolean", label: "Disabled", default: false},
	},
	fixedProps: {icon: "♥", children: "beğen", "aria-label": "beğen"},
});
