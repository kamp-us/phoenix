import type * as React from "react";
import {ReportButton} from "../../../components/ui/ReportButton";
import {defineExhibit} from "../exhibit";

// `onReport` is a callback (non-knobbable) — pinned to a stub that resolves
// `reported`, so the button's in-flight lock and confirmation feedback can be felt.
export const reportButtonExhibit = defineExhibit<React.ComponentProps<typeof ReportButton>>({
	id: "report-button",
	title: "Bildir Düğmesi",
	summary: "Bir öğeyi bildirir; tıklayınca kilitlenip “bildirildi” geri bildirimine geçer.",
	component: ReportButton,
	knobs: {},
	fixedProps: {onReport: async () => "reported" as const},
});
