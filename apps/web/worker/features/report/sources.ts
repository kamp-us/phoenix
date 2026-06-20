/**
 * Report fate source — `ReportReceipt` has NO fetch path: it is the
 * `report.submit` ack, returned inline by the mutation and never read by id (a
 * report is private moderation state, ADR 0082). `syntheticSource` registers the
 * entity so source-completeness validation accepts it (it's view-reachable as
 * the mutation's result type) with ZERO capabilities; any capability call fails
 * loudly. Mirrors `Contribution` — the escape hatch in
 * `.patterns/fate-effect-sources.md`.
 */
import {Fate} from "@kampus/fate-effect";
import {OpenReportView, ReportReceiptView, ResolveReceiptView} from "./views.ts";

export const reportReceiptSource = Fate.syntheticSource(ReportReceiptView);
// `OpenReport` is delivered inline by the `report.listOpen` list resolver and
// `ResolveReceipt` by the `report.resolve` mutation — neither is read by id, so
// both are capability-less synthetic sources (view-reachable, no fetch path).
export const openReportSource = Fate.syntheticSource(OpenReportView);
export const resolveReceiptSource = Fate.syntheticSource(ResolveReceiptView);
