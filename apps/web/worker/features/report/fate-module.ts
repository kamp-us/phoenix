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
	// Both roots are `Moderate`-capability-gated (the `moderates` relation tuple, ADR 0107 §4);
	// each resolver owns its own order — oldest-first for the queue, newest-decision-first for
	// the feed (ADR 0098, #1704).
	"report.listOpen": list(openReportDataView),
	"report.listResolved": list(resolvedReportDataView),
};

export const fateModule = {
	lists,
	mutations,
	sources: [reportReceiptSource, openReportSource, resolvedReportSource, resolveReceiptSource],
	roots,
} satisfies FateModule;
