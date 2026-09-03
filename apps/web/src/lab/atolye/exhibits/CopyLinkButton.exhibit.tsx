import {CopyLinkButton} from "@kampus/design";
import type * as React from "react";
import {defineExhibit} from "../exhibit";

export const copyLinkButtonExhibit = defineExhibit<React.ComponentProps<typeof CopyLinkButton>>({
	id: "copy-link-button",
	title: "CopyLinkButton",
	summary: "Copies an item's link to the clipboard; gives inline feedback on click.",
	component: CopyLinkButton,
	knobs: {
		path: {kind: "string", label: "Path", default: "/pano/ornek"},
		label: {kind: "string", label: "Label", default: "paylaş"},
	},
});
