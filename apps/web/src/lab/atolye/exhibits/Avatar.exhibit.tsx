import type * as React from "react";
import {Avatar} from "../../../components/ui/Avatar";
import {defineExhibit} from "../exhibit";

export const avatarExhibit = defineExhibit<React.ComponentProps<typeof Avatar>>({
	id: "avatar",
	title: "Avatar",
	summary: "User avatar — falls back to name initials when there is no image, in four sizes.",
	component: Avatar,
	knobs: {
		name: {kind: "string", label: "Name", default: "Ada Lovelace"},
		src: {kind: "string", label: "Image URL", default: "", placeholder: "empty → initials"},
		size: {
			kind: "enum",
			label: "Size",
			default: "md",
			options: [
				{value: "sm", label: "Small"},
				{value: "md", label: "Medium"},
				{value: "lg", label: "Large"},
				{value: "xl", label: "Extra large"},
			],
		},
	},
});
