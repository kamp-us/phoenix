/**
 * The product report registry — the single injection point for report *content*, wired into the
 * runtime by `cli.ts`. It is the mechanism-vs-content boundary (ADR 0153) made concrete: the generic
 * runner in `report.ts` carries no query, and a product's report definitions land here. Each entry is
 * authored as its own content module under `reports/`; this file only lists them, so `report --name
 * <id>` resolves the id against the registered set.
 */

import type {ReportDefinition} from "./report.ts";
import {votesVsReactions} from "./reports/votes-vs-reactions.ts";

export const REPORT_CATALOG: ReadonlyArray<ReportDefinition> = [votesVsReactions];
