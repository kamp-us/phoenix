import type * as React from "react";
import {CopyLinkButton} from "../../../components/ui/CopyLinkButton";
import {defineExhibit} from "../exhibit";

export const copyLinkButtonExhibit = defineExhibit<React.ComponentProps<typeof CopyLinkButton>>({
	id: "copy-link-button",
	title: "Bağlantı Kopyala",
	summary: "Öğenin bağlantısını panoya kopyalar; tıklayınca yerinde geri bildirim verir.",
	component: CopyLinkButton,
	knobs: {
		path: {kind: "string", label: "Yol", default: "/pano/ornek"},
		label: {kind: "string", label: "Etiket", default: "paylaş"},
	},
});
