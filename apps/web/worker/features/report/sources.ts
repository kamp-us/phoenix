/**
 * Every report entity is delivered inline by a resolver or mutation and never read by
 * id, so all four are capability-less `syntheticSource`s — registered for
 * source-completeness validation, with any capability call failing loudly. See the
 * escape hatch in `.patterns/fate-effect-sources.md`.
 */
import {Fate} from "@kampus/fate-effect";
import {
	OpenReportView,
	ReportReceiptView,
	ResolvedReportView,
	ResolveReceiptView,
} from "./views.ts";

export const reportReceiptSource = Fate.syntheticSource(ReportReceiptView);
export const openReportSource = Fate.syntheticSource(OpenReportView);
export const resolvedReportSource = Fate.syntheticSource(ResolvedReportView);
export const resolveReceiptSource = Fate.syntheticSource(ResolveReceiptView);
