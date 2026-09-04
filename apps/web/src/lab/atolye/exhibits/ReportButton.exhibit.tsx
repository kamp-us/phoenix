import {ReportButton} from "@kampus/design";
import type * as React from "react";
import {defineExhibit} from "../exhibit";

export const reportButtonExhibit = defineExhibit<React.ComponentProps<typeof ReportButton>>({
	id: "report-button",
	title: "ReportButton",
	summary: "Reports an item; on click it locks and switches to a “reported” confirmation.",
	component: ReportButton,
	knobs: {},
	fixedProps: {onReport: async () => "reported" as const},
});
