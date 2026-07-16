/**
 * The product report registry — the single injection point for report *content*, wired into the
 * runtime by `cli.ts`. The anka-ops core ships this EMPTY: it is the mechanism-vs-content boundary
 * (ADR 0153) made concrete — the generic runner in `report.ts` carries no query, and a product adds
 * its definitions here (the first, `votes-vs-reactions`, is a separate child). Until one is wired,
 * `report --name <id>` fails loud listing an empty catalog rather than inventing a built-in report.
 */

import type {ReportDefinition} from "./report.ts";

export const REPORT_CATALOG: ReadonlyArray<ReportDefinition> = [];
