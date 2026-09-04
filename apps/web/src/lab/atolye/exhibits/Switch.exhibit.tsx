import {Switch} from "@kampus/design";
import type * as React from "react";
import {defineExhibit} from "../exhibit";

export const switchExhibit = defineExhibit<React.ComponentProps<typeof Switch>>({
	id: "switch",
	title: "Switch",
	summary: "Manti Switch ile iki durumlu seçim.",
	component: Switch,
	knobs: {
		defaultChecked: {kind: "boolean", label: "On", default: true},
		disabled: {kind: "boolean", label: "Disabled", default: false},
	},
	fixedProps: {children: "Bildirimler"},
});
