import type * as React from "react";
import {Button} from "../../../components/ui/Button";
import {defineExhibit} from "../exhibit";

/**
 * The worked exemplar — proves the harness end to end: an enum knob per literal-union prop
 * (`variant`/`size`), a boolean knob per flag, and `children` pinned as a fixed prop because
 * `ReactNode` is not knobbable. Every later exhibit (#3094/#3095) follows this shape.
 */
export const buttonExhibit = defineExhibit<React.ComponentProps<typeof Button>>({
	id: "button",
	title: "Button",
	summary: "Primary action button — with appearance, size, and state variants.",
	component: Button,
	knobs: {
		variant: {
			kind: "enum",
			label: "Appearance",
			default: "primary",
			options: [
				{value: "primary", label: "Primary"},
				{value: "secondary", label: "Secondary"},
				{value: "tertiary", label: "Tertiary"},
				{value: "danger", label: "Danger"},
			],
		},
		size: {
			kind: "enum",
			label: "Size",
			default: "md",
			options: [
				{value: "sm", label: "Small"},
				{value: "md", label: "Medium"},
				{value: "lg", label: "Large"},
			],
		},
		pressed: {kind: "boolean", label: "Pressed", default: false},
		loading: {kind: "boolean", label: "Loading", default: false},
		block: {kind: "boolean", label: "Full width", default: false},
		disabled: {kind: "boolean", label: "Disabled", default: false},
	},
	fixedProps: {children: "Kaydet"},
});
