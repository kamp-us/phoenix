import type * as React from "react";
import {Button} from "../../../components/ui/Button";
import {EmptyState} from "../../../components/ui/EmptyState";
import {defineExhibit} from "../exhibit";

// Every slot is a ReactNode, so none is knobbable — the prop space is exercised
// through `fixedProps` (icon + title + description + action), not on-screen knobs.
export const emptyStateExhibit = defineExhibit<React.ComponentProps<typeof EmptyState>>({
	id: "empty-state",
	title: "Boş Durum",
	summary: "Seyrek bir alanın boşluk yerine gösterdiği ortalanmış blok — ikon, başlık, eylem.",
	component: EmptyState,
	knobs: {},
	fixedProps: {
		icon: "🗒️",
		title: "Henüz gönderi yok",
		description: "İlk gönderiyi paylaşan sen ol.",
		action: (
			<Button variant="primary" size="sm">
				Gönderi oluştur
			</Button>
		),
	},
});
