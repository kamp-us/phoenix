/**
 * The product report registry — the content side of the mechanism-vs-content
 * boundary (ADR 0153). The runner in `report.ts` carries no query; each report
 * is its own module under `reports/` and this file only lists them.
 */

import type {ReportDefinition} from "./report.ts";
import {votesVsReactions} from "./reports/votes-vs-reactions.ts";

export const REPORT_CATALOG: ReadonlyArray<ReportDefinition> = [votesVsReactions];
