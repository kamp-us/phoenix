import type * as React from "react";
import {Card} from "../../../components/ui/Card";
import {defineExhibit} from "../exhibit";

export const cardExhibit = defineExhibit<React.ComponentProps<typeof Card>>({
	id: "card",
	title: "Card",
	summary: "Bordered, subtly raised surface — with tone, elevation, corner, and padding tokens.",
	component: Card,
	knobs: {
		tone: {
			kind: "enum",
			label: "Tone",
			default: "default",
			options: [
				{value: "default", label: "Default"},
				{value: "raised", label: "Raised"},
				{value: "sunken", label: "Sunken"},
			],
		},
		elevation: {
			kind: "enum",
			label: "Elevation",
			default: "raised",
			options: [
				{value: "flat", label: "Flat"},
				{value: "raised", label: "Raised"},
				{value: "dropdown", label: "Dropdown"},
				{value: "overlay", label: "Overlay"},
			],
		},
		radius: {
			kind: "enum",
			label: "Corner",
			default: "md",
			options: [
				{value: "none", label: "None"},
				{value: "sm", label: "Small"},
				{value: "md", label: "Medium"},
				{value: "lg", label: "Large"},
			],
		},
		padding: {
			kind: "enum",
			label: "Padding",
			default: "md",
			options: [
				{value: "none", label: "None"},
				{value: "sm", label: "Small"},
				{value: "md", label: "Medium"},
				{value: "lg", label: "Large"},
			],
		},
		border: {kind: "boolean", label: "Border", default: true},
		interactive: {kind: "boolean", label: "Interactive", default: false},
	},
	fixedProps: {children: "Kartın içeriği burada yer alır."},
});
