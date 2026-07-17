import type * as React from "react";
import {ReportButton} from "../../../components/ui/ReportButton";
import {defineExhibit} from "../exhibit";

// `onReport` is a callback (non-knobbable) — pinned to a stub that resolves
// `reported`, so the button's in-flight lock and confirmation feedback can be felt.
export const reportButtonExhibit = defineExhibit<React.ComponentProps<typeof ReportButton>>({
	id: "report-button",
	title: "ReportButton",
	summary: "Reports an item; on click it locks and switches to a “reported” confirmation.",
	component: ReportButton,
	knobs: {},
	fixedProps: {onReport: async () => "reported" as const},
});
