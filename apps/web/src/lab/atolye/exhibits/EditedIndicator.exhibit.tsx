import type * as React from "react";
import {EditedIndicator} from "../../../components/ui/EditedIndicator";
import {defineExhibit} from "../exhibit";

// `createdAt` is pinned; `updatedAt` is the knob. When the two land within the
// 60s edit grace window the indicator renders nothing — the boundary is felt by
// editing the timestamp.
export const editedIndicatorExhibit = defineExhibit<React.ComponentProps<typeof EditedIndicator>>({
	id: "edited-indicator",
	title: "Düzenlendi İşareti",
	summary: "Bir içerik düzenlendiğinde beliren, tarihini ipucu olarak taşıyan sessiz işaret.",
	component: EditedIndicator,
	knobs: {
		updatedAt: {kind: "string", label: "Güncellenme", default: "2026-01-02T12:00:00Z"},
	},
	fixedProps: {createdAt: "2026-01-01T09:00:00Z"},
});
