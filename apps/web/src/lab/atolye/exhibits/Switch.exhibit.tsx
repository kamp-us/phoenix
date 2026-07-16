import type * as React from "react";
import {Switch} from "../../../components/ui/Switch";
import {defineExhibit} from "../exhibit";

export const switchExhibit = defineExhibit<React.ComponentProps<typeof Switch>>({
	id: "switch",
	title: "Switch",
	summary: "A two-state on/off switch — built on base-ui Switch, with role tokens.",
	component: Switch,
	knobs: {
		defaultChecked: {kind: "boolean", label: "On", default: true},
		disabled: {kind: "boolean", label: "Disabled", default: false},
	},
	fixedProps: {"aria-label": "Bildirimler"},
});
