/** report's contribution to the one fate config. See `../fate/module.ts`. */
import {list} from "@nkzw/fate/server";
import type {FateModule, FateRootsRecord} from "../fate/module.ts";
import {lists} from "./lists.ts";
import {mutations} from "./mutations.ts";
import {
	openReportSource,
	reportReceiptSource,
	resolvedReportSource,
	resolveReceiptSource,
} from "./sources.ts";
import {openReportDataView, resolvedReportDataView} from "./views.ts";

const roots: FateRootsRecord = {
	// The moderation queue (ADR 0098) — a `Moderate`-capability-gated list root (the
	// `moderates` relation tuple, ADR 0107 §4); the
	// `report.listOpen` resolver owns the oldest-first order.
	"report.listOpen": list(openReportDataView),
	// The shared decision feed (#1704) — a `Moderate`-gated list root over recently
	// resolved/dismissed targets; the `report.listResolved` resolver owns the
	// newest-decision-first order.
	"report.listResolved": list(resolvedReportDataView),
};

export const fateModule = {
	lists,
	mutations,
	sources: [reportReceiptSource, openReportSource, resolvedReportSource, resolveReceiptSource],
	roots,
} satisfies FateModule;
